/**
 * "Sending in 4:32 — Edit · Cancel" — the undo window, wherever a held email
 * is listed.
 *
 * David, 24 Sep: an email a person sends waits a few minutes first, so the
 * wrong recipient, the wrong file or a typo can still be caught. Only the
 * sender may edit or cancel (RLS "email log update own"); everyone else who
 * can see the email sees the countdown, so nobody resends it thinking it
 * went nowhere.
 *
 * Every write is conditioned on status = 'held'. Once the release sweep has
 * claimed the email that matches no row, and the sender is told it has
 * already gone — never a silent "saved".
 *
 * And after the window: an email nothing carried is 'queued' (or 'failed'),
 * and this is where it says so. David's 11 Oct invoice sat in 'queued' for
 * hours with the screen saying sent. Now the row reads "Not sent yet — …"
 * with the reason the transport seam stored, the action that fixes it
 * (Connect Outlook on your Security page; for admins, connect an email
 * service in Integrations), and Resend / Cancel for the sender or an admin.
 * While it is still held, a sender with no transport is warned on the row
 * itself, before the window closes.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Clock, Paperclip, Send, X } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
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
import { TokenEditor, stripTokenMarkup } from "@/components/token-editor";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { isValidEmail, parseRecipients } from "@/lib/email";
import { fetchEmailDeliveryDetail } from "@/lib/email-delivery-detail";
import { holdLabel, isHeld, parseAttachments, type EmailAttachmentLink } from "@/lib/email-hold";
import { noTransportSentence, unsentEmailNotice } from "@/lib/email-transport";
import { isPrivileged } from "@/lib/roles";
import { sanitizeEditorHtml } from "@/lib/safe-html";
import { useMyEmailTransport } from "@/lib/use-email-transport";

/** The columns this needs; add them to any select that lists email. */
export const HELD_EMAIL_COLUMNS =
  "status, release_at, sent_by, to_emails, cc_emails, subject, body_html, attachments";

export type HeldEmailRow = {
  id: string;
  status: string | null;
  release_at?: string | null;
  sent_by?: string | null;
  to_emails?: string[] | null;
  cc_emails?: string[] | null;
  subject?: string | null;
  body_html?: string | null;
  attachments?: unknown;
  created_at?: string | null;
  sent_at?: string | null;
};

/** Re-renders once a second while mounted — the countdown's clock. */
export function useNow(active: boolean, intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return;
    setNow(new Date());
    const t = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [active, intervalMs]);
  return now;
}

const ALREADY_GONE = "Too late — this email has already been released to send.";

/**
 * The held line for one email, or nothing when it is not held or cancelled.
 * `onChanged` refreshes whatever list it sits in.
 */
