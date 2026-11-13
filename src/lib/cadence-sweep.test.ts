import { describe, expect, it } from "vitest";

import {
  MEETING_INTERVAL_DAYS,
  isSweptAccount,
  planCadenceTasks,
  type CadenceSweepAccount,
  type CadenceSweepTouchpoint,
} from "./cadence-sweep";
import { CLIENT_HEALTH_DEFAULTS, computeClientHealth, countsTowardCadence } from "./client-health";
import { HOMEOWNER_TYPE_KEYS } from "./account-clocks";

/**
 * The nightly sweep is the only thing in this system that creates work out of
 * silence. Both bugs it had were of the same kind — it agreed with nobody.
 *
 *   1. It did not ask whether the account's type runs a clock, so a homeowner
 *      got a "Quarterly touch overdue" task every month. Mark, 10 Sep 2026:
 *      "Homeowners get neither clock. They are a one time job. There is no
 *      future sale to protect, so there is nothing to follow up on."
 *      `computeClientHealth` had honoured that since the day it was written;
 *      the sweep never did, so the badge said "not tracked" while the rep's
 *      task list said "overdue today".
 *
 *   2. It counted every row in `touchpoints`, so an unanswered outbound email
 *      reset its 90-day clock. The Active Clients board has always filtered
 *      `counts_toward_cadence`. Same account, two answers.
 *
 * So these tests are written as agreement tests wherever they can be: not
 * "the sweep returns X" but "the sweep and the thing it disagreed with now
 * say the same thing about the same account". A future edit that re-breaks
 * either rule has to break an assertion that names the other module.
 */

