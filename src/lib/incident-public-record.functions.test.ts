/**
 * lookupIncidentPublicRecord with its dependencies stubbed: visibility comes
 * from the caller's own RLS read of the incident, the cache is read through
 * the same client and written by the service role, network lookups spend the
 * per-user budget (closed), and nothing contact-shaped is ever stored.
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
  consume: vi.fn(),
  lookup: vi.fn(),
  upsert: vi.fn(),
  secret: vi.fn(),
}));

vi.mock("./rate-limit.server", () => ({
  RATE_LIMITS: { publicRecordLookup: { limit: 60, windowSeconds: 900, blockSeconds: 900 } },
  consumeLimit: state.consume,
}));
vi.mock("./integration-credentials.server", () => ({ getIntegrationSecret: state.secret }));
vi.mock("./public-record/lookup", () => ({ lookupPublicRecord: state.lookup }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: () => ({ upsert: state.upsert }) },
}));

const { lookupIncidentPublicRecord, fromCache, FOUND_TTL_MS, NOT_FOUND_TTL_MS } =
  await import("./incident-public-record.functions");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const INCIDENT_ID = "22222222-2222-4222-8222-222222222222";

const INCIDENT = {
  id: INCIDENT_ID,
  address: "84-74 257th St",
  locality: "Queens",
  postal_code: "11001",
  lat: 40.7346,
  lon: -73.7105,
};

const RECORD = {
  source: "nyc_pluto" as const,
  source_label: "NYC PLUTO 26v2",
  source_vintage: "26v2",
  parcel_id: "BBL 4087860042",
  parcel_address: "84-74 257 STREET, Queens",
  owner_name: "SAMPLE OWNER, A",
  owner_withheld: false,
  property_class: "A1",
  property_class_label: "One-family dwelling",
  unit_count: 1,
  year_built: 1945,
  last_sale_date: "2006-03-31",
  last_sale_amount: 875000,
  assessed_value: 68460,
};

type Answer = { data: unknown; error: unknown };

/** The caller's RLS client: one answer per table. */
function rlsClient(answers: Record<string, Answer>) {
  const reads: string[] = [];
  return {
    reads,
    client: {
      from(table: string) {
        reads.push(table);
        const q = {
          select: () => q,
          eq: () => q,
          maybeSingle: async () => answers[table] ?? { data: null, error: null },
        };
        return q;
      },
    },
  };
}

const call = (supabase: unknown, incidentId = INCIDENT_ID) =>
  (lookupIncidentPublicRecord as unknown as (a: unknown) => Promise<Loose>)({
    data: { incidentId },
    context: { supabase, userId: USER_ID },
  });

/** The result union, flattened so a test can read any branch's fields. */
type Loose = {
  status: string;
  cached?: boolean;
  reason?: string;
  record?: { last_sale_amount: number | null };
};

const allowed = { allowed: true, retryAfterSeconds: 0, attempts: 1, degraded: false };

beforeEach(() => {
  for (const f of Object.values(state)) f.mockReset();
  state.consume.mockResolvedValue(allowed);
  state.secret.mockResolvedValue(undefined);
  state.upsert.mockResolvedValue({ error: null });
  state.lookup.mockResolvedValue({ kind: "found", record: RECORD });
});

