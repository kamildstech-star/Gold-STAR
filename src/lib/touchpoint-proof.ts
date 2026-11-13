import { supabase } from "@/integrations/supabase/client";
import { SIGNED_URL_OPEN_SECONDS, signStoredFile } from "@/lib/signed-url";

/**
 * Proof on a hand-logged touch.
 *
 * Melly, GSR Edits: "Some things the rep logs by hand, like dropping off a
 * gift or having lunch. Those count, but only if the rep attaches something
 * — a photo of the gift, a copy of their thank you, meeting notes. The system
 * marks these unverified but accepts them. A rep clicking a button with
 * nothing attached does not count. It gets recorded as an attempt."
 *
 * The rule itself is the database's (`tg_touchpoint_cadence`, migration
 * 20261110190000): it decides `counts_toward_cadence`, and refuses a proof
 * path that was never uploaded under the account's folder. This module
 * uploads the file, attaches it, and says what a row should show.
 */

export const PROOF_BUCKET = "touchpoint-proof";
export const PROOF_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif,application/pdf";
export const PROOF_MAX_BYTES = 15 * 1024 * 1024;

export type ProofKind = "photo" | "file" | "form";

export function proofKindFor(file: Pick<File, "type">): Exclude<ProofKind, "form"> {
  return file.type.startsWith("image/") ? "photo" : "file";
}

/** What stops a file being used as proof, or null. */
export function proofFileProblem(file: Pick<File, "type" | "size">): string | null {
  if (!PROOF_ACCEPT.split(",").includes(file.type)) return "Attach a photo or a PDF.";
  if (file.size > PROOF_MAX_BYTES) return "That file is over 15 MB.";
  return null;
}

/** `{accountId}/{random}-{name}` — the account folder is what the bucket policy checks. */
export function proofPath(accountId: string, fileName: string, rand: string): string {
  const safe =
    fileName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-80) || "proof";
  return `${accountId}/${rand}-${safe}`;
}

export async function uploadProof(accountId: string, file: File): Promise<string> {
  const problem = proofFileProblem(file);
  if (problem) throw new Error(problem);
  const path = proofPath(accountId, file.name, crypto.randomUUID());
  const { error } = await supabase.storage
    .from(PROOF_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw error;
  return path;
}

/** Upload, then attach to an existing touch — the trigger re-judges it. */
export async function attachProof(input: {
  touchpointId: string;
  accountId: string;
  file: File;
}): Promise<boolean> {
  const path = await uploadProof(input.accountId, input.file);
  const { data, error } = await supabase
    .from("touchpoints")
    .update({ proof_path: path, proof_kind: proofKindFor(input.file) })
    .eq("id", input.touchpointId)
    .select("counts_toward_cadence")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Only the person who logged this can attach proof to it.");
  return data.counts_toward_cadence;
}

export async function proofLink(path: string): Promise<string> {
  const { data, error } = await signStoredFile(supabase, PROOF_BUCKET, path, {
    seconds: SIGNED_URL_OPEN_SECONDS,
  });
  if (error || !data) throw error ?? new Error("Could not open the proof.");
  return data.signedUrl;
}

/** When the rule started, so a touch from before it is not offered proof. */
export async function fetchFollowupRuleStart(): Promise<string | null> {
  const { data, error } = await supabase.rpc("followup_rule_settings");
  if (error) return null;
  return data?.[0]?.starts_at ?? null;
}

export type ProofState =
  /** Logged by hand and counted: accepted, but on the rep's word. */
  | "unverified"
  /** Logged by hand with nothing attached since the rule: an attempt that proof would turn into a follow-up. */
  | "needs_proof"
  /** Anything else: captured by the system, or not a follow-up either way. */
  | null;

export function proofState(
  t: {
    is_self_reported: boolean;
    counts_toward_cadence: boolean;
    proof_kind?: string | null;
    meeting_held?: boolean | null;
    is_auto_reply?: boolean;
    created_at: string;
  },
  ruleStart: string | null,
): ProofState {
  if (!t.is_self_reported) return null;
  if (t.counts_toward_cadence) return t.proof_kind === "form" ? null : "unverified";
  if (t.proof_kind || t.meeting_held === false || t.is_auto_reply) return null;
  if (!ruleStart || t.created_at < ruleStart) return null;
  return "needs_proof";
}
