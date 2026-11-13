import { useEffect, useState, type ReactNode } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import { EXTERNAL_LINK_REL, googleMapsSearchUrl, isFramed, type MapsQuery } from "@/lib/maps-links";

/**
 * "Open in Maps" as a plain link: Google's canonical search URL, a new
 * top-level tab, no opener and no referrer (src/lib/maps-links.ts).
 *
 * Inside a framed preview a new tab inherits the frame's sandbox and Google
 * refuses to load there (ERR_BLOCKED_BY_RESPONSE), so — only there — a small
 * "Copy link" sits beside it, to paste into a real tab.
 */
export function MapsLink({
  query,
  className,
  title,
  children,
}: {
  query: MapsQuery | null | undefined;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const href = googleMapsSearchUrl(query);
  // Read after mount: the server render has no window, and the first client
  // render has to match it.
  const [framed, setFramed] = useState(false);
  useEffect(() => setFramed(isFramed()), []);
  if (!href) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a
        className={className}
        href={href}
        target="_blank"
        rel={EXTERNAL_LINK_REL}
        title={title}
        data-maps-link=""
      >
        {children}
      </a>
      {framed ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          title="This preview cannot open Google Maps itself. Copy the link and paste it into a new browser tab."
          onClick={() => {
            if (!navigator.clipboard) {
              toast.error("Could not copy the link.");
              return;
            }
            navigator.clipboard
              .writeText(href)
              .then(() => toast.success("Maps link copied. Paste it into a new tab."))
              .catch(() => toast.error("Could not copy the link."));
          }}
        >
          <Copy className="size-3" /> Copy link
        </button>
      ) : null}
    </span>
  );
}
