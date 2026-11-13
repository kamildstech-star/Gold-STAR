import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * 20261012150000 redefines every database caller of an app hook. It must
 * change ONLY where the URL comes from — nothing else. The bodies it starts
 * from are recorded from live (pg_get_functiondef, read-only) in the fixture;
 * this test fails if the migration's copy of any function or of the
 * run-automations-15min command differs from that recording anywhere except
 * the hook_url assignment (and the `IF hook_url IS NULL THEN RETURN` line the
 * base-URL fallback replaces).
 *
 * Why it exists: an earlier draft was written from a body read before
 * 20261012100000 (#360) landed and silently dropped email_release_kick's
 * retry wake-up for parked queued mail. If a migration that redefines one of
 * these functions lands before this one is applied, re-record the fixture
 * from live and regenerate the body — this test then shows the diff.
 */

const MIGRATION = readFileSync(
  "supabase/migrations/20261012150000_app_base_url.sql",
  "utf8",
).replace(/\r\n/g, "\n");
const FIXTURE = JSON.parse(
  readFileSync("supabase/tests/fixtures/live-hook-callers-2026-10-12.json", "utf8"),
) as {
  functions: Record<string, { def: string; md5: string; acl: string }>;
  cron: Record<string, string>;
};

const PATHS: Record<string, string> = {
  drying_weather_kick: "drying-weather",
  email_release_kick: "email-release",
  fire_feed_kick: "fire-feed",
  graph_sync_kick: "graph-sync",
  kahi_sync_kick: "kahi-sync",
  raven_sync_kick: "raven-sync",
  tg_automation_notify: "run-automations",
};

/** The URL line(s) collapsed to one placeholder; everything else verbatim. */
function withoutUrl(body: string): string {
  return body
    .replace(
      /hook_url := (?:public\.app_hook_url\([^;]*\)|COALESCE\(\s*NULLIF\(btrim\([^)]*\), ''\),\s*'[^']*'\s*\)|cfg->>'hook_url');/,
      "hook_url := <URL>;",
    )
    .replace(/\n[ \t]*IF hook_url IS NULL THEN RETURN(?: NULL)?; END IF;/, "");
}

function migrationBody(name: string): string {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is redefined`).toBeGreaterThanOrEqual(0);
  const end = MIGRATION.indexOf("$function$;", start);
  return `${MIGRATION.slice(start, end)}$function$\n`;
}

describe("20261012150000 changes nothing in the live hook callers but the URL", () => {
  it("the recording is intact", () => {
    for (const [name, f] of Object.entries(FIXTURE.functions)) {
      expect(createHash("md5").update(f.def).digest("hex"), name).toBe(f.md5);
    }
  });

  it("redefines exactly the recorded callers", () => {
    const redefined = [...MIGRATION.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_]+)\(/g)]
      .map((m) => m[1]!)
      .filter((n) => n !== "app_base_url" && n !== "app_hook_url")
      .sort();
    expect(redefined).toEqual(Object.keys(FIXTURE.functions).sort());
  });

  for (const name of Object.keys(PATHS)) {
    it(`${name}: identical to live outside the URL line`, () => {
      const live = FIXTURE.functions[name]!.def;
      const ours = migrationBody(name);
      expect(withoutUrl(ours)).toBe(withoutUrl(live));
      // and the URL line asks the base for this caller's own hook, keeping
      // whatever per-job override the live body honoured.
      const liveOverride = /NULLIF\(btrim\(([^)]*)\), ''\)/.exec(live)?.[1] ?? "cfg->>'hook_url'";
      expect(ours).toContain(`hook_url := public.app_hook_url('${PATHS[name]}', ${liveOverride});`);
    });
  }

  it("email_release_kick still wakes for parked queued mail (#360)", () => {
    const body = migrationBody("email_release_kick");
    expect(body).toContain("q.delivery_reason IS NOT NULL");
    expect(body).toContain("q.delivery_attempts < 6");
  });

  it("run-automations-15min: the live command with only the url changed", () => {
    const live = FIXTURE.cron["run-automations-15min"]!;
    const ours = /_command text := \$cron\$([\s\S]*?)\$cron\$;/.exec(MIGRATION)![1]!;
    const strip = (c: string) =>
      c.replace(/url:=(?:'[^']*'|public\.app_hook_url\('[a-z-]+'\)),/, "url:=<URL>,");
    expect(strip(ours)).toBe(strip(live));
    expect(ours).toContain("url:=public.app_hook_url('run-automations'),");
  });
});
