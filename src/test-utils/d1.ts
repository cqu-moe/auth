import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type BoundStatement = {
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
};

function result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    success: true,
    results,
    meta: {
      duration: 0,
      size_after: 0,
      rows_read: 0,
      rows_written: changes,
      last_row_id: 0,
      changed_db: changes > 0,
      changes,
    },
  };
}

export function createSqliteD1(database: DatabaseSync): D1Database {
  const prepare = (query: string, values: SQLInputValue[] = []) => {
    const statement = database.prepare(query);
    const execute = <T = Record<string, unknown>>() => statement.run(...values);

    return {
      bind(...next: SQLInputValue[]) {
        return prepare(query, next);
      },
      async first<T = Record<string, unknown>>(columnName?: string) {
        const row = statement.get(...values) as T | undefined;
        if (columnName && row && typeof row === "object") {
          return (row as Record<string, unknown>)[columnName] as T | null;
        }
        return row ?? null;
      },
      async run<T = Record<string, unknown>>() {
        const execution = execute();
        return result<T>([], Number(execution.changes));
      },
      async all<T = Record<string, unknown>>() {
        const before = Number(database.prepare("SELECT total_changes() AS count").get()!.count);
        const rows = statement.all(...values) as T[];
        const after = Number(database.prepare("SELECT total_changes() AS count").get()!.count);
        return result(rows, after - before);
      },
      async raw<T = unknown[]>(options?: { columnNames?: boolean }) {
        statement.setReturnArrays(true);
        const rows = statement.all(...values) as T[];
        statement.setReturnArrays(false);
        if (options?.columnNames) {
          return [statement.columns().map((column) => column.name), ...rows] as [string[], ...T[]];
        }
        return rows;
      },
    };
  };

  return {
    prepare,
    async exec(query: string) {
      database.exec(query);
      return { count: 0, duration: 0 };
    },
    async batch(statements: BoundStatement[]) {
      database.exec("BEGIN");
      try {
        const results = await Promise.all(statements.map((statement) => statement.all()));
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}
