import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ageLabel,
  feedFreshness,
  fleetLocationFilter,
  freshnessOf,
  isStalePosition,
  liveFeedState,
  minutesSince,
  seesAllLocations,
} from "@/lib/fleet-visibility";

/**
 * Fleet: who sees which vans, and how old "where it is" really is.
 *
 * Both halves are David's, 16 Sep. He asked that vehicles be scoped to a
 * location with corporate seeing across them, and separately read a last-known
 * position dated "Sep 10" as where the van was on Thursday — it was six days
 * old and the screen said nothing about that.
 *
 * The scoping half is the one worth guarding hardest: a visibility rule that
 * quietly widens is invisible until somebody notices they can see another
 * office's fleet, and by then nobody remembers which change did it.
 */

const MIN = 60_000;
const NOW = Date.parse("2026-09-16T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();

describe("seesAllLocations", () => {
  it("lets corporate and regional look across offices", () => {
    expect(seesAllLocations(["owner"])).toBe(true);
    expect(seesAllLocations(["admin"])).toBe(true);
    expect(seesAllLocations(["dev"])).toBe(true);
    expect(seesAllLocations(["regional"])).toBe(true);
  });

  it("does not let a location manager — the role the rule exists to bound", () => {
    expect(seesAllLocations(["location_manager"])).toBe(false);
    expect(seesAllLocations(["office"])).toBe(false);
    expect(seesAllLocations(["crew"])).toBe(false);
    expect(seesAllLocations([])).toBe(false);
  });
});

describe("fleetLocationFilter", () => {
  it("returns no filter for corporate sitting on All my locations", () => {
    expect(
      fleetLocationFilter({
        roles: ["admin"],
        currentLocationId: null,
        visibleLocationIds: ["a", "b"],
      }),
    ).toBeNull();
  });

  it("still honors the switcher when corporate narrows to one office", () => {
    expect(
      fleetLocationFilter({
        roles: ["owner"],
        currentLocationId: "b",
        visibleLocationIds: ["a", "b"],
      }),
    ).toEqual(["b"]);
  });

  /*
   * The bug this module was written for. The page asked
   * `if (currentLocationId) q = q.eq(...)`, so a location manager whose sidebar
   * read "All my locations" — the default, because nothing is stored until
   * somebody picks an office — fell straight through the `if` and was served
   * every office's vehicles. It looked like the filter was there.
   */
  it("bounds a location manager on All my locations to their own offices", () => {
    expect(
      fleetLocationFilter({
        roles: ["location_manager"],
        currentLocationId: null,
        visibleLocationIds: ["a", "b"],
      }),
    ).toEqual(["a", "b"]);
  });

  it("never widens on a stale switcher value pointing somewhere unvisible", () => {
    expect(
      fleetLocationFilter({
        roles: ["location_manager"],
        currentLocationId: "z",
        visibleLocationIds: ["a"],
      }),
    ).toEqual(["a"]);
  });

  it("treats an empty list as a real answer: no offices means no vehicles", () => {
    // Distinct from null. The caller must show nothing, not everything.
    expect(
      fleetLocationFilter({
        roles: ["crew"],
        currentLocationId: null,
        visibleLocationIds: [],
      }),
    ).toEqual([]);
  });

  it("narrows a location user to the one office the switcher names", () => {
    expect(
      fleetLocationFilter({
        roles: ["office"],
        currentLocationId: "a",
        visibleLocationIds: ["a", "b"],
      }),
    ).toEqual(["a"]);
  });
});

describe("minutesSince", () => {
  it("is null when there has never been a fix", () => {
    expect(minutesSince(null, NOW)).toBeNull();
    expect(minutesSince(undefined, NOW)).toBeNull();
    expect(minutesSince("not a date", NOW)).toBeNull();
  });

  it("clamps a client clock running ahead of the server to zero, not a negative age", () => {
    expect(minutesSince(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe(0);
  });

  it("counts whole minutes", () => {
    expect(minutesSince(ago(90), NOW)).toBe(90);
  });
});

describe("ageLabel", () => {
  it("spells out days rather than printing a bare date", () => {
    // "10/09/2026, 15:14" is exactly how a six-day-old fix got read as
    // Thursday's. The number has to carry the warning itself.
    expect(ageLabel(6 * 24 * 60)).toBe("6 days ago");
    expect(ageLabel(24 * 60)).toBe("1 day ago");
  });

  it("uses minutes, then hours, then days", () => {
    expect(ageLabel(0)).toBe("just now");
    expect(ageLabel(4)).toBe("4m ago");
    expect(ageLabel(120)).toBe("2h ago");
  });

  it("says never when there is nothing to date", () => {
    expect(ageLabel(null)).toBe("never");
  });
});

describe("freshnessOf", () => {
  it("is live under a quarter of an hour, with nothing to warn about", () => {
    const f = freshnessOf(ago(4), NOW);
    expect(f.level).toBe("live");
    expect(f.warning).toBeNull();
    expect(isStalePosition(f)).toBe(false);
  });

  it("is recent but unwarned inside the hour", () => {
    const f = freshnessOf(ago(45), NOW);
    expect(f.level).toBe("recent");
    expect(f.warning).toBeNull();
    expect(isStalePosition(f)).toBe(false);
  });

  it("warns past the hour that this is where the vehicle WAS", () => {
    const f = freshnessOf(ago(180), NOW);
    expect(f.level).toBe("stale");
    expect(f.warning).toContain("not where it is");
    expect(isStalePosition(f)).toBe(true);
  });

  it("calls a fix older than a day history rather than a location", () => {
    const f = freshnessOf(ago(6 * 24 * 60), NOW);
    expect(f.level).toBe("very_stale");
    expect(f.ageLabel).toBe("6 days ago");
    expect(f.warning).toContain("6 days ago");
    expect(f.warning).toContain("history");
    expect(isStalePosition(f)).toBe(true);
  });

  it("says plainly when a vehicle has never reported", () => {
    const f = freshnessOf(null, NOW);
    expect(f.level).toBe("never");
    expect(f.minutes).toBeNull();
    expect(f.ageLabel).toBe("never");
    expect(isStalePosition(f)).toBe(true);
  });
});

describe("feedFreshness", () => {
  it("reads the whole feed from its newest fix, not its oldest", () => {
    // One van parked in a shed for a week is ordinary; it must not make the
    // feed itself look broken while the others are reporting.
    const f = feedFreshness([ago(9 * 24 * 60), ago(3), ago(400)], NOW);
    expect(f.level).toBe("live");
  });

  it("goes stale only when every vehicle has gone quiet — the feed being down", () => {
    const f = feedFreshness([ago(4 * 24 * 60), ago(5 * 24 * 60)], NOW);
    expect(f.level).toBe("very_stale");
    expect(isStalePosition(f)).toBe(true);
  });

  it("reports never when no vehicle has ever reported", () => {
    expect(feedFreshness([null, undefined], NOW).level).toBe("never");
    expect(feedFreshness([], NOW).level).toBe("never");
  });
});

/**
 * David, 17 Sep, on the fleet card: "you see this over here — that shouldn't be
 * there. You don't see it because it's white, but I did notice that there was
 * something there... we don't want anything showing up that doesn't belong
 * there."
 */
describe("nothing renders that has nothing to say", () => {
  const PAGE = readFileSync("src/routes/_authenticated/fleet.index.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("draws the provider id only when the vehicle has one", () => {
    // It was unconditional, so a vehicle with no external id rendered an empty
    // muted line under its name: invisible, and occupying a row.
    /*
     * The div's own text cannot tell a guarded render from an unguarded one —
     * prettier puts both on one line. So the assertion is that every render of
     * it follows the guard, which is the thing that actually changed.
     */
    const renders = [...code.matchAll(/\{r\.v\.external_id\}/g)];
    expect(renders).toHaveLength(1);
    const before = code.slice(0, renders[0]!.index);
    expect(before.slice(-120)).toContain("r.v.external_id?.trim() ? (");
  });

  it("no longer carries a row field nothing reads", () => {
    // `age` was computed onto every row and read nowhere.
    expect(code).not.toContain("const age = fresh.minutes");
    expect(code).not.toMatch(/return \{ v, lat, lon, at, age,/);
  });
});

describe("a dead feed is not a quiet fleet", () => {
  const now = Date.parse("2026-10-05T14:00:00Z");
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();

  it("live while a fix arrived within the hour", () => {
    expect(liveFeedState({ newestAt: ago(59), now })).toEqual({ live: true, reason: null });
  });

  it("names Raven's own error when the sync job recorded one", () => {
    const s = liveFeedState({
      newestAt: ago(6 * 60),
      ravenStatus: "error",
      ravenError: "Raven https://api.klashwerks.com/user-v1/auth/token → HTTP 403 Forbidden",
      now,
    });
    expect(s.live).toBe(false);
    expect(s.reason).toBe(
      "The Raven dashcam sync is failing: Raven https://api.klashwerks.com/user-v1/auth/token → HTTP 403 Forbidden",
    );
  });

  it("falls back to the age of the newest fix when the error is not readable", () => {
    expect(liveFeedState({ newestAt: ago(6 * 60), now }).reason).toBe(
      "Last position from any vehicle: 6h ago. The live feed has stopped.",
    );
    expect(liveFeedState({ newestAt: null, now }).reason).toBe(
      "No vehicle position has ever been received.",
    );
  });

  it("the fleet page blanks the live tiles instead of printing a zero", () => {
    const page = readFileSync("src/routes/_authenticated/fleet.index.tsx", "utf8").replace(
      /\r\n/g,
      "\n",
    );
    const moving = page.match(/label: "Moving now",[\s\S]*?icon: Navigation/)?.[0] ?? "";
    expect(moving).toMatch(/value: feed\.live \? movingCount\.toLocaleString\("en-US"\) : "—"/);
    expect(moving).toMatch(/note: feed\.live \? undefined : "Live feed unavailable"/);
    const near = page.match(/label: "Near incident",[\s\S]*?icon: AlertTriangle/)?.[0] ?? "";
    expect(near).toMatch(/value: feed\.live \? nearIncidentCount\.toLocaleString\("en-US"\) : "—"/);
  });
});
