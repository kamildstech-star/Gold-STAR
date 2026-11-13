import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { signStoredFile } from "@/lib/signed-url";
import { isStorageAlreadyExists } from "@/lib/storage-already-exists";

// Storage SDK paths are interpolated into URLs. Dot segments, backslashes and
// percent escapes can change the object/bucket after the project is authorized.
const photoIdSchema = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[A-Za-z0-9_-]+$/);
const photoPathSchema = z
  .string()
  .min(1)
  .refine((path) => {
    if (!/^[A-Za-z0-9_./-]+$/.test(path)) return false;
    const segments = path.split("/");
    return (
      segments.length >= 2 &&
      z.string().uuid().safeParse(segments[0]).success &&
      segments.every((segment) => segment !== "" && segment !== "." && segment !== "..")
    );
  }, "Invalid photo path");

// ----------------------------------------------------------------------------
// Upload URL — hand the client a signed URL to PUT the original directly to
// storage. Client-side variants (display + thumb) get their own signed URLs.
// ----------------------------------------------------------------------------
export const createPhotoUploadUrls = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      projectId: string;
      photoId: string; // ULID from client
      ext: string;
    }) =>
      z
        .object({
          projectId: z.string().uuid(),
          photoId: photoIdSchema,
          ext: z.string().regex(/^[a-z0-9]{2,5}$/i),
        })
        .parse(data),
  )
  .handler(async ({ data, context }) => {
    // Must be able to manage the project.
    const { data: canManage, error: cErr } = await context.supabase.rpc("can_manage_project", {
      _user_id: context.userId,
      _project_id: data.projectId,
    });
    if (cErr) throw new Error(cErr.message);
    if (!canManage) throw new Error("Not authorized for this project");

    const base = `${data.projectId}`;
    const ext = data.ext.toLowerCase();
    const paths = {
      original: `${base}/orig/${data.photoId}.${ext}`,
      display: `${base}/display/${data.photoId}.webp`,
      thumb: `${base}/thumb/${data.photoId}.webp`,
    };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const bucket = supabaseAdmin.storage.from("project-photos");

    /*
     * Signing a key that already exists is refused — "The resource already
     * exists" — because these URLs are minted without upsert, and the
     * `x-upsert` header the browser used to send on the PUT has no effect on a
     * signed URL; only the signing call can grant it. So an attempt that got
     * its bytes into storage and then died before `finalizePhoto` could never
     * be finished: every retry asked to sign the same three keys, was refused,
     * and Mark's 182nd photo spent eight attempts proving it was already
     * uploaded and then gave up.
     *
     * That refusal is now an answer, per object: this one is stored, skip it.
     * The photo id in the path is a ULID minted on the phone for this capture,
     * so an object at that key is this capture's bytes and nothing else's, and
     * Storage only records an object once its upload has completed. We do not
     * re-sign with upsert to overwrite it: a URL that can replace a stored
     * original is a way to swap the evidence on a claim photo, and nothing here
     * needs one.
     */
    const sign = async (path: string): Promise<PhotoUploadTarget> => {
      const { data, error } = await bucket.createSignedUploadUrl(path);
      if (!error && data) {
        return { path, token: data.token, signedUrl: data.signedUrl, alreadyStored: false };
      }
      if (isStorageAlreadyExists(error)) {
        return { path, token: null, signedUrl: null, alreadyStored: true };
      }
      throw new Error(error?.message ?? "Failed to create upload URLs");
    };

    const [original, display, thumb] = await Promise.all([
      sign(paths.original),
      sign(paths.display),
      sign(paths.thumb),
    ]);
    return { original, display, thumb };
  });

/** Where one of a photo's three objects goes — or that it is already there. */
export type PhotoUploadTarget = {
  path: string;
  token: string | null;
  signedUrl: string | null;
  /** The object is in storage from an earlier attempt; do not PUT it again. */
  alreadyStored: boolean;
};

