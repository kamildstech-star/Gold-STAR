import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { useWritesDisabled } from "@/components/app-context";
import { errText } from "@/lib/db-errors";
import { claimLead, fetchNewLeads, type NewLeadRow } from "@/lib/new-leads";

/**
 * New leads entering the pipeline, each answering "do we already know them?"
 * before anyone starts work. Claiming is free-for-all — no approval step.
 */
export function NewLeadsCard() {
  const writes = useWritesDisabled();
  const qc = useQueryClient();

  const leads = useQuery({
    queryKey: ["new-leads-card"],
    queryFn: () => fetchNewLeads(8),
  });

  async function claim(l: NewLeadRow) {
    try {
      await claimLead(l.id, writes);
      toast.success(`${l.name} is yours`);
      await qc.invalidateQueries({ queryKey: ["new-leads-card"] });
    } catch (e) {
      toast.error(errText(e));
    }
  }

  const rows = leads.data ?? [];

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          New leads
        </CardTitle>
        <CardDescription>Last 30 days, checked against existing customers.</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-2">
        {leads.isError ? (
          <LoadError what="new leads" error={leads.error} onRetry={() => void leads.refetch()} />
        ) : leads.isLoading ? (
          <EmptyLine>Loading…</EmptyLine>
        ) : !rows.length ? (
          <EmptyLine>No new leads in the last 30 days.</EmptyLine>
        ) : (
          <ul className="divide-y">
            {rows.map((l) => {
              const match = l.matches[0];
              return (
                <li key={l.id} className="space-y-1 py-2">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <Link
                        to="/accounts/$id"
                        params={{ id: l.id }}
                        className="block truncate text-[13px] font-semibold hover:underline"
                      >
                        {l.name}
                      </Link>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {[l.address, l.phone, l.locationName].filter(Boolean).join(" · ") || "—"}
                      </div>
                    </div>
                    {l.ownerName ? (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {l.ownerName}
                      </Badge>
                    ) : (
                      <Button
                        size="sm"
                        className="h-7 shrink-0 px-2 text-[11px]"
                        disabled={writes.disabled}
                        title={writes.reason ?? undefined}
                        onClick={() => void claim(l)}
                      >
                        Claim
                      </Button>
                    )}
                  </div>

                  {match ? (
                    <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700 dark:text-amber-400">
                      <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
                      <span className="min-w-0">
                        Already a client
                        {match.ownerName ? ` — owned by ${match.ownerName}` : ""}
                        {!match.ownerName && match.locationName
                          ? ` — ${match.locationName} office`
                          : ""}
                        <span className="text-muted-foreground"> · matched on {match.on}</span>
                        {match.accountId ? (
                          <>
                            {" "}
                            <Link
                              to="/accounts/$id"
                              params={{ id: match.accountId }}
                              className="font-semibold underline"
                            >
                              {match.name}
                            </Link>
                          </>
                        ) : (
                          <span className="font-semibold"> {match.name}</span>
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" /> New to us
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
