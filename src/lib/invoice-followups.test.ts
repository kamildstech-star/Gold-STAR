import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  dueFollowup,
  followupRecipients,
  followupState,
  normalizeSteps,
  ruleForInvoice,
  sendTimeBlock,
  type FiredFollowup,
  type FollowupInvoice,
  type FollowupRule,
} from "@/lib/invoice-followups";

/*
 * Client item 18 (21 Oct, David): reminders on unpaid, sent invoices — 7 days,
 * then 14 — off per invoice, off per client, and never twice.
 */
const DAY = 86_400_000;
const SENT = new Date("2026-10-01T15:00:00Z");
const at = (days: number) => new Date(SENT.getTime() + days * DAY + 60_000);

const DEFAULT: FollowupRule = {
  id: "r-default",
  name: "Unpaid invoice reminders",
  location_id: null,
  is_active: true,
  steps: [
    { days: 7, template_key: "invoice_followup_1" },
    { days: 14, template_key: "invoice_followup_2" },
  ],
};
const NJ_RULE: FollowupRule = {
  id: "r-nj",
  name: "NJ reminders",
  location_id: "nj",
  is_active: true,
  steps: [{ days: 3, template_key: "invoice_followup_1" }],
};

const invoice = (over: Partial<FollowupInvoice> = {}): FollowupInvoice => ({
  id: "inv-1",
  status: "sent",
  sent_at: SENT.toISOString(),
  issue_date: "2026-10-01",
  total: 1000,
  billed_amount: 1000,
  collected_amount: 0,
  location_id: "ny",
  followup_mode: "auto",
  followup_rule_id: null,
  ...over,
});

const decide = (
  inv: FollowupInvoice,
  now: Date,
  fired: FiredFollowup[] = [],
  exempt = false,
  rules = [DEFAULT, NJ_RULE],
) => dueFollowup({ invoice: inv, rules, exempt, fired, now });

describe("a rule firing at N days", () => {
  it("does nothing before day 7, sends the first reminder on day 7", () => {
    expect(decide(invoice(), at(6)).act).toBe(false);
    const d = decide(invoice(), at(7));
    expect(d).toMatchObject({
      act: true,
      stepIndex: 0,
      step: { days: 7, template_key: "invoice_followup_1" },
    });
  });

  it("sends the second reminder on day 14, once the first has gone", () => {
    const fired = [{ rule_key: "r-default", step_index: 0 }];
    expect(decide(invoice(), at(10), fired).act).toBe(false);
    expect(decide(invoice(), at(14), fired)).toMatchObject({ act: true, stepIndex: 1 });
  });

  it("sends only the later reminder when both are due at once, and skips the earlier", () => {
    expect(decide(invoice(), at(20))).toMatchObject({ act: true, stepIndex: 1, skip: [0] });
  });

  it("uses the office's own rule over the company-wide one", () => {
    expect(ruleForInvoice(invoice({ location_id: "nj" }), [DEFAULT, NJ_RULE])?.id).toBe("r-nj");
    expect(decide(invoice({ location_id: "nj" }), at(3))).toMatchObject({
      act: true,
      rule: { id: "r-nj" },
    });
  });

  it("uses a rule picked on the invoice", () => {
    const inv = invoice({ followup_mode: "rule", followup_rule_id: "r-nj" });
    expect(ruleForInvoice(inv, [DEFAULT, NJ_RULE])?.id).toBe("r-nj");
  });
});

describe("not refiring", () => {
  it("a step that has fired never fires again, on any later sweep", () => {
    const fired = [
      { rule_key: "r-default", step_index: 0 },
      { rule_key: "r-default", step_index: 1 },
    ];
    for (const day of [14, 15, 30, 90]) expect(decide(invoice(), at(day), fired).act).toBe(false);
    expect(followupState({ invoice: invoice(), rules: [DEFAULT], exempt: false, fired }).kind).toBe(
      "done",
    );
  });

  it("the database is the lock: one row per invoice, rule and step", () => {
    const sql = readFileSync("supabase/migrations/20261022160000_invoice_followups.sql", "utf8");
    expect(sql).toMatch(/UNIQUE \(invoice_id, rule_key, step_index\)/);
    const sweep = readFileSync("src/lib/invoice-followups.server.ts", "utf8");
    // Claim first, act second; a duplicate claim is skipped.
    expect(sweep.indexOf('.from("invoice_followups")\n        .insert(')).toBeLessThan(
      sweep.indexOf('.from("email_messages")\n          .insert('),
    );
    expect(sweep).toMatch(
      /if \(\(claimErr as \{ code\?: string \}\)\.code === "23505"\) continue;/,
    );
  });
});

