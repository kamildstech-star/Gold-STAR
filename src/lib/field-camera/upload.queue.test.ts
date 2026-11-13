/**
 * A Field Camera shot goes through the SAME queue as a Pictures-tab upload —
 * `enqueuePhoto` into IndexedDB, then `drainQueue` → signed upload →
 * `finalizePhoto` — with its capture record riding in `exif_raw`, its device
 * time and GPS in the row's own columns, and its folder, tag and note applied
 * once the row exists. The real photo queue runs here end to end; only the
 * storage, the network and the database are fakes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => void store.set(k, v),
  del: async (k: string) => void store.delete(k),
  entries: async () => [...store.entries()],
}));

/** Writes made through the singleton client (review-strip delete / note). */
const direct: { table: string; op: string; row: unknown; filter?: unknown }[] = [];
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: async () => ({
        data: { session: { user: { id: "u1" }, access_token: ["session", "a"].join("-") } },
        error: null,
      }),
    },
    from: (table: string) => ({
      update: (row: unknown) => ({
        eq: async (_c: string, v: unknown) => {
          direct.push({ table, op: "update", row, filter: v });
          return { error: null };
        },
      }),
      upsert: async (row: unknown) => {
        direct.push({ table, op: "upsert", row });
        return { error: null };
      },
    }),
  },
}));

/** Writes made through the queue's own scoped client after finalize. */
const scoped: { table: string; op: string; row: unknown }[] = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        update: (row: unknown) => {
          scoped.push({ table, op: "update", row });
          return chain;
        },
        upsert: async (row: unknown) => {
          scoped.push({ table, op: "upsert", row });
          return { error: null };
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      return chain;
    },
  }),
}));

const finalized: Record<string, unknown>[] = [];
vi.mock("@/lib/photos.functions", () => ({
  createPhotoUploadUrls: async ({ data }: { data: { photoId: string } }) => {
    const t = (k: string) => ({
      path: k,
      token: null,
      signedUrl: `https://x/${k}/${data.photoId}`,
      alreadyStored: false,
    });
    return { original: t("orig"), display: t("disp"), thumb: t("thumb") };
  },
  finalizePhoto: async ({ data }: { data: Record<string, unknown> }) => {
    finalized.push(data);
    return { ok: true as const, photoId: data["photoId"] };
  },
}));

import { listQueue, type QueuedPhoto } from "@/lib/photos";
import {
  FIELD_CAMERA_SOURCE,
  captureRecord,
  discardShot,
  isFieldCameraRaw,
  queueFieldShot,
  setShotNote,
  shotStatus,
  type FieldCaptureMeta,
} from "./upload";

const JOB = {
  id: "11111111-1111-4111-8111-111111111111",
  job_number: "24-1032",
  address: "314 Troy Ave, Brooklyn, NY 11213",
  job_name: "Newark",
  location_id: "loc-1",
};
const ALBUM = "22222222-2222-4222-8222-222222222222";

const META: FieldCaptureMeta = {
  v: 1,
  taken_at: "2026-10-14T18:04:00.000Z",
  time_zone: "America/New_York",
  utc_offset_min: -240,
  lat: 40.67123,
  lon: -73.93841,
  accuracy_m: 8,
  fix_age_s: 3,
  address: "314 Troy Ave, Brooklyn, NY 11213",
  address_source: "device",
  job_id: JOB.id,
  job_number: JOB.job_number,
  room_id: "room-kitchen",
  folder_id: "folder-kitchen",
  tag_ids: ["tag-airbnb"],
  note: "Ceiling stain",
  user_id: "u1",
  crew_name: "Dov Levin",
  facing: "environment",
  zoom: 1,
  stamp_fields: ["time", "date", "address", "job", "crew", "note"],
  width: 3024,
  height: 4032,
};

beforeEach(() => {
  store.clear();
  direct.length = 0;
  scoped.length = 0;
  finalized.length = 0;
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("createImageBitmap", async () => ({ width: 3024, height: 4032, close: () => {} }));
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return { drawImage: () => {} };
      }
      async convertToBlob() {
        return new Blob([new Uint8Array(8)], { type: "image/webp" });
      }
    },
  );
  vi.stubGlobal("XMLHttpRequest", undefined);
  vi.stubGlobal(
    "fetch",
    async () => ({ ok: true, status: 200, text: async () => "" }) as unknown as Response,
  );
});

const blob = () => new Blob([new Uint8Array(256)], { type: "image/jpeg" });

