/**
 * The raw write behind a trade show lead captured on a tablet.
 *
 * One definition, shared by the immediate attempt and by the offline queue
 * draining it hours later, so "what a captured lead becomes" cannot drift into
 * two versions. Lives here rather than in `tradeshow-capture.ts` for the same
 * mechanical reason as `offline-writes.ts`: `offline-queue` imports this file,
 * so nothing in it may import `offline-queue` back.
 *
 * Every row is keyed by an id generated at the moment of capture and carried
 * in the payload, and every write is an upsert on that id, so a replay after a
 * lost response rewrites one lead instead of filing two. Files go up with
 * `upsert: true` on a path derived from those ids for the same reason.
 *
 * Order matters: the account first, so the lead exists even if the media
 * upload fails and the queue has to come back for it.
 */
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export const TRADESHOW_LEADS_BUCKET = "tradeshow-leads";

export type TradeshowLeadPayload = {
  /** Account primary key, generated at capture. Also the queue item id. */
  accountId: string;
  /** Contact primary key, or null when no contact name was given. */
  contactId: string | null;
  touchpointId: string;
  photoMediaId: string | null;
  audioMediaId: string | null;
  badgeMediaId?: string | null;
  badge?: { mime: string; width: number; height: number; sizeBytes: number } | null;
  tradeshowId: string;
  tradeshowName: string;
  locationId: string;
  userId: string;
  /** When the rep tapped Save, as an ISO string. Never the drain time. */
  capturedAt: string;
  name: string;
  company: string;
  phone: string;
  email: string;
  notes: string;
  /**
   * The account name to use when nothing was typed — a one-tap voice note has
   * no name and no company, and `accounts.name` is NOT NULL. Something a human
   * can pick out of a list until the review pass replaces it.
   */
  placeholderName?: string | null;
  /**
   * True for a capture nobody has written up yet. The lead is real and counts
   * on the show immediately; the fields arrive later, in the review pass.
   */
  needsReview?: boolean;
  /** Whatever a scanned badge produced, verbatim and unparsed. */
  badgeRaw?: string | null;
  leadSourceId: string | null;
  stageId: string | null;
  pipelineId: string | null;
  photo: {
    mime: string;
    width: number;
    height: number;
    sizeBytes: number;
    hasThumb: boolean;
  } | null;
  audio: { mime: string; durationSec: number; peaks: number[]; sizeBytes: number } | null;
};

/** The files that travel with the payload, keyed by role. */
export type TradeshowLeadBlobs = Partial<
  Record<"photo" | "thumb" | "audio" | "badge", { blob: Blob; mime: string }>
>;

/**
 * The account name is the company; a person met without one is the account.
 * A capture with neither — a voice note taken in ten seconds at a booth — uses
 * the placeholder the capture generated, so the row is still findable before
 * anyone has listened to it.
 */
export function leadAccountName(input: {
  name: string;
  company: string;
  placeholderName?: string | null;
}): string {
  return (
    input.company.trim() ||
    input.name.trim() ||
    (input.placeholderName ?? "").trim() ||
    "Voice note"
  );
}

const IMAGE_EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
};

const AUDIO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** `audio/webm;codecs=opus` → `audio/webm`. Buckets match on the bare type. */
export function bareMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

export function mediaExt(mime: string): string {
  const bare = bareMime(mime);
  return IMAGE_EXT[bare] ?? AUDIO_EXT[bare] ?? (bare.startsWith("audio/") ? "webm" : "jpg");
}

/**
 * Where the files live: {user_id}/{account_id}/{file}. The leading segment is
 * what the storage policy checks, and the account id keeps a replay writing
 * the same object rather than a second one.
 */
export function leadMediaPaths(input: {
  userId: string;
  accountId: string;
  photoMime?: string | null;
  audioMime?: string | null;
}) {
  const base = `${input.userId}/${input.accountId}`;
  return {
    photo: input.photoMime ? `${base}/photo.${mediaExt(input.photoMime)}` : null,
    thumb: input.photoMime ? `${base}/photo-thumb.webp` : null,
    audio: input.audioMime ? `${base}/voice.${mediaExt(input.audioMime)}` : null,
  };
}

async function upload(
  path: string,
  file: { blob: Blob; mime: string },
  client: typeof supabase,
): Promise<void> {
  const { error } = await client.storage
    .from(TRADESHOW_LEADS_BUCKET)
    .upload(path, file.blob, { contentType: bareMime(file.mime), upsert: true });
  if (error) throw error;
}

