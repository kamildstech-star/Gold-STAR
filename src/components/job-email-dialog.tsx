import { browserAppOrigin } from "@/lib/app-origin";
import { escapeHtml as escapeMergeHtml, sanitizeEditorHtml } from "@/lib/safe-html";
/**
 * Send Email from a job.
 *
 * The template is resolved against the real job before anything is shown, so
 * what the rep reads on screen is exactly what leaves the building. When the
 * template is a request-for-information, a single-use tokenized intake link is
 * minted at send time and substituted for {IntakeLink}.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Link2, Mail, Paperclip } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import { TokenEditor, htmlToText, stripTokenMarkup } from "@/components/token-editor";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { sendEmail, emailStatus } from "@/lib/email.functions";
import {
  EMAIL_CATEGORY_LABEL,
  isValidEmail,
  parseRecipients,
  type EmailCategory,
} from "@/lib/email";
import {
  loadJobMergeContext,
  renderKeys,
  stripUnavailablePaymentBlocks,
  unresolvedKeys,
} from "@/lib/merge-keys";
import { applyMintedLinks, mintLinkKeys } from "@/lib/link-keys";
import { announceEmailSend } from "@/components/email-send-toast";
import { noTransportSentence } from "@/lib/email-transport";
import { isMissingSchema } from "@/lib/schema-fallback";
import { EmailAttachmentPicker } from "@/components/email-attachment-picker";
import { mergeAttachmentLinks, type PickedAttachment } from "@/lib/email-attachments";
import { signedDocumentUrl } from "@/lib/pdf-actions";
import {
  HELD_EMAIL_COLUMNS,
  HeldEmailControls,
  type HeldEmailRow,
} from "@/components/held-email-controls";

type TemplateRow = {
  id: string;
  name: string;
  category: EmailCategory;
  subject: string;
  body: string;
  signature: string | null;
  intake_form: boolean;
};

/**
 * A file the recipient gets with the message. The mail provider does not carry
 * binary attachments yet, so these go as time-limited download links and the
 * dialog says so — a customer must never be told a file is attached when it is
 * a link, or vice versa.
 */
export type JobEmailAttachment = { label: string; url: string };

