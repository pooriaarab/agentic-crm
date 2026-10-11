import { describe, expect, test } from "vitest";
import { ZodError } from "zod";
import { VendorError } from "agentic-core";
import {
  BindingSqlRunner,
  createD1Store,
  D1RestClient,
  readD1Env,
  RestSqlRunner,
  SCHEMA_STATEMENTS,
  SqlCrmStore,
} from "./d1.js";
import { FakeD1Binding, FakeSqlRunner, mockFetch, type RecordedCall } from "./fakes.js";
import type { Vendor } from "./crm.js";

const OPTIONS = { accountId: "acct", databaseId: "db", apiToken: "token" };
const QUERY_URL = "https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query";

function okQuery(results: unknown[], changes = 0): Response {
  return Response.json({
    success: true,
    result: [{ results, success: true, meta: { changes } }],
    errors: [],
  });
}

describe("D1RestClient", () => {
  test("posts sql plus params with a bearer token", async () => {
    const calls: RecordedCall[] = [];
    const client = new D1RestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => okQuery([{ id: "1" }]), calls),
    });
    const { rows } = await client.query<{ id: string }>("SELECT 1 WHERE 1 = ?", [1]);
    expect(rows).toEqual([{ id: "1" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(QUERY_URL);
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer token",
    );
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      sql: "SELECT 1 WHERE 1 = ?",
      params: [1],
    });
  });

  test("batch posts a statement array", async () => {
    const calls: RecordedCall[] = [];
    const client = new D1RestClient({
      ...OPTIONS,
      fetchFn: mockFetch(
        () =>
          Response.json({
            success: true,
            result: [
              { results: [], success: true, meta: {} },
              { results: [], success: true, meta: {} },
            ],
            errors: [],
          }),
        calls,
      ),
    });
    await client.batch([{ sql: "SELECT 1" }, { sql: "SELECT ?", params: [2] }]);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual([
      { sql: "SELECT 1", params: [] },
      { sql: "SELECT ?", params: [2] },
    ]);
  });

  test("a network failure throws VendorError", async () => {
    const client = new D1RestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(client.query("SELECT 1")).rejects.toThrow(VendorError);
  });

  test("a non-2xx status throws VendorError with the status", async () => {
    const client = new D1RestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() =>
        Response.json({ success: false, errors: [{ message: "bad database" }] }, { status: 500 }),
      ),
    });
    const failure = await client.query("SELECT 1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VendorError);
    expect((failure as VendorError).status).toBe(500);
    expect((failure as Error).message).toContain("bad database");
  });

  test("an api success:false throws VendorError", async () => {
    const client = new D1RestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() =>
        Response.json({ success: false, errors: [{ message: "no such table" }] }),
      ),
    });
    await expect(client.query("SELECT 1")).rejects.toThrow(/no such table/);
  });

  test("a failed statement inside a batch throws VendorError", async () => {
    const client = new D1RestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() =>
        Response.json({
          success: true,
          result: [{ results: [], success: false, meta: {} }],
          errors: [],
        }),
      ),
    });
    await expect(client.batch([{ sql: "SELECT 1" }])).rejects.toThrow(VendorError);
  });

  test("empty account, database, or token throws at once", () => {
    expect(() => new D1RestClient({ ...OPTIONS, accountId: " " })).toThrow(/accountId/);
    expect(() => new D1RestClient({ ...OPTIONS, databaseId: "" })).toThrow(/databaseId/);
    expect(() => new D1RestClient({ ...OPTIONS, apiToken: "" })).toThrow(/apiToken/);
  });
});

