import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link2, Mail, Plus, Receipt, Trash2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { EmailSendDelayCard } from "@/components/email-send-delay-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TokenEditor, htmlToText } from "@/components/token-editor";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import {
  EMAIL_CATEGORIES,
  EMAIL_CATEGORY_LABEL,
  PAYMENT_RECEIPT_TEMPLATE,
  type EmailCategory,
} from "@/lib/email";
import {
  EMAIL_TEMPLATE_DEFAULTS,
  fieldsFor,
  isEmailTemplateKey,
  renderEmail,
  sampleDataFor,
  unknownTokens,
} from "@/lib/email-templates";
import { tokensIn, MERGE_KEY_SET } from "@/lib/merge-keys";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/admin/email-templates")({
  head: () => ({
    meta: [
      { title: "Email templates — Recovery Hub" },
      {
        name: "description",
        content:
          "Rich-text email templates with merge keys that resolve from the job at send time.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: EmailTemplatesPage,
});

type Row = {
  id: string;
  key: string;
  name: string;
  category: EmailCategory;
  subject: string;
  body: string;
  signature: string | null;
  is_active: boolean;
  intake_form: boolean;
  updated_at: string;
  /** Null until somebody saves here; absent until the migration is applied. */
  updated_by?: string | null;
};

/*
 * `*` rather than a column list on purpose. `updated_by` arrives with
 * 20260918140000 and migrations are applied by hand after merge; naming a
 * column PostgREST does not have yet fails the WHOLE read and takes this screen
 * down. A star returns whatever the database actually has, and the field is
 * optional on Row below.
 */
const SELECT = "*";

/** Engine templates first, then everything hand-made, each alphabetically. */
function orderTemplates(rows: Row[]): Row[] {
  return [...rows].sort((a, b) => {
    const ea = isEmailTemplateKey(a.key) ? 0 : 1;
    const eb = isEmailTemplateKey(b.key) ? 0 : 1;
    return ea - eb || a.name.localeCompare(b.name);
  });
}

function EmailTemplatesPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["email-templates", "admin"],
    queryFn: async () => {
      const { data, error } = await supabase.from("email_templates").select(SELECT).order("name");
      if (error) throw error;
      return orderTemplates((data ?? []) as unknown as Row[]);
    },
  });

  // Who last edited, by name. A user id in the corner of an admin screen
  // tells nobody whose wording they are about to rewrite.
  const editors = useQuery({
    queryKey: ["email-templates", "editors"],
    queryFn: async () => {
      const { data } = await supabase.from("profiles").select("user_id, full_name");
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name ?? "Someone"]));
    },
  });

  const rows = list.data ?? [];
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  const editorName = (id: string | null | undefined) =>
    id ? (editors.data?.get(id) ?? "Someone") : null;

  const create = useMutation({
    mutationFn: async (preset?: "payment_receipt") => {
      const key = `template_${Date.now()}`;
      // The receipt wording carries {Payment.*} keys nobody should have to
      // type from memory, so that one purpose starts from the standard text.
      const seed =
        preset === "payment_receipt"
          ? {
              name: "Payment received — thank you",
              category: "payment_receipt" as EmailCategory,
              ...PAYMENT_RECEIPT_TEMPLATE,
            }
          : {
              name: "New template",
              category: "notification" as EmailCategory,
              subject: "",
              body: "",
            };
      const { data, error } = await supabase
        .from("email_templates")
        .insert({ key, ...seed })
        .select("id")
        .single();
      if (error) throw error;
      return data.id as string;
    },
    onSuccess: (id) => {
      setSelectedId(id);
      void qc.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (e) => toastDbError(e, { action: "Create template" }),
  });

  return (
    <div className="space-y-3">
      <EmailSendDelayCard />
      <div className="grid gap-3 lg:grid-cols-[280px_1fr]">
        <Card className="h-fit">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm">Email templates</CardTitle>
            <div className="flex items-center gap-1">
              {rows.some((r) => r.category === "payment_receipt") ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  title="Start a payment-receipt template from the standard wording"
                  onClick={() => create.mutate("payment_receipt")}
                  disabled={app.writesDisabled || create.isPending}
                >
                  <Receipt className="size-4" />
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => create.mutate(undefined)}
                disabled={app.writesDisabled || create.isPending}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">
                No email templates yet. A template is the wording of an outgoing email with merge
                keys like {"{Job.JobNumber}"} that fill from the job when it is sent.
              </p>
            ) : (
              <ul className="divide-y">
                {rows.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted/60 ${
                        r.id === selectedId ? "bg-muted" : ""
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        {r.name}
                        {r.intake_form ? <Link2 className="size-3 text-primary" /> : null}
                      </span>
                      {/*
                      The stable key is shown but never editable: code sends by
                      key, so a renamed key is a silently broken send.
                    */}
                      {isEmailTemplateKey(r.key) ? (
                        <span className="font-mono text-[10px] text-muted-foreground">{r.key}</span>
                      ) : null}
                      <span className="text-[11px] text-muted-foreground">
                        {EMAIL_CATEGORY_LABEL[r.category]}
                        {r.is_active ? "" : " · disabled"}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {`Edited ${new Date(r.updated_at).toLocaleDateString(DATE_LOCALE, US_DATE)}`}
                        {editorName(r.updated_by) ? ` by ${editorName(r.updated_by)}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {selected ? (
          <TemplateEditor
            key={selected.id}
            row={selected}
            lastEditor={editorName(selected.updated_by ?? null)}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              Select a template to edit, or create one. Insert merge keys from the category menus —
              they render highlighted here and resolve from the job when the email is sent.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({
  row,
  lastEditor,
  onDeleted,
}: {
  row: Row;
  lastEditor: string | null;
  onDeleted: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Row>(row);

  useEffect(() => setDraft(row), [row]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("email_templates")
        .update({
          name: draft.name,
          category: draft.category,
          subject: draft.subject,
          body: draft.body,
          signature: draft.signature,
          is_active: draft.is_active,
          intake_form: draft.intake_form,
          // updated_at is the table's own trigger; this is the name beside it.
          // Cast because the generated types lag 20260918140000.
          updated_by: app.userId,
        } as never)
        .eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Template saved");
      void qc.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (e) => toastDbError(e, { action: "Save template" }),
  });

  const remove = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("email_templates").delete().eq("id", row.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Template deleted");
      onDeleted();
      void qc.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (e) => toastDbError(e, { action: "Delete template" }),
  });

  const engineKey = isEmailTemplateKey(row.key) ? row.key : null;
  const fields = fieldsFor(engineKey);
  const plain = `${draft.subject}\n${htmlToText(draft.body)}`;
  const used = tokensIn(plain);

  /*
   * What counts as a typo depends on which kind of template this is.
   *
   * An engine template is rendered by renderEmailTemplate, which only fills its
   * own declared fields — so a global catalogue key like {Job.JobNumber} would
   * survive into a customer's inbox as literal text, and is flagged. A
   * hand-made template still goes through the old job-email path, so the global
   * catalogue is exactly what is legal there.
   */
  const unknown = engineKey
    ? unknownTokens(plain, engineKey)
    : used.filter((t) => !MERGE_KEY_SET.has(t));
  const hasIntakeToken = used.includes("IntakeLink");

  // Live preview, filled with realistic sample data for this key. The body is
  // shown as text rather than rendered HTML: this screen is for judging the
  // WORDING, and rendering admin-authored HTML would be the first innerHTML of
  // user content in the app for no gain here.
  const preview = renderEmail({
    subject: draft.subject,
    body: htmlToText(draft.body),
    data: sampleDataFor(engineKey),
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex flex-col items-start gap-0.5 text-sm">
          <span className="flex items-center gap-2">
            <Mail className="size-4" /> Edit template
            {engineKey ? (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {engineKey}
              </Badge>
            ) : null}
          </span>
          <span className="text-[11px] font-normal text-muted-foreground">
            {`Last edited ${new Date(row.updated_at).toLocaleString("en-US")}`}
            {lastEditor ? ` by ${lastEditor}` : " — not yet edited here"}
          </span>
        </CardTitle>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => remove.mutate()}
            disabled={app.writesDisabled || remove.isPending}
          >
            <Trash2 className="size-4" />
          </Button>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={app.writesDisabled || save.isPending || unknown.length > 0}
            title={unknown.length ? "Fix the unknown merge keys before saving." : undefined}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Label className="text-xs">Name</Label>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>
          <div>
            <Label className="text-xs">Category</Label>
            <Select
              value={draft.category}
              onValueChange={(v) => setDraft({ ...draft, category: v as EmailCategory })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMAIL_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {EMAIL_CATEGORY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label className="text-xs">Subject</Label>
          <Input
            value={draft.subject}
            onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
            placeholder="Request for information — {Job.SiteAddress.Address1}"
          />
        </div>

        <div>
          <Label className="text-xs">Body</Label>
          <TokenEditor
            value={draft.body}
            onChange={(html) => setDraft({ ...draft, body: html })}
            placeholder="Write the email — use Insert key to search every field…"
            extraTokens={fields}
          />
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={draft.is_active}
              onCheckedChange={(v) => setDraft({ ...draft, is_active: v })}
            />
            Enabled
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={draft.intake_form}
              onCheckedChange={(v) => setDraft({ ...draft, intake_form: v })}
            />
            Request for information — attach a secure intake form link
          </label>
        </div>

        {draft.intake_form && !hasIntakeToken ? (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Insert the {"{IntakeLink}"} key (Job menu) where the link should appear, otherwise the
            recipient gets no way to reply with the missing details.
          </p>
        ) : null}

        {used.length ? (
          <div className="flex flex-wrap gap-1">
            {used.map((t) => (
              <Badge
                key={t}
                variant={MERGE_KEY_SET.has(t) ? "secondary" : "destructive"}
                className="font-mono text-[10px]"
              >
                {`{${t}}`}
              </Badge>
            ))}
          </div>
        ) : null}
        {unknown.length ? (
          <p className="text-xs text-destructive">
            {engineKey
              ? `This template has no field called ${unknown.map((u) => `{{${u}}}`).join(", ")} — it would go out to the recipient exactly as written.`
              : `Unknown keys will be sent as-is: ${unknown.map((u) => `{${u}}`).join(", ")}`}
          </p>
        ) : null}

        {/*
          The preview. Filled with realistic sample data so the wording can be
          judged as a recipient will read it — and so an unfilled blank is
          obvious HERE rather than in somebody's inbox.
        */}
        {engineKey ? (
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-xs font-medium">Preview — filled with sample data</span>
              {preview.unresolved.length ? (
                <span className="text-[11px] text-destructive">
                  {preview.unresolved.length} blank
                  {preview.unresolved.length === 1 ? "" : "s"} not filled:{" "}
                  {preview.unresolved.map((u) => `{{${u}}}`).join(", ")}
                </span>
              ) : (
                <span className="text-[11px] text-muted-foreground">Every blank filled</span>
              )}
            </div>
            <p className="mb-2 text-sm font-medium">{preview.subject || "(no subject)"}</p>
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">
              {preview.body.trim() || "(no body yet)"}
            </p>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Wording only — the sample values above are made up, and nothing is sent from this
              screen.
            </p>
          </div>
        ) : null}

        {engineKey ? (
          <p className="text-[11px] text-muted-foreground">
            {EMAIL_TEMPLATE_DEFAULTS[engineKey].description} Code finds this template by its key,
            <span className="font-mono"> {engineKey}</span>, so the key never changes — the wording
            behind it is yours to edit.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
