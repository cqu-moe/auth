# Modern Web Guidance 前端检查

检查日期：2026-11-16（Asia/Shanghai）。代码基线：`ece22b5ff2fe32136e91ba1344d7ae96c79cde1f`。

最初完成项目级指南接入与优化评估；用户随后授权实施，下述五项建议均已在同一工作区落实。前面的“证据”保留初始基线观测，同日实施与验证见文末。本报告不代表后续分支或生产状态。

## 检查方法与范围

- 执行 `pnpx modern-web-guidance@latest legacy-scan frontend --json`：33 个指南、35 条规则、0 条命中；跳过 42 个文档/测试文件。工具明确说明仅覆盖约 20% 的指南，因此继续做专题检查。
- 分别搜索 `accessible form inputs`、`reduce motion animations`、`load page efficiently`，搜索使用 skill 版本 `2026_11_09-5bcc021b`；完整读取 `forms`、`autofill-sign-in-form`、`autofill-sign-up-form`、`accessibility`、`motion`、`performance`。
- 检查入口 HTML、路由与布局、认证表单、验证码、设置/管理组件、样式、现有测试和构建配置。共享组件核对锁定的 `@cqu-moe/ui@1.2.0` 发布包及 `DESIGN.md`，避免把组件内部已提供的行为误报为缺失。
- Ask Matt 的配置前提已存在：GitHub issue tracker、triage 标签映射和 single-context 领域文档。文档修改采用 writing-for-agents 的条件入口；没有新建一套重复流程。
- 表单检查另由 `zhipu/glm-5.3` / `max` 子代理提供候选，主代理复核后才纳入报告。未访问真实账号、学校登录或线上 PostHog 数据。

## 优先优化项

### 1. 缩小首屏 JavaScript 加载范围

**证据：**本地生产构建的入口 `index-CfL12j9Q.js` 为 **1,204.16 kB，gzip 382.05 kB**，触发 Vite 的大于 500 kB 警告。CSS 为 115.18 kB，gzip 21.20 kB。设置页和后台各分区已经分包，仍有进一步空间。

