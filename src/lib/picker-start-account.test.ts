import { describe, expect, it } from "vitest";

import { JOB_FIELDS, pickerStartAccountId } from "@/lib/job-fields";

/**
 * Mark, 2026-09-09, on a job's Customer card: "main point of contgact is not
 * working properyl and not pulling int he contacts."
 *
 * The card showed the account as Rockland Estates Management and the main
 * point of contact as a dash. Opening the picker offered nobody, because the
 * picker only fetches contacts once a company is chosen and nothing chose one
 * — so the job named a company, and the field that asks "who at that company"
 * started from nothing.
 */
const job = {
  id: "job-1",
  account_id: "rockland",
  referred_by_account_id: "sunset-brokers",
};

const def = (key: string) => {
  const found = JOB_FIELDS.find((f) => f.key === key);
  expect(found, `no job field called ${key}`).toBeTruthy();
  return found!;
};

describe("which company a person-picker on a job opens on", () => {
  it("starts on the job's own company", () => {
    expect(pickerStartAccountId(def("primary_contact_id"), job)).toBe("rockland");
  });

  it("starts a referral on the company that referred, not the customer", () => {
    // The person who sent the work is by definition somewhere else.
    expect(pickerStartAccountId(def("referred_by_contact_id"), job)).toBe("sunset-brokers");
  });

  it("asks when the job names no company", () => {
    expect(pickerStartAccountId(def("primary_contact_id"), { id: "job-2" })).toBeNull();
    expect(pickerStartAccountId(def("primary_contact_id"), { account_id: null })).toBeNull();
    expect(pickerStartAccountId(def("primary_contact_id"), { account_id: "" })).toBeNull();
  });

  it("leaves every other kind of field alone", () => {
    // Only a person-picker has a company to start from. An account field is
    // choosing the company itself, and the rest are not people at all.
    for (const f of JOB_FIELDS.filter((f) => f.kind !== "contact")) {
      expect(pickerStartAccountId(f, job), f.key).toBeNull();
    }
  });

  it("ignores a company id that is not a string", () => {
    expect(pickerStartAccountId(def("primary_contact_id"), { account_id: 42 })).toBeNull();
  });
});
