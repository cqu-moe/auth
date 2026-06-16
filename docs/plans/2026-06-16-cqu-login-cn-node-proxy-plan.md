# CQU 登录经「国内节点 + 青果代理 + Workers VPC」改造 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 CQU 登录/取票/keepalive 的「连 CQU」出站从 CF 容器迁到国内 VPS，经青果动态住宅 IP 出站消除 captcha；CF ↔ 国内节点用 Workers VPC 私有连接。

**Architecture:** 国内 VPS 跑 `server.py`(aiohttp) + `cqu_login.py`(patchright) + 青果提取 + `cloudflared`；CF 的 `CquSessionDO` 状态机/熔断/取票闸全不动，只把三条「连 CQU」出站(登录 `/run`、取票 `/service-ticket`、keepalive `/keepalive`)与 2FA 投码 `/code` 改为 `env.LOGIN_NODE.fetch(...)`(Workers VPC Service binding)。铁律：所有 CQU 出站经青果；国内节点对 CQU 隐身。

**Tech Stack:** Python 3.12 + patchright + aiohttp + httpx(国内节点)；TypeScript + Hono + Durable Objects + Workers VPC(CF)；cloudflared Tunnel；青果短效住宅代理(API 提取 + 账密)。

**设计依据:** `docs/plans/2026-06-16-cqu-login-cn-node-proxy-design.md`

---

## Phase 0：前置依赖

- [x] **国内 VPS** = `tencent-cd-cqu-moe`(`1.14.106.150`,Ubuntu 22.04,成都腾讯云;连青果实测过;腾讯云远控/监控已清)。`<CN_NODE>` = 它。
- [x] **Cloudflare Tunnel** 已建:**Tunnel ID `35d48aa0-ecd1-402a-b913-932e7a8ec0ac`**(remotely-managed,名 `tencent-cd-cqu-moe`)。connector token 由用户在 VPS `cloudflared service install <token>`(不入仓库)。
- [ ] **Workers VPC** binding 在 DO 内 `env.LOGIN_NODE.fetch()` 可用性 — 部署验证(beta)。
- [ ] **青果套餐**：确认提取额度覆盖「登录 + keepalive 均提取」;`QG_AUTH_KEY/PWD` 就绪(上线前轮换对话中出现过的那对)。
- [ ] **1Password Environment + service account**:建 Environment(放 `QG_*` 运行时 secret)+ service account scope 到它(只读);给我 environment ID;service account token 用户放 VPS(不入仓库)。
- [ ] 决定 keepalive 频率(现 15min)是否下调省青果提取(设计 §9 风险 4)。

> Phase 1、2 纯 codebase,不依赖 VPS;Phase 3 部署用 `<CN_NODE>`。

---

## Phase 1：国内节点代码(`container/`，Python，TDD) — ✅ 已完成(2026-06-16)

> **状态**:Task 1.1-1.5 全部实现 + spec/quality 双 review 通过,**55 测试绿**。commit 链 `e975d17 → 54da59c`。下方各 Task 代码片段是初版参考,实现中有微调(`acquire_qg_proxy` 收口网络错误为 `QgExtractError`、`parse_extract_response` isinstance guard、取票端 `follow_redirects` + httpx cookie 域隔离防 TGC 泄露、keepalive 青果失败归 `unreachable` 不 502),**以仓库实际代码为准**。

> 这些文件部署时整目录拷到 `<CN_NODE>`。测试用 pytest（仓库已有 `container/test_classify_send_code.py`）。
> 运行测试：`cd container && python -m pytest -v`

### Task 1.1：青果提取纯函数 `acquire_qg_proxy`

**Files:**
- Create: `container/qg_proxy.py`
- Test: `container/test_qg_proxy.py`

**Step 1 — 写失败测试**（URL 构造 + 返回解析，纯函数，不打网络）：

