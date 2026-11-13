import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The Vercel deploy target must never reach into Lovable's build. Lovable runs
 * `npm run build` (vite build through @lovable.dev/vite-tanstack-config, Nitro's
 * cloudflare-module preset); build:vercel is a separate script that pins the
 * vercel preset. Nothing here may change what the first one produces.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const pkg = JSON.parse(read("package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const script = read("scripts/build-vercel.mjs");
const constant = (name: string) => new RegExp(`const ${name} = ([^;]+);`).exec(script)?.[1];

describe("vercel.json", () => {
  const config = JSON.parse(read("vercel.json")) as Record<string, unknown>;

  it("builds with build:vercel, installs from the lockfile CI checks, no framework guessing", () => {
    expect(config.buildCommand).toBe("npm run build:vercel");
    expect(config.installCommand).toBe("npm ci");
    expect(config.framework).toBeNull();
  });

  it("is plain JSON — Nitro's vercel preset parses it (for bunVersion) and must not choke", () => {
    expect(config).not.toHaveProperty("bunVersion");
  });

  it("schedules nothing and configures no function by pattern — pg_cron stays the scheduler", () => {
    expect(config).not.toHaveProperty("crons");
    // Prebuilt output: function settings live in .vc-config.json, written by
    // scripts/build-vercel.mjs. A `functions` pattern would match no source file.
    expect(config).not.toHaveProperty("functions");
  });

  it("names the same region the build writes into the function config", () => {
    expect(config.regions).toEqual(["sfo1"]);
    expect(constant("VERCEL_REGION")).toBe('"sfo1"');
  });
});

describe("scripts/build-vercel.mjs", () => {
  it("pins the vercel preset and leaves `build` as Lovable runs it", () => {
    expect(pkg.scripts["build"]).toBe("vite build");
    expect(pkg.scripts["build:vercel"]).toBe("node scripts/build-vercel.mjs");
    expect(script).toMatch(/NITRO_PRESET: "vercel"/);
  });

  it("gives long server work 300 s on Node 24", () => {
    expect(constant("VERCEL_MAX_DURATION")).toBe("300");
    expect(constant("NODE_MAJOR")).toBe("24");
    expect(script).toMatch(/vc\.regions = \[VERCEL_REGION\];/);
    expect(script).toMatch(/vc\.maxDuration = VERCEL_MAX_DURATION;/);
  });

  it("fails the build on Vercel Cron jobs, a missing service worker or an unbundled function", () => {
    expect(script).toMatch(/config\.crons\?\.length/);
    expect(script).toMatch(/\["sw\.js", "manifest\.webmanifest"\]/);
    expect(script).toMatch(/the function must be fully bundled/);
  });

  it("adds no dependency — a new one would change bun.lock, which Lovable installs from", () => {
    for (const name of ["vercel", "@vercel/node", "nitropack"]) {
      expect(pkg.dependencies[name], name).toBeUndefined();
      expect(pkg.devDependencies[name], name).toBeUndefined();
    }
  });
});

describe("Lovable's build is untouched", () => {
  const vite = read("vite.config.ts");

  it("vite.config.ts still builds through Lovable's wrapper, with nitro options only for Vercel", () => {
    expect(vite).toMatch(/import \{ defineConfig \} from "@lovable\.dev\/vite-tanstack-config";/);
    // Any other `nitro` key could reach Lovable's build. This one exists only
    // under the vercel preset.
    const nitroKeys = vite.match(/\bnitro: \{[^}]*\}/g) ?? [];
    expect(nitroKeys).toEqual(["nitro: { noExternals: true }"]);
    // Inside `vite: { … }` (Vite's own option, read by nitro/vite), never the
    // wrapper's top-level `nitro`, which would switch its explicit-Nitro path on.
    const viteBlock = /\n {2}vite: \{\n([\s\S]*?)\n {4}resolve: \{/.exec(vite)?.[1] ?? "";
    expect(viteBlock).toContain(
      '\n    ...(process.env.NITRO_PRESET === "vercel" ? { nitro: { noExternals: true } } : {}),',
    );
  });

  it("the service worker goes to .output/public unless the preset is vercel", () => {
    const outDir = /outDir: ([^\n]+),\n/.exec(vite)?.[1];
    expect(outDir).toBe(
      'process.env.NITRO_PRESET === "vercel" ? ".vercel/output/static" : ".output/public"',
    );
  });

  it("no Nitro or TanStack config file that Lovable's wrapper or Nitro would load on its own", () => {
    for (const name of ["nitro.config.ts", "nitro.config.js", "nitro.config.mjs", ".nitrorc"]) {
      expect(existsSync(name), name).toBe(false);
    }
  });

  it("the build output is ignored, not committed", () => {
    expect(read(".gitignore")).toMatch(/^\.vercel$/m);
  });
});

describe("CI", () => {
  it("runs build:vercel with no secrets", () => {
    const wf = read(".github/workflows/pull-request-checks.yml");
    const step = /- name: Vercel build \(build:vercel\)\n([\s\S]*?)\n\n/.exec(wf)?.[1] ?? "";
    expect(step).toMatch(/run: npm run build:vercel/);
    expect(step).not.toMatch(/secrets\.|VERCEL_TOKEN/);
  });
});
