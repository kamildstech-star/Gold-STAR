import type { Standing } from "@/lib/leaderboard";

/**
 * The action catalogue — every countable thing a person does in the CRM.
 *
 * Mark, 16 Sep 2026, on leaderboard points, verbatim:
 *
 *   "this needs to have an admin menu to change and add, also the admin menu
 *    needs to have the ability to add components and targets weights etc for
 *    anything they want that needs to tie to an action, so have a list of
 *    actions they can choose from, it should get every action available i
 *    the crm with a serach function thats smart"
 *
 * Until now a scorecard component was a bare string in `scorecard_weights`
 * that only meant something if `componentValue()` in leaderboard-board.ts
 * happened to have a `case` for it. This file is the list Mark asked for: one
 * entry per action the system records, with the words a Sales Head would use
 * for it, so the admin screen can offer "anything they want" and the points
 * math can compute it.
 *
 * WHERE THE NUMBERS COME FROM
 * ---------------------------
 * Two roads, both server-side, both scoped by `can_view_location`:
 *
 *   - `standing`: the action already rides on the `leaderboard_standings` row
 *     (migration 20260912103000). These are the columns the board has always
 *     ranked on, and reading them here keeps every seeded component producing
 *     the number it produced yesterday — leaderboard-board.test.ts asserts it.
 *
 *   - `scorecard_action_counts` (migration 20260916140000): one SECURITY
 *     DEFINER function that takes a list of catalogue KEYS and switches on an
 *     allowlist in SQL. The client never sends a table name, a column or a
 *     predicate — only keys — and a key the allowlist does not know is
 *     ignored, never an error that describes the schema. Every key in this
 *     file has a `WHEN 'key' THEN` branch there; action-catalogue.test.ts reads
 *     the migration and fails if one is missing.
 *
 * AUDIENCE: COLD versus ACTIVE CLIENT
 * -----------------------------------
 * "A cold call is a call to a prospect; an active-client reach-out is any
 * outbound contact to an active client." Whether an account is a client is
 * the board's own rule — `isActiveClient` in src/lib/pipeline-reversion.ts and
 * `isProspectingBoardCard` in src/lib/pipeline.ts: a Client Health stage, the
 * won prospecting stage, or an active/onboarding status. The SQL mirrors it in
 * `scorecard_account_client_since`, judged at the moment of the touch, so
 * January's cold calls stay cold when the account signs in February.
 *
 * HOUSE ACCOUNTS
 * --------------
 * Nothing on a house account counts toward a rep, on either road — the same
 * `NOT public.account_is_house_account(a.id)` guard 20260912103000 put on the
 * standings, on every per-rep aggregate the new function runs.
 *
 * THE SIX GOAL METRICS
 * --------------------
 * `cold_calls`, `cold_emails`, `new_deals_worked`, `cold_leads_converted`,
 * `active_client_reach_outs` and `fires_chased` are the goal metrics being
 * added to src/lib/goals.ts on branch wt/six-new-goal-metrics, under the same
 * keys. They are defined here too so an admin can weight them. When that
 * branch lands they also arrive on the standings row, and the `standing`
 * accessor below picks them up ahead of the RPC — same key, same number.
 */

export type ActionUnit = "count" | "currency" | "percent" | "minutes";
export type ActionDirection = "higher" | "lower";
/** Which role group the action belongs to. "both" is offered to either tab. */
export type ActionGroup = "sales" | "chase" | "both";
/** How the picker groups results. */
export type ActionArea = "outreach" | "meetings" | "pipeline" | "fires" | "money" | "admin";

export const ACTION_AREAS: readonly { id: ActionArea; label: string }[] = [
  { id: "outreach", label: "Outreach" },
  { id: "meetings", label: "Meetings" },
  { id: "pipeline", label: "Pipeline" },
  { id: "fires", label: "Fires" },
  { id: "money", label: "Money" },
  { id: "admin", label: "Admin" },
];

export type ActionDef = {
  /** Stable. Stored in `scorecard_weights.component`; never renamed casually. */
  key: string;
  label: string;
  /** Plain words a Sales Head reads: what one unit of this action is. */
  description: string;
  unit: ActionUnit;
  /** Default when an admin adds it; editable per component. */
  direction: ActionDirection;
  group: ActionGroup;
  area: ActionArea;
  /** What people call it. The picker's search reads these. */
  synonyms: readonly string[];
  /**
   * The rule, in one line, as the SQL implements it — table, filter, who gets
   * the credit. The comment beside each `WHEN` in the migration says the same.
   */
  rule: string;
  /**
   * Reads the actual off a standings row when the row carries it. Absent or
   * returning null means "ask `scorecard_action_counts`".
   */
  standing?: (s: Standing) => number | null;
  /**
   * True when `standing` reads a column this build's standings row may not
   * have yet (the six goal metrics, until wt/six-new-goal-metrics lands), so
   * the board must still ask the RPC for it.
   */
  standingMayBeAbsent?: boolean;
};

