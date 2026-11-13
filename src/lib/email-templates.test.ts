import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_FIELDS,
  EMAIL_TEMPLATE_KEYS,
  fieldsFor,
  isEmailTemplateKey,
  renderEmail,
  renderEmailTemplate,
  sampleDataFor,
  unknownTokens,
} from "@/lib/email-templates";

/**
 * The email template engine.
 *
 * 16 Sep meeting, point 26, decided since: "A single place where all email
 * templates live (receipt, estimate, vendor order, etc.) · Each template: a
 * subject + body with fill-in blanks (customer name, amount...) · Staff can
 * edit the wording themselves in Admin."
 *
 * The rule worth guarding hardest is what happens to a blank that does NOT get
 * filled. Silently dropping it produces a sentence that reads as finished and
 * is wrong — "Dear ," — and nobody catches that until a customer has it. Every
 * unfilled blank stays visible and is reported, so it is caught in preview.
 */

/*
 * The five original keys are seeded by the engine migration; a key added
 * later is seeded by its own migration (job_followup, 20260926121000). The
 * seed checks read them together so every key is pinned to its seed.
 */
const ENGINE_MIGRATION = readFileSync(
  "supabase/migrations/20260918140000_email_template_engine.sql",
  "utf8",
).replace(/\r\n/g, "\n");
const MIGRATION = [
  "supabase/migrations/20260918140000_email_template_engine.sql",
  "supabase/migrations/20260926121000_job_stage_automation.sql",
  "supabase/migrations/20261022160000_invoice_followups.sql",
]
  .map((p) => {
    const text = readFileSync(p, "utf8");
    // The follow-ups migration also creates its own tables and their policies;
    // only its template section is about email_templates.
    const at = text.indexOf("-- 5. The two follow-up templates");
    return p.includes("invoice_followups") && at >= 0 ? text.slice(at) : text;
  })
  .join("\n")
  .replace(/\r\n/g, "\n");

describe("the keys", () => {
  it("is the five the decision named, plus the staff-only automation follow-up", () => {
    expect([...EMAIL_TEMPLATE_KEYS]).toEqual([
      "receipt",
      "estimate_send",
      "invoice_send",
      "vendor_order",
      "intake_confirmation",
      "job_followup",
      // The client-facing invoice reminders (22 Oct, invoice-followups.ts).
      "invoice_followup_1",
      "invoice_followup_2",
    ]);
  });

  it("knows its own keys from a hand-made template's", () => {
    expect(isEmailTemplateKey("vendor_order")).toBe(true);
    expect(isEmailTemplateKey("template_1758200000000")).toBe(false);
    expect(isEmailTemplateKey(null)).toBe(false);
    expect(isEmailTemplateKey(undefined)).toBe(false);
  });
});

describe("substitution", () => {
  it("fills a blank that has a value", () => {
    const out = renderEmail({
      subject: "Invoice {{invoice_number}}",
      body: "Dear {{customer_name}}, you owe {{amount}}.",
      data: { invoice_number: "INV-20841", customer_name: "Maria Delgado", amount: "$7,250.00" },
    });
    expect(out.subject).toBe("Invoice INV-20841");
    expect(out.body).toBe("Dear Maria Delgado, you owe $7,250.00.");
    expect(out.unresolved).toEqual([]);
  });

  it("fills the same blank everywhere it appears", () => {
    const out = renderEmail({
      subject: "{{company_name}}",
      body: "{{company_name}} — call {{company_name}}",
      data: { company_name: "Gold Star Restoration" },
    });
    expect(out.body).toBe("Gold Star Restoration — call Gold Star Restoration");
  });

  it("tolerates the spacing people actually type", () => {
    const out = renderEmail({
      subject: "",
      body: "{{customer_name}} / {{ customer_name }} / {{  customer_name  }}",
      data: { customer_name: "Maria" },
    });
    expect(out.body).toBe("Maria / Maria / Maria");
  });

  it("takes a number without turning it into the string 'null'", () => {
    const out = renderEmail({ subject: "", body: "{{amount}}", data: { amount: 0.5 } });
    expect(out.body).toBe("0.5");
  });
});

describe("missing data", () => {
  it("leaves a known field visible when nobody supplied it", () => {
    // "Dear ," is worse than "Dear {{customer_name}}": only one of the two is
    // obviously broken to the person looking at the preview.
    const out = renderEmail({ subject: "", body: "Dear {{customer_name}},", data: {} });
    expect(out.body).toBe("Dear {{customer_name}},");
    expect(out.unresolved).toEqual(["customer_name"]);
  });

  it("treats null, undefined and whitespace as not supplied", () => {
    const out = renderEmail({
      subject: "",
      body: "{{a}} {{b}} {{c}}",
      data: { a: null, b: undefined, c: "   " },
    });
    expect(out.body).toBe("{{a}} {{b}} {{c}}");
    expect(out.unresolved.sort()).toEqual(["a", "b", "c"]);
  });

  it("reports a blank once however many times it appears", () => {
    const out = renderEmail({ subject: "{{x}}", body: "{{x}} {{x}}", data: {} });
    expect(out.unresolved).toEqual(["x"]);
  });

  it("renders an empty template without throwing", () => {
    expect(renderEmail({ subject: "", body: "", data: {} })).toEqual({
      subject: "",
      body: "",
      unresolved: [],
    });
  });
});

