import { beforeEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";
import {
  createGuards,
  getCostReport,
  GuardError,
  resetCosts,
} from "agentic-core";
import {
  describeInput,
  MemoryCrmStore,
  runWrite,
} from "./crm.js";

beforeEach(() => {
  resetCosts();
});

describe("memory store prospects", () => {
  test("adds, reads, lists, updates, and deletes", async () => {
    const store = new MemoryCrmStore();
    await store.init();
    const added = await store.addProspect({ name: "Ava", email: "ava@example.com" });
    expect(added.id.length).toBeGreaterThan(0);
    expect(added.status).toBe("new");

    expect(await store.getProspect(added.id)).toMatchObject({ email: "ava@example.com" });
    expect(await store.getProspect("missing")).toBeNull();

    const listed = await store.listProspects();
    expect(listed).toHaveLength(1);

    const updated = await store.updateProspect(added.id, { status: "qualified" });
    expect(updated?.status).toBe("qualified");
    expect(await store.updateProspect("missing", { status: "qualified" })).toBeNull();

    expect(await store.deleteProspect(added.id)).toBe(true);
    expect(await store.deleteProspect(added.id)).toBe(false);
    expect(await store.listProspects()).toHaveLength(0);
  });

  test("filters by status and query", async () => {
    const store = new MemoryCrmStore();
    await store.addProspect({ name: "Ava", email: "ava@example.com", status: "new" });
    await store.addProspect({
      name: "Ben",
      email: "ben@acme.test",
      company: "Acme",
      status: "contacted",
    });
    expect(await store.listProspects({ status: "contacted" })).toHaveLength(1);
    expect(await store.listProspects({ query: "acme" })).toHaveLength(1);
    expect(await store.listProspects({ query: "AVA" })).toHaveLength(1);
    expect(await store.listProspects({ query: "nobody" })).toHaveLength(0);
  });

  test("rejects a bad email and an empty name", async () => {
    const store = new MemoryCrmStore();
    await expect(store.addProspect({ name: "Ava", email: "not-an-email" })).rejects.toThrow(
      ZodError,
    );
    await expect(store.addProspect({ name: "  ", email: "ava@example.com" })).rejects.toThrow(
      ZodError,
    );
  });
});

describe("memory store vendors", () => {
  test("adds, reads, lists, updates, and deletes", async () => {
    const store = new MemoryCrmStore();
    const added = await store.addVendor({ name: "Ink Supply", category: "office" });
    expect(added.status).toBe("active");
    expect(await store.getVendor(added.id)).toMatchObject({ name: "Ink Supply" });
    expect(await store.getVendor("missing")).toBeNull();
    expect(await store.listVendors({ query: "ink" })).toHaveLength(1);
    const updated = await store.updateVendor(added.id, { status: "inactive" });
    expect(updated?.status).toBe("inactive");
    expect(await store.deleteVendor(added.id)).toBe(true);
    expect(await store.listVendors()).toHaveLength(0);
  });
});

describe("memory store leads", () => {
  test("adds, moves, filters, updates, and deletes", async () => {
    const store = new MemoryCrmStore();
    const prospect = await store.addProspect({ name: "Ava", email: "ava@example.com" });
    const added = await store.addLead({
      title: "Site rebuild",
      prospectId: prospect.id,
      value: 1200,
      currency: "USD",
    });
    expect(added.stage).toBe("new");
    const moved = await store.moveLead(added.id, "proposal");
    expect(moved?.stage).toBe("proposal");
    expect(await store.moveLead("missing", "won")).toBeNull();
    expect(await store.listLeads({ stage: "proposal" })).toHaveLength(1);
    expect(await store.listLeads({ prospectId: prospect.id })).toHaveLength(1);
    expect(await store.listLeads({ query: "rebuild" })).toHaveLength(1);
    const updated = await store.updateLead(added.id, { value: 1500 });
    expect(updated?.value).toBe(1500);
    expect(await store.deleteLead(added.id)).toBe(true);
    expect(await store.listLeads()).toHaveLength(0);
  });

  test("rejects a negative value and a bad currency", async () => {
    const store = new MemoryCrmStore();
    await expect(store.addLead({ title: "Bad", value: -5 })).rejects.toThrow(ZodError);
    await expect(store.addLead({ title: "Bad", currency: "US" })).rejects.toThrow(ZodError);
  });
});

describe("runWrite", () => {
  test("dry run calls no adapter and records no cost", async () => {
    const store = new MemoryCrmStore();
    let calls = 0;
    const preview = await runWrite("memory", "add prospect Ava", { dryRun: true }, async () => {
      calls += 1;
      return store.addProspect({ name: "Ava", email: "ava@example.com" });
    });
    expect(preview).toMatchObject({ dryRun: true });
    expect(calls).toBe(0);
    expect(await store.listProspects()).toHaveLength(0);
    expect(getCostReport()).toMatchObject({ dispatches: 0, units: 0 });
  });

  test("real write counts one dispatch and one cost unit", async () => {
    const store = new MemoryCrmStore();
    const guards = createGuards({ caps: { maxDispatches: 2 } });
    const written = await runWrite("memory", "add prospect Ava", { guards }, () =>
      store.addProspect({ name: "Ava", email: "ava@example.com" }),
    );
    expect(written.dryRun).toBe(false);
    expect(guards.dispatchCount).toBe(1);
    expect(getCostReport()).toMatchObject({ dispatches: 0, units: 1 });
    expect(getCostReport().entries[0]).toMatchObject({ kind: "write", adapter: "memory" });
  });

  test("a denied guard throws before the adapter runs", async () => {
    const store = new MemoryCrmStore();
    const guards = createGuards({ blocklist: ["banned"] });
    let calls = 0;
    await expect(
      runWrite("memory", "add prospect Banned Name", { guards }, async () => {
        calls += 1;
        return store.addProspect({ name: "Banned Name", email: "b@example.com" });
      }),
    ).rejects.toThrow(GuardError);
    expect(calls).toBe(0);
    expect(getCostReport().entries).toHaveLength(0);
  });

  test("a failed adapter throws and records no cost", async () => {
    const guards = createGuards();
    await expect(
      runWrite("memory", "boom", { guards }, async () => {
        throw new Error("adapter down");
      }),
    ).rejects.toThrow("adapter down");
    expect(guards.dispatchCount).toBe(0);
    expect(getCostReport().entries).toHaveLength(0);
  });
});

describe("describeInput", () => {
  test("names the record from name, title, or email", () => {
    expect(describeInput("prospect", { name: "Ava" })).toBe("add prospect Ava");
    expect(describeInput("lead", { title: "Rebuild" })).toBe("add lead Rebuild");
    expect(describeInput("prospect", { email: "a@b.test" })).toBe("add prospect a@b.test");
    expect(describeInput("vendor", {})).toBe("add vendor record");
  });
});
