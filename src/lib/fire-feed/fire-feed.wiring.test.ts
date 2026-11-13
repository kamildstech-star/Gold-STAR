import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { SETTINGS_PAGE_BY_PATH, settingsSectionOf } from "@/lib/admin-settings";
import { API_ROUTES } from "@/lib/security/public-surface";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/*
 * The promise that matters most: fire-feed leads land through the SAME insert
 * the BNN webhook uses, so the chase deck, assignment, escalation, the map
 * and the reports need no change. These pin the wiring, fragment by fragment.
 */
describe("one insert path for BNN and the fire feed", () => {
  it("the incident webhook validates with the shared schema and inserts with ingestIncident", () => {
    const hook = read("src/routes/api/public/hooks/incidents.ts");
    expect(hook.match(/incidentPayloadSchema\.safeParse\(parsedJson\)/)).not.toBeNull();
    expect(
      hook.match(/await ingestIncident\(supabaseAdmin as never, parsed\.data\)/),
    ).not.toBeNull();
    expect(hook.match(/\.from\("incidents"\)/)).toBeNull();
  });

  it("the fire feed's run is wired to that same ingestIncident", () => {
    const wiring = read("src/lib/fire-feed/run-defaults.server.ts");
    expect(wiring.match(/import\("@\/lib\/incident-ingest\.server"\)/)).not.toBeNull();
    expect(
      wiring.match(/ingest: \(payload, extras\) => ingestIncident\(db, payload, extras\)/),
    ).not.toBeNull();
  });

  it("the shared insert upserts on (source, external_ref), like the webhook always did", () => {
    const ingest = read("src/lib/incident-ingest.server.ts");
    expect(ingest.match(/onConflict: "source,external_ref"/)).not.toBeNull();
  });
});

describe("the hook and the page", () => {
  it("the cron hook is on the public-surface allowlist, behind the cron secret", () => {
    expect(API_ROUTES["src/routes/api/public/hooks/fire-feed.ts"]?.credential).toBe("cron-secret");
    const hook = read("src/routes/api/public/hooks/fire-feed.ts");
    expect(hook.match(/runFireFeedWithDefaults\(\{ trigger: "cron" \}\)/)).not.toBeNull();
  });

  it("Settings › Sales › Fire feed sits next to Territory", () => {
    const page = SETTINGS_PAGE_BY_PATH.get("/admin/fire-feed");
    expect(page?.label).toBe("Fire feed");
    expect(settingsSectionOf(page!).id).toBe("sales");
  });

  it("Run now is admin-only and rate-limited", () => {
    const fns = read("src/lib/fire-feed/fire-feed.functions.ts");
    const runNow = fns.match(/export const runFireFeedNow[\s\S]*?\n {2}\}\);/)![0];
    expect(runNow).toContain(".middleware([requireSupabaseAuth])");
    expect(runNow).toContain("await assertAdmin(context)");
    expect(runNow).toContain("RATE_LIMITS.fireFeedRunNow");
  });
});
