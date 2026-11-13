/**
 * An invoice's automated follow-ups (client item 18, 21 Oct): on or off for
 * this invoice, which rule (the default, or another one), where it stands —
 * the next reminder's date, or why there is none (off here, the client is
 * exempt, not sent, paid) — and what has already gone.
 *
 * The same card carries the customer's open balance (FE9) with its own
 * switch — whether that balance prints at the bottom of this invoice (6 Nov
 * voice note). One Follow-ups card, in the invoice editor's rail; the draft
 * invoice pop-up shows that one, not a second copy above the editor.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { loadFollowupRules, FOLLOWUP_RULES_KEY } from "@/components/invoice-followup-rules-admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { accountOpenBalance } from "@/lib/account-statement";
import { toastDbError } from "@/lib/db-errors";
import {
  followupState,
  ruleForInvoice,
  type FollowupInvoice,
  type FollowupMode,
} from "@/lib/invoice-followups";
import { isMissingSchema } from "@/lib/schema-fallback";
import { cn } from "@/lib/utils";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const db = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;

type History = {
  id: string;
  step_index: number;
  days: number;
  outcome: "emailed" | "notified" | "skipped" | "cancelled";
  to_emails: string[];
  reason: string | null;
  cancel_reason: string | null;
  created_at: string;
};

const OUTCOME_LABEL: Record<History["outcome"], string> = {
  emailed: "Emailed",
  notified: "No email on file — office asked to call",
  skipped: "Skipped (a later step went)",
  cancelled: "Canceled",
};

type PanelInvoice = FollowupInvoice & {
  account_id: string | null;
  job_id: string | null;
  /** Null until its migration is in: the switch stays hidden, the PDF prints as before. */
  show_account_balance: boolean | null;
};

async function loadInvoiceFollowups(invoiceId: string) {
  const cols =
    "id, status, sent_at, issue_date, total, billed_amount, collected_amount, location_id, account_id, job_id, followup_mode, followup_rule_id";
  // show_account_balance shipped after the follow-up columns, and PostgREST
  // fails the whole read on one unknown column — so it is asked for first and
  // dropped alone when missing.
  let inv = await db
    .from("invoices")
    .select(`${cols}, show_account_balance`)
    .eq("id", invoiceId)
    .maybeSingle();
  let balanceMigrated = true;
  if (inv.error && isMissingSchema(inv.error)) {
    balanceMigrated = false;
    inv = await db.from("invoices").select(cols).eq("id", invoiceId).maybeSingle();
  }
  if (inv.error) {
    if (isMissingSchema(inv.error)) return null;
    throw inv.error;
  }
  const row = inv.data as
    | (Omit<PanelInvoice, "show_account_balance"> & {
        show_account_balance?: boolean | null;
      })
    | null;
  if (!row) return null;
  const invoice: PanelInvoice = {
    ...row,
    show_account_balance: balanceMigrated ? row.show_account_balance !== false : null,
  };
  const { data: job } = invoice.job_id
    ? await supabase
        .from("jobs")
        .select("account_id, bill_to_account_id")
        .eq("id", invoice.job_id)
        .maybeSingle()
    : { data: null };
  const ids = [invoice.account_id, job?.account_id, job?.bill_to_account_id].filter(
    Boolean,
  ) as string[];
  const [accts, hist] = await Promise.all([
    ids.length
      ? db.from("accounts").select("id, name, no_auto_followups").in("id", ids)
      : Promise.resolve({ data: [] as { id: string; name: string; no_auto_followups: boolean }[] }),
    db
      .from("invoice_followups")
      .select(
        "id, rule_key, step_index, days, outcome, to_emails, reason, cancel_reason, created_at",
      )
      .eq("invoice_id", invoiceId)
      .order("created_at"),
  ]);
  const exemptBy = ((accts.data ?? []) as { name: string; no_auto_followups: boolean }[]).find(
    (a) => a.no_auto_followups,
  );
  return {
    invoice,
    exemptBy: exemptBy?.name ?? null,
    history: (hist.data ?? []) as (History & { rule_key: string })[],
  };
}

/**
 * FE9: what this customer owes across every open invoice — this job and
 * their others — so nobody bills a customer without seeing the whole account.
 * The switch beside it (6 Nov) is whether that figure prints at the bottom of
 * this invoice, under Balance due, as "Account balance, all open invoices".
 * Nothing shows for an invoice with no customer.
 */
