import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { signStoredFile } from "@/lib/signed-url";
import type { DueKind } from "@/lib/vehicle-maintenance";

/**
 * The paper behind each vehicle date — the insurance card, the registration,
 * the inspection report — and the receipt behind each maintenance record.
 *
 * Same shape as compliance_requirement_files (src/lib/compliance-files.ts):
 * a renewal SUPERSEDES the current document rather than overwriting it, so
 * the card that was in the glovebox on the day of an accident is still on
 * file after the renewal lands. The supersede happens in the database
 * (tg_vehicle_documents_supersede), in the same statement as the insert.
 *
 * Table and bucket ship in 20261005140000. Until that is applied every read
 * here reports `available: false` instead of throwing, and the vehicle page
 * hides the attach controls — the dates and the log keep working.
 */

export const VEHICLE_DOCUMENT_BUCKET = "vehicle-documents";
export const VEHICLE_DOCUMENT_MAX_BYTES = 15 * 1024 * 1024;
export const VEHICLE_DOCUMENT_ACCEPT =
  "image/png,image/jpeg,image/webp,image/heic,image/heif,application/pdf";

export type VehicleDocument = {
  id: string;
  vehicle_id: string;
  due_kind: DueKind | null;
  maintenance_record_id: string | null;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  is_current: boolean;
  superseded_at: string | null;
  created_at: string;
};

const SELECT =
  "id, vehicle_id, due_kind, maintenance_record_id, storage_path, file_name, mime_type, size_bytes, is_current, superseded_at, created_at";

function safeName(name: string) {
  return name.replace(/[^\w.-]+/g, "_").slice(-80) || "document";
}

/**
 * {vehicle_id}/{kind | receipts}/{timestamp}-{name}. The first segment is
 * what the bucket's policies read, and the table refuses a row whose path
 * does not start with its own vehicle.
 */
export function vehicleDocumentPath(input: {
  vehicleId: string;
  dueKind: DueKind | null;
  fileName: string;
  at: number;
}): string {
  return `${input.vehicleId}/${input.dueKind ?? "receipts"}/${input.at}-${safeName(input.fileName)}`;
}

export async function fetchVehicleDocuments(
  vehicleId: string,
): Promise<{ available: boolean; docs: VehicleDocument[] }> {
  const { data, error } = await supabase
    .from("vehicle_documents" as never)
    .select(SELECT)
    .eq("vehicle_id", vehicleId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) {
    if (isMissingSchema(error)) return { available: false, docs: [] };
    throw error;
  }
  return { available: true, docs: (data ?? []) as unknown as VehicleDocument[] };
}

/** Upload the file, then file the row; a refused row takes its file with it. */
export async function uploadVehicleDocument(input: {
  vehicleId: string;
  dueKind: DueKind | null;
  maintenanceRecordId: string | null;
  file: File;
}): Promise<void> {
  if (input.file.size > VEHICLE_DOCUMENT_MAX_BYTES) {
    throw new Error("That file is over 15 MB. Take a photo instead, or attach a smaller PDF.");
  }
  const path = vehicleDocumentPath({
    vehicleId: input.vehicleId,
    dueKind: input.dueKind,
    fileName: input.file.name,
    at: Date.now(),
  });
  const up = await supabase.storage.from(VEHICLE_DOCUMENT_BUCKET).upload(path, input.file, {
    contentType: input.file.type || "application/octet-stream",
    upsert: false,
  });
  if (up.error) throw up.error;

  const { error } = await supabase.from("vehicle_documents" as never).insert({
    vehicle_id: input.vehicleId,
    due_kind: input.dueKind,
    maintenance_record_id: input.maintenanceRecordId,
    storage_path: path,
    file_name: input.file.name,
    mime_type: input.file.type || null,
    size_bytes: input.file.size,
  } as never);
  if (error) {
    await supabase.storage.from(VEHICLE_DOCUMENT_BUCKET).remove([path]);
    throw error;
  }
}

/** Ten minutes, the house default: long enough to open, short enough not to leak. */
export async function signedVehicleDocumentUrl(path: string): Promise<string | null> {
  const { data } = await signStoredFile(supabase, VEHICLE_DOCUMENT_BUCKET, path);
  return data?.signedUrl ?? null;
}

/**
 * Row first, then file. If the second step fails, an orphaned file nobody can
 * see is the harmless leftover; a row pointing at a deleted file would be a
 * dead link on the vehicle page.
 */
export async function removeVehicleDocuments(docs: readonly VehicleDocument[]): Promise<void> {
  if (!docs.length) return;
  const { error } = await supabase
    .from("vehicle_documents" as never)
    .delete()
    .in(
      "id",
      docs.map((d) => d.id),
    );
  if (error) throw error;
  await supabase.storage.from(VEHICLE_DOCUMENT_BUCKET).remove(docs.map((d) => d.storage_path));
}
