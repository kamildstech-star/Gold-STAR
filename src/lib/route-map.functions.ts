/**
 * Static Google images, fetched server-side and handed back as data URLs.
 *
 * The Google key is server-only, so the image is fetched server-side and
 * handed back as a data URL rather than exposing the key. That rule was
 * written for the route map and then not applied to the two images built in
 * the browser — the offline map `chase-prefetch.ts` caches at accept time and
 * the Street View photo on the chase jobs panel — both of which used the
 * public browser key, whose referrer list turned out to stop nothing (see the
 * header of `static-maps.server.ts`). Those two now live here as siblings of
 * the route map, and the browser key is no longer used for images at all.
 *
 * The URL building and the fetch are in `static-maps.server.ts`, reached by
 * `await import()` only: this file is imported by client components, so a
 * top-level import would carry the key read into the browser bundle.
 *
 * Every handler here is behind Supabase auth AND a per-user budget
 * (`RATE_LIMITS.mapImage`). Auth alone is a gate, not a budget — a session
 * token in a script bills Google exactly as well as a browser does. The
 * budget fails CLOSED: a refused image costs the user a picture, not data,
 * and the counter store being unreachable means the same database every
 * caller is about to read is unreachable too.
 */

import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { ImageResult } from "@/lib/static-maps.server";

type Point = { lat: number; lon: number };

/** Charge one image against the user's budget; the refusal is the same shape as any other miss. */
async function overBudget(bucket: string, userId: string): Promise<ImageResult | null> {
  const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
  const outcome = await consumeLimit(bucket, userId, RATE_LIMITS.mapImage, "closed");
  if (outcome.allowed) return null;
  return {
    dataUrl: null,
    error: `Too many map images requested. Please wait about ${Math.ceil(outcome.retryAfterSeconds / 60)} minute(s).`,
  };
}

const coordinate = (value: unknown, min: number, max: number): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;

export const routeMapImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { points: Point[]; width?: number; height?: number }) => {
    const points = (input?.points ?? [])
      .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
      .slice(0, 60);
    return {
      points,
      width: Math.min(Math.max(input?.width ?? 640, 200), 640),
      height: Math.min(Math.max(input?.height ?? 360, 200), 640),
    };
  })
  .handler(async ({ data, context }): Promise<ImageResult> => {
    if (!data.points.length) return { dataUrl: null, error: null };
    const refused = await overBudget("maps:route", context.userId);
    if (refused) return refused;
    const { routeMap } = await import("./static-maps.server");
    return routeMap(data.points, data.width, data.height);
  });

/**
 * The destination on a roadmap, for the offline bundle a chaser carries to
 * the doorstep. Called once per accepted incident from `chase-prefetch.ts`.
 */
export const staticMapImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { lat: number; lon: number }) => ({
    lat: coordinate(input?.lat, -90, 90),
    lon: coordinate(input?.lon, -180, 180),
  }))
  .handler(async ({ data, context }): Promise<ImageResult> => {
    if (data.lat == null || data.lon == null) {
      return { dataUrl: null, error: "No coordinates for this map." };
    }
    const refused = await overBudget("maps:static", context.userId);
    if (refused) return refused;
    const { destinationMap } = await import("./static-maps.server");
    return destinationMap(data.lat, data.lon);
  });

/** The property from the street, for the chase jobs panel. Cached per job by the caller. */
export const streetViewImage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { lat: number; lon: number }) => ({
    lat: coordinate(input?.lat, -90, 90),
    lon: coordinate(input?.lon, -180, 180),
  }))
  .handler(async ({ data, context }): Promise<ImageResult> => {
    if (data.lat == null || data.lon == null) {
      return { dataUrl: null, error: "No coordinates for this photo." };
    }
    const refused = await overBudget("maps:streetview", context.userId);
    if (refused) return refused;
    const { streetView } = await import("./static-maps.server");
    return streetView(data.lat, data.lon);
  });
