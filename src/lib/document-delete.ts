/**
 * Deleting documents from a job's Documents tab — and image documents from
 * its Pictures tab — after a confirmation (12 Nov: "we can also delete
 * document after confirmation").
 *
 * WHO. `documents_delete` is `status <> 'signed' AND
 * can_manage_location(auth.uid(), location_id)`: a manager of the office (or
 * an owner/admin), never for a signed document. The buttons ask the same
 * function (`useManagesDocuments`), so Delete is not offered to someone the
 * database would refuse, and `deleteDocuments` re-reads each row's status and
 * asks it again per office before touching anything.
 *
 * SIGNED IS KEPT. A signed document is the evidence trail in a coverage
 * dispute; the policy refuses it and so does the storage policy on its file.
 * They are skipped and said so, never counted as failures.
 *
 * WHAT GOES WITH A ROW (every FK onto documents, from supabase/migrations):
 *   ON DELETE CASCADE — document_events, document_signatures,
 *     document_send_items (the row's place in a signature request) and
 *     job_room_sketches (a room sketch IS its image document).
 *   ON DELETE SET NULL — field_work_tickets, job_tm_forms, job_reports,
 *     record_revisions, account_proposals, certificate_sends,
 *     invoice_payments: the record stays and just loses its link to the file.
 *   Nothing RESTRICTs, so a refused delete is a permission answer.
 *
 * THE FILE GOES FIRST. Every storage policy on the `documents` bucket grants
 * through the row (`can_access_document_object`: the path is the row's
 * `storage_path`, or under `<id>/` — the thumbnail, a signature image). Once
 * the row is gone nobody but the service role can remove its objects, and
 * `remove()` would answer "ok" having removed nothing. So, per document and
 * only after the same checks the row policy makes: remove its objects
 * (best effort — a failure is reported, the delete goes on), then delete the
 * row. If the row is then refused anyway the result says the file went and
 * the record stayed; Delete again finishes it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { describeDbError } from "@/lib/db-errors";
import { DOCUMENT_BUCKET, documentThumbPath } from "@/lib/documents";
import { isPrivileged, type AppRole } from "@/lib/roles";

type Db = typeof supabase;

export type DeleteCandidate = {
  id: string;
  name: string;
  status: string;
  location_id: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
};

export type DocumentDeleteFailure = { id: string; name: string; reason: string };

export type DocumentDeleteResult = {
  deleted: { id: string; name: string }[];
  /** Skipped: signed documents cannot be deleted. */
  signed: { id: string; name: string }[];
  failed: DocumentDeleteFailure[];
  /** Deleted, but some of its stored files could not be removed. */
  fileLeftovers: { id: string; name: string }[];
};

export const SIGNED_KEPT_REASON =
  "Signed documents can't be deleted — they are the signed record, so they are kept.";
export const NOT_MANAGER_REASON =
  "Only a manager of this office (or an owner/admin) can delete it.";
export const GONE_REASON = "It is already gone, or you no longer have access to it.";

/** Signed documents stay; everything else may go. Keeps the input order. */
export function partitionForDelete<T extends { status: string }>(
  docs: readonly T[],
): { deletable: T[]; signed: T[] } {
  const deletable: T[] = [];
  const signed: T[] = [];
  for (const d of docs) (d.status === "signed" ? signed : deletable).push(d);
  return { deletable, signed };
}

/**
 * Every object a document owns in its bucket: the file itself and whatever is
 * under its `<id>/` sidecar folder (the thumbnail is always named, listed or
 * not — removing a path that does not exist is harmless). `sharedPaths` are
 * file paths another document still points at; those stay.
 */
