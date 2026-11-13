/**
 * The server half of reading a ticket, run with its dependencies stubbed.
 *
 * The live `assistant_audit` table held no `field_ticket_read` row at all
 * after the reader shipped, though the first version promised one "either
 * way". These tests hold the promise to account: every way the handler can
 * refuse or fail writes a row with the reason, and the crew gets that
 * reason's words and code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: (data: unknown) => unknown) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        (args: { data: unknown; context: unknown }) =>
          fn({ ...args, data: validate(args.data) }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const state = vi.hoisted(() => ({
  audit: vi.fn(),
  scope: vi.fn(),
  consume: vi.fn(),
  gateway: vi.fn(),
}));

vi.mock("./assistant-scope.server", () => ({
  resolveAssistantScope: state.scope,
  logAssistantEvent: state.audit,
}));
vi.mock("./rate-limit.server", () => ({
  RATE_LIMITS: {
    fieldTicketRead: { limit: 20, windowSeconds: 900, blockSeconds: 900 },
    fieldTicketReadReport: { limit: 30, windowSeconds: 900 },
  },
  consumeLimit: state.consume,
}));
vi.mock("./ai.server", () => ({ readFieldTicketDocument: state.gateway }));

const { readFieldTicket, readFieldTicketInput, reportFieldTicketReadFailure } =
  await import("./field-ticket-extract.functions");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const context = { supabase: {}, userId: USER_ID };
const B64 = "A".repeat(200);
const webp = { file_data_url: `data:image/webp;base64,${B64}`, mime: "image/webp" };

const call = (data: unknown) =>
  (readFieldTicket as unknown as (a: { data: unknown; context: unknown }) => Promise<any>)({
    data,
    context,
  });

const allowed = { allowed: true, retryAfterSeconds: 0, attempts: 1, degraded: false };

/** The one audit row this attempt wrote. */
function auditRow() {
  expect(state.audit).toHaveBeenCalledTimes(1);
  const [scope, entry] = state.audit.mock.calls[0]!;
  return { scope, entry };
}

beforeEach(() => {
  state.audit.mockReset();
  state.scope.mockReset();
  state.consume.mockReset();
  state.gateway.mockReset();
  state.scope.mockResolvedValue({ actorUserId: USER_ID, roles: ["crew"] });
  state.consume.mockResolvedValue(allowed);
});

describe("every attempt the handler sees leaves an audit row", () => {
  it("a spent budget: refused, audited, worded as a limit", async () => {
    state.consume.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 600,
      attempts: 21,
      degraded: false,
    });
    const res = await call(webp);
    expect(res).toMatchObject({ ok: false, reason: "rate_limited", retryable: true });
    expect(res.error).toContain("about 10 minutes");
    const { entry } = auditRow();
    expect(entry).toMatchObject({ feature: "field_ticket_read", outcome: "denied" });
    expect(entry.retrieved.reason).toBe("rate_limited");
    expect(state.gateway).not.toHaveBeenCalled();
  });

  it("a limiter that could not answer: refused, audited, and NOT called a limit", async () => {
    state.consume.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 30,
      attempts: 0,
      degraded: true,
    });
    const res = await call(webp);
    expect(res.reason).toBe("limiter_unavailable");
    expect(res.error).not.toMatch(/too many/i);
    expect(res.error).toContain("FT-LIMIT");
    expect(auditRow().entry.retrieved.reason).toBe("limiter_unavailable");
  });

  it("a file the schema refuses: audited from inside the handler, before the key is read", async () => {
    // A PNG labelled WebP — what Safari's canvas fallback used to send.
    const res = await call({ file_data_url: `data:image/png;base64,${B64}`, mime: "image/webp" });
    expect(res).toMatchObject({ ok: false, reason: "file_rejected", retryable: false });
    const { entry } = auditRow();
    expect(entry.outcome).toBe("denied");
    expect(entry.retrieved.reason).toBe("file_rejected");
    expect(entry.retrieved.prefix).toBe("data:image/png;base64,");
    expect(JSON.stringify(entry)).not.toContain(B64);
    expect(state.gateway).not.toHaveBeenCalled();
  });

  it("a scope lookup that throws does not take the audit row with it", async () => {
    state.scope.mockRejectedValue(new Error("Could not verify assistant access scope."));
    state.gateway.mockResolvedValue("not json");
    await call(webp);
    const { scope, entry } = auditRow();
    expect(scope.actorUserId).toBe(USER_ID);
    expect(scope.roles).toEqual([]);
    expect(scope.caps.canWrite).toBe(false);
    expect(entry.retrieved.scope_error).toContain("Could not verify");
  });

  it("a missing gateway key: named as such, because no retry will fix it", async () => {
    state.gateway.mockRejectedValue(new Error("AI is not configured (missing LOVABLE_API_KEY)."));
    const res = await call(webp);
    expect(res).toMatchObject({ ok: false, reason: "not_configured", retryable: false });
    expect(auditRow().entry).toMatchObject({ outcome: "error" });
  });

  it("a gateway error: audited with the gateway's text, shown without it", async () => {
    state.gateway.mockRejectedValue(new Error("AI request failed [500]: upstream exploded"));
    const res = await call(webp);
    expect(res.reason).toBe("gateway");
    expect(res.error).not.toContain("upstream");
    expect(auditRow().entry.responsePreview).toContain("upstream exploded");
  });

  it("a reply that is not a ticket: audited as unreadable", async () => {
    state.gateway.mockResolvedValue("I cannot help with that.");
    const res = await call(webp);
    expect(res.reason).toBe("unreadable");
    expect(auditRow().entry.retrieved).toMatchObject({ reason: "unreadable", parsed: false });
  });

  it("anything else that throws: caught, audited, returned as a reason", async () => {
    state.consume.mockRejectedValue(new Error("boom"));
    const res = await call(webp);
    expect(res).toMatchObject({ ok: false, reason: "server_error" });
    expect(auditRow().entry.retrieved.reason).toBe("server_error");
  });

  it("a good read: audited ok, fields handed back", async () => {
    state.gateway.mockResolvedValue(
      JSON.stringify({ crew_chief_name: "Izzy / Allan", gsr_crew_size: 7 }),
    );
    const res = await call(webp);
    expect(res.ok).toBe(true);
    expect(res.values.gsr_crew_size).toBe(7);
    expect(auditRow().entry.outcome).toBe("ok");
    expect(state.gateway).toHaveBeenCalledWith(
      webp.file_data_url,
      "image/webp",
      "field-work-ticket",
      expect.any(String),
    );
  });
});

