# Auth 实施任务 01–04

先读总计划、规格和固定参考。本章 cwd 一律为 AUTH worktree。只在当前 Task 验证通过后继续。

## Task 01：接纳现有修复，补上首次绑定 pending 语义

**Files**
- 保留：`src/services/cqu-binding.ts`、`src/rpc.ts`、`src/routes/cqu-bind.ts`、`src/routes/cqu-bind.test.ts`、`frontend/src/pages/CquBindWizard.tsx`。
- 修改：`src/routes/cqu-bind.ts` 的 `PUT /credentials`。
- 测试：`src/routes/cqu-bind.test.ts`；如扩充 D1 测试适配器，放 `src/test-utils/d1.ts`。

**Consumes**：冻结 baseline 的 `getCquBinding(database: D1Database, userId: string)`。
**Produces**：GET 与 RPC 凭证优先；新凭证在首次登录中为 pending，真实完成后才 active。现有错误码不变。

- [ ] 检查五文件是否已在当前工作树或 HEAD 中；有则保留，没有则先 `git apply --check /Users/uu/Developer/cqu-moe/auth/docs/superpowers/specs/assets/2026-09-10-schedule-onboarding/baseline/auth-preplan.patch` 再应用。禁止覆盖后来已有实现。
- [ ] 先运行现有状态测试与 typecheck：
```sh
npm test -- src/routes/cqu-bind.test.ts src/rpc.test.ts
npm run typecheck
```
- [ ] 写 PUT 的红测试。真实 SQLite/D1 执行 SQL，只 mock 登录外部边界和已认证会话。扩展测试适配器支持 D1 `run/all/raw/batch`，batch 用 SQLite BEGIN/COMMIT/ROLLBACK，不能用 Map 假装数据库。

测试必须暂停 `CQU_SESSION.fetch(/init)`，在 promise 未 resolve 时通过另一次 GET 验证 pending，再放行登录成功验证 active：
```ts
it('does not report a newly inserted credential as active before init succeeds', async () => {
  const fixture = createBindingFixture();
  await fixture.insertAddress('current-user', 'pending');
  const init = fixture.deferInit();
  const request = fixture.putCredentials({ studentId: '20260001', password: 'test-only' });
  await init.started;
  expect((await fixture.getBinding()).bindStatus).toBe('pending');
  init.resolve({ success: true });
  expect((await request).status).toBe(200);
  expect((await fixture.getBinding()).bindStatus).toBe('active');
  fixture.close();
});
```
`createBindingFixture()` 为本 Task 测试辅助函数，契约如下：`insertAddress(userId,status): Promise<void>` 插入真实邮箱行；`deferInit()` 返回 `{ started: Promise<void>, resolve(body):void }` 并拦截唯一 DO init；`putCredentials(body):Promise<Response>` 调用真实 Hono 路由；`getBinding():Promise<BindResponse>` 解析真实 GET；`close()` 关闭数据库。测试环境使用固定的测试加密 key，不读取 `.dev.vars`。

- [ ] 运行红测试，确认失败是提前 active，不是 mock/导入错误。
- [ ] 新插入凭证显式 `status: 'pending'`，不要改 schema 全局默认以影响旧入口。成功后用 `db.batch` 同时更新邮箱与凭证为 active。失败沿用本请求拥有的 insertedCredsId 回滚，不删除其他并发请求或旧账号凭证。
```ts
await db.batch([
  db.update(cquBindAddresses).set({ status: 'active' })
    .where(eq(cquBindAddresses.userId, user.id)),
  db.update(cquCredentials).set({ status: 'active' })
    .where(eq(cquCredentials.userId, user.id)),
]);
```
并发插入失败后不把读到的另一请求 pending 行改成 active；若仅更新该行，完成状态仍必须等本次 init 成功。已经存在的 active/revoked 凭证遵循现有更新/失败回滚规则，不在此 Task 大改旧重绑策略。
- [ ] 新增或保持这些用例：新 init 失败删除自己新建的凭证；已有凭证 init 失败不删除他人行；激活 batch 失败返回 `BIND_ACTIVATE_FAILED`；GET 不查询他人凭证；legacy active + 无邮箱仍为 active；revoked 凭证压过旧 active 邮箱。
- [ ] 绿测试、typecheck、前端构建。提交建议 `fix(auth): unify binding status and confirm first login before activation`。

