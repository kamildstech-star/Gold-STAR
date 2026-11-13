import { describe, expect, it } from "vitest";
import {
  addressCorrectionPatch,
  geocodeLine,
  placeChanged,
  type AddressDraft,
} from "./job-address-correction";

const before: AddressDraft = {
  address: "12 Mian St",
  address_line2: "Apt 2",
  locality: "Lakewood",
  region: "NJ",
  postal_code: "08701",
  county: "Ocean",
};

describe("correcting a job's address", () => {
  it("writes only what changed, and moves the pin with the place", () => {
    const patch = addressCorrectionPatch(
      before,
      { ...before, address: " 12 Main St " },
      { lat: 40.1, lon: -74.2 },
    );
    expect(patch).toEqual({ address: "12 Main St", lat: 40.1, lon: -74.2 });
  });

  it("clears the old pin when the corrected place cannot be found", () => {
    const patch = addressCorrectionPatch(before, { ...before, postal_code: "08702" }, null);
    expect(patch).toMatchObject({ postal_code: "08702", lat: null, lon: null });
  });

  it("keeps the pin when only the unit changes", () => {
    const patch = addressCorrectionPatch(before, { ...before, address_line2: "Apt 3" }, null);
    expect(patch).toEqual({ address_line2: "Apt 3" });
    expect(placeChanged(before, { ...before, address_line2: "" })).toBe(false);
  });

  it("geocodes street, city, state and zip — not the unit", () => {
    expect(geocodeLine(before)).toBe("12 Mian St, Lakewood, NJ 08701");
  });
});
