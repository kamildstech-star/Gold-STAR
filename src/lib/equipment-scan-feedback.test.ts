import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAMERA_KEEP_WARM_MS,
  CAMERA_KEEP_WARM_ONE_TIME_MS,
  acquireCamera,
  cameraKeepWarmMs,
  cameraPromptHint,
  cameraRememberHint,
  noteCameraPermission,
  rememberCameraHint,
  releaseCamera,
  resetCameraPoolForTests,
} from "@/lib/barcode-camera";
import { NO_READ_NUDGE_MS, cameraLookupTag, scanNudge } from "@/lib/equipment-scan";

/**
 * David, 15 Oct: of ten plates scanned, three worked and seven did "nothing"
 * — no message at all — and the camera asked for permission on every scan.
 */

describe("a read that is not tag-shaped is still looked up", () => {
  it("looks a tag-shaped read up as before", () => {
    expect(cameraLookupTag("gsr-00983-nj")).toEqual({ tag: "GSR-00983-NJ", strict: true });
  });

  it("looks up a plausible older tag instead of silently refusing it", () => {
    // No state suffix: registered under an older tag. Used to go nowhere.
    expect(cameraLookupTag("GSR-00983")).toEqual({ tag: "GSR-00983", strict: false });
    expect(cameraLookupTag("DH 4471")).toEqual({ tag: "DH-4471", strict: false });
  });

  it("refuses junk without a lookup", () => {
    expect(cameraLookupTag("")).toBeNull();
    expect(cameraLookupTag("x")).toBeNull();
    expect(cameraLookupTag("https://example.com/a?b=c")).toBeNull();
    expect(cameraLookupTag("A".repeat(40))).toBeNull();
  });
});

