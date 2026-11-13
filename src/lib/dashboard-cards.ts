import { supabase } from "@/integrations/supabase/client";
import { loadOrgDefault } from "./org-layouts";
import type { AppRole, DashboardKey } from "./roles";

/**
 * Per-user dashboard customisation.
 *
 * A card only ever appears for a role that can actually read its data, so
 * nobody sees an empty or locked tile. Layout is stored per user AND per
 * role key, which is what keeps "View as role" honest: previewing a role
 * shows that role's default layout, never the admin's saved one.
 */

export type CardKey =
  | "ov_kpis"
  | "ov_map"
  | "ov_feed"
  | "ov_pipeline"
  | "ov_inspections"
  | "ov_crew"
  | "ov_phase"
  | "ov_response"
  | "ov_revenue"
  | "ov_running_cost"
  | "ov_urgent"
  | "role_body"
  | "goal_progress"
  | "my_commissions"
  | "new_lead"
  | "week_calendar"
  | "calendar_agenda"
  | "rep_cost"
  | "new_leads"
  | "morning_brief"
  | "my_month"
  | "my_todo"
  | "location_scorecard"
  | "critical_list";

export type CardDef = {
  key: CardKey;
  title: string;
  description: string;
  /** Dashboards (role keys) allowed to render this card. */
  roles: DashboardKey[];
  /** Full width in the grid. */
  wide?: boolean;
  /** Column span out of 12 on large screens. Defaults to 4. */
  span?: number;
  /**
   * Cannot be switched off. Melly: the Critical list "cannot be dismissed".
   * The editor shows the switch disabled and the card has no hide control.
   */
  locked?: boolean;
};

/** Every role sees the overview widgets; money cards gate themselves. */
export const DASHBOARD_ROLE_KEYS: DashboardKey[] = [
  "owner",
  "regional",
  "location_manager",
  "sales_head",
  "sales_person",
  "outside_sales_rep",
  "cold_caller",
  "sales_manager",
  "sales_rep",
  "field_chaser",
  "crew",
  "admin",
];

