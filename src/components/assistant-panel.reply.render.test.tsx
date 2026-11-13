// @vitest-environment jsdom
/**
 * 11 Nov: Polaris answered on the server (the reply was saved and showed up
 * when the conversation was reopened from History) but the open panel showed
 * nothing. The reveal looked the new reply up by a position computed inside a
 * setMessages updater, which React ran later — so it was still 0, and the
 * reply stayed at 0 characters. This sends a question and waits for the
 * answer to appear, twice, so the second answer in a conversation is covered.
 */
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const fns = vi.hoisted(() => ({
  askAssistant: { name: "ask" },
  confirmAssistantAction: { name: "confirm" },
  deleteAssistantConversation: { name: "delete" },
  getAssistantConversation: { name: "get" },
  listAssistantConversations: { name: "list" },
}));
const ask = vi.hoisted(() => vi.fn());
// Stable functions, as useServerFn gives: the panel's effects depend on them.
const others = vi.hoisted(() => ({ list: async () => [], none: async () => null }));

vi.mock("@/lib/assistant.functions", () => fns);
vi.mock("@tanstack/react-start", () => ({
  useServerFn: (fn: { name: string }) =>
    fn.name === "ask" ? ask : fn.name === "list" ? others.list : others.none,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => "/pipeline",
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ fullName: "Mark Adelman" }),
  useWritesDisabled: () => ({ disabled: false, reason: null }),
}));
vi.mock("@/components/assistant-markdown", () => ({
  AssistantMarkdown: ({ content }: { content: string }) =>
    createElement("span", { "data-reply": "" }, content),
}));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ className, children }: { className?: string; children: ReactNode }) =>
    createElement("div", { className }, children),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { AssistantPanel } from "./assistant-panel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, so the panel's scroll-to-bottom has nothing to call.
Element.prototype.scrollIntoView ??= () => {};

let host: HTMLDivElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
  ask.mockReset();
});

const replies = (el: HTMLElement) =>
  [...el.querySelectorAll("[data-reply]")].map((n) => n.textContent);

async function settle(el: HTMLElement, want: string) {
  for (let i = 0; i < 100 && !replies(el).includes(want); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

async function sendSuggestion(el: HTMLElement, label: string) {
  const btn = [...el.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(btn, `suggestion "${label}"`).toBeTruthy();
  await act(async () => {
    btn!.click();
  });
}

async function sendTyped(el: HTMLElement, text: string) {
  const ta = el.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(ta, text);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}

describe("a Polaris reply", () => {
  it("appears in the open panel, for the first answer and the next", async () => {
    ask
      .mockResolvedValueOnce({ conversationId: "c1", reply: "You have 40 active jobs." })
      .mockResolvedValueOnce({ conversationId: "c1", reply: "Four tasks are overdue." });

    host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(AssistantPanel, { open: true, onOpenChange: () => {} }));
    });

    await sendSuggestion(host, "How does the pipeline look right now?");
    await settle(host, "You have 40 active jobs.");
    expect(replies(host)).toEqual(["You have 40 active jobs."]);

    await sendTyped(host, "What is overdue?");
    await settle(host, "Four tasks are overdue.");
    expect(replies(host)).toEqual(["You have 40 active jobs.", "Four tasks are overdue."]);
    // The questions are untouched.
    expect(host.textContent).toContain("How does the pipeline look right now?");
    expect(host.textContent).toContain("What is overdue?");
    expect(ask).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });
});
