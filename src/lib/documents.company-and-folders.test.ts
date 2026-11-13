import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  COMPANY_DOCUMENT_TYPES,
  authorizationFolderId,
  ensureJobFolder,
  folderContainer,
  WORK_AUTHORIZATION_FOLDER,
  fileIntoJobFolder,
  isCompanyDocument,
  type DocumentFolder,
  type DocumentScope,
} from "@/lib/documents";
import { ensureTmJobFolders, TM_FORM_KINDS, TM_FORM_META } from "@/lib/tm-forms";

/**
 * David, 12 Oct, on document organisation:
 *  - sign-in sheets, supply lists and field forms arrive every day of a job,
 *    so each gets its own job folder — made the first time one is saved — and
 *    each day's PDF is filed into it automatically;
 *  - the main Documents section is COMPANY-WIDE papers only (COI, W-9,
 *    contracts, client and tenant forms), not job files; a job can still pull
 *    a company document in.
 */

const JOB_SCOPE: DocumentScope = { locationId: "loc-1", jobId: "job-1", accountId: "acc-1" };

function folder(id: string, name: string, parent: string | null = null): DocumentFolder {
  return {
    id,
    location_id: "loc-1",
    job_id: "job-1",
    account_id: null,
    project_id: null,
    name,
    parent_folder_id: parent,
    sort_order: 0,
    created_at: "2026-10-12T00:00:00Z",
  };
}

/** An in-memory folder store with the same three calls the app makes. */
function store(initial: DocumentFolder[] | null) {
  let folders = initial;
  const moved: [string, string | null][] = [];
  let made = 0;
  return {
    moved,
    get folders() {
      return folders;
    },
    deps: {
      list: vi.fn(async () => folders),
      create: vi.fn(async (input: { name: string; parentFolderId: string | null }) => {
        const f = folder(`new-${++made}`, input.name.trim(), input.parentFolderId);
        folders = [...(folders ?? []), f];
        return f;
      }),
      move: vi.fn(async (doc: string, f: string | null) => {
        moved.push([doc, f]);
      }),
      rename: vi.fn(async (id: string, name: string) => {
        folders = (folders ?? []).map((f) => (f.id === id ? { ...f, name: name.trim() } : f));
      }),
    },
  };
}

describe("each recurring sheet has its job folder", () => {
  it("names the three folders for their purpose — David, 20 Oct", () => {
    expect(TM_FORM_KINDS.map((k) => TM_FORM_META[k].folder)).toEqual([
      "Daily Sign-In",
      "Daily Crew Chief",
      "Daily Supply List",
    ]);
  });

  it("remembers the names they had before, so old folders are renamed, not doubled", () => {
    expect(TM_FORM_KINDS.map((k) => TM_FORM_META[k].formerFolders)).toEqual([
      ["Sign-in sheets"],
      ["Field forms"],
      ["Supply lists"],
    ]);
  });
});

describe("ensureJobFolder / fileIntoJobFolder — auto-created, then reused", () => {
  it("creates the folder the first time a sheet is filed, and files the sheet into it", async () => {
    const s = store([]);
    const landed = await fileIntoJobFolder(
      { documentId: "doc-mon", scope: JOB_SCOPE, folderName: "Sign-in sheets", userId: "u1" },
      s.deps,
    );
    expect(landed?.name).toBe("Sign-in sheets");
    expect(s.deps.create).toHaveBeenCalledTimes(1);
    expect(s.deps.create.mock.calls[0]![0]).toMatchObject({
      scope: JOB_SCOPE,
      name: "Sign-in sheets",
      parentFolderId: null,
    });
    expect(s.moved).toEqual([["doc-mon", landed!.id]]);
  });

  it("files the next day's sheet into the same folder rather than making another", async () => {
    const s = store([]);
    const input = { scope: JOB_SCOPE, folderName: "Supply lists", userId: "u1" };
    const mon = await fileIntoJobFolder({ ...input, documentId: "doc-mon" }, s.deps);
    const tue = await fileIntoJobFolder({ ...input, documentId: "doc-tue" }, s.deps);
    expect(s.deps.create).toHaveBeenCalledTimes(1);
    expect(tue!.id).toBe(mon!.id);
    expect(s.moved).toEqual([
      ["doc-mon", mon!.id],
      ["doc-tue", mon!.id],
    ]);
  });

  it("keeps the three kinds apart", async () => {
    const s = store([]);
    for (const k of TM_FORM_KINDS) {
      await fileIntoJobFolder(
        {
          documentId: `doc-${k}`,
          scope: JOB_SCOPE,
          folderName: TM_FORM_META[k].folder,
          userId: null,
        },
        s.deps,
      );
    }
    expect(s.folders!.map((f) => f.name).sort()).toEqual([
      "Daily Crew Chief",
      "Daily Sign-In",
      "Daily Supply List",
    ]);
  });

  it("adopts a top-level folder somebody already made by hand, in any case", async () => {
    const s = store([folder("mine", "sign-in SHEETS")]);
    const f = await ensureJobFolder(
      { scope: JOB_SCOPE, name: "Sign-in sheets", userId: null },
      s.deps,
    );
    expect(f?.id).toBe("mine");
    expect(s.deps.create).not.toHaveBeenCalled();
  });

  it("does not mistake a sub-folder of the same name for the top-level one", async () => {
    const s = store([folder("parent", "Archive"), folder("nested", "Supply lists", "parent")]);
    const f = await ensureJobFolder(
      { scope: JOB_SCOPE, name: "Supply lists", userId: null },
      s.deps,
    );
    expect(f?.id).not.toBe("nested");
    expect(s.deps.create).toHaveBeenCalledTimes(1);
  });

  it("leaves the document at the top level when folders are not migrated", async () => {
    const s = store(null);
    const landed = await fileIntoJobFolder(
      { documentId: "doc-1", scope: JOB_SCOPE, folderName: "Field forms", userId: null },
      s.deps,
    );
    expect(landed).toBeNull();
    expect(s.deps.create).not.toHaveBeenCalled();
    expect(s.moved).toEqual([]);
  });

  it("never throws: the PDF is already saved, filing is tidiness", async () => {
    const s = store([]);
    s.deps.move.mockRejectedValueOnce(new Error("permission denied"));
    await expect(
      fileIntoJobFolder(
        { documentId: "doc-1", scope: JOB_SCOPE, folderName: "Field forms", userId: null },
        s.deps,
      ),
    ).resolves.toBeNull();
  });
});

