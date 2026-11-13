#!/usr/bin/env node
/**
 * `npm run build:vercel` — the production build for Vercel, off Lovable.
 *
 * Why a script and not a second vite config: vite.config.ts goes through
 * Lovable's wrapper (@lovable.dev/vite-tanstack-config), and inside Lovable's
 * builder that wrapper pins its own Nitro preset and output layout whatever we
 * pass. So `npm run build` stays exactly what Lovable runs, and this script
 * only adds what a Vercel deploy needs on top:
 *
 *   1. pins NITRO_PRESET=vercel, so Nitro writes the Build Output API
 *      (.vercel/output: config.json, functions/__server.func, static/) instead
 *      of the Cloudflare default. vite.config.ts reads the same variable, and
 *      only then, to put the service worker in .vercel/output/static where
 *      Vercel serves it, and to bundle every package into the function
 *      (noExternals) the way the Workers build does;
 *   2. writes the function settings into every .vc-config.json — region and
 *      max duration (below). With a prebuilt Build Output API deployment these
 *      files ARE the function config: vercel.json `functions` patterns match
 *      source files, and there are none here;
 *   3. checks the result, so a Nitro upgrade that moves things, a wrong Node
 *      version, a missing service worker or a function that still leans on a
 *      traced node_modules fails here, not on Vercel.
 *
 * No network, no secrets, no Vercel account. Cross-platform (plain Node).
 * vercel.json at the repo root is safe for Lovable's build: the only thing in
 * Nitro that reads it is the vercel preset (for `bunVersion`); the Cloudflare
 * preset Lovable builds with never opens it.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * sfo1 (San Francisco) sits next to the GSR database (Supabase us-west-1,
 * N. California): every server function makes several database round trips,
 * and Vercel's default region is iad1 (Washington, D.C.).
 */
const VERCEL_REGION = "sfo1";
/**
 * Seconds. The Outlook sync, the fire feed and the paper ticket reader run
 * long; 300 s is the Pro plan's default and is also allowed on Hobby (both
 * with Fluid compute); Pro may go to 800. vercel.com/docs/functions/configuring-functions/duration
 */
const VERCEL_MAX_DURATION = 300;
/** The project is Node 24 (CI, .github/workflows); Vercel's runtime must match. */
const NODE_MAJOR = 24;

const LOVABLE_PROJECT = "ortpawtuqerkmuykwndp";
const OUT = join(root, ".vercel", "output");

function fail(message) {
  console.error(`\n[build:vercel] ${message}`);
  process.exit(1);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readEnvFile() {
  const path = join(root, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/* Node: Nitro names the Vercel runtime after the Node that builds it. */
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor !== NODE_MAJOR) {
  fail(
    `Building on Node ${process.versions.node}; the project runs on Node ${NODE_MAJOR}.\n` +
      `            On Vercel: Project Settings › Build and Deployment › Node.js Version = ${NODE_MAJOR}.x.`,
  );
}

/* The browser bundle is baked with VITE_* at build time (environment wins over .env). */
const effective = { ...readEnvFile(), ...process.env };
if ((effective.VITE_SUPABASE_URL ?? "").includes(LOVABLE_PROJECT)) {
  console.warn(
    `[build:vercel] WARNING: VITE_SUPABASE_URL is the Lovable Cloud project (${LOVABLE_PROJECT}).\n` +
      "               Set VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and VITE_SUPABASE_PROJECT_ID\n" +
      "               in the Vercel project's environment to build against GSR (docs/MOVING-OFF-LOVABLE-VERCEL.md).",
  );
}

/* 1: the build. A clean output, so a function from an older build cannot linger. */
rmSync(OUT, { recursive: true, force: true });
const vite = join(root, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(vite)) fail("vite is not installed. Run `npm ci` first.");
// 4 GiB heap, as CI gives `npm run build`: Node 24's default is not enough for
// this app's build, and a flag here needs no NODE_OPTIONS in the Vercel project
// (which would also reach the functions at runtime).
const run = spawnSync(process.execPath, ["--max-old-space-size=4096", vite, "build"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NITRO_PRESET: "vercel" },
});
if (run.status !== 0) fail(`vite build exited with ${run.status ?? run.signal}.`);

/* 3a: is it the Build Output API, from the vercel preset? */
const nitroJson = join(OUT, "nitro.json");
if (!existsSync(nitroJson)) fail(".vercel/output/nitro.json is missing — Nitro did not run.");
const nitro = readJson(nitroJson);
if (nitro.preset !== "vercel") fail(`Nitro built preset "${nitro.preset}", not vercel.`);
const config = readJson(join(OUT, "config.json"));
if (config.version !== 3) fail(`.vercel/output/config.json is version ${config.version}, not 3.`);
if (config.crons?.length) fail("config.json schedules Vercel Cron jobs; pg_cron is the scheduler.");
for (const file of ["sw.js", "manifest.webmanifest"]) {
  if (!existsSync(join(OUT, "static", file))) fail(`.vercel/output/static/${file} is missing.`);
}

/* 2: the function settings, in every function (symlinked ones share a directory). */
const functionsDir = join(OUT, "functions");
const funcs = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    if (name.endsWith(".func")) funcs.push(path);
    else walk(path);
  }
})(functionsDir);
if (!funcs.some((f) => f.endsWith("__server.func")))
  fail("functions/__server.func is missing — the app's server function was not built.");

const patched = new Set();
for (const func of funcs) {
  const real = realpathSync(func);
  if (patched.has(real)) continue;
  patched.add(real);
  const path = join(real, ".vc-config.json");
  if (!existsSync(path)) fail(`${path} is missing.`);
  const vc = readJson(path);
  // Traced packages are how tslib went missing (vite.config.ts, noExternals).
  if (existsSync(join(real, "node_modules")))
    fail(`${func} has a node_modules directory; the function must be fully bundled.`);
  if (vc.runtime !== `nodejs${NODE_MAJOR}.x`)
    fail(`${func} runs on ${vc.runtime}, not nodejs${NODE_MAJOR}.x.`);
  vc.regions = [VERCEL_REGION];
  vc.maxDuration = VERCEL_MAX_DURATION;
  writeFileSync(path, JSON.stringify(vc, null, 2));
}

/* 3b: read it back, as Vercel will. */
const server = readJson(join(functionsDir, "__server.func", ".vc-config.json"));
if (
  server.regions?.join() !== VERCEL_REGION ||
  server.maxDuration !== VERCEL_MAX_DURATION ||
  server.launcherType !== "Nodejs" ||
  !existsSync(join(functionsDir, "__server.func", server.handler))
) {
  fail(`__server.func/.vc-config.json is not what was written: ${JSON.stringify(server)}`);
}

console.log(
  `\n[build:vercel] OK — Build Output API in .vercel/output/: ${funcs.length} function(s), ` +
    `${server.runtime}, region ${VERCEL_REGION}, maxDuration ${VERCEL_MAX_DURATION}s.`,
);
