#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
  CALL_STATUSES,
  CALL_VENDORS,
  MemoryCallStore,
  describeCallInput,
  runCallWrite,
  type CallFilter,
  type CallInput,
  type CallPatch,
  type CallStore,
} from "./calls.js";
import {
  describeInput,
  LEAD_STAGES,
  MemoryCrmStore,
  PROSPECT_STATUSES,
  runWrite,
  VENDOR_STATUSES,
  type CrmStore,
  type CrmWriteOptions,
  type LeadInput,
  type LeadPatch,
  type ProspectInput,
  type ProspectPatch,
  type VendorInput,
  type VendorPatch,
} from "./crm.js";
import { createD1CallStore, createD1Store } from "./d1.js";
import { DEFAULT_BRAND } from "./index.js";
import { VERSION } from "./version.js";

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export type CliCommand =
  | "add-prospect"
  | "get-prospect"
  | "list-prospects"
  | "update-prospect"
  | "delete-prospect"
  | "add-vendor"
  | "get-vendor"
  | "list-vendors"
  | "update-vendor"
  | "delete-vendor"
  | "add-lead"
  | "get-lead"
  | "list-leads"
  | "update-lead"
  | "move-lead"
  | "delete-lead"
  | "request-call"
  | "get-call"
  | "list-calls"
  | "attach-transcript"
  | "costs"
  | "mcp"
  | "help"
  | "version";

const COMMANDS: CliCommand[] = [
  "add-prospect",
  "get-prospect",
  "list-prospects",
  "update-prospect",
  "delete-prospect",
  "add-vendor",
  "get-vendor",
  "list-vendors",
  "update-vendor",
  "delete-vendor",
  "add-lead",
  "get-lead",
  "list-leads",
  "update-lead",
  "move-lead",
  "delete-lead",
  "request-call",
  "get-call",
  "list-calls",
  "attach-transcript",
  "costs",
  "mcp",
  "help",
  "version",
];

interface CommandSpec {
  needs: string[];
  allows: string[];
}

const GLOBAL_FLAGS = ["store"];

const SPECS: Record<string, CommandSpec> = {
  "add-prospect": {
    needs: ["name", "email"],
    allows: ["name", "email", "company", "source", "status", "notes"],
  },
  "get-prospect": { needs: ["id"], allows: ["id"] },
  "list-prospects": { needs: [], allows: ["status", "query"] },
  "update-prospect": {
    needs: ["id"],
    allows: ["id", "name", "email", "company", "source", "status", "notes"],
  },
  "delete-prospect": { needs: ["id"], allows: ["id"] },
  "add-vendor": {
    needs: ["name"],
    allows: ["name", "contact-email", "category", "status", "notes"],
  },
  "get-vendor": { needs: ["id"], allows: ["id"] },
  "list-vendors": { needs: [], allows: ["status", "query"] },
  "update-vendor": {
    needs: ["id"],
    allows: ["id", "name", "contact-email", "category", "status", "notes"],
  },
  "delete-vendor": { needs: ["id"], allows: ["id"] },
  "add-lead": {
    needs: ["title"],
    allows: ["title", "prospect", "vendor", "value", "currency", "stage", "notes"],
  },
  "get-lead": { needs: ["id"], allows: ["id"] },
  "list-leads": { needs: [], allows: ["stage", "prospect", "vendor", "query"] },
  "update-lead": {
    needs: ["id"],
    allows: ["id", "title", "prospect", "vendor", "value", "currency", "stage", "notes"],
  },
  "move-lead": { needs: ["id", "stage"], allows: ["id", "stage"] },
  "delete-lead": { needs: ["id"], allows: ["id"] },
  "request-call": {
    needs: ["vendor", "to"],
    allows: ["vendor", "to", "prospect", "lead", "status", "barge-in", "transcript-ref", "audio-ref"],
  },
  "get-call": { needs: ["id"], allows: ["id"] },
  "list-calls": { needs: [], allows: ["vendor", "status", "prospect", "lead"] },
  "attach-transcript": {
    needs: ["id", "transcript-ref"],
    allows: ["id", "transcript-ref", "audio-ref"],
  },
  costs: { needs: [], allows: [] },
  mcp: { needs: [], allows: [] },
  help: { needs: [], allows: [] },
  version: { needs: [], allows: [] },
};

export interface CliRequest {
  command: CliCommand;
  flags: Record<string, string>;
  dryRun: boolean;
}

