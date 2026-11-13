import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  matchLocationForAddress,
  matchLocationForFields,
  normalizeZipPrefix,
  parseAddressZip,
  planIntakeRematch,
  routingBadgeSuffix,
  rulesFromRows,
  US_STATES,
  type IntakeOfficeRule,
  type RematchCandidate,
  type RoutableLocation,
} from "./intake-routing";
import { intakeRuleProblem } from "./intake-office-rules";

/*
 * Mark: "add in here a address match for intake, that will set certain states
 * to certain offices that overrides the closest match". His screenshot was a
 * Scranton, PA lead badged NY-UP "from address": Pennsylvania has no office,
 * so the closest office on the map won.
 */

const offices: RoutableLocation[] = [
  {
    id: "nyup",
    code: "NY-UP",
    name: "NY-Upstate",
    region: "NY",
    locality: "Binghamton",
    lat: 42.0987,
    lon: -75.918,
  },
  {
    id: "nj",
    code: "NJ",
    name: "Lakewood",
    region: "NJ",
    locality: "Lakewood",
    lat: 40.0978,
    lon: -74.2176,
  },
  {
    id: "nw",
    code: "NW",
    name: "Newark",
    region: "NJ",
    locality: "Newark",
    lat: 40.7357,
    lon: -74.1724,
  },
  {
    id: "closed",
    code: "OLD",
    name: "Closed",
    region: "PA",
    locality: "Allentown",
    lat: 40.6,
    lon: -75.47,
    active: false,
  },
];

const scranton = {
  site_address: "740 Oak St, Scranton, PA 18508",
  site_region: "PA",
  site_postal_code: "18508",
  site_lat: "41.4223",
  site_lon: "-75.6642",
};

const rule = (kind: "state" | "zip", value: string, location_id: string): IntakeOfficeRule => ({
  kind,
  value,
  location_id,
});

describe("today, without rules: the closest office wins", () => {
  it("sends Scranton to NY-Upstate, because PA has no office", () => {
    expect(matchLocationForFields(scranton, offices, null, [])).toEqual({
      locationId: "nyup",
      reason: "nearest",
    });
  });
});

describe("a state rule overrides the closest office", () => {
  it("PA → Lakewood beats NY-Upstate being nearer", () => {
    expect(matchLocationForFields(scranton, offices, null, [rule("state", "PA", "nj")])).toEqual({
      locationId: "nj",
      reason: "state_rule",
      detail: "PA",
    });
  });

  it("beats an in-state nearest office too — a rule is a person's decision", () => {
    // Toms River is nearest Lakewood; the rule says Newark.
    const tomsRiver = {
      site_address: "1 Main St, Toms River, NJ 08753",
      site_lat: "39.9537",
      site_lon: "-74.1979",
    };
    expect(matchLocationForFields(tomsRiver, offices, null, [rule("state", "NJ", "nw")])).toEqual({
      locationId: "nw",
      reason: "state_rule",
      detail: "NJ",
    });
  });

  it("works on a hand-typed address with no point and no structured state", () => {
    expect(
      matchLocationForAddress("740 Oak St, Scranton, PA 18508", offices, null, {
        rules: [rule("state", "PA", "nj")],
      }),
    ).toEqual({ locationId: "nj", reason: "state_rule", detail: "PA" });
  });

  it("leaves other states to the address", () => {
    const binghamton = { site_address: "5 Court St, Binghamton, NY 13901" };
    expect(matchLocationForFields(binghamton, offices, null, [rule("state", "PA", "nj")])).toEqual({
      locationId: "nyup",
      reason: "locality",
    });
  });

  it("skips a rule that names an inactive or unknown office, and the address decides", () => {
    expect(
      matchLocationForFields(scranton, offices, null, [rule("state", "PA", "closed")]).reason,
    ).toBe("nearest");
    expect(
      matchLocationForFields(scranton, offices, null, [rule("state", "PA", "gone")]).locationId,
    ).toBe("nyup");
  });

  it("beats the default office for a state the address cannot place", () => {
    expect(
      matchLocationForAddress("1 Ocean Dr, Miami, FL 33139", offices, "nyup", {
        rules: [rule("state", "FL", "nj")],
      }),
    ).toEqual({ locationId: "nj", reason: "state_rule", detail: "FL" });
  });
});

