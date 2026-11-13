// "+ Add room" on the drying log. Mark, 7 Oct 2026: "add a way to add a room
// from here too." The picker and the add path are tested on their own
// (drying-room-select.render.test.tsx, job-room-add.test.ts); these pin that
// the drying log, the Rooms tab and the job page are wired to them. Each check
// pulls one fragment out of the source and asserts on that alone.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const pick = (src: string, re: RegExp) => re.exec(src)?.[0] ?? "";

const LOG = read("src/components/job-drying-log.tsx");
const TAB = read("src/components/job-rooms-tab.tsx");
const PAGE = read("src/routes/_authenticated/jobs.$id.tsx");

const CAN_ADD = pick(LOG, /const canAddRoom = [^;]*;/);
const ADD_ROOM = pick(LOG, /const addRoom = async \([\s\S]*?\n {2}\};\n/);
const PICKER = pick(LOG, /<DryingRoomSelect\b[\s\S]*?\/>/);
const TAB_ADD = pick(TAB, /const add = async \(\) => \{[\s\S]*?\n {2}\};\n/);
const MOUNT = pick(PAGE, /<JobDryingLog\b[^>]*?\/>/);

describe("the drying log's + Add room", () => {
  it("found every fragment it is about", () => {
    for (const f of [CAN_ADD, ADD_ROOM, PICKER, TAB_ADD, MOUNT]) expect(f).not.toBe("");
  });

  it("is shown only to someone can_manage_job lets in, on a day writes are open", () => {
    expect(LOG).toContain("const canManageJob = useCanManageJob(jobId);");
    expect(CAN_ADD).toContain("canManageJob === true");
    expect(CAN_ADD).toContain("!app.writesDisabled");
    expect(PICKER).toContain("canAddRoom={canAddRoom}");
  });

  it("is the room picker for every reading that names a room", () => {
    // One picker in the reading card, used for each ROOM_POINTS reading.
    expect(LOG.match(/<DryingRoomSelect\b/g)).toHaveLength(1);
    expect(PICKER).toContain("onAddRoom={addRoom}");
    expect(PICKER).toContain("onChoose={(choice) => patch(r.key, choice)}");
  });

  it("adds the room through the Rooms tab's own path, and says a refusal", () => {
    expect(ADD_ROOM).toContain("await addJobRoom({");
    expect(ADD_ROOM).toContain("queryClient: qc,");
    expect(ADD_ROOM).toContain('toastDbError(e, { action: "Adding room" });');
    expect(TAB_ADD).toContain("await addJobRoom({");
    expect(TAB_ADD).toContain('toastDbError(e, { action: "Adding room" });');
    // No second insert anywhere on the drying log.
    expect(LOG).not.toMatch(/from\("job_rooms"\)/);
    expect(LOG).not.toContain("createJobRoom");
  });

  it("is given the album the Rooms tab is given, so the room gets its photo folder", () => {
    expect(MOUNT).toContain("album={{ job, projectId, onAlbumCreated: refetchAlbum }}");
    const tab = pick(PAGE, /<JobRoomsTab[\s\S]*?\/>/);
    expect(tab).toContain("job={job}");
    expect(tab).toContain("projectId={projectId}");
  });

  it("asks can_manage_job through the one hook the job header uses too", () => {
    expect(PAGE).toContain("const canManageJob = useCanManageJob(id);");
    expect(PAGE).not.toContain('rpc("can_manage_job"');
  });
});

describe("the add form on a phone", () => {
  const SRC = read("src/components/drying-room-select.tsx");
  const CONTENT = pick(SRC, /<DialogContent className="([^"]*)"/);
  const FOOTER = pick(SRC, /<DialogFooter className="([^"]*)"/);

  it("sits at the top of a phone screen, so the keyboard rises under it", () => {
    expect(CONTENT).toContain("max-sm:top-3");
    expect(CONTENT).toContain("max-sm:translate-y-0");
    expect(CONTENT).toContain("max-w-[calc(100vw-1.5rem)]");
    expect(CONTENT).toContain("flex-col");
  });

  it("pins Save to the dialog's foot, as #288 did for the field dialogs", () => {
    expect(FOOTER).toContain("sticky -bottom-6");
    expect(FOOTER).toContain("flex-row");
  });

  it("gives every control a 44px target", () => {
    const save = pick(SRC, /<Button\s+type="submit"\s+className="([^"]*)"/);
    const cancel = pick(SRC, /<Button\s+type="button"\s+variant="ghost"\s+className="([^"]*)"/);
    expect(save).toContain("h-11");
    expect(cancel).toContain("h-11");
    const inputs = [...SRC.matchAll(/<Input\s[\s\S]*?\/>/g)].map((m) => m[0]);
    expect(inputs).toHaveLength(3);
    for (const i of inputs) expect(i).toContain('className="h-11"');
    const entry = pick(SRC, /<SelectItem value=\{ADD_ROOM\} className="([^"]*)"/);
    expect(entry).toContain("min-h-11");
  });

  it("leaves autofill alone", () => {
    expect(SRC).not.toMatch(/autoComplete=/);
  });
});
