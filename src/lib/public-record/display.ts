/**
 * Words for the chase card's public-record block (public-record-basics.tsx):
 * the rows, the source line, and calendar dates. Pure, so the card's text is
 * tested without rendering it.
 */
import type { PublicRecord } from "./sources";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

/** "2006-03-31" -> "Mar 31, 2006", read as a calendar date (no timezone shift). */
export function formatRecordDate(iso: string | null): string | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(DATE_LOCALE, { ...US_DATE, timeZone: "UTC" });
}

/** "Public record — NYC PLUTO 26v2 · pulled Oct 14, 2026" */
export function sourceLine(record: PublicRecord, fetchedAt: string | null): string {
  let vintage = "";
  if (record.source === "nj_modiv") {
    const d = formatRecordDate(record.source_vintage);
    if (d) vintage = `, updated ${d}`;
  } else if (record.source === "nys_parcels" && record.source_vintage) {
    vintage = `, ${record.source_vintage}`;
  }
  const pulled = formatRecordDate(fetchedAt);
  return `Public record — ${record.source_label}${vintage}${pulled ? ` · pulled ${pulled}` : ""}`;
}

export function publicRecordRows(record: PublicRecord): [string, string][] {
  const owner = record.owner_name
    ? record.owner_name
    : record.owner_withheld
      ? "Withheld in NJ public data (Daniel's Law)"
      : "Not in public record";
  const cls = record.property_class_label
    ? `${record.property_class_label}${record.property_class ? ` (${record.property_class})` : ""}`
    : record.property_class;
  const saleDate = formatRecordDate(record.last_sale_date);
  const sale =
    saleDate && record.last_sale_amount
      ? `${usd.format(record.last_sale_amount)} · ${saleDate}`
      : record.last_sale_amount
        ? usd.format(record.last_sale_amount)
        : saleDate
          ? `${saleDate} (no price on record)`
          : null;
  const rows: [string, string | null][] = [
    ["Owner of record", owner],
    ["Property", cls],
    ["Units", record.unit_count ? String(record.unit_count) : null],
    ["Year built", record.year_built ? String(record.year_built) : null],
    ["Last sale", sale],
    ["Assessed", record.assessed_value ? usd.format(record.assessed_value) : null],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}
