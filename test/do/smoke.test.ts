// Spike 冒烟: 验证 vitest-pool-workers 能在 workerd 里起 CquSessionDO, 拿 stub,
// 并经 runInDurableObject 读写 DO storage。通过即证明配置链(cloudflareTest 插件 +
// wrangler.jsonc DO/migrations)整体可用。LOGIN_NODE 在各用例内经 vi.spyOn 拦截
// (serviceBindings 覆盖 vpc 远程绑定实测不生效, 见 vitest.workers.config.mts)。
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("vitest-pool-workers smoke", () => {
  it("can get a CquSessionDO stub and round-trip storage", async () => {
    const id = env.CQU_SESSION.idFromName("smoke-user");
    const stub = env.CQU_SESSION.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("status", "active");
      const status = await state.storage.get<string>("status");
      expect(status).toBe("active");
    });
  });
});
