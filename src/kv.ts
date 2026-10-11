import { VendorError } from "agentic-core";
import type { Vendor } from "./crm.js";

// KV over REST. Vendors live in D1 plus KV: D1 holds the table, KV
// holds one JSON copy per vendor under vendor:<id> for fast reads.
// Endpoint shapes follow the Cloudflare KV API: GET/PUT/DELETE on
// .../values/<key>, GET on .../keys for listing.

export interface KvRestOptions {
  accountId: string;
  namespaceId: string;
  apiToken: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

interface KvEnvelope {
  success: boolean;
  result?: unknown;
  result_info?: { cursor?: string };
  errors?: { message?: string }[];
}

interface KvKeyEntry {
  name: string;
}

function apiErrorText(errors: { message?: string }[] | undefined, status: number): string {
  const lines = (errors ?? [])
    .map((entry) => entry.message ?? "")
    .filter((line) => line.length > 0);
  const detail = lines.length > 0 ? lines.join("; ") : "no detail";
  return `kv request failed with status ${status}: ${detail}`;
}

export class KvRestClient {
  private readonly valuesUrl: string;
  private readonly keysUrl: string;
  private readonly apiToken: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: KvRestOptions) {
    for (const key of ["accountId", "namespaceId", "apiToken"] as const) {
      if (options[key].trim().length === 0) {
        throw new Error(`kv client needs ${key}`);
      }
    }
    const base = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    const root = `${base}/accounts/${options.accountId}/storage/kv/namespaces/${options.namespaceId}`;
    this.valuesUrl = `${root}/values`;
    this.keysUrl = `${root}/keys`;
    this.apiToken = options.apiToken;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private async send(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(path, {
        ...init,
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new VendorError(`kv request failed: ${String(error)}`, { cause: error });
    }
  }

  // Reads return the raw value, or null when the key is missing. A
  // 404 is a miss, not a failure. Anything else outside 2xx throws.
  async get(key: string): Promise<string | null> {
    const response = await this.send(`${this.valuesUrl}/${encodeURIComponent(key)}`, {
      method: "GET",
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new VendorError(apiErrorText(undefined, response.status), {
        status: response.status,
      });
    }
    return response.text();
  }

  async put(key: string, value: string, expirationTtl?: number): Promise<void> {
    let url = `${this.valuesUrl}/${encodeURIComponent(key)}`;
    if (expirationTtl !== undefined) {
      url += `?expiration_ttl=${encodeURIComponent(String(expirationTtl))}`;
    }
    const response = await this.send(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: value,
    });
    if (!response.ok) {
      let errors: { message?: string }[] | undefined;
      try {
        errors = ((await response.json()) as KvEnvelope).errors;
      } catch {
        errors = undefined;
      }
      throw new VendorError(apiErrorText(errors, response.status), {
        status: response.status,
      });
    }
    let envelope: KvEnvelope;
    try {
      envelope = (await response.json()) as KvEnvelope;
    } catch (error) {
      throw new VendorError("kv put returned no JSON", {
        status: response.status,
        cause: error,
      });
    }
    if (envelope.success !== true) {
      throw new VendorError(apiErrorText(envelope.errors, response.status), {
        status: response.status,
      });
    }
  }

  // Deletes are idempotent: a missing key still counts as done.
  async remove(key: string): Promise<void> {
    const response = await this.send(`${this.valuesUrl}/${encodeURIComponent(key)}`, {
      method: "DELETE",
    });
    if (response.status === 404) return;
    if (!response.ok) {
      let errors: { message?: string }[] | undefined;
      try {
        errors = ((await response.json()) as KvEnvelope).errors;
      } catch {
        errors = undefined;
      }
      throw new VendorError(apiErrorText(errors, response.status), {
        status: response.status,
      });
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const params = new URLSearchParams({ prefix, limit: "1000" });
      if (cursor !== undefined) params.set("cursor", cursor);
      const response = await this.send(`${this.keysUrl}?${params.toString()}`, {
        method: "GET",
      });
      if (!response.ok) {
        throw new VendorError(apiErrorText(undefined, response.status), {
          status: response.status,
        });
      }
      let envelope: KvEnvelope;
      try {
        envelope = (await response.json()) as KvEnvelope;
      } catch (error) {
        throw new VendorError("kv list returned no JSON", {
          status: response.status,
          cause: error,
        });
      }
      if (envelope.success !== true) {
        throw new VendorError(apiErrorText(envelope.errors, response.status), {
          status: response.status,
        });
      }
      const entries = (envelope.result ?? []) as KvKeyEntry[];
      for (const entry of entries) {
        names.push(entry.name);
      }
      const next = envelope.result_info?.cursor;
      if (next === undefined || next.length === 0 || entries.length === 0) break;
      cursor = next;
    }
    return names;
  }
}

// Vendor mirror. One JSON copy per vendor. The store writes through
// it after each D1 write and removes through it after each delete.

export const VENDOR_KEY_PREFIX = "vendor:";

export function vendorKey(id: string): string {
  return `${VENDOR_KEY_PREFIX}${id}`;
}

export class KvVendorMirror {
  constructor(private readonly client: KvRestClient) {}

  async put(vendor: Vendor): Promise<void> {
    await this.client.put(vendorKey(vendor.id), JSON.stringify(vendor));
  }

  async get(id: string): Promise<Vendor | null> {
    const raw = await this.client.get(vendorKey(id));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as Vendor;
    } catch (error) {
      throw new VendorError(`kv holds broken JSON for vendor ${id}`, { cause: error });
    }
  }

  async remove(id: string): Promise<void> {
    await this.client.remove(vendorKey(id));
  }

  async listIds(): Promise<string[]> {
    const keys = await this.client.listKeys(VENDOR_KEY_PREFIX);
    return keys
      .filter((key) => key.startsWith(VENDOR_KEY_PREFIX))
      .map((key) => key.slice(VENDOR_KEY_PREFIX.length));
  }
}

// Binding mirror. Same shape as KvVendorMirror, but over the KV
// binding for the worker. The worker passes env.VENDOR_CACHE.

export interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class KvBindingMirror {
  constructor(private readonly binding: KvBinding) {}

  async put(vendor: Vendor): Promise<void> {
    try {
      await this.binding.put(vendorKey(vendor.id), JSON.stringify(vendor));
    } catch (error) {
      throw new VendorError(`kv put failed for vendor ${vendor.id}: ${String(error)}`, {
        cause: error,
      });
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.binding.delete(vendorKey(id));
    } catch (error) {
      throw new VendorError(`kv delete failed for vendor ${id}: ${String(error)}`, {
        cause: error,
      });
    }
  }
}
