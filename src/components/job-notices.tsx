import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Home,
  Pencil,
  Percent,
  Pin,
  ShieldAlert,
  Plus,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { ALERT_TONE } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import {
  fetchAccountStandingNote,
  fetchPropertyNote,
  saveAccountStandingNote,
  savePropertyNote,
  STANDING_NOTE_KINDS,
  type StandingNoteKind,
} from "@/lib/standing-notes";
import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * One consolidated notices strip for a job.
 *
 * Tone carries meaning here, so it is rationed: red only for safety and
 * compliance, amber only for the on-site warning the crew must act on, and a
 * neutral surface for standing context like a discount arrangement. When four
 * things all shout, none of them is read.
 *
 * Every row keeps its source visible and edits the source record — the account
 * note lives on the account, the property note on the address — so one edit
 * updates every job that shows it. No per-job copies.
 */

type Tone = "danger" | "warning" | "neutral";
type NoticeKind = "safety" | "instructions" | "property" | "account";

/** Urgent pills on the top row beside the Notices toggle: three cells across. */
const ROW_PINNED_MAX = 2;

const ORDER: Record<NoticeKind, number> = {
  safety: 0,
  instructions: 1,
  property: 2,
  account: 3,
};

interface Notice {
  id: string;
  kind: NoticeKind;
  tone: Tone;
  icon: React.ReactNode;
  /** Where the note lives — shown so a crew member knows its blast radius. */
  scope: string;
  text: string;
  editable: boolean;
  /** Pinned at the top of the job, outside the collapsible strip (T4). */
  urgent: boolean;
}

/** Each notice is its own bubble, so the tint is what carries the severity —
 *  there is no shared row background or rail left to lean on. */
/* 3 Nov mock-up: a soft banner per notice — a light tint and a tinted edge,
   the words in the body colour so every tone stays readable. */
/* The app's one set of banner tints (ui/alert), so a notice and an Alert of
   the same tone look the same. */
const TONE_BUBBLE: Record<Tone, string> = {
  danger: ALERT_TONE.destructive,
  warning: ALERT_TONE.warning,
  neutral: ALERT_TONE.neutral,
};

const TONE_ICON: Record<Tone, string> = {
  danger: "text-destructive",
  warning: "text-warning",
  neutral: "text-muted-foreground",
};

/** The bold scope label at the start of the line ("Safety — …"). */
const TONE_LABEL: Record<Tone, string> = {
  danger: "text-destructive",
  warning: "text-warning",
  neutral: "text-foreground",
};

/* ------------------------------------------------------------ preferences */

const COLLAPSE_KEY = "job-notices:collapsed";
const DISMISS_KEY = "job-notices:dismissed";

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Collapse choice and dismissals are per user, per browser — never shared. */
function useNoticePrefs(userId: string | null, jobId: string) {
  const scope = userId ?? "anon";
  const [collapsed, setCollapsed] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setCollapsed(readJson<Record<string, boolean>>(COLLAPSE_KEY, {})[scope] ?? false);
    setDismissed(readJson<Record<string, string[]>>(DISMISS_KEY, {})[`${scope}:${jobId}`] ?? []);
    setHydrated(true);
  }, [scope, jobId]);

  const persistCollapsed = (v: boolean) => {
    setCollapsed(v);
    const all = readJson<Record<string, boolean>>(COLLAPSE_KEY, {});
    all[scope] = v;
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all));
  };

  const persistDismissed = (next: string[]) => {
    setDismissed(next);
    const all = readJson<Record<string, string[]>>(DISMISS_KEY, {});
    all[`${scope}:${jobId}`] = next;
    window.localStorage.setItem(DISMISS_KEY, JSON.stringify(all));
  };

  return { collapsed, persistCollapsed, dismissed, persistDismissed, hydrated };
}

/* -------------------------------------------------------------- bubbles */

