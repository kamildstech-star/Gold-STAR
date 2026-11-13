import { supabase } from "@/integrations/supabase/client";
import { fetchAccountLocationsMap } from "@/lib/account-locations";
import { countsTowardRep, inRepBook, isCompanyOwned } from "@/lib/account-ownership";
import { fetchHouseAccountLabelsOrNone } from "@/lib/house-accounts";

/**
 * The weekly sales report is the meeting agenda, so it leads with what was
 * missed. Everything here comes from captured activity — a touchpoint only
 * counts when the other side actually responded.
 *
 * ONE OFFICE, ONE RULE. Gold Star runs twelve offices, and this report was the
 * last export surface the office filter could not reach. It reaches it now
 * through a single question asked once: **which offices does the account
 * belong to?** — the office that owns it (`accounts.location_id`) plus every
 * office serving it (`account_locations`), which is the same rule the accounts
 * list and the location reports already use, so weekly sales cannot disagree
 * with them.
 *
 * Every figure hangs off that answer, because every figure hangs off an
 * account: a touchpoint, a missed cadence, a pipeline move, a closed job and a
 * payment all name one. Asking once is what keeps the summary at the top, the
 * cards underneath and the three export sheets from describing different sets
 * of records.
 *
 * The office is the **account's**, never the rep's. A rep who works six
 * offices is not forced into one and is not dropped from the other five: they
 * appear in each office's report carrying only that office's accounts.
 *
 * The filter can only narrow. It is applied on top of rows row-level security
 * has already returned, and the caller resolves the office id with
 * `resolveLocationChoice`, which never offers an office the viewer cannot
 * already see.
 */

/* --------------------------------------------------------------- the rule */

export type OfficeVerdict = "in" | "out" | "unattributed";

/**
 * Does a row belong under the chosen office?
 *
 *   - no office chosen → everything is in;
 *   - the row names the chosen office → in;
 *   - the row names only other offices → out;
 *   - the row names no office at all → `"unattributed"`.
 *
 * Unattributed is deliberately not "out". A record with no office is a gap in
 * the data, not a record belonging to somebody else, and dropping it would
 * mean the twelve office reports quietly add up to less than the company.
 * Such a record is carried into every office's view and counted separately,
 * so the page and the export can both name it rather than lose it.
 */
export function officeVerdict(
  offices: readonly string[] | null | undefined,
  chosen: string | null,
): OfficeVerdict {
  if (!chosen) return "in";
  const named = (offices ?? []).filter(Boolean);
  if (named.length === 0) return "unattributed";
  return named.includes(chosen) ? "in" : "out";
}

/**
 * Every office an account belongs to: the one that owns it plus every one
 * serving it. A multi-location company shows up on each serving office's
 * report, which is the whole point of `account_locations` — Jersey may own the
 * company while California works it.
 */
export function accountOffices(
  account: { id: string; location_id?: string | null },
  serving?: ReadonlyMap<string, readonly string[]>,
): string[] {
  const out = new Set<string>();
  if (account.location_id) out.add(account.location_id);
  for (const id of serving?.get(account.id) ?? []) if (id) out.add(id);
  return [...out];
}

export type AccountScope = {
  /** Offices per account, for every account the viewer can read. */
  officesById: Map<string, string[]>;
  /** Accounts this report counts: in the chosen office, or in none at all. */
  ids: Set<string>;
  /** Of those, the ones with no office recorded anywhere. */
  unattributed: Set<string>;
};

/**
 * Split the accounts the viewer can read into "counts here" and "belongs to
 * another office". Accounts with no office at all land in `unattributed` in
 * every view — including "all offices", where nothing is misplaced but the gap
 * is still worth naming.
 */
export function scopeAccounts(
  accounts: readonly { id: string; location_id?: string | null }[],
  serving: ReadonlyMap<string, readonly string[]> | undefined,
  chosen: string | null,
): AccountScope {
  const officesById = new Map<string, string[]>();
  const ids = new Set<string>();
  const unattributed = new Set<string>();

  for (const account of accounts) {
    const offices = accountOffices(account, serving);
    officesById.set(account.id, offices);
    if (offices.length === 0) unattributed.add(account.id);
    if (officeVerdict(offices, chosen) === "out") continue;
    ids.add(account.id);
  }

  return { officesById, ids, unattributed };
}