describe("company-wide vs job documents", () => {
  it("a document on no job and no photo project is company-wide", () => {
    expect(isCompanyDocument({ job_id: null, project_id: null })).toBe(true);
  });

  it("a vendor COI or client contract held on an account is still company paperwork", () => {
    expect(isCompanyDocument({ job_id: null, project_id: null, account_id: "acc-1" })).toBe(true);
  });

  it("a job's document is not", () => {
    expect(isCompanyDocument({ job_id: "job-1", project_id: null })).toBe(false);
  });

  it("a photo project's document is not", () => {
    expect(isCompanyDocument({ job_id: null, project_id: "proj-1" })).toBe(false);
  });

  it("offers the company paperwork types first", () => {
    expect(COMPANY_DOCUMENT_TYPES).toEqual(expect.arrayContaining(["coi", "w9", "contract"]));
  });

  it("the Documents page reads company documents only", () => {
    const page = readFileSync("src/routes/_authenticated/documents.index.tsx", "utf8");
    expect(page).toMatch(/\.is\("job_id", null\)\.is\("project_id", null\)/);
  });

  it("the location scope (that page's folder rail) no longer reaches job folders", () => {
    const lib = readFileSync("src/lib/documents.ts", "utf8");
    const scopeFn = lib.slice(
      lib.indexOf("function scopeQuery"),
      lib.indexOf("export function isCompanyDocument"),
    );
    expect(scopeFn).toMatch(
      /\.eq\("location_id", scope\.locationId\)\s*\.is\("job_id", null\)\s*\.is\("project_id", null\)/,
    );
  });

  it("a job's documents panel can pull a company document in", () => {
    const panel = readFileSync("src/components/documents-panel.tsx", "utf8");
    expect(panel).toMatch(/From company documents/);
    expect(panel).toMatch(/<CompanyDocumentPicker/);
    const picker = readFileSync("src/components/company-document-picker.tsx", "utf8");
    expect(picker).toMatch(/copyCompanyDocumentToJob\(/);
  });
});

describe("T&M jobs get all three folders — David, 20 Oct", () => {
  it("makes the three on a job that has none", async () => {
    const s = store([]);
    await ensureTmJobFolders(JOB_SCOPE, "u1", (input) => ensureJobFolder(input, s.deps));
    expect(s.folders!.map((f) => f.name)).toEqual([
      "Daily Sign-In",
      "Daily Crew Chief",
      "Daily Supply List",
    ]);
    // A second view changes nothing.
    await ensureTmJobFolders(JOB_SCOPE, "u1", (input) => ensureJobFolder(input, s.deps));
    expect(s.deps.create).toHaveBeenCalledTimes(3);
  });

  it("renames the old folders in place, so the PDFs already filed stay in them", async () => {
    const s = store([folder("old-si", "Sign-in sheets"), folder("old-ff", "Field forms")]);
    await ensureTmJobFolders(JOB_SCOPE, "u1", (input) => ensureJobFolder(input, s.deps));
    expect(s.deps.rename.mock.calls).toEqual([
      ["old-si", "Daily Sign-In"],
      ["old-ff", "Daily Crew Chief"],
    ]);
    expect(s.deps.create).toHaveBeenCalledTimes(1);
    expect(s.folders!.find((f) => f.id === "old-si")?.name).toBe("Daily Sign-In");
    expect(s.folders!.map((f) => f.name).sort()).toEqual([
      "Daily Crew Chief",
      "Daily Sign-In",
      "Daily Supply List",
    ]);
  });

  it("a day's sheet filed after the rename lands in the renamed folder", async () => {
    const s = store([folder("old-sl", "supply LISTS")]);
    const meta = TM_FORM_META.supply_list;
    const landed = await fileIntoJobFolder(
      {
        documentId: "doc-wed",
        scope: JOB_SCOPE,
        folderName: meta.folder,
        folderAliases: meta.formerFolders,
        userId: "u1",
      },
      s.deps,
    );
    expect(landed).toMatchObject({ id: "old-sl", name: "Daily Supply List" });
    expect(s.moved).toEqual([["doc-wed", "old-sl"]]);
    expect(s.deps.create).not.toHaveBeenCalled();
  });

  it("prefers a folder that already has the new name over an old-named one", async () => {
    const s = store([folder("old", "Sign-in sheets"), folder("new", "Daily Sign-In")]);
    const f = await ensureJobFolder(
      { scope: JOB_SCOPE, name: "Daily Sign-In", userId: null, aliases: ["Sign-in sheets"] },
      s.deps,
    );
    expect(f?.id).toBe("new");
    expect(s.deps.rename).not.toHaveBeenCalled();
  });

  it("still files into the old folder when the rename is refused", async () => {
    const s = store([folder("old", "Field forms")]);
    s.deps.rename.mockRejectedValueOnce(new Error("permission denied"));
    const f = await ensureJobFolder(
      { scope: JOB_SCOPE, name: "Daily Crew Chief", userId: null, aliases: ["Field forms"] },
      s.deps,
    );
    expect(f?.id).toBe("old");
    expect(s.deps.create).not.toHaveBeenCalled();
  });

  it("is run by the Documents panel on a T&M job, before the folders are listed", () => {
    const panel = readFileSync("src/components/documents-panel.tsx", "utf8");
    const page = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
    expect(panel.indexOf("ensureTmJobFolders(scope")).toBeGreaterThan(-1);
    expect(panel.indexOf("ensureTmJobFolders(scope")).toBeLessThan(
      panel.indexOf("await listDocumentFolders(scope)"),
    );
    expect(page).toContain("tmJob={isTmJob(job.job_type)}");
  });
});

describe("folderContainer — one container per folder (document_folders_one_scope)", () => {
  it("files a job's folder against the job only, not the job's account too", () => {
    expect(folderContainer(JOB_SCOPE)).toEqual({
      job_id: "job-1",
      account_id: null,
      project_id: null,
    });
  });
  it("files a photo project's folder against the project only", () => {
    expect(folderContainer({ locationId: "loc-1", projectId: "p-1", accountId: "acc-1" })).toEqual({
      job_id: null,
      account_id: null,
      project_id: "p-1",
    });
  });
  it("files an account's folder against the account; company-wide against none", () => {
    expect(folderContainer({ locationId: "loc-1", accountId: "acc-1" })).toEqual({
      job_id: null,
      account_id: "acc-1",
      project_id: null,
    });
    expect(folderContainer({ locationId: "loc-1" })).toEqual({
      job_id: null,
      account_id: null,
      project_id: null,
    });
  });
});

describe("authorizationFolderId — where a signed work authorization is filed", () => {
  const base = { jobId: "job-1", accountId: "acc-1", locationId: "loc-1", capturedBy: "u-1" };

  it("files into the job's Work Authorizations folder, made on the first one", async () => {
    const seen: { name: string; jobId?: string | null }[] = [];
    const id = await authorizationFolderId({ ...base, folderId: null }, async (i) => {
      seen.push({ name: i.name, jobId: i.scope.jobId });
      return folder("f-wa", i.name);
    });
    expect(id).toBe("f-wa");
    expect(seen).toEqual([{ name: WORK_AUTHORIZATION_FOLDER, jobId: "job-1" }]);
  });

  it("uses the folder the user had open instead", async () => {
    const ensure = vi.fn();
    expect(await authorizationFolderId({ ...base, folderId: "f-open" }, ensure)).toBe("f-open");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("an account-only signing, or a folder that cannot be made, stays at the top level", async () => {
    expect(await authorizationFolderId({ ...base, jobId: null }, vi.fn())).toBeNull();
    const failing = async () => {
      throw new Error("offline");
    };
    expect(await authorizationFolderId(base, failing)).toBeNull();
  });
});
