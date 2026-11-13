// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { ProposalForm } from "./proposal-form";
import { draftProblem, emptyDraft, type ProposalDraft } from "@/lib/account-proposals";

/*
 * Mark: "Is there a way to make something in the pipeline a proposal?" The
 * Create proposal dialog's body, drawn from a draft the way a rep would leave
 * it. The arithmetic is pinned in lib/account-proposals.test.ts and the
 * database fixture; this proves the screen shows it.
 */

const TEMPLATES = [
  { id: "t1", label: "Service proposal · Contract (v3)" },
  { id: "t2", label: "Vendor agreement · Vendor agreement (v1)" },
];

const filled: ProposalDraft = {
  title: "Annual water mitigation agreement",
  templateId: "t1",
  notes: "Starts in May.",
  terms: "Net 30.",
  lines: [
    { key: "a", description: "Monthly moisture survey", quantity: "2", unitPrice: "150.50" },
    { key: "b", description: "Emergency call-out retainer", quantity: "3", unitPrice: "33.33" },
  ],
};

const render = (draft: ProposalDraft, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(ProposalForm, { draft, onDraft: () => {}, templates: TEMPLATES, ...extra }),
  );

const total = (html: string, which: string) =>
  html.match(new RegExp(`data-total="${which}"[^>]*>([^<]*)<`))![1];
const lineTotal = (html: string, n: number) =>
  html.match(new RegExp(`data-line-total="${n}"[^>]*>([^<]*)<`))![1];

describe("the Create proposal form", () => {
  it("asks for a title, a template, priced lines, notes and terms", () => {
    const html = render(emptyDraft());
    expect(html).toContain('id="proposal-title"');
    expect(html).toContain('aria-label="Template"');
    for (const head of ["Description", "Qty", "Unit price", "Line total"]) {
      expect(html, head).toContain(`>${head}</th>`);
    }
    expect(html).toContain('id="proposal-notes"');
    expect(html).toContain('id="proposal-terms"');
    expect(html).toContain("Add line");
  });

  it("works out each line and the totals as the rep types", () => {
    const html = render(filled);
    expect(lineTotal(html, 1)).toBe("$301.00");
    expect(lineTotal(html, 2)).toBe("$99.99");
    expect(total(html, "subtotal")).toBe("$400.99");
    expect(total(html, "total")).toBe("$400.99");
  });

  it("starts with one empty line, nothing owed, and says what is missing", () => {
    const html = render(emptyDraft());
    expect(html.match(/aria-label="Line \d+ description"/g)).toHaveLength(1);
    expect(total(html, "total")).toBe("$0.00");
    expect(draftProblem(emptyDraft())).toBe("Give the proposal a title.");
    expect(draftProblem(emptyDraft("Annual agreement"))).toBe("Add at least one priced line.");
    expect(draftProblem(filled)).toBeNull();
  });

  it("names a bad line under the table", () => {
    const html = render({
      ...filled,
      lines: [...filled.lines, { key: "c", description: "", quantity: "1", unitPrice: "75" }],
    });
    expect(html).toContain('data-testid="proposal-errors"');
    expect(html).toContain("Line 3 needs a description.");
  });

  it("a sent proposal is shown, not edited: no Add line, no remove buttons", () => {
    const html = render(filled, { readOnly: true });
    expect(html).not.toContain("Add line");
    expect(html).not.toContain('aria-label="Remove line');
    expect(html).toMatch(/<input[^>]*id="proposal-title"[^>]*readonly=""/i);
    expect(total(html, "total")).toBe("$400.99");
  });

  it("the template is a choice while drafting and fixed once sent", () => {
    const templateTrigger = (html: string) =>
      html.match(/<button[^>]*role="combobox"[^>]*aria-label="Template"[^>]*>/)![0];
    expect(templateTrigger(render(filled))).not.toMatch(/\sdisabled=""/);
    expect(templateTrigger(render(filled, { readOnly: true }))).toMatch(/\sdisabled=""/);
  });
});
