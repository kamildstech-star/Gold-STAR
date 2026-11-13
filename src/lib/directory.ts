import { supabase } from "@/integrations/supabase/client";
import { isPrivileged, type AppRole } from "@/lib/roles";

export type DirectoryPerson = {
  user_id: string;
  full_name: string | null;
  /** Work email. Null while profiles.email stays column-revoked — see below. */
  email: string | null;
  is_active: boolean;
  job_title: string | null;
  work_phone: string | null;
  extension: string | null;
  mobile_phone: string | null;
  /** Offices this person belongs to, as far as the viewer's RLS lets them see. */
  location_ids: string[];
  roles: AppRole[];
};

export type DirectoryResult =
  | {
      status: "ready";
      people: DirectoryPerson[];
      /** True when the work-email column came back denied, so every email is null. */
      emailsHidden: boolean;
    }
  | {
      /** The contact columns aren't in the database yet. Say so; don't show an empty list. */
      status: "needs-migration";
      missing: string;
    };

const BASE_COLUMNS = "user_id, full_name, is_active";
const CONTACT_COLUMNS = "job_title, work_phone, extension, mobile_phone";

/**
 * Declared here rather than derived from the generated Supabase types:
 * integrations/supabase/types.ts won't carry the contact columns until the
 * migration is applied and the types regenerated, which is also why the
 * result rows below are cast rather than inferred.
 */
type ProfileRow = {
  user_id: string;
  full_name: string | null;
  is_active: boolean;
  email?: string | null;
  job_title: string | null;
  work_phone: string | null;
  extension: string | null;
  mobile_phone: string | null;
};

type PgError = { code?: string; message?: string; details?: string } | null;

/** 42703 is what PostgREST returns for a column the database doesn't have. */
function missingColumn(err: PgError): string | null {
  if (!err) return null;
  const raw = `${err.message ?? ""} ${err.details ?? ""}`;
  if (err.code !== "42703" && !/does not exist/i.test(raw)) return null;
  return raw.match(/column "?[\w.]*?\.?(\w+)"?\s+does not exist/i)?.[1] ?? "contact details";
}

/** 42501 — the column exists but this role was never granted SELECT on it. */
function isDenied(err: PgError): boolean {
  return err?.code === "42501" || /permission denied/i.test(err?.message ?? "");
}

async function fetchProfiles(): Promise<{
  rows: ProfileRow[];
  emailsHidden: boolean;
  missing: string | null;
  error: unknown;
}> {
  // profiles.email is not granted to `authenticated` (20260806211619 revoked
  // it, and 20260821175812 left it out again). Ask for it anyway: the day
  // someone grants it the directory fills in with no code change, and until
  // then one retry without it keeps the page useful rather than broken.
  const withEmail = await supabase
    .from("profiles")
    .select(`${BASE_COLUMNS}, email, ${CONTACT_COLUMNS}`);

  if (!withEmail.error) {
    return {
      rows: (withEmail.data ?? []) as unknown as ProfileRow[],
      emailsHidden: false,
      missing: null,
      error: null,
    };
  }

  const missing = missingColumn(withEmail.error);
  if (missing && missing !== "email") {
    return { rows: [], emailsHidden: false, missing, error: null };
  }
  if (!isDenied(withEmail.error) && !missing) {
    return { rows: [], emailsHidden: false, missing: null, error: withEmail.error };
  }

  const withoutEmail = await supabase
    .from("profiles")
    .select(`${BASE_COLUMNS}, ${CONTACT_COLUMNS}`);
  return {
    rows: (withoutEmail.data ?? []) as unknown as ProfileRow[],
    emailsHidden: true,
    missing: missingColumn(withoutEmail.error),
    error: withoutEmail.error,
  };
}

/**
 * Three queries for the whole company — profiles, memberships, roles — then
 * stitched in memory. Never one query per person: this page loads every
 * employee at once and a per-row fetch would be hundreds of round trips.
 *
 * RLS narrows two of them for ordinary staff: location_members is readable
 * only for your own offices, and user_roles only for yourself. Both come back
 * short rather than failing, which is why the page hides the role column for
 * anyone who can't read it instead of showing a column of blanks.
 */
export async function fetchDirectory(): Promise<DirectoryResult> {
  const [profiles, memberships, roles] = await Promise.all([
    fetchProfiles(),
    supabase.from("location_members").select("user_id, location_id"),
    supabase.from("user_roles").select("user_id, role"),
  ]);

  if (profiles.missing) return { status: "needs-migration", missing: profiles.missing };
  if (profiles.error) throw profiles.error;
  if (memberships.error) throw memberships.error;
  if (roles.error) throw roles.error;

  const officesByUser = new Map<string, string[]>();
  for (const m of memberships.data ?? []) {
    const list = officesByUser.get(m.user_id) ?? [];
    list.push(m.location_id);
    officesByUser.set(m.user_id, list);
  }

  const rolesByUser = new Map<string, AppRole[]>();
  for (const r of roles.data ?? []) {
    const list = rolesByUser.get(r.user_id) ?? [];
    list.push(r.role as AppRole);
    rolesByUser.set(r.user_id, list);
  }

  const people = (profiles.rows ?? []).map<DirectoryPerson>((p) => ({
    user_id: p.user_id,
    full_name: p.full_name,
    email: p.email ?? null,
    is_active: p.is_active,
    job_title: p.job_title,
    work_phone: p.work_phone,
    extension: p.extension,
    mobile_phone: p.mobile_phone,
    location_ids: officesByUser.get(p.user_id) ?? [],
    roles: rolesByUser.get(p.user_id) ?? [],
  }));

  // Unnamed profiles are half-finished accounts, not people you look up.
  people.sort((a, b) => {
    if (!a.full_name || !b.full_name) return (a.full_name ? 0 : 1) - (b.full_name ? 0 : 1);
    return a.full_name.localeCompare(b.full_name, undefined, { sensitivity: "base" });
  });

  return { status: "ready", people, emailsHidden: profiles.emailsHidden };
}

/**
 * A work extension is company information. A personal mobile is not, so it is
 * shown only to the people who already carry that trust elsewhere in the app:
 * the same set public.can_read_staff_email() uses to release staff email,
 * plus legacy `office`, which maps onto location_manager everywhere else.
 *
 * This is a UI gate. Column privileges belong to the shared `authenticated`
 * database role, so Postgres cannot make this distinction for us.
 */
export function canSeeMobiles(roles: AppRole[]): boolean {
  return (
    isPrivileged(roles) ||
    roles.includes("regional") ||
    roles.includes("location_manager") ||
    roles.includes("office") ||
    roles.includes("sales_head")
  );
}

/**
 * tel: refuses spaces and brackets. `,,` is a two-second pause — an extension
 * only dials correctly once the switchboard has answered.
 */
export function telHref(phone: string | null, extension?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  if (!digits) return null;
  const ext = (extension ?? "").replace(/\D/g, "");
  return ext ? `tel:${digits},,${ext}` : `tel:${digits}`;
}

/** One lowercase haystack per person so the search box is a single pass. */
export function searchText(
  person: DirectoryPerson,
  officeNames: string[],
  roleLabels: string[],
): string {
  return [
    person.full_name,
    person.job_title,
    person.email,
    person.work_phone,
    person.extension,
    ...officeNames,
    ...roleLabels,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
