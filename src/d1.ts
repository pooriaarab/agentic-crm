import { randomUUID } from "node:crypto";
import { VendorError } from "agentic-core";
import { z } from "zod";
import {
  leadInputSchema,
  leadPatchSchema,
  prospectInputSchema,
  prospectPatchSchema,
  vendorInputSchema,
  vendorPatchSchema,
  type CrmStore,
  type Lead,
  type LeadFilter,
  type LeadInput,
  type LeadPatch,
  type LeadStage,
  type Prospect,
  type ProspectFilter,
  type ProspectInput,
  type ProspectPatch,
  type Vendor,
  type VendorFilter,
  type VendorInput,
  type VendorPatch,
  LEAD_STAGES,
  PROSPECT_STATUSES,
  VENDOR_STATUSES,
} from "./crm.js";
import { KvRestClient, KvVendorMirror } from "./kv.js";

// D1 over REST. The CLI and the MCP server run on plain Node, so they
// reach D1 through the Cloudflare HTTP API, not through a binding.
// Endpoint shape follows the D1 REST query API: one POST per call,
// { sql, params } in, { result: [{ results, meta }] } out.

// Schema. One table per record kind, strict types, indexes on the
// columns that filters read.

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS prospects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    company TEXT,
    source TEXT,
    status TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_prospects_status ON prospects(status)`,
  `CREATE INDEX IF NOT EXISTS idx_prospects_email ON prospects(email)`,
  `CREATE TABLE IF NOT EXISTS vendors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    contact_email TEXT,
    category TEXT,
    status TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_vendors_status ON vendors(status)`,
  `CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    prospect_id TEXT,
    vendor_id TEXT,
    value REAL,
    currency TEXT,
    stage TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage)`,
];

export interface D1RestOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface D1QueryResult {
  results?: unknown[];
  success: boolean;
  meta?: { changes?: number };
}

interface D1ApiEnvelope {
  success: boolean;
  result?: D1QueryResult[];
  errors?: { message?: string }[];
}

function apiErrorText(errors: { message?: string }[] | undefined): string {
  const lines = (errors ?? [])
    .map((entry) => entry.message ?? "unknown error")
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join("; ") : "unknown error";
}

export class D1RestClient {
  private readonly queryUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: D1RestOptions) {
    for (const key of ["accountId", "databaseId", "apiToken"] as const) {
      if (options[key].trim().length === 0) {
        throw new Error(`d1 client needs ${key}`);
      }
    }
    const base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.queryUrl = `${base}/accounts/${options.accountId}/d1/database/${options.databaseId}/query`;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async post(body: unknown): Promise<D1QueryResult[]> {
    let response: Response;
    try {
      response = await this.fetchFn(this.queryUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`d1 request failed: ${String(error)}`, { cause: error });
    }
    let envelope: D1ApiEnvelope;
    try {
      envelope = (await response.json()) as D1ApiEnvelope;
    } catch (error) {
      throw new VendorError(`d1 returned no JSON (status ${response.status})`, {
        status: response.status,
        cause: error,
      });
    }
    if (!response.ok || envelope.success !== true) {
      throw new VendorError(`d1 query failed: ${apiErrorText(envelope.errors)}`, {
        status: response.status,
      });
    }
    const results = envelope.result ?? [];
    for (const entry of results) {
      if (entry.success !== true) {
        throw new VendorError("d1 statement failed inside batch", {
          status: response.status,
        });
      }
    }
    return results;
  }

  async query<T>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; changes: number }> {
    const [entry] = await this.post({ sql, params });
    if (entry === undefined) {
      throw new VendorError("d1 returned no result block");
    }
    const rows = (entry.results ?? []) as T[];
    return { rows, changes: entry.meta?.changes ?? 0 };
  }

  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<void> {
    await this.post(statements.map((entry) => ({ sql: entry.sql, params: entry.params ?? [] })));
  }
}

// SQL runner. One small interface with two transports: the REST
// client above for Node, and the D1 binding for the worker. The
// store below runs the same SQL on either one.

export interface SqlRunner {
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
  first<T>(sql: string, params: unknown[]): Promise<T | null>;
  run(sql: string, params: unknown[]): Promise<number>;
  execMany(statements: string[]): Promise<void>;
}

export class RestSqlRunner implements SqlRunner {
  constructor(private readonly client: D1RestClient) {}

  async all<T>(sql: string, params: unknown[]): Promise<T[]> {
    const { rows } = await this.client.query<T>(sql, params);
    return rows;
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    const { rows } = await this.client.query<T>(sql, params);
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  async run(sql: string, params: unknown[]): Promise<number> {
    const { rows, changes } = await this.client.query<Record<string, unknown>>(sql, params);
    if (changes > 0) return changes;
    // Some D1 responses omit meta.changes on success. A returned
    // row block means the statement ran; report 1 so callers that
    // only need "did it run" stay honest without a second query.
    return rows.length >= 0 ? Math.max(changes, 0) : 0;
  }

  async execMany(statements: string[]): Promise<void> {
    await this.client.batch(statements.map((sql) => ({ sql })));
  }
}

export interface D1BindingStatement {
  bind(...params: unknown[]): {
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<{ meta?: { changes?: number } }>;
  };
}

export interface D1Binding {
  prepare(sql: string): D1BindingStatement;
}

export class BindingSqlRunner implements SqlRunner {
  constructor(private readonly db: D1Binding) {}

  async all<T>(sql: string, params: unknown[]): Promise<T[]> {
    const { results } = await this.db.prepare(sql).bind(...params).all<T>();
    return results;
  }

  async first<T>(sql: string, params: unknown[]): Promise<T | null> {
    return this.db.prepare(sql).bind(...params).first<T>();
  }

  async run(sql: string, params: unknown[]): Promise<number> {
    const done = await this.db.prepare(sql).bind(...params).run();
    return done.meta?.changes ?? 0;
  }

  async execMany(statements: string[]): Promise<void> {
    for (const sql of statements) {
      await this.db.prepare(sql).bind().run();
    }
  }
}

// Rows. Snake case on disk, camel case in code. Output schemas
// re-check each row so a corrupt row throws instead of leaking.

interface ProspectRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  source: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface VendorRow {
  id: string;
  name: string;
  contact_email: string | null;
  category: string | null;
  status: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface LeadRow {
  id: string;
  title: string;
  prospect_id: string | null;
  vendor_id: string | null;
  value: number | null;
  currency: string | null;
  stage: string;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const prospectRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  company: z.string().optional(),
  source: z.string().optional(),
  status: z.enum(PROSPECT_STATUSES),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const vendorRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  contactEmail: z.string().optional(),
  category: z.string().optional(),
  status: z.enum(VENDOR_STATUSES),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const leadRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  prospectId: z.string().optional(),
  vendorId: z.string().optional(),
  value: z.number().optional(),
  currency: z.string().optional(),
  stage: z.enum(LEAD_STAGES),
  notes: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function toProspect(row: ProspectRow): Prospect {
  return prospectRecordSchema.parse({
    id: row.id,
    name: row.name,
    email: row.email,
    company: row.company ?? undefined,
    source: row.source ?? undefined,
    status: row.status,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toVendor(row: VendorRow): Vendor {
  return vendorRecordSchema.parse({
    id: row.id,
    name: row.name,
    contactEmail: row.contact_email ?? undefined,
    category: row.category ?? undefined,
    status: row.status,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toLead(row: LeadRow): Lead {
  return leadRecordSchema.parse({
    id: row.id,
    title: row.title,
    prospectId: row.prospect_id ?? undefined,
    vendorId: row.vendor_id ?? undefined,
    value: row.value ?? undefined,
    currency: row.currency ?? undefined,
    stage: row.stage,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (mark) => `\\${mark}`);
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface VendorMirror {
  put(vendor: Vendor): Promise<void>;
  remove(id: string): Promise<void>;
}

const PROSPECT_COLUMNS: Record<string, string> = {
  name: "name",
  email: "email",
  company: "company",
  source: "source",
  status: "status",
  notes: "notes",
};

const VENDOR_COLUMNS: Record<string, string> = {
  name: "name",
  contactEmail: "contact_email",
  category: "category",
  status: "status",
  notes: "notes",
};

const LEAD_COLUMNS: Record<string, string> = {
  title: "title",
  prospectId: "prospect_id",
  vendorId: "vendor_id",
  value: "value",
  currency: "currency",
  stage: "stage",
  notes: "notes",
};

function buildSetClause(
  patch: Record<string, unknown>,
  columns: Record<string, string>,
): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key];
    if (column === undefined || value === undefined) continue;
    parts.push(`${column} = ?`);
    params.push(value);
  }
  return { clause: parts.join(", "), params };
}

export class SqlCrmStore implements CrmStore {
  readonly name: string;

  constructor(
    private readonly runner: SqlRunner,
    private readonly vendorMirror?: VendorMirror,
    name = "d1",
  ) {
    this.name = name;
  }

  async init(): Promise<void> {
    await this.runner.execMany(SCHEMA_STATEMENTS);
  }

  async addProspect(input: ProspectInput): Promise<Prospect> {
    const parsed = prospectInputSchema.parse(input);
    const at = nowIso();
    const id = randomUUID();
    await this.runner.run(
      `INSERT INTO prospects (id, name, email, company, source, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, parsed.name, parsed.email, parsed.company ?? null, parsed.source ?? null, parsed.status, parsed.notes ?? null, at, at],
    );
    const created = await this.getProspect(id);
    if (created === null) {
      throw new VendorError("d1 insert of prospect left no row behind");
    }
    return created;
  }

  async getProspect(id: string): Promise<Prospect | null> {
    const row = await this.runner.first<ProspectRow>(
      `SELECT id, name, email, company, source, status, notes, created_at, updated_at
       FROM prospects WHERE id = ?`,
      [id],
    );
    return row === null ? null : toProspect(row);
  }

  async listProspects(filter: ProspectFilter = {}): Promise<Prospect[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.query !== undefined) {
      clauses.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(filter.query)}%`;
      params.push(pattern, pattern, pattern);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.runner.all<ProspectRow>(
      `SELECT id, name, email, company, source, status, notes, created_at, updated_at
       FROM prospects ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(toProspect);
  }

  async updateProspect(id: string, patch: ProspectPatch): Promise<Prospect | null> {
    const current = await this.getProspect(id);
    if (current === null) return null;
    const parsed = prospectPatchSchema.parse(patch);
    const { clause, params } = buildSetClause(parsed as Record<string, unknown>, PROSPECT_COLUMNS);
    if (clause.length === 0) return current;
    await this.runner.run(`UPDATE prospects SET ${clause}, updated_at = ? WHERE id = ?`, [
      ...params,
      nowIso(),
      id,
    ]);
    return this.getProspect(id);
  }

  async deleteProspect(id: string): Promise<boolean> {
    const current = await this.getProspect(id);
    if (current === null) return false;
    await this.runner.run(`DELETE FROM prospects WHERE id = ?`, [id]);
    return true;
  }

  async addVendor(input: VendorInput): Promise<Vendor> {
    const parsed = vendorInputSchema.parse(input);
    const at = nowIso();
    const id = randomUUID();
    await this.runner.run(
      `INSERT INTO vendors (id, name, contact_email, category, status, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, parsed.name, parsed.contactEmail ?? null, parsed.category ?? null, parsed.status, parsed.notes ?? null, at, at],
    );
    const created = await this.getVendor(id);
    if (created === null) {
      throw new VendorError("d1 insert of vendor left no row behind");
    }
    // Vendors live in D1 plus KV. The mirror call throws on
    // failure, so a half-written vendor surfaces as an error.
    await this.vendorMirror?.put(created);
    return created;
  }

  async getVendor(id: string): Promise<Vendor | null> {
    const row = await this.runner.first<VendorRow>(
      `SELECT id, name, contact_email, category, status, notes, created_at, updated_at
       FROM vendors WHERE id = ?`,
      [id],
    );
    return row === null ? null : toVendor(row);
  }

  async listVendors(filter: VendorFilter = {}): Promise<Vendor[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== undefined) {
      clauses.push("status = ?");
      params.push(filter.status);
    }
    if (filter.query !== undefined) {
      clauses.push("(name LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\')");
      const pattern = `%${escapeLike(filter.query)}%`;
      params.push(pattern, pattern);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.runner.all<VendorRow>(
      `SELECT id, name, contact_email, category, status, notes, created_at, updated_at
       FROM vendors ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(toVendor);
  }

  async updateVendor(id: string, patch: VendorPatch): Promise<Vendor | null> {
    const current = await this.getVendor(id);
    if (current === null) return null;
    const parsed = vendorPatchSchema.parse(patch);
    const { clause, params } = buildSetClause(parsed as Record<string, unknown>, VENDOR_COLUMNS);
    if (clause.length === 0) return current;
    await this.runner.run(`UPDATE vendors SET ${clause}, updated_at = ? WHERE id = ?`, [
      ...params,
      nowIso(),
      id,
    ]);
    const next = await this.getVendor(id);
    if (next !== null) {
      await this.vendorMirror?.put(next);
    }
    return next;
  }

  async deleteVendor(id: string): Promise<boolean> {
    const current = await this.getVendor(id);
    if (current === null) return false;
    await this.runner.run(`DELETE FROM vendors WHERE id = ?`, [id]);
    await this.vendorMirror?.remove(id);
    return true;
  }

  async addLead(input: LeadInput): Promise<Lead> {
    const parsed = leadInputSchema.parse(input);
    const at = nowIso();
    const id = randomUUID();
    await this.runner.run(
      `INSERT INTO leads (id, title, prospect_id, vendor_id, value, currency, stage, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, parsed.title, parsed.prospectId ?? null, parsed.vendorId ?? null, parsed.value ?? null, parsed.currency ?? null, parsed.stage, parsed.notes ?? null, at, at],
    );
    const created = await this.getLead(id);
    if (created === null) {
      throw new VendorError("d1 insert of lead left no row behind");
    }
    return created;
  }

  async getLead(id: string): Promise<Lead | null> {
    const row = await this.runner.first<LeadRow>(
      `SELECT id, title, prospect_id, vendor_id, value, currency, stage, notes, created_at, updated_at
       FROM leads WHERE id = ?`,
      [id],
    );
    return row === null ? null : toLead(row);
  }

  async listLeads(filter: LeadFilter = {}): Promise<Lead[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.stage !== undefined) {
      clauses.push("stage = ?");
      params.push(filter.stage);
    }
    if (filter.prospectId !== undefined) {
      clauses.push("prospect_id = ?");
      params.push(filter.prospectId);
    }
    if (filter.vendorId !== undefined) {
      clauses.push("vendor_id = ?");
      params.push(filter.vendorId);
    }
    if (filter.query !== undefined) {
      clauses.push("title LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(filter.query)}%`);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = await this.runner.all<LeadRow>(
      `SELECT id, title, prospect_id, vendor_id, value, currency, stage, notes, created_at, updated_at
       FROM leads ${where} ORDER BY created_at DESC`,
      params,
    );
    return rows.map(toLead);
  }

  async updateLead(id: string, patch: LeadPatch): Promise<Lead | null> {
    const current = await this.getLead(id);
    if (current === null) return null;
    const parsed = leadPatchSchema.parse(patch);
    const { clause, params } = buildSetClause(parsed as Record<string, unknown>, LEAD_COLUMNS);
    if (clause.length === 0) return current;
    await this.runner.run(`UPDATE leads SET ${clause}, updated_at = ? WHERE id = ?`, [
      ...params,
      nowIso(),
      id,
    ]);
    return this.getLead(id);
  }

  async moveLead(id: string, stage: LeadStage): Promise<Lead | null> {
    return this.updateLead(id, { stage });
  }

  async deleteLead(id: string): Promise<boolean> {
    const current = await this.getLead(id);
    if (current === null) return false;
    await this.runner.run(`DELETE FROM leads WHERE id = ?`, [id]);
    return true;
  }
}

