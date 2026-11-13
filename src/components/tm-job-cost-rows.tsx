/**
 * TM7: on a T&M job, the job page's Amounts card adds what the job COST —
 * from the same signed hours, field forms and supply lists the T&M bill
 * bills — against Billed and Collected, and the margin. Internal: rendered
 * only for a cost viewer (the card's own `job.view_costs` gate), and the
 * loader answers null for anyone else.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { fmtMoney } from "@/lib/jobs";
import { loadTmJobCost, type TmBillJob } from "@/lib/tm-bill-run";
import { tmMargin } from "@/lib/tm-job-cost";
import { todayLocal } from "@/lib/drying-log";

export function TmJobCostRows({
  job,
  billed,
  collected,
}: {
  job: TmBillJob;
  billed: number;
  collected: number;
}) {
  const today = todayLocal();
  const q = useQuery({
    queryKey: ["tm-job-cost", job.id, today],
    queryFn: () => loadTmJobCost(supabase as never, job, today),
  });
  if (!q.data) return null;
  const { cost } = q.data;
  const { margin, pct } = tmMargin(billed, cost.total);
  return (
    <div className="mt-2 space-y-1 border-t pt-2 text-sm" data-tm-job-cost>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Job cost · internal
      </div>
      <Row label="Total expenses" value={fmtMoney(cost.total)} />
      <Row label="Billed" value={fmtMoney(billed)} />
      <Row label="Collected" value={fmtMoney(collected)} />
      <Row
        label="Margin"
        value={`${fmtMoney(margin)}${pct == null ? "" : ` · ${pct}%`}`}
        tone={margin < 0 ? "text-destructive" : undefined}
      />
      {/* J5, 5 Nov (round 2): the labor / materials / equipment split and the
          "no cost rate for …" note used to sit under Margin; David asked for
          the card to end at Margin. The missing-rate check itself is still
          made (loadTmJobCost) and still warns under Billing & Costs. */}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${tone ?? ""}`}>{value}</span>
    </div>
  );
}