export const DASHBOARD_CARDS: CardDef[] = [
  {
    key: "ov_kpis",
    title: "Key numbers",
    description: "Active jobs, fire leads, crews, revenue and A/R.",
    roles: DASHBOARD_ROLE_KEYS,
    wide: true,
  },
  {
    key: "ov_map",
    title: "Service area map",
    description: "Crews and live incidents across your area.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 5,
  },
  {
    key: "ov_feed",
    title: "Live incident feed",
    description: "Newest incidents with dispatch status.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 3,
  },
  {
    key: "ov_pipeline",
    title: "Sales pipeline summary",
    description: "Open accounts by stage.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 4,
  },
  {
    key: "ov_inspections",
    title: "Today's inspections",
    description: "Today's scheduled visits and their status.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 5,
  },
  {
    key: "ov_crew",
    title: "Crew utilization",
    description: "Share of crews currently deployed.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 3,
  },
  {
    key: "ov_phase",
    title: "Jobs by phase",
    description: "Job mix across the production phases.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 4,
  },
  {
    key: "ov_response",
    title: "Average response time",
    description: "Dispatch to on-site over the last week.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 8,
  },
  {
    key: "ov_revenue",
    title: "Revenue vs goal",
    description: "Month to date against the monthly target.",
    roles: ["owner", "regional", "location_manager", "sales_head", "sales_manager", "admin"],
    span: 4,
  },
  {
    key: "ov_running_cost",
    title: "Job running cost",
    description: "Live cost across active jobs and the worst-margin jobs.",
    roles: ["owner", "sales_head", "admin"],
    span: 4,
  },
  {
    key: "ov_urgent",
    title: "Urgent action list",
    description: "Leads and tasks that are ageing badly.",
    roles: DASHBOARD_ROLE_KEYS,
    wide: true,
  },
  {
    key: "role_body",
    title: "Role overview",
    description: "The standard workspace for your role.",
    roles: [
      "owner",
      "regional",
      "location_manager",
      "sales_head",
      "sales_person",
      "outside_sales_rep",
      "cold_caller",
      "sales_manager",
      "sales_rep",
      "field_chaser",
      "crew",
      "admin",
    ],
    wide: true,
  },
  {
    key: "goal_progress",
    title: "Goal progress",
    description: "This month against your target.",
    roles: [
      "sales_person",
      "outside_sales_rep",
      "cold_caller",
      "sales_rep",
      "sales_manager",
      "sales_head",
      "owner",
      "admin",
    ],
  },
  {
    key: "my_commissions",
    title: "My commissions",
    description: "Year to date. Pending payouts carry no figure.",
    roles: [
      "sales_person",
      "outside_sales_rep",
      "cold_caller",
      "sales_rep",
      "sales_manager",
      "sales_head",
      "owner",
      "admin",
    ],
  },
  {
    key: "new_lead",
    title: "New lead check",
    description: "Check every office before creating a company.",
    roles: [
      "sales_person",
      "outside_sales_rep",
      "cold_caller",
      "sales_rep",
      "sales_manager",
      "sales_head",
      "field_chaser",
      "owner",
      "admin",
    ],
  },
  {
    key: "week_calendar",
    title: "This week",
    description: "Meetings from your synced calendar.",
    roles: [
      "sales_person",
      "outside_sales_rep",
      "cold_caller",
      "sales_rep",
      "sales_manager",
      "sales_head",
      "location_manager",
      "field_chaser",
      "owner",
      "admin",
    ],
  },
  {
    key: "calendar_agenda",
    title: "Calendar",
    description: "Today and what's coming: meetings, tasks due and inspections.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 4,
  },
  {
    key: "rep_cost",
    title: "Rep's cost",
    description: "Salary vs commission paid, against revenue signed.",
    roles: ["owner", "sales_head", "sales_manager", "location_manager", "regional", "admin"],
    span: 6,
  },
  {
    key: "morning_brief",
    title: "Morning brief",
    description: "Exception-only: what needs a decision across your team today.",
    roles: ["owner", "sales_head", "sales_manager", "location_manager", "regional", "admin"],
    span: 6,
  },
  {
    key: "new_leads",
    title: "New leads",
    description: "Recent leads with an existing-client check. Claim straight from the card.",
    roles: [
      "sales_person",
      "outside_sales_rep",
      "cold_caller",
      "sales_rep",
      "sales_manager",
      "sales_head",
      "owner",
      "admin",
    ],
    span: 6,
  },
  {
    key: "my_month",
    title: "My month",
    description: "Your own captured activity, month to date.",
    roles: [
      "sales_person",
      "outside_sales_rep",
      "cold_caller",
      "sales_rep",
      "sales_manager",
      "sales_head",
      "owner",
      "admin",
    ],
  },
  {
    key: "my_todo",
    title: "My to-do",
    // David, 22 Sep: "every user should have their tasks on their dashboard
    // also... maybe like sticky notes type of thing."
    description:
      "Your day as sticky notes — your tasks, the job tasks you pinned and notes to yourself, by day or by property.",
    roles: DASHBOARD_ROLE_KEYS,
    span: 4,
  },
  {
    key: "critical_list",
    title: "Critical clients",
    description:
      "Clients in the Critical band, each inside its thirty-day cure window, and the day-30 decisions waiting on you. Cannot be switched off.",
    roles: ["owner", "regional", "location_manager", "sales_head", "sales_manager", "admin"],
    span: 4,
    locked: true,
  },
  {
    key: "location_scorecard",
    title: "Scorecard",
    description:
      "Jobs, invoiced and collections per office, month to date vs last month and last year.",
    roles: ["owner", "regional", "location_manager", "sales_head", "sales_manager", "admin"],
    wide: true,
  },
];

/**
 * Default order per dashboard. Anything omitted defaults to hidden.
 *
 * Sales roles open on sales cards. Melly (29 Oct): the top of the sales
 * dashboard was "placeholders, not really functional" -- a rep's first screen
 * led with the service-area map, the incident feed, today's inspections,
 * crew utilisation and job phases, none of which a salesperson acts on. The
 * sales layouts now lead with the role's own workspace, new leads, to-dos,
 * the calendar, goals and the pipeline; the operations widgets stay in the
 * catalogue and can be switched on from the dashboard editor. Leadership
 * (Sales Head, Sales Manager) keeps the Morning brief first. Saved layouts
 * are untouched: this is only what a person who never customised sees.
 */
