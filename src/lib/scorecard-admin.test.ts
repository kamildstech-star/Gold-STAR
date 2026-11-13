import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { actionFor } from "./action-catalogue";
import { PAGES } from "./page-access";
import { SETTINGS_PAGE_BY_PATH } from "./admin-settings";
import type { Weight } from "./scorecard";
import {
  draftFromAction,
  effectiveRows,
  minActivityAt,
  officeOverrides,
  planSave,
  previewPoints,
  rowProblems,
  weightTotal,
} from "./scorecard-admin";

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

const w = (over: Partial<Weight> & { component: string }): Weight => ({
  id: `id-${over.component}-${over.location_id ?? "co"}`,
  location_id: null,
  role_group: "sales",
  weight: 10,
  target: 5,
  direction: "higher",
  enabled: true,
  ...over,
});

const COMPANY: Weight[] = [
  w({ component: "touchpoints", weight: 20, target: 30 }),
  w({ component: "meetings_held", weight: 15, target: 4 }),
  w({ component: "jobs_won", weight: 15, target: 3, enabled: false }),
  w({ component: "chase_tta", role_group: "chase", weight: 25, target: 20, direction: "lower" }),
];

describe("effective rows per scope", () => {
  it("company scope lists company rows, disabled ones included, with their ids", () => {
    const rows = effectiveRows(COMPANY, "sales", { locationId: null });
    expect(rows.map((r) => r.component)).toEqual(["touchpoints", "jobs_won", "meetings_held"]);
    expect(rows.find((r) => r.component === "jobs_won")!.enabled).toBe(false);
    expect(rows.every((r) => r.id && r.source === "company")).toBe(true);
    expect(rows.every((r) => r.action)).toBe(true);
  });

  it("an office row overrides the company row for that component only", () => {
    const office = w({ component: "touchpoints", location_id: "L1", weight: 5, target: 60 });
    const rows = effectiveRows([...COMPANY, office], "sales", { locationId: "L1" });
    const tp = rows.find((r) => r.component === "touchpoints")!;
    expect(tp.source).toBe("office");
    expect(tp.target).toBe(60);
    expect(tp.id).toBe(office.id);
    expect(tp.companyRow?.target).toBe(30);
    const mh = rows.find((r) => r.component === "meetings_held")!;
    expect(mh.source).toBe("company");
    expect(mh.id).toBeNull();
    expect(officeOverrides([...COMPANY, office], "sales", "L1")).toBe(true);
    expect(officeOverrides(COMPANY, "sales", "L1")).toBe(false);
  });

  it("a disabled office row has no effect, as weightsFor() ignores it", () => {
    const off = w({ component: "touchpoints", location_id: "L1", enabled: false, target: 99 });
    const rows = effectiveRows([...COMPANY, off], "sales", { locationId: "L1" });
    expect(rows.find((r) => r.component === "touchpoints")!.target).toBe(30);
  });
});

describe("totals and preview", () => {
  it("sums enabled weights and previews weight × 25", () => {
    const rows = effectiveRows(COMPANY, "sales", { locationId: null });
    expect(weightTotal(rows)).toBe(35);
    expect(previewPoints(rows)).toBe(875);
  });

  it("a new row from the catalog: weight 10, direction from the catalog, target required", () => {
    const d = draftFromAction(actionFor("chase_tta")!, { locationId: null });
    expect(d.weight).toBe(10);
    expect(d.direction).toBe("lower");
    expect(d.target).toBeNull();
    expect(rowProblems([d])[0].message).toMatch(/Target is required/);
    expect(rowProblems([{ ...d, target: 20 }])).toEqual([]);
  });
});