## Task 02：让认证返回到绑定页，而非提前返回 Schedule

**Files**
- 新建 `frontend/src/lib/cqu-bind-continuation.ts`、`.test.ts`。
- 修改 `frontend/src/components/ProtectedRoute.tsx`、`EmailVerificationGate.tsx`。
- 追加测试 `frontend/src/lib/post-login-redirect.test.ts`、`frontend/src/pages/Login.test.ts`。
- 按需要小修 `frontend/src/lib/post-login-redirect.ts`，不改变第一方允许域范围。

**Consumes**：现有 `sanitizePostLoginRedirect`、`withRedirectParam`、`getLoginNavigationDestination`。
**Produces**：三个纯函数，签名固定：
```ts
export function protectedLoginUrl(pathname: string, search: string): string;
export function verificationContinuation(pathname: string, search: string): string | null;
export function bindingReturnTarget(candidate: string | null, authOrigin: string): string | null;
```

- [ ] 先把下面行为测试写入 `.test.ts`。内层 URL 只编码/解码一次；让 URLSearchParams 操作参数，不手工拼接未编码字符串。
```ts
import { describe, expect, it } from 'vitest';
import { protectedLoginUrl, verificationContinuation, bindingReturnTarget } from './cqu-bind-continuation';
import { withRedirectParam } from './post-login-redirect';
import { getLoginNavigationDestination } from './login-routing';

const service = 'https://schedule.cqu.moe/dashboard?setup=1';
const binding = withRedirectParam('/cqu/bind', service);

describe('CQU binding continuation', () => {
  it('returns to binding after login, keeping the service nested', () => {
    const url = new URL(binding, 'https://auth.cqu.moe');
    const login = protectedLoginUrl(url.pathname, url.search);
    const target = new URL(login, url.origin).searchParams.get('redirect');
    expect(target).toBe(binding);
    expect(getLoginNavigationDestination({user:{emailVerified:true}}, target)).toBe(binding);
  });
  it('does not unwrap the service when verifying on the binding route', () => {
    const url = new URL(binding, 'https://auth.cqu.moe');
    expect(verificationContinuation(url.pathname, url.search)).toBe(binding);
  });
  it('keeps the already stored target on login and verification pages', () => {
    const search = '?redirect=' + encodeURIComponent(binding);
    for (const path of ['/login','/register','/two-factor','/verify-email']) {
      expect(verificationContinuation(path, search)).toBe(binding);
    }
  });
  it.each([
    'https://evil.example/',
    'https://user:pass@schedule.cqu.moe/',
    'https://auth.cqu.moe/cqu/bind',
    '//schedule.cqu.moe/',
    '/cqu/bind',
    'javascript:alert(1)',
  ])('rejects unsafe or looping final targets: %s', target => {
    expect(bindingReturnTarget(target, 'https://auth.cqu.moe')).toBeNull();
  });
  it('accepts the intended service', () => {
    expect(bindingReturnTarget(service, 'https://auth.cqu.moe')).toBe(service);
  });
});
```
- [ ] 运行 `npm test -- frontend/src/lib/cqu-bind-continuation.test.ts`，确认红。
- [ ] 实现纯函数：
```ts
import { sanitizePostLoginRedirect, withRedirectParam } from './post-login-redirect';
const authPages = new Set(['/login','/register','/two-factor','/verify-email']);
export function protectedLoginUrl(pathname: string, search: string): string {
  return withRedirectParam('/login', sanitizePostLoginRedirect(pathname + search));
}
export function verificationContinuation(pathname: string, search: string): string | null {
  if (authPages.has(pathname)) {
    return sanitizePostLoginRedirect(new URLSearchParams(search).get('redirect'));
  }
  return sanitizePostLoginRedirect(pathname + search);
}
export function bindingReturnTarget(candidate: string | null, authOrigin: string): string | null {
  if (!candidate || /[\u0000-\u0020\\]/.test(candidate)) return null;
  const safe = sanitizePostLoginRedirect(candidate);
  if (!safe || safe.startsWith('/')) return null;
  const url = new URL(safe);
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.username || url.password || url.origin === authOrigin) return null;
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  return url.toString();
}
```
默认生产绑定返回只接受绝对第一方 HTTPS 服务地址；HTTP 仅用于本机测试。直接 Auth 入口无目标时由成功页兜底，不强塞 `/settings` 到函数结果。

