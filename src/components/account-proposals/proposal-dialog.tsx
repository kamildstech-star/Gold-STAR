import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Copy, Download, FileSignature, Send, Trash2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { announceEmailSend } from "@/components/email-send-toast";
import { ProposalForm, type TemplateOption } from "@/components/account-proposals/proposal-form";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import {
  PROPOSAL_STATUS_LABEL,
  PROPOSAL_STATUS_TONE,
  deleteProposalDraft,
  draftProblem,
  emptyDraft,
  fetchProposal,
  formatMoney,
  isEditable,
  mergeDataForAccount,
  parseLineDrafts,
  proposalStageMove,
  proposalTotals,
  renderProposalBody,
  saveProposalDraft,
  setProposalStatus,
  stageMoveClause,
  stageMoveSentence,
  type AccountProposal,
  type ProposalDraft,
  type ProposalLine,
  type ProposalStage,
} from "@/lib/account-proposals";
import { buildContractPdf, type ContractBrand } from "@/lib/contract-pdf";
import { toastDbError } from "@/lib/db-errors";
import { createSendPacket, signUrl } from "@/lib/document-send";
import {
  currentVersion,
  listTemplates,
  loadLocationBrand,
  logDocumentEvent,
  mergeDataForLocation,
  type DocumentTemplate,
  type LocationBrand,
} from "@/lib/document-templates";
import { DOCUMENT_TYPE_LABEL } from "@/lib/documents";
import { emailStatus, sendEmail } from "@/lib/email.functions";
import { textToEmailHtml } from "@/lib/safe-html";
import { cn } from "@/lib/utils";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
type AccountRow = {
  id: string;
  name: string;
  location_id: string;
  stage_id: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
};

type Mode = "edit" | "send" | "decline";

function toDraft(
  proposal: AccountProposal,
  lines: Array<ProposalLine & { id?: string }>,
): ProposalDraft {
  return {
    title: proposal.title,
    templateId: proposal.template_id ?? "",
    notes: proposal.notes ?? "",
    terms: proposal.terms ?? "",
    lines: lines.length
      ? lines.map((l, i) => ({
          key: l.id ?? `saved-${i}`,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unit_price),
        }))
      : emptyDraft().lines,
  };
}

async function brandForPdf(
  b: LocationBrand | null,
  address: string | null,
): Promise<ContractBrand> {
  let logo: Uint8Array | null = null;
  let logoMime: string | null = null;
  if (b?.logo_url) {
    try {
      const res = await fetch(b.logo_url);
      if (res.ok) {
        logo = new Uint8Array(await res.arrayBuffer());
        logoMime = res.headers.get("content-type");
      }
    } catch {
      // The PDF still renders without the logo.
    }
  }
  return {
    companyName: b?.legal_entity_name ?? b?.name ?? "",
    legalEntityName: b?.legal_entity_name ?? null,
    officeName: b?.name ?? null,
    address,
    phone: b?.office_phone ?? null,
    email: b?.office_email ?? null,
    ein: b?.ein ?? null,
    logo,
    logoMime,
  };
}

/**
 * One proposal on one account: write it, then send it for signature through
 * the Documents panel's own path, or download it and mark it sent.
 *
 * Opened from a pipeline card ("Create proposal") and from the account
 * record's Proposals list. A draft is edited here; anything after a draft is
 * shown read-only with the actions its status allows. What happens to the card
 * is the database's call (migration 20261012200000) — the line under the send
 * buttons previews it, and the toast afterwards repeats what it actually did.
 *
 * "Send for e-signature" is DocumentSendDialog's sequence for one document:
 * a `documents` row from the template, `createSendPacket`, the email through
 * `sendEmail`, and the secure link to copy. When this person's email is not
 * connected the link is still made — the toast says so, as it does there —
 * and "Download PDF" with "Mark as sent" is the way round it.
 */