describe("visibility", () => {
  it("an incident the caller's RLS hides is 'not found', before any spend or fetch", async () => {
    const { client } = rlsClient({ incidents: { data: null, error: null } });
    expect(await call(client)).toEqual({ status: "unavailable", reason: "Incident not found." });
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.lookup).not.toHaveBeenCalled();
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("does not require a claim: an unclaimed visible incident gets its basics", async () => {
    const { client } = rlsClient({ incidents: { data: INCIDENT, error: null } });
    const res = await call(client);
    expect(res).toMatchObject({ status: "ok", cached: false, record: RECORD });
  });

  it("rejects a malformed id at the validator", async () => {
    const { client } = rlsClient({});
    await expect(async () => call(client, "not-a-uuid")).rejects.toThrow(/uuid/i);
  });
});

describe("cache", () => {
  it("a fresh cached row answers without spending budget or fetching", async () => {
    const { client, reads } = rlsClient({
      incidents: { data: INCIDENT, error: null },
      incident_public_records: {
        data: {
          ...RECORD,
          status: "found",
          last_sale_amount: "875000",
          assessed_value: "68460",
          note: null,
          fetched_at: new Date(Date.now() - 86_400_000).toISOString(),
        },
        error: null,
      },
    });
    const res = await call(client);
    expect(res).toMatchObject({ status: "ok", cached: true });
    expect(res.record?.last_sale_amount).toBe(875000);
    expect(reads).toEqual(["incidents", "incident_public_records"]);
    expect(state.consume).not.toHaveBeenCalled();
    expect(state.lookup).not.toHaveBeenCalled();
  });

  it("a miss looks up, then the service role stores it — with no contact fields", async () => {
    const { client } = rlsClient({ incidents: { data: INCIDENT, error: null } });
    await call(client);
    expect(state.consume).toHaveBeenCalledWith(
      "public-record-lookup",
      USER_ID,
      expect.objectContaining({ limit: 60 }),
      "closed",
    );
    expect(state.lookup).toHaveBeenCalledWith(
      {
        lat: INCIDENT.lat,
        lon: INCIDENT.lon,
        address: INCIDENT.address,
        locality: INCIDENT.locality,
        postalCode: INCIDENT.postal_code,
      },
      expect.objectContaining({ socrataAppToken: null }),
    );
    expect(state.upsert).toHaveBeenCalledTimes(1);
    const [row, opts] = state.upsert.mock.calls[0]!;
    expect(opts).toEqual({ onConflict: "incident_id" });
    expect(row).toMatchObject({
      incident_id: INCIDENT_ID,
      status: "found",
      owner_name: "SAMPLE OWNER, A",
      fetched_by: USER_ID,
    });
    for (const key of Object.keys(row)) expect(key).not.toMatch(/phone|email|mail/i);
  });

  it("'none' is cached too; an error is not", async () => {
    const { client } = rlsClient({ incidents: { data: INCIDENT, error: null } });
    state.lookup.mockResolvedValueOnce({
      kind: "none",
      source: null,
      reason: "No free public record for this area.",
    });
    expect(await call(client)).toMatchObject({
      status: "none",
      reason: "No free public record for this area.",
    });
    expect(state.upsert.mock.calls[0]![0]).toMatchObject({
      status: "not_found",
      source: null,
      note: "No free public record for this area.",
    });

    state.upsert.mockClear();
    state.lookup.mockResolvedValueOnce({ kind: "error", reason: "did not answer" });
    expect(await call(client)).toEqual({ status: "unavailable", reason: "did not answer" });
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("before the migration is applied: no cache, still answers, writes nothing", async () => {
    const { client } = rlsClient({
      incidents: { data: INCIDENT, error: null },
      incident_public_records: {
        data: null,
        error: { code: "PGRST205", message: "Could not find the table in the schema cache" },
      },
    });
    expect(await call(client)).toMatchObject({ status: "ok", cached: false });
    expect(state.upsert).not.toHaveBeenCalled();
  });

  it("a real cache read error is not swallowed", async () => {
    const { client } = rlsClient({
      incidents: { data: INCIDENT, error: null },
      incident_public_records: { data: null, error: { code: "57014", message: "timeout" } },
    });
    await expect(call(client)).rejects.toMatchObject({ code: "57014" });
  });

  it("TTL: found rows for 30 days, not_found for 7", () => {
    const now = Date.parse("2026-10-14T00:00:00Z");
    const at = (ms: number) => new Date(now - ms).toISOString();
    const base = {
      ...RECORD,
      status: "found",
      note: null,
      last_sale_amount: 1,
      assessed_value: 1,
    };
    expect(fromCache({ ...base, fetched_at: at(FOUND_TTL_MS - 1000) }, now)?.status).toBe("ok");
    expect(fromCache({ ...base, fetched_at: at(FOUND_TTL_MS + 1000) }, now)).toBeNull();
    const none = { ...base, status: "not_found", source: null, note: "No parcel." };
    expect(fromCache({ ...none, fetched_at: at(NOT_FOUND_TTL_MS - 1000) }, now)).toMatchObject({
      status: "none",
      reason: "No parcel.",
    });
    expect(fromCache({ ...none, fetched_at: at(NOT_FOUND_TTL_MS + 1000) }, now)).toBeNull();
  });
});

describe("rate limit", () => {
  it("over budget: refused with a wait, nothing fetched", async () => {
    state.consume.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 600,
      attempts: 61,
      degraded: false,
    });
    const { client } = rlsClient({ incidents: { data: INCIDENT, error: null } });
    const res = await call(client);
    expect(res.status).toBe("unavailable");
    expect(res.reason).toContain("about 10 minute");
    expect(state.lookup).not.toHaveBeenCalled();
  });

  it("limiter down: refused (closed), and not worded as the user's fault", async () => {
    state.consume.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 30,
      attempts: 0,
      degraded: true,
    });
    const { client } = rlsClient({ incidents: { data: INCIDENT, error: null } });
    const res = await call(client);
    expect(res.status).toBe("unavailable");
    expect(res.reason).not.toMatch(/too many/i);
    expect(state.lookup).not.toHaveBeenCalled();
  });
});
