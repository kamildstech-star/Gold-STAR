import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  MAX_CREW_NAMES,
  crewNamesFromRows,
  crewPickList,
  fetchJobCrewList,
  parseCrewNames,
  saveJobCrewList,
} from "@/lib/job-crew-list";

/**
 * David, 12 Oct, on the crew sign-in sheet: the crew are hired labourers with
 * no system account, so "Add person" must not list every user. The office
 * uploads a CSV or Excel file of NAMES — just names, one per cell or row,
 * nothing else — and those names are the job's dropdown from then on. The only
 * system user on the sheet is the crew chief.
 */

describe("parseCrewNames — a names-only CSV", () => {
  it("reads one name per row", () => {
    expect(parseCrewNames("Juan Perez\nMaria Lopez\nAndre Smith").names).toEqual([
      "Juan Perez",
      "Maria Lopez",
      "Andre Smith",
    ]);
  });

  it("reads names spread across cells, in reading order", () => {
    expect(parseCrewNames("Juan Perez,Maria Lopez\nAndre Smith\tLi Wei").names).toEqual([
      "Juan Perez",
      "Maria Lopez",
      "Andre Smith",
      "Li Wei",
    ]);
  });

  it("drops blank rows, empty cells and trailing commas Excel leaves behind", () => {
    const csv = "Juan Perez,,\n\n,Maria Lopez,\n , \r\nAndre Smith,\r\n";
    expect(parseCrewNames(csv).names).toEqual(["Juan Perez", "Maria Lopez", "Andre Smith"]);
  });

  it("skips a header cell and numbers-only cells, and says how many", () => {
    const { names, skipped } = parseCrewNames("Name\nJuan Perez\n12\nMaria Lopez\n2026-10-12");
    expect(names).toEqual(["Juan Perez", "Maria Lopez"]);
    expect(skipped).toBe(3);
  });

  it("keeps a quoted name with a comma in it as one person", () => {
    expect(parseCrewNames('"Perez, Juan"\nMaria Lopez').names).toEqual([
      "Perez, Juan",
      "Maria Lopez",
    ]);
  });

  it("keeps each person once, whatever the case or spacing", () => {
    expect(parseCrewNames("Juan Perez\njuan  perez\n JUAN PEREZ ").names).toEqual(["Juan Perez"]);
  });

  it("ignores a byte-order mark from an Excel CSV export", () => {
    expect(parseCrewNames("\uFEFFJuan Perez\nMaria Lopez").names[0]).toBe("Juan Perez");
  });

  it("refuses an over-long cell as a note, not a person", () => {
    const { names, skipped } = parseCrewNames(`Juan Perez\n${"x".repeat(81)}`);
    expect(names).toEqual(["Juan Perez"]);
    expect(skipped).toBe(1);
  });

  it("stops at the cap rather than storing a whole wrong file", () => {
    const many = Array.from(
      { length: MAX_CREW_NAMES + 5 },
      (_, i) => `Person ${String.fromCharCode(65 + (i % 26))}${i}`,
    );
    const { names, skipped } = crewNamesFromRows(many.map((n) => [n]));
    expect(names).toHaveLength(MAX_CREW_NAMES);
    expect(skipped).toBe(5);
  });
});

describe("crewPickList — what Add person offers", () => {
  const assignments = [
    { userId: "u-chief", name: "Carlos Chief", role: "crew_chief" },
    { userId: "u-pm", name: "Pat Manager", role: "project_manager" },
    { userId: "u-tech", name: "Terry Tech", role: "technician" },
  ];

  it("is the crew chief, then the uploaded names — no other system users", () => {
    const list = crewPickList({
      assignments,
      crewChiefId: "u-chief",
      uploaded: ["Juan Perez", "Maria Lopez"],
    });
    expect(list).toEqual([
      { userId: "u-chief", name: "Carlos Chief" },
      { userId: null, name: "Juan Perez" },
      { userId: null, name: "Maria Lopez" },
    ]);
  });

  it("finds the chief from the job's crew_chief even when the role is different", () => {
    const list = crewPickList({ assignments, crewChiefId: "u-tech", uploaded: [] });
    expect(list.map((p) => p.name)).toEqual(["Carlos Chief", "Terry Tech"]);
  });

  it("keeps the chief once when the uploaded sheet lists them too", () => {
    const list = crewPickList({
      assignments,
      crewChiefId: "u-chief",
      uploaded: ["carlos chief", "Juan Perez"],
    });
    expect(list).toEqual([
      { userId: "u-chief", name: "Carlos Chief" },
      { userId: null, name: "Juan Perez" },
    ]);
  });

  it("is just the uploaded names on a job with no chief assigned", () => {
    expect(crewPickList({ assignments: [], crewChiefId: null, uploaded: ["Juan Perez"] })).toEqual([
      { userId: null, name: "Juan Perez" },
    ]);
  });
});

