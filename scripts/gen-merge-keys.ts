/**
 * Generates the merge-key catalog from the database schema.
 *
 * Templates must be able to reference *every* field, so the catalog is derived
 * from src/integrations/supabase/types.ts rather than hand-listed: add a
 * column, re-run this, and the key exists. Run with:
 *
 *   bun scripts/gen-merge-keys.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

// Normalised to LF because the block scanning below matches on "\n" and a
// Windows checkout hands us CRLF — on which every table lookup missed.
const types = readFileSync("src/integrations/supabase/types.ts", "utf8").replace(/\r\n/g, "\n");

type GroupCfg = {
  id: string;
  label: string;
  /** Which loaded record the values come from. */
  source: string;
  table: string;
  /** Key prefix, e.g. "Account" → {Account.Name}. */
  prefix: string;
  /** Restrict to these columns (in order); otherwise every safe column. */
  only?: (c: string) => boolean;
  /** Column → key suffix overrides. */
  rename?: Record<string, string>;
  /**
   * Column → format overrides, for the columns the name heuristic reads wrong.
   * `received_at` is a plain date, and printing it as a datetime shifts a
   * late-afternoon cheque onto the wrong day for anyone west of Greenwich.
   */
  fmt?: Record<string, Fmt>;
};

const GROUPS: GroupCfg[] = [
  {
    id: "account",
    label: "Account",
    source: "account",
    table: "accounts",
    prefix: "Account",
    rename: {
      account_type: "Type",
      account_type_detail: "TypeDetail",
      address_line1: "AddressLine1",
    },
  },
  {
    id: "job",
    label: "Job",
    source: "job",
    table: "jobs",
    prefix: "Job",
    rename: {
      address: "SiteAddress.Address1",
      address_line2: "SiteAddress.Address2",
      locality: "SiteAddress.City",
      region: "SiteAddress.State",
      postal_code: "SiteAddress.Zip",
    },
  },
  {
    id: "customer",
    label: "Customer",
    source: "job",
    table: "jobs",
    prefix: "Customer",
    only: (c) => c.startsWith("customer_") || c === "cash_payer_name",
    rename: { customer_name: "Name", customer_kind: "Kind", cash_payer_name: "CashPayerName" },
  },
  {
    id: "insurance",
    label: "Insurance",
    source: "job",
    table: "jobs",
    prefix: "Insurance",
    only: (c) =>
      c.startsWith("insurance_") ||
      ["claim_number", "policy_number", "deductible", "third_party_company"].includes(c),
    rename: {
      insurance_carrier: "Carrier",
      insurance_agency: "Agency",
      insurance_kind: "Kind",
      insurance_kind_detail: "KindDetail",
      insurance_agent_name: "AgentName",
      insurance_agent_email: "AgentEmail",
      insurance_agent_phone: "AgentPhone",
    },
  },
  {
    id: "adjuster",
    label: "Adjuster",
    source: "job",
    table: "jobs",
    prefix: "Adjuster",
    only: (c) => c.includes("adjuster") || c.includes("independent_reviewer"),
  },
  {
    id: "referral",
    label: "Referral",
    source: "job",
    table: "jobs",
    prefix: "Referral",
    only: (c) =>
      c.startsWith("referral_") || c.startsWith("referred_by") || c.startsWith("reported_source"),
  },
  {
    id: "contact",
    label: "Contact",
    source: "contact",
    table: "contacts",
    prefix: "Contact",
    rename: { full_name: "FullName" },
  },
  {
    id: "office",
    label: "Location / Office",
    source: "location",
    table: "locations",
    prefix: "Office",
    rename: {
      name: "Name",
      legal_entity_name: "LegalEntityName",
      card_payment_url: "PaymentLink",
      zelle_email: "ZelleEmail",
      ein: "EIN",
    },
  },
  {
    id: "invoice",
    label: "Invoice",
    source: "invoice",
    table: "invoices",
    prefix: "Invoice",
    rename: { invoice_number: "Number", billed_amount: "Billed", collected_amount: "Collected" },
  },
  { id: "estimate", label: "Estimate", source: "estimate", table: "estimates", prefix: "Estimate" },
  {
    id: "task",
    label: "Task",
    source: "task",
    table: "tasks",
    prefix: "Task",
    rename: { title: "Title", due_date: "DueDate" },
  },
  {
    id: "note",
    label: "Note",
    source: "note",
    table: "job_notes",
    prefix: "Note",
    rename: { body: "Body" },
  },
  {
    id: "payment",
    label: "Payment",
    source: "payment",
    table: "invoice_payments",
    prefix: "Payment",
    rename: {
      amount: "Amount",
      received_at: "ReceivedDate",
      method: "Method",
      reference: "Reference",
      notes: "Notes",
    },
    fmt: { received_at: "date" },
  },
];