export async function writeTradeshowLead(
  p: TradeshowLeadPayload,
  blobs: TradeshowLeadBlobs,
  client: typeof supabase = supabase,
): Promise<void> {
  const accountName = leadAccountName(p);
  const phone = p.phone.trim() || null;
  const email = p.email.trim() || null;

  // Ordinary account creation is intentionally limited to office managers.
  // Tablet capture uses the narrow RPC instead: it only accepts an active
  // seller, pins ownership to the caller, checks the show/office/pipeline, and
  // remains idempotent when an offline replay repeats this account id.
  const { error: accErr } = await client.rpc("capture_tradeshow_lead_account", {
    _account_id: p.accountId,
    _tradeshow_id: p.tradeshowId,
    _location_id: p.locationId,
    _name: accountName,
    _captured_at: p.capturedAt,
    _phone: phone ?? undefined,
    _email: email ?? undefined,
    _notes: p.notes.trim() || undefined,
    _lead_source_id: p.leadSourceId ?? undefined,
    _pipeline_id: p.pipelineId ?? undefined,
    _stage_id: p.stageId ?? undefined,
  });
  if (accErr) throw accErr;

  // The review state of the capture. `ignoreDuplicates` makes this an
  // INSERT … ON CONFLICT DO NOTHING: a queued capture replayed after a lost
  // response must never drag a lead that has since been written up back into
  // the unreviewed queue. A database that has not had the migration applied
  // yet loses the queue, not the lead — the account, media and touchpoint are
  // already written by this point.
  const captureRow = {
    account_id: p.accountId,
    tradeshow_id: p.tradeshowId,
    needs_review: p.needsReview ?? false,
    badge_raw: (p.badgeRaw ?? "").trim() || null,
    captured_at: p.capturedAt,
    created_by: p.userId,
  };
  const { error: capErr } = await client
    .from("tradeshow_lead_captures")
    .upsert(captureRow as never, { onConflict: "account_id", ignoreDuplicates: true });
  if (capErr && !isMissingSchema(capErr)) throw capErr;

  if (p.contactId && p.name.trim()) {
    const { error } = await client.from("contacts").upsert(
      {
        id: p.contactId,
        account_id: p.accountId,
        location_id: p.locationId,
        full_name: p.name.trim(),
        phone,
        email,
        is_primary: true,
        created_by: p.userId,
        created_at: p.capturedAt,
      } as never,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  const paths = leadMediaPaths({
    userId: p.userId,
    accountId: p.accountId,
    photoMime: p.photo?.mime ?? null,
    audioMime: p.audio?.mime ?? null,
  });

  if (p.photo && p.photoMediaId && blobs.photo && paths.photo) {
    await upload(paths.photo, blobs.photo, client);
    const hasThumb = !!blobs.thumb && !!paths.thumb;
    if (hasThumb) await upload(paths.thumb!, blobs.thumb!, client);
    const { error } = await client.from("tradeshow_lead_media").upsert(
      {
        id: p.photoMediaId,
        tradeshow_id: p.tradeshowId,
        account_id: p.accountId,
        kind: "photo",
        storage_path: paths.photo,
        thumb_path: hasThumb ? paths.thumb : null,
        mime: bareMime(p.photo.mime),
        size_bytes: p.photo.sizeBytes,
        width: p.photo.width || null,
        height: p.photo.height || null,
        captured_at: p.capturedAt,
        created_by: p.userId,
      } as never,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  // A badge is a second photo, using the existing media kind and storage policy.
  // Keep its own path so it never replaces the selfie when the queue replays.
  if (p.badge && p.badgeMediaId && blobs.badge) {
    const badgePath = `${p.userId}/${p.accountId}/badge.${mediaExt(p.badge.mime)}`;
    await upload(badgePath, blobs.badge, client);
    const { error } = await client.from("tradeshow_lead_media").upsert(
      {
        id: p.badgeMediaId,
        tradeshow_id: p.tradeshowId,
        account_id: p.accountId,
        kind: "photo",
        storage_path: badgePath,
        thumb_path: null,
        mime: bareMime(p.badge.mime),
        size_bytes: p.badge.sizeBytes,
        width: p.badge.width || null,
        height: p.badge.height || null,
        captured_at: p.capturedAt,
        created_by: p.userId,
      } as never,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  if (p.audio && p.audioMediaId && blobs.audio && paths.audio) {
    await upload(paths.audio, blobs.audio, client);
    const { error } = await client.from("tradeshow_lead_media").upsert(
      {
        id: p.audioMediaId,
        tradeshow_id: p.tradeshowId,
        account_id: p.accountId,
        kind: "audio",
        storage_path: paths.audio,
        thumb_path: null,
        mime: bareMime(p.audio.mime),
        size_bytes: p.audio.sizeBytes,
        duration_seconds: p.audio.durationSec,
        waveform_peaks: p.audio.peaks,
        captured_at: p.capturedAt,
        created_by: p.userId,
      } as never,
      { onConflict: "id" },
    );
    if (error) throw error;
  }

  // The meeting at the booth is the first touchpoint on the account, so the
  // timeline starts where the relationship did. A voice note is a captured
  // source, not a self-reported one.
  const noteLines = [`Met at ${p.tradeshowName}`, p.notes.trim()].filter(Boolean);
  const { error: tpErr } = await client.from("touchpoints").upsert(
    {
      id: p.touchpointId,
      account_id: p.accountId,
      contact_id: p.contactId && p.name.trim() ? p.contactId : null,
      type: "meeting_in_person",
      direction: "outbound",
      occurred_at: p.capturedAt,
      meeting_held: true,
      is_self_reported: !p.audio,
      capture_source: p.audio ? "voice_note" : "manual",
      notes: noteLines.join("\n"),
      created_by: p.userId,
    } as never,
    { onConflict: "id" },
  );
  if (tpErr) throw tpErr;
}