export function HeldEmailControls({
  row,
  onChanged,
  className,
}: {
  row: HeldEmailRow;
  onChanged?: () => void;
  className?: string;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const held = isHeld(row);
  const now = useNow(held);
  const [editing, setEditing] = useState(false);
  const label = holdLabel(row, now);
  const mine = Boolean(app.userId) && row.sent_by === app.userId;
  /*
   * David, 13 Oct: Send now matters most for a contract or an invoice somebody
   * is waiting on — and the person waiting is often not the sender. The
   * server already lets an owner or admin release any held email
   * (sendHeldEmailNow); the button now shows for them too.
   */
  const mayRelease = mine || isPrivileged(app.realRoles);
  // Only the sender's own held email can be warned about: their transport is
  // the one that will (or will not) carry it.
  const transport = useMyEmailTransport(held && mine);
  const wontSend = held && mine && transport.data && !transport.data.configured;

  const refresh = () => {
    onChanged?.();
    void qc.invalidateQueries({ queryKey: ["job-comms"] });
    void qc.invalidateQueries({ queryKey: ["job-outbox"] });
    void qc.invalidateQueries({ queryKey: ["account-timeline"] });
  };

  const cancel = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("email_messages")
        .update({ status: "cancelled" } as never)
        .eq("id", row.id)
        .eq("status", "held" as never)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error(ALREADY_GONE);
    },
    onSuccess: () => {
      toast.success("Canceled — the email will not be sent.");
      refresh();
    },
    onError: (e) =>
      e instanceof Error && e.message === ALREADY_GONE
        ? (toast.error(ALREADY_GONE), refresh())
        : toastDbError(e, { action: "Cancel email" }),
  });

  const sendNow = useMutation({
    mutationFn: async () => {
      const { sendHeldEmailNow } = await import("@/lib/email.functions");
      return sendHeldEmailNow({ data: { id: row.id } });
    },
    onSuccess: (result) => {
      if (result.sent) toast.success("Sent.");
      else
        toast.warning("Not sent yet.", {
          description: noTransportSentence(result.reason as never) || undefined,
        });
      refresh();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Couldn't send it now.");
      refresh();
    },
  });

  if (row.status === "queued" || row.status === "failed") {
    return <UnsentEmailNotice row={row} className={className} onChanged={refresh} />;
  }
  if (!label) return null;

  return (
    <div
      data-held-email={row.status}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${
        held ? "text-warning" : "text-muted-foreground"
      } ${className ?? ""}`}
    >
      <Clock className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium tabular-nums" aria-live="off">
        {label}
      </span>
      {held && mayRelease ? (
        <>
          {/* A real button, not a link: it is the one thing on the line a
              person waiting on a signature needs to find. */}
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-warning/50 px-2 text-xs"
            data-send-now
            disabled={app.writesDisabled || sendNow.isPending || cancel.isPending}
            onClick={() => sendNow.mutate()}
          >
            <Send className="mr-1 size-3" aria-hidden />
            {sendNow.isPending ? "Sending…" : "Send now"}
          </Button>
          {mine ? (
            <>
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs"
                disabled={app.writesDisabled}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              <span aria-hidden>·</span>
              <Button
                size="sm"
                variant="link"
                className="h-auto p-0 text-xs text-destructive"
                disabled={app.writesDisabled || cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                {cancel.isPending ? "Canceling…" : "Cancel"}
              </Button>
            </>
          ) : null}
        </>
      ) : null}
      {wontSend ? (
        <span className="flex basis-full items-start gap-1.5 text-destructive" data-held-wont-send>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {noTransportSentence(transport.data?.reason)}{" "}
            <Link to="/security" className="font-medium underline underline-offset-2">
              Open your Security page
            </Link>
          </span>
        </span>
      ) : null}
      {editing ? (
        <HeldEmailEditDialog
          row={row}
          open
          onOpenChange={(o) => !o && setEditing(false)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

/**
 * "Not sent yet — {reason}" for an email the transport seam parked or a
 * provider refused, with what fixes it. Reads the stored reason itself so no
 * list has to select the newer columns (and none breaks before they exist).
 */
function UnsentEmailNotice({
  row,
  onChanged,
  className,
}: {
  row: HeldEmailRow;
  onChanged: () => void;
  className?: string;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const mine = Boolean(app.userId) && row.sent_by === app.userId;
  /*
   * David, 13 Oct: Send now matters most for a contract or an invoice somebody
   * is waiting on — and the person waiting is often not the sender. The
   * server already lets an owner or admin release any held email
   * (sendHeldEmailNow); the button now shows for them too.
   */
  const mayRelease = mine || isPrivileged(app.realRoles);
  // Real roles, not View As: the server checks the signed-in person.
  const canManage = isPrivileged(app.realRoles);
  const transport = useMyEmailTransport(mine);
  const detail = useQuery({
    queryKey: ["email-delivery", row.id],
    queryFn: () => fetchEmailDeliveryDetail(row.id, mine ? null : row.sent_by),
    staleTime: 30_000,
  });

  const refresh = () => {
    onChanged();
    void qc.invalidateQueries({ queryKey: ["email-delivery", row.id] });
  };

  const resend = useMutation({
    // Imported on use: see use-email-transport.ts for why not at load.
    mutationFn: async () => {
      const { resendQueuedEmail } = await import("@/lib/email.functions");
      return resendQueuedEmail({ data: { id: row.id } });
    },
    onSuccess: (r) => {
      if (r.sent) toast.success(r.provider === "outlook" ? "Sent through Outlook." : "Sent.");
      else toast.warning("Still not sent.", { description: noTransportSentence(r.reason) });
      refresh();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not resend the email.");
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: async () => {
      const { cancelQueuedEmail } = await import("@/lib/email.functions");
      return cancelQueuedEmail({ data: { id: row.id } });
    },
    onSuccess: () => {
      toast.success("Canceled — the email will not be sent.");
      refresh();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : "Could not cancel the email.");
      refresh();
    },
  });

  const notice = unsentEmailNotice(
    {
      status: detail.data?.status ?? row.status,
      sent_at: detail.data?.sent_at ?? row.sent_at ?? null,
      created_at: detail.data?.created_at ?? row.created_at ?? null,
      sent_by: row.sent_by ?? null,
      delivery_reason: detail.data?.delivery_reason ?? null,
      next_attempt_at: detail.data?.next_attempt_at ?? null,
      error: detail.data?.error ?? null,
    },
    {
      mine,
      canManage,
      senderName: detail.data?.sender_name ?? null,
      myTransport: transport.data ?? null,
    },
    new Date(),
  );
  if (!notice) return null;

  const busy = resend.isPending || cancel.isPending;
  return (
    <div
      data-unsent-email={row.status}
      className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-xs ${
        notice.tone === "destructive" ? "text-destructive" : "text-warning"
      } ${className ?? ""}`}
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium">{notice.headline}</span>
      {notice.actions.map((a) =>
        a.kind === "link" ? (
          <Link
            key={a.to}
            to={a.to}
            className="font-medium text-foreground underline underline-offset-2"
          >
            {a.label}
          </Link>
        ) : a.kind === "resend" ? (
          <Button
            key="resend"
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs"
            disabled={app.writesDisabled || busy}
            onClick={() => resend.mutate()}
          >
            {resend.isPending ? "Sending…" : "Resend"}
          </Button>
        ) : (
          <Button
            key="cancel"
            size="sm"
            variant="link"
            className="h-auto p-0 text-xs text-destructive"
            disabled={app.writesDisabled || busy}
            onClick={() => cancel.mutate()}
          >
            {cancel.isPending ? "Canceling…" : "Cancel"}
          </Button>
        ),
      )}
      {notice.detail ? (
        <span className="basis-full text-muted-foreground">{notice.detail}</span>
      ) : null}
    </div>
  );
}

