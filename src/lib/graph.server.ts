/**
 * Microsoft Graph transport — server only.
 *
 * Two auth models, chosen by `OUTLOOK_AUTH_MODE`:
 *
 *  - **delegated** (the default since IT asked for it — Option A of
 *    docs/OUTLOOK-ACCESS-PROPOSAL.md). Every request carries ONE person's
 *    token (`{ kind: "delegated", userId }`), minted from the refresh token
 *    they granted on their Security page (microsoft-delegated.server.ts).
 *    Microsoft decides what that token can reach: the person's own mailbox,
 *    plus a shared mailbox IT has given them Full Access to when they granted
 *    the `.Shared` scopes. Which person's token speaks for which mailbox is
 *    decided in graph-auth.server.ts, and nowhere else.
 *  - **application** — app-only client credentials with admin consent, as
 *    first designed. Reps connect nothing and history survives a departure,
 *    but the credential can reach every mailbox in the tenant unless IT
 *    applies an ApplicationAccessPolicy, which we cannot enforce from here.
 *    Unchanged; kept for the day Gold Star chooses Option B.
 *
 * Every Graph helper takes the `GraphAuth` to use as its last argument.
 * Asking for the wrong kind for the configured mode throws, rather than
 * quietly reaching Graph with a broader (or different) credential.
 */
import {
  delegatedConfig,
  delegatedMissingSecrets,
  loadOutlookEnv,
} from "@/lib/microsoft-delegated.server";
import { joinOrigin, serverAppOrigin } from "@/lib/app-origin";
import { outlookAuthMode } from "@/lib/microsoft-oauth";

export type GraphAuth = { kind: "application" } | { kind: "delegated"; userId: string };

/** The company-wide client-credentials token. Only valid in application mode. */
export const APP_AUTH: GraphAuth = { kind: "application" };

const GRAPH = "https://graph.microsoft.com/v1.0";
const LOGIN = "https://login.microsoftonline.com";

let cachedToken: { value: string; expiresAt: number } | null = null;

/**
 * Whether the configured mode has what it needs to talk to Graph at all.
 *
 * Synchronous, so it reads process.env as it stands: a server entry point
 * calls `await loadOutlookEnv()` first, or the values an admin typed on the
 * Integrations screen are not there yet (outlook-env.wiring.test.ts).
 */
export function graphConfigured(): boolean {
  if (outlookAuthMode() === "delegated") return delegatedConfig() !== null;
  return Boolean(
    process.env["OUTLOOK_CLIENT_ID"] &&
    process.env["OUTLOOK_CLIENT_SECRET"] &&
    process.env["OUTLOOK_TENANT_ID"],
  );
}

export function graphMissingSecrets(): string[] {
  if (outlookAuthMode() === "delegated") {
    return [
      ...delegatedMissingSecrets(),
      ...(process.env["OUTLOOK_WEBHOOK_CLIENT_STATE"] ? [] : ["OUTLOOK_WEBHOOK_CLIENT_STATE"]),
    ];
  }
  return [
    "OUTLOOK_CLIENT_ID",
    "OUTLOOK_CLIENT_SECRET",
    "OUTLOOK_TENANT_ID",
    "OUTLOOK_WEBHOOK_CLIENT_STATE",
  ].filter((name) => !process.env[name]);
}

export function notificationUrl(): string {
  return joinOrigin(serverAppOrigin(), "/api/public/hooks/outlook");
}

