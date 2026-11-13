import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Graph transport and its two big callers under delegated tokens:
 *  - a request carries exactly the token the router chose, and the wrong kind
 *    for the configured mode throws before anything leaves the process;
 *  - a 401 mid-hour drops the cached token and retries once;
 *  - a mailbox with no usable token is skipped by sync and subscriptions
 *    without a single Graph call, and the calendar queue leaves its rows
 *    untouched;
 *  - application mode still mints a client-credentials token, as before.
 */
const delegated = vi.hoisted(() => ({
  token: vi.fn(async (userId: string) => `delegated-token-for-${userId}`),
  forget: vi.fn(),
}));
vi.mock("@/lib/microsoft-delegated.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./microsoft-delegated.server")>()),
  getDelegatedAccessToken: delegated.token,
  forgetAccessToken: delegated.forget,
}));

const routing = vi.hoisted(() => ({
  result: null as null | Record<string, unknown>,
}));
vi.mock("@/lib/graph-auth.server", () => ({
  resolveMailboxAuth: vi.fn(async () => routing.result),
  resolveMailboxAuthById: vi.fn(async () => routing.result),
}));

const db = vi.hoisted(() => ({ writes: [] as Array<{ table: string; patch: unknown }> }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    // calendar_push_authorized_event: the database clears the push through
    // mailbox "mbx", so what is left to test is the token step after it.
    rpc: async () => ({
      data: { row: {}, mailbox: { id: "mbx", upn: "office@goldstar.test" } },
      error: null,
    }),
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        eq: chain,
        in: chain,
        is: chain,
        order: chain,
        limit: chain,
        update: (patch: unknown) => {
          db.writes.push({ table, patch });
          return q;
        },
        maybeSingle: async () => ({
          data:
            table === "graph_mailboxes"
              ? { id: "mbx", upn: "office@goldstar.test", enabled: true, sync_calendar: true }
              : null,
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return q;
    },
  },
}));

import { pushCalendarRow } from "./calendar-push.server";
import { ensureSubscriptions, syncMailbox, type Mailbox } from "./graph-sync.server";
import {
  APP_AUTH,
  DELTA_PAGE_SIZE,
  drainDelta,
  eventsDeltaStart,
  getMessage,
  graphFetch,
  messagesDeltaStart,
  usableEventsDeltaLink,
} from "./graph.server";

const TENANT = "9f1c1b5e-1234-4abc-8def-0123456789ab";