- [ ] ProtectedRoute 引入 `useLocation()`；未登录改为：
```tsx
return <Navigate to={protectedLoginUrl(location.pathname, location.search)} replace />;
```
不得重写登录表单或拦截 Better Auth 的 2FA 重定向。
- [ ] EmailVerificationGate 的未验证分支先调用 `verificationContinuation(location.pathname,location.search)`，再 `withRedirectParam('/verify-email',target)`。已验证分支维持跳转存储的 redirect。这样在 `/cqu/bind?...` 上发生验证 gate 时，整个绑定路径不会丢失。
- [ ] common sanitizer 拒绝 userinfo、原始反斜杠和控制字符；保留第一方与本机允许域。新增 `https://evil@allowed`、`/\\evil`、换行、错误编码、同域正常深链测试。不要通过解码任意 redirect 多次来“修复”URL。
- [ ] 测试包含：已登录但邮箱未验证直接打开绑定；注册必填/选填邀请码策略不变；有2FA时先挑战再绑定；无来源普通登录仍回 settings；OAuth authorize 的原目标仍保留。
- [ ] 运行 Auth 所有现有 redirect/login/2FA 测试与 typecheck。提交建议 `fix(auth): preserve binding continuation through authentication`。

## Task 03：绑定 bootstrap、刷新恢复与固定成功页

**Files**
- 修改 `src/services/cqu-binding.ts`、`src/routes/cqu-bind.ts`：GET 增加本用户恢复必要的公开字段。
- 新建 `frontend/src/lib/cqu-bind-progress.ts`、`.test.ts`；`frontend/src/components/CquBindSuccess.tsx`、`.test.tsx`。
- 修改 `frontend/src/pages/CquBindWizard.tsx`，不重写 Step2 的 WebSocket、验证码租约或邮件匹配。

**Produces**：
```ts
type BindKind = 'direct' | 'forward';
interface BindingSnapshot {
  address?: string;
  bindStatus: 'unbound' | 'pending' | 'active' | 'revoked';
  kind?: BindKind;
  forwardAddress?: string;
  sessionStatus: unknown;
}
interface SavedBindProgress {
  userId: string;
  address: string;
  kind: BindKind;
  step: 2 | 3;
}
type BindScreen = 'intro' | 'address' | 'credentials' | 'waiting' | 'complete';
export function bindScreen(snapshot: BindingSnapshot, saved: SavedBindProgress | null, userId: string, repair?: boolean): BindScreen;
```

