import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

type MockChain = {
  insert: () => MockChain;
  upsert: () => MockChain;
  update: () => MockChain;
  eq: () => MockChain;
  then: (
    resolve: (value: { error: unknown }) => unknown,
    reject: (error: unknown) => unknown,
  ) => Promise<unknown>;
};

const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  session: { user: { id: "A", is_anonymous: false }, access_token: "token-A" } as {
    user: { id: string; is_anonymous: boolean };
    access_token: string;
  } | null,
  listener: undefined as undefined | (() => void),
  afterEntries: undefined as undefined | (() => void),
  afterSet: undefined as undefined | (() => void),
  afterRequest: undefined as undefined | (() => void),
  requests: [] as string[],
  responseErrors: [] as unknown[],
  sign: vi.fn(),
  finalize: vi.fn(),
}));
function switchTo(id: string | null, anonymous = false) {
  h.session = id ? { user: { id, is_anonymous: anonymous }, access_token: `token-${id}` } : null;
  h.listener?.();
}
vi.mock("idb-keyval", () => ({
  get: async (key: string) => h.store.get(key),
  set: async (key: string, value: unknown) => {
    // IndexedDB rejects functions and other non-cloneable values.
    h.store.set(key, structuredClone(value));
    h.afterSet?.();
  },
  del: async (key: string) => {
    h.store.delete(key);
  },
  entries: async () => {
    const entries = [...h.store.entries()];
    h.afterEntries?.();
    return entries;
  },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: h.session }, error: null }),
      onAuthStateChange: (listener: () => void) => {
        h.listener = listener;
      },
    },
  },
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, options: { accessToken: () => Promise<string> }) => {
    const chain: MockChain = {
      insert: () => chain,
      upsert: () => chain,
      update: () => chain,
      eq: () => chain,
      then: async (resolve, reject) => {
        try {
          const token = await options.accessToken();
          h.requests.push(token);
          h.afterRequest?.();
          return resolve({ error: h.responseErrors.shift() ?? null });
        } catch (error) {
          return reject(error);
        }
      },
    };
    return {
      from: () => chain,
      rpc: () => chain,
      storage: { from: () => ({ upload: () => chain }) },
    };
  },
}));
vi.mock("./photos.functions", () => ({ createPhotoUploadUrls: h.sign, finalizePhoto: h.finalize }));
import {
  enqueue,
  listQueue,
  drain,
  removeItem,
  retryItem,
  writeOrQueue,
  queueRecoveryStatus,
} from "./offline-queue";
import {
  enqueuePhoto,
  listQueue as listPhotos,
  uploadQueued,
  drainQueue,
  dequeuePhoto,
  updateQueueItem,
} from "./photos";

