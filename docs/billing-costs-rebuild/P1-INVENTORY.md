# Billing & Costs rebuild — P1 inventory and formula census

Taken 29 Oct 2026 on `billing-and-costs`, before any change. Proposed mapping key:
**carry** (moves as is), **relocate** (moves to another tab or module), **retire**
(with a reason, only once its replacement is live), **question** (needs a decision).
Nothing has been retired yet.

## A. Screens, fields, toggles, rules

### Settings › T&M rate codes (`/admin/tm-rate-codes`, `tm_rate_codes`)
| Thing | Today | Proposed |
|---|---|---|
| 158 codes in 6 sections (Labor 28, Consumables 57, Equipment 47, PPE 13, Vehicle 7, General 6) | edited in place, each box saves on blur | Labor/Consumables/PPE/Vehicle → **Catalogs** (done, P1). Equipment → **relocate** to Equipment module types (P2/P3). General → **relocate** to General rules (P2) |
| Code (immutable), description, sort order | trigger pins code, no delete | **carry** (Catalogs) |
| Active switch | off = out of pickers, filled sheets keep it | **carry** (Catalogs Active; plus new Archive) |
| Unit note ("How it bills") free text | per code | **question** — Catalogs uses a structured unit; keep the note as a description field? |
| Rate (bill) per code, numeric(10,2) | labor /hr, supplies /unit, Per Diem /person-day, Small Tools % | **relocate** → T&M Rates tab, office-aware (P2) |
| Cost rate per code (withheld column, `tm_rate_code_costs()`) | cost viewers only | **relocate** → Cost tab (P3) |
| Unit (hr/day/each/pct/person_day) | drives bill math | **carry** in T&M book until P2; catalog has its own unit (hr/day/piece/roll/box/pair) |
| Small Tools switch per labor code | management titles off | **relocate** → General rules / T&M Rates (P2) |
| T&M bill rules card (`app_settings tm.bill_rules`): Small Tools %, Per Diem, O&P %, pass-through markup %, OH fee %, standard hours/window, daily OT threshold, OT/after-hours/weekend/holiday multipliers, tax % | company default; job override in `job_tm_settings` | **relocate** → General rules (P2). Tax: **untouched** (out of scope) |
| Job rate sheet (`job_tm_rates`) snapshotted at job creation | freeze rule already true | **carry**; extended to all books in P5 |
| Fallback: compiled Daily Supply List if table missing | | **carry** until P2 |

### Settings › Cost rates (`/admin/equipment-rates`; `/admin/labour-rates` = its Labor tab)
| Thing | Today | Proposed |
|---|---|---|
| Labor tab: cost rate per role / crew class (GSR, temp), per office or company-wide, effective-dated (`labour_rates`, supersede) | finance only | **relocate** → Cost tab (P3) on `money_values` |
| Labor tab: per-location BILL rate (price-list item `GSC-LABOR-REG`) and per-client labor rates | | **relocate** → T&M Rates / Client Agreements (P2/P4) — **question** which |
| Materials & supplies tab: supply items (name, unit, category, unit cost, charge), add/archive, duplicate-name check | cost withheld (`supply_item_costs()`); charge = matching estimate catalog item's default price | **question** — supply catalog is a separate book from T&M consumables; merge into Catalogs or keep in Supplies? |
| Equipment tab: rate by equipment type ($/day or $/3 days, apply to all units), per-unit `daily_rate_cents`, unpriced count | cost, withheld | **relocate** → Equipment module money fields, read-through in Cost (P2/P3) |
| Minimum margin (margin floor %) | app setting | **relocate** → General rules (P2) |

### Settings › Estimate catalog (`/admin/estimate-catalog`, `estimate_catalog_items`)
| Thing | Today | Proposed |
|---|---|---|
| Headers (code, active) | | **carry** for estimates (P4 rewire only) |
| Items: code, description, header, UOM, default cost (cost viewers), default price, taxable, retire | default price = the default price list | **question** — relationship to Catalogs (two item books today) |
| Quick Estimate opening/closing statements | | **carry** (estimates, out of scope) |

### Settings › Price lists (`/admin/price-lists`)
| Thing | Today | Proposed |
|---|---|---|
| Named lists (name, note, active) with per-item prices over the estimate catalog | resolution customer → office/state → catalog (`price-lists.ts`) | **relocate** → Client Agreements (P4) |
| Applies-to: customer / state / office, effective from/to | | **relocate** (P4) |
| CSV import (Code,Price) | | **carry** (P4) |

