import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { roundMoneyLoose } from "@/lib/money";
/**
 * Automated invoice follow-ups (client item 18, 21 Oct — David): the
 * decisions, pure. The sweep (invoice-followups.server.ts), the send-time
 * check, the invoice's own panel and the settings screen all read these, so
 * "is this invoice due a reminder, and when?" has one answer.
 *
 * The rules, in order of who wins:
 *   1. The client says never (accounts.no_auto_followups) — nothing, ever,
 *      and an email already waiting is stopped at send time.
 *   2. The invoice says off (invoices.followup_mode = 'off').
 *   3. The invoice names a rule ('rule' + followup_rule_id), else the office's
 *      own active rule, else the company-wide one.
 * And only for an invoice that is SENT and still owes money — never a draft,
 * never paid, never written off. A disputed invoice is left to a person.
 */

export type FollowupStep = { days: number; template_key: string };

export type FollowupRule = {
  id: string;
  name: string;
  location_id: string | null;
  is_active: boolean;
  steps: FollowupStep[];
};

export type FollowupMode = "auto" | "off" | "rule";

export type FollowupInvoice = {
  id: string;
  status: string;
  sent_at: string | null;
  issue_date: string | null;
  total: number | null;
  billed_amount: number | null;
  collected_amount: number | null;
  location_id: string | null;
  followup_mode: FollowupMode | null;
  followup_rule_id: string | null;
};

/** One row of invoice_followups: a step that has already fired, one way or another. */
export type FiredFollowup = { rule_key: string; step_index: number };

/** Statuses a reminder may go out on: sent, and part paid. */
export const FOLLOWUP_STATUSES: readonly string[] = ["sent", "partial"];

export const FOLLOWUP_TEMPLATE_KEYS = ["invoice_followup_1", "invoice_followup_2"] as const;

const DAY = 86_400_000;

/** Steps cleaned up: whole positive days, ascending, one per day count. */
export function normalizeSteps(raw: unknown): FollowupStep[] {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set<number>();
  return list
    .map((s) => ({
      days: Math.round(Number((s as FollowupStep)?.days)),
      template_key: String((s as FollowupStep)?.template_key ?? "").trim(),
    }))
    .filter((s) => Number.isFinite(s.days) && s.days > 0 && s.days <= 365 && s.template_key)
    .sort((a, b) => a.days - b.days)
    .filter((s) => !seen.has(s.days) && seen.add(s.days));
}

/** What the invoice still owes; null when its figures are missing. */
export function balanceDue(inv: FollowupInvoice): number | null {
  const total = inv.total ?? inv.billed_amount;
  if (total == null) return null;
  return roundMoneyLoose(Number(total) - Number(inv.collected_amount ?? 0));
}

