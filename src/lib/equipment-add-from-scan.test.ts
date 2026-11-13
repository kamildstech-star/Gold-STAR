import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  addDefaults,
  addEquipmentFromScan,
  canOfferAdd,
  officeFromTag,
  typeFromTag,
} from "@/lib/equipment-add-from-scan";
import { placementWarnings, type RegisterUnit } from "@/lib/equipment-scan";

/*
 * CEO, 26 Oct: a tag that is not yet in the equipment register can be added
 * right there from the scan. The server half is proved against the real
 * function in supabase/tests/equipment-add-from-scan.pglite.mjs.
 */
const OFFICES = [
  { id: "ny", code: "NY", name: "Brooklyn, NY" },
  { id: "nyup", code: "NY-UP", name: "NY-Upstate" },
  { id: "nj", code: "NJ", name: "Lakewood, NJ" },
  { id: "tx", code: "TX", name: "Gold Star Restoration HTX LLC" },
  { id: "cat", code: "CAT", name: "Gold Star Restoration CAT LLC" },
  { id: "il", code: "IL", name: "Skokie, IL" },
];

const unit = (over: Partial<RegisterUnit> = {}): RegisterUnit => ({
  id: "u1",
  asset_tag: "GSR-DU00042-NJ",
  equipment_type: "dehumidifier",
  status: "available",
  location_id: "nj",
  ...over,
});

/** A stand-in Supabase client whose rpc answers as given. */
const client = (answer: { data?: unknown; error?: { code?: string; message: string } | null }) => {
  const rpc = vi.fn(async () => ({ data: answer.data ?? null, error: answer.error ?? null }));
  return { rpc } as unknown as Parameters<typeof addEquipmentFromScan>[0] & { rpc: typeof rpc };
};

describe("the smart defaults", () => {
  it("reads the type from the tag's letters", () => {
    expect(typeFromTag("GSR-AM00001-NY")).toBe("air_mover");
    expect(typeFromTag("GSR-DU00001-NJ")).toBe("dehumidifier");
    expect(typeFromTag("gsr as00001 htx")).toBe("air_scrubber");
    expect(typeFromTag("GSR-00983-NJ")).toBeNull(); // older plates: no letters
    expect(typeFromTag("HELLO")).toBeNull();
  });

  it("reads the home office from the tag's suffix, as the tag import maps them", () => {
    expect(officeFromTag("GSR-AM00001-NY", OFFICES)).toBe("ny");
    expect(officeFromTag("GSR-AM00001-NYU", OFFICES)).toBe("nyup");
    expect(officeFromTag("GSR-AM00001-HTX", OFFICES)).toBe("tx");
    expect(officeFromTag("GSR-AM00001-CAT1", OFFICES)).toBe("cat");
    expect(officeFromTag("GSR-AM00001-CAT2", OFFICES)).toBe("cat");
    expect(officeFromTag("GSR-AM00001-IL", OFFICES)).toBe("il");
    expect(officeFromTag("GSR-AM00001-GA", OFFICES)).toBeNull(); // not an office this person sees
  });

  it("falls back to the job's office, then the person's own", () => {
    expect(
      addDefaults("GSR-00983-GA", {
        offices: OFFICES,
        jobLocationId: "nj",
        primaryLocationId: "ny",
      }),
    ).toEqual({
      equipmentType: "air_mover",
      typeFromTag: false,
      officeId: "nj",
    });
    expect(
      addDefaults("GSR-DU00007-GA", {
        offices: OFFICES,
        jobLocationId: null,
        primaryLocationId: "ny",
      }),
    ).toEqual({
      equipmentType: "dehumidifier",
      typeFromTag: true,
      officeId: "ny",
    });
  });
});

describe("the honesty guards", () => {
  it("offers add only after the register's own no, and only for a plate", () => {
    expect(canOfferAdd("GSR-AM00001-NY", "unregistered")).toBe(true);
    expect(canOfferAdd("GSR-AM00001-NY", "offline_unknown")).toBe(false);
    expect(canOfferAdd("GSR-AM00001-NY", "lookup_failed")).toBe(false);
    expect(canOfferAdd("GSRAM00001NY", "unregistered")).toBe(false); // not plate-shaped
    expect(canOfferAdd("1Z999AA10123456784", "unregistered")).toBe(false);
  });

  it("never sends a misread to the server", async () => {
    const c = client({ data: [] });
    expect(
      await addEquipmentFromScan(c, {
        tag: "HELLO",
        equipmentType: "air_mover",
        officeId: "ny",
        notes: null,
        via: "scan:equipment_setup",
        jobId: "j1",
      }),
    ).toEqual({ kind: "not_a_tag" });
    expect(c.rpc).not.toHaveBeenCalled();
  });
});

