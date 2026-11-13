/**
 * What the invoice review pop-up shows (David, 21 Oct): every line and the
 * hours behind it, for a person to check before the draft goes anywhere.
 * Pure, so the arithmetic is tested without a DOM.
 */
import { roundMoneyLoose } from "@/lib/money";

/** Units that are hours of labour. Lines are written "HR" by the pulls. */
const HOUR_UOMS = new Set(["HR", "HRS", "HOUR", "HOURS", "MH"]);

export function isHourUom(uom: string | null | undefined): boolean {
  return HOUR_UOMS.has((uom ?? "").trim().toUpperCase());
}

export type ReviewLine = {
  id: string;
  name: string;
  description: string | null;
  uom: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  is_discount: boolean;
  scope_id: string | null;
};

export type ReviewGroup = { scopeId: string | null; name: string; lines: ReviewLine[] };

export type InvoiceReview = {
  groups: ReviewGroup[];
  lineCount: number;
  hours: number;
  /** Sum of the line subtotals, discounts already negative in their rows. */
  linesTotal: number;
  /** Lines at $0 — usually a supply with no charge rate; worth a second look. */
  unpriced: number;
};

/**
 * Lines grouped by scope in scope order, lines without a scope last, each
 * group in line order — the order the invoice prints in.
 */
export function invoiceReview(
  lines: readonly ReviewLine[],
  scopes: readonly { id: string; name: string; position: number }[],
): InvoiceReview {
  const ordered = [...scopes].sort((a, b) => a.position - b.position);
  const known = new Set(ordered.map((s) => s.id));
  const groups: ReviewGroup[] = ordered.map((s) => ({
    scopeId: s.id,
    name: s.name,
    lines: lines.filter((l) => l.scope_id === s.id),
  }));
  const loose = lines.filter((l) => !l.scope_id || !known.has(l.scope_id));
  if (loose.length)
    groups.push({ scopeId: null, name: groups.length ? "Other" : "", lines: loose });
  const round2 = roundMoneyLoose;
  return {
    groups: groups.filter((g) => g.lines.length),
    lineCount: lines.length,
    hours: round2(lines.reduce((s, l) => s + (isHourUom(l.uom) ? Number(l.quantity) || 0 : 0), 0)),
    linesTotal: round2(lines.reduce((s, l) => s + (Number(l.subtotal) || 0), 0)),
    unpriced: lines.filter((l) => !l.is_discount && Number(l.unit_price) === 0).length,
  };
}
