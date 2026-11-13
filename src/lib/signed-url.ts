/**
 * Signed URLs: short by default, long only with a reason written at the call.
 *
 * The security review: a signed URL is a bearer credential — anyone holding
 * the link reads the file, no session asked — so sensitive files get 5–10
 * minutes, and a longer life has to be justified where it is asked for. This
 * is the ONE way the app signs a stored file for reading; a test fails any
 * `.createSignedUrl(` or `.createSignedUrls(` anywhere else in src/, so new
 * code inherits the default instead of copying a number.
 *
 *   open      5 minutes   a single open or download, used at once
 *   view     10 minutes   the default: an image or file shown on a page;
 *                          caches built on it refresh inside that window
 *   longer              only with `why`, e.g. a link inside an email a
 *                          customer will open next week
 *
 * Upload URLs (createSignedUploadUrl) are not read links: Supabase fixes
 * their life and each is good for one object under one path. They are not
 * covered here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const SIGNED_URL_OPEN_SECONDS = 300;
export const SIGNED_URL_DEFAULT_SECONDS = 600;

/** The ceiling for a signed URL whose call site gives no reason. */
export const SIGNED_URL_MAX_WITHOUT_REASON = SIGNED_URL_DEFAULT_SECONDS;

export type SignedUrlLife = {
  /** Lifetime in seconds. Defaults to SIGNED_URL_DEFAULT_SECONDS. */
  seconds?: number;
  /** Required above SIGNED_URL_MAX_WITHOUT_REASON: why this link must live longer. */
  why?: string;
};

/** The lifetime to sign with; throws on a long one with no stated reason. */
export function signedUrlSeconds(life: SignedUrlLife = {}): number {
  const seconds = life.seconds ?? SIGNED_URL_DEFAULT_SECONDS;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("A signed URL needs a positive lifetime.");
  }
  if (seconds > SIGNED_URL_MAX_WITHOUT_REASON && !life.why?.trim()) {
    throw new Error(
      `A signed URL longer than ${SIGNED_URL_MAX_WITHOUT_REASON}s needs a reason (why) at the call site.`,
    );
  }
  return Math.floor(seconds);
}

/**
 * How long a query or cache may hold a URL signed for `seconds`: a minute
 * short of it, so nothing is served a link that dies on the click.
 */
export function signedUrlStaleMs(seconds = SIGNED_URL_DEFAULT_SECONDS): number {
  return Math.max(0, seconds - 60) * 1000;
}

type Storage = Pick<SupabaseClient, "storage">;

/** One file, for reading. `download` asks the browser to save rather than show it. */
export function signStoredFile(
  client: Storage,
  bucket: string,
  path: string,
  life: SignedUrlLife & { download?: boolean | string } = {},
) {
  const seconds = signedUrlSeconds(life);
  return client.storage
    .from(bucket)
    .createSignedUrl(path, seconds, life.download ? { download: life.download } : undefined);
}

/** Several files in one bucket, for reading. */
export function signStoredFiles(
  client: Storage,
  bucket: string,
  paths: string[],
  life: SignedUrlLife = {},
) {
  return client.storage.from(bucket).createSignedUrls(paths, signedUrlSeconds(life));
}
