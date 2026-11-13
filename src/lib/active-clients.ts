import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { JOB_STATUS_LABELS, OPEN_JOB_STATUSES, type JobStatus } from "@/lib/jobs";
import {
  computeClientHealth,
  countsTowardCadence,
  loadClientHealthSettings,
  type ClientHealthKey,
} from "@/lib/client-health";
import { ACTIVE_CLIENT_STAGE_KEYS } from "@/lib/pipeline-reversion";
import { accountClocks } from "@/lib/account-clocks";
import {
  computeHealthTracks,
  type ComplianceTrackRow,
  type HealthTrack,
} from "@/lib/client-health-tracks";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  criticalWindow,
  fetchOpenCriticalEpisodes,
  type CriticalWindow,
} from "@/lib/critical-clients";

/**
 * Active Clients is the operational view of a client who currently has work
 * running: which job, which phase, who the PM is, what the carrier is doing,
 * what is outstanding. Every column below is derived from a real record —
 * nothing here is decorative.
 */

/**
 * Health is one definition, shared with the account header, the nightly sweep
 * and the automation engine — see src/lib/client-health.ts. The board only
 * re-exports the tokens it renders with.
 */
export {
  HEALTH_META,
  HEALTH_SEVERITY,
  HEALTH_TO_FARMING_STAGE_KEY,
  isAtRisk,
  type ClientHealthKey,
} from "@/lib/client-health";

export type PhaseTone = "blue" | "teal" | "red" | "purple" | "grey";

const PHASE_TONE_BY_WORD: { match: RegExp; tone: PhaseTone }[] = [
  { match: /mitigat|dry/i, tone: "blue" },
  { match: /content/i, tone: "teal" },
  { match: /reconstruct|rebuild|repair/i, tone: "red" },
  { match: /walkthrough|final|complete/i, tone: "purple" },
];

export const PHASE_TONE_STYLE: Record<PhaseTone, { bg: string; fg: string }> = {
  blue: { bg: "var(--accent)", fg: "var(--primary)" },
  teal: {
    bg: "color-mix(in oklab, #0F766E 16%, var(--card))",
    fg: "color-mix(in oklab, #14B8A6 72%, var(--foreground))",
  },
  red: {
    bg: "color-mix(in oklab, #F97316 16%, var(--card))",
    fg: "color-mix(in oklab, #F97316 72%, var(--foreground))",
  },
  purple: {
    bg: "color-mix(in oklab, #7C3AED 16%, var(--card))",
    fg: "color-mix(in oklab, #8B5CF6 72%, var(--foreground))",
  },
  grey: { bg: "var(--muted)", fg: "var(--muted-foreground)" },
};

export function phaseTone(phase: string | null): PhaseTone {
  if (!phase) return "grey";
  return PHASE_TONE_BY_WORD.find((p) => p.match.test(phase))?.tone ?? "grey";
}

export type InsuranceStatus = "verified" | "in_review" | "in_progress" | "none";

/** Historical work stays on the account, but only live work makes it active. */
export function isOpenClientJobStatus(status: string | null | undefined): status is JobStatus {
  return OPEN_JOB_STATUSES.includes(status as JobStatus);
}

export const INSURANCE_STYLE: Record<InsuranceStatus, { label: string; bg: string; fg: string }> = {
  verified: {
    label: "Verified",
    bg: "color-mix(in oklab, #16A34A 16%, var(--card))",
    fg: "color-mix(in oklab, #16A34A 72%, var(--foreground))",
  },
  in_review: {
    label: "In Review",
    bg: "color-mix(in oklab, #F59E0B 16%, var(--card))",
    fg: "color-mix(in oklab, #F59E0B 72%, var(--foreground))",
  },
  in_progress: { label: "In Progress", bg: "var(--accent)", fg: "var(--primary)" },
  none: { label: "No claim", bg: "var(--muted)", fg: "var(--muted-foreground)" },
};