/** Application mode's client-credentials token. */
async function accessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const tenant = process.env["OUTLOOK_TENANT_ID"];
  const clientId = process.env["OUTLOOK_CLIENT_ID"];
  const clientSecret = process.env["OUTLOOK_CLIENT_SECRET"];
  if (!tenant || !clientId || !clientSecret) {
    throw new Error(
      "Microsoft 365 is not configured. Add OUTLOOK_TENANT_ID, OUTLOOK_CLIENT_ID and OUTLOOK_CLIENT_SECRET in Project Settings → Secrets.",
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(`${LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Microsoft token request failed [${res.status}]: ${text}`);
  }
  const json = JSON.parse(text) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

/**
 * The bearer for one request. A mismatch between the auth asked for and the
 * configured mode is a bug at the call site; it fails here, before Graph.
 */
async function tokenFor(auth: GraphAuth): Promise<string> {
  // Every Graph request passes here, so no request can go out on a
  // deployment secret an admin has since replaced on the Integrations screen.
  await loadOutlookEnv();
  const mode = outlookAuthMode();
  if (auth.kind === "application") {
    if (mode !== "application") {
      throw new Error(
        "A company-wide (application) Graph token was requested while OUTLOOK_AUTH_MODE is delegated.",
      );
    }
    return accessToken();
  }
  if (mode !== "delegated") {
    throw new Error(
      "A per-person Graph token was requested while OUTLOOK_AUTH_MODE is application.",
    );
  }
  const { getDelegatedAccessToken } = await import("@/lib/microsoft-delegated.server");
  return getDelegatedAccessToken(auth.userId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GraphError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Microsoft Graph request failed [${status}]: ${body}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * Graph throttles hard at tenant scale, so 429/503/504 are retried with the
 * server's own Retry-After when it supplies one and exponential backoff when
 * it does not. Everything else surfaces the provider's status and body — a
 * generic 500 would hide the actual permission or scoping problem.
 */
export async function graphFetch(
  pathOrUrl: string,
  init: RequestInit = {},
  auth: GraphAuth = APP_AUTH,
): Promise<Response> {
  return graphFetchAttempt(pathOrUrl, init, auth, 0, false);
}

async function graphFetchAttempt(
  pathOrUrl: string,
  init: RequestInit,
  auth: GraphAuth,
  attempt: number,
  reauthed: boolean,
): Promise<Response> {
  const url = graphRequestUrl(pathOrUrl);
  const token = await tokenFor(auth);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  // Never follow a redirect: the bearer token must only ever go to Graph.
  // "manual", not "error" — Cloudflare Workers refuse redirect: "error"
  // outright ("does not make sense at the edge"), which threw before any
  // request left. A 3xx comes back as itself and is refused here.
  const res = await fetch(url, { ...init, headers, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`Microsoft Graph answered ${res.status} with a redirect; not followed.`);
  }

  if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 4) {
    const retryAfter = Number(res.headers.get("Retry-After") ?? 0);
    const waitMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 16_000);
    await sleep(waitMs);
    return graphFetchAttempt(pathOrUrl, init, auth, attempt + 1, reauthed);
  }

  // A person's access token can die inside its hour (password change, IT
  // revoking sessions). Drop the cached one and try once with a fresh token;
  // if the refresh itself is refused, that marks the connection
  // needs_reconnect and throws instead of retrying.
  if (res.status === 401 && auth.kind === "delegated" && !reauthed) {
    const { forgetAccessToken } = await import("@/lib/microsoft-delegated.server");
    forgetAccessToken(auth.userId);
    return graphFetchAttempt(pathOrUrl, init, auth, attempt, true);
  }

  return res;
}

/** Every request carries a bearer token: never send one outside Graph. */
export function graphRequestUrl(pathOrUrl: string): string {
  // Intentionally reject control characters before attaching the bearer token.
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000- ]/.test(pathOrUrl)) throw new Error("Invalid Graph URL.");
  const url = new URL(pathOrUrl.startsWith("/") ? `${GRAPH}${pathOrUrl}` : pathOrUrl);
  if (
    url.origin !== "https://graph.microsoft.com" ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith("/v1.0/")
  )
    throw new Error("Invalid Graph URL.");
  return url.href;
}

