import { beforeEach, describe, expect, test } from "vitest";
import { ZodError } from "zod";
import { getCostReport, resetCosts } from "agentic-core";
import {
  MemoryCallStore,
  callCostAdapter,
  describeCallInput,
  runCallWrite,
} from "./calls.js";

beforeEach(() => {
  resetCosts();
});

describe("memory call store", () => {
  test("requests, reads, lists, and attaches", async () => {
    const store = new MemoryCallStore();
    await store.init();
    const requested = await store.requestCall({
      leadId: "lead-1",
      vendor: "bland",
      to: "+14155550132",
    });
    expect(requested.id.length).toBeGreaterThan(0);
    expect(requested.status).toBe("requested");
    expect(requested.bargeIn).toBe(false);

    expect(await store.getCall(requested.id)).toMatchObject({ to: "+14155550132" });
    expect(await store.getCall("missing")).toBeNull();

    expect(await store.listCalls()).toHaveLength(1);
    expect(await store.listCalls({ vendor: "vapi" })).toHaveLength(0);
    expect(await store.listCalls({ leadId: "lead-1" })).toHaveLength(1);

    const attached = await store.attachTranscript(requested.id, {
      transcriptRef: "call-logs/abc.txt",
      audioRef: "call-audio/abc.mp3",
    });
    expect(attached?.transcriptRef).toBe("call-logs/abc.txt");
    expect(attached?.audioRef).toBe("call-audio/abc.mp3");
    expect(await store.attachTranscript("missing", { transcriptRef: "x" })).toBeNull();
  });

  test("needs a prospect or a lead and an E.164 destination", async () => {
    const store = new MemoryCallStore();
    await expect(store.requestCall({ vendor: "dry", to: "+14155550132" })).rejects.toThrow(
      "a call needs a prospectId or a leadId",
    );
    await expect(
      store.requestCall({ prospectId: "p-1", vendor: "dry", to: "4155550132" }),
    ).rejects.toThrow(ZodError);
  });
});

describe("call costs", () => {
  test("runCallWrite records one unit per vendor and subject", async () => {
    const store = new MemoryCallStore();
    const first = await runCallWrite("memory", "request bland call", {}, () =>
      store.requestCall({ leadId: "lead-9", vendor: "bland", to: "+14155550132" }),
    );
    expect(first.dryRun).toBe(false);
    const report = getCostReport();
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      kind: "call",
      adapter: "bland:lead-9",
      units: 1,
    });
  });

  test("dry run records no cost", async () => {
    const store = new MemoryCallStore();
    const preview = await runCallWrite("memory", "request call", { dryRun: true }, () =>
      store.requestCall({ leadId: "lead-9", vendor: "bland", to: "+14155550132" }),
    );
    expect(preview.dryRun).toBe(true);
    expect(getCostReport().entries).toHaveLength(0);
  });

  test("adapter key prefers the lead over the prospect", () => {
    expect(
      callCostAdapter({
        id: "c",
        leadId: "lead-1",
        prospectId: "p-1",
        vendor: "telnyx",
        to: "+14155550132",
        status: "requested",
        bargeIn: false,
        createdAt: "t",
        updatedAt: "t",
      }),
    ).toBe("telnyx:lead-1");
  });

  test("describeCallInput names vendor, destination, and subject", () => {
    expect(
      describeCallInput({ prospectId: "p-1", vendor: "vapi", to: "+14155550132" }),
    ).toContain("vapi call to +14155550132 for prospect p-1");
  });
});
