/**
 * Which colour a pipeline stage is drawn in — the one answer every surface asks.
 *
 * Mark, on an account's prospect record: "the colors here in the pipeline
 * aren't exciting." They weren't anything. The rail, the current-stage pill,
 * the board's column bands and the Timeline's stage rows were all the same
 * gold (or, on the board, a 10% wash of whatever hex an admin had picked), so
 * colour carried no meaning anywhere. Now a stage has ONE tone, the same on
 * the record's rail, the board's column, a grid card's badge, the list's Stage
 * cell and the Timeline row that says the account moved there.
 *
 * BY KEY, NEVER BY LABEL. Labels are display text an admin can rename —
 * "GOASTED" became "Ghosted" without the key moving — and the key is what the
 * rule engine, the history and `accounts.stage` store. So the map is keyed on
 * `pipeline_stages.key`, and the misspelled `goasted` is in it on purpose (see
 * the note in `sales-pipeline.ts`).
 *
 * WHY NOT `pipeline_stages.color`. That column is a raw hex chosen once per
 * stage. It has no dark-mode value and no contrast guarantee, and the seeds
 * gave Ready and Active Outreach the same blue and Conversation Established
 * and Active Client the same green — two adjacent pairs indistinguishable on
 * the rail. The tones are theme tokens (`styles.css`, Tones block) measured
 * for AA in light and dark. The admin picker still colours the job board,
 * which this does not touch.
 *
 * A CUSTOM STAGE gets a tone deterministically from its key: the same stage is
 * the same colour on every screen and every visit, and a rename does not
 * repaint it. The fallback set deliberately excludes the six stage hues and
 * indigo (AI), so a custom stage can never be mistaken for Ghosted.
 *
 * Every class string below is a literal, because Tailwind only generates the
 * classes it can find written out in the source.
 */

export type ToneName =
  | "sky"
  | "violet"
  | "amber"
  | "emerald"
  | "slate"
  | "rose"
  | "teal"
  | "fuchsia"
  | "orange"
  | "lime";

export type StageTone = {
  name: ToneName;
  /** The fill as a CSS value, for inline styles — the rail's gradient stops. */
  color: string;
  /** A solid pill: the fill with its own legible text. */
  fill: string;
  /** A marker dot, or anything that is just the colour. */
  dot: string;
  /** The hue as text on the page, the card or the soft tint. */
  text: string;
  /** The same text, only while its row or marker is hovered (`group`). */
  groupHoverText: string;
  /** A chip or band: the soft tint with the hue's text. */
  soft: string;
  /** The soft tint as a CSS value, for inline backgrounds. */
  softColor: string;
  /** A hairline in the hue. */
  border: string;
  /** A halo around the fill — the current-stage pill's glow ring. */
  ring: string;
};

