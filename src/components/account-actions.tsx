import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, Plus, ShieldAlert, Undo2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { createTask } from "@/components/task-dialog";
import { dueInDays } from "@/lib/tasks";
import { toastDbError } from "@/lib/db-errors";
import { EmailComposer } from "@/components/email-composer";
import { useWritesDisabled } from "@/components/app-context";
import { assertWritesEnabled } from "@/lib/write-guard";
import { useManagedOptions } from "@/lib/managed-options";
import { fetchProspectingStages } from "@/lib/visits";
import { fireNoteTriggers } from "@/lib/timeline";
import { PROOF_ACCEPT, proofFileProblem, proofKindFor, uploadProof } from "@/lib/touchpoint-proof";
import { cn } from "@/lib/utils";
import {
  REVERSION_DETAIL_REQUIRED,
  REVERSION_MANAGER_ONLY_REASON,
  REVERSION_REASON_FALLBACK,
  REVERSION_REASON_LIST_KEY,
  composeReversionReason,
  moveAccountBackToPipeline,
  reversionBlocked,
  useReversionRights,
} from "@/lib/pipeline-reversion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MANUAL_TOUCHPOINT_CAPTURE_SOURCE,
  MANUAL_TOUCHPOINT_TYPES,
  TOUCHPOINT_LABEL,
  type GiftPolicy,
  type TouchpointType,
} from "@/lib/accounts";

/** Minimal shape both actions need from a contact. */
export type ActionContact = {
  id: string;
  full_name: string;
  email: string | null;
  phone?: string | null;
  is_primary: boolean;
  gift_policy: GiftPolicy;
};
type Contact = ActionContact;

export function AccountEmailAction({
  accountId,
  accountName,
  locationId,
  contacts,
  onSent,
  compact,
}: {
  accountId: string;
  accountName: string;
  locationId: string | null;
  contacts: Contact[];
  onSent: () => void;
  compact?: boolean;
}) {
  const writes = useWritesDisabled();
  const [open, setOpen] = useState(false);
  const primary = contacts.find((c) => c.is_primary && c.email) ?? contacts.find((c) => c.email);

  return (
    <>
      <Button
        variant="outline"
        size={compact ? "sm" : "default"}
        className={compact ? "h-7 px-2 text-[12px]" : "w-full"}
        disabled={writes.disabled}
        title={writes.reason ?? undefined}
        onClick={() => setOpen(true)}
      >
        <Mail className={compact ? "mr-1 size-3.5" : "mr-2 size-4"} />
        Email
      </Button>
      {!primary && !compact && (
        <p className="text-[12px] text-muted-foreground">
          No contact on this account has an email address yet.
        </p>
      )}
      {!writes.disabled && (
        <EmailComposer
          open={open}
          onOpenChange={setOpen}
          onSent={onSent}
          context={{
            category: "follow_up",
            to: primary?.email ? [primary.email] : [],
            accountId,
            contactId: primary?.id ?? null,
            locationId,
            variables: {
              "account.name": accountName,
              "contact.name": primary?.full_name ?? null,
            },
          }}
        />
      )}
    </>
  );
}