describe("unknown tag → add → placed, in one flow", () => {
  it("creates the unit and hands it back ready to place on the job", async () => {
    const c = client({
      data: [
        {
          outcome: "created",
          id: "new1",
          asset_tag: "GSR-DU00042-NJ",
          equipment_type: "dehumidifier",
          status: "available",
          location_id: "nj",
          purchase_cost_cents: null,
        },
      ],
    });
    // The scan's lookup said "unregistered"; the crew confirmed the defaults.
    expect(canOfferAdd("GSR-DU00042-NJ", "unregistered")).toBe(true);
    const d = addDefaults("GSR-DU00042-NJ", {
      offices: OFFICES,
      jobLocationId: "nj",
      primaryLocationId: null,
    });
    const res = await addEquipmentFromScan(c, {
      tag: "gsr du00042 nj",
      equipmentType: d.equipmentType,
      officeId: d.officeId,
      notes: " by the stairs ",
      via: "scan:equipment_setup",
      jobId: "job-7",
    });
    expect(c.rpc).toHaveBeenCalledWith("add_equipment_from_scan", {
      _tag: "GSR-DU00042-NJ",
      _equipment_type: "dehumidifier",
      _location_id: "nj",
      _notes: "by the stairs",
      _via: "scan:equipment_setup",
      _job_id: "job-7",
    });
    expect(res).toEqual({ kind: "created", unit: unit({ id: "new1" }) });
    // Nothing blocks placing it on this job: it is idle and in the job's office.
    if (res.kind !== "created") throw new Error("not created");
    expect(placementWarnings(res.unit, { jobLocationId: "nj", stale: false })).toEqual([]);
  });

  it("puts the added unit on the session's list, the list the Place button places", () => {
    const scanner = readFileSync("src/components/asset-tag-scanner.tsx", "utf8");
    expect(scanner).toMatch(/if \(addToRegisterRef\.current && canOfferAdd\(tag, found\.kind\)\)/);
    expect(scanner).toMatch(/take\(res\.unit, \{\s*kind: "match",/);
    const panel = readFileSync("src/components/equipment-panel.tsx", "utf8");
    expect(panel).toMatch(
      /addToRegister=\{\{ via: "scan:equipment_setup", jobId, jobLocationId \}\}/,
    );
    const ticket = readFileSync("src/components/field-work-ticket-panel.tsx", "utf8");
    expect(ticket).toMatch(
      /addToRegister=\{\{ via: "scan:field_ticket", jobId, jobLocationId: locationId \}\}/,
    );
  });

  it("is not offered when retrieving — an unknown unit was never logged out to the job", () => {
    const panel = readFileSync("src/components/equipment-panel.tsx", "utf8");
    const pickup = panel.slice(panel.indexOf("function PickupScanSession"));
    const body = pickup.slice(0, pickup.indexOf("\nfunction ", 10));
    expect(body).toMatch(/<AssetTagScanner/);
    expect(body).not.toMatch(/addToRegister=/);
  });
});

describe("a normalized duplicate offers the existing unit", () => {
  it("hands back the unit already registered, never a twin", async () => {
    const c = client({
      data: [
        {
          outcome: "existing",
          id: "old1",
          asset_tag: "GSR-AM00001-NY",
          equipment_type: "air_mover",
          status: "available",
          location_id: "ny",
          purchase_cost_cents: null,
        },
      ],
    });
    const res = await addEquipmentFromScan(c, {
      tag: "GSR AM00001 NY",
      equipmentType: "air_mover",
      officeId: "ny",
      notes: null,
      via: "scan:equipment_setup",
      jobId: null,
    });
    expect(res).toMatchObject({
      kind: "existing",
      unit: { id: "old1", asset_tag: "GSR-AM00001-NY" },
    });
  });
});

describe("the permission-refused path", () => {
  it("turns the server's refusal into 'not permitted', not a failure", async () => {
    const c = client({ error: { code: "42501", message: "not_permitted" } });
    expect(
      await addEquipmentFromScan(c, {
        tag: "GSR-AS00099-NY",
        equipmentType: "air_scrubber",
        officeId: "ny",
        notes: null,
        via: "scan:field_ticket",
        jobId: "j1",
      }),
    ).toEqual({ kind: "not_permitted" });
    // 13 Nov (owner): a role that may not add sees no panel and no "your role
    // cannot" notice — the office is dropped, and with none left the panel
    // hands back to the scanner, which says the tag is unregistered.
    const panel = readFileSync("src/components/add-to-register-panel.tsx", "utf8");
    expect(panel).not.toMatch(/Your role cannot add/);
    expect(panel).not.toMatch(/Ask an admin/);
    expect(panel).toMatch(/if \(res\.kind === "not_permitted"\) \{[\s\S]{0,200}setPermitted\(/);
    expect(panel).toMatch(/if \(notPermitted\) onNotPermitted\?\.\(\)/);
    const scanner = readFileSync("src/components/asset-tag-scanner.tsx", "utf8");
    expect(scanner).toMatch(/onNotPermitted=\{/);
  });

  it("other errors are said as errors, not swallowed", async () => {
    const c = client({ error: { code: "08006", message: "connection lost" } });
    await expect(
      addEquipmentFromScan(c, {
        tag: "GSR-AS00099-NY",
        equipmentType: "air_scrubber",
        officeId: "ny",
        notes: null,
        via: "scan:field_ticket",
        jobId: "j1",
      }),
    ).rejects.toMatchObject({ message: "connection lost" });
  });
});
