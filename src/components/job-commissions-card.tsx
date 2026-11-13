import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Percent } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  commissionStatus,
  markCommissionOutstanding,
  markCommissionPaid,
} from "@/lib/commission-entries";
import { toastDbError } from "@/lib/db-errors";
import { BASIS_ORIGIN_LABEL, type CommissionLine, type RuleKind } from "@/lib/job-commission";
import { creditLine } from "@/lib/job-credit";
import { isActiveSource, kindOf } from "@/lib/job-ledger";
import { REVENUE_BASIS_LABEL } from "@/lib/running-cost";
import {
  refreshJobCommission,
  useJobCommission,
  type JobCommissionRow,
} from "@/lib/use-job-commission";
import { cn } from "@/lib/utils";

const usd = (n: number | null | undefined, cents = true) =>
  n == null
    ? "—"
    : n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: cents ? 2 : 0,
      });

/**
 * Commissions — who is owed what on this job, in the Billing tab's rail where
 * the Job ledger card used to be.
 *
 * Mark, 7 Oct: "we want to replace the ledger to be replaced with a card
 * called commissions, it will pull the referring company from general, (in
 * admin we need to be able put the rates for each referral), or use the
 * current commission page in admin settings, and that should be connected to
 * the card ... commission amount, which will auto calculate as the charges
 * get added, or a flat fee". Then: "and reports, it needs to be able to
 * separate salesman and referrers."
 *
 * So the card has two halves. REFERRER: the company or person from the
 * General tab, the deal that applies to them (this job's override → their own
 * rule → their company's → the "Came from" rate), what that comes to on the
 * job's revenue right now, and whether it has been paid. SALESMEN: what the
 * rep commission engine owes Gold Star's own reps on the job — shown, not
 * edited here; the engine and its payouts screen own it.
 *
 * Every figure is `useJobCommission`'s, the hook the ledger strip's Referral
 * and Commission cells read, so the card and the strip cannot disagree.
 *
 * It keeps everything the stop-gap Commission card (#336) could do: pick
 * "Came from", override the rate for this job, and mark the commission paid
 * or outstanding — `/my-commissions` and Settings › Commissions depend on
 * those.
 */
