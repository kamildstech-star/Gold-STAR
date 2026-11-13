// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A failed chase action shows the database's reason, not the generic
 * fallback. Live, 14 Oct: "Could not accept" hid 'Out of market' because the
 * thrown PostgrestError is not an `Error` instance. The decline sheet had the
 * same `e instanceof Error` pattern; it is the smallest real component that
 * renders the toast, so it is driven here with the real DeclineSheet and the
 * real db-errors helper. Only the network edge (declineWithReason), the option
 * list and the toast are replaced.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => ({
  thrown: null as unknown,
  toastError: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign((...a: unknown[]) => h.toast(...a), { error: h.toastError }),
}));
vi.mock("@/lib/option-lists", () => ({
  useOptionList: () => ({ options: [{ label: "Too far" }] }),
}));
vi.mock("@/lib/outcomes", () => ({
  DECLINE_REASONS: ["Too far", "Other"],
  declineWithReason: async () => {
    if (h.thrown) throw h.thrown;
  },
}));

import { DeclineSheet } from "./decline-sheet";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.toastError.mockReset();
  h.toast.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

async function declineWith(thrown: unknown) {
  h.thrown = thrown;
  await act(async () => {
    root.render(
      createElement(DeclineSheet, {
        open: true,
        onOpenChange: () => {},
        incidentId: "incident-1",
        onDeclined: () => {},
      }),
    );
  });
  const button = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent === "Too far",
  );
  expect(button, "the reason button renders").toBeTruthy();
  await act(async () => {
    button!.click();
  });
  // A reason only selects since #395; Submit sends it.
  const submit = [...document.body.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === "Submit",
  );
  expect(submit, "the Submit button renders").toBeTruthy();
  await act(async () => {
    submit!.click();
  });
}

/** Since #395 the reason shows inside the dialog, which stays open. */
const dialogText = () => document.body.textContent ?? "";

describe("DeclineSheet error message", () => {
  it("says the alert is outside your market for a PostgrestError 'Out of market'", async () => {
    await declineWith({ message: "Out of market", code: "P0001", details: null, hint: null });
    expect(dialogText()).toContain("This alert is outside your market.");
  });

  it("shows any other database reason as-is, not the fallback", async () => {
    await declineWith({ message: "Not authenticated", code: "P0001" });
    expect(dialogText()).toContain("Not authenticated");
  });

  it("uses the fallback only when the error carries no message", async () => {
    await declineWith({});
    expect(dialogText()).toContain("Could not decline");
  });
});
