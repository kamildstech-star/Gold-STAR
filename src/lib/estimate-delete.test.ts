import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { NO_DELETE, canOfferDelete } from "@/lib/estimate-delete";

/**
 * Mark, 2026-10-06, of an empty ESTIMATE-2 draft on a job's Billing tab: "add
 * a delete button here" — and, in the same message, "in timeline have a
 * restore button for each item that gets removed or changed".
 *
 * The behaviour of the SQL is proved in supabase/tests/estimate-delete.pglite.mjs;
 * this file pins the wiring and guards the copy of #300's functions.
 */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const MINE = read("supabase/migrations/20261006163000_estimate_delete.sql");
const RESTORE = read("supabase/migrations/20261006150000_record_history.sql");
const LIB = read("src/lib/estimate-delete.ts");
const PANEL = read("src/components/job-billing-panel.tsx");

const fn = (sql: string, name: string) => {
  const m = sql.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;\\n`),
  );
  if (!m) throw new Error(`${name} not found`);
  return m[0];
};

/** This migration's text for a function, minus exactly what it adds. */
const withoutCalculations = (body: string) =>
  body
    .replace(/ *-- job_calculations: begin\n[\s\S]*? *-- job_calculations: end\n/g, "")
    .replace(/, 'job_calculations'/g, "");

describe("Quick Estimates join #300's record_history by its own procedure", () => {
  const COPIED = [
    "record_history_capture",
    "record_history_may_restore",
    "record_history_display",
    "record_history_state",
    "record_history_reinsert",
    "restore_record_history",
  ];

  it.each(COPIED)("%s is #300's text plus the job_calculations lines, nothing else", (name) => {
    // If #300's function changes, this fails until the copy here is
    // regenerated — a later migration must never quietly undo it.
    expect(withoutCalculations(fn(MINE, name))).toBe(fn(RESTORE, name));
    expect(fn(MINE, name)).toContain("job_calculations");
  });

  it("allows the table in the CHECK and attaches the trigger for deletes only", () => {
    expect(MINE).toMatch(
      /ADD CONSTRAINT record_history_table_allowed CHECK \(table_name IN \([\s\S]*'job_calculations'\s*\)\);/,
    );
    expect(MINE).toMatch(
      /CREATE TRIGGER "A_record_history" AFTER DELETE ON public\.job_calculations\s+FOR EACH ROW EXECUTE FUNCTION public\.record_history_capture\(\);/,
    );
  });

  it("restores under job_calculations_delete, restated", () => {
    const branch = fn(MINE, "record_history_may_restore").match(
      /WHEN 'job_calculations' THEN[\s\S]*?\);/,
    )![0];
    expect(branch).toContain("_op = 'delete'");
    expect(branch).toContain("public.can_manage_location(_uid, (_row ->> 'location_id')::uuid)");
    expect(branch).toContain("(_row ->> 'created_by')::uuid IS NOT DISTINCT FROM _uid");
  });

  it("never shows the sheet's price on the Timeline", () => {
    const branch = fn(MINE, "record_history_display").match(
      /WHEN 'job_calculations' THEN jsonb_build_object\([\s\S]*?'date', _image -> 'job_date'\)/,
    )![0];
    expect(branch).not.toMatch(/customer_price|internal_cost|profit/);
  });
});

describe("an invoiced estimate cannot be deleted", () => {
  it("is refused by a BEFORE DELETE trigger on both tables", () => {
    expect(MINE).toMatch(
      /CREATE TRIGGER estimates_refuse_invoiced_delete BEFORE DELETE ON public\.estimates/,
    );
    expect(MINE).toMatch(
      /CREATE TRIGGER job_calculations_refuse_invoiced_delete BEFORE DELETE ON public\.job_calculations/,
    );
    const guard = fn(MINE, "refuse_deleting_invoiced_estimate");
    expect(guard).toContain("SECURITY DEFINER");
    expect(guard).toContain("WHERE i.estimate_id = OLD.id");
    // A whole job going is not refused.
    expect(guard).toMatch(/NOT EXISTS \(SELECT 1 FROM public\.jobs j WHERE j\.id = OLD\.job_id\)/);
  });
});

describe("Delete is offered only where it can be undone", () => {
  it("asks the database, and is closed to anon", () => {
    expect(MINE).toContain(
      "REVOKE ALL ON FUNCTION public.record_history_covers(text) FROM PUBLIC, anon;",
    );
    expect(MINE).toContain(
      "GRANT EXECUTE ON FUNCTION public.record_history_covers(text) TO authenticated, service_role;",
    );
    expect(fn(MINE, "record_history_covers")).toContain("t.tgname = 'A_record_history'");
    expect(LIB).toContain('"record_history_covers"');
  });

  it("offers it per kind, never on an invoiced row, and never without support", () => {
    const both = { estimate: true, calculator: true };
    expect(canOfferDelete("estimate", both, false)).toBe(true);
    expect(canOfferDelete("calculator", both, false)).toBe(true);
    expect(canOfferDelete("estimate", both, true)).toBe(false);
    expect(canOfferDelete("calculator", { estimate: true, calculator: false }, false)).toBe(false);
    expect(canOfferDelete("estimate", NO_DELETE, false)).toBe(false);
  });

  it("is a plain DELETE, as #300's convention says — no deleted_at", () => {
    const del = LIB.match(/export async function deleteEstimateRow[\s\S]*?\n}\n/)![0];
    expect(del).toContain(".delete()");
    // RLS refuses by deleting nothing; that must not read as success.
    expect(del).toContain('.select("id")');
    expect(del).toContain("if (!data?.length)");
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code(LIB)).not.toContain("deleted_at");
    expect(MINE.replace(/--.*$/gm, "")).not.toContain("deleted_at");
  });
});

describe("the Billing tab's Delete", () => {
  const body = PANEL.match(/const removeEstimate = \([\s\S]*?\n {2}};\n/)![0];

  it("hides the row at once and offers Undo before anything is sent", () => {
    expect(body).toContain("setRemoving(");
    expect(body).toContain("undoableDelete({");
    expect(body).toContain('label: "Undo"');
    expect(body).toContain("deleteEstimateRow(kind, row.id)");
  });

  it("closes the open editor if it was the one deleted", () => {
    expect(body).toContain(
      'if (kind === "estimate" && openEstimateId === row.id) setOpenEstimateId(null);',
    );
  });

  it("refreshes the list and the Timeline after the delete is sent", () => {
    expect(body).toContain("await load();");
    expect(body).toContain('queryKey: ["record-history", jobId]');
    expect(body).toContain('queryKey: ["billing-estimates"]');
  });

  it("passes the database's answer and the handler to the list", () => {
    const list = PANEL.match(/<EstimatesRailList[\s\S]*?\/>/)![0];
    expect(list).toContain("deleteSupport={deleteSupport}");
    expect(list).toContain("onDelete={removeEstimate}");
    expect(list).toContain("!removing.has(r.key)");
  });
});
