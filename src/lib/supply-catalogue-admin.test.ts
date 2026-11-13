import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The supply catalogue is editable from the Cost rates screen.
 *
 * Mark, on that screen: "also they should be able to add or edit these as
 * needed". It could only price rows somebody had seeded by migration, so a new
 * consumable meant a SQL session.
 *
 * The two things worth guarding forever are here: the friendly half of a
 * collision on `lower(name)`, and that REMOVING an item archives it. A supply
 * item is pointed at by `supply_request_lines` and priced into every job by
 * the running-cost engine, so a delete would quietly rewrite finished jobs.
 */

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mocks.from } }));

import {
  BLANK_SUPPLY_DRAFT,
  addSupplyItem,
  archiveSupplyItem,
  duplicateSupplyName,
  prepareSupplyItem,
  updateSupplyItem,
} from "@/lib/running-cost";

type Call = { table: string; op: "insert" | "update" | "delete"; payload?: unknown; id?: unknown };

let calls: Call[] = [];
let insertResult: { data: unknown; error: unknown };
let writeError: unknown;

beforeEach(() => {
  calls = [];
  insertResult = {
    data: { id: "s9", name: "Duct tape", unit: "roll", category: null, unit_cost: 4 },
    error: null,
  };
  writeError = null;
  mocks.from.mockImplementation((table: string) => ({
    insert(payload: unknown) {
      calls.push({ table, op: "insert", payload });
      return { select: () => ({ single: async () => insertResult }) };
    },
    update(payload: unknown) {
      const call: Call = { table, op: "update", payload };
      calls.push(call);
      return {
        eq: async (_col: string, id: unknown) => {
          call.id = id;
          return { error: writeError };
        },
      };
    },
    delete() {
      calls.push({ table, op: "delete" });
      return { eq: async () => ({ error: null }) };
    },
  }));
});

describe("prepareSupplyItem", () => {
  it("refuses a nameless item with a sentence, not a database error", () => {
    const out = prepareSupplyItem({ ...BLANK_SUPPLY_DRAFT, name: "   " });
    expect(out).toEqual({ ok: false, error: "Name the item before adding it." });
  });

  it("trims, and falls back to the unit the column defaults to", () => {
    const out = prepareSupplyItem({
      name: "  Duct tape  ",
      unit: "  ",
      category: " ",
      unitCost: null,
    });
    expect(out).toEqual({
      ok: true,
      row: { name: "Duct tape", unit: "each", category: null, unit_cost: null },
    });
  });

  it("keeps a free-text unit exactly as David's sheet types it", () => {
    const out = prepareSupplyItem({
      name: "N95 masks",
      unit: "24 Case",
      category: "PPE",
      unitCost: 42.5,
    });
    expect(out).toEqual({
      ok: true,
      row: { name: "N95 masks", unit: "24 Case", category: "PPE", unit_cost: 42.5 },
    });
  });

  it("refuses a negative cost", () => {
    const out = prepareSupplyItem({ name: "Gloves", unit: "box", category: "", unitCost: -1 });
    expect(out).toEqual({ ok: false, error: "A unit cost cannot be negative." });
  });
});

describe("duplicateSupplyName", () => {
  it("says what collided and that capitals do not save you", () => {
    const msg = duplicateSupplyName(
      {
        code: "23505",
        message: 'duplicate key value violates unique constraint "supply_items_name_key"',
      },
      "  Duct Tape  ",
    );
    expect(msg).toContain('"Duct Tape"');
    expect(msg).toContain("ignores capitals");
  });

  it("recognizes the collision from the constraint name alone", () => {
    expect(duplicateSupplyName({ message: "supply_items_name_key" }, "x")).not.toBeNull();
  });

  it("stays out of the way of every other error", () => {
    expect(duplicateSupplyName({ code: "42501", message: "permission denied" }, "x")).toBeNull();
    expect(duplicateSupplyName(null, "x")).toBeNull();
  });
});

describe("addSupplyItem", () => {
  it("inserts the prepared row and hands back what the database stored", async () => {
    const row = await addSupplyItem({
      name: " Duct tape ",
      unit: "roll",
      category: "",
      unitCost: 4,
    });
    expect(calls).toEqual([
      {
        table: "supply_items",
        op: "insert",
        payload: { name: "Duct tape", unit: "roll", category: null, unit_cost: 4 },
      },
    ]);
    expect(row.id).toBe("s9");
  });

  it("never reaches the database with a draft it has already refused", async () => {
    await expect(addSupplyItem(BLANK_SUPPLY_DRAFT)).rejects.toThrow(
      "Name the item before adding it.",
    );
    expect(calls).toEqual([]);
  });
});

