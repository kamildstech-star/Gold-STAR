// TODO(remove after cutover): goes with storage-export.functions.ts.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (fn: (args: unknown) => unknown) => async (args: unknown) => fn(args),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

const state = vi.hoisted(() => ({
  consume: vi.fn(),
  signCalls: [] as string[][],
}));

vi.mock("@/lib/rate-limit.server", () => ({
  RATE_LIMITS: { storageExport: { limit: 3, windowSeconds: 3600, blockSeconds: 3600 } },
  consumeLimit: state.consume,
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const paths: Record<string, string[]> = {
    "project-photos": ["job-1/a.jpg", "job-1/rooms/b.jpg"],
    documents: ["d/x.pdf"],
  };
  return {
    supabaseAdmin: {
      storage: {
        listBuckets: async () => ({
          data: Object.keys(paths).map((id) => ({ id, name: id })),
          error: null,
        }),
        from: (bucket: string) => ({
          listV2: async () => ({
            data: {
              hasNext: false,
              folders: [],
              objects: paths[bucket]!.map((p) => ({
                name: p,
                key: p,
                updated_at: "2026-10-01T00:00:00Z",
                metadata: { size: 100, mimetype: "image/jpeg" },
              })),
            },
            error: null,
          }),
          list: async () => ({ data: [], error: null }),
          createSignedUrls: async (ps: string[]) => {
            state.signCalls.push(ps);
            return {
              data: ps.map((p) => ({
                path: p,
                signedUrl: `https://x.supabase.co/sign/${bucket}/${p}?token=SECRET`,
                error: null,
              })),
              error: null,
            };
          },
        }),
      },
    },
  };
});

import { exportStorageManifest } from "./storage-export.functions";

const OWNER = "11111111-1111-4111-8111-111111111111";
let roles: string[] = ["owner"];
let auditError: unknown = null;
const rpc = vi.fn();

const invoke = () =>
  (
    exportStorageManifest as unknown as (
      a: unknown,
    ) => Promise<{ csv: string; totalObjects: number }>
  )({ context: { userId: OWNER, supabase: { rpc } } });

beforeEach(() => {
  roles = ["owner"];
  auditError = null;
  state.signCalls.length = 0;
  state.consume
    .mockReset()
    .mockResolvedValue({ allowed: true, retryAfterSeconds: 0, attempts: 1, degraded: false });
  rpc.mockReset().mockImplementation(async (fn: string, args: Record<string, unknown>) => {
    if (fn === "has_role") return { data: roles.includes(args._role as string), error: null };
    if (fn === "log_export") return { data: auditError ? null : "audit-id", error: auditError };
    return { data: null, error: new Error(`unexpected rpc ${fn}`) };
  });
});

describe("only the Owner, decided on the server", () => {
  it.each([["admin"], ["dev"], ["sales_head"], ["rep"]])(
    "refuses %s before the service-role client is touched",
    async (role) => {
      roles = [role];
      await expect(invoke()).rejects.toThrow("Only the Owner");
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("has_role", { _user_id: OWNER, _role: "owner" });
      expect(state.consume).not.toHaveBeenCalled();
      expect(state.signCalls).toEqual([]);
    },
  );

  it("refuses when the role check itself fails (fail closed)", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: new Error("db down") });
    await expect(invoke()).rejects.toThrow("Only the Owner");
    expect(state.signCalls).toEqual([]);
  });

  it("the owner gets the CSV", async () => {
    const result = await invoke();
    expect(result.totalObjects).toBe(3);
    expect(result.csv.split("\n")[0]).toBe("bucket,path,size,content_type,updated_at,signed_url");
    expect(result.csv).toContain("project-photos,job-1/rooms/b.jpg,100,image/jpeg,");
  });
});

describe("rate limit, fail closed", () => {
  it("asks the limiter per user with the closed policy, and stops when refused", async () => {
    state.consume.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 1800,
      attempts: 4,
      degraded: false,
    });
    await expect(invoke()).rejects.toThrow(/about 30 minute/);
    expect(state.consume).toHaveBeenCalledWith(
      "storage-export",
      OWNER,
      expect.objectContaining({ limit: 3 }),
      "closed",
    );
    expect(state.signCalls).toEqual([]);
  });
});

describe("the audit row", () => {
  it("is written as the caller, with counts and never a link, before anything is signed", async () => {
    const order: string[] = [];
    rpc.mockImplementation(async (fn: string, args: Record<string, unknown>) => {
      order.push(fn);
      if (fn === "has_role") return { data: true, error: null };
      return { data: "audit-id", error: null };
    });
    const before = state.signCalls.length;
    await invoke();
    expect(order).toEqual(["has_role", "log_export"]);

    const audit = rpc.mock.calls.find(([fn]) => fn === "log_export")![1];
    expect(audit).toMatchObject({
      _entity: "storage_objects",
      _record_count: 3,
      _format: "csv",
      _filters: { buckets: { "project-photos": 2, documents: 1 }, link_seconds: 86_400 },
    });
    const text = JSON.stringify(audit);
    expect(text).not.toMatch(/https?:|token|sign\//i);
    expect(state.signCalls.length).toBeGreaterThan(before);
  });

  it("no audit row, no links", async () => {
    auditError = { message: "Export is restricted" };
    await expect(invoke()).rejects.toThrow("could not be recorded");
    expect(state.signCalls).toEqual([]);
  });
});

describe("nothing logs or keeps the links", () => {
  const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const files = [
    "src/lib/storage-export.ts",
    "src/lib/storage-export.functions.ts",
    "src/components/storage-export-card.tsx",
  ];

  it.each(files)("%s has no console call", (f) => {
    expect(read(f).match(/console\.\w+\(/g)).toBeNull();
  });

  it("the card does not put the CSV in the query cache", () => {
    const card = read("src/components/storage-export-card.tsx");
    expect(card.match(/useMutation\(|useQuery\(/g)).toBeNull();
    expect(card.match(/saveFile\(filename, result\.csv, CSV_MIME\)/)).not.toBeNull();
  });

  it("every file is marked for removal after the cutover", () => {
    for (const f of [...files, "src/lib/storage-export.test.ts"]) {
      expect(read(f).startsWith("// TODO(remove after cutover)"), f).toBe(true);
    }
  });

  it("the server function is behind the session middleware", () => {
    const fn = read("src/lib/storage-export.functions.ts");
    const chain = fn.match(
      /export const exportStorageManifest = createServerFn\([\s\S]*?\.handler\(/,
    )![0];
    expect(chain).toContain(".middleware([requireSupabaseAuth])");
    // The owner check precedes the service-role import.
    expect(fn.indexOf('"has_role"')).toBeLessThan(fn.indexOf("client.server"));
  });
});
