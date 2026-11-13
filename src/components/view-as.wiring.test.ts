import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { walkFiles } from "@/lib/source-files";

/*
 * Mark, 11 Oct: "I also want to be able to view as specific people."
 *
 * The wiring half of "View as person", read from source because this repo has
 * no DOM testing library (precedent: src/lib/job-calculations.columns.test.ts).
 * Each assertion extracts the fragment it is about rather than matching the
 * whole file, so a comment cannot satisfy or break it.
 */
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", start + signature.length);
  const nextExport = source.indexOf("\nexport ", start + signature.length);
  const nextConst = source.indexOf("\nconst ", start + signature.length);
  const ends = [next, nextExport, nextConst].filter((i) => i > -1);
  return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

describe("the sidebar switcher offers View as person… to the same people as View as role", () => {
  const SHELL = read("src/components/app-shell.tsx");
  const switcher = fnBody(SHELL, "function RolePreviewSwitcher()");

  it("returns nothing for anyone whose REAL roles are not owner/admin/dev", () => {
    const gate = switcher.indexOf("if (!isPrivileged(app.realRoles)) return null;");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(switcher.indexOf("return ("));
  });

  it("has the item, and it opens the picker", () => {
    expect(switcher).toMatch(/<SelectItem value="__person"/);
    expect(switcher).toContain('"View as person…"');
    expect(switcher).toMatch(/if \(v === "__person"\) \{\s*setPickerOpen\(true\);/);
    expect(switcher).toMatch(/<ViewAsPersonPicker open=\{pickerOpen\}/);
  });

  it("sign-out ends the view before the session goes", () => {
    const signOut = SHELL.match(/const handleSignOut = async \(\) => \{[\s\S]*?\n {2}\};/)![0];
    const end = signOut.indexOf("await endImpersonationForSignOut()");
    expect(end).toBeGreaterThan(-1);
    expect(end).toBeLessThan(signOut.indexOf("supabase.auth.signOut()"));
  });
});

describe("the picker", () => {
  const PICKER = read("src/components/view-as-person-picker.tsx");
  const component = fnBody(PICKER, "export function ViewAsPersonPicker(");

  it("is gated on the real roles too, and lists through fetchPickablePeople", () => {
    expect(component).toMatch(/const allowed = isPrivileged\(app\.realRoles\);/);
    expect(component).toMatch(/if \(!allowed\) return null;/);
    expect(component).toMatch(/enabled: open && allowed/);
    expect(component).toMatch(
      /queryFn: \(\) => fetchPickablePeople\(app\.userId, app\.allLocations\)/,
    );
  });

  it("starts through the audited start_impersonation, allowed past the read-only net", () => {
    const start = component.match(/const start = useMutation\(\{[\s\S]*?\n {2}\}\);/)![0];
    expect(start).toMatch(/meta: VIEW_AS_ALLOWED_META/);
    expect(start).toMatch(
      /mutationFn: \(person: PickablePerson\) => startImpersonationAs\(person\.userId\)/,
    );
  });
});

describe("audit: every start and stop is an impersonation_audit row", () => {
  const LIB = read("src/lib/impersonation.ts");

  it("start and end go through the SECURITY DEFINER RPCs (actor, target, times)", () => {
    const start = fnBody(LIB, "export async function startImpersonationAs(");
    expect(start).toMatch(/supabase\.rpc\("start_impersonation"/);
    expect(start).toMatch(
      /rememberViewAsSession\(data as string, await currentAuthSessionId\(\)\)/,
    );
    const end = fnBody(LIB, "export async function endImpersonation()");
    expect(end).toMatch(/supabase\.rpc\("end_impersonation"\)/);
  });
});

describe("the banner", () => {
  const BANNER = read("src/components/impersonation-banner.tsx");
  const person = BANNER.match(/if \(viewingAsPerson\) \{[\s\S]*?\n {2}\}\n/)![0];

  it("names the person, roles and office, says Read only, and offers Switch back", () => {
    expect(person).toMatch(/\{viewingAsPerson\.name\}/);
    expect(person).toMatch(/roleListLabel\(viewingAsPerson\.roles\), viewingAsPerson\.officeName/);
    expect(person).toMatch(/>\s*Read only\s*</);
    expect(person).toMatch(/exitButton\("Switch back"\)/);
  });

  it("carries the preview caveat in its tooltip", () => {
    expect(person).toMatch(/<TooltipContent[^>]*>\s*\{VIEW_AS_CAVEAT\}/);
    expect(person).toMatch(/title=\{VIEW_AS_CAVEAT\}/);
  });

  it("switching back is allowed past the read-only net", () => {
    const exit = BANNER.match(/const exitMut = useMutation\(\{[\s\S]*?\n {2}\}\);/)![0];
    expect(exit).toMatch(/meta: VIEW_AS_ALLOWED_META/);
  });

  it("sits in the shell above the outlet, so it survives navigation", () => {
    const shell = read("src/components/app-shell.tsx");
    expect(shell).toMatch(/<IosInstallSheetHost \/>\s*<ImpersonationBanner \/>/);
  });
});

describe("read only", () => {
  it("the query client refuses to start a mutation while viewing as someone", () => {
    const ROUTER = read("src/router.tsx");
    const cache = ROUTER.match(/mutationCache: new MutationCache\(\{[\s\S]*?\n {4}\}\),/)![0];
    expect(cache).toMatch(
      /onMutate: \(_vars, mutation\) => guardMutationWhileViewingAs\(mutation\.options\.meta\)/,
    );
  });
});

describe("'my' scopes follow the viewed person", () => {
  const cases: { file: string; fragment: RegExp }[] = [
    {
      file: "src/routes/_authenticated/tasks.index.tsx",
      fragment: /if \(scope === "mine" && viewerUserId\) q = q\.eq\("assignee", viewerUserId\);/,
    },
    {
      file: "src/routes/_authenticated/jobs.index.tsx",
      fragment: /const me = app\.viewerUserId;/,
    },
    {
      file: "src/routes/_authenticated/jobs.index.tsx",
      fragment: /else if \(previewOffices\) q = q\.in\("location_id", previewOffices\);/,
    },
    {
      file: "src/routes/_authenticated/pipeline.index.tsx",
      fragment: /scope,\s*userId: app\.viewerUserId!,/,
    },
    {
      file: "src/routes/_authenticated/pipeline.index.tsx",
      fragment: /viewerUserId=\{app\.viewerUserId \?\? null\}/,
    },
    {
      file: "src/routes/_authenticated/my-commissions.tsx",
      fragment: /const subjectId = \(isFinance && search\.rep\) \|\| app\.viewerUserId \|\| "";/,
    },
    {
      file: "src/routes/_authenticated/my-goals.tsx",
      fragment: /const subjectId = \(leadership && search\.u\) \|\| app\.viewerUserId;/,
    },
    {
      file: "src/routes/_authenticated/calendar.tsx",
      fragment: /if \(person === "me"\) return app\.viewerUserId \? \[app\.viewerUserId\] : \[\];/,
    },
    {
      file: "src/components/dashboard-grid.tsx",
      fragment: /<GoalProgressCard userId=\{app\.viewerUserId\}/,
    },
    {
      file: "src/components/owner-filter.tsx",
      fragment: /<SelectItem value=\{app\.viewerUserId\}>Me<\/SelectItem>/,
    },
    {
      file: "src/lib/use-can-manage-job.ts",
      fragment: /const who = app\.viewerUserId;/,
    },
  ];

  it.each(cases)("$file", ({ file, fragment }) => {
    expect(read(file)).toMatch(fragment);
  });
});

describe("no write ever uses the viewed person's id as its author", () => {
  /*
   * The database session is the admin's; viewerUserId is for READING whose
   * "my" list it is. A row that says it was made by someone who did not make
   * it is the one thing this preview must never do, so any authorship-shaped
   * key fed from viewerUserId fails here.
   */
  const AUTHOR_KEYS =
    "author_id|created_by|actor_id|user_id|owner_id|assignee|assigned_to|assigned_rep|" +
    "uploaded_by|requested_by|recipient_id|sender_id|accepted_by|approved_by|crew_chief";
  const authorFromViewer = new RegExp(`\\b(${AUTHOR_KEYS})\\s*:\\s*[^,}\\n]*viewerUserId`);
  const writeWithViewer = /\.(insert|upsert|update)\(\s*\{[^}]*viewerUserId/;

  const files = walkFiles("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f));

  it("finds the files that use viewerUserId (sanity)", () => {
    const using = files.filter((f) => read(f).includes("viewerUserId"));
    expect(using.length).toBeGreaterThan(10);
  });

  it.each(files.filter((f) => read(f).includes("viewerUserId")))("%s", (file) => {
    const source = read(file);
    expect(source.match(authorFromViewer)?.[0] ?? null).toBeNull();
    expect(source.match(writeWithViewer)?.[0] ?? null).toBeNull();
  });
});
