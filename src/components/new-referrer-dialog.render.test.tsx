// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * "+ New referrer" on the General tab, rendered. Mark, 7 Oct: "and allow them
 * to create a new person on the general tab as well with a commission rate".
 * The CRM's create dialog is a stub here (it has its own tests); the first
 * step's fields are rendered directly because a closed portal renders nothing.
 */
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ roles: ["office"], writesDisabled: false, userId: "u1" }),
}));
vi.mock("@/components/create-customer-dialog", () => ({ CreateCustomerDialog: () => null }));

import { NewReferrerButton, NewReferrerDealFields } from "./new-referrer-dialog";

const fields = (canSetRates: boolean, problem: string | null = null) =>
  renderToStaticMarkup(
    createElement(NewReferrerDealFields, {
      who: "person",
      onWho: () => {},
      kind: "percent",
      onKind: () => {},
      value: null,
      onValue: () => {},
      canSetRates,
      problem,
    }),
  );

describe("the New referrer step", () => {
  it("asks who and what they are paid, percent or flat", () => {
    const html = fields(true);
    expect(html).toContain('aria-label="Referrer is a person or company"');
    expect(html).toContain('aria-label="Percentage or flat fee"');
    expect(html).toContain('aria-label="Referrer rate percent"');
    expect(html).toMatch(/of the job.s revenue/);
    expect(html).not.toContain("data-rates-need-admin");
  });

  it("someone who cannot set rates is not shown the rate at all", () => {
    const html = fields(false);
    expect(html).toContain('aria-label="Referrer is a person or company"');
    expect(html).not.toContain('aria-label="Percentage or flat fee"');
    expect(html).not.toContain('aria-label="Referrer rate percent"');
    expect(html).not.toContain("owner or admin");
    expect(html).not.toMatch(/ disabled=""/);
  });

  it("shows the problem with a value", () => {
    expect(fields(true, "A percentage is between 0 and 100.")).toContain("between 0 and 100");
  });

  it("the button is a 44px tap target on a phone", () => {
    const html = renderToStaticMarkup(
      createElement(NewReferrerButton, { jobId: "j1", account: null, onDone: () => {} }),
    );
    const btn = html.match(/<button[^>]*>[\s\S]*?New referrer[\s\S]*?<\/button>/)![0];
    expect(btn).toContain("h-11");
  });

  it("is no longer a second way to add a referrer on the General tab", () => {
    // David, 21 Oct: one path — "Referred by" offers "Add contact" inline.
    const panel = readFileSync("src/components/job-referral-panel.tsx", "utf8");
    expect(panel).not.toMatch(/<NewReferrerButton/);
    const picker = readFileSync("src/components/company-contact-picker.tsx", "utf8");
    expect(picker).toMatch(/Add contact “\$\{term\}”/);
  });
});
