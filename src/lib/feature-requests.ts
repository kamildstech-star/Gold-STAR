// Internal suggestion board: types, labels, attachment upload and vote maths.
// Attachments live in the private "feature-requests" bucket; lists are always
// served a generated display variant, never the original bytes.

import { supabase } from "@/integrations/supabase/client";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";
import { signStoredFile, signStoredFiles, type SignedUrlLife } from "@/lib/signed-url";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { TONE } from "@/lib/tone";
export const FR_BUCKET = "feature-requests";

export type FrStatus = "new" | "reviewed" | "planned" | "in_progress" | "completed" | "dismissed";

export const FR_STATUSES: FrStatus[] = [
  "new",
  "reviewed",
  "planned",
  "in_progress",
  "completed",
  "dismissed",
];

export const FR_STATUS_LABEL: Record<FrStatus, string> = {
  new: "New",
  reviewed: "Reviewed",
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  dismissed: "Dismissed",
};

/** Badge classes — flat, 1px border, no shadow, per the density rules. */
export const FR_STATUS_CLASS: Record<FrStatus, string> = {
  new: TONE.brand,
  reviewed: TONE.neutral,
  planned: TONE.brand,
  in_progress: TONE.warning,
  completed: TONE.success,
  dismissed: `${TONE.neutral} line-through`,
};

export type FrPriority = "low" | "normal" | "high" | "urgent";
export const FR_PRIORITIES: FrPriority[] = ["low", "normal", "high", "urgent"];
export const FR_PRIORITY_LABEL: Record<FrPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export type FeatureRequest = {
  id: string;
  title: string;
  description: string;
  category: string;
  status: FrStatus;
  priority: FrPriority | null;
  submitted_by: string | null;
  submitter_name: string | null;
  submitter_role: string | null;
  submitter_job_title: string | null;
  submitter_location_id: string | null;
  submitter_location_name: string | null;
  dismissed_reason: string | null;
  dismissed_at: string | null;
  duplicate_of: string | null;
  created_at: string;
  updated_at: string;
};

export type FrAttachment = {
  id: string;
  request_id: string;
  storage_path: string;
  display_path: string | null;
  file_name: string | null;
  mime_type: string;
  byte_size: number | null;
  width: number | null;
  height: number | null;
  uploaded_by: string | null;
  created_at: string;
};

export type FrComment = {
  id: string;
  request_id: string;
  author: string | null;
  body: string;
  created_at: string;
};

export type FrHistory = {
  id: string;
  request_id: string;
  from_status: FrStatus | null;
  to_status: FrStatus;
  note: string | null;
  changed_by: string | null;
  created_at: string;
};

export type FrVote = { request_id: string; user_id: string };

export const ACCEPTED_TYPES = "image/*,application/pdf";

export function isImage(mime: string): boolean {
  return mime.startsWith("image/");
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "No role recorded";
  return ROLE_LABELS[role as AppRole] ?? role.replace(/_/g, " ");
}

/** One line of submitter context: who, what they do, where they work. */
export function submitterLine(r: FeatureRequest): string {
  const bits = [
    r.submitter_name?.trim() || "Unknown submitter",
    r.submitter_job_title?.trim() || roleLabel(r.submitter_role),
    r.submitter_location_name?.trim() || "No office recorded",
  ];
  return bits.join(" · ");
}

export function excerpt(text: string, max = 220): string {
  const flat = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------- Vote maths ----------

/**
 * Votes carried across merges: a request marked as a duplicate of another
 * contributes its voters to the surviving request, de-duplicated by person.
 */
export function voteIndex(requests: FeatureRequest[], votes: FrVote[]): Map<string, Set<string>> {
  const canonical = new Map<string, string>();
  for (const r of requests) canonical.set(r.id, r.duplicate_of ?? r.id);
  const out = new Map<string, Set<string>>();
  for (const r of requests) out.set(r.id, new Set());
  for (const v of votes) {
    const target = canonical.get(v.request_id) ?? v.request_id;
    if (!out.has(target)) out.set(target, new Set());
    out.get(target)!.add(v.user_id);
  }
  return out;
}

// ---------- Attachments ----------

type DisplayVariant = { blob: Blob; width: number; height: number };

async function makeDisplay(file: Blob, maxEdge = 1600): Promise<DisplayVariant | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/webp", 0.82),
    );
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    if (!blob) return null;
    return { blob, width: dims.width, height: dims.height };
  } catch {
    return null;
  }
}

function extOf(file: File): string {
  const fromName = file.name.includes(".") ? file.name.split(".").pop()! : "";
  if (fromName) return fromName.toLowerCase().slice(0, 8);
  if (file.type === "application/pdf") return "pdf";
  return file.type.split("/")[1] ?? "bin";
}

export type UploadedAttachment = Omit<FrAttachment, "id" | "created_at">;

/**
 * Uploads one file into the request's folder and returns the row payload.
 * Images also get a downscaled webp display variant — lists and cards only
 * ever load that.
 */
export async function uploadAttachment(
  requestId: string,
  userId: string,
  file: File,
): Promise<UploadedAttachment> {
  const key = `${requestId}/${crypto.randomUUID()}`;
  const storagePath = `${key}.${extOf(file)}`;

  const { error } = await supabase.storage
    .from(FR_BUCKET)
    .upload(storagePath, file, { contentType: file.type || "application/octet-stream" });
  if (error) throw error;

  let displayPath: string | null = null;
  let width: number | null = null;
  let height: number | null = null;

  if (isImage(file.type)) {
    const variant = await makeDisplay(file);
    if (variant) {
      width = variant.width;
      height = variant.height;
      const p = `${key}.display.webp`;
      const up = await supabase.storage
        .from(FR_BUCKET)
        .upload(p, variant.blob, { contentType: "image/webp" });
      if (!up.error) displayPath = p;
    }
  }

  return {
    request_id: requestId,
    storage_path: storagePath,
    display_path: displayPath,
    file_name: file.name || "screenshot.png",
    mime_type: file.type || "application/octet-stream",
    byte_size: file.size,
    width,
    height,
    uploaded_by: userId,
  };
}

/** Signed URLs for a set of attachments, preferring the display variant. */
export async function signAttachments(
  attachments: FrAttachment[],
  life: SignedUrlLife = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const paths = attachments.map((a) => a.display_path ?? a.storage_path);
  if (paths.length === 0) return out;
  const { data, error } = await signStoredFiles(supabase, FR_BUCKET, paths, life);
  if (error || !data) return out;
  data.forEach((row, i) => {
    const att = attachments[i];
    if (att && row.signedUrl) out.set(att.id, row.signedUrl);
  });
  return out;
}

/** Signed URL for the original file (lightbox / PDF open). */
export async function signOriginal(path: string, life: SignedUrlLife = {}): Promise<string | null> {
  const { data } = await signStoredFile(supabase, FR_BUCKET, path, life);
  return data?.signedUrl ?? null;
}

// ---------- Copy details ----------

export function detailsText(r: FeatureRequest, categoryLabel: string): string {
  return [
    r.title,
    "",
    r.description.trim(),
    "",
    `Category: ${categoryLabel}`,
    `Status: ${FR_STATUS_LABEL[r.status]}`,
    `Submitted by: ${submitterLine(r)}`,
    `Date: ${formatDate(r.created_at)}`,
  ].join("\n");
}
