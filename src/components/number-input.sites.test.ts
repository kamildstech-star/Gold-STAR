import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, from a screenshot of Set Goals reading "$ 100000": "add commas for
 * thousands millions hundred thousands, etc".
 *
 * There was no shared money box — 55 files carried their own bare
 * `inputMode="decimal"` or `type="number"` input — so the commas had to be
 * swept in site by site. This pins each converted site to the shared
 * `NumberInput`, and pins a handful of fields that were deliberately left
 * alone, so a later edit cannot quietly put a spinner back on a price or,
 * worse, start grouping a year or a percentage.
 *
 * Source-level, per the brief: there is no DOM testing library here. Each
 * assertion extracts the one element by a prop that only it carries, so an
 * explanatory comment elsewhere in the file cannot satisfy or break it.
 */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

/** Every self-closing JSX element named `tag` in `source`. */
function elements(source: string, tag: string): string[] {
  return source.match(new RegExp(`<${tag}\\b[\\s\\S]*?/>`, "g")) ?? [];
}

/**
 * The self-closing element of any tag that carries `anchor` (a prop text
 * unique to the field). A regex cannot pair the braces of an arrow-function
 * prop, so this walks from each `<Tag` to the `/>` at brace depth zero.
 */
function fieldWith(source: string, anchor: string): { tag: string; text: string }[] {
  const out: { tag: string; text: string }[] = [];
  const open = /<([A-Za-z][\w.]*)\b/g;
  for (const m of source.matchAll(open)) {
    let depth = 0;
    for (let i = m.index + m[0].length; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      else if (depth === 0 && ch === "/" && source[i + 1] === ">") {
        const text = source.slice(m.index, i + 2);
        if (text.includes(anchor)) out.push({ tag: m[1]!, text });
        break;
      } else if (depth === 0 && ch === ">") break; // has children; not a field
    }
  }
  return out;
}

type Site = { file: string; anchor: string; count?: number; why: string };

