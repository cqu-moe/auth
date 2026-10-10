# CI/CD

GitHub Actions 负责自动检查和构建归档；Cloudflare Workers Builds 负责部署。
PR、分支 push、`v*` tag 和手动运行均执行 Tests，稳定汇总检查名为 `CI`。
取消旧的分支运行不会中断 tag 发布。文档变更也生成检查结果。

## 本地与 CI 命令

使用 Node 22.22.3，根目录 `npm ci`，然后在 `frontend/` 运行
`corepack pnpm install --frozen-lockfile`（packageManager 锁定 pnpm 版本）。

- `npm run check:ci`：应用与 DO 类型、生成契约一致性、OpenAPI lint、导入边界、前端 lint/设计规则、Vitest、Workers/DO 测试。
- `npm run test:container`：linux/amd64 Chromium 镜像内运行 Python 测试，需要 Docker。沿用已存在的测试镜像和测试依赖版本。
- `npm run build:ci`：构建前端并 dry-run 打包 Worker，不上传版本，不应用 D1 迁移。
- `npm run package:ci`：打包前端、Worker、API JSON 和 SQL 迁移文件，生成 SHA-256。归档不包含 secrets、依赖、源码映射或整个仓库。

Actions 保存 `auth-<commit>` 构建产物 14 天，包含 tar.gz 和 `SHA256SUMS`。
产物来自应用检查 job；下载前必须确认整个运行的 `CI`（含容器测试）成功。
正式 `vX.Y.Z` 必须对应 package.json 版本，且提交已在 main 历史中；全部检查成功后创建 GitHub Release，不覆盖既有 Release。重新发布先修复失败原因，不移动已发布 tag。

## Cloudflare

Worker：`cqu-moe-auth`，生产分支 main，根目录 `/`。
建议构建命令：

```sh
npm ci && npx --yes pnpm@11.19.0 --dir frontend install --frozen-lockfile && VITE_RELEASE=$CF_BUILD_COMMIT_SHA npm run build:cloudflare
```

其中 `build:cloudflare` 在构建前执行应用、Workers 和 Docker 容器检查，任何一步失败即停止；Cloudflare 的 deploy command 保持现有命令及 release 标记。

容器检查先按生产 Dockerfile 构建基础镜像，再用 `container/Dockerfile.test` 在镜像构建阶段安装固定版本 pytest 并运行测试。根 `.dockerignore` 仅允许测试文件、fixture 和必要源码契约进入测试上下文，不使用 Cloudflare 构建机不支持的 `docker run`。当 Cloudflare 设置 `WRANGLER_CI_OVERRIDE_NETWORK_MODE_HOST` 时，两次构建都采用与 Wrangler 相同的 host 网络；生产镜像仍使用原 Dockerfile。
构建环境需要 Node 22、与 frontend/package.json 一致的 pnpm 和 Docker。
不在 Wrangler custom build hook 内跑测试，避免 Workers 测试读取 Wrangler 配置时递归构建。

Cloudflare Git 构建不会自动等待独立 Actions 的完成，不能把二者并行启动当作部署门禁。
私有仓库分支保护接口当前返回套餐限制；`CI` 汇总检查不会因此自动成为禁止合并的规则。
构建命令必须在 Cloudflare 控制台真实配置后才生效，仓库文档不能证明控制台已更新。

现有生产 deploy command 会先执行 `wrangler d1 migrations apply auth-cqu-moe-db --remote`，再部署 Worker；本次保留该行为。新增迁移必须继续单独审查，代码回滚不能撤销迁移。
发布验收分别记录 Actions、Cloudflare build/deploy、当前 Worker 版本及已登录业务验收。