```python
# container/test_qg_proxy.py
from qg_proxy import build_extract_url, parse_extract_response, QgExtractError
import pytest

def test_build_extract_url_has_required_params():
    url = build_extract_url(base="https://share.proxy.qg.net/get", key="K", area="500100")
    assert "key=K" in url and "area=500100" in url
    assert "format=json" in url and "num=1" in url and "isp=0" in url and "distinct=true" in url

def test_parse_extract_response_ok():
    body = {"code": "SUCCESS", "data": [{"server": "1.2.3.4:20000",
            "proxy_ip": "183.226.0.1", "area": "重庆市市辖区", "isp": "移动",
            "deadline": "2026-06-16 13:00:00"}]}
    server = parse_extract_response(body)
    assert server == "1.2.3.4:20000"

def test_parse_extract_response_empty_raises():
    with pytest.raises(QgExtractError):
        parse_extract_response({"code": "SUCCESS", "data": []})

def test_parse_extract_response_error_code_raises():
    with pytest.raises(QgExtractError):
        parse_extract_response({"code": "NO_BALANCE", "data": []})
```

**Step 2 — 跑测试确认失败：** `cd container && python -m pytest test_qg_proxy.py -v` → 期望 `ModuleNotFoundError: qg_proxy`。

**Step 3 — 最小实现：**

```python
# container/qg_proxy.py
"""青果短效代理提取(国内来源调用)。
acquire_qg_proxy() 在国内节点本地调提取 API, 拿一个重庆移动 server:port,
组成 patchright/httpx 用的 proxy 配置。账密走环境变量。"""
import os
import urllib.parse
import httpx


class QgExtractError(Exception):
    pass


def build_extract_url(base: str, key: str, area: str) -> str:
    q = urllib.parse.urlencode({
        "key": key, "num": 1, "area": area, "isp": 0,
        "format": "json", "distinct": "true",
    })
    return f"{base}?{q}"


def parse_extract_response(body: dict) -> str:
    if body.get("code") != "SUCCESS":
        raise QgExtractError(f"qg extract not SUCCESS: {body.get('code')!r}")
    data = body.get("data") or []
    if not data or not data[0].get("server"):
        raise QgExtractError("qg extract returned no server")
    return data[0]["server"]


async def acquire_qg_proxy() -> dict:
    """返回 patchright proxy dict: {server, username, password}。
    QG_ENABLED=0 时抛 QgExtractError(由调用方按硬依赖处理: 端点返回 5xx)。"""
    if os.environ.get("QG_ENABLED", "1") == "0":
        raise QgExtractError("QG_ENABLED=0 (应急开关关闭)")
    base = os.environ.get("QG_EXTRACT_BASE", "https://share.proxy.qg.net/get")
    url = build_extract_url(base, os.environ["QG_AUTH_KEY"], os.environ.get("QG_AREA", "500100"))
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url)
        server = parse_extract_response(r.json())
    return {"server": f"http://{server}",
            "username": os.environ["QG_AUTH_KEY"],
            "password": os.environ["QG_AUTH_PWD"]}
```

**Step 4 — 跑测试确认通过：** `cd container && python -m pytest test_qg_proxy.py -v` → 期望 4 passed。

**Step 5 — 加 httpx 到依赖：** `container/requirements.txt` 追加 `httpx==0.28.1`（或与 patchright 兼容版本）。

**Step 6 — Commit：**
```bash
git add container/qg_proxy.py container/test_qg_proxy.py container/requirements.txt
git commit -m "feat(cn-node): 青果提取纯函数 acquire_qg_proxy + 单测"
```

### Task 1.2：`cqu_login.py` 给浏览器挂 proxy

**Files:** Modify `container/cqu_login.py`（`run_login` 签名 + 两处 `chromium.launch`）

