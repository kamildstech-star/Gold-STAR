// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "We are disabling the information which is not granted to that role. This is
 * wrong: make it so they cannot see it at all, or the functionality
 * disappears." A Client 360 card someone may read but not change is plain
 * text: no "Read-only" lock chip, no note saying why, no greyed-out stars.
 * The read-only preview (View As) is the one place a disabled control stays.
 */
const writes = vi.hoisted(() => ({ disabled: false, reason: null as string | null }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/job-inline-field", () => ({ JobField: () => null }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "u1", roles: ["sales_rep"] }),
  useWritesDisabled: () => writes,
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}));

import { MilestonesSection, OpenTasksSection, SatisfactionSection } from "./client-360-sections";

const stars = (canEdit: boolean) =>
  renderToStaticMarkup(
    createElement(SatisfactionSection, {
      accountId: "a1",
      score: 3,
      canEdit,
      onSaved: () => {},
    }),
  );

beforeEach(() => {
  writes.disabled = false;
  writes.reason = null;
});

describe("Client 360 cards for a role that may not edit", () => {
  it("draws the satisfaction score with nothing to click", () => {
    const html = stars(false);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("disabled");
    expect(html).toContain("Satisfaction 3.0 of 5");
  });

  it("gives the account's rep the stars as buttons", () => {
    const html = stars(true);
    expect(html).toContain('aria-label="Set satisfaction 1"');
    expect(html).not.toContain("disabled");
  });

  it("keeps the View As preview's disabled stars and its reason", () => {
    writes.disabled = true;
    writes.reason = "Read-only preview";
    const html = stars(true);
    expect(html).toContain("disabled");
    expect(html).toContain("Read-only preview");
  });

  it("shows record sections without a lock chip or a why-not note", () => {
    const html =
      renderToStaticMarkup(createElement(MilestonesSection, { milestones: [] })) +
      renderToStaticMarkup(createElement(OpenTasksSection, { tasks: [] }));
    expect(html).not.toContain("Read-only");
    expect(html).not.toContain("move the job to change them");
    expect(html).not.toContain("Edited on the task itself");
  });
});
