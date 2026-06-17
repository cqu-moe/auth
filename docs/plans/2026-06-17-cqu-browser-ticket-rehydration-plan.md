# 临时浏览器水化取票 + 砍青果 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把节点取票/保活从 `httpx`(被瑞数挡)改为"临时浏览器水化完整 `storage_state` → navigate 换 ST",DO 改存/传完整 state,砍青果直连 IDC。

**Architecture:** 节点 `/service-ticket`、`/keepalive` 起临时 chromium、`new_context(storage_state=…)` navigate 换票/探活;`/run` 返回完整 `storage_state`;DO 的 `SessionState` 用 `storageState` 取代 3-cookie 的 `cookies`,三处出站载荷随之改,keepalive 回写刷新后的 state。取票四道闸、VPC 接线、2FA 链路、熔断/退避、caps、前端全不动。

**Tech Stack:** Python(patchright/asyncio/aiohttp,pytest)+ TypeScript(Cloudflare Workers/DO,vitest)。

**设计依据:** `docs/plans/2026-06-17-cqu-browser-ticket-rehydration-design.md`(根因实测 + 决策)。

**测试现实:** 浏览器取票是 e2e(今天已用 R1/R2/C 在节点实测过),无法纯单测;**纯函数**(URL 构造 / ST 提取 / 三态分类 / state 取 TGT)走 pytest/vitest,**浏览器段**走节点冒烟脚本(免青果直连,复用今天的脚手架)。

---

## Phase 0 — 砍青果开关(零代码,先验)

### Task 0.1: 节点 env 关青果,验证直连浏览器登录+取票仍通
**Files:** 无代码改动(只动 1Password Environment / systemd env)。

**Step 1:** 在节点 1Password Environment `auth-cqu-moe.cn-node`(或 systemd `Environment=`)加 `QG_ENABLED=0`。`should_use_proxy()` 即对所有 profile 返回 False → 全 `proxy=None` 直连成都 IDC。

**Step 2:** 重启服务并冒烟:
```bash
ssh ubuntu@1.14.106.150 'sudo systemctl restart cqu-login && curl -s localhost:8080/ping'
```
Expected: `{"ok":true}`。

**Step 3:** 不提交(纯配置)。记一条:**直连 IDC 登录今日已实测干净(captcha=0),取票真凶是瑞数 JS 非 IP**,故关青果安全。

---

## Phase 1 — 节点:浏览器取票核心(纯函数先行)

### Task 1.1: 新增 `cqu_ticket_browser.py` 的纯函数 + 单测
**Files:**
- Create: `container/cqu_ticket_browser.py`
- Test: `container/test_cqu_ticket_browser.py`

**Step 1: 写失败测试**(复用 `cqu_ticket` 既有判据,保持语义一致)
```python
# container/test_cqu_ticket_browser.py
import cqu_ticket_browser as m

def test_build_login_url_encodes_service():
    u = m.build_login_url("https://my.cqu.edu.cn/authserver/authentication/cas")
    assert u == "https://sso.cqu.edu.cn/login?service=https%3A%2F%2Fmy.cqu.edu.cn%2Fauthserver%2Fauthentication%2Fcas"

def test_classify_browser_result_ticket():
    assert m.classify_browser_result("ST-1-abc", "") == ("ok", "ST-1-abc")

def test_classify_browser_result_cas_login_is_expired():
    body = "<input id='login-page-flowkey' value='x'>"
    assert m.classify_browser_result("", body)[0] == "expired"

def test_classify_browser_result_unknown_is_no_ticket():
    assert m.classify_browser_result("", "<html>weird</html>")[0] == "no_ticket"
```

**Step 2:** `cd container && python -m pytest test_cqu_ticket_browser.py -q` → FAIL(模块不存在)。

