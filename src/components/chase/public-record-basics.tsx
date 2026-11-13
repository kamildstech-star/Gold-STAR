import type { PublicRecordResult } from "@/lib/incident-public-record.functions";
import { publicRecordRows, sourceLine } from "@/lib/public-record/display";

/**
 * The free public-record half of the chase card's Homeowner / contact status
 * box: owner of record, property class, units, year built, last sale and
 * assessed value, with the source named. Shown before claim (Mark, 14 Oct).
 * Phone and email are not here — they unlock on claim (ContactUnlockRows).
 *
 * Presentational only; the card owns the query.
 */

const muted = "text-[11px] leading-snug text-[var(--muted-foreground)]";

export function PublicRecordBasics({
  loading,
  failed,
  result,
}: {
  loading: boolean;
  failed: boolean;
  result: PublicRecordResult | undefined;
}) {
  if (loading) return <p className={muted}>Looking up the public record…</p>;
  if (failed || !result) {
    return <p className={muted}>Could not load the public record. Try again later.</p>;
  }
  if (result.status !== "ok") return <p className={muted}>{result.reason}</p>;

  const { record } = result;
  return (
    <div>
      <dl className="space-y-1">
        {publicRecordRows(record).map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-2 text-[12px]">
            <dt className="shrink-0 text-[var(--muted-foreground)]">{k}</dt>
            <dd className="text-right font-semibold text-[var(--foreground)]">{v}</dd>
          </div>
        ))}
      </dl>
      <p className={`mt-1.5 ${muted}`}>{sourceLine(record, result.fetched_at)}</p>
    </div>
  );
}

/**
 * Contact and Phone: the paid quick skip's answer once the incident is
 * claimed, and a plain "unlocks" line before.
 */
export function ContactUnlockRows({
  claimed,
  email,
  phone,
}: {
  claimed: boolean;
  email: string | null | undefined;
  phone: string | null | undefined;
}) {
  const locked = "Unlocks when you claim";
  const rows: [string, string][] = [
    ["Contact", claimed ? (email ?? "--") : locked],
    ["Phone", claimed ? (phone ?? "--") : locked],
  ];
  return (
    <dl className="space-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-2 text-[12px]">
          <dt className="text-[var(--muted-foreground)]">{k}</dt>
          <dd
            className={
              v === locked
                ? "truncate text-[var(--muted-foreground)]"
                : "truncate font-semibold text-[var(--foreground)]"
            }
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}
