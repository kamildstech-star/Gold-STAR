/**
 * "What the AI read" — the read half of the suggestion card.
 *
 * What the rep sees here is not a count. It is what one model pass noticed
 * while reading the same history the Timeline card below renders, and every
 * line carries the date and the words it came from, so it can be checked in
 * two seconds and a wrong one is obvious rather than mysterious.
 *
 * The label used to be "From the timeline", which rendered as a bold
 * uppercase FROM THE TIMELINE at the very top of the prospect dock — above,
 * and read as the heading of, the card actually called Timeline. Mark filed
 * exactly that: "heading shows FROM THE TIMELINE — expected ... Timeline".
 * Nothing on the page but the Timeline card may head itself "timeline", so
 * this half says whose reading it is instead, and its button asks to read
 * "the history", the word the empty states here already use.
 *
 * Cost: opening this page never calls the model. The query below asks the
 * server for the CACHED read only (`generate: false`); a model call happens
 * when the rep presses Read, and then only if the timeline has actually moved
 * since the last one. The mechanical checks render regardless, so a model
 * outage costs the card its top section and nothing else.
 *
 * And it says so by saying nothing. A page load used to print "Looking for an
 * existing read…", which reads exactly like the work we promise not to do on a
 * page view, whatever the code underneath is. So the in-flight cache lookup
 * renders the un-read state — the "Read the timeline" invitation and nothing
 * else — and a stored read swaps in when it arrives. No spinner, no skeleton,
 * no sentence in the present continuous. Progress is shown only on the button
 * the rep pressed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { BookOpenText, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";

import { useWritesDisabled } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { longDate } from "@/lib/account-timeline";
import { accountTimelineRead, dismissTimelineObservation } from "@/lib/timeline-read.functions";
import type { TimelineReadResult } from "@/lib/timeline-read.functions";
import { cn } from "@/lib/utils";

export const TIMELINE_READ_QUERY_KEY = "account-timeline-read";

const EMPTY: TimelineReadResult = {
  status: "none",
  items: [],
  stale: false,
  readThrough: null,
  generatedAt: null,
  entryCount: 0,
  message: null,
};

/** The query is shared with render tests that stub `useQuery`; never trust the shape. */
function asResult(data: unknown): TimelineReadResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) return EMPTY;
  const d = data as Partial<TimelineReadResult>;
  if (typeof d.status !== "string") return EMPTY;
  return { ...EMPTY, ...d, items: Array.isArray(d.items) ? d.items : [] };
}

export function TimelineReadPanel({
  accountId,
  className,
}: {
  accountId: string;
  className?: string;
}) {
  const qc = useQueryClient();
  const writes = useWritesDisabled();
  const run = useServerFn(accountTimelineRead);
  const dismissFn = useServerFn(dismissTimelineObservation);

  const readQ = useQuery({
    queryKey: [TIMELINE_READ_QUERY_KEY, accountId],
    // Cache lookup only. This call can never reach the model.
    queryFn: () => run({ data: { account_id: accountId, generate: false } }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const generate = useMutation({
    mutationFn: () => run({ data: { account_id: accountId, generate: true } }),
    onSuccess: (r) => qc.setQueryData([TIMELINE_READ_QUERY_KEY, accountId], r),
    onError: (e: Error) => toast.error(e.message),
  });

  const dismiss = useMutation({
    mutationFn: (key: string) => dismissFn({ data: { account_id: accountId, key } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [TIMELINE_READ_QUERY_KEY, accountId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  // While the cache lookup is in flight there is nothing truthful to show and
  // nothing worth announcing, so the section renders as if no read were stored.
  // If one is, it appears a moment later; the alternative is a message that
  // claims work is happening on load, which is the thing we promised not to do.
  const read = readQ.isLoading ? EMPTY : asResult(readQ.data);
  const busy = generate.isPending;
  const disabled = busy || writes.disabled;
  const reason = writes.disabled ? (writes.reason ?? "Read only") : undefined;

  const action = (label: string) => (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 gap-1 border-ai/30 text-[12px] text-ai-text hover:bg-ai/10"
      disabled={disabled}
      title={reason}
      onClick={() => generate.mutate()}
    >
      <RefreshCw className={cn("size-3", busy && "animate-spin")} />
      {busy ? "Reading…" : label}
    </Button>
  );

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-2">
        {/* The AI tone (indigo): a model's reading, told apart from the record's own checks. */}
        <BookOpenText className="size-3.5 shrink-0 text-ai-text" />
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-ai-text">
          What the AI read
        </h3>
        {read.readThrough && read.status === "ok" && (
          <span className="truncate text-[11px] text-muted-foreground">
            read through {longDate(read.readThrough)}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {/* The action is always offered. Hiding it once a read existed and was
              current left a rep looking at a stored read with no way to refresh
              it, and no way to see what pressing it does. "Re-read" the moment
              anything is stored, whether or not the timeline has moved since. */}
          {read.status === "none" ? action("Read the history") : action("Re-read")}
        </span>
      </div>

      {readQ.isError ? (
        <p className="text-[12.5px] text-muted-foreground">
          The timeline read could not be loaded. The checks below are unaffected.
        </p>
      ) : read.status === "unavailable" ? (
        <p className="text-[12.5px] text-muted-foreground">
          {read.message ??
            "The timeline read is unavailable right now. The checks below are still up to date."}
        </p>
      ) : read.status === "insufficient" ? (
        <p className="text-[12.5px] text-muted-foreground">
          {read.message ?? "There is too little history on this account to read yet."}
        </p>
      ) : read.status === "none" ? (
        <p className="text-[12.5px] text-muted-foreground">
          This account&rsquo;s history has not been read yet.
        </p>
      ) : read.items.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">
          Read the history and nothing stood out beyond the checks below.
        </p>
      ) : (
        <ul className="space-y-2">
          {read.items.map((item) => (
            <li
              key={item.key}
              className="rounded-lg border border-ai/20 bg-card px-3 py-2 text-[13px]"
            >
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold leading-snug">{item.headline}</div>
                  {item.detail && (
                    <p className="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
                      {item.detail}
                    </p>
                  )}
                  {/* The receipt. A rep can find this line in the Timeline card below. */}
                  <p className="mt-1 text-[11.5px] text-muted-foreground">
                    <span className="font-medium">{longDate(`${item.date}T12:00:00`)}</span>
                    {" · "}
                    {item.sourceLabel}
                    {item.quote ? <span> &mdash; &ldquo;{item.quote}&rdquo;</span> : null}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 opacity-50 hover:opacity-100 disabled:opacity-25"
                  aria-label="Dismiss observation"
                  disabled={writes.disabled || dismiss.isPending}
                  title={reason}
                  onClick={() => dismiss.mutate(item.key)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* A read that failed while an older one is stored says so rather than
          passing the old one off as current. */}
      {read.status === "ok" && read.message && (
        <p className="text-[11px] text-muted-foreground">{read.message}</p>
      )}

      {read.stale && read.status !== "none" && (
        <p className="text-[11px] text-muted-foreground">The timeline has moved since this read.</p>
      )}
    </div>
  );
}
