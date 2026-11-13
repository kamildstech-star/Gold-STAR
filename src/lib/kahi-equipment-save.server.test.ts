/**
 * The Kahi sync's equipment save, against a stand-in that answers the way
 * PostgREST + Postgres do for a bulk upsert — which is the whole bug: a key
 * missing from one row of a bulk payload is sent as NULL, not as the column
 * default, so `id` arrived NULL for the three new assets on 11 Oct 2026 and
 * the 384 known ones in the same chunk were refused with them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import { fakeDb, type FakeDb } from "./fire-feed/fake-supabase.testkit";
import {
  kahiSyncHttpStatus,
  planEquipmentRows,
  saveEquipmentRows,
  type EquipmentUpsertRow,
  type ExistingEquipment,
} from "./kahi-equipment-save.server";
import type { KahiAssetRaw } from "./kahi.server";

type Row = Record<string, unknown>;

const NJ = "11111111-1111-4111-8111-111111111111";
const NOWHERE = "99999999-9999-4999-8999-999999999999";
const KNOWN_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = "2026-10-11T22:00:00.000Z";

let uuidSeq = 0;
const genUuid = () => `bbbbbbbb-0000-4000-8000-${String(++uuidSeq).padStart(12, "0")}`;

/**
 * One PostgREST bulk upsert on external_tracker_id, all-or-nothing like the
 * single INSERT … ON CONFLICT statement it becomes. Column list = union of
 * keys; a row lacking a listed key sends NULL; an unlisted column takes its
 * default (id → gen_random_uuid()); the UPDATE sets only listed columns.
 */
function postgrestUpsert(
  table: Row[],
  payload: Row[],
  locations: Set<string>,
): {
  data: { id: string; external_tracker_id: string | null }[] | null;
  error: { message: string } | null;
} {
  const columns = [...new Set(payload.flatMap((r) => Object.keys(r)))];
  const next = table.map((r) => ({ ...r }));
  const out: Row[] = [];
  for (const r of payload) {
    const sent: Row = {};
    for (const c of columns) sent[c] = c in r ? r[c] : null;
    const target = next.find((e) => e.external_tracker_id === sent.external_tracker_id);
    const row: Row = target ? { ...target, ...sent } : { id: genUuid(), ...sent };
    for (const c of ["id", "asset_tag", "equipment_type", "location_id"]) {
      if (row[c] == null) {
        return {
          data: null,
          error: {
            message: `null value in column "${c}" of relation "equipment" violates not-null constraint`,
          },
        };
      }
    }
    if (!locations.has(row.location_id as string)) {
      return {
        data: null,
        error: {
          message:
            'insert or update on table "equipment" violates foreign key constraint "equipment_location_id_fkey"',
        },
      };
    }
    if (next.some((e) => e !== target && e.asset_tag === row.asset_tag)) {
      return {
        data: null,
        error: {
          message: 'duplicate key value violates unique constraint "equipment_asset_tag_key"',
        },
      };
    }
    if (target) Object.assign(target, row);
    else next.push(row);
    out.push(row);
  }
  table.splice(0, table.length, ...next);
  return {
    data: out.map((r) => ({
      id: r.id as string,
      external_tracker_id: r.external_tracker_id as string,
    })),
    error: null,
  };
}

function asset(id: string, unit: string, shop = "NJ SHOP"): KahiAssetRaw {
  return {
    id,
    unit_id: unit,
    serial_number: `S-${unit}`,
    home_location: { name: shop },
    asset_category: { full_name: "Dehumidifier LGR", asset_group: "Dehumidifiers" },
    tracking: {
      coordinate_timestamp: "2026-10-11T21:55:00Z",
      coordinates: { latitude: 40.7, longitude: -74.1 },
    },
  };
}

const existing: ExistingEquipment[] = [
  { id: KNOWN_ID, asset_tag: "GSR00001NJ", external_tracker_id: "known-1", location_id: NJ },
];

describe("planEquipmentRows", () => {
  const plan = planEquipmentRows(
    [asset("known-1", "GSR00001NJ"), asset("c3c91b25-7426-4dfd-8a88-feb463f6b774", "GSR00970NJ")],
    existing,
    new Map([["NJ", NJ]]),
    NOW,
  );

  it("never puts id on a row, so PostgREST never lists the column", () => {
    for (const r of plan.rows) expect(r).not.toHaveProperty("id");
  });

  it("gives every row the same keys, so no row is padded with NULLs", () => {
    const shapes = new Set(plan.rows.map((r) => Object.keys(r).sort().join(",")));
    expect(shapes.size).toBe(1);
  });

  it("knows which assets are already in the register", () => {
    expect([...plan.known]).toEqual(["known-1"]);
  });
});