describe("updateSupplyItem", () => {
  it("patches only the field that was edited", async () => {
    await updateSupplyItem("s1", { category: "  PPE " });
    expect(calls).toEqual([
      { table: "supply_items", op: "update", payload: { category: "PPE" }, id: "s1" },
    ]);
  });

  it("empties a category back to null rather than to an empty string", async () => {
    await updateSupplyItem("s1", { category: "   " });
    expect(calls[0].payload).toEqual({ category: null });
  });

  it("refuses to blank a name", async () => {
    await expect(updateSupplyItem("s1", { name: "  " })).rejects.toThrow(
      "An item has to keep a name.",
    );
    expect(calls).toEqual([]);
  });

  it("writes nothing when the patch is empty", async () => {
    await updateSupplyItem("s1", {});
    expect(calls).toEqual([]);
  });

  it("throws the database error so the caller can name the collision", async () => {
    writeError = { code: "23505", message: "duplicate key" };
    await expect(updateSupplyItem("s1", { name: "Gloves" })).rejects.toMatchObject({
      code: "23505",
    });
  });
});

describe("archiveSupplyItem", () => {
  it("flips is_active and never deletes the row", async () => {
    await archiveSupplyItem("s1");
    expect(calls).toEqual([
      { table: "supply_items", op: "update", payload: { is_active: false }, id: "s1" },
    ]);
    expect(calls.some((c) => c.op === "delete")).toBe(false);
  });
});

/* ------------------------------------------------------- source guards */

const LIB = readFileSync(new URL("./running-cost.ts", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n",
);
// Cost rates › Materials & supplies moved whole to Billing & Costs › Cost ›
// Supplies book (prompt 3); the Cost rates address redirects there.
const PAGE = readFileSync(
  new URL("../components/billing-costs/supply-book.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const supplyCard = PAGE.match(/Supply unit costs[\s\S]*?<\/Card>/)![0];
// The per-unit equipment list moved to the Equipment area (23 Oct); what the
// Cost tab says about units is the note pointing there.
const equipmentNote = PAGE.match(/export function UnpricedUnitsNote[\s\S]*?\n}/)![0];

describe("the Supplies book offers add, edit and archive", () => {
  it("edits the name, the unit and the category in place, as the cost already did", () => {
    expect(supplyCard).toContain("saveItem(s, { name: next })");
    expect(supplyCard).toContain("saveItem(s, { unit: next })");
    expect(supplyCard).toContain("saveItem(s, { category: next })");
    expect(supplyCard).toContain("setSupplyCost(s.id, next)");
  });

  it("adds from a row at the bottom of the table", () => {
    const addRow = supplyCard.match(/<TableRow className="bg-muted\/40[\s\S]*?<\/TableRow>/)![0];
    expect(addRow).toContain('placeholder="New item"');
    expect(addRow).toContain("add.mutate()");
  });

  it("removes by archiving, behind a confirm", () => {
    expect(supplyCard).toContain("setArchiving(s)");
    const confirm = PAGE.match(/<AlertDialog open=\{!!archiving\}[\s\S]*?<\/AlertDialog>/)![0];
    expect(confirm).toContain("archive.mutate(archiving)");
    expect(confirm).toContain("Nothing is deleted");
    const archiveFn = LIB.match(/export async function archiveSupplyItem[\s\S]*?\n}/)![0];
    expect(archiveFn).toContain("is_active: false");
    expect(archiveFn).not.toContain(".delete(");
  });

  it("does not offer to add a machine — the register owns that", () => {
    expect(equipmentNote).not.toContain("add.mutate()");
    expect(equipmentNote).toContain('to="/equipment"');
  });
});

/**
 * Mark: "this is overlapping in the settings". `overflow-x-auto` on the card
 * body made it a scroll container, so the table's `sticky top:2.5rem` header
 * resolved against the CARD instead of the page scrollport and was pushed 40px
 * down its own table — an empty band under the title and the first row hidden
 * beneath the header. `Table` already scrolls itself sideways below md.
 */
describe("the table cards are not their own scroll container", () => {
  it("leaves the card body unpadded but not scrolling", () => {
    for (const card of [supplyCard]) {
      const content = card.match(/<CardContent className="[^"]*">/)![0];
      expect(content).toContain("p-0");
      expect(content).not.toContain("overflow-x-auto");
    }
  });
});
