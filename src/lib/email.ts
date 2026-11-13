import type { Database } from "@/integrations/supabase/types";

export type EmailCategory = Database["public"]["Enums"]["email_category"];
export type EmailStatus = Database["public"]["Enums"]["email_status"];
export type EmailTemplate = Database["public"]["Tables"]["email_templates"]["Row"];
export type EmailMessage = Database["public"]["Tables"]["email_messages"]["Row"];

export const EMAIL_CATEGORIES: EmailCategory[] = [
  "estimate",
  "invoice",
  "follow_up",
  "seasonal",
  "work_authorization",
  "reminder",
  "notification",
  "payment_receipt",
];

export const EMAIL_CATEGORY_LABEL: Record<EmailCategory, string> = {
  estimate: "Estimate",
  invoice: "Invoice",
  follow_up: "Follow-up",
  seasonal: "Seasonal",
  work_authorization: "Work authorization",
  reminder: "Reminder",
  notification: "Notification",
  payment_receipt: "Payment receipt",
};

/**
 * The wording Gold Star's current system sends under "Payment Received - Thank
 * You". Seeded here rather than in a migration because the enum value it needs
 * cannot be used in the same transaction that adds it; an administrator starts
 * a template from this under Admin → Email templates.
 */
export const PAYMENT_RECEIPT_TEMPLATE = {
  subject: "Payment received — thank you (invoice {Payment.InvoiceNumber})",
  body: [
    "<p>Hello {Contact.FirstName},</p>",
    "<p>Thank you — we received your payment of <b>{Payment.Amount}</b> on {Payment.ReceivedDate} by {Payment.Method}, applied to invoice {Payment.InvoiceNumber} for the work at {Job.SiteAddress.Full}.</p>",
    "<p>Invoice total: {Payment.InvoiceTotal}<br/>Received to date: {Payment.PaidToDate}<br/>Balance remaining: {Payment.BalanceAfter}</p>",
    "<p>Your receipt is below. Please keep it for your records.</p>",
    "<p>{Office - Company Name}<br/>{Office Phone}</p>",
  ].join("\n"),
} as const;

export const EMAIL_STATUS_LABEL: Record<EmailStatus, string> = {
  held: "Held",
  cancelled: "Canceled",
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  opened: "Opened",
  bounced: "Bounced",
  failed: "Failed",
};

/**
 * Templates carry {{variable}} placeholders. Rendering is deliberately dumb:
 * a missing variable is left visible as its placeholder rather than silently
 * blanked, so nobody sends "Hi ," to a client.
 */
export function renderTemplate(text: string, vars: Record<string, string | null | undefined>) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value == null || value === "" ? match : value;
  });
}

/** Placeholders still unresolved after rendering — surfaced before sending. */
export function unresolvedVariables(text: string) {
  return [...new Set([...text.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]!))];
}

export function templateVariables(template: Pick<EmailTemplate, "subject" | "body">) {
  return unresolvedVariables(`${template.subject}\n${template.body}`);
}

export function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function parseRecipients(value: string) {
  return value
    .split(/[,;\s]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}