**Step 3: 最小实现(纯函数 + 浏览器函数同文件)**
```python
# container/cqu_ticket_browser.py
"""临时浏览器水化完整 storage_state 取票(替代 httpx,过瑞数 JS 挑战)。"""
import asyncio
import urllib.parse
from patchright.async_api import async_playwright
import cqu_login  # UA / SSO / install_ticket_sniffer / extract_ticket

SSO = cqu_login.SSO
CAS_LOGIN_MARKERS = ("login-page-flowkey", "login-croypto")
# 取票并发上限(护 4G 节点;实测见设计 §6)。模块级单例,跨请求共享。
TICKET_SEMAPHORE = asyncio.Semaphore(3)

def build_login_url(service_url: str) -> str:
    return f"{SSO}/login?service={urllib.parse.quote(service_url, safe='')}"

def classify_browser_result(ticket: str, body: str) -> tuple[str, str]:
    """("ok", ST) / ("expired", "") / ("no_ticket", "")。纯函数。"""
    if ticket:
        return ("ok", ticket)
    if any(mk in (body or "") for mk in CAS_LOGIN_MARKERS):
        return ("expired", "")
    return ("no_ticket", "")

async def fetch_service_ticket_browser(service_url: str, state: dict) -> str:
    """水化完整 storage_state 起临时浏览器 navigate 换 ST。
    成功返回 ST;落 CAS 登录页抛 ExpiredError;否则抛 NoTicketError。"""
    url = build_login_url(service_url)
    async with TICKET_SEMAPHORE:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True, args=[
                "--headless=new", "--disable-blink-features=AutomationControlled",
                "--no-sandbox", "--disable-dev-shm-usage"], timeout=30000)
            try:
                ctx = await browser.new_context(
                    storage_state=state, user_agent=cqu_login.UA,
                    viewport={"width": 1440, "height": 900},
                    locale="zh-CN", timezone_id="Asia/Shanghai")
                page = await ctx.new_page()
                tickets = []
                cqu_login.install_ticket_sniffer(page, tickets)
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=25000)
                    await page.wait_for_timeout(3500)
                except Exception:
                    pass
                ticket = cqu_login.extract_ticket(tickets + [page.url])
                body = ""
                if not ticket:
                    try:
                        body = await page.content()
                    except Exception:
                        body = ""
            finally:
                await browser.close()
    verdict, tk = classify_browser_result(ticket, body)
    if verdict == "ok":
        return tk
    if verdict == "expired":
        raise ExpiredError("fell back to CAS login page")
    raise NoTicketError("no ST, non-login page")

class ExpiredError(Exception): pass
class NoTicketError(Exception): pass
```

**Step 4:** `python -m pytest test_cqu_ticket_browser.py -q` → PASS(纯函数 4 条)。浏览器函数此步不单测。

**Step 5: Commit**
```bash
git add container/cqu_ticket_browser.py container/test_cqu_ticket_browser.py
git commit -m "feat(cn-node): 浏览器水化取票核心 + 纯函数单测(替代 httpx)"
```

---

## Phase 2 — 节点:`/run` 返回完整 storage_state

### Task 2.1: `run_login` 返回 `state` 而非 3 cookie
**Files:** Modify `container/cqu_login.py`(`run_login` 的两处 `return`,见 `:382-388` 与 `:416-417`)

**Step 1:** 改 `run_login` 返回值:把 `cookies = extract_cookies(await ctx.storage_state())` 换成 `state = await ctx.storage_state()`,两处 `return {"cookies": cookies, "ticket": tk}` → `return {"state": state, "ticket": tk}`。`extract_cookies` 保留(回滚 + 测试用)。

**Step 2:** 既有节点测试跑通:`cd container && python -m pytest test_run_qg.py test_run_login_proxy.py -q`(若它们断言 `cookies` 键,改断言 `state`/`ticket`,并补一条 `assert "cookies" in result["state"]`)。

**Step 3: Commit**
```bash
git add container/cqu_login.py container/test_run_qg.py container/test_run_login_proxy.py
git commit -m "feat(cn-node): /run 返回完整 storage_state(水化取票所需)"
```

---

## Phase 3 — 节点:`/service-ticket` 改浏览器

### Task 3.1: `server.py` `/service-ticket` 收 `{serviceUrl, state}` 走浏览器
**Files:** Modify `container/server.py:184-237`(`service_ticket_handler`);Test `container/test_service_ticket.py`

