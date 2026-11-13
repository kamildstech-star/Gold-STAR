import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  rows: [] as { id: string; role: string; account_id: string | null; full_name: string | null }[],
  deleted: [] as string[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: async (_col: string, role: string) => ({
            data: db.rows.filter((r) => r.role === role),
            error: null,
          }),
        }),
      }),
      delete: () => ({
        in: async (_col: string, ids: string[]) => {
          db.deleted.push(...ids);
          return { error: null };
        },
      }),
    }),
  },
}));

import { removeFormerCustomerContacts } from "./job-relationships";

/* 4 Nov: one customer per job — a new Account replaces the old customer. */
describe("removeFormerCustomerContacts", () => {
  beforeEach(() => {
    db.deleted = [];
    db.rows = [
      { id: "old-co", role: "customer", account_id: "acct-old", full_name: "Beacon Hill" },
      { id: "old-person", role: "customer", account_id: "acct-old", full_name: "Gina Alvarez" },
      { id: "typed", role: "customer", account_id: null, full_name: "beacon  hill" },
      { id: "new-co", role: "customer", account_id: "acct-new", full_name: "Ellerbe Court" },
      { id: "hand-typed", role: "customer", account_id: null, full_name: "Someone Else" },
      { id: "adjuster", role: "desk_adjuster", account_id: "acct-old", full_name: "Pat" },
    ];
  });

  it("removes the old account's customers and the old typed name, nobody else", async () => {
    const n = await removeFormerCustomerContacts("job-1", {
      accountId: "acct-old",
      customerName: "Beacon Hill",
    });
    expect(n).toBe(3);
    expect(db.deleted.sort()).toEqual(["old-co", "old-person", "typed"]);
  });

  it("does nothing when there was no customer before", async () => {
    const n = await removeFormerCustomerContacts("job-1", { accountId: null, customerName: null });
    expect(n).toBe(0);
    expect(db.deleted).toEqual([]);
  });
});