- [ ] 先给 `bindScreen` 写表驱动测试：active 凭证无地址→complete；pending+DO binding→waiting；pending+当前 user/address/kind 的 step3→credentials；存储用户或地址不匹配→address；无记录→intro；未知响应不能传入该纯函数（解析层必须拒绝）；revoked 不得 complete；active+repair+地址→credentials，active+repair+无地址→intro。
- [ ] 共享 GET 查询增加邮箱行的 `kind`、`senderWhitelist`，仅在有地址时返回 kind。forwardAddress 从现有 forward 的 whitelist 第一项恢复，校验 JSON 为 string[]；direct 不返回 forwardAddress。禁止返回 encryptedPassword、iv、整个凭证行或内部 Cookie。RPC 只返回原 cquBindStatus，不额外泄露上述字段。
- [ ] 实现 `bindScreen`。优先级固定：普通入口active → complete；合法 DO `{status:'binding'}` → waiting；显式repair=1入口即使active也不自动完成，有地址则credentials、无地址则intro；无 address → intro；匹配存储 step3 → credentials；其余 → address。DO 的 needs_reauth 与网络错误不等价于绑定不存在，不自动删记录。
- [ ] Wizard 首次 mount 显示小型 loading，GET `/api/cqu/binding`，先检查 HTTP 状态、JSON 和枚举，再决定画面。GET 失败显示「暂时无法确认绑定状态」与「重试」。必须使用 AbortController 并忽略已取消/旧请求，防止覆盖新提交结果。
- [ ] 已经 active、repair不为1且是服务来源，bootstrap 直接 `window.location.replace(returnTo)`；这是老用户跳过绑定。独立访问 active 的绑定页显示成功页，不强制服务跳转。仅本次绑定真正完成的用户观看3秒成功反馈。
- [ ] 在 Step2→Step3 时写 `sessionStorage['cqu-bind-progress:'+userId]` 的 SavedBindProgress。存储失败不阻止绑定；只保存上面四字段，不保存密码、验证码、密钥。每次读写都 catch 存储权限错误；成功后移除本账号记录。恢复 forward 模式要使用服务端 kind/forwardAddress，不能把它默认为 direct。
- [ ] 首次提交新凭证时保持当前请求行为，HTTP成功且 `data.success===true` 后再次确认 GET 返回 active，随后显示成功。确认失败显示「正在确认绑定结果」及重查，不再提交一次凭证。page refresh 遇到 DO binding 就每3秒重查绑定，429/临时网络错误退避；10分钟未确认只显示「尚未确认绑定结果」和重查，不把绑定改成失败或清空服务端记录。
- [ ] 成功组件使用固定文案与现有 Auth 蓝色按钮，接口固定：
```tsx
interface CquBindSuccessProps {
  returnTo: string | null;
  autoReturn: boolean;
  onReturn?: (url: string) => void;
}
```
参考实现（保持组件小，别把整个 Wizard 迁移进来）：
```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
const navigateToService = (url: string) => window.location.replace(url);
export default function CquBindSuccess({returnTo, autoReturn, onReturn = navigateToService}: CquBindSuccessProps) {
  const [paused, setPaused] = useState(false);
  const [seconds, setSeconds] = useState(3);
  const running = Boolean(returnTo && autoReturn && !paused);
  useEffect(() => {
    if (!running || !returnTo) return;
    const timer = window.setTimeout(() => {
      if (seconds <= 1) onReturn(returnTo);
      else setSeconds(value => value - 1);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [running, returnTo, seconds, onReturn]);
  const schedule = returnTo && new URL(returnTo).hostname === 'schedule.cqu.moe';
  return <div className="space-y-6 text-center">
    <div><h2 className="text-xl font-semibold text-gray-900">绑定成功</h2>
      <p className="mt-2 text-sm text-gray-500">可以返回使用服务了。</p></div>
    {returnTo ? <a href={returnTo} onClick={() => setPaused(true)}
      className="block w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700">
      {schedule ? '返回课表' : '返回服务'}</a>
      : <a href="https://schedule.cqu.moe/" className="block text-sm text-blue-600">前往课表</a>}
    {running && <p className="text-xs text-gray-500">{seconds} 秒后自动返回 · <button type="button" onClick={() => setPaused(true)} className="underline">留在此页</button></p>}
    {!returnTo && <Link to="/settings" className="block text-sm text-gray-500">返回账户设置</Link>}
  </div>;
}
```
`returnTo` 必须在父组件通过 Task02 函数校验。组件通过 key={returnTo} 在目标变化时重置倒计时。手动链接或取消可阻止计时器，卸载清理计时器，StrictMode 不得双跳转。

- [ ] 测试真实成功才装载此组件；失败/空响应不装载。倒计时测试用 fake timers 和注入 onReturn，不改全局 location。测试3秒、取消、卸载、无来源不跳转、非法来源被父组件拦截。
- [ ] 学校按钮保留 baseline 深链；forward 模式不出现改密保邮箱指令。绑定入口标题统一，说明压缩到一行；已有关键影响说明保留在操作前，不自行删除。
- [ ] 绿测试与 typecheck、前端 build。提交建议 `feat(auth): continue and resume CQU binding with service return`。

