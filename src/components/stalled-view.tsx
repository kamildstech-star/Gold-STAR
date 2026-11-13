/**
 * Stalled view — everything currently escalated because nothing has moved on
 * it. Grouped by record type then owner, sorted by days of silence, because
 * the failure this answers is the Texas one: work sat still and nobody noticed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Check, RefreshCw, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  RECORD_TYPE_LABEL,
  closeEscalation,
  groupStalled,
  listStalled,
  recordHref,
  runScanNow,
  type EscalationRecordType,
} from "@/lib/escalations";

export function StalledView({
  compact = false,
  limitTypes,
}: {
  compact?: boolean;
  limitTypes?: EscalationRecordType[];
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<EscalationRecordType | "all">("all");

  const locationIds = app.currentLocationId
    ? [app.currentLocationId]
    : app.visibleLocations.map((l) => l.id);

  const q = useQuery({
    queryKey: ["stalled", locationIds, filter],
    queryFn: () =>
      listStalled({
        locationIds,
        state: "open",
        recordType: filter === "all" ? null : filter,
      }),
    enabled: locationIds.length > 0,
  });

  const rows = useMemo(() => {
    const all = q.data ?? [];
    return limitTypes ? all.filter((r) => limitTypes.includes(r.record_type)) : all;
  }, [q.data, limitTypes]);

  const groups = useMemo(() => groupStalled(rows), [rows]);

  const scan = useMutation({
    mutationFn: runScanNow,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["stalled"] });
      toast.success(`Scan complete — ${r.raised} raised, ${r.resolved} cleared`);
    },
    onError: (e: Error) => toast.error("Scan failed", { description: e.message }),
  });

  const close = useMutation({
    mutationFn: (v: { id: string; state: "resolved" | "dismissed" }) =>
      closeEscalation(v.id, app.userId!, v.state, null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stalled"] });
    },
    onError: (e: Error) => toast.error("Could not update", { description: e.message }),
  });

  const shown = compact ? groups.slice(0, 2) : groups;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <AlertTriangle className="size-4" /> Stalled
          {rows.length > 0 && (
            <Badge variant="destructive" className="ml-1">
              {rows.length}
            </Badge>
          )}
        </CardTitle>
        <div className="flex items-center gap-2">
          {!compact && (
            <div className="flex flex-wrap gap-1">
              {(["all", "invoice", "estimate", "job", "account", "lead"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setFilter(t as EscalationRecordType | "all")}
                  className={`rounded border px-2 py-0.5 text-xs ${
                    filter === t ? "border-primary bg-primary/5" : "border-border"
                  }`}
                >
                  {t === "all" ? "All" : RECORD_TYPE_LABEL[t as EscalationRecordType]}
                </button>
              ))}
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            disabled={scan.isPending || app.writesDisabled}
            onClick={() => scan.mutate()}
          >
            <RefreshCw className={`mr-1 size-3.5 ${scan.isPending ? "animate-spin" : ""}`} />
            Run scan
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

        {!q.isLoading && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Nothing is stalled. A record appears here when there has been no status change, no
            payment, no touchpoint and no email against it for the number of days set in the
            escalation rules for its location.
          </p>
        )}

        {shown.map((g) => (
          <div key={g.type} className="rounded border">
            <div className="flex items-center justify-between border-b px-2 py-1.5">
              <span className="text-xs font-medium">{RECORD_TYPE_LABEL[g.type]}</span>
              <span className="text-xs text-muted-foreground">{g.count}</span>
            </div>
            {g.owners.map((o) => (
              <div key={o.owner}>
                <div className="bg-muted/40 px-2 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                  {o.owner}
                </div>
                {o.items.slice(0, compact ? 4 : 100).map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between gap-2 border-t px-2 py-1.5 text-xs"
                  >
                    <div className="min-w-0">
                      <Link
                        to={recordHref(r.record_type, r.record_id)}
                        className="block truncate font-medium hover:underline"
                      >
                        {r.record_label ?? r.record_id.slice(0, 8)}
                      </Link>
                      <div className="truncate text-muted-foreground">
                        {r.days_stale} days without movement · step {r.step} ·{" "}
                        {r.notifiedName ? `notified ${r.notifiedName}` : "nobody notified"}
                        {r.ruleName ? ` · ${r.ruleName}` : ""}
                      </div>
                    </div>
                    {!compact && (
                      <div className="flex shrink-0 gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          title="Mark resolved"
                          disabled={app.writesDisabled}
                          onClick={() => close.mutate({ id: r.id, state: "resolved" })}
                        >
                          <Check className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          title="Dismiss"
                          disabled={app.writesDisabled}
                          onClick={() => close.mutate({ id: r.id, state: "dismissed" })}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}

        {compact && groups.length > shown.length && (
          <Link to="/stalled" className="text-xs underline">
            See all stalled records
          </Link>
        )}
      </CardContent>
    </Card>
  );
}