/* ------------------------------------------------------------------ */
/* Building blocks                                                     */
/* ------------------------------------------------------------------ */

const n = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Reads a column that may not exist on this build of the standings row — the
 * six goal metrics before wt/six-new-goal-metrics lands. Null, not zero: an
 * absent column is unmeasured, and the RPC fills it in.
 */
const loose = (col: string) => (s: Standing) => n((s as unknown as Record<string, unknown>)[col]);

type Partial_ = Partial<
  Pick<ActionDef, "unit" | "direction" | "group" | "standing" | "standingMayBeAbsent">
>;

function def(
  key: string,
  area: ActionArea,
  label: string,
  description: string,
  synonyms: readonly string[],
  rule: string,
  extra: Partial_ = {},
): ActionDef {
  return {
    key,
    label,
    description,
    unit: extra.unit ?? "count",
    direction: extra.direction ?? "higher",
    group: extra.group ?? "sales",
    area,
    synonyms,
    rule,
    standing: extra.standing,
    standingMayBeAbsent: extra.standingMayBeAbsent,
  };
}

const CALL_WORDS = [
  "call",
  "calls",
  "phone",
  "phone call",
  "dial",
  "dialed",
  "dials",
  "dialer",
  "rang",
  "ring",
];
const EMAIL_WORDS = ["email", "emails", "e-mail", "mail out", "outreach email", "sent email"];
const TEXT_WORDS = ["text", "texts", "sms", "message", "messages", "texted"];
const PROSPECT_WORDS = [
  "cold",
  "prospect",
  "prospects",
  "prospecting",
  "lead",
  "leads",
  "new business",
  "not yet a client",
];
const CLIENT_WORDS = [
  "active client",
  "client",
  "clients",
  "existing client",
  "customer",
  "farming",
  "account management",
];

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

