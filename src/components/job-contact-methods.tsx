import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CONTACT_LABELS } from "@/lib/jobs";
import { toastDbError } from "@/lib/db-errors";
import {
  contactMethodsError,
  insertJobContactMethods,
  isBadContactEmail,
} from "@/lib/job-contact-methods";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Plus, Star, Trash2 } from "lucide-react";

type PersonMethods = {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
};

export type DraftMethod = {
  kind: "phone" | "email";
  label: string;
  value: string;
  extension?: string;
  is_preferred: boolean;
};

/**
 * Commercial restoration customers hand over several numbers and inboxes —
 * a site super, a billing address, an after-hours mobile. The preferred flag
 * is what tells a rep which one to actually use.
 */
export function ContactMethodEditor({
  value,
  onChange,
}: {
  value: DraftMethod[];
  onChange: (next: DraftMethod[]) => void;
}) {
  const add = (kind: "phone" | "email") =>
    onChange([
      ...value,
      {
        kind,
        label: kind === "phone" ? "Main" : "Work",
        value: "",
        is_preferred: value.filter((m) => m.kind === kind).length === 0,
      },
    ]);

  const update = (i: number, patch: Partial<DraftMethod>) =>
    onChange(value.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));

  const setPreferred = (i: number) =>
    onChange(
      value.map((m, idx) => (m.kind === value[i].kind ? { ...m, is_preferred: idx === i } : m)),
    );

  return (
    <div className="space-y-2">
      <Label className="text-xs">Phones & emails</Label>
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">
          None added. A preferred phone and email make the difference between reaching someone at
          2am and not.
        </p>
      )}
      {value.map((m, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 rounded border p-2">
          <Select value={m.label} onValueChange={(v) => update(i, { label: v })}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTACT_LABELS.map((l) => (
                <SelectItem key={l} value={l}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className={cn(
              "h-8 min-w-40 flex-1",
              isBadContactEmail(m) && "border-destructive focus-visible:ring-destructive",
            )}
            type={m.kind === "email" ? "email" : "tel"}
            placeholder={m.kind === "phone" ? "(718) 555-0143" : "name@company.com"}
            value={m.value}
            aria-invalid={isBadContactEmail(m) || undefined}
            onChange={(e) => update(i, { value: e.target.value })}
          />
          {m.kind === "phone" && (
            <Input
              className="h-8 w-20"
              placeholder="ext."
              value={m.extension ?? ""}
              onChange={(e) => update(i, { extension: e.target.value })}
            />
          )}
          <Button
            type="button"
            variant={m.is_preferred ? "default" : "outline"}
            size="sm"
            className="h-8"
            onClick={() => setPreferred(i)}
          >
            <Star className="size-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => onChange(value.filter((_, idx) => idx !== i))}
          >
            <Trash2 className="size-3.5" />
          </Button>
          {isBadContactEmail(m) && (
            <p className="w-full text-xs text-destructive">
              Enter a valid email, like name@company.com.
            </p>
          )}
        </div>
      ))}
      <div className="-ml-2 flex gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-[13px]"
          onClick={() => add("phone")}
        >
          <Plus className="size-3.5" /> Add phone
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-[13px]"
          onClick={() => add("email")}
        >
          <Plus className="size-3.5" /> Add email
        </Button>
      </div>
    </div>
  );
}

type StoredMethod = DraftMethod & { id: string };