**Step 1: 改 handler**(砍青果分支,改调浏览器):
```python
import cqu_ticket_browser
from cqu_ticket_browser import ExpiredError, NoTicketError

async def service_ticket_handler(request):
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "invalid JSON body"}, status=400)
    service_url = body.get("serviceUrl")
    state = body.get("state")
    if not service_url or not isinstance(state, dict):
        return web.json_response({"ok": False, "error": "missing serviceUrl/state"}, status=400)
    try:
        ticket = await cqu_ticket_browser.fetch_service_ticket_browser(service_url, state)
        log.info("service-ticket ok (len=%d)", len(ticket))
        return web.json_response({"ok": True, "ticket": ticket})
    except ExpiredError as e:
        log.warning("service-ticket expired: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=409)
    except Exception as e:  # NoTicketError / 浏览器崩 / 超时 → 502 瞬态
        log.warning("service-ticket transient: %s", e)
        return web.json_response({"ok": False, "error": str(e)}, status=502)
```
> 409/502 的语义与 DO `mintServiceTicketViaNode` 既有映射(409→TGT_EXPIRED、其余→WAF_CHALLENGE)**完全一致**,DO 侧不必改判别。

**Step 2:** 改 `test_service_ticket.py`:mock `cqu_ticket_browser.fetch_service_ticket_browser`,断言 200→ticket / ExpiredError→409 / NoTicketError→502 / 缺 state→400。`python -m pytest test_service_ticket.py -q` → PASS。

**Step 3: Commit**
```bash
git add container/server.py container/test_service_ticket.py
git commit -m "feat(cn-node): /service-ticket 改浏览器水化取票(收 state, 409/502 语义不变)"
```

### Task 3.2: 节点冒烟(免青果直连,真取票)
**Files:** 复用今日脚手架思路(`/tmp/node_rehydrate_test.py` 的 R1 段)。
**Step 1:** 节点起一次登录拿完整 state(写临时文件)→ 调 `/service-ticket` POST `{serviceUrl, state}` → 期望 200 + `ST-`。
**Step 2:** 人工核对日志 `service-ticket ok`。不入仓库(冒烟脚本),记结果于 PR。

---

## Phase 4 — 节点:`/keepalive` 改浏览器 + 回吐刷新 state

### Task 4.1: `cqu_keepalive.py` 浏览器探活 + 导出刷新 state
**Files:** Modify `container/cqu_keepalive.py`;Test `container/test_cqu_keepalive.py`

**Step 1:** 新增 `async def probe_session_browser(state: dict) -> dict`:水化 state、navigate `/login?service=PROBE_SERVICE`、嗅 ST;**导出 `await ctx.storage_state()` 作刷新后的 state**。返回 `{"status": alive|expired|unreachable, "state": <refreshed>, "detail": ...}`。三态判定复用 `classify_browser_result`(ok→alive / expired→expired / no_ticket→unreachable)+ 任何异常→unreachable(绝不误判过期)。

**Step 2:** `classify_probe` 纯函数保留/调整测试;`python -m pytest test_cqu_keepalive.py -q` → PASS(纯函数三态映射)。

**Step 3: Commit**
```bash
git add container/cqu_keepalive.py container/test_cqu_keepalive.py
git commit -m "feat(cn-node): /keepalive 浏览器探活 + 回吐刷新 storage_state"
```

### Task 4.2: `server.py` `/keepalive` 收 `{state}`、回 `{status, state}`
**Files:** Modify `container/server.py:240-288`;Test `container/test_keepalive.py`

**Step 1:** handler 改收 `state`(dict),调 `probe_session_browser`,返回 `{"ok": True, "status", "state", "detail"}`;砍青果。三态恒 200(沿用"探不通不误判过期")。
**Step 2:** `python -m pytest test_keepalive.py -q` → PASS。
**Step 3: Commit**
```bash
git add container/server.py container/test_keepalive.py
git commit -m "feat(cn-node): /keepalive 收 state 回刷新 state(砍青果)"
```

---

## Phase 5 — CF 侧 DO:`storageState` 取代 `cookies`,三处出站随改

### Task 5.1: 类型 + `SessionState` 字段
**Files:** Modify `src/services/cqu-sso.ts`(加类型)、`src/durable-objects/cqu-session.ts:64-75,107-113`

