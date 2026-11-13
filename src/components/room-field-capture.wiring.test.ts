// Field capture on the Rooms tab — Mark, 6 Oct 2026: "yes build field capture
// into the rooms tab."
//
// The arithmetic, the tape parser and the held-op overlay are tested on the
// real code in src/lib. What this file pins is that the SCREENS use them: the
// tab measures through the offline queue, the boxes open the number pad at a
// thumb's size, nothing pins itself above the mobile nav, and the queue knows
// how to replay a capture. No DOM testing library here, so each check pulls
// one fragment out of the source and asserts on that alone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const TAB = read("src/components/job-rooms-tab.tsx");
const PANEL = read("src/components/room-capture-panel.tsx");
const FIELD = read("src/components/tape-measure-field.tsx");
const HOOK = read("src/lib/use-room-capture.ts");
const QUEUE = read("src/lib/offline-queue.ts");
const ROOMS = read("src/lib/job-rooms.ts");

const pick = (src: string, re: RegExp) => re.exec(src)?.[0] ?? "";

describe("the Rooms tab measures rooms", () => {
  const MEASURE_FN = pick(TAB, /const measure = \(r: JobRoom, patch: RoomMeasurePatch\) =>[^;]*;/);
  const PANEL_USE = pick(TAB, /<RoomCapturePanel[\s\S]*?\/>/);
  const ADD_FN = pick(TAB, /const add = async \(\) => \{[\s\S]*?\n {2}\};\n/);
  const ROW_DIMS = pick(
    TAB,
    /kind="number"\s*value=\{r\.length_ft\}[\s\S]*?value=\{r\.height_ft\}[\s\S]*?\/>/,
  );

  it("found every fragment it is about", () => {
    for (const f of [MEASURE_FN, PANEL_USE, ADD_FN, ROW_DIMS]) expect(f).not.toBe("");
  });

  it("saves every capture change through the hook's queue path", () => {
    expect(TAB).toMatch(
      /const capture = useRoomCapture\(jobId, roomsQ\.data\?\.rooms \?\? \[\][,)]/,
    );
    expect(MEASURE_FN).toContain('capture.run({ op: "measure", roomId: r.id, patch }');
    expect(PANEL_USE).toContain("onOp={(op, label) => void capture.run(op, label)}");
  });

  it("sends the row's L × W × H boxes the same way, not straight to the table", () => {
    expect(ROW_DIMS).toContain("onSave={(v) => measure(r, { length_ft: v })}");
    expect(ROW_DIMS).toContain("onSave={(v) => measure(r, { width_ft: v })}");
    expect(ROW_DIMS).toContain("onSave={(v) => measure(r, { height_ft: v })}");
    expect(ROW_DIMS).not.toMatch(/patch\(r\.id, \{ (length|width|height)_ft/);
  });

  it("reads the add-room sizes with the tape parser — Number() stored NaN for 12'6\"", () => {
    expect(ADD_FN).toContain("parseFeet(t)");
    expect(ADD_FN).not.toMatch(/Number\((len|wid|hgt)\)/);
  });

  it("hands the panel the migration flags so it can hide what is not there yet", () => {
    expect(PANEL_USE).toContain("partsAvailable={capture.partsAvailable}");
    expect(PANEL_USE).toContain("columnsAvailable={captureColumnsAvailable}");
    expect(PANEL_USE).toContain("readOnly={app.writesDisabled}");
  });

  it("has one floor-area formula: the old length × width helper is gone", () => {
    expect(ROOMS).not.toMatch(/export function roomAreaSqft/);
    expect(TAB).not.toContain("roomAreaSqft");
    expect(TAB).toMatch(
      /const takeoff = jobTakeoff\(groups, capture\.openings, capture\.cabinets\);/,
    );
  });

  it("shows the job and unit takeoffs above the list", () => {
    const summary = pick(TAB, /<RoomTakeoffSummary[\s\S]*?\/>/);
    expect(summary).toContain("takeoff={takeoff}");
    expect(summary).toContain("multiUnit={multiUnit}");
  });
});

describe("the capture hook", () => {
  const RUN = pick(HOOK, /const run = useCallback\([\s\S]*?\n {2}\);\n/);

  it("found its fragment", () => expect(RUN).not.toBe(""));

  it("writes through writeOrQueue as a room_capture, replayed by the same raw write", () => {
    expect(RUN).toContain("writeOrQueue({");
    expect(RUN).toContain('kind: "room_capture"');
    expect(RUN).toContain("write: () => applyRoomCaptureOp(op)");
  });

  it("says a held change is held, never that it was saved", () => {
    expect(RUN).toMatch(/if \(res\.queued\) \{\s*toast\.warning\(HELD_TOAST/);
    expect(HOOK).toMatch(
      /const HELD_TOAST = "Held on this device — it saves when you have signal\.";/,
    );
  });
});

describe("the offline queue replays a capture", () => {
  it("knows the kind, names it, and dispatches it to the capture writer", () => {
    expect(QUEUE).toMatch(/\| "room_capture"[;\s]/);
    expect(QUEUE).toMatch(/room_capture: "Room measurement",/);
    const c = pick(QUEUE, /case "room_capture":[\s\S]*?break;/);
    expect(c).toContain("await applyRoomCaptureOp(p as unknown as RoomCaptureOp, supabase);");
  });
});

describe("built for a phone", () => {
  it("opens the number pad on every length box, at 48px", () => {
    const input = pick(FIELD, /<Input\s+ref=\{inputRef\}[\s\S]*?\/>/);
    expect(input).toContain('inputMode="decimal"');
    expect(input).toMatch(/"h-12 text-lg tabular-nums"/);
  });

  it("gives the iPhone number pad the ' and \" it does not have, without blurring the box", () => {
    const keys = pick(FIELD, /\{active && !readOnly && \([\s\S]*?\n {6}\)\}/);
    expect(keys).toContain("onPointerDown={(e) => e.preventDefault()}");
    expect(keys).toContain("onMouseDown={(e) => e.preventDefault()}");
    expect(keys).toContain("onClick={() => mark(m)}");
  });

  it("never pins a bar above the mobile nav inside the page", () => {
    for (const src of [TAB, PANEL, FIELD]) {
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        expect(m[1] ?? m[2]).not.toContain("above-mobile-nav");
      }
    }
  });

  it("uses steppers and two-tap removal rather than typed counts and confirm dialogs", () => {
    expect(PANEL).not.toMatch(/window\.confirm/);
    expect(PANEL).toMatch(/<Stepper\s+label="How many"/);
  });
});

describe("copy layout and export on the Rooms tab", () => {
  const COPY_FN = pick(TAB, /const copyLayout = async \([\s\S]*?\n {2}\};\n/);
  const ON_LANDED = pick(TAB, /onLanded: \(ops\) => \{[\s\S]*?\},/);
  const EXCEL = pick(TAB, /<ExportExcelButton[\s\S]*?\/>/);
  const CSV_FN = pick(TAB, /const exportCsv = \(\) =>[\s\S]*?\}\);\n/);
  const COPY_BUTTON = pick(
    TAB,
    /\{unitAvailable && g\.unit && g\.label && !app\.writesDisabled && \([\s\S]*?<\/Button>/,
  );

  it("found every fragment it is about", () => {
    for (const f of [COPY_FN, ON_LANDED, EXCEL, CSV_FN, COPY_BUTTON]) expect(f).not.toBe("");
  });

  it("copies through the same queue path, and makes folders for what landed", () => {
    expect(COPY_FN).toContain("await capture.run(p.op, p.label)");
    expect(COPY_FN).toContain("void followFolders();");
    // …and for a copy that was held and drained later.
    expect(ON_LANDED).toContain('ops.some((op) => op.op === "copy_layout")');
    expect(ON_LANDED).toContain("void followFolders()");
  });

  it("offers Copy layout only on a real unit, and not to a read-only session", () => {
    expect(COPY_BUTTON).toContain("setCopyFrom({ unit: g.unit!, label: g.label! })");
  });

  it("offers Excel and CSV through the export gate, from the takeoffs on screen", () => {
    expect(EXCEL).toContain("sheets={exportSheets");
    expect(EXCEL).toContain('surface="jobs"');
    expect(TAB).toMatch(
      /const exportSheets = takeoffSheets\(takeoff, capture\.openings, capture\.cabinets, exportOpts\);/,
    );
    expect(CSV_FN).toContain("exportGate.runExport(");
    expect(CSV_FN).toContain('format: "csv"');
    expect(CSV_FN).toContain("recordCount: takeoff.rooms.length");
    expect(TAB).toMatch(/\{exportGate\.allowed && \(\s*<Button[\s\S]*?onClick=\{exportCsv\}/);
  });
});
