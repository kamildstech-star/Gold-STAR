import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney, JOB_STATUS_LABELS, JOB_STATUSES } from "@/lib/jobs";
import {
  coerceJobValue,
  JOB_FIELD_BY_KEY,
  pickerStartAccountId,
  type JobFieldDef,
} from "@/lib/job-fields";
import { useJobFieldAccess } from "@/lib/job-field-access";
import { saveJobField, updateJobFields, updateJobFieldsQueued } from "@/lib/job-update";
import {
  COMPANY_TEXT_COMPANION,
  updateCompanyPerson,
  type SharedPersonField,
} from "@/lib/company-people";
import { LinkedEditChoice, type LinkedEditScope } from "@/components/linked-edit-choice";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import { useJobStages } from "@/lib/job-stages";
import { useManagedOptions, optionsFrom, type ManagedOption } from "@/lib/managed-options";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { CompanyContactPicker, type PickedContact } from "@/components/company-contact-picker";
import { LocationPicker } from "@/components/location-picker";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/* --------------------------------------------------------- section edit */

/**
 * Click-to-edit is right for correcting one value, and wrong for filling a
 * card in — nobody wants to click twelve times to type an adjuster's details.
 * A card wraps itself in SectionEdit and gets a pencil that opens all of its
 * inline fields at once.
 *
 * 4 Nov: "before make done why it is saving??" Under the pencil a field no
 * longer writes on blur: it stages its write here, and the card writes them
 * all when Done closes it. Nothing else saves them: a card that goes away
 * while open (another tab, a new page) drops what it holds and says so. A
 * single field opened on its own (click, not the pencil) still saves as it
 * always did.
 */
type Staged = () => void | Promise<void>;
interface SectionEditState {
  editing: boolean;
  /** Hold a write until Done. Null outside a SectionEdit. */
  stage: ((key: string, run: Staged) => void) | null;
}
const SectionEditContext = createContext<SectionEditState>({ editing: false, stage: null });

export function useSectionEdit() {
  return useContext(SectionEditContext).editing;
}

/** The staging hook for a field under the pencil; null when it should save now. */
export function useSectionStage() {
  const ctx = useContext(SectionEditContext);
  return ctx.editing ? ctx.stage : null;
}

export function SectionEdit({
  editing,
  children,
}: {
  editing: boolean;
  children: React.ReactNode;
}) {
  const staged = useRef(new Map<string, Staged>());
  const flush = () => {
    const runs = [...staged.current.values()];
    staged.current.clear();
    // One after another, in the order typed: a field's write can read the last.
    void runs.reduce<Promise<void>>(
      (p, run) => p.then(() => run()).catch(() => undefined),
      Promise.resolve(),
    );
  };
  const was = useRef(editing);
  useEffect(() => {
    if (was.current && !editing) flush();
    was.current = editing;
  });
  /* 4 Nov: "i open it, make it editable and move to next tab then it is
     saving — why?" Only Done saves. Leaving with changes held drops them,
     and says so, rather than writing what nobody confirmed. */
  useEffect(
    () => () => {
      if (staged.current.size === 0) return;
      staged.current.clear();
      toast.info("Changes not saved — press Done to save them.");
    },
    [],
  );
  const value = useMemo<SectionEditState>(
    () => ({
      editing,
      stage: (key, run) => {
        staged.current.delete(key);
        staged.current.set(key, run);
      },
    }),
    [editing],
  );
  return <SectionEditContext.Provider value={value}>{children}</SectionEditContext.Provider>;
}

/** The pencil itself — put it in the card header. */
export function SectionEditToggle({
  editing,
  onToggle,
  disabled,
}: {
  editing: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={editing ? "secondary" : "ghost"}
      disabled={disabled}
      onClick={onToggle}
      className="h-8 px-2.5 text-[13px] text-muted-foreground hover:text-foreground"
      aria-pressed={editing}
      aria-label={editing ? "Done editing" : "Edit all fields in this section"}
    >
      <Pencil className="size-3.5" />
      {editing ? "Done" : "Edit"}
    </Button>
  );
}

/* ------------------------------------------------------------- fallbacks */

