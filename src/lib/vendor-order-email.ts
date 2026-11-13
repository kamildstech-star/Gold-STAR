/**
 * The vendor's purchase order, composed when a supply order is approved.
 *
 * David, 16 Sep, point 22: the approval flow shipped with vendor emailing
 * MANUAL and "a clean seam to switch on". The decision came back — switch it
 * on. Approving an order now produces the vendor email by itself.
 *
 * WHAT IS STILL NOT TRUE, and the reason this file is shaped the way it is:
 * outbound delivery is blocked on Chaim approving the email backend. So the
 * email is composed for real, recorded for real, and handed to the approver's
 * own Outlook as a prefilled draft. It works today, through a mail client the
 * office already has, rather than waiting.
 *
 * `deliverVendorOrder` at the bottom is THE SEAM — one function, and the only
 * thing that changes the day a real sender exists.
 *
 * Everything above `composeVendorOrder` is pure, because the wording that goes
 * to a merchant on Gold Star's behalf should be testable without a database.
 */

import { supabase } from "@/integrations/supabase/client";
import {
  EMAIL_TEMPLATE_DEFAULTS,
  renderEmailTemplate,
  type RenderedEmail,
} from "@/lib/email-templates";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { SupplyRequestFull } from "@/lib/supplies";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/* ------------------------------------------------------------------ */
/* Reading the order                                                   */
/* ------------------------------------------------------------------ */

/**
 * The order's items, one per line, the way a merchant reads an order.
 *
 * Quantity, then the pack it is ordered in, then the name — "2 × 24 Case —
 * Duct Tape". The unit matters more than anywhere else in the app here: a
 * vendor shipping 2 rolls instead of 2 cases is a real and expensive
 * misunderstanding.
 */
export function orderLinesText(request: Pick<SupplyRequestFull, "supply_request_lines">): string {
  return (request.supply_request_lines ?? [])
    .map((l) => {
      const name = l.supply_items?.name ?? l.other_label ?? "Item";
      // `size` lands with the catalogue-load branch. Read through a narrow cast
      // so this works either way: with it, a merchant is told WHICH of the five
      // Merv 8 filters; without it, the line is simply shorter.
      const size = (l.supply_items as { size?: string | null } | null)?.size?.trim();
      const unit = (l.unit ?? l.supply_items?.unit ?? "").trim();
      const qty = Number(l.quantity);
      const amount = qty % 1 === 0 ? String(qty) : qty.toFixed(2);
      const head = unit ? `${amount} × ${unit}` : amount;
      return `${head} — ${name}${size ? ` (${size})` : ""}`;
    })
    .join("\n");
}

/**
 * Who this order goes to, from the catalogue's usual supplier for its items.
 *
 * Null when the lines disagree or nothing says. An order spanning two merchants
 * is not a thing to guess at: picking the first would send one vendor a request
 * for goods they do not stock, so the approver is asked instead.
 */
export function vendorNameFor(
  request: Pick<SupplyRequestFull, "supply_request_lines">,
  supplierOf: (itemId: string) => string | null,
  /**
   * The vendor chosen on the line itself, which beats the item's usual one.
   * David, 22 Sep: "we could obviously always in each order select a vendor."
   */
  lineVendorOf?: (line: SupplyRequestFull["supply_request_lines"][number]) => string | null,
): string | null {
  const names = new Set<string>();
  for (const line of request.supply_request_lines ?? []) {
    const chosen = lineVendorOf?.(line)?.trim();
    if (chosen) {
      names.add(chosen);
      continue;
    }
    if (!line.item_id) continue;
    const supplier = supplierOf(line.item_id)?.trim();
    if (supplier) names.add(supplier);
  }
  return names.size === 1 ? [...names][0]! : null;
}

