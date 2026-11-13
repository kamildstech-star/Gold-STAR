import { supabase } from "@/integrations/supabase/client";
import { isCompanyOwned } from "@/lib/account-ownership";
import { fetchGoals, goalWindow, elapsedShare } from "@/lib/goals";
import { fetchHouseAccountLabelsOrNone } from "@/lib/house-accounts";
import { fetchStandings, rankStandings, type Ranked } from "@/lib/leaderboard";

/**
 * Morning Brief — the manager's exception list.
 *
 * Every line is something that needs a decision this morning: an unclaimed
 * lead, a deal past its stage window, a rep off pace, a client slipping out
 * of cadence. Nothing here is a data dump — a healthy pipeline produces an
 * empty brief and says so in one line.
 *
 * All reads go through the signed-in user's client, so RLS decides the scope:
 * a location manager gets their office, a regional gets their states, the
 * owner gets everything. No dollar figure appears anywhere — the money rule
 * holds here exactly as it does on a rep's screen.
 *
 * Real records only. Demo rows (`is_demo`, seeded from Admin → Demo data and
 * purged from there) and shared reference records (`is_reference` — the
 * national carriers, which the database keeps off every pipeline with
 * `stage = 'reference'`) are never decisions, so they are excluded at the
 * query the way the fleet screens exclude demo vehicles, and again in
 * `buildMorningBrief` so the rule holds for any row that reaches it.
 */

export type BriefSectionKey = "needs_you" | "off_pace" | "slipping" | "closed" | "coverage";

export type BriefAction =
  | { kind: "open"; href: string; label: string }
  | { kind: "message"; userId: string; label: string };

export type BriefItem = {
  id: string;
  /** Short reason this line exists. */
  title: string;
  /** The decision-relevant fact, one clause. */
  detail: string;
  severity: "danger" | "warn" | "info";
  action: BriefAction;
};

export type BriefSection = {
  key: BriefSectionKey;
  title: string;
  /** Every row, most urgent first. The tile shows a handful; the drawer shows all. */
  items: BriefItem[];
};

export type MorningBrief = {
  generatedAt: string;
  sections: BriefSection[];
  total: number;
};

/** Tunables. Deliberately conservative — a brief that cries wolf gets ignored. */
export const BRIEF_THRESHOLDS = {
  /** A lead nobody claimed after this many hours is a decision. */
  unclaimedLeadHours: 24,
  /** Fallback when a stage has no configured window. */
  defaultStageWindowDays: 21,
  /** Relationship cadence: quarterly touch. */
  cadenceDays: 90,
  /** Annual meeting window opens two weeks before the deadline. */
  annualMeetingLeadDays: 14,
  /** Off pace when attainment trails the share of month elapsed by this much. */
  offPaceGap: 0.15,
};

const OPEN_LEAD_STAGES = ["leads", "new_lead_input", "ready"];
const CLOSED_STAGES = ["lost", "no_service_needed", "active_client", "goasted"];
/** The stage the database pins every `is_reference` account to. Never a pipeline card. */
const REFERENCE_STAGE = "reference";

const iso = (d: Date) => d.toISOString();
const dayKey = (d: Date) => d.toISOString().slice(0, 10);

function section(key: BriefSectionKey, title: string, items: BriefItem[]): BriefSection {
  return { key, title, items };
}

/** Sections in the order a manager reads them; ties in urgency break this way. */
export const BRIEF_SECTION_ORDER: BriefSectionKey[] = [
  "needs_you",
  "off_pace",
  "slipping",
  "closed",
  "coverage",
];

const SEVERITY_RANK: Record<BriefItem["severity"], number> = { danger: 0, warn: 1, info: 2 };

export type RankedBriefItem = BriefItem & { section: BriefSectionKey };

/**
 * The few lines the dashboard tile has room for, chosen across every section
 * rather than the first rows of each: red before amber before blue, then the
 * section a manager reads first, then the order the section already put them
 * in. Stable, so the same brief always shows the same three.
 */
export function topBriefItems(sections: BriefSection[], limit: number): RankedBriefItem[] {
  const all: RankedBriefItem[] = [];
  for (const s of sections) for (const item of s.items) all.push({ ...item, section: s.key });
  const sectionRank = (k: BriefSectionKey) => {
    const i = BRIEF_SECTION_ORDER.indexOf(k);
    return i < 0 ? BRIEF_SECTION_ORDER.length : i;
  };
  return all
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.item.severity] - SEVERITY_RANK[b.item.severity] ||
        sectionRank(a.item.section) - sectionRank(b.item.section) ||
        a.index - b.index,
    )
    .slice(0, Math.max(0, limit))
    .map((r) => r.item);
}

