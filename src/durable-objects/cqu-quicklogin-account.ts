import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  assertGrantFromState,
  emptyAccountState,
  getDeviceAuthorityFromState,
  listDevicesFromState,
  QuickloginAccountError,
  reduceAccount,
  type AccountCommand,
} from "../services/quicklogin/account-reducer";
import type {
  AccountState,
  DeviceList,
  DeviceMetadata,
  ErrorCode,
  HeartbeatInput,
  QuotaApply,
  QuotaPreview,
} from "../services/quicklogin/contracts";
import {
  deferOutboxEvent,
  dispatchOutboxEvent,
  nextOutboxAlarm,
  type OutboxDispatcher,
  type OutboxEvent,
} from "../services/quicklogin/outbox";
import { selectQuotaDevices, validateDeviceLimit } from "../services/quicklogin/policy";
import { projectAccount } from "../services/quicklogin/projection";
import { QuickloginDeviceClient } from "../services/quicklogin/device-client";
import { revokeProviderGrantFamily } from "../services/quicklogin/oauth-grants";

const ACCOUNT_KEY = "account";
const OWNER_KEY = "ownerUserId";
const OUTBOX_KEY = "outbox";
const PREVIEW_PREFIX = "quotaPreview:";
const RESULT_PREFIX = "quotaResult:";
const PREVIEW_TTL_MS = 5 * 60_000;

interface StoredQuotaResult {
  newLimit: number;
  result: DeviceList;
}

class PreviewChangedError extends QuickloginAccountError {
  constructor(public readonly preview: QuotaPreview) {
    super("PREVIEW_CHANGED");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new QuickloginAccountError("INVALID_REQUEST");
  }
  return value;
}

function readBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new QuickloginAccountError("INVALID_REQUEST");
  }
  return value;
}

function readNow(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new QuickloginAccountError("INVALID_REQUEST");
  }
  return value;
}

function sameDeviceSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((deviceId) => expected.has(deviceId));
}

function errorStatus(code: ErrorCode): number {
  switch (code) {
    case "FORBIDDEN":
    case "DEVICE_REVOKED":
    case "MASTER_DISABLED":
    case "DEVICE_DISABLED":
    case "NO_DEVICE_CAPACITY":
      return 403;
    case "DEVICE_LIMIT_REACHED":
    case "STALE_GENERATION":
    case "PREVIEW_CHANGED":
      return 409;
    case "INVALID_REQUEST":
      return 422;
    case "PROTOCOL_UNSUPPORTED":
      return 426;
    default:
      return 500;
  }
}

export class CquQuickloginAccountDO extends DurableObject<Env> {
  private ownerUserId: string | null = null;
  private readonly outboxDispatcher: OutboxDispatcher | undefined;

