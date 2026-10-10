# Issue tracker: GitHub

Issues 和规格使用本仓库的 GitHub Issues。仓库名从 `git remote get-url origin` 确认；使用 `gh` CLI，在当前仓库目录执行。

- “fetch the relevant ticket”：`gh issue view <number> --json number,title,body,labels,comments`。
- “publish to the issue tracker”：创建 GitHub issue；多行正文写临时 UTF-8 文件，使用 `gh issue create --title '标题' --body-file <path>`。编辑和评论同样使用 `--body-file`。
- 列举、标签、关闭等操作先查对应 `gh issue <command> --help`；标签角色见 [triage-labels.md](triage-labels.md)。
- 配置不代表自动授权对外写入；执行当前用户任务或其明确调用技能所授权的操作，完成后读取远端结果核对。
- 子任务优先关联 GitHub 原生 sub-issues；CLI/仓库不支持时，在子 issue 写 `Part of #<parent>` 并在父 issue 保留任务列表。
- 阻塞关系优先用 GitHub 原生 dependencies；不可用时写 `Blocked by: #<number>`。仅处理阻塞已关闭且未被认领的任务，认领时指派当前执行者。

**PRs as a request surface: no.**
