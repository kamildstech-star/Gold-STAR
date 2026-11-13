// TODO(remove after cutover): temporary, for moving Storage off Lovable Cloud.
// Delete with the rest of the storage manifest (see the header of
// storage-export.ts) once the files are in the new Supabase project.
/**
 * "Export storage file list" — the Owner's one-press manifest of every stored
 * file with a 24-hour download link, for copying Storage to the new server.
 *
 * Owner ONLY, decided here and not by the button: an admin or developer is
 * refused before the service-role client is even loaded. The links are
 * bearer credentials to every photo and document the company holds, so the
 * set of people who can mint them all at once is the smallest it can be.
 *
 * Order matters and is the export gate's order (export-guard.ts): list the
 * names, write the export_audit row through `log_export` AS THE CALLER, and
 * only then sign. If the audit row cannot be written, no link is ever made.
 * The audit row carries per-bucket counts; it never carries a link, and
 * nothing here logs one.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import type { BucketTotals } from "./storage-export";

export type StorageManifestResult = {
  csv: string;
  totals: BucketTotals[];
  totalObjects: number;
  totalBytes: number;
  generatedAt: string;
  expiresAt: string;
};

type CallerContext = {
  userId: string;
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
  };
};

export const exportStorageManifest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<StorageManifestResult> => {
    const ctx = context as unknown as CallerContext;

    const { data: isOwner } = await ctx.supabase.rpc("has_role", {
      _user_id: ctx.userId,
      _role: "owner",
    });
    if (isOwner !== true) {
      throw new Error("Only the Owner can export the storage file list.");
    }

    const { RATE_LIMITS, consumeLimit } = await import("@/lib/rate-limit.server");
    const budget = await consumeLimit(
      "storage-export",
      ctx.userId,
      RATE_LIMITS.storageExport,
      "closed",
    );
    if (!budget.allowed) {
      throw new Error(
        `The storage file list was exported recently. Try again in about ${Math.max(1, Math.ceil(budget.retryAfterSeconds / 60))} minute(s).`,
      );
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { MANIFEST_LINK_SECONDS, bucketTotals, buildManifestCsv, listAllObjects, signObjects } =
      await import("./storage-export");
    const storage = supabaseAdmin.storage as never;

    const { buckets, objects } = await listAllObjects(storage);
    const counted = bucketTotals(buckets, objects);

    const { error: auditError } = await ctx.supabase.rpc("log_export", {
      _surface: "admin_security_storage_manifest",
      _entity: "storage_objects",
      _record_count: objects.length,
      _format: "csv",
      _filters: {
        purpose: "storage move off Lovable",
        link_seconds: MANIFEST_LINK_SECONDS,
        buckets: Object.fromEntries(counted.map((t) => [t.bucket, t.objects])),
      },
    });
    if (auditError) {
      throw new Error("The export could not be recorded, so no links were made.");
    }

    const signed = await signObjects(storage, objects);
    const totals = bucketTotals(buckets, signed);
    const generatedAt = new Date();
    return {
      csv: buildManifestCsv(signed, totals, generatedAt),
      totals,
      totalObjects: signed.length,
      totalBytes: totals.reduce((n, t) => n + t.bytes, 0),
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + MANIFEST_LINK_SECONDS * 1000).toISOString(),
    };
  });