export const ACTION_CATALOGUE: readonly ActionDef[] = [
  /* ------------------------------------------------------- Outreach */
  def(
    "touchpoints",
    "outreach",
    "Touchpoints logged",
    "Every touchpoint the rep recorded — calls, emails, texts, meetings, gifts, mail, LinkedIn — to any account.",
    [
      "touch",
      "touches",
      "touchpoint",
      "activity",
      "activities",
      "contacts",
      "logged",
      "all outreach",
    ],
    "touchpoints.created_by = rep, occurred_at in window.",
    { group: "both", standing: (s) => s.touchpoints },
  ),
  def(
    "calls_made",
    "outreach",
    "Calls made",
    "Calls logged to anyone: call touchpoints plus call attempts on fire leads.",
    [...CALL_WORDS, "all calls", "calls logged"],
    "touchpoints.type = 'call' plus contact_attempts.channel = 'call', by the rep, in window.",
    { group: "both", standing: (s) => s.calls_made ?? 0 },
  ),
  def(
    "cold_calls",
    "outreach",
    "Cold calls",
    "Outbound calls to prospects — accounts that were not yet a client when the call happened.",
    [...CALL_WORDS, ...PROSPECT_WORDS, "cold calling", "cold call"],
    "Call touchpoints (not inbound) and call attempts where the account was not a client at the time. House accounts excluded.",
    { standing: loose("cold_calls"), standingMayBeAbsent: true },
  ),
  def(
    "active_client_calls",
    "outreach",
    "Active-client calls",
    "Outbound calls to accounts that were already active clients at the time.",
    [...CALL_WORDS, ...CLIENT_WORDS, "check-in call", "client call"],
    "Call touchpoints (not inbound) and call attempts where the account was a client at the time. House accounts excluded.",
  ),
  def(
    "emails_sent",
    "outreach",
    "Emails sent",
    "Outbound emails to anyone — email touchpoints (including Outlook-synced mail) plus email attempts on leads.",
    [...EMAIL_WORDS, "outlook", "mailbox", "all emails"],
    "touchpoints.type = 'email' (not inbound) plus contact_attempts.channel = 'email', by the rep, in window.",
    { group: "both" },
  ),
  def(
    "cold_emails",
    "outreach",
    "Cold email outreach",
    "Outbound emails to prospects — accounts that were not yet a client when the email went out.",
    [...EMAIL_WORDS, ...PROSPECT_WORDS, "cold email", "cold emails", "email outreach"],
    "Email touchpoints (not inbound) and email attempts where the account was not a client at the time. House accounts excluded.",
    { standing: loose("cold_emails"), standingMayBeAbsent: true },
  ),
  def(
    "active_client_emails",
    "outreach",
    "Active-client emails",
    "Outbound emails to accounts that were already active clients at the time.",
    [...EMAIL_WORDS, ...CLIENT_WORDS, "client email"],
    "Email touchpoints (not inbound) and email attempts where the account was a client at the time. House accounts excluded.",
  ),
  def(
    "texts_sent",
    "outreach",
    "Texts sent",
    "Outbound text messages: text touchpoints plus SMS attempts on leads.",
    [...TEXT_WORDS, "texting"],
    "touchpoints.type = 'text' (not inbound) plus contact_attempts.channel = 'sms', by the rep, in window.",
    { group: "both" },
  ),
  def(
    "linkedin_touches",
    "outreach",
    "LinkedIn touches",
    "LinkedIn messages or connections logged as a touchpoint.",
    ["linkedin", "social", "connection request", "inmail", "dm"],
    "touchpoints.type = 'linkedin' (not inbound), by the rep, in window.",
  ),
  def(
    "mail_sent",
    "outreach",
    "Mail sent",
    "Physical mail — letters, cards, mailers — logged as a touchpoint.",
    ["mail", "letter", "letters", "postcard", "mailer", "snail mail", "post"],
    "touchpoints.type = 'mail', by the rep, in window.",
  ),
  def(
    "gifts_sent",
    "outreach",
    "Gifts and seasonal sends",
    "Gifts and seasonal sends recorded against an account (the gift engine logs one touchpoint per send).",
    ["gift", "gifts", "present", "seasonal", "holiday", "birthday", "thank you", "swag"],
    "touchpoints.type in ('gift','seasonal_send'), by the rep, in window.",
  ),
  def(
    "door_knocks",
    "outreach",
    "Door knocks",
    "In-person attempts on a fire lead — a knock on the door, logged as a contact attempt.",
    [
      "door",
      "knock",
      "knocks",
      "door knock",
      "canvass",
      "canvassing",
      "walk up",
      "in person attempt",
    ],
    "contact_attempts.channel = 'door', by the rep, in window.",
    { group: "chase" },
  ),
  def(
    "lead_contact_attempts",
    "outreach",
    "Lead contact attempts",
    "Every attempt to reach a fire lead — call, text, email, door knock or other — whether or not anyone answered.",
    [
      "attempt",
      "attempts",
      "contact attempt",
      "fire lead",
      "lead outreach",
      "tried to reach",
      "reach attempts",
    ],
    "contact_attempts.author_id = rep, occurred_at in window, any channel.",
    { group: "chase" },
  ),
  def(
    "contact_attempts",
    "outreach",
    "Activity events",
    "The leaderboard's activity count: touchpoints, stage moves, jobs opened and chases accepted, added together. Seeded under the name contact_attempts.",
    ["activity", "events", "activity events", "busy", "volume", "contact attempts"],
    "leaderboard_standings.activity_events — kept exactly as the board has always read this component.",
    { group: "both", standing: (s) => s.activity_events },
  ),
  def(
    "active_client_reach_outs",
    "outreach",
    "Active-client reach-outs",
    "Any outbound contact — call, email, text, meeting, LinkedIn, mail, gift — to an account that was an active client at the time.",
    [
      ...CLIENT_WORDS,
      "reach out",
      "reach-out",
      "reachout",
      "check in",
      "check-in",
      "client touch",
      "messaging",
    ],
    "Every outbound touchpoint plus every contact attempt where the account was a client at the time. House accounts excluded.",
    { group: "both", standing: loose("active_client_reach_outs"), standingMayBeAbsent: true },
  ),
  def(
    "prospect_reach_outs",
    "outreach",
    "Prospect reach-outs",
    "Any outbound contact to an account that was not yet a client at the time.",
    [...PROSPECT_WORDS, "reach out", "reach-out", "prospect touch", "new business outreach"],
    "Every outbound touchpoint plus every contact attempt where the account was not a client at the time. House accounts excluded.",
  ),
  def(
    "replies_received",
    "outreach",
    "Replies received",
    "Outreach that got an answer — a reply recorded against one of the rep's touchpoints.",
    [
      "reply",
      "replies",
      "replied",
      "answered",
      "response",
      "responses",
      "got back",
      "wrote back",
      "engagement",
    ],
    "touchpoints.created_by = rep with replied_at in window.",
    { group: "both" },
  ),
  def(
    "inbound_contacts",
    "outreach",
    "Inbound contacts",
    "Calls, emails or messages that came in from the account and were logged to the rep.",
    ["inbound", "incoming", "came in", "they called", "they emailed", "received"],
    "touchpoints.direction = 'inbound', created_by = rep, occurred_at in window.",
    { group: "both" },
  ),

  /* ------------------------------------------------------- Meetings */
  def(
    "meetings_held",
    "meetings",
    "Meetings held",
    "Meetings that happened — meeting touchpoints, or accounts moved to a meeting-held stage, whichever is higher.",
    ["meeting", "meetings", "met", "sat down", "appointment", "appointments", "held"],
    "GREATEST(meeting touchpoints, stage moves to meeting_held) — the leaderboard_standings column.",
    { group: "both", standing: (s) => s.meetings_held },
  ),
  def(
    "meetings_in_person",
    "meetings",
    "In-person meetings",
    "Face-to-face meetings and visits that happened — a canceled calendar meeting does not count.",
    [
      "in person",
      "in-person",
      "face to face",
      "showed up",
      "show up",
      "visit",
      "visits",
      "drop in",
      "drop-in",
      "site visit",
      "on site",
      "walk in",
      "lunch",
    ],
    "touchpoints.type = 'meeting_in_person' and meeting_held is not false, by the rep, in window.",
    { group: "both" },
  ),
  def(
    "meetings_virtual",
    "meetings",
    "Virtual meetings",
    "Video or phone meetings that happened.",
    ["virtual", "video", "zoom", "teams", "google meet", "remote", "online meeting"],
    "touchpoints.type = 'meeting_virtual' and meeting_held is not false, by the rep, in window.",
  ),
  def(
    "meetings_booked",
    "meetings",
    "Meetings booked",
    "Meetings put on the calendar with an account, plus accounts moved to a meeting-booked stage.",
    [
      "booked",
      "book",
      "scheduled",
      "schedule",
      "calendar",
      "set a meeting",
      "appointment set",
      "invite",
    ],
    "calendar_events created by the rep (not canceled, linked to an account) with starts_at in window, plus stage moves to meeting_booked.",
  ),
  def(
    "visits_logged",
    "meetings",
    "Visits logged (with location)",
    "Touchpoints recorded at a place — the visits that show on the Routes map.",
    [
      "visit",
      "visits",
      "route",
      "routes",
      "map",
      "checked in",
      "check in",
      "location",
      "gps",
      "was there",
      "showed up",
    ],
    "touchpoints with a recorded latitude, created_by = rep, occurred_at in window.",
    { group: "both" },
  ),

  /* ------------------------------------------------------- Pipeline */
  def(
    "accounts_advanced",
    "pipeline",
    "Accounts advanced",
    "Stage changes the rep made on accounts, in any direction.",
    ["stage", "stages", "moved", "advanced", "progressed", "pipeline moves", "stage change"],
    "account_stage_history.changed_by = rep, changed_at in window.",
    { standing: (s) => s.accounts_advanced },
  ),
  def(
    "stage_advances",
    "pipeline",
    "Forward stage moves",
    "Accounts moved forward in the pipeline by the rep — the auto-advance engine's moves do not count.",
    [
      "forward",
      "advance",
      "advances",
      "progress",
      "moved forward",
      "next stage",
      "up the pipeline",
    ],
    "account_stage_history forward moves by the rep, excluding any within two minutes of a stage_auto_advances firing.",
    { standing: (s) => s.stage_advances ?? 0 },
  ),
  def(
    "moved_to_active_outreach",
    "pipeline",
    "Moved to Active Outreach",
    "Accounts the rep started working — moved into the Active Outreach stage.",
    ["active outreach", "started working", "began outreach", "working", "first attempt"],
    "account_stage_history.to_stage = 'active_outreach', changed_by = rep, in window. House accounts excluded.",
  ),
  def(
    "moved_to_conversation_established",
    "pipeline",
    "Moved to Conversation Established",
    "Accounts where the rep got a two-way conversation going with a decision maker.",
    ["conversation", "conversation established", "talking", "engaged", "two-way", "decision maker"],
    "account_stage_history.to_stage = 'conversation_established', changed_by = rep, in window. House accounts excluded.",
  ),
  def(
    "moved_to_active_client",
    "pipeline",
    "Clients activated",
    "Accounts the rep moved to Active Client — a prospect became a client.",
    [
      "activated",
      "activate",
      "active client",
      "won",
      "closed",
      "signed up",
      "new client",
      "converted",
      "landed",
    ],
    "account_stage_history.to_stage in ('active_client','won','active'), changed_by = rep, in window. House accounts excluded.",
  ),
  def(
    "moved_to_no_service",
    "pipeline",
    "Marked No Service Needed",
    "Accounts the rep closed out as not needing the service, with a reason.",
    ["no service", "no service needed", "closed out", "not a fit", "disqualified", "in-house team"],
    "account_stage_history.to_stage = 'no_service_needed', changed_by = rep, in window. House accounts excluded.",
  ),
  def(
    "moved_to_ghosted",
    "pipeline",
    "Marked Ghosted",
    "Accounts the rep marked Ghosted after outreach went unanswered. Lower is better by default.",
    ["ghosted", "ghost", "goasted", "no response", "went dark", "unresponsive"],
    "account_stage_history.to_stage = 'goasted', changed_by = rep, in window. House accounts excluded.",
    { direction: "lower" },
  ),
  def(
    "leads_claimed",
    "pipeline",
    "Leads claimed",
    "Accounts the rep picked up out of the lead pool — moved out of Leads or New Lead Input.",
    ["claimed", "claim", "picked up", "took a lead", "lead pool", "new lead", "assigned"],
    "account_stage_history from_stage in ('leads','new_lead_input') to any other stage, changed_by = rep, in window. House accounts excluded.",
  ),
  def(
    "accounts_created",
    "pipeline",
    "Accounts created",
    "New accounts the rep entered into the CRM.",
    ["created", "added", "entered", "new account", "new accounts", "new record"],
    "accounts.created_by = rep, created_at in window. House accounts excluded.",
    { group: "both" },
  ),
  def(
    "new_accounts",
    "pipeline",
    "New accounts owned",
    "Accounts created in the window that the rep owns.",
    ["new accounts", "new", "opened", "book growth", "owned new"],
    "accounts.assigned_rep = rep and created_at in window. House accounts excluded.",
    { standing: (s) => s.new_accounts },
  ),
  def(
    "accounts_owned",
    "pipeline",
    "Accounts owned",
    "Accounts currently assigned to the rep. Not a window count — the size of their book today.",
    ["book", "owned", "portfolio", "assigned accounts", "my accounts", "book size"],
    "accounts.assigned_rep = rep. House accounts excluded.",
    { standing: (s) => s.accounts_owned },
  ),
  def(
    "cadence_health",
    "pipeline",
    "Cadence health",
    "Share of the rep's accounts touched inside the last 90 days. 1 means every account is on cadence.",
    ["cadence", "health", "on cadence", "overdue", "stale", "neglected", "coverage", "90 days"],
    "1 − (accounts with no touchpoint in 90 days ÷ accounts owned). House accounts excluded.",
    { unit: "percent", standing: (s) => s.cadence_health },
  ),
  def(
    "cold_leads_converted",
    "pipeline",
    "Cold leads converted",
    "Accounts that became a client in the window after the rep had to open the conversation — they passed through Active Outreach first.",
    [...PROSPECT_WORDS, "converted", "conversion", "closed cold", "won cold", "cold to client"],
    "Accounts owned by the rep with a move into a client stage in window and an earlier move into active_outreach. House accounts excluded.",
    { standing: loose("cold_leads_converted"), standingMayBeAbsent: true },
  ),
  def(
    "new_deals_worked",
    "pipeline",
    "New deals worked on",
    "Prospect accounts the rep reached out to for the first time in the window.",
    ["new deals", "deals", "new deal", "started", "opened", "worked", "first touch", "fresh"],
    "Distinct accounts whose earliest outbound touch by the rep falls in window and that were not a client at that moment. House accounts excluded.",
    { standing: loose("new_deals_worked"), standingMayBeAbsent: true },
  ),

  /* ---------------------------------------------------------- Fires */
  def(
    "incidents_dispatched",
    "fires",
    "Fires dispatched",
    "Fire incidents dispatched in the chaser's markets — the denominator for acceptance rate.",
    ["dispatched", "dispatch", "fires", "incidents", "alerts", "calls out", "sent out"],
    "incidents reported in window in any location the person belongs to.",
    { group: "chase", standing: (s) => s.incidents_dispatched },
  ),
  def(
    "incidents_accepted",
    "fires",
    "Fires accepted",
    "Fire incidents the chaser accepted.",
    ["accepted", "accept", "claimed", "took the fire", "responded", "chases"],
    "incidents.accepted_by = rep, accepted_at in window.",
    { group: "chase", standing: (s) => s.incidents_accepted },
  ),
  def(
    "fires_chased",
    "fires",
    "Fires chased",
    "Fires the chaser accepted and went after. The chase starts at acceptance.",
    ["fire", "fires", "chased", "chase", "chasing", "went to a fire", "fire chaser"],
    "incidents.accepted_by = rep, accepted_at in window — the same count as Fires accepted, under the name Mark uses.",
    { group: "both", standing: (s) => loose("fires_chased")(s) ?? s.incidents_accepted },
  ),
  def(
    "incidents_arrived",
    "fires",
    "Arrived on scene",
    "Fires where the chaser logged arrival.",
    ["arrived", "arrival", "on scene", "on site", "got there", "showed up", "reached"],
    "incidents.accepted_by = rep, arrived_at in window.",
    { group: "chase" },
  ),
  def(
    "chase_attempts",
    "fires",
    "Chase attempts",
    "Visits to a fire that did not close — an attempt logged with a reason, keeping the lead live or not.",
    ["attempt", "attempts", "tried", "revisit", "went back", "outcome", "reason"],
    "incident_attempts.chaser_id = rep, attended_at in window.",
    { group: "chase" },
  ),
  def(
    "contracts_signed",
    "fires",
    "Contracts signed",
    "Chases that ended with a signed no-cost contract.",
    ["contract", "contracts", "signed", "signature", "closed", "won the fire", "no-cost contract"],
    "incidents.accepted_by = rep with outcome = 'contract_signed', accepted_at in window.",
    { group: "both", standing: (s) => s.contracts_signed },
  ),
  def(
    "chase_acceptance",
    "fires",
    "Acceptance rate",
    "Share of dispatched fires the chaser accepted. 1 means every fire.",
    ["acceptance", "accept rate", "acceptance rate", "response rate", "pickup rate"],
    "incidents accepted ÷ incidents dispatched in the person's locations, capped at 1.",
    { group: "chase", unit: "percent", standing: (s) => s.chase_acceptance },
  ),
  def(
    "chase_tta",
    "fires",
    "Time to arrival",
    "Median minutes from accepting a fire to logging arrival. Lower is better.",
    [
      "tta",
      "time to arrive",
      "time to arrival",
      "response time",
      "speed",
      "how fast",
      "minutes",
      "eta",
    ],
    "median of (arrived_at − accepted_at) in minutes over the chaser's accepted incidents in window.",
    { group: "chase", unit: "minutes", direction: "lower", standing: (s) => s.median_tta_minutes },
  ),

  /* ---------------------------------------------------------- Money */
  def(
    "jobs_won",
    "money",
    "Jobs won",
    "Jobs opened in the window on accounts the rep owns (canceled jobs excluded).",
    ["job", "jobs", "won", "wins", "deals closed", "work", "booked jobs"],
    "jobs on accounts where assigned_rep = rep, created_at in window, status <> canceled. House accounts excluded.",
    { group: "both", standing: (s) => s.jobs_won },
  ),
  def(
    "jobs_signed_total",
    "money",
    "Jobs signed (total)",
    "Jobs signed on accounts the rep owns — insurance and cash together.",
    ["signed jobs", "jobs signed", "total jobs", "all jobs", "signed"],
    "Same as Jobs won: jobs on the rep's accounts, created_at in window, not canceled. House accounts excluded.",
    { standing: (s) => s.jobs_signed_total ?? s.jobs_won },
  ),
  def(
    "jobs_signed_insurance",
    "money",
    "Insurance jobs signed",
    "Signed jobs with an insurance carrier or claim on them.",
    ["insurance", "carrier", "claim", "claims", "insured", "adjuster"],
    "jobs on the rep's accounts with an insurance carrier, carrier account or insurance kind set. House accounts excluded.",
    { standing: (s) => s.jobs_signed_insurance ?? 0 },
  ),
  def(
    "jobs_signed_cash",
    "money",
    "Cash jobs signed",
    "Signed jobs with no insurance on them — paid directly.",
    ["cash", "cash job", "private pay", "self pay", "direct pay", "no insurance"],
    "jobs on the rep's accounts with no insurance carrier, carrier account or insurance kind. House accounts excluded.",
    { standing: (s) => s.jobs_signed_cash ?? 0 },
  ),
  def(
    "billed_value",
    "money",
    "Billed value",
    "Dollars billed on jobs opened in the window on the rep's accounts. Visible to managers only.",
    ["billed", "billing", "revenue", "sales", "dollars", "invoiced value", "$", "money", "amount"],
    "sum(jobs.billed_amount) on the rep's accounts, created_at in window, not canceled. NULL unless the caller may see money. House accounts excluded.",
    { group: "both", unit: "currency", standing: (s) => s.billed_value },
  ),
  def(
    "collected_value",
    "money",
    "Collected value",
    "Dollars collected on jobs opened in the window on the rep's accounts. Visible to managers only.",
    ["collected", "collections", "cash in", "paid", "received", "dollars in", "money in"],
    "sum(jobs.collected_amount) on the rep's accounts, created_at in window, not canceled. NULL unless the caller may see money. House accounts excluded.",
    { group: "both", unit: "currency", standing: (s) => s.collected_value },
  ),
  def(
    "invoices_sent",
    "money",
    "Invoices sent",
    "Invoices the rep sent to a customer or carrier.",
    ["invoice", "invoices", "billed out", "sent invoice", "bill"],
    "invoices.created_by = rep, sent_at in window. House accounts excluded.",
    { group: "both" },
  ),
  def(
    "payments_received",
    "money",
    "Payments received",
    "Payments recorded against invoices on the rep's accounts.",
    ["payment", "payments", "paid", "received payment", "check", "cheque", "deposit"],
    "invoice_payments received_at in window on invoices whose account (or job's account) the rep owns. House accounts excluded.",
    { group: "both" },
  ),
  def(
    "payments_collected",
    "money",
    "Payments collected ($)",
    "Dollars received against invoices on the rep's accounts in the window. Visible to managers only.",
    [
      "collected",
      "collections",
      "cash collected",
      "dollars collected",
      "money collected",
      "receipts",
    ],
    "sum(invoice_payments.amount) received_at in window on the rep's accounts. NULL unless the caller may see money. House accounts excluded.",
    { group: "both", unit: "currency" },
  ),

  /* ---------------------------------------------------------- Admin */
  def(
    "tasks_completed",
    "admin",
    "Tasks completed",
    "Tasks assigned to the rep that they marked done.",
    ["task", "tasks", "done", "completed", "to-do", "todo", "finished", "closed tasks"],
    "tasks.assignee = rep, status = 'done', completed_at in window. Tasks on house accounts excluded.",
    { group: "both" },
  ),
  def(
    "tasks_completed_on_time",
    "admin",
    "Tasks completed on time",
    "Tasks the rep finished on or before their due date.",
    ["on time", "punctual", "before due", "not late", "deadline", "due date"],
    "Tasks completed in window where completed_at is on or before due_date (or there was no due date). Tasks on house accounts excluded.",
    { group: "both" },
  ),
  def(
    "documents_uploaded",
    "admin",
    "Documents uploaded",
    "Files the rep uploaded — contracts, COIs, W-9s, correspondence, photos of paperwork.",
    [
      "document",
      "documents",
      "upload",
      "uploaded",
      "file",
      "files",
      "paperwork",
      "attachment",
      "coi",
      "w9",
    ],
    "documents.created_by = rep with a storage path, created_at in window. Documents on house accounts excluded.",
    { group: "both" },
  ),
  def(
    "documents_sent",
    "admin",
    "Documents sent for signature",
    "Documents the rep sent out to be signed.",
    ["sent", "sent for signature", "esign", "e-sign", "docusign", "sent contract", "sent document"],
    "documents.created_by = rep, sent_at in window. Documents on house accounts excluded.",
    { group: "both" },
  ),
  def(
    "documents_signed",
    "admin",
    "Documents signed",
    "Documents the rep sent that came back signed.",
    ["signed", "signature", "executed", "countersigned", "signed contract", "signed document"],
    "documents.created_by = rep, signed_at in window. Documents on house accounts excluded.",
    { group: "both" },
  ),
  def(
    "notes_written",
    "admin",
    "Notes written",
    "Notes the rep wrote on accounts, jobs and leads.",
    ["note", "notes", "wrote", "journal", "log", "comment", "comments", "write up"],
    "account_notes.created_by + job_notes.author_id + lead_notes.author_id = rep, created_at in window.",
    { group: "both" },
  ),
];

