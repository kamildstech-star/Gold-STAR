// @vitest-environment jsdom
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it, vi } from "vitest";
import { transitionIdentityCaches } from "./identity-cache";

describe("account cache boundary", () => {
  it("removes unscoped cached results and rejects late results from A", async () => {
    const client = new QueryClient();
    const router = { clearCache: vi.fn(), invalidate: vi.fn().mockResolvedValue(undefined) };
    await transitionIdentityCaches(client, router, "a");
    client.setQueryData(["jobs"], ["A private job"]);
    let finish!: (value: string) => void;
    const old = client
      .fetchQuery({
        queryKey: ["profile"],
        queryFn: () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      })
      .catch(() => undefined);
    await transitionIdentityCaches(client, router, "b");
    expect(client.getQueryData(["jobs"])).toBeUndefined();
    client.setQueryData(["profile"], "B profile");
    finish("A private profile");
    await old;
    expect(client.getQueryData(["profile"])).toBe("B profile");
    client.clear();
  });
  it("does not clear caches on token refresh for the same identity", async () => {
    const client = new QueryClient();
    const router = { clearCache: vi.fn(), invalidate: vi.fn().mockResolvedValue(undefined) };
    await transitionIdentityCaches(client, router, "a");
    client.setQueryData(["jobs"], "A");
    await transitionIdentityCaches(client, router, "a");
    expect(client.getQueryData(["jobs"])).toBe("A");
    expect(router.invalidate).toHaveBeenCalledTimes(1);
    await transitionIdentityCaches(client, router, null);
    expect(client.getQueryData(["jobs"])).toBeUndefined();
  });
  it("retires pending router loaders before showing B", async () => {
    let identity = "a";
    let finish!: (value: string) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const root = createRootRoute();
    const route = createRoute({
      getParentRoute: () => root,
      path: "/data",
      loader: () => {
        if (identity === "b") return "B loader";
        started();
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
    });
    const router = createRouter({
      isServer: false,
      routeTree: root.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/data"] }),
    });
    const old = router.load();
    await ready;
    identity = "b";
    await transitionIdentityCaches(new QueryClient(), router, "b");
    finish("A private loader");
    await old;
    // The app's global Router Register describes production routes, while this
    // isolated router deliberately owns only the synthetic /data fixture.
    const matches = router.state.matches as readonly { routeId: string; loaderData?: unknown }[];
    expect(matches.find((match) => match.routeId === route.id)?.loaderData).toBe("B loader");
  });
});