  constructor(
    ctx: DurableObjectState,
    env: Env,
    outboxDispatcher?: OutboxDispatcher
  ) {
    super(ctx, env);
    this.outboxDispatcher =
      outboxDispatcher ?? ((event) => this.dispatchOutbox(event));
    ctx.blockConcurrencyWhile(async () => {
      this.ownerUserId = (await ctx.storage.get<string>(OWNER_KEY)) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return this.errorResponse("INVALID_REQUEST", 405);
      }
      const body = await request.json<unknown>();
      if (!isRecord(body) || !isRecord(body.payload)) {
        throw new QuickloginAccountError("INVALID_REQUEST");
      }
      const operation = readString(body.operation);
      const ownerUserId = readString(body.ownerUserId);
      await this.ensureOwner(ownerUserId);
      const payload = body.payload;
      let result: unknown;

      switch (operation) {
        case "create_pending_grant":
          result = await this.mutate(
            {
              type: "create_pending_grant",
              grantId: crypto.randomUUID(),
              ownerUserId,
              clientId: readString(payload.clientId),
            },
            readNow(payload.now)
          );
          break;
        case "activate_grant":
          result = await this.mutate(
            { type: "activate_grant", grantId: readString(payload.grantId) },
            readNow(payload.now)
          );
          break;
        case "register_device": {
          if (!isRecord(payload.metadata)) {
            throw new QuickloginAccountError("INVALID_REQUEST");
          }
          const metadata: DeviceMetadata = {
            deviceName: readString(payload.metadata.deviceName),
            browserFamily:
              payload.metadata.browserFamily === "chrome"
                ? "chrome"
                : (() => {
                    throw new QuickloginAccountError("INVALID_REQUEST");
                  })(),
            browserVersion: readString(payload.metadata.browserVersion),
          };
          result = await this.mutate(
            {
              type: "register_device",
              grantId: readString(payload.grantId),
              deviceId: crypto.randomUUID(),
              metadata,
            },
            Date.now()
          );
          break;
        }
        case "set_device_enabled":
          result = await this.mutate(
            {
              type: "set_device_enabled",
              deviceId: readString(payload.deviceId),
              enabled: readBoolean(payload.enabled),
            },
            Date.now()
          );
          break;
        case "set_master_enabled":
          result = await this.mutate(
            {
              type: "set_master_enabled",
              enabled: readBoolean(payload.enabled),
            },
            Date.now()
          );
          break;
        case "revoke_device":
          result = await this.mutate(
            { type: "revoke_device", deviceId: readString(payload.deviceId) },
            readNow(payload.now)
          );
          break;
        case "get_device_authority": {
          const state = await this.readAccount();
          result = getDeviceAuthorityFromState(
            state,
            readString(payload.deviceId)
          );
          break;
        }
        case "assert_grant": {
          const state = await this.readAccount();
          result = assertGrantFromState(
            state,
            readString(payload.grantId),
            readString(payload.clientId)
          );
          break;
        }
        case "list_devices":
          result = listDevicesFromState(
            await this.readAccount(),
            readNow(payload.now)
          );
          break;
        case "heartbeat": {
          if (!isRecord(payload.input)) {
            throw new QuickloginAccountError("INVALID_REQUEST");
          }
          const input: HeartbeatInput = {
            protocolVersion:
              payload.input.protocolVersion === 1
                ? 1
                : (() => {
                    throw new QuickloginAccountError("PROTOCOL_UNSUPPORTED");
                  })(),
            appliedVersion:
              payload.input.appliedVersion === null
                ? null
                : readNow(payload.input.appliedVersion),
            generation: readNow(payload.input.generation),
            browserVersion: readString(payload.input.browserVersion),
          };
          if (payload.ip !== null && typeof payload.ip !== "string") {
            throw new QuickloginAccountError("INVALID_REQUEST");
          }
          result = await this.mutate(
            {
              type: "heartbeat",
              deviceId: readString(payload.deviceId),
              input,
              ip: payload.ip as string | null,
            },
            readNow(payload.now)
          );
          break;
        }
        case "notify_binding_changed":
          result = await this.mutate(
            { type: "notify_binding_changed" },
            Date.now()
          );
          break;
        case "preview_quota":
          result = await this.previewQuota(
            validateDeviceLimit(payload.limit),
            readNow(payload.now)
          );
          break;
        case "apply_quota": {
          if (!isRecord(payload.input)) {
            throw new QuickloginAccountError("INVALID_REQUEST");
          }
          const input: QuotaApply = {
            token: readString(payload.input.token),
            newLimit: validateDeviceLimit(payload.input.newLimit),
          };
          result = await this.applyQuota(input, readNow(payload.now));
          break;
        }
        default:
          throw new QuickloginAccountError("INVALID_REQUEST");
      }

      return Response.json(
        { result },
        { headers: { "cache-control": "no-store" } }
      );
    } catch (error) {
      if (error instanceof PreviewChangedError) {
        return Response.json(
          {
            error: { code: error.code, message: error.message },
            preview: error.preview,
          },
          {
            status: errorStatus(error.code),
            headers: { "cache-control": "no-store" },
          }
        );
      }
      if (error instanceof QuickloginAccountError) {
        return this.errorResponse(error.code, errorStatus(error.code));
      }
      return this.errorResponse("TEMPORARY_UNAVAILABLE", 503);
    }
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const snapshot =
      (await this.ctx.storage.get<OutboxEvent[]>(OUTBOX_KEY)) ?? [];
    const due = snapshot.filter((event) => event.nextAttemptAt <= now);
    const delivered = new Set<string>();

    for (const event of due) {
      try {
        if (await dispatchOutboxEvent(event, this.outboxDispatcher)) {
          delivered.add(event.id);
        }
      } catch {
        // The durable event remains queued and receives the same bounded backoff.
      }
    }

    await this.ctx.storage.transaction(async (tx) => {
      const current = (await tx.get<OutboxEvent[]>(OUTBOX_KEY)) ?? [];
      const dueIds = new Set(due.map((event) => event.id));
      const next = current.flatMap((event) => {
        if (delivered.has(event.id)) return [];
        if (dueIds.has(event.id)) return [deferOutboxEvent(event, now)];
        return [event];
      });
      await tx.put(OUTBOX_KEY, next);
      const alarm = nextOutboxAlarm(next);
      if (alarm === null) await tx.deleteAlarm();
      else await tx.setAlarm(alarm);
    });
  }

