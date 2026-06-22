// Workers-pool 测试配置(@cloudflare/vitest-pool-workers, 跑在真 workerd 运行时里)。
// 独立于根 vitest.config.ts(Node pool, 跑 runtime-agnostic 纯函数单测)—— 两者 include
// 互斥, `npm run test` 不会跑这里的 DO 集成测试, 反之亦然。
//
// 用途: 锁住 CquSessionDO 方法体里只能在 workerd 内验证的时序行为(纯函数层已被 Node pool
// 覆盖, 但 DO 本体 import `cloudflare:workers` 在 Node pool 起不来)。
//
// 注意 pool-workers 0.16.x(vitest 4)已弃用旧 `defineWorkersProject` + `poolOptions.workers`,
// 改用从 `@cloudflare/vitest-pool-workers` 导出的 `cloudflareTest(<opts>)` Vite 插件(opts 形状
// 与旧 poolOptions.workers 一致)。见 dist/codemods/vitest-v3-to-v4。
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      // 复用生产 wrangler.jsonc 拿 DO/迁移/兼容性定义。
      wrangler: { configPath: "./wrangler.jsonc" },
      // 关掉 remote bindings: 生产 wrangler.jsonc 的 LOGIN_NODE(vpc_services)是 remote:true,
      // remoteBindings 默认 true 会拉起 remoteProxySession(需 CF 凭证 + 触网连真 VPC)。
      // 测试里从不真打 LOGIN_NODE —— 每个用例在 workerd 内 vi.spyOn(env.LOGIN_NODE,"fetch")
      // 拦截出站(DO 的 this.env.LOGIN_NODE 与测试 env.LOGIN_NODE 同一隔离区同一对象), 故彻底
      // 关掉远程代理, 保证 DO 测试完全本地、不依赖账户登录、不触网。
      // 注: miniflare.serviceBindings 覆盖 wrangler 的 vpc_services LOGIN_NODE 实测不生效(vpc
      // 远程绑定优先 → "needs to be run remotely"); 故改用 spy 路线, 根本不触达底层绑定。
      // 预期噪音: miniflare 启动期会向 stderr 打一行 `uncaught exception ... Binding LOGIN_NODE
      // needs to be run remotely`(远程代理桩在 spy 安装前被预探)+ containers sourcemap 缺失告警。
      // 二者均不来自测试体、不影响 exit 0 与全绿, 是已知背景噪音, 勿误判为真失败。
      remoteBindings: false,
      miniflare: {
        // DO 内可能访问的 env 标量(relogin 解密用 ENCRYPTION_KEY 等)。这里给最小集合;
        // 本批用例都不走真解密/查库分支, 仅作兜底避免缺键。
        bindings: {
          ENCRYPTION_KEY:
            "0000000000000000000000000000000000000000000000000000000000000000",
          BETTER_AUTH_URL: "http://localhost:8787",
          BETTER_AUTH_SECRET: "dev-secret-for-local-testing-only",
          RESEND_API_KEY: "re_dev_placeholder",
          BIND_EMAIL_DOMAIN: "cquotp.com",
        },
      },
    }),
  ],
  test: {
    include: ["test/do/**/*.test.ts"],
  },
});