export function parseArgs(argv: string[]): CliRequest {
  const request: CliRequest = { command: "help", flags: {}, dryRun: false };
  const args = [...argv];
  const first = args.shift();
  if (first === undefined || first === "--help" || first === "-h") {
    return request;
  }
  if (first === "--version" || first === "-V") {
    request.command = "version";
    return request;
  }
  if (!(COMMANDS as string[]).includes(first)) {
    throw new UsageError(`unknown command "${first}"`);
  }
  request.command = first as CliCommand;
  const spec = SPECS[request.command] ?? { needs: [], allows: [] };
  const allowed = new Set([...spec.allows, ...GLOBAL_FLAGS]);
  while (args.length > 0) {
    const flag = args.shift() as string;
    if (flag === "--dry-run") {
      request.dryRun = true;
      continue;
    }
    if (!flag.startsWith("--")) {
      throw new UsageError(`expected a flag, got "${flag}"`);
    }
    const key = flag.slice(2);
    if (!allowed.has(key)) {
      throw new UsageError(`unknown flag "${flag}" for "${request.command}"`);
    }
    const value = args.shift();
    if (value === undefined) {
      throw new UsageError(`flag "${flag}" needs a value`);
    }
    request.flags[key] = value;
  }
  for (const key of spec.needs) {
    if (request.flags[key] === undefined) {
      throw new UsageError(`${request.command} needs --${key}`);
    }
  }
  const store = request.flags["store"];
  if (store !== undefined && store !== "memory" && store !== "d1") {
    throw new UsageError(`--store must be "memory" or "d1", got "${store}"`);
  }
  return request;
}

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  store?: CrmStore;
  callStore?: CallStore;
  env?: Record<string, string | undefined>;
  guards?: Guards;
  logger?: Logger;
}

function defaultIo(): CliIo {
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

function helpText(): string {
  const command = DEFAULT_BRAND.command;
  return [
    `${DEFAULT_BRAND.name} ${VERSION}`,
    `${DEFAULT_BRAND.description}`,
    "",
    `Usage: ${command} <command> [flags]`,
    "",
    "Prospects:",
    "  add-prospect --name <n> --email <e> [--company <c>] [--source <s>] [--status <t>] [--notes <n>]",
    "  get-prospect --id <id>",
    "  list-prospects [--status <t>] [--query <q>]",
    "  update-prospect --id <id> [--name <n>] [--email <e>] [--company <c>] [--source <s>] [--status <t>] [--notes <n>]",
    "  delete-prospect --id <id>",
    "",
    "Vendors:",
    "  add-vendor --name <n> [--contact-email <e>] [--category <c>] [--status <t>] [--notes <n>]",
    "  get-vendor --id <id>",
    "  list-vendors [--status <t>] [--query <q>]",
    "  update-vendor --id <id> [--name <n>] [--contact-email <e>] [--category <c>] [--status <t>] [--notes <n>]",
    "  delete-vendor --id <id>",
    "",
    "Calls:",
    "  request-call --vendor <dry|bland|telnyx|vapi> --to <E.164> [--prospect <id>] [--lead <id>] [--status <s>] [--barge-in true|false] [--transcript-ref <r>] [--audio-ref <r>]",
    "  get-call --id <id>",
    "  list-calls [--vendor <v>] [--status <s>] [--prospect <id>] [--lead <id>]",
    "  attach-transcript --id <id> --transcript-ref <r> [--audio-ref <r>]",
    "",
    "Leads:",
    "  add-lead --title <t> [--prospect <id>] [--vendor <id>] [--value <n>] [--currency <c>] [--stage <s>] [--notes <n>]",
    "  get-lead --id <id>",
    "  list-leads [--stage <s>] [--prospect <id>] [--vendor <id>] [--query <q>]",
    "  update-lead --id <id> [--title <t>] [--prospect <id>] [--vendor <id>] [--value <n>] [--currency <c>] [--stage <s>] [--notes <n>]",
    "  move-lead --id <id> --stage <s>",
    "  delete-lead --id <id>",
    "",
    "Meta:",
    "  costs                    Print the cost report as JSON.",
    "  mcp [--store <s>]        Start the MCP server on stdio.",
    "",
    "Flags:",
    '  --dry-run      Preview a write without touching the store. Works on add/update/move/delete.',
    '  --store <s>    "memory" (default, no keys) or "d1" (needs Cloudflare env vars).',
    "  --help, -h     Print this help.",
    "  --version, -V  Print the version.",
    "",
    `Statuses: prospects ${PROSPECT_STATUSES.join("/")}; vendors ${VENDOR_STATUSES.join("/")}; lead stages ${LEAD_STAGES.join("/")}; call vendors ${CALL_VENDORS.join("/")}; call statuses ${CALL_STATUSES.join("/")}.`,
  ].join("\n");
}

function zodMessage(error: ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  });
  return `invalid input: ${parts.join("; ")}`;
}

