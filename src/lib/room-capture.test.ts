import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { isPermanent } from "./offline-queue";
import { applyRoomCaptureOp, fetchRoomCapture } from "./room-capture";

/**
 * A stand-in for the Supabase client that records each call and answers with
 * whatever the test hands it. Only the chain shapes room-capture.ts uses.
 */
function fakeClient(answer: { data?: unknown; error?: unknown } = {}) {
  const calls: { table: string; method: string; args: unknown[] }[] = [];
  const result = { data: answer.data ?? null, error: answer.error ?? null };
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const method of ["update", "upsert", "delete", "select", "eq", "order"]) {
      q[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return q;
      };
    }
    q.then = (resolve: (v: unknown) => void) => resolve(result);
    return q;
  };
  return { client: { from: (t: string) => chain(t) } as never, calls };
}

describe("the raw capture writes the offline queue replays", () => {
  it("upserts a new door on its client id, so a replay lands one door", async () => {
    const { client, calls } = fakeClient();
    const row = {
      id: "d1",
      job_id: "job",
      room_id: "kitchen",
      kind: "interior_door" as const,
      width_in: 30,
      height_in: 80,
      qty: 1,
      created_by: "u1",
    };
    await applyRoomCaptureOp({ op: "opening_add", row }, client);
    expect(calls).toEqual([
      { table: "job_room_openings", method: "upsert", args: [row, { onConflict: "id" }] },
    ]);
  });

  it("writes a measurement as an UPDATE of the room and reads the row back", async () => {
    const { client, calls } = fakeClient({ data: [{ id: "kitchen" }] });
    await applyRoomCaptureOp(
      { op: "measure", roomId: "kitchen", patch: { length_ft: 12.5 } },
      client,
    );
    expect(calls.map((c) => [c.table, c.method])).toEqual([
      ["job_rooms", "update"],
      ["job_rooms", "eq"],
      ["job_rooms", "select"],
    ]);
    expect(calls[0]!.args[0]).toEqual({ length_ft: 12.5 });
  });

  it("turns an update RLS silently refused into a refusal the queue will not retry", async () => {
    const { client } = fakeClient({ data: [] });
    const write = applyRoomCaptureOp(
      { op: "cabinet_patch", id: "c1", patch: { length_ft: 8 } },
      client,
    );
    await expect(write).rejects.toThrow(/can see this job but not edit its rooms/);
    const err = await write.catch((e) => e);
    expect(isPermanent(err)).toBe(true);
  });

  it("deletes by id, which is safe to replay", async () => {
    const { client, calls } = fakeClient();
    await applyRoomCaptureOp({ op: "opening_delete", id: "d1" }, client);
    expect(calls.map((c) => c.method)).toEqual(["delete", "eq"]);
  });

  it("passes a database error through for the queue to classify", async () => {
    const { client } = fakeClient({ error: { code: "23503", message: "fk" } });
    const err = await applyRoomCaptureOp(
      {
        op: "cabinet_add",
        row: {
          id: "c1",
          job_id: "job",
          room_id: "r",
          kind: "base",
          length_ft: null,
          created_by: null,
        },
      },
      client,
    ).catch((e) => e);
    // A cabinet queued behind a room that has not landed yet: try again next pass.
    expect(err).toMatchObject({ code: "23503" });
    expect(isPermanent(err)).toBe(false);
  });
});

describe("copying a layout", () => {
  it("inserts rooms, then their doors, then their cabinet runs — and never overwrites on a replay", async () => {
    const { client, calls } = fakeClient();
    await applyRoomCaptureOp(
      {
        op: "copy_layout",
        targetUnit: "102",
        rooms: [
          {
            id: "r2",
            job_id: "job",
            unit: "102",
            name: "Kitchen",
            floor: null,
            length_ft: 12.5,
            width_ft: 10,
            height_ft: null,
            sort_order: 10,
            created_by: "u1",
          },
        ],
        openings: [
          {
            id: "o2",
            job_id: "job",
            room_id: "r2",
            kind: "interior_door",
            width_in: 30,
            height_in: 80,
            qty: 1,
            created_by: "u1",
          },
        ],
        cabinets: [],
      },
      client,
    );
    expect(calls.map((c) => [c.table, c.method])).toEqual([
      ["job_rooms", "upsert"],
      ["job_room_openings", "upsert"],
    ]);
    for (const c of calls) {
      expect(c.args[1]).toEqual({ onConflict: "id", ignoreDuplicates: true });
    }
  });
});

describe("reading a job's doors and cabinets", () => {
  it("is null — not an empty job — while the tables are not in the database", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const missing = fakeClient({
      error: { code: "PGRST205", message: "Could not find the table in the schema cache" },
    });
    Object.assign(supabase, missing.client);
    expect(await fetchRoomCapture("job")).toBeNull();
  });

  it("reads numeric columns as numbers", async () => {
    const { supabase } = await import("@/integrations/supabase/client");
    const ok = fakeClient({
      data: [
        {
          id: "x",
          job_id: "job",
          room_id: "r",
          kind: "base",
          width_in: "30",
          height_in: null,
          qty: "2",
          length_ft: "8.5",
        },
      ],
    });
    Object.assign(supabase, ok.client);
    const rows = await fetchRoomCapture("job");
    expect(rows!.openings[0]).toMatchObject({ width_in: 30, height_in: null, qty: 2 });
    expect(rows!.cabinets[0]).toMatchObject({ length_ft: 8.5 });
  });
});
