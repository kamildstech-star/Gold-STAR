/**
 * Whose token speaks for which mailbox — server only, and the ONLY place that
 * decides it.
 *
 * In application mode the answer is always the company credential, exactly
 * as before. In delegated mode (IT's ask: Option A of
 * docs/OUTLOOK-ACCESS-PROPOSAL.md) every Graph call acts as one person:
 *
 *  - **Reading and syncing a mailbox** (delta, subscriptions, notifications,
 *    on-demand bodies, calendar pushes) uses the token of the person who
 *    holds it: a personal mailbox's own user (`graph_mailboxes.user_id`), or
 *    a shared office mailbox's recorded owner (`graph_mailboxes.owner_user_id`)
 *    — someone IT has given Full Access to, who connected with the `.Shared`
 *    scopes. Nobody connected, connection dead, owner deactivated: the
 *    mailbox is reported and skipped, never served by anyone else's token.
 *  - **Sending and booking** uses the CALLER's own token, so mail goes out
 *    as the person who pressed Send, under the rights Microsoft gives them:
 *    `Mail.Send` for their own mailbox, `Mail.Send.Shared` for an office
 *    mailbox they have Send As on. `assertCanSendAs` still runs first; this
 *    narrows it, it never widens it.
 *
 * Microsoft enforces the boundary either way. These rules only decide whose
 * token we try, so that a mailbox with no willing owner stays unsynced
 * rather than borrowing someone's broader access.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { APP_AUTH, type GraphAuth } from "@/lib/graph.server";
import {
  supabaseConnectionStore,
  type ConnectionRow,
  type ConnectionStore,
} from "@/lib/microsoft-delegated.server";
import { hasSharedScopes, outlookAuthMode } from "@/lib/microsoft-oauth";
import { isMissingSchema } from "@/lib/schema-fallback";

export type MailboxForAuth = {
  upn: string;
  kind: string;
  user_id: string | null;
  owner_user_id?: string | null;
};

export type MailboxAuthProblem =
  /** A shared mailbox nobody has been recorded as owning. */
  | "no_owner"
  /** The holder has never connected Outlook (or disconnected). */
  | "not_connected"
  /** Microsoft refused the holder's sign-in; only they can fix it. */
  | "needs_reconnect"
  /** The holder's Recovery Hub account is deactivated. */
  | "inactive"
  /** An office mailbox owner connected without the .Shared scopes. */
  | "missing_shared_scopes";

export type MailboxAuth =
  | { ok: true; auth: GraphAuth; holderUserId: string | null }
  | { ok: false; problem: MailboxAuthProblem; holderUserId: string | null; message: string };

/** A personal mailbox is read with its own person's token; anything else needs an owner. */
function holderOf(mailbox: MailboxForAuth): { userId: string | null; shared: boolean } {
  if (mailbox.kind !== "shared_office" && mailbox.user_id) {
    return { userId: mailbox.user_id, shared: false };
  }
  return { userId: mailbox.owner_user_id ?? null, shared: true };
}

function problemMessage(problem: MailboxAuthProblem, mailbox: MailboxForAuth, shared: boolean) {
  const who = shared ? "Its owner" : "Its person";
  switch (problem) {
    case "no_owner":
      return `${mailbox.upn} needs an owner: nobody with Full Access has been assigned to connect it.`;
    case "not_connected":
      return shared
        ? `${mailbox.upn} needs an owner: the assigned owner has not connected Outlook.`
        : `${mailbox.upn} is not connected: its person has not connected Outlook yet.`;
    case "needs_reconnect":
      return `${mailbox.upn} is paused: ${who.toLowerCase()} needs to reconnect Outlook.`;
    case "inactive":
      return shared
        ? `${mailbox.upn} needs an owner: the assigned owner's account is no longer active.`
        : `${mailbox.upn} is paused: its person's account is no longer active.`;
    case "missing_shared_scopes":
      return `${mailbox.upn} is paused: its owner must reconnect Outlook with "I also look after a shared office mailbox" ticked.`;
  }
}