/** File names reach the HTML body verbatim; they are not ours to trust. */
function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function JobEmailDialog({
  jobId,
  open,
  onOpenChange,
  purpose,
  paymentId,
  invoiceId,
  attachments,
  links,
  draft,
}: {
  jobId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Narrows the template picker to templates written for this purpose. Falls
   * back to the whole library when the office has not written one yet, so the
   * action is never dead-ended by a missing template.
   */
  purpose?: EmailCategory;
  /** Resolves the {Payment.*} keys against one recorded payment. */
  paymentId?: string | null;
  /** Logged on the message, so the invoice's history shows the send. */
  invoiceId?: string | null;
  attachments?: JobEmailAttachment[];
  /**
   * A finished draft to open on instead of a template (the daily update).
   * "Hello there," is addressed to the job's contact by first name when the
   * job has one. The office still edits it before sending.
   */
  draft?: { subject: string; html: string } | null;
  /**
   * Pages the recipient can open, as opposed to files they download — the
   * invoice's photo link. Listed separately in the dialog and in the body so
   * nobody is told a web page is an attachment.
   */
  links?: JobEmailAttachment[];
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const send = useServerFn(sendEmail);
  const status = useServerFn(emailStatus);

  const [templateId, setTemplateId] = useState("none");
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  /** Documents the sender ticked — the job's own or the company's (21 Oct). */
  const [picked, setPicked] = useState<PickedAttachment[]>([]);

  const ctxQ = useQuery({
    queryKey: ["job-merge-context", jobId, paymentId ?? null],
    enabled: open,
    queryFn: () =>
      loadJobMergeContext(jobId, { name: app.fullName, email: app.email }, { paymentId }),
  });

  const templatesQ = useQuery({
    queryKey: ["email-templates", "job-send"],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_templates")
        .select("id, name, category, subject, body, signature, intake_form")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as TemplateRow[];
    },
  });

  const configuredQ = useQuery({
    queryKey: ["email", "status"],
    enabled: open,
    queryFn: () => status({}),
  });

  const outboxQ = useQuery({
    queryKey: ["job-outbox", jobId],
    enabled: open,
    queryFn: async () => {
      const read = (cols: string) =>
        supabase
          .from("email_messages")
          .select(cols)
          .eq("job_id", jobId)
          .order("created_at", { ascending: false })
          .limit(5);
      let res = await read(`id, created_at, ${HELD_EMAIL_COLUMNS}`);
      // Before 20260928122000 there are no held columns to read.
      if (res.error && isMissingSchema(res.error)) {
        res = await read("id, subject, status, created_at, to_emails, sent_by");
      }
      if (res.error) throw res.error;
      return (res.data ?? []) as unknown as (HeldEmailRow & { created_at: string })[];
    },
  });

  const all = useMemo(() => templatesQ.data ?? [], [templatesQ.data]);
  const forPurpose = useMemo(
    () => (purpose ? all.filter((t) => t.category === purpose) : all),
    [all, purpose],
  );
  // Only fall back to the whole library when this purpose has no template at
  // all — an empty picker would strand the action behind an admin task.
  const templates = forPurpose.length ? forPurpose : all;
  const purposeUnwritten = Boolean(purpose) && forPurpose.length === 0;
  const template = templates.find((t) => t.id === templateId) ?? null;
  const mergeData = ctxQ.data?.data ?? {};

  /*
   * Closing clears the draft. This dialog is mounted once and reopened per
   * payment, so keeping the body would carry one customer's receipt wording,
   * amounts included, into the next one.
   */
  useEffect(() => {
    if (open) return;
    setTemplateId("none");
    setSubject("");
    setBody("");
    setPicked([]);
  }, [open]);

  // A ready draft (daily update) opens filled, once the contact is known.
  useEffect(() => {
    if (!open || !draft || !ctxQ.data || templateId !== "none" || subject) return;
    const first = mergeData["Contact.FirstName"];
    setSubject(draft.subject);
    setBody(
      first ? draft.html.replace("Hello there,", `Hello ${escapeMergeHtml(first)},`) : draft.html,
    );
    // Seeds once per opening; later edits are the office's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draft, ctxQ.data]);

  // Smart-fill: default recipient is the job's primary contact.
  useEffect(() => {
    if (!open || !ctxQ.data) return;
    const first = ctxQ.data.jobContacts.find((c) => c.email);
    setTo(first?.email ?? "");
  }, [open, ctxQ.data]);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    setSubject(renderKeys(tpl.subject, mergeData));
    const withSig = tpl.signature ? `${tpl.body}<p>${tpl.signature}</p>` : tpl.body;
    // Payment methods this billing office does not have are dropped whole —
    // a customer never sees an empty link or "n/a".
    const escapedData = Object.fromEntries(
      Object.entries(mergeData).map(([key, value]) => [
        key,
        value == null ? value : escapeMergeHtml(value),
      ]),
    );
    setBody(renderKeys(stripUnavailablePaymentBlocks(withSig, mergeData), escapedData));
  };

  /*
   * A purpose-driven send (a receipt, say) opens on its own template already
   * resolved, so the office reads the finished wording rather than hunting for
   * it. Only once, and only once the merge data is in — applying it earlier
   * would bake the unresolved keys into the body.
   */
  useEffect(() => {
    if (!open || !purpose || templateId !== "none" || !ctxQ.data || !forPurpose.length) return;
    applyTemplate(forPurpose[0]!.id);
    // applyTemplate reads state this effect must not depend on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, purpose, templateId, ctxQ.data, forPurpose]);

  const plain = htmlToText(`${subject}\n${body}`);
  const missing = unresolvedKeys(plain, mergeData).filter(
    (k) => k !== "IntakeLink" && k !== "link",
  );
  // Warn (never block) when the billing office has no card link and no Zelle.
  const noPaymentMethods =
    Boolean(ctxQ.data) &&
    !String(mergeData["Office Payment Link"] ?? "").trim() &&
    !String(mergeData["Office Zelle Email"] ?? "").trim();

  // The client's own templates write the secure link as {{link}}; both spellings
  // mint the same signing/intake link at send time.
  const needsIntakeLink =
    plain.includes("{IntakeLink}") || plain.includes("{{link}}") || Boolean(template?.intake_form);
  const recipients = parseRecipients(to);
  const invalid = recipients.filter((r) => !isValidEmail(r));

  const mutation = useMutation({
    mutationFn: async () => {
      let html = stripTokenMarkup(body);
      let intakeRequestId: string | null = null;

      if (needsIntakeLink) {
        const { data: req, error } = await supabase
          .from("intake_requests")
          .insert({
            job_id: jobId,
            recipient_email: recipients[0] ?? null,
            recipient_name: ctxQ.data?.jobContacts[0]?.name ?? null,
            created_by: app.userId ?? null,
          })
          .select("id, token")
          .single();
        if (error) throw error;
        intakeRequestId = req.id;
        const url = `${browserAppOrigin()}/intake/${req.token}`;
        const anchor = `<a href="${url}">${url}</a>`;
        html =
          html.includes("{IntakeLink}") || html.includes("{{link}}")
            ? html.replaceAll("{IntakeLink}", anchor).replaceAll("{{link}}", anchor)
            : `${html}<p>Please confirm the missing details here: ${anchor}</p>`;
      }

      // Link keys mint a fresh tokenized URL for this recipient at send time,
      // honouring the form-link expiry setting and logging who received it.
      if (ctxQ.data?.locationId) {
        const minted = await mintLinkKeys({
          jobId,
          locationId: ctxQ.data.locationId,
          text: `${subject}\n${html}`,
          recipientEmail: recipients[0] ?? null,
          recipientName: ctxQ.data?.jobContacts[0]?.name ?? null,
          userId: app.userId ?? null,
        });
        html = applyMintedLinks(html, minted);
      }

      // Files ride separately and are appended when the email is released,
      // not here: during the undo window the sender can take a wrong file
      // off, and that must really take it out of what the customer gets.
      // Picked documents are signed only now, when the email really goes —
      // the same thirty-day life the invoice's own PDF link gets.
      const pickedLinks = await Promise.all(
        picked.map(async (p) => ({
          label: p.name,
          url: await signedDocumentUrl(p.id, {
            seconds: 60 * 60 * 24 * 30,
            why: "The link sits inside an emailed document list; the recipient opens it when they get to it and cannot sign in.",
          }),
        })),
      );
      const files = mergeAttachmentLinks(attachments ?? [], pickedLinks);
      // The URL itself is printed beside the label, so a mail client that
      // strips anchors still leaves the customer something they can copy.
      const pages = links ?? [];
      if (pages.length) {
        html += `<p>${pages
          .map((l) => `${escapeHtml(l.label)}<br/><a href="${l.url}">${escapeHtml(l.url)}</a>`)
          .join("<br/>")}</p>`;
      }

      const res = await send({
        data: {
          to: recipients,
          cc: parseRecipients(cc),
          subject,
          bodyHtml: sanitizeEditorHtml(html),
          attachmentUrl: files[0]?.url ?? null,
          attachments: files,
          category: template?.category ?? "notification",
          templateId: template?.id ?? null,
          jobId,
          invoiceId: invoiceId ?? null,
          accountId: ctxQ.data?.accountId ?? null,
          contactId: ctxQ.data?.primaryContactId ?? null,
          locationId: ctxQ.data?.locationId ?? null,
        },
      });
      /*
       * Tie the request to the email that carried it, so a customer who just
       * hits Reply is recognised as answering THIS request and their answers
       * come back as suggested job fields (info-reply.server.ts). Best effort:
       * the subject still threads the reply when this write does not land.
       */
      if (intakeRequestId && res?.id) {
        const { error: linkError } = await supabase
          .from("intake_requests")
          .update({ email_message_id: res.id })
          .eq("id", intakeRequestId);
        if (linkError) console.warn("[email] could not link the info request:", linkError);
      }
      return res;
    },
    onSuccess: (res) => {
      announceEmailSend(res, { sent: "Email sent" });
      void qc.invalidateQueries({ queryKey: ["job-comms", jobId] });
      void qc.invalidateQueries({ queryKey: ["job-outbox", jobId] });
      void qc.invalidateQueries({ queryKey: ["intake-requests", jobId] });
      onOpenChange(false);
    },
    onError: (e) => toastDbError(e, { action: "Send email" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="size-4" /> Send email
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Template</Label>
              <Select value={templateId} onValueChange={applyTemplate}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a template" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No template</SelectItem>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">To</Label>
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="name@example.com"
              />
              {(ctxQ.data?.jobContacts ?? []).filter((c) => c.email).length ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {(ctxQ.data?.jobContacts ?? [])
                    .filter((c) => c.email)
                    .map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          setTo((prev) => (prev ? `${prev}, ${c.email}` : (c.email ?? "")))
                        }
                        className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted"
                      >
                        {c.name ?? c.email} · {c.role}
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
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
            <TokenEditor sample={mergeData} value={body} onChange={setBody} minHeight={200} />
          </div>

          {ctxQ.data?.locationId ? (
            <EmailAttachmentPicker
              jobId={jobId}
              locationId={ctxQ.data.locationId}
              picked={picked}
              onChange={setPicked}
            />
          ) : null}

          {(attachments ?? []).length || picked.length ? (
            <div className="rounded-md border p-2">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Paperclip className="size-3" /> Files going with this email
              </p>
              <ul className="space-y-0.5 text-xs">
                {(attachments ?? []).map((f) => (
                  <li key={f.url} className="truncate">
                    {f.label}
                  </li>
                ))}
                {picked.map((p) => (
                  <li key={p.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {p.name}
                      <span className="ml-1 text-[11px] text-muted-foreground">
                        ({p.source === "company" ? "company" : "job"})
                      </span>
                    </span>
                    <button
                      type="button"
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      onClick={() => setPicked((all) => all.filter((x) => x.id !== p.id))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Sent as secure download links, not as file attachments — the mail provider does not
                carry attachments yet.
              </p>
            </div>
          ) : null}

          {(links ?? []).length ? (
            <div className="rounded-md border p-2">
              <p className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <Link2 className="size-3" /> Links going with this email
              </p>
              <ul className="space-y-0.5 text-xs">
                {(links ?? []).map((l) => (
                  <li key={l.url} className="truncate">
                    {l.label}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {ctxQ.isError ? (
            <p className="text-xs text-destructive">
              The job details behind the merge keys could not be loaded, so nothing below is filled
              from the record. Close and reopen before sending.
            </p>
          ) : null}

          {purposeUnwritten ? (
            <p className="text-xs text-muted-foreground">
              No “{EMAIL_CATEGORY_LABEL[purpose!]}” template exists yet — every template is listed
              instead. An administrator adds one under Admin → Email templates.
            </p>
          ) : null}

          {needsIntakeLink ? (
            <p className="flex items-center gap-1.5 text-xs text-primary">
              <Link2 className="size-3.5" />A secure intake link is generated when you send. Answers
              come back for review before anything on the job changes.
            </p>
          ) : null}

          {noPaymentMethods ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              This job&apos;s billing office has no card link or Zelle address configured — the
              email goes out with cash/check only.
            </p>
          ) : null}
          {missing.length ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Unfilled keys: {missing.map((m) => `{${m}}`).join(", ")} — fill them in or edit them
              out.
            </p>
          ) : null}

          {invalid.length ? (
            <p className="text-xs text-destructive">Invalid addresses: {invalid.join(", ")}</p>
          ) : null}
          {configuredQ.data && configuredQ.data.checked && !configuredQ.data.configured ? (
            <p className="text-xs text-destructive" data-no-transport>
              {noTransportSentence(configuredQ.data.reason)}{" "}
              <Link to="/security" className="font-medium underline underline-offset-2">
                Open your Security page
              </Link>
            </p>
          ) : configuredQ.data?.configured && configuredQ.data.from ? (
            <p className="text-xs text-muted-foreground">
              Goes out from {configuredQ.data.from}
              {configuredQ.data.via === "outlook" ? " (your Outlook)" : ""}.
            </p>
          ) : null}

          {(outboxQ.data ?? []).length ? (
            <div className="rounded-md border p-2">
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">Recent / outbox</p>
              <ul className="space-y-1">
                {(outboxQ.data ?? []).map((m) => (
                  <li key={m.id} className="text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{m.subject}</span>
                      <Badge
                        variant={m.status === "sent" ? "secondary" : "outline"}
                        className="text-[10px]"
                      >
                        {m.status === "queued" || m.status === "failed" ? "not sent" : m.status}
                      </Badge>
                    </div>
                    <HeldEmailControls row={m} onChanged={() => void outboxQ.refetch()} />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={
              app.writesDisabled ||
              mutation.isPending ||
              recipients.length === 0 ||
              invalid.length > 0 ||
              !subject.trim()
            }
          >
            {mutation.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