### Quiet features (must not disappear)
- **Supply vendor prices** (`supply-vendor-prices.ts`, Supplies page): per-vendor expected price, auto-pick on orders. **carry** (Supplies) — question whether Cost reads it.
- **Supply charges** (`supply-charges.ts`): charge = estimate catalog item price matched by SKU then name. **question** (P3/P4).
- **Equipment rental rates on the T&M bill** come from price lists (`tm-bill-run.ts:208`). **relocate** to T&M Rates (P2).
- **Quick invoice**: typed `billed_amount`, no line math. **carry**; tax toggles removed in P4 only.
- **Discounts** on estimates/invoices (`PCT:x` codes, targeted `LN:` lines). **carry** (out of scope).
- **Payment counts / balances** on Billing (`/billing`), payment receipts, follow-ups. **carry**.
- **Job calculator** prices off price lists (`job-calculator-pricing.ts`). **carry**, rewired P4.
- **Commissions** (referral rules, tiers). Not pricing — **carry**, untouched.
- **Gift catalog** unit costs. Not pricing — **carry**, untouched.

## B. Formula census (money-calculation sites)

Full list with line numbers was gathered by a code sweep; the headline sites:

1. **T&M bill** — `src/lib/tm-bill.ts` (`buildTmBill`, `billTotals`, `taxOn`, `smallToolsFee`, `splitHours`/`splitAmount` in `tm-bill-rules.ts`), `tm-bill-run.ts` (`insertTmBill`), `tm-job-cost.ts` (cost/margin). Lallypak test (`tm-bill-lallypak.test.ts`) pins it to the cent.
2. **Invoices/estimates** — SQL generated `subtotal` columns, `recalc_estimate_totals`, `recalc_invoice_totals`, payment and job rollups; TS `estimates.ts` (line tax/total, discounts), `estimate-sheet.ts`, editors' optimistic subtotals, invoice/estimate PDFs, `add-payment.ts` (integer cents), `payment-receipt.ts`, `invoice-paid.ts`, `invoice-followups.ts`, `account-statement.ts`, `billing.ts`.
3. **Job calculator / proposals / price lists** — `job-calculator.ts` (`roundCurrency`), `calculator-invoice.ts` (integer-cent check), `job-calculator-pricing.ts`, `price-lists.ts`, `account-proposals.ts` (integer cents).
4. **Equipment** — `equipment.ts` `equipmentDaysOnSite`, `invoice-pull.ts`, `job_running_cost` eq CTE, `job_profitability` eq CTE.
5. **Costs/profitability** — `job_running_cost`, `job_profitability`, `job_cost_breakdown`, `company_money_summary`, `rep_profitability`, `job_ticket_crew_hours` (SQL); `field-ticket-costing.ts`, `job-ledger.ts`, `invoice-ledger-pull.ts`, `job-ledger-report.ts`, `line-costs.ts`, `finance.ts`, `reports-engine.ts`, supply receipts/inventory/spend.
6. **Commissions/payroll** — `compute_job_commissions`, `job_referrer_commission`, `commission_overview`, `director_rep_cost` (SQL); `job-commission.ts` (parity-tested), `commissions.ts`, `commissions-report.ts`.
7. **Expenses** — `expense-sheet.ts`, `large-loss-expenses.ts`, `expenses.ts`.

### Inconsistencies found (not changed — questions for later prompts)
- `round2` is re-defined privately in ~15 files; three other rounding styles exist (EPSILON in the calculator, integer-cent half-away in proposals and payments).
- Hours × labor rate is computed 7+ ways (SQL and TS), some ignoring role and effective dates (`job_cost_breakdown`, `company_money_summary`, `reports-engine.ts`).
- Equipment days: three rules (T&M uses runtime-local calendar days; running cost uses office-timezone calendar days; `job_profitability` uses CEIL of 24h periods).
- Job revenue precedence differs across `job_running_cost`, `job_profitability` (counts drafts) and `compute_job_commissions`.
- Tax rounding: editors round per line, DB/PDF round the aggregate. `invoices.tax_rate` and invoice line columns are unbounded numeric; estimates are bounded.
- T&M premium column: `round2(total − rate × regular)` vs workbook's `round2(rate × regular)` — can differ by a cent.
- Supplies charge: ledger report uses catalog default (no price list); job ledger pull uses the price list.
- Salary proration /365.25 vs /365.0; rep commission cost read from two different tables.
- `labourAmount` (`labour-bill-rates.ts`) is described as the shared multiplication but has no callers.
- Lallypak: Associated Labor Fees and Total Due are $15.60 below the workbook because the workbook charged Small Tools on a management (SPM) day; the code never does.