/**
 * The offices a payment belongs to. It inherits the account it was booked
 * against — through its job when it only names one — because the account is
 * what decides every other figure on this report. Only when no account can be
 * resolved at all (an older job outside this week's read, or an event that
 * names neither) does the event's own `location_id` speak, and an event with
 * none of the three is unattributed rather than dropped: money is the last
 * thing a report should lose quietly.
 */
export function moneyOffices(
  event: { account_id?: string | null; job_id?: string | null; location_id?: string | null },
  officesOfAccount: (accountId: string) => readonly string[] | undefined,
  accountOfJob: (jobId: string) => string | null | undefined,
): string[] {
  const accountId = event.account_id ?? (event.job_id ? accountOfJob(event.job_id) : null);
  if (accountId) {
    const offices = officesOfAccount(accountId);
    if (offices && offices.length > 0) return [...offices];
  }
  return event.location_id ? [event.location_id] : [];
}

/* --------------------------------------------------------------- the shape */

/* ------------------------------------------------------- whose week it is */

/**
 * Account id → its house label names, as `fetchHouseAccountLabels` returns
 * them. Absent means "not the company's", which is the only thing asked.
 */
export type HouseLabelMap = Record<string, readonly string[]>;

type OwnedRow = { id: string; assigned_rep: string | null };

/**
 * The accounts that make up one rep's week.
 *
 * Mark: "House accounts belong to the company rather than a rep." This report
 * is the rep's meeting agenda — their calls, their missed cadence, their
 * moves, their closed jobs, their cash. It used to be `assigned_rep === rep`,
 * which put a company relationship into a named person's week and then judged
 * them on how it went.
 *
 * The label decides, and only the label. An account with no rep is nobody's
 * week either way, so the unclaimed quarter of the book never reaches this
 * question — `inRepBook` answers false for it because there is no rep, not
 * because anyone decided it was the company's.
 */
export function repWeekAccounts<T extends OwnedRow>(
  accounts: T[],
  house: HouseLabelMap,
  rep: string,
): T[] {
  return accounts.filter((a) =>
    inRepBook({ assigned_rep: a.assigned_rep, labels: house[a.id] ?? [] }, rep),
  );
}

/**
 * The reps this report has a week for.
 *
 * Built from the same rule as the rows, so a rep holding nothing but house
 * accounts does not get a card of zeroes that reads like a bad week.
 */
export function repsWithABook<T extends OwnedRow>(accounts: T[], house: HouseLabelMap): string[] {
  const out = new Set<string>();
  for (const a of accounts) {
    if (!a.assigned_rep) continue;
    if (!countsTowardRep({ assigned_rep: a.assigned_rep, labels: house[a.id] ?? [] })) continue;
    out.add(a.assigned_rep);
  }
  return Array.from(out);
}

/**
 * The accounts held back from every rep's week, so the page can name them.
 *
 * The reassignment page settled this shape of question already: hiding a house
 * account leaves a Sales Head hunting for accounts that look lost. The report
 * has nowhere to put a company account — every figure hangs off a person — so
 * it says which ones, the same way it already says which accounts have no
 * office.
 */
export function companyOwnedRows<T extends { id: string }>(
  accounts: T[],
  house: HouseLabelMap,
): T[] {
  return accounts.filter((a) => isCompanyOwned({ labels: house[a.id] ?? [] }));
}

/** `office` is the account's owning office id, or null when it has none. */
export type WeeklyExceptions = {
  missedCadence: { id: string; name: string; days: number | null; office: string | null }[];
  needsAttention: { id: string; name: string; reason: string; office: string | null }[];
  annualWindow: {
    id: string;
    name: string;
    dueOn: string | null;
    missed: boolean;
    office: string | null;
  }[];
};

export type WeeklyActivity = {
  callsConnected: number;
  meetingsHeld: number;
  emailsReplied: number;
  outboundNoReply: number;
  touchedAccounts: number;
};

export type WeeklyPerson = {
  userId: string;
  name: string;
  activity: WeeklyActivity;
  exceptions: WeeklyExceptions;
  stageMoves: {
    accountName: string;
    from: string | null;
    to: string | null;
    at: string;
    office: string | null;
  }[];
  jobsClosed: number;
  cashReceivedCount: number;
};