describe("a Field Camera shot through the shared photo queue", () => {
  it("is held in the photo queue with its capture record before anything is sent", async () => {
    // Offline: the drain finds nothing to do until signal returns, the item waits.
    vi.stubGlobal("fetch", async () => {
      throw new Error("Upload failed — no connection.");
    });
    const albumFor = vi.fn(async () => ALBUM);
    const landed = new Promise<void>(
      (resolve) =>
        void queueFieldShot({
          job: JOB,
          userId: "u1",
          blob: blob(),
          meta: META,
          folderId: "folder-kitchen",
          tagIds: ["tag-airbnb"],
          note: "Ceiling stain",
          albumFor,
          onLanded: resolve,
        }),
    );
    await landed;
    expect(albumFor).toHaveBeenCalledWith(JOB, "u1");
    const [held] = (await listQueue(ALBUM)) as QueuedPhoto[];
    expect(held).toBeDefined();
    expect(held!.projectId).toBe(ALBUM);
    expect(held!.mime).toBe("image/jpeg");
    expect(held!.capturedAt).toBe(META.taken_at);
    expect([held!.exifLat, held!.exifLon]).toEqual([40.67123, -73.93841]);
    expect(held!.exifRaw).toEqual({ source: FIELD_CAMERA_SOURCE, field_camera: META });
    expect(held!.folderId).toBe("folder-kitchen");
    expect(held!.tagIds).toEqual(["tag-airbnb"]);
    expect(held!.caption).toBe("Ceiling stain");
    expect(held!.captionId).toBeTruthy();
    // Still on the phone, marked to retry — not lost.
    expect(held!.status).toBe("error");
    expect(finalized).toHaveLength(0);
  });

  it("lands like any photo: finalizePhoto carries the record, then folder, tag and caption", async () => {
    let shot: Awaited<ReturnType<typeof queueFieldShot>> | null = null;
    await new Promise<void>((resolve) => {
      void queueFieldShot({
        job: JOB,
        userId: "u1",
        blob: blob(),
        meta: META,
        folderId: "folder-kitchen",
        tagIds: ["tag-airbnb"],
        note: "Ceiling stain",
        albumFor: async () => ALBUM,
        onLanded: resolve,
      }).then((s) => (shot = s));
    });
    expect(await listQueue(ALBUM)).toHaveLength(0);
    expect(finalized).toHaveLength(1);
    const f = finalized[0]!;
    expect(f["projectId"]).toBe(ALBUM);
    expect(f["photoId"]).toBe(shot!.photoId);
    expect(f["capturedAt"]).toBe(META.taken_at);
    expect(f["exifLat"]).toBe(40.67123);
    expect(f["exifRaw"]).toEqual(captureRecord(META));
    expect(isFieldCameraRaw(f["exifRaw"])).toBe(true);

    expect(scoped).toContainEqual({
      table: "photos",
      op: "update",
      row: { folder_id: "folder-kitchen" },
    });
    expect(scoped).toContainEqual({
      table: "photo_tags",
      op: "upsert",
      row: [{ photo_id: shot!.photoId, tag_id: "tag-airbnb", created_by: "u1" }],
    });
    const caption = scoped.find((w) => w.table === "photo_comments")!;
    expect(caption.row).toMatchObject({
      id: shot!.captionId,
      photo_id: shot!.photoId,
      body: "Ceiling stain",
      author_id: "u1",
    });
  });

  it("a note edited while the shot is still on the phone rides with the queued item", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    let shot: Awaited<ReturnType<typeof queueFieldShot>> | null = null;
    await new Promise<void>((resolve) => {
      void queueFieldShot({
        job: JOB,
        userId: "u1",
        blob: blob(),
        meta: { ...META, note: null },
        folderId: null,
        tagIds: [],
        note: null,
        albumFor: async () => ALBUM,
        onLanded: resolve,
      }).then((s) => (shot = s));
    });
    const res = await setShotNote(shot!, "Mold behind baseboard", "u1");
    const [held] = await listQueue(ALBUM);
    expect(held!.caption).toBe("Mold behind baseboard");
    expect(held!.captionId).toBe(res.captionId);
    expect(direct).toHaveLength(0);
  });

  it("deleting a shot still on the phone drops it from the queue; nothing is sent", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    let shot: Awaited<ReturnType<typeof queueFieldShot>> | null = null;
    await new Promise<void>((resolve) => {
      void queueFieldShot({
        job: JOB,
        userId: "u1",
        blob: blob(),
        meta: META,
        folderId: null,
        tagIds: [],
        note: null,
        albumFor: async () => ALBUM,
        onLanded: resolve,
      }).then((s) => (shot = s));
    });
    expect(await discardShot(shot!, "u1")).toEqual({ pending: false });
    expect(await listQueue(ALBUM)).toHaveLength(0);
    expect(direct).toHaveLength(0);
  });

  it("deleting a landed shot soft-deletes the row, like the Pictures tab", async () => {
    const res = await discardShot({ photoId: "01HZZZ", projectId: ALBUM, captionId: null }, "u1");
    expect(res.pending).toBe(false);
    expect(direct[0]).toMatchObject({
      table: "photos",
      op: "update",
      filter: "01HZZZ",
      row: { deleted_by: "u1", deleted_reason: "Discarded in the Field Camera review" },
    });
  });
});

describe("shot status", () => {
  it("reads the queue: in flight, failed, waiting, or gone (uploaded)", () => {
    const pending = [
      { id: "a", status: "uploading" },
      { id: "b", status: "error" },
      { id: "c", status: "queued" },
    ];
    expect(shotStatus("a", pending, { a: 0.4 })).toBe("uploading");
    expect(shotStatus("b", pending, {})).toBe("failed");
    expect(shotStatus("c", pending, {})).toBe("queued");
    expect(shotStatus("d", pending, {})).toBe("uploaded");
  });

  it("only a field_camera record counts as verified", () => {
    expect(isFieldCameraRaw({ source: "field_camera" })).toBe(true);
    expect(isFieldCameraRaw({ Make: "Apple" })).toBe(false);
    expect(isFieldCameraRaw(null)).toBe(false);
  });
});