**Step 1 — 改 `run_login` 接受 `proxy` 参数**，透传给 `chromium.launch(proxy=proxy)`：
- `run_login(student_id, password, service, method="mail", code_provider=None, proxy=None)`。
- `launch(...)` 加 `proxy=proxy`（`proxy=None` 时 patchright 忽略，行为不变 → 兼容旧路径/测试）。
- 这一行已在 `/tmp/l1_proxy_test.py` 的 L1 spike 实测可跑通，照搬。

**Step 2 — typecheck/语法自检：** `cd container && python -c "import cqu_login"` → 无错。

**Step 3 — Commit：**
```bash
git add container/cqu_login.py
git commit -m "feat(cn-node): cqu_login.run_login 支持 proxy(patchright launch 挂青果)"
```

### Task 1.3：`server.py` 的 `/run` 接入青果(硬依赖回退)

**Files:** Modify `container/server.py`（`run_handler`）

**Step 1 — `run_handler` 在调 `run_login` 前提取青果**，提取失败返回 502：

```python
from qg_proxy import acquire_qg_proxy, QgExtractError
# ...在 run_handler 内, 拿到 student_id/password/service 之后:
try:
    proxy = await acquire_qg_proxy()
except QgExtractError as e:
    log.warning("run abort session=%s qg extract failed: %s", session, e)
    return web.json_response({"ok": False, "error": f"qg proxy unavailable: {e}"}, status=502)
# ...把 proxy 传进 run_login(..., proxy=proxy)
```

**Step 2 — 验证回退：** 设 `QG_ENABLED=0` 本地起 server，`curl -XPOST localhost:8080/run -d '{...}'` → 期望 `502 {"ok":false,"error":"qg proxy unavailable..."}`。

**Step 3 — Commit：**
```bash
git add container/server.py
git commit -m "feat(cn-node): /run 经青果出站, 提取失败 502(硬依赖回退)"
```

### Task 1.4：取票逻辑迁到国内节点 — `/service-ticket` 端点

> **迁移**：现在取 ST 在 DO 的 `src/services/cqu-sso.ts` `getServiceTicket`（用 `ssoFetch` 带 TGC cookie GET `/login?service=...` 跟随重定向抓 `ticket=ST-`）。用 httpx + 青果在 Python 复刻这段 HTTP 流程。**取票闸（host 校验/opt-in/限流/审计）不迁，留 DO**；本端点只「拿已校验的 serviceUrl + cookies，经青果换 ST」。

**Files:**
- Create: `container/cqu_ticket.py`（httpx 取 ST 纯逻辑）
- Test: `container/test_cqu_ticket.py`（用 httpx mock / respx 测重定向抓票解析）
- Modify: `container/server.py`（加 `web.post("/service-ticket", ...)`）

**Steps（TDD）：**
1. 写失败测试：给定一串重定向最终带 `ticket=ST-xxx` 的 Location，`extract_ticket_from_history(...)` 返回 `ST-xxx`；无票抛错。
2. 跑测试失败 → 实现 `cqu_ticket.py`（参照 `cqu-sso.ts` 的取票 URL/cookie 组装 + `extract_ticket` 正则 `ticket=(ST-[\w.\-]+)`，httpx `follow_redirects` + `proxies=acquire_qg_proxy()`）→ 跑测试通过。
3. `server.py` 加 `/service-ticket`：入参 `{serviceUrl, cookies}`，提取青果 → httpx 取 ST → 返回 `{ok, ticket}`；青果失败 502。
4. Commit：`feat(cn-node): /service-ticket 经青果取 ST(取票闸仍在 DO)`

### Task 1.5：keepalive 探测迁到国内节点 — `/keepalive` 端点

> **迁移**：参照 `cqu-sso.ts` 的 keepalive 探测（带 cookie GET 某 CQU 端点，判 `cas-login`/过期/可达）。用 httpx + 青果复刻，返回结构化结果给 DO 决策（DO 的熔断/退避不动）。

**Files:** Create `container/cqu_keepalive.py` + test；Modify `container/server.py`（加 `/keepalive`）

