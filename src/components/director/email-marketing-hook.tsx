import { Mail } from "lucide-react";

/**
 * Placeholder only. Nothing is wired to a provider yet, and no AI-written or
 * automated outbound is sent from this app — that rule stands.
 */
export function EmailMarketingHook() {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center gap-2">
        <Mail className="size-4 text-muted-foreground" />
        <h3 className="text-[14px] font-bold">Email marketing — not connected</h3>
      </div>
      <p className="mt-2 text-[13px] text-muted-foreground">
        Hook left in place for a bulk-send provider. Recommendation, given Outlook is already the
        mail platform: keep one-to-one rep mail in Outlook and put campaigns on a provider that
        authenticates as your own domain and writes results back — Mailchimp or Brevo if marketing
        runs it themselves, Customer.io if the trigger logic should live with the CRM. Whichever is
        chosen, add its domain to the same SPF/DKIM/DMARC records as Outlook so reputation is not
        split, and sync sends and replies back onto the account timeline so cadence stays honest.
      </p>
      <p className="mt-2 text-[12px] text-muted-foreground">
        Campaign sends stay marketing-owned. Rep outbound remains human-written, one to one.
      </p>
    </div>
  );
}
