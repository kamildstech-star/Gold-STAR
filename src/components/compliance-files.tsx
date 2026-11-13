import { SafeFilePreview } from "@/components/safe-file-preview";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Upload, Send, History, Trash2, ExternalLink, Loader2 } from "lucide-react";

import { useServerFn } from "@tanstack/react-start";

import { useAppContext } from "@/components/app-context";
import { extractCredentialDocument } from "@/lib/ai.functions";
import { toastDbError } from "@/lib/db-errors";
import { supabase } from "@/integrations/supabase/client";
import { sendEmail } from "@/lib/email.functions";
import { announceEmailSend } from "@/components/email-send-toast";
import { logCertificateSend } from "@/lib/compliance";
import {
  fetchAgentEmail,
  fetchRequirementFiles,
  fetchCertificatesEmail,
  markCertificateSent,
  markSentToAgent,
  saveCertificatesEmail,
  removeRequirementFile,
  saveAgentEmail,
  signedComplianceUrl,
  uploadRequirementFile,
  type ComplianceFile,
  type ComplianceSlot,
} from "@/lib/compliance-files";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * The two slots on a requirement. They are deliberately not one list: the
 * sample tells our agent what to issue, the certificate is what we can show a
 * client. Mixing them is how a specimen COI ends up filed as proof of cover.
 */
