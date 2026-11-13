/**
 * Vitest runs from the repo root, and background agents work in git worktrees
 * under .claude/worktrees — each a full checkout with its own copy of every
 * test file. Without this exclude the suite collects those too, so a test one
 * agent has deliberately rewritten fails from another agent's stale copy and
 * reads as a real regression on main. Two of today's runs were exactly that.
 */
import { defineConfig } from "vitest/config";
import tsConfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsConfigPaths()],
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "**/.output/**", "**/.claude/**"],
    /*
     * 20s, not vitest's 5s.
     *
     * Three tests have been failing intermittently for a week and getting
     * written off as flakes: document-audience and photo-pdf (each builds a
     * real PDF with pdf-lib) and the badge-parser guard (walks all 598 files
     * in src/lib). None of them hangs — they are slow, synchronous work that
     * finishes in about a second alone and misses 5s when the whole suite is
     * running in parallel on a loaded machine. A timeout that fires on load
     * rather than on a fault trains everyone to ignore a red run, which is
     * worse than a slow one.
     */
    testTimeout: 20_000,
  },
});
