import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Building2, Mail, Phone } from "lucide-react";

import { BackLink } from "@/components/back-link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LoadError, PageHeader } from "@/components/ui-density";
import { supabase } from "@/integrations/supabase/client";
import {
  CONTACT_POSITION_OPTIONS,
  fetchPropertyAssignments,
  fetchPropertiesByIds,
  type AccountProperty,
} from "@/lib/company-hierarchy";
import { fmtDate } from "@/lib/jobs";
import { useManagedOptions } from "@/lib/managed-options";
import { addressKey, fetchPropertyNote } from "@/lib/standing-notes";

export const Route = createFileRoute("/_authenticated/buildings/$id")({
  head: () => ({
    meta: [{ title: "Building · Recovery Hub" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  component: BuildingDetail,
});

type Person = {
  id: string;
  full_name: string;
  title: string | null;
  position_key: string | null;
  email: string | null;
  phone: string | null;
};

type BuildingJob = {
  id: string;
  job_number: string | null;
  address: string | null;
  status: string | null;
  created_at: string;
};

/**
 * One building a client manages (5 Nov: "on click that building, go to its
 * detail page"): where it is, whose it is, who covers it there and in what
 * role, its standing property note, and every job Gold Star has had at the
 * address. Reached from a person's building count on the company chart and
 * on a job's Contacts tab.
 */
function BuildingDetail() {
  const { id } = Route.useParams();
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);

  const q = useQuery({
    queryKey: ["building", id],
    queryFn: async () => {
      const [property] = await fetchPropertiesByIds([id]);
      if (!property) return null;
      const [account, assigned, jobs, note] = await Promise.all([
        supabase.from("accounts").select("id, name").eq("id", property.account_id).maybeSingle(),
        fetchPropertyAssignments([property.id]),
        supabase
          .from("jobs")
          .select("id, job_number, address, status, created_at")
          .eq("account_id", property.account_id)
          .order("created_at", { ascending: false })
          .limit(500),
        fetchPropertyNote(property.address).catch(() => null),
      ]);
      if (account.error) throw account.error;
      if (jobs.error) throw jobs.error;
      const ids = [...new Set(assigned.rows.map((a) => a.contact_id))];
      const people = ids.length
        ? await supabase
            .from("contacts")
            .select("id, full_name, title, position_key, email, phone")
            .in("id", ids)
        : { data: [], error: null };
      if (people.error) throw people.error;
      const byId = new Map(((people.data ?? []) as Person[]).map((p) => [p.id, p]));
      const covers = [...assigned.rows]
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((a) => ({ person: byId.get(a.contact_id), positionKey: a.position_key }))
        .filter((c): c is { person: Person; positionKey: string | null } => !!c.person);
      // A job is at this building when its address folds to the same key.
      const here = ((jobs.data ?? []) as BuildingJob[]).filter(
        (j) => addressKey(j.address) === property.address_key,
      );
      return {
        property: property as AccountProperty,
        account: account.data as { id: string; name: string } | null,
        covers,
        jobs: here,
        note,
      };
    },
  });

  const back = (
    <BackLink
      fallbackTo="/accounts"
      label="Back"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
    >
      <ArrowLeft className="size-4" /> Back
    </BackLink>
  );

  if (q.isError) {
    return (
      <div className="space-y-3 px-3 py-4 sm:px-4">
        {back}
        <LoadError what="this building" error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }
  if (q.isPending) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (!q.data) {
    return (
      <div className="space-y-3 px-3 py-4 sm:px-4">
        {back}
        <p className="text-sm text-muted-foreground">
          This building is not on file, or you cannot see it.
        </p>
      </div>
    );
  }

  const { property, account, covers, jobs, note } = q.data;
  const label = (k: string | null) => (k ? positions.label(k) : null);

  return (
    <div className="space-y-3 px-3 py-4 sm:px-4">
      {back}
      <PageHeader
        title={property.name || property.address}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {property.name ? <span>{property.address}</span> : null}
            {account ? (
              <Link
                to="/accounts/$id"
                params={{ id: account.id }}
                className="text-link underline-offset-2 hover:underline"
              >
                {account.name}
              </Link>
            ) : null}
            {!property.active && <Badge variant="outline">Inactive</Badge>}
          </span>
        }
      />

      {note?.note || property.notes ? (
        <Card>
          <CardContent className="space-y-1 p-4 text-sm">
            {note?.note ? (
              <p>
                <span className="font-semibold">Property note — </span>
                {note.note}
              </p>
            ) : null}
            {property.notes ? <p className="text-muted-foreground">{property.notes}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="size-4 text-muted-foreground" aria-hidden /> Who covers it
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {covers.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">
                Nobody is assigned to this building yet.
              </p>
            ) : (
              <ul className="divide-y">
                {covers.map(({ person, positionKey }) => {
                  const role = label(positionKey ?? person.position_key);
                  return (
                    <li key={person.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium">
                          {person.full_name}
                          {role && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              {role}
                            </span>
                          )}
                        </div>
                        {person.title ? (
                          <div className="text-xs text-muted-foreground">{person.title}</div>
                        ) : null}
                      </div>
                      {person.phone ? (
                        <a
                          href={`tel:${person.phone}`}
                          className="flex size-9 items-center justify-center rounded-md text-link hover:bg-hover"
                          aria-label={`Call ${person.full_name}`}
                          title={person.phone}
                        >
                          <Phone className="size-4" />
                        </a>
                      ) : null}
                      {person.email ? (
                        <a
                          href={`mailto:${person.email}`}
                          className="flex size-9 items-center justify-center rounded-md text-link hover:bg-hover"
                          aria-label={`Email ${person.full_name}`}
                          title={person.email}
                        >
                          <Mail className="size-4" />
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              Jobs here <span className="font-normal text-muted-foreground">({jobs.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {jobs.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-muted-foreground">
                No jobs at this address yet.
              </p>
            ) : (
              <ul className="divide-y">
                {jobs.map((j) => (
                  <li key={j.id}>
                    <Link
                      to="/jobs/$id"
                      params={{ id: j.id }}
                      className="flex items-center justify-between gap-2 px-4 py-2.5 text-[13px] hover:bg-hover"
                    >
                      <span className="min-w-0 truncate">
                        <span className="font-mono font-medium">{j.job_number ?? "Job"}</span>
                        {j.address ? (
                          <span className="text-muted-foreground"> · {j.address}</span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {fmtDate(j.created_at)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
