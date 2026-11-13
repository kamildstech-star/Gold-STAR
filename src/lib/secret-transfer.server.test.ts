// TODO(remove after cutover): delete with src/lib/secret-transfer.server.ts.
/**
 * Every fetch here is a mock. Nothing in this file talks to Vercel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SECRET_TRANSFER_ALLOWLIST, VERCEL_ENV_ENDPOINT } from "./secret-transfer";
import {
  checkPresence,
  handleSecretTransfer,
  transferSecrets,
  vercelEnvBody,
  type CallerContext,
  type SecretTransferDeps,
} from "./secret-transfer.server";

const VALUE_1 = "fake-value-1";
const BEARER = "fake-bearer-1";
const NOW = new Date("2026-10-12T12:00:00Z");

/** A server that has two allowlisted values, the token, the switch, and things never to send. */
function serverEnv(extra: Record<string, string | undefined> = {}) {
  return {
    SECRET_TRANSFER_ENABLED: "1",
    INTEGRATION_CRED_KEY: VALUE_1,
    RESEND_API_KEY: `${VALUE_1}-resend`,
    RAVEN_API_KEY: "   ",
    VERCEL_TRANSFER_TOKEN: BEARER,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-NEVER-sent",
    CRON_SECRET: "cron-NEVER-sent",
    LOVABLE_API_KEY: "lovable-NEVER-sent",
    ...extra,
  } as Record<string, string | undefined>;
}

/** Vercel's 201, which echoes the value back — exactly what must not reach the result. */
function created(body: unknown = null) {
  return new Response(
    JSON.stringify(
      body ?? { created: { key: "X", value: VALUE_1, type: "sensitive" }, failed: [] },
    ),
    { status: 201, headers: { "content-type": "application/json" } },
  );
}

function everyConsoleCall(spies: ReturnType<typeof vi.spyOn>[]): string {
  return JSON.stringify(spies.flatMap((s) => s.mock.calls));
}

