import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { INTAKE_PHOTO_BUCKET, sanitizeIntakePhotos, type IntakePhoto } from "./intake-form";
import { isMissingSchema } from "./schema-fallback";
import { signStoredFiles } from "@/lib/signed-url";

export type IntakePhotoView = IntakePhoto & { url: string | null };

/**
 * Staff view of the photos a customer attached to an intake form.
 *
 * The bucket is private and has no read policy for staff on purpose: whether
 * a user may see these photos is exactly whether they may see the submission,
 * and RLS on intake_submissions already answers that. So the row is read with
 * the caller's own client first, and only then are short-lived signed URLs
 * minted with the admin client.
 */
export const intakePhotoUrls = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { submissionId: string }) =>
    z.object({ submissionId: z.string().uuid() }).parse(data),
  )
  .handler(async ({ data, context }): Promise<IntakePhotoView[]> => {
    const { data: row, error } = await context.supabase
      .from("intake_submissions")
      .select("id, request_id, photos")
      .eq("id", data.submissionId)
      .maybeSingle();
    if (error) {
      // The column ships in a migration that is written but not applied.
      if (isMissingSchema(error)) return [];
      throw new Error(error.message);
    }
    if (!row) throw new Error("Not authorized");

    const submission = row as unknown as { request_id: string; photos?: unknown };
    const { data: request, error: requestError } = await context.supabase
      .from("intake_requests")
      .select("id")
      .eq("id", submission.request_id)
      .maybeSingle();
    if (requestError || !request) throw new Error("Not authorized");
    const photos = sanitizeIntakePhotos(submission.photos, submission.request_id);
    if (photos.length === 0) return [];

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // Ten minutes (was an hour); the inbox refetches before they lapse.
    const { data: signed } = await signStoredFiles(
      supabaseAdmin,
      INTAKE_PHOTO_BUCKET,
      photos.map((p) => p.path),
    );
    const byPath = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
    return photos.map((p) => ({ ...p, url: byPath.get(p.path) ?? null }));
  });
