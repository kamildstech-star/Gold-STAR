/**
 * People — one place for everyone at Gold Star.
 *
 * Melly, 6 Nov (GSR Edits, "Reassign a book - People and Pay - Offboarding"):
 * "instead of 3 tabs we should have one tab of people at the company … simple
 * cards for everyone: name, title, time at Gold Star … Stages: Interviewing,
 * Onboarding, Active, Offboarding, Former." And on the call: "it could look
 * exactly like [the Vendors] page … counts by stage on top, then person boxes
 * you click into."
 *
 * The stage is mostly DERIVED from records the app already keeps, so it cannot
 * disagree with them:
 *
 *   an offboarding checklist still open   -> Offboarding
 *   a deactivated profile                 -> Former
 *   a signup waiting for approval         -> Onboarding
 *   otherwise                             -> Active
 *
 * Interviewing and Onboarding have no record of their own, so a manager sets
 * them on the person's profile (`profiles.employment_stage`, migration
 * 20261110200000). A stored stage can only say Interviewing or Onboarding;
 * Offboarding and Former always come from the checklist and the lockout,
 * which are the actions that make them true.
 */
import { supabase } from "@/integrations/supabase/client";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { Tone } from "@/lib/tone";

export const PEOPLE_STAGES = [
  "interviewing",
  "onboarding",
  "active",
  "offboarding",
  "former",
] as const;
export type PeopleStage = (typeof PEOPLE_STAGES)[number];

export const PEOPLE_STAGE_LABEL: Record<PeopleStage, string> = {
  interviewing: "Interviewing",
  onboarding: "Onboarding",
  active: "Active",
  offboarding: "Offboarding",
  former: "Former",
};

/** One tone per meaning: in progress (info), joining (brand), working, leaving, gone. */
export const PEOPLE_STAGE_TONE: Record<PeopleStage, Tone> = {
  interviewing: "info",
  onboarding: "brand",
  active: "success",
  offboarding: "warning",
  former: "neutral",
};

/** The stages a manager may set by hand. The other two follow from actions. */
export const SETTABLE_STAGES: readonly PeopleStage[] = ["interviewing", "onboarding", "active"];

export type StageInput = {
  isActive: boolean;
  approvalStatus?: string | null;
  storedStage?: string | null;
  openOffboarding: boolean;
};

export function personStage(p: StageInput): PeopleStage {
  if (p.openOffboarding) return "offboarding";
  if (!p.isActive) return "former";
  if (p.storedStage === "interviewing" || p.storedStage === "onboarding") return p.storedStage;
  if (p.approvalStatus === "pending") return "onboarding";
  return "active";
}

export function countStages(
  people: readonly { stage: PeopleStage }[],
): Record<PeopleStage, number> {
  const out = Object.fromEntries(PEOPLE_STAGES.map((s) => [s, 0])) as Record<PeopleStage, number>;
  for (const p of people) out[p.stage] += 1;
  return out;
}

const DAY_MS = 86_400_000;

/** A calendar date's parts: the date as written for a date, local day for an instant. */
function dayParts(iso: string): [number, number, number] | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    return [y!, m! - 1, d!];
  }
  const t = new Date(iso);
  return Number.isFinite(t.getTime()) ? [t.getFullYear(), t.getMonth(), t.getDate()] : null;
}

/**
 * "3 yr 2 mo", "5 mo", "12 days", "Starts in 4 days" — time at Gold Star, in
 * calendar days and months so a work anniversary reads "1 yr" on the day.
 */
