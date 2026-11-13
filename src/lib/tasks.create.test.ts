import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A task with a NULL `location_id` is invisible to management.
 *
 * The RLS policy `tasks visible in scope` (20260804184212) reads:
 *
 *   assignee = auth.uid()
 *   OR created_by = auth.uid()
 *   OR (location_id IS NOT NULL AND can_view_location(auth.uid(), location_id))
 *
 * so a row with no office can be selected by exactly two people and by no
 * manager at any level. Nothing deletes it and no query in the app filters it
 * out — it is simply unselectable, which is why it was reported as tasks
 * "vanishing". Every creation path therefore has to put an office on the row,
 * and this is the proof that the one shared helper does.
 */

const from = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from } }));

import { createTask, pickTaskLocationId, resolveTaskLocationId } from "./tasks";

/** The last payload handed to `.insert()`, whatever table it was for. */
let inserted: Record<string, unknown> | null = null;

/**
 * Enough of the PostgREST builder for these paths: a `profiles` read, a
 * `location_members` read and the `tasks` insert.
 */
function mockSupabase(options: {
  primaryLocationId?: string | null;
  membershipLocationIds?: string[];
}) {
  inserted = null;
  from.mockReset();
  from.mockImplementation((table: string) => {
    if (table === "profiles") {
      const row = { primary_location_id: options.primaryLocationId ?? null };
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return builder;
    }
    if (table === "location_members") {
      const rows = (options.membershipLocationIds ?? []).map((location_id) => ({ location_id }));
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: async () => ({ data: rows, error: null }),
      };
      return builder;
    }
    if (table === "tasks") {
      return {
        insert: (payload: Record<string, unknown>) => {
          inserted = payload;
          return {
            select: () => ({ single: async () => ({ data: { id: "task-1" }, error: null }) }),
          };
        },
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

const BASE = {
  title: "Call the adjuster",
  assignee: "user-1",
  dueDate: "2026-09-20",
  createdBy: "user-1",
};

describe("pickTaskLocationId", () => {
  it("prefers the office the caller named", () => {
    expect(
      pickTaskLocationId({
        explicit: "explicit-office",
        primaryLocationId: "primary-office",
        membershipLocationIds: ["member-office"],
      }),
    ).toBe("explicit-office");
  });

  it("falls back to the creator's primary office", () => {
    expect(
      pickTaskLocationId({
        explicit: null,
        primaryLocationId: "primary-office",
        membershipLocationIds: ["member-office"],
      }),
    ).toBe("primary-office");
  });

  it("falls back again to any office the creator belongs to", () => {
    expect(
      pickTaskLocationId({
        explicit: null,
        primaryLocationId: null,
        membershipLocationIds: ["member-office"],
      }),
    ).toBe("member-office");
  });

  it("only answers null when the creator belongs to nothing", () => {
    expect(
      pickTaskLocationId({ explicit: null, primaryLocationId: null, membershipLocationIds: [] }),
    ).toBeNull();
  });
});

describe("resolveTaskLocationId", () => {
  it("does not read the profile when an office was supplied", async () => {
    mockSupabase({ primaryLocationId: "primary-office" });
    await expect(resolveTaskLocationId("explicit-office", "user-1")).resolves.toBe(
      "explicit-office",
    );
    expect(from).not.toHaveBeenCalled();
  });

  it("reads the creator's office when one was not", async () => {
    mockSupabase({ primaryLocationId: "primary-office" });
    await expect(resolveTaskLocationId(null, "user-1")).resolves.toBe("primary-office");
  });
});

describe("every task created through the shared helper carries an office", () => {
  beforeEach(() => {
    inserted = null;
  });

  it("writes the office the caller named", async () => {
    mockSupabase({ primaryLocationId: "primary-office" });
    await createTask({ ...BASE, link: { locationId: "explicit-office" } });
    expect(inserted).not.toBeNull();
    expect(inserted!.location_id).toBe("explicit-office");
  });

  /* The regression. Every one of these reached the insert as `?? null`. */
  for (const [name, link] of [
    ["no link at all", undefined],
    ["a link with no office", { accountId: "account-1" }],
    ["a link whose office is explicitly null", { accountId: "account-1", locationId: null }],
  ] as const) {
    it(`still writes an office given ${name}`, async () => {
      mockSupabase({ primaryLocationId: "primary-office" });
      await createTask({ ...BASE, link });
      expect(inserted).not.toBeNull();
      expect(inserted!.location_id).toBe("primary-office");
    });
  }

  it("uses a membership when the profile names no primary office", async () => {
    mockSupabase({ primaryLocationId: null, membershipLocationIds: ["member-office"] });
    await createTask({ ...BASE, link: { locationId: null } });
    expect(inserted!.location_id).toBe("member-office");
  });

  it("still records the task, and says so, when the creator has no office", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockSupabase({ primaryLocationId: null, membershipLocationIds: [] });

    // Refusing to record somebody's work because their profile is incomplete
    // would be the worse failure, so the row is written and reported.
    await createTask({ ...BASE, link: { locationId: null } });

    expect(inserted).not.toBeNull();
    expect(inserted!.location_id).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