describe("unknown placeholders", () => {
  it("keeps a typo visible in the output instead of swallowing it", () => {
    // The whole point: a typo is caught in preview, not in front of a customer.
    const out = renderEmail({
      subject: "Hello {{custmer_name}}",
      body: "Total {{typo_field}}",
      data: { customer_name: "Maria", amount: "$10.00" },
    });
    expect(out.subject).toBe("Hello {{custmer_name}}");
    expect(out.body).toBe("Total {{typo_field}}");
    expect(out.unresolved.sort()).toEqual(["custmer_name", "typo_field"]);
  });

  it("names the placeholders a template has no field for", () => {
    expect(unknownTokens("{{vendor_name}} {{typo_field}}", "vendor_order")).toEqual(["typo_field"]);
    // A hand-made template declares no fields, so everything is unknown to the
    // engine — the old global catalogue is what judges those.
    expect(unknownTokens("{{vendor_name}}", "template_123")).toEqual(["vendor_name"]);
  });

  it("does not half-eat the old catalog's own spelling", () => {
    // {Job.SiteAddress.Full} belongs to merge-keys.ts. The engine's pattern is
    // deliberately tight so it passes straight through untouched.
    const out = renderEmail({
      subject: "",
      body: "{Job.SiteAddress.Full} and {{job_address}}",
      data: { job_address: "14 Fairmount Avenue" },
    });
    expect(out.body).toBe("{Job.SiteAddress.Full} and 14 Fairmount Avenue");
    expect(out.unresolved).toEqual([]);
  });
});

describe("multiline bodies", () => {
  it("fills blanks across every line, including the last", () => {
    const body = [
      "Dear {{customer_name}},",
      "",
      "Your total is {{amount}}.",
      "",
      "{{company_name}}",
    ].join("\n");
    const out = renderEmail({
      subject: "",
      body,
      data: { customer_name: "Maria", amount: "$10.00", company_name: "Gold Star Restoration" },
    });
    expect(out.body.split("\n")).toEqual([
      "Dear Maria,",
      "",
      "Your total is $10.00.",
      "",
      "Gold Star Restoration",
    ]);
  });

  it("substitutes a value that is itself multiline, keeping its line breaks", () => {
    // {{order_lines}} is the one that does this, and it is the field most
    // likely to break a layout.
    const out = renderEmail({
      subject: "",
      body: "<p>{{order_lines}}</p>",
      data: { order_lines: "2 × Duct Tape\n4 × Shockwave" },
    });
    expect(out.body).toBe("<p>2 × Duct Tape\n4 × Shockwave</p>");
  });

  it("reports a blank on line nine as readily as one on line one", () => {
    const body = Array.from({ length: 9 }, (_, i) => `line ${i}`).join("\n") + "\n{{missing}}";
    expect(renderEmail({ subject: "", body, data: {} }).unresolved).toEqual(["missing"]);
  });
});

describe("fields per template key", () => {
  it("gives each key its own list, not one shared list", () => {
    const vendor = fieldsFor("vendor_order").map((f) => f.token);
    const receipt = fieldsFor("receipt").map((f) => f.token);
    // A vendor order has no customer, and a receipt has no order lines.
    expect(vendor).toContain("order_lines");
    expect(vendor).not.toContain("customer_name");
    expect(receipt).toContain("customer_name");
    expect(receipt).not.toContain("order_lines");
  });

  it("offers nothing for a hand-made template", () => {
    expect(fieldsFor("template_123")).toEqual([]);
    expect(sampleDataFor(null)).toEqual({});
  });

  it("declares no field twice within a template", () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const tokens = EMAIL_TEMPLATE_FIELDS[key].map((f) => f.token);
      expect(new Set(tokens).size, `${key} repeats a field`).toBe(tokens.length);
    }
  });

  it("gives every field a sample, so a preview is never half-filled", () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      for (const f of EMAIL_TEMPLATE_FIELDS[key]) {
        expect(f.sample.trim(), `${key}.${f.token} has no sample`).not.toBe("");
        expect(f.label.trim()).not.toBe("");
      }
    }
  });
});

