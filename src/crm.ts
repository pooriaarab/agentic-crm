import { randomUUID } from "node:crypto";
import {
  createLogger,
  recordCost,
  type Guards,
  type Logger,
} from "agentic-core";
import { z } from "zod";

// Domain records. Three kinds: prospects (people to win), vendors
// (suppliers you buy from), leads (deals in a pipeline stage).

export const PROSPECT_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "unqualified",
] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];

export const VENDOR_STATUSES = ["active", "inactive"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export const LEAD_STAGES = [
  "new",
  "contacted",
  "proposal",
  "won",
  "lost",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export interface Prospect {
  id: string;
  name: string;
  email: string;
  company?: string;
  source?: string;
  status: ProspectStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Vendor {
  id: string;
  name: string;
  contactEmail?: string;
  category?: string;
  status: VendorStatus;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Lead {
  id: string;
  title: string;
  prospectId?: string;
  vendorId?: string;
  value?: number;
  currency?: string;
  stage: LeadStage;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

// Input shapes. The CLI, the library, and the MCP server share these,
// so one validation rule binds all three faces.

const nonEmpty = (label: string): z.ZodString =>
  z.string().trim().min(1, `${label} must not be empty`);

const optionalText = (): z.ZodOptional<z.ZodString> =>
  z.string().trim().min(1).optional();

export const prospectInputShape = {
  name: nonEmpty("name").max(200),
  email: z.string().trim().email("email must be a valid address").max(320),
  company: optionalText(),
  source: optionalText(),
  status: z.enum(PROSPECT_STATUSES).default("new"),
  notes: optionalText(),
};

export const prospectPatchShape = {
  name: nonEmpty("name").max(200).optional(),
  email: z.string().trim().email("email must be a valid address").max(320).optional(),
  company: optionalText(),
  source: optionalText(),
  status: z.enum(PROSPECT_STATUSES).optional(),
  notes: optionalText(),
};

export const vendorInputShape = {
  name: nonEmpty("name").max(200),
  contactEmail: z.string().trim().email("contactEmail must be a valid address").max(320).optional(),
  category: optionalText(),
  status: z.enum(VENDOR_STATUSES).default("active"),
  notes: optionalText(),
};

export const vendorPatchShape = {
  name: nonEmpty("name").max(200).optional(),
  contactEmail: z.string().trim().email("contactEmail must be a valid address").max(320).optional(),
  category: optionalText(),
  status: z.enum(VENDOR_STATUSES).optional(),
  notes: optionalText(),
};

export const leadInputShape = {
  title: nonEmpty("title").max(200),
  prospectId: optionalText(),
  vendorId: optionalText(),
  value: z.number().finite().min(0, "value must be 0 or more").optional(),
  currency: z.string().trim().length(3, "currency must be a 3-letter code").optional(),
  stage: z.enum(LEAD_STAGES).default("new"),
  notes: optionalText(),
};

export const leadPatchShape = {
  title: nonEmpty("title").max(200).optional(),
  prospectId: optionalText(),
  vendorId: optionalText(),
  value: z.number().finite().min(0, "value must be 0 or more").optional(),
  currency: z.string().trim().length(3, "currency must be a 3-letter code").optional(),
  stage: z.enum(LEAD_STAGES).optional(),
  notes: optionalText(),
};

export const prospectInputSchema = z.object(prospectInputShape);
export const prospectPatchSchema = z.object(prospectPatchShape);
export const vendorInputSchema = z.object(vendorInputShape);
export const vendorPatchSchema = z.object(vendorPatchShape);
export const leadInputSchema = z.object(leadInputShape);
export const leadPatchSchema = z.object(leadPatchShape);

export type ProspectInput = z.input<typeof prospectInputSchema>;
export type ProspectPatch = z.infer<typeof prospectPatchSchema>;
export type VendorInput = z.input<typeof vendorInputSchema>;
export type VendorPatch = z.infer<typeof vendorPatchSchema>;
export type LeadInput = z.input<typeof leadInputSchema>;
export type LeadPatch = z.infer<typeof leadPatchSchema>;

// Store contract. Every adapter (memory, D1) meets this shape.
// Reads return null or false when a record is missing. Writes throw
// on invalid input or on vendor failure. Nothing returns fake success.

export interface ProspectFilter {
  status?: ProspectStatus;
  query?: string;
}

export interface VendorFilter {
  status?: VendorStatus;
  query?: string;
}

export interface LeadFilter {
  stage?: LeadStage;
  prospectId?: string;
  vendorId?: string;
  query?: string;
}

export interface CrmStore {
  readonly name: string;
  init(): Promise<void>;
  addProspect(input: ProspectInput): Promise<Prospect>;
  getProspect(id: string): Promise<Prospect | null>;
  listProspects(filter?: ProspectFilter): Promise<Prospect[]>;
  updateProspect(id: string, patch: ProspectPatch): Promise<Prospect | null>;
  deleteProspect(id: string): Promise<boolean>;
  addVendor(input: VendorInput): Promise<Vendor>;
  getVendor(id: string): Promise<Vendor | null>;
  listVendors(filter?: VendorFilter): Promise<Vendor[]>;
  updateVendor(id: string, patch: VendorPatch): Promise<Vendor | null>;
  deleteVendor(id: string): Promise<boolean>;
  addLead(input: LeadInput): Promise<Lead>;
  getLead(id: string): Promise<Lead | null>;
  listLeads(filter?: LeadFilter): Promise<Lead[]>;
  updateLead(id: string, patch: LeadPatch): Promise<Lead | null>;
  moveLead(id: string, stage: LeadStage): Promise<Lead | null>;
  deleteLead(id: string): Promise<boolean>;
}

// Guarded writes. Mirrors the core dispatch path: check guards, then
// act, then count cost. Dry run validates and previews but calls no
// adapter and records no cost.

export interface CrmWriteOptions {
  guards?: Guards;
  logger?: Logger;
  dryRun?: boolean;
}

export interface CrmWriteResult<T> {
  dryRun: boolean;
  label: string;
  result?: T;
}

export async function runWrite<T>(
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
  recordCost({ kind: "write", adapter: storeName, units: 1 });
  logger.info(`wrote (${label}) via ${storeName}`);
  return { dryRun: false, label, result };
}

export function describeInput(kind: string, input: unknown): string {
  const fields = input as Record<string, unknown>;
  const head =
    typeof fields["name"] === "string"
      ? fields["name"]
      : typeof fields["title"] === "string"
        ? fields["title"]
        : typeof fields["email"] === "string"
          ? fields["email"]
          : "record";
  return `add ${kind} ${head}`.slice(0, 200);
}

// Memory store. The dry-run default: full behavior, no network, no
// key. CLI runs, MCP tools, and tests use it when no D1 config exists.

function nowIso(): string {
  return new Date().toISOString();
}

function matchesQuery(haystacks: (string | undefined)[], query: string): boolean {
  const needle = query.toLowerCase();
  return haystacks.some(
    (field) => typeof field === "string" && field.toLowerCase().includes(needle),
  );
}

export class MemoryCrmStore implements CrmStore {
  readonly name = "memory";
  private readonly prospects = new Map<string, Prospect>();
  private readonly vendors = new Map<string, Vendor>();
  private readonly leads = new Map<string, Lead>();

  async init(): Promise<void> {
    // Nothing to set up. Kept so callers treat every store alike.
  }

  async addProspect(input: ProspectInput): Promise<Prospect> {
    const parsed = prospectInputSchema.parse(input);
    const at = nowIso();
    const record: Prospect = { id: randomUUID(), ...parsed, createdAt: at, updatedAt: at };
    this.prospects.set(record.id, record);
    return { ...record };
  }

  async getProspect(id: string): Promise<Prospect | null> {
    const found = this.prospects.get(id);
    return found === undefined ? null : { ...found };
  }

  async listProspects(filter: ProspectFilter = {}): Promise<Prospect[]> {
    const rows = [...this.prospects.values()];
    return rows
      .filter((row) => filter.status === undefined || row.status === filter.status)
      .filter(
        (row) =>
          filter.query === undefined ||
          matchesQuery([row.name, row.email, row.company, row.notes], filter.query),
      )
      .map((row) => ({ ...row }));
  }

  async updateProspect(id: string, patch: ProspectPatch): Promise<Prospect | null> {
    const current = this.prospects.get(id);
    if (current === undefined) return null;
    const parsed = prospectPatchSchema.parse(patch);
    const next: Prospect = { ...current, ...parsed, updatedAt: nowIso() };
    this.prospects.set(id, next);
    return { ...next };
  }

  async deleteProspect(id: string): Promise<boolean> {
    return this.prospects.delete(id);
  }

  async addVendor(input: VendorInput): Promise<Vendor> {
    const parsed = vendorInputSchema.parse(input);
    const at = nowIso();
    const record: Vendor = { id: randomUUID(), ...parsed, createdAt: at, updatedAt: at };
    this.vendors.set(record.id, record);
    return { ...record };
  }

  async getVendor(id: string): Promise<Vendor | null> {
    const found = this.vendors.get(id);
    return found === undefined ? null : { ...found };
  }

  async listVendors(filter: VendorFilter = {}): Promise<Vendor[]> {
    const rows = [...this.vendors.values()];
    return rows
      .filter((row) => filter.status === undefined || row.status === filter.status)
      .filter(
        (row) =>
          filter.query === undefined ||
          matchesQuery([row.name, row.contactEmail, row.category, row.notes], filter.query),
      )
      .map((row) => ({ ...row }));
  }

  async updateVendor(id: string, patch: VendorPatch): Promise<Vendor | null> {
    const current = this.vendors.get(id);
    if (current === undefined) return null;
    const parsed = vendorPatchSchema.parse(patch);
    const next: Vendor = { ...current, ...parsed, updatedAt: nowIso() };
    this.vendors.set(id, next);
    return { ...next };
  }

  async deleteVendor(id: string): Promise<boolean> {
    return this.vendors.delete(id);
  }

  async addLead(input: LeadInput): Promise<Lead> {
    const parsed = leadInputSchema.parse(input);
    const at = nowIso();
    const record: Lead = { id: randomUUID(), ...parsed, createdAt: at, updatedAt: at };
    this.leads.set(record.id, record);
    return { ...record };
  }

  async getLead(id: string): Promise<Lead | null> {
    const found = this.leads.get(id);
    return found === undefined ? null : { ...found };
  }

  async listLeads(filter: LeadFilter = {}): Promise<Lead[]> {
    const rows = [...this.leads.values()];
    return rows
      .filter((row) => filter.stage === undefined || row.stage === filter.stage)
      .filter((row) => filter.prospectId === undefined || row.prospectId === filter.prospectId)
      .filter((row) => filter.vendorId === undefined || row.vendorId === filter.vendorId)
      .filter(
        (row) =>
          filter.query === undefined ||
          matchesQuery([row.title, row.notes], filter.query),
      )
      .map((row) => ({ ...row }));
  }

  async updateLead(id: string, patch: LeadPatch): Promise<Lead | null> {
    const current = this.leads.get(id);
    if (current === undefined) return null;
    const parsed = leadPatchSchema.parse(patch);
    const next: Lead = { ...current, ...parsed, updatedAt: nowIso() };
    this.leads.set(id, next);
    return { ...next };
  }

  async moveLead(id: string, stage: LeadStage): Promise<Lead | null> {
    return this.updateLead(id, { stage });
  }

  async deleteLead(id: string): Promise<boolean> {
    return this.leads.delete(id);
  }
}
