# Billing & Costs rebuild — closure (prompt 5 of 5)

Branch `billing-and-costs`. Read with `P1-INVENTORY.md`. Everything here is on the branch and covered by the tests named; nothing is applied to a database until the branch merges (the migrations run on merge to `main`).

## Migrations, in apply order

| # | File | Seeds / guards |
|---|---|---|
| P1 | `20261029120000_billing_costs_foundation.sql` | Money audit log (append-only); `catalog_items` seeded from the T&M codes (labor, consumable, PPE, vehicle), counts checked old vs new; `money_values` + `resolve_money_value`. |
| P2 | `20261030120000_billing_costs_rules_and_tm_rates.sql` | Every T&M rate seeded into `money_values` (stops on a mismatch); equipment-type rates from the catalog default; General rules + 5 charges from the old setting (tax carried hidden); equipment codes mapped to types. |
| P3 | `20261031120000_billing_costs_cost_and_overhead.sql` | Every code cost carried (stops on a mismatch); equipment-type costs from units / the field-ticket card; overhead engine, Wage seeded from the field crew's labor rates (today's rate guaranteed); `tm_cost_rates`; equipment types as data. |
| P4 | `20261101120000_billing_costs_client_agreements.sql` | Standard rates = catalog default + each office's branch list (stops if any office × item differs today); lists become agreements / office / state; job rate sources + regular-rate freeze; Estimate catalog merged into Catalogs (stops if merged + flagged ≠ old count); P3 follow-ups. |
| P5 | `20261102120000_billing_costs_one_book.sql` | The T&M sheet moves into Catalogs (stops if any old code differs); mirror dropped both ways; `tm_rate_codes` read-only; every new job freezes its General rules, charges and minimum margin; billing version 5; T&M-job estimates from T&M Rates; "strip lines equal to Standard". |
| P5 | `20261103120000_billing_costs_one_engine.sql` | `job_revenue` (one revenue ladder); `job_profitability` on it, on Eastern calendar equipment days, rejected time uncosted; `job_cost_breakdown` / `company_money_summary` on `rate_for`. |

Dry run (nothing written): `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/dry-runs/billing-costs-dry-run.sql`.

## Census closure (P1 formula census §B)

| Area | Before | Now | Figures that change |
|---|---|---|---|
| Rounding | ~15 private `round2`/`cents` helpers, an EPSILON style, an integer-cent style | One rule, `src/lib/money.ts` (integer cents, half away from zero); every helper is now an alias of `roundMoney`; SQL rounds once per output with `ROUND(x,2)`, also half away | Only exact half-cent values that floating point used to round down (e.g. 1.005 → 1.01) and negative half-cents (−0.005 → −0.01) |
| T&M premium column | `round2(total − rate × regular)` vs the workbook's `round2(rate × regular)` — could be a cent off | `premiumPart`: regular printed to the cent, premium = total − regular | Lines where the two disagreed now add up; totals unchanged (Lallypak exact) |
| Line vs total | Pull-from-job / ledger totals summed unrounded line amounts | Totals are the sum of the printed lines | At most a cent on a document whose lines each had a half-cent |
| Equipment days | Three rules: Eastern calendar days (running cost, equipment panel), CEIL of 24-hour periods (`job_profitability`), runtime-local calendar days (T&M bill), fractional days (equipment report) | One: Eastern calendar days, drop-off = day 1 (`gsr_local_date` / `equipmentDaysOnSite` / `officeDate`) | `job_profitability` days (e.g. 11 PM → 1 AM two days later: 2 → 3); the equipment report's days are whole days |
| Labor rate | `rate_for` (running cost, profitability); "any rate with no person" (`job_cost_breakdown`, `company_money_summary`); first company-wide row of any kind (field-ticket costing) | `rate_for(user, work_date)` in SQL; field crew `gsr` rate on the work date for tickets; `laborAmount` for every hours × rate | Breakdown / company summary labor where a role rate exists; tickets that previously picked a non-crew row |
| Revenue | Five rules | `job_revenue`: non-draft invoices (approved, else billed) → approved estimates → agreed price → sent → draft estimate → cost-line revenue | `job_profitability` and `company_money_summary` no longer count draft invoices |
| Job ledger Labor (P5.1) | All the ledger's hours × TODAY's office crew rate | The running cost's labour: each day's hours at that day's crew rate (hours typed on the ledger still use the office rate) | A job whose hours span a wage change, e.g. 40 h shown as 1,800.00 at today's 45.00 now 1,200.00 as actually costed |
| Deliberately not changed | Commission bases (`compute_job_commissions`, `rep_profitability`) read job columns | — | Deferred: revenue basis switch = owner decision |
| Rounding, two forms | — | `roundMoney` (strict, refuses a non-number) in every persisted / billing path; `roundMoneyLoose` (same rule, passes a non-number through as the old helpers did) only in display paths: running-cost panel and `sumOfSources`, account statement, commissions / comparison reports, invoice follow-ups and review, job ledger and its report, report totals, supply spend, T&M job cost readout, vehicle maintenance totals, the supplies list | — |

