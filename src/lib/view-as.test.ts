// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  guardMutationWhileViewingAs,
  jwtSessionId,
  officeLabel,
  pickablePeople,
  previewOfficeScope,
  rememberViewAsSession,
  clearViewAsSession,
  searchPeople,
  setViewAsReadOnly,
  viewAsBannerText,
  viewAsBelongsToSession,
  viewAsExpired,
  viewAsReadOnlyReason,
  ViewAsReadOnlyError,
  VIEW_AS_ALLOWED_META,
  VIEW_AS_MAX_AGE_MS,
} from "./view-as";

/*
 * Mark, 11 Oct: "I also want to be able to view as specific people." These
 * pin the non-React half: who can be picked, the one-sign-in rule, the
 * read-only net, and the banner's words.
 */

const LOCATIONS = [
  { id: "nwk", code: "NWK", name: "Newark" },
  { id: "tre", code: "TRE", name: "Trenton" },
];

const profile = (over: Partial<Parameters<typeof pickablePeople>[0]["profiles"][number]>) => ({
  user_id: "u",
  full_name: "Someone",
  is_active: true,
  approval_status: "approved",
  primary_location_id: null,
  ...over,
});

describe("pickablePeople — the picker lists only active, approved staff", () => {
  const people = pickablePeople({
    profiles: [
      profile({ user_id: "dana", full_name: "Dana Ruiz", primary_location_id: "nwk" }),
      profile({ user_id: "pending", full_name: "Pat Pending", approval_status: "pending" }),
      profile({ user_id: "rejected", full_name: "Rae Rejected", approval_status: "rejected" }),
      profile({ user_id: "gone", full_name: "Gil Gone", is_active: false }),
      profile({ user_id: "nullactive", full_name: "Nia Null", is_active: null }),
      profile({ user_id: "me", full_name: "Mark Admin" }),
      profile({ user_id: "blank", full_name: "   " }),
      profile({ user_id: "abe", full_name: "Abe Crew" }),
    ],
    roles: [
      { user_id: "dana", role: "sales_person" },
      { user_id: "dana", role: "cold_caller" },
      { user_id: "abe", role: "crew" },
      { user_id: "pending", role: "crew" },
    ],
    memberships: [
      { user_id: "dana", location_id: "tre" },
      { user_id: "abe", location_id: "nwk" },
      { user_id: "abe", location_id: "tre" },
    ],
    locations: LOCATIONS,
    selfId: "me",
  });

  it("keeps active + approved, drops pending, rejected, inactive, unnamed and yourself", () => {
    expect(people.map((p) => p.userId)).toEqual(["abe", "dana"]);
  });

  it("carries roles (highest first) and the office", () => {
    const dana = people.find((p) => p.userId === "dana")!;
    expect(dana.roles).toEqual(["sales_person", "cold_caller"]);
    expect(dana.primaryRole).toBe("sales_person");
    // Their own office wins over a membership elsewhere.
    expect(dana.officeName).toBe("Newark");
    expect(people.find((p) => p.userId === "abe")!.officeName).toBe("2 offices");
  });

  it("searches name, role and office, every word", () => {
    expect(searchPeople(people, "dana").map((p) => p.userId)).toEqual(["dana"]);
    expect(searchPeople(people, "crew").map((p) => p.userId)).toEqual(["abe"]);
    expect(searchPeople(people, "newark sales").map((p) => p.userId)).toEqual(["dana"]);
    expect(searchPeople(people, "newark crew")).toEqual([]);
    expect(searchPeople(people, "  ")).toHaveLength(2);
  });
});

describe("officeLabel", () => {
  it("primary, else the only office, else a count, else nothing", () => {
    expect(officeLabel("tre", ["nwk"], LOCATIONS)).toBe("Trenton");
    expect(officeLabel(null, ["nwk", "nwk"], LOCATIONS)).toBe("Newark");
    expect(officeLabel(null, ["nwk", "tre"], LOCATIONS)).toBe("2 offices");
    expect(officeLabel("unknown", [], LOCATIONS)).toBeNull();
  });
});

