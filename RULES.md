# agentic-crm rules

These rules bind every run of agentic-crm. They also bind
agents that drive this pack over MCP.

1. Preview before you act. Run each write with dry run first.
2. Respect guards. A denied call stays denied.
3. Report failures as failures. Adapters throw, and callers surface
   the error. No silent success follows a failed call.
4. Count the cost. Read the cost report before you close a task.
5. Keep quiet hours. The pack refuses writes inside the window.

Pack: Small CRM for prospects, vendors, and leads on Cloudflare D1 and KV. Keywords: crm, contacts, pipeline, agentic-suite, claude-code, codex, cli, mcp.