describe("saveEquipmentRows against PostgREST bulk-upsert semantics", () => {
  let table: Row[];
  const locations = new Set([NJ]);
  const upsert = (rows: EquipmentUpsertRow[]) =>
    Promise.resolve(postgrestUpsert(table, rows as unknown as Row[], locations));

  beforeEach(() => {
    table = [
      {
        id: KNOWN_ID,
        asset_tag: "GSR00001NJ",
        external_tracker_id: "known-1",
        equipment_type: "dehumidifier",
        location_id: NJ,
      },
    ];
  });

  it("reproduces the outage with the old payload: a known row's id NULLs the new row's", async () => {
    const plan = planEquipmentRows(
      [asset("known-1", "GSR00001NJ"), asset("new-1", "GSR00970NJ")],
      existing,
      new Map([["NJ", NJ]]),
      NOW,
    );
    const old = plan.rows.map((r) =>
      r.external_tracker_id === "known-1" ? { id: KNOWN_ID, ...r } : r,
    );
    const answer = postgrestUpsert(table, old as unknown as Row[], locations);
    expect(answer.error?.message).toBe(
      'null value in column "id" of relation "equipment" violates not-null constraint',
    );
  });

  it("a new asset with no id gets one, and the known asset keeps its own", async () => {
    const plan = planEquipmentRows(
      [asset("known-1", "GSR00001NJ"), asset("new-1", "GSR00970NJ")],
      existing,
      new Map([["NJ", NJ]]),
      NOW,
    );
    const { saved, failed } = await saveEquipmentRows(upsert, plan.rows);
    expect(failed).toEqual([]);
    expect(saved.get("known-1")).toBe(KNOWN_ID);
    expect(saved.get("new-1")).toMatch(/^bbbbbbbb-/);
    expect(table.find((r) => r.external_tracker_id === "new-1")?.id).toBe(saved.get("new-1"));
    expect(table.find((r) => r.external_tracker_id === "known-1")?.id).toBe(KNOWN_ID);
  });

  it("one bad asset does not sink the chunk: the rest save, the bad one is named with its reason", async () => {
    const plan = planEquipmentRows(
      [asset("known-1", "GSR00001NJ"), asset("new-1", "GSR00970NJ"), asset("bad-1", "GSR00971NJ")],
      existing,
      new Map([["NJ", NJ]]),
      NOW,
    );
    // A shop id that is not in locations: the FK refuses just this row.
    plan.rows.find((r) => r.external_tracker_id === "bad-1")!.location_id = NOWHERE;

    const { saved, failed } = await saveEquipmentRows(upsert, plan.rows);
    expect([...saved.keys()].sort()).toEqual(["known-1", "new-1"]);
    expect(failed).toEqual([
      {
        external_tracker_id: "bad-1",
        asset_tag: "GSR00971NJ",
        reason: expect.stringContaining("equipment_location_id_fkey"),
      },
    ]);
  });

  it("only retries the chunk that failed", async () => {
    const calls: number[] = [];
    const counting = (rows: EquipmentUpsertRow[]) => {
      calls.push(rows.length);
      return upsert(rows);
    };
    const assets = Array.from({ length: 5 }, (_, i) => asset(`n-${i}`, `T${i}`));
    const plan = planEquipmentRows(assets, existing, new Map([["NJ", NJ]]), NOW);
    plan.rows[4]!.location_id = NOWHERE;
    const { saved, failed } = await saveEquipmentRows(counting, plan.rows, 2);
    expect(saved.size).toBe(4);
    expect(failed.map((f) => f.external_tracker_id)).toEqual(["n-4"]);
    // [n-0,n-1] ok, [n-2,n-3] ok, [n-4] fails, then [n-4] alone.
    expect(calls).toEqual([2, 2, 1, 1]);
  });
});

describe("kahiSyncHttpStatus", () => {
  it("is 200 for a clean run and for a partial one, 502 only when nothing was done", () => {
    expect(kahiSyncHttpStatus({ ok: true, partial: false })).toBe(200);
    expect(kahiSyncHttpStatus({ ok: false, partial: true })).toBe(200);
    expect(kahiSyncHttpStatus({ ok: false, partial: false })).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// The whole sync, end to end on an in-memory database, for the report shape.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  db: null as unknown as SupabaseClient,
  assets: [] as KahiAssetRaw[],
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return h.db;
  },
}));
vi.mock("@/lib/integration-credentials.server", () => ({
  ensureIntegrationEnv: async () => {},
}));
vi.mock("./kahi.server", async (importActual) => ({
  ...(await importActual<typeof import("./kahi.server")>()),
  kahiToken: () => "test-token",
  fetchKahiAssets: async () => ({ rows: h.assets }),
}));

