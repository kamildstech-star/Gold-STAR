/**
 * Session memory (last job / folder / tag) and the per-user stamp template.
 * Both must survive a browser that refuses storage.
 */
import { describe, expect, it } from "vitest";

import { readCameraSession, readTemplate, writeCameraSession, writeTemplate } from "./prefs";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    raw: m,
  };
}

const broken = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("session memory", () => {
  it("remembers the last job, folder and tag for the session", () => {
    const s = memoryStore();
    writeCameraSession({ jobId: "job-1" }, s);
    writeCameraSession({ folderId: "f-kitchen", tagId: "t-1" }, s);
    expect(readCameraSession(s)).toMatchObject({
      jobId: "job-1",
      folderId: "f-kitchen",
      tagId: "t-1",
    });
  });

  it("a new job drops the old job's folder and keeps a recent list", () => {
    const s = memoryStore();
    writeCameraSession({ jobId: "job-1", folderId: "f-1" }, s);
    writeCameraSession({ jobId: "job-2" }, s);
    const r = readCameraSession(s);
    expect(r.folderId).toBeNull();
    expect(r.recentJobIds).toEqual(["job-2", "job-1"]);
  });

  it("survives a storage that throws, and garbage in storage", () => {
    expect(readCameraSession(broken)).toEqual({
      jobId: null,
      folderId: null,
      tagId: null,
      recentJobIds: [],
    });
    expect(() => writeCameraSession({ jobId: "x" }, broken)).not.toThrow();
    const s = memoryStore();
    s.setItem("field-camera:session", "{not json");
    expect(readCameraSession(s).jobId).toBeNull();
  });
});

describe("stamp template", () => {
  it("defaults to Standard", () => {
    expect(readTemplate("u1", memoryStore()).presetId).toBe("standard");
  });

  it("is stored per user", () => {
    const s = memoryStore();
    writeTemplate("u1", { presetId: "minimal", fields: ["time", "date", "address"] }, s);
    expect(readTemplate("u1", s)).toEqual({
      presetId: "minimal",
      fields: ["time", "date", "address"],
    });
    expect(readTemplate("u2", s).presetId).toBe("standard");
  });

  it("drops unknown fields and unknown presets", () => {
    const s = memoryStore();
    s.setItem(
      "field-camera:template:u1",
      JSON.stringify({ presetId: "fancy", fields: ["note", "evil", "time"] }),
    );
    expect(readTemplate("u1", s)).toEqual({ presetId: "custom", fields: ["time", "note"] });
  });

  it("never throws on a locked-down browser", () => {
    expect(readTemplate("u1", broken).presetId).toBe("standard");
    expect(() => writeTemplate("u1", { presetId: "full", fields: ["time"] }, broken)).not.toThrow();
    expect(readTemplate(null, memoryStore()).presetId).toBe("standard");
  });
});
