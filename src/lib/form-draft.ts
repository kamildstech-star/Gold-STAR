/**
 * Keeps a long form's half-typed contents on the device until it is submitted.
 *
 * Mark, 5 Oct, with /jobs/new open next to JobNimbus and a spreadsheet: "when
 * they switch tabs, it doesnt keep things in the fields." The provider bug
 * that unmounted the route on every tab switch is fixed separately — but a
 * browser is still allowed to discard a background tab whenever it wants
 * memory back, and no amount of care inside the page prevents that. New job
 * is forty-odd fields of intake. Re-keying it because Chrome reclaimed a tab
 * is not something a rep should ever have to do, so the draft is written
 * where it survives the page.
 *
 * WHY IndexedDB AND NOT localStorage.
 * localStorage is a synchronous main-thread write of a serialised string. The
 * draft here is the whole form — picked accounts, contacts, contact methods,
 * intake answers — and it is written while someone is typing into it, on a
 * field tablet. idb-keyval's put is asynchronous and structured-cloned, so it
 * costs the typist nothing. It is also what the rest of this app's durable
 * per-user state already uses: offline-queue.ts (`sync-queue:`) and photos.ts
 * (`photo-queue:`) both key by owner into the same store, and a reviewer
 * looking for "where does unsent work live" should find one answer.
 *
 * SCOPING. Field tablets are shared. A key carries the owner and so does the
 * record, and a draft is only ever returned when both agree with the signed-in
 * user — the same belt-and-braces offline-queue.ts uses, for the same reason:
 * one rep's half-typed job must never open under another rep's login.
 */
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";

const PREFIX = "form-draft:";

/**
 * Bump when a form's saved shape changes incompatibly. A draft written by an
 * older build is discarded rather than spread over mismatched fields.
 */
export const DRAFT_SHAPE_VERSION = 1;

/**
 * A week. Long enough that Friday's interrupted intake is still there on
 * Monday; short enough that a draft nobody came back to does not reappear
 * months later looking like today's work.
 */
export const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type FormDraft<T = Record<string, unknown>> = {
  ownerId: string;
  formId: string;
  version: number;
  savedAt: number;
  values: T;
};

/** `form-draft:<owner>:<form>`, both components encoded so neither can forge a key. */
export function draftKey(ownerId: string, formId: string): string {
  return PREFIX + encodeURIComponent(ownerId) + ":" + encodeURIComponent(formId);
}

/* --------------------------------------------------------------- shaping */

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/**
 * What survives a round trip, and what is dropped on purpose.
 *
 * A `File` from a picker, a `Blob`, a function, a class instance — none of
 * them mean anything once the page is gone, and structured clone either
 * refuses them or revives something subtly wrong. Rather than let a save
 * throw halfway through (losing the whole draft because one field held a
 * file) each offending value is left out and its path reported, so the caller
 * can tell the user what did not come back instead of pretending it did.
 *
 * `undefined` is simply absent, not "dropped" — that is what an unset
 * optional field looks like and it is not worth telling anyone about.
 */
export function sanitizeDraftValues(input: unknown): { values: Json; dropped: string[] } {
  const dropped: string[] = [];
  const seen = new WeakSet<object>();

  const walk = (value: unknown, path: string): Json | undefined => {
    if (value === null) return null;
    const t = typeof value;
    if (t === "string" || t === "boolean") return value as Json;
    if (t === "number") return Number.isFinite(value as number) ? (value as number) : null;
    if (t === "undefined") return undefined;
    if (t !== "object") {
      // function, symbol, bigint
      dropped.push(path);
      return undefined;
    }
    const obj = value as object;
    if (seen.has(obj)) {
      dropped.push(path);
      return undefined;
    }
    if (Array.isArray(obj)) {
      seen.add(obj);
      // A hole or an undefined entry would change length on the way back, so
      // they become null rather than disappearing.
      return obj.map((v, i) => walk(v, `${path}[${i}]`) ?? null);
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      // Date, File, Blob, Map, Set, a class instance — anything that is not a
      // plain bag of fields.
      dropped.push(path);
      return undefined;
    }
    seen.add(obj);
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const next = walk(v, path ? `${path}.${k}` : k);
      if (next !== undefined) out[k] = next;
    }
    return out;
  };

  const values = walk(input, "");
  return { values: (values ?? {}) as Json, dropped };
}

/**
 * Is this stored thing a draft we are allowed to open?
 *
 * Every clause is a refusal we want: a draft for another person, for another
 * form, from an incompatible build, or older than we promised to keep.
 * `now` is a required argument — a helper that reaches for `Date.now()` on
 * its own is how a test with a fixed fixture date passes all year and then
 * goes red on a Tuesday.
 */