const task = {
  kind: "task_complete" as const,
  id: "same-id",
  label: "A private label",
  payload: { taskId: "task" },
};
const photo = {
  id: "photo",
  projectId: "shared-project",
  blob: new Blob(["unsent image"]),
  ext: "jpg",
  mime: "image/jpeg",
  capturedAt: null,
  exifLat: null,
  exifLon: null,
  exifRaw: {},
  width: 1,
  height: 1,
};
beforeEach(() => {
  h.store.clear();
  h.requests.length = 0;
  h.responseErrors.length = 0;
  h.afterEntries = h.afterSet = h.afterRequest = undefined;
  switchTo("A");
  h.sign.mockReset().mockResolvedValue({
    original: { signedUrl: "https://upload/orig" },
    display: { signedUrl: "https://upload/display" },
    thumb: { signedUrl: "https://upload/thumb" },
  });
  h.finalize.mockReset().mockResolvedValue({});
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 1, height: 1, close() {} }),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return { drawImage() {} };
      }
      async convertToBlob() {
        return new Blob(["variant"]);
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("sync queue account isolation", () => {
  it("hides A labels and cannot drain/delete/retry A work as B, even with the same id", async () => {
    await enqueue(task);
    switchTo("B");
    expect(await listQueue()).toEqual([]);
    await removeItem(task.id);
    await retryItem(task.id);
    expect(await drain()).toEqual({ sent: 0, failed: 0 });
    await enqueue({ ...task, label: "B label" });
    expect((await listQueue()).map((i) => i.label)).toEqual(["B label"]);
    expect(h.store.has("sync-queue:A:same-id")).toBe(true);
    await drain();
    expect(h.requests).toEqual(["token-B"]);
    switchTo("A");
    expect((await listQueue())[0].label).toBe(task.label);
  });
  it.each([null, "anonymous"])("fails closed for %s sessions", async (id) => {
    await enqueue(task);
    switchTo(id, !!id);
    await expect(enqueue(task)).rejects.toThrow("Sign in");
    expect(await listQueue()).toEqual([]);
    expect(await drain()).toEqual({ sent: 0, failed: 0 });
    expect(h.store.size).toBe(1);
    expect(h.requests).toEqual([]);
  });
  it("preserves legacy records and blobs without trusting payload userId", async () => {
    const legacy = { ...task, blob: new Blob(["voice"]), payload: { userId: "A" } };
    h.store.set("sync-queue:legacy", legacy);
    expect(await listQueue()).toEqual([]);
    await drain();
    await removeItem("legacy");
    await retryItem("legacy");
    expect(h.store.get("sync-queue:legacy")).toBe(legacy);
    expect(h.requests).toEqual([]);
  });
  it("returns no stale list when auth changes during IndexedDB enumeration", async () => {
    await enqueue(task);
    h.afterEntries = () => switchTo("B");
    expect(await listQueue()).toEqual([]);
  });
  it("keeps the initiating owner when auth changes during persistence", async () => {
    h.afterSet = () => switchTo("B");
    await enqueue(task);
    h.afterSet = undefined;
    expect(h.store.get("sync-queue:A:same-id")).toMatchObject({ ownerId: "A" });
    expect(await listQueue()).toEqual([]);
  });
  it("stops before dispatch when auth changes while marking sending", async () => {
    await enqueue(task);
    h.afterSet = () => switchTo("B");
    await drain();
    expect(h.requests).toEqual([]);
    expect(h.store.has("sync-queue:A:same-id")).toBe(true);
  });
  it("never sends the second voice-memo request with B credentials", async () => {
    await enqueue({
      ...task,
      kind: "voice_memo",
      blob: new Blob(["audio"]),
      payload: { userId: "A" },
    });
    h.afterRequest = () => switchTo("B");
    await drain();
    expect(h.requests).toEqual(["token-A"]);
    expect(h.store.has("sync-queue:A:same-id")).toBe(true);
  });
  it("detects A to B to A during an await", async () => {
    await enqueue(task);
    h.afterEntries = () => {
      switchTo("B");
      switchTo("A");
    };
    expect(await listQueue()).toEqual([]);
  });
  it("retains first-online work as A and never invokes the singleton callback", async () => {
    const write = vi.fn();
    h.afterSet = () => switchTo("B");
    expect(await writeOrQueue({ ...task, write })).toEqual({ queued: true });
    expect(write).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
    expect(h.store.get("sync-queue:A:same-id")).toMatchObject({ ownerId: "A" });
  });
});

describe("legacy recovery notice", () => {
  it("reports preserved counts without disclosing labels, ids, payloads or blobs", async () => {
    h.store.set("sync-queue:legacy", { ...task, blob: new Blob(["private"]) });
    h.store.set("photo-queue:legacy", photo);
    await enqueue(task);
    switchTo("B");
    const status = await queueRecoveryStatus();
    expect(status).toMatchObject({ syncItems: 1, photos: 1 });
    expect(status.message).toContain("Do not clear");
    expect(JSON.stringify(status)).not.toContain(task.label);
    expect(h.store.size).toBe(3);
    expect(await listQueue()).toEqual([]);
  });
});

const complexKinds = [
  "field_work_ticket",
  "drying_reading",
  "equipment_place",
  "equipment_retrieve",
  "tradeshow_lead",
] as const;
function complexCapture(kind: (typeof complexKinds)[number]) {
  const payload =
    kind === "tradeshow_lead"
      ? {
          accountId: "account",
          contactId: "contact",
          touchpointId: "touchpoint",
          photoMediaId: "media",
          tradeshowId: "show",
          userId: "A",
          tradeshowName: "Show",
          locationId: "location",
          name: "Rep",
          company: "Company",
          phone: "",
          email: "",
          notes: "captured note",
          capturedAt: "2026-09-01T11:00:00.000Z",
          photo: { mime: "image/jpeg", width: 1, height: 1, sizeBytes: 5, hasThumb: true },
        }
      : kind === "drying_reading"
        ? {
            job_id: "job",
            captured_by: "A",
            photo_path: "A/job/reading.jpg",
            photo_thumb_path: "A/job/thumb.webp",
            temperature_f: 70,
            relative_humidity: 50,
          }
        : kind === "equipment_retrieve"
          ? { placementId: "placement", userId: "A", condition: "good" }
          : kind === "equipment_place"
            ? { id: "placement", equipment_id: "equipment", job_id: "job", placed_by: "A" }
            : { job_id: "job", work_date: "2026-09-01", created_by: "A" };
  return {
    ...task,
    kind,
    payload,
    blobs: {
      photo: { blob: new Blob(["photo"]), mime: "image/jpeg" },
      thumb: { blob: new Blob(["thumb"]), mime: "image/webp" },
    },
  };
}
describe("complex capture replay", () => {
  it.each(complexKinds)("successfully syncs %s under the original account", async (kind) => {
    await enqueue(complexCapture(kind));
    expect(await drain()).toEqual({ sent: 1, failed: 0 });
    expect(h.requests.length).toBe(
      {
        field_work_ticket: 1,
        drying_reading: 4,
        equipment_place: 1,
        equipment_retrieve: 1,
        // account RPC, capture-review state, contact, photo + thumb uploads,
        // media row, touchpoint — every one of them under A's token.
        tradeshow_lead: 7,
      }[kind],
    );
    expect(new Set(h.requests)).toEqual(new Set(["token-A"]));
    expect(h.store.size).toBe(0);
  });
  it.each(complexKinds)("never replays %s as B and resumes when A returns", async (kind) => {
    await enqueue(complexCapture(kind));
    switchTo("B");
    expect(await drain()).toEqual({ sent: 0, failed: 0 });
    expect(h.requests).toEqual([]);
    switchTo("A");
    expect(await drain()).toEqual({ sent: 1, failed: 0 });
  });
  it.each(["drying_reading", "tradeshow_lead"] as const)(
    "stops %s media steps after a mid-flight switch",
    async (kind) => {
      await enqueue(complexCapture(kind));
      h.afterRequest = () => switchTo("B");
      expect(await drain()).toEqual({ sent: 0, failed: 1 });
      expect(h.requests).toEqual(["token-A"]);
      expect(h.store.size).toBe(1);
      h.afterRequest = undefined;
      switchTo("A");
      expect(await drain()).toEqual({ sent: 1, failed: 0 });
      expect(h.store.size).toBe(0);
    },
  );
});

describe("nested upload and retry boundaries", () => {
  it.each(["drying_reading", "tradeshow_lead"] as const)(
    "stops %s after an upload changes auth",
    async (kind) => {
      await enqueue(complexCapture(kind));
      h.afterRequest = () => {
        if (h.requests.length === (kind === "drying_reading" ? 2 : 3)) switchTo("B");
      };
      expect(await drain()).toEqual({ sent: 0, failed: 1 });
      expect(h.requests.every((token) => token === "token-A")).toBe(true);
      expect(h.store.size).toBe(1);
    },
  );
  it.each(["field_work_ticket", "drying_reading"] as const)(
    "pins %s schema fallback retries",
    async (kind) => {
      const capture = complexCapture(kind);
      await enqueue({ ...capture, payload: { ...capture.payload, equipment_left_tags: ["tag"] } });
      h.responseErrors.push({ code: "PGRST204", message: "column not in schema cache" });
      expect(await drain()).toEqual({ sent: 1, failed: 0 });
      expect(h.requests.length).toBe(kind === "field_work_ticket" ? 2 : 5);
      expect(new Set(h.requests)).toEqual(new Set(["token-A"]));
    },
  );
});

describe("additional replay boundaries", () => {
  it("pins ownerless job_field payloads to the enqueue session", async () => {
    await enqueue({
      ...task,
      kind: "job_field",
      payload: { jobId: "shared-job", patch: { name: "private change" } },
    });
    switchTo("B");
    await drain();
    expect(h.requests).toEqual([]);
    switchTo("A");
    await drain();
    expect(h.requests).toEqual(["token-A"]);
  });
  it("stops subsequent queue items after an in-flight request changes auth", async () => {
    await enqueue(task);
    await enqueue({ ...task, id: "second" });
    h.afterRequest = () => switchTo("B");
    await drain();
    expect(h.requests).toEqual(["token-A"]);
    expect(h.store.size).toBe(2);
  });
  it("cannot reattribute photos through the public update API", async () => {
    await enqueuePhoto(photo);
    await updateQueueItem(photo.id, { ownerId: "B", id: "other" });
    expect(h.store.get("photo-queue:A:photo")).toMatchObject({ ownerId: "A", id: "photo" });
    switchTo("B");
    expect(await listPhotos()).toEqual([]);
  });
  it("retains the original after auth changes during finalization", async () => {
    await enqueuePhoto(photo);
    const [a] = await listPhotos();
    h.finalize.mockImplementationOnce(async () => {
      switchTo("B");
    });
    await expect(uploadQueued(a)).rejects.toThrow("Account changed");
    expect(h.finalize.mock.calls[0][0].headers.Authorization).toBe("Bearer token-A");
    expect(h.store.has("photo-queue:A:photo")).toBe(true);
  });
});

describe("photo queue account isolation", () => {
  it("isolates users even on the same project and rejects direct A uploads as B", async () => {
    await enqueuePhoto(photo);
    const [a] = await listPhotos();
    switchTo("B");
    expect(await listPhotos(photo.projectId)).toEqual([]);
    await dequeuePhoto(photo.id);
    await updateQueueItem(photo.id, { ownerId: "B" });
    await drainQueue(photo.projectId);
    await expect(uploadQueued(a)).rejects.toThrow("owner mismatch");
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.store.has("photo-queue:A:photo")).toBe(true);
  });
  it.each([null, "anonymous"])("does not expose or accept photos with %s session", async (id) => {
    await enqueuePhoto(photo);
    switchTo(id, !!id);
    expect(await listPhotos()).toEqual([]);
    await expect(enqueuePhoto(photo)).rejects.toThrow("Sign in");
    await drainQueue(photo.projectId);
    expect(h.sign).not.toHaveBeenCalled();
  });
  it("preserves unattributed originals without migrating them to the current user", async () => {
    h.store.set("photo-queue:photo", photo);
    expect(await listPhotos()).toEqual([]);
    await drainQueue(photo.projectId);
    await dequeuePhoto(photo.id);
    expect(h.store.get("photo-queue:photo")).toBe(photo);
  });
  it("suppresses stale photo lists after account switch", async () => {
    await enqueuePhoto(photo);
    h.afterEntries = () => switchTo("B");
    expect(await listPhotos()).toEqual([]);
  });
  it("stops before signing if account changes during image processing", async () => {
    await enqueuePhoto(photo);
    const [a] = await listPhotos();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn().mockImplementation(async () => {
        switchTo("B");
        return { width: 1, height: 1, close() {} };
      }),
    );
    await expect(uploadQueued(a)).rejects.toThrow("Account changed");
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.store.has("photo-queue:A:photo")).toBe(true);
  });
  it("pins signing bearer and stops before PUT after a switch", async () => {
    await enqueuePhoto(photo);
    const [a] = await listPhotos();
    h.sign.mockImplementationOnce(async () => {
      switchTo("B");
      return {};
    });
    await expect(uploadQueued(a)).rejects.toThrow("Account changed");
    expect(h.sign.mock.calls[0][0].headers.Authorization).toBe("Bearer token-A");
    expect(fetch).not.toHaveBeenCalled();
    expect(h.finalize).not.toHaveBeenCalled();
  });
  it("stops before finalization after account changes during PUT", async () => {
    await enqueuePhoto(photo);
    const [a] = await listPhotos();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        switchTo("B");
        return { ok: true };
      }),
    );
    await expect(uploadQueued(a)).rejects.toThrow("Account changed");
    expect(h.finalize).not.toHaveBeenCalled();
    expect(h.store.has("photo-queue:A:photo")).toBe(true);
  });
  it("uses the original bearer for finalization and removes only the successful owned capture", async () => {
    await enqueuePhoto(photo);
    const [a] = await listPhotos();
    await uploadQueued(a);
    expect(h.finalize.mock.calls[0][0].headers.Authorization).toBe("Bearer token-A");
    expect(h.store.size).toBe(0);
  });
});