export async function graphJson<T>(
  pathOrUrl: string,
  init: RequestInit = {},
  auth: GraphAuth = APP_AUTH,
): Promise<T> {
  const res = await graphFetch(pathOrUrl, init, auth);
  if (!res.ok) {
    throw new GraphError(res.status, await res.text());
  }
  // An empty success is a success. sendMail (and /reply) answer 202 Accepted
  // with no body; reading that as JSON threw "Unexpected end of JSON input"
  // AFTER Outlook had sent the mail, so the send was recorded as failed and
  // the retry sweep sent it again, up to six times (2026-10-13).
  const text = await res.text();
  if (res.status === 204 || !text.trim()) return undefined as T;
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ */
/* Subscriptions (change notifications)                                */
/* ------------------------------------------------------------------ */

export type GraphSubscription = {
  id: string;
  resource: string;
  expirationDateTime: string;
};

/** Mail subscriptions max out near three days; we ask for ~2.5 and renew daily. */
export function subscriptionExpiry(hours = 60): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

export async function createSubscription(
  input: {
    resource: string;
    changeType?: string;
    clientState: string;
    expirationHours?: number;
  },
  auth: GraphAuth,
): Promise<GraphSubscription> {
  return graphJson<GraphSubscription>(
    "/subscriptions",
    {
      method: "POST",
      body: JSON.stringify({
        changeType: input.changeType ?? "created,updated,deleted",
        notificationUrl: notificationUrl(),
        resource: input.resource,
        clientState: input.clientState,
        expirationDateTime: subscriptionExpiry(input.expirationHours ?? 60),
      }),
    },
    auth,
  );
}

export async function renewSubscription(
  id: string,
  auth: GraphAuth,
  expirationHours = 60,
): Promise<GraphSubscription> {
  return graphJson<GraphSubscription>(
    `/subscriptions/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ expirationDateTime: subscriptionExpiry(expirationHours) }),
    },
    auth,
  );
}

export async function deleteSubscription(id: string, auth: GraphAuth): Promise<void> {
  const res = await graphFetch(
    `/subscriptions/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    auth,
  );
  if (!res.ok && res.status !== 404) throw new GraphError(res.status, await res.text());
}

/* ------------------------------------------------------------------ */
/* Messages + events                                                   */
/* ------------------------------------------------------------------ */

export type GraphRecipient = { emailAddress?: { address?: string; name?: string } };

export type GraphMessage = {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  webLink?: string;
  isDraft?: boolean;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  internetMessageHeaders?: { name: string; value: string }[];
  "@removed"?: { reason?: string };
};

export type GraphEvent = {
  id: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  webLink?: string;
  seriesMasterId?: string;
  lastModifiedDateTime?: string;
  location?: { displayName?: string };
  organizer?: GraphRecipient;
  responseStatus?: { response?: string };
  attendees?: (GraphRecipient & { status?: { response?: string } })[];
  "@removed"?: { reason?: string };
};

const MESSAGE_FIELDS =
  "id,conversationId,internetMessageId,subject,bodyPreview,receivedDateTime,sentDateTime,webLink,isDraft,from,sender,toRecipients,ccRecipients";
const EVENT_FIELDS =
  "id,subject,bodyPreview,start,end,isAllDay,isCancelled,webLink,seriesMasterId,lastModifiedDateTime,location,organizer,responseStatus,attendees";

/**
 * Items per delta page. Sent ONLY as `Prefer: odata.maxpagesize` (see
 * drainDelta), never as `$top`: calendarView delta answers `$top` with 400
 * ErrorInvalidUrlQuery ("page size cannot be guaranteed"), and the Prefer
 * header is the page-size control every Graph delta endpoint documents.
 */
export const DELTA_PAGE_SIZE = 50;

/** One Prefer header, comma-separated, as Graph reads it. */
export const DELTA_PREFER = `odata.maxpagesize=${DELTA_PAGE_SIZE},outlook.body-content-type="text"`;

export function messagesDeltaStart(upn: string): string {
  return `/users/${encodeURIComponent(upn)}/mailFolders/AllItems/messages/delta?$select=${MESSAGE_FIELDS}`;
}

/**
 * calendarView delta takes only the window: no `$top` (rejected outright) and
 * no `$select` (documented as unsupported there; it returns the same default
 * event properties a plain GET /calendarView does, which covers EVENT_FIELDS).
 */
export function eventsDeltaStart(upn: string): string {
  const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 365 * 86_400_000).toISOString();
  return `/users/${encodeURIComponent(upn)}/calendarView/delta?startDateTime=${from}&endDateTime=${to}`;
}

