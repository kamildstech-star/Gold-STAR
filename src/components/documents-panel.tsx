import { DocumentDropzone, type UploadProgress } from "@/components/document-dropzone";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import type { RecordFocus } from "@/lib/job-page-search";
import { assertWritesEnabled } from "@/lib/write-guard";
import { cn } from "@/lib/utils";
import {
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_LABEL,
  EXPIRING_DOCUMENT_TYPES,
  buildDocumentFolderTree,
  createDocumentFolder,
  deleteDocumentFolder,
  documentFileUrl,
  documentFolderCounts,
  documentKind,
  documentsInFolder,
  flattenDocumentFolderTree,
  listDocumentFolders,
  listDocumentPeople,
  listDocuments,
  moveDocumentToFolder,
  renameDocumentFolder,
  uploadDocumentFile,
  type DocumentFolder,
  type DocumentRow,
  type DocumentScope,
  type DocumentType,
} from "@/lib/documents";
import { metadataLine, type PersonNames } from "@/lib/document-metadata";
import {
  RECENT_DOCUMENT_ROWS,
  documentCountLabel,
  hiddenDocumentsLabel,
  recentDocuments,
} from "@/lib/prospect-documents";
import { ensureDocumentThumbnail } from "@/lib/document-thumbnails";
import { DocumentThumb, DocumentViewer, type ViewerDocument } from "@/components/document-viewer";
import { DocumentStatusBadge } from "@/components/document-status-badge";
import {
  DocumentFolderDialog,
  DocumentFolderRail,
  type FolderDialogState,
} from "@/components/document-folder-rail";
import { countWaitingSignatures } from "@/lib/document-status";
import { WorkAuthorizationDialog } from "@/components/work-authorization-dialog";
import { GenerateFromTemplateDialog } from "@/components/document-generate-dialog";
import { DocumentSendDialog } from "@/components/document-send-dialog";
import {
  PACKET_STATE_LABEL,
  PACKET_STATE_TONE,
  daysOutstanding,
  listPacketsForJob,
  packetState,
  revokePacket,
  signUrl,
  canEmailToSign,
  offerEmailToSign,
  type PacketWithItems,
} from "@/lib/document-send";
import { verifyDocumentHash } from "@/lib/document-templates";
import {
  Building2,
  ChevronRight,
  Copy,
  FileSignature,
  FileText,
  FolderPlus,
  LayoutGrid,
  Link2,
  Mail,
  List,
  MoreHorizontal,
  MoveRight,
  Printer,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { FormLinkDialog } from "@/components/form-link-dialog";
import { CompanyDocumentPicker } from "@/components/company-document-picker";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  printSkipReason,
  pruneSelection,
  selectAllState,
  selectedInOrder,
  toggleAllShown,
} from "@/lib/document-print-selection";
import {
  deleteDocuments,
  deleteSummary,
  partitionForDelete,
  toastDeleteSummary,
  useManagesDocuments,
} from "@/lib/document-delete";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { markFormLinkSent, regenerateFormLink } from "@/lib/form-links";

function toViewerDocument(d: DocumentRow): ViewerDocument {
  return {
    id: d.id,
    name: d.name,
    doc_type: d.doc_type,
    mime: d.mime,
    size_bytes: d.size_bytes,
    storage_path: d.storage_path,
  };
}

/**
 * Documents live against a job, an account, or a project. Signed items are
 * immutable by policy — the evidence trail in a coverage dispute — so the
 * only removal here is "Delete selected" (12 Nov): office managers and
 * owners/admins, after a confirmation, never a signed document. See
 * src/lib/document-delete.ts.
 *
 * `compact` is the same panel as a glance: the newest few rows with their
 * kind, status and filing line, a count, Upload, and "All documents" as the
 * way into the full view. It reads through the same scope and the same
 * queries, so what the prospect dock shows can never differ from what the
 * full panel shows for the same account, and RLS answers both alike.
 */
