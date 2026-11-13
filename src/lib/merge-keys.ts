/**
 * Merge keys for email and document templates.
 *
 * The catalog is generated from the database schema (see
 * scripts/gen-merge-keys.ts → merge-keys.generated.ts) rather than hand-listed,
 * so a template can reference every column and a new column becomes a key the
 * moment the schema types are regenerated. Curated keys on top of that cover
 * derived values, the client's own legacy key spellings, and links.
 *
 * Syntax stays the client's: {Job.JobNumber} — single braces, dotted path,
 * case-sensitive. {{Key}} is accepted as an alias so their existing documents
 * paste in unchanged. A *known* key with no value renders as an empty string
 * (never "null"); an *unknown* key is left visible so nobody silently sends a
 * letter with a typo'd field in it.
 */
import { supabase } from "@/integrations/supabase/client";
import { GENERATED_GROUPS, type GeneratedFmt } from "./merge-keys.generated";
import { loadReceiptContext, type ReceiptContext } from "./payment-receipt";

import { DATE_LOCALE, US_DATE, US_DATE_TIME } from "@/lib/date-format";
export type MergeKey = { key: string; label: string; example?: string };
export type MergeCategory = { id: string; label: string; keys: MergeKey[] };

/** Derived / looked-up keys that no single column provides. */
const CURATED_EXTRAS: Record<string, MergeKey[]> = {
  account: [
    { key: "Account.Location", label: "Owning office" },
    { key: "Account.ParentAccount", label: "Parent account" },
    { key: "Account.AssignedRepName", label: "Assigned rep (name)" },
  ],
  job: [
    { key: "Job.SiteAddress.Full", label: "Site address (one line)" },
    { key: "Job.SiteAddress.PostalCode", label: "Site ZIP (client key)" },
    { key: "Job.CustomerPhone", label: "Customer phone" },
    { key: "Job.CustomerEmail", label: "Customer email" },
    { key: "Job.BillingName", label: "Billing name" },
    { key: "Job.LossType", label: "Loss type (detail preferred)" },
    { key: "Job.JobType", label: "Job type (detail preferred)" },
    { key: "Today", label: "Today's date" },
  ],
  contact: [
    { key: "Contact.FirstName", label: "Contact first name" },
    { key: "Contact.Role", label: "Contact role on this job" },
    { key: "Company.Name", label: "Company / account name" },
  ],
  office: [
    { key: "Office.Address (Full)", label: "Office address (one line)" },
    { key: "Office - Company Name", label: "Legal entity name (client key)" },
    { key: "Office Phone", label: "Office phone (client key)" },
    { key: "Office Email", label: "Office email (client key)" },
    { key: "Office Address (Full)", label: "Office address (client key)" },
    { key: "Office Payment Link", label: "Card payment link (client key)" },
    { key: "Office Zelle Email", label: "Zelle address (client key)" },
  ],
  invoice: [
    { key: "Invoice.Balance", label: "Invoice balance" },
    { key: "Invoice Number", label: "Invoice number (client key)" },
    { key: "Invoice Total", label: "Invoice total (client key)" },
    { key: "Invoice Date", label: "Invoice date (client key)" },
    { key: "Invoice Due Date", label: "Invoice due date (client key)" },
    { key: "Payment Link", label: "Payment link (client key)" },
  ],
  insurance: [{ key: "InsuranceCompany", label: "Insurance carrier (client key)" }],
  payment: [
    { key: "Payment.InvoiceNumber", label: "Invoice this payment was applied to" },
    { key: "Payment.InvoiceTotal", label: "Invoice total" },
    { key: "Payment.PaidToDate", label: "Received on that invoice through this payment" },
    { key: "Payment.BalanceAfter", label: "Balance remaining after this payment" },
    { key: "Payment.Overpaid", label: "Credit, when the payment exceeded the balance" },
    { key: "Payment.ReceiptNumber", label: "Receipt number" },
    { key: "Payment Amount", label: "Amount received (client key)" },
    { key: "Payment Date", label: "Date received (client key)" },
    { key: "Payment Method", label: "Method (client key)" },
    { key: "Payment Reference", label: "Check # / ACH trace (client key)" },
    { key: "Balance After Payment", label: "Balance after payment (client key)" },
  ],
};

