/**
 * Who reported an incident, for the chase card.
 *
 * A scanner or BNN alert is a dispatch: the address and the call sign are the
 * whole story. A fire-feed lead is a news story, a fire department's post or
 * a county 911 listing, and the chaser needs to read it before driving —
 * "Two-alarm fire displaces family on Pine Street", and the link. The fire
 * feed keeps every report of a fire in `incidents.source_links` (migration
 * 20261011140000), merging corroborating reports onto one incident; this
 * file turns that column into something a card can show, and refuses
 * anything in it that is not a web link.
 *
 * Pure and defensive: before that migration the column does not exist, and
 * a row from any source may carry nothing, so every input is `unknown`.
 */

export interface IncidentSourceLinkView {
  kind: string;
  /** Only ever an http(s) URL; null when the report had no usable link. */
  url: string | null;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
}

/** incidents.source → what the card calls it. Unknown sources show as stored. */
const SOURCE_LABEL: Record<string, string> = {
  google_news: "Google News",
  rss: "RSS feed",
  public_page: "911 incident page",
  bnn: "BNN",
  scanner: "Scanner",
  demo_scanner: "Scanner (demo)",
  exposure: "Exposure",
  fire_feed: "Fire feed",
};

export function incidentSourceLabel(source: string | null | undefined): string {
  if (!source) return "Unknown source";
  return SOURCE_LABEL[source] ?? source;
}

/** The fire feed's own sources — the ones whose story is worth showing. */
export function isFireFeedSource(source: string | null | undefined): boolean {
  return source === "google_news" || source === "rss" || source === "public_page";
}

function safeUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** Every report on the incident, oldest first, at most `limit`. */
export function incidentSourceLinks(
  incident: { source_links?: unknown } | null | undefined,
  limit = 10,
): IncidentSourceLinkView[] {
  const raw = incident?.source_links;
  if (!Array.isArray(raw)) return [];
  const out: IncidentSourceLinkView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title = text(e.title, 200);
    const url = safeUrl(e.url);
    if (!title && !url) continue;
    out.push({
      kind: text(e.kind, 40) ?? "report",
      url,
      title: title ?? url!,
      publisher: text(e.publisher, 80),
      publishedAt: text(e.published_at, 40),
    });
  }
  return out.slice(0, limit);
}

/** "Check before driving: Town only — …" when the lead was marked for review. */
export function incidentReviewNote(
  incident: { needs_review?: unknown; review_reason?: unknown } | null | undefined,
): string | null {
  if (!incident || incident.needs_review !== true) return null;
  return text(incident.review_reason, 200) ?? "Marked for review";
}
