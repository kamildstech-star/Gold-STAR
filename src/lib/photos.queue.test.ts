/**
 * What the photo queue has to be right about.
 *
 * Mark, with a screenshot of three rows reading "Photo (full resolution) —
 * Uploading… · captured 4h ago": "these are stuck uploading". They were. An
 * attempt the app was killed in the middle of stayed marked "uploading", and
 * every later drain filtered exactly that status out, so nothing ever picked
 * them up again. The same incident is why his job's album read 179 when he had
 * uploaded 182.
 *
 * The rules below are the fix, and the second one is as important as the
 * first: reclaiming has to rescue a dead attempt without stealing a live one.
 *
 * Every clock here is passed in. A fixture that pins a date and then calls a
 * function defaulting to `Date.now()` ages with the real calendar until it
 * crosses a threshold — that took main red on 24 September.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() }),
}));

/* ------------------------------------------------------------------ */
/* An IndexedDB that is a Map                                          */
/* ------------------------------------------------------------------ */

const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => void store.set(k, v),
  del: async (k: string) => void store.delete(k),
  entries: async () => [...store.entries()],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: async () => ({
        data: { session: { user: { id: "u1" }, access_token: "token-a" } },
        error: null,
      }),
    },
  },
}));

/** Photo ids the fake server already holds, so a repeat attempt can be told. */
const onServer = new Set<string>();
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      let wanted = "";
      const chain = {
        select: () => chain,
        eq: (_c: string, v: string) => {
          wanted = v;
          return chain;
        },
        is: () => chain,
        maybeSingle: async () => ({
          data: onServer.has(wanted) ? { id: wanted } : null,
          error: null,
        }),
        update: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
      };
      return chain;
    },
  }),
}));

/** Every upload the fake network was asked to perform, in order. */
const uploaded: string[] = [];
let uploadFails = 0;
/**
 * Photo ids whose three storage objects an earlier attempt already wrote. The
 * real `createPhotoUploadUrls` answers those with `alreadyStored` instead of a
 * URL — that half is proved against the real storage client in
 * photos.functions.security.test.ts; this file proves what the queue does next.
 */
const storedObjects = new Set<string>();
/** Every PUT the fake network received, by URL. */
const puts: string[] = [];
/** What the next PUTs answer with instead of 200, for the race case. */
let putAnswers: { status: number; body: string }[] = [];
vi.mock("@/lib/photos.functions", () => ({
  createPhotoUploadUrls: async ({ data }: { data: { photoId: string } }) => {
    const target = (kind: string) =>
      storedObjects.has(data.photoId)
        ? { path: kind, token: null, signedUrl: null, alreadyStored: true }
        : {
            path: kind,
            token: "t",
            signedUrl: `https://x/${kind}/${data.photoId}`,
            alreadyStored: false,
          };
    return { original: target("orig"), display: target("disp"), thumb: target("thumb") };
  },
  finalizePhoto: async ({ data }: { data: { photoId: string } }) => {
    uploaded.push(data.photoId);
    onServer.add(data.photoId);
    return { ok: true as const, photoId: data.photoId };
  },
}));

import {
  MAX_UPLOAD_ATTEMPTS,
  STARTUP_STALE_MS,
  UPLOADING_STALE_MS,
  drainQueue,
  drainableNow,
  hasBeenAttempted,
  isAlreadyStoredRejection,
  isStalledUpload,
  listQueue,
  photoStateLabel,
  pickImageFiles,
  reclaimStalledUploads,
  retryPhoto,
  type QueuedPhoto,
} from "@/lib/photos";

/* ------------------------------------------------------------------ */

const KEY = (id: string) => `photo-queue:u1:${id}`;

function held(id: string, patch: Partial<QueuedPhoto> = {}): QueuedPhoto {
  const item: QueuedPhoto = {
    id,
    ownerId: "u1",
    projectId: "proj-1",
    blob: new Blob([new Uint8Array(16)], { type: "image/jpeg" }),
    ext: "jpg",
    mime: "image/jpeg",
    capturedAt: null,
    exifLat: null,
    exifLon: null,
    exifRaw: {},
    width: 0,
    height: 0,
    createdAt: 1_000,
    status: "queued",
    attempts: 0,
    ...patch,
  };
  store.set(KEY(id), item);
  return item;
}