export type WeeklySalesReport = {
  /** The office every figure below was built for; null means every office in scope. */
  locationId: string | null;
  people: WeeklyPerson[];
  /**
   * Accounts with no office on record. They are counted under every office
   * rather than under none; the page and the export name them so nobody has to
   * guess where they went.
   */
  unattributed: { id: string; name: string }[];
  /**
   * House accounts in scope. They belong to the company, so they are in
   * nobody's week — named here rather than dropped, so a short agenda is
   * explained instead of doubted.
   */
  companyOwned: { id: string; name: string }[];
};

export function weekWindow(reference = new Date()) {
  const end = new Date(reference);
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return { start, end };
}

const CADENCE_DAYS = 90;

/**
 * PostgREST puts `in.(…)` in the query string, so a long id list would blow
 * the URL length before it reached the database. Past this many accounts the
 * touchpoint read stays as wide as it always was and is narrowed in memory
 * instead — the in-memory scope is what decides the answer either way, the
 * `in` only stops one office paying for twelve offices' touchpoints.
 */
const MAX_INLINE_IDS = 150;

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Builds one person's agenda, or everyone's. `userId` null means "everyone in
 * scope" — RLS already limits the rows, so a rep asking for everyone still
 * only sees theirs. `locationId` null means every office the viewer may see.
 */
