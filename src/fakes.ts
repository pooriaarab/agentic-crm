import type { D1Binding, SqlRunner } from "./d1.js";
import type { KvBinding } from "./kv.js";

// Test support. In-memory doubles for the D1 and KV transports. The
// SQL fake reads the real statement strings (table, columns, WHERE
// clauses), so tests fail when the store writes wrong SQL.

type Row = Record<string, unknown>;
type TableName = "prospects" | "vendors" | "leads";

function tableOf(sql: string): TableName {
  const match = /(?:FROM|INTO|UPDATE)\s+(\w+)/i.exec(sql);
  if (match === null) throw new Error(`fake cannot find table in: ${sql}`);
  const name = match[1]?.toLowerCase();
  if (name !== "prospects" && name !== "vendors" && name !== "leads") {
    throw new Error(`fake knows no table "${match[1]}"`);
  }
  return name;
}

function likeMatch(value: unknown, pattern: string): boolean {
  if (typeof value !== "string") return false;
  const needle = pattern.replace(/^%+|%+$/g, "").toLowerCase();
  return value.toLowerCase().includes(needle);
}

export class FakeSqlRunner implements SqlRunner {
  readonly statements: { sql: string; params: unknown[] }[] = [];
  private readonly tables: Record<TableName, Map<string, Row>> = {
    prospects: new Map(),
    vendors: new Map(),
    leads: new Map(),
  };

  async all<T>(sql: string, params: unknown[]): Promise<T[]> {
    this.statements.push({ sql, params });
    return this.select(sql, params) as T[];
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    this.statements.push({ sql, params });
    const rows = this.select(sql, params);
    return (rows.length > 0 ? rows[0] : null) as T | null;
  }

  async run(sql: string, params: unknown[]): Promise<number> {
    this.statements.push({ sql, params });
    const head = sql.trim().slice(0, 6).toUpperCase();
    if (head === "INSERT") {
      const table = tableOf(sql);
      const columns = (/\(([^)]+)\)/.exec(sql)?.[1] ?? "")
        .split(",")
        .map((column) => column.trim());
      const row: Row = {};
      columns.forEach((column, index) => {
        row[column] = params[index] ?? null;
      });
      this.tables[table].set(String(row["id"]), row);
      return 1;
    }
    if (head === "UPDATE") {
      const table = tableOf(sql);
      const setPart = /SET\s+(.+?)\s+WHERE/i.exec(sql)?.[1] ?? "";
      const columns = setPart.split(",").map((part) => part.trim().split(" ")[0] as string);
      const id = String(params[params.length - 1]);
      const current = this.tables[table].get(id);
      if (current === undefined) return 0;
      columns.forEach((column, index) => {
        current[column] = params[index] ?? null;
      });
      return 1;
    }
    if (head === "DELETE") {
      const table = tableOf(sql);
      const id = String(params[0]);
      return this.tables[table].delete(id) ? 1 : 0;
    }
    // DDL (CREATE TABLE, CREATE INDEX) needs no fake state.
    return 0;
  }

  async execMany(statements: string[]): Promise<void> {
    for (const sql of statements) {
      this.statements.push({ sql, params: [] });
    }
  }

  private select(sql: string, params: unknown[]): Row[] {
    const table = tableOf(sql);
    let rows = [...this.tables[table].values()];
    const whereAt = sql.toUpperCase().indexOf("WHERE");
    if (whereAt >= 0) {
      const wherePart = sql.slice(whereAt + 5).split(/ORDER BY/i)[0] as string;
      const clauses = wherePart.split(/ AND /i).map((clause) => clause.trim());
      let taken = 0;
      for (const clause of clauses) {
        if (clause.startsWith("(")) {
          const columns = [...clause.matchAll(/(\w+)\s+LIKE\s+\?/g)].map((hit) => hit[1] as string);
          const patterns = params.slice(taken, taken + columns.length) as string[];
          taken += columns.length;
          rows = rows.filter((row) =>
            columns.some((column, index) => likeMatch(row[column], patterns[index] as string)),
          );
          continue;
        }
        const column = /(\w+)\s*=\s*\?/.exec(clause)?.[1];
        if (column === undefined) throw new Error(`fake cannot parse WHERE clause: ${clause}`);
        const want = params[taken];
        taken += 1;
        rows = rows.filter((row) => row[column] === want);
      }
    }
    if (/ORDER BY\s+created_at\s+DESC/i.test(sql)) {
      rows.sort((a, b) => String(b["created_at"]).localeCompare(String(a["created_at"])));
    }
    return rows.map((row) => ({ ...row }));
  }
}

export class FakeD1Binding implements D1Binding {
  constructor(readonly runner: FakeSqlRunner = new FakeSqlRunner()) {}

  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
  } {
    const runner = this.runner;
    return {
      bind(...params: unknown[]) {
        return {
          first<T>(): Promise<T | null> {
            return runner.first<T>(sql, params);
          },
          async all<T>(): Promise<{ results: T[] }> {
            return { results: await runner.all<T>(sql, params) };
          },
          async run(): Promise<{ meta?: { changes?: number } }> {
            return { meta: { changes: await runner.run(sql, params) } };
          },
        };
      },
    };
  }
}

export class FakeKvBinding implements KvBinding {
  readonly data = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

export function mockFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  calls: RecordedCall[] = [],
): typeof fetch {
  const fn = (async (url: URL | Request | string, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    const merged: RequestInit = { ...(init ?? {}) };
    calls.push({ url: href, init: merged });
    return respond(href, merged);
  }) as typeof fetch;
  return fn;
}
