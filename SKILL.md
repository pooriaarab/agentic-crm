---
name: agentic-crm
description: Small CRM for prospects, vendors, and leads on Cloudflare D1 and KV. Keywords: crm, contacts, pipeline, agentic-suite, claude-code, codex, cli, mcp.
---

# agentic-crm

Small CRM for prospects, vendors, and leads on Cloudflare D1 and KV.

## Use the SDK

```js
import { MemoryCrmStore } from "agentic-crm";

const store = new MemoryCrmStore();
await store.addProspect({ name: "Ava", email: "ava@example.com" });
console.log(await store.listProspects());
```

## Use the CLI

```sh
agentic-crm add-prospect --name "Ava" --email "ava@example.com"
agentic-crm add-prospect --name "Ava" --email "ava@example.com" --dry-run
agentic-crm list-leads --stage proposal
```

## Use the MCP server

Start the server with `agentic-crm mcp`. Call `add_prospect` for
writes, `list_prospects` for reads, `move_lead` for stage changes,
`get_cost_report` for costs.

## Rules

- Preview each write with dry run first.
- Report guard denials and adapter errors as failures.
- Read the cost report at the end.
