import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { DOCUMENT_TYPE_LABEL } from "@/lib/documents";
import {
  currentVersion,
  listTemplates,
  logDocumentEvent,
  mergeDataForJob,
  renderTemplate,
  unresolvedTokens,
} from "@/lib/document-templates";

/**
 * Generates a document from a published template version. The generated
 * document records the exact version it came from, so the wording a customer
 * signed can always be reproduced.
 */
export function GenerateFromTemplateDialog({
  open,
  onOpenChange,
  jobId,
  accountId,
  projectId,
  locationId,
  onGenerated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId?: string | null;
  accountId?: string | null;
  projectId?: string | null;
  locationId: string;
  onGenerated: () => void;
}) {
  const app = useAppContext();
  const [templateId, setTemplateId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const templatesQ = useQuery({
    queryKey: ["document-templates", locationId, open],
    enabled: open,
    queryFn: () => listTemplates(locationId),
  });

  const jobQ = useQuery({
    queryKey: ["document-merge-job", jobId, open],
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

  const versionQ = useQuery({
    queryKey: ["document-template-current", templateId],
    enabled: !!templateId,
    queryFn: () => currentVersion(templateId),
  });

  useEffect(() => {
    if (!templateId && templatesQ.data?.length) setTemplateId(templatesQ.data[0].id);
  }, [templatesQ.data, templateId]);

  const template = templatesQ.data?.find((t) => t.id === templateId) ?? null;
  const mergeData = useMemo(
    () =>
      mergeDataForJob(
        (jobQ.data ?? {}) as Parameters<typeof mergeDataForJob>[0],
        "Gold Star Restoration",
        null,
      ),
    [jobQ.data],
  );
  const body = versionQ.data?.body ?? "";
  const rendered = useMemo(() => renderTemplate(body, mergeData), [body, mergeData]);
  const missing = useMemo(() => unresolvedTokens(body, mergeData), [body, mergeData]);

  const generate = async () => {
    if (!template || !versionQ.data) return;
    setBusy(true);
    const { data, error } = await supabase
      .from("documents")
      .insert({
        location_id: locationId,
        job_id: jobId ?? null,
        account_id: accountId ?? null,
        project_id: projectId ?? null,
        doc_type: template.doc_type,
        name: `${template.name}${mergeData["job.number"] ? ` — ${mergeData["job.number"]}` : ""}`,
        status: "draft",
        template_id: template.id,
        template_version_id: versionQ.data.id,
        rendered_body: rendered,
        merge_data: mergeData as never,
        created_by: app.userId,
      })
      .select("id")
      .single();
    setBusy(false);
    if (error) {
      toastDbError(error, { action: "Generate document" });
      return;
    }
    await logDocumentEvent(data.id, "generated", {
      template_id: template.id,
      version: versionQ.data.version,
      unresolved: missing,
    });
    toast.success("Document generated");
    onOpenChange(false);
    onGenerated();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Generate from template</DialogTitle>
        </DialogHeader>

        {templatesQ.isLoading ? (
          <div className="text-sm text-muted-foreground">Loading templates…</div>
        ) : (templatesQ.data ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No templates exist for this location yet. An administrator adds them under Admin →
            Templates; the starter set covers work authorization, direction to pay and completion.
          </p>
        ) : (
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Template</Label>
              <Select value={templateId} onValueChange={setTemplateId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(templatesQ.data ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.name} · {DOCUMENT_TYPE_LABEL[t.doc_type]} (v{t.current_version})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {missing.length > 0 && (
              <p className="rounded-sm bg-warning/15 px-2 py-1 text-xs">
                Missing on the record: {missing.join(", ")}. These print as placeholders — fill the
                job in first if the contract is going to a customer.
              </p>
            )}

            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-sm border bg-muted/40 p-3 text-[11px]">
              {rendered || "Select a template to preview."}
            </pre>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={generate} disabled={busy || app.writesDisabled || !versionQ.data}>
            {busy ? "Generating…" : "Generate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