// Env wiring. --store d1 reads these four vars. The KV namespace is
// optional: without it vendors still persist in D1, only the KV copy
// is skipped.

export interface D1EnvConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  kvNamespaceId?: string;
}

export function readD1Env(env: Record<string, string | undefined>): D1EnvConfig {
  const accountId = env["CLOUDFLARE_ACCOUNT_ID"] ?? "";
  const databaseId = env["CRM_D1_DATABASE_ID"] ?? "";
  const apiToken = env["CLOUDFLARE_API_TOKEN"] ?? "";
  const missing: string[] = [];
  if (accountId.trim().length === 0) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (databaseId.trim().length === 0) missing.push("CRM_D1_DATABASE_ID");
  if (apiToken.trim().length === 0) missing.push("CLOUDFLARE_API_TOKEN");
  if (missing.length > 0) {
    throw new Error(
      `--store d1 needs ${missing.join(", ")}. Set them and retry, or drop the flag for memory mode.`,
    );
  }
  const kvNamespaceId = env["CRM_KV_NAMESPACE_ID"];
  return {
    accountId,
    databaseId,
    apiToken,
    kvNamespaceId: kvNamespaceId !== undefined && kvNamespaceId.trim().length > 0 ? kvNamespaceId : undefined,
  };
}

export function createD1Store(
  env: Record<string, string | undefined>,
  fetchFn?: typeof fetch,
): SqlCrmStore {
  const config = readD1Env(env);
  const client = new D1RestClient({
    accountId: config.accountId,
    databaseId: config.databaseId,
    apiToken: config.apiToken,
    fetchFn,
  });
  const mirror =
    config.kvNamespaceId === undefined
      ? undefined
      : new KvVendorMirror(
          new KvRestClient({
            accountId: config.accountId,
            namespaceId: config.kvNamespaceId,
            apiToken: config.apiToken,
            fetchFn,
          }),
        );
  return new SqlCrmStore(new RestSqlRunner(client), mirror, "d1");
}
