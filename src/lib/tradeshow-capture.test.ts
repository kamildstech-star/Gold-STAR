/**
 * What the booth capture has to be right about.
 *
 * A tablet at a show loses signal, gets its response dropped, and gets tapped
 * twice. The lead it captured must land once — one account, one contact, one
 * photo row, one voice row, one touchpoint — whether the write went through
 * first time, was replayed after a lost response, or sat in the queue until
 * the hall emptied out. And the rep must be told "held here", never "saved",
 * while it sits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }));

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

/* ------------------------------------------------------------------ */
/* A Supabase that is a table of rows and a bucket of paths            */
/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;
const tables = new Map<string, Map<string, Row>>();
const uploads: { path: string; size: number; contentType: string; upsert: boolean }[] = [];
const rpcCalls: { name: string; args: Row }[] = [];
/** Tables whose next write should fail, consumed one per call. */
const failures: { table: string; error: unknown; afterWrite?: boolean }[] = [];
let offlineUploads = false;

function rows(table: string): Map<string, Row> {
  if (!tables.has(table)) tables.set(table, new Map());
  return tables.get(table)!;
}

function builder(table: string) {
  return {
    /**
     * `ignoreDuplicates` is INSERT … ON CONFLICT DO NOTHING, which is how the
     * capture-review row survives a replay: the second write must leave a
     * lead that has since been reviewed exactly as it is.
     */
    upsert(row: Row, opts?: { ignoreDuplicates?: boolean }) {
      const i = failures.findIndex((f) => f.table === table);
      const fail = i === -1 ? null : failures.splice(i, 1)[0]!;
      const key = String(row["id"] ?? row["account_id"]);
      if (!fail || fail.afterWrite) {
        if (!(opts?.ignoreDuplicates && rows(table).has(key))) rows(table).set(key, row);
      }
      return Promise.resolve({ data: null, error: fail?.error ?? null });
    },
    /** `update(patch).eq("id", id)` — the late card read's patch onto the account. */
    update(patch: Row) {
      return {
        eq: (col: string, val: unknown) => {
          const i = failures.findIndex((f) => f.table === table);
          const fail = i === -1 ? null : failures.splice(i, 1)[0]!;
          if (!fail) {
            for (const [key, row] of rows(table)) {
              if (row[col] === val) rows(table).set(key, { ...row, ...patch });
            }
          }
          return Promise.resolve({ data: null, error: fail?.error ?? null });
        },
      };
    },
  };
}

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(),
      getSession: async () => ({
        data: { session: { user: { id: USER }, access_token: "test-token" } },
        error: null,
      }),
    },
    from: (table: string) => builder(table),
    rpc: async (name: string, args: Row) => {
      rpcCalls.push({ name, args });
      if (name !== "capture_tradeshow_lead_account") {
        return { data: null, error: { message: `Unexpected RPC ${name}` } };
      }
      const i = failures.findIndex((f) => f.table === "accounts");
      const fail = i === -1 ? null : failures.splice(i, 1)[0]!;
      if (!fail || fail.afterWrite) {
        rows("accounts").set(String(args["_account_id"]), {
          id: args["_account_id"],
          name: args["_name"],
          tradeshow_id: args["_tradeshow_id"],
          location_id: args["_location_id"],
          lead_source_id: args["_lead_source_id"],
          lead_source_detail: "RIMS 2026",
          assigned_rep: USER,
          created_by: USER,
          created_at: args["_captured_at"],
          phone: args["_phone"],
          email: args["_email"],
          notes: args["_notes"],
          pipeline_id: args["_pipeline_id"],
          stage_id: args["_stage_id"],
        });
      }
      return { data: fail ? null : args["_account_id"], error: fail?.error ?? null };
    },
    storage: {
      from: () => ({
        upload: async (
          path: string,
          blob: Blob,
          opts: { contentType: string; upsert: boolean },
        ) => {
          if (offlineUploads) return { error: { message: "Failed to fetch" } };
          uploads.push({
            path,
            size: blob.size,
            contentType: opts.contentType,
            upsert: opts.upsert,
          });
          return { error: null };
        },
      }),
    },
  },
}));

vi.mock("@supabase/supabase-js", async () => {
  const { supabase } = await import("@/integrations/supabase/client");
  return { createClient: () => supabase };
});

