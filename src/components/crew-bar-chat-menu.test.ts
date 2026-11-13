import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 5 Oct, choosing between six cramped tabs and moving one: "move chat
 * into menu". Receipts had just taken the crew's fifth tab, which made six
 * cells with Menu; iOS and Android both stop a tab bar at five.
 *
 * Three things have to stay true for that to be a move and not a removal:
 * Chat is still one tap away in the sidebar Menu opens, a waiting message is
 * still visible from the bar, and the unread count is not computed twice —
 * the hook polls and holds a realtime channel named for the user.
 */
const SHELL = readFileSync("src/components/app-shell.tsx", "utf8").replace(/\r\n/g, "\n");

const between = (from: string, to: string) => SHELL.slice(SHELL.indexOf(from), SHELL.indexOf(to));
const bar = between("function bottomNavForRole(", "function usePendingSupplies(");
const crew = bar.slice(0, bar.indexOf("// field_chaser / field"));
const field = bar.slice(bar.indexOf("// field_chaser / field"));
const tabs = (s: string) => [...s.matchAll(/\{ to: "([^"]+)"/g)].map((m) => m[1]);

describe("Chat lives behind Menu on the field roles' phone bar", () => {
  it("is not a tab for crew or field roles", () => {
    expect(tabs(crew)).not.toContain("/chat");
    expect(tabs(field)).not.toContain("/chat");
  });

  it("stops the bar at four tabs, so Menu makes five", () => {
    expect(SHELL).toContain(".slice(0, mobileFirst ? 4 : 3);");
    expect(tabs(crew).length).toBeLessThanOrEqual(4);
    expect(tabs(field).length).toBeLessThanOrEqual(4);
  });

  it("keeps Receipts on the bar for both", () => {
    expect(tabs(crew)).toContain("/receipts");
    expect(tabs(field)).toContain("/receipts");
  });

  it("is still in the sidebar Menu opens, for crew and field roles", () => {
    const chat = SHELL.match(/to: "\/chat",\s+label: "Chat",[\s\S]*?roles: \[[^\]]*\]/)![0];
    for (const r of ["crew", "field", "field_chaser"]) expect(chat).toContain(`"${r}"`);
  });
});

describe("a waiting message still shows from the bar", () => {
  it("puts a dot on Menu only when Chat is behind it", () => {
    const shell = SHELL.slice(SHELL.indexOf("function MobileBottomNav("));
    expect(shell).toContain('const chatBehindMenu = unreadChats > 0 && !items.some((i) => i.to === "/chat");');
    expect(shell).toMatch(/\{chatBehindMenu && \(\s*<span\s+data-unread-dot/);
    // A screen reader is told too; the dot alone is decoration.
    expect(shell).toContain("aria-label={chatBehindMenu ? `Menu, ${unreadChats} unread messages` : undefined}");
  });

  it("counts unread chat once, in the shell, for the sidebar and the bar", () => {
    expect(SHELL.match(/useUnreadChats\(app\.userId\)/g)).toHaveLength(1);
    const shell = between("export function AppShell(", "function AppSidebar(");
    expect(shell).toContain("const unreadChats = useUnreadChats(app.userId);");
    expect(shell).toContain("<AppSidebar unreadChats={unreadChats} />");
    expect(shell).toContain("<MobileBottomNav condensed={condensed} unreadChats={unreadChats} />");
    expect(SHELL).toContain("function AppSidebar({ unreadChats }: { unreadChats: number }) {");
  });
});