const DEFAULTS: Partial<Record<DashboardKey, CardKey[]>> = {
  sales_person: [
    "role_body",
    "new_leads",
    "my_todo",
    "calendar_agenda",
    "goal_progress",
    "ov_pipeline",
    "my_month",
    "ov_urgent",
    "my_commissions",
    "new_lead",
    "week_calendar",
  ],
  sales_rep: [
    "role_body",
    "new_leads",
    "my_todo",
    "calendar_agenda",
    "goal_progress",
    "ov_pipeline",
    "my_month",
    "ov_urgent",
    "my_commissions",
    "new_lead",
    "week_calendar",
  ],
  outside_sales_rep: [
    "role_body",
    "new_leads",
    "my_todo",
    "calendar_agenda",
    "goal_progress",
    "ov_pipeline",
    "my_month",
    "ov_urgent",
    "my_commissions",
    "new_lead",
    "week_calendar",
  ],
  cold_caller: [
    "role_body",
    "new_leads",
    "my_todo",
    "calendar_agenda",
    "goal_progress",
    "ov_pipeline",
    "my_month",
    "ov_urgent",
    "new_lead",
    "week_calendar",
  ],
  field_chaser: [
    "ov_kpis",
    "ov_map",
    "ov_feed",
    "ov_pipeline",
    "ov_inspections",
    "ov_crew",
    "ov_phase",
    "ov_response",
    "ov_revenue",
    "ov_urgent",
    "role_body",
    "my_todo",
    "calendar_agenda",
    "week_calendar",
    "new_lead",
  ],
  sales_head: [
    "morning_brief",
    "critical_list",
    "role_body",
    "new_leads",
    "ov_pipeline",
    "ov_revenue",
    "goal_progress",
    "rep_cost",
    "location_scorecard",
    "ov_urgent",
    "my_todo",
    "calendar_agenda",
    "week_calendar",
    "my_month",
  ],
  sales_manager: [
    "morning_brief",
    "critical_list",
    "role_body",
    "new_leads",
    "ov_pipeline",
    "ov_revenue",
    "goal_progress",
    "rep_cost",
    "location_scorecard",
    "ov_urgent",
    "my_todo",
    "calendar_agenda",
    "week_calendar",
    "my_month",
  ],
  location_manager: [
    "morning_brief",
    "critical_list",
    "location_scorecard",
    "rep_cost",
    "ov_kpis",
    "ov_map",
    "ov_feed",
    "ov_pipeline",
    "ov_inspections",
    "ov_crew",
    "ov_phase",
    "ov_response",
    "ov_revenue",
    "ov_urgent",
    "role_body",
    "my_todo",
    "calendar_agenda",
    "week_calendar",
  ],
  owner: [
    "morning_brief",
    "critical_list",
    "location_scorecard",
    "rep_cost",
    "ov_kpis",
    "ov_map",
    "ov_feed",
    "ov_pipeline",
    "ov_inspections",
    "ov_crew",
    "ov_phase",
    "ov_response",
    "ov_revenue",
    "ov_running_cost",
    "ov_urgent",
    "role_body",
    "my_todo",
    "calendar_agenda",
  ],
  admin: [
    "morning_brief",
    "critical_list",
    "location_scorecard",
    "rep_cost",
    "ov_kpis",
    "ov_map",
    "ov_feed",
    "ov_pipeline",
    "ov_inspections",
    "ov_crew",
    "ov_phase",
    "ov_response",
    "ov_revenue",
    "ov_running_cost",
    "ov_urgent",
    "role_body",
    "my_todo",
    "calendar_agenda",
  ],
  regional: [
    "morning_brief",
    "critical_list",
    "location_scorecard",
    "rep_cost",
    "ov_kpis",
    "ov_map",
    "ov_feed",
    "ov_pipeline",
    "ov_inspections",
    "ov_crew",
    "ov_phase",
    "ov_response",
    "ov_revenue",
    "ov_urgent",
    "role_body",
    "my_todo",
    "calendar_agenda",
  ],
  crew: [
    "ov_kpis",
    "ov_map",
    "ov_feed",
    "ov_pipeline",
    "ov_inspections",
    "ov_crew",
    "ov_phase",
    "ov_response",
    "ov_revenue",
    "ov_urgent",
    "role_body",
    "my_todo",
    "calendar_agenda",
  ],
};

export function cardsForRole(role: DashboardKey): CardDef[] {
  return DASHBOARD_CARDS.filter((c) => c.roles.includes(role));
}

export type LayoutEntry = { key: CardKey; hidden: boolean };

export function defaultLayout(role: DashboardKey): LayoutEntry[] {
  const available = cardsForRole(role);
  const order = (DEFAULTS[role] ?? ["role_body", "calendar_agenda"]).filter((k) =>
    available.some((c) => c.key === k),
  );
  const rest = available.filter((c) => !order.includes(c.key)).map((c) => c.key);
  return [
    ...order.map((key) => ({ key, hidden: false })),
    ...rest.map((key) => ({ key, hidden: true })),
  ];
}

