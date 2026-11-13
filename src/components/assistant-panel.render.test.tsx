import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({ useServerFn: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => "/pipeline",
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ fullName: "Melly Chein" }),
  useWritesDisabled: () => ({ disabled: false, reason: null }),
}));
vi.mock("@/components/assistant-markdown", () => ({
  AssistantMarkdown: ({ content }: { content: string }) => createElement("span", null, content),
}));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ className, children }: { className?: string; children: ReactNode }) =>
    createElement("div", { className }, children),
}));
vi.mock("@/lib/assistant.functions", () => ({
  askAssistant: {},
  confirmAssistantAction: {},
  deleteAssistantConversation: {},
  getAssistantConversation: {},
  listAssistantConversations: {},
}));

import { AssistantPanel, AssistantPanelHost } from "./assistant-panel";

describe("compact Polaris surface", () => {
  it("renders a bounded non-modal panel without a sheet overlay", () => {
    const html = renderToStaticMarkup(
      createElement(AssistantPanel, { open: true, onOpenChange: vi.fn() }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="false"');
    expect(html).toContain("h-[72svh]");
    expect(html).toContain("max-h-[36rem]");
    expect(html).toContain("md:w-[min(25rem,calc(100vw-2rem))]");
    expect(html).toContain('aria-label="Close Polaris"');
    expect(html).not.toContain("data-sheet-side");
    expect(html).not.toContain("fixed inset-0");
  });

  it("keeps the conversation panel mounted while closed and exposes a phone launcher", () => {
    const html = renderToStaticMarkup(createElement(AssistantPanelHost));

    expect(html).toContain('aria-label="Open Polaris"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("md:hidden");
  });
});
