/**
 * The email template engine: one place where every template lives.
 *
 * From the 16 Sep meeting, point 26, and the decision taken since — stop
 * waiting on Chaim and build the engine now:
 *
 *   "A single place where all email templates live (receipt, estimate, vendor
 *    order, etc.) · Each template: a subject + body with fill-in blanks
 *    (customer name, amount...) · Staff can edit the wording themselves in
 *    Admin."
 *
 * NOTHING HERE SENDS ANYTHING. This composes a subject and a body and stops.
 * Sending stays blocked on the backend approval, and the vendor-order
 * auto-email in the next PR will call `renderEmailTemplate("vendor_order", …)`
 * for its wording and hand the result to whatever eventually does the sending.
 *
 * WHY THIS SITS BESIDE `merge-keys.ts` RATHER THAN REPLACING IT
 *
 * The app already has a 620-key merge catalogue generated from the database
 * schema, with the client's own `{Job.SiteAddress.Full}` spelling, used by the
 * document templates, the contract signer and the job email dialog. It is not
 * wrong and it is not going anywhere.
 *
 * What it cannot do is the thing the decision asks for: say which fields belong
 * to WHICH template. Every template today is offered all 620 keys, so "the
 * fields available to a vendor order" is not a question the old catalogue can
 * answer. That is what this module adds — a small, typed, per-key field list in
 * the plain `{{snake_case}}` the decision itself uses, which is also the
 * vocabulary the next PR's vendor order needs.
 *
 * The two coexist deliberately: an engine template's own fields are legal
 * alongside the global catalogue, and the admin editor knows both. Converging
 * them into one vocabulary is real work and does not belong in the same change
 * as the engine itself.
 */

/* ------------------------------------------------------------------ */
/* The keys                                                            */
/* ------------------------------------------------------------------ */

/**
 * The stable keys code references. Staff edit the wording behind a key; they
 * never edit the key, because a renamed key is a silently broken send.
 */
export const EMAIL_TEMPLATE_KEYS = [
  "receipt",
  "estimate_send",
  "invoice_send",
  "vendor_order",
  "intake_confirmation",
  // Staff-only: what a job-stage automation rule emails (20260926121000).
  "job_followup",
  // To the client: automated reminders on an unpaid invoice (20261022160000).
  "invoice_followup_1",
  "invoice_followup_2",
] as const;

export type EmailTemplateKey = (typeof EMAIL_TEMPLATE_KEYS)[number];

const KEY_SET: ReadonlySet<string> = new Set(EMAIL_TEMPLATE_KEYS);

/** Is this one of the keys the engine owns, rather than a hand-made template? */
export function isEmailTemplateKey(key: string | null | undefined): key is EmailTemplateKey {
  return !!key && KEY_SET.has(key);
}

/* ------------------------------------------------------------------ */
/* The fields                                                          */
/* ------------------------------------------------------------------ */

/**
 * One fill-in blank.
 *
 * `sample` is what the preview shows. It is realistic on purpose — an admin
 * checking their wording against "Sample Value 1" learns nothing about whether
 * the sentence reads properly, and a price that looks like a price is how a
 * missing dollar sign gets noticed before a customer sees it.
 */
export type EmailMergeField = {
  token: string;
  label: string;
  sample: string;
};

const COMPANY: EmailMergeField[] = [
  { token: "company_name", label: "Company name", sample: "Gold Star Restoration" },
  { token: "company_phone", label: "Company phone", sample: "(201) 555-0180" },
];

/** An automated invoice reminder (invoice-followups.ts) — the invoice's own facts. */
const INVOICE_FOLLOWUP_FIELDS: EmailMergeField[] = [
  { token: "customer_name", label: "Customer name", sample: "Maria Delgado" },
  { token: "invoice_number", label: "Invoice number", sample: "INV-20841" },
  { token: "amount", label: "Invoice total", sample: "$7,250.00" },
  { token: "balance_remaining", label: "Balance due", sample: "$7,250.00" },
  { token: "due_date", label: "Due date", sample: "October 18, 2026" },
  { token: "days_since_sent", label: "Days since sent", sample: "14" },
  { token: "job_address", label: "Job address", sample: "14 Fairmount Avenue, Hackensack, NJ" },
  { token: "payment_link", label: "Payment link", sample: "https://hub.gsr.com/pay/20841" },
  { token: "company_name", label: "Company name", sample: "Gold Star Restoration" },
  { token: "company_phone", label: "Company phone", sample: "(201) 555-0180" },
];

