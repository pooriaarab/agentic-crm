# Agentic CRM

Small CRM for prospects, vendors, and leads on Cloudflare D1 and KV.

You run it three ways: as a terminal command, as an npm import,
or as an MCP server for agents. All three share one store, so each
face returns the same shapes.

## Install

```sh
npm install agentic-crm
```

The command needs Node 18 or newer.

## Quick start

Memory mode needs no keys. It keeps records in the process, so you
can try every command at once.

```sh
npx agentic-crm add-prospect --name "Ava" --email "ava@example.com"
npx agentic-crm add-vendor --name "Ink Supply" --category "office"
npx agentic-crm add-lead --title "Site rebuild" --value 1200 --currency USD
npx agentic-crm list-prospects
npx agentic-crm move-lead --id <lead-id> --stage proposal
```

Each write prints JSON. Each read prints JSON. A missing record
prints an error and exits 1.

## Use D1 and KV

Pass `--store d1` to persist records in Cloudflare D1. Vendors also
mirror to KV as JSON under `vendor:<id>`. Set these vars first:

| Var | Use |
| --- | --- |
| CLOUDFLARE_ACCOUNT_ID | Your Cloudflare account id. |
| CLOUDFLARE_API_TOKEN | A token with D1 edit rights. |
| CRM_D1_DATABASE_ID | The D1 database id. |
| CRM_KV_NAMESPACE_ID | The KV namespace id. Optional. |

```sh
agentic-crm add-prospect --name "Ava" --email "ava@example.com" --store d1
agentic-crm list-leads --stage proposal --store d1
```

Without `CRM_KV_NAMESPACE_ID` vendors still persist in D1. Only the
KV copy is skipped. The pack reads no other store.

## Preview writes

Add `--dry-run` to preview any write. The pack checks guards and
validates input, then prints the preview. It calls no adapter and
records no cost.

```sh
agentic-crm add-lead --title "Rebuild" --dry-run
agentic-crm move-lead --id <lead-id> --stage won --dry-run
```

## Use the library

```js
import { MemoryCrmStore, createD1Store } from "agentic-crm";

const store = new MemoryCrmStore();
const prospect = await store.addProspect({ name: "Ava", email: "ava@example.com" });
console.log(await store.listProspects());

const live = createD1Store(process.env);
await live.init();
console.log(await live.listLeads({ stage: "proposal" }));
```

## Use the MCP server

Start the server, then point your agent at it:

```sh
agentic-crm mcp
agentic-crm mcp --store d1
```

Or add it to your MCP config:

```json
{ "mcpServers": { "agentic-crm": { "command": "npx", "args": ["-y", "agentic-crm", "mcp"] } } }
```

Tools: `add_prospect`, `get_prospect`, `list_prospects`,
`update_prospect`, `delete_prospect`, `add_vendor`, `get_vendor`,
`list_vendors`, `update_vendor`, `delete_vendor`, `add_lead`,
`get_lead`, `list_leads`, `update_lead`, `move_lead`, `delete_lead`,
`get_cost_report`. Write tools take `dryRun` to preview only.

## Three usecases

1. You track people to win. Add each prospect with a status, then
   search and filter the list as it grows.
2. You track suppliers in one place. Add each vendor once, then
   read it back from D1 or from the KV copy.
3. You run a small pipeline. Add each deal as a lead, then move it
   from stage to stage until it closes.

## Guards and costs

Writes pass through guards: a dispatch cap, quiet hours, and a
blocklist. A denied write throws and writes nothing. Each real
write records one cost unit. Read the totals any time:

```sh
agentic-crm costs
```

## Worker

`src/worker.ts` serves the same store over HTTP on D1 plus KV
bindings. It exposes `/health`, `/prospects`, `/vendors`, and
`/leads`. Fill the D1 and KV ids in `wrangler.jsonc`, then deploy
with wrangler from the pack root.

## License

MIT. See LICENSE.
