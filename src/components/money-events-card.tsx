import { useEffect, useState } from "react";
import { BadgeDollarSign, CheckCircle2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
type MoneyEvent = {
  id: string;
  event_type: "payment_received" | "commission_issued";
  amount: number | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
};

function usd(n: number) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

/**
 * The rep-facing money surface. Two deliberately separate events:
 * a payment arrived (no figure, ever) and commission was issued (the figure).
 * The gap between them is the point — do not collapse it.
 */
export function MoneyEventsCard({ jobId, accountId }: { jobId?: string; accountId?: string }) {
  const [events, setEvents] = useState<MoneyEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let q = supabase
        .from("money_events")
        .select("id,event_type,amount,reference,notes,created_at")
        .order("created_at", { ascending: false })
        .limit(25);
      if (jobId) q = q.eq("job_id", jobId);
      else if (accountId) q = q.eq("account_id", accountId);
      const { data } = await q;
      if (cancelled) return;
      setEvents((data ?? []) as MoneyEvent[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId, accountId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-base">
          <BadgeDollarSign className="h-4 w-4 text-muted-foreground" />
          Payment &amp; commission
        </CardTitle>
        <CardDescription>
          You are told when money lands. The amount appears once commission is issued — not on the
          estimate, not on approval, not on the invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="px-3 py-3 text-sm text-muted-foreground">Loading…</div>
        ) : events.length === 0 ? (
          <div className="m-3 rounded-md border border-dashed px-3 py-5 text-center text-[12px] text-muted-foreground">
            Nothing yet. When the office scans in a check you&apos;ll see it here.
          </div>
        ) : (
          events.map((e) => (
            <div key={e.id} className="flex items-center gap-2 border-b px-3 py-2 text-[13px]">
              <CheckCircle2
                className={`h-3.5 w-3.5 ${
                  e.event_type === "commission_issued" ? "text-success" : "text-muted-foreground"
                }`}
              />
              <span className="font-medium">
                {e.event_type === "commission_issued" ? "Commission issued" : "Payment received"}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {e.event_type === "payment_received"
                  ? "Commission is coming."
                  : (e.notes ?? e.reference ?? "")}
              </span>
              <span className="ml-auto tabular-nums text-[12px]">
                {e.event_type === "commission_issued" && e.amount != null
                  ? usd(Number(e.amount))
                  : ""}
              </span>
              <span className="w-[86px] shrink-0 text-right text-[11px] text-muted-foreground">
                {new Date(e.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
