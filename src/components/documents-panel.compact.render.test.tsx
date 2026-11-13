// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The prospect dock's Documents section is the job page's panel in compact
 * mode. A static render pins its shape: a bounded section with a count, an
 * Upload that files into this account, and "All documents" as the way in —
 * none of the folder rail, view toggle or signature tooling the full panel
 * carries. Effects do not run under renderToStaticMarkup, so this is the
 * frame before the list lands, which is also the frame on a slow connection.
 */
const state = vi.hoisted(() => ({ writesDisabled: false }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({
    userId: "qa-user",
    writesDisabled: state.writesDisabled,
    writesDisabledReason: state.writesDisabled ? "Read only today" : null,
  }),
}));
vi.mock("@/components/document-viewer", () => ({
  DocumentThumb: () => null,
  DocumentViewer: () => null,
}));
vi.mock("@/lib/document-thumbnails", () => ({ ensureDocumentThumbnail: vi.fn() }));
vi.mock("@/components/work-authorization-dialog", () => ({
  WorkAuthorizationDialog: () => null,
}));
vi.mock("@/components/document-generate-dialog", () => ({
  GenerateFromTemplateDialog: () => null,
}));
vi.mock("@/components/document-send-dialog", () => ({ DocumentSendDialog: () => null }));
vi.mock("@/components/form-link-dialog", () => ({ FormLinkDialog: () => null }));

import { DocumentsPanel } from "./documents-panel";

const ACCOUNT = {
  accountId: "account-1",
  locationId: "loc-1",
  address: "12 Harbor St, Miami, FL",
  allowAuthorization: false,
};

beforeEach(() => {
  state.writesDisabled = false;
});

describe("DocumentsPanel compact", () => {
  it("renders a bounded section with Upload and the way into the full panel", () => {
    const html = renderToStaticMarkup(
      createElement(DocumentsPanel, { ...ACCOUNT, compact: true, onOpenAll: vi.fn() }),
    );
    expect(html).toContain('aria-label="Documents"');
    expect(html).toContain("Upload");
    expect(html).toContain('type="file"');
    expect(html).toContain("All documents");
    // What the next upload is filed as is still visible and changeable.
    expect(html).toContain("Contract");
    // None of the full panel's furniture.
    expect(html).not.toContain("Tile view");
    expect(html).not.toContain("List view");
    expect(html).not.toContain("Sign work authorization");
    expect(html).not.toContain("More document actions");
  });

  it("omits the way in when no full panel is wired, rather than a dead button", () => {
    const html = renderToStaticMarkup(createElement(DocumentsPanel, { ...ACCOUNT, compact: true }));
    expect(html).not.toContain("All documents");
  });

  it("disables Upload when writes are disabled", () => {
    state.writesDisabled = true;
    const html = renderToStaticMarkup(
      createElement(DocumentsPanel, { ...ACCOUNT, compact: true, onOpenAll: vi.fn() }),
    );
    expect(html).toMatch(/<input[^>]*type="file"[^>]*disabled=""/);
  });

  it("leaves the full panel as it was", () => {
    const html = renderToStaticMarkup(createElement(DocumentsPanel, ACCOUNT));
    expect(html).toContain("Tile view");
    expect(html).toContain("More document actions");
    expect(html).not.toContain("All documents");
  });
});
