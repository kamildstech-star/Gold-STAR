import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Plus, Trash2, User } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { CompanyContactPicker, type PickedContact } from "@/components/company-contact-picker";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LoadError } from "@/components/ui-density";
import { toastDbError } from "@/lib/db-errors";
import { describeBasis, type RuleKind } from "@/lib/job-commission";
import {
  BLANK_RULE_DRAFT,
  deleteReferralRule,
  insertReferralRule,
  loadReferralRules,
  overlapMessage,
  ruleProblem,
  updateReferralRule,
  type ReferralRuleRow,
  type RuleDraft,
} from "@/lib/referral-commission-rules";
import { isPrivileged } from "@/lib/roles";

export const REFERRAL_RULES_QUERY_KEY = ["referral-commission-rules"] as const;

/**
 * Settings › Commissions › Referrers: a deal per referring company and per
 * referring person.
 *
 * Mark, 7 Oct: "it will pull the referring company from general, (in admin we
 * need to be able put the rates for each referral), or use the current
 * commission page in admin settings ... commission amount, which will auto
 * calculate as the charges get added, or a flat fee".
 *
 * So it sits on the existing page, above the role and name rates it falls
 * back to, and a deal is either a percentage or a flat fee. The page says in
 * words what a percentage is OF, because "10%" with no base is how the office
 * and the referrer end up disagreeing about a cheque.
 */
export function ReferralCommissionRulesAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const canEdit = isPrivileged(app.roles) && !app.writesDisabled;
  const q = useQuery({ queryKey: REFERRAL_RULES_QUERY_KEY, queryFn: loadReferralRules });
  const rules = q.data?.rules ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: REFERRAL_RULES_QUERY_KEY });

  const patch = useMutation({
    mutationFn: ({
      id,
      change,
    }: {
      id: string;
      change: Parameters<typeof updateReferralRule>[1];
    }) => updateReferralRule(id, change),
    onSuccess: refresh,
    onError: (e) => {
      const overlap = overlapMessage(e);
      if (overlap) toast.error(overlap);
      else if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "save the commission rule" });
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteReferralRule(id),
    onSuccess: () => {
      toast.success("Rule removed — jobs fall back to the source rate");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "remove the commission rule" }),
  });

  return (
    <Card data-referral-rules>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Referrers</CardTitle>
        <p className="text-xs text-muted-foreground" data-commission-base>
          A deal with a referring company or person: a percentage of the job&rsquo;s revenue, or a
          flat fee per job. Revenue is what has been invoiced on the job &mdash; before an invoice,
          the approved estimate, then the agreed price, then the latest priced estimate &mdash; so
          the commission moves as charges are added.
        </p>
        <p className="text-xs text-muted-foreground">
          On a job, a rate typed on the job wins; then the person&rsquo;s rule, then their
          company&rsquo;s, then the &ldquo;Came from&rdquo; rate below.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {q.isError ? <LoadError what="the referrer rules" error={q.error} /> : null}
        {q.data && !q.data.available ? (
          <p className="px-3 pb-3 text-sm text-muted-foreground" data-rules-unavailable>
            Referrer rules need a database update that has not been applied yet. Jobs use the rates
            below until then.
          </p>
        ) : (
          <div className="divide-y border-y">
            {rules.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                No referrer has a deal of their own yet.
              </p>
            ) : (
              rules.map((r) => (
                <RuleRow
                  key={`${r.id}:${r.kind}:${r.value}:${r.effective_from}:${r.effective_to}`}
                  rule={r}
                  canEdit={canEdit}
                  onPatch={(change) => patch.mutate({ id: r.id, change })}
                  onRemove={() => remove.mutate(r.id)}
                />
              ))
            )}
          </div>
        )}
        {q.data?.available && canEdit ? <AddRule onAdded={refresh} /> : null}
      </CardContent>
    </Card>
  );
}

