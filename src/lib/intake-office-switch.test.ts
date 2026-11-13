import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  canManageOffice,
  officeBadgeTail,
  officeSwitchChoices,
  type OfficeSwitchViewer,
  type SwitchableOffice,
} from "./intake-office-switch";
import { planIntakeRematch, type RematchCandidate } from "./intake-routing";

/*
 * Mark: "give a way to switch the office quickly if they don't like the
 * match". The switch offers exactly the offices can_manage_location would
 * accept, and a person's choice beats every rule.
 */

const offices: SwitchableOffice[] = [
  { id: "nyup", code: "NY-UP", name: "NY-Upstate", region_ids: ["north"] },
  { id: "nj", code: "NJ", name: "Lakewood", region_ids: ["mid"] },
  { id: "nw", code: "NW", name: "Newark", region_ids: ["mid"] },
];

const viewer = (v: Partial<OfficeSwitchViewer>): OfficeSwitchViewer => ({
  roles: [],
  memberships: [],
  regionMemberships: [],
  ...v,
});

describe("who manages an office — mirrors can_manage_location", () => {
  it("privileged staff manage every office", () => {
    expect(canManageOffice(viewer({ roles: ["admin"] }), offices[0])).toBe(true);
  });

  it("an office manager manages their own office only", () => {
    const v = viewer({ roles: ["location_manager"], memberships: [{ location_id: "nyup" }] });
    expect(canManageOffice(v, offices[0])).toBe(true);
    expect(canManageOffice(v, offices[1])).toBe(false);
  });

  it("a member without a managing role manages nothing", () => {
    const v = viewer({ roles: ["sales_rep"], memberships: [{ location_id: "nyup" }] });
    expect(canManageOffice(v, offices[0])).toBe(false);
  });

  it("a regional manages the offices of their region", () => {
    const v = viewer({ roles: ["regional"], regionMemberships: ["mid"] });
    expect(canManageOffice(v, offices[1])).toBe(true);
    expect(canManageOffice(v, offices[2])).toBe(true);
    expect(canManageOffice(v, offices[0])).toBe(false);
  });

  it("an unknown office is never managed", () => {
    expect(canManageOffice(viewer({ roles: ["admin"] }), undefined)).toBe(false);
  });
});

describe("the choices on the card", () => {
  it("an admin can send it to any other office", () => {
    const { canSwitch, choices } = officeSwitchChoices(
      viewer({ roles: ["admin"] }),
      offices,
      "nyup",
    );
    expect(canSwitch).toBe(true);
    expect(choices.map((o) => o.id)).toEqual(["nj", "nw"]);
  });

  it("a regional over Lakewood and Newark can swap between those two only", () => {
    const v = viewer({ roles: ["regional"], regionMemberships: ["mid"] });
    expect(officeSwitchChoices(v, offices, "nj").choices.map((o) => o.id)).toEqual(["nw"]);
  });

  it("a manager of the current office alone has nowhere to send it", () => {
    const v = viewer({ roles: ["office"], memberships: [{ location_id: "nyup" }] });
    expect(officeSwitchChoices(v, offices, "nyup")).toEqual({ canSwitch: false, choices: [] });
  });

  it("someone who cannot manage the current office gets no picker, never a list it would refuse", () => {
    const v = viewer({ roles: ["office"], memberships: [{ location_id: "nj" }] });
    expect(officeSwitchChoices(v, offices, "nyup")).toEqual({ canSwitch: false, choices: [] });
  });

  it("a form nothing matched is privileged staff's to place", () => {
    expect(officeSwitchChoices(viewer({ roles: ["admin"] }), offices, null).choices).toHaveLength(
      3,
    );
    const regional = viewer({ roles: ["regional"], regionMemberships: ["mid"] });
    expect(officeSwitchChoices(regional, offices, null).canSwitch).toBe(false);
  });
});