## Task 04：认证链异常恢复与交叉标签验证

**Files**
- 修改 `Login.tsx`、`Register.tsx`、`VerifyEmail.tsx`、`ResetPassword.tsx`、`ResetPasswordConfirm.tsx`（均在 frontend/src/pages）。
- 新建 `frontend/src/lib/refetch-on-return.ts`、`.test.ts`。
- 修改 `frontend/src/lib/two-factor-challenge.ts` 仅在现有 refetch 结果处理确有缺漏时进行。
- 测试：`frontend/src/pages/CquBindWizard.test.tsx`、`frontend/src/components/EmailVerificationGate.test.tsx`。

**Consumes**：Task02 路径函数、Task03 snapshot/成功组件。**Produces**：邮箱跨标签及密码重置后仍继续原绑定目标，不改变认证条件。

- [ ] 先写 focus/visibility 行为测试，再实现清理函数：
```ts
export function refetchOnReturn(refetch: () => unknown): () => void {
  let busy = false;
  const run = async () => {
    if (document.visibilityState !== 'visible' || busy) return;
    busy = true;
    try { await refetch(); } finally { busy = false; }
  };
  const safeRun = () => { void run().catch(() => {}); };
  window.addEventListener('focus', safeRun);
  document.addEventListener('visibilitychange', safeRun);
  return () => {
    window.removeEventListener('focus', safeRun);
    document.removeEventListener('visibilitychange', safeRun);
  };
}
```
这里网络失败仅维持已有验证页面，不视为验证成功；页面显示既有重发按钮。测试隐藏时不请求、同时事件合并一次、清理后不请求、请求失败后下次focus可恢复。外部监听失败吞掉不会绕过 gate。
- [ ] VerifyEmail 在 useEffect 安装该监听，refetch authClient.useSession，状态更新由 EmailVerificationGate 决定去向。邮箱链接 callbackURL 仍由 withRedirectParam 生成，禁止改掉 verified 标记或验证token机制。
- [ ] Login→忘记密码携带当前 redirect；ResetPassword.requestPasswordReset 的 redirectTo 使用 withRedirectParam('/reset-password/confirm',target)；ResetPasswordConfirm 成功后回 withRedirectParam('/login',target)。所有“返回登录”和 VerifyEmail 退出登录也保留该目标。密码本身只在原表单内。
- [ ] 登录/注册来源文案仅在 redirect 指向 `/cqu/bind` 且内层合法 Schedule 目标时显示「继续使用重庆大学课表」。普通 Auth、OAuth 授权、其他服务不能冒充此来源。
- [ ] 为需要 mount/effect 的 React 测试使用 `react-dom/client` 的 createRoot 和 `react` 的 act。现有依赖没有 DOM 环境时只加开发依赖 `jsdom@28.1.0`，不引入 UI 库，不升级 React/Vite。测试文件首行 `// @vitest-environment jsdom`。
- [ ] 集成矩阵每项必须有真实路由结果断言：
  1. 无会话→绑定路由→login→register→verify→绑定；全过程没有提前外跳 Schedule。
  2. 已登录未验证→直接bind→verify→bind。
  3. 登录触发2FA→完成验证→bind，邮箱未验证时仍先走原 gate。
  4. 验证邮件新标签完成→原标签focus→bind。
  5. bind页刷新→恢复当前用户步骤；切账号不读取旧账号步骤。
  6. 已绑定老用户缺邮箱行→回服务，未调用 credentials PUT；显式repair=1入口不自动回服务。
  7. bind查询失败→重试，既不显示成功也不重新创建绑定。
  8. 正常无来源Auth登录与OAuth authorize不被强行改成Schedule。
  9. 找回密码往返后仍进入bind，不能遗失 returnTo。
- [ ] 运行 `npm test`、`npm run typecheck`、`npm --prefix frontend run build`。提交建议 `test(auth): cover onboarding continuation and recovery`。