**Steps（TDD）：** 同 1.4 节奏 —— 纯函数判定「响应 → alive/expired/unreachable」写测试 → 实现（httpx + 青果）→ `/keepalive` 端点 → Commit：`feat(cn-node): /keepalive 经青果探测 CQU 会话`

---

## Phase 2：CF 侧接线(Workers VPC，TypeScript)

> 测试：`npm run typecheck`（DO 接线难单测，以类型 + 集成为主）。**迁移期保留 `CquLoginContainer` 类不删**（Phase 4 再清理）。

### Task 2.1：wrangler 加 VPC binding

**Files:** Modify `wrangler.jsonc`

**Steps:**
1. 加 `"vpc_services": [{ "binding": "LOGIN_NODE", "service_id": "<VPC_SERVICE_ID>", "remote": true }]`（`<VPC_SERVICE_ID>` 来自 Phase 3 建的 VPC Service，先占位）。
2. **保留** `containers`（回滚窗口）；删 `placement`（容器已无关）可延后到 Phase 4。
3. `npm run typecheck` 通过。
4. Commit：`feat(cf): wrangler 加 Workers VPC binding LOGIN_NODE`

### Task 2.2：`types.ts` 加 binding 类型

**Files:** Modify `src/types.ts`（`Env` 加 `LOGIN_NODE: { fetch: (req: Request) => Promise<Response> }` 或 VPC service 的官方类型）。typecheck 通过 → Commit。

### Task 2.3：`containerLogin` 改用 LOGIN_NODE

**Files:** Modify `src/durable-objects/cqu-session.ts`（`containerLogin`，约 932 行）

**Steps:**
1. `const stub = this.getLoginContainer(...)` + `stub.fetch(new Request("https://c/run", ...))` 改为 `this.env.LOGIN_NODE.fetch(new Request("http://login-node/run", { method:"POST", body: JSON.stringify({studentId, password, service, method, session}) }))`。**body 不变**（青果提取在国内节点本地，DO 不传 proxy）。
2. `npm run typecheck` 通过。
3. Commit：`feat(cf): 容器登录改经 Workers VPC 调国内节点 /run`

### Task 2.4：取票出站改 LOGIN_NODE（闸不动）

**Files:** Modify `src/durable-objects/cqu-session.ts`（getServiceTicket 内，闸校验**之后**的出站一跳）+ 可能 `src/services/cqu-sso.ts`

**Steps:**
1. 保留 host 校验/opt-in/限流/审计；把闸内 `ssoClient.getServiceTicket(...)` 那一跳换成 `this.env.LOGIN_NODE.fetch("http://login-node/service-ticket", {serviceUrl, cookies})`，解析 `{ticket}`。
2. typecheck 通过。
3. Commit：`feat(cf): 取票出站经 Workers VPC 调国内节点(闸仍在 DO)`

### Task 2.5：keepalive 改 LOGIN_NODE

**Files:** Modify `src/durable-objects/cqu-session.ts`（alarm/keepalive 探测处）

**Steps:** DO 探测从 `ssoFetch` 改 `this.env.LOGIN_NODE.fetch("http://login-node/keepalive", {cookies})`；熔断/退避/状态机据返回决策的逻辑**不动** → typecheck → Commit：`feat(cf): keepalive 探测经 Workers VPC 调国内节点`

### Task 2.6：2FA 投码改 LOGIN_NODE

**Files:** Modify 投码处（`deposit-code` → 容器 `/code` 的调用，约 cqu-session.ts 566 行附近）

**Steps:** `env.CQU_LOGIN.fetch(/code)` → `env.LOGIN_NODE.fetch("http://login-node/code", {session, code})` → typecheck → Commit：`feat(cf): 2FA 投码经 Workers VPC 调国内节点`

---

## Phase 3：部署 + 上线验证(运维 checklist，需 `<CN_NODE>`)

