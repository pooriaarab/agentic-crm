export { VERSION } from "./version.js";

// Core. The pack builds on the frozen agentic core and re-exports
// the pieces that callers need next to the CRM API.
export {
  defineBrand,
  createLogger,
  GuardError,
  VendorError,
  createGuards,
  recordCost,
  getCostReport,
  resetCosts,
} from "agentic-core";
export type {
  BrandConfig,
  LogLevel,
  Logger,
  LoggerOptions,
  GuardsConfig,
  Guards,
  CostEntry,
  CostReport,
} from "agentic-core";

// CRM domain: records, validation, the store contract, the memory
// store, and the guarded write path.
export {
  PROSPECT_STATUSES,
  VENDOR_STATUSES,
  LEAD_STAGES,
  prospectInputSchema,
  prospectPatchSchema,
  vendorInputSchema,
  vendorPatchSchema,
  leadInputSchema,
  leadPatchSchema,
  prospectInputShape,
  prospectPatchShape,
  vendorInputShape,
  vendorPatchShape,
  leadInputShape,
  leadPatchShape,
  MemoryCrmStore,
  runWrite,
  describeInput,
} from "./crm.js";
export type {
  ProspectStatus,
  VendorStatus,
  LeadStage,
  Prospect,
  Vendor,
  Lead,
  ProspectInput,
  ProspectPatch,
  VendorInput,
  VendorPatch,
  LeadInput,
  LeadPatch,
  ProspectFilter,
  VendorFilter,
  LeadFilter,
  CrmStore,
  CrmWriteOptions,
  CrmWriteResult,
} from "./crm.js";

// D1 adapter: REST client, SQL runners, the SQL store, env wiring.
export {
  SCHEMA_STATEMENTS,
  D1RestClient,
  RestSqlRunner,
  BindingSqlRunner,
  SqlCrmStore,
  readD1Env,
  createD1Store,
} from "./d1.js";
export type {
  D1RestOptions,
  SqlRunner,
  D1Binding,
  D1BindingStatement,
  VendorMirror,
  D1EnvConfig,
} from "./d1.js";

// KV adapter: REST client, the vendor mirror, the binding mirror.
export {
  VENDOR_KEY_PREFIX,
  vendorKey,
  KvRestClient,
  KvVendorMirror,
  KvBindingMirror,
} from "./kv.js";
export type { KvRestOptions, KvBinding } from "./kv.js";

import { defineBrand, type BrandConfig } from "agentic-core";
import { VERSION } from "./version.js";

export const DEFAULT_BRAND: BrandConfig = defineBrand({
  name: "Agentic CRM",
  command: "agentic-crm",
  description: "Small CRM for prospects, vendors, and leads on Cloudflare D1 and KV.",
  keywords: ["crm", "contacts", "pipeline", "agentic-suite", "claude-code", "codex", "cli", "mcp"],
  version: VERSION,
});
