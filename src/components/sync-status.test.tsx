// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  list: vi.fn(),
  recovery: vi.fn(),
  drain: vi.fn(),
  refresh: undefined as undefined | (() => void),
}));
vi.mock("@/lib/offline-queue", () => ({
  listQueue: h.list,
  queueRecoveryStatus: h.recovery,
  drain: h.drain,
  subscribe: (callback: () => void) => {
    h.refresh = callback;
    return () => {};
  },
  startAutoDrain: () => () => {},
  KIND_LABEL: { note: "Note" },
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
import { SyncStatus } from "./sync-status";
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.list.mockReset().mockResolvedValue([]);
  h.recovery.mockReset().mockResolvedValue({
    syncItems: 2,
    photos: 1,
    message: "Unsent work is preserved. Do not clear site data.",
  });
  h.drain.mockReset().mockResolvedValue({ sent: 0, failed: 0 });
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("shows count-only recovery guidance with no automatic claim or retry of legacy data", async () => {
  await act(async () => root.render(<SyncStatus />));
  expect(container.textContent).toContain("3 need recovery");
  expect(container.textContent).toContain("2 saved entries and 1 photos");
  expect(container.textContent).toContain("How to request safe recovery");
  expect(container.textContent).toContain("must independently verify");
  expect(container.textContent).toContain("Retry now cannot recover");
  expect(container.textContent).not.toContain("All synced");
  const retry = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Retry now",
  );
  expect(retry?.disabled).toBe(true);
  expect(h.drain).not.toHaveBeenCalled();
});
it("clears previous account labels and ignores older reads after auth notification", async () => {
  h.recovery.mockResolvedValue({ syncItems: 0, photos: 0, message: "" });
  h.list.mockResolvedValueOnce([
    { id: "a", kind: "note", label: "A private label", status: "queued" },
  ]);
  await act(async () => root.render(<SyncStatus />));
  expect(container.textContent).toContain("A private label");
  let finish!: (value: unknown[]) => void;
  h.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => h.refresh?.());
  expect(container.textContent).not.toContain("A private label");
  await act(async () => h.refresh?.());
  await act(async () =>
    finish([{ id: "a", kind: "note", label: "late A label", status: "queued" }]),
  );
  expect(container.textContent).not.toContain("late A label");
});
it("does not claim success when recovery enumeration fails", async () => {
  h.recovery.mockRejectedValue(new Error("account changed"));
  await act(async () => root.render(<SyncStatus />));
  expect(container.textContent).toContain("Saved work has not been verified yet");
  expect(container.textContent).not.toContain("All synced");
});