/** fakeDb for everything, with `equipment` upserts answered PostgREST-style. */
function syncDb(): FakeDb {
  const fake = fakeDb({
    locations: [{ id: NJ, code: "NJ" }],
    equipment: [
      {
        id: KNOWN_ID,
        asset_tag: "GSR00001NJ",
        external_tracker_id: "known-1",
        equipment_type: "dehumidifier",
        location_id: NJ,
        tracker_provider: "kahi",
      },
    ],
  });
  const inner = fake.client;
  fake.client = {
    from(t: string) {
      const b = inner.from(t) as unknown as Record<string, unknown>;
      if (t !== "equipment") return b;
      return {
        ...b,
        upsert: (rows: Row[]) => ({
          select: () =>
            Promise.resolve(postgrestUpsert(fake.tables.equipment!, rows, new Set([NJ]))),
        }),
      };
    },
  } as unknown as SupabaseClient;
  return fake;
}

describe("syncKahiEquipment report", () => {
  it("a clean run with a new asset is ok and the new asset is in the register", async () => {
    const fake = syncDb();
    h.db = fake.client;
    h.assets = [asset("known-1", "GSR00001NJ"), asset("new-1", "GSR00970NJ")];
    const { syncKahiEquipment } = await import("./kahi-sync.server");
    const report = await syncKahiEquipment();
    expect(report).toMatchObject({
      ok: true,
      partial: false,
      failed: [],
      assets: 2,
      matched: 1,
      created: 1,
    });
    expect(kahiSyncHttpStatus(report)).toBe(200);
    expect(fake.tables.equipment!.find((r) => r.external_tracker_id === "new-1")?.id).toBeTruthy();
    expect(fake.tables.sync_runs!.at(-1)).toMatchObject({ success: true, upserted: 2 });
  });

  it("a refused asset makes the run partial, 200, with the asset and reason listed", async () => {
    const fake = syncDb();
    h.db = fake.client;
    // Taken tag owned by nobody we know of → planning keeps it; the unique
    // index refuses it at save time (a concurrent manual add, say).
    fake.tables.equipment!.push({
      id: "cccccccc-0000-4000-8000-000000000001",
      asset_tag: "GSR00972NJ",
      external_tracker_id: null,
      equipment_type: "other",
      location_id: NJ,
    });
    h.assets = [
      asset("known-1", "GSR00001NJ"),
      asset("new-1", "GSR00970NJ"),
      asset("new-2", "GSR00972NJ"),
    ];
    const { syncKahiEquipment } = await import("./kahi-sync.server");
    // Hide the clashing row from the planner's read so the clash reaches the
    // database, the way a row added between read and write would.
    const from = fake.client.from.bind(fake.client);
    let reads = 0;
    fake.client.from = ((t: string) => {
      const b = from(t) as unknown as Record<string, unknown> & {
        select: (...a: unknown[]) => unknown;
      };
      if (t === "equipment" && reads++ === 0) {
        return {
          ...b,
          select: () =>
            Promise.resolve({
              data: fake.tables.equipment!.filter((r) => r.asset_tag !== "GSR00972NJ"),
              error: null,
            }),
        };
      }
      return b;
    }) as never;

    const report = await syncKahiEquipment();
    expect(report.ok).toBe(false);
    expect(report.partial).toBe(true);
    expect(report.matched).toBe(1);
    expect(report.created).toBe(1);
    expect(report.failed).toEqual([
      {
        external_tracker_id: "new-2",
        asset_tag: "GSR00972NJ",
        reason: expect.stringContaining("equipment_asset_tag_key"),
      },
    ]);
    expect(report.message).toContain("1 asset not saved: GSR00972NJ");
    expect(kahiSyncHttpStatus(report)).toBe(200);
    expect(fake.tables.sync_runs!.at(-1)).toMatchObject({ success: false, upserted: 2 });
    // The rest of the run still happened: the movement log was written.
    expect(report.events).toBe(3);
  });

  it("nothing saved at all is a total failure: ok and partial both false, 502", async () => {
    const fake = syncDb();
    h.db = fake.client;
    const from = fake.client.from.bind(fake.client);
    fake.client.from = ((t: string) => {
      const b = from(t) as unknown as Record<string, unknown>;
      if (t !== "equipment") return b;
      return {
        ...b,
        upsert: () => ({
          select: () => Promise.resolve({ data: null, error: { message: "permission denied" } }),
        }),
      };
    }) as never;
    h.assets = [asset("known-1", "GSR00001NJ"), asset("new-1", "GSR00970NJ")];
    const { syncKahiEquipment } = await import("./kahi-sync.server");
    const report = await syncKahiEquipment();
    expect(report).toMatchObject({ ok: false, partial: false });
    expect(report.failed).toHaveLength(2);
    expect(report.message).toBe("Saving equipment failed: permission denied");
    expect(kahiSyncHttpStatus(report)).toBe(502);
  });
});
