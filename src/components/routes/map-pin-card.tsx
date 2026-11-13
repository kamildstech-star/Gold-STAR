import { Link } from "@tanstack/react-router";
import {
  Building,
  Building2,
  Check,
  Footprints,
  Hammer,
  Handshake,
  Navigation,
  Plus,
  UserRound,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { PinDetails, PinDetailRow, PinKind, PinTarget } from "@/lib/map-pin-details";
import { buildMapsRouteUrl } from "@/lib/visits";

/**
 * The card that opens above a Field map pin. Shaped after the Pipedrive map
 * Mark sent: a contact line that links to the record, a few labelled lines,
 * the street address, and the actions underneath. It lives inside Google's
 * InfoWindow (see `LiveMapCallout`), which supplies the white box, the tail
 * and the × — this component is only the content.
 *
 * Compact on purpose: it is read on a phone in a car. Every line is one
 * line; the notes on a past visit are the only thing allowed to wrap.
 */

/** The same glyph the pin wears, so the card and the dot match. */
export const PIN_KIND_ICON: Record<PinKind, typeof Handshake> = {
  deal: Handshake,
  client: Building2,
  job: Hammer,
  visit: Footprints,
  office: Building,
};

function Initials({ name }: { name: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "—";
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground"
    >
      {initials}
    </span>
  );
}

function RecordLink({
  target,
  className,
  children,
}: {
  target: PinTarget;
  className?: string;
  children: React.ReactNode;
}) {
  return target.kind === "job" ? (
    <Link to="/jobs/$id" params={{ id: target.id }} className={className}>
      {children}
    </Link>
  ) : (
    <Link to="/accounts/$id" params={{ id: target.id }} className={className}>
      {children}
    </Link>
  );
}

function Row({ row }: { row: PinDetailRow }) {
  const value = row.pill ? (
    <span className={cn("rounded px-1.5 py-px text-[11px] font-semibold", row.pill)}>
      {row.value}
    </span>
  ) : row.href ? (
    <a href={row.href} className="truncate text-primary underline underline-offset-2">
      {row.value}
    </a>
  ) : row.to ? (
    <RecordLink target={row.to} className="truncate text-primary underline underline-offset-2">
      {row.value}
    </RecordLink>
  ) : (
    <span
      className={cn(
        row.label === "Notes" ? "whitespace-pre-wrap" : "truncate",
        row.tone === "warning" && "font-semibold text-warning",
      )}
    >
      {row.value}
    </span>
  );
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-5">
      <span className="shrink-0 text-muted-foreground">{row.label}:</span>
      {row.dot !== undefined && (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ background: row.dot ?? "var(--muted-foreground)" }}
        />
      )}
      {row.avatar && <Initials name={row.value} />}
      {value}
    </div>
  );
}

export function MapPinCard({
  details,
  onRoute,
  picked,
}: {
  details: PinDetails;
  /** Toggles the stop on the route; the button is hidden when there is none. */
  onRoute?: (stopId: string) => void;
  /** Is this stop already on the route? */
  picked?: boolean;
}) {
  const Icon = PIN_KIND_ICON[details.kind];
  const directions = details.directionsTo ? buildMapsRouteUrl([details.directionsTo]) : null;
  return (
    <div className="w-[260px] max-w-[calc(100vw-56px)] space-y-1 pr-1 text-foreground">
      <div className="flex items-start gap-1.5 pr-4">
        <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">
          <span className="block text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
            {details.kindLabel}
          </span>
          {details.target ? (
            <RecordLink
              target={details.target}
              className="block text-[13px] font-semibold leading-tight text-primary underline underline-offset-2"
            >
              {details.title}
            </RecordLink>
          ) : (
            <span className="block text-[13px] font-semibold leading-tight">{details.title}</span>
          )}
        </span>
      </div>
      {details.rows.map((row) => (
        <Row key={row.label} row={row} />
      ))}
      {details.address && (
        <p className="text-[12px] leading-5 text-muted-foreground">{details.address}</p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        {details.stopId && onRoute && (
          <button
            type="button"
            onClick={() => onRoute(details.stopId!)}
            className={cn(
              "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium",
              picked ? "border-primary/40 text-primary hover:bg-primary/5" : "hover:bg-muted",
            )}
          >
            {picked ? (
              <>
                <Check className="size-3" /> On route
              </>
            ) : (
              <>
                <Plus className="size-3" /> Add to route
              </>
            )}
          </button>
        )}
        {details.target && (
          <RecordLink
            target={details.target}
            className="rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
          >
            Open
          </RecordLink>
        )}
        {directions && (
          <a
            href={directions}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
          >
            <Navigation className="size-3" /> Directions
          </a>
        )}
      </div>
      {details.kind === "office" && (
        <p className="text-[11px] text-muted-foreground">An office is not a route stop.</p>
      )}
    </div>
  );
}

/**
 * A cluster that zooming cannot break up — several accounts at one address.
 * Listed, each with its own add, so the pin is not a dead end.
 */
export type MapClusterItem = {
  id: string;
  name: string;
  kind: PinKind;
  sub: string | null;
  /** The stop the Add button toggles; a job has none and gets Open instead. */
  stopId: string | null;
  target: PinTarget;
};

export function MapClusterCard({
  items,
  picked,
  onRoute,
}: {
  items: MapClusterItem[];
  picked: string[];
  onRoute: (stopId: string) => void;
}) {
  return (
    <div className="w-[260px] max-w-[calc(100vw-56px)] text-foreground">
      <div className="flex items-center gap-1.5 pr-4 text-[12px] font-semibold">
        <UserRound className="size-3.5 text-muted-foreground" aria-hidden />
        {items.length} at this spot
      </div>
      <ul className="mt-1 max-h-[200px] divide-y overflow-y-auto">
        {items.map((it) => {
          const Icon = PIN_KIND_ICON[it.kind];
          const idx = it.stopId ? picked.indexOf(it.stopId) : -1;
          const on = idx >= 0;
          return (
            <li key={it.id} className="flex items-center gap-1.5 py-1 text-[12px]">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <RecordLink
                  target={it.target}
                  className="block truncate font-medium text-primary underline underline-offset-2"
                >
                  {it.name}
                </RecordLink>
                {it.sub && (
                  <span className="block truncate text-[11px] text-muted-foreground">{it.sub}</span>
                )}
              </span>
              {it.stopId ? (
                <button
                  type="button"
                  onClick={() => onRoute(it.stopId!)}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
                    on ? "border-primary/40 text-primary hover:bg-primary/5" : "hover:bg-muted",
                  )}
                >
                  {on ? (
                    <>
                      <Check className="size-3" /> {idx + 1}
                    </>
                  ) : (
                    <>
                      <Plus className="size-3" /> Add
                    </>
                  )}
                </button>
              ) : (
                <RecordLink
                  target={it.target}
                  className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-medium hover:bg-muted"
                >
                  Open
                </RecordLink>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