describe("the envelope is all the validator checks", () => {
  it("still refuses an oversized body before the handler runs", async () => {
    await expect(async () =>
      call({ ...webp, file_data_url: "A".repeat(20_000_000) }),
    ).rejects.toThrow();
    expect(state.audit).not.toHaveBeenCalled();
  });
});

describe("readFieldTicketInput", () => {
  it("takes each type the model reads, labeled as what it is", () => {
    for (const mime of ["image/webp", "image/jpeg", "image/png", "application/pdf"]) {
      expect(
        readFieldTicketInput.safeParse({ file_data_url: `data:${mime};base64,${B64}`, mime })
          .success,
      ).toBe(true);
    }
  });

  it("refuses a label that disagrees with the bytes", () => {
    expect(
      readFieldTicketInput.safeParse({
        file_data_url: `data:image/png;base64,${B64}`,
        mime: "image/webp",
      }).success,
    ).toBe(false);
  });

  it("refuses what the model does not read", () => {
    expect(
      readFieldTicketInput.safeParse({
        file_data_url: `data:application/octet-stream;base64,${B64}`,
        mime: "application/pdf",
      }).success,
    ).toBe(false);
  });
});

describe("reportFieldTicketReadFailure", () => {
  const report = (data: unknown) =>
    (
      reportFieldTicketReadFailure as unknown as (a: {
        data: unknown;
        context: unknown;
      }) => Promise<any>
    )({
      data,
      context,
    });

  it("puts a browser-side failure on record under the same feature", async () => {
    const res = await report({ reason: "file_unusable", mime: "image/heic", bytes: 3_000_000 });
    expect(res).toEqual({ logged: true });
    const { entry } = auditRow();
    expect(entry).toMatchObject({ feature: "field_ticket_read", outcome: "error" });
    expect(entry.retrieved).toMatchObject({
      reason: "file_unusable",
      where: "browser",
      mime: "image/heic",
    });
  });

  it("uses its own budget and fails open", async () => {
    await report({ reason: "file_too_big", mime: "image/jpeg", bytes: 1 });
    expect(state.consume).toHaveBeenCalledWith(
      "field-ticket-read-report",
      USER_ID,
      expect.anything(),
      "open",
    );
  });

  it("only takes the reasons that can happen in the browser", async () => {
    await expect(async () => report({ reason: "ok", mime: "x", bytes: 1 })).rejects.toThrow();
  });
});
