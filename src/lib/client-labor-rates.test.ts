import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { clientListFor } from "@/lib/labour-bill-rates";
import type { PriceListAssignmentRow } from "@/lib/price-lists";

/*
 * David, 23 Oct: "I want the option to add our cost also. And to be able to
 * have different rates for different locations and clients."
 */
const asg = (over: Partial<PriceListAssignmentRow>): PriceListAssignmentRow => ({
  id: "a",
  price_list_id: "list-1",
  account_id: null,
  location_id: null,
  state_code: null,
  effective_from: "2026-01-01",
  effective_to: null,
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

describe("a client's own price list", () => {
  it("is the newest agreement in force for that client, never another client's or an office's", () => {
    const rows = [
      asg({ id: "1", price_list_id: "old", account_id: "acme", effective_from: "2025-01-01" }),
      asg({ id: "2", price_list_id: "new", account_id: "acme", effective_from: "2026-03-01" }),
      asg({ id: "3", price_list_id: "other", account_id: "globex" }),
      asg({ id: "4", price_list_id: "branch", location_id: "nj" }),
      asg({
        id: "5",
        price_list_id: "ended",
        account_id: "acme",
        effective_from: "2026-06-01",
        effective_to: "2026-07-01",
      }),
    ];
    expect(clientListFor(rows, "acme", "2026-10-23")?.price_list_id).toBe("new");
    expect(clientListFor(rows, "initech", "2026-10-23")).toBeNull();
  });
});

describe("Labor charge cards (Billing & Costs › Client Agreements until prompt 4)", () => {
  const page = readFileSync("src/components/admin/labor-rates-section.tsx", "utf8");

  it("no longer sets a labor COST — the overhead engine publishes it", () => {
    expect(page).not.toMatch(/<CardTitle[^>]*>Cost rate/);
    expect(page).not.toMatch(/supersedeRate\(/);
    const engine = readFileSync(
      "supabase/migrations/20261031120000_billing_costs_cost_and_overhead.sql",
      "utf8",
    );
    expect(engine).toMatch(/PERFORM public\.overhead_publish_labour\('gsr', office, v, eff/);
  });

  it("sets the CHARGE per office, and a client's own agreed charge", () => {
    expect(page).toMatch(/What the customer is billed/);
    expect(page).toMatch(/Client rates — a client&rsquo;s own agreed charge/);
    expect(page).toMatch(/await setClientLaborRate\(\{/);
  });

  it("a client's rate reaches the job ledger the way it reaches the invoice", () => {
    // The ledger is priced with the job's client (ledgerCharges → the invoice plan).
    const pull = readFileSync("src/lib/invoice-ledger-pull.ts", "utf8");
    expect(pull).toMatch(/account_id: job\.account_id,/);
  });
});