// ----------------------------------------------------------------------------
// Finalize — insert the DB row and variant rows once all three uploads land.
// Idempotent on photoId, so an offline retry is safe.
// ----------------------------------------------------------------------------
export const finalizePhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      projectId: string;
      photoId: string;
      ext: string;
      mime: string;
      sizeBytes: number;
      width: number;
      height: number;
      capturedAt: string | null;
      exifLat: number | null;
      exifLon: number | null;
      exifRaw: Record<string, unknown>;
      displayWidth: number;
      displayHeight: number;
      displayBytes: number;
      thumbWidth: number;
      thumbHeight: number;
      thumbBytes: number;
    }) =>
      z
        .object({
          projectId: z.string().uuid(),
          photoId: photoIdSchema,
          ext: z.string().regex(/^[a-z0-9]{2,5}$/i),
          mime: z.string().max(80),
          sizeBytes: z.number().int().nonnegative(),
          width: z.number().int().nonnegative(),
          height: z.number().int().nonnegative(),
          capturedAt: z.string().datetime().nullable(),
          exifLat: z.number().nullable(),
          exifLon: z.number().nullable(),
          exifRaw: z.record(z.string(), z.unknown()),
          displayWidth: z.number().int().nonnegative(),
          displayHeight: z.number().int().nonnegative(),
          displayBytes: z.number().int().nonnegative(),
          thumbWidth: z.number().int().nonnegative(),
          thumbHeight: z.number().int().nonnegative(),
          thumbBytes: z.number().int().nonnegative(),
        })
        .parse(data),
  )
  .handler(async ({ data, context }) => {
    const base = data.projectId;
    const paths = {
      original: `${base}/orig/${data.photoId}.${data.ext.toLowerCase()}`,
      display: `${base}/display/${data.photoId}.webp`,
      thumb: `${base}/thumb/${data.photoId}.webp`,
    };

    // Upsert photo row (idempotent on photoId).
    const { error: pErr } = await context.supabase.from("photos").upsert(
      {
        id: data.photoId,
        project_id: data.projectId,
        uploader_id: context.userId,
        storage_bucket: "project-photos",
        storage_path_original: paths.original,
        mime: data.mime,
        size_bytes: data.sizeBytes,
        width: data.width,
        height: data.height,
        captured_at: data.capturedAt,
        upload_completed_at: new Date().toISOString(),
        exif_lat: data.exifLat,
        exif_lon: data.exifLon,
        exif_raw: data.exifRaw as never,
      },
      { onConflict: "id" },
    );
    if (pErr) throw new Error(pErr.message);

    // Upsert both variants.
    const { error: vErr } = await context.supabase.from("photo_variants").upsert(
      [
        {
          photo_id: data.photoId,
          variant: "display" as const,
          storage_path: paths.display,
          width: data.displayWidth,
          height: data.displayHeight,
          size_bytes: data.displayBytes,
          generated_at: new Date().toISOString(),
        },
        {
          photo_id: data.photoId,
          variant: "thumb" as const,
          storage_path: paths.thumb,
          width: data.thumbWidth,
          height: data.thumbHeight,
          size_bytes: data.thumbBytes,
          generated_at: new Date().toISOString(),
        },
      ],
      { onConflict: "photo_id,variant" },
    );
    if (vErr) throw new Error(vErr.message);

    return { ok: true as const, photoId: data.photoId };
  });

// ----------------------------------------------------------------------------
// Signed URL for a variant (thumb or display) — client uses this to render.
// ----------------------------------------------------------------------------
export const signVariantUrl = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { path: string }) => z.object({ path: photoPathSchema }).parse(data))
  .handler(async ({ data, context }) => {
    // Verify the caller can view the underlying project.
    const projectId = data.path.split("/")[0];
    const { data: canView } = await context.supabase.rpc("can_view_project", {
      _user_id: context.userId,
      _project_id: projectId,
    });
    if (!canView) throw new Error("Not authorized");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // The default ten minutes (was an hour): the caller shows it at once.
    const { data: signed, error } = await signStoredFile(
      supabaseAdmin,
      "project-photos",
      data.path,
    );
    if (error) throw new Error(error.message);
    return { url: signed.signedUrl };
  });

// ----------------------------------------------------------------------------
// Share links — expiring, revocable adjuster access.
// ----------------------------------------------------------------------------
export const createShareLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      projectId: string;
      kind: "project" | "photo_set";
      photoIds?: string[];
      expiresInHours: number;
      allowDownloadOriginal: boolean;
      note?: string;
    }) =>
      z
        .object({
          projectId: z.string().uuid(),
          kind: z.enum(["project", "photo_set"]),
          photoIds: z.array(z.string()).optional(),
          expiresInHours: z
            .number()
            .int()
            .min(1)
            .max(24 * 365),
          allowDownloadOriginal: z.boolean(),
          note: z.string().max(500).optional(),
        })
        .parse(data),
  )
  .handler(async ({ data, context }) => {
    // 32 bytes → 43-char urlsafe base64.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const expiresAt = new Date(Date.now() + data.expiresInHours * 3600 * 1000).toISOString();
    const { data: row, error } = await context.supabase
      .from("share_links")
      .insert({
        project_id: data.projectId,
        created_by: context.userId,
        kind: data.kind,
        photo_ids: data.kind === "photo_set" ? (data.photoIds ?? []) : null,
        token,
        expires_at: expiresAt,
        allow_download_original: data.allowDownloadOriginal,
        note: data.note ?? null,
      })
      .select("id, token, expires_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const revokeShareLink = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { linkId: string }) => z.object({ linkId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("share_links")
      .update({ revoked_at: new Date().toISOString(), revoked_by: context.userId })
      .eq("id", data.linkId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });
