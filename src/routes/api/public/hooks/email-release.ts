import { createFileRoute } from "@tanstack/react-router";

import { CRON_WEBHOOK, verifyWebhook } from "@/lib/webhook-verify";

/**
 * Releases held email whose undo window has run out.
 *
 * David, 24 Sep: "Sending in 4:32 — Edit · Cancel." sendEmail logs a person's
 * email as 'held'; pg_cron's email-release job (20260928122000) calls this
 * each minute that something is due. The claim is atomic — held → queued in
 * one statement — so a Cancel either landed first or is refused, and an email
 * is never handed over twice. Each claimed row then goes through the same
 * transport seam as an immediate send: sent through the sender's own Outlook
 * or Resend, or left 'queued' with the reason why (email-delivery.server.ts).
 *
 * Then the retry step (email-retry.server.ts): emails parked 'queued' earlier
 * — David's 11 Oct invoice is the one that started this — are claimed again
 * when due and go out as soon as their sender has a transport; anything 14
 * days old is left for a person to resend or cancel. Last, the admins are told
 * (once a day each) when sent email is piling up unsent. pg_cron's kick posts
 * here when a held email is due OR a parked one is (20261012100000).
 *
 * Auth: the `x-cron-secret` shared secret, fail closed — through the webhook
 * seam (src/lib/webhook-verify.ts), its first direct consumer.
 */
export const Route = createFileRoute("/api/public/hooks/email-release")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const verified = await verifyWebhook(request, CRON_WEBHOOK);
        if (!verified.ok) return verified.response;

        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "email-release", true);
        if (throttled) return throttled;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data, error } = await supabaseAdmin.rpc(
          "claim_due_held_emails" as never,
          {
            _limit: 50,
          } as never,
        );
        if (error) return Response.json({ error: error.message }, { status: 500 });

        const { deliverEmailMessage } = await import("@/lib/email-delivery.server");
        const rows = (data ?? []) as unknown as Parameters<typeof deliverEmailMessage>[1][];
        let sent = 0;
        let queued = 0;
        let failed = 0;
        let cancelled = 0;
        for (const row of rows) {
          try {
            const outcome = await deliverEmailMessage(supabaseAdmin, row);
            if (outcome.cancelled) cancelled += 1;
            else if (outcome.queued) queued += 1;
            else sent += 1;
          } catch {
            // deliverEmailMessage has already written 'failed' and the reason
            // on the row, where the sender sees it; one bad address must not
            // hold up the rest of the batch.
            failed += 1;
          }
        }

        // Each step reports rather than throws: a broken retry must not hide
        // that the held emails above went out, and vice versa.
        const { retryQueuedEmails, notifyUnsentEmailPileUp } =
          await import("@/lib/email-retry.server");
        let retry: Record<string, unknown>;
        try {
          retry = { ...(await retryQueuedEmails(supabaseAdmin)) };
        } catch (e) {
          retry = { error: e instanceof Error ? e.message : String(e) };
        }
        const notice = await notifyUnsentEmailPileUp(supabaseAdmin);

        return Response.json({
          ok: true,
          claimed: rows.length,
          sent,
          queued,
          failed,
          cancelled,
          retry,
          unsent: notice,
        });
      },
    },
  },
});
