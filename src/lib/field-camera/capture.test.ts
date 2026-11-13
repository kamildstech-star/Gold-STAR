/**
 * The lens: opening the camera (and every way it is refused), what the track
 * can do, and capture — a frame drawn at full resolution, cropped for digital
 * zoom, stamped, and encoded as a JPEG. Media and canvas are fakes; there is
 * no browser in this run.
 */
import { describe, expect, it, vi } from "vitest";

import {
  CameraError,
  FIELD_CAMERA_FAILURE,
  JPEG_QUALITY,
  captureStampedFrame,
  cropRect,
  lensCaps,
  openFieldCamera,
  setHardwareZoom,
  setTorch,
  zoomChoices,
  type CanvasLike,
} from "./capture";
import { stampText } from "./stamp";

const stream = { id: "s" } as unknown as MediaStream;
const refusal = (name: string) => Object.assign(new Error(name), { name });

describe("opening the camera", () => {
  it("asks for the rear lens at the highest resolution it will give, ideal-only", async () => {
    const getUserMedia = vi.fn(async () => stream);
    await expect(openFieldCamera("environment", { getUserMedia })).resolves.toBe(stream);
    const asked = (getUserMedia.mock.calls[0] as unknown[])[0] as MediaStreamConstraints;
    expect(asked.audio).toBe(false);
    expect(asked.video).toMatchObject({
      facingMode: { ideal: "environment" },
      width: { ideal: 4096 },
      height: { ideal: 3072 },
    });
  });

  it("flips to the selfie lens on request", async () => {
    const getUserMedia = vi.fn(async () => stream);
    await openFieldCamera("user", { getUserMedia });
    const asked = (getUserMedia.mock.calls[0] as unknown[])[0] as {
      video: { facingMode: unknown };
    };
    expect(asked.video.facingMode).toEqual({ ideal: "user" });
  });

  it("permission denied is 'denied', and the copy points at the phone's own camera", async () => {
    const getUserMedia = vi.fn(async () => {
      throw refusal("NotAllowedError");
    });
    const err = await openFieldCamera("environment", { getUserMedia }).catch((e) => e);
    expect(err).toBeInstanceOf(CameraError);
    expect((err as CameraError).reason).toBe("denied");
    // Never retried with a bare request: a refusal is a refusal.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(FIELD_CAMERA_FAILURE.denied.detail).toContain("Take photo");
  });

  it("no mediaDevices at all (an in-app browser) is 'unsupported', with a way out", async () => {
    const err = await openFieldCamera("environment", undefined).catch((e) => e);
    expect((err as CameraError).reason).toBe("unsupported");
    expect(FIELD_CAMERA_FAILURE.unsupported.detail).toMatch(/Take photo/);
  });

  it("a camera held by another app is 'busy'", async () => {
    const err = await openFieldCamera("environment", {
      getUserMedia: async () => {
        throw refusal("NotReadableError");
      },
    }).catch((e) => e);
    expect((err as CameraError).reason).toBe("busy");
  });

  it("an over-fussy webcam gets a bare retry before being called missing", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(refusal("OverconstrainedError"))
      .mockResolvedValueOnce(stream);
    await expect(openFieldCamera("environment", { getUserMedia })).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenLastCalledWith({ video: true, audio: false });
  });

  it("no camera at all is 'no_camera'", async () => {
    const getUserMedia = vi.fn(async () => {
      throw refusal("NotFoundError");
    });
    const err = await openFieldCamera("environment", { getUserMedia }).catch((e) => e);
    expect((err as CameraError).reason).toBe("no_camera");
  });

  it("every failure reason has words for the crew", () => {
    for (const r of [
      "denied",
      "no_camera",
      "insecure",
      "unsupported",
      "busy",
      "no_frames",
      "unknown",
    ] as const) {
      expect(FIELD_CAMERA_FAILURE[r].title.length).toBeGreaterThan(5);
    }
  });
});

describe("what the lens can do", () => {
  it("reads torch and zoom from the track, and hides what is not there", () => {
    expect(
      lensCaps({ getCapabilities: () => ({ torch: true, zoom: { min: 1, max: 8 } }) }),
    ).toEqual({
      torch: true,
      zoom: { min: 1, max: 8 },
    });
    expect(lensCaps({ getCapabilities: () => ({}) })).toEqual({ torch: false, zoom: null });
    // iOS Safari: no getCapabilities on the track at all.
    expect(lensCaps({})).toEqual({ torch: false, zoom: null });
    expect(
      lensCaps({
        getCapabilities: () => {
          throw new Error("nope");
        },
      }),
    ).toEqual({ torch: false, zoom: null });
  });

  it("hardware zoom offers the chips the lens can reach; .5 only below 1", () => {
    expect(zoomChoices({ torch: false, zoom: { min: 1, max: 8 } }).map((c) => c.label)).toEqual([
      "1x",
      "2",
    ]);
    expect(zoomChoices({ torch: false, zoom: { min: 0.5, max: 10 } }).map((c) => c.label)).toEqual([
      ".5",
      "1x",
      "2",
    ]);
    expect(
      zoomChoices({ torch: false, zoom: { min: 0.5, max: 10 } }).every((c) => c.hardware),
    ).toBe(true);
  });

  it("without hardware zoom, 1x and a digital 2x", () => {
    const c = zoomChoices({ torch: false, zoom: null });
    expect(c.map((x) => [x.label, x.hardware])).toEqual([
      ["1x", false],
      ["2", false],
    ]);
  });

  it("torch and zoom go through applyConstraints, and a refusal is reported, not thrown", async () => {
    const applyConstraints = vi.fn(async () => {});
    expect(await setTorch({ applyConstraints }, true)).toBe(true);
    expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    expect(await setHardwareZoom({ applyConstraints }, 2)).toBe(true);
    expect(applyConstraints).toHaveBeenLastCalledWith({ advanced: [{ zoom: 2 }] });
    const refuse = vi.fn(async () => {
      throw new Error("OverconstrainedError");
    });
    expect(await setTorch({ applyConstraints: refuse }, true)).toBe(false);
    expect(await setTorch(null, true)).toBe(false);
  });
});