const CONVERTED: Site[] = [
  // The screenshot.
  {
    file: "src/routes/_authenticated/team-goals.tsx",
    anchor: "value={revenue}",
    why: "Revenue goal — the field in Mark's screenshot",
  },
  { file: "src/routes/_authenticated/team-goals.tsx", anchor: "value={jobs}", why: "Jobs goal" },
  // Insurance limits and coverage: seven-figure numbers.
  {
    file: "src/components/account-compliance.tsx",
    anchor: 'value={limits[k.key] ?? ""}',
    why: "Required insurance limit",
  },
  {
    file: "src/components/compliance-files.tsx",
    anchor: "value={amount}",
    why: "Covered limit on a compliance file",
  },
  {
    file: "src/components/credential-upload-dialog.tsx",
    anchor: "value={d.limit_occurrence}",
    why: "Per-occurrence limit",
  },
  {
    file: "src/components/credential-upload-dialog.tsx",
    anchor: "value={d.limit_aggregate}",
    why: "Aggregate limit",
  },
  {
    file: "src/routes/_authenticated/networks.tsx",
    anchor: 'value={limits[k.key] ?? ""}',
    why: "Network required limit",
  },
  {
    file: "src/routes/_authenticated/vendors.$id.tsx",
    anchor: "value={amount}",
    why: "Vendor covered amount",
  },
  // Money drafts held as strings.
  {
    file: "src/components/commission-tier-card.tsx",
    anchor: "value={minAmount}",
    why: "Commission tier from-amount",
  },
  {
    file: "src/components/director/affiliates-panel.tsx",
    anchor: "value={refForm.amount_owed}",
    why: "Referral amount owed",
  },
  { file: "src/components/entity-kinds.tsx", anchor: "value={cost}", why: "Gift item unit cost" },
  {
    file: "src/components/quick-composer.tsx",
    anchor: "value={billed}",
    why: "Quick invoice billed amount",
  },
  {
    file: "src/components/job-billing-panel.tsx",
    anchor: "value={quickDraft.billed}",
    why: "Quick invoice billed amount (job)",
  },
  {
    file: "src/components/add-payment-dialog.tsx",
    anchor: "value={draft.received}",
    why: "Payment amount received",
  },
  {
    file: "src/components/add-payment-dialog.tsx",
    anchor: "value={draft.applied[inv.id]}",
    why: "Amount applied to each ticked invoice",
  },
  {
    file: "src/components/job-billing-panel.tsx",
    anchor: "defaultValue={i.approved_amount}",
    why: "Approved amount per invoice",
  },
  {
    file: "src/routes/_authenticated/expenses.index.tsx",
    anchor: "value={amount}",
    count: 2,
    why: "Spend approval and log spend amounts",
  },
  {
    file: "src/routes/_authenticated/jobs.new.tsx",
    anchor: "value={deductible}",
    why: "Deductible",
  },
  {
    file: "src/routes/_authenticated/jobs.new.tsx",
    anchor: "value={agreedPrice}",
    why: "Agreed price",
  },
  {
    file: "src/routes/_authenticated/jobs.new.tsx",
    anchor: "value={depositAmount}",
    why: "Deposit taken",
  },
  {
    // The show form moved out of the list page so the show's own page could
    // open it too (Mark: the Edit button "just takes you back to the page").
    file: "src/components/tradeshow-show-dialog.tsx",
    anchor: "value={cost}",
    why: "Trade show cost",
  },
  {
    file: "src/routes/_authenticated/admin.gift-catalog.tsx",
    anchor: "value={cost}",
    why: "Gift catalog unit cost",
  },
  {
    // The labor charge by office (Billing & Costs › Client Agreements until
    // prompt 4). The crew COST is the overhead engine's now (prompt 3).
    file: "src/components/admin/labor-rates-section.tsx",
    anchor: 'value={drafts[o.id] ?? ""}',
    why: "Office labor charge rate",
  },
  {
    file: "src/components/people/person-pay-panel.tsx",
    anchor: "value={salary}",
    why: "Annual base salary",
  },
  {
    file: "src/components/people/person-pay-panel.tsx",
    anchor: "value={hourly}",
    why: "Hourly rate",
  },
  { file: "src/components/people/person-pay-panel.tsx", anchor: "value={draw}", why: "Draw" },
  {
    file: "src/components/people/person-pay-panel.tsx",
    anchor: "value={flat}",
    why: "Flat commission",
  },
  {
    file: "src/routes/_authenticated/equipment.index.tsx",
    anchor: "value={cost}",
    why: "Equipment purchase cost",
  },
  {
    file: "src/routes/_authenticated/goals.index.tsx",
    anchor: "value={target}",
    count: 2,
    why: "Goal target and annual target",
  },
  {
    file: "src/routes/_authenticated/goals.index.tsx",
    anchor: "onCommit={(n) => editMonth(",
    why: "Monthly goal targets",
  },
  {
    file: "src/routes/_authenticated/leaderboard.index.tsx",
    anchor: "value={form.target}",
    why: "Challenge target",
  },
  // The supply request form moved to src/components/supply-order-form.tsx when
  // it was rebuilt Job-Calculator-style (David, 16 Sep). The quantity box is
  // now one per catalogue row rather than one per draft line, so the anchor
  // changed with it — the field it pins is the same field.
  {
    file: "src/components/supply-order-form.tsx",
    anchor: "value={quantities[item.id] ?? 0}",
    why: "Supply order quantity",
  },
  {
    file: "src/routes/_authenticated/supplies.index.tsx",
    anchor: "value={use[r.item_id] ?? 0}",
    why: "Inventory mark-down quantity",
  },
  {
    file: "src/routes/_authenticated/supplies.index.tsx",
    anchor: "value={shownPrice}",
    why: "Supply purchase unit price",
  },
  {
    // Moved to the unit's own page in Equipment (23 Oct).
    file: "src/routes/_authenticated/equipment.$equipmentId.tsx",
    anchor: 'aria-label="Daily rate ($)"',
    why: "Per-unit daily rate",
  },
  {
    // Cost rates › Materials & supplies, moved whole to Billing & Costs ›
    // Cost › Supplies book (prompt 3).
    file: "src/components/billing-costs/supply-book.tsx",
    anchor: "defaultValue={s.unit_cost}",
    why: "Supply unit cost",
  },
  // Cells that save on blur through `num()`, which is parseFloat-based and
  // would have read "1,250" as 1 had they kept reading e.target.value.
  {
    file: "src/components/estimate-editor.tsx",
    anchor: "defaultValue={pct ?? amount}",
    why: "Estimate discount amount",
  },
  {
    file: "src/components/invoice-editor.tsx",
    anchor: "defaultValue={pct ?? amount}",
    why: "Invoice discount amount",
  },
  {
    file: "src/components/invoice-editor.tsx",
    anchor: "defaultValue={inv.billed_amount}",
    why: "Invoice billed amount (not itemized)",
  },
  {
    file: "src/routes/_authenticated/admin.price-lists.tsx",
    anchor: "defaultValue={it.unit_price}",
    why: "Price list unit price",
  },
  // Shared field components.
  {
    file: "src/components/job-cost-breakdown.tsx",
    anchor: "onValueChange={(_, clean) => onChange(clean)}",
    why: "Cost breakdown Field (revenue, costs)",
  },
  {
    file: "src/components/job-calculator-editor.tsx",
    anchor: "onValueChange={(n) => onChange(numberValue(n))}",
    why: "Job calculator NumberField",
  },
  {
    file: "src/components/job-calculator-editor.tsx",
    anchor: "onValueChange={(n) => updateEquipment(",
    why: "Job calculator equipment quantity",
  },
  {
    file: "src/components/calc-input.tsx",
    anchor: "onCommit={commit}",
    why: "Unit price (PlainNumberInput)",
  },
];

