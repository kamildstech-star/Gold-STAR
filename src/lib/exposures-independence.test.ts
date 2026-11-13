/**
 * Exposure independence.
 *
 * The rule the client cares about: a fire and each neighbour taken off it are
 * siblings, not parent and child. Signing the fire must not sign the block,
 * and losing the fire must not lose the neighbours. This exercises all four
 * combinations against the real database, plus the guard that refuses a
 * group-wide outcome write.
 */
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

const url = process.env["SUPABASE_URL"];
const key = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const live = !!url && !!key;
const d = live ? describe : describe.skip;

const admin = live ? createClient(url!, key!, { auth: { persistSession: false } }) : null;

const LOCATION = "68d38cfe-c792-4066-9801-9e88e4e02114";
const made: string[] = [];

type Combo = {
  name: string;
  origin: "won" | "lost";
  exposures: ("won" | "lost")[];
};

const WON = { outcome: "contract_signed", lifecycle: "won", status: "closed" } as const;
const LOST = { outcome: "homeowner_declined", lifecycle: "dead", status: "closed" } as const;

async function makeGroup(prefix: string, exposureCount: number) {
  const stamp = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const originId = crypto.randomUUID();
  const rows = [
    {
      id: originId,
      source: "test",
      external_ref: `${stamp}-origin`,
      incident_type: "fire",
      address: `${stamp} origin`,
      location_id: LOCATION,
      exposure_group_id: originId,
      is_exposure: false,
      is_demo: true,
    },
    ...Array.from({ length: exposureCount }, (_, i) => ({
      id: crypto.randomUUID(),
      source: "test",
      external_ref: `${stamp}-exp-${i}`,
      incident_type: "fire",
      address: `${stamp} exposure ${i}`,
      location_id: LOCATION,
      exposure_group_id: originId,
      is_exposure: true,
      is_demo: true,
    })),
  ];
  const { error } = await admin!.from("incidents").insert(rows);
  expect(error).toBeNull();
  for (const r of rows) made.push(r.id);
  return { originId, exposureIds: rows.slice(1).map((r) => r.id) };
}

async function read(ids: string[]) {
  const { data, error } = await admin!
    .from("incidents")
    .select("id,outcome,lifecycle,status,job_id")
    .in("id", ids);
  expect(error).toBeNull();
  return new Map((data ?? []).map((r) => [r.id, r]));
}

d("exposure outcomes never cascade", () => {
  afterAll(async () => {
    if (made.length) await admin!.from("incidents").delete().in("id", made);
  });

  const combos: Combo[] = [
    { name: "origin won, exposures lost", origin: "won", exposures: ["lost", "lost"] },
    { name: "origin lost, exposures won", origin: "lost", exposures: ["won", "won"] },
    { name: "mixed", origin: "won", exposures: ["won", "lost"] },
    { name: "all won", origin: "won", exposures: ["won", "won"] },
  ];

  for (const combo of combos) {
    it(combo.name, async () => {
      const { originId, exposureIds } = await makeGroup("indep", combo.exposures.length);

      // Each lead gets its own write — exactly how the app logs an outcome.
      const apply = async (id: string, want: "won" | "lost") => {
        const { error } = await admin!
          .from("incidents")
          .update({ ...(want === "won" ? WON : LOST), outcome_at: new Date().toISOString() })
          .eq("id", id);
        expect(error).toBeNull();
      };

      await apply(originId, combo.origin);
      for (const [i, id] of exposureIds.entries()) await apply(id, combo.exposures[i]!);

      const rows = await read([originId, ...exposureIds]);
      const expected = (want: "won" | "lost") => (want === "won" ? WON : LOST);

      expect(rows.get(originId)?.outcome).toBe(expected(combo.origin).outcome);
      expect(rows.get(originId)?.lifecycle).toBe(expected(combo.origin).lifecycle);
      for (const [i, id] of exposureIds.entries()) {
        const want = expected(combo.exposures[i]!);
        expect(rows.get(id)?.outcome).toBe(want.outcome);
        expect(rows.get(id)?.lifecycle).toBe(want.lifecycle);
      }
    });
  }

  it("refuses to write an outcome across the whole group at once", async () => {
    const { originId, exposureIds } = await makeGroup("guard", 2);
    const { error } = await admin!
      .from("incidents")
      .update({ ...WON, outcome_at: new Date().toISOString() })
      .eq("exposure_group_id", originId);

    expect(error).not.toBeNull();
    expect(`${error?.message}`.toLowerCase()).toContain("exposure independence");

    // Nothing was written — the group is untouched.
    const rows = await read([originId, ...exposureIds]);
    for (const r of rows.values()) expect(r.outcome).toBeNull();
  });
});