// ---- Rows the brief reasons over -------------------------------------------

export type BriefAccountRow = {
  id: string;
  name: string;
  stage: string | null;
  stage_id: string | null;
  assigned_rep: string | null;
  stage_changed_at: string | null;
  created_at: string;
  approval_state: string | null;
  approval_due_on: string | null;
  annual_meeting_due_on: string | null;
  location_id: string | null;
  is_demo?: boolean | null;
  is_reference?: boolean | null;
  /**
   * The account's label names, when the caller has read them. Only the house
   * label is consulted, and only to stop the coverage list calling a company
   * account an unowned one — see the gap loop below.
   */
  labels?: readonly string[] | null;
};

export type BriefTaskRow = {
  id: string;
  title: string;
  assignee: string | null;
  due_date: string | null;
  account_id: string | null;
  is_demo?: boolean | null;
};

export type BriefProfileRow = {
  user_id: string;
  full_name: string | null;
  is_demo?: boolean | null;
};

export type BriefHistoryRow = {
  id: string;
  account_id: string;
  to_stage: string | null;
  reason: string | null;
  changed_at: string;
};

export type BriefInput = {
  accounts: BriefAccountRow[];
  /** Active stage windows: stage_id → rot_days. */
  stageWindows: { stage_id: string; rot_days: number | null }[];
  /** Open tasks already past due. */
  overdueTasks: BriefTaskRow[];
  profiles: BriefProfileRow[];
  pendingExpenseCount: number;
  requestedSupplyCount: number;
  /** Stage moves since yesterday, newest first. */
  history: BriefHistoryRow[];
  /** Accounts with a cadence-counting touch inside the cadence window. */
  touchedAccountIds: Iterable<string>;
  contacts: { account_id: string | null; is_decision_maker: boolean | null }[];
  /** Month-to-date standings against goals; empty when the leaderboard is unavailable. */
  ranked: Ranked[];
  /** Share of the month elapsed, 0..1. */
  elapsed: number;
};

/**
 * A row the brief may count. Demo rows are fixtures; reference accounts are
 * shared records the database keeps off the pipeline. Neither is a decision.
 */
export function isRealAccount(a: BriefAccountRow): boolean {
  return !a.is_demo && !a.is_reference && a.stage !== REFERENCE_STAGE;
}