describe("money and large-count fields use the shared NumberInput", () => {
  for (const site of CONVERTED) {
    it(`${site.why} — ${site.file}`, () => {
      const source = read(site.file);
      const found = fieldWith(source, site.anchor);
      expect(found.length, `no element carries ${site.anchor}`).toBe(site.count ?? 1);
      for (const f of found) {
        expect(f.tag, `${site.anchor} is on a <${f.tag}>, not <NumberInput>`).toBe("NumberInput");
        // type="number" is exactly what the shared box exists to replace:
        // it refuses commas, and it scrolls the value under a stray wheel.
        expect(f.text).not.toContain('type="number"');
        expect(f.text).not.toMatch(/\binputMode=/);
      }
    });
  }

  it("the shared box is a text input, not type=number", () => {
    const source = read("src/components/ui/number-input.tsx");
    const rendered = elements(source, "Input").find((e) => e.includes("value={text}"));
    expect(rendered).toBeDefined();
    expect(rendered).toContain('type="text"');
    expect(rendered).not.toContain('type="number"');
  });

  it("the estimate/invoice Cost and Qty boxes (CalcInput) group a plain number as it is typed", () => {
    // With the keypad gone (29 Oct) they ARE the shared NumberInput, through
    // PlainNumberInput: it groups a number as typed and leaves a formula
    // alone. The evaluator drops commas so "1,250 / 3" still works.
    const source = read("src/components/calc-input.tsx");
    const calc = source.slice(source.indexOf("export function CalcInput"));
    expect(calc.slice(0, calc.indexOf("\n}\n"))).toContain("<PlainNumberInput");
    // The evaluator moved to formula.ts (estimates.ts re-exports it).
    const evaluator = read("src/lib/formula.ts");
    const line = evaluator.match(/const text = normalizeFormulaSymbols\([^\n]*/)?.[0] ?? "";
    expect(line).toContain('.replace(/,/g, "")');
  });
});

/**
 * Fields that must NOT group. A comma in any of these is a bug, and the
 * temptation during a sweep is to convert every numeric box in sight.
 */
const LEFT: Site[] = [
  {
    file: "src/routes/_authenticated/team-goals.tsx",
    anchor: "value={conversion}",
    why: "Conversion goal is a percentage",
  },
  {
    file: "src/components/contact-relationship.tsx",
    anchor: 'value={draft.birthday_year ?? ""}',
    why: "A birthday year: 1,985 is not a year",
  },
  {
    file: "src/routes/_authenticated/admin.locations.tsx",
    anchor: "value={form.lat}",
    why: "A latitude is a coordinate",
  },
  {
    file: "src/routes/_authenticated/expenses.index.tsx",
    anchor: "value={last4}",
    why: "Card last four digits",
  },
  {
    file: "src/components/estimate-editor.tsx",
    anchor: "defaultValue={rate}",
    why: "Tax rate override is a fraction like 0.0825",
  },
  {
    file: "src/routes/_authenticated/admin.pipelines.tsx",
    anchor: "defaultValue={Number(s.probability)}",
    why: "Stage probability is a percentage",
  },
  {
    file: "src/routes/_authenticated/notifications.index.tsx",
    anchor: 'value={current.quiet_hours_start ?? ""}',
    why: "An hour of the day",
  },
];

describe("fields where a thousands separator would be a bug are left alone", () => {
  for (const site of LEFT) {
    it(`${site.why} — ${site.file}`, () => {
      const found = fieldWith(read(site.file), site.anchor);
      expect(found.length, `no element carries ${site.anchor}`).toBeGreaterThan(0);
      for (const f of found) expect(f.tag).not.toBe("NumberInput");
    });
  }
});