async function usable(
  userId: string,
  store: ConnectionStore,
): Promise<{ ok: true; row: ConnectionRow } | { ok: false; problem: MailboxAuthProblem }> {
  const row = await store.get(userId);
  if (!row) return { ok: false, problem: "not_connected" };
  if (row.status !== "connected") return { ok: false, problem: "needs_reconnect" };
  if (!(await store.isUserActive(userId))) return { ok: false, problem: "inactive" };
  return { ok: true, row };
}

/**
 * The same, by mailbox id, for callers that only carry the id (the calendar
 * push queue). A missing owner column (migration 20261007210000 not yet
 * applied) reads as "no owner".
 */
export async function resolveMailboxAuthById(
  mailboxId: string,
  store: ConnectionStore = supabaseConnectionStore,
): Promise<MailboxAuth> {
  if (outlookAuthMode() === "application") return { ok: true, auth: APP_AUTH, holderUserId: null };
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const read = (columns: string) =>
    (supabaseAdmin as unknown as SupabaseClient)
      .from("graph_mailboxes")
      .select(columns)
      .eq("id", mailboxId)
      .maybeSingle();
  let result = await read("upn, kind, user_id, owner_user_id");
  if (result.error && isMissingSchema(result.error)) result = await read("upn, kind, user_id");
  if (result.error) throw result.error;
  const row = result.data as unknown as MailboxForAuth | null;
  if (!row) {
    return {
      ok: false,
      problem: "no_owner",
      holderUserId: null,
      message: "That mailbox is no longer registered.",
    };
  }
  return resolveMailboxAuth(row, store);
}

/** The token that reads and syncs this mailbox. */
export async function resolveMailboxAuth(
  mailbox: MailboxForAuth,
  store: ConnectionStore = supabaseConnectionStore,
): Promise<MailboxAuth> {
  if (outlookAuthMode() === "application") return { ok: true, auth: APP_AUTH, holderUserId: null };

  const { userId, shared } = holderOf(mailbox);
  if (!userId) {
    return {
      ok: false,
      problem: "no_owner",
      holderUserId: null,
      message: problemMessage("no_owner", mailbox, shared),
    };
  }
  const check = await usable(userId, store);
  if (!check.ok) {
    return {
      ok: false,
      problem: check.problem,
      holderUserId: userId,
      message: problemMessage(check.problem, mailbox, shared),
    };
  }
  if (shared && !hasSharedScopes(check.row.scopes)) {
    return {
      ok: false,
      problem: "missing_shared_scopes",
      holderUserId: userId,
      message: problemMessage("missing_shared_scopes", mailbox, shared),
    };
  }
  return { ok: true, auth: { kind: "delegated", userId }, holderUserId: userId };
}

/**
 * The token a send or a meeting goes out on: the caller's own. Throws a
 * sentence the person can act on.
 */
export async function resolveSenderAuth(
  callerUserId: string,
  mailbox: MailboxForAuth,
  store: ConnectionStore = supabaseConnectionStore,
): Promise<GraphAuth> {
  if (outlookAuthMode() === "application") return APP_AUTH;

  const check = await usable(callerUserId, store);
  if (!check.ok) {
    throw new Error(
      check.problem === "needs_reconnect"
        ? "Microsoft stopped accepting your Outlook sign-in. Reconnect Outlook on your Security page, then try again."
        : check.problem === "inactive"
          ? "Your Recovery Hub account is not active."
          : "Connect Outlook on your Security page first — Recovery Hub sends as you, with your own sign-in.",
    );
  }
  const ownMailbox = mailbox.kind !== "shared_office" && mailbox.user_id === callerUserId;
  if (!ownMailbox && !hasSharedScopes(check.row.scopes)) {
    throw new Error(
      `To send from ${mailbox.upn}, reconnect Outlook on your Security page with "I also look after a shared office mailbox" ticked. IT must also have given you Send As on it.`,
    );
  }
  return { kind: "delegated", userId: callerUserId };
}