function AccountBalanceLine({
  accountId,
  show,
  disabled,
  onChange,
}: {
  accountId: string | null;
  /** Null: the column is not in the database yet, so no switch. */
  show: boolean | null;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  const q = useQuery({
    queryKey: ["account-open-balance", accountId],
    enabled: !!accountId,
    queryFn: () => accountOpenBalance(accountId),
  });
  if (!accountId || !q.data) return null;
  return (
    <div className="space-y-1.5 border-t pt-2" data-account-balance>
      <p className="text-xs text-muted-foreground">
        Customer&rsquo;s open balance:{" "}
        <span className="font-semibold tabular-nums text-foreground">
          {q.data.balance.toLocaleString("en-US", { style: "currency", currency: "USD" })}
        </span>{" "}
        across {q.data.count} open invoice{q.data.count === 1 ? "" : "s"}
      </p>
      {show !== null ? (
        <label className="flex items-center justify-between gap-2">
          <span>Open balance on this invoice</span>
          <Switch
            checked={show}
            disabled={disabled}
            onCheckedChange={onChange}
            aria-label="Open balance on this invoice"
          />
        </label>
      ) : null}
      {show !== null ? (
        <p
          className="text-xs text-muted-foreground"
          data-account-balance-state={show ? "on" : "off"}
        >
          {show
            ? "Prints under Balance due, so the customer sees what is still open on their other invoices."
            : "This invoice shows only its own balance."}
        </p>
      ) : null}
    </div>
  );
}

export function InvoiceFollowupPanel({ invoiceId }: { invoiceId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const key = ["invoice-followups", invoiceId];
  const dataQ = useQuery({ queryKey: key, queryFn: () => loadInvoiceFollowups(invoiceId) });
  const rulesQ = useQuery({ queryKey: FOLLOWUP_RULES_KEY, queryFn: loadFollowupRules });

  const setMode = useMutation({
    mutationFn: async (patch: {
      followup_mode: FollowupMode;
      followup_rule_id?: string | null;
    }) => {
      const { error } = await db.from("invoices").update(patch).eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toastDbError(e, { action: "change this invoice's follow-ups" }),
  });
  const setShowBalance = useMutation({
    mutationFn: async (show_account_balance: boolean) => {
      const { error } = await db
        .from("invoices")
        .update({ show_account_balance })
        .eq("id", invoiceId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) =>
      toastDbError(e, { action: "change whether the open balance prints on this invoice" }),
  });

  // Before the migration: nothing to show, rather than a broken card.
  if (dataQ.data === null || rulesQ.data === null) return null;
  if (!dataQ.data || !rulesQ.data) return null;
  const { invoice, exemptBy, history } = dataQ.data;
  const rules = rulesQ.data;
  const state = followupState({ invoice, rules, exempt: !!exemptBy, fired: history });
  const on = (invoice.followup_mode ?? "auto") !== "off";
  const effective = ruleForInvoice(
    { ...invoice, followup_mode: on ? invoice.followup_mode : "auto" },
    rules,
  );
  const tone =
    state.kind === "scheduled"
      ? "text-foreground"
      : state.kind === "client_exempt" || state.kind === "off"
        ? "text-warning"
        : "text-muted-foreground";

  const body = (
    <div className="space-y-2 text-sm" data-invoice-followups>
      <label className="flex items-center justify-between gap-2">
        <span>Automatic follow-ups</span>
        <Switch
          checked={on && !exemptBy}
          disabled={!!exemptBy || app.writesDisabled || setMode.isPending}
          onCheckedChange={(v) =>
            setMode.mutate({ followup_mode: v ? "auto" : "off", followup_rule_id: null })
          }
          aria-label="Automatic follow-ups for this invoice"
        />
      </label>
      {on && !exemptBy && rules.filter((r) => r.is_active).length > 1 ? (
        <Select
          value={
            invoice.followup_mode === "rule" && invoice.followup_rule_id
              ? invoice.followup_rule_id
              : "auto"
          }
          disabled={app.writesDisabled}
          onValueChange={(v) =>
            setMode.mutate(
              v === "auto"
                ? { followup_mode: "auto", followup_rule_id: null }
                : { followup_mode: "rule", followup_rule_id: v },
            )
          }
        >
          <SelectTrigger className="h-9 text-xs" aria-label="Follow-up rule">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Default for this office</SelectItem>
            {rules
              .filter((r) => r.is_active)
              .map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ) : null}
      <p className={cn("text-xs", tone)} data-followup-state={state.kind}>
        {state.kind === "client_exempt" && exemptBy
          ? `Off — ${exemptBy} is set to no automated follow-ups.`
          : state.text}
        {effective && on && !exemptBy ? (
          <span className="block text-muted-foreground">
            Rule: {effective.name} ({effective.steps.map((s) => `${s.days}d`).join(", ")})
          </span>
        ) : null}
      </p>
      <AccountBalanceLine
        accountId={invoice.account_id}
        show={invoice.show_account_balance}
        disabled={app.writesDisabled || setShowBalance.isPending}
        onChange={(v) => setShowBalance.mutate(v)}
      />
      {history.length ? (
        <ul className="space-y-1 border-t pt-2 text-xs">
          {history.map((h) => (
            <li key={h.id}>
              <span className="font-medium">
                Step {h.step_index + 1} ({h.days}d) · {OUTCOME_LABEL[h.outcome]}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {new Date(h.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                {h.to_emails.length ? ` · to ${h.to_emails.join(", ")}` : ""}
                {h.cancel_reason ? ` · ${h.cancel_reason}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <BellRing className="size-4" /> Follow-ups
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

/**
 * The client's "No automated follow-ups" switch — on the account profile,
 * where it is plain to see. Wins over every rule and invoice setting, and is
 * re-checked when a reminder is about to go.
 */
export function AccountFollowupToggle({ accountId }: { accountId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const key = ["account-no-followups", accountId];
  const q = useQuery({
    queryKey: key,
    queryFn: async () => {
      const { data, error } = await db
        .from("accounts")
        .select("no_auto_followups")
        .eq("id", accountId)
        .maybeSingle();
      if (error) {
        if (isMissingSchema(error)) return null;
        throw error;
      }
      return Boolean((data as { no_auto_followups?: boolean } | null)?.no_auto_followups);
    },
  });
  const set = useMutation({
    mutationFn: async (v: boolean) => {
      const { error } = await db
        .from("accounts")
        .update({ no_auto_followups: v })
        .eq("id", accountId);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) => toastDbError(e, { action: "change automated follow-ups for this client" }),
  });
  if (q.data == null) return null;
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2 py-1 text-xs",
        q.data ? "border-warning/50 bg-warning/10 font-medium" : "text-muted-foreground",
      )}
      title="When on, this client's invoices never get automated reminders, whatever the rule or invoice says."
      data-account-no-followups
    >
      <Switch
        checked={q.data}
        disabled={app.writesDisabled || set.isPending}
        onCheckedChange={(v) => set.mutate(v)}
        aria-label="No automated follow-ups"
      />
      No automated follow-ups
    </label>
  );
}