export async function buildWeeklySalesReport(
  userId: string | null,
  locationId: string | null = null,
  reference = new Date(),
): Promise<WeeklySalesReport> {
  const { start, end } = weekWindow(reference);

  // Round one settles which accounts this office owns or serves, because that
  // answer bounds everything read in round two.
  const [accountsRes, serving, profilesRes, pipelineStagesRes, houseLabels] = await Promise.all([
    supabase
      .from("accounts")
      .select(
        "id, name, assigned_rep, status, annual_meeting_due_on, annual_meeting_missed_at, health_stage_id, location_id",
      ),
    fetchAccountLocationsMap(),
    supabase.from("profiles").select("user_id, full_name"),
    supabase.from("pipeline_stages").select("id, name"),
    // Read in round one because it bounds who has a week, the same way the
    // office answer bounds what is in it.
    fetchHouseAccountLabelsOrNone(),
  ]);

  const accounts = accountsRes.data ?? [];
  const scope = scopeAccounts(accounts, serving, locationId);
  const inScope = accounts.filter((a) => scope.ids.has(a.id));
  const scopedIds = inScope.map((a) => a.id);

  // Only the ninety-day touchpoint read is worth narrowing at the database.
  // The other three are already bounded to one week, and leaving them whole is
  // what lets a move or a payment we cannot attribute survive as unattributed
  // instead of vanishing.
  let touchQuery = supabase
    .from("touchpoints")
    .select(
      "id, account_id, type, occurred_at, created_by, counts_toward_cadence, direction, duration_seconds, replied_at",
    )
    .gte("occurred_at", new Date(Date.now() - CADENCE_DAYS * 86_400_000).toISOString());
  if (locationId && scopedIds.length > 0 && scopedIds.length <= MAX_INLINE_IDS) {
    touchQuery = touchQuery.in("account_id", scopedIds);
  }

  const [touchRes, stageRes, jobsRes, moneyRes] = await Promise.all([
    touchQuery,
    supabase
      .from("account_stage_history")
      .select("account_id, from_stage, to_stage, changed_at, changed_by")
      .gte("changed_at", start.toISOString()),
    supabase
      .from("jobs")
      .select("id, account_id, status, updated_at")
      .gte("updated_at", start.toISOString()),
    supabase
      .from("money_events")
      .select("id, job_id, account_id, location_id, rep_user_id, event_type, created_at")
      .gte("created_at", start.toISOString()),
  ]);

  const touches = (touchRes.data ?? []).filter((t) => scope.ids.has(t.account_id));
  const stages = stageRes.data ?? [];
  const jobs = jobsRes.data ?? [];
  const money = moneyRes.data ?? [];
  const names = new Map((profilesRes.data ?? []).map((p) => [p.user_id, p.full_name ?? "Unnamed"]));
  const stageNames = new Map((pipelineStagesRes.data ?? []).map((s) => [s.id, s.name]));

  const reps = userId ? [userId] : repsWithABook(inScope, houseLabels);

  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const accountOfJob = new Map(jobs.map((j) => [j.id, j.account_id]));
  const officesOfAccount = (id: string) => scope.officesById.get(id);
  /** The owning office, for the label on an exception or a move. */
  const officeOf = (accountId: string) => accountById.get(accountId)?.location_id ?? null;

  const people = reps.map((rep) => {
    const mine = repWeekAccounts(inScope, houseLabels, rep);
    const mineIds = new Set(mine.map((a) => a.id));
    const inWeek = touches.filter(
      (t) =>
        mineIds.has(t.account_id) &&
        new Date(t.occurred_at) >= start &&
        new Date(t.occurred_at) <= end,
    );

    const activity: WeeklyActivity = {
      callsConnected: inWeek.filter((t) => t.type === "call" && (t.duration_seconds ?? 0) >= 30)
        .length,
      meetingsHeld: inWeek.filter(
        (t) => t.type === "meeting_in_person" || t.type === "meeting_virtual",
      ).length,
      emailsReplied: inWeek.filter((t) => t.type === "email" && t.replied_at).length,
      outboundNoReply: inWeek.filter((t) => t.direction === "outbound" && !t.counts_toward_cadence)
        .length,
      touchedAccounts: new Set(
        inWeek.filter((t) => t.counts_toward_cadence).map((t) => t.account_id),
      ).size,
    };

    // Missed cadence: no landed touch inside the quarter window.
    const missedCadence = mine
      .map((a) => {
        const landed = touches
          .filter((t) => t.account_id === a.id && t.counts_toward_cadence)
          .map((t) => t.occurred_at)
          .sort()
          .at(-1);
        const days = daysSince(landed ?? null);
        return { id: a.id, name: a.name, days, office: a.location_id ?? null };
      })
      .filter((r) => r.days === null || r.days >= CADENCE_DAYS)
      .sort((a, b) => (b.days ?? 9_999) - (a.days ?? 9_999));

    const needsAttention = mine
      .map((a) => ({ account: a, stage: stageNames.get(a.health_stage_id ?? "") ?? null }))
      .filter(({ stage }) => stage === "Needs Attention" || stage === "Ghosted")
      .map(({ account, stage }) => ({
        id: account.id,
        name: account.name,
        reason: stage === "Ghosted" ? "Ghosted" : "Task 7+ days past due",
        office: account.location_id ?? null,
      }));

    const annualWindow = mine
      .filter((a) => {
        if (a.annual_meeting_missed_at) return true;
        if (!a.annual_meeting_due_on) return false;
        const due = new Date(a.annual_meeting_due_on).getTime();
        return due - Date.now() <= 14 * 86_400_000;
      })
      .map((a) => ({
        id: a.id,
        name: a.name,
        dueOn: a.annual_meeting_due_on,
        missed: Boolean(a.annual_meeting_missed_at),
        office: a.location_id ?? null,
      }));

    // A move counts when the rep made it or it landed on one of their
    // accounts, and then only when the account it landed on belongs here. A
    // move whose account we cannot read has no office to judge, so it stays.
    const stageMoves = stages
      .filter((s) => s.changed_by === rep || mineIds.has(s.account_id))
      .filter((s) => officeVerdict(officesOfAccount(s.account_id), locationId) !== "out")
      .map((s) => ({
        accountName: accountById.get(s.account_id)?.name ?? "Account",
        from: s.from_stage ?? null,
        to: s.to_stage ?? null,
        at: s.changed_at,
        office: officeOf(s.account_id),
      }))
      .sort((a, b) => b.at.localeCompare(a.at));

    const myJobs = jobs.filter((j) => j.account_id && mineIds.has(j.account_id));
    const myJobIds = new Set(myJobs.map((j) => j.id));

    return {
      userId: rep,
      name: names.get(rep) ?? "Unnamed",
      activity,
      exceptions: { missedCadence, needsAttention, annualWindow },
      stageMoves,
      jobsClosed: myJobs.filter((j) => j.status === "complete" || j.status === "paid").length,
      cashReceivedCount: money.filter(
        (m) =>
          m.event_type === "payment_received" &&
          (m.rep_user_id === rep || (m.job_id ? myJobIds.has(m.job_id) : false)) &&
          officeVerdict(
            moneyOffices(m, officesOfAccount, (jobId) => accountOfJob.get(jobId) ?? null),
            locationId,
          ) !== "out",
      ).length,
    };
  });

  return {
    locationId,
    people,
    unattributed: accounts
      .filter((a) => scope.unattributed.has(a.id))
      .map((a) => ({ id: a.id, name: a.name })),
    companyOwned: companyOwnedRows(inScope, houseLabels).map((a) => ({ id: a.id, name: a.name })),
  };
}