export function isRestorableDraft(
  raw: unknown,
  opts: { ownerId: string; formId: string; now: number; maxAgeMs?: number; version?: number },
): raw is FormDraft {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const d = raw as Partial<FormDraft>;
  if (d.ownerId !== opts.ownerId) return false;
  if (d.formId !== opts.formId) return false;
  if (d.version !== (opts.version ?? DRAFT_SHAPE_VERSION)) return false;
  if (typeof d.savedAt !== "number" || !Number.isFinite(d.savedAt)) return false;
  if (!d.values || typeof d.values !== "object" || Array.isArray(d.values)) return false;
  const age = opts.now - d.savedAt;
  // A clock that moved backwards (a tablet syncing time) gives a negative age.
  // That is odd, not dangerous; only genuine staleness refuses.
  if (age > (opts.maxAgeMs ?? DRAFT_MAX_AGE_MS)) return false;
  return true;
}

/**
 * Is there anything here worth keeping?
 *
 * A form fills several fields in by itself — today's date, the default
 * office, the default payment type. Writing those out as a "draft" would mean
 * every rep who merely opened the page and left gets offered a restore of
 * nothing. Only a value the person actually differs from the blank form
 * counts.
 */
export function draftHasContent(
  values: Record<string, unknown>,
  blank: Record<string, unknown>,
  opts?: { ignore?: readonly string[] },
): boolean {
  const ignore = new Set(opts?.ignore ?? []);
  for (const [key, value] of Object.entries(values)) {
    // Fields the form fills in by itself — the office, the stage, the nearest
    // branch. They are set before anyone has typed a character, so counting
    // them would mean every rep who merely opened the page and walked away
    // gets offered a restore of nothing.
    if (ignore.has(key)) continue;
    if (isBlankish(value)) continue;
    if (JSON.stringify(value) === JSON.stringify(blank[key])) continue;
    return true;
  }
  return false;
}

function isBlankish(value: unknown): boolean {
  if (value === null || value === undefined || value === "" || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value as object).length === 0;
  return false;
}

/** "just now" / "4 minutes ago" / "2 hours ago" / "3 days ago". `now` is explicit on purpose. */
export function draftAge(savedAt: number, now: number): string {
  const ms = Math.max(0, now - savedAt);
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* ----------------------------------------------------------- the debounce */

export type DraftSaver<T> = {
  /** Record the latest values; the write happens once typing pauses. */
  queue: (values: T) => void;
  /** Write whatever is pending right now (leaving the tab, submitting). */
  flush: () => void;
  /** Forget what is pending — used when the draft has just been cleared. */
  cancel: () => void;
};

/**
 * One write per pause, not one per keystroke. 800ms is long enough that a
 * sentence typed at speed is a single write and short enough that a tab
 * discarded moments after someone stops typing still has it.
 */
export const DRAFT_DEBOUNCE_MS = 800;

export function makeDraftSaver<T>(
  write: (values: T) => void,
  delayMs: number = DRAFT_DEBOUNCE_MS,
): DraftSaver<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: { values: T } | null = null;

  const fire = () => {
    timer = undefined;
    if (!pending) return;
    const { values } = pending;
    pending = null;
    write(values);
  };

  return {
    queue(values: T) {
      pending = { values };
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fire, delayMs);
    },
    flush() {
      if (timer !== undefined) clearTimeout(timer);
      fire();
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      pending = null;
    },
  };
}

/* ------------------------------------------------------------- the store */

/**
 * Save, restore and clear never throw. A browser in private mode, a tablet
 * out of quota, a store the user blocked — none of that is a reason to stop
 * someone creating a job. The draft is a safety net, not a dependency.
 */
export async function saveFormDraft(
  ownerId: string,
  formId: string,
  values: unknown,
  now: number,
): Promise<{ saved: boolean; dropped: string[] }> {
  if (!ownerId) return { saved: false, dropped: [] };
  const { values: clean, dropped } = sanitizeDraftValues(values);
  const draft: FormDraft<Json> = {
    ownerId,
    formId,
    version: DRAFT_SHAPE_VERSION,
    savedAt: now,
    values: clean,
  };
  try {
    await idbSet(draftKey(ownerId, formId), draft);
    return { saved: true, dropped };
  } catch {
    return { saved: false, dropped };
  }
}

export async function loadFormDraft<T = Record<string, unknown>>(
  ownerId: string,
  formId: string,
  opts: { now: number; maxAgeMs?: number },
): Promise<FormDraft<T> | null> {
  if (!ownerId) return null;
  let raw: unknown;
  try {
    raw = await idbGet(draftKey(ownerId, formId));
  } catch {
    return null;
  }
  if (!isRestorableDraft(raw, { ownerId, formId, now: opts.now, maxAgeMs: opts.maxAgeMs })) {
    // A draft that will never be offered is a draft worth deleting, so a stale
    // one does not sit on a shared tablet forever.
    if (raw !== undefined) void clearFormDraft(ownerId, formId);
    return null;
  }
  return raw as FormDraft<T>;
}

export async function clearFormDraft(ownerId: string, formId: string): Promise<void> {
  if (!ownerId) return;
  try {
    await idbDel(draftKey(ownerId, formId));
  } catch {
    /* nothing to do: the draft is advisory */
  }
}
