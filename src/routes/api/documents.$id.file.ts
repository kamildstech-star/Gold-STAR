/**
 * `GET /api/documents/<id>/file?disposition=inline|attachment`
 *
 * The bytes of one document, over ordinary same-origin HTTP.
 *
 * The viewer used to download a document with the Supabase client, wrap it in a
 * `Blob` and hand the browser a `blob:` URL. Three separate faults came out of
 * that one choice: ad blockers and privacy extensions refuse `blob:` outright
 * (`ERR_BLOCKED_BY_CLIENT`, framed or top-level, with nothing the page can do
 * about it); Storage serves whatever `mime` the upload recorded, which is
 * `application/octet-stream` for every extension the uploader's OS did not know
 * (`.esx` always, `.heic`/`.dwg` often) and a browser downloads that whatever
 * the disposition says; and a document with no stored file — an unsigned
 * contract, whose PDF is built from the row — had no URL at all. A same-origin
 * `https:` URL answers all three: extensions leave it alone, this handler names
 * the type from the filename, and it can render on demand.
 *
 * AUTH. This route never touches the service role. A URL anyone can guess must
 * not be a way to read anyone's document, so the caller's own JWT is the only
 * credential in play and RLS is what decides:
 *
 *   - the token comes from the `rh_doc_session` cookie (`session-cookie.ts`),
 *     because `<object data>` and `<img src>` are issued by the browser and
 *     carry no header we control; an `Authorization: Bearer` header is accepted
 *     too, for callers that use `fetch` and can set one;
 *   - it is verified against Supabase before anything else happens;
 *   - the `documents` row is read through a client built on the *publishable*
 *     key carrying that token, so `documents_select` applies — a document
 *     outside the caller's locations comes back as no row, and this returns 404;
 *   - the object is pulled from Storage with the same token, so
 *     `documents_objects_read` applies independently of the row read.
 *
 * Nothing is cached: `private, no-store`, because the response is per-user.
 *
 * `?variant=thumb` serves the document's thumbnail — the small WebP the browser
 * stored at `<id>/thumb.webp` (see `documentThumbPath`) — under exactly the
 * same two gates, and a 404 when none has been made yet. The tile grid asks
 * for that and never for the file, so forty documents cost forty small images.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { DOCUMENT_SESSION_COOKIE } from "@/integrations/supabase/session-cookie";
import { validateSession } from "@/integrations/supabase/validate-session";

import { DOCUMENT_BUCKET, documentMime, documentThumbPath } from "@/lib/documents";

/**
 * Types safe to hand a browser inline from our own origin. Anything that can
 * execute in it — SVG, HTML, XML with a stylesheet — is forced to a download
 * instead, no matter what the caller asked for. Uploads are untrusted content
 * and this route is same-origin, which is exactly what the blob URLs were not.
 */
function servableInline(mime: string): boolean {
  if (mime === "application/pdf" || mime === "text/plain") return true;
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim()) || null;
  }
  return null;
}

/**
 * Document names carry spaces, em dashes and tildes —
 * `LEVITTOWN Levittown~SApartments.ESX`. The quoted-string form is ASCII only
 * and must escape its own quotes and backslashes; RFC 5987 carries the real
 * name for anything that understands it. Dropping every character outside
 * printable ASCII is also what keeps a name from injecting a header.
 */
function contentDisposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "\\$&");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** `documents.id` is a uuid; anything else is a 404, not a Postgres cast error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Plain text, never an empty body — a failed read must say what failed. */
function fail(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export const Route = createFileRoute("/api/documents/$id/file")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
          return fail(503, "Supabase is not configured on this server.");
        }

        if (!UUID.test(params.id)) {
          return fail(404, "This document does not exist, or you cannot access it.");
        }

        const authHeader = request.headers.get("authorization");
        const token =
          authHeader?.startsWith("Bearer ") && authHeader.length > 7
            ? authHeader.slice(7)
            : readCookie(request.headers.get("cookie"), DOCUMENT_SESSION_COOKIE);
        if (!token || token.split(".").length !== 3) {
          return fail(401, "Sign in again to open this document.");
        }

        // The publishable key only ever grants what the `authenticated` role
        // holds; the bearer token is what identifies the caller to RLS.
        const supabase: SupabaseClient<Database> = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_PUBLISHABLE_KEY,
          {
            global: {
              fetch: (input, init) => {
                const headers = new Headers(
                  typeof Request !== "undefined" && input instanceof Request
                    ? input.headers
                    : undefined,
                );
                if (init?.headers) {
                  new Headers(init.headers).forEach((v, k) => headers.set(k, v));
                }
                headers.set("apikey", SUPABASE_PUBLISHABLE_KEY);
                headers.set("Authorization", `Bearer ${token}`);
                return fetch(input, { ...init, headers });
              },
            },
            auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
          },
        );

        // getClaims throws — it does not return an error — on a token whose
        // signature or shape it dislikes. Unhandled, the framework's error page
        // turns a plain rejected credential into an HTML 500 served as a PDF.
        try {
          await validateSession(supabase, token);
        } catch {
          return fail(401, "Sign in again to open this document.");
        }

        let doc: {
          id: string;
          name: string;
          mime: string | null;
          storage_bucket: string | null;
          storage_path: string | null;
        } | null;
        try {
          const { data, error } = await supabase
            .from("documents")
            .select("id, name, mime, storage_bucket, storage_path")
            .eq("id", params.id)
            .maybeSingle();
          if (error) throw error;
          doc = data;
        } catch {
          return fail(502, "This document could not be looked up.");
        }
        // RLS returns no row for a document outside the caller's locations, and
        // for one that does not exist. Both are a 404 and neither says which.
        if (!doc) return fail(404, "This document does not exist, or you cannot access it.");

        const variant = new URL(request.url).searchParams.get("variant");
        const bucket = doc.storage_bucket || DOCUMENT_BUCKET;
        const range = request.headers.get("range");

        /**
         * Streamed, not buffered: a Worker has a hard memory ceiling and the
         * bytes never need to exist here. Range is forwarded so a PDF viewer
         * can page through a large file instead of pulling all of it — and so
         * a one-byte probe can ask whether a thumbnail exists.
         */
        const fromStorage = async (objectPath: string): Promise<Response> => {
          const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
          let upstream: Response;
          try {
            upstream = await fetch(
              `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`,
              {
                headers: {
                  apikey: SUPABASE_PUBLISHABLE_KEY,
                  Authorization: `Bearer ${token}`,
                  ...(range ? { Range: range } : {}),
                },
              },
            );
          } catch {
            return fail(502, "Storage could not be reached.");
          }
          if (!upstream.ok || !upstream.body) {
            // `documents_objects_read` is a second, independent gate: the row
            // was readable and the object still may not be.
            if (upstream.status === 401 || upstream.status === 403) {
              return fail(403, "You cannot access the file behind this document.");
            }
            if (upstream.status === 404) {
              return fail(
                404,
                variant === "thumb"
                  ? "This document has no thumbnail yet."
                  : "This document's file is missing from storage.",
              );
            }
            return fail(502, "The file could not be read from storage.");
          }
          return upstream;
        };

        const passThrough = (upstream: Response, headers: Headers): Response => {
          headers.set("cache-control", "private, no-store");
          headers.set("x-content-type-options", "nosniff");
          headers.set("accept-ranges", "bytes");
          const length = upstream.headers.get("content-length");
          if (length) headers.set("content-length", length);
          const contentRange = upstream.headers.get("content-range");
          if (contentRange) headers.set("content-range", contentRange);
          return new Response(upstream.body, { status: upstream.status, headers });
        };

        if (variant === "thumb") {
          // A thumbnail is only ever made of a stored file; a row rendered on
          // demand has no fixed picture to keep.
          if (!doc.storage_path) return fail(404, "This document has no thumbnail.");
          const upstream = await fromStorage(documentThumbPath(doc.id));
          /*
           * A thumbnail is decoration, and "there isn't one" is the only answer
           * a caller can act on. Storage answering anything other than the
           * object — unreachable, a malformed key, a 500 of its own — used to
           * surface here as a 502, which put a red line in every console that
           * opened the Documents list (QA, 2026-09-16) and, worse, told the
           * client the read was *denied*: it then declined to draw the missing
           * thumbnail, so the document was stuck without one for good.
           *
           * 403 is kept as itself. That one means `documents_objects_read`
           * refused the object, and generating a replacement would fail the
           * same way, so there is a reason not to try.
           */
          if (!upstream.ok) {
            return upstream.status === 403
              ? upstream
              : fail(404, "This document has no thumbnail yet.");
          }
          // The object records the type the browser could encode — WebP, or
          // PNG from a Safari that cannot write WebP. Serve what it is, and
          // only ever an image: this path is not a way to read anything else.
          const stored = upstream.headers.get("content-type") ?? "";
          const mime =
            stored.startsWith("image/") && stored !== "image/svg+xml" ? stored : "image/webp";
          return passThrough(
            upstream,
            new Headers({
              "content-type": mime,
              "content-disposition": contentDisposition("inline", "thumb.webp"),
            }),
          );
        }

        const wanted =
          new URL(request.url).searchParams.get("disposition") === "attachment"
            ? "attachment"
            : "inline";

        if (doc.storage_path) {
          const mime = documentMime(doc.name, doc.mime);
          const upstream = await fromStorage(doc.storage_path);
          if (!upstream.ok) return upstream;
          return passThrough(
            upstream,
            new Headers({
              "content-type": mime,
              "content-disposition": contentDisposition(
                wanted === "inline" && servableInline(mime) ? "inline" : "attachment",
                doc.name,
              ),
            }),
          );
        }

        // No stored file. Normal for a templated document before signing: the
        // PDF is built from the row's own `rendered_body` and never by
        // re-resolving today's template.
        //
        // This is the one response built in memory rather than streamed. A
        // contract PDF is tens of kilobytes; nothing here scales with an upload.
        let built;
        try {
          /*
           * Imported here, not at the top of the file. This module is part of
           * the worker's entry graph, and document-render pulls in pdf-lib,
           * whose tslib interop throws under Workers the moment it is
           * evaluated - "Cannot destructure property '__extends'". A
           * top-level import therefore took down every route in the app,
           * including "/", for a dependency only this one branch needs.
           * document-sign.functions.ts already loads it this way.
           */
          const { renderDocumentOnDemand } = await import("@/lib/document-render");
          built = await renderDocumentOnDemand(doc.id, supabase);
        } catch {
          // Without this the framework's HTML error page would arrive labelled
          // as a PDF, which reads as a corrupt document rather than a failure.
          return fail(500, "This document could not be rendered.");
        }
        if (!built.ok) return fail(422, built.reason);

        const name = doc.name.toLowerCase().endsWith(".pdf") ? doc.name : `${doc.name}.pdf`;
        return new Response(built.bytes.slice().buffer as ArrayBuffer, {
          status: 200,
          headers: {
            "content-type": "application/pdf",
            "content-disposition": contentDisposition(wanted, name),
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});
