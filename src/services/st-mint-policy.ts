// Service Ticket(ST)铸造的限频/告警策略 —— 纯函数, 无副作用, 便于单测。
// 镜像 cqu-2fa/relogin-policy.ts 的「纯策略 + DO 侧只读写 storage 并调用」分工:
// DO 从 storage 读写「近期取票记录(StMintRecord[])」, 阈值与判定集中在本文件。
//
// 取票是 DO 的权威 chokepoint(route / 未来 RPC / DO 内铸都汇于 getServiceTicket),
// betterAuth 的 HTTP rateLimit 覆盖不到 RPC 路径与 DO 内铸 —— 故限频/审计必须落在这里。

// 滑动窗口: 1min。窗口内对「每用户」与「每 client」分别计数。
export const ST_MINT_RATE_WINDOW_MS = 60_000; // 1min

// 每用户(本 DO = 单用户)窗口内取票上限(跨所有 client 合计)。
export const MAX_ST_MINTS_PER_USER = 60;

// 每 client(按 clientId 分桶)窗口内取票上限。null clientId 自成一桶。
export const MAX_ST_MINTS_PER_CLIENT = 30;

// 窗口内出现的「不同 broad-path host」数超此阈值即告警(开放重定向探测信号): 正常一个
// 浏览器插件只会冲着少数几个域取 ST, 短窗内冒出大量不同域多半是在拿本服务当 ST 中继探活。
export const DISTINCT_HOST_ALERT_THRESHOLD = 5;

// 一条取票记录。broad = serviceUrl 模式(广路径快捷登录); 符号 key 模式 broad=false。
// 绝不记录 ticket / cookies / 密码 —— 只留时刻、clientId、目标 host、是否广路径。
export interface StMintRecord {
  ts: number;
  clientId: string | null;
  host: string;
  broad: boolean;
}

/**
 * 把取票记录裁到窗口内: 保留 now - windowMs <= ts <= now 的记录(含两端边界)。
 * 丢弃过旧(滑出窗口)与未来(时钟漂移)异常时刻。返回新数组, 不改入参。
 * 语义与 relogin-policy.pruneAttempts 完全一致(只是元素是记录而非裸时刻)。
 */
export function pruneStMintLog(
  log: StMintRecord[],
  now: number,
  windowMs: number
): StMintRecord[] {
  const lowerBound = now - windowMs;
  return log.filter((r) => r.ts >= lowerBound && r.ts <= now);
}

/**
 * 「现在再铸一张」是否会越过 per-user 或 per-client 上限。
 * 入参应为已裁剪到窗口内的 log(pruned)。判定基于「已在窗口内的计数 >= 上限」:
 *   - per-user : pruned.length >= maxUser(本 DO 即单用户, 全部记录都计)。
 *   - per-client: 与候选 clientId 同桶(null 只跟 null 同桶)的记录数 >= maxClient。
 * 任一命中即限流。
 */
export function stMintThrottled(
  pruned: StMintRecord[],
  clientId: string | null,
  maxUser: number,
  maxClient: number
): boolean {
  if (pruned.length >= maxUser) return true;
  const sameClient = pruned.filter((r) => r.clientId === clientId).length;
  return sameClient >= maxClient;
}

/**
 * 窗口内(已裁剪 log)出现的「不同 broad-path host」数, 计入候选 host(若非 null)。
 * 只数 broad=true 的记录(符号 key 模式不计); 候选 host 视为「本次将铸的 broad 目标」纳入去重集。
 * 供 DO 在 broad 路径上算「distinct broad hosts > 阈值 → 告警(只告警不拦)」。
 */
export function distinctBroadHosts(
  pruned: StMintRecord[],
  candidateHost: string | null
): number {
  const hosts = new Set<string>();
  for (const r of pruned) {
    if (r.broad) hosts.add(r.host);
  }
  if (candidateHost !== null) hosts.add(candidateHost);
  return hosts.size;
}