/** Persisted variant used on the job record. */
export function JobContactMethodsPanel({
  jobId,
  contactId,
  disabled,
  version = 0,
}: {
  jobId: string;
  /** The job's main point of contact, whose own number is worth showing here. */
  contactId?: string | null;
  disabled?: boolean;
  /** Changes when something else added a method (an applied suggestion): re-read. */
  version?: number;
}) {
  const [rows, setRows] = useState<StoredMethod[]>([]);
  const [draft, setDraft] = useState<DraftMethod[]>([]);
  const [saving, setSaving] = useState(false);
  const [person, setPerson] = useState<PersonMethods | null>(null);

  /*
   * The card said "No phones or emails on this job yet" while naming a main
   * point of contact who has both. True, and useless: these rows are numbers
   * recorded FOR THIS JOB -- a site trailer, an after-hours mobile -- and the
   * contact's own details live on the contact. Somebody reading the card wants
   * to ring whoever is named on it, not learn a distinction between two tables.
   *
   * So the person's own details show here too, clearly as theirs and not as
   * something typed against this job. They are read-only on purpose: this is a
   * window onto the contact record, and editing them here would be editing a
   * record this card does not own.
   */
  useEffect(() => {
    let cancelled = false;
    if (!contactId) {
      setPerson(null);
      return;
    }
    void supabase
      .from("contacts")
      .select("id, full_name, phone, email")
      .eq("id", contactId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setPerson((data as PersonMethods | null) ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  const load = async () => {
    const { data } = await supabase
      .from("job_contact_methods")
      .select("id, kind, label, value, extension, is_preferred")
      .eq("job_id", jobId)
      .order("kind");
    setRows((data ?? []) as StoredMethod[]);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, version]);

  const remove = async (id: string) => {
    const { error } = await supabase.from("job_contact_methods").delete().eq("id", id);
    if (error) return toastDbError(error, { action: "Removing contact method" });
    load();
  };

  const makePreferred = async (row: StoredMethod) => {
    await supabase
      .from("job_contact_methods")
      .update({ is_preferred: false })
      .eq("job_id", jobId)
      .eq("kind", row.kind);
    const { error } = await supabase
      .from("job_contact_methods")
      .update({ is_preferred: true })
      .eq("id", row.id);
    if (error) return toastDbError(error, { action: "Setting preferred contact" });
    load();
  };

  const saveDraft = async () => {
    if (!draft.some((d) => d.value.trim())) return;
    const invalid = contactMethodsError(draft);
    if (invalid) return void toast.error(invalid);
    setSaving(true);
    try {
      await insertJobContactMethods(jobId, draft);
    } catch (error) {
      setSaving(false);
      return toastDbError(error, { action: "Adding contact methods" });
    }
    setSaving(false);
    setDraft([]);
    load();
  };

  return (
    <div className="space-y-3">
      {person && (person.phone || person.email) && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {person.full_name}
          </p>
          <ul className="space-y-2 text-sm">
            {person.phone && (
              <li className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-6 min-w-14 items-center justify-center rounded-full bg-muted px-2.5 text-xs font-semibold capitalize text-foreground">
                  Phone
                </span>
                <a className="underline-offset-2 hover:underline" href={`tel:${person.phone}`}>
                  {person.phone}
                </a>
              </li>
            )}
            {person.email && (
              <li className="flex flex-wrap items-center gap-2">
                <span className="inline-flex h-6 min-w-14 items-center justify-center rounded-full bg-muted px-2.5 text-xs font-semibold capitalize text-foreground">
                  Email
                </span>
                <a
                  className="min-w-0 break-all underline-offset-2 hover:underline"
                  href={`mailto:${person.email}`}
                >
                  {person.email}
                </a>
              </li>
            )}
          </ul>
          <p className="text-[11px] text-muted-foreground">
            From their contact record. Anything added below belongs to this job only.
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {person && (person.phone || person.email)
            ? "Nothing recorded for this job on top of the above."
            : "No phones or emails on this job yet."}
        </p>
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex min-h-8 items-center justify-between gap-2">
              <span className="flex min-w-0 flex-wrap items-center gap-2.5">
                <span className="inline-flex h-6 min-w-14 items-center justify-center rounded-full bg-muted px-2.5 text-xs font-semibold capitalize text-foreground">
                  {r.label ?? r.kind}
                </span>
                {r.kind === "phone" ? (
                  <a className="underline-offset-2 hover:underline" href={`tel:${r.value}`}>
                    {r.value}
                  </a>
                ) : (
                  <a className="underline-offset-2 hover:underline" href={`mailto:${r.value}`}>
                    {r.value}
                  </a>
                )}
                {r.extension && (
                  <span className="text-xs text-muted-foreground">ext. {r.extension}</span>
                )}
                {r.is_preferred && (
                  <span className="inline-flex h-6 items-center rounded-full bg-accent px-2.5 text-xs font-semibold text-accent-foreground">
                    Preferred
                  </span>
                )}
              </span>
              {!disabled && (
                <span className="flex items-center gap-1">
                  {!r.is_preferred && (
                    <Button size="sm" variant="ghost" onClick={() => makePreferred(r)}>
                      <Star className="size-3.5" />
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => remove(r.id)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {!disabled && (
        <>
          <ContactMethodEditor value={draft} onChange={setDraft} />
          {draft.length > 0 && (
            <Button size="sm" onClick={saveDraft} disabled={saving}>
              {saving ? "Saving…" : "Save contact methods"}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
