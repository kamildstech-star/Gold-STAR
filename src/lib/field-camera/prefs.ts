/**
 * What the Field Camera remembers.
 *
 * Per session (sessionStorage): the last job, folder and tag, so reopening the
 * camera between rooms lands where the crew left off — but a new day starts
 * clean, because yesterday's job is the wrong default for a photo today.
 *
 * Per user (localStorage): the stamp template, because it is a preference,
 * not a context. Keyed by user id so a shared truck tablet does not hand one
 * crew member's template to the next.
 *
 * Every read and write is wrapped: private browsing, a full quota or a
 * locked-down browser must never take the camera down with it.
 */
import { DEFAULT_TEMPLATE, normaliseFields, STAMP_PRESETS, type StampField } from "./stamp";

type Store = Pick<Storage, "getItem" | "setItem">;

function session(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function local(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readJson(store: Store | null, key: string): unknown {
  try {
    const raw = store?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(store: Store | null, key: string, value: unknown): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or a locked-down browser — the camera works without memory.
  }
}

export type CameraSession = {
  jobId: string | null;
  folderId: string | null;
  tagId: string | null;
  /** Jobs picked this session, most recent first, for the picker's order. */
  recentJobIds: string[];
};

const SESSION_STORE = "field-camera:session";
const EMPTY_SESSION: CameraSession = { jobId: null, folderId: null, tagId: null, recentJobIds: [] };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

export function readCameraSession(store: Store | null = session()): CameraSession {
  const v = readJson(store, SESSION_STORE) as Partial<CameraSession> | null;
  if (!v || typeof v !== "object") return { ...EMPTY_SESSION };
  return {
    jobId: str(v.jobId),
    folderId: str(v.folderId),
    tagId: str(v.tagId),
    recentJobIds: Array.isArray(v.recentJobIds)
      ? v.recentJobIds.filter((x): x is string => typeof x === "string").slice(0, 10)
      : [],
  };
}

export function writeCameraSession(
  patch: Partial<CameraSession>,
  store: Store | null = session(),
): CameraSession {
  const cur = readCameraSession(store);
  const next: CameraSession = { ...cur, ...patch };
  if (patch.jobId && patch.jobId !== cur.jobId) {
    next.recentJobIds = [patch.jobId, ...cur.recentJobIds.filter((id) => id !== patch.jobId)].slice(
      0,
      10,
    );
    // A folder and a tag belong to the job they were picked on.
    if (patch.folderId === undefined) next.folderId = null;
  }
  writeJson(store, SESSION_STORE, next);
  return next;
}

export type StoredTemplate = { presetId: string; fields: StampField[] };

const templateKey = (userId: string) => `field-camera:template:${userId}`;

/** The user's stamp template; the default preset when nothing usable is stored. */
export function readTemplate(userId: string | null, store: Store | null = local()): StoredTemplate {
  const fallback = { presetId: DEFAULT_TEMPLATE.id, fields: [...DEFAULT_TEMPLATE.fields] };
  if (!userId) return fallback;
  const v = readJson(store, templateKey(userId)) as Partial<StoredTemplate> | null;
  if (!v || typeof v !== "object" || !Array.isArray(v.fields)) return fallback;
  const presetId =
    typeof v.presetId === "string" &&
    (v.presetId === "custom" || STAMP_PRESETS.some((p) => p.id === v.presetId))
      ? v.presetId
      : "custom";
  return { presetId, fields: normaliseFields(v.fields) };
}

export function writeTemplate(
  userId: string | null,
  t: StoredTemplate,
  store: Store | null = local(),
): void {
  if (!userId) return;
  writeJson(store, templateKey(userId), {
    presetId: t.presetId,
    fields: normaliseFields(t.fields),
  });
}