describe("the banner and the tooltip say whose eyes and that it is read only", () => {
  it("names the person, roles and office", () => {
    expect(
      viewAsBannerText({
        userId: "dana",
        name: "Dana Ruiz",
        roles: ["cold_caller", "sales_person"],
        officeName: "Newark",
      }),
    ).toBe("Viewing as Dana Ruiz (Sales Person, Cold Caller, Newark) — Read only");
  });

  it("disabled writes explain how to get out", () => {
    expect(viewAsReadOnlyReason("Dana Ruiz")).toBe(
      "Viewing as Dana Ruiz — switch back to make changes",
    );
  });
});

describe("read only: the mutation net", () => {
  afterEach(() => setViewAsReadOnly(null));

  it("lets everything through when no person view is on", () => {
    expect(() => guardMutationWhileViewingAs(undefined)).not.toThrow();
  });

  it("refuses to start a mutation while viewing as someone, with the tooltip's words", () => {
    setViewAsReadOnly(viewAsReadOnlyReason("Dana Ruiz"));
    expect(() => guardMutationWhileViewingAs(undefined)).toThrow(ViewAsReadOnlyError);
    expect(() => guardMutationWhileViewingAs({ other: true })).toThrow(
      "Viewing as Dana Ruiz — switch back to make changes",
    );
  });

  it("only the view's own actions (switch person, switch back) are allowed", () => {
    setViewAsReadOnly(viewAsReadOnlyReason("Dana Ruiz"));
    expect(() => guardMutationWhileViewingAs({ ...VIEW_AS_ALLOWED_META })).not.toThrow();
  });
});

describe("a person view lasts one sign-in", () => {
  const token = (claims: object) =>
    `h.${btoa(JSON.stringify(claims)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.s`;

  afterEach(() => clearViewAsSession());

  it("reads the auth session id from the access token", () => {
    expect(jwtSessionId(token({ session_id: "s-1", sub: "a" }))).toBe("s-1");
    expect(jwtSessionId(token({ sub: "a" }))).toBeNull();
    expect(jwtSessionId("not-a-jwt")).toBeNull();
    expect(jwtSessionId(null)).toBeNull();
  });

  it("belongs to the session that started it, not to a later one", () => {
    rememberViewAsSession("imp-1", "s-1");
    expect(viewAsBelongsToSession("imp-1", "s-1")).toBe(true);
    expect(viewAsBelongsToSession("imp-1", "s-2")).toBe(false);
    expect(viewAsBelongsToSession("imp-2", "s-1")).toBe(false);
  });

  it("a view nobody noted (or noted before sign-out cleared it) is ended", () => {
    expect(viewAsBelongsToSession("imp-1", "s-1")).toBe(false);
    rememberViewAsSession("imp-1", "s-1");
    clearViewAsSession();
    expect(viewAsBelongsToSession("imp-1", "s-1")).toBe(false);
  });

  it("cannot tell without a session id, so the 8-hour cap decides", () => {
    expect(viewAsBelongsToSession("imp-1", null)).toBe("unknown");
    const now = Date.parse("2026-10-11T18:00:00Z");
    expect(viewAsExpired(new Date(now - VIEW_AS_MAX_AGE_MS - 1).toISOString(), now)).toBe(true);
    expect(viewAsExpired(new Date(now - 60_000).toISOString(), now)).toBe(false);
    expect(viewAsExpired(null, now)).toBe(false);
  });
});

describe("previewOfficeScope — 'All' means the viewed person's offices", () => {
  const person = { userId: "dana", name: "Dana", roles: [], officeName: null };

  it("does not narrow outside a person view, or for someone who sees every office", () => {
    expect(
      previewOfficeScope({ viewingAsPerson: null, roles: [], visibleLocationIds: ["nwk"] }),
    ).toBeNull();
    expect(
      previewOfficeScope({ viewingAsPerson: person, roles: ["admin"], visibleLocationIds: [] }),
    ).toBeNull();
  });

  it("narrows to their offices otherwise — and an office-less person gets none", () => {
    expect(
      previewOfficeScope({
        viewingAsPerson: person,
        roles: ["sales_person"],
        visibleLocationIds: ["tre", "nwk"],
      }),
    ).toEqual(["nwk", "tre"]);
    expect(
      previewOfficeScope({ viewingAsPerson: person, roles: ["crew"], visibleLocationIds: [] }),
    ).toEqual([]);
  });
});
