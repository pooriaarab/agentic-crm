import { randomUUID } from "node:crypto";
import {
  createLogger,
  recordCost,
  type Guards,
  type Logger,
} from "agentic-core";
import { z } from "zod";
import type { CrmWriteOptions, CrmWriteResult } from "./crm.js";

// Call records. A voice call sits next to a prospect or a lead and
// keeps one reference to where the transcript lives and one to the
// audio. The vendor is the agentic-phone channel that placed the
// call; the status is the call's own lifecycle. Live dispatch stays
// in agentic-phone; this pack only records intent and outcomes.

export const CALL_VENDORS = ["dry", "bland", "telnyx", "vapi"] as const;
export type CallVendor = (typeof CALL_VENDORS)[number];

export const CALL_STATUSES = ["requested", "active", "done", "failed"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

// E.164: +, then a non-zero country code digit, then 1-14 more
// digits. Keeps destinations honest at the schema edge.
const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

export interface Call {
  id: string;
  prospectId?: string;
  leadId?: string;
  vendor: CallVendor;
  to: string;
  status: CallStatus;
  transcriptRef?: string;
  audioRef?: string;
  bargeIn: boolean;
  createdAt: string;
  updatedAt: string;
}

// Input shapes. One validation rule binds the CLI, the library, and
// the MCP server, mirroring the prospect/vendor/lead inputs.

const nonEmpty = (label: string): z.ZodString =>
  z.string().trim().min(1, `${label} must not be empty`);

const optionalText = (): z.ZodOptional<z.ZodString> =>
  z.string().trim().min(1).optional();

export const callInputShape = {
  prospectId: optionalText(),
  leadId: optionalText(),
  vendor: z.enum(CALL_VENDORS, {
    errorMap: () => ({ message: `vendor must be one of ${CALL_VENDORS.join("/")}` }),
  }),
  to: z
    .string()
    .trim()
    .regex(E164_PATTERN, "to must be an E.164 phone number like +14155550132"),
  status: z.enum(CALL_STATUSES).default("requested"),
  transcriptRef: optionalText(),
  audioRef: optionalText(),
  bargeIn: z.boolean().default(false),
};

export const callPatchShape = {
  transcriptRef: nonEmpty("transcriptRef").optional(),
  audioRef: nonEmpty("audioRef").optional(),
  status: z.enum(CALL_STATUSES).optional(),
};

export const callInputSchema = z
  .object(callInputShape)
  .superRefine((value, ctx) => {
    if (value.prospectId === undefined && value.leadId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["prospectId"],
        message: "a call needs a prospectId or a leadId",
      });
    }
  });
export const callPatchSchema = z.object(callPatchShape).superRefine((value, ctx) => {
  if (
    value.transcriptRef === undefined &&
    value.audioRef === undefined &&
    value.status === undefined
  ) {
    ctx.addIssue({
      code: "custom",
      message: "a patch needs a transcriptRef, an audioRef, or a status",
    });
  }
});

export type CallInput = z.input<typeof callInputSchema>;
export type CallPatch = z.infer<typeof callPatchSchema>;

// Store contract. Every adapter (memory, D1) meets this shape.
// Reads return null when a record is missing. Writes throw on
// invalid input or on vendor failure.

export interface CallFilter {
  vendor?: CallVendor;
  status?: CallStatus;
  prospectId?: string;
  leadId?: string;
}

export interface CallStore {
  readonly name: string;
  init(): Promise<void>;
  requestCall(input: CallInput): Promise<Call>;
  getCall(id: string): Promise<Call | null>;
  listCalls(filter?: CallFilter): Promise<Call[]>;
  attachTranscript(id: string, patch: CallPatch): Promise<Call | null>;
}

// Cost accounting. Recording a call costs on the (vendor, subject)
// pair, so the cost report holds one entry per lead per channel and
// can be reconciled against vendor billing. A write that produced no
// call record (missing id, dry run, denied guard) costs nothing.

export function callCostAdapter(call: Call): string {
  const subject = call.leadId ?? call.prospectId ?? "unlinked";
  return `${call.vendor}:${subject}`;
}

export async function runCallWrite<T>(
  storeName: string,
  label: string,
  options: CrmWriteOptions,
  act: () => Promise<T>,
): Promise<CrmWriteResult<T>> {
  const logger = options.logger ?? createLogger({ quiet: true });
  options.guards?.checkDispatch(label);
  if (options.dryRun === true) {
    logger.info(`dry run: would write (${label})`);
    return { dryRun: true, label };
  }
  const result = await act();
  options.guards?.recordDispatch();
  const call = asCall(result);
  if (call !== null) {
    recordCost({ kind: "call", adapter: callCostAdapter(call), units: 1 });
  }
  logger.info(`wrote (${label}) via ${storeName}`);
  return { dryRun: false, label, result };
}

function asCall(value: unknown): Call | null {
  if (typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "object" && first !== null && "vendor" in first
      ? (first as Call)
      : null;
  }
  return "vendor" in value ? (value as Call) : null;
}

export function describeCallInput(input: CallInput): string {
  const subject =
    input.leadId !== undefined
      ? `lead ${input.leadId}`
      : input.prospectId !== undefined
        ? `prospect ${input.prospectId}`
        : "call";
  return `request ${input.vendor} call to ${input.to} for ${subject}`.slice(0, 200);
}

// Memory store. The dry-run default: full behavior, no network, no
// key. CLI runs, MCP tools, and tests use it when no D1 config exists.

function nowIso(): string {
  return new Date().toISOString();
}

export class MemoryCallStore implements CallStore {
  readonly name = "memory";
  private readonly calls = new Map<string, Call>();

  async init(): Promise<void> {
    // Nothing to set up. Kept so callers treat every store alike.
  }

  async requestCall(input: CallInput): Promise<Call> {
    const parsed = callInputSchema.parse(input);
    const at = nowIso();
    const record: Call = { id: randomUUID(), ...parsed, createdAt: at, updatedAt: at };
    this.calls.set(record.id, record);
    return { ...record };
  }

  async getCall(id: string): Promise<Call | null> {
    const found = this.calls.get(id);
    return found === undefined ? null : { ...found };
  }

  async listCalls(filter: CallFilter = {}): Promise<Call[]> {
    const rows = [...this.calls.values()];
    return rows
      .filter((row) => filter.vendor === undefined || row.vendor === filter.vendor)
      .filter((row) => filter.status === undefined || row.status === filter.status)
      .filter((row) => filter.prospectId === undefined || row.prospectId === filter.prospectId)
      .filter((row) => filter.leadId === undefined || row.leadId === filter.leadId)
      .map((row) => ({ ...row }));
  }

  async attachTranscript(id: string, patch: CallPatch): Promise<Call | null> {
    const current = this.calls.get(id);
    if (current === undefined) return null;
    const parsed = callPatchSchema.parse(patch);
    const next: Call = { ...current, ...parsed, updatedAt: nowIso() };
    this.calls.set(id, next);
    return { ...next };
  }
}