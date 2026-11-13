import { readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Every file under `dir`, recursively, as a forward-slash path relative to the
 * repo root ("src/routes/api/public/hooks/cadence-sweep.ts") on every OS.
 *
 * Test-only: it reads the disk, so nothing in the app may import it.
 *
 * The source-tree audits (server-surface, token-serialization, signed-url,
 * safe-html) compare what they find against allowlists keyed by path, and
 * those keys are written with "/". Each of them used to carry its own copy of
 * a walker built on `path.join`, which on Windows returns "src\routes\…". So
 * on a Windows checkout nothing matched: every listed route read as missing,
 * every route on disk read as unlisted, and the reachable-module count came out
 * at 31 against a floor of 40 — eight red tests that were green on CI. The
 * separator is fixed here, where the path is made, so no caller can forget to
 * do it and no allowlist has to know which OS it is running on.
 *
 * Directory entries come back typed rather than stat'd one by one: the same
 * list, about ten times faster on Windows, and several of these audits read
 * the whole tree while the full suite is contending for the disk.
 */
export function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const p = join(dir, entry.name).split(sep).join("/");
    return entry.isDirectory() ? walkFiles(p) : [p];
  });
}