[App.tsx](../../frontend/src/App.tsx#L10) 同步引入注册、密码重置、OAuth 授权等页面；[posthog.ts](../../frontend/src/lib/posthog.ts#L1) 同步引入 SDK、recorder 与 exception-autocapture，且 [main.tsx](../../frontend/src/main.tsx#L12) 在挂载前初始化。关闭功能不等于剔除静态导入。

另用已有 Vite 的临时 `generateBundle` 检查入口模块贡献：`posthog-js` 的 `renderedLength` 合计 551,783 字节，`react-dom` 为 653,811 字节。这是 **minify 前的模块统计**，不能与 gzip 大小相加，也不是预估可省下的下载量。该次无写入分析构建显式关闭遥测变量，与上面的普通构建不作同配置体积对比。

**最小方向：**先分别评估低频页面的路由懒加载和 recorder 的同源动态导入，测量各自收益。保留已有身份同步、脱敏、异常采集和录制配置；不能仅为减小体积删除这些行为，也不应只调高 warning 阈值或拆出仍被同步加载的 vendor chunk。

**验收：**比较相同构建配置的入口请求和压缩体积，再用移动设备/网络条件检查 LCP、长任务与导航等待。当前没有真实 CWV 数据，不能据体积断言用户已遭遇卡顿。

指南：`performance`，特别是 “DO use dynamic imports”。

### 2. 为 SPA 路由提供有区别的文档标题

**证据：**[index.html](../../frontend/index.html#L10) 只有固定的 `CQU Auth`，业务源码未设置路由 `<title>` 或 `document.title`。隔离 Chromium 验证：从 `/login` 点击“立即注册”进入 `/register` 后，页面标题依旧是 `CQU Auth`；两个页面的 h1 分别为“欢迎回来”和“创建账号”。

这会降低多标签页、历史记录及辅助技术识别页面用途的能力。

**最小方向：**在现有页面/布局的标题责任处设置“登录 · CQU Auth”“账户安全 · CQU Auth”等标题。项目已使用 React 19，可使用内置 `<title>`，无需增加 Helmet；保证同一时刻只有一个文档标题，处理静态 fallback、嵌套布局与 Suspense 的组合。[React 官方说明](https://react.dev/reference/react-dom/components/title)支持组件内声明标题并强调单一标题限制；通过 Context7 核对。

**验收：**登录、注册、重置密码、授权、设置与后台导航及浏览器后退后标题正确；不把邮箱、验证码或查询参数写入标题。

指南：`accessibility`，“Update single-page application (SPA) titles during page transitions”。

### 3. 补齐设备额度字段的错误关联与恢复

**证据：**[QuotaEditor.tsx](../../frontend/src/components/quicklogin/QuotaEditor.tsx#L46) 对空值等非法输入设置错误；[输入框](../../frontend/src/components/quicklogin/QuotaEditor.tsx#L115) 有条件 `aria-invalid`，但没有 `aria-describedby`，且 `onChange` 只更新值。[错误段落](../../frontend/src/components/quicklogin/QuotaEditor.tsx#L140) 有 `role="alert"`，没有可关联的 ID。

因此错误首次出现时有播报机制，但再次聚焦字段时缺少错误描述关联；修正为有效整数后，旧的 invalid 状态和错误仍持续到下一次提交。非法提交分支也未主动把焦点移回字段。现有 [QuotaEditor 测试](../../frontend/src/components/quicklogin/QuotaEditor.test.tsx)覆盖预览、二次确认与失败处理，未覆盖这条字段错误恢复路径。

**最小方向：**为字段错误提供 ID/描述关联，提交校验失败时聚焦输入框，输入变为有效值时清除此字段的错误。保留网络错误、设备名单变化提示及预览后二次确认的行为，不以清除输入错误为由吞掉操作失败信息。

**验收：**空值提交后不发 API 请求、焦点回到字段且可读取错误；修正输入后 invalid 状态消失；已有额度预览和名单变化测试继续通过。

指南：`forms`、`accessibility`。规则包括 “use `aria-describedby` to link inputs with help text or error messages” 及输入时清除已解决错误。

### 4. 校准认证表单的自动填充语义

**证据：**[登录邮箱](../../frontend/src/pages/Login.tsx#L113)与[注册邮箱](../../frontend/src/pages/Register.tsx#L220)使用 `autocomplete="email"`，但这两个字段承担凭据中的用户名角色。指南建议该用途使用 `username`，同时保留 `type="email"`。

[注册邀请码](../../frontend/src/pages/Register.tsx#L355)使用 `one-time-code`，源码语义是 8 位注册邀请值，与六位登录/邮箱验证码不同；隔离 Chromium 也确认了这一属性。把它标记为 OTP 可能带来不相关验证码建议，尚未在真实密码管理器或手机系统中复现。

**最小方向：**登录/注册邮箱改用 `username` 并保留稳定 ID；注册邀请字段移除错误的 OTP 提示，可用 `autocomplete="off"`，同时保留 URL 预填和粘贴。真正验证码输入继续使用 `one-time-code`。不要机械替换密码重置/邮箱资料采集中的 `email`。

**验收：**真实浏览器密码管理器可保存并回填账号，注册仍建议新密码；邀请码预填及可选/必填流程不变。当前只确认属性与指南的差异，不声称现有登录自动填充必然失效。

指南：`autofill-sign-in-form`、`autofill-sign-up-form`、`forms`。

### 5. 恢复设置页的连续标题层级

**证据：**共享 `PageHeader` 输出 h1；[账户页](../../frontend/src/pages/Settings.tsx#L411)下直接放置 `AccountProfileSection`，其 [SettingsCard](../../frontend/src/components/SettingsCard.tsx#L16) 固定输出 h3，形成 h1 → h3。安全/CQU 设置也复用该组件。

**最小方向：**核对所有 `SettingsCard` 调用后，为直接隶属于页面标题的卡片使用 h2；保持现有视觉样式。当前没有证据需要新增一个可任意配置标题层级的组件 API。

**验收：**账户、安全、CQU 设置及加载态的标题树连续，组件与页面测试正常。

指南：`accessibility`，“Avoid ‘skipped’ heading levels”。这是导航语义改善，不是视觉样式问题。

## 保留现有实现与后续核验

- **验证码：**`VerificationCodeInput` 已采用单一真实 text 输入框、numeric 键盘、one-time-code、六位 pattern、粘贴和原生选区；外观格子为 `aria-hidden`。其 6 格外观不属于多输入框反模式。
- **共享组件：**AppShell 内已有 skip link 和可聚焦 main；Dialog/Select 由共享 UI 包负责，并有焦点返回测试。本次不把业务源码中未直接出现 `<dialog>` 当作重写理由。
- **动效：**入口有 View Transition 特性检测；入场动效在 no-preference 下启用，并有 reduced-motion 分支。部分 CSS 大范围关闭 transition 可作为后续精细化候选，但当前没有据此确认操作失败。
- **表单：**主流程有真实 form、label、required、新旧密码 autocomplete、错误焦点与重复提交保护。缺少 `name` 不足以证明受控 JSON 提交或自动填充失败；不将其单独升级为高优先问题。
- **构建 CSS：**Tailwind 的构建期 `@import` 不等于浏览器运行时串行 CSS 请求，不据此要求改写。
- **后续浏览器检查：**登录 → 注册时，Chromium 实测焦点已落在“创建账号”h1。设置区/后台尚未建立同等导航焦点证据，应另测键盘、移动 Sheet 关闭与浏览器后退，避免添加与共享组件争抢焦点的逻辑。
- **OAuth 输入：**管理页 URI 字段使用 text 是可改善候选，但需先核对自定义 scheme、localhost 等服务端允许值，再决定 type/url 键盘与字段级验证；本次未据此提出收紧 OAuth 契约。

## 验证记录

| 检查 | 结果与边界 |
| --- | --- |
| Modern Web Guidance legacy-scan | PASS：0 条命中；33 指南、35 规则，覆盖约 20% |
| `corepack pnpm@11.19.0 --dir frontend lint` | PASS |
| `corepack pnpm@11.19.0 --dir frontend check:design` | PASS；不能替代视觉验收 |
| `corepack pnpm@11.19.0 --dir frontend build` | PASS；保留入口 bundle 体积警告 |
| `npm test -- frontend/src` | PASS：42 个测试文件、247 项测试；PostHog 上游 sourcemap 缺失警告未导致失败 |
| 隔离 Chromium 登录 → 注册 | 确认固定文档标题、注册标题焦点及邀请码 autocomplete；合成 API 响应，所有外部请求拦截，结束后关闭预览与浏览器 |
| Rollup 入口贡献分析 | 只读构建、write=false，统计 renderedLength；未添加依赖或修改应用代码 |
| CI、部署、真实账号与真机/读屏器 | 未执行；本次未提交、推送、合并或发布 |

环境说明：全局 pnpm 12.21.0 被项目版本检查拒绝，改用锁定的 11.19.0 后安装成功；前端构建还依赖根项目的 Vitest 类型，按仓库约定完成 `npm ci` 后构建通过。没有修改包管理器配置或锁文件以绕过检查。

## 同日实施与验证

实施分支：`codex/modern-web-guidance-audit`，下述记录为基于上述提交、创建 PR 前的工作区验证。没有增加依赖、修改锁文件或放宽构建警告阈值。

- **加载范围：**注册、密码重置、邮箱验证、二次验证与 OAuth 授权页面沿用已有 `React.lazy` / `Suspense`。recorder 改为同源动态导入，保留 SDK 初始化、身份同步、异常采集和全部脱敏配置；导入失败由现有异常通道记录，不向路由 effect 抛出未处理 rejection。加载期间收到停止请求后，不再启动录制。
- **文档标题：**统一按匹配路由更新现有 `document.title`，加载态也可获得对应标题，未知路由有独立 fallback。保留 HTML 的单一标题节点，不把查询参数或 fragment 写入标题。React 19 直接追加 `<title>` 的试验出现两个标题节点，因此未采用该写法或新增 metadata 库。
- **额度错误：**输入校验失败时聚焦字段，用 `aria-describedby` 关联错误；有效输入解除字段错误与 invalid 状态。操作失败信息、额度预览和二次确认继续保留。
- **自动填充：**登录和注册邮箱使用 `autocomplete="username"`，保留 `type="email"`、稳定 ID、新旧密码区分；邀请字段改为 `off`，真实验证码保持 `one-time-code`。
- **标题结构：**核对调用处后，将设置卡片标题从 h3 改为 h2，保持样式和组件 API 不变。

### 同配置构建对比

两次均为生产模式、合成公开 telemetry token、`https://telemetry.invalid` host，关闭 sourcemap 上传；不使用真实凭据。与前面普通构建的数字分开比较。

| 指标 | 实施前 | 实施后 | 变化 |
| --- | ---: | ---: | ---: |
| 入口 JS | 1,212,124 B | 968,824 B | -20.1% |
| 入口 JS gzip | 383,500 B | 307,633 B | -19.8% |
| 独立 recorder chunk | 入口内 | 213.54 kB / gzip 69.60 kB | 路由 effect 后按需加载 |

录像开启时仍会下载 recorder；这项改动减少入口解析范围，不等于全会话传输减少同等比例。入口仍超过 500 kB，构建保留原警告。未测量真实 LCP / INP，不能据体积推断 CWV 提升。

### 实施后检查

| 检查 | 结果与边界 |
| --- | --- |
| `npm test -- frontend/src` | PASS：43 文件、252 测试；新增额度焦点/错误恢复、路由标题与录像异步加载回归。关键回归先验证失败，再修复通过 |
| 前端 lint / check:design / build | PASS；包体积警告仍在，PostHog 上游 sourcemap 警告不影响测试 |
| `npm run typecheck:e2e` | PASS |
| 既有注册验证登录 E2E | PASS：桌面、移动两种视口；本地隔离 Worker，覆盖注册、验证码、会话持久化、退出、错误密码与重新登录。错误密码日志来自预期反例 |
| 隔离 Chromium + 实际 posthog-js | PASS：延迟 recorder 时表单可输入，释放后 `sessionRecordingStarted()` 为 true；失败时登录/注册和后退正常且无 pageerror；非生产 origin 不请求 recorder。实际 SDK 保留全输入/文本遮罩与禁用外部依赖加载 |
| 浏览器语义检查 | PASS：登录 → 注册 → 后退标题正确且仅有一个 title；自动填充属性正确，注册后焦点落在 h1；登录页在 320 / 390 / 768 / 1440 px 无横向溢出 |

本地可复查证据（不入 Git）：`artifacts/modern-web/` 中的构建大小、测试日志和隔离浏览器检查；E2E 为 `.e2e/run-1794813211930/`。浏览器用本地构建与合成响应拦截所有请求，没有连接生产域名、真实账户或线上遥测。

以上本地验证阶段未执行 CI 或部署；后续提交、PR 与 CI 状态以 GitHub 为准。未验收真实密码管理器、真机/读屏器及生产录像上报。异步 recorder 开始前的短暂页面状态不会被录制。
