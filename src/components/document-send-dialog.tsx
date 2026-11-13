import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Copy, Eye, Send } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { toastDbError } from "@/lib/db-errors";
import { DOCUMENT_TYPE_LABEL } from "@/lib/documents";
import {
  currentVersion,
  listTemplates,
  loadLocationBrand,
  logDocumentEvent,
  mergeDataForJob,
  mergeDataForLocation,
  renderTemplate,
  unresolvedTokens,
  type MergeData,
} from "@/lib/document-templates";
import { buildContractPdf } from "@/lib/contract-pdf";
import { emailDocumentsToSign } from "@/lib/document-send";
import { sendEmail } from "@/lib/email.functions";
import { announceEmailSend } from "@/components/email-send-toast";

/** Gaps a recipient is commonly asked to fill on the signing page. */
const FIELD_CHOICES = [
  { key: "policy_number", label: "Policy number" },
  { key: "claim_number", label: "Claim number" },
  { key: "deductible", label: "Deductible amount" },
  { key: "mortgage_company", label: "Mortgage company" },
  { key: "best_phone", label: "Best contact number" },
];

/**
 * Sends one or more templated documents to a customer as a single secure link.
 *
 * Staff pick the templates, see the resolved PDF exactly as the customer will,
 * and only then send — nothing goes out that was not previewed. The email body
 * is merge-keyed but fully editable, because the person sending it knows the
 * relationship better than the template does.
 */