function RuleRow({
  rule,
  canEdit,
  onPatch,
  onRemove,
}: {
  rule: ReferralRuleRow;
  canEdit: boolean;
  onPatch: (change: Parameters<typeof updateReferralRule>[1]) => void;
  onRemove: () => void;
}) {
  const Icon = rule.payee_type === "account" ? Building2 : User;
  const window =
    rule.effective_from || rule.effective_to
      ? `${rule.effective_from ?? "always"} → ${rule.effective_to ?? "open"}`
      : null;
  return (
    <div
      data-rule-row
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_8rem_7rem_auto]"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{rule.payee_name}</div>
          <div className="truncate text-xs text-muted-foreground">
            {rule.payee_type === "account" ? "Company" : "Person"} · {describeBasis(rule)}
            {window ? ` · ${window}` : ""}
          </div>
        </div>
      </div>
      {canEdit ? (
        <>
          <Select value={rule.kind} onValueChange={(v) => onPatch({ kind: v as RuleKind })}>
            <SelectTrigger className="h-11 md:h-8" aria-label={`${rule.payee_name} kind`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">% of revenue</SelectItem>
              <SelectItem value="flat">Flat fee</SelectItem>
            </SelectContent>
          </Select>
          <NumberInput
            className="h-11 md:h-8"
            decimals={2}
            aria-label={`${rule.payee_name} ${rule.kind === "flat" ? "flat fee" : "rate"}`}
            defaultValue={rule.value}
            onCommit={(n) => n != null && n !== rule.value && onPatch({ value: n })}
          />
          <Button
            variant="ghost"
            size="icon"
            className="size-11 md:size-8"
            aria-label={`Remove the rule for ${rule.payee_name}`}
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
          </Button>
        </>
      ) : null}
    </div>
  );
}

function AddRule({ onAdded }: { onAdded: () => void }) {
  const [draft, setDraft] = useState<RuleDraft>(BLANK_RULE_DRAFT);
  const [payeeType, setPayeeType] = useState<"account" | "contact">("account");
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [contact, setContact] = useState<PickedContact | null>(null);

  const add = useMutation({
    mutationFn: () => insertReferralRule(draft),
    onSuccess: (row) => {
      toast.success(`${row.payee_name}: ${describeBasis(row)}`);
      setDraft(BLANK_RULE_DRAFT);
      setAccount(null);
      setContact(null);
      onAdded();
    },
    onError: (e) => {
      const overlap = overlapMessage(e);
      if (overlap) toast.error(overlap);
      else if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "add the commission rule" });
    },
  });

  const submit = () => {
    const problem = ruleProblem(draft);
    if (problem) return toast.error(problem);
    add.mutate();
  };

  return (
    <div className="space-y-2 px-3 pb-3" data-add-rule>
      <div className="text-xs font-medium">Add a deal</div>
      <Select
        value={payeeType}
        onValueChange={(v) => {
          setPayeeType(v as "account" | "contact");
          setAccount(null);
          setContact(null);
          setDraft((d) => ({ ...d, payee: null }));
        }}
      >
        <SelectTrigger className="h-11 md:h-9" aria-label="Company or person">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="account">With a company</SelectItem>
          <SelectItem value="contact">With a person</SelectItem>
        </SelectContent>
      </Select>
      {payeeType === "account" ? (
        <AccountPicker
          label="Referring company"
          value={account}
          allowCreate={false}
          onChange={(a) => {
            setAccount(a);
            setDraft((d) => ({ ...d, payee: a ? { type: "account", id: a.id } : null }));
          }}
        />
      ) : (
        <CompanyContactPicker
          personFirst
          accountLabel="Their company (to narrow the list)"
          contactLabel="Referring person"
          account={account}
          onAccountChange={setAccount}
          contact={contact}
          onContactChange={(c) => {
            setContact(c);
            setDraft((d) => ({ ...d, payee: c ? { type: "contact", id: c.id } : null }));
          }}
        />
      )}
      <div className="grid gap-2 sm:grid-cols-[10rem_8rem_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-1">
          <Label className="text-xs">Paid as</Label>
          <Select
            value={draft.kind}
            onValueChange={(v) => setDraft((d) => ({ ...d, kind: v as RuleKind }))}
          >
            <SelectTrigger className="h-11 md:h-9" aria-label="Percentage or flat fee">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="percent">% of revenue</SelectItem>
              <SelectItem value="flat">Flat fee per job</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{draft.kind === "flat" ? "Fee ($)" : "Rate (%)"}</Label>
          <NumberInput
            className="h-11 md:h-9"
            decimals={2}
            aria-label={draft.kind === "flat" ? "Flat fee" : "Rate percent"}
            value={draft.value}
            onValueChange={(n) => setDraft((d) => ({ ...d, value: n }))}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="rule-from">
            From (optional)
          </Label>
          <Input
            id="rule-from"
            type="date"
            className="h-11 md:h-9"
            value={draft.effective_from ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, effective_from: e.target.value || null }))}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="rule-to">
            Until (optional)
          </Label>
          <Input
            id="rule-to"
            type="date"
            className="h-11 md:h-9"
            value={draft.effective_to ?? ""}
            onChange={(e) => setDraft((d) => ({ ...d, effective_to: e.target.value || null }))}
          />
        </div>
      </div>
      <Button className="h-11 md:h-9" disabled={add.isPending} onClick={submit}>
        <Plus className="mr-1 size-4" /> Add deal
      </Button>
    </div>
  );
}