describe("silence is never the answer", () => {
  const base = { live: true, busy: false, frames: 40, since: 0 };

  it("says nothing was read once the camera has looked for a while", () => {
    expect(scanNudge({ ...base, now: NO_READ_NUDGE_MS - 1 })).toBeNull();
    expect(scanNudge({ ...base, now: NO_READ_NUDGE_MS })).toBe("no_read");
  });

  it("stays quiet while looking up, before frames arrive, or when the camera is not live", () => {
    expect(scanNudge({ ...base, busy: true, now: 60_000 })).toBeNull();
    expect(scanNudge({ ...base, frames: 0, now: 60_000 })).toBeNull();
    expect(scanNudge({ ...base, live: false, now: 60_000 })).toBeNull();
  });

  it("restarts the wait after anything happens", () => {
    expect(scanNudge({ ...base, since: 10_000, now: 12_000 })).toBeNull();
  });

  const scanner = readFileSync("src/components/asset-tag-scanner.tsx", "utf8");

  it("turns a lookup that throws into a message rather than an unhandled rejection", () => {
    expect(scanner).toMatch(
      /try \{\s*found = await resolveAssetTag\(tag, \{ locationId \}\);\s*\} catch \(error\) \{[\s\S]*?found = \{ kind: "lookup_failed", tag, error \};/,
    );
  });

  it("shows the nudge, flashes a repeated outcome, and prefers the plate's code", () => {
    expect(scanner).toContain('nudge === "no_read"');
    expect(scanner).toContain("key={outcome.at}");
    expect(scanner).toContain("prefer: (raw) => normalizeAssetTag(raw) !== null");
  });
});

/* ------------------------------------------------------------------ */
/* The camera is asked for once                                        */
/* ------------------------------------------------------------------ */

type FakeTrack = { readyState: "live" | "ended"; enabled: boolean; stop: () => void };

function fakeStream() {
  const track: FakeTrack = {
    readyState: "live",
    enabled: true,
    stop() {
      this.readyState = "ended";
    },
  };
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

describe("one camera for the visit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCameraPoolForTests();
  });
  afterEach(() => {
    resetCameraPoolForTests();
    vi.useRealTimers();
  });

  it("hands the next scanner the same granted stream — no second permission request", async () => {
    const { stream, track } = fakeStream();
    const open = vi.fn(async () => stream);
    const first = await acquireCamera(open);
    releaseCamera(first);
    // Paused, not stopped, between scans.
    expect(track.enabled).toBe(false);
    expect(track.readyState).toBe("live");

    const second = await acquireCamera(open);
    expect(second).toBe(first);
    expect(track.enabled).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("really turns the camera off once nobody has scanned for a while", async () => {
    const { stream, track } = fakeStream();
    releaseCamera(await acquireCamera(async () => stream));
    vi.advanceTimersByTime(CAMERA_KEEP_WARM_MS);
    expect(track.readyState).toBe("ended");

    const again = fakeStream();
    const open = vi.fn(async () => again.stream);
    expect(await acquireCamera(open)).toBe(again.stream);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens a new camera when the kept one has ended (the OS took it back)", async () => {
    const a = fakeStream();
    releaseCamera(await acquireCamera(async () => a.stream));
    a.track.readyState = "ended";
    const b = fakeStream();
    expect(await acquireCamera(async () => b.stream)).toBe(b.stream);
  });

  it("stops at once when asked to (a stream that sent no picture)", async () => {
    const { stream, track } = fakeStream();
    releaseCamera(await acquireCamera(async () => stream), 0);
    expect(track.readyState).toBe("ended");
  });

  it("tells the crew how to make the answer stick on their phone", () => {
    expect(rememberCameraHint("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toMatch(
      /Website Settings.*Camera to Allow/,
    );
    expect(rememberCameraHint("Mozilla/5.0 (Linux; Android 14)")).toMatch(/Only this time/);
  });

  it("both scanners take the pooled camera rather than opening their own", () => {
    for (const f of [
      "src/components/asset-tag-scanner.tsx",
      "src/components/code-scan-dialog.tsx",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("await acquireCamera()");
      expect(src, f).not.toMatch(/await openCamera\(\)/);
    }
  });
});

/**
 * David, 20 Oct: still asked for the camera again and again — Chrome's "Allow
 * this time", and every new visit. The web cannot remember the answer for
 * him; it can avoid asking when it does not have to, and say which answer
 * makes it stop.
 */
describe("a one-time yes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetCameraPoolForTests();
  });
  afterEach(() => {
    resetCameraPoolForTests();
    vi.useRealTimers();
  });

  it("keeps the paused camera much longer, since letting it go means asking again", async () => {
    noteCameraPermission("prompt");
    const { stream, track } = fakeStream();
    const open = vi.fn(async () => stream);
    releaseCamera(await acquireCamera(open));
    vi.advanceTimersByTime(CAMERA_KEEP_WARM_MS + 1000);
    expect(track.readyState).toBe("live");
    expect(await acquireCamera(open)).toBe(stream);
    expect(open).toHaveBeenCalledTimes(1);
    releaseCamera(stream);
    vi.advanceTimersByTime(CAMERA_KEEP_WARM_ONE_TIME_MS);
    expect(track.readyState).toBe("ended");
  });

  it("keeps the usual three minutes when the site's Allow is remembered", () => {
    expect(cameraKeepWarmMs("granted")).toBe(CAMERA_KEEP_WARM_MS);
    expect(cameraKeepWarmMs(null)).toBe(CAMERA_KEEP_WARM_MS);
    expect(cameraKeepWarmMs("prompt")).toBe(CAMERA_KEEP_WARM_ONE_TIME_MS);
    expect(cameraKeepWarmMs("unknown")).toBe(CAMERA_KEEP_WARM_ONE_TIME_MS);
  });

  it("says which answer to pick while the browser is asking, in both languages", () => {
    const android = cameraPromptHint("Mozilla/5.0 (Linux; Android 14)");
    expect(android.en).toMatch(/Allow on every visit/);
    expect(android.es).toMatch(/Permitir en cada visita/);
    const desktop = cameraPromptHint("Mozilla/5.0 (Windows NT 10.0)");
    expect(desktop.en).toMatch(/Allow on every visit.*not “Allow this time”/);
    const ios = cameraPromptHint("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)");
    expect(ios.en).toMatch(/Website Settings › Camera › Allow/);
    expect(ios.es).toMatch(/Cámara › Permitir/);
  });

  it("keeps the English 'make it stick' line and adds the Spanish", () => {
    const ua = "Mozilla/5.0 (Linux; Android 14)";
    expect(cameraRememberHint(ua).en).toBe(rememberCameraHint(ua));
    expect(cameraRememberHint(ua).es).toMatch(/Solo esta vez/);
  });

  it("the scanner asks beside the camera request, never in front of it", () => {
    const src = readFileSync("src/components/asset-tag-scanner.tsx", "utf8");
    const start = src.slice(src.indexOf("const start = useCallback"));
    const query = start.indexOf("void cameraPermissionState()");
    const acquire = start.indexOf("await acquireCamera()");
    expect(query).toBeGreaterThan(-1);
    expect(query).toBeLessThan(acquire);
    // Not awaited: the scan starts exactly as fast as before.
    expect(start.slice(0, acquire)).not.toMatch(/await cameraPermissionState/);
    expect(src).toContain("bi(permissionHint.en, permissionHint.es)");
    expect(src).toContain("watchCameraPermission(");
  });
});
