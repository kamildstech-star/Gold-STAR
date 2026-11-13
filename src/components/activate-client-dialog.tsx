/**
 * The screen that appears when a deal is dropped into Active Clients.
 *
 * Mark: "a small screen appears with everything already filled in ... The date
 * the client gave the green light, which defaults to today but can be changed,
 * because reps often log something on Tuesday that happened last Thursday.
 * That date starts the clock." And: "None of the fields are mandatory."
 *
 * So this asks, it does not interrogate. Every question can be left alone and
 * the client is still won; the answers only decide what gets created for
 * somebody to chase afterwards. The questions come from the account's own
 * label -- a management company is asked about COIs and vendor packets, a
 * referral partner about fees -- and what each answer will create is printed
 * under it, so nobody agrees to work they cannot see.
 *
 * Two writes, in order and never merged: activate first, then the onboarding.
 * If the onboarding call fails the client is still won, which is the half that
 * matters, and the failure says so rather than rolling back a win.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PartyPopper } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { celebrate } from "@/lib/confetti";
import { toastDbError } from "@/lib/db-errors";
import { activateClient, applyOnboarding } from "@/lib/pipeline-rules";
import {
  ONBOARDING_LABEL_TITLE,
  ONBOARDING_QUESTIONS,
  REFERRAL_FEE_BASES,
  onboardingLabelForAccount,
  onboardingLabelFromNames,
  type OnboardingAnswers,
  type OnboardingQuestion,
  type ReferralFeeAnswer,
} from "@/lib/onboarding-questions";

export type ActivateTarget = {
  id: string;
  name: string;
  account_type?: string | null;
  what_they_do?: string[] | null;
  /** Label names on the account. A category label here decides the questions. */
  labels?: string[] | null;
};