export const TONES: Record<ToneName, StageTone> = {
  sky: {
    name: "sky",
    color: "var(--tone-sky)",
    fill: "bg-tone-sky text-tone-sky-fg",
    dot: "bg-tone-sky",
    text: "text-tone-sky-text",
    groupHoverText: "group-hover:text-tone-sky-text",
    soft: "bg-tone-sky-soft text-tone-sky-text",
    softColor: "color-mix(in oklab, var(--tone-sky) var(--tone-soft-mix), var(--card))",
    border: "border-tone-sky",
    ring: "ring-tone-sky/25",
  },
  violet: {
    name: "violet",
    color: "var(--tone-violet)",
    fill: "bg-tone-violet text-tone-violet-fg",
    dot: "bg-tone-violet",
    text: "text-tone-violet-text",
    groupHoverText: "group-hover:text-tone-violet-text",
    soft: "bg-tone-violet-soft text-tone-violet-text",
    softColor: "color-mix(in oklab, var(--tone-violet) var(--tone-soft-mix), var(--card))",
    border: "border-tone-violet",
    ring: "ring-tone-violet/25",
  },
  amber: {
    name: "amber",
    color: "var(--tone-amber)",
    fill: "bg-tone-amber text-tone-amber-fg",
    dot: "bg-tone-amber",
    text: "text-tone-amber-text",
    groupHoverText: "group-hover:text-tone-amber-text",
    soft: "bg-tone-amber-soft text-tone-amber-text",
    softColor: "color-mix(in oklab, var(--tone-amber) var(--tone-soft-mix), var(--card))",
    border: "border-tone-amber",
    ring: "ring-tone-amber/25",
  },
  emerald: {
    name: "emerald",
    color: "var(--tone-emerald)",
    fill: "bg-tone-emerald text-tone-emerald-fg",
    dot: "bg-tone-emerald",
    text: "text-tone-emerald-text",
    groupHoverText: "group-hover:text-tone-emerald-text",
    soft: "bg-tone-emerald-soft text-tone-emerald-text",
    softColor: "color-mix(in oklab, var(--tone-emerald) var(--tone-soft-mix), var(--card))",
    border: "border-tone-emerald",
    ring: "ring-tone-emerald/25",
  },
  slate: {
    name: "slate",
    color: "var(--tone-slate)",
    fill: "bg-tone-slate text-tone-slate-fg",
    dot: "bg-tone-slate",
    text: "text-tone-slate-text",
    groupHoverText: "group-hover:text-tone-slate-text",
    soft: "bg-tone-slate-soft text-tone-slate-text",
    softColor: "color-mix(in oklab, var(--tone-slate) var(--tone-soft-mix), var(--card))",
    border: "border-tone-slate",
    ring: "ring-tone-slate/25",
  },
  rose: {
    name: "rose",
    color: "var(--tone-rose)",
    fill: "bg-tone-rose text-tone-rose-fg",
    dot: "bg-tone-rose",
    text: "text-tone-rose-text",
    groupHoverText: "group-hover:text-tone-rose-text",
    soft: "bg-tone-rose-soft text-tone-rose-text",
    softColor: "color-mix(in oklab, var(--tone-rose) var(--tone-soft-mix), var(--card))",
    border: "border-tone-rose",
    ring: "ring-tone-rose/25",
  },
  teal: {
    name: "teal",
    color: "var(--tone-teal)",
    fill: "bg-tone-teal text-tone-teal-fg",
    dot: "bg-tone-teal",
    text: "text-tone-teal-text",
    groupHoverText: "group-hover:text-tone-teal-text",
    soft: "bg-tone-teal-soft text-tone-teal-text",
    softColor: "color-mix(in oklab, var(--tone-teal) var(--tone-soft-mix), var(--card))",
    border: "border-tone-teal",
    ring: "ring-tone-teal/25",
  },
  fuchsia: {
    name: "fuchsia",
    color: "var(--tone-fuchsia)",
    fill: "bg-tone-fuchsia text-tone-fuchsia-fg",
    dot: "bg-tone-fuchsia",
    text: "text-tone-fuchsia-text",
    groupHoverText: "group-hover:text-tone-fuchsia-text",
    soft: "bg-tone-fuchsia-soft text-tone-fuchsia-text",
    softColor: "color-mix(in oklab, var(--tone-fuchsia) var(--tone-soft-mix), var(--card))",
    border: "border-tone-fuchsia",
    ring: "ring-tone-fuchsia/25",
  },
  orange: {
    name: "orange",
    color: "var(--tone-orange)",
    fill: "bg-tone-orange text-tone-orange-fg",
    dot: "bg-tone-orange",
    text: "text-tone-orange-text",
    groupHoverText: "group-hover:text-tone-orange-text",
    soft: "bg-tone-orange-soft text-tone-orange-text",
    softColor: "color-mix(in oklab, var(--tone-orange) var(--tone-soft-mix), var(--card))",
    border: "border-tone-orange",
    ring: "ring-tone-orange/25",
  },
  lime: {
    name: "lime",
    color: "var(--tone-lime)",
    fill: "bg-tone-lime text-tone-lime-fg",
    dot: "bg-tone-lime",
    text: "text-tone-lime-text",
    groupHoverText: "group-hover:text-tone-lime-text",
    soft: "bg-tone-lime-soft text-tone-lime-text",
    softColor: "color-mix(in oklab, var(--tone-lime) var(--tone-soft-mix), var(--card))",
    border: "border-tone-lime",
    ring: "ring-tone-lime/25",
  },
};

/**
 * The prospecting stages, by key. Ready is the cool start, Active Outreach
 * the work, Conversation Established Gold Star's own gold, Active Client the
 * win; the two exits are a quiet grey and the red of a lost deal.
 */
export const STAGE_KEY_TONE: Readonly<Record<string, ToneName>> = {
  ready: "sky",
  active_outreach: "violet",
  conversation_established: "amber",
  active_client: "emerald",
  no_service_needed: "slate",
  goasted: "rose",
  /*
   * Same meanings under other keys: the board's Active Clients column (not a
   * stage row, see `ACTIVE_CLIENTS_STAGE`) is the win, and the Farming
   * pipeline's Ghosted is a ghost.
   */
  active_clients: "emerald",
  ghosted: "rose",
};

/** What a custom stage may be. None of these is a stage hue or AI's indigo. */
export const FALLBACK_TONES: readonly ToneName[] = ["teal", "fuchsia", "orange", "lime"];

/** FNV-1a: tiny, stable across runtimes, and spreads short keys well. */
function hashKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The tone name for a stage key. A stage with no key is neutral. */
export function stageToneName(key: string | null | undefined): ToneName {
  const k = (key ?? "").trim();
  if (!k) return "slate";
  const known = STAGE_KEY_TONE[k];
  if (known) return known;
  return FALLBACK_TONES[hashKey(k) % FALLBACK_TONES.length]!;
}

/** Every class and value a surface needs to draw a stage in its colour. */
export function stageTone(key: string | null | undefined): StageTone {
  return TONES[stageToneName(key)];
}

/**
 * The rail's travelled stretch: a gradient through each passed stage's tone to
 * the current one. Steps are evenly spaced and the fill runs centre to centre,
 * so evenly spaced stops land exactly on the markers.
 */
export function stageGradient(keys: readonly (string | null | undefined)[]): string | null {
  if (keys.length === 0) return null;
  const colors = keys.map((k) => stageTone(k).color);
  if (colors.length === 1) return colors[0]!;
  return `linear-gradient(to right, ${colors.join(", ")})`;
}