/** An order number a merchant can quote back. Short, and stable per request. */
export function orderNumberFor(requestId: string): string {
  return `PO-${requestId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

export type VendorOrderContext = {
  request: SupplyRequestFull;
  vendorName: string | null;
  requestedBy: string | null;
  deliveryAddress: string | null;
  companyName: string;
  companyPhone: string | null;
};

/**
 * The template's fill-in blanks, assembled from the order.
 *
 * Every blank the `vendor_order` template declares is filled or deliberately
 * left out — and left out means the placeholder survives into the preview,
 * which is exactly how the approver finds out the delivery address is missing.
 */
export function vendorOrderMergeData(ctx: VendorOrderContext): Record<string, string> {
  const data: Record<string, string> = {
    order_number: orderNumberFor(ctx.request.id),
    order_lines: orderLinesText(ctx.request),
    company_name: ctx.companyName,
  };
  if (ctx.vendorName) data.vendor_name = ctx.vendorName;
  if (ctx.requestedBy) data.requested_by = ctx.requestedBy;
  if (ctx.deliveryAddress) data.delivery_address = ctx.deliveryAddress;
  if (ctx.companyPhone) data.company_phone = ctx.companyPhone;
  if (ctx.request.needed_by) data.needed_by = formatNeededBy(ctx.request.needed_by);
  return data;
}

/** A date a merchant reads, not an ISO string. */
function formatNeededBy(value: string): string {
  const parsed = Date.parse(`${value}T00:00:00`);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toLocaleDateString(DATE_LOCALE, US_DATE);
}

/* ------------------------------------------------------------------ */
/* mailto                                                              */
/* ------------------------------------------------------------------ */

/**
 * How long a mailto: may get before a mail client starts truncating it.
 *
 * There is no standard. Outlook historically cuts around 2,000 characters and
 * old shells lower, so the whole URL is kept under this and the BODY is what
 * gives way — losing the tail of a purchase order silently is the one outcome
 * worth engineering against.
 */
export const MAILTO_MAX_LENGTH = 1900;

const TRUNCATION_NOTICE = "\n\n[Order continues — see the full order in Recovery Hub.]";

export type MailtoInput = { to: string | null; subject: string; body: string };
export type MailtoResult = { url: string; truncated: boolean };

/**
 * A prefilled draft in whatever mail client the user already has.
 *
 * `encodeURIComponent` rather than `encodeURI`: a subject carrying `&` or `#`
 * would otherwise end the query string early and the body would vanish, which
 * is precisely what happens with a real supplier called "Smith & Sons".
 *
 * A blank recipient is a legitimate result — the draft opens with the To field
 * empty and the approver types the address. That is better than refusing to
 * open, which would leave them with the wording trapped in the app.
 */
export function buildMailto(input: MailtoInput): MailtoResult {
  const to = (input.to ?? "").trim();
  const subject = input.subject ?? "";
  const build = (body: string) =>
    `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  const full = build(input.body ?? "");
  if (full.length <= MAILTO_MAX_LENGTH) return { url: full, truncated: false };

  // Trim the body a character at a time from the end until the whole URL fits
  // WITH the notice on it, so the reader is always told the order was cut.
  let body = input.body ?? "";
  while (body.length > 0 && build(body + TRUNCATION_NOTICE).length > MAILTO_MAX_LENGTH) {
    body = body.slice(0, -Math.max(1, Math.ceil(body.length * 0.05)));
  }
  return { url: build(body + TRUNCATION_NOTICE), truncated: true };
}

/* ------------------------------------------------------------------ */
/* Composing                                                           */
/* ------------------------------------------------------------------ */

export type ComposedVendorOrder = RenderedEmail & {
  to: string | null;
  /** True when the template row was missing or disabled and defaults were used. */
  usedDefaultWording: boolean;
  /** Why the wording came from the built-in default, for the record. */
  wordingNote: string | null;
  /** No address on file. The approver fills it in; approval is unaffected. */
  missingRecipient: boolean;
};

/**
 * Subject and body through the engine, never hardcoded here.
 *
 * A template row that is missing OR disabled falls back to the built-in default
 * wording rather than composing nothing — an approval must not depend on
 * somebody having left a template switched on — and the record says which was
 * used, so "why does this read differently" has an answer.
 */
export function composeVendorOrder(
  ctx: VendorOrderContext,
  vendorEmail: string | null,
  templates?: readonly { key: string; subject: string; body: string; is_active?: boolean }[],
): ComposedVendorOrder {
  const rendered = renderEmailTemplate("vendor_order", vendorOrderMergeData(ctx), templates);

  // A disabled template is not wording anybody stands behind, so it is not
  // used. Re-rendered from the default instead of shipping what was switched
  // off deliberately.
  const disabled = !rendered.usedDefault && !rendered.isActive;
  const final = disabled
    ? renderEmailTemplate("vendor_order", vendorOrderMergeData(ctx), undefined)
    : rendered;

  const usedDefaultWording = final.usedDefault;
  return {
    subject: final.subject,
    body: final.body,
    unresolved: final.unresolved,
    to: vendorEmail?.trim() || null,
    usedDefaultWording,
    wordingNote: disabled
      ? "The vendor_order template is switched off in Admin, so the built-in default wording was used."
      : usedDefaultWording
        ? "No vendor_order template exists yet, so the built-in default wording was used."
        : null,
    missingRecipient: !vendorEmail?.trim(),
  };
}

/** The wording this composes from when no template row exists. */
export const VENDOR_ORDER_DEFAULT = EMAIL_TEMPLATE_DEFAULTS.vendor_order;

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

export type VendorOrderEmail = {
  id: string;
  supply_request_id: string;
  to_emails: string[];
  subject: string;
  body_html: string;
  status: string;
  queued_at: string;
  sent_at: string | null;
};

/** The vendor emails already composed for these orders, by request id. */
export async function listVendorOrderEmails(
  requestIds: readonly string[],
): Promise<Map<string, VendorOrderEmail>> {
  const out = new Map<string, VendorOrderEmail>();
  if (requestIds.length === 0) return out;
  const { data, error } = await supabase
    .from("email_messages")
    .select("id, supply_request_id, to_emails, subject, body_html, status, queued_at, sent_at")
    .in("supply_request_id", requestIds as string[]);
  if (error) {
    // The column arrives with 20260918150000. Until then an order simply shows
    // no email status, and approving still works.
    if (isMissingSchema(error)) return out;
    throw error;
  }
  for (const row of (data ?? []) as unknown as VendorOrderEmail[]) {
    if (row.supply_request_id) out.set(row.supply_request_id, row);
  }
  return out;
}

/**
 * Put the composed email on the record, queued.
 *
 * Returns null when the schema is not there yet — the email is still composed
 * and still openable, it just is not logged. An approval must never fail
 * because the log could not be written; that is the whole point of the
 * try/catch this sits inside.
 */
export async function recordVendorOrderEmail(input: {
  requestId: string;
  locationId: string;
  composed: ComposedVendorOrder;
  userId: string;
}): Promise<VendorOrderEmail | null> {
  const { data, error } = await supabase
    .from("email_messages")
    .insert({
      supply_request_id: input.requestId,
      location_id: input.locationId,
      category: "notification",
      template_key: "vendor_order",
      to_emails: input.composed.to ? [input.composed.to] : [],
      cc_emails: [],
      subject: input.composed.subject,
      body_html: input.composed.body,
      status: "queued",
      sent_by: input.userId,
      error: input.composed.wordingNote,
    } as never)
    .select("id, supply_request_id, to_emails, subject, body_html, status, queued_at, sent_at")
    .single();

  if (error) {
    if (isMissingSchema(error)) return null;
    // A second approval hitting the one-per-request unique index means the
    // email already exists, which is success, not failure.
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
  return data as unknown as VendorOrderEmail;
}

/** The approver opened the draft. Recorded so nobody sends it twice. */
export async function markVendorOrderEmailOpened(id: string): Promise<void> {
  const { error } = await supabase
    .from("email_messages")
    .update({ status: "sent", sent_at: new Date().toISOString() } as never)
    .eq("id", id);
  if (error && !isMissingSchema(error)) throw error;
}

/* ------------------------------------------------------------------ */
/* THE SEAM                                                            */
/* ------------------------------------------------------------------ */

export type DeliveryResult = {
  /** True only when a backend actually accepted the message for sending. */
  delivered: boolean;
  /** How it reached, or will reach, the vendor. */
  via: "mailto" | "backend";
  /** A mailto: URL when the user's own client is the transport. */
  url: string | null;
  truncated: boolean;
  note: string;
};

/**
 * ============================ THE SEAM ============================
 *
 * The ONE function that changes the day a real sender exists. Nothing upstream
 * moves: the approval flow composes, records and calls this, and cares only
 * about the DeliveryResult it gets back.
 *
 * TODAY it returns a mailto: URL, because outbound delivery is blocked on Chaim
 * approving the email backend and an office with Outlook can send a prefilled
 * draft right now.
 *
 * WHEN THE BACKEND EXISTS, this function body becomes a call to it and returns
 * `{ delivered: true, via: "backend" }`. The caller then marks the record sent
 * exactly as it does now. Do not add a second path; change this one.
 * ==================================================================
 */
export function deliverVendorOrder(composed: ComposedVendorOrder): DeliveryResult {
  const { url, truncated } = buildMailto({
    to: composed.to,
    subject: composed.subject,
    body: composed.body,
  });
  return {
    delivered: false,
    via: "mailto",
    url,
    truncated,
    note: composed.missingRecipient
      ? "No supplier email on file — the draft opens with an empty To field."
      : "Opens as a draft in your own email client. Nothing is sent by Recovery Hub.",
  };
}

/* ------------------------------------------------------------------ */
/* The vendor directory                                                */
/* ------------------------------------------------------------------ */

/**
 * Supplier name -> email address, lower-cased for matching.
 *
 * Every supplier in the app is free text somebody typed, so this is a lookup
 * beside those names rather than a replacement for them. An empty map is the
 * normal state on day one and composes a blank recipient, which is handled.
 */
export async function listVendorEmails(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { data, error } = await supabase.from("supply_vendors" as never).select("name, email");
  if (error) {
    if (isMissingSchema(error)) return out;
    throw error;
  }
  for (const row of (data ?? []) as unknown as { name: string; email: string | null }[]) {
    if (row.email?.trim()) out.set(row.name.trim().toLowerCase(), row.email.trim());
  }
  return out;
}

/**
 * Remember the address the approver just typed, so the next order knows it.
 *
 * Best effort on purpose: this is called after an email has already been
 * composed and opened, and failing to memorise an address must not look like
 * the email failed. The caller logs and moves on. The write itself lives with
 * the vendor list (supply-vendors.ts), which is what this fills.
 */
export async function rememberVendorEmail(
  name: string,
  email: string,
  userId: string | null,
): Promise<void> {
  if (!email.trim()) return;
  const { rememberVendor } = await import("./supply-vendors");
  await rememberVendor(name, { email }, userId);
}
