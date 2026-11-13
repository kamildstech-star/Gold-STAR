import type { Json } from "@/integrations/supabase/types";
import { AUDIT_ACTION_LABEL, LOCATION_MEMBER_ROLE_LABEL } from "@/lib/admin";
import { PAGE_BY_ID, PAGE_KEY_PREFIX, isPagePermissionKey } from "@/lib/page-access";
import { ROLE_LABELS } from "@/lib/roles";

/**
 * Reading `role_change_audit` back as sentences.
 *
 * Every access change in the system — a role given a page, a person granted a
 * capability, a role assigned — already lands in `role_change_audit` through
 * SECURITY DEFINER triggers, one row per write, with the raw before/after row
 * as JSON. That is the right thing to store and the wrong thing to show: an
 * administrator asking "who let crew into Pipeline?" should not have to read
 * `{"role":"crew","permission_key":"page.pipeline"}`.
 *
 * This module is pure so the wording is testable. Fetching lives in
 * `page-access-admin.ts`; rendering in `components/access/access-history.tsx`.
 */

export type AuditRow = {
  id: string;
  action: string;
  entity: string | null;
  actor_id: string | null;
  target_user_id: string | null;
  old_value: Json | null;
  new_value: Json | null;
  occurred_at: string;
};

export type AuditLine = {
  /** What happened, e.g. "Page allowed". */
  title: string;
  /** What it happened to, e.g. "Pipeline" or "Fleet: manage". */
  subject: string | null;
  /** "off → on", "grant → block", … — the old and new value in two words. */
  change: string | null;
  /** The role the change was made on, when the row is a role-level rule. */
  role: string | null;
  /** A qualifier in plain words, e.g. "as Field" on a location membership. */
  detail: string | null;
};

/**
 * Names for the ids an audit row stores. Both maps come from the app context,
 * which already holds every office and region once for the whole session, so
 * a forty-line history costs no extra reads.
 */
export type AuditNames = {
  locations?: ReadonlyMap<string, string>;
  regions?: ReadonlyMap<string, string>;
};

type Rec = Record<string, Json | undefined>;

function asRecord(v: Json | null | undefined): Rec | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : null;
}

