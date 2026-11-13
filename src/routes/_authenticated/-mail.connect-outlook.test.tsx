// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark, on the Mail page: "Connect Outlook" took people to the admin API
 * settings screen. He wanted it to work like Gmail — one click, Microsoft's
 * own sign-in, back to Mail with the inbox connected.
 *
 * Real React and real TanStack Query; the server functions, the sign-in
 * start and the router are stand-ins whose calls the test reads. What is
 * pinned: which of the three things the empty Mail page offers (Connect, the
 * admin setup link, or "ask an administrator"), that Connect starts the shared
 * sign-in naming Mail as the way back, and what happens on landing at
 * /mail?outlook=<code>.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Outlook = {
  mode: "delegated" | "application";
  configured: boolean;
  available: boolean;
  connection: { status: "connected" | "needs_reconnect"; upn: string } | null;
};

const state = vi.hoisted(() => ({
  search: {} as { outlook?: string },
  roles: [] as string[],
  outlook: null as Outlook | null,
  outlookFails: false,
  mailboxes: [] as { upn: string; enabled: boolean; sync_mail: boolean }[],
  statusCalls: 0,
}));
const navigate = vi.hoisted(() => vi.fn());
const startConnect = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({
    ...options,
    useSearch: () => state.search,
  }),
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) =>
    createElement("a", { href: to, ...rest }, children),
  useNavigate: () => navigate,
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (fn: unknown) => fn }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/outlook-connect-start", () => ({ startConnect }));
vi.mock("@/lib/graph.functions", () => ({
  graphStatus: async () => {
    state.statusCalls += 1;
    return {
      configured: true,
      missing_secrets: [],
      notification_url: null,
      mailboxes: state.mailboxes,
    };
  },
}));
vi.mock("@/lib/microsoft-connection.functions", () => ({
  myOutlookConnection: async () => {
    if (state.outlookFails) throw new Error("network down");
    return state.outlook;
  },
}));
vi.mock("@/integrations/supabase/client", () => {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: async () => ({ data: [], error: null }),
  };
  return { supabase: { from: () => chain } };
});
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ roles: state.roles }),
}));
vi.mock("@/components/email-context-sidebar", () => ({ EmailContextSidebar: () => null }));
vi.mock("@/components/email-composer", () => ({ EmailComposer: () => null }));
vi.mock("@/components/ui-density", () => ({
  PageHeader: ({ title }: { title: string }) => createElement("header", null, title),
  EmptyLine: ({ children }: { children?: ReactNode }) => createElement("p", null, children),
  LoadError: () => createElement("p", null, "load error"),
}));

import { Route } from "./mail.index";

const route = Route as unknown as {
  component: React.ComponentType;
  validateSearch: (s: Record<string, unknown>) => { outlook?: string };
};

let container: HTMLDivElement;
let root: Root;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(warm?: (qc: QueryClient) => void) {
  const qc = new QueryClient({
    defaultOptions: {
      // A warm cache never refetches by itself, so only an invalidation can.
      queries: { retry: false, ...(warm ? { staleTime: Infinity } : {}) },
      mutations: { retry: false },
    },
  });
  warm?.(qc);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(route.component)));
  });
  await settle();
}

const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
const adminLink = () => container.querySelector('a[href="/admin/integrations/outlook"]');

const DELEGATED: Outlook = {
  mode: "delegated",
  configured: true,
  available: true,
  connection: null,
};