export function JobCommissionsCard({ jobId }: { jobId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const c = useJobCommission(jobId);
  const job = c.job;

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const { data, error } = await supabase
        .from("jobs")
        .update(body as never)
        .eq("id", jobId)
        .select("id");
      if (error) throw error;
      if ((data ?? []).length === 0) throw new Error("You can't change this job's commission.");
    },
    onSuccess: () => refreshJobCommission(qc, jobId),
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "save the commission" });
    },
  });

  if (c.loading) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Working out the commissions…
        </CardContent>
      </Card>
    );
  }
  // Commission is money: without the running cost (finance only) there is no
  // base and nothing to show — the gate the ledger's commission always had.
  if (!c.costQ.data || !job) return null;

  const referrer = c.referrer;
  const total = c.totals.total;
  const disabled = app.writesDisabled || save.isPending;

  return (
    <Card data-commissions-card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <Percent className="size-4" /> Commissions
          </span>
          <span className="text-sm tabular-nums" data-commission-total>
            {usd(total)}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* ---------------- Referrer ---------------- */}
        <section className="space-y-2" data-commission-section="referrer">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Referrer
          </h3>
          <ReferrerSummary job={job} line={referrer} accountName={c.facts?.accountName ?? null} />

          {referrer ? (
            <div className="rounded-md border bg-muted/30 p-2 text-sm" data-referrer-amount>
              <div className="flex items-baseline justify-between gap-2">
                {/* David, 13 Oct: the commission reads as dollars, not a
                    percentage. The rate behind it stays in Settings. */}
                <span className="min-w-0">
                  Commission
                  {referrer.basis ? (
                    <span className="text-xs text-muted-foreground">
                      {" "}
                      · {BASIS_ORIGIN_LABEL[referrer.basis.origin]}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 font-semibold tabular-nums" data-commission-dollars>
                  {usd(referrer.amount)}
                </span>
              </div>
              {referrer.basis?.kind === "percent" ? (
                <p className="text-xs text-muted-foreground">
                  On {usd(c.base, false)} revenue (
                  {REVENUE_BASIS_LABEL[c.costQ.data.revenue_basis].short}) — it moves as charges are
                  added.
                </p>
              ) : null}
              {!referrer.basis ? (
                <p className="text-xs text-muted-foreground">
                  No deal for this referrer. Give them one in Settings › Commissions, pick a
                  &ldquo;Came from&rdquo; rate, or set one for this job below.
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">Came from</Label>
              <Select
                value={job.commission_source ?? "none"}
                disabled={disabled}
                onValueChange={(v) => save.mutate({ commission_source: v === "none" ? null : v })}
              >
                <SelectTrigger className="h-11 text-xs md:h-8" aria-label="Commission came from">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not set</SelectItem>
                  {/*
                    By name first. David, 24 Sep: "I just have a dropdown, I
                    select his name and his rate automatically deducts." An
                    entry switched off in Settings leaves the list, except on
                    the job that already uses it.
                  */}
                  {(["person", "role"] as const).map((kind) => {
                    const inKind = c.sources.filter(
                      (s) =>
                        kindOf(s) === kind &&
                        (isActiveSource(s) || s.key === job.commission_source),
                    );
                    return inKind.length ? (
                      <SelectGroup key={kind}>
                        <SelectLabel className="text-[11px]">
                          {kind === "person" ? "People" : "Roles"}
                        </SelectLabel>
                        {inKind.map((s) => (
                          <SelectItem key={s.key} value={s.key}>
                            {/* Name only (David, 13 Oct) — no percentage. */}
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ) : null;
                  })}
                </SelectContent>
              </Select>
            </div>
            <OverrideControl job={job} disabled={disabled} onSave={(body) => save.mutate(body)} />
          </div>

          {job.paidTracked && referrer ? (
            <CommissionPaidControl jobId={jobId} job={job} computed={referrer.amount} />
          ) : null}
        </section>

        {/* ---------------- Salesmen ---------------- */}
        <section className="space-y-2 border-t pt-3" data-commission-section="salesman">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Salesmen
          </h3>
          {c.salesmen.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sales rep commission on this job.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {c.salesmen.map((l) => (
                <li
                  key={l.payee_id ?? l.payee_name}
                  data-salesman-line
                  className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate">{l.payee_name}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <StatusPill status={l.status} />
                    <span className="tabular-nums">{usd(l.amount)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <CreditLine job={job} />
          <p className="text-[11px] text-muted-foreground">
            From each rep&rsquo;s commission plan — approved and paid on the payouts screen, not
            here.
          </p>
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * One line for where invoices are written (David, 21 Oct): who referred the
 * job and what their commission comes to in dollars, so the fee is in view
 * while billing. Same `useJobCommission` figures as the card and the strip.
 * Renders nothing when the job has no referrer or money is not visible.
 */
export function JobReferralFeeLine({ jobId, className }: { jobId: string; className?: string }) {
  const c = useJobCommission(jobId);
  const job = c.job;
  const referrer = c.referrer;
  if (c.loading || !c.costQ.data || !job || !referrer) return null;
  if (
    !job.referred_by_account_id &&
    !job.referred_by_contact_id &&
    !job.referred_by_name &&
    !job.commission_source
  )
    return null;
  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border bg-muted/30 px-2 py-1.5 text-sm",
        className,
      )}
      data-referral-fee
    >
      <span className="min-w-0">
        <span className="text-xs text-muted-foreground">Referred by </span>
        <span className="font-medium" data-referral-name>
          {referrer.payee_name}
        </span>
      </span>
      <span className="shrink-0">
        <span className="text-xs text-muted-foreground">Commission </span>
        <span className="font-semibold tabular-nums" data-referral-dollars>
          {usd(referrer.amount)}
        </span>
        {referrer.status === "paid" ? (
          <span className="ml-1 text-xs text-success">paid</span>
        ) : null}
      </span>
    </div>
  );
}

function ReferrerSummary({
  job,
  line,
  accountName,
}: {
  job: JobCommissionRow;
  line: CommissionLine | null;
  accountName: string | null;
}) {
  if (!job.referred_by_account_id && !job.referred_by_contact_id) {
    return (
      <p className="text-sm text-muted-foreground" data-no-referrer>
        {line
          ? `${line.payee_name} — no referring company or person on the General tab.`
          : "No referrer yet. Pick the referring company or person on the General tab."}
      </p>
    );
  }
  const company = job.referred_by_contact_id && accountName ? ` at ${accountName}` : "";
  return (
    <p className="text-sm" data-referrer-name>
      <span className="font-medium">{line?.payee_name ?? job.referred_by_name ?? "Referrer"}</span>
      {line?.payee_type === "contact" ? company : ""}
      <span className="text-xs text-muted-foreground">
        {" "}
        · {line?.payee_type === "account" ? "company" : "person"}, from the General tab
      </span>
    </p>
  );
}

/**
 * This job only: a percentage or a flat fee, stored on the job's own
 * `commission_rate_pct` / `commission_flat_amount` (exclusive — typing one
 * clears the other). Blank uses the deal. Flat needs 20261007224200; until
 * then only the percentage is offered.
 */
function OverrideControl({
  job,
  disabled,
  onSave,
}: {
  job: JobCommissionRow;
  disabled: boolean;
  onSave: (body: Record<string, unknown>) => void;
}) {
  // Dollars by default (David, 13 Oct). A percentage stays reachable only on a
  // job that already carries one, so nothing set before is hidden.
  const current: RuleKind =
    job.commission_flat_amount != null || (job.flatTracked && job.commission_rate_pct == null)
      ? "flat"
      : "percent";
  const [kind, setKind] = useState<RuleKind>(current);
  const value = kind === "flat" ? job.commission_flat_amount : job.commission_rate_pct;

  const commit = (n: number | null) => {
    if (n != null && (n < 0 || (kind === "percent" && n > 100))) {
      toast.error(kind === "percent" ? "A rate is between 0 and 100." : "A fee can't be negative.");
      return;
    }
    const body: Record<string, unknown> =
      kind === "flat"
        ? { commission_flat_amount: n, commission_rate_pct: null }
        : { commission_rate_pct: n };
    if (kind === "percent" && job.flatTracked) body.commission_flat_amount = null;
    onSave(body);
  };

  return (
    <div className="space-y-1">
      <Label className="text-xs">This job only</Label>
      <div className="flex gap-2">
        {job.flatTracked && job.commission_rate_pct != null ? (
          <Select value={kind} disabled={disabled} onValueChange={(v) => setKind(v as RuleKind)}>
            <SelectTrigger className="h-11 w-24 text-xs md:h-8" aria-label="Override as">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">%</SelectItem>
              <SelectItem value="flat">$ flat</SelectItem>
            </SelectContent>
          </Select>
        ) : null}
        <NumberInput
          key={`${kind}:${value ?? ""}`}
          decimals={2}
          className="h-11 min-w-0 flex-1 text-xs md:h-8"
          aria-label={kind === "flat" ? "Commission flat fee override" : "Commission rate override"}
          defaultValue={value ?? undefined}
          placeholder={kind === "flat" ? "$ for this job" : "Use the deal"}
          disabled={disabled}
          onCommit={(n) => {
            if (n === value) return;
            commit(n);
          }}
        />
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: "paid" | "outstanding" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "paid" ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
      )}
    >
      {status === "paid" ? "Paid" : "Outstanding"}
    </span>
  );
}

/**
 * Paid or outstanding, with when and against what. David, 24 Sep: "I want to
 * be able to mark off if the payment was actually made or still outstanding."
 * What was paid is stored, not recomputed — the job's revenue can still move
 * after the cheque has gone out. This is the REFERRER's payment; a rep's is a
 * payout, marked on the payouts screen.
 */
export function CommissionPaidControl({
  jobId,
  job,
  computed,
}: {
  jobId: string;
  job: JobCommissionRow;
  computed: number | null;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const status = commissionStatus(job);
  const [open, setOpen] = useState(false);
  const today = new Date().toLocaleDateString("en-CA");
  const [paidOn, setPaidOn] = useState(today);
  const [reference, setReference] = useState("");
  const [amount, setAmount] = useState<number | null>(computed);

  const refresh = () => refreshJobCommission(qc, jobId);
  const pay = useMutation({
    mutationFn: () => markCommissionPaid({ jobId, paidOn, reference, amount, userId: app.userId }),
    onSuccess: () => {
      toast.success("Commission marked paid");
      setOpen(false);
      refresh();
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "mark the commission paid" });
    },
  });
  const unpay = useMutation({
    mutationFn: () => markCommissionOutstanding(jobId),
    onSuccess: refresh,
    onError: (e) => toastDbError(e, { action: "mark the commission outstanding" }),
  });

  return (
    <div className="w-full space-y-2 border-t pt-2" data-commission-status={status}>
      {status === "paid" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusPill status="paid" />
          <span>
            {usd(job.commission_paid_amount)} on {job.commission_paid_on}
            {job.commission_paid_ref ? ` · ${job.commission_paid_ref}` : ""}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-11 md:h-7"
            disabled={unpay.isPending || app.writesDisabled}
            onClick={() => unpay.mutate()}
          >
            Mark outstanding
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusPill status="outstanding" />
          <span className="text-muted-foreground">
            {usd(computed)} owed at today&rsquo;s figures
          </span>
          {!open ? (
            <Button
              size="sm"
              variant="outline"
              className="h-11 md:h-7"
              disabled={app.writesDisabled}
              onClick={() => {
                setAmount(computed);
                setOpen(true);
              }}
            >
              Mark paid…
            </Button>
          ) : null}
        </div>
      )}
      {open && status !== "paid" ? (
        <div className="grid gap-2 sm:grid-cols-[9rem_minmax(0,1fr)_8rem_auto] sm:items-end">
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="commission-paid-on">
              Paid on
            </Label>
            <Input
              id="commission-paid-on"
              type="date"
              className="h-11 md:h-8"
              value={paidOn}
              onChange={(e) => setPaidOn(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="commission-paid-ref">
              Reference
            </Label>
            <Input
              id="commission-paid-ref"
              className="h-11 md:h-8"
              placeholder="Check #, payroll run…"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="commission-paid-amount">
              Amount paid
            </Label>
            <NumberInput
              id="commission-paid-amount"
              decimals={2}
              allowMath
              className="h-11 md:h-8"
              value={amount}
              onValueChange={(n) => setAmount(n)}
            />
          </div>
          <Button className="h-11 md:h-8" disabled={pay.isPending} onClick={() => pay.mutate()}>
            Save
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Who the job is credited to and why. Melly: "Credit locks the day the job
 * is signed" — the rep the account had when the job arrived, and the stage it
 * sat in, which decides whether the payout waits for a manager.
 */
function CreditLine({ job }: { job: JobCommissionRow }) {
  const repQ = useQuery({
    queryKey: ["profile-name", job.credit_rep_id],
    enabled: !!job.credit_rep_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("user_id", job.credit_rep_id!)
        .maybeSingle();
      return data?.full_name ?? null;
    },
  });
  if (!job.credit_rep_id) return null;
  return (
    <p className="text-[11px] text-muted-foreground" data-commission-credit>
      Credited to{" "}
      <span className="font-medium text-foreground">{repQ.data ?? "the account's rep"}</span>
      {job.credit_locked_at ? ` since ${job.credit_locked_at.slice(0, 10)}` : ""}. {creditLine(job)}
      .
    </p>
  );
}