describe("save plan", () => {
  it("company scope: edited rows update, new rows insert, removed rows delete", () => {
    const rows = effectiveRows(COMPANY, "sales", { locationId: null });
    const edited = rows
      .filter((r) => r.component !== "jobs_won")
      .map((r) => (r.component === "touchpoints" ? { ...r, target: 40 } : r));
    edited.push(draftFromAction(actionFor("cold_calls")!, { locationId: null }));
    edited[edited.length - 1].target = 50;
    const plan = planSave(edited, COMPANY, "sales", { locationId: null });
    expect(plan.updates).toEqual([
      { id: "id-touchpoints-co", weight: 20, target: 40, direction: "higher", enabled: true },
    ]);
    expect(plan.inserts).toEqual([
      {
        location_id: null,
        role_group: "sales",
        component: "cold_calls",
        weight: 10,
        target: 50,
        direction: "higher",
        enabled: true,
      },
    ]);
    expect(plan.deleteIds).toEqual(["id-jobs_won-co"]);
  });

  it("office scope: an untouched inherited row writes nothing; an edited one inserts an office row", () => {
    const rows = effectiveRows(COMPANY, "sales", { locationId: "L1" });
    const untouched = planSave(rows, COMPANY, "sales", { locationId: "L1" });
    expect(untouched).toEqual({ inserts: [], updates: [], deleteIds: [] });

    const edited = rows.map((r) => (r.component === "touchpoints" ? { ...r, weight: 0 } : r));
    const plan = planSave(edited, COMPANY, "sales", { locationId: "L1" });
    expect(plan.inserts).toHaveLength(1);
    expect(plan.inserts[0]).toMatchObject({
      location_id: "L1",
      component: "touchpoints",
      weight: 0,
    });
    expect(plan.updates).toEqual([]);
    expect(plan.deleteIds).toEqual([]);
  });

  it("office scope: removing an office row deletes it — back to the company rule — and never touches company rows", () => {
    const office = w({ component: "touchpoints", location_id: "L1", target: 60 });
    const all = [...COMPANY, office];
    const rows = effectiveRows(all, "sales", { locationId: "L1" }).filter(
      (r) => r.component !== "touchpoints",
    );
    const plan = planSave(rows, all, "sales", { locationId: "L1" });
    expect(plan.deleteIds).toEqual([office.id]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
  });
});

describe("minimum activity", () => {
  const rows = [
    { id: "s-co", location_id: null, min_activity_events: 8 },
    { id: "s-l1", location_id: "L1", min_activity_events: 3 },
  ];
  it("resolves office over company, and falls back to the default", () => {
    expect(minActivityAt(rows, { locationId: null })).toMatchObject({ value: 8 });
    expect(minActivityAt(rows, { locationId: "L1" })).toMatchObject({ value: 3, own: rows[1] });
    expect(minActivityAt(rows, { locationId: "L2" })).toMatchObject({ value: 8, own: null });
    expect(minActivityAt([], { locationId: null }).value).toBe(8);
  });
});

describe("the admin page is registered and gated", () => {
  it("page-access grants owner, admin, dev and the Sales Head, nobody else", () => {
    const page = PAGES.find((p) => p.path === "/admin/scorecard");
    expect(page).toBeDefined();
    expect([...page!.defaultRoles].sort()).toEqual(["admin", "dev", "owner", "sales_head"]);
  });

  it("is in the settings hub registry under Sales", () => {
    const entry = SETTINGS_PAGE_BY_PATH.get("/admin/scorecard");
    expect(entry?.area).toBe("sales");
    expect(entry?.keywords).toContain("leaderboard");
  });

  it("is in the admin nav for the same roles", () => {
    const shell = src("../components/app-shell.tsx");
    const item = shell.match(/to: "\/admin\/scorecard",[\s\S]*?roles: ([^\n]+),/);
    expect(item).not.toBeNull();
    expect(item![1]).toBe('[...PRIVILEGED, "sales_head"]');
  });

  it("the route file has two tabs, an office picker, a reset, a picker and the preview line", () => {
    const route = src("../routes/_authenticated/admin.scorecard.tsx");
    expect(route).toMatch(/createFileRoute\("\/_authenticated\/admin\/scorecard"\)/);
    expect(route).toMatch(/id: "sales"/);
    expect(route).toMatch(/id: "chase"/);
    expect(route).toMatch(/Company-wide default/);
    expect(route).toMatch(/Reset to company/);
    // The picker itself lives in src/components/action-picker.tsx since the
    // weekly challenge started sharing it; the route mounts it.
    expect(route).toMatch(/<ActionPicker\s/);
    expect(src("../components/action-picker.tsx")).toMatch(/searchActions\(q, \{ group \}\)/);
    expect(route).toMatch(/A rep who exactly hits every target scores/);
    expect(route).toMatch(/min_activity_events|Minimum activity/);
    // The number fields are plain Inputs for now — the shared formatted
    // component is landing on another branch.
    expect(route).toMatch(/<Input\s+type="number"/);
  });

  it("the Intelligence header links here instead of naming the table", () => {
    const intel = src("../routes/_authenticated/intelligence.index.tsx");
    const subtitle = intel.match(/subtitle=\{\s*<>([\s\S]*?)<\/>/);
    expect(subtitle).not.toBeNull();
    expect(subtitle![1]).toContain('to="/admin/scorecard"');
    expect(subtitle![1]).not.toContain("scorecard_weights");
  });
});
