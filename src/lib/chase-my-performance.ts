// The chaser's own performance. Deliberately narrower than the management
// screen: the funnel starts where their action starts (chases they took),
// there are no alert counts, decline counts or response rates, and the only
// comparisons are their own last month plus an anonymous team average.
import { supabase } from "@/integrations/supabase/client";

export type MyChaseRow = {
  id: string;
  address: string | null;
  locality: string | null;
  reported_at: string;
  accepted_at: string | null;
  arrived_at: string | null;
  outcome: string | null;
  lifecycle: string;
  accepted_by: string | null;
};

const COLS = "id,address,locality,reported_at,accepted_at,arrived_at,outcome,lifecycle,accepted_by";

export type MyFunnel = { chases: number; arrived: number; signed: number };

export type MyPerformance = {
  current: MyChaseRow[];
  previous: MyChaseRow[];
  funnel: MyFunnel;
  previousFunnel: MyFunnel;
  /** Anonymous benchmark: one unnamed line, never a ranking. */
  teamAverage: MyFunnel & { chasers: number; signRate: number | null };
  /** Their arrival speed, minutes from accept to arrival. */
  medianArrivalMinutes: number | null;
  insights: MyInsight[];
  /** Set when there simply isn't enough of their own data yet. */
  insightsNote: string | null;
  missingOutcomes: MyChaseRow[];
};

export type MyInsight = { title: string; body: string; tone: "good" | "warn" | "info" };

const signed = (r: MyChaseRow) => r.lifecycle === "won" || r.outcome === "contract_signed";

export function monthWindow(offset = 0) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return { from, to };
}

function funnelOf(rows: MyChaseRow[]): MyFunnel {
  return {
    chases: rows.length,
    arrived: rows.filter((r) => r.arrived_at).length,
    signed: rows.filter(signed).length,
  };
}