/** "location_members" → "Location members"; "some_action" → "Some action". */
function humanise(ident: string): string {
  const words = ident.replace(/[_.-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : ident;
}

/** Bookkeeping columns every table carries; they say nothing about the change. */
const NOISE_FIELDS = new Set(["id", "created_at", "updated_at", "user_id"]);

function scalar(v: Json | undefined): string | null {
  if (v === undefined) return null;
  if (v === null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null; // nested objects are not a sentence
}

/**
 * The fields a row stores, as "field: value" pairs — with "old → new" where
 * the two sides differ. Only for entities nobody has written wording for; the
 * point is that even then a manager reads words, not braces.
 */
function fieldSummary(before: Rec | null, after: Rec | null): string | null {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter(
    (k) => !NOISE_FIELDS.has(k),
  );
  const parts: string[] = [];
  for (const k of keys) {
    const o = scalar(before?.[k]);
    const n = scalar(after?.[k]);
    const label = humanise(k).toLowerCase();
    if (o !== null && n !== null && o !== n) parts.push(`${label}: ${o} → ${n}`);
    else if (n !== null) parts.push(`${label}: ${n}`);
    else if (o !== null) parts.push(`${label}: ${o}`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}

function locationName(id: string | null, names?: AuditNames): string | null {
  if (!id) return null;
  return names?.locations?.get(id) ?? "a location no longer on file";
}

function regionName(id: string | null, names?: AuditNames): string | null {
  if (!id) return null;
  return names?.regions?.get(id) ?? "a region no longer on file";
}

function memberRoleLabel(role: string | null): string | null {
  if (!role) return null;
  return (LOCATION_MEMBER_ROLE_LABEL as Record<string, string>)[role] ?? humanise(role);
}

/** "page.jobs" → "Jobs"; "fleet.manage" → "fleet.manage" (the catalogue label is
 *  resolved by the caller when it has one). */
export function subjectForKey(
  key: string | null,
  labels?: ReadonlyMap<string, string>,
): string | null {
  if (!key) return null;
  if (isPagePermissionKey(key)) {
    const page = PAGE_BY_ID.get(key.slice(PAGE_KEY_PREFIX.length));
    return page ? page.label : key;
  }
  return labels?.get(key) ?? key;
}

function roleLabel(role: string | null): string | null {
  if (!role) return null;
  return (ROLE_LABELS as Record<string, string>)[role] ?? role;
}

/**
 * One audit row → one line. Every entity the triggers write today has its own
 * wording; anything added later still comes out as words — the action, the
 * entity, and its fields — never as a JSON blob.
 */
export function describeAuditRow(
  row: Pick<AuditRow, "action" | "entity" | "old_value" | "new_value">,
  labels?: ReadonlyMap<string, string>,
  names?: AuditNames,
): AuditLine {
  const after = asRecord(row.new_value);
  const before = asRecord(row.old_value);
  const value = after ?? before;

  if (row.entity === "role_permissions") {
    const key = str(value?.permission_key);
    const page = key ? isPagePermissionKey(key) : false;
    const what = page ? "Page" : "Capability";
    const added = row.action === "role_permission_added";
    const removed = row.action === "role_permission_removed";
    return {
      title: added ? `${what} allowed` : removed ? `${what} removed` : `${what} changed`,
      subject: subjectForKey(key, labels),
      change: added ? "off → on" : removed ? "on → off" : null,
      role: roleLabel(str(value?.role)),
      detail: null,
    };
  }

  if (row.entity === "user_permissions") {
    const key = str(value?.permission_key);
    const page = key ? isPagePermissionKey(key) : false;
    const what = page ? "Page" : "Capability";
    const effectWord = (e: string | null) =>
      e === "revoke" ? "block" : e === "grant" ? "allow" : e;
    const oldEffect = effectWord(str(before?.effect));
    const newEffect = effectWord(str(after?.effect));
    switch (row.action) {
      case "user_permission_added":
      case "permission_granted":
      case "permission_revoked":
        return {
          title:
            newEffect === "block"
              ? `${what} blocked for this person`
              : `${what} allowed for this person`,
          subject: subjectForKey(key, labels),
          change: `role → ${newEffect ?? "allow"}`,
          role: null,
          detail: null,
        };
      case "user_permission_removed":
      case "permission_removed":
        return {
          title: "Personal override cleared",
          subject: subjectForKey(key, labels),
          change: `${oldEffect ?? "override"} → role`,
          role: null,
          detail: null,
        };
      default:
        return {
          title: "Personal override changed",
          subject: subjectForKey(key, labels),
          change: oldEffect && newEffect ? `${oldEffect} → ${newEffect}` : null,
          role: null,
          detail: null,
        };
    }
  }

  if (row.entity === "user_roles") {
    return {
      title: AUDIT_ACTION_LABEL[row.action] ?? humanise(row.action),
      subject: roleLabel(str(value?.role)),
      change:
        row.action === "role_granted"
          ? "off → on"
          : row.action === "role_revoked"
            ? "on → off"
            : null,
      role: null,
      detail: null,
    };
  }

  // Office membership: "Location added · Baltimore, MD · as Field". The role
  // here is the membership role (manager/office/field), not an app role.
  if (row.entity === "location_members") {
    const oldRole = memberRoleLabel(str(before?.role));
    const newRole = memberRoleLabel(str(after?.role));
    const roleChanged = oldRole && newRole && oldRole !== newRole;
    const current = newRole ?? oldRole;
    return {
      title: AUDIT_ACTION_LABEL[row.action] ?? humanise(row.action),
      subject: locationName(str(value?.location_id), names),
      change: roleChanged ? `${oldRole} → ${newRole}` : null,
      role: null,
      detail: roleChanged || !current ? null : `as ${current}`,
    };
  }

  if (row.entity === "region_members") {
    return {
      title: AUDIT_ACTION_LABEL[row.action] ?? humanise(row.action),
      subject: regionName(str(value?.region_id), names),
      change: null,
      role: null,
      detail: null,
    };
  }

  // Sign-in on or off. The title already says which way; the stored
  // {"is_active": false} adds nothing a manager needs to read.
  if (row.entity === "profiles") {
    const was = before?.is_active;
    const now = after?.is_active;
    const word = (b: Json | undefined) =>
      b === true ? "active" : b === false ? "inactive" : null;
    const o = word(was);
    const n = word(now);
    return {
      title: AUDIT_ACTION_LABEL[row.action] ?? humanise(row.action),
      subject: null,
      change: o && n && o !== n ? `${o} → ${n}` : null,
      role: null,
      detail: null,
    };
  }

  // Anything a later trigger starts writing: name the record and its fields.
  return {
    title: AUDIT_ACTION_LABEL[row.action] ?? humanise(row.action),
    subject: row.entity ? humanise(row.entity) : null,
    change: null,
    role: null,
    detail: fieldSummary(before, after),
  };
}

/** Which stored role a role-level audit row is about, or null for personal rows. */
export function auditRowRole(row: Pick<AuditRow, "old_value" | "new_value">): string | null {
  const value = asRecord(row.new_value) ?? asRecord(row.old_value);
  return str(value?.role);
}
