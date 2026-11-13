/**
 * `GET /api/share/<token>/photo/<id>?size=thumb|full|original`
 *
 * The bytes of one shared photograph, to someone with no account.
 *
 * WHY A PROXY AND NOT A SIGNED URL. A signed storage URL is a second credential
 * with its own clock. Once issued it keeps working for its full life whatever
 * happens to the link it came from, so "revoke" would stop the page and not the
 * pictures — and revoking is the one thing the sender does when a link has gone
 * somewhere it should not have. Here the token is re-checked, against revoke
 * and against expiry, on every single image request. It also keeps the whole
 * gallery same-origin: no storage host in the markup, no bucket name, no photo
 * path, and nothing for a privacy extension to object to.
 *
 * SCOPE. The id must be named by this link *and* resolve inside this link's own
 * job — `shareImageSources` is the single place that decides both, shared with
 * the payload builder so the two cannot come to different conclusions.
 *
 * Streamed rather than buffered: a Worker has a hard memory ceiling and the
 * bytes never need to exist here.
 */
import { createFileRoute } from "@tanstack/react-router";

/** Types we will hand a browser inline. Anything that can execute is not here. */
const RENDERABLE = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/bmp",
  "image/tiff",
]);

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

function fail(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export const Route = createFileRoute("/api/share/$token/photo/$id")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
          return fail(503, "Supabase is not configured on this server.");
        }

        // A token short enough to guess is not a token; refuse before the db.
        const token = params.token;
        if (typeof token !== "string" || token.length < 16 || token.length > 128) {
          return fail(404, "This link is not valid.");
        }

        /* Its own ceiling rather than RATE_LIMITS.publicTokenRead: one gallery
           is one page view but sixty image requests, so the bucket sized for
           opening a page would throttle a customer scrolling their own photos.
           Fails OPEN for the same reason — a counter store outage must not
           blank the pictures. What this is here for is the flood with no valid
           token at all, which would otherwise cost a database read each. */
        const { guardByIp } = await import("@/lib/rate-limit.server");
        const throttled = await guardByIp(
          request,
          "share:photo",
          { limit: 600, windowSeconds: 300 },
          "open",
        );
        if (throttled) return throttled;

        const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");

        let link: {
          kind: string;
          job_id: string | null;
          expires_at: string;
          revoked_at: string | null;
          photo_ids: string[] | null;
          document_ids: string[] | null;
          display_options: unknown;
          allow_download_original: boolean | null;
        } | null;
        try {
          const { data, error } = await db
            .from("share_links")
            .select(
              "kind, job_id, expires_at, revoked_at, photo_ids, document_ids, display_options, allow_download_original",
            )
            .eq("token", token)
            .maybeSingle();
          if (error) throw error;
          link = data;
        } catch {
          // A read that failed is not a link that is gone.
          return fail(502, "This image could not be looked up.");
        }

        /* A drying report sent as a link (David, 13 Oct) comes through this
           same route: one PDF, named by the link, filed on the link's job.
           Same token, revoke and expiry checks, on every request. */
        if (link && link.kind === "job_drying_report") {
          const { reportShareServes } = await import("@/lib/report-share");
          const docId = params.id;
          const { data: doc } = await db
            .from("documents")
            .select("job_id, mime, storage_path, storage_bucket, name")
            .eq("id", docId)
            .maybeSingle();
          const served = reportShareServes(link, docId, doc ?? null);
          if (served === "revoked") return fail(410, "This link has been turned off.");
          if (served === "expired") return fail(410, "This link has expired.");
          if (served !== "ok" || !doc?.storage_path) {
            return fail(404, "This file is not part of this link.");
          }
          const objectPath = doc.storage_path.split("/").map(encodeURIComponent).join("/");
          let upstream: Response;
          try {
            upstream = await fetch(
              `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(doc.storage_bucket ?? "documents")}/${objectPath}`,
              {
                headers: {
                  apikey: SUPABASE_SERVICE_ROLE_KEY,
                  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                },
              },
            );
          } catch {
            return fail(502, "Storage could not be reached.");
          }
          if (!upstream.ok || !upstream.body) {
            return fail(upstream.status === 404 ? 404 : 502, "This file could not be read.");
          }
          const download = new URL(request.url).searchParams.get("download") === "1";
          const filename = (doc.name || "drying-report").replace(/[^\w.-]+/g, "_");
          const headers = new Headers({
            "content-type": "application/pdf",
            "content-disposition": `${download ? "attachment" : "inline"}; filename="${filename}.pdf"`,
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
          const length = upstream.headers.get("content-length");
          if (length) headers.set("content-length", length);
          return new Response(upstream.body, { status: 200, headers });
        }

        if (!link || link.kind !== "job_photos" || !link.job_id) {
          return fail(404, "This link is not valid.");
        }
        if (link.revoked_at) return fail(410, "This link has been turned off.");
        if (new Date(link.expires_at).getTime() < Date.now()) {
          return fail(410, "This link has expired.");
        }

        /* An image document's id is `doc:<uuid>`, and that colon goes down the
           wire percent-encoded. Whether the router hands it back decoded is
           not something this route should have an opinion about. */
        const id = params.id.includes("%") ? decodeURIComponent(params.id) : params.id;

        const { shareImageSources } = await import("@/lib/photo-share.server");
        let source;
        try {
          const sources = await shareImageSources(
            db,
            {
              token,
              job_id: link.job_id,
              photo_ids: link.photo_ids,
              document_ids: link.document_ids,
              display_options: link.display_options,
            },
            id,
          );
          source = sources.get(id);
        } catch {
          return fail(502, "This image could not be looked up.");
        }
        // Not named by this link, deleted since, or filed against another job.
        if (!source) return fail(404, "This image is not part of this link.");

        const size = new URL(request.url).searchParams.get("size");
        /* The original is the one file that still carries EXIF — capture time
           and GPS. It goes out only when the sender turned that on for this
           link; a guessed `size=original` on a view-only link gets the same
           answer as a wrong token. */
        const wantOriginal = size === "original";
        if (wantOriginal && link.allow_download_original !== true) {
          return fail(403, "This link is view-only.");
        }
        const wantThumb = !wantOriginal && size !== "full";
        const storedPath = wantOriginal ? source.original : wantThumb ? source.thumb : source.full;
        const objectPath = storedPath.split("/").map(encodeURIComponent).join("/");

        let upstream: Response;
        try {
          upstream = await fetch(
            `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(source.bucket)}/${objectPath}`,
            {
              headers: {
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              },
            },
          );
        } catch {
          return fail(502, "Storage could not be reached.");
        }
        if (!upstream.ok || !upstream.body) {
          return fail(upstream.status === 404 ? 404 : 502, "This image could not be read.");
        }

        /* Never the mime the uploader claimed, unless we recognise it as a
           raster image. Falling back to the stored filename's extension is for
           rows old enough to carry no mime at all; a type we still do not
           recognise is served as bytes, which cannot execute in our origin. */
        const claimed = ((wantOriginal ? source.originalMime : source.mime) ?? "").toLowerCase();
        const mime = RENDERABLE.has(claimed)
          ? claimed
          : (EXT_MIME[storedPath.split(".").pop()?.toLowerCase() ?? ""] ??
            "application/octet-stream");

        const headers = new Headers({
          "content-type": mime,
          "content-disposition": wantOriginal
            ? `attachment; filename="${
                storedPath
                  .split("/")
                  .pop()
                  ?.replace(/[^\w.-]/g, "_") || "photo"
              }"`
            : "inline",
          /* Not cacheable at all: revoking a link has to stop the pictures, and
             a cached image is a picture the revoke cannot reach. */
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        const length = upstream.headers.get("content-length");
        if (length) headers.set("content-length", length);

        return new Response(upstream.body, { status: 200, headers });
      },
    },
  },
});