/**
 * Which fields each template may use. Defined once, here, and typed — the
 * editor's chips, the preview's sample data and the render all read this same
 * list, so a field cannot exist in one and not the others.
 */
export const EMAIL_TEMPLATE_FIELDS: Record<EmailTemplateKey, EmailMergeField[]> = {
  receipt: [
    { token: "customer_name", label: "Customer name", sample: "Maria Delgado" },
    { token: "amount", label: "Amount received", sample: "$4,820.00" },
    { token: "payment_date", label: "Date received", sample: "September 18, 2026" },
    { token: "payment_method", label: "Payment method", sample: "Check #4471" },
    { token: "invoice_number", label: "Invoice number", sample: "INV-20841" },
    { token: "invoice_total", label: "Invoice total", sample: "$7,250.00" },
    { token: "balance_remaining", label: "Balance remaining", sample: "$2,430.00" },
    { token: "job_address", label: "Job address", sample: "14 Fairmount Avenue, Hackensack, NJ" },
    ...COMPANY,
  ],
  estimate_send: [
    { token: "customer_name", label: "Customer name", sample: "Maria Delgado" },
    { token: "estimate_number", label: "Estimate number", sample: "EST-3092" },
    { token: "amount", label: "Estimate total", sample: "$7,250.00" },
    { token: "job_address", label: "Job address", sample: "14 Fairmount Avenue, Hackensack, NJ" },
    { token: "loss_type", label: "Type of loss", sample: "Water — supply line failure" },
    { token: "valid_until", label: "Valid until", sample: "October 18, 2026" },
    { token: "estimate_link", label: "Link to the estimate", sample: "https://hub.gsr.com/e/3092" },
    ...COMPANY,
  ],
  invoice_send: [
    { token: "customer_name", label: "Customer name", sample: "Maria Delgado" },
    { token: "invoice_number", label: "Invoice number", sample: "INV-20841" },
    { token: "amount", label: "Invoice total", sample: "$7,250.00" },
    { token: "due_date", label: "Due date", sample: "October 18, 2026" },
    { token: "balance_remaining", label: "Balance due", sample: "$7,250.00" },
    { token: "job_address", label: "Job address", sample: "14 Fairmount Avenue, Hackensack, NJ" },
    { token: "payment_link", label: "Payment link", sample: "https://hub.gsr.com/pay/20841" },
    ...COMPANY,
  ],
  invoice_followup_1: INVOICE_FOLLOWUP_FIELDS,
  invoice_followup_2: INVOICE_FOLLOWUP_FIELDS,
  job_followup: [
    { token: "rule_name", label: "Rule name", sample: "Unpaid invoice follow-up" },
    { token: "job_number", label: "Job number", sample: "J-20841" },
    { token: "job_name", label: "Job name", sample: "1309 Ridge Avenue" },
    { token: "job_address", label: "Job address", sample: "1309 Ridge Avenue, Lakewood, NJ" },
    { token: "stage_name", label: "Stage", sample: "Invoice pending payment" },
    { token: "days_in_stage", label: "Days in the stage", sample: "7" },
    { token: "job_link", label: "Link to the job", sample: "https://hub.gsr.com/jobs/20841" },
    ...COMPANY,
  ],
  vendor_order: [
    { token: "vendor_name", label: "Vendor name", sample: "Jon-Don" },
    { token: "order_number", label: "Order number", sample: "PO-1184" },
    {
      token: "order_lines",
      label: "Items ordered (one per line)",
      // Multi-line on purpose: it is the field most likely to break a layout,
      // so the preview should show it breaking before a vendor does.
      sample: [
        '2 × 24 Case — Duct Tape (2"x60 Yard)',
        "4 × 4 Case — Shockwave Concentrate (1 Gallon)",
        "1 × 10 Case — Nitrile Gloves 100 Box (Large)",
      ].join("\n"),
    },
    { token: "needed_by", label: "Needed by", sample: "September 24, 2026" },
    {
      token: "delivery_address",
      label: "Deliver to",
      sample: "Gold Star Restoration, 88 Industrial Way, Paterson, NJ 07503",
    },
    { token: "requested_by", label: "Requested by", sample: "Danny Ruiz" },
    ...COMPANY,
  ],
  intake_confirmation: [
    { token: "customer_name", label: "Customer name", sample: "Maria Delgado" },
    { token: "job_number", label: "Job number", sample: "2026-1184" },
    { token: "job_address", label: "Job address", sample: "14 Fairmount Avenue, Hackensack, NJ" },
    { token: "loss_type", label: "Type of loss", sample: "Water — supply line failure" },
    { token: "scheduled_date", label: "Scheduled arrival", sample: "September 19, 2026, 8:00 AM" },
    { token: "technician_name", label: "Technician", sample: "Danny Ruiz" },
    ...COMPANY,
  ],
};