describe("cancel on payment", () => {
  it("a paid or written-off invoice is due nothing", () => {
    for (const status of ["paid", "written_off", "draft"]) {
      expect(decide(invoice({ status }), at(30)).act).toBe(false);
    }
    expect(decide(invoice({ status: "partial", collected_amount: 1000 }), at(30)).act).toBe(false);
  });

  it("keeps chasing a part-paid invoice that still owes", () => {
    expect(decide(invoice({ status: "partial", collected_amount: 400 }), at(7)).act).toBe(true);
  });

  it("a reminder already waiting is stopped at send time once paid", () => {
    expect(sendTimeBlock({ invoice: invoice({ status: "paid" }), exempt: false })).toBe(
      "Invoice paid.",
    );
    expect(sendTimeBlock({ invoice: invoice({ collected_amount: 1000 }), exempt: false })).toMatch(
      /Nothing is owed/,
    );
    expect(sendTimeBlock({ invoice: invoice(), exempt: false })).toBeNull();
  });

  it("the database cancels held and queued reminders when the invoice is paid", () => {
    const sql = readFileSync("supabase/migrations/20261022160000_invoice_followups.sql", "utf8");
    expect(sql).toMatch(/IF NEW\.status IN \('paid', 'written_off', 'draft'\)/);
    expect(sql).toMatch(/status IN \('held', 'queued'\)/);
  });

  it("never chases a draft", () => {
    expect(
      followupState({
        invoice: invoice({ status: "draft", sent_at: null, issue_date: null }),
        rules: [DEFAULT],
        exempt: false,
        fired: [],
      }).kind,
    ).toBe("not_sent");
  });
});

describe("the per-invoice off switch", () => {
  it("off means nothing is scheduled and nothing is due", () => {
    const inv = invoice({ followup_mode: "off" });
    expect(
      followupState({ invoice: inv, rules: [DEFAULT], exempt: false, fired: [] }),
    ).toMatchObject({ kind: "off" });
    expect(decide(inv, at(30)).act).toBe(false);
  });

  it("switching off after scheduling stops the waiting reminder", () => {
    expect(sendTimeBlock({ invoice: invoice({ followup_mode: "off" }), exempt: false })).toMatch(
      /switched off/,
    );
  });

  it("the sweep never even reads an invoice switched off", () => {
    const sweep = readFileSync("src/lib/invoice-followups.server.ts", "utf8");
    expect(sweep).toMatch(/\.neq\("followup_mode", "off"\)/);
  });
});

describe("the client exemption", () => {
  it("wins over every rule and invoice setting", () => {
    const inv = invoice({ followup_mode: "rule", followup_rule_id: "r-nj" });
    expect(
      followupState({ invoice: inv, rules: [DEFAULT, NJ_RULE], exempt: true, fired: [] }).kind,
    ).toBe("client_exempt");
    expect(decide(inv, at(30), [], true).act).toBe(false);
  });

  it("flipped AFTER the reminder was scheduled, it still stops the send", () => {
    // Scheduled while the client was not exempt…
    expect(decide(invoice(), at(7), [], false).act).toBe(true);
    // …then the toggle is flipped: the send-time check refuses it.
    expect(sendTimeBlock({ invoice: invoice(), exempt: true })).toMatch(/no automated follow-ups/);
  });

  it("is re-checked by the one function every email leaves through", () => {
    const delivery = readFileSync("src/lib/email-delivery.server.ts", "utf8");
    const guard = delivery.indexOf("blockFollowupAtSend(admin, row)");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(delivery.indexOf("const resolution = await resolve("));
  });
});

describe("the no-email fallback", () => {
  it("picks the adjuster, then the bill-to client, then the job's default contact", () => {
    expect(
      followupRecipients({ adjusterEmail: "adj@carrier.com", billToEmail: "a@b.com" }),
    ).toEqual(["adj@carrier.com"]);
    expect(followupRecipients({ billToEmail: " a@b.com " })).toEqual(["a@b.com"]);
    expect(
      followupRecipients({
        jobContacts: [
          { email: "other@x.com", is_default_contact: false },
          { email: "main@x.com", is_default_contact: true },
        ],
      }),
    ).toEqual(["main@x.com"]);
  });

  it("finds nobody when nobody has a usable email", () => {
    expect(
      followupRecipients({ adjusterEmail: "not an email", jobContacts: [{ email: null }] }),
    ).toEqual([]);
  });

  it("then the office gets a task and a notification, not silence", () => {
    const sweep = readFileSync("src/lib/invoice-followups.server.ts", "utf8");
    expect(sweep).toMatch(/if \(!to\.length\) \{\s*await notifyOffice\(/);
    const notify = sweep.slice(sweep.indexOf("async function notifyOffice"));
    expect(notify).toMatch(/\.from\("tasks"\)/);
    expect(notify).toMatch(/\.from\("notifications"\)/);
    expect(notify).toMatch(/outcome: "notified"/);
  });
});

describe("through the existing queue, never sending directly", () => {
  it("queues a held email on the job and the invoice, with the send delay", () => {
    const sweep = readFileSync("src/lib/invoice-followups.server.ts", "utf8");
    const insert = sweep.slice(sweep.indexOf('.from("email_messages")\n          .insert('));
    expect(insert).toMatch(/status: "held"/);
    expect(insert).toMatch(/job_id: inv\.job_id/);
    expect(insert).toMatch(/invoice_id: inv\.id/);
    expect(sweep).not.toMatch(/sendViaResend|sendThroughOutlook/);
  });

  it("is run by the every-15-minutes automations sweep", () => {
    const hook = readFileSync("src/routes/api/public/hooks/run-automations.ts", "utf8");
    expect(hook).toMatch(/runInvoiceFollowupSweep\(supabaseAdmin\)/);
  });

  it("steps are cleaned: positive days, ascending, one per day", () => {
    expect(
      normalizeSteps([
        { days: 14, template_key: "b" },
        { days: 7, template_key: "a" },
        { days: 7, template_key: "dup" },
        { days: 0, template_key: "zero" },
        { days: 3 },
      ]),
    ).toEqual([
      { days: 7, template_key: "a" },
      { days: 14, template_key: "b" },
    ]);
  });
});