describe("capture", () => {
  function fakeCanvas() {
    const calls: { op: string; args: unknown[] }[] = [];
    let encoded: { type?: string; quality?: number } = {};
    const ctx = {
      font: "",
      fillStyle: "",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textBaseline: "alphabetic",
      save: () => calls.push({ op: "save", args: [] }),
      restore: () => calls.push({ op: "restore", args: [] }),
      fillRect: (...args: unknown[]) => calls.push({ op: "fillRect", args }),
      fillText: (...args: unknown[]) => calls.push({ op: "fillText", args }),
      measureText: (t: string) => ({ width: t.length * 10 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args }),
      translate: (...args: unknown[]) => calls.push({ op: "translate", args }),
      scale: (...args: unknown[]) => calls.push({ op: "scale", args }),
      setTransform: (...args: unknown[]) => calls.push({ op: "setTransform", args }),
    };
    const canvas: CanvasLike & { calls: typeof calls; encoded: () => typeof encoded } = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      toBlob: (cb, type, quality) => {
        encoded = { type, quality };
        cb(new Blob([new Uint8Array(64)], { type: type ?? "" }));
      },
      calls,
      encoded: () => encoded,
    };
    return canvas;
  }

  const video = { videoWidth: 3024, videoHeight: 4032 } as unknown as HTMLVideoElement;
  const stamp = stampText(
    {
      at: new Date("2026-10-14T18:04:00Z"),
      timeZone: "America/New_York",
      address: "314 Troy Ave, New York NY 11213",
      lat: null,
      lon: null,
      accuracyM: null,
      jobNumber: "24-1032",
      jobName: "Newark",
      crewName: "Dov Levin",
      note: null,
    },
    ["time", "date", "address", "job", "crew"],
  );

  it("draws the whole frame at the stream's resolution, burns the stamp in, encodes JPEG 0.85", async () => {
    const canvas = fakeCanvas();
    const out = await captureStampedFrame({
      source: video,
      digitalZoom: 1,
      mirror: false,
      stamp,
      makeCanvas: () => canvas,
    });
    expect(out.width).toBe(3024);
    expect(out.height).toBe(4032);
    expect([canvas.width, canvas.height]).toEqual([3024, 4032]);
    const draw = canvas.calls.find((c) => c.op === "drawImage")!;
    expect(draw.args.slice(1)).toEqual([0, 0, 3024, 4032, 0, 0, 3024, 4032]);
    // Frame first, stamp on top of it.
    const firstText = canvas.calls.findIndex((c) => c.op === "fillText");
    expect(firstText).toBeGreaterThan(canvas.calls.indexOf(draw));
    expect(canvas.calls.filter((c) => c.op === "fillText").map((c) => c.args[0])).toContain(
      "2:04 PM",
    );
    expect(canvas.encoded()).toEqual({ type: "image/jpeg", quality: JPEG_QUALITY });
    expect(JPEG_QUALITY).toBe(0.85);
    expect(out.blob.type).toBe("image/jpeg");
  });

  it("digital zoom crops the center and keeps the crop's own pixels", async () => {
    const canvas = fakeCanvas();
    const out = await captureStampedFrame({
      source: video,
      digitalZoom: 2,
      mirror: false,
      stamp: null,
      makeCanvas: () => canvas,
    });
    expect([out.width, out.height]).toEqual([1512, 2016]);
    const draw = canvas.calls.find((c) => c.op === "drawImage")!;
    expect(draw.args.slice(1)).toEqual([756, 1008, 1512, 2016, 0, 0, 1512, 2016]);
    expect(canvas.calls.some((c) => c.op === "fillText")).toBe(false);
    expect(cropRect(1000, 500, 0.5)).toEqual({ sx: 0, sy: 0, sw: 1000, sh: 500 });
  });

  it("mirroring flips the frame but not the stamp", async () => {
    const canvas = fakeCanvas();
    await captureStampedFrame({
      source: video,
      digitalZoom: 1,
      mirror: true,
      stamp,
      makeCanvas: () => canvas,
    });
    const ops = canvas.calls.map((c) => c.op);
    expect(ops.indexOf("scale")).toBeLessThan(ops.indexOf("drawImage"));
    expect(ops.indexOf("setTransform")).toBeGreaterThan(ops.indexOf("drawImage"));
    expect(ops.indexOf("setTransform")).toBeLessThan(ops.indexOf("fillText"));
  });

  it("a stream with no frame yet is a 'no_frames' failure, not a black photo", async () => {
    const err = await captureStampedFrame({
      source: { videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement,
      digitalZoom: 1,
      mirror: false,
      stamp,
      makeCanvas: fakeCanvas,
    }).catch((e) => e);
    expect((err as CameraError).reason).toBe("no_frames");
  });

  it("an encoder that returns nothing fails loudly", async () => {
    const canvas = fakeCanvas();
    canvas.toBlob = (cb) => cb(null);
    await expect(
      captureStampedFrame({
        source: video,
        digitalZoom: 1,
        mirror: false,
        stamp,
        makeCanvas: () => canvas,
      }),
    ).rejects.toThrow(/could not be encoded/);
  });
});
