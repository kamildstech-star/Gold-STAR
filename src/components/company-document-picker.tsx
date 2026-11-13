/**
 * Pull a company-wide document onto a job.
 *
 * David, 12 Oct: the main Documents section is company paperwork — COI, W-9,
 * contracts, client and tenant forms — and a job's documents must still be
 * able to bring one of those in. Picking one copies the file onto the job
 * (`copyCompanyDocumentToJob`); the company's original is never touched.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastDbError } from "@/lib/db-errors";
import {
  DOCUMENT_TYPE_LABEL,
  copyCompanyDocumentToJob,
  listCompanyDocuments,
  type CompanyDocument,
  type DocumentScope,
} from "@/lib/documents";

export function CompanyDocumentPicker({
  open,
  onOpenChange,
  scope,
  userId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The job's scope; the company list is read from its location. */
  scope: DocumentScope;
  userId: string | null;
  onAdded: (documentId: string) => void | Promise<void>;
}) {
  const [term, setTerm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const docsQ = useQuery({
    queryKey: ["company-documents", scope.locationId],
    enabled: open && !!scope.locationId,
    queryFn: () => listCompanyDocuments(scope.locationId),
  });

  const shown = useMemo(() => {
    const t = term.trim().toLowerCase();
    const all = docsQ.data ?? [];
    return t
      ? all.filter(
          (d) =>
            d.name.toLowerCase().includes(t) ||
            (DOCUMENT_TYPE_LABEL[d.doc_type] ?? "").toLowerCase().includes(t),
        )
      : all;
  }, [docsQ.data, term]);

  async function pick(doc: CompanyDocument) {
    setBusy(doc.id);
    try {
      const { id } = await copyCompanyDocumentToJob({ source: doc, scope, userId });
      await onAdded(id);
      toast.success(`${doc.name} added to the job`);
      onOpenChange(false);
    } catch (e) {
      toastDbError(e, { action: "Add the company document" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle>Add from company documents</DialogTitle>
          <DialogDescription>
            COI, W-9, contracts and forms kept under Documents. The job gets its own copy.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search company documents"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
          {docsQ.isLoading ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          ) : docsQ.isError ? (
            <p className="p-3 text-sm text-destructive">
              Company documents could not be loaded — this is not an empty list.
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              {term ? "Nothing matches." : "No company documents yet. Add them under Documents."}
            </p>
          ) : (
            <ul className="divide-y">
              {shown.map((d) => (
                <li key={d.id} className="flex items-center gap-2 px-3 py-2">
                  <Building2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{d.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {DOCUMENT_TYPE_LABEL[d.doc_type] ?? d.doc_type}
                      {d.expiry_date ? ` · expires ${d.expiry_date}` : ""}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy != null}
                    onClick={() => void pick(d)}
                  >
                    {busy === d.id && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