**Step 1:** `cqu-sso.ts` 加:
```ts
export interface CquStorageState {
  cookies: Array<{ name: string; value: string; domain: string; path: string;
    expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: string }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}
```
**Step 2:** `cqu-session.ts`:`SessionState.cookies: CasCookies` → `storageState: CquStorageState | null`;`ContainerRunResult.cookies?` → `state?: CquStorageState`。`initSession` 占位 state 的 `cookies:{…}` → `storageState: null`。加纯函数:
```ts
function tgtFromState(s: CquStorageState | null): string {
  return s?.cookies.find((c) => c.name === "SOURCEID_TGC")?.value ?? "";
}
```
**Step 3:** `npm run typecheck` 会报后续引用错(预期),先不提交,Task 5.2-5.4 一并修完再提交。

### Task 5.2: `mintServiceTicketViaNode` 发 `state`
**Files:** Modify `cqu-session.ts:498,524-564`
**Step 1:** `getServiceTicket` 里 `this.mintServiceTicketViaNode(this.state.cookies, target)` → `(this.state.storageState, target)`。函数签名 `cookies: CasCookies` → `state: CquStorageState | null`;body `{ serviceUrl, cookies }` → `{ serviceUrl, state }`。409/502 映射不动。

### Task 5.3: `runKeepAlive` 发 `state`、回写刷新 state
**Files:** Modify `cqu-session.ts:832-880` + `alarm()` 的 active 分支 `773-783`
**Step 1:** `runKeepAlive` body `{ cookies: state.cookies }` → `{ state: state.storageState }`;读 `body.status`;**alive 时把 `body.state` 存入 `this.state.storageState`**(在返回 "active" 前);三态映射不变。`alarm()` 的 active 分支已 `ctx.storage.put("state", this.state)`,刷新的 storageState 随之落盘(C)。

### Task 5.4: `containerLogin` 存 `state`、TGT 诊断改从 state 取
**Files:** Modify `cqu-session.ts:1035-1074`
**Step 1:** `result.cookies` 校验 → `result.state`(`!result.state` 即失败);`fresh.cookies = result.cookies` → `fresh.storageState = result.state`;TGT 诊断 `decodeJwtExp(result.cookies.SOURCEID_TGC)` → `decodeJwtExp(tgtFromState(result.state))`。
**Step 2:** `npm run typecheck` → 干净。`npm run test`(vitest)→ 既有 159 测试全绿(若有断言 `cookies` 字段的 DO 测试,改 `storageState`)。
**Step 3: Commit**
```bash
git add src/services/cqu-sso.ts src/durable-objects/cqu-session.ts
git commit -m "feat(be): DO 用完整 storageState 取代 3-cookie, 三处出站随改 + keepalive 回写"
```

---

## Phase 6 — 灰度上线 + 清理

### Task 6.1: 部署 + 灰度观测
**Step 1:** 节点先部署 Phase 1-4(`QG_ENABLED=0`),冒烟取票 200。
**Step 2:** push `main` → GH Actions 部署 CF(Phase 5)。
**Step 3:** observability(`cqu-moe-auth`)观测:`st_mint` 审计成功率、`service-ticket` 409/502 比例、keepalive `active` 比例、节点内存/僵尸。**若取票持续失败 → 开关切回 httpx 路径**(回滚)。

### Task 6.2: 清理(稳定后,单独 PR)
**Step 1:** 删 `qg_proxy.py` 调用、两套青果 key(1Password)、`cqu_ticket.py` httpx `fetch_service_ticket*` 与 `cqu_keepalive` httpx 路径、相关测试;删容器 `CquLoginContainer`/`CQU_LOGIN` binding/`ssoClient`/`getLoginContainer`(原 Phase 4 清理项一并)。
**Step 2:** `npm run typecheck && npm run test && cd container && python -m pytest -q` 全绿。
**Step 3: Commit** `chore: 清理青果 + httpx 取票/keepalive + 容器残留(回滚窗口结束)`

---

## 验证清单(完成判据)
- [ ] 节点 `pytest -q` 全绿(纯函数 + handler mock)。
- [ ] 节点冒烟:登录拿 state → `/service-ticket` 返回 `ST-`(免青果直连)。
- [ ] `npm run typecheck` 干净;`npm run test` 全绿。
- [ ] 灰度:生产 `st_mint` 成功率回升、keepalive `active`、内存平稳。
