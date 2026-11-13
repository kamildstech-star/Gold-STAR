/**
 * Creating, listing and revoking a job's share links.
 *
 * These run in the browser against RLS, not the service role: the policies
 * added alongside the `job_id` column are the enforcement, so a user who
 * cannot manage the job cannot mint a link for it and no bespoke permission
 * check here can drift away from the one the database applies.
 *
 * Reading a link's contents is the opposite problem and lives in
 * `job-share.functions.ts`, where the recipient has no session at all.
 */
import { browserAppOrigin } from "@/lib/app-origin";
import { supabase } from "@/integrations/supabase/client";

import {
  SHARE_DISPLAY_DEFAULTS,
  jobSharePath,
  normalizeDisplayOptions,
  type ShareDisplayOptions,
} from "./job-share";

export type JobShareLink = {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  note: string | null;
  options: ShareDisplayOptions;
};

/**
 * 42703 / PGRST204 / PGRST205 all mean the share-link migration has not been
 * applied yet, not that the query was wrong. The caller disables the feature
 * and says so rather than reporting an empty list.
 */
export function shareLinksNotMigrated(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string } | null;
  if (!e) return false;
  if (e.code === "42703" || e.code === "PGRST204" || e.code === "PGRST205") return true;
  return /does not exist|could not find/i.test(`${e.message ?? ""} ${e.details ?? ""}`);
}

export function jobShareUrl(token: string): string {
  const origin = browserAppOrigin();
  return `${origin}${jobSharePath(token)}`;
}

/** Shared with the photo share links, so both kinds have the same entropy. */
export function newShareToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type JobShareListResult =
  { migrated: true; links: JobShareLink[] } | { migrated: false; links: [] };

export async function listJobShareLinks(jobId: string): Promise<JobShareListResult> {
  const { data, error } = await supabase
    .from("share_links")
    .select("id, token, created_at, expires_at, revoked_at, note, display_options")
    .eq("job_id", jobId)
    .eq("kind", "job_schedule")
    .order("created_at", { ascending: false });

  if (error) {
    if (shareLinksNotMigrated(error)) return { migrated: false, links: [] };
    throw error;
  }

  return {
    migrated: true,
    links: (data ?? []).map((r) => ({
      id: r.id,
      token: r.token,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      revokedAt: r.revoked_at,
      note: r.note,
      options: normalizeDisplayOptions(r.display_options),
    })),
  };
}

export type CreateJobShareInput = {
  jobId: string;
  userId: string | null;
  options: ShareDisplayOptions;
  expiresInDays: number;
  note: string | null;
};

export async function createJobShareLink(
  input: CreateJobShareInput,
): Promise<{ id: string; token: string; url: string }> {
  const token = newShareToken();
  const expiresAt = new Date(
    Date.now() + Math.max(1, input.expiresInDays) * 86_400_000,
  ).toISOString();

  const { data, error } = await supabase
    .from("share_links")
    .insert({
      job_id: input.jobId,
      kind: "job_schedule",
      token,
      created_by: input.userId,
      expires_at: expiresAt,
      note: input.note,
      /* Normalised on the way in as well as on the way out, so a link can
         never carry a permission the dialog could not have granted. */
      display_options: { ...SHARE_DISPLAY_DEFAULTS, ...normalizeDisplayOptions(input.options) },
    })
    .select("id, token")
    .single();
  if (error) throw error;

  return { id: data.id, token: data.token, url: jobShareUrl(data.token) };
}

export async function revokeJobShareLink(linkId: string, userId: string | null): Promise<void> {
  const { error } = await supabase
    .from("share_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by: userId })
    .eq("id", linkId);
  if (error) throw error;
}
