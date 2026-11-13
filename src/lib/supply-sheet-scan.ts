/**
 * Reading Gold Star's paper Daily Supply List from a photo (12 Nov: "give the
 * supply list paper upload button also").
 *
 * The paper is the T&M rate code catalogue, one line per code with a Quantity
 * box (Daily Supply List 1.1). The vision model reads the date, the total crew
 * and every quantity written; only codes printed on that sheet are accepted.
 * Pure: the prompt, and the strict reading of the reply (untrusted data —
 * parsed, clamped, never fed into another prompt).
 */
import { TM_RATE_CODES_COMPILED } from "@/lib/tm-rate-codes";
import type { SupplyLine } from "@/lib/tm-forms";

export type ScannedSupplySheet = {
  /** The Date written on the sheet, "YYYY-MM-DD". */
  date: string | null;
  totalCrew: string;
  lines: SupplyLine[];
};

/** The codes printed on the paper, upper-case. */
export const SUPPLY_PAPER_CODES: ReadonlySet<string> = new Set(
  TM_RATE_CODES_COMPILED.map((c) => c.code.toUpperCase()),
);

const CODE_LIST = TM_RATE_CODES_COMPILED.map((c) => `${c.code} = ${c.label}`).join("\n");

export const SUPPLY_SCAN_PROMPT = `You read Gold Star Restoration's paper "Daily Supply List" from a photo and transcribe the quantities written on it.

The sheet lists rate codes, one per line, each with a Quantity box. These are the codes printed on it:
${CODE_LIST}

Return ONLY one JSON object, no prose:
{"date": "YYYY-MM-DD"|null, "total_crew": string|null, "lines": [{"code": string, "qty": number}]}

- lines: one entry for every line whose Quantity box has a number written in it. Skip lines with an empty box, a dash or a zero.
- code: the code printed at the start of that line, exactly as in the list above (e.g. "DL", "PM", "104").
- qty: the number written in its Quantity box. Decimals are allowed ("1.5"). Read each box on its own line — never shift a number to the line above or below.
- date: the Date written at the top, as YYYY-MM-DD (a two-digit year like 26 is 2026). null if none.
- total_crew: the Total Crew written at the top, as written. null if none.
Transcribe; never guess a quantity that is not written.`;

export const SUPPLY_SCAN_MAX_LINES = 120;

function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isoDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** The model's reply as a supply sheet, or null when it is not one. */
export function parseSupplyModelOutput(raw: string): ScannedSupplySheet | null {
  const o = firstJsonObject(raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.lines)) return null;
  const byCode = new Map<string, number>();
  for (const l of o.lines as Record<string, unknown>[]) {
    if (!l || typeof l !== "object") continue;
    const code = typeof l.code === "string" ? l.code.trim().toUpperCase() : "";
    if (!SUPPLY_PAPER_CODES.has(code)) continue;
    const qty = typeof l.qty === "number" ? l.qty : Number(String(l.qty ?? "").trim());
    if (!Number.isFinite(qty) || qty <= 0 || qty > 9999) continue;
    byCode.set(code, Math.round(qty * 100) / 100);
    if (byCode.size >= SUPPLY_SCAN_MAX_LINES) break;
  }
  const crew = typeof o.total_crew === "string" || typeof o.total_crew === "number";
  return {
    date: isoDate(o.date),
    totalCrew: crew
      ? String(o.total_crew)
          .replace(/[^0-9]/g, "")
          .slice(0, 3)
      : "",
    lines: [...byCode].map(([code, qty]) => ({ code, qty })),
  };
}
