import {
  COMPARE_MODES,
  PERIOD_PRESETS,
  resolveCompare,
  resolvePeriod,
  type CompareMode,
  type PeriodPreset,
  type Range,
} from "@/lib/period";

/**
 * The period / comparison / scope selection lives in the URL, so Reports and
 * Sales Intelligence share one selection: moving between the two screens (or
 * sharing a link) carries the window with it instead of resetting it.
 */
export type PeriodSearch = {
  period: PeriodPreset;
  from?: string;
  to?: string;
  cmp: CompareMode;
  cfrom?: string;
  cto?: string;
  /**
   * "all" | "mine" | "loc:<uuid>" | "region:<uuid>".
   *
   * Absent means the viewer has not chosen — the report then opens on their
   * own office rather than on all twelve at once. Picking "All locations you
   * can see" writes an explicit "all", so a deliberate choice is never
   * mistaken for an unset one.
   */
  scope?: string;
};

const PERIOD_KEYS = PERIOD_PRESETS.map((p) => p.key) as string[];
const COMPARE_KEYS = COMPARE_MODES.map((c) => c.key) as string[];

const str = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s : undefined;
};

export function parsePeriodSearch(raw: Record<string, unknown>): PeriodSearch {
  const period = (
    PERIOD_KEYS.includes(String(raw.period)) ? raw.period : "last_90"
  ) as PeriodPreset;
  const cmp = (COMPARE_KEYS.includes(String(raw.cmp)) ? raw.cmp : "previous") as CompareMode;
  return {
    period,
    from: str(raw.from),
    to: str(raw.to),
    cmp,
    cfrom: str(raw.cfrom),
    cto: str(raw.cto),
    scope: str(raw.scope),
  };
}

/** Only the shared keys — safe to spread into any `<Link search>` on either screen. */
export function periodSearchOf(s: PeriodSearch): PeriodSearch {
  return {
    period: s.period,
    from: s.from,
    to: s.to,
    cmp: s.cmp,
    cfrom: s.cfrom,
    cto: s.cto,
    scope: s.scope,
  };
}

/**
 * `<Link search={(prev) => ...}>` receives the union of every route's search
 * params, so it can't be handed straight back to a typed target. Re-parsing
 * carries the selection across while satisfying the target's shape.
 */
export function carryPeriodSearch(prev: unknown): PeriodSearch {
  return parsePeriodSearch((prev ?? {}) as Record<string, unknown>);
}

export type IntelSearch = PeriodSearch & {
  view: "scorecards" | "leaderboard";
  team: "all" | "chase" | "relationship";
  gp: "month" | "quarter" | "year";
};

export function carryIntelSearch(prev: unknown): IntelSearch {
  const raw = (prev ?? {}) as Record<string, unknown>;
  return {
    ...parsePeriodSearch(raw),
    view: raw.view === "leaderboard" ? "leaderboard" : "scorecards",
    team: raw.team === "chase" ? "chase" : raw.team === "all" ? "all" : "relationship",
    gp: raw.gp === "month" || raw.gp === "year" ? raw.gp : "quarter",
  };
}

export type ResolvedSelection = {
  range: Range;
  compare: Range | null;
  /** null = whatever RLS already allows. */
  locationIds: string[] | null;
  onlyMine: boolean;
  scopeLabel: string;
  /** The scope actually in force, with the default applied. Drives the picker. */
  scope: string;
};

export function resolveSelection(
  search: PeriodSearch,
  opts: {
    locations: {
      id: string;
      code: string;
      name: string;
      region_id: string | null;
      region_ids?: string[];
    }[];
    regions: { id: string; name: string }[];
    /**
     * The viewer's own office, used when nothing is in the URL. Optional so
     * callers that genuinely want the old "everything" default can omit it.
     */
    defaultLocationId?: string | null;
  },
): ResolvedSelection {
  const range = resolvePeriod(search.period, search.from, search.to);
  const compare = resolveCompare(search.cmp, range, search.cfrom, search.cto);

  const own = opts.defaultLocationId;
  const ownIsVisible = !!own && opts.locations.some((l) => l.id === own);
  const scope = search.scope ?? (ownIsVisible ? `loc:${own}` : "all");

  let locationIds: string[] | null = null;
  let onlyMine = false;
  let scopeLabel = "All locations you can see";

  if (scope === "mine") {
    onlyMine = true;
    scopeLabel = "My team only";
  } else if (scope.startsWith("loc:")) {
    const id = scope.slice(4);
    const loc = opts.locations.find((l) => l.id === id);
    locationIds = [id];
    scopeLabel = loc ? `${loc.code} · ${loc.name}` : "Selected location";
  } else if (scope.startsWith("region:")) {
    const id = scope.slice(7);
    const region = opts.regions.find((r) => r.id === id);
    locationIds = opts.locations
      .filter((l) => (l.region_ids ?? (l.region_id ? [l.region_id] : [])).includes(id))
      .map((l) => l.id);
    scopeLabel = region ? `${region.name} region` : "Selected region";
  }

  return { range, compare, locationIds, onlyMine, scopeLabel, scope };
}
