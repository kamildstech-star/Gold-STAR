import { useQuery } from "@tanstack/react-query";
import { Footprints } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { daysSince, fetchLastVisit } from "@/lib/route-history";
import { cn } from "@/lib/utils";

/** "31 days ago" / "today" / "yesterday" — how long ago, in words. */
function whenLabel(age: number) {
  return age === 0 ? "today" : age === 1 ? "yesterday" : `${age} days ago`;
}

/**
 * "Have I been here?" — the answer any rep wants before knocking, including
 * when the visit was somebody else's.
 *
 * The full sentence names the rep ("Test Sales Rep NY (Brooklyn) was here 31
 * days ago"), which makes this the widest chip on an account header by a
 * distance. Pass `responsive` where the badge sits in a `@container` and the
 * room is not guaranteed: below 60rem of container it drops to "Visited 31
 * days ago" — the rep's office is its own chip anyway — and the sentence
 * stays on the tooltip.
 */
export function LastVisitBadge({
  accountId,
  className,
  responsive = false,
}: {
  accountId: string;
  className?: string;
  /** Shorten the label when the container is narrow. Off by default. */
  responsive?: boolean;
}) {
  const app = useAppContext();
  const q = useQuery({
    queryKey: ["last-visit", accountId],
    queryFn: () => fetchLastVisit(accountId),
  });

  if (q.isLoading) return null;
  const v = q.data;
  const age = daysSince(v?.occurred_at ?? null);

  const text =
    !v || age === null
      ? "Never visited in person"
      : `${v.rep_id && v.rep_id === app.userId ? "You were" : `${v.rep_name ?? "A rep"} was`} here ${whenLabel(age)}`;
  const short = !v || age === null ? "Never visited" : `Visited ${whenLabel(age)}`;

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[13px] font-medium",
        /* Fresh is emerald; past a month amber; past a quarter orange, so
           "127 days ago" stops reading the same as "35 days ago". The words
           say it too. Shared tones, see styles.css. */
        !v
          ? "bg-muted text-muted-foreground"
          : age! <= 30
            ? "bg-tone-emerald-soft text-tone-emerald-text"
            : age! <= 90
              ? "bg-tone-amber-soft text-tone-amber-text"
              : "bg-tone-orange-soft text-tone-orange-text",
        className,
      )}
      title={v ? `${text} — ${new Date(v.occurred_at).toLocaleString("en-US")}` : text}
    >
      <Footprints className="size-3.5 shrink-0" />
      {/* The text truncates only where a caller caps the width. */}
      {responsive ? (
        <>
          <span className="truncate @min-[60rem]:hidden">{short}</span>
          <span className="hidden truncate @min-[60rem]:inline">{text}</span>
        </>
      ) : (
        <span className="truncate">{text}</span>
      )}
    </span>
  );
}