export const ACTION_BY_KEY: ReadonlyMap<string, ActionDef> = new Map(
  ACTION_CATALOGUE.map((a) => [a.key, a]),
);

export function actionFor(key: string): ActionDef | null {
  return ACTION_BY_KEY.get(key) ?? null;
}

/** Entries an admin may put on a group's scorecard. */
export function actionsForGroup(group: "sales" | "chase"): ActionDef[] {
  return ACTION_CATALOGUE.filter((a) => a.group === group || a.group === "both");
}

/** Keys the standings row does not carry, and so must come from the RPC. */
export function keysNeedingCounts(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const a = ACTION_BY_KEY.get(k);
    if (a && (!a.standing || a.standingMayBeAbsent)) out.add(k);
  }
  return [...out];
}

/** The per-user output of `scorecard_action_counts`: key → value, null when withheld. */
export type ActionCounts = Record<string, number | null>;

/**
 * The actual for one catalogue key. The standings row wins when it carries
 * the value — that is what keeps every seeded component identical to before —
 * and the RPC's counts fill in everything else. Unknown key → null, so an
 * unrecognised component scores nothing rather than something.
 */
export function actionValue(key: string, s: Standing, counts?: ActionCounts | null): number | null {
  const a = ACTION_BY_KEY.get(key);
  if (!a) return null;
  if (a.standing) {
    const v = a.standing(s);
    if (v != null && Number.isFinite(v)) return v;
  }
  if (counts && key in counts) {
    const v = counts[key];
    return v == null ? null : Number(v);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/**
 * "a serach function thats smart": every word of the query has to land
 * somewhere — label, synonym or description — but it may land as a prefix
 * ("dial" → "dialed"), a substring, or one typo away ("emial" → "email").
 * Label and synonym hits outrank description hits, so "cold call" puts Cold
 * calls first and the other call entries behind it, rather than every entry
 * whose description mentions a call.
 */
export type ActionSearchHit = { action: ActionDef; score: number };

const tokenise = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, " ")
    .split(" ")
    .filter(Boolean);

/**
 * Optimal string alignment distance, bounded: true when `a` is within `max`
 * edits of `b`, counting an adjacent swap ("emial" → "email") as one edit,
 * because that is the typo people actually make.
 */
function withinEdits(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows[i] = new Array<number>(b.length + 1).fill(0);
    rows[i][0] = i;
  }
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = d;
      if (d < rowMin) rowMin = d;
    }
    if (rowMin > max) return false;
  }
  return rows[a.length][b.length] <= max;
}