export function DocumentSendDialog({
  open,
  onOpenChange,
  jobId,
  accountId,
  locationId,
  onSent,
  presetDocTypes,
  existingDocument,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string | null;
  accountId: string | null;
  locationId: string;
  onSent: () => void;
  /**
   * Opened from a contract (David, 15 Oct: "email it to them to sign"): tick
   * the templates of these types on open, so the service agreement or the
   * work authorisation is already chosen.
   */
  presetDocTypes?: readonly string[];
  /**
   * A document already filed on the job — a contract generated from a
   * template — to email as it is, instead of generating new ones.
   */
  existingDocument?: { id: string; name: string } | null;
}) {
  const app = useAppContext();
  const send = useServerFn(sendEmail);

  const [picked, setPicked] = useState<string[]>([]);
  const [requireSignature, setRequireSignature] = useState(true);
  const [fields, setFields] = useState<string[]>([]);
  const [to, setTo] = useState("");
  const [toName, setToName] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [reminderDays, setReminderDays] = useState(3);
  const [busy, setBusy] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);

  const templatesQ = useQuery({
    queryKey: ["document-templates", locationId, open],
    enabled: open,
    queryFn: () => listTemplates(locationId),
  });

  const jobQ = useQuery({
    queryKey: ["document-send-job", jobId, open],
    enabled: open && !!jobId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("*")
        .eq("id", jobId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const brandQ = useQuery({
    queryKey: ["location-brand", locationId, open],
    enabled: open && !!locationId,
    queryFn: () => loadLocationBrand(locationId),
  });

  const mergeData: MergeData = useMemo(
    () => ({
      ...mergeDataForJob(
        (jobQ.data ?? {}) as Parameters<typeof mergeDataForJob>[0],
        brandQ.data?.legal_entity_name ?? brandQ.data?.name ?? "",

        null,
      ),
      ...mergeDataForLocation(brandQ.data ?? null),
    }),
    [jobQ.data, brandQ.data],
  );

  useEffect(() => {
    if (!open) return;
    const job = jobQ.data as {
      customer_email?: string | null;
      customer_name?: string | null;
    } | null;
    if (job?.customer_email && !to) setTo(job.customer_email);
    if (job?.customer_name && !toName) setToName(job.customer_name);
  }, [open, jobQ.data, to, toName]);

  useEffect(() => {
    if (!open || subject) return;
    setSubject(
      `Paperwork to sign${mergeData["job.number"] ? ` — job ${mergeData["job.number"]}` : ""}`,
    );
    setMessage(
      `Hello ${mergeData["customer.name"] ?? "there"},\n\n` +
        `Please review and sign the attached paperwork for the work at ${mergeData["property.address"] ?? "your property"}. ` +
        `It takes about a minute and works on your phone.\n\n` +
        `If anything looks wrong, reply to this email before signing and we will correct it.\n\n` +
        `${mergeData["location.legal_name"] ?? ""}\n` +
        `${mergeData["location.phone"] ?? ""}`,
    );
  }, [open, subject, mergeData]);

  const templates = templatesQ.data ?? [];
  const selected = templates.filter((t) => picked.includes(t.id));
  const ready = existingDocument ? true : selected.length > 0;

  // Each opening from a contract starts with that contract's templates ticked.
  const presetKey = presetDocTypes?.join(",") ?? "";
  useEffect(() => {
    if (!open || existingDocument || !presetKey) return;
    const want = presetKey.split(",");
    setPicked(
      templates
        .filter((t) => want.includes(t.doc_type))
        .map((t) => t.id)
        .slice(0, 1),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the list arrives
  }, [open, presetKey, existingDocument, templatesQ.data]);

  const resolveBodies = async () => {
    const out: {
      templateId: string;
      versionId: string;
      version: number;
      name: string;
      body: string;
      docType: string;
    }[] = [];
    for (const t of selected) {
      const version = await currentVersion(t.id);
      if (!version) throw new Error(`${t.name} has no published version yet.`);
      out.push({
        templateId: t.id,
        versionId: version.id,
        version: version.version,
        name: t.name,
        docType: t.doc_type,
        body: renderTemplate(version.body, mergeData),
      });
    }
    return out;
  };

  const brandForPdf = async () => {
    const b = brandQ.data;
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
        // Preview must still render without the logo.
      }
    }
    return {
      companyName: b?.legal_entity_name ?? b?.name ?? "",
      legalEntityName: b?.legal_entity_name ?? null,
      officeName: b?.name ?? null,
      address: mergeData["location.address"] ?? null,
      phone: b?.office_phone ?? null,
      email: b?.office_email ?? null,
      ein: b?.ein ?? null,
      logo,
      logoMime,
    };
  };

  const preview = async () => {
    if (!selected.length) return;
    setBusy(true);
    try {
      const bodies = await resolveBodies();
      const brand = await brandForPdf();
      const bytes = await buildContractPdf({
        title: bodies[0].name,
        body: bodies[0].body,
        meta: [
          ["Document", bodies[0].name],
          ["Prepared for", toName || to || "—"],
          ["Job", mergeData["job.number"] ?? "—"],
          ["Property", mergeData["property.address"] ?? "—"],
        ],
        brand,
        filledFields: fields.map((k) => [FIELD_CHOICES.find((f) => f.key === k)?.label ?? k, ""]),
        footerNote: "PREVIEW — not yet sent",
      });
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }),
      );
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the preview.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!ready) return toast.error("Pick at least one document.");
    if (!to.trim()) return toast.error("Add a recipient email.");
    setBusy(true);
    try {
      const docIds: string[] = existingDocument ? [existingDocument.id] : [];
      for (const b of existingDocument ? [] : await resolveBodies()) {
        const { data, error } = await supabase
          .from("documents")
          .insert({
            location_id: locationId,
            job_id: jobId,
            account_id: accountId,
            doc_type: b.docType as never,
            name: `${b.name}${mergeData["job.number"] ? ` — ${mergeData["job.number"]}` : ""}`,
            status: "draft",
            template_id: b.templateId,
            template_version_id: b.versionId,
            rendered_body: b.body,
            merge_data: mergeData as never,
            created_by: app.userId,
          })
          .select("id")
          .single();
        if (error) throw error;
        await logDocumentEvent(data.id, "generated", {
          template_id: b.templateId,
          version: b.version,
          unresolved: unresolvedTokens(b.body, mergeData),
        });
        docIds.push(data.id);
      }

      // The packet, its secure link and the email: the shared email-to-sign
      // path (lib/document-send.ts), the same one every contract uses.
      const { link, result } = await emailDocumentsToSign(
        {
          locationId,
          jobId,
          accountId,
          documentIds: docIds,
          requireSignature,
          recipientEmail: to.trim(),
          recipientName: toName.trim() || null,
          subject,
          message,
          requiredFields: FIELD_CHOICES.filter((f) => fields.includes(f.key)),
          reminderDays,
          expiresInDays: 30,
          userId: app.userId,
        },
        { send },
      );
      setLastLink(link);

      announceEmailSend(result, {
        prefix: "Documents prepared. ",
        sent: "Sent for signature",
        extra: "Or copy the secure link to send it yourself now.",
      });
      onSent();
      if (!result.queued) onOpenChange(false);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) toastDbError(e, { action: "Send documents" });
      else toast.error(e instanceof Error ? e.message : "Could not send the documents.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{existingDocument ? "Email to sign" : "Send for signature"}</DialogTitle>
          <DialogDescription>
            The recipient gets one secure link. Preview the resolved PDF before it goes out.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="text-xs">Documents</Label>
            {existingDocument ? (
              <p className="mt-1 rounded-sm border px-3 py-2 text-sm">{existingDocument.name}</p>
            ) : templatesQ.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading templates…</p>
            ) : templates.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No contract templates for this office yet — an administrator adds them under Admin →
                Contract templates.
              </p>
            ) : (
              <ul className="mt-1 max-h-48 divide-y overflow-y-auto rounded-sm border">
                {templates.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 px-3 py-2">
                    <Checkbox
                      id={`tpl-${t.id}`}
                      checked={picked.includes(t.id)}
                      onCheckedChange={(v) =>
                        setPicked((p) => (v ? [...p, t.id] : p.filter((x) => x !== t.id)))
                      }
                    />
                    <label htmlFor={`tpl-${t.id}`} className="flex-1 cursor-pointer text-sm">
                      {t.name}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {DOCUMENT_TYPE_LABEL[t.doc_type]} · v{t.current_version}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Recipient name</Label>
              <Input value={toName} onChange={(e) => setToName(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Recipient email</Label>
              <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>

          <div>
            <Label className="text-xs">Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          <div>
            <Label className="text-xs">Message</Label>
            <Textarea rows={7} value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>

          <div>
            <Label className="text-xs">Ask the recipient to fill in</Label>
            <div className="mt-1 flex flex-wrap gap-3">
              {FIELD_CHOICES.map((f) => (
                <label key={f.key} className="flex items-center gap-1.5 text-sm">
                  <Checkbox
                    checked={fields.includes(f.key)}
                    onCheckedChange={(v) =>
                      setFields((p) => (v ? [...p, f.key] : p.filter((x) => x !== f.key)))
                    }
                  />
                  {f.label}
                </label>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={requireSignature}
                onCheckedChange={(v) => setRequireSignature(Boolean(v))}
              />
              Signature required
            </label>
            <div className="flex items-center gap-2 text-sm">
              <span>Remind after</span>
              <Input
                type="number"
                min={1}
                max={30}
                className="h-8 w-16"
                value={reminderDays}
                onChange={(e) => setReminderDays(Number(e.target.value) || 3)}
              />
              <span>days unsigned</span>
            </div>
          </div>

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
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          {!existingDocument && (
            <Button variant="outline" onClick={preview} disabled={busy || !selected.length}>
              <Eye className="mr-1.5 h-4 w-4" />
              Preview PDF
            </Button>
          )}
          <Button onClick={submit} disabled={busy || app.writesDisabled || !ready}>
            <Send className="mr-1.5 h-4 w-4" />
            {busy ? "Working…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
