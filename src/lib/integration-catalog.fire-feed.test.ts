import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  INTEGRATIONS,
  resolveStatus,
  type IntegrationSignals,
  type ProbeInput,
} from "./integration-catalog";

const spec = (id: string) => INTEGRATIONS.find((s) => s.id === id)!;

const baseSignals: IntegrationSignals = {
  events: {},
  connections: {},
  hpd: { last_at: null, success: null, upserted: null },
  incidents: { scanner_last_at: null, bnn_last_at: null, last24h: 0 },
  dialer: { last_at: null, total: 0 },
  esign: { provider: null, last_at: null },
  companycam: { imported: 0 },
  ai: { last_at: null, calls30d: 0 },
  fireFeed: {
    migrated: false,
    enabled: false,
    last_at: null,
    last_status: null,
    last_dry_run: false,
    leads24h: 0,
  },
};

const probe = (
  fireFeed: Partial<IntegrationSignals["fireFeed"]>,
  extra: Partial<IntegrationSignals> = {},
): ProbeInput => ({
  secrets: { INCIDENT_WEBHOOK_SECRET: true },
  browserKeys: {},
  signals: { ...baseSignals, ...extra, fireFeed: { ...baseSignals.fireFeed, ...fireFeed } },
});

const recent = new Date(Date.now() - 5 * 60_000).toISOString();

describe("Integrations: the fire feed card", () => {
  it("is listed before BNN, needs no paid key, and opens the fire feed's settings", () => {
    const ids = INTEGRATIONS.map((s) => s.id);
    expect(ids.indexOf("fire_feed")).toBeLessThan(ids.indexOf("bnn"));
    const s = spec("fire_feed");
    expect(s.name).toBe("Fire feed — replaces BNN");
    expect(s.credentials.filter((c) => !c.optional && c.secret)).toEqual([]);
    expect(s.detailTo).toBe("/admin/fire-feed");
    expect(s.detailLabel).toBe("Open fire feed");
    expect(s.powers).toMatch(/No API fees/);
  });

  it("before the migration it says so", () => {
    const r = resolveStatus(spec("fire_feed"), probe({}));
    expect(r.status).toBe("not_connected");
    expect(r.detail).toMatch(/20261011140000/);
  });

  it("migrated but off is amber, with where to switch it on", () => {
    const r = resolveStatus(spec("fire_feed"), probe({ migrated: true }));
    expect(r.status).toBe("pending");
    expect(r.detail).toMatch(/Settings › Sales › Fire feed/);
  });

  it("on and running is green with its leads; a failed run is red; a partial one amber", () => {
    expect(
      resolveStatus(
        spec("fire_feed"),
        probe({ migrated: true, enabled: true, last_at: recent, last_status: "ok", leads24h: 3 }),
      ),
    ).toMatchObject({
      status: "connected",
      detail: "Last run 5m ago · 3 leads in the last 24h",
    });
    expect(
      resolveStatus(
        spec("fire_feed"),
        probe({ migrated: true, enabled: true, last_at: recent, last_status: "failed" }),
      ).status,
    ).toBe("error");
    expect(
      resolveStatus(
        spec("fire_feed"),
        probe({ migrated: true, enabled: true, last_at: recent, last_status: "partial" }),
      ).status,
    ).toBe("pending");
  });
});

describe("Integrations: BNN, being replaced", () => {
  it("says it is not needed, and that the endpoint stays live", () => {
    const r = resolveStatus(spec("bnn"), probe({}));
    expect(spec("bnn").name).toBe("BNN fire alert feed (being replaced)");
    expect(r.status).toBe("not_connected");
    expect(r.detail).toBe(
      "Not needed — the fire feed replaces BNN. The endpoint stays live until Mark retires it.",
    );
  });

  it("if BNN alerts still arrive, they still show as connected", () => {
    const r = resolveStatus(
      spec("bnn"),
      probe({}, { incidents: { scanner_last_at: null, bnn_last_at: recent, last24h: 1 } }),
    );
    expect(r.status).toBe("connected");
    expect(r.detail).toMatch(/being replaced by the fire feed/);
  });
});
