// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T4 (5 Nov review): an urgent notice is pinned above the Notices strip as a
 * one-line pill and never needs the strip opened; the rest stay in the strip.
 */
let answers: Record<string, unknown> = {};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    if (enabled === false) return { data: undefined, isLoading: false, isError: false };
    return { data: answers[String(queryKey[0])] ?? null, isLoading: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: () => {} }),
  useMutation: () => ({ mutate: () => {}, isPending: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ writesDisabled: false, userId: "u1", roles: ["admin"] }),
}));

import { JobNotices } from "./job-notices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  answers = {};
  window.localStorage.clear();
});

async function mount(props: Partial<Parameters<typeof JobNotices>[0]>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(JobNotices, {
        jobId: "j1",
        accountId: "a1",
        address: "12 Main St",
        importantInstructions: null,
        rehabbedAfter1978: true,
        ...props,
      }),
    );
  });
  return host;
}

describe("urgent notices", () => {
  it("pins urgent notices above the strip, outside the collapse, and keeps the rest in it", async () => {
    // The strip is collapsed: an urgent notice must still be on screen.
    window.localStorage.setItem("job-notices:collapsed", JSON.stringify({ u1: true }));
    answers = {
      "property-note": {
        id: "p1",
        address_key: "12 main street",
        address: "12 Main St",
        note: "Call 30 min before",
        updated_at: "",
        urgent: true,
      },
      "account-standing-note": {
        accountId: "a1",
        accountName: "AJH",
        note: "20% discount",
        kind: "discount",
        urgent: false,
      },
    };
    const el = await mount({
      importantInstructions: "Don't block driveway",
      importantInstructionsUrgent: true,
    });

    const pinned = el.querySelector("[data-urgent-notices]");
    expect(pinned).not.toBeNull();
    // 6 Nov: one row at every width — the pills and the Notices toggle share it.
    expect(pinned!.className).toContain("flex");
    expect(pinned!.querySelector("[data-notices-toggle]")).not.toBeNull();
    const pills = [...pinned!.querySelectorAll("[data-urgent-notice]")].map((p) => p.textContent);
    expect(pills).toHaveLength(2);
    expect(pills.join("|")).toContain("Don't block driveway");
    expect(pills.join("|")).toContain("Call 30 min before");
    // The non-urgent account note is not pinned, and the strip counts only it.
    expect(pills.join("|")).not.toContain("20% discount");
    // Beside pills the toggle shows the bare count ("Notices 1"), to fit a phone.
    expect(el.querySelector("[data-notices-toggle]")!.textContent).toContain("1");
    expect(el.textContent).not.toContain("20% discount");
  });

  it("keeps the row to three cells: a third urgent notice goes into the strip", async () => {
    answers = {
      "property-note": {
        id: "p1",
        address_key: "12 main street",
        address: "12 Main St",
        note: "Call 30 min before",
        updated_at: "",
        urgent: true,
      },
      "account-standing-note": {
        accountId: "a1",
        accountName: "AJH",
        note: "Net 30",
        kind: "general",
        urgent: true,
      },
    };
    const el = await mount({
      importantInstructions: "Don't block driveway",
      importantInstructionsUrgent: true,
    });
    const row = el.querySelector("[data-urgent-notices]")!;
    expect(row.querySelectorAll("[data-urgent-notice]")).toHaveLength(2);
    expect(row.querySelector("[data-notices-toggle]")!.textContent).toContain("1");
    // The strip (open by default) still shows the third one.
    expect(el.textContent).toContain("Net 30");
    // 6 Nov: the Property pill no longer repeats the job's address.
    expect(row.textContent).not.toContain("12 Main St");
    expect(row.textContent).toContain("Property");
  });

  it("pins nothing when no notice is urgent", async () => {
    const el = await mount({ importantInstructions: "Gate code 4412" });
    expect(el.querySelector("[data-urgent-notices]")).toBeNull();
    expect(el.textContent).toContain("Gate code 4412");
  });
});
