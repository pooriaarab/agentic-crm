# agentic-crm agent guide

Small CRM for prospects, vendors, and leads on Cloudflare D1 and KV.

## Mental model

Records go in. The same records come out. One store serves all
three faces, so each face returns the same shape.

## The three faces

- SDK: `import { MemoryCrmStore } from "agentic-crm"`.
- CLI: `npx agentic-crm list-prospects`.
- MCP: `npx agentic-crm mcp`, then call a tool below.

Keywords: crm, contacts, pipeline, agentic-suite, claude-code, codex, cli, mcp.

## MCP tools

| Tool | Use it for |
| --- | --- |
| add_prospect | Add a prospect. Pass dryRun to preview. |
| get_prospect | Read one prospect by id. |
| list_prospects | List prospects with filters. |
| update_prospect | Patch a prospect. Pass dryRun to preview. |
| delete_prospect | Delete a prospect. Pass dryRun to preview. |
| add_vendor | Add a vendor. Pass dryRun to preview. |
| get_vendor | Read one vendor by id. |
| list_vendors | List vendors with filters. |
| update_vendor | Patch a vendor. Pass dryRun to preview. |
| delete_vendor | Delete a vendor. Pass dryRun to preview. |
| add_lead | Add a lead. Pass dryRun to preview. |
| get_lead | Read one lead by id. |
| list_leads | List leads with filters. |
| update_lead | Patch a lead. Pass dryRun to preview. |
| move_lead | Move a lead to a new stage. Pass dryRun to preview. |
| delete_lead | Delete a lead. Pass dryRun to preview. |
| request_call | Request a voice call for a prospect or lead. Pass dryRun to preview. |
| get_call | Read one call by id. |
| list_calls | List calls with vendor, status, and link filters. |
| attach_transcript | Attach transcript/audio refs or move call status. Records no cost. |
| get_cost_report | Read session cost totals. |

## The loop

1. Discover the tools with `tools/list`.
2. Preview a write with dryRun true.
3. Run the real write when the preview looks right.
4. Read the record back to confirm.
5. Read `get_cost_report` and state the cost.

## Rules

- Preview with dry run before each real write.
- Stop when a guard denies the call. State the reason.
- Never retry a denied call with changed text to dodge a guard.
- Report adapter errors as errors. Never present them as success.
- State the cost report before you claim the task is done.
