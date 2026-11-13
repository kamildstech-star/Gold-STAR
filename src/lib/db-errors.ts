import { toast } from "sonner";
import type { PostgrestError } from "@supabase/supabase-js";

/**
 * Translate a Supabase / PostgREST error into a message that tells the user
 * what actually happened. The default `err.message` is often unhelpful — the
 * most common one, PGRST116 ("JSON object requested, multiple (or no) rows
 * returned"), is what an RLS-hidden row looks like after an `.insert().select()`.
 */
/**
 * PostgREST errors name the failing objects inside free text, not in fields.
 * Pull them out so the console line is diagnosable without a database session.
 */
export function dbErrorFacts(err: unknown): {
  code?: string;
  table?: string;
  relationship?: string;
  column?: string;
  constraint?: string;
  details?: string;
  hint?: string;
} {
  const e = err as Partial<PostgrestError> & {
    message?: string;
    code?: string;
    details?: string;
    hint?: string;
  };
  const raw = `${e?.message ?? ""} ${e?.details ?? ""} ${e?.hint ?? ""}`;
  const facts: ReturnType<typeof dbErrorFacts> = {};
  if (e?.code) facts.code = e.code;
  if (e?.details) facts.details = e.details;
  if (e?.hint) facts.hint = e.hint;

  // "Could not find a relationship between 'messages' and 'profiles' ..."
  const rel = raw.match(/relationship between '([^']+)' and '([^']+)'/i);
  if (rel) {
    facts.table = rel[1];
    facts.relationship = rel[2];
  }
  // "Perhaps you meant 'x'" / embedded resource hints
  const embed = raw.match(
    /Could not embed because more than one relationship was found for '([^']+)' and '([^']+)'/i,
  );
  if (embed) {
    facts.table = embed[1];
    facts.relationship = embed[2];
  }
  const col = raw.match(/column "?([\w.]+)"?/i);
  if (col) facts.column = col[1];
  const con = raw.match(/constraint "([^"]+)"/i);
  if (con) facts.constraint = con[1];
  const tbl = raw.match(/(?:relation|table) "([^"]+)"/i);
  if (tbl && !facts.table) facts.table = tbl[1];
  return facts;
}

export function describeDbError(err: unknown, context: { action: string }): string {
  const e = err as Partial<PostgrestError> & { message?: string; code?: string };
  const code = e?.code;
  const raw = e?.message ?? String(err ?? "");

  if (code === "PGRST200" || /relationship between/i.test(raw)) {
    const f = dbErrorFacts(err);
    const pair = f.table && f.relationship ? ` (${f.table} → ${f.relationship})` : "";
    return `${context.action} failed: the database has no declared link between these records${pair}. This needs a foreign key, not a UI change.`;
  }
  if (code === "PGRST116") {
    return `${context.action} appeared to succeed but the row was hidden by database permissions. Ask an admin to check your role and location access.`;
  }
  if (
    code === "42501" ||
    /permission denied|row-level security|violates row-level security/i.test(raw)
  ) {
    return `${context.action} was blocked by database permissions.`;
  }
  if (code === "23505" || /duplicate key/i.test(raw)) {
    return `${context.action} conflicts with an existing record.`;
  }
  if (code === "23503" || /foreign key/i.test(raw)) {
    return `${context.action} references something that no longer exists.`;
  }
  if (code === "23502" || /null value in column/i.test(raw)) {
    return `${context.action} is missing a required field.`;
  }
  const known = KNOWN_REFUSALS[raw.trim()];
  if (known) return known;
  return `${context.action} failed: ${raw || "unknown error"}`;
}

/**
 * Refusals the database raises by name, said in plain words. Keys are the
 * exact RAISE EXCEPTION texts (claim_incident, release_incident_claim,
 * log_incident_outcome and create_exposure_incident all raise 'Out of market').
 */
const KNOWN_REFUSALS: Record<string, string> = {
  "Out of market": "This alert is outside your market.",
};

/**
 * The message of a thrown value, or null. supabase-js throws PostgrestError
 * objects that are NOT `Error` instances, so `e instanceof Error` misses them.
 */
export function errorMessageOf(err: unknown): string | null {
  if (err instanceof Error) return err.message || null;
  if (typeof err === "string") return err || null;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === "string" && m ? m : null;
}

/**
 * Toast text for a failed action: the real reason (mapped to plain words when
 * it is a known refusal), or `fallback` only when there is no message at all.
 */
export function actionErrorMessage(err: unknown, fallback: string): string {
  const m = errorMessageOf(err)?.trim();
  if (!m) return fallback;
  return KNOWN_REFUSALS[m] ?? m;
}

/**
 * Wrap a Supabase query call — throws on error with a friendly message and
 * on empty single-row results (which usually means RLS hid the returned row).
 * Use it around mutation reads so silent failures become loud.
 */
export async function required<T>(
  promise: PromiseLike<{ data: T | null; error: unknown }>,
  context: { action: string },
): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(describeDbError(error, context));
  if (data == null) {
    throw new Error(
      `${context.action} appeared to succeed but the row was hidden by database permissions.`,
    );
  }
  return data;
}

/** Toast a Supabase error with a friendly message and log the raw error. */
export function toastDbError(err: unknown, context: { action: string }): void {
  const facts = dbErrorFacts(err);
  const tag = [
    facts.code && `code=${facts.code}`,
    facts.table && `table=${facts.table}`,
    facts.relationship && `relationship=${facts.relationship}`,
    facts.constraint && `constraint=${facts.constraint}`,
    facts.column && `column=${facts.column}`,
  ]
    .filter(Boolean)
    .join(" ");
  console.error(`[db-error] ${context.action}${tag ? ` [${tag}]` : ""}:`, err, facts);
  toast.error(describeDbError(err, context));
}

/** Plain readable text for any thrown value. Never returns an empty string. */
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  const m = (err as { message?: unknown } | null)?.message;
  if (typeof m === "string" && m) return m;
  try {
    return JSON.stringify(err) ?? "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/**
 * True only when the error genuinely indicates a permissions problem:
 * insufficient privilege, an explicit row-level-security message, or a
 * single-row fetch that returned nothing for a record we expected to exist.
 * A malformed query (missing column, bad embed) is NOT an access error.
 */
export function isAccessError(err: unknown, opts?: { expectedToExist?: boolean }): boolean {
  const e = err as Partial<PostgrestError> & { message?: string; code?: string };
  const raw = `${e?.message ?? ""} ${e?.details ?? ""}`;
  if (e?.code === "42501") return true;
  if (/row-level security|permission denied/i.test(raw)) return true;
  if (e?.code === "PGRST116" && opts?.expectedToExist !== false) return true;
  return false;
}

/** Honest one-line message for a failed record load. */
export function describeRecordLoad(err: unknown, ctx: { record: string }): string {
  if (err == null) {
    return `This ${ctx.record} isn't there any more, or it's outside the offices you can see.`;
  }
  if (isAccessError(err)) {
    return `You don't have access to this ${ctx.record}. If you think that's wrong, ask an admin.`;
  }
  const msg = describeDbError(err, { action: `Loading this ${ctx.record}` });
  return `${msg} Retry, and if it keeps happening send this message to support.`;
}

/** Console breadcrumb: record id and failing table, so a dev can act on it. */
export function logRecordLoad(
  err: unknown,
  ctx: { record: string; table: string; id?: string | null },
): void {
  const facts = dbErrorFacts(err);
  console.error(
    `[record-load] ${ctx.record} table=${ctx.table} id=${ctx.id ?? "unknown"}`,
    err,
    facts,
  );
}
