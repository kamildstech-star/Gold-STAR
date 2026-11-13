import { describe, expect, it } from "vitest";

import { allowedTargets, safeHref } from "./notifications.functions";

/**
 * notifyUsers writes a trusted-looking record and sends mail from our own
 * domain. Both of the things standing between a caller and "notify everyone
 * with a link to my page" are pure enough to pin down here.
 */

describe("safeHref", () => {
  it("keeps a same-origin path", () => {
    expect(safeHref("/supplies")).toBe("/supplies");
    expect(safeHref("/jobs/123?tab=photos#top")).toBe("/jobs/123?tab=photos#top");
  });

  it("drops anything that leaves the site", () => {
    expect(safeHref("https://evil.example/login")).toBeNull();
    expect(safeHref("//evil.example/login")).toBeNull();
    expect(safeHref("/\\evil.example/login")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref("supplies")).toBeNull();
  });

  it("drops control characters and empties", () => {
    expect(safeHref("/sup\nplies")).toBeNull();
    expect(safeHref("")).toBeNull();
    expect(safeHref(null)).toBeNull();
    expect(safeHref(undefined)).toBeNull();
  });

  it("trims before deciding, so leading space is not a bypass", () => {
    expect(safeHref("  /supplies  ")).toBe("/supplies");
    expect(safeHref("  https://evil.example")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

type Row = { user_id: string; location_id: string };

/**
 * Enough of the client surface for allowedTargets: one rpc and two shapes of
 * location_members read.
 */
function fakeAdmin(opts: { privileged: string[]; members: Row[] }) {
  return {
    rpc: async (_fn: string, args: { _user_id: string }) => ({
      data: opts.privileged.includes(args._user_id),
    }),
    from: () => ({
      select: () => ({
        eq: async (_col: string, value: string) => ({
          data: opts.members.filter((m) => m.user_id === value),
        }),
        in: (_col: string, locationIds: string[]) => ({
          in: async (_col2: string, userIds: string[]) => ({
            data: opts.members.filter(
              (m) => locationIds.includes(m.location_id) && userIds.includes(m.user_id),
            ),
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof allowedTargets>[0];
}

describe("allowedTargets", () => {
  const members: Row[] = [
    { user_id: "crew", location_id: "bk" },
    { user_id: "manager", location_id: "bk" },
    { user_id: "stranger", location_id: "qns" },
  ];

  it("always lets you notify yourself", async () => {
    const admin = fakeAdmin({ privileged: [], members: [] });
    expect(await allowedTargets(admin, "crew", ["crew"])).toEqual(["crew"]);
  });

  it("lets a crew member reach a manager at their own location", async () => {
    const admin = fakeAdmin({ privileged: [], members });
    expect(await allowedTargets(admin, "crew", ["manager"])).toEqual(["manager"]);
  });

  it("drops a user with no shared location", async () => {
    const admin = fakeAdmin({ privileged: [], members });
    expect(await allowedTargets(admin, "crew", ["stranger"])).toEqual([]);
  });

  it("keeps the reachable half of a mixed list", async () => {
    const admin = fakeAdmin({ privileged: [], members });
    const out = await allowedTargets(admin, "crew", ["crew", "manager", "stranger"]);
    expect(out.sort()).toEqual(["crew", "manager"]);
  });

  it("lets an owner/admin/dev reach anyone", async () => {
    const admin = fakeAdmin({ privileged: ["boss"], members });
    const out = await allowedTargets(admin, "boss", ["crew", "stranger"]);
    expect(out.sort()).toEqual(["crew", "stranger"]);
  });

  it("gives a caller with no location membership nobody but themselves", async () => {
    const admin = fakeAdmin({ privileged: [], members });
    expect(await allowedTargets(admin, "nomad", ["crew", "manager"])).toEqual([]);
    expect(await allowedTargets(admin, "nomad", ["nomad", "crew"])).toEqual(["nomad"]);
  });
});
