/**
 * Focus — what this record needs next, in two clearly separate halves.
 *
 * "What the AI read" is the read: one model pass over the same history the
 * Timeline card renders, each observation carrying the date and words it came
 * from. It is cached per account and only regenerated when the history moves,
 * so this section never costs tokens on a page view.
 *
 * Everything below it is computed, not guessed: `public.account_focus` works
 * it out in SQL from the rows the signed-in user can already read, which is
 * why it is labelled "on the record" rather than presented as an AI
 * suggestion. The pre-call brief remains a summary of those same facts and is
 * still barred from drafting anything a client would receive.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronRight,
  ClipboardCheck,
  Info,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TimelineReadPanel } from "@/components/timeline-read-panel";
import { useServerFn } from "@tanstack/react-start";
import { preCallBrief } from "@/lib/ai.functions";
import {
  FOCUS_ACTION_LABEL,
  dismissFocus,
  fetchAccountFocus,
  restoreFocus,
  type FocusSuggestion,
} from "@/lib/account-focus";
import { useWritesDisabled } from "@/components/app-context";
import { assertWritesEnabled } from "@/lib/write-guard";

const TONE: Record<string, { wrap: string; icon: typeof Info }> = {
  danger: { wrap: "border-destructive/40 bg-destructive/5 text-destructive", icon: AlertTriangle },
  warn: {
    wrap: "border-border border-l-2 border-l-gold bg-card text-foreground",
    icon: TriangleAlert,
  },
  info: { wrap: "border-border bg-muted/40 text-foreground", icon: Info },
};

export function AccountFocus({
  accountId,
  onAction,
}: {
  accountId: string;
  /** Lets the host panel wire a suggestion to its own controls. */
  onAction?: (s: FocusSuggestion) => void;
}) {
  const writes = useWritesDisabled();
  const qc = useQueryClient();
  const [brief, setBrief] = useState<string | null>(null);
  const runBrief = useServerFn(preCallBrief);

  const focusQ = useQuery({
    queryKey: ["account-focus", accountId],
    queryFn: () => fetchAccountFocus(accountId),
  });

  const dismiss = useMutation({
    mutationFn: (key: string) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      return dismissFocus(accountId, key);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account-focus", accountId] }),
    onError: (e: Error) => toast.error(e.message),
  });

  const brief$ = useMutation({
    mutationFn: () => runBrief({ data: { account_id: accountId } }),
    onSuccess: (r) => setBrief(r.text),
    onError: (e: Error) => toast.error(e.message),
  });

  const items = focusQ.data ?? [];

  return (
    <div className="space-y-3">
      <TimelineReadPanel accountId={accountId} />

      <hr className="border-border/60" />

      <div className="flex items-center gap-2 pt-1">
        <ClipboardCheck className="size-3.5 shrink-0 text-muted-foreground" />
        <h3 className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          On the record
        </h3>
        <span className="text-[11px] text-muted-foreground">computed, not written by AI</span>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[12px]"
          disabled={brief$.isPending}
          onClick={() => brief$.mutate()}
        >
          <Sparkles className="mr-1 size-3.5" />
          {brief$.isPending ? "Reading the record…" : "Pre-call brief"}
        </Button>
        <button
          type="button"
          disabled={writes.disabled}
          title={writes.reason ?? undefined}
          className="ml-auto text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={async () => {
            assertWritesEnabled(writes.disabled, writes.reason);
            await restoreFocus(accountId);
            qc.invalidateQueries({ queryKey: ["account-focus", accountId] });
            qc.invalidateQueries({ queryKey: ["account-timeline-read", accountId] });
          }}
        >
          Restore dismissed
        </button>
      </div>

      {brief && (
        <div className="rounded-md border bg-card p-2 text-[12.5px] whitespace-pre-wrap">
          <div className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
            <Sparkles className="size-3" /> Summary of this record — never sent to anyone
            <button
              type="button"
              className="ml-auto"
              onClick={() => setBrief(null)}
              aria-label="Dismiss brief"
            >
              <X className="size-3" />
            </button>
          </div>
          {brief}
        </div>
      )}

      {focusQ.isLoading ? (
        <p className="text-[12px] text-muted-foreground">Checking the record…</p>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          Nothing needs attention on this account.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((s) => {
            const tone = TONE[s.severity] ?? TONE.info;
            const Icon = tone.icon;
            return (
              <li
                key={s.key}
                className={`flex items-center gap-3 rounded-xl border p-4 text-[13.5px] ${tone.wrap}`}
              >
                <span
                  className={`flex size-8 shrink-0 items-center justify-center rounded-full ${
                    s.severity === "danger"
                      ? "bg-destructive/12 text-destructive"
                      : s.severity === "warn"
                        ? "bg-muted text-brand-gold-text"
                        : "bg-primary/10 text-primary"
                  }`}
                >
                  <Icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold leading-tight">{s.title}</div>
                  <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
                    {s.detail}
                  </div>
                </div>
                {s.action !== "none" && onAction && (
                  <button
                    type="button"
                    disabled={writes.disabled}
                    title={writes.reason ?? undefined}
                    className="flex shrink-0 items-center gap-1 text-[13px] font-medium text-primary hover:underline"
                    onClick={() => onAction(s)}
                  >
                    {FOCUS_ACTION_LABEL[s.action] ?? "Open"}
                    <ChevronRight className="size-4" />
                  </button>
                )}
                <button
                  type="button"
                  disabled={writes.disabled}
                  title={writes.reason ?? undefined}
                  className="shrink-0 opacity-50 hover:opacity-100"
                  aria-label="Dismiss suggestion"
                  onClick={() => dismiss.mutate(s.key)}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
