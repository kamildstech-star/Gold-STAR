/**
 * Is this Supabase Storage telling us the object is already there?
 *
 * Mark, with a screenshot of the "Waiting to upload" sheet: "why is this
 * stuck". One photo of 182, "Stopped — needs attention · 8 attempts", reading
 * "Gave up after 8 attempts. Last error: The resource already exists". That is
 * Storage refusing to create a key that exists — which means the bytes made
 * it, and the upload queue was counting proof of success as a failure.
 *
 * The answer arrives in more than one shape, and this has to recognise all of
 * them rather than lean on the English sentence alone:
 *
 * - `StorageApiError` from storage-js: `status` is the HTTP status, and
 *   `statusCode` is whatever the body said. Storage has historically answered
 *   a duplicate with HTTP 400 and `"statusCode": "409"` in the body, and newer
 *   servers send a real 409 — so both fields are read.
 * - `code` / `error` in the body: `"Duplicate"`, and the service codes
 *   `KeyAlreadyExists` / `ResourceAlreadyExists` the error-code docs name.
 * - A plain string or `Error` whose message is all that survived — a server
 *   function's thrown error crosses to the browser as its message only, and an
 *   item already in the queue holds nothing but its `errorMessage`.
 *
 * The message test is "already exists", not "duplicate" on its own: Postgres
 * says "duplicate key value violates unique constraint" for an unrelated
 * failure, and treating that as "the file is stored" would drop a photo.
 */

const DUPLICATE_CODES = new Set(["duplicate", "keyalreadyexists", "resourcealreadyexists"]);

export function isStorageAlreadyExists(err: unknown): boolean {
  if (err == null) return false;
  if (typeof err === "string") return /already exists/i.test(err);
  if (typeof err !== "object") return false;
  const e = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    error?: unknown;
    message?: unknown;
  };
  if (Number(e.status) === 409 || String(e.statusCode ?? "") === "409") return true;
  for (const field of [e.code, e.error]) {
    if (typeof field === "string" && DUPLICATE_CODES.has(field.toLowerCase())) return true;
  }
  return typeof e.message === "string" && /already exists/i.test(e.message);
}

/**
 * The same question asked of a raw HTTP answer — the photo queue PUTs to a
 * signed URL with XHR, so there is no SDK in between to parse the body.
 */
export function isAlreadyExistsResponse(status: number, body: string): boolean {
  if (status === 409) return true;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON — fall through to the text, which is all there is.
  }
  return isStorageAlreadyExists(parsed ?? body);
}
