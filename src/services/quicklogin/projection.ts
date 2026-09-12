import type { Env } from "../../types";
import type { AccountState, DeviceRecord } from "./contracts";

function publicDevice(device: DeviceRecord): Record<string, unknown> {
  const { ownerUserId: _ownerUserId, grantId: _grantId, ...metadata } = device;
  return metadata;
}

export async function projectAccount(
  env: Env,
  userId: string,
  state: AccountState
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  statements.push(
    env.DATABASE.prepare(
      `INSERT INTO quicklogin_account_projection
         (user_id, revision, device_limit, master_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         revision = excluded.revision,
         device_limit = excluded.device_limit,
         master_enabled = excluded.master_enabled,
         updated_at = excluded.updated_at
       WHERE excluded.revision > quicklogin_account_projection.revision`
    ).bind(
      userId,
      state.revision,
      state.deviceLimit,
      state.masterEnabled ? 1 : 0,
      Date.now()
    )
  );

  statements.push(
    env.DATABASE.prepare(
      `DELETE FROM quicklogin_device_projection
       WHERE user_id = ?
         AND EXISTS (
           SELECT 1 FROM quicklogin_account_projection
           WHERE user_id = ? AND revision = ?
         )`
    ).bind(userId, userId, state.revision)
  );

  for (const device of Object.values(state.devices)) {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO quicklogin_device_projection
           (device_id, user_id, revision, payload_json)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM quicklogin_account_projection
           WHERE user_id = ? AND revision = ?
         )
         ON CONFLICT(device_id) DO UPDATE SET
           user_id = excluded.user_id,
           revision = excluded.revision,
           payload_json = excluded.payload_json
         WHERE quicklogin_device_projection.user_id = excluded.user_id
           AND EXISTS (
             SELECT 1 FROM quicklogin_account_projection
             WHERE user_id = excluded.user_id
               AND revision = excluded.revision
           )`
      ).bind(
        device.deviceId,
        userId,
        state.revision,
        JSON.stringify(publicDevice(device)),
        userId,
        state.revision
      )
    );
  }

  statements.push(
    env.DATABASE.prepare(
      `INSERT INTO user_entitlement
         (user_id, subsystem, capability, value, updated_at)
       SELECT ?, 'cqu', 'quicklogin_device_limit', ?, datetime('now')
       WHERE EXISTS (
         SELECT 1 FROM quicklogin_account_projection
         WHERE user_id = ? AND revision = ?
       )
       ON CONFLICT(user_id, subsystem, capability) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE EXISTS (
         SELECT 1 FROM quicklogin_account_projection
         WHERE user_id = excluded.user_id
           AND revision = ?
       )`
    ).bind(
      userId,
      String(state.deviceLimit),
      userId,
      state.revision,
      state.revision
    )
  );

  if (state.masterEnabled) {
    statements.push(
      env.DATABASE.prepare(
        `INSERT INTO user_entitlement
           (user_id, subsystem, capability, value, updated_at)
         SELECT ?, 'cqu', 'quicklogin', '1', datetime('now')
         WHERE EXISTS (
           SELECT 1 FROM quicklogin_account_projection
           WHERE user_id = ? AND revision = ?
         )
         ON CONFLICT(user_id, subsystem, capability) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at
         WHERE EXISTS (
           SELECT 1 FROM quicklogin_account_projection
           WHERE user_id = excluded.user_id
             AND revision = ?
         )`
      ).bind(userId, userId, state.revision, state.revision)
    );
  } else {
    statements.push(
      env.DATABASE.prepare(
        `DELETE FROM user_entitlement
         WHERE user_id = ?
           AND subsystem = 'cqu'
           AND capability = 'quicklogin'
           AND EXISTS (
             SELECT 1 FROM quicklogin_account_projection
             WHERE user_id = ? AND revision = ?
           )`
      ).bind(userId, userId, state.revision)
    );
  }

  await env.DATABASE.batch(statements);
}
