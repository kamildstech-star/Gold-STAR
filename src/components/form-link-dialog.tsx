import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Link2 } from "lucide-react";
import { toast } from "sonner";

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
import { Switch } from "@/components/ui/switch";
import { toastDbError } from "@/lib/db-errors";
import { DOCUMENT_TYPE_LABEL } from "@/lib/documents";
import { createFormLink, formLinkDefaults, formTemplates } from "@/lib/form-links";
import { markFormLinkSent } from "@/lib/form-links";

/**
 * Mints a public, tokenised form link for one job. The recipient needs no
 * login, and the link reaches nothing but this job's paperwork.
 */
export function FormLinkDialog({
  open,
  onOpenChange,
  jobId,
  locationId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string;
  locationId: string;
  onCreated: () => void;
}) {
  const app = useAppContext();
  const [selected, setSelected] = useState<string[]>([]);
  const [requireSignature, setRequireSignature] = useState(true);
  const [singleUse, setSingleUse] = useState(true);
  const [expiresInDays, setExpiresInDays] = useState(30);
  const [recipientName, setRecipientName] = useState("");
  const [recipientEmail, setRecipientEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<{ id: string; url: string } | null>(null);

  const defaultsQ = useQuery({
    queryKey: ["form-link-defaults"],
    enabled: open,
    queryFn: formLinkDefaults,
  });

  const templatesQ = useQuery({
    queryKey: ["form-link-templates", locationId, open],
    enabled: open,
    queryFn: () => formTemplates(locationId),
  });

  useEffect(() => {
    if (!open) return;
    setLink(null);
    setSelected([]);
  }, [open]);

  useEffect(() => {
    if (defaultsQ.data) {
      setExpiresInDays(defaultsQ.data.expires_in_days);
      setSingleUse(defaultsQ.data.single_use);
    }
  }, [defaultsQ.data]);

  const grouped = useMemo(() => {
    const map = new Map<string, { id: string; name: string }[]>();
    for (const t of templatesQ.data ?? []) {
      const list = map.get(t.doc_type) ?? [];
      list.push({ id: t.id, name: t.name });
      map.set(t.doc_type, list);
    }
    return [...map.entries()];
  }, [templatesQ.data]);

  const create = async () => {
    setBusy(true);
    try {
      const res = await createFormLink({
        jobId,
        locationId,
        templateIds: selected,
        requireSignature,
        expiresInDays,
        singleUse,
        recipientName: recipientName || null,
        recipientEmail: recipientEmail || null,
        requiredFields: [],
        userId: app.userId ?? null,
      });
      setLink({ id: res.packet.id, url: res.url });
      toast.success("Form link created");
      onCreated();
    } catch (e) {
      toastDbError(e, { action: "Create form link" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Generate a form link</DialogTitle>
          <DialogDescription>
            A secure link to this job only. The recipient does not need an account, and the entity,
            logo and payment details come from this job&apos;s billing office.
          </DialogDescription>
        </DialogHeader>

        {link ? (
          <div className="space-y-3">
            <Label className="text-xs">Shareable link</Label>
            <div className="flex gap-2">
              <Input readOnly value={link.url} className="font-mono text-xs" />
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(link.url);
                  void markFormLinkSent(link.id).then(onCreated);
                  toast.success("Link copied");
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Expires in {expiresInDays} days · {singleUse ? "single use" : "reusable"}. You can
              revoke or regenerate it from the Documents tab.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">Templates</Label>
              <div className="max-h-56 space-y-3 overflow-auto rounded-sm border p-3">
                {templatesQ.isLoading && (
                  <div className="text-sm text-muted-foreground">Loading templates…</div>
                )}
                {!templatesQ.isLoading && !grouped.length && (
                  <div className="text-sm text-muted-foreground">
                    No templates available for this office yet.
                  </div>
                )}
                {grouped.map(([docType, list]) => (
                  <div key={docType} className="space-y-1">
                    <div className="text-xs font-medium text-muted-foreground">
                      {DOCUMENT_TYPE_LABEL[docType as keyof typeof DOCUMENT_TYPE_LABEL] ?? docType}
                    </div>
                    {list.map((t) => (
                      <label key={t.id} className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selected.includes(t.id)}
                          onCheckedChange={(v) =>
                            setSelected((prev) =>
                              v ? [...prev, t.id] : prev.filter((x) => x !== t.id),
                            )
                          }
                        />
                        {t.name}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Expires in (days)</Label>
                <Input
                  type="number"
                  min={1}
                  value={expiresInDays}
                  onChange={(e) => setExpiresInDays(Number(e.target.value) || 1)}
                />
              </div>
              <div className="space-y-2 pt-5">
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={singleUse} onCheckedChange={setSingleUse} />
                  Single use
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch checked={requireSignature} onCheckedChange={setRequireSignature} />
                  Requires signature
                </label>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Recipient name (optional)</Label>
                <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">Recipient email (optional)</Label>
                <Input
                  type="email"
                  value={recipientEmail}
                  onChange={(e) => setRecipientEmail(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {link ? "Done" : "Cancel"}
          </Button>
          {!link && (
            <Button onClick={create} disabled={busy || !selected.length || app.writesDisabled}>
              <Link2 className="mr-2 size-4" />
              Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