  private errorResponse(code: ErrorCode, status: number): Response {
    return Response.json(
      { error: { code, message: code } },
      { status, headers: { "cache-control": "no-store" } }
    );
  }

  private async dispatchOutbox(event: OutboxEvent): Promise<boolean> {
    const ownerUserId =
      this.ownerUserId ??
      (await this.ctx.storage.get<string>(OWNER_KEY)) ??
      null;
    if (!ownerUserId) return false;
    if (event.kind === "projection") {
      await projectAccount(this.env, ownerUserId, await this.readAccount());
      return true;
    }
    if (event.kind === "device-notify" && event.deviceId) {
      const authority = getDeviceAuthorityFromState(
        await this.readAccount(),
        event.deviceId
      );
      await new QuickloginDeviceClient(this.env).notifyDevice(authority);
      return true;
    }
    if (event.kind === "revoke-oauth-family" && event.grantId) {
      await revokeProviderGrantFamily(
        this.env,
        ownerUserId,
        this.env.QUICKLOGIN_CLIENT_ID,
        event.grantId
      );
      return true;
    }
    return false;
  }

  private async ensureOwner(ownerUserId: string): Promise<void> {
    if (this.ownerUserId !== null) {
      if (this.ownerUserId !== ownerUserId) {
        throw new QuickloginAccountError("FORBIDDEN");
      }
      return;
    }
    await this.ctx.storage.transaction(async (tx) => {
      const stored = (await tx.get<string>(OWNER_KEY)) ?? null;
      if (stored !== null && stored !== ownerUserId) {
        throw new QuickloginAccountError("FORBIDDEN");
      }
      if (stored === null) await tx.put(OWNER_KEY, ownerUserId);
    });
    this.ownerUserId = ownerUserId;
  }

  private async readAccount(): Promise<AccountState> {
    return (
      (await this.ctx.storage.get<AccountState>(ACCOUNT_KEY)) ??
      emptyAccountState()
    );
  }

  private async mutate(command: AccountCommand, now: number): Promise<unknown> {
    let result: unknown;
    await this.ctx.storage.transaction(async (tx) => {
      const state =
        (await tx.get<AccountState>(ACCOUNT_KEY)) ?? emptyAccountState();
      const outbox = (await tx.get<OutboxEvent[]>(OUTBOX_KEY)) ?? [];
      const reduction = reduceAccount(state, command, now);
      result = reduction.result;
      const nextOutbox = [...outbox, ...reduction.events];
      await tx.put({
        [ACCOUNT_KEY]: reduction.state,
        [OUTBOX_KEY]: nextOutbox,
      });
      const alarm = nextOutboxAlarm(nextOutbox);
      const currentAlarm = await tx.getAlarm();
      if (alarm !== null && (currentAlarm === null || alarm < currentAlarm)) {
        await tx.setAlarm(alarm);
      }
    });
    return result;
  }

