// CquSessionDO 集成测试共用夹具/驱动。
//
// 关键机制(spike 验证, 见 vitest.workers.config.mts 注释):
//   · LOGIN_NODE 是生产 wrangler.jsonc 的 vpc_services(remote:true)绑定, miniflare
//     serviceBindings 覆盖它实测不生效。改为每个用例在 workerd 内 vi.spyOn(env.LOGIN_NODE,
//     "fetch") 拦截出站 —— DO 的 this.env.LOGIN_NODE 与测试 env.LOGIN_NODE 是同一隔离区
//     同一对象, 故 spy 对 DO 内出站生效。
//   · alarm() 直接经 runInDurableObject(stub, inst => inst.alarm()) 驱动(faithful 到方法体);
//     不走 runDurableObjectAlarm —— 后者需 storage 里有已排定的 alarm, 与直接 seed state 不契合。
import { env, runInDurableObject } from "cloudflare:test";
import { vi, type MockInstance } from "vitest";
import type { CquStorageState } from "../../src/services/cqu-sso";

let seq = 0;
/** 每次调用返回唯一 DO stub(隔离命名, 避免用例间 storage 串扰)。 */
export function freshStub(prefix = "do-test") {
  const name = `${prefix}-${seq++}-${Math.random().toString(36).slice(2)}`;
  const id = env.CQU_SESSION.idFromName(name);
  return env.CQU_SESSION.get(id);
}

/** CAS 三件套齐全的合法 storageState(hasValidTgt 为 true)。 */
export function validStorageState(): CquStorageState {
  return {
    cookies: [
      { name: "SOURCEID_TGC", value: "tgt-value", domain: "sso.cqu.edu.cn", path: "/" },
      { name: "SESSION", value: "session-value", domain: "sso.cqu.edu.cn", path: "/" },
      { name: "rg_objectid", value: "obj-value", domain: "sso.cqu.edu.cn", path: "/" },
    ],
    origins: [],
  };
}

export interface SeedOpts {
  status?: string;
  storageState?: CquStorageState | null;
  loginAt?: number;
  /** 额外 storage 键(如 stMintLog)。 */
  extra?: Record<string, unknown>;
}

/** 在 stub 的 DO storage 里直接 seed 一个会话状态。 */
export async function seedSession(
  stub: DurableObjectStub,
  opts: SeedOpts = {}
): Promise<void> {
  const now = Date.now();
  await runInDurableObject(stub, async (_inst, state) => {
    await state.storage.put({
      status: opts.status ?? "active",
      state: {
        userId: "u1",
        studentId: "2020000001",
        storageState:
          opts.storageState === undefined ? validStorageState() : opts.storageState,
        objectId: "",
        tgt: "",
        loginAt: opts.loginAt ?? now,
        lastKeepAlive: now,
        lastRequestedAt: now,
        consecutiveFailures: 0,
      },
      ...(opts.extra ?? {}),
    });
  });
}

/** 直接驱动 DO 的 alarm() 方法体(在 DO 上下文内)。 */
export async function driveAlarm(stub: DurableObjectStub): Promise<void> {
  await runInDurableObject(stub, async (inst) => {
    await (inst as unknown as { alarm: () => Promise<void> }).alarm();
  });
}

/**
 * 驱动 alarm(),但先在【同一个 DO 上下文】里跑 setup(拿到 inst+state)。
 * 用于 M7: 让 keepalive spy 在出站时往【同一个 state.storage】写 revoked(同 DO 上下文,
 * 不触发跨 DO I/O 限制),从而忠实复现「探活在途时 status 被改写 → 写回前重查命中撤销」。
 */
export async function driveAlarmWith(
  stub: DurableObjectStub,
  setup: (inst: unknown, state: DurableObjectState) => void | Promise<void>
): Promise<void> {
  await runInDurableObject(stub, async (inst, state) => {
    await setup(inst, state);
    await (inst as unknown as { alarm: () => Promise<void> }).alarm();
  });
}

/** 读 DO 当前 status。 */
export async function readStatus(stub: DurableObjectStub): Promise<string | undefined> {
  return runInDurableObject(stub, async (_inst, state) =>
    state.storage.get<string>("status")
  );
}

/** 读 DO 当前已排定的 alarm 时刻(无则 null)。 */
export async function readAlarm(stub: DurableObjectStub): Promise<number | null> {
  return runInDurableObject(stub, async (_inst, state) => state.storage.getAlarm());
}

/** 读 DO 当前 SessionState(用于断言 storageState 未被破坏性覆盖)。 */
export async function readState(
  stub: DurableObjectStub
): Promise<{ storageState: CquStorageState | null } | undefined> {
  return runInDurableObject(stub, async (_inst, state) =>
    state.storage.get("state")
  );
}

/** 读取任意测试关注的 DO storage 键。 */
export async function readStorage<T>(
  stub: DurableObjectStub,
  key: string
): Promise<T | undefined> {
  return runInDurableObject(stub, async (_inst, state) =>
    state.storage.get<T>(key)
  );
}

/** 读窗口内 ST 铸票记录(限流账本)。 */
export async function readStMintLog(
  stub: DurableObjectStub
): Promise<Array<{ ts: number; clientId: string | null; host: string; broad: boolean }>> {
  return (
    (await runInDurableObject(stub, async (_inst, state) =>
      state.storage.get("stMintLog")
    )) ?? []
  );
}

/**
 * spy 掉某个 DO 自身的 storage.setAlarm, 把每次排定的目标时刻(ms)记入返回数组(仍透传真排)。
 * 用于 H4 确定性断言「409 路径排了即时 alarm」—— 避开「setAlarm(now) 后即时 alarm 自动触发并
 * 被消费」造成的 getAlarm() 读取竞态(读到 null/已重排)。
 */
export async function captureSetAlarm(
  stub: DurableObjectStub
): Promise<number[]> {
  const calls: number[] = [];
  await runInDurableObject(stub, async (_inst, state) => {
    const orig = state.storage.setAlarm.bind(state.storage);
    vi.spyOn(state.storage, "setAlarm").mockImplementation(
      async (t: number | Date, opts?: DurableObjectSetAlarmOptions) => {
        calls.push(t instanceof Date ? t.getTime() : t);
        return orig(t, opts);
      }
    );
  });
  return calls;
}

/**
 * spy 掉 env.LOGIN_NODE.fetch, 按出站请求 path 路由到 handlers[path]。
 * 未声明 path → 抛, 暴露漏设桩。返回 spy 供断言调用次数。
 */
export function spyLoginNode(
  handlers: Record<string, (req: Request) => Response | Promise<Response>>
): MockInstance {
  return vi
    .spyOn(env.LOGIN_NODE, "fetch")
    .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input as string | URL, init);
      const path = new URL(req.url).pathname;
      const h = handlers[path];
      if (!h) throw new Error(`unstubbed LOGIN_NODE path: ${path}`);
      return Promise.resolve(h(req));
    }) as unknown as MockInstance;
}