import { emptyFields, type CardRead } from "@/lib/business-card";
import { drain, listQueue, KIND_LABEL } from "@/lib/offline-queue";
import {
  applyLateCardRead,
  buildLeadPayload,
  captureTradeshowLead,
  findTradeshowLeadSourceId,
  mediaByAccount,
  pickCaptureStage,
  validateBoothCapture,
  validateLeadDetails,
  type LeadMedia,
} from "@/lib/tradeshow-capture";
import {
  leadAccountName,
  leadMediaPaths,
  mediaExt,
  writeTradeshowLead,
} from "@/lib/tradeshow-lead-writes";
import type { OptionValue } from "@/lib/option-lists";
import type { PipelineStage } from "@/lib/pipeline";

const USER = "11111111-1111-4111-8111-111111111111";
const SHOW = "22222222-2222-4222-8222-222222222222";
const LOC = "33333333-3333-4333-8333-333333333333";
const TAPPED_AT = "2026-10-14T15:42:00.000Z";

function aLead(overrides: Partial<Parameters<typeof buildLeadPayload>[0]> = {}) {
  return buildLeadPayload({
    tradeshowId: SHOW,
    tradeshowName: "RIMS 2026",
    locationId: LOC,
    userId: USER,
    details: {
      name: "Dana Ortiz",
      company: "Harbor Point",
      phone: "555-0100",
      email: "",
      notes: "",
    },
    photo: {
      blob: new Blob([new Uint8Array(3000)], { type: "image/webp" }),
      mime: "image/webp",
      width: 1600,
      height: 1200,
      thumb: new Blob([new Uint8Array(400)], { type: "image/webp" }),
    },
    audio: {
      blob: new Blob([new Uint8Array(9000)], { type: "audio/webm" }),
      mime: "audio/webm;codecs=opus",
      durationSec: 14.2,
      peaks: [0.2, 0.9, 0.4],
    },
    leadSourceId: "src-tradeshow",
    stageId: "stage-intake",
    pipelineId: "pipe-1",
    capturedAt: TAPPED_AT,
    ...overrides,
  });
}

