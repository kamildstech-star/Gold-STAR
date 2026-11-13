import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import type { JobRoom } from "@/lib/job-rooms";
import {
  addScopeLine,
  buildScopeOfWork,
  removeScopeLine,
  scopeItemCount,
  scopeLines,
  scopeOfWorkText,
  updateScopeLine,
} from "@/lib/scope-of-work";
import { buildScopeOfWorkPdf } from "@/lib/scope-of-work-pdf";

/**
 * David, 12 Oct, on scope of work from the rooms: per room, type a scope line
 * inline (no "+" first) in what used to be "Notes", now "Scope". "Generate
 * Scope" pulls every room's scope into one Scope-of-Work report — a plain
 * bullet list per room ("Living room — demo drywall", "Dining room — flood
 * cuts", "Kitchen — remove cabinets") — downloadable, and viewable on the job.
 */

const room = (over: Partial<JobRoom> & { id: string; name: string }): JobRoom => ({
  job_id: "job-1",
  unit: null,
  floor: null,
  length_ft: null,
  width_ft: null,
  height_ft: null,
  affected_materials: [],
  notes: null,
  sort_order: 0,
  flooring: null,
  extra_sf: 0,
  ...over,
});

const LIVING = room({ id: "r1", name: "Living room", notes: "demo drywall", sort_order: 0 });
const DINING = room({ id: "r2", name: "Dining room", notes: "flood cuts", sort_order: 10 });
const KITCHEN = room({
  id: "r3",
  name: "Kitchen",
  notes: "remove cabinets\nflood cuts 2ft",
  sort_order: 20,
});
const HALL = room({ id: "r4", name: "Hall", notes: null, sort_order: 30 });

describe("a room's scope lines", () => {
  it("is one item per line, with typed bullets and blanks dropped", () => {
    expect(scopeLines("- demo drywall\n\n• flood cuts\n  2. remove cabinets  \n")).toEqual([
      "demo drywall",
      "flood cuts",
      "remove cabinets",
    ]);
  });

  it("reads a room's old free-text Notes as its scope", () => {
    expect(scopeLines("Wet drywall on north wall")).toEqual(["Wet drywall on north wall"]);
  });

  it("adds what was typed inline, and a paste of several lines adds each", () => {
    expect(addScopeLine(null, "demo drywall")).toBe("demo drywall");
    expect(addScopeLine("demo drywall", "flood cuts\nremove baseboard")).toBe(
      "demo drywall\nflood cuts\nremove baseboard",
    );
  });

  it("adds nothing for a blank line", () => {
    expect(addScopeLine("demo drywall", "   ")).toBe("demo drywall");
    expect(addScopeLine(null, "")).toBeNull();
  });

  it("removes and edits one line in place", () => {
    const notes = "demo drywall\nflood cuts\nremove cabinets";
    expect(removeScopeLine(notes, 1)).toBe("demo drywall\nremove cabinets");
    expect(updateScopeLine(notes, 0, "demo drywall to 4ft")).toBe(
      "demo drywall to 4ft\nflood cuts\nremove cabinets",
    );
    expect(removeScopeLine("only line", 0)).toBeNull();
  });
});

describe("buildScopeOfWork — every room's scope, gathered", () => {
  it("lists each room that has scope, in room order, with its lines as bullets", () => {
    const scope = buildScopeOfWork([KITCHEN, HALL, LIVING, DINING]);
    expect(scope.map((r) => r.label)).toEqual(["Living room", "Dining room", "Kitchen"]);
    expect(scope.map((r) => r.items.map((i) => i.text))).toEqual([
      ["demo drywall"],
      ["flood cuts"],
      ["remove cabinets", "flood cuts 2ft"],
    ]);
    expect(scopeItemCount(scope)).toBe(4);
  });

  it("leaves out a room with no scope — the report is the work, not the room list", () => {
    expect(buildScopeOfWork([HALL])).toEqual([]);
  });

  it("leads with the unit in a multi-unit building", () => {
    const scope = buildScopeOfWork([room({ id: "u", name: "Kitchen", unit: "4B", notes: "demo" })]);
    expect(scope[0]!.label).toMatch(/4B.*Kitchen/);
  });

  it("gives each line a stable key — the seam for checkable tasks later", () => {
    const before = buildScopeOfWork([KITCHEN]);
    const after = buildScopeOfWork([{ ...KITCHEN, notes: `add dehu\n${KITCHEN.notes}` }]);
    const keyOf = (s: typeof before, text: string) => s[0]!.items.find((i) => i.text === text)!.key;
    expect(keyOf(after, "remove cabinets")).toBe(keyOf(before, "remove cabinets"));
    expect(keyOf(before, "remove cabinets")).toBe("r3:remove cabinets");
  });

  it("as plain text is the same layout: the room, then a bullet per line", () => {
    expect(scopeOfWorkText(buildScopeOfWork([LIVING, KITCHEN]))).toBe(
      "Living room\n- demo drywall\n\nKitchen\n- remove cabinets\n- flood cuts 2ft",
    );
  });
});