export type ActiveClientRow = {
  accountId: string;
  /** Owning office — whose managers may move the client back to the pipeline. */
  locationId: string | null;
  /** Who the account is assigned to — half of the `accounts_update` policy. */
  assignedRep: string | null;
  /**
   * That person's name, so a card can print an owner the way a pipeline card
   * does. The id alone is no use to a rep looking at a board.
   */
  assignedRepName: string | null;
  name: string;
  address: string;
  /** The address parts, unjoined, because each one saves on its own. */
  addressLine1: string | null;
  cityName: string | null;
  stateName: string | null;
  postalCode: string | null;
  city: string;
  /** What "Client since" shows: the stated day, falling back to created_at. */
  clientSince: string | null;
  /** The stated day alone — null when nobody has said, which is editable. */
  clientSinceStated: string | null;
  /** False when `accounts.client_since` has not been migrated in yet. */
  clientSinceAvailable: boolean;
  /** Prospecting stage key and account status — what "Move back to pipeline" checks. */
  stage: string | null;
  status: string | null;
  health: ClientHealthKey;
  /** Why the band is what it is: "No touch in 134 days". */
  healthReason: string;
  daysSinceTouch: number | null;
  /** Band the interaction metrics alone give — a hand move below it is refused. */
  healthMetric: ClientHealthKey;
  /** Band asserted by the stored Farming stage, if one is set. */
  healthOverride: ClientHealthKey | null;
  /**
   * False when the account type runs no relationship clock — a homeowner.
   * `health` is then Healthy and means "not tracked": the card shows the
   * reason rather than a green pill nobody earned.
   */
  healthTracked: boolean;
  /**
   * The two tracks behind `health`, in a fixed order, each with its own band
   * and one-word label. `health` is the WORSE of them; the card shows both,
   * because "red" alone does not say whether to phone the client or chase a
   * certificate. Empty when the account type runs no clock.
   */
  healthTracks: HealthTrack[];
  /**
   * 15+ days outstanding on any requirement. Shown as its own mark, NOT as a
   * colour: Critical says go and chase this, Non-Compliant says Gold Star may
   * not be allowed to take their work. See ComplianceVerdict.
   */
  nonCompliant: boolean;
  /**
   * The open Critical episode, when the nightly sweep has opened one: the
   * thirty-day cure window the rep is inside, or past. Null while none is
   * open — including the first day a card turns red before the sweep runs.
   */
  critical: (CriticalWindow & { episodeId: string; deadline: string; openedAt: string }) | null;
  /** `accounts.is_demo`, carried so the sweep marks what it creates the same way. */
  isDemo: boolean;
  satisfaction: number | null;
  jobId: string | null;
  jobNumber: string | null;
  lossType: string | null;
  lossDate: string | null;
  phase: string | null;
  pmName: string | null;
  insurance: InsuranceStatus;
  outstandingDocs: number;
  nextMilestone: { title: string; due: string | null } | null;
  jobValue: number | null;
  jobStatus: JobStatus | null;
};

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

// `account_type` and `what_they_do` are here for the clock rule, not for
// display: the type decides whether this row has a relationship clock at all
// (src/lib/account-clocks.ts), and a homeowner computed without them would
// show up as At Risk on a board Mark says it should never appear red on.
const ACCOUNT_COLUMNS =
  "id,name,location_id,assigned_rep,address_line1,city,state,postal_code,created_at,stage,stage_changed_at,status,health_stage_id,satisfaction_score,account_type,what_they_do,is_demo";

/**
 * `client_since` is newer than this code in any database the migration has not
 * reached yet, and PostgREST fails the WHOLE read on one unknown column. So the
 * board asks for it, and drops it rather than showing no clients at all — the
 * panel then says the field is not stored yet instead of pretending it saved.
 */
type BoardClient = Pick<SupabaseClient<Database>, "from" | "rpc">;

