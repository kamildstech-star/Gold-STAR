/**
 * What Polaris can actually be shown — one source of truth.
 *
 * The composer and the server both read this file. A limit only the client
 * knows is a suggestion; a limit only the server knows is a file the user
 * watches upload before being told no. Keeping both on the same constants is
 * what stops the two from drifting apart.
 *
 * The chat model is `google/gemini-3.6-flash` behind the Lovable gateway. It
 * takes images and PDFs as native parts (see `extractDocument` in ai.server),
 * and nothing else — so every other format either becomes text here or is
 * refused by name. Accepting a file the model never sees is the worst outcome.
 */

export const ASSISTANT_ATTACHMENT_BUCKET = "assistant-attachments";

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** The same ceiling expressed for the base64 payload the schema validates. */
export const MAX_ATTACHMENT_BASE64_CHARS = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4;

/** Sent to the model as an image part. */
export const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

/** Sent as a document part; the gateway forwards PDFs to Gemini natively. */
export const PDF_MIME = "application/pdf";

/** Decoded server-side as UTF-8 and quoted into the prompt as untrusted text. */
export const TEXT_MIMES = [
  "text/plain",
  "text/csv",
  "text/tab-separated-values",
  "text/markdown",
  "application/json",
] as const;

export const ATTACHMENT_MIMES: string[] = [...IMAGE_MIMES, PDF_MIME, ...TEXT_MIMES];

/** Extensions are part of the accept list because browsers lie about CSV. */
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_MIMES, ".csv", ".tsv", ".txt", ".md"].join(",");

export type AttachmentKind = "image" | "pdf" | "text";

export interface AttachmentMeta {
  name: string;
  mime: string;
  kind: AttachmentKind;
  size_bytes: number;
  storage_path?: string;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

const TEXT_EXTENSIONS = new Set(["csv", "tsv", "txt", "md", "json", "log"]);

/**
 * Windows reports .csv as `application/vnd.ms-excel` and .md as empty, so the
 * extension is consulted whenever the browser's guess is not one we know.
 * The server re-checks the bytes; this is only a routing decision.
 */
export function attachmentKind(mime: string, name: string): AttachmentKind | null {
  const type = (mime || "").toLowerCase().split(";")[0]!.trim();
  if ((IMAGE_MIMES as readonly string[]).includes(type)) return "image";
  if (type === PDF_MIME) return "pdf";
  if ((TEXT_MIMES as readonly string[]).includes(type)) return "text";

  const ext = extensionOf(name);
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return null;
}

/** The mime we will store and hand the model, ignoring the browser's guess. */
export function normalisedMime(kind: AttachmentKind, mime: string, name: string): string {
  const type = (mime || "").toLowerCase().split(";")[0]!.trim();
  if (kind === "pdf") return PDF_MIME;
  if (kind === "image") {
    if ((IMAGE_MIMES as readonly string[]).includes(type)) return type;
    const ext = extensionOf(name);
    if (ext === "png") return "image/png";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    return "image/jpeg";
  }
  if ((TEXT_MIMES as readonly string[]).includes(type)) return type;
  const ext = extensionOf(name);
  if (ext === "csv") return "text/csv";
  if (ext === "tsv") return "text/tab-separated-values";
  if (ext === "json") return "application/json";
  if (ext === "md") return "text/markdown";
  return "text/plain";
}

/** Formats that get a specific refusal rather than a shrug. */
const NAMED_REFUSALS: Record<string, string> = {
  xlsx: "Excel workbooks can't be read — save the sheet as CSV and attach that.",
  xls: "Excel workbooks can't be read — save the sheet as CSV and attach that.",
  xlsm: "Excel workbooks can't be read — save the sheet as CSV and attach that.",
  docx: "Word files can't be read — export it to PDF and attach that.",
  doc: "Word files can't be read — export it to PDF and attach that.",
  pptx: "Slide decks can't be read — export them to PDF and attach that.",
  heic: "HEIC photos can't be read — share it as JPEG or PNG.",
  heif: "HEIF photos can't be read — share it as JPEG or PNG.",
  zip: "Archives can't be read — attach the file itself.",
};

/**
 * Why this file cannot go to Polaris, or null if it can. Returned as prose
 * because the user sees it verbatim, on the client and from the server.
 */
export function attachmentRejection(file: {
  name: string;
  type: string;
  size: number;
}): string | null {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(
      MAX_ATTACHMENT_BYTES,
    )}.`;
  }
  if (attachmentKind(file.type, file.name)) return null;

  const named = NAMED_REFUSALS[extensionOf(file.name)];
  if (named) return `${file.name}: ${named}`;
  return `${file.name} isn't a type Polaris can read. Attach a photo, a PDF, or a CSV.`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
