// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
 * Mark, 13 Oct: "it needs to have a pop up or a bubble or something that shows
 * that info that should be inputted into the correct fields in the job not as
 * a task". The bubble on the job, and the review panel it opens: each field
 * current -> proposed with Apply / Edit / Dismiss, Apply all, and the email
 * the values were read from.
 */
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { InfoSuggestionsBubble, InfoSuggestionsPanelBody } from "./intake-submissions-review";
import {
  buildSuggestionRows,
  type SuggestionRow,
  type SuggestionSubmission,
} from "@/lib/info-suggestions";

const SUB: SuggestionSubmission = {
  id: "sub-1",
  submitted_by_name: "Jane Smith",
  submitted_by_email: "jane@example.com",
  created_at: "2026-10-13T15:00:00Z",
  status: "pending",
  source: "email_reply",
  source_subject: "RE: Request for information — 12 Main St",
  source_excerpt: "Date of loss: 10/3\nPower on: yes",
  source_received_at: "2026-10-13T15:00:00Z",
  fields: { loss_date: "2026-10-03", policy_number: "HO-1", site_address: "12 Main St" },
  answers: { "q-power": { bool: true } },
};

const rows = buildSuggestionRows(SUB, {
  job: { id: "job-1", loss_date: null, policy_number: "HO-OLD", address: "12 Main Street" },
  answers: {},
  questions: [{ id: "q-power", prompt: "Is the power on?", answer_type: "yes_no" }],
  contactValues: { phone: [], email: [] },
  lossTypeLabel: (id) => id,
  canSee: () => true,
});

const panel = (canEdit: (row: SuggestionRow) => boolean = () => true) =>
  renderToStaticMarkup(
    createElement(InfoSuggestionsPanelBody, {
      groups: [{ sub: SUB, rows }],
      busy: false,
      canEdit,
      onApply: () => {},
      onDismiss: () => {},
      onApplyAll: () => {},
      onDismissAll: () => {},
    }),
  );

const bubble = (collapsed: boolean) =>
  renderToStaticMarkup(
    createElement(InfoSuggestionsBubble, {
      text: "New info from Jane Smith — 4 fields to review",
      emailed: true,
      collapsed,
      pending: 4,
      onReview: () => {},
      onHide: () => {},
      onShow: () => {},
    }),
  );

const buttons = (html: string, label: string) =>
  html.match(
    new RegExp(`<button[^>]*>(?:(?!</button>).)*${label}(?:(?!</button>).)*</button>`, "g"),
  ) ?? [];
const isDisabled = (button: string) => /\sdisabled=""/.test(button);

describe("the New info bubble", () => {
  it("names the sender and the count, with Review and a way to hide it", () => {
    const html = bubble(false);
    expect(html).toContain('data-info-suggestions="bubble"');
    expect(html).toContain("New info from Jane Smith — 4 fields to review");
    expect(buttons(html, "Review")).toHaveLength(1);
    expect(html).toContain('aria-label="Hide for now"');
  });

  it("hidden, it shrinks to a chip rather than disappearing", () => {
    const html = bubble(true);
    expect(html).toContain('data-info-suggestions="chip"');
    expect(html).toContain("4 suggested updates");
  });
});

describe("the review panel", () => {
  it("lists each proposed field as current → proposed with Apply, Edit and Dismiss", () => {
    const html = panel();
    expect(html).toContain("Date of loss");
    expect(html).toContain("→ 10/03/2026");
    expect(html).toContain("HO-OLD");
    expect(html).toContain("→ HO-1");
    expect(html).toContain("(replaces the current value)");
    expect(html).toContain("Is the power on?");
    // Three applicable rows, plus the address shown for reference only.
    const count = (label: string) => html.split(`</svg> ${label}</button>`).length - 1;
    expect(count("Apply")).toBe(3);
    expect(count("Edit")).toBe(3);
    expect(count("Dismiss")).toBe(4);
    expect(html).toContain("(for reference)");
    expect(html).toContain("Apply all (3) · replaces 1");
  });

  it("shows the email the values were read from", () => {
    const html = panel();
    expect(html).toContain("email reply");
    expect(html).toContain("Subject: RE: Request for information — 12 Main St");
    expect(html).toMatch(/data-source-snippet[^>]*>[\s\S]*Date of loss: 10\/3/);
    expect(html).toContain("&lt;jane@example.com&gt;");
  });

  it("a field this person cannot edit cannot be applied", () => {
    const html = panel((r) => r.fieldId !== "f:policy_number");
    const policyRow = html.match(/<li[^>]*data-row="f:policy_number"[\s\S]*?<\/li>/)![0];
    for (const b of buttons(policyRow, "Apply")) expect(isDisabled(b)).toBe(true);
    expect(html).toContain("Apply all (2)");
  });
});
