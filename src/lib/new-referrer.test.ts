import { describe, expect, it, vi } from "vitest";

import type { PickedCustomer } from "@/components/customer-picker";
import { dealProblem, finishNewReferrer, payeeOf, type NewReferrerDeps } from "@/lib/new-referrer";

/**
 * Mark, 7 Oct: "and allow them to create a new person on the general tab as
 * well with a commission rate". The person is created by the CRM's own
 * dialog; this is what happens next — the deal, then the job — and what a
 * user who may add contacts but not set rates is told.
 */

const person = (over: Partial<PickedCustomer> = {}): PickedCustomer => ({
  kind: "person",
  contactId: "c-new",
  name: "Jane Broker",
  title: null,
  accountId: "a-acme",
  accountName: "Acme",
  accountLocationId: null,
  phone: null,
  email: null,
  methods: [],
  ...over,
});

const deps = (over: Partial<NewReferrerDeps> = {}) => {
  const calls: string[] = [];
  const d: NewReferrerDeps = {
    insertRule: vi.fn(async () => {
      calls.push("rule");
    }),
    saveJobReferral: vi.fn(async () => {
      calls.push("job");
    }),
    overlapMessage: (e) => ((e as { code?: string })?.code === "23P01" ? "overlap" : null),
    isMissingSchema: (e) => (e as { code?: string })?.code === "PGRST205",
    ...over,
  };
  return { d, calls };
};

describe("a new referrer with a rate", () => {
  it("writes the person's deal, then picks them (and their company) on the job", async () => {
    const { d, calls } = deps();
    const out = await finishNewReferrer(person(), { kind: "percent", value: 12 }, true, d);
    expect(calls).toEqual(["rule", "job"]);
    expect(d.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({
        payee: { type: "contact", id: "c-new" },
        kind: "percent",
        value: 12,
      }),
    );
    expect(d.saveJobReferral).toHaveBeenCalledWith({
      accountId: "a-acme",
      contactId: "c-new",
      name: "Jane Broker",
    });
    expect(out.rule).toBe("written");
    expect(out.message).toContain("12% of revenue");
  });

  it("a new company gets the deal itself", async () => {
    const { d } = deps();
    const company = person({ kind: "company", contactId: null, name: "Acme" });
    await finishNewReferrer(company, { kind: "flat", value: 500 }, true, d);
    expect(d.insertRule).toHaveBeenCalledWith(
      expect.objectContaining({
        payee: { type: "account", id: "a-acme" },
        kind: "flat",
        value: 500,
      }),
    );
  });

  it("no rate given: just the referrer", async () => {
    const { d, calls } = deps();
    const out = await finishNewReferrer(person(), { kind: "percent", value: null }, true, d);
    expect(calls).toEqual(["job"]);
    expect(out.rule).toBe("none_given");
  });
});

describe("someone who can add a contact but not set rates", () => {
  it("gets the referrer created and picked, and is told the rate needs an admin", async () => {
    const { d, calls } = deps();
    const out = await finishNewReferrer(person(), { kind: "percent", value: 12 }, false, d);
    expect(calls).toEqual(["job"]);
    expect(d.insertRule).not.toHaveBeenCalled();
    expect(out.rule).toBe("needs_admin");
    expect(out.message).toMatch(/owner or admin/);
  });
});

describe("a rate that does not stick never loses the referrer", () => {
  it("an existing person who already has a deal keeps theirs", async () => {
    const { d, calls } = deps({
      insertRule: vi.fn(async () => {
        throw { code: "23P01" };
      }),
    });
    const out = await finishNewReferrer(person(), { kind: "percent", value: 12 }, true, d);
    expect(calls).toEqual(["job"]);
    expect(out.rule).toBe("already_has_one");
  });

  it("before the migration, says the rate was not saved", async () => {
    const { d } = deps({
      insertRule: vi.fn(async () => {
        throw { code: "PGRST205" };
      }),
    });
    const out = await finishNewReferrer(person(), { kind: "flat", value: 100 }, true, d);
    expect(out.rule).toBe("not_migrated");
    expect(d.saveJobReferral).toHaveBeenCalled();
  });

  it("any other refusal still picks the referrer and says so", async () => {
    const { d } = deps({
      insertRule: vi.fn(async () => {
        throw { code: "42501" };
      }),
    });
    const out = await finishNewReferrer(person(), { kind: "flat", value: 100 }, true, d);
    expect(out.rule).toBe("failed");
    expect(d.saveJobReferral).toHaveBeenCalled();
  });

  it("a failed job save is the caller's error", async () => {
    const { d } = deps({
      saveJobReferral: vi.fn(async () => {
        throw new Error("denied");
      }),
    });
    await expect(
      finishNewReferrer(person(), { kind: "percent", value: null }, true, d),
    ).rejects.toThrow("denied");
  });
});

describe("the deal fields", () => {
  it("refuse a percent over 100 or a negative value, and allow blank", () => {
    expect(dealProblem({ kind: "percent", value: 120 })).toMatch(/between 0 and 100/);
    expect(dealProblem({ kind: "flat", value: -5 })).toMatch(/negative/);
    expect(dealProblem({ kind: "flat", value: 2500 })).toBeNull();
    expect(dealProblem({ kind: "percent", value: null })).toBeNull();
  });

  it("the payee is the person, else the company", () => {
    expect(payeeOf(person())).toEqual({ type: "contact", id: "c-new" });
    expect(payeeOf(person({ contactId: null }))).toEqual({ type: "account", id: "a-acme" });
    expect(payeeOf(person({ contactId: null, accountId: null }))).toBeNull();
  });
});