const STATUS_FALLBACK = optionsFrom(JOB_STATUSES, JOB_STATUS_LABELS);
const CUSTOMER_KIND_FALLBACK: ManagedOption[] = [
  { key: "person", label: "Person" },
  { key: "company", label: "Company" },
];
const PRIORITY_FALLBACK: ManagedOption[] = [
  { key: "low", label: "Low" },
  { key: "normal", label: "Normal" },
  { key: "high", label: "High" },
  { key: "urgent", label: "Urgent" },
];
const NO_FALLBACK: ManagedOption[] = [];

function fallbackFor(list: string | undefined): ManagedOption[] {
  switch (list) {
    case "job_status":
      return STATUS_FALLBACK;
    case "customer_kind":
      return CUSTOMER_KIND_FALLBACK;
    case "job_priority":
      return PRIORITY_FALLBACK;
    default:
      return NO_FALLBACK;
  }
}

/** Staff for people-pickers (crew chief). */
function useStaff() {
  const q = useQuery({
    queryKey: ["job-staff-options"],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name")
        .limit(500);
      return (data ?? []) as { user_id: string; full_name: string | null }[];
    },
    staleTime: 5 * 60_000,
  });
  return q.data ?? [];
}

/* ------------------------------------------------------------ display */

export interface JobRecordLike {
  id: string;
  [key: string]: unknown;
}

function useDisplay(job: JobRecordLike, def: JobFieldDef) {
  const raw = job[def.key];
  const stages = useJobStages((job["location_id"] as string) ?? null);
  const opts = useManagedOptions(def.list ?? "__none", fallbackFor(def.list));
  const staff = useStaff();

  const relQ = useQuery({
    queryKey: ["job-field-rel", def.kind, raw],
    enabled:
      (def.kind === "account" || def.kind === "contact" || def.kind === "location") &&
      typeof raw === "string" &&
      !!raw,
    queryFn: async () => {
      const id = raw as string;
      if (def.kind === "account") {
        const { data } = await supabase.from("accounts").select("name").eq("id", id).maybeSingle();
        return data?.name ?? null;
      }
      if (def.kind === "contact") {
        const { data } = await supabase
          .from("contacts")
          .select("full_name")
          .eq("id", id)
          .maybeSingle();
        return data?.full_name ?? null;
      }
      const { data } = await supabase.from("locations").select("name").eq("id", id).maybeSingle();
      return data?.name ?? null;
    },
    staleTime: 5 * 60_000,
  });

  if (raw == null || raw === "") return "—";
  switch (def.kind) {
    case "money":
      return fmtMoney(Number(raw));
    case "date":
      return fmtDate(String(raw));
    case "time":
      return String(raw).slice(0, 5);
    case "bool":
      return raw ? "Yes" : "No";
    case "option":
      return opts.label(String(raw));
    case "stage":
      return stages.stageById.get(String(raw))?.name ?? "—";
    case "user":
      return staff.find((s) => s.user_id === raw)?.full_name ?? String(raw).slice(0, 8);
    case "account":
    case "contact":
    case "location":
      return relQ.data ?? "…";
    default:
      return String(raw);
  }
}

/* ------------------------------------------------------------ the field */

/**
 * A job field that holds a copy of a CRM person's name, email or phone — the
 * person was picked from a company's records. Editing it asks whether the
 * change is to the person or to this job (see LinkedEditChoice).
 */
export interface LinkedPerson {
  contactId: string;
  personName: string;
  companyName: string | null;
  field: SharedPersonField;
  /** Whether the viewer may edit the company's people; false means job-only. */
  canUpdateRecord: boolean;
}