beforeEach(() => {
  store.clear();
  tables.clear();
  uploads.length = 0;
  rpcCalls.length = 0;
  failures.length = 0;
  offlineUploads = false;
  vi.stubGlobal("navigator", { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */

describe("the least a lead needs", () => {
  it("is someone to call and a way to call them", () => {
    const base = { name: "", company: "", phone: "", email: "", notes: "" };
    expect(validateLeadDetails(base)).toMatch(/name or company/);
    expect(validateLeadDetails({ ...base, name: "Dana" })).toMatch(/phone|email/);
    expect(validateLeadDetails({ ...base, phone: "555" })).toMatch(/name or a company/);
    expect(validateLeadDetails({ ...base, company: "Harbor Point", email: "d@hp.com" })).toBeNull();
    expect(validateLeadDetails({ ...base, name: "Dana", phone: "555-0100" })).toBeNull();
  });

  it("rejects an email that is not one", () => {
    expect(
      validateLeadDetails({ name: "Dana", company: "", phone: "", email: "dana@", notes: "" }),
    ).toMatch(/email/);
  });

  it("names the account after the company, or the person when there is none", () => {
    expect(leadAccountName({ name: "Dana Ortiz", company: "Harbor Point" })).toBe("Harbor Point");
    expect(leadAccountName({ name: "Dana Ortiz", company: "  " })).toBe("Dana Ortiz");
  });
});

/**
 * Mark: "he wants to be able to just dump info into a section and press
 * save." A card photo or a recording is a capture on its own; typing is for
 * the review pass. The typed rule only stands when there is nothing attached.
 */
describe("the booth rule", () => {
  const none = { name: "", company: "", phone: "", email: "", notes: "" };

  it("saves a card photo or a voice note with nothing typed, for review", () => {
    expect(validateBoothCapture({ details: none, hasPhoto: true, hasAudio: false })).toEqual({
      problem: null,
      needsReview: true,
    });
    expect(validateBoothCapture({ details: none, hasPhoto: false, hasAudio: true })).toEqual({
      problem: null,
      needsReview: true,
    });
  });

  it("keeps partial typing alongside media as a capture still needing review", () => {
    const r = validateBoothCapture({
      details: { ...none, name: "Dana" },
      hasPhoto: true,
      hasAudio: false,
    });
    expect(r).toEqual({ problem: null, needsReview: true });
  });

  it("treats a fully typed lead as reviewed already, media or not", () => {
    const full = { ...none, company: "Harbor Point", phone: "555-0100" };
    expect(validateBoothCapture({ details: full, hasPhoto: true, hasAudio: true })).toEqual({
      problem: null,
      needsReview: false,
    });
    expect(validateBoothCapture({ details: full, hasPhoto: false, hasAudio: false })).toEqual({
      problem: null,
      needsReview: false,
    });
  });

  it("refuses an empty screen, and a name with no way to reach them and nothing attached", () => {
    expect(
      validateBoothCapture({ details: none, hasPhoto: false, hasAudio: false }).problem,
    ).toMatch(/card|voice note/);
    expect(
      validateBoothCapture({ details: { ...none, name: "Dana" }, hasPhoto: false, hasAudio: false })
        .problem,
    ).toMatch(/phone|email/);
  });

  it("takes a scanned badge as a capture: a decoded card with its fields is a reviewed lead", () => {
    // What the MFO Summit badge decoded to, already in the fields.
    const card = {
      ...none,
      name: "Elly Lesser",
      company: "Fairmont Insurance Brokers",
      phone: "+1 718-906-0452",
      email: "elesser@fairmontins.com",
    };
    expect(
      validateBoothCapture({ details: card, hasPhoto: false, hasAudio: false, hasBadge: true }),
    ).toEqual({ problem: null, needsReview: false });
    // An attendee id fills nothing; the capture is still kept, for review.
    expect(
      validateBoothCapture({ details: none, hasPhoto: false, hasAudio: false, hasBadge: true }),
    ).toEqual({ problem: null, needsReview: true });
  });

  it("never lets a malformed email through, even with a photo attached", () => {
    expect(
      validateBoothCapture({ details: { ...none, email: "dana@" }, hasPhoto: true, hasAudio: true })
        .problem,
    ).toMatch(/email/);
  });
});

describe("tagging", () => {
  const opt = (id: string, key: string, label: string): OptionValue => ({
    id,
    key,
    label,
    sort_order: 0,
    active: true,
    is_default: false,
    requires_detail: false,
    location_id: null,
    metadata: null,
  });

  it("finds the admin-managed trade show source however it is spelled", () => {
    expect(
      findTradeshowLeadSourceId([opt("a", "broker", "Broker"), opt("b", "tradeshow", "Tradeshow")]),
    ).toBe("b");
    expect(findTradeshowLeadSourceId([opt("c", "trade_show", "Trade show")])).toBe("c");
    expect(findTradeshowLeadSourceId([opt("d", "other", "Trade-Show / Event")])).toBe("d");
    expect(findTradeshowLeadSourceId([opt("a", "broker", "Broker")])).toBeNull();
  });

  it("lands a fresh lead in the intake column, else the first live one", () => {
    const stage = (key: string, extra: Partial<PipelineStage> & { is_intake?: boolean } = {}) =>
      ({
        id: key,
        pipeline_id: "p",
        key,
        name: key,
        sort_order: 0,
        color: "",
        probability: 0,
        is_won: false,
        is_lost: false,
        wip_limit: null,
        is_active: true,
        ...extra,
      }) as PipelineStage;
    expect(
      pickCaptureStage([
        stage("lost", { is_lost: true }),
        stage("new"),
        stage("intake", { is_intake: true }),
      ])?.id,
    ).toBe("intake");
    expect(pickCaptureStage([stage("won", { is_won: true }), stage("new")])?.id).toBe("new");
    expect(pickCaptureStage([])).toBeNull();
  });
});

describe("where the files go", () => {
  it("is under the uploader, then the account, so the storage policy reads the path alone", () => {
    const paths = leadMediaPaths({
      userId: USER,
      accountId: "acc",
      photoMime: "image/webp",
      audioMime: "audio/webm;codecs=opus",
    });
    expect(paths.photo).toBe(`${USER}/acc/photo.webp`);
    expect(paths.thumb).toBe(`${USER}/acc/photo-thumb.webp`);
    expect(paths.audio).toBe(`${USER}/acc/voice.webm`);
    expect(leadMediaPaths({ userId: USER, accountId: "acc" })).toEqual({
      photo: null,
      thumb: null,
      audio: null,
    });
  });

  it("names the audio by its container, not by the codec suffix", () => {
    expect(mediaExt("audio/webm;codecs=opus")).toBe("webm");
    expect(mediaExt("audio/mp4")).toBe("m4a");
    expect(mediaExt("audio/x-unknown")).toBe("webm");
    expect(mediaExt("image/jpeg")).toBe("jpg");
  });
});

describe("writing the lead", () => {
  it("files one account, one contact, two media rows and one touchpoint", async () => {
    const { payload, blobs } = aLead();
    await writeTradeshowLead(payload, blobs);

    const account = rows("accounts").get(payload.accountId)!;
    expect(account).toMatchObject({
      name: "Harbor Point",
      tradeshow_id: SHOW,
      lead_source_id: "src-tradeshow",
      lead_source_detail: "RIMS 2026",
      assigned_rep: USER,
      location_id: LOC,
      stage_id: "stage-intake",
      created_at: TAPPED_AT,
    });
    expect(rpcCalls).toEqual([
      {
        name: "capture_tradeshow_lead_account",
        args: expect.objectContaining({
          _account_id: payload.accountId,
          _tradeshow_id: SHOW,
          _location_id: LOC,
          _name: "Harbor Point",
          _captured_at: TAPPED_AT,
        }),
      },
    ]);
    expect(rows("contacts").get(payload.contactId!)).toMatchObject({
      account_id: payload.accountId,
      full_name: "Dana Ortiz",
      phone: "555-0100",
      is_primary: true,
    });
    const media = [...rows("tradeshow_lead_media").values()];
    expect(media.map((m) => m["kind"]).sort()).toEqual(["audio", "photo"]);
    expect(media.find((m) => m["kind"] === "audio")).toMatchObject({
      mime: "audio/webm",
      duration_seconds: 14.2,
      waveform_peaks: [0.2, 0.9, 0.4],
      captured_at: TAPPED_AT,
    });
    expect(rows("touchpoints").get(payload.touchpointId)).toMatchObject({
      type: "meeting_in_person",
      capture_source: "voice_note",
      is_self_reported: false,
      occurred_at: TAPPED_AT,
      contact_id: payload.contactId,
    });
    expect(uploads.map((u) => u.path)).toEqual([
      `${USER}/${payload.accountId}/photo.webp`,
      `${USER}/${payload.accountId}/photo-thumb.webp`,
      `${USER}/${payload.accountId}/voice.webm`,
    ]);
    expect(uploads.every((u) => u.upsert)).toBe(true);
    expect(uploads[2]!.contentType).toBe("audio/webm");
  });

  it("writes the same rows again on a replay, never a second lead", async () => {
    const { payload, blobs } = aLead();
    await writeTradeshowLead(payload, blobs);
    await writeTradeshowLead(payload, blobs);
    expect(rows("accounts").size).toBe(1);
    expect(rows("contacts").size).toBe(1);
    expect(rows("tradeshow_lead_media").size).toBe(2);
    expect(rows("touchpoints").size).toBe(1);
  });

  it("skips the contact when no name was given and marks a typed lead self-reported", async () => {
    const { payload, blobs } = aLead({
      details: {
        name: "",
        company: "Harbor Point",
        phone: "",
        email: "ops@hp.com",
        notes: "wants a walkthrough",
      },
      audio: null,
      photo: null,
    });
    expect(payload.contactId).toBeNull();
    await writeTradeshowLead(payload, blobs);
    expect(rows("contacts").size).toBe(0);
    expect(rows("tradeshow_lead_media").size).toBe(0);
    expect(uploads).toHaveLength(0);
    expect(rows("touchpoints").get(payload.touchpointId)).toMatchObject({
      capture_source: "manual",
      is_self_reported: true,
      contact_id: null,
      notes: "Met at RIMS 2026\nwants a walkthrough",
    });
  });
});

describe("a hall with no signal", () => {
  it("holds the lead, files and all, and says so", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { payload, blobs } = aLead();
    const res = await captureTradeshowLead(payload, blobs);
    expect(res.queued).toBe(true);
    expect(rows("accounts").size).toBe(0);

    const held = await listQueue();
    expect(held).toHaveLength(1);
    expect(held[0]!.kind).toBe("tradeshow_lead");
    expect(held[0]!.label).toBe("Harbor Point · RIMS 2026");
    expect(Object.keys(held[0]!.blobs ?? {}).sort()).toEqual(["audio", "photo", "thumb"]);
  });

  it("files it once the signal is back, stamped with when it was tapped", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { payload, blobs } = aLead();
    await captureTradeshowLead(payload, blobs);

    vi.stubGlobal("navigator", { onLine: true });
    const out = await drain();
    expect(out).toEqual({ sent: 1, failed: 0 });
    expect(await listQueue()).toHaveLength(0);
    expect(rows("accounts").get(payload.accountId)).toMatchObject({ created_at: TAPPED_AT });
    expect(rows("tradeshow_lead_media").size).toBe(2);
    expect(uploads).toHaveLength(3);
  });

  it("keeps the account and comes back for the files when only the upload failed", async () => {
    offlineUploads = true;
    const { payload, blobs } = aLead();
    const res = await captureTradeshowLead(payload, blobs);
    expect(res.queued).toBe(true);
    // The account went up before the upload broke — the lead exists.
    expect(rows("accounts").size).toBe(1);
    expect(rows("tradeshow_lead_media").size).toBe(0);

    // The hold kicks off a background drain of its own; whichever pass runs
    // after the network returns is the one that files the media.
    offlineUploads = false;
    await vi.waitFor(async () => {
      await drain();
      expect(await listQueue()).toHaveLength(0);
    });
    expect(rows("accounts").size).toBe(1);
    expect(rows("tradeshow_lead_media").size).toBe(2);
  });

  it("reports a refusal and preserves the capture as rejected without automatic retry", async () => {
    failures.push({
      table: "accounts",
      error: { code: "42501", message: "new row violates row-level security policy" },
    });
    const { payload, blobs } = aLead();
    await expect(captureTradeshowLead(payload, blobs)).rejects.toMatchObject({ code: "42501" });
    expect(await listQueue()).toMatchObject([{ status: "rejected" }]);
    expect(await drain()).toEqual({ sent: 0, failed: 0 });
  });

  it("has a label in the pending list", () => {
    expect(KIND_LABEL.tradeshow_lead).toMatch(/\S/);
  });
});

describe("reading captures back", () => {
  it("pairs each account with its newest photo and voice note", () => {
    const m = (id: string, account_id: string, kind: string): LeadMedia =>
      ({ id, account_id, kind, storage_path: id, tradeshow_id: SHOW }) as unknown as LeadMedia;
    const grouped = mediaByAccount([
      m("p2", "a", "photo"),
      m("v1", "a", "audio"),
      m("p1", "a", "photo"),
      m("v9", "b", "audio"),
    ]);
    expect(grouped.get("a")?.photo?.id).toBe("p2");
    expect(grouped.get("a")?.audio?.id).toBe("v1");
    expect(grouped.get("b")).toEqual({
      photo: null,
      badge: null,
      audio: expect.objectContaining({ id: "v9" }),
    });
  });
});

describe("badge capture alongside the selfie", () => {
  it("keeps a badge, selfie and voice note on the same lead and replays each once", async () => {
    const { payload, blobs } = aLead({
      badge: {
        blob: new Blob([new Uint8Array(1800)], { type: "image/jpeg" }),
        mime: "image/jpeg",
        width: 800,
        height: 600,
        thumb: null,
      },
    });
    await writeTradeshowLead(payload, blobs);
    await writeTradeshowLead(payload, blobs);
    expect(rows("accounts").size).toBe(1);
    expect(rows("tradeshow_lead_media").size).toBe(3);
    const media = [...rows("tradeshow_lead_media").values()] as unknown as LeadMedia[];
    const grouped = mediaByAccount(media).get(payload.accountId)!;
    expect(grouped.badge?.storage_path).toBe(`${USER}/${payload.accountId}/badge.jpg`);
    expect(grouped.photo?.storage_path).toBe(`${USER}/${payload.accountId}/photo.webp`);
    expect(grouped.audio?.storage_path).toBe(`${USER}/${payload.accountId}/voice.webm`);
    expect(new Set(uploads.map((u) => u.path)).size).toBe(4);
  });

  it("holds the badge offline with all the other files", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { payload, blobs } = aLead({
      badge: {
        blob: new Blob(["badge"], { type: "image/jpeg" }),
        mime: "image/jpeg",
        width: 100,
        height: 100,
        thumb: null,
      },
    });
    await captureTradeshowLead(payload, blobs);
    expect(Object.keys((await listQueue())[0]!.blobs ?? {})).toContain("badge");
    vi.stubGlobal("navigator", { onLine: true });
    expect(await drain()).toEqual({ sent: 1, failed: 0 });
    expect(rows("tradeshow_lead_media").size).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* The one-tap voice note                                              */
/* ------------------------------------------------------------------ */

/**
 * "Just a voice note" is the whole booth flow reduced to a held button, so it
 * has to make a lead out of nothing but a recording — and that lead has to be
 * findable, has to be marked as unwritten-up, and must survive the same
 * lost-response replay as any other capture without being dragged back into
 * the review queue after somebody has already dealt with it.
 */
describe("a voice note with nothing typed", () => {
  const voiceOnly = () =>
    aLead({
      details: { name: "", company: "", phone: "", email: "", notes: "" },
      photo: null,
      needsReview: true,
      badgeRaw: "  ATT-99123  ",
    });

  it("names the account by the time it was taken so it can be found before review", async () => {
    const { payload, blobs } = voiceOnly();
    await writeTradeshowLead(payload, blobs);
    const account = [...rows("accounts").values()][0]!;
    expect(String(account["name"]).startsWith("Voice note · ")).toBe(true);
    // No name was spoken into a field, so no contact row is invented.
    expect(rows("contacts").size).toBe(0);
  });

  it("files it as needing review, with the badge value stored raw and unparsed", async () => {
    const { payload, blobs } = voiceOnly();
    await writeTradeshowLead(payload, blobs);
    const capture = [...rows("tradeshow_lead_captures").values()][0]!;
    expect(capture["needs_review"]).toBe(true);
    expect(capture["badge_raw"]).toBe("ATT-99123");
    expect(capture["captured_at"]).toBe(TAPPED_AT);
  });

  it("marks a fully typed lead as already reviewed", async () => {
    const { payload, blobs } = aLead();
    await writeTradeshowLead(payload, blobs);
    expect([...rows("tradeshow_lead_captures").values()][0]!["needs_review"]).toBe(false);
  });

  it("does not drag a written-up lead back into the queue when the queue replays", async () => {
    const { payload, blobs } = voiceOnly();
    await writeTradeshowLead(payload, blobs);
    // Somebody reviews it between the lost response and the replay.
    const capture = rows("tradeshow_lead_captures").get(payload.accountId)!;
    capture["needs_review"] = false;
    await writeTradeshowLead(payload, blobs);
    expect(rows("tradeshow_lead_captures").get(payload.accountId)!["needs_review"]).toBe(false);
  });

  it("still saves the lead when the review table is not in this database yet", async () => {
    failures.push({
      table: "tradeshow_lead_captures",
      error: { code: "PGRST205", message: "Could not find the table in the schema cache" },
    });
    const { payload, blobs } = voiceOnly();
    await expect(writeTradeshowLead(payload, blobs)).resolves.toBeUndefined();
    expect(rows("accounts").size).toBe(1);
    expect(rows("touchpoints").size).toBe(1);
  });

  it("holds the recording on the tablet when the hall has no signal", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const { payload, blobs } = voiceOnly();
    const { queued } = await captureTradeshowLead(payload, blobs);
    expect(queued).toBe(true);
    const held = (await listQueue())[0]!;
    expect(Object.keys(held.blobs ?? {})).toEqual(["audio"]);
    expect(held.label.startsWith("Voice note · ")).toBe(true);

    vi.stubGlobal("navigator", { onLine: true });
    expect(await drain()).toEqual({ sent: 1, failed: 0 });
    expect([...rows("tradeshow_lead_captures").values()][0]!["needs_review"]).toBe(true);
  });
});

describe("a card photo with nothing typed", () => {
  it("is named as a card photo, not a voice note, and files the card for review", async () => {
    const { payload, blobs } = aLead({
      details: { name: "", company: "", phone: "", email: "", notes: "" },
      photo: null,
      audio: null,
      badge: {
        blob: new Blob([new Uint8Array(2000)], { type: "image/webp" }),
        mime: "image/webp",
        width: 1600,
        height: 1000,
        thumb: null,
      },
      needsReview: true,
    });
    expect(payload.placeholderName!.startsWith("Card photo · ")).toBe(true);
    await writeTradeshowLead(payload, blobs);
    const account = [...rows("accounts").values()][0]!;
    expect(String(account["name"]).startsWith("Card photo · ")).toBe(true);
    expect(rows("contacts").size).toBe(0);
    expect([...rows("tradeshow_lead_captures").values()][0]!["needs_review"]).toBe(true);
    const media = [...rows("tradeshow_lead_media").values()];
    expect(media).toHaveLength(1);
    expect(String(media[0]!["storage_path"])).toMatch(/\/badge\.webp$/);
    // No recording means the meeting is self-reported, as a typed lead is.
    const tp = [...rows("touchpoints").values()][0]!;
    expect(tp["capture_source"]).toBe("manual");
  });
});

/**
 * Mark: "also the scanner needs to be able to scan business cards as well
 * with qr codes and without." The read is fire-and-forget on the booth
 * screen, so a rep who saves first still gets it: it lands on the written
 * lead, into the fields the capture left empty.
 */
describe("a card read that arrives after Save", () => {
  const read = (fields: Partial<CardRead["fields"]>): CardRead => ({
    source: "ocr",
    fields: { ...emptyFields(), ...fields },
    raw: { ocrText: "Elly Lesser" },
    confidence: "high",
    uncertain: [],
    pending: false,
  });

  it("names the placeholder lead after the card, sets its contact details and creates the contact", async () => {
    const { payload, blobs } = aLead({
      details: { name: "", company: "", phone: "", email: "", notes: "" },
      audio: null,
      needsReview: true,
    });
    await writeTradeshowLead(payload, blobs);
    expect(rows("accounts").get(payload.accountId)?.name).toMatch(/^Card photo · /);
    expect(rows("contacts").size).toBe(0);

    const filled = await applyLateCardRead(
      payload,
      read({
        name: "Elly Lesser",
        company: "Fairmont Insurance Brokers",
        phone: "(718) 906-0452",
        email: "elesser@fairmontins.com",
        title: "Account Executive",
      }),
    );
    expect(filled).toEqual(["name", "company", "phone", "email", "title"]);

    const account = rows("accounts").get(payload.accountId)!;
    expect(account.name).toBe("Fairmont Insurance Brokers");
    expect(account.phone).toBe("(718) 906-0452");
    expect(account.email).toBe("elesser@fairmontins.com");
    expect(account.notes).toBe("Account Executive");

    const contact = [...rows("contacts").values()][0]!;
    expect(contact.account_id).toBe(payload.accountId);
    expect(contact.full_name).toBe("Elly Lesser");
    expect(contact.phone).toBe("(718) 906-0452");
    expect(contact.is_primary).toBe(true);
    // Still a capture for the review pass to confirm: a model read a photograph.
    expect(rows("tradeshow_lead_captures").get(payload.accountId)?.needs_review).toBe(true);
  });

  it("fills only what was left empty, and updates the contact the capture made", async () => {
    const { payload, blobs } = aLead({ audio: null, needsReview: true });
    await writeTradeshowLead(payload, blobs);
    const contactBefore = rows("contacts").get(payload.contactId!)!;
    expect(contactBefore.full_name).toBe("Dana Ortiz");

    const filled = await applyLateCardRead(
      payload,
      read({ name: "Elly Lesser", company: "Fairmont", email: "dana@hp.com", phone: "999" }),
    );
    expect(filled).toEqual(["email"]);
    const account = rows("accounts").get(payload.accountId)!;
    expect(account.name).toBe("Harbor Point");
    expect(account.phone).toBe("555-0100");
    expect(account.email).toBe("dana@hp.com");
    const contact = rows("contacts").get(payload.contactId!)!;
    expect(contact.full_name).toBe("Dana Ortiz");
    expect(contact.email).toBe("dana@hp.com");
    expect(rows("contacts").size).toBe(1);
  });

  it("writes nothing when the card added nothing", async () => {
    const { payload, blobs } = aLead({ audio: null });
    await writeTradeshowLead(payload, blobs);
    const before = { ...rows("accounts").get(payload.accountId)! };
    const filled = await applyLateCardRead(
      payload,
      read({ name: "Dana Ortiz", phone: "555-0100" }),
    );
    expect(filled).toEqual([]);
    expect(rows("accounts").get(payload.accountId)).toEqual(before);
  });

  it("surfaces a refused write rather than swallowing it", async () => {
    const { payload, blobs } = aLead({ audio: null, needsReview: true });
    await writeTradeshowLead(payload, blobs);
    failures.push({ table: "accounts", error: { code: "42501", message: "permission denied" } });
    await expect(applyLateCardRead(payload, read({ email: "dana@hp.com" }))).rejects.toMatchObject({
      code: "42501",
    });
  });
});
