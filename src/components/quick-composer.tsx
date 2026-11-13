import { textToEmailHtml } from "@/lib/safe-html";
/**
 * Quick composer — the one place a rep records anything against a record.
 *
 * Every tab writes inline, in the panel, so the common actions cost one click
 * and no context switch. Nothing here drafts text on the rep's behalf.
 */
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  FileText,
  Files,
  Mail,
  MessageSquare,
  Phone,
  Receipt,
  StickyNote,
  X,
  Clock,
  Users,
  Flag,
  Check,
  MapPin,
  Star,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { MANUAL_TOUCHPOINT_CAPTURE_SOURCE } from "@/lib/accounts";
import { sendEmail } from "@/lib/email.functions";
import { announceEmailSend } from "@/components/email-send-toast";
import { createTask } from "@/components/task-dialog";
import { toastDbError } from "@/lib/db-errors";
import { CallScreen } from "@/components/call-screen";
import { LogTouchDialog, type ActionContact } from "@/components/account-actions";
import { DocumentsPanel } from "@/components/documents-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { dueInDays } from "@/lib/tasks";
import type { TaskPriority } from "@/lib/tasks";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { Switch } from "@/components/ui/switch";
import { useActivityTypes } from "@/lib/account-tasks";
import { isSalesManager } from "@/lib/roles";
import { PROOF_ACCEPT, proofFileProblem, proofKindFor, uploadProof } from "@/lib/touchpoint-proof";
import { format } from "date-fns";
import { GoogleReviewLinkTab } from "@/components/google-review-link-tab";

/*
 * Melly, 6 Nov, with Pipedrive on screen: log a call or a meeting with a date
 * and "it comes up as a task on November 25th"; and of the old composer, "the
 * activity box opens up more of the same things that are here". So Note, Call
 * and the scheduler are ONE tab now — Activity — whose date decides what it
 * does: later than now schedules a task for whoever it is assigned to, now or
 * earlier logs it on the timeline. Old requests for "note" or "call" (Focus,
 * the timeline's + Add) open Activity with that type picked.
 */
const TABS = [
  { key: "activity", label: "Activity", icon: Clock },
  { key: "email", label: "Email", icon: Mail },
  { key: "sms", label: "Text", icon: MessageSquare },
  { key: "review", label: "Review", icon: Star },
  { key: "files", label: "Files", icon: Files },
  { key: "documents", label: "Documents", icon: FileText },
  { key: "invoice", label: "Invoice", icon: Receipt },
] as const;

export type TabKey = (typeof TABS)[number]["key"];
/** What a caller may ask the composer to open: a tab, or an activity type on Activity. */
export type ComposerRequest = TabKey | "note" | "call" | "meeting";

/** Which tab a request opens, and the activity type it preselects. */
export function composerTarget(req: ComposerRequest): { tab: TabKey; type: string | null } {
  if (req === "note") return { tab: "activity", type: NOTE_TYPE };
  if (req === "call") return { tab: "activity", type: "call" };
  if (req === "meeting") return { tab: "activity", type: "meeting" };
  return { tab: req, type: null };
}
const STORE_KEY = "quick-composer-tab";