export function LogTouchDialog({
  accountId,
  accountName,
  accountLocationId,
  userId,
  contacts,
  onCreated,
  compact,
  trigger,
}: {
  accountId: string;
  accountName?: string;
  accountLocationId?: string | null;
  userId: string | null;
  contacts: Contact[];
  onCreated: () => void;
  compact?: boolean;
  /** "link": an inline text link, for a sentence in the Activity composer. */
  trigger?: "link";
}) {
  const writes = useWritesDisabled();
  const [open, setOpen] = useState(false);
  // Calls and emails are captured from the dialer and the mailbox, never typed.
  // What is left here is genuinely off-system contact — including a text sent
  // from a rep's own phone — and every row is written with
  // capture_source: "manual", which marks it self-reported so nobody mistakes
  // it for captured activity.
  const [type, setType] = useState<TouchpointType>("meeting_in_person");
  /*
   * Melly (29 Oct): a record moves to Conversation Established "once anyone at
   * the company responds. Any response counts, even a receptionist." The
   * engine learns about replies from the dialer and the mailbox on their own;
   * a reply that reached the rep's own phone, or a conversation at the door,
   * had no way in. This switch is that way in: it stamps `replied_at` on the
   * row, which is the same signal a captured inbound message leaves. A meeting
   * in person is a response by definition, so it starts on.
   */
  const [responded, setResponded] = useState(true);
  /*
   * Melly, GSR Edits: a hand-logged touch counts "only if the rep attaches
   * something — a photo of the gift, a copy of their thank you, meeting
   * notes ... A rep clicking a button with nothing attached does not count.
   * It gets recorded as an attempt." The database decides (20261110190000);
   * the form only carries the file and says plainly which one this will be.
   */
  const [proof, setProof] = useState<File | null>(null);
  const [contactId, setContactId] = useState<string>("none");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedContact = contacts.find((c) => c.id === contactId);
  const giftBlocked =
    (type === "gift" || type === "seasonal_send") && selectedContact?.gift_policy === "prohibited";
  const giftApproval =
    (type === "gift" || type === "seasonal_send") &&
    selectedContact?.gift_policy === "approval_required";
  const [approvalRef, setApprovalRef] = useState("");
  const [followUp, setFollowUp] = useState<"none" | "7" | "14" | "30">("none");

  const submit = async () => {
    assertWritesEnabled(writes.disabled, writes.reason);
    if (!userId) return;
    if (giftBlocked) {
      toast.error("This contact's employer prohibits gifts — cannot log.");
      return;
    }
    if (giftApproval && approvalRef.trim().length < 2) {
      toast.error("Enter the approval reference before logging this gift.");
      return;
    }
    if (proof && proofFileProblem(proof)) {
      toast.error(proofFileProblem(proof));
      return;
    }
    setSaving(true);
    const composedNotes = giftApproval
      ? `[Gift pre-approval: ${approvalRef.trim()}]\n${notes}`.trim()
      : notes.trim() || null;
    let proofPathValue: string | null = null;
    if (proof) {
      try {
        proofPathValue = await uploadProof(accountId, proof);
      } catch (e) {
        setSaving(false);
        toastDbError(e, { action: "upload the proof" });
        return;
      }
    }
    const { data: logged, error } = await supabase
      .from("touchpoints")
      .insert({
        account_id: accountId,
        contact_id: contactId === "none" ? null : contactId,
        type,
        notes: composedNotes,
        created_by: userId,
        capture_source: MANUAL_TOUCHPOINT_CAPTURE_SOURCE,
        direction: "outbound",
        replied_at: responded ? new Date().toISOString() : null,
        proof_path: proofPathValue,
        proof_kind: proof ? proofKindFor(proof) : null,
      })
      .select("counts_toward_cadence")
      .maybeSingle();
    if (error) {
      setSaving(false);
      toast.error(error.message);
      return;
    }
    const counted = logged?.counts_toward_cadence === true;

    // "Follow up in two weeks" is one control on this form, not a second
    // screen — it is how reps actually create follow-ups.
    if (followUp !== "none") {
      const { error: taskError } = await createTask({
        title: `Follow up — ${accountName}`,
        description: composedNotes,
        assignee: userId,
        dueDate: dueInDays(Number(followUp)),
        createdBy: userId,
        source: "touchpoint",
        link: {
          entityType: "account",
          entityId: accountId,
          accountId,
          contactId: contactId === "none" ? null : contactId,
          locationId: accountLocationId ?? null,
        },
      });
      if (taskError) toastDbError(taskError, { action: "create follow-up task" });
    }

    setSaving(false);
    const what = counted
      ? "Logged as a follow-up, marked unverified"
      : "Logged as an attempt — attach proof to make it count";
    toast.success(followUp === "none" ? what : `${what}. Follow-up task created.`);
    setOpen(false);
    setType("meeting_in_person");
    setResponded(true);
    setProof(null);
    setContactId("none");
    setNotes("");
    setApprovalRef("");
    setFollowUp("none");
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger === "link" ? (
          <button
            type="button"
            className="font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
            disabled={writes.disabled}
            title={writes.reason ?? undefined}
          >
            Log off-system contact
          </button>
        ) : compact ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-[12px]"
            disabled={writes.disabled}
            title={writes.reason ?? undefined}
          >
            <Plus className="mr-1 size-3.5" />
            Log off-system contact
          </Button>
        ) : (
          <Button
            size="lg"
            className="h-12 w-full text-base"
            disabled={writes.disabled}
            title={writes.reason ?? undefined}
          >
            <Plus className="mr-2 size-5" />
            Log off-system contact
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log off-system contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-[12px] text-muted-foreground">
            Calls and emails log themselves from the dialer and the mailbox. Use this for contact
            they cannot see — a door knock, a LinkedIn message, a letter, or a text you sent from
            your own phone. It is recorded as self-reported, not as captured activity.
          </p>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v as TouchpointType);
                setResponded(v === "meeting_in_person");
              }}
            >
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MANUAL_TOUCHPOINT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TOUCHPOINT_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Contact (optional)</Label>
            <Select value={contactId} onValueChange={setContactId}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No specific contact —</SelectItem>
                {contacts.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.full_name}
                    {c.gift_policy === "prohibited" ? " · gifts prohibited" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2.5">
            <Switch
              checked={responded}
              onCheckedChange={setResponded}
              aria-label="They responded"
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">They responded</span>
              <span className="block text-[12px] text-muted-foreground">
                Any response counts for the pipeline, even a receptionist: a record in Active
                Outreach moves to Conversation Established. A client&rsquo;s clock restarts only
                with proof attached below.
              </span>
            </span>
          </label>
          {giftBlocked && (
            <Alert variant="destructive">
              <ShieldAlert className="size-4" />
              <AlertTitle>Gift blocked</AlertTitle>
              <AlertDescription>
                {selectedContact?.full_name} cannot accept gifts. Choose a different contact or log
                a different touchpoint type.
              </AlertDescription>
            </Alert>
          )}
          {giftApproval && (
            <div className="space-y-1.5">
              <Label>Pre-approval reference</Label>
              <Input
                value={approvalRef}
                onChange={(e) => setApprovalRef(e.target.value)}
                placeholder="Approver name or ticket #"
                className="h-11"
              />
              <p className="text-xs text-muted-foreground">
                Required — this contact's employer wants manager sign-off before accepting.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="touch-proof">Proof</Label>
            <Input
              id="touch-proof"
              type="file"
              accept={PROOF_ACCEPT}
              className="h-11 py-2"
              onChange={(e) => setProof(e.target.files?.[0] ?? null)}
            />
            <p
              className={cn("text-xs", proof ? "text-success" : "text-muted-foreground")}
              data-proof-hint
            >
              {proof
                ? `${proof.name} — this counts as a follow-up, marked unverified.`
                : "A photo of the gift, their thank-you, your meeting notes. Without one this is logged as an attempt and does not restart the client's clock."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Follow up</Label>
            <Select value={followUp} onValueChange={(v) => setFollowUp(v as typeof followUp)}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No follow-up task</SelectItem>
                <SelectItem value="7">Follow up in a week</SelectItem>
                <SelectItem value="14">Follow up in two weeks</SelectItem>
                <SelectItem value="30">Follow up in a month</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || giftBlocked || writes.disabled}
            title={writes.reason ?? undefined}
          >
            {saving ? "Logging…" : "Log"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Move back to pipeline" — the reversal of signing.
 *
 * An active client whose deal fell through, or whose relationship has reset,
 * goes back onto the Prospecting board at the stage the rep picks (earliest
 * open stage by default). A reason is required and is written to the
 * account's stage history, so the timeline reads "Active Client → Ready —
 * Moved back to pipeline — Deal fell through: lost the bid". Nothing is
 * deleted: jobs, documents, touchpoints and history stay on the record.
 *
 * This is a manager's call, not a rep's: "Reps cannot assign owners, move a
 * client back to the pipeline, or clear a Critical directly." The button is
 * disabled with that reason for anyone who does not manage the account's
 * office, and `move_account_back_to_pipeline` raises on the same rule, so a
 * rep who gets past the UI is still refused. The app's write lock applies on
 * top, as it does to every write.
 */
/**
 * "Move back to pipeline" as a menu entry, for the action row's More menu on
 * the account record. It carries the same gate as the dialog's own button —
 * a manager of the owning office, writes enabled — and says why when it is
 * disabled, so a rep who finds it greyed out is told rather than puzzled.
 *
 * It only asks to open the dialog. A `DialogTrigger` inside a dropdown menu
 * is the classic Radix trap — the menu closes on select and takes the
 * trigger, and with it the dialog, out of the tree — so the host holds the
 * open state and renders `MoveBackToPipelineDialog` controlled, outside the
 * menu.
 */
export function MoveBackToPipelineMenuItem({
  locationId,
  onSelect,
}: {
  locationId: string | null;
  onSelect: () => void;
}) {
  const writes = useWritesDisabled();
  const rights = useReversionRights(locationId);
  // Not a manager of this office (or still checking): no menu item at all.
  if (!rights.allowed) return null;
  return (
    <DropdownMenuItem
      disabled={writes.disabled}
      title={writes.reason ?? undefined}
      onSelect={onSelect}
      className="gap-2 text-[13px]"
    >
      <Undo2 className="size-4 text-primary" />
      Move back to pipeline
    </DropdownMenuItem>
  );
}

export function MoveBackToPipelineDialog({
  accountId,
  accountName,
  locationId,
  status,
  onMoved,
  compact,
  open: controlledOpen,
  onOpenChange,
}: {
  accountId: string;
  accountName: string;
  /** The account's owning office — whose managers may make this move. */
  locationId: string | null;
  /** Current account status — active/onboarding return to prospect. */
  status: string | null;
  onMoved: () => void;
  compact?: boolean;
  /**
   * Controlled mode: the host owns whether the dialog is open and no trigger
   * button is rendered — see `MoveBackToPipelineMenuItem`. Left undefined,
   * the dialog renders its own button and keeps its own state, as it always
   * has on the full record and the Client 360 panel.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const writes = useWritesDisabled();
  const rights = useReversionRights(locationId);
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => {
    if (controlled) onOpenChange?.(next);
    else setOwnOpen(next);
  };
  const [stageId, setStageId] = useState("");
  const [reasonKey, setReasonKey] = useState("");
  const [detail, setDetail] = useState("");
  const [saving, setSaving] = useState(false);

  // Same query the account page uses to decide its layout — one stage list.
  const stagesQ = useQuery({
    queryKey: ["prospecting-stages"],
    queryFn: fetchProspectingStages,
    staleTime: 5 * 60_000,
    enabled: open,
  });
  const reasons = useManagedOptions(REVERSION_REASON_LIST_KEY, REVERSION_REASON_FALLBACK);

  const openStages = stagesQ.data?.open ?? [];
  const targetId = stageId || openStages[0]?.id || "";
  const target = openStages.find((s) => s.id === targetId) ?? null;
  const blocked = reversionBlocked({ stageId: targetId || null, reasonKey, detail });
  const detailRequired = REVERSION_DETAIL_REQUIRED.has(reasonKey);

  const reset = () => {
    setStageId("");
    setReasonKey("");
    setDetail("");
  };

  const submit = async () => {
    if (blocked || !target) return;
    if (!rights.allowed) {
      toast.error(rights.reason ?? REVERSION_MANAGER_ONLY_REASON);
      return;
    }
    setSaving(true);
    try {
      assertWritesEnabled(writes.disabled, writes.reason);
      const reason = composeReversionReason(reasons.label(reasonKey), detail);
      await moveAccountBackToPipeline({ accountId, stageId: target.id, reason, status });
      // A stage move is one of the trigger points for a stashed note.
      const fired = await fireNoteTriggers(accountId, "next_stage_change");
      for (const n of fired) toast.info("Note for this moment", { description: n.body });
      toast.success(`${accountName} is back on the pipeline at ${target.name}`, {
        description: "Nothing was removed — the move and its reason are on the timeline.",
      });
      setOpen(false);
      reset();
      onMoved();
    } catch (e) {
      toastDbError(e, { action: "move this account back to the pipeline" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      {/* A rep (or anyone while the manager check is outstanding) gets no
          button at all — the move is a manager's call. */}
      {controlled || !rights.allowed ? null : (
        <DialogTrigger asChild>
          <Button
            variant="outline"
            size={compact ? "sm" : "default"}
            className={compact ? "h-7 px-2 text-[12px]" : "h-10 rounded-lg px-4 text-[14px]"}
            disabled={writes.disabled}
            title={writes.reason ?? undefined}
          >
            <Undo2 className={compact ? "mr-1 size-3.5" : "mr-1.5 size-4"} />
            Move back to pipeline
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {accountName} back to the pipeline</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-[12px] text-muted-foreground">
            The account leaves Active Clients and lands on the Prospecting board at the stage you
            pick. Nothing is deleted — jobs, documents, touchpoints and the stage history stay on
            the record. The move and its reason are written to the timeline.
          </p>
          <div className="space-y-1.5">
            <Label>Return to stage</Label>
            <Select value={targetId} onValueChange={setStageId} disabled={stagesQ.isLoading}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder={stagesQ.isLoading ? "Loading stages…" : "Pick a stage"} />
              </SelectTrigger>
              <SelectContent>
                {openStages.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!stagesQ.isLoading && stagesQ.data && openStages.length === 0 ? (
              <p className="text-xs text-destructive">
                No open Prospecting stage exists — an admin has to add one under Settings →
                Pipelines.
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>Reason (required)</Label>
            <Select value={reasonKey} onValueChange={setReasonKey}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Why is this client going back?" />
              </SelectTrigger>
              <SelectContent>
                {reasons.options.map((r) => (
                  <SelectItem key={r.key} value={r.key}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{detailRequired ? "What happened (required)" : "Note (optional)"}</Label>
            <Textarea
              rows={3}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              placeholder="Lost the bid to a competitor; new property manager wants to re-quote…"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || !!blocked || writes.disabled || !rights.allowed}
            title={blocked ?? undefined}
          >
            {saving ? "Moving…" : "Move back to pipeline"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
