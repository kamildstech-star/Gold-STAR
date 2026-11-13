import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Mail, Phone, Search, Smartphone } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { LoadError, PageHeader, WarningLine } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  canSeeMobiles,
  fetchDirectory,
  searchText,
  telHref,
  type DirectoryPerson,
} from "@/lib/directory";
import { isPrivileged, primaryRole, ROLE_LABELS } from "@/lib/roles";

/** Sort key for the "no office" bucket — it always trails the real offices. */
const NO_OFFICE = "none";

export const Route = createFileRoute("/_authenticated/directory/")({
  head: () => ({
    meta: [
      { title: "Staff directory · Recovery Hub" },
      {
        name: "description",
        content:
          "Every employee with their work phone, extension, email and office — click to call or email.",
      },
      { name: "robots", content: "noindex" },
      { property: "og:title", content: "Staff directory · Recovery Hub" },
      {
        property: "og:description",
        content: "Reach anyone in the company in one click.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DirectoryPage,
});

function DirectoryPage() {
  const app = useAppContext();
  const [q, setQ] = useState("");
  const [officeFilter, setOfficeFilter] = useState<string>("all");
  const [includeInactive, setIncludeInactive] = useState(false);

  const dirQ = useQuery({
    queryKey: ["staff-directory"],
    queryFn: fetchDirectory,
  });

  const showRoles = isPrivileged(app.roles);
  const showMobiles = canSeeMobiles(app.roles);

  const officeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of app.allLocations) m.set(l.id, `${l.code} · ${l.name}`);
    return m;
  }, [app.allLocations]);

  const result = dirQ.data;
  // Stable identity: a fresh [] each render would re-run every memo below.
  const people = useMemo(() => (result?.status === "ready" ? result.people : []), [result]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return people.filter((p) => {
      if (!includeInactive && !p.is_active) return false;
      if (officeFilter === NO_OFFICE && p.location_ids.length > 0) return false;
      if (officeFilter !== "all" && officeFilter !== NO_OFFICE) {
        if (!p.location_ids.includes(officeFilter)) return false;
      }
      if (!needle) return true;
      const offices = p.location_ids.map((id) => officeName.get(id) ?? "");
      const roleLabels = p.roles.map((r) => ROLE_LABELS[r] ?? r);
      return searchText(p, offices, roleLabels).includes(needle);
    });
  }, [people, q, officeFilter, includeInactive, officeName]);

  // Grouped by office so the page reads as a directory rather than a list.
  // Someone in two offices belongs under both — that is the truth of the roster.
  const groups = useMemo(() => {
    const byOffice = new Map<string, DirectoryPerson[]>();
    for (const p of filtered) {
      const keys = p.location_ids.length > 0 ? p.location_ids : [NO_OFFICE];
      for (const key of keys) {
        const list = byOffice.get(key) ?? [];
        list.push(p);
        byOffice.set(key, list);
      }
    }
    const order = app.allLocations.map((l) => l.id);
    return [...byOffice.entries()].sort(([a], [b]) => {
      if (a === NO_OFFICE) return 1;
      if (b === NO_OFFICE) return -1;
      return order.indexOf(a) - order.indexOf(b);
    });
  }, [filtered, app.allLocations]);

  // A rep sees no mobile column at all — unless it's their own number on file,
  // in which case an empty column would look like the app had lost it.
  const showMobileColumn =
    showMobiles || people.some((p) => p.user_id === app.userId && p.mobile_phone);

  return (
    <div className="space-y-3 px-3 py-4 sm:px-4">
      <PageHeader
        title="Staff directory"
        subtitle={
          dirQ.isLoading
            ? "Loading…"
            : dirQ.error || result?.status === "needs-migration"
              ? "Directory unavailable"
              : `${filtered.length} of ${people.length} people`
        }
      />

      {dirQ.error ? (
        <LoadError
          what="the staff directory"
          error={dirQ.error}
          onRetry={() => void dirQ.refetch()}
        />
      ) : null}

      {result?.status === "needs-migration" ? (
        <div
          role="alert"
          className="border-l-2 border-destructive bg-destructive/5 px-3 py-2 text-[13px]"
        >
          The staff directory needs a database update before it can run — the migration that adds
          work phone, extension, mobile and job title to <code>profiles</code> hasn't been applied
          yet (missing: <code>{result.missing}</code>). Nobody is missing from the company; the
          columns are missing from the database.
        </div>
      ) : null}

      {result?.status === "ready" && result.emailsHidden ? (
        <WarningLine>
          Work emails are hidden: <code>profiles.email</code> isn't readable by signed-in users.
          Phone, extension and office are unaffected — an admin can grant the column to show emails
          here.
        </WarningLine>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full min-w-0 sm:min-w-64 sm:flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-3.5 size-4 text-muted-foreground sm:top-2.5" />
          {/* 16px text below sm — iOS zooms into a smaller field and never
              zooms back, which strands the rest of the directory off-screen. */}
          <Input
            className="h-11 pl-8 text-base sm:h-8 sm:text-[13px]"
            placeholder="Search name, office, role or extension…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={officeFilter} onValueChange={setOfficeFilter}>
          <SelectTrigger className="h-11 w-full text-base sm:h-8 sm:w-56 sm:text-[13px]">
            <SelectValue placeholder="Any office" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any office</SelectItem>
            {app.allLocations.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.code} · {l.name}
              </SelectItem>
            ))}
            <SelectItem value={NO_OFFICE}>No office listed</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex min-h-11 items-center gap-2">
          <Switch
            id="directory-inactive"
            checked={includeInactive}
            onCheckedChange={setIncludeInactive}
          />
          <Label htmlFor="directory-inactive" className="text-[13px] text-muted-foreground">
            Include deactivated
          </Label>
        </div>
      </div>

      {result?.status === "ready" && groups.length === 0 ? (
        <Card>
          <CardContent className="px-3 py-2.5 text-[13px] text-muted-foreground">
            Nobody matches the current filters.
          </CardContent>
        </Card>
      ) : null}

      {groups.map(([officeId, members]) => (
        <Card key={officeId}>
          <CardContent className="p-0">
            <div className="border-b bg-muted/40 px-3 py-2 text-xs font-medium uppercase text-muted-foreground">
              {officeId === NO_OFFICE
                ? "No office listed"
                : (officeName.get(officeId) ?? "Unknown office")}
              <span className="ml-2 normal-case">({members.length})</span>
            </div>
            {/* Phone: one row per person with call/text/email as real targets.
                A six-column table behind a sideways scroll is the wrong shape
                for the one screen this page is most used on. */}
            <ul className="divide-y md:hidden">
              {members.map((p) => (
                <PersonCard
                  key={`m:${officeId}:${p.user_id}`}
                  person={p}
                  isSelf={p.user_id === app.userId}
                  showRole={showRoles}
                  showMobile={showMobiles}
                />
              ))}
            </ul>

            <div className="hidden overflow-x-auto md:max-h-[75svh] md:overflow-auto md:block">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Name</th>
                    {showRoles && <th className="px-3 py-2 font-medium">Role</th>}
                    <th className="px-3 py-2 font-medium">Work phone</th>
                    <th className="px-3 py-2 font-medium">Ext</th>
                    {showMobileColumn && <th className="px-3 py-2 font-medium">Mobile</th>}
                    <th className="px-3 py-2 font-medium">Email</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((p) => (
                    <PersonRow
                      key={`${officeId}:${p.user_id}`}
                      person={p}
                      isSelf={p.user_id === app.userId}
                      showRole={showRoles}
                      showMobile={showMobiles}
                      mobileColumn={showMobileColumn}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      ))}

      {dirQ.isLoading ? (
        <p className="px-3 py-2.5 text-[13px] text-muted-foreground">Loading…</p>
      ) : null}

      {result?.status === "ready" && !isPrivileged(app.roles) ? (
        <p className="px-3 text-[12px] text-muted-foreground">
          Office assignments are shown for the offices you belong to; colleagues elsewhere in the
          company appear without one.
        </p>
      ) : null}
    </div>
  );
}

function PersonRow({
  person,
  isSelf,
  showRole,
  showMobile,
  mobileColumn,
}: {
  person: DirectoryPerson;
  isSelf: boolean;
  showRole: boolean;
  /** Whether this viewer may read other people's mobiles. */
  showMobile: boolean;
  /** Whether the table has a mobile column at all. */
  mobileColumn: boolean;
}) {
  const work = telHref(person.work_phone, person.extension);
  // Your own mobile is always yours to see, whatever role you hold.
  const mobile = showMobile || isSelf ? telHref(person.mobile_phone) : null;
  const role = primaryRole(person.roles);

  return (
    <tr className="border-t">
      <td className="px-3 py-2">
        <div className="font-medium">
          {person.full_name || <span className="text-muted-foreground">Unnamed</span>}
          {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
          {!person.is_active && (
            <Badge variant="outline" className="ml-2 text-[10px]">
              Deactivated
            </Badge>
          )}
        </div>
        {person.job_title && (
          <div className="text-xs text-muted-foreground">{person.job_title}</div>
        )}
      </td>
      {showRole && (
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {role ? ROLE_LABELS[role] : "—"}
        </td>
      )}
      <td className="px-3 py-2">
        {work ? (
          <a className="inline-flex items-center gap-1.5 text-primary hover:underline" href={work}>
            <Phone className="size-3.5" />
            {person.work_phone}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {person.extension || <span className="font-sans text-muted-foreground">—</span>}
      </td>
      {mobileColumn && (
        <td className="px-3 py-2">
          {mobile ? (
            <a
              className="inline-flex items-center gap-1.5 text-primary hover:underline"
              href={mobile}
            >
              <Smartphone className="size-3.5" />
              {person.mobile_phone}
            </a>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </td>
      )}
      <td className="px-3 py-2">
        {person.email ? (
          <a
            className="inline-flex items-center gap-1.5 text-primary hover:underline"
            href={`mailto:${person.email}`}
          >
            <Mail className="size-3.5" />
            <span className="font-mono text-xs">{person.email}</span>
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

/**
 * Phone-shaped entry: identity on the left, and the three ways to reach the
 * person as 44px targets on the right. Calling is the whole point of this
 * page, so the tel: link is a button, never a line of small text.
 */
function PersonCard({
  person,
  isSelf,
  showRole,
  showMobile,
}: {
  person: DirectoryPerson;
  isSelf: boolean;
  showRole: boolean;
  showMobile: boolean;
}) {
  const work = telHref(person.work_phone, person.extension);
  const mobile = showMobile || isSelf ? telHref(person.mobile_phone) : null;
  const role = primaryRole(person.roles);

  return (
    <li className="flex items-start gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 text-[14px] font-medium">
          <span className="min-w-0 break-words">
            {person.full_name || <span className="text-muted-foreground">Unnamed</span>}
          </span>
          {isSelf && <span className="text-xs text-muted-foreground">(you)</span>}
          {!person.is_active && (
            <Badge variant="outline" className="text-[10px]">
              Deactivated
            </Badge>
          )}
        </div>
        {(person.job_title || (showRole && role)) && (
          <div className="text-[12px] text-muted-foreground">
            {person.job_title || (role ? ROLE_LABELS[role] : "")}
          </div>
        )}
        <div className="mt-0.5 text-[12px] text-muted-foreground">
          {person.work_phone ? (
            <span className="font-mono">{person.work_phone}</span>
          ) : (
            "No work phone"
          )}
          {person.extension ? <span className="font-mono"> ext {person.extension}</span> : null}
        </div>
        {mobile && person.mobile_phone && (
          <div className="text-[12px] text-muted-foreground">
            Mobile <span className="font-mono">{person.mobile_phone}</span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {work && (
          <a
            href={work}
            aria-label={`Call ${person.full_name || "this person"} at work`}
            className="flex size-11 items-center justify-center rounded-md border text-primary active:bg-hover"
          >
            <Phone className="size-4" />
          </a>
        )}
        {mobile && (
          <a
            href={mobile}
            aria-label={`Call ${person.full_name || "this person"} on mobile`}
            className="flex size-11 items-center justify-center rounded-md border text-primary active:bg-hover"
          >
            <Smartphone className="size-4" />
          </a>
        )}
        {person.email && (
          <a
            href={`mailto:${person.email}`}
            aria-label={`Email ${person.full_name || "this person"}`}
            className="flex size-11 items-center justify-center rounded-md border text-primary active:bg-hover"
          >
            <Mail className="size-4" />
          </a>
        )}
      </div>
    </li>
  );
}