async function pageText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
    } catch {
      // not a content stream
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
    (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join(""),
  );
}

describe("the Scope-of-Work PDF", () => {
  const JOB = {
    job_number: "GS-1042",
    job_name: "Smith residence",
    customer_name: "Jane Smith",
    address: "12 Main St, Springfield",
  };

  it("has the title, the job, each room as a heading and each line as a bullet", async () => {
    const built = await buildScopeOfWorkPdf({
      job: JOB,
      scope: buildScopeOfWork([LIVING, DINING, KITCHEN]),
      preparedAt: new Date("2026-10-12T15:00:00Z"),
    });
    const text = await pageText(built.bytes);
    for (const s of [
      "SCOPE OF WORK",
      "Job GS-1042",
      "LIVING ROOM",
      "DINING ROOM",
      "KITCHEN",
      "demo drywall",
      "flood cuts",
      "remove cabinets",
    ]) {
      expect(text).toContain(s);
    }
    expect(built.filename).toBe("scope-of-work-gs-1042.pdf");
  });

  it("says so, rather than printing an empty page, when no room has scope", async () => {
    const built = await buildScopeOfWorkPdf({ job: JOB, scope: [] });
    expect(await pageText(built.bytes)).toContain("No scope has been written");
  });
});

describe("wiring", () => {
  it("the room's Notes field is now its inline Scope editor", () => {
    const tab = readFileSync("src/components/job-rooms-tab.tsx", "utf8");
    expect(tab).not.toMatch(/\+ notes for this room/);
    expect(tab).toMatch(/<RoomScopeEditor/);
    const editor = readFileSync("src/components/room-scope-editor.tsx", "utf8");
    // Always-visible input: Enter adds the line, no "+" to click first.
    expect(editor).toMatch(/e\.key === "Enter"/);
    expect(editor).toMatch(/>\s*Scope\s*</);
  });

  it("Generate Scope is on the Rooms tab and the job's General tab", () => {
    expect(readFileSync("src/components/job-rooms-tab.tsx", "utf8")).toMatch(/<ScopeOfWorkCard/);
    expect(readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8")).toMatch(
      /<ScopeOfWorkCard job=\{job\} legacyScope=\{job\.scope\}( className="[^"]*")? \/>/,
    );
    expect(readFileSync("src/components/scope-of-work-card.tsx", "utf8")).toMatch(/Generate Scope/);
  });

  it("has one scope on the General tab, with Translate on it (23 Oct)", () => {
    const page = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
    expect(page).not.toMatch(/<WorkOrderBlock/);
    const card = readFileSync("src/components/scope-of-work-card.tsx", "utf8");
    expect(card).toMatch(/data-scope-translate/);
    expect(card).toMatch(/<WorkOrderTranslation\s+inline/);
  });

  it('"Work order" reads "Scope of work" wherever a person sees it', () => {
    for (const f of [
      "src/components/work-order-block.tsx",
      "src/components/work-order-translation.tsx",
      "src/components/job-notices.tsx",
      "src/routes/_authenticated/jobs.new.tsx",
    ]) {
      const code = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(l))
        .join("\n");
      expect(code, f).not.toMatch(/[Ww]ork order/);
    }
  });
});
