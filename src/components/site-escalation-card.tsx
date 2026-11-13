import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Building2, Mail, Phone } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useManagedOptions } from "@/lib/managed-options";
import {
  CONTACT_POSITION_OPTIONS,
  resolveSiteEscalation,
  type HierarchyContact,
} from "@/lib/company-hierarchy";
import { RecordLoadError } from "@/components/record-load-error";
import { Badge } from "@/components/ui/badge";

/**
 * The 2am card.
 *
 * A pipe has burst at 12 Maple Avenue. The job knows its address and its
 * customer account; this turns those two facts into a phone number for the
 * person who runs that building, and then the person above them for when the
 * super does not pick up.
 *
 * It renders nothing at all when the job's address is not a building anyone has
 * mapped — silence is right there, an empty box implying "nobody manages this"
 * is not. What it never does is render empty because a read failed.
 */
export function SiteEscalationCard({ jobId }: { jobId: string }) {
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);

  const jobQ = useQuery({
    queryKey: ["job-site-key", jobId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("id, address, account_id")
        .eq("id", jobId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const siteQ = useQuery({
    queryKey: ["job-site-escalation", jobId, jobQ.data?.account_id, jobQ.data?.address],
    queryFn: () =>
      resolveSiteEscalation({
        accountId: jobQ.data?.account_id ?? null,
        address: jobQ.data?.address ?? null,
      }),
    enabled: jobQ.isSuccess && !!jobQ.data?.account_id,
  });

  if (siteQ.isError) {
    return (
      <div className="rounded-lg border">
        <RecordLoadError
          error={siteQ.error}
          record="site contacts"
          table="account_properties"
          id={jobId}
          onRetry={() => void siteQ.refetch()}
          compact
        />
      </div>
    );
  }

  const site = siteQ.data;
  if (!site || !site.available) return null;
  if (!site.property && site.billing.length === 0) return null;

  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-start gap-2">
        <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">
            {site.property ? (site.property.name ?? site.property.address) : "Company contacts"}
          </p>
          {site.property && (
            <p className="break-words text-[11px] text-muted-foreground">{site.property.address}</p>
          )}
        </div>
      </div>

      {site.property && (
        <Group
          label="Runs this building"
          people={site.onSite.map((s) => ({
            contact: s.contact,
            positionKey: s.positionKey,
            inherited: s.inherited,
          }))}
          positionLabel={positions.label}
          empty="Nobody assigned to this building yet."
        />
      )}

      {site.escalation.length > 0 && (
        <Group
          label="If they don't answer"
          people={site.escalation.map((c) => ({ contact: c, positionKey: c.position_key }))}
          positionLabel={positions.label}
        />
      )}

      {/*
        Which desk this is matters. Some companies run one accounts-payable
        contact for everything; some bill each building separately. Saying
        which one is on screen stops an invoice question going to head office
        when this building answers its own.
      */}
      {site.billing.length > 0 && (
        <Group
          label={
            site.billingLevel === "asset"
              ? "Billing — this building"
              : "Billing — company accounts payable"
          }
          people={site.billing.map((c) => ({ contact: c, positionKey: c.position_key }))}
          positionLabel={positions.label}
        />
      )}
    </div>
  );
}

function Group({
  label,
  people,
  positionLabel,
  empty,
}: {
  label: string;
  people: { contact: HierarchyContact; positionKey: string | null; inherited?: boolean }[];
  positionLabel: (key: string | null | undefined) => string;
  empty?: string;
}) {
  return (
    <div className="mt-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {people.length === 0 ? (
        empty ? (
          <p className="mt-1 text-[12px] text-muted-foreground">{empty}</p>
        ) : null
      ) : (
        <ul className="mt-1 space-y-1.5">
          {people.map(({ contact, positionKey, inherited }) => (
            <li key={contact.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                to="/contacts"
                search={{ sel: contact.id }}
                className="text-[13px] font-medium text-link hover:underline"
              >
                {contact.full_name}
              </Link>
              {positionKey && (
                <Badge variant="outline" className="text-[11px]">
                  {positionLabel(positionKey)}
                </Badge>
              )}
              {/* Nobody put this person against this building; they report to
                  whoever runs it. Worth calling, worth knowing that. */}
              {inherited && (
                <Badge variant="outline" className="text-[11px] text-muted-foreground">
                  Through their manager
                </Badge>
              )}
              {contact.phone && (
                // A tel: link, big enough to hit with a wet thumb.
                <a
                  href={`tel:${contact.phone}`}
                  className="flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] text-link"
                >
                  <Phone className="size-3" />
                  {contact.phone}
                </a>
              )}
              {contact.email && (
                <a
                  href={`mailto:${contact.email}`}
                  className="flex min-w-0 items-center gap-1 text-[12px] text-link underline underline-offset-2"
                >
                  <Mail className="size-3 shrink-0" />
                  <span className="truncate">{contact.email}</span>
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