/** Every field this template may use, or an empty list for a hand-made one. */
export function fieldsFor(key: string | null | undefined): EmailMergeField[] {
  return isEmailTemplateKey(key) ? EMAIL_TEMPLATE_FIELDS[key] : [];
}

/** Realistic data to fill a preview with, so wording can be judged as written. */
export function sampleDataFor(key: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fieldsFor(key)) out[f.token] = f.sample;
  return out;
}

/* ------------------------------------------------------------------ */
/* The render — one function, and everything goes through it           */
/* ------------------------------------------------------------------ */

/**
 * `{{ token }}`, with whitespace tolerated because people type it both ways.
 *
 * Deliberately narrower than the global catalogue's pattern: no dots, no
 * spaces inside the name. These are flat snake_case fields, and a tight
 * pattern means `{{Job.SiteAddress.Full}}` from the old vocabulary is left
 * untouched rather than half-eaten.
 */
const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

export type EmailRenderInput = {
  subject: string;
  body: string;
  /** Values to fill in. Anything missing stays visible. */
  data?: Record<string, string | number | null | undefined>;
};

export type RenderedEmail = {
  subject: string;
  body: string;
  /**
   * Every placeholder still standing after the render — a typo, or a field
   * nobody supplied. The preview shows these; nothing is ever dropped quietly.
   */
  unresolved: string[];
};

/**
 * Fill a subject and body in. Pure: no database, no clock, no network.
 *
 * THE RULE, and the reason this function exists at all: a value substitutes,
 * and ANYTHING ELSE STAYS VISIBLE AS ITS PLACEHOLDER. A typo'd `{{custmer_name}}`
 * survives into the preview where somebody notices it; blanked, it would read
 * as a finished sentence with a hole in it and go out to a customer. The same
 * goes for a known field nobody passed — "Dear ," is worse than "Dear
 * {{customer_name}}", because only one of the two is obviously broken.
 *
 * This differs on purpose from `renderKeys` in merge-keys.ts, which blanks a
 * KNOWN key with no value. That rule suits a document with optional sections;
 * it does not suit an email whose wording was written assuming the blank would
 * be filled.
 */
export function renderEmail(input: EmailRenderInput): RenderedEmail {
  const data = input.data ?? {};
  const unresolved = new Set<string>();

  const fill = (text: string) =>
    text.replace(TOKEN_RE, (whole, token: string) => {
      const value = data[token];
      if (value == null || String(value).trim() === "") {
        unresolved.add(token);
        return whole;
      }
      return String(value);
    });

  return {
    subject: fill(input.subject ?? ""),
    body: fill(input.body ?? ""),
    unresolved: [...unresolved],
  };
}

/**
 * The call everything that composes an engine email makes: a key and some data
 * in, a finished subject and body out.
 *
 * `templates` is whatever came back from `email_templates`. When the key is not
 * in there — a database that has not had the seed migration yet — the built-in
 * default wording is used, so the engine is never the reason an email cannot be
 * composed.
 */
export function renderEmailTemplate(
  key: EmailTemplateKey,
  data: EmailRenderInput["data"],
  templates?: readonly { key: string; subject: string; body: string; is_active?: boolean }[],
): RenderedEmail & { usedDefault: boolean; isActive: boolean } {
  const row = templates?.find((t) => t.key === key);
  const source = row ?? EMAIL_TEMPLATE_DEFAULTS[key];
  return {
    ...renderEmail({ subject: source.subject, body: source.body, data }),
    usedDefault: !row,
    // A disabled template still composes. Whether to SEND it is the caller's
    // decision, and a caller that cannot see the flag cannot make it.
    isActive: row?.is_active ?? true,
  };
}