/** Today, in the viewer's own timezone. UTC is already tomorrow by teatime. */
export function todayLocal(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** The answers actually worth sending: a blank one is not an answer. */
export function collectAnswers(
  questions: OnboardingQuestion[],
  answers: Record<string, unknown>,
  fee: ReferralFeeAnswer,
): OnboardingAnswers {
  const out: OnboardingAnswers = {};
  for (const q of questions) {
    const v = answers[q.key];
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[q.key] = v;
  }
  if (fee.basis || fee.contact_id || fee.rate_percent || fee.amount || fee.notes) {
    out.referral_fee = fee;
  }
  return out;
}

/** A question hidden by `showWhen` is not asked, so its answer is not sent. */
export function visibleQuestions(
  questions: OnboardingQuestion[],
  answers: Record<string, unknown>,
): OnboardingQuestion[] {
  return questions.filter((q) => !q.showWhen || answers[q.showWhen.key] === q.showWhen.equals);
}

export function ActivateClientDialog({
  target,
  onOpenChange,
  onDone,
}: {
  target: ActivateTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => void;
}) {
  const [greenLight, setGreenLight] = useState(todayLocal);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [fee, setFee] = useState<ReferralFeeAnswer>({});
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  /*
   * A category label put on the account by hand beats the guess made from its
   * type. Mark asked for the six categories "as labels ... and the questions
   * tied to them", and the reason is that the guess is sometimes wrong: an
   * account typed commercial that is really a broker got the wrong questions
   * and there was no way to say so. Type inference stays as the fallback for
   * every account nobody has labelled.
   */
  const label = useMemo(
    () =>
      target
        ? (onboardingLabelFromNames(target.labels) ?? onboardingLabelForAccount(target))
        : null,
    [target],
  );
  const questions = label ? ONBOARDING_QUESTIONS[label] : [];
  const visible = visibleQuestions(questions, answers);

  const set = (key: string, value: unknown) => setAnswers((a) => ({ ...a, [key]: value }));

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      // The date starts the client clock, so it goes with the activation.
      await activateClient(target.id, greenLight || undefined);

      let made = { tasks: 0, compliance: 0, fees: 0 };
      try {
        const r = await applyOnboarding(target.id, collectAnswers(visible, answers, fee));
        made = {
          tasks: r.tasks.length,
          compliance: r.compliance_requirements.length,
          fees: r.referral_fees.length,
        };
      } catch (e) {
        // The win stands. Only the paperwork failed, and saying which is the
        // difference between "try again" and "go and check what happened".
        toastDbError(e, { action: "create the onboarding paperwork" });
      }

      celebrate();
      const bits = [
        made.tasks ? `${made.tasks} task${made.tasks === 1 ? "" : "s"}` : null,
        made.compliance
          ? `${made.compliance} compliance item${made.compliance === 1 ? "" : "s"}`
          : null,
        made.fees ? `${made.fees} referral fee${made.fees === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      /*
       * Mark: "have a button in the success message that links you to that
       * client if you want to go into that client to make more changes or see
       * it."
       *
       * Winning a client is usually the start of something, not the end -- the
       * next thing is often adding a contact or checking the paperwork that was
       * just created. Without this the only route back is to find them again on
       * a board they have just left.
       */
      toast.success(
        `${target.name} is an active client${bits.length ? ` — ${bits.join(", ")} created` : ""}`,
        {
          action: {
            label: "Open client",
            onClick: () => void navigate({ to: "/accounts/$id", params: { id: target.id } }),
          },
          duration: 10_000,
        },
      );
      onOpenChange(false);
      setAnswers({});
      setFee({});
      onDone();
    } catch (e) {
      toastDbError(e, { action: "make this an active client" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <DialogContent className="max-h-[85svh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PartyPopper className="size-4 text-muted-foreground" />
            Win {target?.name}
          </DialogTitle>
          <DialogDescription>
            {label ? ONBOARDING_LABEL_TITLE[label] : "Onboarding"}. Nothing here is required. Skip
            what you do not know and it simply will not be created.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <Label htmlFor="green-light">Green light date</Label>
            <Input
              id="green-light"
              type="date"
              value={greenLight}
              max={todayLocal()}
              onChange={(e) => setGreenLight(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              When they actually said yes, which is what starts the client clock. Defaults to today.
            </p>
          </div>

          {visible.map((q) => (
            <QuestionField
              key={q.key}
              q={q}
              value={answers[q.key]}
              onChange={(v) => set(q.key, v)}
              fee={fee}
              onFeeChange={setFee}
            />
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy ? "Winning…" : "Make active client"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QuestionField({
  q,
  value,
  onChange,
  fee,
  onFeeChange,
}: {
  q: OnboardingQuestion;
  value: unknown;
  onChange: (v: unknown) => void;
  fee: ReferralFeeAnswer;
  onFeeChange: (f: ReferralFeeAnswer) => void;
}) {
  if (q.type === "referral_fee") {
    return (
      <div className="grid gap-1.5 rounded-lg border p-3">
        <Label>{q.label}</Label>
        {q.hint && <p className="text-[11px] text-muted-foreground">{q.hint}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            value={fee.basis ?? ""}
            onValueChange={(v) => onFeeChange({ ...fee, basis: v as ReferralFeeAnswer["basis"] })}
          >
            <SelectTrigger>
              <SelectValue placeholder="How is it paid?" />
            </SelectTrigger>
            <SelectContent>
              {REFERRAL_FEE_BASES.map((b) => (
                <SelectItem key={b.value} value={b.value}>
                  {b.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            inputMode="decimal"
            placeholder={fee.basis === "percent" ? "Percent" : "Amount"}
            value={String((fee.basis === "percent" ? fee.rate_percent : fee.amount) ?? "")}
            onChange={(e) =>
              onFeeChange(
                fee.basis === "percent"
                  ? { ...fee, rate_percent: e.target.value }
                  : { ...fee, amount: e.target.value },
              )
            }
          />
        </div>
        <Input
          placeholder="Note — who it goes to, anything unusual"
          value={fee.notes ?? ""}
          onChange={(e) => onFeeChange({ ...fee, notes: e.target.value })}
        />
        {q.effect && <p className="text-[11px] text-muted-foreground">{q.effect}</p>}
      </div>
    );
  }

  if (q.type === "boolean") {
    return (
      <label className="flex items-start gap-2.5">
        <Checkbox
          checked={value === true}
          onCheckedChange={(v) => onChange(v === true ? true : undefined)}
          className="mt-0.5"
        />
        <span>
          <span className="text-sm">{q.label}</span>
          {q.hint && <span className="block text-[11px] text-muted-foreground">{q.hint}</span>}
          {q.effect && <span className="block text-[11px] text-muted-foreground">{q.effect}</span>}
        </span>
      </label>
    );
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={`ob-${q.key}`}>{q.label}</Label>
      {q.hint && <p className="text-[11px] text-muted-foreground">{q.hint}</p>}
      {q.type === "select" ? (
        <Select value={String(value ?? "")} onValueChange={onChange}>
          <SelectTrigger id={`ob-${q.key}`}>
            <SelectValue placeholder="Not known" />
          </SelectTrigger>
          <SelectContent>
            {(q.options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : q.type === "multiselect" ? (
        <div className="grid gap-1.5">
          {(q.options ?? []).map((o) => {
            const list = Array.isArray(value) ? (value as string[]) : [];
            return (
              <label key={o.value} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={list.includes(o.value)}
                  onCheckedChange={(v) =>
                    onChange(v === true ? [...list, o.value] : list.filter((x) => x !== o.value))
                  }
                />
                {o.label}
              </label>
            );
          })}
        </div>
      ) : q.type === "number" ? (
        <Input
          id={`ob-${q.key}`}
          inputMode="decimal"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Textarea
          id={`ob-${q.key}`}
          rows={2}
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {q.effect && <p className="text-[11px] text-muted-foreground">{q.effect}</p>}
    </div>
  );
}
