import { ExternalLink, Info } from "lucide-react";

import {
  incidentReviewNote,
  incidentSourceLabel,
  incidentSourceLinks,
  isFireFeedSource,
} from "@/lib/incident-sources";

/**
 * "Reported by" on a chase card: the headline and link of every report the
 * fire feed merged onto this fire, and the reason a lead was marked for
 * review (a town with no street, a block-level address). Renders nothing for
 * a scanner or BNN alert with no reports attached, so those cards look
 * exactly as they did.
 */
export function IncidentSources({
  incident,
  compact = false,
}: {
  incident: {
    source?: string | null;
    source_links?: unknown;
    needs_review?: unknown;
    review_reason?: unknown;
  };
  compact?: boolean;
}) {
  const links = incidentSourceLinks(incident, compact ? 2 : 6);
  const review = incidentReviewNote(incident);
  if (links.length === 0 && !review) return null;
  const total = incidentSourceLinks(incident, 100).length;

  return (
    <div className="mt-2 space-y-1 text-xs">
      {review && (
        <div className="flex items-start gap-1 rounded-sm bg-warning/10 px-2 py-1 text-warning">
          <Info className="mt-0.5 size-3 shrink-0" />
          <span>Check before driving: {review}</span>
        </div>
      )}
      {links.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {isFireFeedSource(incident.source)
              ? `Fire feed · ${incidentSourceLabel(incident.source)}`
              : "Reported by"}
            {total > 1 ? ` · ${total} reports` : ""}
          </div>
          <ul className="space-y-0.5">
            {links.map((l, i) => (
              <li key={`${l.url ?? l.title}-${i}`} className="truncate">
                {l.url ? (
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {l.title}
                    <ExternalLink className="ml-1 inline size-3" />
                  </a>
                ) : (
                  l.title
                )}
                {l.publisher ? (
                  <span className="text-muted-foreground"> · {l.publisher}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
