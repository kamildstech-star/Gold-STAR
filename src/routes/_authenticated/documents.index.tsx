import type * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AlertTriangle, Clock3, Eye, FileText, FolderPlus, PenLine, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppContext } from "@/components/app-context";
import { supabase } from "@/integrations/supabase/client";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABEL,
  documentDisplayName,
  documentTypeLabel,
  buildDocumentFolderTree,
  createDocumentFolder,
  deleteDocumentFolder,
  documentFolderCounts,
  documentsInFolder,
  isReportDocument,
  flattenDocumentFolderTree,
  foldersNotMigrated,
  listDocumentFolders,
  moveDocumentToFolder,
  renameDocumentFolder,
  uploadDocumentFile,
  type DocumentFolder,
  type DocumentScope,
  type DocumentStatus,
  type DocumentType,
} from "@/lib/documents";
import {
  DOCUMENT_SIGNATURE_COLUMNS,
  countWaitingSignatures,
  type DocumentSignatureFacts,
} from "@/lib/document-status";
import { ensureDocumentThumbnail } from "@/lib/document-thumbnails";
import { isMissingSchema } from "@/lib/schema-fallback";
import { toastDbError } from "@/lib/db-errors";
import { assertWritesEnabled } from "@/lib/write-guard";
import { DocumentStatusBadge } from "@/components/document-status-badge";
import {
  DocumentFolderDialog,
  DocumentFolderRail,
  type FolderDialogState,
} from "@/components/document-folder-rail";
import { DocumentThumb, DocumentViewer, type ViewerDocument } from "@/components/document-viewer";
import { LoadError, PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";

export const Route = createFileRoute("/_authenticated/documents/")({
  head: () => ({
    meta: [
      { title: "Documents · Recovery Hub" },
      {
        name: "description",
        content:
          "Contracts, work authorizations, certificates of insurance and W-9s with expiry tracking.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: DocumentsPage,
});

type Row = {
  id: string;
  name: string;
  doc_type: DocumentType;
  status: DocumentStatus;
  expiry_date: string | null;
  created_at: string;
  location_id: string;
  job_id: string | null;
  account_id: string | null;
  project_id: string | null;
  storage_path: string | null;
  mime: string | null;
  size_bytes: number | null;
  folder_id: string | null;
} & Omit<DocumentSignatureFacts, "status" | "doc_type" | "created_at">;

const BASE_COLUMNS =
  "id, name, doc_type, status, expiry_date, created_at, location_id, job_id, account_id, project_id, storage_path, mime, size_bytes";

/**
 * PostgREST fails the whole read on one unknown column, and two of the things
 * this list wants ship in migrations that an environment may not have applied:
 * the signature timestamps that turn "sent" into "opened, 9 days", and
 * `folder_id`. Ask for the richest shape and step down, the way
 * `listDocuments` does for the record panel — a missing column costs the list
 * that column, never the list.
 */
const SHAPES: { cols: string; folders: boolean }[] = [
  { cols: `${BASE_COLUMNS}, folder_id, ${DOCUMENT_SIGNATURE_COLUMNS}`, folders: true },
  { cols: `${BASE_COLUMNS}, ${DOCUMENT_SIGNATURE_COLUMNS}`, folders: false },
  { cols: `${BASE_COLUMNS}, folder_id`, folders: true },
  { cols: BASE_COLUMNS, folders: false },
];

function DocumentsPage() {
  const app = useAppContext();
  const [type, setType] = useState<DocumentType | "all">("all");
  const [q, setQ] = useState("");
  const [viewing, setViewing] = useState<ViewerDocument | null>(null);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [folderName, setFolderName] = useState("");
  const [uploadType, setUploadType] = useState<DocumentType>("contract");
  const [busy, setBusy] = useState(false);

  const locationId = app.currentLocationId;
  const disabled = app.writesDisabled;
  /**
   * Every document and every folder carries a location — it is the RLS anchor.
   * With the picker on "all locations" there is no answer to which one a new
   * item belongs to, so filing is off rather than guessing at the first one.
   */
  const canFile = !!locationId && !disabled;

  const scope: DocumentScope = useMemo(
    () => ({ locationId: locationId ?? "", jobId: null, accountId: null, projectId: null }),
    [locationId],
  );

  const docsQ = useQuery({
    queryKey: ["documents-index", locationId, type],
    queryFn: async (): Promise<{ rows: Row[]; folders: boolean }> => {
      const run = async (cols: string) => {
        let query = supabase
          .from("documents")
          .select(cols)
          .order("created_at", { ascending: false })
          .limit(500);
        if (locationId) query = query.eq("location_id", locationId);
        if (type !== "all") query = query.eq("doc_type", type);
        // Company-wide only (David, 12 Oct): COI, W-9, contracts, client and
        // tenant forms. A job's files live on the job — see isCompanyDocument.
        query = query.is("job_id", null).is("project_id", null);
        return query;
      };
      let last: unknown = null;
      for (const shape of SHAPES) {
        const res = await run(shape.cols);
        if (!res.error) {
          const rows = (res.data ?? []) as unknown as Row[];
          return {
            rows: rows.map((r) => ({ ...r, folder_id: shape.folders ? r.folder_id : null })),
            folders: shape.folders,
          };
        }
        if (!isMissingSchema(res.error) && !foldersNotMigrated(res.error)) throw res.error;
        last = res.error;
      }
      throw last;
    },
  });

  /** null means the folders migration has not been applied here. */
  const foldersQ = useQuery({
    queryKey: ["documents-index-folders", locationId],
    enabled: !!locationId,
    queryFn: async (): Promise<DocumentFolder[] | null> => listDocumentFolders(scope),
  });
  const folders = locationId ? (foldersQ.data ?? null) : null;

  const refresh = () => {
    void docsQ.refetch();
    void foldersQ.refetch();
  };

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = docsQ.data?.rows ?? [];
    return term ? all.filter((d) => d.name.toLowerCase().includes(term)) : all;
  }, [docsQ.data, q]);

  // The rail filters the list; it never filters the counts above it. A
  // signature owed does not stop being owed because you clicked a folder.
  const shown = useMemo(
    () => documentsInFolder(rows, folders, activeFolder),
    [rows, folders, activeFolder],
  );
  const counts = useMemo(() => documentFolderCounts(rows), [rows]);
  // What Gold Star produced about the job, and what the file has to hold.
  const shownReports = useMemo(() => shown.filter((d) => isReportDocument(d.doc_type)), [shown]);
  const shownOther = useMemo(() => shown.filter((d) => !isReportDocument(d.doc_type)), [shown]);
  const nodes = folders ? flattenDocumentFolderTree(buildDocumentFolderTree(folders)) : [];
  const activeName = folders?.find((f) => f.id === activeFolder)?.name ?? null;

  const today = new Date().toISOString().slice(0, 10);
  const expiring = rows.filter(
    (d) => d.expiry_date && d.expiry_date >= today && d.expiry_date <= addDays(today, 30),
  );
  const expired = rows.filter((d) => d.expiry_date && d.expiry_date < today);
  const waiting = countWaitingSignatures(rows);

  const upload = async (file: File) => {
    if (!canFile) return;
    setBusy(true);
    try {
      const uploaded = await uploadDocumentFile({
        file,
        scope,
        docType: uploadType,
        userId: app.userId ?? null,
      });
      // The bytes are still in hand, so draw the tile's thumbnail now rather
      // than have the list download the file again to make one.
      void ensureDocumentThumbnail(
        {
          id: uploaded.id,
          name: file.name,
          mime: uploaded.mime,
          size_bytes: file.size,
          storage_path: uploaded.path,
        },
        { generate: true, bytes: file, fresh: true },
      );
      // File it where the user is looking, not at the top level they left.
      if (folders && activeFolder) await moveDocumentToFolder(uploaded.id, activeFolder);
      toast.success("Document added");
      refresh();
    } catch (e) {
      toastDbError(e, { action: "Save document" });
    } finally {
      setBusy(false);
    }
  };

  const move = async (documentId: string, folderId: string | null) => {
    try {
      assertWritesEnabled(disabled, app.writesDisabledReason);
      await moveDocumentToFolder(documentId, folderId);
      refresh();
    } catch (e) {
      toastDbError(e, { action: "Move document" });
    }
  };

  const submitFolder = async () => {
    if (!folderDialog || !folderName.trim()) return;
    setBusy(true);
    try {
      assertWritesEnabled(disabled, app.writesDisabledReason);
      if (folderDialog.mode === "new") {
        await createDocumentFolder({
          scope,
          name: folderName,
          parentFolderId: folderDialog.parent,
          userId: app.userId ?? null,
          sortOrder: folders?.length ?? 0,
        });
      } else {
        await renameDocumentFolder(folderDialog.folder.id, folderName);
      }
      setFolderDialog(null);
      setFolderName("");
      refresh();
    } catch (e) {
      toastDbError(e, { action: "Save folder" });
    } finally {
      setBusy(false);
    }
  };

  const newFolder = (parent: string | null) => {
    setFolderDialog({ mode: "new", parent });
    setFolderName("");
  };

  const viewerDoc = (d: Row): ViewerDocument => ({
    id: d.id,
    name: d.name,
    doc_type: d.doc_type,
    mime: d.mime,
    size_bytes: d.size_bytes,
    storage_path: d.storage_path,
  });

  const dragProps = (d: Row) => ({
    draggable: !!folders && !disabled,
    onDragStart: (e: React.DragEvent) => e.dataTransfer.setData("text/document-id", d.id),
  });

  const attachedTo = (d: Row) =>
    d.job_id ? (
      <Link to="/jobs/$id" params={{ id: d.job_id }} className="hover:underline">
        Job
      </Link>
    ) : d.account_id ? (
      <Link to="/accounts/$id" params={{ id: d.account_id }} className="hover:underline">
        Account
      </Link>
    ) : d.project_id ? (
      <Link to="/projects/$id" params={{ id: d.project_id }} className="hover:underline">
        Project
      </Link>
    ) : null;

  return (
    <div className="space-y-3 px-3 py-4 sm:px-4">
      <PageHeader
        title="Documents"
        subtitle={
          docsQ.isError
            ? "Count unavailable"
            : `${rows.length.toLocaleString("en-US")} company documents · job files are on each job`
        }
      >
        {/*
          David, on the call: "I can't even create new documents over here.
          It's not letting me create new documents, new folders." He was right
          — this page was read-only. Upload and New folder now live here, on
          the same document_folders table the job and account panels use.
        */}
        <Select
          value={uploadType}
          onValueChange={(v) => setUploadType(v as DocumentType)}
          disabled={!canFile}
        >
          <SelectTrigger
            className="h-9 w-[190px] text-[13px]"
            title="What the next upload is filed as"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DOCUMENT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {DOCUMENT_TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button asChild size="sm" disabled={!canFile || busy}>
          <label className="cursor-pointer">
            <Upload className="mr-1.5 size-4" />
            {busy ? "Working…" : "Upload"}
            <input
              type="file"
              className="hidden"
              disabled={!canFile || busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </label>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!canFile || busy || !folders}
          onClick={() => newFolder(activeFolder)}
        >
          <FolderPlus className="mr-1.5 size-4" />
          New folder
        </Button>
      </PageHeader>

      {/* Why the buttons above are dead, rather than leaving someone clicking. */}
      {!locationId && (
        <p className="border-l-2 border-muted-foreground/40 px-2 py-1 text-xs text-muted-foreground">
          Pick a single location to upload documents or make folders — a document belongs to one
          location, and this view is showing all of them.
        </p>
      )}
      {/* A failed read is not a missing migration, and saying so would send
          someone to look for a migration that is already applied. */}
      {!!locationId && foldersQ.isError && (
        <p className="border-l-2 border-destructive/50 px-2 py-1 text-xs text-muted-foreground">
          The folders could not be loaded, so every document is listed below unfiled. This is a
          failed query, not an empty folder tree.
        </p>
      )}
      {!!locationId && !foldersQ.isError && folders === null && !foldersQ.isLoading && (
        <p className="border-l-2 border-muted-foreground/40 px-2 py-1 text-xs text-muted-foreground">
          Folders need a database update before they can be used — the migration that adds
          <code className="mx-1">document_folders</code> and
          <code className="mx-1">documents.folder_id</code> has not been applied here. Every
          document is listed below in the meantime; nothing is hidden.
        </p>
      )}

      {/* A failed read has no counts. Zeroes here read as "all clear". */}
      {!docsQ.isError && (
        <MetricStrip
          metrics={[
            { label: "Documents", value: rows.length.toLocaleString("en-US"), icon: FileText },
            {
              label: "Awaiting signature",
              value: waiting.toLocaleString("en-US"),
              icon: PenLine,
              tone: waiting > 0 ? "danger" : "default",
            },
            {
              label: "Expiring in 30 days",
              value: expiring.length.toLocaleString("en-US"),
              icon: Clock3,
              tone: expiring.length > 0 ? "warning" : "default",
            },
            {
              label: "Expired",
              value: expired.length.toLocaleString("en-US"),
              icon: AlertTriangle,
              tone: expired.length > 0 ? "danger" : "default",
            },
          ]}
        />
      )}

      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Search documents"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // 16px below sm, or iOS zooms in on focus and never zooms back.
          className="h-11 w-full text-base sm:h-9 sm:w-64 sm:text-[13px]"
        />
        <Select value={type} onValueChange={(v) => setType(v as DocumentType | "all")}>
          <SelectTrigger className="h-11 w-full text-base sm:h-9 sm:w-[220px] sm:text-[13px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {DOCUMENT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {DOCUMENT_TYPE_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/*
        Folders as icons across the top, and the list below split in two —
        reports on one side, paperwork on the other. David, 16 Sep: the screen
        was "one long downward list", and the folder rail made it longer.
      */}
      <div className="flex flex-col gap-3">
        {folders && (
          <DocumentFolderRail
            variant="tiles"
            className="w-full"
            nodes={nodes}
            counts={counts}
            rootCount={rows.length}
            active={activeFolder}
            disabled={!canFile}
            onSelect={setActiveFolder}
            onDropDocument={(folderId, documentId) => void move(documentId, folderId)}
            onNew={newFolder}
            onRename={(folder) => {
              setFolderDialog({ mode: "rename", folder });
              setFolderName(folder.name);
            }}
            onDelete={async (folder) => {
              try {
                assertWritesEnabled(disabled, app.writesDisabledReason);
                await deleteDocumentFolder(folder.id);
                if (activeFolder === folder.id) setActiveFolder(null);
                toast.success("Folder removed — its documents moved to the top level");
                refresh();
              } catch (e) {
                toastDbError(e, { action: "Delete folder" });
              }
            }}
          />
        )}

        <Card className="min-w-0 flex-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{activeName ?? "All documents"}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {docsQ.isError ? (
              // A failed read is not "no documents" — that reads as a clean slate.
              <LoadError
                what="the document list"
                error={docsQ.error}
                onRetry={() => void docsQ.refetch()}
                className="m-3"
              />
            ) : shown.length === 0 ? (
              <div className="flex gap-3 p-3 text-sm">
                <FileText className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                <div className="space-y-2">
                  <div className="font-medium">
                    {activeName ? "Nothing filed in this folder yet" : "No documents yet"}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Upload files here, or drag a document from the list onto a folder to file it.
                    Documents also arrive on their own: a work authorization signed on scene from a
                    job record, a vendor COI or W-9 uploaded against an account, and contracts
                    attached to a job.
                  </p>
                  <div className="flex gap-2">
                    <Button asChild size="sm" variant="outline">
                      <Link to="/jobs">Open jobs</Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/accounts">Open accounts</Link>
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Phone: a card per document. */}
                <ul className="divide-y md:hidden">
                  {shown.map((d) => (
                    <li key={d.id} className="flex flex-col gap-1 px-3 py-2.5" {...dragProps(d)}>
                      <div className="flex items-start justify-between gap-2">
                        {/*
                          "And if it's PDF, I should be able to view it like a
                          little, you know, preview thingy." The phone had no
                          way in at all — the name was plain text — so a PDF
                          could only be downloaded. It opens the same viewer
                          the table does, which embeds the PDF rather than
                          handing the file to the OS.
                        */}
                        <button
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => setViewing(viewerDoc(d))}
                        >
                          <DocumentThumb doc={viewerDoc(d)} className="size-9" />
                          <span className="min-w-0 break-words text-[14px] font-medium">
                            {documentDisplayName(d.name)}
                          </span>
                        </button>
                        <DocumentStatusBadge doc={d} className="shrink-0" />
                      </div>
                      <div className="text-[12px] text-muted-foreground">
                        {documentTypeLabel(d.doc_type)}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[12px]">
                        {d.expiry_date ? (
                          <Badge variant={d.expiry_date < today ? "destructive" : "outline"}>
                            Expires {d.expiry_date}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">No expiry</span>
                        )}
                        {d.job_id ? (
                          <Link
                            to="/jobs/$id"
                            params={{ id: d.job_id }}
                            className="inline-flex min-h-11 items-center text-primary underline underline-offset-2"
                          >
                            Open job
                          </Link>
                        ) : d.account_id ? (
                          <Link
                            to="/accounts/$id"
                            params={{ id: d.account_id }}
                            className="inline-flex min-h-11 items-center text-primary underline underline-offset-2"
                          >
                            Open account
                          </Link>
                        ) : d.project_id ? (
                          <Link
                            to="/projects/$id"
                            params={{ id: d.project_id }}
                            className="inline-flex min-h-11 items-center text-primary underline underline-offset-2"
                          >
                            Open project
                          </Link>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="hidden gap-3 md:grid xl:grid-cols-2">
                  {(
                    [
                      { title: "Reports", rows: shownReports },
                      { title: "Documents", rows: shownOther },
                    ] as const
                  ).map((col) => (
                    <div key={col.title} className="min-w-0">
                      <div className="flex items-baseline justify-between border-b px-3 py-1.5">
                        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {col.title}
                        </span>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {col.rows.length}
                        </span>
                      </div>
                      {col.rows.length === 0 ? (
                        <p className="px-3 py-4 text-xs text-muted-foreground">
                          Nothing filed here yet.
                        </p>
                      ) : (
                        <DocumentTable
                          rows={col.rows}
                          today={today}
                          dragProps={dragProps}
                          viewerDoc={viewerDoc}
                          setViewing={setViewing}
                          attachedTo={attachedTo}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <DocumentViewer doc={viewing} onOpenChange={(open) => !open && setViewing(null)} />

      <DocumentFolderDialog
        state={folderDialog}
        name={folderName}
        onNameChange={setFolderName}
        onCancel={() => setFolderDialog(null)}
        onSubmit={() => void submitFolder()}
        disabled={!canFile || busy}
      />
    </div>
  );
}

/**
 * The desktop documents table.
 *
 * Lifted out of the page so it can be drawn twice — reports in one column and
 * everything else in the other. David, 16 Sep: the documents area was "one
 * long downward list". Same columns, same controls, same drag behaviour; it is
 * rendered over a smaller set of rows.
 */
function DocumentTable({
  rows,
  today,
  dragProps,
  viewerDoc,
  setViewing,
  attachedTo,
}: {
  rows: Row[];
  today: string;
  dragProps: (d: Row) => Record<string, unknown>;
  viewerDoc: (d: Row) => ViewerDocument;
  setViewing: (d: ViewerDocument) => void;
  attachedTo: (d: Row) => React.ReactNode;
}) {
  return (
    <div className="hidden overflow-x-auto md:max-h-[75svh] md:overflow-auto md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Document</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Attached to</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((d) => (
            <TableRow key={d.id} {...dragProps(d)}>
              <TableCell className="font-medium">
                <button
                  className="flex min-w-0 items-center gap-2 text-left hover:underline"
                  onClick={() => setViewing(viewerDoc(d))}
                >
                  <DocumentThumb doc={viewerDoc(d)} className="size-8" />
                  <span className="truncate">{documentDisplayName(d.name)}</span>
                </button>
              </TableCell>
              <TableCell className="text-xs">{documentTypeLabel(d.doc_type)}</TableCell>
              <TableCell>
                <DocumentStatusBadge doc={d} />
              </TableCell>
              <TableCell className="text-xs">
                {d.expiry_date ? (
                  <Badge variant={d.expiry_date < today ? "destructive" : "outline"}>
                    {d.expiry_date}
                  </Badge>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="text-xs">{attachedTo(d) ?? "—"}</TableCell>
              <TableCell>
                {/* The filename opens it too, but nothing said so. */}
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  title="Preview"
                  aria-label={`Preview ${documentDisplayName(d.name)}`}
                  onClick={() => setViewing(viewerDoc(d))}
                >
                  <Eye className="size-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
