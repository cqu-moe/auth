export type BindKind = "direct" | "forward";
export type BindStatus = "unbound" | "pending" | "active" | "revoked" | "deleting";

export interface BindingSnapshot {
  address?: string;
  bindStatus: BindStatus;
  kind?: BindKind;
  forwardAddress?: string;
  sessionStatus: unknown;
}

export interface SavedBindProgress {
  userId: string;
  address: string;
  kind: BindKind;
  step: 2 | 3;
}

export type BindScreen = "intro" | "address" | "credentials" | "waiting" | "complete";

interface ProgressReader {
  getItem(key: string): string | null;
}

interface ProgressWriter {
  setItem(key: string, value: string): void;
}

interface ProgressRemover {
  removeItem(key: string): void;
}

export function bindProgressKey(userId: string) {
  return `cqu-bind-progress:${userId}`;
}

export function readBindProgress(storage: ProgressReader, userId: string): SavedBindProgress | null {
  try {
    const raw = storage.getItem(bindProgressKey(userId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.userId !== userId
      || typeof candidate.address !== "string"
      || !bindKinds.has(candidate.kind as BindKind)
      || (candidate.step !== 2 && candidate.step !== 3)
    ) {
      return null;
    }
    return {
      userId,
      address: candidate.address,
      kind: candidate.kind as BindKind,
      step: candidate.step,
    };
  } catch {
    return null;
  }
}

export function writeBindProgress(storage: ProgressWriter, progress: SavedBindProgress) {
  try {
    storage.setItem(bindProgressKey(progress.userId), JSON.stringify({
      userId: progress.userId,
      address: progress.address,
      kind: progress.kind,
      step: progress.step,
    }));
  } catch {
    // Storage may be unavailable in private or constrained browsing contexts.
  }
}

export function clearBindProgress(storage: ProgressRemover, userId: string) {
  try {
    storage.removeItem(bindProgressKey(userId));
  } catch {
    // Binding success is authoritative even when local progress cannot be cleared.
  }
}

const bindStatuses = new Set<BindStatus>(["unbound", "pending", "active", "revoked", "deleting"]);
const bindKinds = new Set<BindKind>(["direct", "forward"]);

export function parseBindingSnapshot(value: unknown): BindingSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid binding response");
  }

  const candidate = value as Record<string, unknown>;
  if (
    !bindStatuses.has(candidate.bindStatus as BindStatus)
    || !("sessionStatus" in candidate)
    || (candidate.address !== undefined && typeof candidate.address !== "string")
    || (candidate.kind !== undefined && !bindKinds.has(candidate.kind as BindKind))
    || (candidate.forwardAddress !== undefined && typeof candidate.forwardAddress !== "string")
  ) {
    throw new Error("Invalid binding response");
  }

  return {
    ...(candidate.address === undefined ? {} : { address: candidate.address as string }),
    bindStatus: candidate.bindStatus as BindStatus,
    ...(candidate.kind === undefined ? {} : { kind: candidate.kind as BindKind }),
    ...(candidate.forwardAddress === undefined
      ? {}
      : { forwardAddress: candidate.forwardAddress as string }),
    sessionStatus: candidate.sessionStatus,
  };
}

export function bindScreen(
  snapshot: BindingSnapshot,
  saved: SavedBindProgress | null,
  userId: string,
  repair = false,
): BindScreen {
  if (snapshot.bindStatus === "active" && !repair) return "complete";

  const session = snapshot.sessionStatus;
  if (
    session
    && typeof session === "object"
    && !Array.isArray(session)
    && (session as { status?: unknown }).status === "binding"
  ) {
    return "waiting";
  }

  if (repair) return snapshot.address ? "credentials" : "intro";
  if (!snapshot.address) return "intro";

  if (
    saved?.step === 3
    && saved.userId === userId
    && saved.address === snapshot.address
    && saved.kind === snapshot.kind
  ) {
    return "credentials";
  }

  return "address";
}