function columnsOf(table: string): { name: string; type: string }[] {
  const start = types.indexOf(`      ${table}: {\n        Row: {`);
  if (start < 0) throw new Error(`table ${table} not found in types.ts`);
  const end = types.indexOf("        Insert: {", start);
  const block = types.slice(start, end);
  return [...block.matchAll(/^ {10}(\w+)\??: ([^\n]+)$/gm)].map((m) => ({
    name: m[1]!,
    type: m[2]!.replace(/\|\s*null/g, "").trim(),
  }));
}

// Deprecated columns kept only for a transition. ghosted_at / ghosted_escalated_at
// mirror them and are the merge keys people should see.
const DEPRECATED = new Set(["goasted_at", "goasted_escalated_at"]);
const SKIP = new Set(["id", "geom", "is_demo", "search_vector", "lat", "lon", "seq"]);
const skip = (c: string) =>
  SKIP.has(c) || DEPRECATED.has(c) || c.endsWith("_id") || c.endsWith("_by");

function pascal(col: string) {
  return col
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function humanize(col: string) {
  const s = col
    .replace(/_/g, " ")
    .replace(/\bat\b$/, "date")
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Fmt = "text" | "money" | "date" | "datetime" | "bool" | "number";

function format(col: string, tsType: string): Fmt {
  if (tsType.startsWith("boolean")) return "bool";
  if (/(_at)$/.test(col)) return "datetime";
  if (/(_date|_on|^birthday|^anniversary)/.test(col) || col === "due_date") return "date";
  if (tsType.startsWith("number")) {
    return /(amount|total|price|value|subtotal|tax|deductible|shortfall|uncollected|deposit)/.test(
      col,
    )
      ? "money"
      : "number";
  }
  return "text";
}

const out: string[] = [
  "// AUTO-GENERATED by scripts/gen-merge-keys.ts — do not edit by hand.",
  "// Regenerate after a schema change so new columns become merge keys.",
  "",
  'export type GeneratedFmt = "text" | "money" | "date" | "datetime" | "bool" | "number";',
  "export type GeneratedKey = { key: string; label: string; column: string; fmt: GeneratedFmt };",
  "export type GeneratedGroup = { id: string; label: string; source: string; keys: GeneratedKey[] };",
  "",
  "export const GENERATED_GROUPS: GeneratedGroup[] = [",
];

for (const g of GROUPS) {
  const keys = columnsOf(g.table)
    .filter((c) => !skip(c.name))
    .filter((c) => (g.only ? g.only(c.name) : true))
    .map((c) => {
      const suffix =
        g.rename?.[c.name] ?? pascal(c.name.replace(new RegExp(`^${g.prefix.toLowerCase()}_`), ""));
      return {
        key: `${g.prefix}.${suffix}`,
        label: humanize(c.name),
        column: c.name,
        fmt: g.fmt?.[c.name] ?? format(c.name, c.type),
      };
    });
  // Deduplicate keys produced by rename collisions, first wins.
  const seen = new Set<string>();
  const unique = keys.filter((k) => (seen.has(k.key) ? false : (seen.add(k.key), true)));
  out.push(
    `  { id: ${JSON.stringify(g.id)}, label: ${JSON.stringify(g.label)}, source: ${JSON.stringify(g.source)}, keys: ${JSON.stringify(unique)} },`,
  );
}
out.push("];", "");

writeFileSync("src/lib/merge-keys.generated.ts", out.join("\n"));
console.log("wrote src/lib/merge-keys.generated.ts");