function NoticeBubble({
  notice,
  onEdit,
  onDismiss,
}: {
  notice: Notice;
  onEdit?: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = notice.text.length > 90 || notice.text.includes("\n");

  return (
    <div
      className={cn(
        // One full-width banner per notice (3 Nov mock-up), the actions at
        // the right end of its line.
        "group/notice flex w-full items-start gap-3 rounded-xl border px-4 py-2.5 text-sm",
        TONE_BUBBLE[notice.tone],
      )}
    >
      <span className={cn("mt-0.5 shrink-0", TONE_ICON[notice.tone])}>{notice.icon}</span>
      <button
        type="button"
        disabled={!long}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "min-w-0 flex-1 py-px text-left leading-5",
          expanded ? "whitespace-pre-wrap" : "truncate",
          long && "cursor-pointer",
        )}
        title={long && !expanded ? notice.text : undefined}
      >
        <strong className={cn("font-semibold", TONE_LABEL[notice.tone])}>{notice.scope}</strong>
        <span className="text-foreground"> — {notice.text}</span>
      </button>
      <span className="-my-1 -mr-2 flex shrink-0 items-center gap-0.5">
        {long && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Less" : "More"}
          </Button>
        )}
        {onEdit && (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={`Edit ${notice.scope.toLowerCase()}`}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={`Dismiss ${notice.scope.toLowerCase()}`}
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </Button>
      </span>
    </div>
  );
}

/**
 * An urgent notice, pinned above the tabs (5 Nov, T4: "Don't block driveway"
 * and "Call 30 min before" were missed inside the collapsed strip). One short
 * line; the full text on hover and on tap. Never dismissible: being missed is
 * the problem it solves.
 */
function PinnedNotice({ notice, onEdit }: { notice: Notice; onEdit?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      data-urgent-notice
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px]",
        TONE_BUBBLE[notice.tone],
      )}
    >
      <span className={cn("shrink-0", TONE_ICON[notice.tone])}>
        <Pin className="size-3.5" />
      </span>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className={cn(
          "min-w-0 flex-1 text-left leading-5",
          expanded ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "truncate",
        )}
        title={expanded ? undefined : `${notice.scope} — ${notice.text}`}
      >
        <strong className={cn("font-semibold", TONE_LABEL[notice.tone])}>{notice.scope}</strong>
        <span className="text-foreground"> — {notice.text}</span>
      </button>
      {onEdit && (
        <Button
          size="icon"
          variant="ghost"
          className="-my-0.5 -mr-1 size-6 shrink-0"
          aria-label={`Edit ${notice.scope.toLowerCase()}`}
          onClick={onEdit}
        >
          <Pencil className="size-3" />
        </Button>
      )}
    </div>
  );
}