function optionalFlag(flags: Record<string, string>, key: string): string | undefined {
  const value = flags[key];
  return value === undefined || value.length === 0 ? undefined : value;
}

function numberFlag(flags: Record<string, string>, key: string): number | undefined {
  const raw = optionalFlag(flags, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new UsageError(`--${key} needs a number, got "${raw}"`);
  }
  return value;
}

function buildProspectInput(flags: Record<string, string>): ProspectInput {
  return {
    name: flags["name"] as string,
    email: flags["email"] as string,
    company: optionalFlag(flags, "company"),
    source: optionalFlag(flags, "source"),
    status: optionalFlag(flags, "status") as ProspectInput["status"],
    notes: optionalFlag(flags, "notes"),
  };
}

function buildProspectPatch(flags: Record<string, string>): ProspectPatch {
  return {
    name: optionalFlag(flags, "name"),
    email: optionalFlag(flags, "email"),
    company: optionalFlag(flags, "company"),
    source: optionalFlag(flags, "source"),
    status: optionalFlag(flags, "status") as ProspectPatch["status"],
    notes: optionalFlag(flags, "notes"),
  };
}

function buildVendorInput(flags: Record<string, string>): VendorInput {
  return {
    name: flags["name"] as string,
    contactEmail: optionalFlag(flags, "contact-email"),
    category: optionalFlag(flags, "category"),
    status: optionalFlag(flags, "status") as VendorInput["status"],
    notes: optionalFlag(flags, "notes"),
  };
}

function buildVendorPatch(flags: Record<string, string>): VendorPatch {
  return {
    name: optionalFlag(flags, "name"),
    contactEmail: optionalFlag(flags, "contact-email"),
    category: optionalFlag(flags, "category"),
    status: optionalFlag(flags, "status") as VendorPatch["status"],
    notes: optionalFlag(flags, "notes"),
  };
}

function buildLeadInput(flags: Record<string, string>): LeadInput {
  return {
    title: flags["title"] as string,
    prospectId: optionalFlag(flags, "prospect"),
    vendorId: optionalFlag(flags, "vendor"),
    value: numberFlag(flags, "value"),
    currency: optionalFlag(flags, "currency"),
    stage: optionalFlag(flags, "stage") as LeadInput["stage"],
    notes: optionalFlag(flags, "notes"),
  };
}

function buildLeadPatch(flags: Record<string, string>): LeadPatch {
  return {
    title: optionalFlag(flags, "title"),
    prospectId: optionalFlag(flags, "prospect"),
    vendorId: optionalFlag(flags, "vendor"),
    value: numberFlag(flags, "value"),
    currency: optionalFlag(flags, "currency"),
    stage: optionalFlag(flags, "stage") as LeadPatch["stage"],
    notes: optionalFlag(flags, "notes"),
  };
}

function boolFlag(flags: Record<string, string>, key: string): boolean | undefined {
  const raw = optionalFlag(flags, key);
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new UsageError(`--${key} needs "true" or "false", got "${raw}"`);
}

function buildCallInput(flags: Record<string, string>): CallInput {
  return {
    prospectId: optionalFlag(flags, "prospect"),
    leadId: optionalFlag(flags, "lead"),
    vendor: flags["vendor"] as CallInput["vendor"],
    to: flags["to"] as string,
    status: optionalFlag(flags, "status") as CallInput["status"],
    transcriptRef: optionalFlag(flags, "transcript-ref"),
    audioRef: optionalFlag(flags, "audio-ref"),
    bargeIn: boolFlag(flags, "barge-in"),
  };
}

function buildCallPatch(flags: Record<string, string>): CallPatch {
  return {
    transcriptRef: optionalFlag(flags, "transcript-ref"),
    audioRef: optionalFlag(flags, "audio-ref"),
  };
}