const NOW = Date.parse("2026-09-14T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

const PERIOD = "2026-09";
const TODAY = "2026-09-14";
const REP = "11111111-1111-4111-8111-111111111111";

function account(over: Partial<CadenceSweepAccount> = {}): CadenceSweepAccount {
  return {
    id: "acc-1",
    name: "Test Account",
    location_id: "loc-1",
    assigned_rep: REP,
    account_type: "property_management",
    ...over,
  };
}

function touch(over: Partial<CadenceSweepTouchpoint> = {}): CadenceSweepTouchpoint {
  return {
    account_id: "acc-1",
    type: "email",
    occurred_at: daysAgo(1),
    counts_toward_cadence: true,
    ...over,
  };
}

function plan(accounts: CadenceSweepAccount[], touchpoints: CadenceSweepTouchpoint[] = []) {
  return planCadenceTasks({
    accounts,
    touchpoints,
    health: CLIENT_HEALTH_DEFAULTS,
    now: NOW,
    period: PERIOD,
    today: TODAY,
  });
}

/** "at_risk" | "quarterly" | "annual", in the order the sweep produced them. */
const kinds = (rows: { cadence_key: string }[]) => rows.map((r) => r.cadence_key.split(":")[0]);

/* ------------------------------------------------------------------ */
/* BUG 1 — the account type decides whether the sweep runs at all      */
/* ------------------------------------------------------------------ */

describe("a homeowner is never swept", () => {
  it("creates no task at all for a homeowner, however long the silence", () => {
    // The worst input the old code had: never touched, never met, a rep on the
    // record. That produced an urgent at-risk task AND an annual meeting task,
    // both due the same day, every month, forever.
    const rows = plan([account({ account_type: "homeowner" })]);
    expect(rows).toEqual([]);
  });

  it("skips every spelling of homeowner the clocks module recognizes", () => {
    // The sweep must not acquire its own idea of what a homeowner is. If a
    // spelling is added to HOMEOWNER_TYPE_KEYS tomorrow this test covers it
    // with no edit, because it iterates the exported list.
    for (const key of HOMEOWNER_TYPE_KEYS) {
      expect(plan([account({ account_type: key })]), `type ${key}`).toEqual([]);
    }
  });

  it("agrees with the health badge about the same account", () => {
    // The disagreement, stated directly. The badge says untracked; the sweep
    // must not be making work for a record the badge refuses to warn about.
    const homeowner = account({ account_type: "homeowner" });
    const verdict = computeClientHealth(
      { lastTouchAt: null, sinceAt: daysAgo(400), clocksRun: isSweptAccount(homeowner) },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    expect(verdict.tracked).toBe(false);
    expect(verdict.health).toBe("healthy");
    expect(plan([homeowner])).toEqual([]);
  });

  it("still sweeps every other type, including ones nobody has thought of", () => {
    // The fix may only ever quieten a homeowner. A management company, and an
    // account whose type is unknown or absent, keep exactly today's behaviour.
    for (const type of [
      "property_management",
      "insurance_broker",
      "tpa",
      "commercial",
      "a_new_type_2027",
      null,
    ]) {
      const rows = plan([account({ account_type: type })]);
      expect(kinds(rows), `type ${String(type)}`).toEqual(["at_risk", "annual"]);
    }
  });

  it("still skips an account with nobody to assign the task to", () => {
    // The pre-existing gate, kept. A task with no assignee is not a reminder.
    expect(plan([account({ assigned_rep: null })])).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* BUG 2 — only a real touchpoint resets the clock                     */
/* ------------------------------------------------------------------ */

describe("an unanswered outbound touchpoint does not reset the clock", () => {
  it("leaves the 90-day clock running when the only recent row is unanswered", () => {
    // 100 days since a real touch is past the 90-day watch threshold, so a
    // quarterly task is due. Yesterday's unanswered email must not silence it.
    const rows = plan(
      [account()],
      [
        touch({ occurred_at: daysAgo(100), counts_toward_cadence: true }),
        touch({ occurred_at: daysAgo(1), counts_toward_cadence: false }),
      ],
    );
    expect(kinds(rows)).toContain("quarterly");
    expect(rows.find((r) => r.cadence_key.startsWith("quarterly"))?.description).toBe(
      "Last touchpoint was 100 days ago.",
    );
  });

  it("treats an account whose only activity is unanswered outbound as never touched", () => {
    // Before the fix this account looked touched yesterday and produced
    // nothing. It has in fact never had a reply.
    const rows = plan(
      [account()],
      [touch({ occurred_at: daysAgo(1), counts_toward_cadence: false })],
    );
    expect(kinds(rows)).toContain("at_risk");
    expect(rows.find((r) => r.cadence_key.startsWith("at_risk"))?.description).toContain(
      "No touchpoint has ever been logged",
    );
  });

  it("does reset the clock on a real touch", () => {
    // The other half: the filter must not swallow genuine touches.
    const rows = plan(
      [account()],
      [touch({ occurred_at: daysAgo(1), counts_toward_cadence: true })],
    );
    expect(kinds(rows)).not.toContain("quarterly");
    expect(kinds(rows)).not.toContain("at_risk");
  });

  it("answers the same as the Active Clients board for one account", () => {
    // The board's rule, applied to the same rows, must pick the same "last
    // real touch" the sweep did — this is the bug restated as an equality.
    const rows: CadenceSweepTouchpoint[] = [
      touch({ occurred_at: daysAgo(100), counts_toward_cadence: true }),
      touch({ occurred_at: daysAgo(1), counts_toward_cadence: false }),
    ];
    const boardLastTouch = rows
      .filter(countsTowardCadence)
      .map((t) => t.occurred_at)
      .sort()
      .at(-1)!;

    const verdict = computeClientHealth(
      { lastTouchAt: boardLastTouch },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    expect(verdict.daysSinceTouch).toBe(100);
    expect(verdict.health).toBe("monitoring");

    // And the sweep, from the same rows, creates the task that band implies.
    expect(kinds(plan([account()], rows))).toContain("quarterly");
  });

  it("counts a row that does not carry the column, rather than dropping it", () => {
    // `countsTowardCadence` is `!== false`, which is the spelling the board has
    // always used. A caller that has not selected the column must not have
    // every touch silently discarded.
    const rows = plan(
      [account()],
      [touch({ occurred_at: daysAgo(1), counts_toward_cadence: undefined })],
    );
    expect(kinds(rows)).not.toContain("quarterly");
  });
});

/* ------------------------------------------------------------------ */
/* Everything the two fixes had to leave alone                         */
/* ------------------------------------------------------------------ */

describe("the rest of the sweep is unchanged", () => {
  it("keeps at-risk and quarterly mutually exclusive, worst first", () => {
    expect(kinds(plan([account()], [touch({ occurred_at: daysAgo(200) })]))).toEqual([
      "at_risk",
      "annual",
    ]);
    expect(kinds(plan([account()], [touch({ occurred_at: daysAgo(100) })]))).toEqual([
      "quarterly",
      "annual",
    ]);
  });

  it("keys every task by account and period, so a re-run is idempotent", () => {
    const rows = plan([account()]);
    expect(rows.map((r) => r.cadence_key)).toEqual([
      `at_risk:acc-1:${PERIOD}`,
      `annual:acc-1:${PERIOD}`,
    ]);
    expect(plan([account()]).map((r) => r.cadence_key)).toEqual(rows.map((r) => r.cadence_key));
  });

  it("carries the assignee, office and due date onto every row", () => {
    for (const row of plan([account()])) {
      expect(row.assignee).toBe(REP);
      expect(row.created_by).toBe(REP);
      expect(row.location_id).toBe("loc-1");
      expect(row.due_date).toBe(TODAY);
      expect(row.source).toBe("cadence");
      expect(row.entity_type).toBe("account");
      expect(row.entity_id).toBe("acc-1");
    }
  });

  it("does NOT let a meeting that never happened satisfy the annual clock", () => {
    // Phase 1 left this deliberately unfixed so the TypeScript and the database
    // view could not disagree, and reported it. Phase 2 fixes both together:
    // this line and `last_in_person_at` in migration 20260914140000.
    //
    // `tg_touchpoint_cadence` sets counts_toward_cadence for a meeting to
    // COALESCE(meeting_held, capture_source <> 'calendar'), so a calendar
    // meeting the client CANCELLED carries false. Letting it through held the
    // annual visit off for another 365 days on the strength of a cancellation.
    const notHeld = touch({
      type: "meeting_in_person",
      occurred_at: daysAgo(1),
      counts_toward_cadence: false,
    });
    expect(kinds(plan([account()], [notHeld]))).toContain("annual");
  });

  it("still lets a meeting that DID happen satisfy it", () => {
    const held = touch({
      type: "meeting_in_person",
      occurred_at: daysAgo(1),
      counts_toward_cadence: true,
    });
    expect(kinds(plan([account()], [held]))).not.toContain("annual");
  });

  it("asks for the annual meeting once a year has passed", () => {
    const held = (n: number) =>
      touch({ type: "meeting_in_person", occurred_at: daysAgo(n), counts_toward_cadence: true });
    expect(kinds(plan([account()], [held(MEETING_INTERVAL_DAYS - 1)]))).not.toContain("annual");
    expect(kinds(plan([account()], [held(MEETING_INTERVAL_DAYS)]))).toContain("annual");
  });

  it("ignores touchpoint rows with no account or an unparseable date", () => {
    const rows = plan(
      [account()],
      [touch({ account_id: null }), touch({ occurred_at: "not a date" })],
    );
    expect(kinds(rows)).toContain("at_risk");
  });

  it("plans each account independently", () => {
    const rows = plan(
      [
        account({ id: "acc-1" }),
        account({ id: "acc-2", account_type: "homeowner" }),
        account({ id: "acc-3", assigned_rep: null }),
      ],
      [touch({ account_id: "acc-1", occurred_at: daysAgo(100) })],
    );
    expect(rows.map((r) => r.account_id)).toEqual(["acc-1", "acc-1"]);
    expect(kinds(rows)).toEqual(["quarterly", "annual"]);
  });
});
