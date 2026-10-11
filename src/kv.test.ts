import { describe, expect, test } from "vitest";
import { VendorError } from "agentic-core";
import { KvRestClient, KvVendorMirror, vendorKey, VENDOR_KEY_PREFIX } from "./kv.js";
import { mockFetch, type RecordedCall } from "./fakes.js";
import type { Vendor } from "./crm.js";

const OPTIONS = { accountId: "acct", namespaceId: "ns", apiToken: "token" };
const VALUES = "https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/ns/values";

function vendor(id = "v1"): Vendor {
  return {
    id,
    name: "Ink Supply",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("KvRestClient", () => {
  test("get returns the raw value", async () => {
    const calls: RecordedCall[] = [];
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => new Response("hello", { status: 200 }), calls),
    });
    expect(await client.get("vendor:v1")).toBe("hello");
    expect(calls[0]?.url).toBe(`${VALUES}/vendor%3Av1`);
    expect((calls[0]?.init.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer token",
    );
  });

  test("get maps 404 to null", async () => {
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => new Response("missing", { status: 404 })),
    });
    expect(await client.get("vendor:nope")).toBeNull();
  });

  test("get throws VendorError on other failures", async () => {
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => new Response("denied", { status: 403 })),
    });
    const failure = await client.get("k").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(VendorError);
    expect((failure as VendorError).status).toBe(403);
  });

  test("put sends octet-stream and checks success", async () => {
    const calls: RecordedCall[] = [];
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch(
        () => Response.json({ success: true, result: null, errors: [] }),
        calls,
      ),
    });
    await client.put("vendor:v1", JSON.stringify(vendor()));
    expect(calls[0]?.url).toBe(`${VALUES}/vendor%3Av1`);
    expect(calls[0]?.init.method).toBe("PUT");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/octet-stream",
    );
    expect(JSON.parse(calls[0]?.init.body as string)).toMatchObject({ id: "v1" });
  });

  test("put throws when the api reports failure", async () => {
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() =>
        Response.json({ success: false, errors: [{ message: "too large" }] }),
      ),
    });
    await expect(client.put("k", "v")).rejects.toThrow(/too large/);
  });

  test("remove treats 404 as done", async () => {
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => new Response("gone", { status: 404 })),
    });
    await expect(client.remove("vendor:nope")).resolves.toBeUndefined();
  });

  test("listKeys walks cursors to the end", async () => {
    const seen: string[] = [];
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch((url) => {
        seen.push(url);
        if (!url.includes("cursor=")) {
          return Response.json({
            success: true,
            result: [{ name: "vendor:a" }],
            result_info: { cursor: "next" },
            errors: [],
          });
        }
        return Response.json({
          success: true,
          result: [{ name: "vendor:b" }],
          result_info: { cursor: "" },
          errors: [],
        });
      }),
    });
    expect(await client.listKeys(VENDOR_KEY_PREFIX)).toEqual(["vendor:a", "vendor:b"]);
    expect(seen[0]).toContain("prefix=vendor%3A");
    expect(seen[1]).toContain("cursor=next");
  });

  test("a network failure throws VendorError", async () => {
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch(() => {
        throw new TypeError("fetch failed");
      }),
    });
    await expect(client.get("k")).rejects.toThrow(VendorError);
  });
});

describe("KvVendorMirror", () => {
  function mirrorWithCalls(): {
    mirror: KvVendorMirror;
    calls: RecordedCall[];
    values: Map<string, string>;
  } {
    const calls: RecordedCall[] = [];
    const values = new Map<string, string>();
    const client = new KvRestClient({
      ...OPTIONS,
      fetchFn: mockFetch((url, init) => {
        const key = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
        if (init.method === "PUT") {
          values.set(key, init.body as string);
          return Response.json({ success: true, result: null, errors: [] });
        }
        if (init.method === "DELETE") {
          values.delete(key);
          return Response.json({ success: true, result: null, errors: [] });
        }
        const found = values.get(key);
        if (found === undefined) return new Response("missing", { status: 404 });
        return new Response(found, { status: 200 });
      }, calls),
    });
    return { mirror: new KvVendorMirror(client), calls, values };
  }

  test("put then get round trips one vendor", async () => {
    const { mirror } = mirrorWithCalls();
    await mirror.put(vendor());
    expect(await mirror.get("v1")).toMatchObject({ id: "v1", name: "Ink Supply" });
    expect(await mirror.get("missing")).toBeNull();
  });

  test("remove drops the key", async () => {
    const { mirror, values } = mirrorWithCalls();
    await mirror.put(vendor());
    expect(values.has(vendorKey("v1"))).toBe(true);
    await mirror.remove("v1");
    expect(values.has(vendorKey("v1"))).toBe(false);
  });

  test("broken JSON throws VendorError", async () => {
    const { mirror, values } = mirrorWithCalls();
    values.set(vendorKey("v1"), "{oops");
    await expect(mirror.get("v1")).rejects.toThrow(VendorError);
  });
});
