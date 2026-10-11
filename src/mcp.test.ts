import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test } from "vitest";
import { createGuards, resetCosts } from "agentic-core";
import { MemoryCrmStore } from "./crm.js";
import { createMcpServer } from "./mcp.js";

function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return content[0]?.text ?? "";
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function linkedClient(store?: MemoryCrmStore, guards?: ReturnType<typeof createGuards>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ store: store ?? new MemoryCrmStore(), guards });
  await server.connect(serverTransport);
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, server };
}

beforeEach(() => {
  resetCosts();
});

describe("mcp server", () => {
  test("serves seventeen tools", async () => {
    const { client, server } = await linkedClient();
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(
        [
          "add_lead",
          "add_prospect",
          "add_vendor",
          "delete_lead",
          "delete_prospect",
          "delete_vendor",
          "get_cost_report",
          "get_lead",
          "get_prospect",
          "get_vendor",
          "list_leads",
          "list_prospects",
          "list_vendors",
          "move_lead",
          "update_lead",
          "update_prospect",
          "update_vendor",
        ].sort(),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("prospect round trip over a client link", async () => {
    const store = new MemoryCrmStore();
    const { client, server } = await linkedClient(store);
    try {
      const added = await client.callTool({
        name: "add_prospect",
        arguments: { name: "Ava", email: "ava@example.com" },
      });
      expect(isError(added)).toBe(false);
      const id = (JSON.parse(textOf(added)).result as { id: string }).id;

      const seen = await client.callTool({ name: "get_prospect", arguments: { id } });
      expect(JSON.parse(textOf(seen))).toMatchObject({ email: "ava@example.com" });

      const listed = await client.callTool({ name: "list_prospects", arguments: {} });
      expect(JSON.parse(textOf(listed))).toHaveLength(1);

      const updated = await client.callTool({
        name: "update_prospect",
        arguments: { id, status: "qualified" },
      });
      expect(JSON.parse(textOf(updated)).result).toMatchObject({ status: "qualified" });

      const removed = await client.callTool({ name: "delete_prospect", arguments: { id } });
      expect(JSON.parse(textOf(removed))).toMatchObject({ dryRun: false, result: true });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("vendor and lead round trip with a dry run preview", async () => {
    const store = new MemoryCrmStore();
    const { client, server } = await linkedClient(store);
    try {
      const preview = await client.callTool({
        name: "add_vendor",
        arguments: { name: "Ink", dryRun: true },
      });
      expect(JSON.parse(textOf(preview))).toMatchObject({ dryRun: true });
      expect(await store.listVendors()).toHaveLength(0);

      const added = await client.callTool({
        name: "add_lead",
        arguments: { title: "Rebuild", value: 100, currency: "USD" },
      });
      const id = (JSON.parse(textOf(added)).result as { id: string }).id;
      const moved = await client.callTool({
        name: "move_lead",
        arguments: { id, stage: "won" },
      });
      expect(JSON.parse(textOf(moved)).result).toMatchObject({ stage: "won" });

      const report = await client.callTool({ name: "get_cost_report", arguments: {} });
      expect(JSON.parse(textOf(report))).toMatchObject({ units: 2 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("a blocked write returns a tool error, not a crash", async () => {
    const { client, server } = await linkedClient(
      new MemoryCrmStore(),
      createGuards({ blocklist: ["nope"] }),
    );
    try {
      const result = await client.callTool({
        name: "add_prospect",
        arguments: { name: "nope", email: "n@example.com" },
      });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toContain("blocklisted");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("bad input returns a tool error", async () => {
    const { client, server } = await linkedClient();
    try {
      const result = await client.callTool({
        name: "add_prospect",
        arguments: { name: "Ava", email: "bad" },
      });
      expect(isError(result)).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
