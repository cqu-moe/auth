import { APIError } from "better-auth/api";

const revisions = new WeakMap<Request, Promise<number>>();
export function authResetRevision(db: D1Database, request: Request): Promise<number> {
  let revision = revisions.get(request);
  if (!revision) {
    revision = db.prepare("SELECT revision FROM auth_reset_revision WHERE id = 1").first<{ revision: number }>().then(row => {
      if (!row) throw new Error("Missing authentication reset revision");
      return row.revision;
    });
    revisions.set(request, revision);
  }
  return revision;
}
export function inheritAuthResetRevision(db: D1Database, source: Request, target: Request) {
  revisions.set(target, authResetRevision(db, source));
}

// Every auth mutation is committed in the same D1 transaction as its revision
// check. A request that started before recovery cannot recreate old credentials.
export function authDatabase(db: D1Database, request: Request): D1Database {
  const revision = () => authResetRevision(db, request);
  const originals = new WeakMap<object, { statement: D1PreparedStatement; readonly: boolean }>();
  const execute = async (statements: D1PreparedStatement[]) => {
    const expected = await revision();
    const entries = statements.map(statement => {
      const entry = originals.get(statement);
      if (!entry) throw new Error("Unbound authentication statement");
      return entry;
    });
    if (entries.every(entry => entry.readonly)) return db.batch(entries.map(entry => entry.statement));
    try {
      const results = await db.batch([
        db.prepare("UPDATE auth_reset_revision SET revision = CASE WHEN revision = ? THEN revision ELSE NULL END WHERE id = 1").bind(expected),
        ...entries.map(entry => entry.statement),
      ]);
      return results.slice(1);
    } catch (error) {
      const latest = await db.prepare("SELECT revision FROM auth_reset_revision WHERE id = 1").first<{ revision: number }>();
      if (!latest || latest.revision !== expected) throw new APIError("CONFLICT", { code: "AUTH_STATE_CHANGED", message: "认证状态已变化，请重新开始操作" });
      throw error;
    }
  };
  const prepare = (sql: string, values: unknown[] = []): D1PreparedStatement => {
    const statement = db.prepare(sql).bind(...values);
    // Only generated SELECT and read-only schema introspection bypass the fence.
    const readonly = /^\s*SELECT\b/i.test(sql) || /^\s*PRAGMA\s+(?:index_list|index_info|table_info)\s*\([^;]*\)\s*;?\s*$/i.test(sql);
    const wrapped = {
      bind: (...args: unknown[]) => prepare(sql, args),
      async all() { await revision(); return readonly ? statement.all() : (await execute([wrapped]))[0]; },
      async run() { return (await execute([wrapped]))[0]; },
      async first(column?: string) {
        const result = await wrapped.all();
        const row = result.results[0] as Record<string, unknown> | undefined;
        return row ? column === undefined ? row : row[column] : null;
      },
      async raw(options?: { columnNames?: boolean }) {
        await revision();
        if (!readonly) throw new Error("Raw authentication mutations are unsupported");
        return options?.columnNames ? statement.raw({ columnNames: true }) : statement.raw();
      },
    } as D1PreparedStatement;
    originals.set(wrapped, { statement, readonly });
    return wrapped;
  };
  return {
    prepare,
    batch: execute,
    exec: async () => { throw new Error("Unprepared authentication SQL is unsupported"); },
    dump: async () => { throw new Error("Authentication database export is unsupported"); },
    withSession: () => { throw new Error("Authentication database sessions are unsupported"); },
  } as unknown as D1Database;
}
