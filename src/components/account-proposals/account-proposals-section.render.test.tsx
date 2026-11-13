// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The account record's Proposals list. The query is mocked to each state the
 * section can be in; the dialog is lazy, so nothing here pulls in the server
 * functions it uses (the record's own render tests rely on that too).
 */
let state: { data?: unknown; isLoading?: boolean; isError?: boolean } = {};
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ refetch: vi.fn(), ...state }),
}));
vi.mock("@/components/app-context", () => ({
  useWritesDisabled: () => ({ disabled: false, reason: null }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { AccountProposalsSection } from "./account-proposals-section";

const render = () =>
  renderToStaticMarkup(
    createElement(AccountProposalsSection, { accountId: "acc-1", accountName: "Flatbush Co-op" }),
  );
const createButton = (html: string) =>
  html.match(/<button[^>]*>(?:(?!<\/button>).)*Create proposal<\/button>/s)![0];

beforeEach(() => {
  state = {};
});

describe("the Proposals section", () => {
  it("lists each proposal with its total, date and status", () => {
    state = {
      data: {
        available: true,
        rows: [
          {
            id: "p1",
            title: "Annual water mitigation agreement",
            status: "sent",
            total: 400.99,
            created_at: "2026-10-01T15:00:00.000Z",
            sent_at: "2026-10-02T15:00:00.000Z",
            signed_at: null,
            declined_at: null,
            expired_at: null,
          },
          {
            id: "p2",
            title: "Vendor program",
            status: "signed",
            total: 1200,
            created_at: "2026-09-01T15:00:00.000Z",
            sent_at: "2026-09-02T15:00:00.000Z",
            signed_at: "2026-09-05T15:00:00.000Z",
            declined_at: null,
            expired_at: null,
          },
        ],
      },
    };
    const html = render();
    expect(html).toContain("Annual water mitigation agreement");
    expect(html).toContain("$400.99");
    expect(html).toContain(">Sent<");
    expect(html).toContain(">Signed<");
    expect(html).toContain("· 2");
    expect(createButton(html)).not.toMatch(/\sdisabled=""/);
  });

  it("an empty list says what a proposal is for", () => {
    state = { data: { available: true, rows: [] } };
    expect(render()).toContain("No proposals yet.");
  });

  it("before the migration: says so, and Create proposal is off", () => {
    state = { data: { available: false, rows: [] } };
    const html = render();
    expect(html).toContain("Proposals need a database update before they can be used.");
    expect(createButton(html)).toMatch(/\sdisabled=""/);
  });

  it("a failed read is not an empty list", () => {
    state = { isError: true };
    const html = render();
    expect(html).toContain("Proposals could not be loaded.");
    expect(html).not.toContain("No proposals yet.");
  });
});