function buildCallFilter(flags: Record<string, string>): CallFilter {
  return {
    vendor: optionalFlag(flags, "vendor") as CallFilter["vendor"],
    status: optionalFlag(flags, "status") as CallFilter["status"],
    prospectId: optionalFlag(flags, "prospect"),
    leadId: optionalFlag(flags, "lead"),
  };
}

function buildStore(request: CliRequest, io: CliIo): CrmStore {
  if (io.store !== undefined) return io.store;
  const name = request.flags["store"] ?? "memory";
  if (name === "d1") {
    return createD1Store(io.env ?? process.env);
  }
  return new MemoryCrmStore();
}

function buildCallStore(request: CliRequest, io: CliIo): CallStore {
  if (io.callStore !== undefined) return io.callStore;
  const name = request.flags["store"] ?? "memory";
  if (name === "d1") {
    return createD1CallStore(io.env ?? process.env);
  }
  return new MemoryCallStore();
}

function writeOptions(request: CliRequest, io: CliIo): CrmWriteOptions {
  return {
    guards: io.guards,
    logger: io.logger ?? createLogger({ quiet: true }),
    dryRun: request.dryRun,
  };
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  let request: CliRequest;
  try {
    request = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(`Run "${DEFAULT_BRAND.command} --help" for usage.`);
    return 2;
  }
  try {
    switch (request.command) {
      case "help":
        io.out(helpText());
        return 0;
      case "version":
        io.out(VERSION);
        return 0;
      case "costs":
        io.out(JSON.stringify(getCostReport()));
        return 0;
      case "mcp": {
        const store = buildStore(request, io);
        await store.init();
        const callStore = buildCallStore(request, io);
        await callStore.init();
        const { startMcp } = await import("./mcp.js");
        await startMcp({ store, callStore, guards: io.guards, logger: io.logger });
        return 0;
      }
    }
    const store = buildStore(request, io);
    await store.init();
    const callStore = buildCallStore(request, io);
    await callStore.init();
    const options = writeOptions(request, io);
    const flags = request.flags;

    switch (request.command) {
      case "add-prospect": {
        const input = buildProspectInput(flags);
        const written = await runWrite(store.name, describeInput("prospect", input), options, () =>
          store.addProspect(input),
        );
        io.out(JSON.stringify(written));
        return 0;
      }
      case "get-prospect": {
        const found = await store.getProspect(flags["id"] as string);
        if (found === null) {
          io.err(`no prospect with id "${flags["id"]}"`);
          return 1;
        }
        io.out(JSON.stringify(found));
        return 0;
      }
      case "list-prospects": {
        const status = optionalFlag(flags, "status");
        if (status !== undefined) z.object({ status: z.enum(PROSPECT_STATUSES) }).parse({ status });
        const rows = await store.listProspects({
          status: status as ProspectInput["status"],
          query: optionalFlag(flags, "query"),
        });
        io.out(JSON.stringify(rows));
        return 0;
      }
      case "update-prospect": {
        const id = flags["id"] as string;
        const patch = buildProspectPatch(flags);
        const written = await runWrite(store.name, `update prospect ${id}`, options, () =>
          store.updateProspect(id, patch),
        );
        if (!written.dryRun && written.result === null) {
          io.err(`no prospect with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
      case "delete-prospect": {
        const id = flags["id"] as string;
        const written = await runWrite(store.name, `delete prospect ${id}`, options, () =>
          store.deleteProspect(id),
        );
        if (!written.dryRun && written.result === false) {
          io.err(`no prospect with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
      case "add-vendor": {
        const input = buildVendorInput(flags);
        const written = await runWrite(store.name, describeInput("vendor", input), options, () =>
          store.addVendor(input),
        );
        io.out(JSON.stringify(written));
        return 0;
      }
      case "get-vendor": {
        const found = await store.getVendor(flags["id"] as string);
        if (found === null) {
          io.err(`no vendor with id "${flags["id"]}"`);
          return 1;
        }
        io.out(JSON.stringify(found));
        return 0;
      }
      case "list-vendors": {
        const status = optionalFlag(flags, "status");
        if (status !== undefined) z.object({ status: z.enum(VENDOR_STATUSES) }).parse({ status });
        const rows = await store.listVendors({
          status: status as VendorInput["status"],
          query: optionalFlag(flags, "query"),
        });
        io.out(JSON.stringify(rows));
        return 0;
      }
      case "update-vendor": {
        const id = flags["id"] as string;
        const patch = buildVendorPatch(flags);
        const written = await runWrite(store.name, `update vendor ${id}`, options, () =>
          store.updateVendor(id, patch),
        );
        if (!written.dryRun && written.result === null) {
          io.err(`no vendor with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
      case "delete-vendor": {
        const id = flags["id"] as string;
        const written = await runWrite(store.name, `delete vendor ${id}`, options, () =>
          store.deleteVendor(id),
        );
        if (!written.dryRun && written.result === false) {
          io.err(`no vendor with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
      case "add-lead": {
        const input = buildLeadInput(flags);
        const written = await runWrite(store.name, describeInput("lead", input), options, () =>
          store.addLead(input),
        );
        io.out(JSON.stringify(written));
        return 0;
      }
      case "get-lead": {
        const found = await store.getLead(flags["id"] as string);
        if (found === null) {
          io.err(`no lead with id "${flags["id"]}"`);
          return 1;
        }
        io.out(JSON.stringify(found));
        return 0;
      }
      case "list-leads": {
        const stage = optionalFlag(flags, "stage");
        if (stage !== undefined) z.object({ stage: z.enum(LEAD_STAGES) }).parse({ stage });
        const rows = await store.listLeads({
          stage: stage as LeadInput["stage"],
          prospectId: optionalFlag(flags, "prospect"),
          vendorId: optionalFlag(flags, "vendor"),
          query: optionalFlag(flags, "query"),
        });
        io.out(JSON.stringify(rows));
        return 0;
      }
      case "update-lead": {
        const id = flags["id"] as string;
        const patch = buildLeadPatch(flags);
        const written = await runWrite(store.name, `update lead ${id}`, options, () =>
          store.updateLead(id, patch),
        );
        if (!written.dryRun && written.result === null) {
          io.err(`no lead with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
      case "move-lead": {
        const id = flags["id"] as string;
        const stage = z.object({ stage: z.enum(LEAD_STAGES) }).parse({ stage: flags["stage"] }).stage;
        const written = await runWrite(store.name, `move lead ${id} to ${stage}`, options, () =>
          store.moveLead(id, stage),
        );
        if (!written.dryRun && written.result === null) {
          io.err(`no lead with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
      case "delete-lead": {
        const id = flags["id"] as string;
        const written = await runWrite(store.name, `delete lead ${id}`, options, () =>
          store.deleteLead(id),
        );
        if (!written.dryRun && written.result === false) {
          io.err(`no lead with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
      case "request-call": {
        const input = buildCallInput(flags);
        const written = await runCallWrite(
          callStore.name,
          describeCallInput(input),
          options,
          () => callStore.requestCall(input),
        );
        io.out(JSON.stringify(written));
        return 0;
      }
      case "get-call": {
        const found = await callStore.getCall(flags["id"] as string);
        if (found === null) {
          io.err(`no call with id "${flags["id"]}"`);
          return 1;
        }
        io.out(JSON.stringify(found));
        return 0;
      }
      case "list-calls": {
        const filter = buildCallFilter(flags);
        if (filter.vendor !== undefined) {
          z.object({ vendor: z.enum(CALL_VENDORS) }).parse({ vendor: filter.vendor });
        }
        if (filter.status !== undefined) {
          z.object({ status: z.enum(CALL_STATUSES) }).parse({ status: filter.status });
        }
        const rows = await callStore.listCalls(filter);
        io.out(JSON.stringify(rows));
        return 0;
      }
      case "attach-transcript": {
        const id = flags["id"] as string;
        const patch = buildCallPatch(flags);
        const written = await runCallWrite(
          callStore.name,
          `attach transcript to call ${id}`,
          options,
          () => callStore.attachTranscript(id, patch),
        );
        if (!written.dryRun && written.result === null) {
          io.err(`no call with id "${id}"`);
          return 1;
        }
        io.out(JSON.stringify(written));
        return 0;
      }
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message);
      io.err(`Run "${DEFAULT_BRAND.command} --help" for usage.`);
      return 2;
    }
    if (error instanceof ZodError) {
      io.err(zodMessage(error));
      return 1;
    }
    if (error instanceof GuardError || error instanceof VendorError) {
      io.err(`${error.name}: ${error.message}`);
      return 1;
    }
    if (error instanceof Error) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (typeof invoked !== "string") return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      // Exit nonzero at once. On zero, fall off the end so a running
      // server (mcp) keeps its stdio handles open. Plain commands
      // hold no handles and exit 0 on their own.
      if (code !== 0) process.exit(code);
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