describe("the badge after a person chose", () => {
  const routed = {
    location_auto_assigned: true,
    location_route_reason: "nearest",
    location_route_detail: null,
    location_set_by: null,
    location_set_by_name: null,
  };

  it("names who set it", () => {
    expect(
      officeBadgeTail(
        {
          ...routed,
          location_auto_assigned: false,
          location_set_by: "u2",
          location_set_by_name: "Dana Ruiz",
        },
        "u1",
      ),
    ).toBe("set by Dana Ruiz");
  });

  it("says 'you' to the person who set it", () => {
    expect(
      officeBadgeTail({ ...routed, location_auto_assigned: false, location_set_by: "u1" }, "u1"),
    ).toBe("set by you");
  });

  it("still says it was a person when the name cannot be read", () => {
    expect(
      officeBadgeTail({ ...routed, location_auto_assigned: false, location_set_by: "u2" }, "u1"),
    ).toBe("set by hand");
  });

  it("otherwise says why the address chose it", () => {
    expect(officeBadgeTail(routed, "u1")).toBe("from address (nearest)");
    expect(
      officeBadgeTail(
        { ...routed, location_route_reason: "state_rule", location_route_detail: "PA" },
        "u1",
      ),
    ).toBe("from state rule (PA)");
  });
});

describe("a manual choice beats every rule", () => {
  it("a rule change never re-routes a form a person moved", () => {
    const moved: RematchCandidate = {
      id: "s1",
      job_id: null,
      status: "pending",
      fields: { site_address: "740 Oak St, Scranton, PA 18508" },
      location_id: "nyup",
      // What the switch writes, and what the database trigger enforces.
      location_auto_assigned: false,
      location_route_reason: "nearest",
      location_route_detail: null,
      request: { job_id: null, location_id: null, tradeshow_id: null },
    };
    const locations = [
      { id: "nyup", code: "NY-UP", name: "NY-Upstate", region: "NY", locality: null },
      { id: "nj", code: "NJ", name: "Lakewood", region: "NJ", locality: null },
    ];
    expect(
      planIntakeRematch([moved], locations, null, [
        { kind: "state", value: "PA", location_id: "nj" },
      ]),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  Wiring — asserted on extracted fragments, never on a whole file    */
/* ------------------------------------------------------------------ */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("wiring", () => {
  const route = read("src/routes/_authenticated/intake-inbox.tsx");
  const badge = route.match(/function OfficeBadge[\s\S]*?\n}\n/)![0];

  it("the office badge is the switch, offered only with choices and writes enabled", () => {
    expect(badge).toContain("officeSwitchChoices(app, app.visibleLocations, officeId)");
    expect(badge).toMatch(/if \(!canSwitch \|\| app\.writesDisabled\)/);
    expect(badge).toContain("<DropdownMenuTrigger asChild>");
    expect(badge).toMatch(/onSelect=\{\(\) => move\.mutate\(o\.id\)\}/);
  });

  it("choosing saves at once through setIntakeOffice and refreshes the inbox", () => {
    expect(badge).toMatch(
      /setIntakeOffice\(\{ submissionId: row\.id, locationId, userId: app\.userId \}\)/,
    );
    expect(badge).toContain("qc.invalidateQueries({ queryKey: INTAKE_INBOX_QUERY_KEY })");
  });

  it("the badge tail comes from officeBadgeTail, so a person's choice reads 'set by'", () => {
    expect(badge).toContain("officeBadgeTail(row, app.userId)");
  });

  it("the touch target is 44px on a phone", () => {
    const trigger = badge.match(/<button[\s\S]*?>/)![0];
    expect(trigger).toContain("min-h-11");
  });

  it("the write marks a person's choice and refuses silently-failed moves", () => {
    const lib = read("src/lib/intake-inbox.ts");
    const fn = lib.match(/export async function setIntakeOffice[\s\S]*?\n}\n/)![0];
    expect(fn).toContain("location_auto_assigned: false");
    expect(fn).toContain("location_set_by: input.userId");
    expect(fn).toContain('.is("job_id", null)');
    expect(fn).toMatch(
      /if \(res\.error && isMissingSchema\(res\.error\)\) res = await run\(base\)/,
    );
    expect(fn).toMatch(/if \(!res\.data\?\.length\)/);
  });

  it("Create new job opens in the form's office, which is now the chosen one", () => {
    const jobsNew = read("src/routes/_authenticated/jobs.new.tsx");
    expect(jobsNew).toMatch(
      /setIntakeLocationId\(row\.location_id \?\? row\.request\?\.location_id \?\? null\)/,
    );
  });

  it("the inbox reads who set the office, and still reads a database without it", () => {
    const lib = read("src/lib/intake-inbox.ts");
    const shapes = lib.match(/const SELECT_SHAPES = \[[\s\S]*?\] as const;/)![0];
    expect(shapes.split("\n")[1]).toContain("SUBMISSION_COLUMNS_CHOSEN");
    expect(shapes).toContain("`${SUBMISSION_COLUMNS_REASONED}, photos, ${REQUEST_EMBED_SHOW}`");
  });
});
