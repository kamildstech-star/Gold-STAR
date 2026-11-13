import { JOB_TABS, isJobSection, jobTabHome, type JobTab } from "@/lib/job-tab-order";

/**
 * The job page's search params: which tab to open and, on that tab, which
 * record to bring forward. A link — History's "Open record" first — says
 * `/jobs/<id>?tab=pictures&photo=<photo id>` and the page opens the Pictures
 * tab with that photo in the viewer.
 *
 * `tab` is the page's state: switching tabs writes it, so a reload keeps
 * the tab (FE4, 28 Oct). Without one the page opens on General (David,
 * 20 Oct). The record params are a one-shot instruction: the page reads
 * them, opens what they name, and takes them back off the URL, so the same
 * link pressed again works again.
 */
export type JobPageSearch = {
  tab?: JobTab;
  /**
   * A section to scroll to on the open tab: a tab that was merged into
   * another (5 Nov) — `?tab=schedule&section=tasks`. One-shot, like the
   * record params. An old `?tab=tasks` link is read as exactly that.
   */
  section?: JobTab;
  /** A `photos.id` on the job's album: Pictures opens it in the viewer. */
  photo?: string;
  /** A `job_reports.id`: Documents selects it in the AI reports panel. */
  report?: string;
  /** A `documents.id`: Documents opens it in the document viewer. */
  doc?: string;
  /** A `tasks.id`: Tasks highlights it and scrolls it into view. */
  task?: string;
};

const ID = /^[0-9A-Za-z:_-]{1,80}$/;

function id(raw: unknown): string | undefined {
  return typeof raw === "string" && ID.test(raw) ? raw : undefined;
}

/**
 * The search for a link to the job page that names any tab, merged ones
 * included: `jobSearchFor("tasks", { task })` is Schedule at its Tasks
 * section (5 Nov merges). Every link the app builds goes through here, so
 * none of them names a tab that is no longer on the strip.
 */
export function jobSearchFor(
  tab: JobTab,
  extra: Omit<JobPageSearch, "tab" | "section"> = {},
): JobPageSearch {
  const home = jobTabHome(tab);
  return { tab: home, ...(isJobSection(tab) ? { section: tab } : {}), ...extra };
}

/** Defensive parse of whatever is on the URL. Unknown tabs and odd ids are dropped. */
export function parseJobPageSearch(raw: Record<string, unknown>): JobPageSearch {
  const out: JobPageSearch = {};
  if (typeof raw.tab === "string" && (JOB_TABS as readonly string[]).includes(raw.tab)) {
    const asked = raw.tab as JobTab;
    // A link to a merged tab opens the tab it joined, at its section.
    out.tab = jobTabHome(asked);
    if (isJobSection(asked)) out.section = asked;
  }
  if (
    !out.section &&
    typeof raw.section === "string" &&
    (JOB_TABS as readonly string[]).includes(raw.section) &&
    isJobSection(raw.section as JobTab)
  ) {
    out.section = raw.section as JobTab;
    out.tab = jobTabHome(out.section);
  }
  const photo = id(raw.photo);
  const report = id(raw.report);
  const doc = id(raw.doc);
  const task = id(raw.task);
  if (photo) out.photo = photo;
  if (report) out.report = report;
  if (doc) out.doc = doc;
  if (task) out.task = task;
  return out;
}

/**
 * One record a tab is asked to bring forward. `at` makes asking twice for
 * the same record a new request, so the viewer reopens after being closed.
 */
export type RecordFocus = { id: string; at: number };

export type JobPageFocus = {
  photo: RecordFocus | null;
  report: RecordFocus | null;
  doc: RecordFocus | null;
  task: RecordFocus | null;
};

export function focusFromSearch(s: JobPageSearch, at: number): JobPageFocus {
  const f = (v: string | undefined) => (v ? { id: v, at } : null);
  return { photo: f(s.photo), report: f(s.report), doc: f(s.doc), task: f(s.task) };
}

export const NO_FOCUS: JobPageFocus = { photo: null, report: null, doc: null, task: null };