async function fetchAccountRows(
  client: BoardClient,
): Promise<{ rows: Row[]; clientSinceAvailable: boolean }> {
  const withColumn = await client
    .from("accounts")
    .select(`${ACCOUNT_COLUMNS},client_since`)
    .is("archived_at", null)
    .order("name")
    .limit(500);
  if (!withColumn.error) {
    return { rows: (withColumn.data ?? []) as Row[], clientSinceAvailable: true };
  }
  if (!isMissingSchema(withColumn.error)) throw withColumn.error;

  const without = await client
    .from("accounts")
    .select(ACCOUNT_COLUMNS)
    .is("archived_at", null)
    .order("name")
    .limit(500);
  if (without.error) throw without.error;
  return { rows: (without.data ?? []) as Row[], clientSinceAvailable: false };
}

/**
 * Takes the client so the nightly sweep (service role, on the server) can
 * compute exactly what the board shows — the Critical workflow opens and
 * closes episodes from this verdict and no other.
 */
export async function fetchActiveClients(
  client: BoardClient = supabase,
): Promise<ActiveClientRow[]> {
  const { rows, clientSinceAvailable } = await fetchAccountRows(client);
  const ids = rows.map((a) => String(a.id));
  if (ids.length === 0) return [];

  const [
    jobRes,
    stageRes,
    profileRes,
    taskRes,
    docRes,
    touchRes,
    settings,
    complianceRes,
    criticalEpisodes,
  ] = await Promise.all([
    client
      .from("jobs")
      .select(
        "id,account_id,job_number,loss_type,loss_date,status,stage_id,crew_chief,claim_number,approved_amount,estimated_amount,billed_amount,created_at",
      )
      .in("account_id", ids)
      .in("status", OPEN_JOB_STATUSES)
      .order("created_at", { ascending: false })
      .limit(2000),
    client.from("pipeline_stages").select("id,key,name"),
    client.from("profiles").select("user_id,full_name"),
    client
      .from("tasks")
      .select("id,account_id,job_id,title,due_date,status,priority")
      .in("account_id", ids)
      .neq("status", "done")
      .order("due_date")
      .limit(3000),
    client
      .from("documents")
      .select("id,account_id,job_id,status")
      .in("account_id", ids)
      .limit(3000),
    // Newest first, so the first row per account is the last touch that counts.
    client
      .from("touchpoints")
      .select("account_id,type,occurred_at,counts_toward_cadence")
      .in("account_id", ids)
      .order("occurred_at", { ascending: false })
      .limit(5000),
    loadClientHealthSettings(client),
    /*
     * The compliance track. Read as one query for the whole board rather than
     * per card, and tolerant of the schema not being there yet: `direction`
     * ships in 20260914120000, and PostgREST fails the WHOLE read on one
     * unknown column. A board that showed no clients because a migration had
     * not landed would be a worse failure than a board with no compliance
     * track, so this degrades to "no requirements known" exactly as
     * `client_since` does above.
     */
    client
      .from("account_compliance_status")
      .select(
        "account_id,requirement_type,direction,mandatory,status,requested_at,effective_expiry",
      )
      .in("account_id", ids)
      .limit(5000)
      .then((r) => (r.error && isMissingSchema(r.error) ? { data: [], error: null } : r)),
    // Open Critical episodes — the cure window each red card is inside.
    // Tolerant of the table not being there yet, like the two reads above.
    fetchOpenCriticalEpisodes(client),
  ]);
  const criticalByAccount = new Map(criticalEpisodes.map((e) => [e.account_id, e]));

  const stageName = new Map(
    ((stageRes.data ?? []) as Row[]).map((s) => [String(s.id), String(s.name)]),
  );
  const stageKey = new Map(
    ((stageRes.data ?? []) as Row[]).map((s) => [String(s.id), str(s.key) ?? ""]),
  );
  // Compliance requirements per account, both directions — the second track.
  const complianceByAccount = new Map<string, ComplianceTrackRow[]>();
  // Cast through unknown: `direction` ships in 20260914120000, so until that is
  // applied the generated types do not know the column. Same reason the read
  // above tolerates isMissingSchema — see src/lib/schema-fallback.ts.
  for (const row of (complianceRes.data ?? []) as unknown as Row[]) {
    const acc = str(row.account_id);
    if (!acc) continue;
    const list = complianceByAccount.get(acc) ?? [];
    list.push({
      account_id: acc,
      requirement_type: String(row.requirement_type ?? ""),
      direction: str(row.direction),
      mandatory: row.mandatory !== false,
      status: String(row.status ?? "satisfied"),
      requested_at: str(row.requested_at),
      effective_expiry: str(row.effective_expiry),
    });
    complianceByAccount.set(acc, list);
  }

  const lastTouch = new Map<string, string>();
  // The annual clock's anchor, filtered the same way — a meeting marked
  // not-held must not satisfy the yearly visit. Matches the DB view since
  // 20260914140000 and the nightly sweep.
  const lastInPerson = new Map<string, string>();
  for (const t of (touchRes.data ?? []) as Row[]) {
    const acc = str(t.account_id);
    if (!acc || !countsTowardCadence(t)) continue;
    if (!lastTouch.has(acc)) lastTouch.set(acc, String(t.occurred_at));
    if (t.type === "meeting_in_person" && !lastInPerson.has(acc)) {
      lastInPerson.set(acc, String(t.occurred_at));
    }
  }
  // Every profile, keyed by user id. Two different people are read out of it:
  // the job's crew chief (the PM) and the account's assigned rep.
  const pmName = new Map(
    ((profileRes.data ?? []) as Row[]).map((p) => [String(p.user_id), str(p.full_name) ?? "—"]),
  );

  // Most recent open job per account is the one the client is living through.
  // Completed, paid and cancelled history must not keep a reverted account on
  // Active Clients forever.
  const jobByAccount = new Map<string, Row>();
  for (const j of (jobRes.data ?? []) as Row[]) {
    const acc = str(j.account_id);
    if (!acc || jobByAccount.has(acc)) continue;
    jobByAccount.set(acc, j);
  }

  const nextTask = new Map<string, { title: string; due: string | null }>();
  for (const t of (taskRes.data ?? []) as Row[]) {
    const acc = str(t.account_id);
    if (!acc || nextTask.has(acc)) continue;
    nextTask.set(acc, { title: String(t.title), due: str(t.due_date) });
  }

  const OPEN_DOC = new Set(["draft", "sent", "viewed", "pending", "declined"]);
  const openDocs = new Map<string, number>();
  for (const d of (docRes.data ?? []) as Row[]) {
    const acc = str(d.account_id);
    if (!acc || !OPEN_DOC.has(String(d.status ?? ""))) continue;
    openDocs.set(acc, (openDocs.get(acc) ?? 0) + 1);
  }

  // Active Clients means clients with work running, a health stage, or a won
  // Prospecting stage — carrier reference records are not clients and never
  // belong on this board.
  // A client demoted to Dormant (the day-30 decision) is off this screen
  // until its win-back date brings it back to Active Outreach.
  const live = rows.filter(
    (a) =>
      String(a.status ?? "") !== "dormant" &&
      (jobByAccount.has(String(a.id)) ||
        a.health_stage_id != null ||
        (ACTIVE_CLIENT_STAGE_KEYS as readonly string[]).includes(String(a.stage ?? ""))),
  );

  return live.map((a) => {
    const id = String(a.id);
    const job = jobByAccount.get(id) ?? null;
    const stageId = job ? str(job.stage_id) : null;
    const status = job ? (String(job.status) as JobStatus) : null;
    const claim = job ? str(job.claim_number) : null;
    const approved = job ? Number(job.approved_amount ?? 0) : 0;

    const insurance: InsuranceStatus = !job
      ? "none"
      : !claim
        ? "in_progress"
        : approved > 0
          ? "verified"
          : "in_review";

    const value = job
      ? Number(job.billed_amount ?? job.approved_amount ?? job.estimated_amount ?? 0) || null
      : null;

    const clocks = accountClocks({
      account_type: str(a.account_type),
      what_they_do: Array.isArray(a.what_they_do) ? (a.what_they_do as string[]) : null,
      assigned_rep: str(a.assigned_rep),
    });

    const verdict = computeClientHealth(
      {
        lastTouchAt: lastTouch.get(id) ?? null,
        // A client with nothing logged yet is judged from when it became one.
        sinceAt: str(a.stage_changed_at) ?? str(a.created_at),
        lastInPersonAt: lastInPerson.get(id) ?? null,
        // An open job counts as the quarterly touch and never as the annual
        // visit — `job` below is the most recent OPEN job on this account,
        // which is the signal the board already computes.
        hasActiveJob: !!job,
        stageKey: a.health_stage_id ? (stageKey.get(String(a.health_stage_id)) ?? null) : null,
        clocksRun: clocks.relationshipClock,
      },
      settings,
    );

    /*
     * The two tracks. `accountClocks` is asked once above and its subject is
     * handed straight through, so the type rule has one authority and a
     * homeowner gets no tracks here for the same reason it gets no band.
     */
    const tracks = computeHealthTracks({
      relationship: verdict,
      compliance: complianceByAccount.get(id) ?? [],
      account: {
        account_type: str(a.account_type),
        what_they_do: Array.isArray(a.what_they_do) ? (a.what_they_do as string[]) : null,
        assigned_rep: str(a.assigned_rep),
      },
      // The onboarding floor runs from the green light, falling back to the
      // day the record was created.
      clientSince: str(a.client_since) ?? str(a.created_at),
    });

    return {
      accountId: id,
      locationId: str(a.location_id),
      assignedRep: str(a.assigned_rep),
      assignedRepName: a.assigned_rep ? (pmName.get(String(a.assigned_rep)) ?? null) : null,
      name: String(a.name),
      address: str(a.address_line1) ?? "—",
      addressLine1: str(a.address_line1),
      cityName: str(a.city),
      stateName: str(a.state),
      postalCode: str(a.postal_code),
      city:
        [str(a.city), str(a.state)].filter(Boolean).join(", ") +
        (a.postal_code ? ` ${a.postal_code}` : ""),
      clientSince: str(a.client_since) ?? str(a.created_at),
      clientSinceStated: str(a.client_since),
      clientSinceAvailable,
      stage: str(a.stage),
      status: str(a.status),
      /*
       * The WORSE of the two tracks, not the relationship band alone. An
       * account with a healthy relationship and an expired certificate is not
       * healthy, and before the compliance track existed this board said it
       * was. `healthMetric` below stays the RELATIONSHIP floor, because that is
       * what a hand move is judged against — compliance is not something a rep
       * may assert by dragging a card.
       */
      health: tracks.tracked ? tracks.overall : verdict.health,
      healthTracks: tracks.tracks,
      nonCompliant: tracks.nonCompliant,
      critical: (() => {
        const ep = criticalByAccount.get(id);
        return ep
          ? {
              ...criticalWindow(ep),
              episodeId: ep.id,
              deadline: ep.deadline,
              openedAt: ep.opened_at,
            }
          : null;
      })(),
      isDemo: a.is_demo === true,
      healthReason: verdict.reason,
      daysSinceTouch: verdict.daysSinceTouch,
      healthMetric: verdict.metric,
      healthOverride: verdict.override,
      healthTracked: verdict.tracked,
      satisfaction: a.satisfaction_score == null ? null : Number(a.satisfaction_score),
      jobId: job ? String(job.id) : null,
      jobNumber: job ? str(job.job_number) : null,
      lossType: job ? str(job.loss_type) : null,
      lossDate: job ? str(job.loss_date) : null,
      phase: stageId ? (stageName.get(stageId) ?? null) : status ? JOB_STATUS_LABELS[status] : null,
      pmName: job && job.crew_chief ? (pmName.get(String(job.crew_chief)) ?? null) : null,
      insurance,
      outstandingDocs: openDocs.get(id) ?? 0,
      nextMilestone: nextTask.get(id) ?? null,
      jobValue: value,
      jobStatus: status,
    } satisfies ActiveClientRow;
  });
}

