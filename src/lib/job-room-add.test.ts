import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one way a room is added — the Rooms tab's add row and the drying log's
 * "+ Add room" (Mark, 7 Oct 2026: "add a way to add a room from here too")
 * both come here. Only the network is stubbed.
 */
const db = vi.hoisted(() => ({
  createJobRoom: vi.fn(),
  fetchJobRooms: vi.fn(),
  syncRoomFolders: vi.fn(),
  ensureJobAlbum: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("./job-rooms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./job-rooms")>()),
  createJobRoom: db.createJobRoom,
  fetchJobRooms: db.fetchJobRooms,
  syncRoomFolders: db.syncRoomFolders,
}));
vi.mock("./job-photos", () => ({ ensureJobAlbum: db.ensureJobAlbum }));
vi.mock("sonner", () => ({ toast: { warning: db.warning } }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { UNIT_PENDING, addJobRoom, followRoomFolders } from "./job-room-add";

const job = { id: "job-1", job_number: "J-100", address: "1 Main St", location_id: "loc-1" };
const synced = { created: 1, adopted: 0, updated: 0, heldBack: 0, skipped: 0 };

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  db.createJobRoom.mockResolvedValue({ id: "room-new", unitDropped: false });
  db.fetchJobRooms.mockResolvedValue({ rooms: [{ id: "room-new" }] });
  db.syncRoomFolders.mockResolvedValue(synced);
  db.ensureJobAlbum.mockResolvedValue("album-made");
});

describe("adding a room", () => {
  it("saves the row, refreshes every room list, files its photo folder and returns the room", async () => {
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const onFolders = vi.fn();
    const room = await addJobRoom({
      job,
      projectId: "album-1",
      userId: "me",
      queryClient: qc,
      room: { name: "  Kitchen ", unit: " 4B ", floor: "" },
      sortOrder: 30,
      onFolders,
    });

    expect(db.createJobRoom).toHaveBeenCalledWith({
      jobId: "job-1",
      unit: "4B",
      name: "Kitchen",
      floor: null,
      lengthFt: null,
      widthFt: null,
      heightFt: null,
      createdBy: "me",
      sortOrder: 30,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["job-rooms", "job-1"] });
    expect(room).toMatchObject({ id: "room-new", job_id: "job-1", name: "Kitchen", unit: "4B" });

    await flush();
    expect(db.ensureJobAlbum).not.toHaveBeenCalled();
    expect(db.syncRoomFolders).toHaveBeenCalledWith("album-1", [{ id: "room-new" }], "me");
    expect(onFolders).toHaveBeenCalledWith({ ok: true, result: synced });
  });

  it("makes the album first when the job has none, and tells the page", async () => {
    const onAlbumCreated = vi.fn();
    await addJobRoom({
      job,
      projectId: null,
      userId: "me",
      onAlbumCreated,
      queryClient: new QueryClient(),
      room: { name: "Basement", unit: null, floor: null },
      sortOrder: 0,
    });
    await flush();
    expect(db.ensureJobAlbum).toHaveBeenCalledWith(job, "me");
    expect(onAlbumCreated).toHaveBeenCalled();
    expect(db.syncRoomFolders).toHaveBeenCalledWith("album-made", expect.anything(), "me");
  });

  it("says when the unit had to be dropped, and returns the room the list will show", async () => {
    db.createJobRoom.mockResolvedValue({ id: "room-new", unitDropped: true });
    const room = await addJobRoom({
      job,
      projectId: "album-1",
      userId: "me",
      queryClient: new QueryClient(),
      room: { name: "Bedroom", unit: "4B", floor: null },
      sortOrder: 0,
    });
    expect(db.warning).toHaveBeenCalledWith(UNIT_PENDING);
    expect(room.unit).toBeNull();
  });

  it("throws the database's refusal, and refreshes nothing", async () => {
    const refused = { code: "42501", message: "new row violates row-level security policy" };
    db.createJobRoom.mockRejectedValue(refused);
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    await expect(
      addJobRoom({
        job,
        projectId: "album-1",
        userId: "crew",
        queryClient: qc,
        room: { name: "Kitchen", unit: null, floor: null },
        sortOrder: 0,
      }),
    ).rejects.toBe(refused);
    expect(invalidate).not.toHaveBeenCalled();
    expect(db.syncRoomFolders).not.toHaveBeenCalled();
  });

  it("refuses a blank name before it reaches the database", async () => {
    await expect(
      addJobRoom({
        job,
        projectId: "album-1",
        userId: "me",
        queryClient: new QueryClient(),
        room: { name: "   ", unit: null, floor: null },
        sortOrder: 0,
      }),
    ).rejects.toThrow("A room needs a name");
    expect(db.createJobRoom).not.toHaveBeenCalled();
  });

  it("does not fail the room when the folder cannot be made", async () => {
    db.syncRoomFolders.mockRejectedValue(new Error("No signal"));
    const onFolders = vi.fn();
    const room = await addJobRoom({
      job,
      projectId: "album-1",
      userId: "me",
      queryClient: new QueryClient(),
      room: { name: "Kitchen", unit: null, floor: null },
      sortOrder: 0,
      onFolders,
    });
    expect(room.id).toBe("room-new");
    await flush();
    expect(onFolders).toHaveBeenCalledWith({ ok: false, message: "No signal" });
  });
});

describe("following the folders on their own", () => {
  it("is the repair button's pass too", async () => {
    await expect(followRoomFolders({ job, projectId: "album-1", userId: "me" })).resolves.toEqual({
      ok: true,
      result: synced,
    });
  });
});