/** Best score for one query token against a bag of words; 0 when it misses. */
function tokenScore(q: string, words: readonly string[]): number {
  let best = 0;
  for (const w of words) {
    let s = 0;
    if (w === q) s = 10;
    else if (w.startsWith(q)) s = 7;
    else if (q.length >= 3 && w.includes(q)) s = 5;
    else if (q.length >= 4 && withinEdits(q, w, 1)) s = 4;
    if (s > best) best = s;
  }
  return best;
}

type Indexed = {
  action: ActionDef;
  label: string[];
  syn: string[];
  desc: string[];
  phrases: string[];
};

const INDEX: Indexed[] = ACTION_CATALOGUE.map((a) => ({
  action: a,
  label: tokenise(a.label),
  syn: a.synonyms.flatMap(tokenise),
  desc: tokenise(a.description),
  phrases: [a.label.toLowerCase(), ...a.synonyms.map((s) => s.toLowerCase())],
}));

export function searchActions(
  query: string,
  opts: { group?: "sales" | "chase"; limit?: number } = {},
): ActionSearchHit[] {
  const pool = opts.group
    ? INDEX.filter((i) => i.action.group === opts.group || i.action.group === "both")
    : INDEX;
  const q = query.trim().toLowerCase();
  const tokens = tokenise(q);
  if (tokens.length === 0) {
    return pool.map((i) => ({ action: i.action, score: 0 })).slice(0, opts.limit ?? Infinity);
  }
  const hits: ActionSearchHit[] = [];
  for (const i of pool) {
    let total = 0;
    let missed = false;
    for (const t of tokens) {
      const inLabel = tokenScore(t, i.label);
      const inSyn = tokenScore(t, i.syn);
      const inDesc = tokenScore(t, i.desc);
      const s = Math.max(inLabel * 3, inSyn * 2, inDesc);
      if (s === 0) {
        missed = true;
        break;
      }
      total += s;
    }
    if (missed) continue;
    // A whole-phrase match on the label or a synonym is what a person meant.
    if (i.phrases.some((p) => p === q)) total += 40;
    else if (i.phrases.some((p) => p.includes(q))) total += 15;
    hits.push({ action: i.action, score: total });
  }
  hits.sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label));
  return opts.limit ? hits.slice(0, opts.limit) : hits;
}

/** Search hits bucketed by area, in display order, empty areas dropped. */
export function groupHitsByArea(
  hits: ActionSearchHit[],
): { area: ActionArea; label: string; hits: ActionSearchHit[] }[] {
  return ACTION_AREAS.map((area) => ({
    area: area.id,
    label: area.label,
    hits: hits.filter((h) => h.action.area === area.id),
  })).filter((g) => g.hits.length > 0);
}