/** A clock the tests own outright; nothing below reads the wall. */
const NOW = 10_000_000;

beforeEach(() => {
  store.clear();
  onServer.clear();
  uploaded.length = 0;
  uploadFails = 0;
  vi.stubGlobal("navigator", { onLine: true });
  // No canvas and no XHR in node, so the variant encoder and the uploader get
  // the smallest stand-ins that let the real orchestration run end to end.
  vi.stubGlobal("createImageBitmap", async () => ({ width: 120, height: 90, close: () => {} }));
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
  storedObjects.clear();
  puts.length = 0;
  putAnswers = [];
  vi.stubGlobal("fetch", async (url: string) => {
    puts.push(String(url));
    if (uploadFails > 0) {
      uploadFails -= 1;
      throw new Error("Upload failed — no connection.");
    }
    const answer = putAnswers.shift();
    if (answer) {
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        text: async () => answer.body,
      } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => "" } as unknown as Response;
  });
});

/* ------------------------------------------------------------------ */

describe("an attempt the app was killed in the middle of", () => {
  it("is reclaimed once it is old enough to be dead", () => {
    const item = held("a", { status: "uploading", uploadingSince: NOW - UPLOADING_STALE_MS - 1 });
    expect(isStalledUpload(item, NOW)).toBe(true);
  });

  it("is left alone while it could still be a live upload elsewhere", () => {
    const item = held("a", { status: "uploading", uploadingSince: NOW - 30_000 });
    expect(isStalledUpload(item, NOW)).toBe(false);
  });

  it("counts as long ago when it predates the stamp — which is Mark's three", () => {
    // Written by the build that had no `uploadingSince` at all.
    const item = held("a", { status: "uploading" });
    expect(isStalledUpload(item, NOW)).toBe(true);
    expect(isStalledUpload(item, NOW, STARTUP_STALE_MS)).toBe(true);
  });

  it("is what every later drain used to skip, and now picks up", () => {
    const stale = held("a", { status: "uploading", uploadingSince: NOW - UPLOADING_STALE_MS - 1 });
    const live = held("b", { status: "uploading", uploadingSince: NOW - 1_000 });
    const waiting = held("c");
    expect(drainableNow([stale, live, waiting], NOW).map((i) => i.id)).toEqual(["a", "c"]);
  });
});

