/**
 * Pick files to send with a job email — from BOTH the job's own Documents
 * (any folder) and the company-wide Documents section (W-9, COI, contracts).
 * David, 21 Oct: the office attaches the company W-9 and COI to job emails as
 * often as it attaches the job's own papers, and should not have to copy them
 * onto the job first.
 *
 * Picking only records ids; the composer signs the download links at send
 * time, so a link is never minted for a file that ends up not being sent.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Building2, Briefcase, Paperclip, Search } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DOCUMENT_TYPE_LABEL,
  listCompanyDocuments,
  listDocumentFolders,
  listDocuments,
  type DocumentType,
} from "@/lib/documents";
import { filterPickable, type PickedAttachment } from "@/lib/email-attachments";

type Row = {
  id: string;
  name: string;
  doc_type: DocumentType;
  storage_path: string | null;
  folder?: string | null;
};

export function EmailAttachmentPicker({
  jobId,
  locationId,
  picked,
  onChange,
}: {
  jobId: string;
  locationId: string;
  picked: readonly PickedAttachment[];
  onChange: (next: PickedAttachment[]) => void;
}) {
  const [term, setTerm] = useState("");
  const [tab, setTab] = useState<"job" | "company">("job");

  const jobQ = useQuery({
    queryKey: ["email-attach", "job", jobId, locationId],
    queryFn: async (): Promise<Row[]> => {
      const scope = { locationId, jobId };
      const [{ rows }, folders] = await Promise.all([
        listDocuments(scope),
        listDocumentFolders(scope).catch(() => null),
      ]);
      const folderName = new Map((folders ?? []).map((f) => [f.id, f.name]));
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        doc_type: r.doc_type,
        storage_path: r.storage_path,
        folder: r.folder_id ? (folderName.get(r.folder_id) ?? null) : null,
      }));
    },
  });

  const companyQ = useQuery({
    queryKey: ["company-documents", locationId],
    queryFn: () => listCompanyDocuments(locationId),
  });

  const jobRows = useMemo(() => filterPickable(jobQ.data ?? [], term), [jobQ.data, term]);
  const companyRows = useMemo(
    () => filterPickable(companyQ.data ?? [], term),
    [companyQ.data, term],
  );
  const pickedIds = useMemo(() => new Set(picked.map((p) => p.id)), [picked]);

  const toggle = (row: Row, source: PickedAttachment["source"], on: boolean) => {
    if (on)
      onChange([...picked.filter((p) => p.id !== row.id), { id: row.id, name: row.name, source }]);
    else onChange(picked.filter((p) => p.id !== row.id));
  };

  const list = (
    rows: Row[],
    source: PickedAttachment["source"],
    loading: boolean,
    failed: boolean,
  ) =>
    loading ? (
      <p className="p-2 text-xs text-muted-foreground">Loading…</p>
    ) : failed ? (
      <p className="p-2 text-xs text-destructive">These documents could not be loaded.</p>
    ) : rows.length === 0 ? (
      <p className="p-2 text-xs text-muted-foreground">
        {term ? "Nothing matches." : "No documents here yet."}
      </p>
    ) : (
      <ul className="max-h-56 divide-y overflow-y-auto rounded-sm border">
        {rows.map((r) => (
          <li key={r.id}>
            <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs hover:bg-muted/50">
              <Checkbox
                checked={pickedIds.has(r.id)}
                onCheckedChange={(v) => toggle(r, source, v === true)}
              />
              <span className="min-w-0 flex-1 truncate">{r.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {r.folder ? `${r.folder} · ` : ""}
                {DOCUMENT_TYPE_LABEL[r.doc_type] ?? r.doc_type}
              </span>
            </label>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="space-y-2 rounded-md border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <Paperclip className="size-3" /> Attach documents
          {picked.length ? ` · ${picked.length} selected` : ""}
        </p>
        <div className="relative w-full sm:w-56">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Search documents"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as "job" | "company")}>
        <TabsList>
          <TabsTrigger value="job" className="text-xs">
            <Briefcase className="mr-1 size-3.5" /> This job ({jobRows.length})
          </TabsTrigger>
          <TabsTrigger value="company" className="text-xs">
            <Building2 className="mr-1 size-3.5" /> Company ({companyRows.length})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="job" className="mt-2">
          {list(jobRows, "job", jobQ.isLoading, jobQ.isError)}
        </TabsContent>
        <TabsContent value="company" className="mt-2">
          {list(companyRows, "company", companyQ.isLoading, companyQ.isError)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
