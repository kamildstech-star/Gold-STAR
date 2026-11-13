import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Public intake: the submission and the consumption of a one-time link are
 * one transaction (`submit_public_intake_atomic`), and both write paths fail
 * closed on the limiter. Before, insert and "mark used" were two calls, so a
 * one-time link could be submitted twice under a race.
 */
const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  storage: vi.fn(),
  writes: vi.fn(),
  request: null as Record<string, unknown> | null,
}));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const b = { middleware: () => b, inputValidator: () => b, handler: (fn: unknown) => fn };
    return b;
  },
}));
vi.mock("./rate-limit.server", () => ({
  RATE_LIMITS: { publicTokenWrite: "write-limit", publicTokenRead: "read-limit" },
  guardPublicServerFn: mocks.guard,
}));
vi.mock("./tradeshow-intake.server", () => ({
  boothSubmissionProblem: () => null,
  fileBoothSubmission: vi.fn(),
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from, rpc: mocks.rpc, storage: { from: mocks.storage } },
}));
import {
  createIntakePhotoUpload,
  loadIntakeRequest,
  submitIntakeAtomically,
  submitIntakeRequest,
} from "./intake-public.functions";

const call = (fn: unknown, data: unknown) => (fn as (arg: unknown) => Promise<unknown>)({ data });
const TOKEN = "a-valid-token-value-0123456789";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockResolvedValue(undefined);
  mocks.request = {
    id: "request",
    job_id: "job",
    recipient_name: null,
    note: null,
    expires_at: "2099-01-01T00:00:00Z",
    revoked_at: null,
    submitted_at: null,
    location_id: "office",
    tradeshow_id: null,
    multi_use: false,
    standing: false,
  };
  mocks.from.mockImplementation((table: string) => {
    const q = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({
        data: table === "intake_requests" ? mocks.request : null,
        error: null,
      }),
      insert: (v: unknown) => {
        mocks.writes(table, "insert", v);
        return q;
      },
      update: (v: unknown) => {
        mocks.writes(table, "update", v);
        return q;
      },
    };
    return q;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("submitIntakeAtomically", () => {
  it.each([
    { data: null, error: { code: "PGRST202" } },
    { data: null, error: { code: "22023", message: "already submitted" } },
    { data: null, error: null },
  ])("never falls back to separate writes on %j", async (response) => {
    const from = vi.fn();
    const rpc = vi.fn().mockResolvedValue(response);
    await expect(
      submitIntakeAtomically({ from, rpc } as never, "token", "request", {}),
    ).rejects.toThrow("could not be submitted");
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("sends token, request and payload in one call", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "submission-id", error: null });
    const payload = { job_id: null, fields: { customer_name: "Test" } };
    await expect(
      submitIntakeAtomically({ rpc } as never, "token", "request", payload),
    ).resolves.toEqual({ id: "submission-id" });
    expect(rpc).toHaveBeenCalledWith("submit_public_intake_atomic", {
      _token: "token",
      _request_id: "request",
      _submission: payload,
    });
  });
});

describe("submitIntakeRequest", () => {
  const input = {
    token: TOKEN,
    submittedByName: "Pat",
    submittedByEmail: "pat@example.com",
    fields: { customer_name: "Pat" },
    answers: {},
    photos: [],
  };

  it("saves and consumes the link through the function only", async () => {
    mocks.rpc.mockResolvedValue({ data: "submission-id", error: null });
    await expect(call(submitIntakeRequest, input)).resolves.toEqual({ ok: true });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith("submit_public_intake_atomic", {
      _token: TOKEN,
      _request_id: "request",
      _submission: expect.objectContaining({
        job_id: "job",
        submitted_by_name: "Pat",
        fields: { customer_name: "Pat" },
        photos: [],
        location_id: null,
      }),
    });
    // No direct insert into the inbox, no separate "mark used" stamp.
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it("does not consume or insert anything itself when the function refuses", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "22023" } });
    await expect(call(submitIntakeRequest, input)).rejects.toThrow("could not be submitted");
    expect(mocks.writes).not.toHaveBeenCalled();
  });

  it("refuses an already-submitted one-time link before calling the function", async () => {
    mocks.request = { ...mocks.request, submitted_at: "2026-10-01T00:00:00Z" };
    await expect(call(submitIntakeRequest, input)).rejects.toThrow("already submitted");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});

describe("limiter policy", () => {
  it.each([
    ["submit", submitIntakeRequest],
    ["photo upload grant", createIntakePhotoUpload],
  ])("%s requires a healthy limiter before any read or write", async (_name, handler) => {
    mocks.guard.mockRejectedValue(new Error("Too many requests"));
    await expect(call(handler, { token: TOKEN })).rejects.toThrow();
    expect(mocks.guard).toHaveBeenCalledWith("intake:write", "write-limit", "closed");
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storage).not.toHaveBeenCalled();
  });
  it("loading the form stays fail-open", async () => {
    await call(loadIntakeRequest, { token: TOKEN }).catch(() => {});
    expect(mocks.guard).toHaveBeenCalledWith("intake:read", "read-limit", "open");
  });
});