describe("reclaiming", () => {
  it("puts a stranded photo back in the queue", async () => {
    held("a", { status: "uploading", uploadingSince: NOW - UPLOADING_STALE_MS - 1 });
    expect(await reclaimStalledUploads({ now: NOW })).toBe(1);
    expect((await listQueue())[0]).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("does not touch an attempt inside the window", async () => {
    held("a", { status: "uploading", uploadingSince: NOW - 10_000 });
    expect(await reclaimStalledUploads({ now: NOW })).toBe(0);
    expect((await listQueue())[0]).toMatchObject({ status: "uploading", attempts: 0 });
  });

  it("gives up rather than reclaiming the same photo forever", async () => {
    held("a", {
      status: "uploading",
      uploadingSince: NOW - UPLOADING_STALE_MS - 1,
      attempts: MAX_UPLOAD_ATTEMPTS - 1,
    });
    await reclaimStalledUploads({ now: NOW });
    const item = (await listQueue())[0]!;
    expect(item.status).toBe("rejected");
    expect(item.errorMessage).toMatch(/Gave up after \d+ attempts/);
  });

  it("leaves a terminal photo out of an ordinary drain and in a deliberate one", () => {
    const dead = held("a", { status: "rejected", attempts: MAX_UPLOAD_ATTEMPTS });
    expect(drainableNow([dead], NOW)).toEqual([]);
    expect(drainableNow([dead], NOW, { includeRejected: true })).toEqual([dead]);
  });
});

describe("a reclaimed photo that in fact reached the server", () => {
  it("is dropped rather than uploaded a second time", async () => {
    held("a", { status: "uploading", uploadingSince: NOW - UPLOADING_STALE_MS - 1, attempts: 1 });
    // The upload and finalize both landed; the phone died before the queue
    // entry was deleted. That is the one way this fix could make things worse.
    onServer.add("a");

    await reclaimStalledUploads({ now: NOW });
    await drainQueue("proj-1", 3, { now: NOW });

    expect(uploaded).toEqual([]);
    expect(await listQueue()).toEqual([]);
  });

  it("is still uploaded when the server has never seen it", async () => {
    held("a", { status: "uploading", uploadingSince: NOW - UPLOADING_STALE_MS - 1, attempts: 1 });

    await reclaimStalledUploads({ now: NOW });
    await drainQueue("proj-1", 3, { now: NOW });

    expect(uploaded).toEqual(["a"]);
    expect(await listQueue()).toEqual([]);
  });
});

/*
 * Mark, with a screenshot of the sheet: "why is this stuck". The 182nd photo
 * from 5 October: "Stopped — needs attention · 8 attempts — Gave up after 8
 * attempts. Last error: The resource already exists". Its bytes were in
 * storage; its row was not. Storage refusing to create the object again is
 * proof the upload happened, and the queue was counting it as a failure.
 */
const MARKS_ERROR = "Gave up after 8 attempts. Last error: The resource already exists";

describe("a photo whose bytes are stored but whose row is not", () => {
  it("writes the row once and sends nothing again", async () => {
    held("a", { status: "error", attempts: 1, uploadingSince: NOW - 60_000 });
    storedObjects.add("a");

    await drainQueue("proj-1", 3, { now: NOW });

    expect(puts).toEqual([]);
    expect(uploaded).toEqual(["a"]);
    expect(await listQueue()).toEqual([]);
  });

  it("is simply dropped when the row is there too — no second row, no upload", async () => {
    held("a", { status: "error", attempts: 1, uploadingSince: NOW - 60_000 });
    storedObjects.add("a");
    onServer.add("a");

    await drainQueue("proj-1", 3, { now: NOW });

    expect(puts).toEqual([]);
    expect(uploaded).toEqual([]);
    expect(await listQueue()).toEqual([]);
  });

  it("still uploads and then writes the row when neither is there", async () => {
    held("a");

    await drainQueue("proj-1", 3, { now: NOW });

    expect(puts.map((u) => u.split("/")[3]).sort()).toEqual(["disp", "orig", "thumb"]);
    expect(uploaded).toEqual(["a"]);
  });

  it("treats a PUT answered 'already exists' as uploaded — two attempts raced", async () => {
    held("a");
    // Storage's long-standing shape: HTTP 400, the real code in the body.
    putAnswers = [
      {
        status: 400,
        body: JSON.stringify({
          statusCode: "409",
          error: "Duplicate",
          message: "The resource already exists",
        }),
      },
    ];

    await drainQueue("proj-1", 3, { now: NOW });

    expect(uploaded).toEqual(["a"]);
    expect(await listQueue()).toEqual([]);
  });

  it("still fails on a PUT refused for any other reason", async () => {
    held("a");
    putAnswers = [{ status: 403, body: JSON.stringify({ statusCode: "403", message: "nope" }) }];

    await drainQueue("proj-1", 3, { now: NOW });

    expect(uploaded).toEqual([]);
    expect((await listQueue())[0]).toMatchObject({ status: "error", attempts: 1 });
  });
});

describe("Mark's stopped photo", () => {
  function marks(patch: Partial<QueuedPhoto> = {}) {
    return held("marks-182nd", {
      status: "rejected",
      attempts: MAX_UPLOAD_ATTEMPTS,
      uploadingSince: NOW - 29 * 3_600_000,
      errorMessage: MARKS_ERROR,
      ...patch,
    });
  }

  it("is recognized from what the queue already holds", () => {
    expect(isAlreadyStoredRejection(marks())).toBe(true);
    expect(isAlreadyStoredRejection(marks({ alreadyStoredRequeued: true }))).toBe(false);
    expect(
      isAlreadyStoredRejection(
        marks({ errorMessage: "Gave up after 8 attempts. Last error: Not authorized" }),
      ),
    ).toBe(false);
    expect(isAlreadyStoredRejection(marks({ status: "error" }))).toBe(false);
  });

  it("lands on the next ordinary drain, without a Retry tap or a re-shoot", async () => {
    marks();
    storedObjects.add("marks-182nd");

    // No includeRejected — this is the drain that runs when the app opens.
    await drainQueue("proj-1", 3, { now: NOW });

    expect(puts).toEqual([]);
    expect(uploaded).toEqual(["marks-182nd"]);
    expect(await listQueue()).toEqual([]);
  });

  it("is dropped, not re-filed, if its row turned up in the meantime", async () => {
    marks();
    storedObjects.add("marks-182nd");
    onServer.add("marks-182nd");

    await drainQueue("proj-1", 3, { now: NOW });

    expect(uploaded).toEqual([]);
    expect(await listQueue()).toEqual([]);
  });

  it("is put back once only — a second failure the same way stays stopped", async () => {
    marks({ alreadyStoredRequeued: true });
    storedObjects.add("marks-182nd");

    await drainQueue("proj-1", 3, { now: NOW });

    expect(uploaded).toEqual([]);
    expect((await listQueue())[0]).toMatchObject({ status: "rejected" });
  });

  it("leaves a photo that stopped for another reason where it is", async () => {
    marks({ errorMessage: "Gave up after 8 attempts. Last error: Upload failed — no connection." });

    await drainQueue("proj-1", 3, { now: NOW });

    expect(uploaded).toEqual([]);
    expect((await listQueue())[0]).toMatchObject({ status: "rejected", attempts: 8 });
  });

  it("also clears from the Retry button", async () => {
    marks({ alreadyStoredRequeued: true });
    storedObjects.add("marks-182nd");

    await retryPhoto("marks-182nd");

    expect(uploaded).toEqual(["marks-182nd"]);
    expect(await listQueue()).toEqual([]);
  });
});

describe("whether a photo has been tried before", () => {
  it("survives a Retry resetting the count, so the server is still asked first", () => {
    expect(hasBeenAttempted({ attempts: 0, status: "queued" })).toBe(false);
    expect(hasBeenAttempted({ attempts: 0, status: "queued", uploadingSince: 5 })).toBe(true);
    expect(hasBeenAttempted({ attempts: 2, status: "queued" })).toBe(true);
    expect(hasBeenAttempted({ attempts: 0, status: "rejected" })).toBe(true);
  });

  it("means a retried photo whose row exists is dropped rather than finished twice", async () => {
    held("a", { status: "rejected", attempts: 8, uploadingSince: NOW - 1_000, errorMessage: "x" });
    onServer.add("a");

    await retryPhoto("a");

    expect(uploaded).toEqual([]);
    expect(await listQueue()).toEqual([]);
  });
});

describe("the bar in the waiting-to-upload sheet", () => {
  const SOURCE = readFileSync(
    new URL("../components/offline/sync-banner.tsx", import.meta.url),
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("no longer draws a fixed 60% for anything marked uploading", () => {
    expect(SOURCE).not.toContain(`"60%"`);
    expect(SOURCE).not.toContain(`"8%"`);
  });

  it("only draws a bar when this page has live bytes to report", () => {
    const guard = SOURCE.match(/\{live && \(\s*<div[\s\S]{0,400}?width: `\$\{[^`]+\}%`/);
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain("Math.round(progress * 100)");
  });

  it("says an interrupted attempt is interrupted", () => {
    expect(photoStateLabel({ status: "uploading" }, true)).toBe("Uploading…");
    expect(photoStateLabel({ status: "uploading" }, false)).toBe(
      "Interrupted — will retry on its own",
    );
    expect(photoStateLabel({ status: "rejected" }, false)).toBe("Stopped — needs attention");
    expect(photoStateLabel({ status: "queued" }, false)).toBe("Waiting to upload");
  });
});

describe("what a file picker handed us", () => {
  const file = (name: string, type: string) => new File([new Uint8Array(4)], name, { type });

  it("keeps a photo the browser gave no type to, which is how a HEIC arrives", () => {
    const { images, skipped } = pickImageFiles([file("IMG_4471.HEIC", "")]);
    expect(skipped).toEqual([]);
    expect(images).toMatchObject([{ mime: "image/heic", ext: "heic" }]);
  });

  it("names what it would not take instead of dropping it in silence", () => {
    const { images, skipped } = pickImageFiles([
      file("a.jpg", "image/jpeg"),
      file("notes.pdf", "application/pdf"),
    ]);
    expect(images).toHaveLength(1);
    expect(skipped).toEqual(["notes.pdf"]);
  });

  it("trusts the browser when it does have an opinion", () => {
    const { images } = pickImageFiles([file("shot", "image/png")]);
    expect(images).toMatchObject([{ mime: "image/png", ext: "png" }]);
  });
});