/**
 * Turn one card on or off.
 *
 * Turning a card ON moves it to the end of the order. QC found why that
 * matters: Mark's saved layout predated Morning brief, so `normalizeLayout`
 * appended Morning brief after every card he had ever seen -- including New
 * leads, which was sitting hidden at position 19. Switching New leads on left
 * it at 19 and it appeared ABOVE Morning brief, which he had never moved and
 * had no reason to expect to be last.
 *
 * Appending on enable makes the rule one a person can predict without knowing
 * any of that: a card you just switched on is at the bottom, where you are
 * already looking, and you drag it where you want it from there.
 *
 * Turning a card OFF leaves it exactly where it is. Hiding is not a decision
 * about order, and quietly moving a card while it is invisible would rearrange
 * the dashboard behind someone's back.
 */
export function setCardVisible(layout: LayoutEntry[], key: CardKey, show: boolean): LayoutEntry[] {
  // A locked card ignores "off": it is the one tile that cannot be dismissed.
  if (!show && DASHBOARD_CARDS.find((c) => c.key === key)?.locked) return layout;
  if (!layout.some((l) => l.key === key)) return layout;
  if (!show) return layout.map((l) => (l.key === key ? { ...l, hidden: true } : l));
  return [...layout.filter((l) => l.key !== key), { key, hidden: false }];
}

type Row = { card_key: string; position: number; hidden: boolean };

/**
 * Keeps only cards the role can see, and appends cards the person has never
 * had before.
 *
 * A new card used to arrive hidden, always. That reads as caution — don't
 * rearrange a dashboard someone has arranged — but the effect was that nobody
 * who had ever customised their dashboard saw a new card again. Mark asked
 * where Rep's cost had gone; it had been sitting in his saved layout with
 * `hidden` set since the day it shipped, a choice he never made.
 *
 * So the two kinds of new card are now told apart. A card in the role's own
 * built-in layout is one the product says that role should have, and it
 * arrives visible — the same card a colleague who never customised is already
 * looking at. Everything else is an optional extra from the catalogue and
 * still arrives hidden, to be picked up from the dashboard editor.
 *
 * Either way they go on the end, so nothing the person already placed moves.
 * A card already in `entries` keeps whatever they set: this only decides the
 * opening position of a card they have never been shown, and hiding one
 * afterwards sticks.
 */
export function normalizeLayout(role: DashboardKey, entries: LayoutEntry[]): LayoutEntry[] {
  const available = cardsForRole(role);
  const inRoleDefault = new Set(DEFAULTS[role] ?? []);
  const kept = entries
    .filter((e) => available.some((c) => c.key === e.key))
    .map((e) => ({ key: e.key, hidden: !!e.hidden }));
  const missing = available
    .filter((c) => !kept.some((s) => s.key === c.key))
    .map((c) => ({ key: c.key, hidden: !inRoleDefault.has(c.key) }));
  return [...kept, ...missing];
}

/**
 * The layout for someone who never customised: the admin's published default
 * for their role (or the "all roles" one), falling back to the built-in order.
 */
export async function orgOrBuiltInLayout(role: DashboardKey): Promise<LayoutEntry[]> {
  const published = await loadOrgDefault<LayoutEntry[]>("dashboard", [role]);
  if (published && Array.isArray(published.payload) && published.payload.length > 0) {
    return normalizeLayout(role, published.payload);
  }
  return defaultLayout(role);
}

export async function loadLayout(userId: string, role: DashboardKey): Promise<LayoutEntry[]> {
  const { data } = await supabase
    .from("dashboard_layouts")
    .select("card_key,position,hidden")
    .eq("user_id", userId)
    .eq("role_key", role)
    .order("position");
  const rows = (data ?? []) as Row[];
  // No personal layout → whatever the organisation published.
  if (rows.length === 0) return orgOrBuiltInLayout(role);

  return normalizeLayout(
    role,
    rows.map((r) => ({ key: r.card_key as CardKey, hidden: r.hidden })),
  );
}

export async function saveLayout(
  userId: string,
  role: DashboardKey,
  layout: LayoutEntry[],
): Promise<void> {
  const rows = layout.map((l, i) => ({
    user_id: userId,
    role_key: role,
    card_key: l.key,
    position: i,
    hidden: l.hidden,
  }));
  await supabase
    .from("dashboard_layouts")
    .upsert(rows, { onConflict: "user_id,role_key,card_key" });
}

export async function resetLayout(userId: string, role: DashboardKey): Promise<void> {
  await supabase.from("dashboard_layouts").delete().eq("user_id", userId).eq("role_key", role);
}