export function timeAtGoldStar(
  startIso: string | null | undefined,
  now: number = Date.now(),
): string {
  if (!startIso) return "—";
  const s = dayParts(startIso);
  if (!s) return "—";
  const n = new Date(now);
  const [sy, sm, sd] = s;
  const [ny, nm, nd] = [n.getFullYear(), n.getMonth(), n.getDate()];
  const days = Math.round((Date.UTC(ny, nm, nd) - Date.UTC(sy, sm, sd)) / DAY_MS);
  if (days < 0) return `Starts in ${-days} day${-days === 1 ? "" : "s"}`;
  const months = (ny - sy) * 12 + (nm - sm) - (nd < sd ? 1 : 0);
  if (months < 1) return `${days} day${days === 1 ? "" : "s"}`;
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} yr ${rest} mo` : `${years} yr`;
}

export type Person = {
  userId: string;
  name: string;
  title: string | null;
  roles: AppRole[];
  /** The job title, else the most senior role's label. */
  titleOrRole: string;
  officeId: string | null;
  officeName: string | null;
  isActive: boolean;
  approvalStatus: string | null;
  stage: PeopleStage;
  storedStage: PeopleStage | null;
  /** The day they started, as stored; falls back to the account's creation. */
  startedOn: string | null;
  startedOnStored: string | null;
  isDemo: boolean;
};

/** Role order for the label on a card — the role that says the most first. */
const ROLE_ORDER: AppRole[] = [
  "owner",
  "admin",
  "regional",
  "sales_head",
  "location_manager",
  "sales_manager",
  "office",
  "sales_person",
  "outside_sales_rep",
  "sales_rep",
  "cold_caller",
  "field_chaser",
  "crew",
  "field",
  "dev",
];

export function roleTitle(roles: readonly AppRole[]): string {
  const top = ROLE_ORDER.find((r) => roles.includes(r)) ?? roles[0];
  return top ? (ROLE_LABELS[top] ?? top) : "No role";
}

type ProfileRow = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  job_title: string | null;
  is_active: boolean;
  approval_status: string | null;
  primary_location_id: string | null;
  created_at: string;
  is_demo: boolean;
  employment_stage?: string | null;
  employment_started_on?: string | null;
};

const BASE_COLS =
  "user_id, full_name, email, job_title, is_active, approval_status, primary_location_id, created_at, is_demo";

/** Profiles with the employment columns when they exist, without them when not migrated yet. */
async function loadProfiles(): Promise<{ rows: ProfileRow[]; stageStored: boolean }> {
  const withStage = await supabase
    .from("profiles")
    .select(`${BASE_COLS}, employment_stage, employment_started_on`)
    .order("full_name");
  if (!withStage.error) return { rows: (withStage.data ?? []) as ProfileRow[], stageStored: true };
  if (!isMissingSchema(withStage.error)) throw withStage.error;
  const plain = await supabase.from("profiles").select(BASE_COLS).order("full_name");
  if (plain.error) throw plain.error;
  return { rows: (plain.data ?? []) as ProfileRow[], stageStored: false };
}

export async function fetchPeople(): Promise<{ people: Person[]; stageStored: boolean }> {
  const [{ rows, stageStored }, rolesRes, locRes, offRes] = await Promise.all([
    loadProfiles(),
    supabase.from("user_roles").select("user_id, role"),
    supabase.from("locations").select("id, name, code"),
    supabase.from("offboarding_checklists").select("user_id, status").eq("status", "open"),
  ]);
  if (rolesRes.error) throw rolesRes.error;
  if (locRes.error) throw locRes.error;
  if (offRes.error) throw offRes.error;

  const rolesBy = new Map<string, AppRole[]>();
  for (const r of rolesRes.data ?? []) {
    const list = rolesBy.get(r.user_id) ?? [];
    list.push(r.role as AppRole);
    rolesBy.set(r.user_id, list);
  }
  const office = new Map((locRes.data ?? []).map((l) => [l.id, l.name ?? l.code ?? null]));
  const leaving = new Set((offRes.data ?? []).map((o) => o.user_id));

  const people = rows
    // A rejected signup was never staff.
    .filter((p) => p.approval_status !== "rejected")
    .map((p): Person => {
      const roles = rolesBy.get(p.user_id) ?? [];
      const stored =
        p.employment_stage && (PEOPLE_STAGES as readonly string[]).includes(p.employment_stage)
          ? (p.employment_stage as PeopleStage)
          : null;
      return {
        userId: p.user_id,
        name: p.full_name?.trim() || p.email || p.user_id.slice(0, 8),
        title: p.job_title?.trim() || null,
        roles,
        titleOrRole: p.job_title?.trim() || roleTitle(roles),
        officeId: p.primary_location_id,
        officeName: p.primary_location_id ? (office.get(p.primary_location_id) ?? null) : null,
        isActive: p.is_active,
        approvalStatus: p.approval_status,
        stage: personStage({
          isActive: p.is_active,
          approvalStatus: p.approval_status,
          storedStage: stored,
          openOffboarding: leaving.has(p.user_id),
        }),
        storedStage: stored,
        startedOn: p.employment_started_on ?? p.created_at,
        startedOnStored: p.employment_started_on ?? null,
        isDemo: p.is_demo,
      };
    });
  return { people, stageStored };
}

export async function setPersonEmployment(input: {
  userId: string;
  stage: PeopleStage | null;
  startedOn: string | null;
}): Promise<void> {
  const { error } = await supabase.rpc("set_person_employment", {
    _user_id: input.userId,
    _stage: input.stage ?? undefined,
    _started_on: input.startedOn ?? undefined,
  });
  if (error) throw error;
}

export const PEOPLE_QUERY_KEY = ["people"] as const;

/** Profile tabs, and the old pages each one replaces. */
export const PERSON_TABS = ["pay", "book", "offboarding"] as const;
export type PersonTab = (typeof PERSON_TABS)[number];
export const PERSON_TAB_LABEL: Record<PersonTab, string> = {
  pay: "Pay & commission",
  book: "Book",
  offboarding: "Offboarding",
};