export type ClientDetail = {
  job: Row | null;
  milestones: { label: string; date: string | null; done: boolean }[];
  tasks: { id: string; title: string; due: string | null; priority: string | null }[];
  messages: { id: string; subject: string; from: string; at: string | null }[];
  invoices: { id: string; number: string; date: string | null; amount: number; paid: boolean }[];
};

/** Milestone ladder every restoration job walks, in order. */
const MILESTONE_ORDER: { status: JobStatus; label: string }[] = [
  { status: "new", label: "Job Created" },
  { status: "scheduled", label: "Scheduled" },
  { status: "in_progress", label: "Mitigation Started" },
  { status: "drying", label: "Drying Complete" },
  { status: "complete", label: "Reconstruction Complete" },
  { status: "invoiced", label: "Final Walkthrough" },
];

/**
 * The job a client is living through, by the board's own rule: the most
 * recent job on the account whose status is still open, or none. The board
 * gets this from its one bulk read of every open job; the account record,
 * which shows one client at a time, asks for it by itself here. Same filter,
 * same order, so the Claim Details and Milestones cards on the record are
 * about the job the Client 360 panel would show.
 */
export async function fetchCurrentJobId(accountId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select("id")
    .eq("account_id", accountId)
    .in("status", OPEN_JOB_STATUSES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? String(data.id) : null;
}

export async function fetchClientDetail(
  accountId: string,
  jobId: string | null,
): Promise<ClientDetail> {
  const [jobRes, histRes, taskRes, mailRes, invRes] = await Promise.all([
    jobId
      ? supabase.from("jobs").select("*").eq("id", jobId).maybeSingle()
      : Promise.resolve({ data: null }),
    jobId
      ? supabase
          .from("job_status_history")
          .select("to_status,changed_at")
          .eq("job_id", jobId)
          .order("changed_at")
      : Promise.resolve({ data: [] }),
    supabase
      .from("tasks")
      .select("id,title,due_date,priority,status")
      .eq("account_id", accountId)
      .neq("status", "done")
      .order("due_date")
      .limit(8),
    supabase
      .from("email_messages")
      .select("id,subject,to_emails,sent_at,created_at,category")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("invoices")
      .select("id,invoice_number,issue_date,billed_amount,collected_amount,status")
      .eq("account_id", accountId)
      .order("issue_date", { ascending: false })
      .limit(5),
  ]);

  const reached = new Map<string, string>();
  for (const h of ((histRes as { data: Row[] | null }).data ?? []) as Row[]) {
    const s = String(h.to_status);
    if (!reached.has(s)) reached.set(s, String(h.changed_at));
  }
  const job = (jobRes as { data: Row | null }).data ?? null;
  const current = job ? String(job.status) : null;
  const currentIdx = MILESTONE_ORDER.findIndex((m) => m.status === current);

  const milestones = MILESTONE_ORDER.map((m, i) => ({
    label: m.label,
    date: reached.get(m.status) ?? null,
    done: reached.has(m.status) || (currentIdx >= 0 && i <= currentIdx),
  }));

  return {
    job,
    milestones,
    tasks: (((taskRes as { data: Row[] | null }).data ?? []) as Row[]).map((t) => ({
      id: String(t.id),
      title: String(t.title),
      due: str(t.due_date),
      priority: str(t.priority),
    })),
    messages: (((mailRes as { data: Row[] | null }).data ?? []) as Row[]).map((m) => ({
      id: String(m.id),
      subject: str(m.subject) ?? "(no subject)",
      from: Array.isArray(m.to_emails) ? String((m.to_emails as string[])[0] ?? "—") : "—",
      at: str(m.sent_at) ?? str(m.created_at),
    })),
    invoices: (((invRes as { data: Row[] | null }).data ?? []) as Row[]).map((i) => ({
      id: String(i.id),
      number: str(i.invoice_number) ?? "—",
      date: str(i.issue_date),
      amount: Number(i.billed_amount ?? 0),
      paid:
        Number(i.collected_amount ?? 0) >= Number(i.billed_amount ?? 0) &&
        Number(i.billed_amount ?? 0) > 0,
    })),
  };
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}