/**
 * A stored calendar deltaLink that carries `$top` cannot be replayed — Graph
 * refuses it the same way it refuses the first request. Treat it as absent so
 * the round restarts from a clean link. Links Graph itself hands back encode
 * their options in the token, so this only ever drops a hand-built one.
 */
export function usableEventsDeltaLink(link: string | null): string | null {
  if (!link) return null;
  return /[?&](?:\$|%24)top=/i.test(link) ? null : link;
}

export type DeltaPage<T> = {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
};

/**
 * Walks a delta chain to the end and returns the items plus the new
 * deltaLink. Delta reconciliation is what makes a dropped webhook harmless —
 * push is for freshness, delta is for correctness.
 *
 * `@odata.nextLink` / a stored `@odata.deltaLink` already carry their own
 * encoded query, so they are requested exactly as Graph gave them — nothing
 * appended. Page size rides on the Prefer header on every page.
 */
export async function drainDelta<T>(
  startUrl: string,
  auth: GraphAuth,
  maxPages = 40,
): Promise<{ items: T[]; deltaLink: string | null }> {
  const items: T[] = [];
  let url: string | undefined = startUrl;
  let deltaLink: string | null = null;
  let pages = 0;

  while (url && pages < maxPages) {
    const page: DeltaPage<T> = await graphJson<DeltaPage<T>>(
      url,
      { headers: { Prefer: DELTA_PREFER } },
      auth,
    );
    items.push(...(page.value ?? []));
    deltaLink = page["@odata.deltaLink"] ?? deltaLink;
    url = page["@odata.nextLink"];
    pages += 1;
  }

  return { items, deltaLink };
}

export async function getMessage(upn: string, id: string, auth: GraphAuth): Promise<GraphMessage> {
  return graphJson<GraphMessage>(
    `/users/${encodeURIComponent(upn)}/messages/${encodeURIComponent(id)}?$select=${MESSAGE_FIELDS}&$expand=` +
      // Spaces encoded: graphRequestUrl refuses a raw space (or any control
      // character) before it attaches a bearer token, so the unencoded form
      // made every getMessage throw "Invalid Graph URL".
      `singleValueExtendedProperties($filter=id%20eq%20'String%200x0070')`,
    {},
    auth,
  );
}

/** Full body is fetched on demand — we do not warehouse every message body. */
export async function getMessageBody(
  upn: string,
  id: string,
  auth: GraphAuth,
): Promise<{ contentType: string; content: string }> {
  const msg = await graphJson<{ body?: { contentType?: string; content?: string } }>(
    `/users/${encodeURIComponent(upn)}/messages/${encodeURIComponent(id)}?$select=body`,
    {},
    auth,
  );
  return {
    contentType: msg.body?.contentType ?? "text",
    content: msg.body?.content ?? "",
  };
}

export async function getEvent(upn: string, id: string, auth: GraphAuth): Promise<GraphEvent> {
  return graphJson<GraphEvent>(
    `/users/${encodeURIComponent(upn)}/events/${encodeURIComponent(id)}?$select=${EVENT_FIELDS}`,
    {},
    auth,
  );
}