describe("the default wording", () => {
  it("uses only fields its own template declares", () => {
    // A default that shipped with a blank nothing can fill would preview broken
    // on day one, for every office.
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const t = EMAIL_TEMPLATE_DEFAULTS[key];
      expect(
        unknownTokens(`${t.subject}\n${t.body}`, key),
        `${key} uses an undeclared field`,
      ).toEqual([]);
    }
  });

  it("previews with every blank filled, for all five", () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const t = EMAIL_TEMPLATE_DEFAULTS[key];
      const out = renderEmail({ subject: t.subject, body: t.body, data: sampleDataFor(key) });
      expect(out.unresolved, `${key} previews with an unfilled blank`).toEqual([]);
    }
  });

  it("reuses the existing email_category enum, so no enum value is added", () => {
    // Adding one would need its own transaction — the reason the payment
    // receipt could not be seeded for a month.
    // 'reminder' is in the enum since 20260804184212 — reused, not added.
    const allowed = ["payment_receipt", "estimate", "invoice", "notification", "reminder"];
    for (const key of EMAIL_TEMPLATE_KEYS) {
      expect(allowed).toContain(EMAIL_TEMPLATE_DEFAULTS[key].category);
    }
  });
});

describe("renderEmailTemplate — what everything composing email calls", () => {
  const rows = [
    {
      key: "vendor_order",
      subject: "PO {{order_number}}",
      body: "Hi {{vendor_name}}",
      is_active: true,
    },
  ];

  it("prefers the wording staff have edited in Admin", () => {
    const out = renderEmailTemplate(
      "vendor_order",
      { order_number: "PO-1184", vendor_name: "Jon-Don" },
      rows,
    );
    expect(out.subject).toBe("PO PO-1184");
    expect(out.body).toBe("Hi Jon-Don");
    expect(out.usedDefault).toBe(false);
  });

  it("falls back to the built-in wording when the row is not there", () => {
    // A database that has not had the seed migration must still compose.
    const out = renderEmailTemplate("receipt", { customer_name: "Maria" }, rows);
    expect(out.usedDefault).toBe(true);
    expect(out.body).toContain("Dear Maria,");
  });

  it("works with no templates supplied at all", () => {
    expect(renderEmailTemplate("intake_confirmation", {}).usedDefault).toBe(true);
  });

  it("reports a disabled template rather than deciding for the caller", () => {
    const off = [{ key: "receipt", subject: "s", body: "b", is_active: false }];
    expect(renderEmailTemplate("receipt", {}, off).isActive).toBe(false);
    expect(renderEmailTemplate("receipt", {}, rows).isActive).toBe(true);
  });
});

describe("the seed migration", () => {
  it("seeds all five keys", () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      expect(MIGRATION, `${key} is not seeded`).toContain(`'${key}',`);
    }
  });

  it("seeds the same subject line the code falls back to", () => {
    // The two must not drift: the app renders the code default when the row is
    // missing, so a difference means two different emails for one template.
    for (const key of EMAIL_TEMPLATE_KEYS) {
      const subject = EMAIL_TEMPLATE_DEFAULTS[key].subject.replace(/'/g, "''");
      expect(MIGRATION, `${key} subject differs from the code default`).toContain(`'${subject}'`);
    }
  });

  it("seeds the same body, line for line", () => {
    for (const key of EMAIL_TEMPLATE_KEYS) {
      for (const line of EMAIL_TEMPLATE_DEFAULTS[key].body.split("\n")) {
        expect(MIGRATION, `${key} body line missing: ${line}`).toContain(
          `'${line.replace(/'/g, "''")}'`,
        );
      }
    }
  });

  it("adopts the receipt template that already exists instead of duplicating it", () => {
    // 20260910010000 warned that a second template of one purpose makes
    // JobEmailDialog's auto-select a coin toss.
    expect(MIGRATION).toContain("SET key = 'receipt'");
    expect(MIGRATION).toContain("WHERE key = 'payment_receipt_default'");
  });

  it("never overwrites wording an office has already edited", () => {
    expect(MIGRATION).toContain("ON CONFLICT DO NOTHING");
    expect(MIGRATION).not.toMatch(/ON CONFLICT[\s\S]{0,60}DO UPDATE/);
    expect(MIGRATION).not.toMatch(/UPDATE public\.email_templates\s+SET (subject|body|name)/);
  });

  it("adds who-last-edited without widening who may edit", () => {
    // RLS is the boundary and is deliberately untouched: a new column inherits
    // the table's existing admin-only write policy.
    expect(MIGRATION).toContain("ADD COLUMN IF NOT EXISTS updated_by uuid");
    expect(MIGRATION).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY|DISABLE ROW LEVEL/);
  });

  it("composes only — it builds nothing that could send", () => {
    /*
     * Not a blunt search for "send": two of the five keys are literally called
     * estimate_send and invoice_send, and the file's own header says NOTHING
     * HERE SENDS ANYTHING. The assertion is about machinery, against the
     * statements rather than the prose.
     */
    // The engine's own migration: the automation one (20260926121000) owns a
    // validator function and is checked in automation-jobs.test.ts.
    const statements = ENGINE_MIGRATION.split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    expect(statements).not.toMatch(/pg_net|net\.http|email_messages/i);
    expect(statements).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)/i);
    // It touches one table, and only to add a column and five rows.
    expect(statements).not.toMatch(/CREATE TABLE|DROP TABLE|DELETE FROM/i);
  });
});
