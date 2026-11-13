import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDateTimeUS } from "@/lib/date-format";
import { SKIP_REASON_LABEL, type SkipReason } from "@/lib/fire-feed/decide";
import type { Extraction } from "@/lib/fire-feed/extract";
import { TONE } from "@/lib/tone";

/**
 * One Fire Feed call, laid out (4 Nov: "show popup and show data in
 * presentable form, not a link in a new tab"). Settings › Fire feed and the
 * Chase cockpit's Scanner feed open this instead of the source page.
 *
 * What the feed read from the call (its `extraction`) when it has it; for an
 * older row without one, the dispatch line itself — "Alarm Sounding at 197
 * SICKLES AV, NYACK" — split into what, where and the town.
 */
export type FireFeedCallView = {
  title: string;
  source: string;
  /** When the call went out (or was read). */
  at: string | null;
  url: string | null;
  decision: "lead" | "merged" | "skipped";
  reason: string | null;
  area?: string | null;
  extraction?: Partial<Extraction> | null;
  readBy?: "ai" | "rules" | null;
};

const CATEGORY: Record<string, string> = {
  structure: "Building fire",
  brush: "Brush or grass fire",
  vehicle: "Vehicle fire",
  other_fire: "Other fire",
  not_fire: "Not a fire",
};

/** "Alarm Sounding at 197 SICKLES AV, NYACK" → what, street, town. */
export function splitDispatchLine(title: string): {
  what: string | null;
  street: string | null;
  town: string | null;
} {
  const m = /^(.*?)\s+at\s+(.+)$/i.exec(title.trim());
  if (!m) return { what: null, street: null, town: null };
  const where = m[2]!;
  const comma = where.lastIndexOf(",");
  return {
    what: m[1]!.trim() || null,
    street: (comma > 0 ? where.slice(0, comma) : where).trim() || null,
    town: comma > 0 ? where.slice(comma + 1).trim() || null : null,
  };
}

/** Plainer names for a few of the 911 feeds' own field names. */
const FIELD_LABEL: Record<string, string> = {
  Address2: "Town, state, ZIP",
  Friendly: "Place name",
  FD: "Fire district",
  ID: "Call ID",
};

const title = (s: string | null) =>
  s ? s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : null;

export function FireFeedCallDialog({
  call,
  onOpenChange,
}: {
  call: FireFeedCallView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const ex = call?.extraction ?? null;
  const details = Array.isArray(ex?.sourceDetails)
    ? ex.sourceDetails.filter(
        (d): d is [string, string] =>
          Array.isArray(d) && typeof d[0] === "string" && typeof d[1] === "string",
      )
    : [];
  const line = call ? splitDispatchLine(call.title) : { what: null, street: null, town: null };
  const street = ex?.address ?? ex?.crossStreets ?? line.street;
  const town = ex?.locality ?? line.town;
  const outcome = !call
    ? ""
    : call.decision === "lead"
      ? "Became a lead on the Chase board"
      : call.decision === "merged"
        ? "Added to an alert already on the board"
        : `Skipped — ${SKIP_REASON_LABEL[call.reason as SkipReason] ?? call.reason ?? "no reason recorded"}`;
  const flags = ex
    ? [
        ex.alarmLevel ? title(ex.alarmLevel) : null,
        ex.injuries ? "Injuries reported" : null,
        ex.fatalities ? "Fatalities reported" : null,
        ex.displaced ? "Residents displaced" : null,
      ].filter(Boolean)
    : [];
  const rows: [string, string | null][] = call
    ? [
        ["Call", line.what ?? (ex?.category ? CATEGORY[ex.category] : null) ?? call.title],
        ["Type of fire", ex?.category ? (CATEGORY[ex.category] ?? null) : null],
        ["Address", title(street)],
        ["Town", title(town)],
        ["Building", ex?.buildingType ?? ex?.occupancy ?? null],
        ["Details", flags.length ? flags.join(" · ") : null],
        ["When", call.at ? formatDateTimeUS(call.at) : null],
        ["Source", call.source],
        ["Watch area", call.area ?? null],
        ["Read by", call.readBy === "ai" ? "AI" : call.readBy === "rules" ? "Rules" : null],
      ]
    : [];

  return (
    <Dialog open={call != null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-lg"
        data-fire-feed-call-dialog
      >
        {call ? (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6 leading-snug">{title(call.title)}</DialogTitle>
              <DialogDescription asChild>
                <div>
                  <Badge
                    className={
                      call.decision === "lead"
                        ? TONE.success
                        : call.decision === "merged"
                          ? TONE.info
                          : TONE.neutral
                    }
                  >
                    {outcome}
                  </Badge>
                </div>
              </DialogDescription>
            </DialogHeader>
            <dl className="divide-y rounded-lg border text-sm">
              {rows
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[8rem_minmax(0,1fr)] gap-3 px-3 py-2">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-medium text-foreground">{v}</dd>
                  </div>
                ))}
            </dl>
            {details.length ? (
              <div className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Everything the source sent
                </h3>
                <dl className="max-h-72 divide-y overflow-y-auto rounded-lg border text-sm">
                  {details.map(([k, v], i) => (
                    <div
                      key={`${k}:${i}`}
                      className="grid grid-cols-[10rem_minmax(0,1fr)] gap-3 px-3 py-1.5"
                    >
                      <dt className="text-muted-foreground">{FIELD_LABEL[k] ?? k}</dt>
                      <dd className="break-words font-medium text-foreground">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}
            {call.url && /^https?:\/\//i.test(call.url) ? (
              <p className="text-xs text-muted-foreground">
                From the source&rsquo;s public page —{" "}
                <a
                  href={call.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  view the original
                </a>
                .
              </p>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
