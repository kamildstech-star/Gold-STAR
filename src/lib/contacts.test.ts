import { describe, expect, it } from "vitest";

import { pickContactLocationId } from "./contacts";

const NJ = "loc-nj";
const GA = "loc-ga";
const NY = "loc-ny";

describe("pickContactLocationId", () => {
  it("files the contact in the account's office even when another was picked", () => {
    // The bug this pins: the create form offered an editable Office field next
    // to a chosen CRM account and then threw the choice away. It now says so.
    expect(pickContactLocationId({ accountLocationId: GA, fallbackLocationId: NJ })).toEqual({
      locationId: GA,
      source: "account",
    });
  });

  it("uses the picked office for a contact with no account", () => {
    expect(pickContactLocationId({ accountLocationId: null, fallbackLocationId: NJ })).toEqual({
      locationId: NJ,
      source: "picked",
    });
  });

  it("falls back to the user's own office when nothing else says", () => {
    expect(pickContactLocationId({ membershipLocationId: NY })).toEqual({
      locationId: NY,
      source: "membership",
    });
  });

  it("prefers the picked office over the user's membership", () => {
    expect(
      pickContactLocationId({ fallbackLocationId: NJ, membershipLocationId: NY }),
    ).toEqual({ locationId: NJ, source: "picked" });
  });

  it("returns null rather than guessing when no office is known", () => {
    expect(pickContactLocationId({})).toBeNull();
    expect(
      pickContactLocationId({
        accountLocationId: "",
        fallbackLocationId: null,
        membershipLocationId: undefined,
      }),
    ).toBeNull();
  });
});
