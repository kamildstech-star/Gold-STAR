/**
 * The stamp's address: reverse-geocoded through the server, cached per
 * ~50 m, and falling back to the job's address and then the coordinates.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ADDRESS_REUSE_M,
  AddressCache,
  FIX_STALE_MS,
  chooseAddress,
  distanceM,
  freshFix,
  makeAddressResolver,
  watchDevicePosition,
} from "./geo";

const TROY = { lat: 40.67123, lon: -73.93841 };
/** ~33 m north of TROY. */
const NEAR = { lat: 40.6715, lon: -73.93841 };
/** ~220 m north. */
const FAR = { lat: 40.6732, lon: -73.93841 };

describe("distance", () => {
  it("is metres, near enough", () => {
    expect(distanceM(TROY, TROY)).toBe(0);
    expect(distanceM(TROY, NEAR)).toBeGreaterThan(25);
    expect(distanceM(TROY, NEAR)).toBeLessThan(ADDRESS_REUSE_M);
    expect(distanceM(TROY, FAR)).toBeGreaterThan(200);
  });
});

describe("the 50 m address cache", () => {
  it("reuses an address anywhere within 50 m, not beyond", () => {
    const c = new AddressCache();
    c.set(TROY, "314 Troy Ave");
    expect(c.get(NEAR)).toEqual({ hit: true, address: "314 Troy Ave" });
    expect(c.get(FAR)).toEqual({ hit: false, address: null });
  });

  it("remembers 'no address here' as an answer too", () => {
    const c = new AddressCache();
    c.set(TROY, null);
    expect(c.get(TROY)).toEqual({ hit: true, address: null });
  });

  it("holds a day's work, not a location history", () => {
    const c = new AddressCache(3);
    for (let i = 0; i < 5; i++) c.set({ lat: i, lon: 0 }, String(i));
    expect(c.size).toBe(3);
    expect(c.get({ lat: 0, lon: 0 }).hit).toBe(false);
  });
});

describe("resolving through the server", () => {
  it("asks once per ~50 m while the crew walks the house", async () => {
    const lookup = vi.fn(async () => "314 Troy Ave, Brooklyn, NY 11213");
    const resolve = makeAddressResolver(lookup);
    expect(await resolve(TROY)).toBe("314 Troy Ave, Brooklyn, NY 11213");
    expect(await resolve(NEAR)).toBe("314 Troy Ave, Brooklyn, NY 11213");
    expect(lookup).toHaveBeenCalledTimes(1);
    await resolve(FAR);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("shares a lookup already in flight for a nearby point", async () => {
    let release: (v: string) => void = () => {};
    const lookup = vi.fn(() => new Promise<string>((r) => (release = r)));
    const resolve = makeAddressResolver(lookup);
    const a = resolve(TROY);
    const b = resolve(NEAR);
    release("314 Troy Ave");
    expect(await Promise.all([a, b])).toEqual(["314 Troy Ave", "314 Troy Ave"]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("a failed lookup (dead signal) is not cached and does not throw", async () => {
    const lookup = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce("314 Troy Ave");
    const resolve = makeAddressResolver(lookup);
    expect(await resolve(TROY)).toBeNull();
    expect(await resolve(TROY)).toBe("314 Troy Ave");
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe("which address the stamp prints", () => {
  it("the device's address first", () => {
    expect(
      chooseAddress({ deviceAddress: "314 Troy Ave", jobAddress: "1 Job St", position: TROY }),
    ).toEqual({ address: "314 Troy Ave", source: "device" });
  });

  it("then the job's address (a basement with no fix is still at the job)", () => {
    expect(chooseAddress({ deviceAddress: null, jobAddress: "1 Job St", position: null })).toEqual({
      address: "1 Job St",
      source: "job",
    });
    expect(
      chooseAddress({ deviceAddress: "  ", jobAddress: "1 Job St", position: TROY }).source,
    ).toBe("job");
  });

  it("then the coordinates, then nothing", () => {
    expect(chooseAddress({ deviceAddress: null, jobAddress: null, position: TROY })).toEqual({
      address: "40.67123, -73.93841",
      source: "coords",
    });
    expect(chooseAddress({ deviceAddress: null, jobAddress: null, position: null })).toEqual({
      address: null,
      source: "none",
    });
  });

  it("a stale fix is not printed as where the photo was taken", () => {
    const fix = { ...TROY, accuracyM: 5, at: 1_000_000 };
    expect(freshFix(fix, 1_000_000 + FIX_STALE_MS)).toBe(fix);
    expect(freshFix(fix, 1_000_000 + FIX_STALE_MS + 1)).toBeNull();
  });
});

describe("watching the position", () => {
  it("reports a refusal once and keeps the camera usable", () => {
    const onError = vi.fn();
    const geo = {
      watchPosition: (_ok: PositionCallback, err: PositionErrorCallback) => {
        err({ code: 1 } as GeolocationPositionError);
        return 7;
      },
      clearWatch: vi.fn(),
    } as unknown as Geolocation;
    const stop = watchDevicePosition(vi.fn(), onError, geo);
    expect(onError).toHaveBeenCalledWith("denied");
    stop();
    expect(geo.clearWatch).toHaveBeenCalledWith(7);
  });

  it("no geolocation at all is 'unavailable', not a crash", () => {
    const onError = vi.fn();
    watchDevicePosition(vi.fn(), onError, undefined);
    expect(onError).toHaveBeenCalledWith("unavailable");
  });
});