### Task 3.1：国内节点部署
```bash
# 在 <CN_NODE>:
# 1. 装系统库(chromium 依赖) + python3.12 + pip + 1Password CLI(op)
# 2. 拷 container/ 目录; cd container
pip install -r requirements.txt && patchright install chromium
```
**secret 经 1Password 注入,不落盘明文(见设计 §7)**:
- 1Password 建 **Environment**(放 `QG_AUTH_KEY/QG_AUTH_PWD/QG_AREA=500100/QG_ENABLED=1/QG_EXTRACT_BASE`)+ **service account** scope 到它(只读)。
- systemd `cqu-login.service`:
  - service account token 经 `LoadCredential`(或 600-root `EnvironmentFile`)提供 `OP_SERVICE_ACCOUNT_TOKEN`(用户放,不入仓库)
  - `ExecStart=op run --environment <envID> -- python server.py`
  - `Restart=always`
```bash
systemctl enable --now cqu-login
curl -s localhost:8080/ping   # 期望 {"ok":true}
```

### Task 3.2：cloudflared Tunnel(remotely-managed)+ VPC Service(wrangler CLI)
Tunnel 已在 dashboard 建好(Tunnel ID `35d48aa0-ecd1-402a-b913-932e7a8ec0ac`,名 `tencent-cd-cqu-moe`)。
```bash
# <CN_NODE>(用户执行, token 不入仓库): 装 cloudflared 后
cloudflared service install <connector-token>   # connector 连上 CF, systemd 自动常驻
# dashboard 给该 tunnel 配 Private Network 路由 → VPS 的 :8080 可达目标(loopback 或内网 IP)
```
```bash
# VPC Service 用 wrangler CLI 建(我执行), 拿 service_id:
npx wrangler vpc service create cqu-login --type http \
  --tunnel-id 35d48aa0-ecd1-402a-b913-932e7a8ec0ac \
  --http-port 8080 --ipv4 <VPS目标IP>          # --ipv4/--hostname 跟 tunnel 路由对齐
# → 返回 service_id, 回填 wrangler.jsonc Task 2.1 的 <VPC_SERVICE_ID>, 部署
```

### Task 3.3：上线验证(唯一账号)
- 触发一次登录（解绑重绑或等会话过期重登）。
- Observability 看：容器登录失败页指纹 `captcha` 应为 **0**（对比改造前 `captcha=1`）；`relogin OK`；`getCquTicket` 成功。
- 观测 cloudflared 连接稳定性、青果提取成功率 **数天**。

---

## Phase 4：清理(B 稳定运行数天后)

- [ ] 删 `src/durable-objects/cqu-login-container.ts`（`CquLoginContainer` 类）。
- [ ] `wrangler.jsonc` 删 `containers` 段、`placement`、相关 `migrations` 处理。
- [ ] `src/index.ts` 去掉 `CquLoginContainer` 导出。
- [ ] `container/Dockerfile` 保留或归档（VPS 不用容器镜像）。
- [ ] 更新 `CLAUDE.md`：登录架构从「CF 容器」改为「国内节点 + 青果 + Workers VPC」。
- [ ] Commit：`refactor(cf): 移除 CF 容器登录路径(已迁国内节点)`

---

## 备注
- **DRY/YAGNI**：keepalive/取票/登录的「连 CQU」都收敛到国内节点的端点，青果提取统一走 `acquire_qg_proxy()`。
- **安全**：CQU 密码仍只加密存 CF D1，经 VPC 私有通道传、国内节点用完即弃。青果账密、cloudflared 凭据只在 `<CN_NODE>` 的 EnvironmentFile / cloudflared 配置里。
- **回滚**：Phase 4 之前，CF 容器路径仍在；`vpc_services` 出问题可临时改 DO 出站切回 `env.CQU_LOGIN`，或国内节点 `QG_ENABLED=0` 应急直连。