export async function sendMailAs(
  upn: string,
  message: {
    subject: string;
    contentType: "Text" | "HTML";
    content: string;
    to: string[];
    cc?: string[];
    replyToMessageId?: string | null;
    /** Where the customer's reply goes, when it is not the sending mailbox. */
    replyTo?: string[] | null;
    /**
     * An RFC 5322 Message-ID of our own. sendMail answers 202 with no id, so
     * this is the only handle the CRM keeps on what Outlook sent — and a
     * receiving server that sees the same id twice can drop the repeat.
     */
    internetMessageId?: string | null;
  },
  auth: GraphAuth,
): Promise<void> {
  const recipients = (list: string[]) => list.map((address) => ({ emailAddress: { address } }));

  if (message.replyToMessageId) {
    await graphJson(
      `/users/${encodeURIComponent(upn)}/messages/${encodeURIComponent(message.replyToMessageId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({
          message: {
            toRecipients: recipients(message.to),
            ...(message.cc?.length ? { ccRecipients: recipients(message.cc) } : {}),
          },
          comment: message.content,
        }),
      },
      auth,
    );
    return;
  }

  await graphJson(
    `/users/${encodeURIComponent(upn)}/sendMail`,
    {
      method: "POST",
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: { contentType: message.contentType, content: message.content },
          toRecipients: recipients(message.to),
          ...(message.cc?.length ? { ccRecipients: recipients(message.cc) } : {}),
          ...(message.replyTo?.length ? { replyTo: recipients(message.replyTo) } : {}),
          ...(message.internetMessageId ? { internetMessageId: message.internetMessageId } : {}),
        },
        saveToSentItems: true,
      }),
    },
    auth,
  );
}

export async function createCalendarEvent(
  upn: string,
  input: {
    subject: string;
    body?: string;
    startIso: string;
    endIso: string;
    attendees: string[];
    locationText?: string | null;
  },
  auth: GraphAuth,
): Promise<GraphEvent> {
  return graphJson<GraphEvent>(
    `/users/${encodeURIComponent(upn)}/events`,
    {
      method: "POST",
      body: JSON.stringify({
        subject: input.subject,
        body: { contentType: "Text", content: input.body ?? "" },
        start: { dateTime: input.startIso, timeZone: "UTC" },
        end: { dateTime: input.endIso, timeZone: "UTC" },
        ...(input.locationText ? { location: { displayName: input.locationText } } : {}),
        attendees: input.attendees.map((address) => ({
          emailAddress: { address },
          type: "required",
        })),
      }),
    },
    auth,
  );
}

/**
 * Patch an event that already exists in the mailbox.
 *
 * Graph re-notifies the attendees itself when a meeting's time, place, subject
 * or invitee list changes, which is the entire point: the alternative is
 * everyone keeping the original invite. Same `Calendars.ReadWrite` permission
 * the create path already uses — no new scope, in either mode.
 */
export async function updateCalendarEvent(
  upn: string,
  id: string,
  patch: Record<string, unknown>,
  auth: GraphAuth,
): Promise<GraphEvent> {
  return graphJson<GraphEvent>(
    `/users/${encodeURIComponent(upn)}/events/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
    auth,
  );
}

/**
 * The cancellation notice. Only valid on a meeting this mailbox organises and
 * that has attendees to notify — a solo appointment is removed with
 * `deleteCalendarEvent` instead.
 */
export async function cancelCalendarEvent(upn: string, id: string, auth: GraphAuth): Promise<void> {
  await graphJson(
    `/users/${encodeURIComponent(upn)}/events/${encodeURIComponent(id)}/cancel`,
    { method: "POST", body: JSON.stringify({ comment: "Canceled from Recovery Hub." }) },
    auth,
  );
}

/** Already gone is the outcome we wanted, so a 404 is success, not an error. */
export async function deleteCalendarEvent(upn: string, id: string, auth: GraphAuth): Promise<void> {
  const res = await graphFetch(
    `/users/${encodeURIComponent(upn)}/events/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    auth,
  );
  if (!res.ok && res.status !== 404) throw new GraphError(res.status, await res.text());
}

/**
 * Directory lookup by UPN. Needs `User.Read.All`, so it is APPLICATION MODE
 * ONLY: delegated mode takes a mailbox's id and name from its owner's own
 * connection instead, which is why IT is not asked for directory-wide read.
 */
export async function lookupGraphUser(
  upn: string,
): Promise<{ id: string; displayName: string | null } | null> {
  const res = await graphFetch(
    `/users/${encodeURIComponent(upn)}?$select=id,displayName,mail,userPrincipalName`,
    {},
    APP_AUTH,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new GraphError(res.status, await res.text());
  const json = (await res.json()) as { id: string; displayName?: string };
  return { id: json.id, displayName: json.displayName ?? null };
}
