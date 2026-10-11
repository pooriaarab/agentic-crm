import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createLogger,
  getCostReport,
  GuardError,
  VendorError,
  type Guards,
  type Logger,
} from "agentic-core";
import { z, ZodError } from "zod";
import {
  describeInput,
  LEAD_STAGES,
  MemoryCrmStore,
  PROSPECT_STATUSES,
  runWrite,
  VENDOR_STATUSES,
  leadInputShape,
  leadPatchShape,
  prospectInputShape,
  prospectPatchShape,
  vendorInputShape,
  vendorPatchShape,
  type CrmStore,
  type CrmWriteOptions,
  type LeadInput,
  type LeadPatch,
  type ProspectInput,
  type ProspectPatch,
  type VendorInput,
  type VendorPatch,
} from "./crm.js";
import { DEFAULT_BRAND } from "./index.js";

export interface McpDeps {
  store?: CrmStore;
  guards?: Guards;
  logger?: Logger;
}

type ToolResult =
  | { content: { type: "text"; text: string }[] }
  | { content: { type: "text"; text: string }[]; isError: true };

function errorResult(error: unknown): ToolResult {
  const message =
    error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function isToolError(error: unknown): boolean {
  return (
    error instanceof GuardError || error instanceof VendorError || error instanceof ZodError
  );
}

const dryRunShape = {
  dryRun: z.boolean().optional().describe("Preview the write without touching the store."),
} as const;

const idShape = {
  id: z.string().describe("The record id."),
} as const;

const READ_ANNOTATIONS = { readOnlyHint: true } as const;
const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
const DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export function createMcpServer(deps: McpDeps = {}): McpServer {
  const store = deps.store ?? new MemoryCrmStore();
  const guards = deps.guards;
  const logger = deps.logger ?? createLogger({ quiet: true });
  const server = new McpServer({
    name: DEFAULT_BRAND.command,
    version: DEFAULT_BRAND.version,
  });

  const write = async <T>(
    label: string,
    dryRun: boolean | undefined,
    act: () => Promise<T>,
  ): Promise<ToolResult> => {
    const options: CrmWriteOptions = { guards, logger, dryRun: dryRun ?? false };
    try {
      return okResult(await runWrite(store.name, label, options, act));
    } catch (error) {
      if (isToolError(error)) return errorResult(error);
      throw error;
    }
  };

  const read = async (act: () => Promise<unknown>): Promise<ToolResult> => {
    try {
      return okResult(await act());
    } catch (error) {
      if (isToolError(error)) return errorResult(error);
      throw error;
    }
  };

  server.registerTool(
    "add_prospect",
    {
      description: "Add a prospect. Pass dryRun to preview only.",
      inputSchema: { ...prospectInputShape, ...dryRunShape },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ dryRun, ...input }) =>
      write(describeInput("prospect", input), dryRun, () =>
        store.addProspect(input as ProspectInput),
      ),
  );

  server.registerTool(
    "get_prospect",
    {
      description: "Read one prospect by id. Returns null when missing.",
      inputSchema: idShape,
      annotations: READ_ANNOTATIONS,
    },
    async ({ id }) => read(() => store.getProspect(id)),
  );

  server.registerTool(
    "list_prospects",
    {
      description: "List prospects, with optional status and text filters.",
      inputSchema: {
        status: z.enum(PROSPECT_STATUSES).optional().describe("Only this status."),
        query: z.string().optional().describe("Match name, email, or company."),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ status, query }) => read(() => store.listProspects({ status, query })),
  );

  server.registerTool(
    "update_prospect",
    {
      description: "Patch a prospect. Pass dryRun to preview only.",
      inputSchema: { ...idShape, ...prospectPatchShape, ...dryRunShape },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ id, dryRun, ...patch }) =>
      write(`update prospect ${id}`, dryRun, () =>
        store.updateProspect(id, patch as ProspectPatch),
      ),
  );

  server.registerTool(
    "delete_prospect",
    {
      description: "Delete a prospect. Pass dryRun to preview only.",
      inputSchema: { ...idShape, ...dryRunShape },
      annotations: DELETE_ANNOTATIONS,
    },
    async ({ id, dryRun }) =>
      write(`delete prospect ${id}`, dryRun, () => store.deleteProspect(id)),
  );

  server.registerTool(
    "add_vendor",
    {
      description: "Add a vendor. Pass dryRun to preview only.",
      inputSchema: { ...vendorInputShape, ...dryRunShape },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ dryRun, ...input }) =>
      write(describeInput("vendor", input), dryRun, () => store.addVendor(input as VendorInput)),
  );

  server.registerTool(
    "get_vendor",
    {
      description: "Read one vendor by id. Returns null when missing.",
      inputSchema: idShape,
      annotations: READ_ANNOTATIONS,
    },
    async ({ id }) => read(() => store.getVendor(id)),
  );

  server.registerTool(
    "list_vendors",
    {
      description: "List vendors, with optional status and text filters.",
      inputSchema: {
        status: z.enum(VENDOR_STATUSES).optional().describe("Only this status."),
        query: z.string().optional().describe("Match name or category."),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ status, query }) => read(() => store.listVendors({ status, query })),
  );

  server.registerTool(
    "update_vendor",
    {
      description: "Patch a vendor. Pass dryRun to preview only.",
      inputSchema: { ...idShape, ...vendorPatchShape, ...dryRunShape },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ id, dryRun, ...patch }) =>
      write(`update vendor ${id}`, dryRun, () => store.updateVendor(id, patch as VendorPatch)),
  );

  server.registerTool(
    "delete_vendor",
    {
      description: "Delete a vendor. Pass dryRun to preview only.",
      inputSchema: { ...idShape, ...dryRunShape },
      annotations: DELETE_ANNOTATIONS,
    },
    async ({ id, dryRun }) => write(`delete vendor ${id}`, dryRun, () => store.deleteVendor(id)),
  );

  server.registerTool(
    "add_lead",
    {
      description: "Add a lead. Pass dryRun to preview only.",
      inputSchema: { ...leadInputShape, ...dryRunShape },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ dryRun, ...input }) =>
      write(describeInput("lead", input), dryRun, () => store.addLead(input as LeadInput)),
  );

  server.registerTool(
    "get_lead",
    {
      description: "Read one lead by id. Returns null when missing.",
      inputSchema: idShape,
      annotations: READ_ANNOTATIONS,
    },
    async ({ id }) => read(() => store.getLead(id)),
  );

  server.registerTool(
    "list_leads",
    {
      description: "List leads, with optional stage, link, and text filters.",
      inputSchema: {
        stage: z.enum(LEAD_STAGES).optional().describe("Only this pipeline stage."),
        prospectId: z.string().optional().describe("Only leads linked to this prospect."),
        vendorId: z.string().optional().describe("Only leads linked to this vendor."),
        query: z.string().optional().describe("Match the title."),
      },
      annotations: READ_ANNOTATIONS,
    },
    async ({ stage, prospectId, vendorId, query }) =>
      read(() => store.listLeads({ stage, prospectId, vendorId, query })),
  );

  server.registerTool(
    "update_lead",
    {
      description: "Patch a lead. Pass dryRun to preview only.",
      inputSchema: { ...idShape, ...leadPatchShape, ...dryRunShape },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ id, dryRun, ...patch }) =>
      write(`update lead ${id}`, dryRun, () => store.updateLead(id, patch as LeadPatch)),
  );

  server.registerTool(
    "move_lead",
    {
      description: "Move a lead to a new pipeline stage. Pass dryRun to preview only.",
      inputSchema: {
        ...idShape,
        stage: z.enum(LEAD_STAGES).describe("The new pipeline stage."),
        ...dryRunShape,
      },
      annotations: WRITE_ANNOTATIONS,
    },
    async ({ id, stage, dryRun }) =>
      write(`move lead ${id} to ${stage}`, dryRun, () => store.moveLead(id, stage)),
  );

  server.registerTool(
    "delete_lead",
    {
      description: "Delete a lead. Pass dryRun to preview only.",
      inputSchema: { ...idShape, ...dryRunShape },
      annotations: DELETE_ANNOTATIONS,
    },
    async ({ id, dryRun }) => write(`delete lead ${id}`, dryRun, () => store.deleteLead(id)),
  );

  server.registerTool(
    "get_cost_report",
    {
      description: "Read the cost report for this session.",
      inputSchema: {},
      annotations: READ_ANNOTATIONS,
    },
    async () => okResult(getCostReport()),
  );

  return server;
}

export async function startMcp(deps: McpDeps = {}): Promise<void> {
  const server = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
