import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  INSURANCE_CRITICAL_FIELDS,
  insuranceRuleApplies,
  insuranceTaskTitle,
  missingInsuranceInfo,
} from "./insurance-info-task";

/**
 * David, 22 Sep: "if the insurance information is not filled out, a task
 * should automatically be generated for the office until the information is
 * put in. Meaning carrier, policy, claim, carrier adjuster, public adjuster...
 * You check off the task, those items are not filled in, you get another task."
 */
const complete = {
  job_type: "insurance",
  status: "in_progress",
  insurance_carrier: "State Farm",
  policy_number: "P-1",
  claim_number: "C-1",
  adjuster_name: "Pat Adjuster",
  public_adjuster_name: "Sam PA",
};

describe("which insurance details are missing", () => {
  it("names David's five, in his order", () => {
    expect(INSURANCE_CRITICAL_FIELDS.map((f) => f.label)).toEqual([
      "Carrier",
      "Policy #",
      "Claim #",
      "Carrier adjuster",
      "Public adjuster",
    ]);
    expect(missingInsuranceInfo({ job_type: "insurance", status: "new" })).toEqual([
      "Carrier",
      "Policy #",
      "Claim #",
      "Carrier adjuster",
      "Public adjuster",
    ]);
  });

  it("is satisfied by any column that holds the detail", () => {
    expect(missingInsuranceInfo(complete)).toEqual([]);
    expect(
      missingInsuranceInfo({
        ...complete,
        insurance_carrier: null,
        insurance_carrier_account_id: "acc",
        adjuster_name: null,
        field_adjuster_contact_id: "c1",
        public_adjuster_name: "  ",
        public_adjuster_account_id: "pa",
      }),
    ).toEqual([]);
  });

  it("treats blank text as missing", () => {
    expect(missingInsuranceInfo({ ...complete, claim_number: "   " })).toEqual(["Claim #"]);
  });

  it("applies only to open jobs typed insurance", () => {
    expect(insuranceRuleApplies({ job_type: "cash" })).toBe(false);
    expect(insuranceRuleApplies({ job_type: "undetermined" })).toBe(false);
    expect(insuranceRuleApplies({ job_type: "insurance", status: "paid" })).toBe(false);
    expect(insuranceRuleApplies({ job_type: "insurance", status: "cancelled" })).toBe(false);
    expect(missingInsuranceInfo({ job_type: "cash" })).toEqual([]);
  });

  it("titles the task with what is missing", () => {
    expect(insuranceTaskTitle(["Policy #", "Public adjuster"])).toBe(
      "Insurance info missing: Policy #, Public adjuster",
    );
  });
});

const SQL = readFileSync(
  "supabase/migrations/20260926120000_insurance_info_task.sql",
  "utf8",
).replace(/\r\n/g, "\n");

describe("the database keeps the task, idempotently", () => {
  it("checks the same columns the screen stars", () => {
    const fn = SQL.match(
      /CREATE OR REPLACE FUNCTION public\.insurance_info_missing[\s\S]*?\n\$\$;/,
    )![0];
    for (const f of INSURANCE_CRITICAL_FIELDS) {
      expect(fn, f.label).toContain(`THEN '${f.label}' END`);
      for (const c of f.columns) expect(fn, `${f.label}: ${c}`).toContain(`j.${c}`);
    }
    expect(fn).toContain(
      "WHEN j.job_type IS DISTINCT FROM 'insurance' OR j.status IN ('paid', 'cancelled')",
    );
  });

  it("allows one open task per job, by index, and inserts against it", () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open_insurance_info_per_job\s+ON public\.tasks \(job_id\)\s+WHERE source = 'insurance_info_missing' AND status IN \('open', 'in_progress'\);/,
    );
    expect(SQL).toMatch(
      /ON CONFLICT \(job_id\)\s+WHERE source = 'insurance_info_missing' AND status IN \('open', 'in_progress'\)\s+DO NOTHING;/,
    );
  });

  it("updates the text as fields are filled, and closes itself when all five are in", () => {
    const fn = SQL.match(
      /CREATE OR REPLACE FUNCTION public\.sync_insurance_info_task[\s\S]*?\n\$\$;/,
    )![0];
    expect(fn).toContain(
      "UPDATE public.tasks SET title = _title, updated_at = now() WHERE id = open_task.id;",
    );
    expect(fn).toContain("THEN 'done'::public.task_status");
    expect(fn).toContain("_title := 'Insurance info missing: ' || array_to_string(missing, ', ');");
  });

  it("re-evaluates on the five fields and daily — not on the checkbox", () => {
    const trg = SQL.match(/CREATE TRIGGER jobs_insurance_info_task[\s\S]*?;/)![0];
    expect(trg).toContain("ON public.jobs");
    expect(trg).toContain("policy_number, claim_number, adjuster_name");
    // The job page writes stage_id; status follows in a BEFORE trigger.
    expect(trg).toContain("job_type, status, stage_id,");
    expect(SQL).not.toMatch(/CREATE TRIGGER \w+\s+AFTER[^;]*ON public\.tasks/);
    expect(SQL).toContain("$cron$SELECT public.sweep_insurance_info_tasks();$cron$");
  });

  it("lets nobody call the definer functions directly", () => {
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public.sync_insurance_info_task(uuid) FROM PUBLIC, anon, authenticated;",
    );
    expect(SQL).toContain(
      "REVOKE ALL ON FUNCTION public.sweep_insurance_info_tasks() FROM PUBLIC, anon, authenticated;",
    );
  });
});

describe("the job form shows why the task exists", () => {
  const PAGE = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
  it("stars the five on insurance jobs and names what is missing", () => {
    for (const label of ['star("Carrier")', 'star("Policy #")', 'star("Claim #")']) {
      expect(PAGE).toContain(`label={${label}}`);
    }
    expect(PAGE).toContain('<PartyGroup title={star("Carrier adjuster")}>');
    expect(PAGE).toContain('<PartyGroup title={star("Public adjuster (for the insured)")}>');
    expect(PAGE).toContain("An office task stays open until all five are filled in.");
  });
});
