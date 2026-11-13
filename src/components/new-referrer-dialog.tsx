import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UserPlus } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import type { PickedAccount } from "@/components/account-picker";
import { CreateCustomerDialog } from "@/components/create-customer-dialog";
import type { PickedCustomer } from "@/components/customer-picker";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import type { RuleKind } from "@/lib/job-commission";
import { dealProblem, finishNewReferrer, type NewReferrerOutcome } from "@/lib/new-referrer";
import { insertReferralRule, overlapMessage } from "@/lib/referral-commission-rules";
import { isPrivileged } from "@/lib/roles";
import { isMissingSchema } from "@/lib/schema-fallback";
import { refreshJobCommission } from "@/lib/use-job-commission";
import { REFERRAL_RULES_QUERY_KEY } from "@/components/referral-commission-rules-admin";

/**
 * "+ New referrer" beside the General tab's referral picker. Mark, 7 Oct:
 * "and allow them to create a new person on the general tab as well with a
 * commission rate".
 *
 * Two steps, so nothing about creating a person is reinvented: first who
 * (a person or a company) and what they are paid; then the CRM's own create
 * dialog — the same duplicate check, office rules and permission as adding a
 * contact anywhere else, including "link to the existing one instead". When
 * it comes back, `finishNewReferrer` writes the deal (if this user may set
 * rates) and picks them on the job.
 */
export function NewReferrerButton({
  jobId,
  account,
  disabled,
  onDone,
}: {
  jobId: string;
  /** The referring company already picked, so a new person is filed under it. */
  account: PickedAccount | null;
  disabled?: boolean;
  onDone: (outcome: NewReferrerOutcome) => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const canSetRates = isPrivileged(app.roles);
  const [step, setStep] = useState<"closed" | "deal" | "create">("closed");
  const [who, setWho] = useState<"person" | "company">("person");
  // A dollar fee by default (David, 13 Oct: the commission is a dollar amount).
  const [kind, setKind] = useState<RuleKind>("flat");
  const [value, setValue] = useState<number | null>(null);

  const reset = () => {
    setStep("closed");
    setWho("person");
    setKind("percent");
    setValue(null);
  };

  const onCreated = async (created: PickedCustomer) => {
    setStep("closed");
    try {
      const outcome = await finishNewReferrer(created, { kind, value }, canSetRates, {
        insertRule: insertReferralRule,
        saveJobReferral: async (ref) => {
          const { error } = await supabase
            .from("jobs")
            .update({
              referred_by_account_id: ref.accountId,
              referred_by_contact_id: ref.contactId,
              referred_by_name: ref.name,
            })
            .eq("id", jobId);
          if (error) throw error;
        },
        overlapMessage,
        isMissingSchema,
      });
      if (outcome.rule === "written" || outcome.rule === "none_given")
        toast.success(outcome.message);
      else toast.warning(outcome.message);
      refreshJobCommission(qc, jobId);
      void qc.invalidateQueries({ queryKey: REFERRAL_RULES_QUERY_KEY });
      onDone(outcome);
    } catch (e) {
      toastDbError(e, { action: "make them the referrer on this job" });
    } finally {
      reset();
    }
  };

  const problem = dealProblem({ kind, value });

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 md:h-8"
        disabled={disabled}
        onClick={() => setStep("deal")}
      >
        <UserPlus className="mr-1 size-3.5" /> New referrer
      </Button>

      <Dialog open={step === "deal"} onOpenChange={(o) => (o ? setStep("deal") : reset())}>
        <DialogContent className="w-[min(28rem,calc(100vw-1.5rem))]" data-new-referrer>
          <DialogHeader>
            <DialogTitle>New referrer</DialogTitle>
            <DialogDescription>
              Who sent this job, and what they are paid. Next you add them to the CRM the usual way
              — if they are already there, you can link to them instead.
            </DialogDescription>
          </DialogHeader>
          <NewReferrerDealFields
            who={who}
            onWho={setWho}
            kind={kind}
            onKind={setKind}
            value={value}
            onValue={setValue}
            canSetRates={canSetRates}
            problem={problem}
          />
          <DialogFooter>
            <Button className="h-11 md:h-9" variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button className="h-11 md:h-9" disabled={!!problem} onClick={() => setStep("create")}>
              Continue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateCustomerDialog
        open={step === "create"}
        onOpenChange={(o) => {
          if (!o) reset();
        }}
        kind={who}
        defaultAccount={who === "person" ? account : null}
        onCreated={(c) => void onCreated(c)}
      />
    </>
  );
}

/**
 * The first step's fields: who, and what they are paid. Its own component so
 * the render test can see it without opening a portal. Someone who may not
 * set rates sees the boxes disabled and the sentence saying why.
 */
export function NewReferrerDealFields({
  who,
  onWho,
  kind,
  onKind,
  value,
  onValue,
  canSetRates,
  problem,
}: {
  who: "person" | "company";
  onWho: (v: "person" | "company") => void;
  kind: RuleKind;
  onKind: (v: RuleKind) => void;
  value: number | null;
  onValue: (v: number | null) => void;
  canSetRates: boolean;
  problem: string | null;
}) {
  return (
    <div className="grid gap-3">
      <div className="space-y-1">
        <Label className="text-xs">A person or a company</Label>
        <Select value={who} onValueChange={(v) => onWho(v as "person" | "company")}>
          <SelectTrigger className="h-11 md:h-9" aria-label="Referrer is a person or company">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="person">A person</SelectItem>
            <SelectItem value="company">A company</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {canSetRates && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Paid as</Label>
              <Select value={kind} onValueChange={(v) => onKind(v as RuleKind)}>
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
              <Label className="text-xs">{kind === "flat" ? "Fee ($)" : "Rate (%)"}</Label>
              <NumberInput
                className="h-11 md:h-9"
                decimals={2}
                aria-label={kind === "flat" ? "Referrer flat fee" : "Referrer rate percent"}
                placeholder="Optional"
                value={value}
                onValueChange={(n) => onValue(n)}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {kind === "flat"
              ? "The fee is paid per job they send, in dollars. Leave it blank to set it later in Settings › Commissions."
              : "A percentage is of the job’s revenue and follows them to every job they send. Leave it blank to set it later in Settings › Commissions."}
          </p>
        </>
      )}
      {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
    </div>
  );
}
