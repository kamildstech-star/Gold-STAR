// TODO(remove after cutover): temporary, for moving the app off Lovable to
// Vercel. Delete with the rest of the secret transfer (see the header of
// secret-transfer.ts).
/**
 * The only code that reads the allowlisted values and the only code that
 * sends them anywhere. Server-only: reach it with a dynamic import from the
 * server function's handler.
 *
 * The rules, each with a test in secret-transfer.server.test.ts:
 *  - A value goes in one place: the body of an HTTPS POST to the fixed
 *    VERCEL_ENV_ENDPOINT. It is never returned, logged, thrown or stored.
 *  - Vercel's answer is read for its status and for whether its `failed`
 *    list is empty (a 201 can still carry a per-variable failure), and is
 *    otherwise thrown away. The body can echo the value, so not one byte of
 *    it reaches the result.
 *  - Redirects are not followed: the bearer token and the value must never be
 *    replayed to a host other than api.vercel.com.
 *  - One request per name, one after another. Vercel refuses a project's env
 *    update while another is in flight, and a per-name request gives each row
 *    its own status.
 */
import {
  SECRET_TRANSFER_ALLOWLIST,
  SECRET_TRANSFER_EXCLUDED,
  TRANSFER_CONFIRM_WORD,
  TRANSFER_TOKEN_ENV,
  VERCEL_ENV_ENDPOINT,
  VERCEL_TARGET,
  countStatuses,
  transferSwitchedOff,
  transferTarget,
  type PresenceRow,
  type SecretTransferCheck,
  type SecretTransferRun,
  type TransferRow,
} from "./secret-transfer";

type Env = Record<string, string | undefined>;
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;

/** Shown on each variable in Vercel's dashboard, so nobody wonders where it came from. */
const VERCEL_COMMENT = "Copied from the Lovable server by Transfer secrets (temporary, Owner-run).";

