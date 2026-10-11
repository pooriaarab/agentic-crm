import { z, ZodError } from "zod";
import {
  leadInputSchema,
  leadPatchSchema,
  prospectInputSchema,
  prospectPatchSchema,
  vendorInputSchema,
  vendorPatchSchema,
  LEAD_STAGES,
  PROSPECT_STATUSES,
  VENDOR_STATUSES,
} from "./crm.js";
import {
  BindingSqlRunner,
  SqlCrmStore,
  type D1Binding,
  type VendorMirror,
} from "./d1.js";
import { KvBindingMirror, type KvBinding } from "./kv.js";
import { VERSION } from "./version.js";

// Worker. The same SQL store as the CLI, but over the D1 binding
// instead of REST, with the KV binding as the vendor mirror. Deploy
// with wrangler after you fill the D1 and KV ids in wrangler.jsonc.

export interface WorkerEnv {
  DB: D1Binding;
  VENDOR_CACHE?: KvBinding;
  PACK_NAME?: string;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function zodText(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

function storeFor(env: WorkerEnv): SqlCrmStore {
  const mirror: VendorMirror | undefined =
    env.VENDOR_CACHE === undefined ? undefined : new KvBindingMirror(env.VENDOR_CACHE);
  return new SqlCrmStore(new BindingSqlRunner(env.DB), mirror, "d1-binding");
}

async function readBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw json({ error: "body must be JSON" }, 400);
  }
}

async function guardBody<T>(request: Request, schema: z.ZodSchema<T>): Promise<T> {
  const body = await readBody(request);
  try {
    return schema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw json({ error: zodText(error) }, 400);
    }
    throw error;
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter((part) => part.length > 0);
    const store = storeFor(env);

    try {
      if (request.method === "GET" && parts.length === 1 && parts[0] === "health") {
        return json({ ok: true, pack: env.PACK_NAME ?? "agentic-crm", version: VERSION });
      }

      const kind = parts[0];
      if (kind !== "prospects" && kind !== "vendors" && kind !== "leads") {
        return json({ error: "not found" }, 404);
      }

      // Collection routes.
      if (parts.length === 1) {
        if (request.method === "GET") {
          const query = url.searchParams.get("query") ?? undefined;
          if (kind === "prospects") {
            const status = url.searchParams.get("status") ?? undefined;
            if (status !== undefined) z.object({ status: z.enum(PROSPECT_STATUSES) }).parse({ status });
            return json(await store.listProspects({ status: status as never, query }));
          }
          if (kind === "vendors") {
            const status = url.searchParams.get("status") ?? undefined;
            if (status !== undefined) z.object({ status: z.enum(VENDOR_STATUSES) }).parse({ status });
            return json(await store.listVendors({ status: status as never, query }));
          }
          const stage = url.searchParams.get("stage") ?? undefined;
          if (stage !== undefined) z.object({ stage: z.enum(LEAD_STAGES) }).parse({ stage });
          return json(
            await store.listLeads({
              stage: stage as never,
              prospectId: url.searchParams.get("prospectId") ?? undefined,
              vendorId: url.searchParams.get("vendorId") ?? undefined,
              query,
            }),
          );
        }
        if (request.method === "POST") {
          await store.init();
          if (kind === "prospects") {
            return json(await store.addProspect(await guardBody(request, prospectInputSchema)), 201);
          }
          if (kind === "vendors") {
            return json(await store.addVendor(await guardBody(request, vendorInputSchema)), 201);
          }
          return json(await store.addLead(await guardBody(request, leadInputSchema)), 201);
        }
        return json({ error: "not found" }, 404);
      }

      // Lead move route.
      if (parts.length === 3 && kind === "leads" && parts[2] === "move") {
        if (request.method !== "POST") return json({ error: "not found" }, 404);
        const id = parts[1] as string;
        const body = await guardBody(request, z.object({ stage: z.enum(LEAD_STAGES) }));
        await store.init();
        const moved = await store.moveLead(id, body.stage);
        if (moved === null) return json({ error: `no lead with id "${id}"` }, 404);
        return json(moved);
      }

      // Item routes.
      if (parts.length === 2) {
        const id = parts[1] as string;
        if (request.method === "GET") {
          const found =
            kind === "prospects"
              ? await store.getProspect(id)
              : kind === "vendors"
                ? await store.getVendor(id)
                : await store.getLead(id);
          if (found === null) return json({ error: `no ${kind.slice(0, -1)} with id "${id}"` }, 404);
          return json(found);
        }
        if (request.method === "PATCH") {
          await store.init();
          if (kind === "prospects") {
            const next = await store.updateProspect(id, await guardBody(request, prospectPatchSchema));
            if (next === null) return json({ error: `no prospect with id "${id}"` }, 404);
            return json(next);
          }
          if (kind === "vendors") {
            const next = await store.updateVendor(id, await guardBody(request, vendorPatchSchema));
            if (next === null) return json({ error: `no vendor with id "${id}"` }, 404);
            return json(next);
          }
          const next = await store.updateLead(id, await guardBody(request, leadPatchSchema));
          if (next === null) return json({ error: `no lead with id "${id}"` }, 404);
          return json(next);
        }
        if (request.method === "DELETE") {
          await store.init();
          const removed =
            kind === "prospects"
              ? await store.deleteProspect(id)
              : kind === "vendors"
                ? await store.deleteVendor(id)
                : await store.deleteLead(id);
          if (!removed) return json({ error: `no ${kind.slice(0, -1)} with id "${id}"` }, 404);
          return json({ deleted: true, id });
        }
        return json({ error: "not found" }, 404);
      }

      return json({ error: "not found" }, 404);
    } catch (error) {
      if (error instanceof Response) return error;
      if (error instanceof ZodError) {
        return json({ error: zodText(error) }, 400);
      }
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: message }, 500);
    }
  },
};