export function QuickComposer({
  accountId,
  accountName,
  locationId,
  address,
  contacts,
  userId,
  defaultStateCode,
  requestTab,
  onCreated,
  bare,
  tabs: tabFilter,
}: {
  accountId: string;
  accountName: string;
  locationId: string | null;
  address: string;
  contacts: ActionContact[];
  userId: string | null;
  defaultStateCode?: string | null;
  /** Lets Focus open a specific tab; bump the token to re-open the same one. */
  requestTab?: { tab: ComposerRequest; token: number } | null;
  onCreated: () => void;
  /**
   * The tabs to offer, in TABS order. The account page leaves out Files and
   * Documents, which are its own Documents tab — one way in to each thing.
   */
  tabs?: readonly TabKey[];
  /**
   * Body only — no tab strip, no card frame, and the tab follows `requestTab`
   * rather than the remembered one. The prospect layout's activity popup hosts
   * the composer this way.
   */
  bare?: boolean;
}) {
  const writes = useWritesDisabled();
  const [tab, setTab] = useState<TabKey | null>(null);
  /** The activity type a request asked for; bumped so the same ask works twice. */
  const [preset, setPreset] = useState<{ type: string; token: number } | null>(null);
  const shownTabs = TABS.filter((t) => !tabFilter || tabFilter.includes(t.key));

  useEffect(() => {
    if (bare) return;
    const saved = localStorage.getItem(STORE_KEY) as TabKey | null;
    if (saved && shownTabs.some((t) => t.key === saved)) setTab(saved);
    else setTab("activity");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bare]);

  useEffect(() => {
    if (!requestTab) return;
    const target = composerTarget(requestTab.tab);
    setTab(target.tab);
    if (target.type) setPreset({ type: target.type, token: requestTab.token });
  }, [requestTab]);

  const open = (k: TabKey) => {
    setTab(k);
    localStorage.setItem(STORE_KEY, k);
  };

  if (writes.disabled) {
    return (
      <section className={bare ? undefined : "rounded-xl border bg-card p-4"}>
        <p className="text-[12px] text-muted-foreground">
          {writes.reason ?? "Writes are disabled in this view."}
        </p>
      </section>
    );
  }

  return (
    <section className={bare ? undefined : "rounded-xl border bg-card"}>
      {!bare && (
        <div className="flex flex-wrap items-center gap-1 border-b px-4 pt-2">
          {shownTabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => open(t.key)}
                className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13.5px] ${
                  active
                    ? "border-primary font-semibold text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-3.5" />
                {t.label}
              </button>
            );
          })}
          {tab && (
            <button
              type="button"
              aria-label="Close composer"
              className="ml-auto mb-1.5 p-1 text-muted-foreground hover:text-foreground"
              onClick={() => setTab(null)}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {tab && (
        <div className={bare ? undefined : "p-4"}>
          {tab === "activity" && (
            <ActivityTab
              accountId={accountId}
              accountName={accountName}
              locationId={locationId}
              contacts={contacts}
              userId={userId}
              defaultStateCode={defaultStateCode ?? null}
              preset={preset}
              onSaved={onCreated}
            />
          )}
          {tab === "email" && (
            <EmailTab
              accountId={accountId}
              accountName={accountName}
              locationId={locationId}
              contacts={contacts}
              onSent={onCreated}
            />
          )}
          {tab === "sms" && (
            <SmsTab accountId={accountId} contacts={contacts} userId={userId} onSent={onCreated} />
          )}
          {tab === "review" && (
            <GoogleReviewLinkTab
              accountId={accountId}
              locationId={locationId}
              contacts={contacts}
              userId={userId}
            />
          )}
          {(tab === "files" || tab === "documents") && locationId && (
            <DocumentsPanel
              accountId={accountId}
              locationId={locationId}
              address={address}
              allowAuthorization={tab === "documents"}
            />
          )}
          {(tab === "files" || tab === "documents") && !locationId && (
            <p className="text-[12px] text-muted-foreground">
              This account has no office set, so files cannot be filed against it yet.
            </p>
          )}
          {tab === "invoice" && (
            <InvoiceTab
              accountId={accountId}
              locationId={locationId}
              userId={userId}
              onSaved={onCreated}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** Icon keys stored on the managed activity_type option list. */
const ACTIVITY_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  phone: Phone,
  users: Users,
  flag: Flag,
  mail: Mail,
  check: Check,
  "map-pin": MapPin,
};

/* -------------------------------------------------------------- Activity */

/** "Note" is not a managed activity type; it is the composer's own first chip. */
export const NOTE_TYPE = "note";

/** Activity types that are only ever a to-do: always scheduled, never "logged". */
const ALWAYS_SCHEDULED = new Set(["task", "deadline"]);

/** A logged activity's touchpoint type. Types not here cannot be logged as done. */
const TOUCH_FOR_ACTIVITY: Record<string, "call" | "meeting_in_person" | "email"> = {
  call: "call",
  meeting: "meeting_in_person",
  site_visit: "meeting_in_person",
  email: "email",
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function localDate(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function localTime(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * What the form will do with this type and moment — the one rule, shown under
 * the button before it is pressed so nobody is surprised.
 *
 *   note                       → a note on the timeline, whatever the date
 *   task / deadline            → always a task (they are to-dos by nature)
 *   anything later than now    → a task for the assignee, due then
 *   call/meeting/email, now or earlier → logged on the timeline as done
 */
export function activityMode(
  typeKey: string | null,
  when: Date | null,
  now: Date = new Date(),
): "note" | "schedule" | "log" {
  if (typeKey === NOTE_TYPE) return "note";
  if (!typeKey || ALWAYS_SCHEDULED.has(typeKey) || !TOUCH_FOR_ACTIVITY[typeKey]) return "schedule";
  if (when && when.getTime() > now.getTime() + 60_000) return "schedule";
  return "log";
}

function ActivityTab({
  accountId,
  accountName,
  locationId,
  contacts,
  userId,
  defaultStateCode,
  preset,
  onSaved,
}: {
  accountId: string;
  accountName: string;
  locationId: string | null;
  contacts: ActionContact[];
  userId: string | null;
  defaultStateCode: string | null;
  preset: { type: string; token: number } | null;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const types = useActivityTypes();
  const [typeKey, setTypeKey] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [date, setDate] = useState(() => localDate(new Date()));
  const [time, setTime] = useState(() => localTime(new Date()));
  const [assignee, setAssignee] = useState("me");
  const [contactId, setContactId] = useState("none");
  const [note, setNote] = useState("");
  const [pin, setPin] = useState(false);
  const [responded, setResponded] = useState(true);
  const [proof, setProof] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  /*
   * Melly: "by default it will be you, but if you want to assign it to someone
   * else you can — it's based on the roles." Leadership and office managers
   * may hand a task to someone else; a rep schedules for themselves.
   */
  const canAssignOthers = isSalesManager(app.roles);

  const typeRows = useMemo(() => types.data ?? [], [types.data]);
  // Default to the list's default (Call), once the list arrives.
  useEffect(() => {
    if (typeKey || !typeRows.length) return;
    setTypeKey((typeRows.find((t) => t.is_default) ?? typeRows[0]).key);
  }, [typeRows, typeKey]);
  // A request ("call", "note", "meeting") picks its type each time it is made.
  useEffect(() => {
    if (preset) setTypeKey(preset.type);
  }, [preset]);
  // A meeting is a response by definition; a call or an email is not.
  useEffect(() => {
    setResponded(typeKey === "meeting" || typeKey === "site_visit");
  }, [typeKey]);

  const people = useQuery({
    queryKey: ["task-assignees"],
    enabled: canAssignOthers,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const when = date ? new Date(`${date}T${time || "09:00"}`) : null;
  const mode = activityMode(typeKey, when);
  const typeRow = typeRows.find((t) => t.key === typeKey) ?? null;
  const typeLabel = typeKey === NOTE_TYPE ? "Note" : (typeRow?.label ?? "Activity");
  const contact = contacts.find((c) => c.id === contactId) ?? null;
  const assigneeName =
    assignee === "me"
      ? "you"
      : ((people.data ?? []).find((p) => p.user_id === assignee)?.full_name ?? "them");

  const reset = () => {
    setSubject("");
    setNote("");
    setPin(false);
    setProof(null);
    setContactId("none");
    const now = new Date();
    setDate(localDate(now));
    setTime(localTime(now));
  };

  const save = async () => {
    if (!userId) return toast.error("Not signed in.");
    if (!typeKey) return;
    setSaving(true);
    try {
      if (mode === "note") {
        if (!note.trim()) return toast.error("Write the note first.");
        const { error } = await supabase.from("account_notes").insert({
          account_id: accountId,
          contact_id: contact?.id ?? null,
          body: note.trim(),
          trigger_type: "none",
          is_pinned: pin,
          created_by: userId,
        });
        if (error) return toastDbError(error, { action: "Saving the note" });
        toast.success("Note saved");
      } else if (mode === "schedule") {
        if (!date) return toast.error("Pick the day it is due.");
        const title =
          subject.trim() || (contact ? `${typeLabel} with ${contact.full_name}` : typeLabel);
        const { error } = await createTask({
          title,
          description: note.trim() || null,
          assignee: assignee === "me" || !canAssignOthers ? userId : assignee,
          dueDate: date,
          dueTime: time || null,
          createdBy: userId,
          activityTypeId: typeRow?.id ?? null,
          link: { accountId, locationId: locationId ?? null, contactId: contact?.id ?? null },
        });
        if (error) return toastDbError(error, { action: "Scheduling the activity" });
        toast.success(
          `${typeLabel} scheduled for ${format(when!, "EEE d MMM")}${time ? `, ${format(when!, "h:mm a")}` : ""}`,
        );
      } else {
        const touchType = TOUCH_FOR_ACTIVITY[typeKey];
        if (proof && proofFileProblem(proof)) return toast.error(proofFileProblem(proof));
        let proofPathValue: string | null = null;
        if (proof) {
          try {
            proofPathValue = await uploadProof(accountId, proof);
          } catch (e) {
            return toastDbError(e, { action: "upload the proof" });
          }
        }
        const occurredAt = (when ?? new Date()).toISOString();
        const body = [subject.trim(), note.trim()].filter(Boolean).join("\n") || null;
        const { data: logged, error } = await supabase
          .from("touchpoints")
          .insert({
            account_id: accountId,
            contact_id: contact?.id ?? null,
            type: touchType,
            occurred_at: occurredAt,
            notes: body,
            created_by: userId,
            capture_source: MANUAL_TOUCHPOINT_CAPTURE_SOURCE,
            direction: "outbound",
            replied_at: responded ? occurredAt : null,
            proof_path: proofPathValue,
            proof_kind: proof ? proofKindFor(proof) : null,
          })
          .select("counts_toward_cadence")
          .maybeSingle();
        if (error) return toastDbError(error, { action: "Logging the activity" });
        toast.success(
          logged?.counts_toward_cadence
            ? `${typeLabel} logged as a follow-up, marked unverified`
            : `${typeLabel} logged — attach proof to make it count as a follow-up`,
        );
      }
      reset();
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  const outcome =
    mode === "note"
      ? "Adds a note to the timeline."
      : mode === "schedule"
        ? `Creates a task for ${assigneeName} due ${when ? format(when, "EEE d MMM") : "—"}${time && when ? `, ${format(when, "h:mm a")}` : ""}.`
        : `Logs it on the timeline${when && when.getTime() < Date.now() - 60 * 60_000 ? ` for ${format(when, "EEE d MMM, h:mm a")}` : " now"}.`;

  return (
    <div className="space-y-3" data-testid="activity-composer">
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Activity type">
        {[
          { key: NOTE_TYPE, label: "Note", icon: StickyNote },
          ...typeRows.map((t) => ({
            key: t.key,
            label: t.label,
            icon: ACTIVITY_ICON[t.metadata?.icon ?? ""] ?? Clock,
          })),
        ].map((t) => {
          const Icon = t.icon;
          const active = typeKey === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTypeKey(t.key)}
              className={`flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition-colors ${
                active
                  ? "border-primary bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              }`}
            >
              <Icon className="size-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {mode !== "note" ? (
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={
            typeKey === "meeting"
              ? "Lunch with Dana at the office"
              : `${typeLabel} — subject (optional)`
          }
          aria-label="Subject"
        />
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr]">
        <div className="space-y-1">
          <Label className="text-[12px]">Date</Label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[12px]">Time</Label>
          <Input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className="h-9"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[12px]">With</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger className="h-9 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No specific contact</SelectItem>
              {contacts.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {mode === "schedule" ? (
        <div className="space-y-1 sm:max-w-[50%]">
          <Label className="text-[12px]">Assigned to</Label>
          {canAssignOthers ? (
            <Select value={assignee} onValueChange={setAssignee}>
              <SelectTrigger className="h-9 text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Me</SelectItem>
                {(people.data ?? [])
                  .filter((p) => p.user_id !== userId)
                  .map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-[13px]">
              Me
            </p>
          )}
        </div>
      ) : null}

      <Textarea
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={mode === "note" ? "What happened, in your words" : "Notes (optional)"}
        aria-label="Notes"
      />

      {mode === "log" ? (
        <div className="grid gap-2 rounded-lg border bg-muted/30 p-3 sm:grid-cols-2">
          <label className="flex items-start gap-2.5">
            <Switch checked={responded} onCheckedChange={setResponded} className="mt-0.5" />
            <span className="text-[12.5px]">
              <span className="font-medium">They responded</span>
              <span className="block text-muted-foreground">
                Any response moves a prospect to Conversation Established.
              </span>
            </span>
          </label>
          <div className="space-y-1">
            <Label htmlFor="activity-proof" className="text-[12.5px]">
              Proof (photo or PDF)
            </Label>
            <Input
              id="activity-proof"
              type="file"
              accept={PROOF_ACCEPT}
              onChange={(e) => setProof(e.target.files?.[0] ?? null)}
              className="h-9 text-[12px]"
            />
            <p className={`text-[11.5px] ${proof ? "text-success" : "text-muted-foreground"}`}>
              {proof
                ? "Counts as a follow-up, marked unverified."
                : "Without proof it is an attempt and does not restart the client's clock."}
            </p>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {mode === "note" ? (
          <label className="flex items-center gap-1.5 text-[12px]">
            <Checkbox checked={pin} onCheckedChange={(v) => setPin(v === true)} /> Pin to the top
          </label>
        ) : null}
        {typeKey === "call" ? (
          <CallScreen
            accountId={accountId}
            accountName={accountName}
            contacts={contacts.map((c) => ({
              id: c.id,
              full_name: c.full_name,
              phone: c.phone ?? null,
            }))}
            defaultStateCode={defaultStateCode}
            userId={userId}
            onLogged={onSaved}
            compact
          />
        ) : null}
        <span className="ml-auto text-[11.5px] text-muted-foreground" data-activity-outcome>
          {outcome}
        </span>
        <Button size="sm" className="h-8" disabled={saving || !typeKey} onClick={save}>
          {saving
            ? "Saving…"
            : mode === "note"
              ? "Save note"
              : mode === "schedule"
                ? "Schedule"
                : `Log ${typeLabel.toLowerCase()}`}
        </Button>
      </div>
      <p className="text-[11.5px] text-muted-foreground">
        A gift, a letter, a LinkedIn message or a text from your own phone?{" "}
        <LogTouchDialog
          accountId={accountId}
          accountName={accountName}
          accountLocationId={locationId}
          userId={userId}
          contacts={contacts}
          onCreated={onSaved}
          trigger="link"
        />
      </p>
    </div>
  );
}

/* ----------------------------------------------------------------- Email */

function EmailTab({
  accountId,
  accountName,
  locationId,
  contacts,
  onSent,
}: {
  accountId: string;
  accountName: string;
  locationId: string | null;
  contacts: ActionContact[];
  onSent: () => void;
}) {
  const send = useServerFn(sendEmail);
  const prefill = useMemo(
    () =>
      contacts
        .filter((c) => c.email)
        .slice(0, 3)
        .map((c) => c.email as string)
        .join(", "),
    [contacts],
  );
  const [to, setTo] = useState(prefill);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const contactId = contacts.find((c) => c.email && to.includes(c.email))?.id ?? null;

  const submit = async () => {
    const list = to
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!list.length) return toast.error("Add at least one recipient.");
    if (!subject.trim()) return toast.error("Subject is required.");
    setSending(true);
    try {
      const res = await send({
        data: {
          category: "follow_up",
          to: list,
          subject: subject.trim(),
          bodyHtml: textToEmailHtml(body),
          accountId,
          contactId,
          locationId,
        },
      });
      announceEmailSend(res, {
        prefix: `To ${accountName}: `,
        sent: `Email sent to ${accountName}`,
      });
      setSubject("");
      setBody("");
      onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the email");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-[12px]">To</Label>
        <Input value={to} onChange={(e) => setTo(e.target.value)} className="h-8" />
      </div>
      <div className="space-y-1">
        <Label className="text-[12px]">Subject</Label>
        <Input value={subject} onChange={(e) => setSubject(e.target.value)} className="h-8" />
      </div>
      <Textarea
        rows={5}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Your words, not the machine's"
      />
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-muted-foreground">
          Outbound with no reply does not satisfy the cadence.
        </p>
        <Button size="sm" className="ml-auto h-7" disabled={sending} onClick={submit}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- SMS */

function SmsTab({
  accountId,
  contacts,
  userId,
  onSent,
}: {
  accountId: string;
  contacts: ActionContact[];
  userId: string | null;
  onSent: () => void;
}) {
  const withPhone = contacts.filter((c) => c.phone);
  const [contactId, setContactId] = useState(withPhone[0]?.id ?? "none");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const contact = withPhone.find((c) => c.id === contactId) ?? null;

  const submit = async () => {
    if (!contact?.phone) return toast.error("Pick a contact with a mobile number.");
    if (!text.trim()) return toast.error("Write the message first.");
    setSaving(true);
    /*
     * A text is one of the six outreach methods (src/lib/pipeline-rules.ts),
     * and the attempt standard counts touchpoints, not captured messages. A
     * text recorded here used to reach the timeline and nothing else, so five
     * texts on five days were five attempts the engine never saw. It is
     * written as a self-reported `text` touchpoint first, and the captured row
     * points at it the way a gateway message points at its own.
     */
    const { data: tp, error: tpError } = await supabase
      .from("touchpoints")
      .insert({
        account_id: accountId,
        contact_id: contact.id,
        type: "text",
        notes: text.trim(),
        created_by: userId,
        capture_source: MANUAL_TOUCHPOINT_CAPTURE_SOURCE,
        direction: "outbound",
      })
      .select("id")
      .single();
    if (tpError) {
      setSaving(false);
      return toastDbError(tpError, { action: "Recording the message" });
    }
    const { error } = await supabase.from("captured_communications").insert({
      provider: "manual",
      external_id: crypto.randomUUID(),
      channel: "sms",
      direction: "outbound",
      to_address: contact.phone,
      body_preview: text.trim(),
      account_id: accountId,
      contact_id: contact.id,
      user_id: userId,
      touchpoint_id: tp?.id ?? null,
    });
    setSaving(false);
    if (error) return toastDbError(error, { action: "Recording the message" });
    setText("");
    toast.success("Message recorded on the timeline");
    onSent();
  };

  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-[12px]">To</Label>
        <Select value={contactId} onValueChange={setContactId}>
          <SelectTrigger className="h-8 text-[12px]">
            <SelectValue placeholder="Pick a contact" />
          </SelectTrigger>
          <SelectContent>
            {withPhone.length === 0 && (
              <SelectItem value="none" disabled>
                No contact has a mobile number
              </SelectItem>
            )}
            {withPhone.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.full_name} · {c.phone}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Short and human"
      />
      <div className="flex items-center gap-2">
        <p className="text-[11px] text-muted-foreground">
          Sent from your company number and recorded here; a reply is what counts as a touch.
        </p>
        <Button size="sm" className="ml-auto h-7" disabled={saving} onClick={submit}>
          {saving ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Invoice */

function InvoiceTab({
  accountId,
  locationId,
  userId,
  onSaved,
}: {
  accountId: string;
  locationId: string | null;
  userId: string | null;
  onSaved: () => void;
}) {
  const [jobId, setJobId] = useState("none");
  const [billed, setBilled] = useState("");
  const [due, setDue] = useState("");
  const [saving, setSaving] = useState(false);

  const jobs = useQuery({
    queryKey: ["account-jobs-for-invoice", accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("id, job_number, address, location_id")
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(25);
      if (error) throw error;
      return data ?? [];
    },
  });

  const job = (jobs.data ?? []).find((j) => j.id === jobId) ?? null;

  const submit = async () => {
    if (!job) return toast.error("Pick the job this invoice is against.");
    const amount = Number(billed);
    if (!amount || amount <= 0) return toast.error("Billed amount is required.");
    setSaving(true);
    const { error } = await supabase.from("invoices").insert({
      job_id: job.id,
      account_id: accountId,
      location_id: job.location_id ?? locationId,
      billed_amount: amount,
      due_date: due || null,
      created_by: userId,
      invoice_number: "",
    });
    setSaving(false);
    if (error) return toastDbError(error, { action: "Creating the invoice" });
    setBilled("");
    setDue("");
    toast.success("Invoice created");
    onSaved();
  };

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="space-y-1 sm:col-span-3">
        <Label className="text-[12px]">Job</Label>
        <Select value={jobId} onValueChange={setJobId}>
          <SelectTrigger className="h-8 text-[12px]">
            <SelectValue placeholder="Pick a job" />
          </SelectTrigger>
          <SelectContent>
            {(jobs.data ?? []).length === 0 && (
              <SelectItem value="none" disabled>
                No jobs on this account yet
              </SelectItem>
            )}
            {(jobs.data ?? []).map((j) => (
              <SelectItem key={j.id} value={j.id}>
                {j.job_number} · {j.address}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-[12px]">Billed amount</Label>
        <NumberInput
          value={billed}
          onValueChange={(_, clean) => setBilled(clean)}
          decimals={2}
          className="h-8"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-[12px]">Due date</Label>
        <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="h-8" />
      </div>
      <div className="flex items-end justify-end">
        <Button size="sm" className="h-7" disabled={saving} onClick={submit}>
          {saving ? "Saving…" : "Create invoice"}
        </Button>
      </div>
    </div>
  );
}
