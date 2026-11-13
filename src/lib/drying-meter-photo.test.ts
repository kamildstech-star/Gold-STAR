import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MIN_READ_CONFIDENCE,
  applyMeterRead,
  meterPhotoReaderInstalled,
  readMeterPhoto,
  registerMeterPhotoReader,
} from "@/lib/drying-meter-photo";

/**
 * The OCR seam. Nothing reads a meter photo in this build, and these tests pin
 * both halves of that: that the seam is genuinely inert today, and that the
 * policy protecting a technician's typed numbers already holds — so the day a
 * reader is written, it cannot quietly overwrite the evidence.
 */

afterEach(() => registerMeterPhotoReader(null));

const photo = new Blob(["not really an image"], { type: "image/webp" });

describe("the seam itself", () => {
  it("has no reader installed in this build", async () => {
    expect(meterPhotoReaderInstalled()).toBe(false);
    await expect(readMeterPhoto(photo)).resolves.toBeNull();
  });

  it("uses a reader once one is registered", async () => {
    registerMeterPhotoReader(async () => ({
      temperatureF: 72,
      relativeHumidity: 55,
      confidence: 0.99,
    }));
    expect(meterPhotoReaderInstalled()).toBe(true);
    await expect(readMeterPhoto(photo)).resolves.toMatchObject({ temperatureF: 72 });
  });

  it("swallows a reader that throws — a broken OCR must not block a save", async () => {
    registerMeterPhotoReader(async () => {
      throw new Error("model unavailable");
    });
    await expect(readMeterPhoto(photo)).resolves.toBeNull();
  });

  it("is removed again by registering null", async () => {
    registerMeterPhotoReader(vi.fn());
    registerMeterPhotoReader(null);
    expect(meterPhotoReaderInstalled()).toBe(false);
  });
});

describe("what a machine read is allowed to do", () => {
  const good = { temperatureF: 72, relativeHumidity: 55, confidence: 0.99 };

  it("fills two empty boxes", () => {
    expect(applyMeterRead({ temp: "", rh: "" }, good)).toEqual({
      temp: "72",
      rh: "55",
      filled: true,
    });
  });

  it("fills the one box left empty and leaves the typed one alone", () => {
    expect(applyMeterRead({ temp: "68", rh: "" }, good)).toEqual({
      temp: "68",
      rh: "55",
      filled: true,
    });
  });

  it("never overwrites what a technician typed", () => {
    // The number at the meter is the record. A machine reading a photo of a
    // display does not get to correct the person who was holding it.
    expect(applyMeterRead({ temp: "68", rh: "51" }, good)).toEqual({
      temp: "68",
      rh: "51",
      filled: false,
    });
  });

  it("treats whitespace as empty", () => {
    expect(applyMeterRead({ temp: "  ", rh: "" }, good).temp).toBe("72");
  });

  it("drops a low-confidence read rather than showing it grayed out", () => {
    // A wrong dew point in a drying log is worse than a blank one: a blank gets
    // re-taken, a wrong one gets argued in front of an adjuster.
    const unsure = { ...good, confidence: MIN_READ_CONFIDENCE - 0.01 };
    expect(applyMeterRead({ temp: "", rh: "" }, unsure)).toEqual({
      temp: "",
      rh: "",
      filled: false,
    });
  });

  it("refuses a physically impossible read through the same gate the typed path uses", () => {
    const impossible = { temperatureF: 72, relativeHumidity: 0, confidence: 1 };
    expect(applyMeterRead({ temp: "", rh: "" }, impossible).filled).toBe(false);
    const notANumber = { temperatureF: Number.NaN, relativeHumidity: 55, confidence: 1 };
    expect(applyMeterRead({ temp: "", rh: "" }, notANumber).filled).toBe(false);
  });

  it("does nothing at all when there is no read, which is every reading today", () => {
    expect(applyMeterRead({ temp: "", rh: "" }, null)).toEqual({
      temp: "",
      rh: "",
      filled: false,
    });
  });
});