beforeEach(() => {
  vi.clearAllMocks();
  db.writes = [];
  routing.result = null;
  vi.stubEnv("OUTLOOK_TENANT_ID", TENANT);
  vi.stubEnv("OUTLOOK_CLIENT_ID", "client");
  vi.stubEnv("OUTLOOK_CLIENT_SECRET", "secret");
  vi.stubEnv("INTEGRATION_CRED_KEY", "key");
  vi.stubEnv("OUTLOOK_WEBHOOK_CLIENT_STATE", "state");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("transport", () => {
  it("delegated mode: a person's token is the bearer", async () => {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated");
    const fetchMock = vi.fn(async () => Response.json({ id: "m1" }));
    vi.stubGlobal("fetch", fetchMock);
    await getMessage("rep@goldstar.test", "m1", { kind: "delegated", userId: "rep-1" });
    const headers = new Headers(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
    );
    expect(headers.get("Authorization")).toBe("Bearer delegated-token-for-rep-1");
    expect(delegated.token).toHaveBeenCalledWith("rep-1");
  });

  it("delegated mode refuses to mint the company token, before any request", async () => {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(graphFetch("/users/a/messages", {}, APP_AUTH)).rejects.toThrow(/delegated/);
    await expect(graphFetch("/users/a/messages")).rejects.toThrow(/delegated/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("application mode refuses a per-person token", async () => {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      graphFetch("/users/a/messages", {}, { kind: "delegated", userId: "rep-1" }),
    ).rejects.toThrow(/application/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(delegated.token).not.toHaveBeenCalled();
  });

  it("a 401 drops the cached person's token and retries exactly once", async () => {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(new Response("still no", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await graphFetch("/users/a/messages", {}, { kind: "delegated", userId: "rep-1" });
    expect(res.status).toBe(401);
    expect(delegated.forget).toHaveBeenCalledWith("rep-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("application mode: client credentials, then Graph — unchanged", async () => {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "application");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ access_token: "app-token", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ id: "m1" }));
    vi.stubGlobal("fetch", fetchMock);
    await getMessage("rep@goldstar.test", "m1", APP_AUTH);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(tokenUrl).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(String(tokenInit.body)).toContain("grant_type=client_credentials");
    const graphHeaders = new Headers((fetchMock.mock.calls[1] as [string, RequestInit])[1].headers);
    expect(graphHeaders.get("Authorization")).toBe("Bearer app-token");
    expect(delegated.token).not.toHaveBeenCalled();
  });
});

describe("a mailbox nobody can speak for is skipped, not failed", () => {
  const mailbox = {
    id: "mbx",
    upn: "office@goldstar.test",
    graph_user_id: null,
    kind: "shared_office",
    location_id: "loc",
    user_id: null,
    owner_user_id: null,
    enabled: true,
    sync_mail: true,
    sync_calendar: true,
    messages_delta_link: null,
    events_delta_link: null,
    messages_subscription_id: "sub-1",
    messages_subscription_expires_at: null,
    events_subscription_id: null,
    events_subscription_expires_at: null,
  } as Mailbox;
  const noOwner = {
    ok: false,
    problem: "no_owner",
    holderUserId: null,
    message:
      "office@goldstar.test needs an owner: nobody with Full Access has been assigned to connect it.",
  };

  beforeEach(() => vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated"));

  it("sync: reported as skipped, no Graph call, mailbox error untouched", async () => {
    routing.result = noOwner;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await syncMailbox(mailbox);
    expect(r).toMatchObject({ error: null, skipped: { problem: "no_owner" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes).toEqual([]);
  });

  it("subscriptions: not renewed or recreated with anybody else's token", async () => {
    routing.result = noOwner;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const r = await ensureSubscriptions(mailbox);
    expect(r).toMatchObject({ error: null, skipped: { problem: "no_owner" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sync with a usable holder walks delta on that holder's token", async () => {
    routing.result = {
      ok: true,
      auth: { kind: "delegated", userId: "office-owner" },
      holderUserId: "office-owner",
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/x/delta?$deltatoken=1",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await syncMailbox(mailbox);
    expect(r.error).toBeNull();
    expect(r.skipped).toBeUndefined();
    expect(fetchMock).toHaveBeenCalled();
    for (const call of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect(new Headers(call[1].headers).get("Authorization")).toBe(
        "Bearer delegated-token-for-office-owner",
      );
    }
  });

  it("calendar push: the row waits untouched — no attempt counted, no Graph call", async () => {
    routing.result = noOwner;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const out = await pushCalendarRow({
      id: "event",
      provider: null,
      external_id: null,
      mailbox_id: "mbx",
      organizer_email: null,
      user_id: null,
      location_id: "loc",
      sync_direction: "two_way",
      sync_state: "pending_push",
      subject: "Inspection",
      starts_at: "2099-01-01T10:00:00Z",
      ends_at: "2099-01-01T11:00:00Z",
      attendees: ["client@example.com"],
      is_cancelled: false,
      is_demo: false,
    } as never);
    expect(out).toMatchObject({ ok: false, waiting: true });
    expect(out.reason).toMatch(/needs an owner/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.writes.filter((w) => w.table === "calendar_events")).toEqual([]);
  });
});

/**
 * Graph refuses `$top` on calendarView delta (400 ErrorInvalidUrlQuery: "page
 * size cannot be guaranteed"). Page size goes in `Prefer: odata.maxpagesize`,
 * links Graph hands back are replayed verbatim, and a calendar failure never
 * stops the mail half of the sync.
 */
describe("delta page size and independent mail/calendar sync", () => {
  const holder = {
    ok: true,
    auth: { kind: "delegated", userId: "office-owner" },
    holderUserId: "office-owner",
  };
  const mailbox = {
    id: "mbx",
    upn: "office@goldstar.test",
    graph_user_id: null,
    kind: "shared_office",
    location_id: "loc",
    user_id: null,
    owner_user_id: null,
    enabled: true,
    sync_mail: true,
    sync_calendar: true,
    messages_delta_link: null,
    events_delta_link: null,
    messages_subscription_id: null,
    messages_subscription_expires_at: null,
    events_subscription_id: null,
    events_subscription_expires_at: null,
  } as Mailbox;
  const calls = (m: ReturnType<typeof vi.fn>) => m.mock.calls as unknown as [string, RequestInit][];
  const invalidTop = () =>
    new Response(
      JSON.stringify({
        error: {
          code: "ErrorInvalidUrlQuery",
          message:
            "The '$top' parameter is not supported with change tracking over the 'CalendarView' resource as page size cannot be guaranteed.",
        },
      }),
      { status: 400 },
    );
  const deltaPage = (link: string) => Response.json({ value: [], "@odata.deltaLink": link });
  const mailboxWrites = () =>
    db.writes.filter((w) => w.table === "graph_mailboxes").map((w) => w.patch) as Record<
      string,
      unknown
    >[];

  beforeEach(() => {
    vi.stubEnv("OUTLOOK_AUTH_MODE", "delegated");
    routing.result = holder;
  });

  it("calendarView delta start URL carries no $top (and no $select)", () => {
    const url = eventsDeltaStart("office@goldstar.test");
    expect(url).toContain("/calendarView/delta?startDateTime=");
    expect(url).not.toMatch(/\$top|%24top/i);
    expect(url).not.toMatch(/\$select/);
  });

  it("messages delta start URL leaves page size to the Prefer header too", () => {
    expect(messagesDeltaStart("office@goldstar.test")).not.toMatch(/\$top|%24top/i);
  });

  it("every delta page asks for its size with Prefer: odata.maxpagesize", async () => {
    const fetchMock = vi.fn(async () =>
      deltaPage("https://graph.microsoft.com/v1.0/x/delta?$deltatoken=1"),
    );
    vi.stubGlobal("fetch", fetchMock);
    await drainDelta(eventsDeltaStart("office@goldstar.test"), {
      kind: "delegated",
      userId: "office-owner",
    });
    const [url, init] = calls(fetchMock)[0]!;
    expect(url).not.toMatch(/\$top|%24top/i);
    const prefer = new Headers(init.headers).get("Prefer") ?? "";
    expect(prefer).toContain(`odata.maxpagesize=${DELTA_PAGE_SIZE}`);
    expect(prefer).toContain('outlook.body-content-type="text"');
  });

  it("nextLink and a stored deltaLink are requested verbatim, nothing appended", async () => {
    const stored =
      "https://graph.microsoft.com/v1.0/users/office%40goldstar.test/calendarView/delta?$deltatoken=STORED-1";
    const next =
      "https://graph.microsoft.com/v1.0/users/office%40goldstar.test/calendarView/delta?$skiptoken=NEXT-2";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ value: [], "@odata.nextLink": next }))
      .mockResolvedValueOnce(
        deltaPage(
          "https://graph.microsoft.com/v1.0/users/office%40goldstar.test/calendarView/delta?$deltatoken=NEW-3",
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const out = await drainDelta(stored, { kind: "delegated", userId: "office-owner" });
    expect(calls(fetchMock).map(([url]) => url)).toEqual([stored, next]);
    expect(out.deltaLink).toContain("$deltatoken=NEW-3");
    for (const [, init] of calls(fetchMock)) {
      expect(new Headers(init.headers).get("Prefer")).toContain(
        `odata.maxpagesize=${DELTA_PAGE_SIZE}`,
      );
    }
  });

  it("a stored calendar link carrying $top is ignored and the round restarts", async () => {
    expect(
      usableEventsDeltaLink(
        "https://graph.microsoft.com/v1.0/users/a/calendarView/delta?startDateTime=x&$top=50",
      ),
    ).toBeNull();
    expect(
      usableEventsDeltaLink(
        "https://graph.microsoft.com/v1.0/users/a/calendarView/delta?%24top=50",
      ),
    ).toBeNull();
    const good = "https://graph.microsoft.com/v1.0/users/a/calendarView/delta?$deltatoken=1";
    expect(usableEventsDeltaLink(good)).toBe(good);
    expect(usableEventsDeltaLink(null)).toBeNull();

    const fetchMock = vi.fn(async () =>
      deltaPage("https://graph.microsoft.com/v1.0/x/delta?$deltatoken=1"),
    );
    vi.stubGlobal("fetch", fetchMock);
    await syncMailbox({
      ...mailbox,
      sync_mail: false,
      events_delta_link:
        "https://graph.microsoft.com/v1.0/users/office%40goldstar.test/calendarView/delta?startDateTime=x&$top=50",
    });
    const [url] = calls(fetchMock)[0]!;
    expect(url).toContain("/calendarView/delta?startDateTime=");
    expect(url).not.toMatch(/\$top|%24top/i);
  });

  it("a mailbox that last failed on $top syncs cleanly next run", async () => {
    const fetchMock = vi.fn(async () =>
      deltaPage("https://graph.microsoft.com/v1.0/x/delta?$deltatoken=1"),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await syncMailbox(mailbox);
    expect(r.error).toBeNull();
    expect(r.mail).not.toBeNull();
    expect(r.calendar).not.toBeNull();
    for (const [url] of calls(fetchMock)) expect(url).not.toMatch(/\$top|%24top/i);
    expect(mailboxWrites().at(-1)).toMatchObject({ last_error: null });
  });

  it("mail keeps syncing when the calendar fails", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/calendarView/")
        ? invalidTop()
        : deltaPage(
            "https://graph.microsoft.com/v1.0/users/office%40goldstar.test/messages/delta?$deltatoken=MAIL-1",
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await syncMailbox(mailbox);
    expect(r.mail).toMatchObject({ seen: 0 });
    expect(r.calendar).toBeNull();
    expect(r.error).toMatch(/^Calendar: .*ErrorInvalidUrlQuery/);
    expect(r.error).not.toMatch(/Mail:/);
    const patch = mailboxWrites().at(-1)!;
    expect(patch["messages_delta_link"]).toContain("$deltatoken=MAIL-1");
    expect(patch["last_error"]).toMatch(/^Calendar: /);
    // Only the calendar chain is reset; the mail chain keeps its new link.
    expect(patch["events_delta_link"]).toBeNull();
  });

  it("calendar still syncs when mail fails", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/messages/")
        ? new Response("mail is down", { status: 500 })
        : deltaPage(
            "https://graph.microsoft.com/v1.0/users/office%40goldstar.test/calendarView/delta?$deltatoken=CAL-1",
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await syncMailbox(mailbox);
    expect(r.calendar).toMatchObject({ seen: 0 });
    expect(r.mail).toBeNull();
    expect(r.error).toMatch(/^Mail: .*\[500\]/);
    const patch = mailboxWrites().at(-1)!;
    expect(patch["events_delta_link"]).toContain("$deltatoken=CAL-1");
    expect(patch).not.toHaveProperty("messages_delta_link");
    expect(patch["last_error"]).toMatch(/^Mail: /);
  });

  it("both failing are both named in last_error", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("/calendarView/") ? invalidTop() : new Response("nope", { status: 403 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const r = await syncMailbox(mailbox);
    expect(r.error).toMatch(/^Mail: .*\[403\].* \| Calendar: .*\[400\]/);
  });
});