function arrivalMinutes(r: MyChaseRow): number | null {
  if (!r.accepted_at || !r.arrived_at) return null;
  return (new Date(r.arrived_at).getTime() - new Date(r.accepted_at).getTime()) / 60_000;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function fetchAccepted(from: Date, to: Date, userId: string | null) {
  let q = supabase
    .from("incidents")
    .select(COLS)
    .not("accepted_by", "is", null)
    .gte("accepted_at", from.toISOString())
    .lt("accepted_at", to.toISOString());
  if (userId) q = q.eq("accepted_by", userId);
  const { data, error } = await q.order("accepted_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as MyChaseRow[];
}

/** Coaching that comes out of their own rows — never a canned tip. */
export function buildInsights(rows: MyChaseRow[], prev: MyFunnel): MyInsight[] {
  const out: MyInsight[] = [];
  const cur = funnelOf(rows);

  const fast = rows.filter((r) => {
    const m = arrivalMinutes(r);
    return m != null && m <= 20;
  });
  const slow = rows.filter((r) => {
    const m = arrivalMinutes(r);
    return m != null && m > 20;
  });
  if (fast.length >= 3 && slow.length >= 3) {
    const fastRate = fast.filter(signed).length / fast.length;
    const slowRate = slow.filter(signed).length / slow.length;
    if (slowRate > 0 && fastRate / slowRate >= 1.4) {
      const x = (fastRate / slowRate).toFixed(1).replace(/\.0$/, "");
      out.push({
        tone: "good",
        title: `You sign ${x}× as often when you arrive within 20 minutes`,
        body: `${Math.round(fastRate * 100)}% of your fast arrivals signed, against ${Math.round(
          slowRate * 100,
        )}% when it took longer. Same you, different clock.`,
      });
    } else if (fastRate > 0 && slowRate / fastRate >= 1.2) {
      out.push({
        tone: "info",
        title: "Speed is not what is deciding your signings",
        body: "Your fast and slow arrivals convert about the same, so the win is in what happens on the doorstep, not the drive.",
      });
    }
  }

  const noArrival = cur.chases - cur.arrived;
  if (cur.chases >= 4 && noArrival / cur.chases >= 0.3) {
    out.push({
      tone: "warn",
      title: `${noArrival} of your ${cur.chases} chases never got an arrival`,
      body: "Every chase you actually reach is a chance to sign. Closing that gap is the single biggest lever in your numbers.",
    });
  }

  if (cur.arrived >= 3) {
    const rate = cur.signed / cur.arrived;
    const prevRate = prev.arrived ? prev.signed / prev.arrived : null;
    if (prevRate != null && rate - prevRate >= 0.05) {
      out.push({
        tone: "good",
        title: `Your close rate on arrivals is up ${Math.round((rate - prevRate) * 100)} points`,
        body: `${Math.round(rate * 100)}% of the doors you reach this month sign, against ${Math.round(
          prevRate * 100,
        )}% last month.`,
      });
    } else if (prevRate != null && prevRate - rate >= 0.05) {
      out.push({
        tone: "warn",
        title: `Your close rate on arrivals is down ${Math.round((prevRate - rate) * 100)} points`,
        body: `${Math.round(rate * 100)}% this month against ${Math.round(prevRate * 100)}% last month, on the doors you reached.`,
      });
    }
  }

  const hours = new Map<number, { n: number; won: number }>();
  for (const r of rows) {
    if (!r.accepted_at) continue;
    const h = new Date(r.accepted_at).getHours();
    const b = hours.get(h) ?? { n: 0, won: 0 };
    b.n += 1;
    if (signed(r)) b.won += 1;
    hours.set(h, b);
  }
  const best = [...hours.entries()]
    .filter(([, b]) => b.n >= 3)
    .sort((a, b) => b[1].won / b[1].n - a[1].won / a[1].n)[0];
  if (best && best[1].won > 0) {
    const label = new Date(2000, 0, 1, best[0]).toLocaleTimeString("en-US", { hour: "numeric" });
    out.push({
      tone: "info",
      title: `Your strongest hour is around ${label}`,
      body: `${best[1].won} of ${best[1].n} chases you took at that hour signed.`,
    });
  }

  // Weekend versus weekday: a real correlation only if both sides have volume.
  const isWeekend = (r: MyChaseRow) => {
    const d = new Date(r.accepted_at ?? r.reported_at).getDay();
    return d === 0 || d === 6;
  };
  const wknd = rows.filter(isWeekend);
  const week = rows.filter((r) => !isWeekend(r));
  if (wknd.length >= 3 && week.length >= 3) {
    const a = wknd.filter(signed).length / wknd.length;
    const b = week.filter(signed).length / week.length;
    const gap = Math.round((a - b) * 100);
    if (Math.abs(gap) >= 10) {
      out.push({
        tone: gap > 0 ? "good" : "info",
        title:
          gap > 0
            ? `Your weekend chases convert ${gap} points better`
            : `Your weekday chases convert ${Math.abs(gap)} points better`,
        body: `${Math.round(a * 100)}% on weekends against ${Math.round(b * 100)}% midweek, on the chases you took.`,
      });
    }
  }

  return out.slice(0, 4);
}

export async function fetchMyPerformance(userId: string): Promise<MyPerformance> {
  const cur = monthWindow(0);
  const prev = monthWindow(-1);

  const [current, previous, teamRows] = await Promise.all([
    fetchAccepted(cur.from, cur.to, userId),
    fetchAccepted(prev.from, prev.to, userId),
    fetchAccepted(cur.from, cur.to, null),
  ]);

  const byChaser = new Map<string, MyChaseRow[]>();
  for (const r of teamRows) {
    const key = r.accepted_by!;
    byChaser.set(key, [...(byChaser.get(key) ?? []), r]);
  }
  const funnels = [...byChaser.values()].map(funnelOf);
  const chasers = funnels.length || 1;
  const teamChases = funnels.reduce((a, f) => a + f.chases, 0);
  const teamSigned = funnels.reduce((a, f) => a + f.signed, 0);
  const teamAverage = {
    chases: teamChases / chasers,
    arrived: funnels.reduce((a, f) => a + f.arrived, 0) / chasers,
    signed: teamSigned / chasers,
    chasers: funnels.length,
    // One unnamed benchmark line, computed across everyone.
    signRate: teamChases > 0 ? teamSigned / teamChases : null,
  };

  const previousFunnel = funnelOf(previous);
  const cutoff = Date.now() - 12 * 3_600_000;
  const insights = buildInsights(current, previousFunnel);

  return {
    current,
    previous,
    funnel: funnelOf(current),
    previousFunnel,
    teamAverage,
    medianArrivalMinutes: median(current.map(arrivalMinutes).filter((m): m is number => m != null)),
    insights,
    insightsNote: insights.length
      ? null
      : current.length < 5
        ? "Not enough of your own chases yet this month to draw a reliable pattern. Nothing is invented here — insights appear once the numbers can support them."
        : "Your numbers this month are too even to call out a pattern worth acting on.",

    // A nudge, never a block: old chases with nothing logged.
    missingOutcomes: current.filter(
      (r) =>
        !r.outcome &&
        r.lifecycle !== "won" &&
        new Date(r.accepted_at ?? r.reported_at).getTime() < cutoff,
    ),
  };
}
