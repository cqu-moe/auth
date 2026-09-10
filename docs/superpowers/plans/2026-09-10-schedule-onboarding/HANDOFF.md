# 给执行模型的指令

请执行：
`/Users/uu/Developer/cqu-moe/auth/docs/superpowers/plans/2026-09-10-schedule-onboarding-plan.md`

先完整读取总计划、它链接的确认规格和00-frozen-reference.md，再读取当前Task章节。使用Superpowers executing-plans，严格按Task01到Task11顺序完成。本次执行范围是本地代码与测试；不push、不部署、不运行生产迁移。按当前会话授权决定是否提交本地commit。

用户已经确认第二版现有订阅列表预览。你没有重新设计的权限。不得添加周课表网格、新页面布局、新配色、新字体、大段引导、百分比或装饰动画。使用冻结的FirstSyncNotice组件参考，保留原Dashboard的Card/Button/Badge、通知、分享、删除、下载、二维码和网页预览业务。

每个Task先写红测试，确认失败原因，再实现并跑绿测试。禁止用预览的固定3/10、假链接、replay计时器或占位弹窗替代后端。禁止靠localStorage判断是否已经创建过默认订阅。

仓库为auth和schedule-cloudflare。确认当前工作目录和worktree，保留Auth已有五文件修复，不丢弃既存未跟踪文件，不git add .。从Task01开始；不要问要不要继续到下一个已授权Task。只在真实阻塞且独立工作已完成时报告问题，说明具体失败证据。

发现本计划与当前代码有机械性差异，按函数职责和接口适配，并在execution-log.md记录。涉及业务规则、权限、默认订阅数量或视觉设计的变化，不可擅自决定。不要修改冻结基线来让验收通过。

结束时分别报告两仓本地改动、测试证据、视觉对比、未实测的真实流程，以及未部署状态。