  private async previewQuota(limit: number, now: number): Promise<QuotaPreview> {
    const token = crypto.randomUUID();
    let preview: QuotaPreview | undefined;
    await this.ctx.storage.transaction(async (tx) => {
      const state =
        (await tx.get<AccountState>(ACCOUNT_KEY)) ?? emptyAccountState();
      const selection = selectQuotaDevices(Object.values(state.devices), limit);
      preview = {
        token,
        expiresAt: now + PREVIEW_TTL_MS,
        revision: state.revision,
        oldLimit: state.deviceLimit,
        newLimit: limit,
        ...selection,
      };
      await tx.put(`${PREVIEW_PREFIX}${token}`, preview);
    });
    return preview as QuotaPreview;
  }

  private async applyQuota(input: QuotaApply, now: number): Promise<DeviceList> {
    let result: DeviceList | undefined;
    let changedPreview: QuotaPreview | undefined;

    await this.ctx.storage.transaction(async (tx) => {
      const storedResult = await tx.get<StoredQuotaResult>(
        `${RESULT_PREFIX}${input.token}`
      );
      if (storedResult) {
        if (storedResult.newLimit !== input.newLimit) {
          throw new QuickloginAccountError("INVALID_REQUEST");
        }
        result = storedResult.result;
        return;
      }

      const preview = await tx.get<QuotaPreview>(`${PREVIEW_PREFIX}${input.token}`);
      if (
        !preview ||
        preview.expiresAt <= now ||
        preview.newLimit !== input.newLimit
      ) {
        throw new QuickloginAccountError("INVALID_REQUEST");
      }

      const state =
        (await tx.get<AccountState>(ACCOUNT_KEY)) ?? emptyAccountState();
      const selection = selectQuotaDevices(
        Object.values(state.devices),
        input.newLimit
      );
      if (
        !sameDeviceSet(selection.kept, preview.kept) ||
        !sameDeviceSet(selection.disabled, preview.disabled)
      ) {
        const token = crypto.randomUUID();
        changedPreview = {
          token,
          expiresAt: now + PREVIEW_TTL_MS,
          revision: state.revision,
          oldLimit: state.deviceLimit,
          newLimit: input.newLimit,
          ...selection,
        };
        await tx.delete(`${PREVIEW_PREFIX}${input.token}`);
        await tx.put(`${PREVIEW_PREFIX}${token}`, changedPreview);
        return;
      }

      const outbox = (await tx.get<OutboxEvent[]>(OUTBOX_KEY)) ?? [];
      const reduction = reduceAccount(
        state,
        { type: "apply_quota", limit: input.newLimit },
        now
      );
      result = reduction.result as DeviceList;
      const nextOutbox = [...outbox, ...reduction.events];
      await tx.put({
        [ACCOUNT_KEY]: reduction.state,
        [OUTBOX_KEY]: nextOutbox,
        [`${RESULT_PREFIX}${input.token}`]: {
          newLimit: input.newLimit,
          result,
        } satisfies StoredQuotaResult,
      });
      await tx.delete(`${PREVIEW_PREFIX}${input.token}`);
      const alarm = nextOutboxAlarm(nextOutbox);
      const currentAlarm = await tx.getAlarm();
      if (alarm !== null && (currentAlarm === null || alarm < currentAlarm)) {
        await tx.setAlarm(alarm);
      }
    });

    if (changedPreview) throw new PreviewChangedError(changedPreview);
    if (!result) throw new QuickloginAccountError("TEMPORARY_UNAVAILABLE");
    return result;
  }
}