export function AccountProposalDialog({
  open,
  onOpenChange,
  accountId,
  accountName,
  proposalId = null,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
  /** Null creates a new proposal. */
  proposalId?: string | null;
  onChanged?: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const send = useServerFn(sendEmail);
  const status = useServerFn(emailStatus);

  const [currentId, setCurrentId] = useState<string | null>(proposalId);
  const [proposal, setProposal] = useState<AccountProposal | null>(null);
  const [draft, setDraft] = useState<ProposalDraft>(() => emptyDraft());
  const [mode, setMode] = useState<Mode>("edit");
  const [busy, setBusy] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [to, setTo] = useState("");
  const [toName, setToName] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [declineReason, setDeclineReason] = useState("");

  useEffect(() => {
    if (!open) return;
    setCurrentId(proposalId);
    setProposal(null);
    setDraft(emptyDraft());
    setMode("edit");
    setLastLink(null);
    setDeclineReason("");
    setSubject("");
    setMessage("");
  }, [open, proposalId]);

  const accountQ = useQuery({
    queryKey: ["proposal-account", accountId, open],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id,name,location_id,stage_id,address_line1,city,state,postal_code")
        .eq("id", accountId)
        .maybeSingle();
      if (error) throw error;
      return data as AccountRow | null;
    },
  });
  const account = accountQ.data ?? null;
  const locationId = account?.location_id ?? null;

  const existingQ = useQuery({
    queryKey: ["account-proposal", proposalId, open],
    enabled: open && !!proposalId,
    queryFn: () => fetchProposal(proposalId!),
  });
  useEffect(() => {
    const got = existingQ.data;
    if (!got) return;
    setProposal(got.proposal);
    setDraft(toDraft(got.proposal, got.lines));
  }, [existingQ.data]);

  const templatesQ = useQuery({
    queryKey: ["document-templates", locationId, open],
    enabled: open && !!locationId,
    queryFn: () => listTemplates(locationId),
  });
  const templates: DocumentTemplate[] = templatesQ.data ?? [];
  const templateOptions: TemplateOption[] = templates.map((t) => ({
    id: t.id,
    label: `${t.name} · ${DOCUMENT_TYPE_LABEL[t.doc_type]} (v${t.current_version})`,
  }));

  const stagesQ = useQuery({
    queryKey: ["proposal-stages", account?.stage_id, open],
    enabled: open && !!account?.stage_id,
    queryFn: async (): Promise<ProposalStage[]> => {
      const { data: cur, error } = await supabase
        .from("pipeline_stages")
        .select("pipeline_id")
        .eq("id", account!.stage_id!)
        .maybeSingle();
      if (error) throw error;
      if (!cur) return [];
      const { data, error: listError } = await supabase
        .from("pipeline_stages")
        .select("id,pipeline_id,key,name,sort_order,is_won,is_lost,is_active")
        .eq("pipeline_id", cur.pipeline_id);
      if (listError) throw listError;
      return (data ?? []) as ProposalStage[];
    },
  });

  const contactQ = useQuery({
    queryKey: ["proposal-contact", accountId, open],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("id,full_name,email,phone,is_primary")
        .eq("account_id", accountId)
        .is("archived_at", null);
      if (error) throw error;
      const rows = data ?? [];
      return rows.find((c) => c.is_primary) ?? rows[0] ?? null;
    },
  });

  const brandQ = useQuery({
    queryKey: ["location-brand", locationId, open],
    enabled: open && !!locationId,
    queryFn: () => loadLocationBrand(locationId!),
  });

  const emailQ = useQuery({
    queryKey: ["email", "status"],
    enabled: open,
    queryFn: () => status({}),
  });
  const emailReady = emailQ.data?.configured === true;

  const contact = contactQ.data ?? null;
  const mergeBase = useMemo(
    () => ({
      ...(account
        ? mergeDataForAccount(
            account,
            contact,
            brandQ.data?.legal_entity_name ?? brandQ.data?.name ?? "Gold Star Restoration",
          )
        : {}),
      ...mergeDataForLocation(brandQ.data ?? null),
    }),
    [account, contact, brandQ.data],
  );

  const status_ = proposal?.status ?? "draft";
  const editable = isEditable(status_);
  const readOnly = !editable;
  const disabled = busy || app.writesDisabled;
  const { lines } = parseLineDrafts(draft.lines);
  const totals = proposalTotals(lines);
  const problem = draftProblem(draft);
  const stages = stagesQ.data ?? [];
  const sendMove = proposalStageMove(stages, account?.stage_id ?? null, "sent");
  const signMove = proposalStageMove(stages, account?.stage_id ?? null, "signed");

  const changed = () => {
    qc.invalidateQueries({ queryKey: ["account-proposals", accountId] });
    qc.invalidateQueries({ queryKey: ["account-proposal"] });
    qc.invalidateQueries({ queryKey: ["account-timeline", accountId] });
    qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
    qc.invalidateQueries({ queryKey: ["proposal-account", accountId] });
    onChanged?.();
  };

  /* -------------------------------------------------------------- writes */

  /** Saves the draft (when it is one) and returns its id. */
  const saveDraft = async (): Promise<string> => {
    if (!editable && currentId) return currentId;
    if (problem) throw new Error(problem);
    const version = draft.templateId ? await currentVersion(draft.templateId) : null;
    if (draft.templateId && !version)
      throw new Error("That template has no published version yet.");
    const id = await saveProposalDraft({
      id: currentId,
      accountId,
      title: draft.title,
      templateId: draft.templateId || null,
      templateVersionId: version?.id ?? null,
      notes: draft.notes,
      terms: draft.terms,
      lines,
      userId: app.userId,
    });
    setCurrentId(id);
    return id;
  };

  /** The wording that goes on the page, from the exact version it was written against. */
  const resolveBody = async (): Promise<{ body: string; template: DocumentTemplate | null }> => {
    const template = templates.find((t) => t.id === draft.templateId) ?? null;
    if (proposal?.document_id) {
      const { data } = await supabase
        .from("documents")
        .select("rendered_body")
        .eq("id", proposal.document_id)
        .maybeSingle();
      if (data?.rendered_body) return { body: data.rendered_body, template };
    }
    let templateBody: string | null = null;
    if (draft.templateId) {
      const versionId = !editable ? proposal?.template_version_id : null;
      if (versionId) {
        const { data } = await supabase
          .from("document_template_versions")
          .select("body")
          .eq("id", versionId)
          .maybeSingle();
        templateBody = data?.body ?? null;
      } else {
        templateBody = (await currentVersion(draft.templateId))?.body ?? null;
      }
    }
    return {
      body: renderProposalBody(
        templateBody,
        { title: draft.title, notes: draft.notes, terms: draft.terms },
        lines,
        mergeBase,
      ),
      template,
    };
  };

  /** The same insert "From template" makes, filed on the account's Documents. */
  const fileDocument = async (
    id: string,
    docStatus: "draft" | "sent",
  ): Promise<{ docId: string; body: string }> => {
    if (!locationId) throw new Error("The account has no office yet.");
    const { body, template } = await resolveBody();
    const version = draft.templateId ? await currentVersion(draft.templateId) : null;
    const { data, error } = await supabase
      .from("documents")
      .insert({
        location_id: locationId,
        job_id: null,
        account_id: accountId,
        doc_type: (template?.doc_type ?? "contract") as never,
        name: draft.title.trim(),
        status: docStatus,
        ...(docStatus === "sent" ? { sent_at: new Date().toISOString() } : {}),
        template_id: template?.id ?? null,
        template_version_id: version?.id ?? null,
        rendered_body: body,
        merge_data: mergeBase as never,
        created_by: app.userId,
      })
      .select("id")
      .single();
    if (error) throw error;
    await logDocumentEvent(data.id, "generated", {
      proposal_id: id,
      template_id: template?.id ?? null,
      version: version?.version ?? null,
    });
    return { docId: data.id, body };
  };

  const afterStatus = (p: AccountProposal, lead: string) => {
    setProposal(p);
    toast.success(lead, { description: p.stage_note ?? undefined });
    changed();
  };

  const fail = (e: unknown, action: string) => {
    if (e && typeof e === "object" && "code" in e) toastDbError(e, { action });
    else toast.error(e instanceof Error ? e.message : `Could not ${action.toLowerCase()}.`);
  };

  const onSave = async () => {
    setBusy(true);
    try {
      const got = await fetchProposal(await saveDraft());
      if (got) setProposal(got.proposal);
      toast.success("Draft saved");
      changed();
    } catch (e) {
      fail(e, "Save proposal");
    } finally {
      setBusy(false);
    }
  };

  const onDownload = async () => {
    setBusy(true);
    try {
      if (editable) await saveDraft();
      const { body } = await resolveBody();
      const address =
        [
          brandQ.data?.address,
          [brandQ.data?.locality, brandQ.data?.region, brandQ.data?.postal_code]
            .filter(Boolean)
            .join(", "),
        ]
          .filter(Boolean)
          .join(", ") || null;
      const bytes = await buildContractPdf({
        title: draft.title.trim() || "Proposal",
        body,
        meta: [
          ["Proposal", draft.title.trim()],
          [
            "Prepared for",
            contact?.full_name ? `${contact.full_name}, ${accountName}` : accountName,
          ],
          ["Total", formatMoney(totals.total)],
        ],
        brand: await brandForPdf(brandQ.data ?? null, address),
        footerNote: editable ? "DRAFT — not yet sent" : null,
      });
      const href = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }),
      );
      const link = document.createElement("a");
      link.href = href;
      link.download = `${(draft.title.trim() || "proposal").replace(/[^\w.-]+/g, "-")}.pdf`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 60_000);
      changed();
    } catch (e) {
      fail(e, "Download proposal");
    } finally {
      setBusy(false);
    }
  };

  /** No e-signature: the PDF went some other way and the rep says so. */
  const onMarkSent = async () => {
    setBusy(true);
    try {
      const id = await saveDraft();
      const { docId } = await fileDocument(id, "sent");
      await logDocumentEvent(docId, "sent", { proposal_id: id, by_hand: true });
      afterStatus(
        await setProposalStatus(id, "sent", { documentId: docId }),
        "Proposal marked sent",
      );
    } catch (e) {
      fail(e, "Mark proposal sent");
    } finally {
      setBusy(false);
    }
  };

  const openSend = () => {
    if (problem) {
      toast.error(problem);
      return;
    }
    if (!to && contact?.email) setTo(contact.email);
    if (!toName && contact?.full_name) setToName(contact.full_name);
    if (!subject) setSubject(`Proposal for your review — ${draft.title.trim()}`);
    if (!message) {
      setMessage(
        `Hello ${contact?.full_name ?? "there"},\n\n` +
          `Please review and sign our proposal, "${draft.title.trim()}". ` +
          `It takes about a minute and works on your phone.\n\n` +
          `If anything looks wrong, reply to this email before signing and we will correct it.\n\n` +
          `${mergeBase["location.legal_name"] ?? ""}\n` +
          `${mergeBase["location.phone"] ?? ""}`,
      );
    }
    setMode("send");
  };

  const onSendForSignature = async () => {
    if (!to.trim()) {
      toast.error("Add a recipient email.");
      return;
    }
    if (!locationId) return;
    setBusy(true);
    try {
      const id = await saveDraft();
      const { docId } = await fileDocument(id, "draft");
      const packet = await createSendPacket({
        locationId,
        jobId: null,
        accountId,
        documentIds: [docId],
        requireSignature: true,
        recipientEmail: to.trim(),
        recipientName: toName.trim() || null,
        subject,
        message,
        requiredFields: [],
        reminderDays: 3,
        expiresInDays: 30,
        userId: app.userId,
      });
      const link = signUrl(packet.token);
      setLastLink(link);
      // The link exists and works from here on, so the proposal is out.
      const sent = await setProposalStatus(id, "sent", { documentId: docId });
      setProposal(sent);
      setMode("edit");
      changed();

      const html = `${textToEmailHtml(message)}<p><a href="${link}">Review and sign the proposal</a></p>`;
      const result = await send({
        data: {
          to: [to.trim()],
          subject,
          bodyHtml: html,
          category: "work_authorization",
          accountId,
          locationId,
          logTouchpoint: false,
        },
      });
      announceEmailSend(result, {
        prefix: "Proposal ready. ",
        sent: `Sent for signature. ${sent.stage_note ?? ""}`.trim(),
        extra: "Or copy the secure link to send it yourself now.",
      });
    } catch (e) {
      fail(e, "Send proposal");
    } finally {
      setBusy(false);
    }
  };

  const onStatus = async (next: "signed" | "declined" | "expired") => {
    if (!currentId) return;
    setBusy(true);
    try {
      const p = await setProposalStatus(currentId, next, { declinedReason: declineReason });
      setMode("edit");
      afterStatus(p, `Proposal marked ${PROPOSAL_STATUS_LABEL[next].toLowerCase()}`);
    } catch (e) {
      fail(e, `Mark proposal ${next}`);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!currentId) return;
    setBusy(true);
    try {
      await deleteProposalDraft(currentId);
      toast.success("Draft deleted");
      changed();
      onOpenChange(false);
    } catch (e) {
      fail(e, "Delete proposal");
    } finally {
      setBusy(false);
    }
  };

  /* ---------------------------------------------------------------- view */

  const loading = accountQ.isLoading || (!!proposalId && existingQ.isLoading);
  const title = currentId ? (editable ? "Edit proposal" : "Proposal") : "Create proposal";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {title}
            {proposal && (
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[11px] font-semibold",
                  PROPOSAL_STATUS_TONE[status_],
                )}
              >
                {PROPOSAL_STATUS_LABEL[status_]}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {accountName}
            {proposal?.stage_note ? ` · ${proposal.stage_note}` : ""}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : mode === "send" ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              The customer gets one secure link to read and sign the proposal — the same signing
              page as every other document. {stageMoveSentence(sendMove, "Sending")}
            </p>
            {!emailReady && emailQ.data && (
              <p className="rounded-sm bg-warning/15 px-2 py-1 text-xs">
                Email is not connected for you, so this will make the link but not email it. Copy
                the link afterwards, or go back and use Download PDF and Mark as sent.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="proposal-to-name" className="text-xs">
                  Recipient name
                </Label>
                <Input
                  id="proposal-to-name"
                  value={toName}
                  onChange={(e) => setToName(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="proposal-to" className="text-xs">
                  Recipient email
                </Label>
                <Input
                  id="proposal-to"
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="proposal-subject" className="text-xs">
                Subject
              </Label>
              <Input
                id="proposal-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="proposal-message" className="text-xs">
                Message
              </Label>
              <Textarea
                id="proposal-message"
                rows={7}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <ProposalForm
              draft={draft}
              onDraft={setDraft}
              templates={templateOptions}
              readOnly={readOnly}
              disabled={disabled}
            />
            {editable && (
              <p className="text-xs text-muted-foreground" data-testid="proposal-stage-preview">
                {stageMoveSentence(sendMove, "Sending")}
              </p>
            )}
            {status_ === "sent" && (
              <p className="text-xs text-muted-foreground">
                Sent
                {proposal?.sent_at
                  ? ` ${new Date(proposal.sent_at).toLocaleDateString(DATE_LOCALE, US_DATE)}`
                  : ""}
                . Signing it — by the customer on the link, or Mark signed here —{" "}
                {stageMoveClause(signMove)}.
              </p>
            )}
            {status_ === "declined" && proposal?.declined_reason && (
              <p className="text-xs text-muted-foreground">Reason: {proposal.declined_reason}</p>
            )}
            {mode === "decline" && (
              <div>
                <Label htmlFor="proposal-decline" className="text-xs">
                  Why did they decline? (optional)
                </Label>
                <Input
                  id="proposal-decline"
                  value={declineReason}
                  onChange={(e) => setDeclineReason(e.target.value)}
                />
              </div>
            )}
            {editable && !emailReady && emailQ.data && (
              <p className="rounded-sm bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                Email is not connected for you. Send for e-signature still makes a signing link to
                copy — or use Download PDF, send it yourself, and press Mark as sent.
              </p>
            )}
            {lastLink && (
              <div className="flex items-center gap-2 rounded-sm border bg-muted/40 p-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{lastLink}</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    void navigator.clipboard.writeText(lastLink);
                    toast.success("Link copied");
                  }}
                >
                  <Copy className="mr-1.5 size-3.5" />
                  Copy
                </Button>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            {editable && currentId && mode === "edit" && (
              <Button variant="ghost" onClick={onDelete} disabled={disabled}>
                <Trash2 className="mr-1.5 size-4" />
                Delete draft
              </Button>
            )}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {mode === "send" ? (
              <>
                <Button variant="outline" onClick={() => setMode("edit")} disabled={busy}>
                  Back
                </Button>
                <Button onClick={onSendForSignature} disabled={disabled || !to.trim()}>
                  <Send className="mr-1.5 size-4" />
                  {busy ? "Sending…" : "Send"}
                </Button>
              </>
            ) : mode === "decline" ? (
              <>
                <Button variant="outline" onClick={() => setMode("edit")} disabled={busy}>
                  Back
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => onStatus("declined")}
                  disabled={disabled}
                >
                  Mark declined
                </Button>
              </>
            ) : editable ? (
              <>
                <Button variant="outline" onClick={onDownload} disabled={disabled || !!problem}>
                  <Download className="mr-1.5 size-4" />
                  Download PDF
                </Button>
                <Button
                  variant={emailReady ? "ghost" : "outline"}
                  onClick={onMarkSent}
                  disabled={disabled || !!problem}
                >
                  Mark as sent
                </Button>
                <Button variant="outline" onClick={onSave} disabled={disabled || !!problem}>
                  Save draft
                </Button>
                <Button onClick={openSend} disabled={disabled || !!problem}>
                  <FileSignature className="mr-1.5 size-4" />
                  Send for e-signature
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={onDownload} disabled={busy}>
                  <Download className="mr-1.5 size-4" />
                  Download PDF
                </Button>
                {status_ === "sent" && (
                  <>
                    <Button variant="ghost" onClick={() => onStatus("expired")} disabled={disabled}>
                      Mark expired
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setMode("decline")}
                      disabled={disabled}
                    >
                      Mark declined
                    </Button>
                    <Button onClick={() => onStatus("signed")} disabled={disabled}>
                      Mark signed
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