beforeEach(() => {
  state.search = {};
  state.roles = ["field_tech"];
  state.outlook = { ...DELEGATED };
  state.outlookFails = false;
  state.mailboxes = [];
  state.statusCalls = 0;
  navigate.mockReset();
  startConnect.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("the empty Mail page's Connect Outlook", () => {
  it("where people sign in themselves, it is a Connect button that starts Microsoft's sign-in and comes back to Mail", async () => {
    startConnect.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(text()).toContain("Outlook is not connected");
    const connect = button("Connect Outlook")!;
    expect(connect).toBeTruthy();
    expect(adminLink()).toBeNull();

    await act(async () => connect.click());
    await settle();
    expect(startConnect).toHaveBeenCalledWith({ shared: false, returnTo: "mail" });
    // One sign-in at a time.
    expect(button("Connect Outlook")!.disabled).toBe(true);
  });

  it("a start that fails says why and lets the person try again", async () => {
    startConnect.mockRejectedValue(
      new Error("Too many attempts. Wait a few minutes and try again."),
    );
    await mount();
    await act(async () => button("Connect Outlook")!.click());
    await settle();
    expect(toast.error).toHaveBeenCalledWith(
      "Too many attempts. Wait a few minutes and try again.",
    );
    expect(button("Connect Outlook")!.disabled).toBe(false);
  });

  it("a person whose sign-in needs renewing, or who is signed in but not syncing yet, gets Reconnect", async () => {
    state.outlook = {
      ...DELEGATED,
      connection: { status: "needs_reconnect", upn: "alice@goldstar.test" },
    };
    await mount();
    expect(button("Reconnect Outlook")).toBeTruthy();
    await act(async () => root.unmount());

    root = createRoot(container);
    state.outlook = {
      ...DELEGATED,
      connection: { status: "connected", upn: "alice@goldstar.test" },
    };
    await mount();
    expect(button("Reconnect Outlook")).toBeTruthy();
    expect(text()).toContain("isn't syncing yet");
  });

  it("company-wide mode or not set up: staff are told to ask an administrator, with no admin link", async () => {
    for (const outlook of [
      { ...DELEGATED, mode: "application" as const },
      { ...DELEGATED, configured: false },
      { ...DELEGATED, available: false },
    ]) {
      state.outlook = outlook;
      await mount();
      expect(text(), JSON.stringify(outlook)).toContain(
        "Ask an administrator to set up Microsoft 365.",
      );
      expect(adminLink()).toBeNull();
      expect(button("Connect Outlook")).toBeUndefined();
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it("company-wide mode or not set up: owners, admins and developers get the setup screen", async () => {
    for (const role of ["owner", "admin", "dev"]) {
      state.roles = [role];
      state.outlook = { ...DELEGATED, mode: "application" };
      await mount();
      expect(adminLink()?.textContent, role).toBe("Set up Outlook");
      expect(button("Connect Outlook")).toBeUndefined();
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it("when the connection cannot be read, nothing is offered that might not work", async () => {
    state.outlookFails = true;
    await mount();
    expect(text()).toContain("Couldn't check your Outlook connection");
    expect(button("Connect Outlook")).toBeUndefined();
  });

  it("a mailbox that is syncing means no Connect prompt at all", async () => {
    state.mailboxes = [{ upn: "alice@goldstar.test", enabled: true, sync_mail: true }];
    await mount();
    expect(text()).not.toContain("Outlook is not connected");
    expect(text()).toContain("No messages here.");
  });
});

describe("landing back on Mail from Microsoft", () => {
  it("connected: says so, says when mail arrives, refreshes the mailbox list and clears the code", async () => {
    state.search = { outlook: "connected" };
    // The callback registered the mailbox; the page still holds the old answer.
    state.mailboxes = [{ upn: "alice@goldstar.test", enabled: true, sync_mail: true }];
    await mount((qc) => {
      qc.setQueryData(["graph", "status", "mail"], { mailboxes: [] });
      qc.setQueryData(["my-outlook-connection"], DELEGATED);
    });
    expect(toast.success).toHaveBeenCalledWith("Outlook is connected.", {
      description: expect.stringMatching(/next sync, within 15 minutes/),
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/mail", search: {}, replace: true });
    expect(state.statusCalls).toBe(1);
    expect(text()).not.toContain("Outlook is not connected");
    expect(text()).toContain("No messages here.");
  });

  it("any other outcome shows the Security page's message for it, then clears the code", async () => {
    state.search = { outlook: "wrong_tenant" };
    await mount();
    expect(toast.error).toHaveBeenCalledWith(
      "That Microsoft account is not a Gold Star account. Sign in with your work account.",
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: "/mail", search: {}, replace: true });
  });

  it("no code, no toast and no navigation", async () => {
    await mount();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("the URL keeps only known outcome codes", () => {
    expect(route.validateSearch({ outlook: "connected" })).toEqual({ outlook: "connected" });
    expect(route.validateSearch({ outlook: "cancelled" })).toEqual({ outlook: "cancelled" });
    for (const odd of ["constructor", "toString", "__proto__", "<script>", "Connected", 1, null]) {
      expect(route.validateSearch({ outlook: odd }), String(odd)).toEqual({});
    }
    expect(route.validateSearch({})).toEqual({});
  });
});

describe("the rail's own Connect your Outlook", () => {
  // Live 2026-10-14: once David's mailbox synced, `connected` was true for
  // every admin who could see it, the empty state never showed, and nobody
  // else had a way to connect their own Outlook.
  it("shows even when another mailbox is already syncing, and starts the person's own sign-in", async () => {
    state.mailboxes = [{ upn: "david@goldstar.test", enabled: true, sync_mail: true }];
    startConnect.mockReturnValue(new Promise(() => {}));
    await mount();
    expect(text()).not.toContain("Outlook is not connected");
    const mine = button("Connect your Outlook")!;
    expect(mine).toBeTruthy();
    await act(async () => mine.click());
    await settle();
    expect(startConnect).toHaveBeenCalledWith({ shared: false, returnTo: "mail" });
  });

  it("says whose Outlook is connected once it is, and offers Reconnect when it needs renewing", async () => {
    state.mailboxes = [{ upn: "alice@goldstar.test", enabled: true, sync_mail: true }];
    state.outlook = {
      ...DELEGATED,
      connection: { status: "connected", upn: "alice@goldstar.test" },
    };
    await mount();
    expect(text()).toContain("Your Outlook: alice@goldstar.test");
    expect(button("Connect your Outlook")).toBeUndefined();
    await act(async () => root.unmount());

    root = createRoot(container);
    state.outlook = {
      ...DELEGATED,
      connection: { status: "needs_reconnect", upn: "alice@goldstar.test" },
    };
    await mount();
    expect(button("Reconnect your Outlook")).toBeTruthy();
  });

  it("is absent where Outlook is company-wide (application mode)", async () => {
    state.mailboxes = [{ upn: "office@goldstar.test", enabled: true, sync_mail: true }];
    state.outlook = { ...DELEGATED, mode: "application" };
    await mount();
    expect(button("Connect your Outlook")).toBeUndefined();
  });
});