describe("a ZIP rule is narrower than a state rule, so it wins", () => {
  const rules = [rule("state", "PA", "nj"), rule("zip", "185", "nyup")];

  it("185 → NY-Upstate beats PA → Lakewood for a Scranton ZIP", () => {
    expect(matchLocationForFields(scranton, offices, null, rules)).toEqual({
      locationId: "nyup",
      reason: "zip_rule",
      detail: "185",
    });
  });

  it("the state rule still covers the rest of PA", () => {
    const philly = { site_address: "1 Market St, Philadelphia, PA 19107" };
    expect(matchLocationForFields(philly, offices, null, rules)).toEqual({
      locationId: "nj",
      reason: "state_rule",
      detail: "PA",
    });
  });

  it("the longest prefix wins", () => {
    expect(
      matchLocationForFields(scranton, offices, null, [
        rule("zip", "185", "nyup"),
        rule("zip", "18508", "nw"),
        rule("zip", "1850", "nj"),
      ]),
    ).toEqual({ locationId: "nw", reason: "zip_rule", detail: "18508" });
  });

  it("reads the ZIP off a typed address when the form has no structured one", () => {
    expect(
      matchLocationForAddress("740 Oak St, Scranton, PA 18508-1234", offices, null, { rules })
        .reason,
    ).toBe("zip_rule");
  });
});

describe("ZIP and state parsing for rules", () => {
  it("takes the structured ZIP first, else the last ZIP-shaped number", () => {
    expect(parseAddressZip("12345 Main St, Scranton, PA 18508", null)).toBe("18508");
    expect(parseAddressZip("whatever", "18508-1234")).toBe("18508");
    expect(parseAddressZip("12 Oak St, Scranton, PA", null)).toBeNull();
  });

  it("a ZIP prefix is three to five digits", () => {
    expect(normalizeZipPrefix("185")).toBe("185");
    expect(normalizeZipPrefix(" 18508 ")).toBe("18508");
    expect(normalizeZipPrefix("18")).toBeNull();
    expect(normalizeZipPrefix("185086")).toBeNull();
    expect(normalizeZipPrefix("18a")).toBeNull();
  });

  it("lists every state and DC once, for the picker", () => {
    expect(US_STATES).toHaveLength(51);
    expect(US_STATES.find((s) => s.code === "PA")?.name).toBe("Pennsylvania");
    expect(US_STATES.find((s) => s.code === "NJ")?.name).toBe("New Jersey");
  });

  it("drops a stored row the matcher would misread", () => {
    expect(
      rulesFromRows([
        { match_kind: "state", match_value: "pa", location_id: "nj" },
        { match_kind: "state", match_value: "XX", location_id: "nj" },
        { match_kind: "zip", match_value: "18", location_id: "nj" },
        { match_kind: "county", match_value: "Lackawanna", location_id: "nj" },
        { match_kind: "zip", match_value: "185", location_id: null },
      ]),
    ).toEqual([{ kind: "state", value: "PA", location_id: "nj" }]);
    expect(rulesFromRows(null)).toEqual([]);
  });
});

describe("the badge says why", () => {
  it("names the rule and what it matched", () => {
    expect(routingBadgeSuffix(true, "state_rule", "PA")).toBe("from state rule (PA)");
    expect(routingBadgeSuffix(true, "zip_rule", "185")).toBe("from ZIP rule (185)");
  });

  it("says the map guessed, and how", () => {
    expect(routingBadgeSuffix(true, "nearest", null)).toBe("from address (nearest)");
    expect(routingBadgeSuffix(true, "locality", null)).toBe("from address (town)");
    expect(routingBadgeSuffix(true, "state", null)).toBe("from address (state)");
    expect(routingBadgeSuffix(true, "fallback", null)).toBe("default office");
  });

  it("keeps the old wording for a row routed before the reason was stored", () => {
    expect(routingBadgeSuffix(true, null, null)).toBe("from address");
    expect(routingBadgeSuffix(true, "something-new", null)).toBe("from address");
  });

  it("has no tail when a person chose the office", () => {
    expect(routingBadgeSuffix(false, "state_rule", "PA")).toBe("");
  });
});

