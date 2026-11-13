import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * The browser Google Maps key, served to the client at runtime.
 *
 * The key is referrer-restricted and safe to expose to the browser, but it is
 * stored as a project secret (not a build-time VITE_ variable), so the client
 * asks for it here instead of reading it from the bundle.
 *
 * 2026-09-28, the external-access review: this used to run with NO session,
 * and it preferred `GOOGLE_API_KEY` — a generic name no other code reads, so
 * nothing guarantees it is the restricted browser key rather than an
 * unrestricted one — over `GOOGLE_MAPS_BROWSER_KEY`, and handed it to anyone
 * who asked. Every map is on a signed-in page (live map, chase cockpit, route
 * planner), so it now requires a session, and the explicitly-named browser key
 * wins. `GOOGLE_API_KEY` stays as a fallback only so a deployment that set it
 * keeps its maps; the PR's settings list asks for it to be referrer-restricted
 * or renamed.
 */
export const getGoogleMapsBrowserKey = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ key: string | null }> => {
    const key =
      process.env["GOOGLE_MAPS_BROWSER_KEY"] ?? process.env["GOOGLE_API_KEY"] ?? null;
    return { key: key?.trim() ? key.trim() : null };
  });