/** Placeholders in a piece of text that this template has no field for. */
export function unknownTokens(text: string, key: string | null | undefined): string[] {
  const known = new Set(fieldsFor(key).map((f) => f.token));
  const found = [...text.matchAll(TOKEN_RE)].map((m) => m[1]!);
  return [...new Set(found.filter((t) => !known.has(t)))];
}

/* ------------------------------------------------------------------ */
/* The default wording                                                 */
/* ------------------------------------------------------------------ */

export type EmailTemplateDefault = {
  key: EmailTemplateKey;
  name: string;
  /** The existing `email_category` enum. No new enum value is needed. */
  category: "payment_receipt" | "estimate" | "invoice" | "notification" | "reminder";
  subject: string;
  body: string;
  description: string;
};

/**
 * Sensible default wording, in a professional restoration-company voice.
 *
 * Bodies are HTML because that is what the editor stores and what the existing
 * seeded receipt uses. The migration seeds exactly these strings and a test
 * pins the two together, so the wording cannot drift between code and database.
 *
 * This is a STARTING POINT. The whole point of the decision is that staff edit
 * it themselves in Admin; nothing here is reapplied over an edit.
 */
export const EMAIL_TEMPLATE_DEFAULTS: Record<EmailTemplateKey, EmailTemplateDefault> = {
  receipt: {
    key: "receipt",
    name: "Payment receipt",
    category: "payment_receipt",
    description: "Sent after a payment is recorded against an invoice.",
    subject: "Payment received — thank you (invoice {{invoice_number}})",
    body: [
      "<p>Dear {{customer_name}},</p>",
      "<p>Thank you. We have received your payment of <b>{{amount}}</b> on {{payment_date}} by {{payment_method}}, applied to invoice {{invoice_number}} for the work at {{job_address}}.</p>",
      "<p>Invoice total: {{invoice_total}}<br/>Balance remaining: {{balance_remaining}}</p>",
      "<p>Please keep this receipt for your records. If anything above does not look right, call us and we will straighten it out.</p>",
      "<p>{{company_name}}<br/>{{company_phone}}</p>",
    ].join("\n"),
  },
  estimate_send: {
    key: "estimate_send",
    name: "Estimate",
    category: "estimate",
    description: "Sent to a customer with an estimate for their review.",
    subject: "Your estimate from {{company_name}} — {{job_address}}",
    body: [
      "<p>Dear {{customer_name}},</p>",
      "<p>Thank you for allowing us to look at the {{loss_type}} damage at {{job_address}}. Our estimate {{estimate_number}} for that work comes to <b>{{amount}}</b>.</p>",
      "<p>You can review the full estimate here: {{estimate_link}}</p>",
      "<p>This estimate is good through {{valid_until}}. If anything in it needs adjusting, or you would like us to walk you through the line items, call us and we will go through it together.</p>",
      "<p>{{company_name}}<br/>{{company_phone}}</p>",
    ].join("\n"),
  },
  invoice_send: {
    key: "invoice_send",
    name: "Invoice",
    category: "invoice",
    description: "Sent to a customer with an invoice for completed work.",
    subject: "Invoice {{invoice_number}} from {{company_name}}",
    body: [
      "<p>Dear {{customer_name}},</p>",
      "<p>Please find invoice {{invoice_number}} for the work completed at {{job_address}}. The total is <b>{{amount}}</b>, with {{balance_remaining}} due by {{due_date}}.</p>",
      "<p>You can pay online here: {{payment_link}}</p>",
      "<p>If you have any questions about this invoice, please call us before the due date and we will be glad to go over it.</p>",
      "<p>{{company_name}}<br/>{{company_phone}}</p>",
    ].join("\n"),
  },
  vendor_order: {
    key: "vendor_order",
    name: "Vendor order",
    category: "notification",
    description: "Sent to a supplier when an approved supply order is placed.",
    subject: "Purchase order {{order_number}} from {{company_name}}",
    body: [
      "<p>Hello {{vendor_name}},</p>",
      "<p>Please supply the following against purchase order {{order_number}}:</p>",
      "<p>{{order_lines}}</p>",
      "<p>Needed by: {{needed_by}}<br/>Deliver to: {{delivery_address}}</p>",
      "<p>Please confirm receipt of this order and let us know if anything is back-ordered. Questions to {{requested_by}} on {{company_phone}}.</p>",
      "<p>Thank you,<br/>{{company_name}}</p>",
    ].join("\n"),
  },
  invoice_followup_1: {
    key: "invoice_followup_1",
    name: "Invoice follow-up — first reminder",
    category: "reminder",
    description:
      "Sent to the client automatically when an invoice is still unpaid a set number of days after it was sent (Automations → Invoice follow-ups).",
    subject: "Reminder: invoice {{invoice_number}} — {{balance_remaining}} outstanding",
    body: [
      "<p>Hello {{customer_name}},</p>",
      "<p>This is a friendly reminder that invoice {{invoice_number}} for the work at {{job_address}}, sent {{days_since_sent}} days ago, still shows a balance of <b>{{balance_remaining}}</b>.</p>",
      "<p>If you have already sent payment, thank you — please disregard this note. Otherwise you can pay here: {{payment_link}}</p>",
      "<p>Questions about the invoice? Reply to this email or call us at {{company_phone}}.</p>",
      "<p>{{company_name}}</p>",
    ].join("\n"),
  },
  invoice_followup_2: {
    key: "invoice_followup_2",
    name: "Invoice follow-up — second reminder",
    category: "reminder",
    description:
      "The second automated reminder on an unpaid invoice (Automations → Invoice follow-ups).",
    subject: "Second reminder: invoice {{invoice_number}} is {{days_since_sent}} days unpaid",
    body: [
      "<p>Hello {{customer_name}},</p>",
      "<p>We have not yet received payment for invoice {{invoice_number}} ({{job_address}}), sent {{days_since_sent}} days ago. The balance due is <b>{{balance_remaining}}</b>.</p>",
      "<p>Please arrange payment at your earliest convenience: {{payment_link}}</p>",
      "<p>If there is a question holding this up, reply to this email or call {{company_phone}} and we will sort it out.</p>",
      "<p>{{company_name}}</p>",
    ].join("\n"),
  },
  job_followup: {
    key: "job_followup",
    name: "Job follow-up (automation)",
    category: "notification",
    description:
      "Sent to staff by an automation rule when a job has sat in one stage for a set number of days.",
    subject: "Follow up: job {{job_number}} has been {{stage_name}} for {{days_in_stage}} days",
    body: [
      "<p>Job {{job_number}} ({{job_name}}, {{job_address}}) has been in <b>{{stage_name}}</b> for {{days_in_stage}} days.</p>",
      "<p>Time to follow up. Open the job: {{job_link}}</p>",
      "<p>Sent by the automation rule {{rule_name}}.</p>",
      "<p>{{company_name}}</p>",
    ].join("\n"),
  },
  intake_confirmation: {
    key: "intake_confirmation",
    name: "Job confirmation",
    category: "notification",
    description: "Sent to a customer once their job is booked.",
    subject: "We are on the way — job {{job_number}} at {{job_address}}",
    body: [
      "<p>Dear {{customer_name}},</p>",
      "<p>Thank you for calling {{company_name}}. We have your {{loss_type}} loss at {{job_address}} on our schedule as job {{job_number}}.</p>",
      "<p>{{technician_name}} is scheduled to arrive on {{scheduled_date}}. If anything changes on your end, or the damage gets worse before we arrive, call us right away on {{company_phone}} — do not wait.</p>",
      "<p>In the meantime, please keep everyone clear of the affected area and do not run any equipment that got wet.</p>",
      "<p>{{company_name}}<br/>{{company_phone}}</p>",
    ].join("\n"),
  },
};

/** Every key, in the order the admin list shows them. */
export const EMAIL_TEMPLATE_DEFAULT_LIST: EmailTemplateDefault[] = EMAIL_TEMPLATE_KEYS.map(
  (k) => EMAIL_TEMPLATE_DEFAULTS[k],
);