describe("re-routing the waiting forms after a rule change", () => {
  const general = { job_id: null, location_id: null, tradeshow_id: null };
  const base: RematchCandidate = {
    id: "s1",
    job_id: null,
    status: "pending",
    fields: scranton,
    location_id: "nyup",
    location_auto_assigned: true,
    location_route_reason: "nearest",
    location_route_detail: null,
    request: general,
  };
  const pa = [rule("state", "PA", "nj")];

  it("moves a waiting Scranton form the address put Upstate", () => {
    expect(planIntakeRematch([base], offices, null, pa)).toEqual([
      { id: "s1", locationId: "nj", reason: "state_rule", detail: "PA" },
    ]);
  });

  it("moves it back when the rule is removed", () => {
    const ruled = {
      ...base,
      location_id: "nj",
      location_route_reason: "state_rule",
      location_route_detail: "PA",
    };
    expect(planIntakeRematch([ruled], offices, null, [])).toEqual([
      { id: "s1", locationId: "nyup", reason: "nearest", detail: null },
    ]);
  });

  it("routes a form that matched nothing before", () => {
    const unrouted = {
      ...base,
      fields: { site_address: "1 Ocean Dr, Miami, FL 33139" },
      location_id: null,
      location_auto_assigned: false,
      location_route_reason: "none",
    };
    expect(planIntakeRematch([unrouted], offices, null, [rule("state", "FL", "nj")])).toEqual([
      { id: "s1", locationId: "nj", reason: "state_rule", detail: "FL" },
    ]);
  });

  it("never moves a form a person placed — the manual choice beats every rule", () => {
    const byHand = { ...base, location_auto_assigned: false };
    expect(planIntakeRematch([byHand], offices, null, pa)).toEqual([]);
  });

  it("never moves a form that is already a job, attached, or dismissed", () => {
    expect(planIntakeRematch([{ ...base, job_id: "j1" }], offices, null, pa)).toEqual([]);
    expect(planIntakeRematch([{ ...base, status: "applied" }], offices, null, pa)).toEqual([]);
    expect(planIntakeRematch([{ ...base, status: "dismissed" }], offices, null, pa)).toEqual([]);
  });

  it("never moves a form that came through an office's, a job's or a show's own link", () => {
    for (const request of [
      { ...general, location_id: "nyup" },
      { ...general, job_id: "j1" },
      { ...general, tradeshow_id: "t1" },
    ]) {
      expect(planIntakeRematch([{ ...base, request }], offices, null, pa)).toEqual([]);
    }
    expect(planIntakeRematch([{ ...base, request: null }], offices, null, pa)).toEqual([]);
  });

  it("leaves a form alone when the rules would put it where it already is", () => {
    expect(planIntakeRematch([base], offices, null, [])).toEqual([]);
  });
});