export function storageObjectsOf(
  doc: Pick<DeleteCandidate, "id" | "storage_bucket" | "storage_path">,
  sidecarNames: readonly string[] = [],
  sharedPaths: ReadonlySet<string> = new Set(),
): { bucket: string; paths: string[] } {
  const paths = new Set<string>();
  if (doc.storage_path && !sharedPaths.has(doc.storage_path)) paths.add(doc.storage_path);
  paths.add(documentThumbPath(doc.id));
  for (const n of sidecarNames) if (n) paths.add(`${doc.id}/${n}`);
  return { bucket: doc.storage_bucket ?? DOCUMENT_BUCKET, paths: [...paths] };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What to tell the person afterwards: a headline and the detail, naming the
 * documents that failed and why. `tone` picks the toast.
 */
export function deleteSummary(
  r: DocumentDeleteResult,
  noun = "document",
): { tone: "success" | "warning" | "error"; title: string; description?: string } {
  const lines: string[] = [];
  if (r.signed.length)
    lines.push(
      `${plural(r.signed.length, `signed ${noun}`)} kept — signed documents can't be deleted.`,
    );
  for (const f of r.failed) lines.push(`${f.name}: ${f.reason}`);
  if (r.fileLeftovers.length)
    lines.push(
      `The stored file for ${r.fileLeftovers.map((d) => d.name).join(", ")} could not be removed; the record is gone.`,
    );
  const description = lines.length ? lines.join("\n") : undefined;
  if (r.deleted.length === 0) {
    const title = r.failed.length
      ? `Could not delete ${plural(r.failed.length, noun)}`
      : `Nothing deleted`;
    return { tone: r.failed.length ? "error" : "warning", title, description };
  }
  const title = `${plural(r.deleted.length, noun)} deleted`;
  return {
    tone: r.failed.length || r.fileLeftovers.length ? "warning" : "success",
    title: r.failed.length ? `${title}, ${r.failed.length} not` : title,
    description,
  };
}

/**
 * The toast after a delete: success, a warning when some were kept or failed,
 * an error when nothing went. Failures stay up long enough to read the names.
 */
export function toastDeleteSummary(summary: ReturnType<typeof deleteSummary>): void {
  const show =
    summary.tone === "success"
      ? toast.success
      : summary.tone === "warning"
        ? toast.warning
        : toast.error;
  show(summary.title, {
    description: summary.description,
    classNames: { description: "whitespace-pre-line" },
    duration: summary.tone === "success" ? undefined : 12_000,
  });
}

async function managesLocation(db: Db, userId: string, locationId: string): Promise<boolean> {
  const { data, error } = await db.rpc("can_manage_location", {
    _user_id: userId,
    _location_id: locationId,
  });
  if (error) throw error;
  return data === true;
}

/**
 * Delete these documents (ids as stored — no `doc:` prefix). Signed ones are
 * skipped, and each other one either goes with its files or is named with the
 * reason it did not. Throws only when the documents could not be read at all.
 */
export async function deleteDocuments(
  ids: readonly string[],
  opts: { userId: string | null },
  db: Db = supabase,
): Promise<DocumentDeleteResult> {
  const result: DocumentDeleteResult = { deleted: [], signed: [], failed: [], fileLeftovers: [] };
  const unique = [...new Set(ids)];
  if (!unique.length) return result;

  // Fresh from the database: a document signed since the list loaded is kept.
  const { data, error } = await db
    .from("documents")
    .select("id, name, status, location_id, storage_bucket, storage_path")
    .in("id", unique);
  if (error) throw error;
  const rows = (data ?? []) as DeleteCandidate[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of unique)
    if (!byId.has(id)) result.failed.push({ id, name: "A document", reason: GONE_REASON });

  const ordered = unique.flatMap((id) => byId.get(id) ?? []);
  const { deletable, signed } = partitionForDelete(ordered);
  result.signed = signed.map(({ id, name }) => ({ id, name }));
  if (!deletable.length) return result;

  if (!opts.userId) {
    for (const d of deletable)
      result.failed.push({ id: d.id, name: d.name, reason: "Sign in again to delete documents." });
    return result;
  }

  // The policy's office check, asked once per office before any file is touched.
  const manages = new Map<string, boolean | string>();
  for (const loc of new Set(deletable.map((d) => d.location_id ?? ""))) {
    if (!loc) {
      manages.set(loc, false);
      continue;
    }
    try {
      manages.set(loc, await managesLocation(db, opts.userId, loc));
    } catch (e) {
      manages.set(loc, describeDbError(e, { action: "Checking your access" }));
    }
  }
  const allowed: DeleteCandidate[] = [];
  for (const d of deletable) {
    const m = manages.get(d.location_id ?? "");
    if (m === true) allowed.push(d);
    else
      result.failed.push({
        id: d.id,
        name: d.name,
        reason: typeof m === "string" ? m : NOT_MANAGER_REASON,
      });
  }
  if (!allowed.length) return result;

  // A file path another document still points at (should not happen — every
  // copy gets its own path — but a shared file must outlive this delete).
  const allowedIds = new Set(allowed.map((d) => d.id));
  const filePaths = allowed.flatMap((d) => (d.storage_path ? [d.storage_path] : []));
  const shared = new Set<string>();
  if (filePaths.length) {
    const { data: others } = await db
      .from("documents")
      .select("id, storage_path")
      .in("storage_path", filePaths);
    for (const o of (others ?? []) as { id: string; storage_path: string | null }[])
      if (!allowedIds.has(o.id) && o.storage_path) shared.add(o.storage_path);
  }

  for (const d of allowed) {
    const bucket = d.storage_bucket ?? DOCUMENT_BUCKET;
    let sidecars: string[] = [];
    try {
      const { data: listed } = await db.storage.from(bucket).list(d.id, { limit: 100 });
      sidecars = (listed ?? []).map((f) => f.name);
    } catch {
      // The thumbnail is named anyway; a listing is a bonus.
    }
    const objects = storageObjectsOf(d, sidecars, shared);
    let filesOk = true;
    try {
      const { error: rmErr } = await db.storage.from(objects.bucket).remove(objects.paths);
      if (rmErr) filesOk = false;
    } catch {
      filesOk = false;
    }

    const { data: gone, error: delErr } = await db
      .from("documents")
      .delete()
      .eq("id", d.id)
      .select("id");
    if (delErr || !gone?.length) {
      const why = delErr
        ? describeDbError(delErr, { action: "Delete" })
        : "The database refused it — it may have just been signed, or your access changed.";
      result.failed.push({
        id: d.id,
        name: d.name,
        reason: filesOk ? `${why} Its stored file was removed; Delete it again to finish.` : why,
      });
      continue;
    }
    result.deleted.push({ id: d.id, name: d.name });
    if (!filesOk) result.fileLeftovers.push({ id: d.id, name: d.name });
  }
  return result;
}

/**
 * Whether this person may delete documents in this office: true/false once
 * known, null while the check is out. Owners and admins are answered without
 * asking; anyone else is asked through the same `can_manage_location` the
 * delete policy uses. A failed check is a "no", never a stale yes.
 */
export function useManagesDocuments(input: {
  roles: readonly AppRole[] | undefined;
  userId: string | null | undefined;
  locationId: string | null | undefined;
}): boolean | null {
  const privileged = isPrivileged([...(input.roles ?? [])]);
  const { userId, locationId } = input;
  const [asked, setAsked] = useState<{ key: string; ok: boolean } | null>(null);
  const key = `${userId ?? ""}|${locationId ?? ""}`;
  useEffect(() => {
    if (privileged || !userId || !locationId) return;
    let alive = true;
    managesLocation(supabase, userId, locationId).then(
      (ok) => alive && setAsked({ key, ok }),
      () => alive && setAsked({ key, ok: false }),
    );
    return () => {
      alive = false;
    };
  }, [privileged, userId, locationId, key]);
  if (privileged) return true;
  if (!userId || !locationId) return false;
  return asked?.key === key ? asked.ok : null;
}