const CURATED_GROUPS: MergeCategory[] = [
  {
    id: "job_billing",
    label: "Job Billing",
    keys: [
      { key: "JobBilling.Estimated", label: "Estimated amount" },
      { key: "JobBilling.Approved", label: "Approved amount" },
      { key: "JobBilling.Billed", label: "Billed amount" },
      { key: "JobBilling.Collected", label: "Collected amount" },
      { key: "JobBilling.Balance", label: "Balance due" },
      { key: "JobBilling.Deductible", label: "Deductible" },
      { key: "JobBilling.Deposit", label: "Deposit" },
      { key: "JobBilling.Terms", label: "Payment terms" },
    ],
  },
  {
    id: "compliance",
    label: "Compliance",
    keys: [
      { key: "Compliance.Status", label: "Compliance status" },
      { key: "Compliance.NextExpiry", label: "Next requirement expiry" },
      { key: "Compliance.COIExpiry", label: "Certificate of insurance expiry" },
      { key: "Compliance.COIPolicyNumber", label: "COI policy number" },
      { key: "Compliance.COICarrier", label: "COI carrier" },
      { key: "Compliance.CertificatesEmail", label: "Certificates email" },
      { key: "Compliance.OutstandingCount", label: "Requirements outstanding" },
    ],
  },
  {
    id: "purchase_order",
    label: "Purchase Order",
    keys: [
      { key: "PurchaseOrder.Number", label: "PO number" },
      { key: "PurchaseOrder.Vendor", label: "PO vendor" },
      { key: "PurchaseOrder.Total", label: "PO total" },
    ],
  },
  {
    id: "sender",
    label: "Sender",
    keys: [
      { key: "Sender.Name", label: "Your name" },
      { key: "Sender.Email", label: "Your email" },
      { key: "Company.LegalName", label: "Legal entity name" },
    ],
  },
  {
    id: "links",
    label: "Links & Signature",
    keys: LINK_KEYS_DEF(),
  },
];

function LINK_KEYS_DEF(): MergeKey[] {
  return [
    { key: "SignatureLink", label: "Secure signing link (minted at send)" },
    { key: "FormLink", label: "Per-job form link (minted at send)" },
    { key: "PortalLink", label: "Recipient's job view (minted at send)" },
    { key: "DocumentLink", label: "View the generated PDF" },
    { key: "PaymentLink", label: "Invoice payment link for the billing office" },
    { key: "Signature", label: "Signature block (rendered documents)" },
    { key: "SignatureDate", label: "Date signed (rendered documents)" },
    { key: "SignerName", label: "Signer's printed name" },
    { key: "IntakeLink", label: "Secure intake form link" },
  ];
}

/** Keys whose value can only exist once the message is actually sent. */
export const LINK_KEYS = new Set([
  "SignatureLink",
  "FormLink",
  "PortalLink",
  "DocumentLink",
  "IntakeLink",
  "link",
]);

/** Keys filled by the signing ceremony, not by the record. */
export const SIGNATURE_KEYS = new Set(["Signature", "SignatureDate", "SignerName"]);

export const MERGE_CATEGORIES: MergeCategory[] = [
  ...GENERATED_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    keys: [...g.keys.map((k) => ({ key: k.key, label: k.label })), ...(CURATED_EXTRAS[g.id] ?? [])],
  })),
  ...CURATED_GROUPS,
];

export const ALL_MERGE_KEYS = (() => {
  const seen = new Set<string>();
  const out: MergeKey[] = [];
  for (const c of MERGE_CATEGORIES) {
    for (const k of c.keys) {
      if (seen.has(k.key)) continue;
      seen.add(k.key);
      out.push(k);
    }
  }
  return out;
})();

export const MERGE_KEY_SET = new Set([...ALL_MERGE_KEYS.map((k) => k.key), "link"]);

