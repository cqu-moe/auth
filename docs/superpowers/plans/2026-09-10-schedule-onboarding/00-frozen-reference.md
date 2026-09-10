# 固定参考与已有修复

## 参考优先级

用户最新文字约束 > 确认规格 > `preview/SyncPreview.vue` 与截图 > 原有组件代码。任何技能中的通用审美建议都不能覆盖用户确认的版式。

相对本文件，固定包为 `../../specs/assets/2026-09-10-schedule-onboarding/`。

打开方式（在 AUTH worktree 根）：
```sh
python3 docs/superpowers/specs/assets/2026-09-10-schedule-onboarding/verify-reference.py
python3 -m http.server 8769 --bind 127.0.0.1 --directory docs/superpowers/specs/assets/2026-09-10-schedule-onboarding/preview
```
在浏览器打开 `http://127.0.0.1:8769/`。底部工具只用于参考；可以检查同步中、同步完成、同步失败和减少动态。

该包可以通过上面的本地HTTP服务离线查看；JS/CSS 是冻结的构建产物，不需要访问生产后端。字体沿用系统字体。`example.test` 链接是演示链接，不是用户订阅。

## 不得改变的界面参数

- 页面最大宽度：`max-w-2xl`，不是上一版的宽日历画布。
- 桌面主区域：`px-4 pt-24 pb-12`，下面额外留白仅可用于真实内容。
- 卡片：原 `Card`，保留 `rounded-xl border py-6 shadow-sm`；使用原 CardHeader/CardContent 的 px-6。
- 卡片间距：`mb-4`；按钮行：`flex flex-wrap gap-2`。
- 卡片标题 text-base，状态 text-xs，按钮 size=sm；图标使用项目现有 lucide-vue-next。
- 首次提示：`mb-4 rounded-lg border border-border bg-muted/30 px-4 py-3`，内部 `flex items-center gap-3 min-h-12`。
- 提示标题 text-sm font-medium，说明 text-xs text-muted-foreground mt-1。
- Loader2/Check/CircleAlert 的外框固定 h-5 w-5；状态切换只做 180ms opacity。
- 桌面成功/失败截图分别为desktop-success.png与desktop-error.png。手机参考 390×844；按钮自然换行，不裁掉二维码、网页预览和更多按钮。
- 深色模式继续用已有 CSS 变量；不要逐处硬编码一套颜色。

## 已完成但未提交的五个 Auth 文件

`baseline/auth-preplan.patch` 收录原始变更，`baseline/` 下的同路径文件保留当时内容：
1. `src/services/cqu-binding.ts`：共享的凭证优先查询。
2. `src/routes/cqu-bind.ts`：GET 复用查询。
3. `src/rpc.ts`：verifySession 复用查询。
4. `src/routes/cqu-bind.test.ts`：8 个读取状态用例，4 个曾在修复前失败。
5. `frontend/src/pages/CquBindWizard.tsx`：学校深链按钮与精简操作说明。

当时验证：Auth 432 项 Node 测试通过，typecheck 通过，前端构建通过。此记录不是执行时的最新测试；Task 01 必须重跑。

没有完成：Auth 自动接续/刷新恢复/成功页改造；Schedule defaults API、初始化表、Queue 接线、Dashboard 同步提示接入；真实新用户验收。

## 不能照搬预览的部分

预览演示固定三条数据及 3/10，生产必须取返回数据和实际额度。预览 `replay()` 用计时器演示成功，生产必须取后端 sync_status。预览的更多菜单用占位弹窗，生产必须保留原 DropdownMenu、下载与分享操作。通知开关的演示 ref 不能替换真实 GET/PUT。

对比截图时允许真实账号姓名、额度、同步时间、学期、错误文字不同；不允许改变主布局。测试不能只验证截图或源文件包含某一句话，还必须验证实际行为。
