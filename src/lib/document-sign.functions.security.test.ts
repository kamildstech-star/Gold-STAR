import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (args: unknown) => unknown) => async (args: { data: unknown }) =>
        fn({ data: validate(args.data) }),
    };
    return builder;
  },
}));
const state = vi.hoisted(() => ({
  admin: null as unknown,
  limit: vi.fn(),
  commit: vi.fn(),
  headers: {} as Record<string, string>,
}));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeader: (name: string) => state.headers[name] ?? null,
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return state.admin;
  },
}));
vi.mock("./contract-pdf", () => ({
  buildContractPdf: async () => new Uint8Array([1]),
  dataUrlToBytes: () => new Uint8Array([1]),
}));
vi.mock("./document-templates", () => ({ sha256Hex: async () => "hash" }));

import { loadSignPacket, submitSignPacket } from "./document-sign.functions";

const writes = vi.fn();
let documentLocation = "other-office";
let revoked = false;
const invoke = (fn: unknown, data: unknown) =>
  (fn as (args: unknown) => Promise<unknown>)({ data });
const input = {
  token: "unguessable-packet-token",
  signerName: "Recipient",
  signatureDataUrl: "data:image/png;base64,AQ==",
  fieldValues: {},
};

beforeEach(() => {
  state.headers = {};
  documentLocation = "other-office";
  revoked = false;
  writes.mockReset();
  state.limit.mockReset().mockResolvedValue({
    data: [{ allowed: true, attempt_count: 1, retry_after_seconds: 0 }],
    error: null,
  });
  state.commit.mockReset().mockResolvedValue({ data: 1, error: null });
  state.admin = {
    rpc: (name: string, args: unknown) =>
      name === "consume_rate_limit" ? state.limit(name, args) : state.commit(name, args),
    from: (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = [];
      let single = false;
      let mutation = false;
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => {
          filters.push((r) => r[key] === value);
          return query;
        },
        in: (key: string, values: unknown[]) => {
          filters.push((r) => values.includes(r[key]));
          return query;
        },
        is: () => query,
        order: () => query,
        maybeSingle: () => {
          single = true;
          return query;
        },
        update: (value: unknown) => {
          mutation = true;
          writes(table, value);
          return query;
        },
        insert: (value: unknown) => {
          mutation = true;
          writes(table, value);
          return query;
        },
        then: (resolve: (result: unknown) => unknown) => {
          const rows: Record<string, unknown>[] =
            table === "document_send_packets"
              ? [
                  {
                    id: "packet",
                    token: input.token,
                    location_id: "own-office",
                    job_id: null,
                    revoked_at: revoked ? "2026-01-01" : null,
                    expires_at: "2099-01-01",
                    required_fields: [],
                  },
                ]
              : table === "document_send_items"
                ? [{ packet_id: "packet", document_id: "victim", requires_signature: true }]
                : table === "documents"
                  ? [
                      {
                        id: "victim",
                        location_id: documentLocation,
                        name: "Private contract",
                        rendered_body: "CONFIDENTIAL",
                        status: "draft",
                      },
                    ]
                  : [];
          const matches = rows.filter((r) => filters.every((f) => f(r)));
          return resolve({
            data: mutation ? null : single ? (matches[0] ?? null) : matches,
            error: null,
          });
        },
      };
      return query;
    },
    storage: {
      from: () => ({
        upload: async (...args: unknown[]) => {
          writes("storage", args);
          return { error: null };
        },
      }),
    },
  };
});

