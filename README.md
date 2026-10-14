# agentic-crm

[![npm version](https://img.shields.io/npm/v/agentic-crm)](https://www.npmjs.com/package/agentic-crm) [![Downloads/month](https://img.shields.io/npm/dm/agentic-crm)](https://www.npmjs.com/package/agentic-crm) [![MIT license](https://img.shields.io/badge/license-MIT-blue)](https://opensource.org/license/mit)

[Setup](#create-your-first-prospect) · [API and commands](#runtime-surfaces) · [Cloudflare setup](#integration-guides) · [Comparisons](#compare)

agentic-crm is an open-source customer relationship management (CRM) SDK for developers who track prospects, suppliers, and sales leads. It provides in-memory storage and Cloudflare D1 persistence with optional Cloudflare Workers KV vendor copies. CLI, Model Context Protocol (MCP), and Worker interfaces expose the record operations.

## Install

```bash
npm install agentic-crm
```

Node.js 18 or later is required for the SDK and CLI. TypeScript declarations are included.

## Create your first prospect

Save this as `crm-demo.mjs`, then run `node crm-demo.mjs`.

```js
import {
  MemoryCrmStore, prospectInputSchema, runWrite, getCostReport,
} from 'agentic-crm';

const store = new MemoryCrmStore();
await store.init();
const input = prospectInputSchema.parse({ name: 'Ava', email: 'ava@example.com' });
const add = () => store.addProspect(input);
console.log(await runWrite(store.name, 'add prospect Ava', { dryRun: true }, add));
const written = await runWrite(store.name, 'add prospect Ava', {}, add);
console.log(await store.getProspect(written.result.id));
console.log(getCostReport());
```

Success prints a preview, then Ava's record with an ID and `status: "new"`. The report shows `units: 1`.
No credentials or environment variables are needed. Records survive only while this store instance exists.
Separate memory-mode CLI invocations start with empty stores.

## How it works

```text
SDK / CLI / MCP -> validation -> memory store
                             -> SQL store -> D1 REST API or Worker DB binding
Vendor SQL write -> optional KV mirror under vendor:<id>
Worker HTTP routes -> SQL store through bindings
```

## Why it exists

Some applications need a small record API under their own control. agentic-crm supplies three record types without a separate CRM account.
HubSpot provides a broader CRM object API. agentic-crm leaves user interfaces, message delivery, and workflow automation to your application.

## Compare

Scope checked on 2026-10-14 against [HubSpot contact API documentation](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide).

| Surface | agentic-crm | HubSpot CRM API |
|---|---|---|
| Record model | Fixed prospects, vendors, leads | CRM objects with properties and associations |
| Persistence | Your Cloudflare D1 database or process memory | HubSpot account |
| Configuration | TypeScript options, CLI flags, Worker bindings | Object properties and API requests |
| Integration here | Native stores | No HubSpot adapter included |

## Coverage

| Integration | Status | Implemented behavior |
|---|---|---|
| Process memory | ✓ | Prospect, vendor, and lead operations |
| Cloudflare D1 REST API | ✓ | SQL store for Node.js SDK, CLI, and MCP |
| Cloudflare D1 Worker binding | ✓ | Same SQL store through `DB` |
| Cloudflare Workers KV REST API | ✓ | Optional vendor JSON mirror and helper reads |
| Cloudflare Workers KV binding | ✓ | Optional vendor mirror through `VENDOR_CACHE` |

The source defines two stores, three record types, and two Cloudflare services with REST and binding paths.
These paths are implemented. Tests use fake SQL runners, bindings, and fetch calls; no Cloudflare account is credential-verified for this rewrite.

Prospect statuses are `new`, `contacted`, `qualified`, and `unqualified`.
Vendor statuses are `active` and `inactive`.
The five lead stages are `new`, `contacted`, `proposal`, `won`, and `lost`.

## Common use cases

1. Node.js developers: prototype a prospect workflow with `MemoryCrmStore` in one process.
2. Cloudflare Workers developers: persist prospects and sales leads in D1 through the HTTP entry.
3. Supplier operations teams: keep D1 vendor records and optional KV copies under `vendor:<id>`.
4. MCP client authors: add a lead, read it back, and move it to `proposal` in one server session.
5. TypeScript application teams: filter leads by prospect, supplier, stage, or title through a shared store contract.

## Features

- **Prospect records:** create, read, filter, update, and delete contact records.
- **Vendor records:** manage suppliers with optional [Cloudflare KV mirroring](#integration-guides).
- **Lead stages:** associate IDs, record values, and move leads between five stages.
- **Validation:** parse inputs and patches with exported Zod schemas.
- **Write previews:** use `runWrite` or CLI/MCP dry-run options before a mutation.
- **Optional guards:** supply dispatch caps, UTC quiet hours, and a substring blocklist through SDK integration.
- **Usage records:** count wrapped writes in the current process.

## Runtime surfaces

The Node.js SDK exports `MemoryCrmStore`, `SqlCrmStore`, `createD1Store`, D1/KV clients, validation schemas, and `runWrite`.
It also re-exports shared logging, guard, and cost helpers from `agentic-core`.

The CLI provides 20 commands, including help and version:

| Records | Commands |
|---|---|
| Prospects | `add-prospect`, `get-prospect`, `list-prospects`, `update-prospect`, `delete-prospect` |
| Vendors | `add-vendor`, `get-vendor`, `list-vendors`, `update-vendor`, `delete-vendor` |
| Leads | `add-lead`, `get-lead`, `list-leads`, `update-lead`, `move-lead`, `delete-lead` |
| Other | `costs`, `mcp`, `help`, `version` |

Use `--help`/`-h` or `--version`/`-V` as shortcuts. Add `--store d1` for persistence or `--dry-run` to preview writes.

The MCP server exposes 17 tools:

| Records | Tools |
|---|---|
| Prospects | `add_prospect`, `get_prospect`, `list_prospects`, `update_prospect`, `delete_prospect` |
| Vendors | `add_vendor`, `get_vendor`, `list_vendors`, `update_vendor`, `delete_vendor` |
| Leads | `add_lead`, `get_lead`, `list_leads`, `update_lead`, `move_lead`, `delete_lead` |
| Usage | `get_cost_report` |

```json
{"mcpServers":{"agentic-crm":{"command":"npx","args":["-y","agentic-crm","mcp"]}}}
```

Use `npx agentic-crm mcp --store d1` for a persistent server.
The separate `agentic-crm-mcp` binary starts the default memory server.

The Worker exposes `GET /health`; collection GET/POST and item GET/PATCH/DELETE routes for `/prospects`, `/vendors`, and `/leads`.
`POST /leads/:id/move` accepts `{ "stage": "proposal" }`.

## Delivery and behavior limits

- Writes execute by default. Preview first with CLI `--dry-run`, MCP `dryRun: true`, or `runWrite` options.
- `runWrite` does not validate inputs itself. Parse inputs before preview; CLI dry runs can skip store-level schema validation.
- CLI D1 commands initialize the schema before `runWrite`. Even dry runs can call Cloudflare and create tables or indexes.
- Direct store methods bypass `runWrite` guards and usage records. Default CLI and MCP startup configure no guards.
- Memory records and cost records reset with the process. A separate CLI `costs` call cannot read previous process usage.
- Wrapped writes add one usage unit even when a store returns `null` or `false`. Units are not Cloudflare charges.
- D1 and KV writes are sequential, not atomic. A KV failure can leave the D1 mutation committed.
- CRM reads use D1, not the KV mirror. KV is not a complete standalone CRM store.
- D1/KV REST clients default to 15-second timeouts without retries. Record list methods provide no pagination.
- Lead links have no foreign-key enforcement or cascading delete behavior. Currency checks length, not ISO membership.
- Memory query filters search more fields than SQL filters. Their ordering also differs.
- The Worker has no built-in authentication, authorization, write guards, or dry-run mode. Add access controls before exposing it.
- Worker GET routes do not initialize tables. Initialize the database before the first read.
- There is no managed CRM service, web dashboard, email sender, or HubSpot synchronization.

## Integration guides

### Cloudflare D1 from Node.js

Export your credentials before launching the process. The package does not load `.env` files.

```bash
export CLOUDFLARE_ACCOUNT_ID='YOUR_ACCOUNT_ID'
export CLOUDFLARE_API_TOKEN='YOUR_API_TOKEN'
export CRM_D1_DATABASE_ID='YOUR_DATABASE_ID'
# Optional vendor mirror:
export CRM_KV_NAMESPACE_ID='YOUR_KV_NAMESPACE_ID'
```

Use a token with D1 access and KV access when mirroring.
Preview first, then persist and read a prospect:

```bash
npx agentic-crm add-prospect --name Ava --email ava@example.com --store d1 --dry-run
npx agentic-crm add-prospect --name Ava --email ava@example.com --store d1
npx agentic-crm list-prospects --query Ava --store d1
```

The final command returns Ava's persisted record. Omit `CRM_KV_NAMESPACE_ID` to keep vendor records in D1 without mirroring.

SDK callers can use `const store = createD1Store(process.env)` followed by `await store.init()`.

### A Cloudflare Worker you deploy

The repository includes `src/worker.ts` and `wrangler.jsonc`.
Set your D1 `database_id` and optional KV namespace `id` in that configuration.
If you omit KV, remove its incomplete namespace entry. Configure Node.js compatibility and access controls for your deployment.
Initialize the D1 schema before collection reads. The exported `SCHEMA_STATEMENTS` contains the table and index statements.
Deploy through your Wrangler setup after local verification; this package provides no deployment command or managed endpoint.

## Status

Version 0.1.0 is an early release. APIs and schema behavior can change before 1.0.
Use [GitHub issues](https://github.com/pooriaarab/agentic-crm/issues) for support. Public case studies are not yet published in this repository.

## FAQ

### What is agentic-crm?

agentic-crm is a TypeScript record SDK for prospects, suppliers, and sales leads. It exposes memory and Cloudflare D1 stores through CLI, MCP, and Worker interfaces.

### Which integrations are verified?

agentic-crm tests D1 and KV behavior through fakes and mocked transports. This rewrite does not verify a live Cloudflare account.

### Does agentic-crm provide a managed CRM?

agentic-crm runs in your Node.js process or a Worker you deploy. You own Cloudflare storage and access controls.

### How is agentic-crm different from HubSpot?

agentic-crm provides three fixed record types in your own store. HubSpot provides an account-based CRM object API with properties and associations.

### Why is my memory-mode CLI list empty?

agentic-crm creates a fresh memory store for each CLI process. Use one SDK instance, one MCP session, or D1 for records shared between calls.

### Is KV a standalone store?

agentic-crm uses KV as an optional vendor mirror. Prospects and leads remain in D1, and CRM reads also use D1.

### Do dry runs validate everything without network calls?

agentic-crm CLI dry runs can skip validation inside store methods. D1 mode also initializes the schema before returning a preview.

### Do all SDK writes enforce guards?

agentic-crm direct store methods validate records but bypass write guards. Use `runWrite` with a configured guard instance when you need guarded operations.

### Does the Worker require authentication?

agentic-crm Worker source does not enforce authentication. Add your own access controls before deployment.

## License

[MIT](https://opensource.org/license/mit).
