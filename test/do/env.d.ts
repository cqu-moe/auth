// DO 集成测试的环境类型声明。
// · 引入 @cloudflare/vitest-pool-workers 的运行时类型(cloudflare:test 模块: env/runInDurableObject 等)。
// · 把 cloudflare:test 的 `env`(类型 Cloudflare.Env)对齐到本项目的 Env(src/types.ts) ——
//   本仓没有 wrangler 自动生成的 worker-configuration.d.ts, 故手动声明 Cloudflare.Env extends Env,
//   让 env.CQU_SESSION / env.LOGIN_NODE 等绑定在测试里有类型。
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { Env } from "../../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends ImportedEnv {
      TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
    }
  }
}

// 间接 alias 规避 `interface X extends X`(同名)的自引用; 实际继承自 src/types.ts 的 Env。
type ImportedEnv = Env;

export {};