function ago(from: string | null, now: number): string {
  if (!from) return "unknown";
  const days = Math.floor((now - new Date(from).getTime()) / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.max(1, Math.floor((now - new Date(from).getTime()) / 3_600_000));
  return `${hours}h`;
}

/** Pure: turns the rows into the brief. `now` is injectable so tests are stable. */
export function buildMorningBrief(input: BriefInput, now = Date.now()): MorningBrief {
  const demoUsers = new Set(input.profiles.filter((p) => p.is_demo).map((p) => p.user_id));
  const accounts = input.accounts.filter(isRealAccount);
  const overdue = input.overdueTasks.filter((t) => !t.is_demo && !demoUsers.has(t.assignee ?? ""));

  const names = new Map(
    input.profiles.map((p) => [p.user_id, p.full_name?.trim() || "Unnamed"] as const),
  );
  const stageWindow = new Map(
    input.stageWindows.map((w) => [
      w.stage_id,
      w.rot_days ?? BRIEF_THRESHOLDS.defaultStageWindowDays,
    ]),
  );
  const touchedAccounts = new Set(input.touchedAccountIds);
  const decisionMakers = new Set<string>();
  const anyContact = new Set<string>();
  for (const c of input.contacts) {
    if (!c.account_id) continue;
    anyContact.add(c.account_id);
    if (c.is_decision_maker) decisionMakers.add(c.account_id);
  }
  const openTaskAccounts = new Set(
    overdue.map((t) => t.account_id).filter((v): v is string => !!v),
  );

  const accountHref = (id: string) => `/accounts/${id}`;

  // ---- Needs you today -------------------------------------------------
  const needs: BriefItem[] = [];

  const unclaimedCutoff = now - BRIEF_THRESHOLDS.unclaimedLeadHours * 3_600_000;
  for (const a of accounts) {
    if (a.assigned_rep) continue;
    if (!OPEN_LEAD_STAGES.includes(a.stage ?? "")) continue;
    if (new Date(a.created_at).getTime() > unclaimedCutoff) continue;
    needs.push({
      id: `unclaimed_${a.id}`,
      title: a.name,
      detail: `Unclaimed lead, ${ago(a.created_at, now)} old`,
      severity: "danger",
      action: { kind: "open", href: accountHref(a.id), label: "Assign" },
    });
  }

  for (const a of accounts) {
    if (CLOSED_STAGES.includes(a.stage ?? "")) continue;
    if (!a.stage_changed_at) continue;
    const limit = a.stage_id ? stageWindow.get(a.stage_id) : undefined;
    const days = limit ?? BRIEF_THRESHOLDS.defaultStageWindowDays;
    const inStage = Math.floor((now - new Date(a.stage_changed_at).getTime()) / 86_400_000);
    if (inStage <= days) continue;
    needs.push({
      id: `stalled_${a.id}`,
      title: a.name,
      detail: `${inStage}d in stage, window is ${days}d${
        a.assigned_rep ? ` · ${names.get(a.assigned_rep) ?? "Unassigned"}` : ""
      }`,
      severity: "warn",
      action: { kind: "open", href: accountHref(a.id), label: "Open" },
    });
  }

  const byAssignee = new Map<string, number>();
  for (const t of overdue)
    byAssignee.set(t.assignee ?? "", (byAssignee.get(t.assignee ?? "") ?? 0) + 1);
  for (const [assignee, count] of [...byAssignee.entries()].sort((a, b) => b[1] - a[1])) {
    needs.push({
      id: `tasks_${assignee || "unassigned"}`,
      title: assignee ? (names.get(assignee) ?? "Unnamed") : "Unassigned",
      detail: `${count} overdue task${count === 1 ? "" : "s"}`,
      severity: "warn",
      action: assignee
        ? { kind: "message", userId: assignee, label: "Message" }
        : { kind: "open", href: "/tasks", label: "Open" },
    });
  }

  const pendingLeads = accounts.filter(
    (a) => a.approval_state === "pending" || a.approval_state === "escalated",
  );
  if (pendingLeads.length) {
    needs.push({
      id: "approvals_leads",
      title: "Lead approvals waiting",
      detail: `${pendingLeads.length} rep-entered lead${pendingLeads.length === 1 ? "" : "s"} to sign off`,
      severity: pendingLeads.some((a) => a.approval_state === "escalated") ? "danger" : "warn",
      action: { kind: "open", href: "/pipeline", label: "Review" },
    });
  }
  if (input.pendingExpenseCount) {
    const n = input.pendingExpenseCount;
    needs.push({
      id: "approvals_expenses",
      title: "Expense approvals waiting",
      detail: `${n} request${n === 1 ? "" : "s"} pending`,
      severity: "warn",
      action: { kind: "open", href: "/expenses/approvals", label: "Review" },
    });
  }
  if (input.requestedSupplyCount) {
    const n = input.requestedSupplyCount;
    needs.push({
      id: "approvals_supplies",
      title: "Supply requests waiting",
      detail: `${n} request${n === 1 ? "" : "s"} to action`,
      severity: "info",
      action: { kind: "open", href: "/supplies", label: "Review" },
    });
  }

  // ---- Off pace --------------------------------------------------------
  const offPace: BriefItem[] = [];
  for (const r of input.ranked) {
    if (demoUsers.has(r.standing.user_id)) continue;
    if (r.attainment == null) continue;
    if (r.attainment >= input.elapsed - BRIEF_THRESHOLDS.offPaceGap) continue;
    offPace.push({
      id: `pace_${r.standing.user_id}`,
      title: r.name,
      detail: `${Math.round(r.attainment * 100)}% of goal, ${Math.round(input.elapsed * 100)}% of month gone`,
      severity: r.attainment < input.elapsed - 0.3 ? "danger" : "warn",
      action: { kind: "message", userId: r.standing.user_id, label: "Message" },
    });
  }
  offPace.sort((a, b) => a.detail.localeCompare(b.detail));

  // ---- Slipping accounts ----------------------------------------------
  const slipping: BriefItem[] = [];
  for (const a of accounts) {
    if (a.stage === "active_client" && !touchedAccounts.has(a.id)) {
      slipping.push({
        id: `cadence_${a.id}`,
        title: a.name,
        detail: `No touch in ${BRIEF_THRESHOLDS.cadenceDays}d${
          a.assigned_rep ? ` · ${names.get(a.assigned_rep) ?? "Unassigned"}` : " · no owner"
        }`,
        severity: "danger",
        action: { kind: "open", href: accountHref(a.id), label: "Open" },
      });
      continue;
    }
    if (a.annual_meeting_due_on) {
      const due = new Date(`${a.annual_meeting_due_on}T00:00:00`);
      const left = Math.ceil((due.getTime() - now) / 86_400_000);
      if (left <= BRIEF_THRESHOLDS.annualMeetingLeadDays) {
        slipping.push({
          id: `annual_${a.id}`,
          title: a.name,
          detail:
            left < 0
              ? `Annual meeting ${Math.abs(left)}d overdue`
              : `Annual meeting due in ${left}d`,
          severity: left < 0 ? "danger" : "warn",
          action: { kind: "open", href: accountHref(a.id), label: "Book" },
        });
        continue;
      }
    }
    if (a.stage === "goasted") {
      slipping.push({
        id: `ghosted_${a.id}`,
        title: a.name,
        detail: `Ghosted ${ago(a.stage_changed_at, now)} — reassign or close`,
        severity: "warn",
        action: { kind: "open", href: accountHref(a.id), label: "Decide" },
      });
    }
  }

  // ---- Won / lost since yesterday --------------------------------------
  const closed: BriefItem[] = [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  // History rows for accounts the brief does not count (demo, reference) are
  // dropped too, so a purge or a seed never shows up as a win or a loss.
  const history = input.history.filter((h) => accountName.has(h.account_id));
  const won = history.filter((h) => h.to_stage === "active_client");
  const lost = history.filter((h) => h.to_stage === "lost" || h.to_stage === "no_service_needed");
  if (won.length) {
    closed.push({
      id: "won",
      title: `${won.length} won since yesterday`,
      detail: won
        .slice(0, 3)
        .map((h) => accountName.get(h.account_id) ?? "Account")
        .join(", "),
      severity: "info",
      action: { kind: "open", href: "/pipeline", label: "Open" },
    });
  }
  if (lost.length) {
    const reasons = new Map<string, number>();
    for (const h of lost) {
      const key = h.reason?.trim() || "No reason given";
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      closed.push({
        id: `lost_${reason}`,
        title: `${count} lost — ${reason}`,
        detail: lost
          .filter((h) => (h.reason?.trim() || "No reason given") === reason)
          .slice(0, 3)
          .map((h) => accountName.get(h.account_id) ?? "Account")
          .join(", "),
        severity: "warn",
        action: { kind: "open", href: "/pipeline", label: "Open" },
      });
    }
  }

  // ---- Coverage gaps ----------------------------------------------------
  const coverage: BriefItem[] = [];
  for (const a of accounts) {
    if (CLOSED_STAGES.includes(a.stage ?? "") && a.stage !== "active_client") continue;
    const gaps: string[] = [];
    /*
     * "No owner" is a gap because somebody forgot to hand the account out.
     * Mark: "House accounts belong to the company rather than a rep" — a
     * company account sitting without a rep is the arrangement working, not a
     * hole in it, and putting it on a manager's morning list at `warn` asks
     * them to undo the decision every morning until they do.
     *
     * Only the label excuses it. An account with an empty `assigned_rep` and
     * no label is still a gap: that is the unclaimed quarter of the book, and
     * reading those as the company's is the mistake `account-ownership.ts`
     * exists to prevent.
     */
    if (!a.assigned_rep && !OPEN_LEAD_STAGES.includes(a.stage ?? "") && !isCompanyOwned(a))
      gaps.push("no owner");
    if (!decisionMakers.has(a.id))
      gaps.push(anyContact.has(a.id) ? "no decision-maker" : "no contacts");
    if (!openTaskAccounts.has(a.id) && a.stage === "active_outreach") gaps.push("no next activity");
    if (!gaps.length) continue;
    coverage.push({
      id: `gap_${a.id}`,
      title: a.name,
      detail: gaps.join(" · "),
      severity: gaps.includes("no owner") ? "warn" : "info",
      action: { kind: "open", href: accountHref(a.id), label: "Fix" },
    });
  }

  const sections = [
    section("needs_you", "Needs you today", needs),
    section("off_pace", "Off pace", offPace),
    section("slipping", "Slipping accounts", slipping),
    section("closed", "Won / lost since yesterday", closed),
    section("coverage", "Coverage gaps", coverage),
  ].filter((s) => s.items.length > 0);

  return {
    generatedAt: new Date(now).toISOString(),
    sections,
    total: sections.reduce((sum, s) => sum + s.items.length, 0),
  };
}

// ---- Reading the rows ------------------------------------------------------

export async function fetchMorningBrief(): Promise<MorningBrief> {
  const now = Date.now();
  const month = goalWindow("month");
  const since = new Date(now - 86_400_000);

  const [
    accountsRes,
    windowsRes,
    tasksRes,
    profilesRes,
    expenseRes,
    supplyRes,
    historyRes,
    touchRes,
    contactsRes,
    houseLabels,
  ] = await Promise.all([
    supabase
      .from("accounts")
      .select(
        "id,name,stage,stage_id,assigned_rep,stage_changed_at,created_at,approval_state,approval_due_on,annual_meeting_due_on,location_id,is_demo,is_reference",
      )
      .is("archived_at", null)
      .eq("is_demo", false)
      .eq("is_reference", false)
      .limit(2000),
    supabase
      .from("automation_stage_windows")
      .select("stage_id,rot_days,is_active")
      .eq("is_active", true),
    supabase
      .from("tasks")
      .select("id,title,assignee,due_date,status,account_id,is_demo")
      .in("status", ["open", "in_progress"])
      .eq("is_demo", false)
      .lt("due_date", dayKey(new Date(now)))
      .order("due_date")
      .limit(200),
    supabase.from("profiles").select("user_id,full_name,is_demo"),
    supabase
      .from("expense_requests")
      .select("id,status,requested_at")
      .eq("status", "pending")
      .eq("is_demo", false),
    // supply_requests has no is_demo column; the seeder does not write it.
    supabase.from("supply_requests").select("id,status,created_at").eq("status", "requested"),
    supabase
      .from("account_stage_history")
      .select("id,account_id,to_stage,reason,changed_at")
      .eq("is_demo", false)
      .gte("changed_at", iso(since))
      .order("changed_at", { ascending: false })
      .limit(200),
    supabase
      .from("touchpoints")
      .select("account_id,occurred_at")
      .eq("counts_toward_cadence", true)
      .eq("is_demo", false)
      .gte("occurred_at", iso(new Date(now - BRIEF_THRESHOLDS.cadenceDays * 86_400_000)))
      .limit(5000),
    supabase
      .from("contacts")
      .select("id,account_id,is_decision_maker")
      .is("archived_at", null)
      .eq("is_demo", false)
      .limit(5000),
    // Which accounts are the company's, so the coverage list stops calling a
    // house account with no rep a hole somebody has to plug.
    fetchHouseAccountLabelsOrNone(),
  ]);

  let ranked: Ranked[] = [];
  try {
    const [standings, goals] = await Promise.all([
      fetchStandings(month.from, month.to),
      fetchGoals({ period: "month", window: month }),
    ]);
    ranked = rankStandings(standings, goals);
  } catch {
    /* standings unavailable — the rest of the brief still stands */
  }

  return buildMorningBrief(
    {
      accounts: ((accountsRes.data ?? []) as BriefAccountRow[]).map((a) => ({
        ...a,
        labels: houseLabels[a.id] ?? [],
      })),
      stageWindows: (windowsRes.data ?? []) as { stage_id: string; rot_days: number | null }[],
      overdueTasks: (tasksRes.data ?? []) as BriefTaskRow[],
      profiles: (profilesRes.data ?? []) as BriefProfileRow[],
      pendingExpenseCount: (expenseRes.data ?? []).length,
      requestedSupplyCount: (supplyRes.data ?? []).length,
      history: (historyRes.data ?? []) as BriefHistoryRow[],
      touchedAccountIds: ((touchRes.data ?? []) as { account_id: string }[]).map(
        (t) => t.account_id,
      ),
      contacts: (contactsRes.data ?? []) as {
        account_id: string | null;
        is_decision_maker: boolean | null;
      }[],
      ranked,
      elapsed: elapsedShare("month"),
    },
    now,
  );
}
