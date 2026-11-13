/**
 * Public, opaque Google-review redirect.
 *
 * The table and increment function are closed to anon. This server endpoint is
 * the only public surface, and returns no CRM data. Counts include scanners and
 * link preview bots, so the app deliberately calls them opens rather than
 * human reads or completed reviews.
 */
import { createFileRoute } from "@tanstack/react-router";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const fail = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });

export const Route = createFileRoute("/api/review/$token")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!UUID.test(params.token)) return fail(404, "This review link is not valid.");

        const { guardByIp } = await import("@/lib/rate-limit.server");
        const throttled = await guardByIp(
          request,
          "google-review:open",
          { limit: 120, windowSeconds: 300 },
          "open",
        );
        if (throttled) return throttled;

        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: destination, error } = await supabaseAdmin.rpc(
            "record_google_review_click",
            { _token: params.token },
          );
          if (error) throw error;
          if (!destination) return fail(410, "This review link is no longer active.");
          return Response.redirect(destination, 302);
        } catch (error) {
          console.error("[google-review] redirect failed", error);
          return fail(502, "This review link could not be opened. Please try again.");
        }
      },
    },
  },
});
