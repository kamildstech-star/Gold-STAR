// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Settings › Commissions › Referrers, rendered. Mark, 7 Oct: "(in admin we
 * need to be able put the rates for each referral) ... or a flat fee". The
 * rules query is answered from a fixture; the pickers are stubs (they have
 * their own tests) so what renders is this component's own markup.
 */
let read: unknown = { available: true, rules: [] };
let roles: string[] = ["admin"];

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: read, isLoading: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ roles, writesDisabled: false, userId: "u1" }),
}));
vi.mock("@/components/account-picker", () => ({ AccountPicker: () => null }));
vi.mock("@/components/company-contact-picker", () => ({ CompanyContactPicker: () => null }));

import { ReferralCommissionRulesAdmin } from "./referral-commission-rules-admin";

const RULES = [
  {
    id: "r1",
    account_id: "a1",
    contact_id: null,
    kind: "percent",
    value: 8,
    effective_from: null,
    effective_to: null,
    payee_type: "account",
    payee_name: "Acme Brokers",
  },
  {
    id: "r2",
    account_id: null,
    contact_id: "c1",
    kind: "flat",
    value: 250,
    effective_from: "2026-07-01",
    effective_to: null,
    payee_type: "contact",
    payee_name: "Jane Broker",
  },
];

const render = () => renderToStaticMarkup(createElement(ReferralCommissionRulesAdmin));

describe("the referrer rules on Settings › Commissions", () => {
  it("lists a company deal and a person's flat fee, and says what a percent is of", () => {
    read = { available: true, rules: RULES };
    roles = ["admin"];
    const html = render();
    expect(html.match(/data-rule-row/g)).toHaveLength(2);
    expect(html).toContain("Acme Brokers");
    expect(html).toContain("8% of revenue");
    expect(html).toContain("Jane Broker");
    expect(html).toContain("$250.00 flat");
    expect(html).toContain("2026-07-01 → open");
    const base = html.match(/<p[^>]*data-commission-base[^>]*>([\s\S]*?)<\/p>/)![1];
    expect(base).toContain("invoiced");
    expect(base).toContain("flat fee per job");
  });

  it("gives an admin the add form and 44px controls on a phone", () => {
    read = { available: true, rules: RULES };
    roles = ["admin"];
    const html = render();
    expect(html).toContain("data-add-rule");
    expect(html).toContain("Add deal");
    const remove = html.match(
      /<button[^>]*aria-label="Remove the rule for Acme Brokers"[^>]*>/,
    )![0];
    expect(remove).toContain("size-11");
  });

  it("shows a non-admin the deals but no way to change them", () => {
    read = { available: true, rules: RULES };
    roles = ["office"];
    const html = render();
    expect(html).toContain("Acme Brokers");
    expect(html).not.toContain("data-add-rule");
    expect(html).not.toContain("Remove the rule");
    expect(html).not.toContain("Only an owner or admin");
  });

  it("before the migration, says so instead of failing", () => {
    read = { available: false, rules: [] };
    roles = ["admin"];
    const html = render();
    expect(html).toContain("data-rules-unavailable");
    expect(html).not.toContain("data-add-rule");
  });
});