describe("public signing", () => {
  it("fails closed on a limiter outage, before any signing side effect", async () => {
    documentLocation = "own-office";
    state.limit.mockResolvedValue({ data: null, error: new Error("limiter unavailable") });
    await expect(invoke(submitSignPacket, input)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect(state.commit).not.toHaveBeenCalled();
  });
  it("keeps opening a link fail-open", async () => {
    documentLocation = "own-office";
    state.limit.mockResolvedValue({ data: null, error: new Error("limiter unavailable") });
    await expect(invoke(loadSignPacket, { token: input.token })).resolves.toMatchObject({
      ok: true,
    });
  });
  it("uploads overlapping attempts to distinct paths, never with upsert", async () => {
    documentLocation = "own-office";
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = state.admin as { storage: { from: () => unknown } };
    let uploadsStarted = 0;
    db.storage.from = () => ({
      upload: async (...args: unknown[]) => {
        writes("storage", args);
        uploadsStarted++;
        if (uploadsStarted === 1) await blocked;
        else release();
        return { error: null };
      },
    });
    const first = invoke(submitSignPacket, input);
    await vi.waitFor(() => expect(uploadsStarted).toBe(1));
    const second = invoke(submitSignPacket, input);
    await Promise.all([first, second]);
    const uploads = writes.mock.calls
      .filter(([table]) => table === "storage")
      .map(([, args]) => args as [string, unknown, { upsert?: boolean }]);
    // Two attempts x (PDF + signature image), four different objects.
    expect(uploads).toHaveLength(4);
    expect(new Set(uploads.map(([path]) => path)).size).toBe(4);
    expect(uploads.every(([, , options]) => options.upsert === false)).toBe(true);
    // Each attempt's evidence names its own folder.
    const attempts = state.commit.mock.calls.map(
      ([, args]) => (args as { _attempt_id: string })._attempt_id,
    );
    expect(new Set(attempts).size).toBe(2);
    for (const [, args] of state.commit.mock.calls) {
      const a = args as { _attempt_id: string; _evidence: { pdf_path: string }[] };
      expect(a._evidence[0].pdf_path).toBe(`victim/${a._attempt_id}/signed.pdf`);
    }
  });
  it("publishes nothing when the transaction refuses (link already used)", async () => {
    documentLocation = "own-office";
    state.commit.mockResolvedValue({
      data: null,
      error: { message: "Signing link is unavailable" },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(invoke(submitSignPacket, input)).rejects.toThrow("Signing could not be completed");
    // Only the attempt's own objects were written; no table was touched.
    expect(writes.mock.calls.every(([table]) => table === "storage")).toBe(true);
  });
  it("never falls back to separate writes when the function is missing", async () => {
    documentLocation = "own-office";
    state.commit.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(invoke(submitSignPacket, input)).rejects.toThrow("Signing could not be completed");
    expect(writes.mock.calls.every(([table]) => table === "storage")).toBe(true);
  });
  it("does not commit after an upload fails", async () => {
    documentLocation = "own-office";
    const db = state.admin as { storage: { from: () => unknown } };
    db.storage.from = () => ({ upload: async () => ({ error: new Error("unavailable") }) });
    await expect(invoke(submitSignPacket, input)).rejects.toThrow("could not be stored");
    expect(state.commit).not.toHaveBeenCalled();
  });
  it("passes a valid address through and drops a malformed one", async () => {
    documentLocation = "own-office";
    state.headers = { "cf-connecting-ip": "203.0.113.7" };
    await invoke(submitSignPacket, input);
    state.headers = { "x-forwarded-for": "not-an-ip, 10.0.0.1" };
    await invoke(submitSignPacket, input);
    const ips = state.commit.mock.calls.map(
      ([, args]) => (args as { _submission: { ip: string | null } })._submission.ip,
    );
    expect(ips).toEqual(["203.0.113.7", null]);
  });
  it("on Vercel, stamps Vercel's address and never a client-sent cf-connecting-ip", async () => {
    documentLocation = "own-office";
    vi.stubEnv("VERCEL", "1");
    try {
      state.headers = { "cf-connecting-ip": "6.6.6.6", "x-vercel-forwarded-for": "198.51.100.4" };
      await invoke(submitSignPacket, input);
      state.headers = { "cf-connecting-ip": "6.6.6.6" };
      await invoke(submitSignPacket, input);
    } finally {
      vi.unstubAllEnvs();
    }
    const ips = state.commit.mock.calls.map(
      ([, args]) => (args as { _submission: { ip: string | null } })._submission.ip,
    );
    expect(ips).toEqual(["198.51.100.4", null]);
  });
  it("does not disclose a foreign document attached to an own-office packet", async () => {
    const result = await invoke(loadSignPacket, { token: input.token });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("CONFIDENTIAL");
    expect(writes).not.toHaveBeenCalled();
  });
  it("does not sign or upload evidence for a foreign document", async () => {
    await expect(invoke(submitSignPacket, input)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });
  it("still opens a document in the packet office", async () => {
    documentLocation = "own-office";
    expect(await invoke(loadSignPacket, { token: input.token })).toMatchObject({
      ok: true,
      documents: [{ body: "CONFIDENTIAL" }],
    });
  });
  it("still signs a document in the packet office", async () => {
    documentLocation = "own-office";
    expect(await invoke(submitSignPacket, input)).toMatchObject({ ok: true, signed: 1 });
    expect(state.commit).toHaveBeenCalledWith(
      "complete_document_signing_atomic",
      expect.objectContaining({
        _token: input.token,
        _packet_id: "packet",
        _evidence: [expect.objectContaining({ document_id: "victim", requires_signature: true })],
        _submission: expect.objectContaining({
          signer_name: "Recipient",
          packet_scope: {
            location_id: "own-office",
            job_id: null,
            recipient_name: null,
            recipient_email: null,
          },
        }),
      }),
    );
    // Evidence rows, the document update and the link consumption all live
    // in the transaction now; the handler itself writes only storage.
    expect(writes.mock.calls.every(([table]) => table === "storage")).toBe(true);
  });
  it("rejects revoked packets before any write", async () => {
    revoked = true;
    expect(await invoke(loadSignPacket, { token: input.token })).toMatchObject({
      ok: false,
      reason: "revoked",
    });
    await expect(invoke(submitSignPacket, input)).rejects.toThrow("withdrawn");
    expect(writes).not.toHaveBeenCalled();
  });
});