export function JobField({
  job,
  fieldKey,
  label,
  onSaved,
  className,
  block,
  linked,
  emptyText,
  onWritten,
}: {
  job: JobRecordLike;
  fieldKey: string;
  label?: string;
  onSaved?: () => void;
  /** After a write lands, with the job as it was before it. */
  onWritten?: (value: unknown, before: JobRecordLike) => void | Promise<void>;
  className?: string;
  /** Stack label above the value — used for long text. */
  block?: boolean;
  /** Set when this value was copied from a picked CRM person. */
  linked?: LinkedPerson | null;
  /** Shown instead of "—" when the field is empty (e.g. a typed name with no record yet). */
  emptyText?: string | null;
}) {
  const def = JOB_FIELD_BY_KEY[fieldKey];
  const access = useJobFieldAccess();
  const sectionEditing = useSectionEdit();
  const sectionStage = useSectionStage();
  const stageKey = useId();
  const [editing, setEditing] = useState(false);
  /* A write held until Done (see SectionEdit). Until then the field shows —
     and its editor holds — the held value, laid over the job row. */
  const [staged, setStaged] = useState<{ value: unknown } | null>(null);
  const viewJob = useMemo(
    () => (staged ? { ...job, [fieldKey]: staged.value } : job),
    [job, fieldKey, staged],
  );
  const [pending, setPending] = useState<unknown>(undefined);
  const [pendingExtra, setPendingExtra] = useState<Record<string, unknown> | undefined>();
  const [linkedPending, setLinkedPending] = useState<unknown>(undefined);
  const rawDisplay = useDisplay(
    viewJob,
    def ?? { key: fieldKey, label: fieldKey, group: "identity", kind: "text" },
  );
  const display =
    rawDisplay === "—" && emptyText?.trim() && !staged ? emptyText.trim() : rawDisplay;
  // Done has written it (or the card went away): the job row is the truth again.
  useEffect(() => {
    if (!sectionEditing) setStaged(null);
  }, [sectionEditing]);

  if (!def) return null;
  if (!access.canSee(fieldKey)) return null;
  const editable = access.canEdit(fieldKey);
  const title = label ?? def.label;

  /*
   * A section pencil opens every field in the card at once. Relation fields
   * are excluded on purpose — account and contact edit through a dialog, and
   * unlocking a card would otherwise try to open six dialogs at the same time.
   * Those keep their click-to-open behaviour and stay reachable.
   */
  const inlineKind = def.kind !== "account" && def.kind !== "contact" && def.kind !== "location";
  const open = editing || (sectionEditing && editable && inlineKind);

  /*
   * `extra` rides along in the same write — a picked firm's name into the
   * firm's typed column, so the two never disagree on a document.
   */
  const commit = async (value: unknown, extra?: Record<string, unknown>) => {
    if (value === viewJob[def.key] && !extra) {
      setEditing(false);
      return;
    }
    if (def.warn) {
      setPending(value);
      setPendingExtra(extra);
      return;
    }
    if (linked && !extra) {
      setLinkedPending(value);
      return;
    }
    await write(value, extra);
  };

  const write = async (value: unknown, extra?: Record<string, unknown>) => {
    // Under the pencil: hold it for Done (see SectionEdit).
    if (sectionStage) {
      sectionStage(stageKey, () => writeNow(value, extra));
      setStaged({ value });
      setEditing(false);
      setPending(undefined);
      setPendingExtra(undefined);
      return;
    }
    await writeNow(value, extra);
  };

  const writeNow = async (value: unknown, extra?: Record<string, unknown>) => {
    // The job as it stood when this change was made — a held write runs later.
    const before = job;
    let ok: boolean;
    if (extra) {
      const res = await updateJobFieldsQueued(job.id, { ...extra, [def.key]: value }, title);
      if (res.queued)
        toast.warning(`${title} held on this device — it saves when you have signal.`);
      else if (res.ok) toast.success(`${title} saved`);
      ok = res.ok;
    } else {
      ok = await saveJobField(job.id, def.key, value, title);
    }
    setEditing(false);
    setPending(undefined);
    setPendingExtra(undefined);
    if (ok && value !== before[def.key]) await onWritten?.(value, before);
    if (ok) onSaved?.();
  };

  /** The answer to "update the company record, or this job only?" */
  const writeLinked = async (scope: LinkedEditScope) => {
    const value = linkedPending;
    if (scope === "record" && linked) {
      try {
        const v = value == null || value === "" ? null : String(value);
        await updateCompanyPerson(linked.contactId, { [linked.field]: v });
      } catch (e) {
        toastDbError(e, { action: "Updating the company record" });
        return;
      }
    }
    setLinkedPending(undefined);
    await write(value);
  };

  return (
    <>
      <div
        data-job-field={block ? "block" : "row"}
        className={cn(
          block
            ? "space-y-1"
            : /*
               * A fixed label column rather than justify-between. Pushing the
               * value to the far edge reads fine in a narrow card, but once
               * cards got wider the value ended up inches from its own label
               * and the eye lost the pairing. This keeps them adjacent at any
               * width while values still line up down the card.
               */
              "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3",
          "group/field",
          className,
        )}
      >
        <span className="min-w-0 max-w-[9rem] text-muted-foreground">{title}</span>
        {open ? (
          <div className="w-full">
            <JobFieldEditor
              job={viewJob}
              def={def}
              autoOpen={editing}
              onCancel={() => setEditing(false)}
              onCommit={commit}
            />
          </div>
        ) : !editable ? (
          /* Not editable here: plain text, no button, no hover hint. */
          <span
            data-job-field-readonly
            className={cn(block ? "block whitespace-pre-wrap" : "min-h-7 px-1 -mx-1 py-0.5")}
          >
            {display}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={cn(
              "group/btn inline-flex items-center gap-1.5 rounded-sm text-left",
              block && "w-full justify-start",
              /*
               * 28 Oct: plain text in view mode. The filled bubble added on
               * 27 Oct made every card much bigger ("I'm not sure I like the
               * bubbles around"); a value now takes one line's height, with
               * a light hover to say it can be clicked.
               */
              !block && "min-h-7 w-full justify-between px-1 -mx-1 py-0.5",
              block ? "cursor-text px-1 -mx-1 hover:bg-muted/60" : "cursor-text hover:bg-muted/70",
              /*
               * Account and contact fields cannot join the section unlock -
               * they edit through a dialog and a card full of them would open
               * six at once. Under the pencil they were left looking like dead
               * text, so they get the shape of a control instead: it is
               * obviously clickable, and one click opens the picker.
               */
              sectionEditing && !inlineKind
                ? "h-9 w-full rounded-md border border-input bg-background px-3 hover:bg-muted/40"
                : "",
            )}
            title="Click to edit"
          >
            <span
              className={cn(
                block && "whitespace-pre-wrap",
                sectionEditing && !inlineKind && display === "—" ? "text-muted-foreground" : "",
              )}
            >
              {sectionEditing && !inlineKind && display === "—" ? "Choose…" : display}
            </span>
            <Pencil className="size-3 shrink-0 opacity-0 transition-opacity group-hover/field:opacity-60" />
          </button>
        )}
      </div>

      <AlertDialog
        open={pending !== undefined}
        onOpenChange={(o) => {
          if (!o) setPending(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change {title.toLowerCase()}?</AlertDialogTitle>
            <AlertDialogDescription>{def.warn}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPending(undefined)}>Keep as is</AlertDialogCancel>
            <AlertDialogAction onClick={() => void write(pending, pendingExtra)}>
              Change anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {linked && (
        <LinkedEditChoice
          open={linkedPending !== undefined}
          personName={linked.personName}
          companyName={linked.companyName}
          fieldLabel={linked.field === "full_name" ? "name" : linked.field}
          canUpdateRecord={linked.canUpdateRecord}
          onChoose={writeLinked}
          onCancel={() => {
            setLinkedPending(undefined);
            setEditing(false);
          }}
        />
      )}
    </>
  );
}

/* ---------------------------------------------------------- the editors */

export function JobFieldEditor({
  job,
  def,
  onCommit,
  onCancel,
  autoFocus = true,
  autoOpen,
}: {
  job: JobRecordLike;
  def: JobFieldDef;
  onCommit: (value: unknown, extra?: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
  autoFocus?: boolean;
  /** Only when the field was clicked. Never under the section pencil. */
  autoOpen?: boolean;
}) {
  const initial = job[def.key];
  const [text, setText] = useState(initial == null ? "" : String(initial));
  const opts = useManagedOptions(def.list ?? "__none", fallbackFor(def.list));
  const { stages } = useJobStages((job["location_id"] as string) ?? null);
  const staff = useStaff();
  const [relOpen, setRelOpen] = useState(true);
  const escaped = useRef(false);

  useEffect(() => {
    setText(initial == null ? "" : String(initial));
  }, [initial]);

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      escaped.current = true;
      e.preventDefault();
      onCancel();
    }
    if (e.key === "Enter" && def.kind !== "textarea") {
      e.preventDefault();
      void onCommit(coerceJobValue(def, text));
    }
    if (e.key === "Enter" && def.kind === "textarea" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void onCommit(coerceJobValue(def, text));
    }
  };

  const blur = () => {
    if (escaped.current) {
      escaped.current = false;
      return;
    }
    void onCommit(coerceJobValue(def, text));
  };

  switch (def.kind) {
    case "textarea":
      return (
        <Textarea
          autoFocus={autoFocus}
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          onBlur={blur}
          placeholder="Escape cancels · ⌘Enter saves"
        />
      );

    case "bool":
      return (
        <Select
          defaultOpen={autoOpen}
          value={initial == null ? "" : initial ? "true" : "false"}
          onValueChange={(v) => void onCommit(v === "true")}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="true">Yes</SelectItem>
            <SelectItem value="false">No</SelectItem>
          </SelectContent>
        </Select>
      );

    case "option":
      return (
        <Select
          defaultOpen={autoOpen}
          value={initial == null ? "" : String(initial)}
          onValueChange={(v) => void onCommit(v || null)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose" />
          </SelectTrigger>
          <SelectContent>
            {opts.options.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "stage":
      return (
        <Select
          defaultOpen={autoOpen}
          value={initial == null ? "" : String(initial)}
          onValueChange={(v) => void onCommit(v || null)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose stage" />
          </SelectTrigger>
          <SelectContent>
            {stages.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "user":
      return (
        <Select
          defaultOpen={autoOpen}
          value={initial == null ? "" : String(initial)}
          onValueChange={(v) => void onCommit(v || null)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose person" />
          </SelectTrigger>
          <SelectContent>
            {staff.map((s) => (
              <SelectItem key={s.user_id} value={s.user_id}>
                {s.full_name || s.user_id.slice(0, 8)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );

    case "location":
      return (
        <LocationPicker
          value={initial == null ? "" : String(initial)}
          onChange={(id) => void onCommit(id || null)}
          label={null}
          noPrefill
        />
      );

    case "account":
    case "contact":
      return (
        <RelationshipEditor
          job={job}
          def={def}
          open={relOpen}
          onOpenChange={(o) => {
            setRelOpen(o);
            if (!o) onCancel();
          }}
          onCommit={onCommit}
        />
      );

    case "address":
      return (
        <AddressAutocomplete
          label=""
          value={text}
          autoFocus={autoFocus}
          onValueChange={setText}
          onSelect={(s) => {
            void updateJobFields(job.id, {
              address: s.address,
              locality: s.locality ?? null,
              region: s.region ?? null,
              postal_code: s.postal_code ?? null,
              county: (s as { county?: string | null }).county ?? null,
              lat: s.lat ?? null,
              lon: s.lon ?? null,
            }).then(() => onCommit(s.address));
          }}
        />
      );

    default:
      return (
        <Input
          autoFocus={autoFocus}
          type={
            def.kind === "date"
              ? "date"
              : def.kind === "time"
                ? "time"
                : def.kind === "number" || def.kind === "money"
                  ? "text"
                  : def.kind === "email"
                    ? "email"
                    : "text"
          }
          inputMode={def.kind === "money" || def.kind === "number" ? "decimal" : undefined}
          value={def.kind === "time" ? text.slice(0, 5) : text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={keys}
          onBlur={blur}
          placeholder={def.placeholder}
        />
      );
  }
}

/**
 * Account and contact fields keep the picker used elsewhere — smart-fill,
 * cross-location minimal results and create-new inside the popup.
 */
function RelationshipEditor({
  job,
  def,
  open,
  onOpenChange,
  onCommit,
}: {
  job: JobRecordLike;
  def: JobFieldDef;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCommit: (value: unknown, extra?: Record<string, unknown>) => void | Promise<void>;
}) {
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [contact, setContact] = useState<PickedContact | null>(null);
  const currentId = job[def.key] as string | null;

  const loaded = useQuery({
    queryKey: ["job-rel-editor", def.key, currentId],
    enabled: !!currentId,
    queryFn: async () => {
      if (def.kind === "account") {
        const { data } = await supabase
          .from("accounts")
          .select("id, name, location_id")
          .eq("id", currentId!)
          .maybeSingle();
        return data;
      }
      const { data } = await supabase
        .from("contacts")
        .select("id, full_name, email, phone")
        .eq("id", currentId!)
        .maybeSingle();
      return data;
    },
  });

  useEffect(() => {
    const d = loaded.data as Record<string, unknown> | null | undefined;
    if (!d) return;
    if (def.kind === "account")
      setAccount({
        id: String(d["id"]),
        name: String(d["name"] ?? ""),
        location_id: String(d["location_id"] ?? ""),
        primary_contact: null,
      });
    else setContact(d as unknown as PickedContact);
  }, [loaded.data, def.kind]);

  /*
   * The company whose people this field is most likely asking about.
   *
   * Main point of contact opened with no company chosen at all, and the picker
   * only fetches contacts once it has one -- so a job that already names
   * Rockland Estates Management offered nobody, and whoever opened it had to
   * find and pick that same company again before a single name appeared. The
   * job knows its account; the picker should start there.
   */
  const linkedAccountId = useMemo(
    () => pickerStartAccountId(def, job as unknown as Record<string, unknown>),
    [def, job],
  );

  const linkedAccountQ = useQuery({
    queryKey: ["job-rel-editor-company", linkedAccountId],
    enabled: def.kind === "contact" && !!linkedAccountId,
    queryFn: async () => {
      const { data } = await supabase
        .from("accounts")
        .select("id, name, location_id")
        .eq("id", linkedAccountId!)
        .maybeSingle();
      return data;
    },
    staleTime: 5 * 60_000,
  });

  /* Seeded once. Clearing the company inside the dialog is a deliberate act --
     somebody looking for a person at a different company -- and putting it
     straight back would make that impossible. */
  const seeded = useRef(false);
  useEffect(() => {
    const a = linkedAccountQ.data as Record<string, unknown> | null | undefined;
    if (!a || seeded.current) return;
    seeded.current = true;
    setAccount(
      (prev) =>
        prev ?? {
          id: String(a["id"]),
          name: String(a["name"] ?? ""),
          location_id: String(a["location_id"] ?? ""),
          primary_contact: null,
        },
    );
  }, [linkedAccountQ.data]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{def.label}</DialogTitle>
          {def.kind === "contact" && def.key === "primary_contact_id" ? (
            /* 4 Nov: "primary contact for what?" — say it where it is picked. */
            <DialogDescription>
              The person we call and email about this job
              {account?.name ? ` — someone at ${account.name}` : ""}.
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {def.kind === "account" ? (
          <AccountPicker
            label={def.label}
            value={account}
            typeKey={def.accountTypeKey}
            typeNoun={def.accountTypeNoun}
            onChange={(a) => {
              setAccount(a);
              /* 4 Nov: the × only empties the choice — the pop-up stays open
                 so another account can be picked. Clear, at the foot of the
                 pop-up, is what removes it. */
              if (!a) return;
              /* Picking a firm fills its typed name too; clearing leaves the
                 typed name as it was, so an old job's text never vanishes. */
              const companion = COMPANY_TEXT_COMPANION[def.key];
              void onCommit(a.id, companion ? { [companion]: a.name } : undefined);
              onOpenChange(false);
            }}
          />
        ) : (
          <CompanyContactPicker
            /*
             * David: "Main point of contact should be a person. Because the
             * company is right in here." On a job the company is the Account
             * field directly above this one, so this dialog leads with the
             * person and keeps the company underneath as a filter — and New
             * adds one without a trip to the CRM, which is the other half of
             * the same ask: "I want to be able to add it from the jobs also."
             */
            personFirst
            hideCompany={!!linkedAccountId}
            accountLabel="Company (to narrow the list)"
            contactLabel={def.label}
            account={account}
            onAccountChange={setAccount}
            /* A person added here belongs to the job's own office when the job
               has no company to inherit one from. */
            createLocationId={(job["location_id"] as string | null) ?? null}
            contact={contact}
            onContactChange={(c) => {
              setContact(c);
              void onCommit(c?.id ?? null);
              onOpenChange(false);
            }}
          />
        )}
        {def.kind === "contact" && (
          <p className="text-xs text-muted-foreground">
            {linkedAccountId
              ? `Anyone you add is filed under ${account?.name || "the company on this job"}.`
              : /* Never a silent orphan: say where the record lands. */
                "This job names no company, so anyone you add lands in this job's office with no company against them. Set the Company above first if they work somewhere."}
          </p>
        )}
        <div className="flex justify-between">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void onCommit(null);
              onOpenChange(false);
            }}
          >
            Clear
          </Button>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
