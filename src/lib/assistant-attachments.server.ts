/**
 * Files handed to Polaris in the composer.
 *
 * The client's checks are re-run here on the decoded bytes, and the bytes are
 * sniffed rather than trusted: a renamed executable declaring `image/png` must
 * not reach the model or the bucket. Storage is written with the CALLER'S own
 * client, into a path that starts with their user id, so the same RLS that
 * governs every other read decides who can ever fetch it back — Polaris gains
 * no reach the asker did not already have.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { ulid } from "ulidx";

import type { Database } from "@/integrations/supabase/types";
import {
  ASSISTANT_ATTACHMENT_BUCKET,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type AttachmentKind,
  type AttachmentMeta,
  attachmentKind,
  attachmentRejection,
  formatBytes,
  normalisedMime,
} from "@/lib/assistant-attachments";
import { untrusted } from "@/lib/assistant-scope.server";

type DB = SupabaseClient<Database>;

export interface AttachmentInput {
  name: string;
  mime: string;
  data_base64: string;
}

/** A content part in the gateway's OpenAI-compatible message format. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export interface PreparedAttachment {
  meta: AttachmentMeta;
  parts: ContentPart[];
}

/** Text files are quoted into the prompt; a whole spreadsheet would not fit. */
const MAX_TEXT_CHARS = 40_000;

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

/** What the bytes actually are, independent of what the browser claimed. */
function sniff(bytes: Uint8Array): { kind: AttachmentKind; mime: string } | null {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return { kind: "pdf", mime: "application/pdf" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { kind: "image", mime: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg" };
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { kind: "image", mime: "image/gif" };
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return { kind: "image", mime: "image/webp" };
  }
  return null;
}

/** Valid UTF-8 with no NULs, or null — which is how a disguised binary reads. */
function asText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

/** Storage keys tolerate a narrow charset; the display name is kept in meta. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "attachment").slice(-80);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Validate, store and turn each attachment into model content.
 *
 * Every failure throws with the reason. A file that could not be read or
 * stored must never reach the model as silence — the user has to be told the
 * answer was formed without it.
 */
export async function prepareAttachments(
  supabase: DB,
  userId: string,
  inputs: AttachmentInput[],
): Promise<PreparedAttachment[]> {
  if (inputs.length > MAX_ATTACHMENTS) {
    throw new Error(`Polaris takes up to ${MAX_ATTACHMENTS} files at a time.`);
  }

  // Everything is checked before anything is written, so a rejected second
  // file cannot leave the first one orphaned in the bucket.
  const checked: Array<{
    input: AttachmentInput;
    bytes: Uint8Array;
    kind: AttachmentKind;
    mime: string;
    text: string | null;
  }> = [];

  for (const input of inputs) {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(input.data_base64);
    } catch {
      throw new Error(`${input.name} could not be read — the upload was corrupted.`);
    }

    // Re-run the client's rules against the real byte count, not a claim.
    const rejection = attachmentRejection({
      name: input.name,
      type: input.mime,
      size: bytes.length,
    });
    if (rejection) throw new Error(rejection);

    const claimed = attachmentKind(input.mime, input.name);
    if (!claimed) throw new Error(`${input.name} isn't a type Polaris can read.`);

    const sniffed = sniff(bytes);
    let kind: AttachmentKind;
    let mime: string;
    let text: string | null = null;

    if (sniffed) {
      kind = sniffed.kind;
      mime = sniffed.mime;
    } else {
      text = asText(bytes);
      if (!text) {
        throw new Error(
          `${input.name} isn't the kind of file it claims to be — Polaris can only read photos, PDFs and text.`,
        );
      }
      kind = "text";
      mime = normalisedMime("text", input.mime, input.name);
    }

    checked.push({ input, bytes, kind, mime, text });
  }

  const prepared: PreparedAttachment[] = [];
  for (const { input, bytes, kind, mime, text } of checked) {
    const path = `${userId}/${ulid()}-${safeFileName(input.name)}`;
    const { error } = await supabase.storage
      .from(ASSISTANT_ATTACHMENT_BUCKET)
      .upload(path, new Blob([bytes as unknown as BlobPart], { type: mime }), {
        contentType: mime,
        upsert: false,
      });
    if (error) {
      throw new Error(`Could not store ${input.name}: ${error.message}`);
    }

    const meta: AttachmentMeta = {
      name: input.name,
      mime,
      kind,
      size_bytes: bytes.length,
      storage_path: path,
    };

    if (kind === "text") {
      const body = text!.slice(0, MAX_TEXT_CHARS);
      const truncated = text!.length > MAX_TEXT_CHARS;
      prepared.push({
        meta,
        parts: [
          {
            type: "text",
            text: [
              `ATTACHED FILE: ${input.name} (${mime}, ${formatBytes(bytes.length)})${
                truncated ? ` — only the first ${MAX_TEXT_CHARS} characters are shown` : ""
              }`,
              untrusted(body),
            ].join("\n"),
          },
        ],
      });
      continue;
    }

    const dataUrl = `data:${mime};base64,${toBase64(bytes)}`;
    prepared.push({
      meta,
      parts: [
        {
          type: "text",
          text: `ATTACHED FILE: ${input.name} (${mime}, ${formatBytes(bytes.length)})`,
        },
        kind === "image"
          ? { type: "image_url", image_url: { url: dataUrl } }
          : { type: "file", file: { filename: safeFileName(input.name), file_data: dataUrl } },
      ],
    });
  }

  return prepared;
}