describe("SqlCrmStore", () => {
  function storeWithMirror(): {
    store: SqlCrmStore;
    runner: FakeSqlRunner;
    mirrored: Vendor[];
    removed: string[];
  } {
    const runner = new FakeSqlRunner();
    const mirrored: Vendor[] = [];
    const removed: string[] = [];
    const store = new SqlCrmStore(
      runner,
      {
        put: async (vendor) => {
          mirrored.push(vendor);
        },
        remove: async (id) => {
          removed.push(id);
        },
      },
      "d1",
    );
    return { store, runner, mirrored, removed };
  }

  test("init runs the schema statements", async () => {
    const { store, runner } = storeWithMirror();
    await store.init();
    expect(runner.statements.map((entry) => entry.sql)).toEqual(SCHEMA_STATEMENTS);
  });

  test("prospect round trip through SQL", async () => {
    const { store, runner } = storeWithMirror();
    const added = await store.addProspect({ name: "Ava", email: "ava@example.com" });
    expect(runner.statements[0]?.sql).toContain("INSERT INTO prospects");
    expect(await store.getProspect(added.id)).toMatchObject({ email: "ava@example.com" });
    expect(await store.getProspect("missing")).toBeNull();
    expect(await store.listProspects({ query: "ava" })).toHaveLength(1);
    const updated = await store.updateProspect(added.id, { status: "qualified" });
    expect(updated?.status).toBe("qualified");
    expect(await store.deleteProspect(added.id)).toBe(true);
    expect(await store.deleteProspect(added.id)).toBe(false);
  });

  test("vendor writes mirror to KV and deletes clear the mirror", async () => {
    const { store, mirrored, removed } = storeWithMirror();
    const added = await store.addVendor({ name: "Ink Supply" });
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]?.id).toBe(added.id);
    await store.updateVendor(added.id, { status: "inactive" });
    expect(mirrored).toHaveLength(2);
    expect(mirrored[1]?.status).toBe("inactive");
    await store.deleteVendor(added.id);
    expect(removed).toEqual([added.id]);
  });

  test("a failing mirror throws instead of hiding the gap", async () => {
    const runner = new FakeSqlRunner();
    const store = new SqlCrmStore(runner, {
      put: async () => {
        throw new VendorError("kv down");
      },
      remove: async () => {},
    });
    await expect(store.addVendor({ name: "Ink" })).rejects.toThrow(/kv down/);
  });

  test("lead round trip with move and filters", async () => {
    const { store } = storeWithMirror();
    const prospect = await store.addProspect({ name: "Ava", email: "ava@example.com" });
    const added = await store.addLead({
      title: "Rebuild",
      prospectId: prospect.id,
      value: 500,
      currency: "USD",
    });
    expect(await store.listLeads({ stage: "new" })).toHaveLength(1);
    expect(await store.listLeads({ prospectId: prospect.id })).toHaveLength(1);
    expect(await store.listLeads({ prospectId: "other" })).toHaveLength(0);
    const moved = await store.moveLead(added.id, "won");
    expect(moved?.stage).toBe("won");
    expect(await store.deleteLead(added.id)).toBe(true);
  });

  test("bad input throws before any SQL runs", async () => {
    const { store, runner } = storeWithMirror();
    await expect(store.addProspect({ name: "Ava", email: "bad" })).rejects.toThrow(ZodError);
    expect(runner.statements).toHaveLength(0);
  });

  test("BindingSqlRunner drives the same store", async () => {
    const binding = new FakeD1Binding();
    const store = new SqlCrmStore(new BindingSqlRunner(binding), undefined, "d1-binding");
    await store.init();
    const added = await store.addLead({ title: "Rebuild" });
    expect(await store.getLead(added.id)).toMatchObject({ title: "Rebuild" });
  });

  test("RestSqlRunner maps query rows and first rows", async () => {
    const client = new D1RestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => okQuery([{ id: "1" }], 0)),
    });
    const runner = new RestSqlRunner(client);
    expect(await runner.all("SELECT 1", [])).toEqual([{ id: "1" }]);
    expect(await runner.first("SELECT 1", [])).toEqual({ id: "1" });
  });
});

describe("env wiring", () => {
  test("readD1Env names each missing var", () => {
    expect(() => readD1Env({})).toThrow(/CLOUDFLARE_ACCOUNT_ID.*CRM_D1_DATABASE_ID.*CLOUDFLARE_API_TOKEN/);
    const config = readD1Env({
      CLOUDFLARE_ACCOUNT_ID: "a",
      CRM_D1_DATABASE_ID: "d",
      CLOUDFLARE_API_TOKEN: "t",
    });
    expect(config.kvNamespaceId).toBeUndefined();
  });

  test("createD1Store builds a d1 store", () => {
    const store = createD1Store({
      CLOUDFLARE_ACCOUNT_ID: "a",
      CRM_D1_DATABASE_ID: "d",
      CLOUDFLARE_API_TOKEN: "t",
      CRM_KV_NAMESPACE_ID: "k",
    });
    expect(store.name).toBe("d1");
  });
});
