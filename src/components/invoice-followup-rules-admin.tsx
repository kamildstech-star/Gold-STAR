/**
 * Admin → Automations → Invoice follow-ups (client item 18, 21 Oct).
 *
 * The rules the every-15-minutes sweep applies to unpaid, SENT invoices: after
 * N days, a reminder from a chosen template; several steps make a sequence.
 * A company-wide rule is seeded (7 days, then 14); an office can have its own,
 * which wins for that office's invoices. The wording lives in Admin → Email
 * templates ("Invoice follow-up — first / second reminder").
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { EMAIL_TEMPLATE_DEFAULTS } from "@/lib/email-templates";
import {
  FOLLOWUP_TEMPLATE_KEYS,
  normalizeSteps,
  type FollowupRule,
  type FollowupStep,
} from "@/lib/invoice-followups";
import { isMissingSchema } from "@/lib/schema-fallback";

const db = supabase as unknown as import("@supabase/supabase-js").SupabaseClient;
export const FOLLOWUP_RULES_KEY = ["invoice-followup-rules"];

export async function loadFollowupRules(): Promise<FollowupRule[] | null> {
  const { data, error } = await db
    .from("invoice_followup_rules")
    .select("id, name, location_id, is_active, steps")
    .order("created_at");
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return ((data ?? []) as FollowupRule[]).map((r) => ({ ...r, steps: normalizeSteps(r.steps) }));
}

export function InvoiceFollowupRulesAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const rulesQ = useQuery({ queryKey: FOLLOWUP_RULES_KEY, queryFn: loadFollowupRules });

  const save = useMutation({
    mutationFn: async (rule: Partial<FollowupRule> & { id?: string }) => {
      const row = {
        name: (rule.name ?? "").trim() || "Invoice follow-ups",
        location_id: rule.location_id ?? null,
        is_active: rule.is_active ?? true,
        steps: normalizeSteps(rule.steps),
        updated_at: new Date().toISOString(),
      };
      if (!row.steps.length) throw new Error("A rule needs at least one step.");
      const res = rule.id
        ? await db.from("invoice_followup_rules").update(row).eq("id", rule.id)
        : await db.from("invoice_followup_rules").insert({ ...row, created_by: app.userId });
      if (res.error) throw res.error;
    },
    onSuccess: () => {
      toast.success("Follow-up rule saved");
      void qc.invalidateQueries({ queryKey: FOLLOWUP_RULES_KEY });
    },
    onError: (e) =>
      e instanceof Error && !("code" in e)
        ? toast.error(e.message)
        : toastDbError(e, { action: "save the follow-up rule" }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db.from("invoice_followup_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: FOLLOWUP_RULES_KEY }),
    onError: (e) => toastDbError(e, { action: "delete the follow-up rule" }),
  });

  if (rulesQ.data === null) {
    return (
      <p className="text-xs text-muted-foreground">
        Invoice follow-ups need a database update that has not been applied yet.
      </p>
    );
  }
  const rules = rulesQ.data ?? [];

  return (
    <div className="space-y-3" data-invoice-followup-rules>
      <p className="text-xs text-muted-foreground">
        Reminders go to the client for invoices that are <b>sent</b> and still owe money, a set
        number of days after the invoice was sent. Each step sends once. A payment that settles the
        invoice, writing it off, switching follow-ups off on the invoice, or the client’s{" "}
        <b>No automated follow-ups</b> setting stops anything still waiting. Reminders are queued
        like any email — held for the send delay, under Communications on the job’s Contacts tab. With no client
        email on file, the office gets a task instead. Edit the wording under Admin → Email
        templates.
      </p>
      {rules.map((r) => (
        <RuleCard
          key={r.id}
          rule={r}
          offices={app.visibleLocations}
          busy={save.isPending}
          onSave={(next) => save.mutate({ ...next, id: r.id })}
          onDelete={() => remove.mutate(r.id)}
        />
      ))}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          save.mutate({
            name: "Office reminders",
            location_id: app.visibleLocations[0]?.id ?? null,
            is_active: false,
            steps: [
              { days: 7, template_key: "invoice_followup_1" },
              { days: 14, template_key: "invoice_followup_2" },
            ],
          })
        }
      >
        <Plus className="mr-1.5 size-3.5" /> New rule (starts switched off)
      </Button>
    </div>
  );
}

function RuleCard({
  rule,
  offices,
  busy,
  onSave,
  onDelete,
}: {
  rule: FollowupRule;
  offices: { id: string; code: string; name: string }[];
  busy: boolean;
  onSave: (r: FollowupRule) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState<FollowupRule>(rule);
  const setStep = (i: number, patch: Partial<FollowupStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-sm">{rule.name}</CardTitle>
        <label className="flex items-center gap-2 text-xs">
          <Switch
            checked={draft.is_active}
            onCheckedChange={(v) => setDraft((d) => ({ ...d, is_active: v }))}
            aria-label="Rule active"
          />
          {draft.is_active ? "On" : "Off"}
        </label>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input
              className="h-9"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Applies to</Label>
            <Select
              value={draft.location_id ?? "all"}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, location_id: v === "all" ? null : v }))
              }
            >
              <SelectTrigger className="h-9" aria-label="Office">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Every office (company-wide)</SelectItem>
                {offices.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.code} · {o.name} only
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Steps</Label>
          {draft.steps.map((s, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 text-sm" data-followup-step>
              <span className="text-muted-foreground">After</span>
              <Input
                type="number"
                min={1}
                max={365}
                className="h-9 w-20"
                aria-label={`Step ${i + 1} days`}
                value={s.days}
                onChange={(e) => setStep(i, { days: Number(e.target.value) })}
              />
              <span className="text-muted-foreground">days unpaid, send</span>
              <Select value={s.template_key} onValueChange={(v) => setStep(i, { template_key: v })}>
                <SelectTrigger className="h-9 w-64" aria-label={`Step ${i + 1} template`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FOLLOWUP_TEMPLATE_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {EMAIL_TEMPLATE_DEFAULTS[k].name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                aria-label={`Remove step ${i + 1}`}
                onClick={() =>
                  setDraft((d) => ({ ...d, steps: d.steps.filter((_, j) => j !== i) }))
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                steps: [
                  ...d.steps,
                  {
                    days: (d.steps.at(-1)?.days ?? 0) + 7,
                    template_key: "invoice_followup_2",
                  },
                ],
              }))
            }
          >
            <Plus className="mr-1 size-3.5" /> Add a step
          </Button>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t pt-2">
          {rule.location_id ? (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
              Delete rule
            </Button>
          ) : null}
          <Button size="sm" disabled={busy} onClick={() => onSave(draft)}>
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
