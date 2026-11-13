// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * David, on the call: "Folders over here by documents… I can't even create new
 * documents over here. It's not letting me create new documents, new folders.
 * … And if it's PDF, I should be able to view it like a little, you know,
 * preview thingy."
 *
 * He was on the Documents page in the sidebar, which was a read-only list: no
 * Upload, no New folder, no rail — the folder tree existed only inside a job
 * or account record. This pins the page's frame: the two ways to create, the
 * rail when the migration is there, the note when it is not, and a way into
 * the viewer from both the table and the phone card. Effects do not run under
 * renderToStaticMarkup, so this is the first frame, which is also the frame on
 * a slow connection.
 */
const state = vi.hoisted(() => ({
  writesDisabled: false,
  locationId: "loc-1" as string | null,
  folders: true,
  foldersFailed: false,
  folderRows: [
    {
      id: "carrier",
      location_id: "loc-1",
      job_id: null,
      account_id: null,
      project_id: null,
      name: "Carrier correspondence",
      parent_folder_id: null,
      sort_order: 0,
      created_at: "2026-09-01T00:00:00Z",
    },
  ] as unknown[] | null,
}));

const DOC = {
  id: "doc-1",
  name: "Work authorization.pdf",
  doc_type: "contract",
  status: "active",
  expiry_date: null,
  created_at: "2026-09-01T00:00:00Z",
  location_id: "loc-1",
  job_id: "job-1",
  account_id: null,
  project_id: null,
  storage_path: "loc-1/job-1/x.pdf",
  mime: "application/pdf",
  size_bytes: 1024,
  folder_id: null,
};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({ children }: { children?: React.ReactNode }) => createElement("a", null, children),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    const key = options.queryKey[0];
    if (key === "documents-index-folders")
      return {
        data: state.foldersFailed ? undefined : state.folderRows,
        isLoading: false,
        isError: state.foldersFailed,
        refetch: vi.fn(),
      };
    return {
      data: { rows: [DOC], folders: state.folders },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({
    userId: "qa-user",
    currentLocationId: state.locationId,
    writesDisabled: state.writesDisabled,
    writesDisabledReason: state.writesDisabled ? "Read only today" : null,
  }),
}));
vi.mock("@/components/document-viewer", () => ({
  DocumentThumb: () => null,
  DocumentViewer: () => null,
}));
vi.mock("@/lib/document-thumbnails", () => ({ ensureDocumentThumbnail: vi.fn() }));
vi.mock("@/components/metric-strip", () => ({ MetricStrip: () => null }));
vi.mock("@/components/ui-density", () => ({
  PageHeader: ({ title, children }: { title: string; children?: React.ReactNode }) =>
    createElement("header", null, title, children),
  LoadError: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

import { Route } from "./documents.index";

const page = () =>
  renderToStaticMarkup(
    createElement((Route as unknown as { component: React.ComponentType }).component),
  );

beforeEach(() => {
  state.writesDisabled = false;
  state.locationId = "loc-1";
  state.folders = true;
  state.foldersFailed = false;
  state.folderRows = [
    {
      id: "carrier",
      location_id: "loc-1",
      job_id: null,
      account_id: null,
      project_id: null,
      name: "Carrier correspondence",
      parent_folder_id: null,
      sort_order: 0,
      created_at: "2026-09-01T00:00:00Z",
    },
  ];
});

describe("the Documents page", () => {
  it("can create a document and a folder", () => {
    const html = page();
    expect(html).toContain("Upload");
    expect(html).toContain('type="file"');
    expect(html).toContain("New folder");
  });

  it("shows the folder rail with its folders", () => {
    const html = page();
    expect(html).toContain("Carrier correspondence");
    expect(html).toContain("All documents");
  });

  it("offers a preview of the document rather than only a download", () => {
    // The filename opened it before; nothing said so, and the phone card had
    // no way in at all.
    const html = page();
    expect(html).toContain('aria-label="Preview Work authorization.pdf"');
  });

  it("turns filing off, with a reason, when the picker is on all locations", () => {
    // A document belongs to one location — it is the RLS anchor — so there is
    // no honest answer to which one a new folder would go in.
    state.locationId = null;
    const html = page();
    expect(html).toContain("Pick a single location");
    expect(html).toContain('type="file" class="hidden" disabled=""');
  });

  it("says so when the folders migration has not been applied", () => {
    state.folders = false;
    state.folderRows = null;
    const html = page();
    expect(html).toContain("document_folders");
    // The list is still the list; a missing migration hides nothing.
    expect(html).toContain("Work authorization.pdf");
    expect(html).not.toContain("Carrier correspondence");
  });

  it("does not blame a missing migration for a failed folder read", () => {
    state.foldersFailed = true;
    const html = page();
    expect(html).toContain("failed query, not an empty folder tree");
    expect(html).not.toContain("document_folders");
  });

  it("cannot upload or file while writes are disabled", () => {
    state.writesDisabled = true;
    const html = page();
    expect(html).toContain('type="file" class="hidden" disabled=""');
  });
});