function isSet(value: string | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Which allowlisted names this server has a value for. No values, no lengths. */
export function checkPresence(env: Env): PresenceRow[] {
  return SECRET_TRANSFER_ALLOWLIST.map(({ name }) => ({ name, present: isSet(env[name]) }));
}

export function transferTokenConfigured(env: Env): boolean {
  return isSet(env[TRANSFER_TOKEN_ENV]);
}

/** The JSON body for one variable. Exported for the test that pins its shape. */
export function vercelEnvBody(name: string, value: string): string {
  return JSON.stringify({
    key: name,
    value,
    type: "sensitive",
    target: ["production"],
    comment: VERCEL_COMMENT,
  });
}

/**
 * Did Vercel store it? 2xx AND an empty `failed` list. Anything we cannot
 * read as that is a failure — never a guess at success.
 */
async function vercelAccepted(res: Response): Promise<boolean> {
  if (res.status < 200 || res.status >= 300) {
    await res.body?.cancel().catch(() => undefined);
    return false;
  }
  try {
    const body = (await res.json()) as { failed?: unknown } | null;
    return Array.isArray(body?.failed) ? body.failed.length === 0 : true;
  } catch {
    return false;
  }
}

/**
 * Sends every allowlisted name that is set here to Vercel Production. The
 * token is the caller's to read (from VERCEL_TRANSFER_TOKEN only); this
 * function refuses to run without one rather than sending unauthenticated.
 */
export async function transferSecrets(opts: {
  env: Env;
  token: string;
  fetchImpl?: FetchLike;
}): Promise<TransferRow[]> {
  if (!isSet(opts.token)) throw new Error(`${TRANSFER_TOKEN_ENV} is not set on this server.`);
  const doFetch: FetchLike = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  const rows: TransferRow[] = [];

  for (const { name } of SECRET_TRANSFER_ALLOWLIST) {
    // Never the token itself, whatever the list says.
    if (name === TRANSFER_TOKEN_ENV) continue;
    const value = opts.env[name];
    if (!isSet(value)) {
      rows.push({ name, status: "missing", httpStatus: null });
      continue;
    }
    try {
      const res = await doFetch(VERCEL_ENV_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.token}`,
          "Content-Type": "application/json",
        },
        body: vercelEnvBody(name, value),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const ok = await vercelAccepted(res);
      rows.push(
        ok
          ? { name, status: "copied", httpStatus: null }
          : { name, status: "failed", httpStatus: res.status },
      );
    } catch {
      // Network error, timeout, a refused redirect. The error can quote the
      // request, so it is dropped whole: the row says "no answer", nothing more.
      rows.push({ name, status: "failed", httpStatus: null });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The request: who may run it, how often, and the audit row.
// ---------------------------------------------------------------------------

export type SecretTransferRequest = { mode: "check" } | { mode: "transfer"; confirm: string };

/** The caller, as requireSupabaseAuth hands it over (active, approved profile already checked). */
export type CallerContext = {
  userId: string;
  supabase: {
    rpc: (
      fn: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: unknown }>;
  };
};

type AuditClient = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => {
      select: (cols: string) => {
        single: () => PromiseLike<{
          data: { id: string } | null;
          error: { message?: string } | null;
        }>;
      };
    };
    update: (row: Record<string, unknown>) => {
      eq: (col: string, value: string) => PromiseLike<{ error: { message?: string } | null }>;
    };
  };
};

type LimitRule = { limit: number; windowSeconds: number; blockSeconds?: number };

export type SecretTransferDeps = {
  env: Env;
  fetchImpl?: FetchLike;
  admin: AuditClient;
  consumeLimit: (
    bucket: string,
    identity: string,
    rule: LimitRule,
    onStoreError: "open" | "closed",
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  rules: { check: LimitRule; transfer: LimitRule };
  /** The clock for the built-in expiry; tests pass a fixed one. */
  now?: () => Date;
};

async function assertOwner(ctx: CallerContext): Promise<void> {
  // The database's own role check, as the caller. Owner only — not admin,
  // not developer: this button hands every server secret to another host.
  // A failed lookup is a refusal, never a pass.
  const { data, error } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "owner",
  });
  if (error || data !== true) {
    throw new Error("Only the Owner can transfer secrets to the new host.");
  }
}

function minutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * Every run, check or transfer, is one row in security_events (the table the
 * MFA reset and sign-in lockouts write; owners and admins read it). The row
 * is written BEFORE anything is sent and refused if it cannot be: a transfer
 * nobody can trace afterwards does not happen. It is then completed with the
 * outcome. Names and counts only — never a value.
 */
function auditTarget() {
  return {
    team: VERCEL_TARGET.teamSlug,
    project: VERCEL_TARGET.projectName,
    project_id: VERCEL_TARGET.projectId,
    environment: VERCEL_TARGET.environment,
  };
}

async function startAudit(
  admin: AuditClient,
  userId: string,
  mode: "check" | "transfer",
): Promise<string> {
  const { data, error } = await admin
    .from("security_events")
    .insert({
      event_type: mode === "check" ? "secret_transfer_check" : "secret_transfer",
      actor_id: userId,
      subject_id: userId,
      details: {
        mode,
        dry_run: mode === "check",
        phase: "started",
        target: auditTarget(),
      },
    })
    .select("id")
    .single();
  if (error || !data?.id) {
    console.error("[secret-transfer] audit row could not be written:", error?.message ?? "no id");
    throw new Error(
      "The audit row could not be written, so nothing was checked or sent. Try again.",
    );
  }
  return data.id;
}

async function finishAudit(
  admin: AuditClient,
  id: string,
  details: Record<string, unknown>,
): Promise<boolean> {
  const { error } = await admin
    .from("security_events")
    .update({ details: { ...details, target: auditTarget(), phase: "finished" } })
    .eq("id", id);
  if (error) {
    console.error("[secret-transfer] audit row could not be completed:", error.message ?? "");
    return false;
  }
  return true;
}

export async function handleSecretTransfer(
  ctx: CallerContext,
  request: SecretTransferRequest,
  deps: SecretTransferDeps,
): Promise<SecretTransferCheck | SecretTransferRun> {
  // The switch-off comes first, before the Owner check and before any
  // database or network call: switched off means nobody, for either mode.
  const off = transferSwitchedOff(deps.env, (deps.now ?? (() => new Date()))());
  if (off) throw new Error(off);

  await assertOwner(ctx);

  if (request.mode === "transfer" && request.confirm.trim() !== TRANSFER_CONFIRM_WORD) {
    throw new Error(`Type ${TRANSFER_CONFIRM_WORD} in the box to confirm the transfer.`);
  }

  const budget = await deps.consumeLimit(
    request.mode === "check" ? "secret-transfer-check" : "secret-transfer",
    ctx.userId,
    request.mode === "check" ? deps.rules.check : deps.rules.transfer,
    "closed",
  );
  if (!budget.allowed) {
    throw new Error(
      `Secrets were ${request.mode === "check" ? "checked" : "transferred"} recently. Try again in about ${minutes(budget.retryAfterSeconds)} minute(s).`,
    );
  }

  if (request.mode === "check") {
    const id = await startAudit(deps.admin, ctx.userId, "check");
    const rows = checkPresence(deps.env);
    const tokenConfigured = transferTokenConfigured(deps.env);
    const auditRecorded = await finishAudit(deps.admin, id, {
      mode: "check",
      dry_run: true,
      token_configured: tokenConfigured,
      counts: {
        present: rows.filter((r) => r.present).length,
        missing: rows.filter((r) => !r.present).length,
      },
      present: rows.filter((r) => r.present).map((r) => r.name),
      missing: rows.filter((r) => !r.present).map((r) => r.name),
    });
    return {
      mode: "check",
      target: transferTarget(),
      tokenConfigured,
      rows,
      excluded: SECRET_TRANSFER_EXCLUDED.map((e) => ({ name: e.name, why: e.why })),
      auditRecorded,
    };
  }

  const token = deps.env[TRANSFER_TOKEN_ENV];
  if (!isSet(token)) {
    throw new Error(
      `${TRANSFER_TOKEN_ENV} is not set on this server. Add a Vercel token under that name in Lovable's Secrets, then try again.`,
    );
  }

  const id = await startAudit(deps.admin, ctx.userId, "transfer");
  const rows = await transferSecrets({ env: deps.env, token, fetchImpl: deps.fetchImpl });
  const counts = countStatuses(rows);
  const auditRecorded = await finishAudit(deps.admin, id, {
    mode: "transfer",
    dry_run: false,
    counts,
    copied: rows.filter((r) => r.status === "copied").map((r) => r.name),
    missing: rows.filter((r) => r.status === "missing").map((r) => r.name),
    failed: rows
      .filter((r) => r.status === "failed")
      .map((r) => ({ name: r.name, http_status: r.httpStatus })),
  });
  return { mode: "transfer", target: transferTarget(), rows, counts, auditRecorded };
}