function InlineEditor({
  title,
  hint,
  value,
  onChange,
  kind,
  onKindChange,
  onSave,
  onCancel,
  saving,
  placeholder,
  urgent,
  onUrgentChange,
}: {
  title: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  kind?: StandingNoteKind;
  onKindChange?: (k: StandingNoteKind) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  placeholder: string;
  urgent: boolean;
  onUrgentChange: (v: boolean) => void;
}) {
  return (
    <div className="space-y-2 border-l-2 border-primary/60 bg-muted/40 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide">{title}</div>
      {kind && onKindChange && (
        <Select value={kind} onValueChange={(v) => onKindChange(v as StandingNoteKind)}>
          <SelectTrigger className="h-8 w-full max-w-xs text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STANDING_NOTE_KINDS.map((k) => (
              <SelectItem key={k.value} value={k.value}>
                {k.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={placeholder}
        autoFocus
      />
      <label className="flex w-fit cursor-pointer items-center gap-2 text-[13px]">
        <Checkbox
          checked={urgent}
          onCheckedChange={(v) => onUrgentChange(v === true)}
          aria-label="Urgent"
        />
        <span>
          <span className="font-medium">Urgent</span>
          <span className="text-muted-foreground"> — always shown at the top of the job</span>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={saving}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- card */

export function JobNotices({
  jobId,
  accountId,
  address,
  locationId,
  importantInstructions,
  importantInstructionsUrgent = false,
  rehabbedAfter1978,
  onInstructionsChange,
  readOnly,
}: {
  jobId: string;
  accountId: string | null;
  address: string | null;
  locationId?: string | null;
  importantInstructions: string | null;
  importantInstructionsUrgent?: boolean;
  rehabbedAfter1978: boolean | null;
  onInstructionsChange?: (v: string | null, urgent: boolean) => void;
  readOnly?: boolean;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const canWrite = !readOnly && !app.writesDisabled;
  const prefs = useNoticePrefs(app.userId ?? null, jobId);

  const [editing, setEditing] = useState<NoticeKind | null>(null);
  const [draft, setDraft] = useState("");
  const [urgentDraft, setUrgentDraft] = useState(false);
  const [accountKind, setAccountKind] = useState<StandingNoteKind>("general");

  const accountNote = useQuery({
    queryKey: ["account-standing-note", accountId],
    queryFn: () => fetchAccountStandingNote(accountId),
    enabled: !!accountId,
  });
  const propertyNote = useQuery({
    queryKey: ["property-note", address],
    queryFn: () => fetchPropertyNote(address),
    enabled: !!address,
  });

  useEffect(() => {
    setAccountKind(accountNote.data?.kind ?? "general");
  }, [accountNote.data?.kind]);

  const saveAccount = useMutation({
    mutationFn: () =>
      saveAccountStandingNote(accountId!, draft.trim() || null, accountKind, urgentDraft),
    onSuccess: () => {
      setEditing(null);
      toast.success("Account note saved — it now shows on every job for this account.");
      void qc.invalidateQueries({ queryKey: ["account-standing-note", accountId] });
      void qc.invalidateQueries({ queryKey: ["account", accountId] });
    },
    onError: (e) => toastDbError(e, { action: "save the account note" }),
  });

  const saveProperty = useMutation({
    mutationFn: () =>
      savePropertyNote({
        address: address!,
        note: draft.trim() || null,
        userId: app.userId ?? null,
        locationId: locationId ?? null,
        urgent: urgentDraft,
      }),
    onSuccess: () => {
      setEditing(null);
      toast.success("Property note saved — it now shows on every job at this address.");
      void qc.invalidateQueries({ queryKey: ["property-note"] });
    },
    onError: (e) => toastDbError(e, { action: "save the property note" }),
  });

  const saveInstructions = useMutation({
    mutationFn: async () => {
      const next = draft.trim() || null;
      const urgent = !!next && urgentDraft;
      const { error } = await supabase
        .from("jobs")
        .update({ important_instructions: next, important_instructions_urgent: urgent })
        .eq("id", jobId);
      if (error) throw error;
      return { next, urgent };
    },
    onSuccess: ({ next, urgent }) => {
      setEditing(null);
      onInstructionsChange?.(next, urgent);
      toast.success("Important instructions saved");
    },
    onError: (e) => toastDbError(e, { action: "save the important instructions" }),
  });

  const notices = useMemo<Notice[]>(() => {
    const out: Notice[] = [];

    if (rehabbedAfter1978 === false) {
      out.push({
        id: "safety:lead-pre1978",
        kind: "safety",
        tone: "danger",
        icon: <ShieldAlert className="size-4" />,
        scope: "Safety",
        text: "Pre-1978 property — EPA RRP applies. Lead-safe certified work practices are required on this job.",
        editable: false,
        urgent: false,
      });
    } else if (rehabbedAfter1978 == null) {
      out.push({
        id: "safety:lead-unknown",
        kind: "safety",
        tone: "warning",
        icon: <ShieldAlert className="size-4" />,
        scope: "Safety",
        text: "Lead-paint status unknown — confirm the year the property was built before demolition begins.",
        editable: false,
        urgent: false,
      });
    }

    if (importantInstructions) {
      out.push({
        id: "instructions",
        kind: "instructions",
        tone: "warning",
        icon: <TriangleAlert className="size-4" />,
        scope: "On site",
        text: importantInstructions,
        editable: canWrite,
        urgent: importantInstructionsUrgent,
      });
    }

    if (propertyNote.data) {
      out.push({
        id: "property",
        kind: "property",
        tone: "neutral",
        icon: <Home className="size-4" />,
        // 6 Nov (David): no address in the pill — it is this job's address,
        // and it was printing twice on a phone. The note is the message.
        scope: "Property",
        text: propertyNote.data.note,
        editable: canWrite,
        urgent: propertyNote.data.urgent,
      });
    }

    if (accountNote.data) {
      out.push({
        id: "account",
        kind: "account",
        tone: "neutral",
        icon:
          accountNote.data.kind === "discount" ? (
            <Percent className="size-4" />
          ) : (
            <Building2 className="size-4" />
          ),
        scope: `Account · ${accountNote.data.accountName}`,
        text: accountNote.data.note,
        editable: canWrite,
        urgent: accountNote.data.urgent,
      });
    }

    return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  }, [
    rehabbedAfter1978,
    importantInstructions,
    importantInstructionsUrgent,
    propertyNote.data,
    accountNote.data,
    canWrite,
  ]);

  // Urgent ones are pinned above the strip and never dismissed; the strip
  // keeps everything else exactly as before.
  const pinned = notices.filter((n) => n.urgent);
  const stripNotices = notices.filter((n) => !n.urgent);
  const visible = stripNotices.filter((n) => !prefs.dismissed.includes(n.id));
  const hiddenCount = stripNotices.length - visible.length;

  const startEdit = (kind: NoticeKind) => {
    setEditing(kind);
    setUrgentDraft(notices.find((n) => n.kind === kind)?.urgent ?? false);
    setDraft(
      kind === "instructions"
        ? (importantInstructions ?? "")
        : kind === "property"
          ? (propertyNote.data?.note ?? "")
          : (accountNote.data?.note ?? ""),
    );
  };

  /*
   * A failed lookup is not "no note". Offering "Add account note" after the
   * query errored invites someone to write over a note they were never shown,
   * so the offer is withheld and the failure is said out loud instead.
   */
  const addable = canWrite
    ? ([
        !importantInstructions && { kind: "instructions" as const, label: "Add on-site warning" },
        address &&
          !propertyNote.data &&
          !propertyNote.isError && { kind: "property" as const, label: "Add property note" },
        accountId &&
          !accountNote.data &&
          !accountNote.isError && { kind: "account" as const, label: "Add account note" },
      ].filter(Boolean) as { kind: NoticeKind; label: string }[])
    : [];

  const failed = [
    propertyNote.isError && "property note",
    accountNote.isError && "account note",
  ].filter(Boolean) as string[];

  if (!prefs.hydrated) return null;
  if (notices.length === 0 && addable.length === 0 && failed.length === 0) return null;

  const collapsed = prefs.collapsed;

  const editorProps = {
    draft,
    setDraft,
    accountKind,
    setAccountKind,
    urgent: urgentDraft,
    setUrgent: setUrgentDraft,
    accountName: accountNote.data?.accountName ?? null,
    address,
    onCancel: () => setEditing(null),
    saveAccount,
    saveProperty,
    saveInstructions,
  };

  /*
   * 6 Nov (David): one row, not three. On a phone the two urgent pills and
   * the Notices row took half the screen; now the pills and the Notices
   * toggle share one row at every width, up to three cells across. The pills
   * truncate and expand on tap. A third urgent notice (rare) goes into the
   * strip instead so the row never wraps.
   */
  const rowPinned = pinned.slice(0, ROW_PINNED_MAX);
  const overflowPinned = pinned.slice(ROW_PINNED_MAX);
  const stripList = [...overflowPinned, ...visible];
  const stripCount = stripList.length;
  const bodyShown =
    !collapsed &&
    (failed.length > 0 ||
      stripList.length > 0 ||
      editing !== null ||
      addable.length > 0 ||
      hiddenCount > 0);

  return (
    <div className="space-y-2" data-job-notices>
      <div
        className="flex items-stretch gap-1.5 sm:gap-2"
        aria-label="Notices"
        {...(rowPinned.length > 0 ? { "data-urgent-notices": "" } : {})}
      >
        {rowPinned.map((n) => (
          <PinnedNotice
            key={n.id}
            notice={n}
            onEdit={
              n.editable
                ? () => {
                    if (collapsed) prefs.persistCollapsed(false);
                    startEdit(n.kind);
                  }
                : undefined
            }
          />
        ))}
        <button
          type="button"
          onClick={() => prefs.persistCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          data-notices-toggle
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-lg border bg-muted/40 px-2.5 py-1.5 text-left text-xs font-semibold uppercase tracking-wide",
            rowPinned.length === 0 ? "flex-1" : "shrink-0",
          )}
        >
          {collapsed ? (
            <ChevronRight className="size-3.5 shrink-0" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0" />
          )}
          <span className={cn(rowPinned.length > 0 && "sr-only sm:not-sr-only")}>Notices</span>
          <span className="font-normal normal-case text-muted-foreground">
            {stripCount === 0
              ? failed.length > 0
                ? "couldn't load"
                : "none"
              : rowPinned.length > 0
                ? stripCount
                : `${stripCount} notice${stripCount === 1 ? "" : "s"}`}
          </span>
          {stripList.some((n) => n.tone === "danger") && (
            <span className="rounded-sm bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive">
              Safety
            </span>
          )}
        </button>
      </div>

      {bodyShown && (
        <div className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--card-border)] bg-card">
          {/*
           * A cluster of chips, not a list of rows. Each notice is one short
           * line, so packing them across the row keeps the job itself near the
           * top of the screen. An open editor still takes the whole width - it
           * is a form, not a chip.
           */}
          <div className="flex flex-col gap-2 p-3">
            {failed.length > 0 && (
              <span className="flex items-center gap-3 rounded-xl border border-warning/30 bg-warning/[0.08] px-4 py-2.5 text-sm">
                <TriangleAlert className="size-4 shrink-0 text-warning" />
                Could not load the {failed.join(" or ")} — there may be one you are not seeing.
              </span>
            )}
            {stripList.map((n) =>
              editing === n.kind ? (
                <div key={n.id} className="w-full">
                  <EditorFor kind={n.kind} {...editorProps} />
                </div>
              ) : n.urgent ? (
                <PinnedNotice
                  key={n.id}
                  notice={n}
                  onEdit={n.editable ? () => startEdit(n.kind) : undefined}
                />
              ) : (
                <NoticeBubble
                  key={n.id}
                  notice={n}
                  onEdit={n.editable ? () => startEdit(n.kind) : undefined}
                  onDismiss={() => prefs.persistDismissed([...prefs.dismissed, n.id])}
                />
              ),
            )}

            {editing !== null && !stripList.some((n) => n.kind === editing) && (
              <div className="w-full">
                <EditorFor kind={editing} {...editorProps} />
              </div>
            )}

            {/* The add buttons sit at the end of the open strip (3 Nov: not as
                dashed chips among the notices; 6 Nov: not on the top row,
                which belongs to the pills). */}
            {(addable.length > 0 && editing === null) || hiddenCount > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {addable.length > 0 &&
                  editing === null &&
                  addable.map((a) => (
                    <Button
                      key={a.kind}
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => startEdit(a.kind)}
                    >
                      <Plus className="size-3.5" />
                      {a.label}
                    </Button>
                  ))}
                {hiddenCount > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 text-xs"
                    onClick={() => prefs.persistDismissed([])}
                  >
                    <Undo2 className="mr-1 size-3" /> Restore {hiddenCount} dismissed
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

function EditorFor({
  kind,
  draft,
  setDraft,
  accountKind,
  setAccountKind,
  urgent,
  setUrgent,
  accountName,
  address,
  onCancel,
  saveAccount,
  saveProperty,
  saveInstructions,
}: {
  kind: NoticeKind;
  draft: string;
  setDraft: (v: string) => void;
  accountKind: StandingNoteKind;
  setAccountKind: (k: StandingNoteKind) => void;
  urgent: boolean;
  setUrgent: (v: boolean) => void;
  accountName: string | null;
  address: string | null;
  onCancel: () => void;
  saveAccount: { mutate: () => void; isPending: boolean };
  saveProperty: { mutate: () => void; isPending: boolean };
  saveInstructions: { mutate: () => void; isPending: boolean };
}) {
  if (kind === "account") {
    return (
      <InlineEditor
        title={`Account note${accountName ? ` — ${accountName}` : ""}`}
        hint="Stored on the account — every job for this customer shows it."
        value={draft}
        onChange={setDraft}
        urgent={urgent}
        onUrgentChange={setUrgent}
        kind={accountKind}
        onKindChange={setAccountKind}
        onSave={() => saveAccount.mutate()}
        onCancel={onCancel}
        saving={saveAccount.isPending}
        placeholder="20% discount arrangement, always call before invoicing…"
      />
    );
  }
  if (kind === "property") {
    return (
      <InlineEditor
        title={`Property note${address ? ` — ${address}` : ""}`}
        hint="Stored on the address — every job at this property shows it."
        value={draft}
        onChange={setDraft}
        urgent={urgent}
        onUrgentChange={setUrgent}
        onSave={() => saveProperty.mutate()}
        onCancel={onCancel}
        saving={saveProperty.isPending}
        placeholder="Call 30 minutes before arrival, rear entrance code 4412, park on the north side…"
      />
    );
  }
  if (kind === "instructions") {
    return (
      <InlineEditor
        title="Important instructions — this job"
        hint="Shown to the crew and printed on the scope of work."
        value={draft}
        onChange={setDraft}
        urgent={urgent}
        onUrgentChange={setUrgent}
        onSave={() => saveInstructions.mutate()}
        onCancel={onCancel}
        saving={saveInstructions.isPending}
        placeholder="Don't block the driveway, gate code, dog on site, no parking before 9am…"
      />
    );
  }
  return null;
}