let spies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("transferSecrets", () => {
  it("posts each set value to the fixed URL only, as Sensitive in Production", async () => {
    const fetchImpl = vi.fn(async () => created());
    const rows = await transferSecrets({ env: serverEnv(), token: BEARER, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url, init] of fetchImpl.mock.calls as unknown as [string, RequestInit][]) {
      expect(url).toBe(VERCEL_ENV_ENDPOINT);
      expect(init.method).toBe("POST");
      expect(init.redirect).toBe("manual");
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${BEARER}`);
      const body = JSON.parse(init.body as string);
      expect(body.type).toBe("sensitive");
      expect(body.target).toEqual(["production"]);
      expect(Object.keys(body).sort()).toEqual(["comment", "key", "target", "type", "value"]);
    }
    const sent = (fetchImpl.mock.calls as unknown as [string, RequestInit][]).map((c) =>
      JSON.parse(c[1].body as string),
    );
    expect(sent.map((b) => b.key)).toEqual(["INTEGRATION_CRED_KEY", "RESEND_API_KEY"]);
    expect(sent[0].value).toBe(VALUE_1);

    expect(rows.find((r) => r.name === "INTEGRATION_CRED_KEY")).toEqual({
      name: "INTEGRATION_CRED_KEY",
      status: "copied",
      httpStatus: null,
    });
    // Blank counts as missing, and is never sent empty.
    expect(rows.find((r) => r.name === "RAVEN_API_KEY")?.status).toBe("missing");
    expect(rows).toHaveLength(SECRET_TRANSFER_ALLOWLIST.length);
  });

  it("never sends a name off the allowlist, nor the token as a variable", async () => {
    const fetchImpl = vi.fn(async () => created());
    await transferSecrets({ env: serverEnv(), token: BEARER, fetchImpl });
    const bodies = (fetchImpl.mock.calls as unknown as [string, RequestInit][])
      .map((c) => c[1].body as string)
      .join("\n");
    for (const never of [
      "SUPABASE_SERVICE_ROLE_KEY",
      "CRON_SECRET",
      "LOVABLE_API_KEY",
      "VERCEL_TRANSFER_TOKEN",
    ]) {
      expect(bodies).not.toContain(never);
    }
    expect(bodies).not.toContain("NEVER-sent");
    expect(bodies).not.toContain(BEARER);
  });

  it("returns names and statuses only — no value, even when Vercel echoes it", async () => {
    const fetchImpl = vi.fn(async () => created());
    const rows = await transferSecrets({ env: serverEnv(), token: BEARER, fetchImpl });
    const out = JSON.stringify(rows);
    expect(out).not.toContain(VALUE_1);
    expect(out).not.toContain(BEARER);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["httpStatus", "name", "status"]);
    expect(everyConsoleCall(spies)).not.toContain(VALUE_1);
  });

  it("a refusal is 'failed' with the HTTP status and no body", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "forbidden", message: `bad value ${VALUE_1}` } }),
          { status: 403 },
        ),
    );
    const rows = await transferSecrets({ env: serverEnv(), token: BEARER, fetchImpl });
    expect(rows.find((r) => r.name === "INTEGRATION_CRED_KEY")).toEqual({
      name: "INTEGRATION_CRED_KEY",
      status: "failed",
      httpStatus: 403,
    });
    expect(JSON.stringify(rows)).not.toContain(VALUE_1);
    expect(everyConsoleCall(spies)).not.toContain(VALUE_1);
  });

  it("a 201 whose `failed` list is not empty is a failure, not a copy", async () => {
    const fetchImpl = vi.fn(async () =>
      created({ failed: [{ error: { code: "x", message: "m", value: VALUE_1 } }] }),
    );
    const rows = await transferSecrets({ env: serverEnv(), token: BEARER, fetchImpl });
    expect(rows.find((r) => r.name === "INTEGRATION_CRED_KEY")?.status).toBe("failed");
    expect(JSON.stringify(rows)).not.toContain(VALUE_1);
  });

  it("a redirect is a failure: the token is never replayed elsewhere", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
    );
    const rows = await transferSecrets({ env: serverEnv(), token: BEARER, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(rows.find((r) => r.name === "INTEGRATION_CRED_KEY")).toMatchObject({
      status: "failed",
      httpStatus: 302,
    });
  });

  it("a network error is 'failed (no answer)' and its message, which can quote the request, is dropped", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`socket hang up while sending ${VALUE_1}`);
    });
    const rows = await transferSecrets({ env: serverEnv(), token: BEARER, fetchImpl });
    expect(rows.find((r) => r.name === "INTEGRATION_CRED_KEY")).toEqual({
      name: "INTEGRATION_CRED_KEY",
      status: "failed",
      httpStatus: null,
    });
    expect(JSON.stringify(rows)).not.toContain(VALUE_1);
    expect(everyConsoleCall(spies)).not.toContain(VALUE_1);
  });

  it("refuses to run without a token", async () => {
    const fetchImpl = vi.fn();
    await expect(transferSecrets({ env: serverEnv(), token: "", fetchImpl })).rejects.toThrow(
      "VERCEL_TRANSFER_TOKEN",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("the body is exactly the documented shape", () => {
    expect(JSON.parse(vercelEnvBody("A_KEY", "v"))).toEqual({
      key: "A_KEY",
      value: "v",
      type: "sensitive",
      target: ["production"],
      comment: expect.stringContaining("Transfer secrets"),
    });
  });

  it("checkPresence answers true/false per allowlisted name, nothing else", () => {
    const rows = checkPresence(serverEnv());
    expect(rows.find((r) => r.name === "INTEGRATION_CRED_KEY")).toEqual({
      name: "INTEGRATION_CRED_KEY",
      present: true,
    });
    expect(rows.find((r) => r.name === "RAVEN_API_KEY")?.present).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(VALUE_1);
  });
});

// ---------------------------------------------------------------------------

type Audit = { inserts: Record<string, unknown>[]; updates: Record<string, unknown>[] };

function harness(opts: {
  owner?: boolean | "error";
  env?: Record<string, string | undefined>;
  allowed?: boolean;
  auditInsertFails?: boolean;
  now?: Date;
}) {
  const audit: Audit = { inserts: [], updates: [] };
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    expect(fn).toBe("has_role");
    expect(args).toEqual({ _user_id: "owner-1", _role: "owner" });
    if (opts.owner === "error") return { data: null, error: new Error("db down") };
    return { data: opts.owner ?? true, error: null };
  });
  const ctx: CallerContext = { userId: "owner-1", supabase: { rpc } };
  const consumeLimit = vi.fn(async () => ({
    allowed: opts.allowed ?? true,
    retryAfterSeconds: 1800,
  }));
  const admin = {
    from: (table: string) => {
      expect(table).toBe("security_events");
      return {
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              if (opts.auditInsertFails) return { data: null, error: { message: "no table" } };
              audit.inserts.push(row);
              return { data: { id: "evt-1" }, error: null };
            },
          }),
        }),
        update: (row: Record<string, unknown>) => ({
          eq: async (_col: string, id: string) => {
            audit.updates.push({ id, ...row });
            return { error: null };
          },
        }),
      };
    },
  };
  const fetchImpl = vi.fn(async () => created());
  const deps: SecretTransferDeps = {
    env: opts.env ?? serverEnv(),
    fetchImpl,
    admin: admin as unknown as SecretTransferDeps["admin"],
    consumeLimit,
    rules: {
      check: { limit: 6, windowSeconds: 3600, blockSeconds: 3600 },
      transfer: { limit: 3, windowSeconds: 3600, blockSeconds: 3600 },
    },
    now: () => opts.now ?? NOW,
  };
  return { ctx, deps, rpc, consumeLimit, fetchImpl, audit };
}

describe("handleSecretTransfer: who, how often, the switch, the trail", () => {
  it("refuses anyone who is not the Owner — admin and developer included — before anything else", async () => {
    const h = harness({ owner: false });
    await expect(handleSecretTransfer(h.ctx, { mode: "check" }, h.deps)).rejects.toThrow(
      "Only the Owner",
    );
    await expect(
      handleSecretTransfer(h.ctx, { mode: "transfer", confirm: "TRANSFER" }, h.deps),
    ).rejects.toThrow("Only the Owner");
    expect(h.consumeLimit).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.audit.inserts).toEqual([]);
  });

  it("a failed role lookup is a refusal, never a pass", async () => {
    const h = harness({ owner: "error" });
    await expect(
      handleSecretTransfer(h.ctx, { mode: "transfer", confirm: "TRANSFER" }, h.deps),
    ).rejects.toThrow("Only the Owner");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, "0", "true"])(
    "SECRET_TRANSFER_ENABLED=%j switches both modes off, before even the Owner check",
    async (flag) => {
      const h = harness({ env: serverEnv({ SECRET_TRANSFER_ENABLED: flag }) });
      await expect(handleSecretTransfer(h.ctx, { mode: "check" }, h.deps)).rejects.toThrow(
        "switched off",
      );
      await expect(
        handleSecretTransfer(h.ctx, { mode: "transfer", confirm: "TRANSFER" }, h.deps),
      ).rejects.toThrow("switched off");
      expect(h.rpc).not.toHaveBeenCalled();
      expect(h.consumeLimit).not.toHaveBeenCalled();
      expect(h.fetchImpl).not.toHaveBeenCalled();
      expect(h.audit.inserts).toEqual([]);
    },
  );

  it("after the built-in expiry it refuses even with the flag on", async () => {
    const h = harness({ now: new Date("2026-10-25T00:00:00Z") });
    await expect(
      handleSecretTransfer(h.ctx, { mode: "transfer", confirm: "TRANSFER" }, h.deps),
    ).rejects.toThrow("expired");
    await expect(handleSecretTransfer(h.ctx, { mode: "check" }, h.deps)).rejects.toThrow("expired");
    expect(h.rpc).not.toHaveBeenCalled();
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["", "transfer", "TRANSFERX", "yes"])(
    "a real run needs TRANSFER typed, checked on the server (%j refused)",
    async (confirm) => {
      const h = harness({});
      await expect(
        handleSecretTransfer(h.ctx, { mode: "transfer", confirm }, h.deps),
      ).rejects.toThrow("Type TRANSFER");
      expect(h.consumeLimit).not.toHaveBeenCalled();
      expect(h.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("is rate-limited per user, failing closed, with separate budgets for check and transfer", async () => {
    const h = harness({ allowed: false });
    await expect(
      handleSecretTransfer(h.ctx, { mode: "transfer", confirm: "TRANSFER" }, h.deps),
    ).rejects.toThrow("Try again in about 30 minute(s)");
    expect(h.consumeLimit).toHaveBeenCalledWith(
      "secret-transfer",
      "owner-1",
      h.deps.rules.transfer,
      "closed",
    );
    await expect(handleSecretTransfer(h.ctx, { mode: "check" }, h.deps)).rejects.toThrow(
      "recently",
    );
    expect(h.consumeLimit).toHaveBeenLastCalledWith(
      "secret-transfer-check",
      "owner-1",
      h.deps.rules.check,
      "closed",
    );
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a transfer with a clear message when VERCEL_TRANSFER_TOKEN is unset", async () => {
    const h = harness({ env: serverEnv({ VERCEL_TRANSFER_TOKEN: undefined }) });
    await expect(
      handleSecretTransfer(h.ctx, { mode: "transfer", confirm: "TRANSFER" }, h.deps),
    ).rejects.toThrow("VERCEL_TRANSFER_TOKEN is not set on this server");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

  it("Check needs no token, sends nothing, and reports presence and the target", async () => {
    const h = harness({ env: serverEnv({ VERCEL_TRANSFER_TOKEN: undefined }) });
    const result = await handleSecretTransfer(h.ctx, { mode: "check" }, h.deps);
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(result.mode).toBe("check");
    if (result.mode !== "check") throw new Error("unreachable");
    expect(result.tokenConfigured).toBe(false);
    expect(result.target).toMatchObject({ projectName: "goldstar", teamSlug: "monitex" });
    expect(result.rows.find((r) => r.name === "INTEGRATION_CRED_KEY")?.present).toBe(true);
    expect(JSON.stringify(result)).not.toContain(VALUE_1);
  });

  it("writes ONE audit row per run, before sending, completed with names and counts only", async () => {
    const h = harness({});
    const result = await handleSecretTransfer(
      h.ctx,
      { mode: "transfer", confirm: " TRANSFER " },
      h.deps,
    );
    expect(h.audit.inserts).toHaveLength(1);
    expect(h.audit.inserts[0]).toMatchObject({
      event_type: "secret_transfer",
      actor_id: "owner-1",
      details: { mode: "transfer", dry_run: false, phase: "started" },
    });
    expect(h.audit.updates).toHaveLength(1);
    expect(h.audit.updates[0]).toMatchObject({
      id: "evt-1",
      details: {
        phase: "finished",
        dry_run: false,
        counts: { copied: 2, failed: 0, missing: SECRET_TRANSFER_ALLOWLIST.length - 2 },
        copied: ["INTEGRATION_CRED_KEY", "RESEND_API_KEY"],
      },
    });
    const trail = JSON.stringify(h.audit);
    expect(trail).not.toContain(VALUE_1);
    expect(trail).not.toContain(BEARER);
    expect(result).toMatchObject({ mode: "transfer", auditRecorded: true });
    expect(JSON.stringify(result)).not.toContain(VALUE_1);
    expect(JSON.stringify(result)).not.toContain(BEARER);
    expect(everyConsoleCall(spies)).not.toContain(VALUE_1);
  });

  it("a Check is audited too, as a dry run", async () => {
    const h = harness({});
    await handleSecretTransfer(h.ctx, { mode: "check" }, h.deps);
    expect(h.audit.inserts).toHaveLength(1);
    expect(h.audit.inserts[0]).toMatchObject({
      event_type: "secret_transfer_check",
      details: { dry_run: true },
    });
    expect(h.audit.updates[0]).toMatchObject({ details: { phase: "finished", dry_run: true } });
  });

  it("no audit row, no transfer: an unwritable trail stops the run before anything is sent", async () => {
    const h = harness({ auditInsertFails: true });
    await expect(
      handleSecretTransfer(h.ctx, { mode: "transfer", confirm: "TRANSFER" }, h.deps),
    ).rejects.toThrow("audit row could not be written");
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
});