export function DocumentsPanel({
  jobId,
  accountId,
  projectId,
  locationId,
  address,
  jobNumber,
  lossType,
  allowAuthorization = true,
  compact = false,
  onOpenAll,
  refreshKey,
  onChanged,
  className,
  focusDocument = null,
  tmJob = false,
  fieldTicketJob = false,
}: {
  jobId?: string | null;
  accountId?: string | null;
  projectId?: string | null;
  locationId: string;
  address: string;
  jobNumber?: string | null;
  lossType?: string | null;
  allowAuthorization?: boolean;
  /** Newest few rows, a count and a way in — see above. */
  compact?: boolean;
  /** Compact only: what "All documents" opens. */
  onOpenAll?: () => void;
  /** Change to re-read the list, e.g. after the full panel closed. */
  refreshKey?: unknown;
  /** Called after a document is added here, so a timeline can refresh. */
  onChanged?: () => void;
  className?: string;
  /** A document to open in the viewer — History's "Open record". */
  focusDocument?: RecordFocus | null;
  /**
   * A T&M job: its three daily folders (Daily Sign-In, Daily Crew Chief,
   * Daily Supply List) are made, or renamed from their old names, before the
   * folders are listed — David, 20 Oct. See ensureTmJobFolders.
   */
  tmJob?: boolean;
  /**
   * A job that files daily field work tickets (self-pay and every other
   * non-T&M type): its "Daily Field Forms" folder is made the same way —
   * David, 21 Oct. See ensureDailyFieldFormsFolder.
   */
  fieldTicketJob?: boolean;
}) {
  const app = useAppContext();
  const disabled = app.writesDisabled;
  const [rows, setRows] = useState<DocumentRow[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [signOpen, setSignOpen] = useState(false);
  const [uploadType, setUploadType] = useState<DocumentType>("contract");
  const [genOpen, setGenOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  /** The open folder, merged into one PDF (David, 13 Oct). */
  const [folderPdf, setFolderPdf] = useState<{
    title: string;
    filename: string;
    bytes: Uint8Array;
  } | null>(null);
  const [mergingFolder, setMergingFolder] = useState(false);
  /**
   * David, 21 Oct: tick several PDFs and print them in one go. 12 Nov: every
   * row has a box (paper scans filed as images too), and the same ticks are
   * what "Delete selected" acts on. The ids ticked, across folders — the
   * print runs in the order the list shows.
   */
  const [printPick, setPrintPick] = useState<Set<string>>(() => new Set());
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  /** documents_delete: a manager of this office or an owner/admin; null while asking. */
  const managesDocuments = useManagesDocuments({
    roles: app.roles,
    userId: app.userId,
    locationId,
  });
  const [sendOpen, setSendOpen] = useState(false);
  /** David, 15 Oct: a contract emailed to be signed — a filed one, or the type to generate. */
  const [emailDoc, setEmailDoc] = useState<{ id: string; name: string } | null>(null);
  const [sendPreset, setSendPreset] = useState<readonly string[] | undefined>(undefined);
  const [formLinkOpen, setFormLinkOpen] = useState(false);
  const [packets, setPackets] = useState<PacketWithItems[]>([]);
  /** user_id → name, for every author on this tab. One read, not one per row. */
  const [people, setPeople] = useState<PersonNames>(() => new Map());
  /** False when the database has no `created_by` to read; the row then omits who. */
  const [uploaders, setUploaders] = useState(true);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [expiry, setExpiry] = useState("");
  const [busy, setBusy] = useState(false);
  const [viewing, setViewing] = useState<ViewerDocument | null>(null);
  const [view, setView] = useState<"list" | "tiles">("list");
  /** null means the folders migration has not been applied yet. */
  const [folders, setFolders] = useState<DocumentFolder[] | null>(null);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<FolderDialogState | null>(null);
  const [folderName, setFolderName] = useState("");
  /** The job whose daily folders (T&M or field forms) were made on this mount. */
  const tmFoldersFor = useRef<string | null>(null);

  const scope: DocumentScope = useMemo(
    () => ({
      locationId,
      jobId: jobId ?? null,
      accountId: accountId ?? null,
      projectId: projectId ?? null,
    }),
    [locationId, jobId, accountId, projectId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    let docs: DocumentRow[] = [];
    let requests: PacketWithItems[] = [];
    try {
      const res = await listDocuments(scope);
      docs = res.rows;
      setRows(res.rows);
      setUploaders(res.uploaders);
      setLoadError(null);
      if (
        res.folders &&
        (tmJob || fieldTicketJob) &&
        scope.jobId &&
        !disabled &&
        tmFoldersFor.current !== scope.jobId
      ) {
        tmFoldersFor.current = scope.jobId;
        const { ensureTmJobFolders, ensureDailyFieldFormsFolder } = await import("@/lib/tm-forms");
        if (tmJob) await ensureTmJobFolders(scope, app.userId ?? null);
        else await ensureDailyFieldFormsFolder(scope, app.userId ?? null);
      }
      setFolders(res.folders ? ((await listDocumentFolders(scope)) ?? []) : null);
    } catch (e) {
      // A failed query must never look like "no documents".
      setLoadError(e);
      toastDbError(e, { action: "Load documents" });
    }
    if (scope.jobId) {
      try {
        requests = await listPacketsForJob(scope.jobId);
        setPackets(requests);
      } catch (e) {
        toastDbError(e, { action: "Load signature requests" });
      }
    }
    // One profiles read for the whole tab — documents and signature requests
    // together — rather than a lookup per row.
    setPeople(
      await listDocumentPeople([
        ...docs.map((d) => d.created_by),
        ...requests.map((p) => p.created_by),
      ]),
    );
    setLoading(false);
  }, [scope, tmJob, fieldTicketJob, disabled, app.userId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const fileInput = useRef<HTMLInputElement>(null);

  /*
   * One file up: stored, thumbnailed and filed into the open folder. Throws
   * on a failed save so a run of several can count it; a failed filing into
   * the folder is reported and the document still counts as added.
   */
  const uploadOne = async (file: File) => {
    const uploaded = await uploadDocumentFile({
      file,
      scope,
      docType: uploadType,
      userId: app.userId ?? null,
      expiryDate: expiry || null,
    });
    // The bytes are still in hand, so draw the tile's thumbnail now rather
    // than have the grid download the file again to make one. Not awaited:
    // a thumbnail that fails is an icon, never a failed upload, and the grid
    // waits on this same promise instead of starting a second one.
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
    if (folders && activeFolder) {
      try {
        await moveDocumentToFolder(uploaded.id, activeFolder);
      } catch (e) {
        toastDbError(e, { action: "File the upload" });
      }
    }
  };

  /*
   * FE2: the Upload button and the drop zone both come here, with one file or
   * several. They go up one after another so the progress line can say which
   * one is going and a failure names its file; the rest carry on.
   */
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const upload = async (files: File[]) => {
    if (disabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    if (!files.length) return;
    setBusy(true);
    let added = 0;
    for (const [i, file] of files.entries()) {
      setProgress({ done: i, total: files.length, current: file.name });
      try {
        await uploadOne(file);
        added += 1;
      } catch (e) {
        toastDbError(e, { action: `Save ${file.name}` });
      }
    }
    setProgress(null);
    setBusy(false);
    if (added) {
      toast.success(
        files.length === 1
          ? "Document added"
          : `${added} of ${files.length} document${files.length === 1 ? "" : "s"} added`,
      );
      setExpiry("");
    }
    void load();
    onChanged?.();
  };

  const move = async (documentId: string, folderId: string | null) => {
    try {
      assertWritesEnabled(disabled, app.writesDisabledReason);
      await moveDocumentToFolder(documentId, folderId);
      void load();
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
      void load();
    } catch (e) {
      toastDbError(e, { action: "Save folder" });
    } finally {
      setBusy(false);
    }
  };

  const nodes = folders ? flattenDocumentFolderTree(buildDocumentFolderTree(folders)) : [];

  const counts = useMemo(() => documentFolderCounts(rows), [rows]);

  // A folder view is inclusive of everything filed beneath it, the way the
  // photo rail behaves — a document one level down is still in that folder.
  const shown = useMemo(
    () => documentsInFolder(rows, folders, activeFolder),
    [rows, folders, activeFolder],
  );

  /**
   * David, 13 Oct: share a whole folder — every day's sign-in sheet, supply
   * list or field form — as one PDF. Oldest first, the order the days ran.
   * Each file comes through the same authorised route the viewer reads.
   */
  const combineFolder = async () => {
    const folder = folders?.find((f) => f.id === activeFolder);
    if (!folder) return;
    const inFolder = [...shown].sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!inFolder.length) return toast.error("Nothing filed in this folder yet.");
    await combineDocuments(inFolder, folder.name);
  };

  /**
   * The ticked documents as one file in the print viewer — the same merge the
   * folder button uses, so there is one way documents become one PDF. PDFs
   * and images go in; anything else is named on its "Not included" page.
   */
  const printSelected = async () => {
    const picked = selectedInOrder(rows, printPick);
    if (!picked.length) return;
    await combineDocuments(
      picked,
      jobNumber ? `Job ${jobNumber} — ${picked.length} documents` : `${picked.length} documents`,
    );
  };

  const combineDocuments = async (docs: DocumentRow[], title: string) => {
    setMergingFolder(true);
    try {
      const items = await Promise.all(
        docs.map(async (d) => {
          const kind = documentKind(d.name, d.mime);
          // Known not to go in: named on the last page without a download.
          const skipReason = printSkipReason(d);
          if (skipReason) return { name: d.name, kind, bytes: new Uint8Array(), skipReason };
          const res = await fetch(documentFileUrl(d.id), { credentials: "same-origin" });
          if (!res.ok) throw new Error(`${d.name} could not be read (${res.status}).`);
          return {
            name: d.name,
            kind,
            bytes: new Uint8Array(await res.arrayBuffer()),
          };
        }),
      );
      const { mergeFolderPdf, folderPdfFilename } = await import("@/lib/document-folder-pdf");
      const merged = await mergeFolderPdf({ title, items });
      setFolderPdf({
        title,
        filename: folderPdfFilename(title),
        bytes: merged.bytes,
      });
      if (merged.skipped.length) {
        toast.warning(
          `${merged.skipped.length} file${merged.skipped.length === 1 ? "" : "s"} could not go in the PDF`,
          { description: "They are listed on its last page." },
        );
      }
    } catch (e) {
      toast.error("Could not make the combined PDF", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setMergingFolder(false);
    }
  };

  const togglePrint = (id: string, on: boolean) =>
    setPrintPick((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /**
   * A tick box on every row (12 Nov: images too). The label around it is the
   * tap target — a full 44px on a phone, just the box on a desktop.
   */
  const printBox = (d: DocumentRow, className?: string) => (
    <label
      className={cn(
        "-my-2 -ml-2 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center sm:m-0 sm:size-auto",
        className,
      )}
      title="Select to print or delete with others"
    >
      <Checkbox
        checked={printPick.has(d.id)}
        onCheckedChange={(v) => togglePrint(d.id, v === true)}
        aria-label={`Select ${d.name}`}
      />
    </label>
  );

  // A tick on a document that has left the record (deleted here or elsewhere) goes too.
  useEffect(() => {
    setPrintPick((prev) => {
      const next = pruneSelection(prev, rows);
      return next.size === prev.size ? prev : next;
    });
  }, [rows]);

  /** The ticked documents, in list order — what Print and Delete act on. */
  const picked = useMemo(() => selectedInOrder(rows, printPick), [rows, printPick]);
  const pickedSplit = useMemo(() => partitionForDelete(picked), [picked]);
  const allShown = selectAllState(shown, printPick);
  const canDelete = managesDocuments === true;

  const deleteSelected = async () => {
    if (disabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    const ids = pickedSplit.deletable.map((d) => d.id);
    if (!ids.length) return;
    setDeleting(true);
    try {
      const result = await deleteDocuments(ids, { userId: app.userId ?? null });
      // Signed ones never went to the database, so count them here.
      const signed = [
        ...pickedSplit.signed.map(({ id, name }) => ({ id, name })),
        ...result.signed,
      ];
      toastDeleteSummary(deleteSummary({ ...result, signed }));
      const gone = new Set(result.deleted.map((d) => d.id));
      setPrintPick((prev) => new Set([...prev].filter((id) => !gone.has(id))));
      if (viewing && gone.has(viewing.id)) setViewing(null);
      setDeleteOpen(false);
      if (result.deleted.length) onChanged?.();
    } catch (e) {
      toastDbError(e, { action: "Delete documents" });
    } finally {
      setDeleting(false);
      void load();
    }
  };

  // Counted over every document on the record, not the filtered folder view —
  // a signature owed does not stop being owed because you clicked a folder.
  const waiting = useMemo(() => countWaitingSignatures(rows), [rows]);

  const viewerDoc = (d: DocumentRow): ViewerDocument => toViewerDocument(d);

  /*
   * History's "Open record" on a document: open it in the viewer once the
   * list has it, once per request. Folders are cleared so the row is on show
   * behind the viewer too.
   */
  const openedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!focusDocument || openedFor.current === focusDocument.at) return;
    const d = rows.find((r) => r.id === focusDocument.id);
    if (!d) return;
    openedFor.current = focusDocument.at;
    setActiveFolder(null);
    setViewing(toViewerDocument(d));
  }, [focusDocument, rows]);

  const verify = async (d: DocumentRow) => {
    setVerifying(d.id);
    const verdict = await verifyDocumentHash(d);
    setVerifying(null);
    if (verdict.state === "ok") toast.success("File matches its recorded hash");
    else if (verdict.state === "mismatch")
      toast.error("Hash mismatch — this file has changed since it was locked", {
        description: "Treat it as unreliable evidence and re-issue.",
      });
    else if (verdict.state === "unhashed") toast.message("No hash recorded for this document");
    else toast.error(verdict.reason);
  };

  /** The row's "Email to sign": only a document with wording the signing page can show. */
  const emailToSign = async (d: DocumentRow) => {
    const { data, error } = await supabase
      .from("documents")
      .select("rendered_body")
      .eq("id", d.id)
      .maybeSingle();
    if (error) return toastDbError(error, { action: "Open the document" });
    if (!canEmailToSign({ ...d, rendered_body: data?.rendered_body ?? null })) {
      toast.error("This document cannot be signed online", {
        description:
          "It has no wording for the signing page (an uploaded file). Use More › Send for signature to send it from a template.",
      });
      return;
    }
    setEmailDoc({ id: d.id, name: d.name });
  };

  const moveMenu = (d: DocumentRow) =>
    folders && folders.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            title="File into a folder"
            disabled={disabled}
          >
            <MoveRight className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            File into
          </DropdownMenuLabel>
          <DropdownMenuItem
            disabled={disabled || !d.folder_id}
            onClick={() => void move(d.id, null)}
          >
            Top level
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {nodes.map((n) => (
            <DropdownMenuItem
              key={n.id}
              disabled={disabled || n.id === d.folder_id}
              onClick={() => void move(d.id, n.id)}
            >
              <span style={{ paddingLeft: `${n.depth * 10}px` }}>{n.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null;

  /**
   * "13 days ago · David Stern", with the exact stamp on hover. The same line
   * in both views and under a signature request, so the answer to "who put
   * this here" never depends on which toggle you happen to be on.
   */
  const metaText = (
    createdAt: string | null,
    createdBy: string | null,
    opts?: { uploaderKnown?: boolean; verb?: string },
  ) => {
    const meta = metadataLine(createdAt, createdBy, people, opts);
    if (!meta) return null;
    return (
      <span
        className="block w-full truncate text-[11px] font-normal text-muted-foreground"
        title={meta.title}
      >
        {meta.text}
      </span>
    );
  };

  const dragProps = (d: DocumentRow) => ({
    draggable: !!folders && !disabled,
    onDragStart: (e: React.DragEvent) => e.dataTransfer.setData("text/document-id", d.id),
  });

  /*
    Upload is the action people reach for most, so it is the primary button
    and no longer buried under the list. Its two settings live in the popover
    beside it, which doubles as the label for what the next upload will be
    filed as. Both headers — full and compact — use these same two elements.
  */
  const uploadButton = (
    <Button asChild size="sm" variant={compact ? "outline" : "default"} disabled={disabled || busy}>
      <label className={cn("cursor-pointer", compact && "h-8")}>
        <Upload className="mr-1.5 h-4 w-4" />
        {busy ? "Uploading…" : "Upload"}
        <input
          ref={fileInput}
          type="file"
          multiple
          className="hidden"
          disabled={disabled || busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            void upload(files);
          }}
        />
      </label>
    </Button>
  );

  const uploadTypePopover = (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn("max-w-44", compact && "h-8 max-w-32")}
          title="What the next upload is filed as"
        >
          <span className="truncate">{DOCUMENT_TYPE_LABEL[uploadType]}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <p className="text-xs text-muted-foreground">Applies to the next upload.</p>
        <div className="space-y-1">
          <Label className="text-xs">Type</Label>
          <Select value={uploadType} onValueChange={(v) => setUploadType(v as DocumentType)}>
            <SelectTrigger className="h-9">
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
        </div>
        {/* Expiry is a real field on a COI or a W9 and dead UI on a photo report. */}
        {EXPIRING_DOCUMENT_TYPES.has(uploadType) && (
          <div className="space-y-1">
            <Label className="text-xs">Expiry (optional)</Label>
            <Input
              type="date"
              className="h-9"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );

  if (compact) {
    const recent = recentDocuments(rows, RECENT_DOCUMENT_ROWS);
    const hidden = hiddenDocumentsLabel(rows.length, recent.length);
    return (
      <section
        aria-label="Documents"
        className={cn("rounded-xl border bg-card px-4 py-3", className)}
      >
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <FileText className="size-4 shrink-0 text-primary" />
          <h2 className="text-[13px] font-semibold text-foreground">Documents</h2>
          {!loading && !loadError && (
            <span className="text-[12px] tabular-nums text-muted-foreground">· {rows.length}</span>
          )}
          {/* Same helper as the full panel and the tab count: one meaning of "waiting". */}
          {!loading && !loadError && waiting > 0 && (
            <span className="text-[11px] font-medium text-destructive">
              {waiting} awaiting signature
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            {uploadTypePopover}
            {uploadButton}
          </div>
        </header>

        <div className="mt-2">
          {loading ? (
            <p className="py-1.5 text-[12.5px] text-muted-foreground">Loading…</p>
          ) : loadError ? (
            // A failed read is not an empty record; it says so and offers a retry.
            <div className="flex items-center justify-between gap-2 py-1.5 text-[12.5px]">
              <span className="text-destructive">Documents could not be loaded.</span>
              <Button size="sm" variant="outline" className="h-8" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : recent.length === 0 ? (
            <p className="py-1.5 text-[12.5px] text-muted-foreground">
              No documents yet. Proposals, contracts sent for signature and intake forms appear
              here.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {recent.map((d) => {
                const meta = metadataLine(d.created_at, d.created_by, people, {
                  uploaderKnown: uploaders,
                });
                const kind = DOCUMENT_TYPE_LABEL[d.doc_type];
                return (
                  <li key={d.id} className="flex items-center gap-2 py-1.5">
                    <button
                      type="button"
                      className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left"
                      onClick={() => setViewing(viewerDoc(d))}
                    >
                      <DocumentThumb doc={viewerDoc(d)} className="size-9" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium leading-tight hover:underline">
                          {d.name}
                        </span>
                        <span
                          className="block truncate text-[11px] text-muted-foreground"
                          title={meta ? `${kind} · ${meta.title}` : kind}
                        >
                          {kind}
                          {meta ? ` · ${meta.text}` : ""}
                        </span>
                      </span>
                    </button>
                    <DocumentStatusBadge doc={d} className="max-w-[45%] shrink-0" />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="mt-1 flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-[12px] text-muted-foreground">
          <span>{loading || loadError ? "" : (hidden ?? documentCountLabel(rows.length))}</span>
          {onOpenAll && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 shrink-0 px-2 text-[12.5px] font-medium text-primary"
              onClick={onOpenAll}
            >
              All documents
              <ChevronRight className="ml-0.5 size-3.5" />
            </Button>
          )}
        </footer>

        <DocumentViewer doc={viewing} onOpenChange={(open) => !open && setViewing(null)} />
      </section>
    );
  }

  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Documents</CardTitle>
        <div className="flex items-center gap-2">
          {uploadButton}
          {uploadTypePopover}
          {allowAuthorization && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSignOpen(true)}
              disabled={disabled}
            >
              <FileSignature className="mr-1.5 h-4 w-4" />
              Sign work authorization
            </Button>
          )}
          {/* Generating, sending and form links are occasional; they move here. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="size-8" title="More document actions">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled={disabled} onClick={() => setGenOpen(true)}>
                <Sparkles className="mr-2 size-4" />
                From template
              </DropdownMenuItem>
              {/* A job pulls company-wide papers (COI, W-9, contracts) in from
                  the main Documents section — David, 12 Oct. */}
              {jobId && (
                <DropdownMenuItem disabled={disabled} onClick={() => setCompanyOpen(true)}>
                  <Building2 className="mr-2 size-4" />
                  From company documents
                </DropdownMenuItem>
              )}
              {jobId && (
                <DropdownMenuItem disabled={disabled} onClick={() => setFormLinkOpen(true)}>
                  <Link2 className="mr-2 size-4" />
                  Form link
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={disabled}
                onClick={() => {
                  setSendPreset(undefined);
                  setSendOpen(true);
                }}
              >
                <Send className="mr-2 size-4" />
                Send for signature
              </DropdownMenuItem>
              {allowAuthorization && (
                <DropdownMenuItem
                  disabled={disabled}
                  onClick={() => {
                    setSendPreset(["work_authorization"]);
                    setSendOpen(true);
                  }}
                >
                  <Mail className="mr-2 size-4" />
                  Email work authorization to sign
                </DropdownMenuItem>
              )}
              {folders && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    disabled={disabled}
                    onClick={() => {
                      setFolderDialog({ mode: "new", parent: activeFolder });
                      setFolderName("");
                    }}
                  >
                    <FolderPlus className="mr-2 size-4" />
                    New folder
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <DocumentDropzone
          onFiles={(files) => void upload(files)}
          disabled={disabled}
          progress={progress}
        />

        {folders === null && !loading && !loadError && (
          <p className="border-l-2 border-muted-foreground/40 px-2 py-1 text-xs text-muted-foreground">
            Folders need a database update before they can be used — the migration that adds
            <code className="mx-1">document_folders</code> and
            <code className="mx-1">documents.folder_id</code> has not been applied yet. Every
            document is listed below in the meantime; nothing is hidden.
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          {!loading && !loadError && shown.length > 0 && (
            <label
              className="-my-2 -ml-1 inline-flex h-11 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-foreground sm:my-0 sm:h-7"
              title="Select every document shown here"
            >
              <Checkbox
                checked={allShown}
                onCheckedChange={(v) =>
                  setPrintPick((prev) => toggleAllShown(shown, prev, v === true))
                }
                aria-label={
                  activeFolder ? "Select all documents in this folder" : "Select all documents"
                }
              />
              <span className="sr-only sm:not-sr-only">All</span>
            </label>
          )}
          <span className="text-xs text-muted-foreground">
            {loading
              ? "Loading…"
              : loadError
                ? "Could not load documents"
                : `${shown.length} document${shown.length === 1 ? "" : "s"}`}
            {/* Same helper as the tab count and the global list, so the three
                can never disagree about what "waiting" means. */}
            {!loading && !loadError && waiting > 0 && (
              <span className="ml-2 font-medium text-destructive">
                {waiting} awaiting signature
              </span>
            )}
          </span>
          {printPick.size > 0 && (
            <span className="ml-auto flex flex-wrap items-center gap-1">
              <Button
                size="sm"
                className="h-11 text-xs sm:h-7"
                disabled={mergingFolder}
                title="The ticked PDFs and images, in list order, as one file ready to print"
                onClick={() => void printSelected()}
              >
                <Printer className="mr-1 size-3.5" />
                {mergingFolder ? "Combining…" : `Print ${printPick.size} selected`}
              </Button>
              {/* documents_delete: managers of this office and owners/admins only. */}
              {canDelete && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 text-xs sm:h-7"
                  disabled={disabled || deleting || picked.length === 0}
                  title={
                    disabled
                      ? (app.writesDisabledReason ?? "Writes disabled")
                      : "Delete the ticked documents, after a confirmation"
                  }
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 className="mr-1 size-3.5 text-destructive" />
                  {`Delete ${picked.length} selected`}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="h-11 text-xs sm:h-7"
                onClick={() => setPrintPick(new Set())}
              >
                Clear
              </Button>
            </span>
          )}
          {activeFolder && folders && shown.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className={cn("h-7 text-xs", printPick.size === 0 && "ml-auto")}
              disabled={mergingFolder}
              title="Every document in this folder, oldest first, as one PDF to download or share"
              onClick={() => void combineFolder()}
            >
              <FileText className="mr-1 size-3.5" />
              {mergingFolder ? "Combining…" : `Combine ${shown.length} into one PDF`}
            </Button>
          )}
          <div className="flex items-center rounded-sm border">
            <Button
              size="icon"
              variant="ghost"
              aria-label="List view"
              className={cn("size-7 rounded-none", view === "list" && "bg-muted")}
              onClick={() => setView("list")}
            >
              <List className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Tile view"
              className={cn("size-7 rounded-none", view === "tiles" && "bg-muted")}
              onClick={() => setView("tiles")}
            >
              <LayoutGrid className="size-4" />
            </Button>
          </div>
        </div>

        <div className="flex gap-3">
          {folders && (
            <DocumentFolderRail
              nodes={nodes}
              counts={counts}
              rootCount={rows.length}
              active={activeFolder}
              disabled={disabled}
              onSelect={setActiveFolder}
              onDropDocument={(folderId, documentId) => void move(documentId, folderId)}
              onNew={(parent) => {
                setFolderDialog({ mode: "new", parent });
                setFolderName("");
              }}
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
                  void load();
                } catch (e) {
                  toastDbError(e, { action: "Delete folder" });
                }
              }}
            />
          )}

          <div className="min-w-0 flex-1 space-y-3">
            {loading ? (
              <div className="text-sm text-muted-foreground">Loading…</div>
            ) : loadError ? (
              <div className="space-y-2 rounded-sm border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <div className="font-medium">Documents could not be loaded</div>
                <p className="text-xs text-muted-foreground">
                  This is a failed query, not an empty record — nothing has been deleted.
                </p>
                <Button size="sm" variant="outline" onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            ) : shown.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                {activeFolder
                  ? "Nothing filed in this folder yet."
                  : "No documents yet. Signed work authorizations, COIs, W9s and carrier correspondence appear here."}
              </div>
            ) : view === "tiles" ? (
              <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {shown.map((d) => (
                  <li
                    key={d.id}
                    {...dragProps(d)}
                    className="relative flex flex-col gap-2 rounded-sm border p-2"
                  >
                    <span className="absolute left-1 top-1 z-10 rounded-sm bg-background/90 sm:left-2 sm:top-2">
                      {printBox(d, "m-0 sm:p-0.5")}
                    </span>
                    <button
                      className="flex w-full min-w-0 flex-col items-center gap-1 text-center"
                      onClick={() => setViewing(viewerDoc(d))}
                    >
                      <DocumentThumb doc={viewerDoc(d)} className="h-24 w-full" detailed />
                      <span className="line-clamp-2 w-full text-xs font-medium">{d.name}</span>
                      {metaText(d.created_at, d.created_by, { uploaderKnown: uploaders })}
                    </button>
                    <div className="flex items-center justify-between gap-1">
                      <DocumentStatusBadge doc={d} className="min-w-0" />
                      <span className="flex items-center">
                        {d.content_hash && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="size-7"
                            title="Verify the stored file still matches its recorded hash"
                            disabled={verifying === d.id}
                            onClick={() => void verify(d)}
                          >
                            <ShieldCheck
                              className={cn(
                                "size-4",
                                d.locked_at ? "text-success" : "text-muted-foreground",
                              )}
                            />
                          </Button>
                        )}
                        {moveMenu(d)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <ul className="divide-y rounded-sm border">
                {shown.map((d) => (
                  <li
                    key={d.id}
                    {...dragProps(d)}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    {printBox(d)}
                    <button
                      className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                      onClick={() => setViewing(viewerDoc(d))}
                    >
                      <DocumentThumb doc={viewerDoc(d)} />
                      {/*
                        Two lines rather than one: the filing metadata would
                        push the name out of a tablet-width row if it sat
                        beside it, and the name is what people scan for.
                      */}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate hover:underline">
                          {d.name}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {DOCUMENT_TYPE_LABEL[d.doc_type]}
                            {d.expiry_date ? ` · expires ${d.expiry_date}` : ""}
                          </span>
                        </span>
                        {metaText(d.created_at, d.created_by, { uploaderKnown: uploaders })}
                      </span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      {d.content_hash && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          title="Verify the stored file still matches its recorded hash"
                          disabled={verifying === d.id}
                          onClick={() => void verify(d)}
                        >
                          <ShieldCheck
                            className={cn(
                              "size-4",
                              d.locked_at ? "text-success" : "text-muted-foreground",
                            )}
                          />
                        </Button>
                      )}
                      {offerEmailToSign(d) && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          title="Email to sign"
                          aria-label={`Email ${d.name} to sign`}
                          disabled={disabled}
                          onClick={() => void emailToSign(d)}
                        >
                          <Mail className="size-4" />
                        </Button>
                      )}
                      {moveMenu(d)}
                      <DocumentStatusBadge doc={d} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {packets.length > 0 && (
          <div className="space-y-2 border-t pt-3">
            <div className="text-xs font-medium text-muted-foreground">
              Form links &amp; signature requests
            </div>
            <ul className="divide-y rounded-sm border">
              {packets.map((p) => {
                const state = packetState(p);
                const outstanding = daysOutstanding(p);
                const overdue =
                  state !== "completed" && outstanding !== null && outstanding >= p.reminder_days;
                return (
                  <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        {p.recipient_name ?? p.recipient_email ?? "Shareable form link"}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {p.items.length} document{p.items.length === 1 ? "" : "s"}
                          {p.single_use === false ? " · reusable" : " · single use"}
                          {overdue ? ` · unsigned ${outstanding} days` : ""}
                        </span>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{p.subject}</div>
                      {/*
                        Who asked for a signature is the same question as who
                        uploaded a document, so it is answered in the same
                        words and the same place.
                      */}
                      {metaText(p.created_at, p.created_by, { verb: "Requested" })}
                    </div>
                    <Badge className={PACKET_STATE_TONE[state]}>{PACKET_STATE_LABEL[state]}</Badge>
                    {state !== "completed" && state !== "revoked" && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          title={
                            disabled
                              ? (app.writesDisabledReason ?? undefined)
                              : "Copy the secure signing link"
                          }
                          disabled={disabled}
                          onClick={() => {
                            assertWritesEnabled(disabled, app.writesDisabledReason);
                            void navigator.clipboard.writeText(signUrl(p.token));
                            void markFormLinkSent(p.id).then(load);
                            toast.success("Link copied");
                          }}
                        >
                          <Copy className="size-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={disabled}
                          onClick={async () => {
                            try {
                              assertWritesEnabled(disabled, app.writesDisabledReason);
                              await revokePacket(p.id);
                              toast.success("Request withdrawn");
                              void load();
                            } catch (e) {
                              toastDbError(e, { action: "Withdraw request" });
                            }
                          }}
                        >
                          Withdraw
                        </Button>
                      </>
                    )}
                    {state !== "completed" && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7"
                        title="Retire this link and mint a fresh one"
                        disabled={disabled}
                        onClick={async () => {
                          try {
                            assertWritesEnabled(disabled, app.writesDisabledReason);
                            const res = await regenerateFormLink(p, app.userId ?? null);
                            void navigator.clipboard.writeText(res.url);
                            toast.success("New link created and copied");
                            void load();
                          } catch (e) {
                            toastDbError(e, { action: "Regenerate link" });
                          }
                        }}
                      >
                        <RefreshCw className="size-4" />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </CardContent>

      <DocumentViewer doc={viewing} onOpenChange={(open) => !open && setViewing(null)} />

      <DocumentFolderDialog
        state={folderDialog}
        name={folderName}
        onNameChange={setFolderName}
        onCancel={() => setFolderDialog(null)}
        onSubmit={() => void submitFolder()}
        disabled={disabled || busy}
      />

      {jobId && (
        <FormLinkDialog
          open={formLinkOpen}
          onOpenChange={setFormLinkOpen}
          jobId={jobId}
          locationId={locationId}
          onCreated={load}
        />
      )}
      <DocumentSendDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        jobId={jobId ?? null}
        accountId={accountId ?? null}
        locationId={locationId}
        onSent={load}
        presetDocTypes={sendPreset}
      />
      <DocumentSendDialog
        open={!!emailDoc}
        onOpenChange={(v) => !v && setEmailDoc(null)}
        jobId={jobId ?? null}
        accountId={accountId ?? null}
        locationId={locationId}
        onSent={load}
        existingDocument={emailDoc}
      />

      {canDelete && (
        <ConfirmDeleteDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title={
            pickedSplit.deletable.length
              ? `Delete ${pickedSplit.deletable.length} document${pickedSplit.deletable.length === 1 ? "" : "s"}?`
              : "Nothing to delete"
          }
          description={
            pickedSplit.deletable.length ? (
              <p>
                This permanently deletes{" "}
                {pickedSplit.deletable.length === 1 ? "it and its file" : "them and their files"}{" "}
                from this record. It cannot be undone.
              </p>
            ) : (
              <p>Every document you ticked is signed.</p>
            )
          }
          confirmLabel={deleting ? "Deleting…" : "Delete permanently"}
          busy={deleting}
          disabled={pickedSplit.deletable.length === 0 || disabled}
          onConfirm={() => void deleteSelected()}
        >
          {pickedSplit.deletable.length > 0 && (
            <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-[13px]">
              {pickedSplit.deletable.slice(0, 8).map((d) => (
                <li key={d.id} className="break-words">
                  {d.name}
                </li>
              ))}
              {pickedSplit.deletable.length > 8 && (
                <li className="list-none text-muted-foreground">
                  and {pickedSplit.deletable.length - 8} more
                </li>
              )}
            </ul>
          )}
          {pickedSplit.signed.length > 0 && (
            <Alert variant="warning">
              <AlertDescription>
                {pickedSplit.signed.length} signed document
                {pickedSplit.signed.length === 1 ? " is" : "s are"} kept — signed documents
                can&rsquo;t be deleted. They are the signed record.
              </AlertDescription>
            </Alert>
          )}
          {pickedSplit.deletable.length > 0 && (
            <p className="text-xs text-muted-foreground">
              A room sketch drawn on one of them is deleted with it. T&amp;M forms, field tickets
              and reports that link to one keep their own record, without the file.
            </p>
          )}
        </ConfirmDeleteDialog>
      )}

      {folderPdf && (
        <PdfPreviewDialog
          open
          onOpenChange={(v) => !v && setFolderPdf(null)}
          title={folderPdf.title}
          bytes={folderPdf.bytes}
          filename={folderPdf.filename}
        />
      )}

      {jobId && (
        <CompanyDocumentPicker
          open={companyOpen}
          onOpenChange={setCompanyOpen}
          scope={scope}
          userId={app.userId ?? null}
          onAdded={async (id) => {
            if (activeFolder && folders) await moveDocumentToFolder(id, activeFolder);
            await load();
          }}
        />
      )}

      <GenerateFromTemplateDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        jobId={jobId ?? null}
        accountId={accountId ?? null}
        projectId={projectId ?? null}
        locationId={locationId}
        onGenerated={load}
      />

      {allowAuthorization && (
        <WorkAuthorizationDialog
          open={signOpen}
          onOpenChange={setSignOpen}
          target={{
            jobId: jobId ?? null,
            accountId: accountId ?? null,
            locationId,
            address,
            jobNumber: jobNumber ?? null,
            lossType: lossType ?? null,
            folderId: folders ? activeFolder : null,
          }}
          onSigned={load}
          onEmailInstead={() => {
            setSignOpen(false);
            setSendPreset(["work_authorization"]);
            setSendOpen(true);
          }}
        />
      )}
    </Card>
  );
}
