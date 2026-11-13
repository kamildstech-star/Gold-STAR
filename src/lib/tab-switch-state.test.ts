import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Coming back to the tab finds the app where he left it.
 *
 * David, 17 Sep: he switches to a spreadsheet in another tab, comes back, and
 * the app has reset. He had been told it was resource management; his answer:
 * "even if I go to another tab... I'm coming back, it's gone."
 *
 * The mechanism was in the auth listener, not in anything about resources.
 * Supabase fires TOKEN_REFRESHED when a backgrounded tab comes forward and the
 * access token is due, and EVERY auth event ran the full sign-in teardown —
 * clearIdentity() emptied the context and setLoading(true) put the whole
 * authenticated tree behind a loading shell. Everything under it unmounted and
 * came back fresh: which page of a list, how far down, which record was open.
 * Nothing about who he was had changed.
 */
const CONTEXT = readFileSync("src/components/app-context.tsx", "utf8").replace(/\r\n/g, "\n");
const ROUTER = readFileSync("src/router.tsx", "utf8").replace(/\r\n/g, "\n");

describe("a token refresh does not tear the app down", () => {
  it("only clears the identity when the signed-in user actually differs", () => {
    const listener = CONTEXT.slice(
      CONTEXT.indexOf("supabase.auth.onAuthStateChange"),
      CONTEXT.indexOf("sub.subscription.unsubscribe"),
    );
    expect(listener).toContain("const identityChanged = nextUserId !== lastUserId.current;");
    expect(listener).toMatch(/if \(identityChanged\) \{\s*clearIdentity\(\);\s*setLoading/);
  });

  it("calls clearIdentity exactly once in the listener, behind the guard", () => {
    /*
     * The old code ran it unconditionally, one line after the event arrived.
     * Counting is the honest check here: indentation cannot tell a guarded
     * call from a bare one, and there must be exactly the one.
     */
    const listener = CONTEXT.slice(
      CONTEXT.indexOf("supabase.auth.onAuthStateChange"),
      CONTEXT.indexOf("sub.subscription.unsubscribe"),
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(listener.match(/clearIdentity\(\)/g) ?? []).toHaveLength(1);
    expect(listener).toMatch(/if \(identityChanged\) \{\s*clearIdentity\(\)/);
  });

  it("still reloads the profile after a refresh, quietly", () => {
    /*
     * This used to assert a bare `void load()` and call it quiet. It was not:
     * load() opened with its own setLoading(true) and clearIdentity(), so the
     * guard above saved nothing — the teardown just happened one tick later.
     * Mark found it again on 5 Oct, on the New job form: "when they switch
     * tabs, it doesnt keep things in the fields." The refresh now says which
     * kind it is, and only a genuinely new user gets the loading shell.
     */
    const listener = CONTEXT.slice(
      CONTEXT.indexOf("supabase.auth.onAuthStateChange"),
      CONTEXT.indexOf("sub.subscription.unsubscribe"),
    );
    expect(listener).toContain("void load({ quiet: !identityChanged });");
    expect(listener).toContain("syncDocumentSessionCookie(session);");

    // And the quiet path really does skip the teardown.
    const head = CONTEXT.slice(
      CONTEXT.indexOf("const load = useCallback("),
      CONTEXT.indexOf("const { data: userData, error: userError }"),
    );
    expect(head).toMatch(/if \(!opts\?\.quiet\) \{\s*setLoading\(true\);\s*clearIdentity\(\);/);
  });

  it("treats the first event as a change, so a cold load still loads", () => {
    // lastUserId starts undefined, which no session id can equal.
    expect(CONTEXT).toContain("const lastUserId = useRef<string | null | undefined>(undefined);");
  });

  it("leaves the cache transition's own guard alone", () => {
    // transitionIdentityCaches already returned early on an unchanged user; it
    // was the teardown above it that did not.
    const cache = readFileSync("src/lib/identity-cache.ts", "utf8").replace(/\r\n/g, "\n");
    expect(cache).toContain("if (previous?.userId === userId) return previous.pending;");
  });
});

describe("the router still restores scroll", () => {
  it("has scroll restoration on", () => {
    expect(ROUTER).toContain("scrollRestoration: true");
  });
});