/** When the clock started: when it was sent, else its issue date. */
export function sentAt(inv: FollowupInvoice): Date | null {
  const raw = inv.sent_at ?? (inv.issue_date ? `${inv.issue_date}T12:00:00` : null);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** The rule that governs this invoice, or null for none. Ignores the client setting. */
export function ruleForInvoice(
  inv: FollowupInvoice,
  rules: readonly FollowupRule[],
): FollowupRule | null {
  const mode = inv.followup_mode ?? "auto";
  if (mode === "off") return null;
  const active = rules.filter((r) => r.is_active && normalizeSteps(r.steps).length > 0);
  if (mode === "rule" && inv.followup_rule_id) {
    const chosen = active.find((r) => r.id === inv.followup_rule_id);
    if (chosen) return chosen;
  }
  return (
    active.find((r) => r.location_id && r.location_id === inv.location_id) ??
    active.find((r) => !r.location_id) ??
    null
  );
}

export type FollowupState =
  | { kind: "client_exempt"; text: string }
  | { kind: "off"; text: string }
  | { kind: "no_rule"; text: string }
  | { kind: "not_sent"; text: string }
  | { kind: "settled"; text: string }
  | { kind: "done"; text: string; rule: FollowupRule }
  | {
      kind: "scheduled";
      text: string;
      rule: FollowupRule;
      /** The next step that has not fired, and when it is due. */
      next: { stepIndex: number; step: FollowupStep; dueAt: Date };
    };

/**
 * Where an invoice stands: what the invoice page says and what the sweep acts
 * on. `exempt` is the client's setting; `fired` the rows already written.
 */
export function followupState(input: {
  invoice: FollowupInvoice;
  rules: readonly FollowupRule[];
  exempt: boolean;
  fired: readonly FiredFollowup[];
}): FollowupState {
  const { invoice } = input;
  if (input.exempt) {
    return {
      kind: "client_exempt",
      text: "Off — this client is set to no automated follow-ups.",
    };
  }
  if ((invoice.followup_mode ?? "auto") === "off") {
    return { kind: "off", text: "Off for this invoice." };
  }
  const rule = ruleForInvoice(invoice, input.rules);
  if (!rule) return { kind: "no_rule", text: "No active follow-up rule applies." };
  if (invoice.status === "draft" || !sentAt(invoice)) {
    return { kind: "not_sent", text: "Starts once the invoice is sent." };
  }
  const balance = balanceDue(invoice);
  if (!FOLLOWUP_STATUSES.includes(invoice.status) || (balance != null && balance <= 0)) {
    return {
      kind: "settled",
      text:
        invoice.status === "disputed"
          ? "Paused — the invoice is disputed."
          : "Nothing to chase — the invoice is not open.",
    };
  }
  const steps = normalizeSteps(rule.steps);
  const firedHere = new Set(
    input.fired.filter((f) => f.rule_key === rule.id).map((f) => f.step_index),
  );
  const nextIndex = steps.findIndex((_, i) => !firedHere.has(i));
  if (nextIndex < 0) {
    return { kind: "done", text: `All ${steps.length} reminders have gone.`, rule };
  }
  const step = steps[nextIndex]!;
  const dueAt = new Date(sentAt(invoice)!.getTime() + step.days * DAY);
  return {
    kind: "scheduled",
    text: `Next reminder ${dueAt.toLocaleDateString(DATE_LOCALE, US_DATE)} (${step.days} days after sent).`,
    rule,
    next: { stepIndex: nextIndex, step, dueAt },
  };
}

export type DueDecision =
  | { act: false }
  | {
      act: true;
      rule: FollowupRule;
      /** The step that goes now: the latest one already due. */
      stepIndex: number;
      step: FollowupStep;
      /** Earlier steps also due but not sent: recorded as skipped, never doubled up. */
      skip: number[];
      daysSinceSent: number;
    };

/**
 * What the sweep does with one invoice now. A step fires once (the caller's
 * UNIQUE row is the lock). If the sweep was down and two steps are due at
 * once, only the later one is sent and the earlier is marked skipped — a
 * client never gets two reminders in one go.
 */
export function dueFollowup(input: {
  invoice: FollowupInvoice;
  rules: readonly FollowupRule[];
  exempt: boolean;
  fired: readonly FiredFollowup[];
  now: Date;
}): DueDecision {
  const state = followupState(input);
  if (state.kind !== "scheduled") return { act: false };
  const steps = normalizeSteps(state.rule.steps);
  const firedHere = new Set(
    input.fired.filter((f) => f.rule_key === state.rule.id).map((f) => f.step_index),
  );
  const start = sentAt(input.invoice)!.getTime();
  const daysSinceSent = Math.floor((input.now.getTime() - start) / DAY);
  const due = steps
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => !firedHere.has(i) && daysSinceSent >= s.days);
  if (!due.length) return { act: false };
  const last = due[due.length - 1]!;
  return {
    act: true,
    rule: state.rule,
    stepIndex: last.i,
    step: last.s,
    skip: due.slice(0, -1).map((d) => d.i),
    daysSinceSent,
  };
}

/**
 * Who the reminder goes to. An invoice raised against a carrier carries its
 * adjuster's email; otherwise the bill-to client's email; otherwise the job's
 * default contact, then any job contact with an email. Empty means nobody —
 * and then the office is asked to follow up by hand instead.
 */
export function followupRecipients(input: {
  adjusterEmail?: string | null;
  billToEmail?: string | null;
  jobContacts?: readonly { email: string | null; is_default_contact?: boolean | null }[];
}): string[] {
  const ok = (e: string | null | undefined) => {
    const v = (e ?? "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
  };
  const first =
    ok(input.adjusterEmail) ??
    ok(input.billToEmail) ??
    ok(input.jobContacts?.find((c) => c.is_default_contact && ok(c.email))?.email) ??
    ok(input.jobContacts?.find((c) => ok(c.email))?.email);
  return first ? [first] : [];
}

/**
 * At SEND time: is this reminder still wanted? Rechecked from the invoice and
 * the client as they are now, so a payment, an "off", or the client's
 * exemption flipped after the reminder was scheduled still stops it.
 * Returns why not, or null to send.
 */
export function sendTimeBlock(input: {
  invoice: Pick<
    FollowupInvoice,
    "status" | "followup_mode" | "total" | "billed_amount" | "collected_amount"
  > | null;
  exempt: boolean;
}): string | null {
  if (!input.invoice) return "The invoice no longer exists.";
  if (input.exempt) return "The client is set to no automated follow-ups.";
  if ((input.invoice.followup_mode ?? "auto") === "off")
    return "Follow-ups were switched off for this invoice.";
  if (!FOLLOWUP_STATUSES.includes(input.invoice.status)) {
    return input.invoice.status === "paid"
      ? "Invoice paid."
      : `Invoice is ${input.invoice.status.replace("_", " ")}.`;
  }
  const bal = balanceDue(input.invoice as FollowupInvoice);
  if (bal != null && bal <= 0) return "Nothing is owed on the invoice any more.";
  return null;
}

/** Is this queued email an automated invoice reminder? */
export const isFollowupEmail = (templateKey: string | null | undefined) =>
  !!templateKey && templateKey.startsWith("invoice_followup");