describe("the job's crew list in storage", () => {
  function fakeClient(answer: { data?: unknown; error?: unknown }) {
    const calls: { table: string; op: string; args: unknown[] }[] = [];
    const chain = {
      select: (...args: unknown[]) => (calls.push({ table: "", op: "select", args }), chain),
      eq: (...args: unknown[]) => (calls.push({ table: "", op: "eq", args }), chain),
      maybeSingle: async () => answer,
      upsert: async (...args: unknown[]) => (calls.push({ table: "", op: "upsert", args }), answer),
    };
    return {
      calls,
      client: {
        from: (table: string) => (calls.push({ table, op: "from", args: [] }), chain),
      } as never,
    };
  }

  it("reads the names attached to the job", async () => {
    const { client } = fakeClient({
      data: { names: ["Juan Perez", "Maria Lopez"], updated_at: "2026-10-12T12:00:00Z" },
      error: null,
    });
    expect(await fetchJobCrewList("job-1", client)).toEqual({
      available: true,
      names: ["Juan Perez", "Maria Lopez"],
      updatedAt: "2026-10-12T12:00:00Z",
    });
  });

  it("is an empty list, not an error, on a job with none uploaded", async () => {
    const { client } = fakeClient({ data: null, error: null });
    expect(await fetchJobCrewList("job-1", client)).toMatchObject({ available: true, names: [] });
  });

  it("says 'not yet' when the migration has not been applied", async () => {
    const { client } = fakeClient({
      data: null,
      error: { code: "PGRST205", message: "Could not find the table public.job_crew_lists" },
    });
    expect(await fetchJobCrewList("job-1", client)).toMatchObject({ available: false, names: [] });
  });

  it("an upload replaces the job's list, one row per job", async () => {
    const { client, calls } = fakeClient({ error: null });
    await saveJobCrewList("job-1", ["Juan Perez", " juan perez ", "Maria Lopez"], client);
    const upsert = calls.find((c) => c.op === "upsert")!;
    expect(calls[0]).toMatchObject({ table: "job_crew_lists", op: "from" });
    expect(upsert.args).toEqual([
      { job_id: "job-1", names: ["Juan Perez", "Maria Lopez"] },
      { onConflict: "job_id" },
    ]);
  });
});

describe("wiring", () => {
  const panel = readFileSync("src/components/tm-field-forms-panel.tsx", "utf8");
  const editor = readFileSync("src/components/tm-form-editors.tsx", "utf8");

  it("the sign-in sheet no longer reads every active user for Add person", () => {
    expect(panel).not.toMatch(/tm-forms-people/);
    expect(panel).toMatch(/crewPickList\(/);
    expect(editor).toMatch(/Add from crew list/);
  });

  it("the Field Form tab has the crew-list upload, CSV or Excel", () => {
    expect(panel).toMatch(/readCrewNamesFile\(/);
    expect(panel).toMatch(/accept="\.csv,\.txt,\.xlsx/);
  });

  it("the hotel / per diem box is a toggle, not a select", () => {
    expect(editor).not.toMatch(/LODGING_OPTIONS\.map/);
    expect(editor).toMatch(/aria-pressed=\{!!r\.lodging\}/);
  });

  it("the three sheets are small buttons in one row, not a tall list", () => {
    expect(panel).toMatch(/condensed \? "grid-cols-1 sm:max-w-xs" : "grid-cols-3"/);
    expect(panel).toMatch(/TM_FORM_META\[kind\]\.short/);
  });

  it("a filed sheet goes into its own job folder", () => {
    expect(panel).toMatch(/fileIntoJobFolder\(\{[\s\S]*folderName: meta\.folder/);
  });
});