const SINGLE_RE = /\{([A-Za-z][A-Za-z0-9_.\-#'()]*(?:[ ][A-Za-z0-9_.\-#'()]+)*)\}/g;
const DOUBLE_RE = /\{\{([A-Za-z][A-Za-z0-9_.\-#'()]*(?:[ ][A-Za-z0-9_.\-#'()]+)*)\}\}/g;

export function tokensIn(text: string): string[] {
  const keys = [
    ...[...text.matchAll(DOUBLE_RE)].map((m) => m[1]!),
    ...[...text.matchAll(SINGLE_RE)].map((m) => m[1]!),
  ];
  return [...new Set(keys)];
}

/** Tokens the catalog does not know about — the editor blocks a save on these. */
export function unknownKeys(text: string): string[] {
  return tokensIn(text).filter((k) => !MERGE_KEY_SET.has(k));
}

export type MergeData = Record<string, string | null | undefined>;

/**
 * Substitutes {Key} and {{Key}}. A known key with no value becomes an empty
 * string; an unknown key is left as written so it is visible before sending.
 */
export function renderKeys(text: string, data: MergeData): string {
  const sub = (match: string, key: string) => {
    const value = data[key];
    if (value != null && String(value).trim() !== "") return String(value);
    return MERGE_KEY_SET.has(key) ? "" : match;
  };
  return text.replace(DOUBLE_RE, sub).replace(SINGLE_RE, sub);
}

/**
 * Payment tokens whose bullet must disappear when the billing office has no
 * such method. A customer never sees an empty link, "n/a" or a dead URL.
 */
const PAYMENT_KEYS = [
  "Office Payment Link",
  "Payment Link",
  "Office Zelle Email",
  "Office.PaymentLink",
  "Office.ZelleEmail",
  "PaymentLink",
];

export function stripUnavailablePaymentBlocks(text: string, data: MergeData): string {
  const missing = PAYMENT_KEYS.filter((k) => {
    const v = data[k];
    return v == null || String(v).trim() === "";
  });
  if (missing.length === 0) return text;
  let out = text;
  for (const key of missing) {
    const tokens = [`{${key}}`, `{{${key}}}`];
    out = out.replace(/<(li|p)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) =>
      tokens.some((t) => block.includes(t)) ? "" : block,
    );
    out = out
      .split("\n")
      .filter((line) => !tokens.some((t) => line.includes(t)))
      .join("\n");
  }
  return out.replace(/<ul>\s*<\/ul>/gi, "").replace(/<ol>\s*<\/ol>/gi, "");
}

/** Known keys used in the text that resolve to nothing — a warning, not a block. */
export function unresolvedKeys(text: string, data: MergeData): string[] {
  return tokensIn(text).filter((k) => {
    if (LINK_KEYS.has(k) || SIGNATURE_KEYS.has(k)) return false;
    const v = data[k];
    return v == null || String(v).trim() === "";
  });
}

const money = (v: unknown) =>
  v == null || v === ""
    ? null
    : `$${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * A plain `date` column has no time zone, and `new Date("2026-09-01")` is
 * parsed as UTC midnight — which formats as 31 August for every office in the
 * US. Anchoring a date-only value at noon lands it on the day it says.
 */
const date = (v: unknown) => {
  if (!v) return null;
  const raw = String(v);
  const dt = new Date(raw.length <= 10 ? `${raw}T12:00:00` : raw);
  return Number.isNaN(dt.getTime()) ? null : dt.toLocaleDateString(DATE_LOCALE, US_DATE);
};

const dateTime = (v: unknown) =>
  !v ? null : new Date(String(v)).toLocaleString(DATE_LOCALE, US_DATE_TIME);

function formatValue(value: unknown, fmt: GeneratedFmt): string | null {
  if (value == null || value === "") return null;
  switch (fmt) {
    case "money":
      return money(value);
    case "date":
      return date(value);
    case "datetime":
      return dateTime(value);
    case "bool":
      return value ? "Yes" : "No";
    case "number":
      return String(value);
    default:
      return typeof value === "object" ? null : String(value);
  }
}

type Row = Record<string, unknown> | null | undefined;

/** Maps every generated key for one source record into the merge data. */
function applyGenerated(source: string, row: Row, data: MergeData) {
  for (const group of GENERATED_GROUPS) {
    if (group.source !== source) continue;
    for (const k of group.keys) {
      const current = data[k.key];
      const next = row ? formatValue(row[k.column], k.fmt) : null;
      if (next != null || current === undefined) data[k.key] = next;
    }
  }
}

/**
 * The payment group's values, including the ones no column holds.
 *
 * The balance is the figure a customer disputes, so it is computed from the
 * invoice total and the payment history (see payment-receipt.ts) rather than
 * read off `invoices.uncollected` — that column is the balance *now*, and a
 * receipt has to state the balance as at the payment it receipts.
 */
export function paymentMergeData(ctx: ReceiptContext): MergeData {
  const { payment, invoice, math } = ctx;
  const amount = money(math.thisPayment);
  const received = date(payment.received_at);
  const balance = money(math.balanceAfter);
  return {
    "Payment.Amount": amount,
    "Payment.ReceivedDate": received,
    "Payment.Method": payment.method ?? null,
    "Payment.Reference": payment.reference ?? null,
    "Payment.Notes": payment.notes ?? null,
    "Payment.CreatedAt": dateTime(payment.created_at ?? null),

    "Payment.InvoiceNumber": invoice.invoice_number ?? null,
    "Payment.InvoiceTotal": money(math.invoiceTotal),
    "Payment.PaidToDate": money(math.paidThrough),
    "Payment.BalanceAfter": balance,
    // Absent rather than "$0.00" so a template can print a credit line only
    // when there is a credit to print.
    "Payment.Overpaid": math.overpaid > 0 ? money(math.overpaid) : null,
    "Payment.ReceiptNumber": ctx.receiptNumber,

    "Payment Amount": amount,
    "Payment Date": received,
    "Payment Method": payment.method ?? null,
    "Payment Reference": payment.reference ?? null,
    "Balance After Payment": balance,
  };
}

export type JobMergeContext = {
  data: MergeData;
  jobContacts: { id: string; name: string | null; email: string | null; role: string }[];
  locationId: string | null;
  accountId: string | null;
  primaryContactId: string | null;
};

/**
 * Everything a template can need for one job, in one place. Related records
 * (invoice, estimate, note, task) resolve to the most recent one — that is what
 * an author means by {Invoice.Number} in a per-job email.
 */
export async function loadJobMergeContext(
  jobId: string,
  sender?: { name?: string | null; email?: string | null },
  /** Resolves the payment group against one recorded payment — a receipt. */
  opts?: { paymentId?: string | null },
): Promise<JobMergeContext> {
  const [jobRes, contactsRes, invoiceRes, estimateRes, noteRes, taskRes] = await Promise.all([
    supabase.from("jobs").select("*").eq("id", jobId).maybeSingle(),
    supabase
      .from("job_contacts")
      .select("id, contact_id, full_name, email, phone, role, is_default_contact, sort_order")
      .eq("job_id", jobId)
      .order("sort_order"),
    supabase
      .from("invoices")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("estimates")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("job_notes")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(1),
    supabase
      .from("tasks")
      .select("*")
      .eq("job_id", jobId)
      .neq("status", "done")
      .order("due_date")
      .limit(1),
  ]);

  const job = (jobRes.data ?? null) as Record<string, unknown> | null;
  if (!job) throw new Error("Job not found.");

  // Documents bill under the job's billing entity, never the operating office.
  const locationId =
    (job["billing_location_id"] as string | null) ?? (job["location_id"] as string | null) ?? null;
  const accountId = (job["account_id"] as string | null) ?? null;

  const contacts = (contactsRes.data ?? []) as Record<string, unknown>[];
  const primary = contacts.find((c) => c["is_default_contact"] === true) ?? contacts[0] ?? null;
  const primaryContactId = (primary?.["contact_id"] as string | null) ?? null;

  const [locationRes, accountRes, contactRes, complianceRes] = await Promise.all([
    locationId
      ? supabase.from("locations").select("*").eq("id", locationId).maybeSingle()
      : Promise.resolve({ data: null }),
    accountId
      ? supabase.from("accounts").select("*").eq("id", accountId).maybeSingle()
      : Promise.resolve({ data: null }),
    primaryContactId
      ? supabase.from("contacts").select("*").eq("id", primaryContactId).maybeSingle()
      : Promise.resolve({ data: null }),
    accountId
      ? supabase
          .from("account_compliance_status")
          .select(
            "requirement_type, status, effective_expiry, cert_policy_number, policy_number, carrier",
          )
          .eq("account_id", accountId)
      : Promise.resolve({ data: [] }),
  ]);

  const loc = (locationRes.data ?? null) as Record<string, unknown> | null;
  const account = (accountRes.data ?? null) as Record<string, unknown> | null;
  const contactRow = (contactRes.data ?? null) as Record<string, unknown> | null;
  const compliance = (complianceRes.data ?? []) as Record<string, unknown>[];

  // Account lookups that are ids on the row but names in a letter.
  const [parentRes, repRes] = await Promise.all([
    account?.["parent_account_id"]
      ? supabase
          .from("accounts")
          .select("name")
          .eq("id", account["parent_account_id"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    account?.["assigned_rep"]
      ? supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", account["assigned_rep"] as string)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const inv = (invoiceRes.data ?? [])[0] as Record<string, unknown> | undefined;
  const est = (estimateRes.data ?? [])[0] as Record<string, unknown> | undefined;
  const note = (noteRes.data ?? [])[0] as Record<string, unknown> | undefined;
  const task = (taskRes.data ?? [])[0] as Record<string, unknown> | undefined;

  const str = (k: string) => (job[k] as string | null) ?? null;
  const num = (k: string) => (job[k] as number | null) ?? null;

  const fullAddress = [
    str("address"),
    str("address_line2"),
    [str("locality"), str("region"), str("postal_code")].filter(Boolean).join(", "),
  ]
    .filter(Boolean)
    .join(", ");

  const contactName =
    (primary?.["full_name"] as string | null) ??
    (contactRow?.["full_name"] as string | null) ??
    str("customer_name");

  const officeAddress = loc
    ? [
        loc["address"],
        [loc["locality"], loc["region"], loc["postal_code"]].filter(Boolean).join(", "),
      ]
        .filter(Boolean)
        .join(", ")
    : null;

  const data: MergeData = {};

  // 1. Everything the schema offers, group by group.
  applyGenerated("job", job, data);
  applyGenerated("account", account, data);
  applyGenerated("contact", contactRow, data);
  applyGenerated("location", loc, data);
  applyGenerated("invoice", inv, data);
  applyGenerated("estimate", est, data);
  applyGenerated("task", task, data);
  applyGenerated("note", note, data);

  // 2. Derived values and the client's legacy key spellings.
  const coi =
    compliance.find((r) => String(r["requirement_type"] ?? "").includes("liability")) ??
    compliance.find((r) => String(r["requirement_type"] ?? "").includes("coi"));
  const expiries = compliance
    .map((r) => r["effective_expiry"] as string | null)
    .filter(Boolean)
    .sort() as string[];
  const outstanding = compliance.filter((r) => r["status"] !== "compliant").length;

  Object.assign(data, {
    "Job.SiteAddress.Full": fullAddress,
    "Job.SiteAddress.PostalCode": str("postal_code"),
    "Job.CustomerName": str("customer_name") ?? contactName,
    "Job.CustomerPhone":
      (primary?.["phone"] as string | null) ?? (contactRow?.["phone"] as string | null) ?? null,
    "Job.CustomerEmail":
      (primary?.["email"] as string | null) ?? (contactRow?.["email"] as string | null) ?? null,
    "Job.BillingName": str("customer_name") ?? contactName,
    "Job.LossType": str("loss_type_detail") ?? str("loss_type"),
    "Job.JobType": str("job_type_detail") ?? str("job_type"),
    Today: date(new Date().toISOString()),

    "Customer.Name": str("customer_name") ?? contactName,

    "JobBilling.Estimated": money(num("estimated_amount")),
    "JobBilling.Approved": money(num("approved_amount")),
    "JobBilling.Billed": money(num("billed_amount")),
    "JobBilling.Collected": money(num("collected_amount")),
    "JobBilling.Balance": money(
      num("billed_amount") == null
        ? null
        : (num("billed_amount") ?? 0) - (num("collected_amount") ?? 0),
    ),
    "JobBilling.Deductible": money(num("deductible")),
    "JobBilling.Deposit": money(num("deposit_amount")),
    "JobBilling.Terms": str("payment_terms"),

    "Contact.FullName": contactName,
    "Contact.FirstName": contactName ? contactName.split(" ")[0]! : null,
    "Contact.Email":
      (primary?.["email"] as string | null) ?? (contactRow?.["email"] as string | null) ?? null,
    "Contact.Phone":
      (primary?.["phone"] as string | null) ?? (contactRow?.["phone"] as string | null) ?? null,
    "Contact.Role": (primary?.["role"] as string | null) ?? null,
    "Company.Name":
      (account?.["name"] as string | null) ?? (loc?.["name"] as string | null) ?? null,

    "Account.Location": (loc?.["name"] as string | null) ?? null,
    "Account.ParentAccount": (parentRes.data as { name?: string } | null)?.name ?? null,
    "Account.AssignedRepName": (repRes.data as { full_name?: string } | null)?.full_name ?? null,

    "Office.Address (Full)": officeAddress,

    "Compliance.Status": compliance.length
      ? outstanding === 0
        ? "Compliant"
        : "Not compliant"
      : null,
    "Compliance.NextExpiry": date(expiries[0] ?? null),
    "Compliance.COIExpiry": date((coi?.["effective_expiry"] as string | null) ?? null),
    "Compliance.COIPolicyNumber":
      (coi?.["cert_policy_number"] as string | null) ??
      (coi?.["policy_number"] as string | null) ??
      null,
    "Compliance.COICarrier": (coi?.["carrier"] as string | null) ?? null,
    "Compliance.CertificatesEmail": (account?.["certificates_email"] as string | null) ?? null,
    "Compliance.OutstandingCount": compliance.length ? String(outstanding) : null,

    "Sender.Name": sender?.name ?? null,
    "Sender.Email": sender?.email ?? null,
    "Company.LegalName": (loc?.["legal_entity_name"] as string | null) ?? "Gold Star Restoration",

    "Invoice.Balance": money(
      inv
        ? ((inv["billed_amount"] as number) ?? 0) - ((inv["collected_amount"] as number) ?? 0)
        : null,
    ),

    InsuranceCompany: str("insurance_carrier"),
    "Office - Company Name":
      (loc?.["legal_entity_name"] as string | null) ?? "Gold Star Restoration",
    "Office Phone": (loc?.["office_phone"] as string | null) ?? null,
    "Office Email": (loc?.["office_email"] as string | null) ?? null,
    "Office Address (Full)": officeAddress,
    "Office Payment Link": (loc?.["card_payment_url"] as string | null) ?? null,
    "Office Zelle Email": (loc?.["zelle_email"] as string | null) ?? null,
    "Payment Link": (loc?.["card_payment_url"] as string | null) ?? null,
    PaymentLink: (loc?.["card_payment_url"] as string | null) ?? null,
    "Invoice Number": (inv?.["invoice_number"] as string | null) ?? null,
    "Invoice Total": money(inv?.["billed_amount"] as number | null),
    "Invoice Date": date(inv?.["issue_date"] as string | null),
    "Invoice Due Date": date(inv?.["due_date"] as string | null),
    "Form Recipient Full Name": contactName,
  } satisfies MergeData);

  // A receipt is written about one payment, so the payment group only resolves
  // when the caller names it. Elsewhere {Payment.*} stays visibly unfilled
  // rather than quietly picking whichever payment happened to be latest.
  if (opts?.paymentId) {
    Object.assign(data, paymentMergeData(await loadReceiptContext(opts.paymentId)));
  }

  return {
    data,
    jobContacts: contacts.map((c) => ({
      id: c["id"] as string,
      name: (c["full_name"] as string | null) ?? null,
      email: (c["email"] as string | null) ?? null,
      role: (c["role"] as string) ?? "contact",
    })),
    locationId,
    accountId,
    primaryContactId,
  };
}