describe("saving a rule", () => {
  const name = (id: string) => (id === "nj" ? "NJ · Lakewood" : id);
  const existing = [{ id: "r1", kind: "state" as const, value: "PA", location_id: "nj" }];

  it("says a duplicate in words, naming where it already goes", () => {
    expect(
      intakeRuleProblem({ kind: "state", value: "pa", locationId: "nyup" }, existing, name),
    ).toBe("PA already goes to NJ · Lakewood. Remove that first.");
  });

  it("asks for what is missing", () => {
    expect(intakeRuleProblem({ kind: "state", value: "", locationId: "nj" }, [], name)).toBe(
      "Choose a state.",
    );
    expect(intakeRuleProblem({ kind: "state", value: "NJ", locationId: "" }, [], name)).toBe(
      "Choose the office.",
    );
    expect(intakeRuleProblem({ kind: "zip", value: "18", locationId: "nj" }, [], name)).toMatch(
      /3 to 5 digits/,
    );
    expect(intakeRuleProblem({ kind: "zip", value: "185", locationId: "nj" }, [], name)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Wiring — asserted on extracted fragments, never on a whole file    */
/* ------------------------------------------------------------------ */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("wiring", () => {
  it("the public submit routes with the rules and stores why", () => {
    const src = read("src/lib/intake-public.functions.ts");
    const route = src.match(/async function routeGeneralSubmission[\s\S]*?\n}\n/)![0];
    expect(route).toContain(".from(INTAKE_OFFICE_RULES_TABLE)");
    expect(route).toMatch(/error \? \[\] : rulesFromRows\(data\)/);
    expect(route).toMatch(/matchLocationForFields\(fields, .*, fallback, rules\)/);
    // The office goes in with the atomic save; the reason is stamped on that
    // saved row afterwards, because the atomic function predates the column.
    expect(src).toMatch(/location_id: routing\?\.locationId \?\? null/);
    const why = src.match(
      /if \(routing\) \{\s*const \{ error: whyError \}[\s\S]*?\.eq\("id", inserted\.id\)/,
    )![0];
    expect(why).toContain("location_route_reason: routing.reason");
    expect(why).toContain("location_route_detail: routing.detail ?? null");
  });

  it("the inbox badge prints the reason", () => {
    const src = read("src/routes/_authenticated/intake-inbox.tsx");
    const badge = src.match(/function OfficeBadge[\s\S]*?\n}\n/)![0];
    // The card's quick switch put a person's choice in front; the reason
    // still comes from routingBadgeSuffix, inside officeBadgeTail.
    expect(badge).toContain("officeBadgeTail(row, app.userId)");
    expect(badge).not.toContain('" · from address"');
    const tail = read("src/lib/intake-office-switch.ts").match(
      /export function officeBadgeTail[\s\S]*?\n}\n/,
    )![0];
    expect(tail).toMatch(/routingBadgeSuffix\(\s*row\.location_auto_assigned,/);
    expect(tail).toContain("row.location_route_reason");
  });

  it("the inbox reads the reason columns, and still reads a database without them", () => {
    const src = read("src/lib/intake-inbox.ts");
    const shapes = src.match(/const SELECT_SHAPES = \[[\s\S]*?\] as const;/)![0];
    expect(shapes).toContain("`${SUBMISSION_COLUMNS_REASONED}, photos, ${REQUEST_EMBED_SHOW}`");
    expect(shapes).toContain("`${SUBMISSION_COLUMNS_ROUTED}, photos, ${REQUEST_EMBED_SHOW}`");
  });

  it("the Territory page shows the rules card", () => {
    const src = read("src/routes/_authenticated/admin.territory.tsx");
    expect(src).toMatch(/<IntakeOfficeRulesCard disabled=\{disabled\} \/>/);
  });

  it("the card states the precedence and re-routes after a change", () => {
    const src = read("src/components/intake-office-rules-card.tsx");
    const order = src.match(/<ol[\s\S]*?<\/ol>/)![0];
    expect(order.indexOf("ZIP rule")).toBeLessThan(order.indexOf("state rule"));
    expect(order.indexOf("state rule")).toBeLessThan(order.indexOf("closest office"));
    const after = src.match(/const afterChange = async[\s\S]*?\n {2}};/)![0];
    expect(after).toContain("await rematchWaitingIntakes()");
  });

  it("the re-route update repeats the eligibility in its own filter", () => {
    const src = read("src/lib/intake-office-rules.ts");
    const update = src.match(
      /\.update\(\{\s*location_id: c\.locationId[\s\S]*?\.select\("id"\)/,
    )![0];
    expect(update).toContain('.is("job_id", null)');
    expect(update).toContain('.eq("status", "pending")');
    expect(update).toContain('.or("location_auto_assigned.eq.true,location_id.is.null")');
  });
});