export function RequirementFiles({
  requirementId,
  accountId,
  accountName,
  requirementLabel,
  requiredSummary,
}: {
  requirementId: string;
  accountId: string;
  accountName: string;
  requirementLabel: string;
  requiredSummary: string;
}) {
  const app = useAppContext();
  const disabled = app.writesDisabled;
  const [files, setFiles] = useState<ComplianceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<ComplianceFile | null>(null);
  const [sending, setSending] = useState<ComplianceFile | null>(null);
  const [sendingCert, setSendingCert] = useState<ComplianceFile | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await fetchRequirementFiles(requirementId));
    } catch (e) {
      toastDbError(e, { action: "Load requirement files" });
    }
    setLoading(false);
  }, [requirementId]);

  useEffect(() => {
    void load();
  }, [load]);

  const samples = files.filter((f) => f.slot === "sample");
  const certs = files.filter((f) => f.slot === "certificate");
  const currentCert = certs.find((c) => c.is_current) ?? null;
  const superseded = certs.filter((c) => !c.is_current);

  return (
    <div className="space-y-3">
      <Slot
        title="Sample / requirement document"
        hint="What the client sent us — forwarded to our agent so the certificate comes back right."
        slot="sample"
        multiple
        requirementId={requirementId}
        accountId={accountId}
        disabled={disabled}
        onUploaded={load}
      >
        {loading && <Loading />}
        {!loading && samples.length === 0 && <Empty>No sample on file.</Empty>}
        {samples.map((f) => (
          <FileRow
            key={f.id}
            file={f}
            onOpen={() => setViewing(f)}
            onDelete={disabled ? undefined : () => void del(f, load)}
            trailing={
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                disabled={disabled}
                onClick={() => setSending(f)}
              >
                <Send className="mr-1 size-3" />
                {f.sent_to_agent_at ? "Resend" : "Send to agent"}
              </Button>
            }
          />
        ))}
      </Slot>

      <Slot
        title="Current certificate"
        hint="The document that actually satisfies this requirement. A new upload supersedes the old one."
        slot="certificate"
        requirementId={requirementId}
        accountId={accountId}
        disabled={disabled}
        withMeta
        onUploaded={load}
      >
        {loading && <Loading />}
        {!loading && !currentCert && <Empty>No certificate held.</Empty>}
        {currentCert && (
          <FileRow
            file={currentCert}
            onOpen={() => setViewing(currentCert)}
            onDelete={disabled ? undefined : () => void del(currentCert, load)}
            trailing={
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[11px]"
                disabled={disabled}
                onClick={() => setSendingCert(currentCert)}
              >
                <Send className="mr-1 size-3" />
                {currentCert.cert_sent_at ? "Resend COI" : "Send COI"}
              </Button>
            }
          />
        )}
        {superseded.length > 0 && (
          <button
            type="button"
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowHistory((v) => !v)}
          >
            <History className="size-3" /> {superseded.length} superseded version
            {superseded.length === 1 ? "" : "s"}
          </button>
        )}
        {showHistory &&
          superseded.map((f) => <FileRow key={f.id} file={f} muted onOpen={() => setViewing(f)} />)}
      </Slot>

      {viewing && <FileViewer file={viewing} onClose={() => setViewing(null)} />}
      {sendingCert && (
        <SendCertificateDialog
          file={sendingCert}
          accountId={accountId}
          accountName={accountName}
          requirementLabel={requirementLabel}
          onClose={() => setSendingCert(null)}
          onSent={() => {
            setSendingCert(null);
            void load();
          }}
        />
      )}
      {sending && (
        <SendToAgentDialog
          file={sending}
          accountId={accountId}
          accountName={accountName}
          requirementLabel={requirementLabel}
          requiredSummary={requiredSummary}
          onClose={() => setSending(null)}
          onSent={() => {
            setSending(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

async function del(file: ComplianceFile, reload: () => Promise<void>) {
  try {
    await removeRequirementFile(file);
    toast.success("File removed");
    await reload();
  } catch (e) {
    toastDbError(e, { action: "Remove file" });
  }
}

function Loading() {
  return <p className="text-[11px] text-muted-foreground">Loading…</p>;
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-muted-foreground">{children}</p>;
}

/** Upload surface for one slot. */
function Slot({
  title,
  hint,
  slot,
  requirementId,
  accountId,
  disabled,
  multiple,
  withMeta,
  onUploaded,
  children,
}: {
  title: string;
  hint: string;
  slot: ComplianceSlot;
  requirementId: string;
  accountId: string;
  disabled: boolean;
  multiple?: boolean;
  withMeta?: boolean;
  onUploaded: () => Promise<void>;
  children: React.ReactNode;
}) {
  const app = useAppContext();
  const inputRef = useRef<HTMLInputElement>(null);
  const extract = useServerFn(extractCredentialDocument);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<File | null>(null);
  const [reading, setReading] = useState(false);
  const [prefill, setPrefill] = useState<CertificateDraft | null>(null);

  /**
   * A COI states its own expiry — reading it is the difference between a date
   * that is right and a date somebody guessed. Advisory: the user confirms.
   */
  const readCertificate = async (file: File) => {
    setPending(file);
    setPrefill(null);
    if (file.size > 15_000_000) return;
    setReading(true);
    try {
      const base64 = await toBase64(file);
      const r = await extract({
        data: {
          file_base64: base64,
          mime: file.type || "application/pdf",
          file_name: file.name,
          kinds: ["certificate_of_insurance", "general_liability"],
        },
      });
      const c = r.coverages[0];
      setPrefill({
        issuer: r.carrier ?? r.issuer ?? "",
        policy: c?.policy_number ?? r.policy_number ?? "",
        effective: c?.effective_date ?? r.effective_date ?? "",
        expiry: c?.expiry_date ?? r.expiry_date ?? "",
        amount:
          c?.limit_occurrence != null
            ? String(c.limit_occurrence)
            : r.limit_occurrence != null
              ? String(r.limit_occurrence)
              : "",
        confidence: r.confidence,
      });
    } catch {
      toast.message("Could not read that certificate — enter the details by hand.");
    }
    setReading(false);
  };

  const doUpload = async (
    file: File,
    meta?: Parameters<typeof uploadRequirementFile>[0]["meta"],
  ) => {
    setBusy(true);
    try {
      await uploadRequirementFile({
        requirementId,
        accountId,
        slot,
        file,
        userId: app.userId,
        meta,
      });
      toast.success("Uploaded");
      await onUploaded();
    } catch (e) {
      toastDbError(e, { action: "Upload file" });
    }
    setBusy(false);
  };

  return (
    <div className="rounded-[6px] border bg-card px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-medium uppercase text-muted-foreground">{title}</div>
          <p className="text-[11px] text-muted-foreground">{hint}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 px-1.5 text-[11px]"
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <Loader2 className="mr-1 size-3 animate-spin" />
          ) : (
            <Upload className="mr-1 size-3" />
          )}
          Upload
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple={multiple}
          accept="application/pdf,image/*"
          className="hidden"
          onChange={async (e) => {
            const list = [...(e.target.files ?? [])];
            e.target.value = "";
            if (!list.length) return;
            if (withMeta) void readCertificate(list[0]!);
            else for (const f of list) await doUpload(f);
          }}
        />
      </div>
      <div className="mt-1.5 space-y-1">{children}</div>
      {pending && (
        <CertificateMetaDialog
          fileName={pending.name}
          reading={reading}
          prefill={prefill}
          onCancel={() => setPending(null)}
          onConfirm={async (meta) => {
            const f = pending;
            setPending(null);
            await doUpload(f, meta);
          }}
        />
      )}
    </div>
  );
}

function FileRow({
  file,
  onOpen,
  onDelete,
  trailing,
  muted,
}: {
  file: ComplianceFile;
  onOpen: () => void;
  onDelete?: () => void;
  trailing?: React.ReactNode;
  muted?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-[4px] border px-1.5 py-1 ${muted ? "opacity-70" : ""}`}
    >
      <Thumbnail file={file} onClick={onOpen} />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onOpen}>
        <div className="truncate text-[12px]">{file.file_name}</div>
        <div className="truncate text-[10px] text-muted-foreground">
          {file.slot === "certificate" && `v${file.version} · `}
          {file.policy_number ? `${file.policy_number} · ` : ""}
          {file.expiry_date ? `expires ${file.expiry_date} · ` : ""}
          {file.cert_sent_at
            ? `COI sent ${new Date(file.cert_sent_at).toLocaleDateString(DATE_LOCALE, US_DATE)} · `
            : ""}
          {new Date(file.created_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
        </div>
      </button>
      {file.sent_to_agent_at && (
        <Badge variant="outline" className="h-4 rounded-[3px] px-1 text-[9px]">
          Sent
        </Badge>
      )}
      {trailing}
      {onDelete && (
        <Button variant="ghost" size="sm" className="h-6 px-1" onClick={onDelete}>
          <Trash2 className="size-3" />
        </Button>
      )}
    </div>
  );
}

/** Signed URLs expire, so thumbnails are fetched per render of the row. */
function Thumbnail({ file, onClick }: { file: ComplianceFile; onClick: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const isImage = (file.mime_type ?? "").startsWith("image/");

  useEffect(() => {
    let live = true;
    if (!isImage) return;
    void signedComplianceUrl(file.storage_path).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [file.storage_path, isImage]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[4px] border bg-muted"
    >
      {isImage && url ? (
        <img src={url} alt={file.file_name} className="size-full object-cover" />
      ) : (
        <FileText className="size-4 text-muted-foreground" />
      )}
    </button>
  );
}

function FileViewer({ file, onClose }: { file: ComplianceFile; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    // The default ten minutes: the viewer shows it at once (was fifteen).
    void signedComplianceUrl(file.storage_path).then(setUrl);
  }, [file.storage_path]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-[14px]">{file.file_name}</DialogTitle>
        </DialogHeader>
        <div className="h-[65vh] overflow-hidden rounded-[6px] border bg-muted">
          {!url && <p className="p-3 text-[12px] text-muted-foreground">Preparing preview…</p>}
          {url && <SafeFilePreview url={url} mime={file.mime_type} name={file.file_name} />}
        </div>
        {url && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] underline"
          >
            <ExternalLink className="size-3" /> Open in a new tab
          </a>
        )}
      </DialogContent>
    </Dialog>
  );
}

export type CertificateDraft = {
  issuer: string;
  policy: string;
  effective: string;
  expiry: string;
  amount: string;
  confidence: "high" | "medium" | "low";
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read that file"));
    r.readAsDataURL(file);
  });
}

function CertificateMetaDialog({
  fileName,
  reading,
  prefill,
  onCancel,
  onConfirm,
}: {
  fileName: string;
  reading?: boolean;
  prefill?: CertificateDraft | null;
  onCancel: () => void;
  onConfirm: (meta: {
    issuer: string | null;
    policyNumber: string | null;
    effectiveDate: string | null;
    expiryDate: string | null;
    coveredAmount: number | null;
  }) => void;
}) {
  const [issuer, setIssuer] = useState("");
  const [policy, setPolicy] = useState("");
  const [effective, setEffective] = useState("");
  const [expiry, setExpiry] = useState("");
  const [amount, setAmount] = useState("");

  useEffect(() => {
    if (!prefill) return;
    setIssuer(prefill.issuer);
    setPolicy(prefill.policy);
    setEffective(prefill.effective);
    setExpiry(prefill.expiry);
    setAmount(prefill.amount);
  }, [prefill]);

  return (
    <Dialog open onOpenChange={onCancel}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Certificate details</DialogTitle>
        </DialogHeader>
        <p className="text-[11px] text-muted-foreground">{fileName}</p>
        {reading && (
          <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Reading the certificate…
          </p>
        )}
        {!reading && prefill && (
          <p className="text-[11px] text-amber-800 dark:text-amber-300">
            Read from the document ({prefill.confidence} confidence) — check the expiry before
            saving.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Issuer">
            <Input
              className="h-7 text-[12px]"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
            />
          </Field>
          <Field label="Policy number">
            <Input
              className="h-7 text-[12px]"
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
            />
          </Field>
          <Field label="Effective">
            <Input
              type="date"
              className="h-7 text-[12px]"
              value={effective}
              onChange={(e) => setEffective(e.target.value)}
            />
          </Field>
          <Field label="Expires">
            <Input
              type="date"
              className="h-7 text-[12px]"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </Field>
          <Field label="Covered limit">
            <NumberInput
              className="h-7 text-[12px]"
              decimals={0}
              placeholder="2,000,000"
              value={amount}
              onValueChange={(_, clean) => setAmount(clean)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onConfirm({
                issuer: issuer || null,
                policyNumber: policy || null,
                effectiveDate: effective || null,
                expiryDate: expiry || null,
                coveredAmount: amount ? Number(amount) : null,
              })
            }
          >
            Save certificate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] uppercase text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/** Forwards the sample to our insurance agent and records it on the timeline. */
function SendToAgentDialog({
  file,
  accountId,
  accountName,
  requirementLabel,
  requiredSummary,
  onClose,
  onSent,
}: {
  file: ComplianceFile;
  accountId: string;
  accountName: string;
  requirementLabel: string;
  requiredSummary: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const app = useAppContext();
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchAgentEmail().then((e) => e && setTo(e));
  }, []);

  const send = async () => {
    if (!to.trim()) return;
    setBusy(true);
    try {
      const url = await signedComplianceUrl(file.storage_path, {
        seconds: 60 * 60 * 24 * 7,
        why: "The agent needs the actual paper, so the link must outlive the email being read — a week is the shortest that survives a weekend.",
      });
      const html = `
        <p>Please issue a certificate for the requirement below.</p>
        <table cellpadding="4">
          <tr><td><b>Client</b></td><td>${escapeHtml(accountName)}</td></tr>
          <tr><td><b>Requirement</b></td><td>${escapeHtml(requirementLabel)}</td></tr>
          <tr><td><b>Client requires</b></td><td>${escapeHtml(requiredSummary)}</td></tr>
          <tr><td><b>Document</b></td><td>${escapeHtml(file.file_name)}</td></tr>
        </table>
        ${note ? `<p>${escapeHtml(note)}</p>` : ""}
        ${url ? `<p><a href="${url}">Download the client's requirement document</a></p>` : ""}
      `;
      const sent = await sendEmail({
        data: {
          to: [to.trim()],
          subject: `Certificate request — ${accountName} · ${requirementLabel}`,
          bodyHtml: html,
          category: "notification",
          accountId,
          attachmentUrl: url,
          logTouchpoint: false,
        },
      });
      await markSentToAgent([file.id], app.userId);
      await supabase.from("account_notes").insert({
        account_id: accountId,
        body: `Sent "${file.file_name}" to the insurance agent (${to.trim()}) for ${requirementLabel}.`,
        created_by: app.userId,
      });
      if (app.userId) await saveAgentEmail(to.trim(), app.userId).catch(() => undefined);
      announceEmailSend(sent, { prefix: "To the agent: ", sent: "Sent to agent" });
      onSent();
    } catch (e) {
      toastDbError(e, { action: "Send to agent" });
    }
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Send to insurance agent</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Field label="Agent email">
            <Input
              className="h-7 text-[12px]"
              value={to}
              placeholder="agent@brokerage.com"
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <Field label="Note (optional)">
            <Input
              className="h-7 text-[12px]"
              value={note}
              placeholder="Needed before Monday's job"
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
          <p className="text-[11px] text-muted-foreground">
            {accountName} · {requirementLabel} · {requiredSummary}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={send} disabled={busy || !to.trim()}>
            {busy && <Loader2 className="mr-1 size-3 animate-spin" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function escapeHtml(s: string) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

/**
 * Emails the current certificate to the company's "send certificates to"
 * address and records sent-by/when. If no mail provider is connected yet the
 * message sits queued rather than failing.
 */
function SendCertificateDialog({
  file,
  accountId,
  accountName,
  requirementLabel,
  onClose,
  onSent,
}: {
  file: ComplianceFile;
  accountId: string;
  accountName: string;
  requirementLabel: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const app = useAppContext();
  const [to, setTo] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchCertificatesEmail(accountId).then((e) => e && setTo(e));
  }, [accountId]);

  const send = async () => {
    if (!to.trim()) return;
    setBusy(true);
    const subject = `Certificate of insurance — Gold Star Restoration · ${requirementLabel}`;
    try {
      const url = await signedComplianceUrl(file.storage_path, {
        seconds: 60 * 60 * 24 * 7,
        why: "The certificate goes out by email to a third party, who opens it when they get to it; a week survives a weekend.",
      });
      const html = `
        <p>Please find our current certificate of insurance attached below.</p>
        <table cellpadding="4">
          <tr><td><b>Vendor</b></td><td>Gold Star Restoration</td></tr>
          <tr><td><b>Requirement</b></td><td>${escapeHtml(requirementLabel)}</td></tr>
          ${file.policy_number ? `<tr><td><b>Policy</b></td><td>${escapeHtml(file.policy_number)}</td></tr>` : ""}
          ${file.expiry_date ? `<tr><td><b>Expires</b></td><td>${escapeHtml(file.expiry_date)}</td></tr>` : ""}
        </table>
        ${url ? `<p><a href="${url}">Download the certificate</a></p>` : ""}
      `;
      const res = await sendEmail({
        data: {
          to: [to.trim()],
          subject,
          bodyHtml: html,
          category: "notification",
          accountId,
          attachmentUrl: url,
          logTouchpoint: false,
        },
      });
      // Held in the undo window is not sent yet either: the log says queued
      // until it actually goes.
      const queued = Boolean(
        (res as { queued?: boolean }).queued || (res as { held?: boolean }).held,
      );
      await markCertificateSent(file.id, to.trim(), app.userId);
      // The send log is the record a client asks for months later: what went
      // out, to whom, by whom, when.
      await logCertificateSend({
        accountId,
        requirementId: file.requirement_id,
        fileId: file.id,
        requirementLabel,
        fileName: file.file_name,
        toEmail: to.trim(),
        subject,
        status: queued ? "queued" : "sent",
        sentBy: app.userId,
      }).catch(() => undefined);
      if (remember) await saveCertificatesEmail(accountId, to.trim()).catch(() => undefined);
      await supabase.from("account_notes").insert({
        account_id: accountId,
        body: `Sent the current ${requirementLabel} certificate to ${to.trim()}.`,
        created_by: app.userId,
      });
      announceEmailSend(res, { sent: `Certificate sent to ${to.trim()}` });
      onSent();
    } catch (e) {
      toastDbError(e, { action: "Send certificate" });
    }
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-[14px]">Send certificate</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Field label="Send certificates to">
            <Input
              className="h-7 text-[12px]"
              value={to}
              placeholder="compliance@client.com"
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Save as this company's certificates address
          </label>
          <p className="text-[11px] text-muted-foreground">
            {accountName} · {requirementLabel}
            {file.expiry_date ? ` · expires ${file.expiry_date}` : ""}
          </p>
          {file.cert_sent_at && (
            <p className="text-[11px] text-muted-foreground">
              Last sent {new Date(file.cert_sent_at).toLocaleString("en-US")}
              {file.cert_sent_to ? ` to ${file.cert_sent_to}` : ""}.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={send} disabled={busy || !to.trim()}>
            {busy && <Loader2 className="mr-1 size-3 animate-spin" />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