function HeldEmailEditDialog({
  row,
  open,
  onOpenChange,
  onSaved,
}: {
  row: HeldEmailRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const now = useNow(open);
  const [to, setTo] = useState((row.to_emails ?? []).join(", "));
  const [cc, setCc] = useState((row.cc_emails ?? []).join(", "));
  const [subject, setSubject] = useState(row.subject ?? "");
  const [body, setBody] = useState(row.body_html ?? "");
  const [files, setFiles] = useState<EmailAttachmentLink[]>(() =>
    parseAttachments(row.attachments),
  );

  const recipients = parseRecipients(to);
  const ccList = parseRecipients(cc);
  const invalid = [...recipients, ...ccList].filter((r) => !isValidEmail(r));

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("email_messages")
        .update({
          to_emails: recipients,
          cc_emails: ccList,
          subject: subject.trim(),
          body_html: sanitizeEditorHtml(stripTokenMarkup(body)),
          attachments: files,
        } as never)
        .eq("id", row.id)
        .eq("status", "held" as never)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error(ALREADY_GONE);
    },
    onSuccess: () => {
      toast.success("Changes saved — it still sends when the timer runs out.");
      onSaved();
      onOpenChange(false);
    },
    onError: (e) =>
      e instanceof Error && e.message === ALREADY_GONE
        ? (toast.error(ALREADY_GONE), onSaved(), onOpenChange(false))
        : toastDbError(e, { action: "Save email" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Edit before it sends</DialogTitle>
          <DialogDescription className="tabular-nums">
            {holdLabel(row, now) ?? "Sending now"} — the timer keeps running while you edit.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">To</Label>
            <Input value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">CC</Label>
            <Input value={cc} onChange={(e) => setCc(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">Body</Label>
            <TokenEditor value={body} onChange={setBody} minHeight={180} />
          </div>
          {files.length ? (
            <div className="rounded-md border p-2" data-held-attachments>
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Paperclip className="size-3" /> Files going with this email
              </p>
              <ul className="space-y-1 text-xs">
                {files.map((f) => (
                  <li key={f.url} className="flex items-center justify-between gap-2">
                    <span className="truncate">{f.label}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => setFiles((prev) => prev.filter((x) => x.url !== f.url))}
                    >
                      <X className="mr-1 size-3" /> Remove
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {invalid.length ? (
            <p className="text-xs text-destructive">Invalid addresses: {invalid.join(", ")}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending || recipients.length === 0 || invalid.length > 0 || !subject.trim()
            }
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