## Retired surfaces → where their job lives now

| Retired | Now |
|---|---|
| Settings › T&M rate codes (`/admin/tm-rate-codes`, redirects) | Rates: Billing & Costs › T&M Rates. Bill rules: General rules. Costs: Cost. Codes (all sections, incl. Equipment & Supply-list charges): Catalogs. Small Tools: T&M Rates › Labor. |
| Settings › Cost rates (`/admin/equipment-rates`, redirects) and Labor rates (`/admin/labour-rates`, redirects) | Crew wage: Cost › Overhead engine. Labor by office: Cost › Compare offices. Charge rates: Client Agreements › Standard (GSC-LABOR-REG per office). Client rates: agreements. Supplies: Cost › Supplies book. Equipment type day cost: Cost › Equipment; a unit's own: its Equipment page. Minimum margin: General rules. |
| Settings › Estimate catalog (`/admin/estimate-catalog`, redirects) | Items: Catalogs (Equipment / Services / …). Prices: Client Agreements › Standard and agreements. Rows kept (lines point at them). |
| Settings › Price lists (kept, folded) | Agreements: Client Agreements. Office lists: Standard. The page remains the state-list editor, with a banner. |
| Catalogs ↔ tm_rate_codes mirror | Dropped both ways; forms read `tm_sheet_codes` (Catalogs). `tm_rate_codes` read-only history. |

## Freeze proof (no later publish reaches a job made after it)

| Book | Fixture |
|---|---|
| T&M rates | `billing-costs-one-book.pglite.mjs` (91.00 kept after a 95.00 publish); P2 fixture |
| Costs (incl. engine labor) | `billing-costs-one-book.pglite.mjs` (61.00 kept after 70.00); `billing-costs-cost-overhead.pglite.mjs` (old and frozen jobs through an engine publish); `src/lib/tm-job-cost.freeze.test.ts` |
| Regular rates / agreements | `billing-costs-agreements.pglite.mjs`; `billing-costs-one-book.pglite.mjs` (60.00 kept after 57.00) |
| General rules + charges + minimum margin | `billing-costs-one-book.pglite.mjs` (overtime mode kept after a change; charges frozen) |

Jobs made before the merge have no snapshot rows and read as they always did (the value in force on their creation date where the resolver is dated).

Not frozen, by design (question in the report): the running cost and job ledger cost hours at the wage in force on the day worked — that is actual payroll cost, not a price.

## Deferred (post-launch)

| Item | Why deferred |
|---|---|
| Commission revenue basis (`compute_job_commissions`, `rep_profitability` read job columns, not `job_revenue`) | Revenue basis switch = owner decision (contractual) |
| State lists folded into agreements or Standard | Kept as their layer this series (P5 answer 2) |
| HEPA register units onto Air scrubber | Needs one price for both types first |
| Overhead engine publish timing | Owner enters GL / WC, then publishes |
| Permissions deep pass | Out of scope |
| Estimates UX | Out of scope |
| Equipment codes with no type, merged items flagged for review | Owner review after the dry run |

## Merge checklist

1. Run the dry run on a copy of production (or production, read: it rolls back). Every NOTICE should print; no `mismatch` exception.
2. Review the NOTICE counts: catalog merge flags, unmatched equipment codes, HEPA decision, agreements with equipment lines on T&M jobs, wage scopes set to today.
3. Merge `billing-and-costs` → `main` (the migrations apply in the order above).
4. Smoke test: open Billing & Costs, every tab; make an invoice on a regular job (Pull from job, simple mode); open a T&M bill; open the Overhead engine.
5. One-time owner actions: enter General liability and Workers' comp, then Publish (or "Apply to labor costs"); review flagged units / merged items (Catalogs, `catalog_merge_review`); confirm Standard (catalog default + office lists).
