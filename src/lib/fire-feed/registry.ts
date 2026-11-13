/**
 * Which source kinds this build can fetch.
 *
 * Found by file name, not by a list: every `sources/<kind>.source.ts` whose
 * default export is a FireSource is registered. A new free source (a fire
 * department's page, the NWS, a scanner transcript feed) is one new file in
 * `sources/` and a kind in the database's CHECK — this file never changes,
 * and two pull requests adding two sources cannot collide in it.
 *
 * A database row whose kind has no file in this build is not an error: the
 * run logs "no adapter for public_page in this build" against it and moves
 * on, and the admin screen shows the same thing.
 */
import type { FireSource, FireSourceKind } from "./types";

const modules = import.meta.glob<{ default?: unknown }>("./sources/*.source.ts", { eager: true });

function isFireSource(v: unknown): v is FireSource {
  const s = v as Partial<FireSource> | null;
  return Boolean(
    s && typeof s.kind === "string" && typeof s.fetch === "function" && typeof s.label === "string",
  );
}

export const FIRE_SOURCES: ReadonlyMap<FireSourceKind, FireSource> = new Map(
  Object.entries(modules)
    .map(([, mod]) => mod.default)
    .filter(isFireSource)
    .map((s) => [s.kind, s] as const),
);

export function fireSourceFor(kind: string): FireSource | null {
  return FIRE_SOURCES.get(kind as FireSourceKind) ?? null;
}

export function availableSourceKinds(): FireSourceKind[] {
  return [...FIRE_SOURCES.keys()].sort();
}
