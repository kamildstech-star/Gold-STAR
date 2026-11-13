import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Lock, Search } from "lucide-react";
import { toast } from "sonner";

import { AccessGroup } from "@/components/access/access-group";
import { AccessHistory } from "@/components/access/access-history";
import { useGroupState } from "@/components/access/use-group-state";
import { AccessRow, SourceBadge } from "@/components/access/access-row";
import { ExpandCollapse, Notice } from "@/components/access/access-role-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";
import { ACCESS_HISTORY_KEY } from "@/lib/page-access-admin";
import {
  BREAK_GLASS_REASON,
  PAGES,
  PAGE_AREAS,
  isBreakGlass,
  pagePermissionKey,
  resolveAllPages,
  storedPageStates,
  type PageAccess,
} from "@/lib/page-access";
import {
  clearPermissionOverride,
  fetchEffectivePermissions,
  grantPermission,
} from "@/lib/permissions";

type Person = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  roles: string[];
  is_active: boolean;
};

/**
 * "Pick one person and see the same for them, including any individual grant
 * or revocation and where it came from."
 *
 * Same layout as the role view so an admin only learns one screen. The
 * difference is the badge on every line: from role, granted, revoked, or the
 * built-in default — the question the old matrix could not answer at all.
 *
 * Every line is the three-way Role/Allow/Block control, on every page and for
 * every person: an Owner or Admin can be blocked from a page here, and the
 * three essential pages can be blocked too.
 *
 * The exception is somebody holding the recovery role. Their access is granted
 * and locked, on every line, because a personal Block on a break-glass account
 * would defeat the only guarantee left — so the app ignores one, and the
 * database refuses to store one.
 */
export function AccessPersonPanel({
  people,
  peopleLoading,
  writesDisabled,
}: {
  people: Person[];
  peopleLoading: boolean;
  writesDisabled: boolean;
}) {
  const qc = useQueryClient();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () =>
      people
        .filter(
          (p) =>
            !needle ||
            (p.full_name ?? "").toLowerCase().includes(needle) ||
            (p.email ?? "").toLowerCase().includes(needle),
        )
        .slice(0, 40),
    [people, needle],
  );

  const person = people.find((p) => p.user_id === selected) ?? null;

  return (
    <div className="grid gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
      <Card className="h-fit overflow-hidden lg:sticky lg:top-1">
        <div className="border-b p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a person"
              className="h-8 pl-7 text-[13px]"
            />
          </div>
        </div>
        <CardContent className="max-h-[60vh] overflow-y-auto p-1">
          {peopleLoading ? (
            <p className="px-2 py-3 text-[12px] text-muted-foreground">Loading…</p>
          ) : matches.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-muted-foreground">Nobody matches that.</p>
          ) : (
            <ul className="space-y-0.5">
              {matches.map((p) => (
                <li key={p.user_id}>
                  <button
                    type="button"
                    onClick={() => setSelected(p.user_id)}
                    className={cn(
                      "flex min-h-11 w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors md:min-h-0",
                      p.user_id === selected
                        ? "bg-primary/10 text-primary"
                        : "hover:bg-foreground/[0.04]",
                    )}
                  >
                    <span className="w-full truncate text-[13px] font-medium">
                      {p.full_name ?? p.email ?? "Unnamed"}
                    </span>
                    <span className="w-full truncate text-[11px] text-muted-foreground">
                      {p.roles.map((r) => ROLE_LABELS[r as AppRole] ?? r).join(", ") || "no role"}
                      {p.is_active ? "" : " · inactive"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="min-w-0">
        {person ? (
          <PersonAccess
            person={person}
            writesDisabled={writesDisabled}
            onChanged={() => {
              qc.invalidateQueries({ queryKey: ["person-access", person.user_id] });
              qc.invalidateQueries({ queryKey: ["user-permissions", person.user_id] });
              qc.invalidateQueries({ queryKey: ["my-permissions"] });
              qc.invalidateQueries({ queryKey: [ACCESS_HISTORY_KEY] });
            }}
          />
        ) : (
          <Card>
            <CardContent className="p-6 text-center text-[13px] text-muted-foreground">
              Pick someone on the left to see every page they can reach and why.
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function PersonAccess({
  person,
  writesDisabled,
  onChanged,
}: {
  person: Person;
  writesDisabled: boolean;
  onChanged: () => void;
}) {
  const [search, setSearch] = useState("");

  const q = useQuery({
    queryKey: ["person-access", person.user_id],
    queryFn: () => fetchEffectivePermissions(person.user_id),
  });

  const roles = person.roles as AppRole[];
  /** Holds the recovery role: every page is granted and none of it is editable. */
  const recovery = isBreakGlass(roles);
  const stored = useMemo(() => storedPageStates(q.data ?? []), [q.data]);
  const map = useMemo(() => resolveAllPages({ roles, stored }), [roles, stored]);

  /** Override id per page, so "use role default" knows what to delete. */
  const overrideByPage = useMemo(() => {
    const out = new Map<string, string>();
    for (const row of q.data ?? []) {
      if (row.override_id) out.set(row.permission_key, row.override_id);
    }
    return out;
  }, [q.data]);

  const set = useMutation({
    mutationFn: async (v: { pageId: string; effect: "grant" | "revoke" | "clear" }) => {
      const key = pagePermissionKey(v.pageId);
      const existing = overrideByPage.get(key);
      if (v.effect === "clear") {
        if (existing) await clearPermissionOverride(existing);
        return;
      }
      await grantPermission({
        userId: person.user_id,
        key,
        effect: v.effect,
        reason: "Set from the Access screen",
      });
    },
    onSuccess: () => {
      toast.success("Saved");
      onChanged();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const needle = search.trim().toLowerCase();
  const areas = PAGE_AREAS.map((area) => ({
    area,
    pages: PAGES.filter(
      (p) =>
        p.area === area &&
        (!needle ||
          p.label.toLowerCase().includes(needle) ||
          p.path.toLowerCase().includes(needle) ||
          p.area.toLowerCase().includes(needle)),
    ),
  })).filter((a) => a.pages.length > 0);

  /**
   * A group opens on its own when it carries something worth seeing — a
   * personal grant or block — exactly as the user page's panel does. Everything
   * else stays a closed row with a count.
   */
  const autoOpen = useMemo(() => {
    const s = new Set<string>();
    for (const p of PAGES) {
      const src = map.byPage.get(p.id)?.source;
      if (src === "granted" || src === "revoked") s.add(p.area);
    }
    return s;
  }, [map]);
  const groups = useGroupState({ autoOpen, searching: needle.length > 0 });
  const groupKeys = useMemo(() => areas.map((a) => a.area), [areas]);

  const allowedCount = PAGES.filter((p) => map.byPage.get(p.id)?.allowed).length;
  const overrides = [...overrideByPage.keys()].filter((k) => k.startsWith("page."));

  return (
    <div className="space-y-3">
      <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-background px-1 pb-2 pt-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">
            {person.full_name ?? person.email ?? "Unnamed"}
          </h2>
          {roles.map((r) => (
            <Badge key={r} variant="secondary" className="h-5 text-[11px]">
              {ROLE_LABELS[r] ?? r}
            </Badge>
          ))}
          <Badge variant="outline" className="h-5 text-[11px]">
            {allowedCount} of {PAGES.length} pages
          </Badge>
          <ExpandCollapse
            onExpand={() => groups.setAll(groupKeys, true)}
            onCollapse={() => groups.setAll(groupKeys, false)}
          />
          <div className="relative ml-auto w-full sm:w-[220px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pages…"
              className="h-8 pl-7 text-[13px]"
            />
          </div>
        </div>

        {recovery ? (
          <Notice tone="info" icon={<Lock className="size-4" />}>
            <strong className="font-semibold">This person holds the recovery role.</strong>{" "}
            {BREAK_GLASS_REASON} Their access cannot be narrowed here — a personal block would be
            ignored by the app and refused by the database. Remove the Developer role on their user
            page if they should not have it.
          </Notice>
        ) : null}

        {roles.length === 0 ? (
          <Notice tone="warn">
            <strong className="font-semibold">This person holds no role.</strong> They reach only
            the pages granted to them personally. Give them a role on their user panel rather than
            granting pages one at a time.
          </Notice>
        ) : null}

        {map.recovered ? (
          <Notice tone="warn">
            <strong className="font-semibold">No page rules apply to this person.</strong> Their
            roles have no page rows stored, so the app is falling back to the built-in defaults
            rather than showing them an empty app. Set this role up under <em>Roles</em> to replace
            the fallback with a real answer.
          </Notice>
        ) : null}

        {overrides.length > 0 ? (
          <Notice tone="info">
            {overrides.length} personal {overrides.length === 1 ? "override" : "overrides"} on this
            person, on top of their roles.
          </Notice>
        ) : null}
      </div>

      {q.isLoading ? <p className="px-1 text-[13px] text-muted-foreground">Loading…</p> : null}

      {areas.length === 0 ? (
        <p className="px-1 text-[13px] text-muted-foreground">No page matches that search.</p>
      ) : null}

      <div className="space-y-2">
        {areas.map(({ area, pages }) => (
          <AccessGroup
            key={area}
            title={area}
            count={pages.filter((p) => map.byPage.get(p.id)?.allowed).length}
            total={pages.length}
            open={groups.isOpen(area)}
            onToggle={() => groups.toggle(area)}
          >
            {pages.map((p) => {
              const a = map.byPage.get(p.id) as PageAccess;
              return (
                <AccessRow
                  key={p.id}
                  label={p.label}
                  detail={p.path}
                  note={
                    recovery
                      ? BREAK_GLASS_REASON
                      : a.viaRole
                        ? `via ${ROLE_LABELS[a.viaRole] ?? a.viaRole}`
                        : (p.note ?? undefined)
                  }
                  allowed={a.allowed}
                  source={a.source}
                  locked={recovery}
                  trailing={
                    <OverrideControl
                      value={
                        a.source === "granted"
                          ? "grant"
                          : a.source === "revoked"
                            ? "revoke"
                            : "inherit"
                      }
                      disabled={writesDisabled || set.isPending}
                      onChange={(effect) => set.mutate({ pageId: p.id, effect })}
                    />
                  }
                />
              );
            })}
          </AccessGroup>
        ))}
      </div>

      <p className="px-1 text-[12px] text-muted-foreground">
        Capabilities — what this person may <em>do</em> on a page — are on their user page, in the
        same kind of list.{" "}
        <Link
          to="/admin/users/$userId"
          params={{ userId: person.user_id }}
          className="inline-flex items-center gap-0.5 text-primary hover:underline"
        >
          Open user page
          <ArrowUpRight className="size-3" />
        </Link>
      </p>

      <AccessHistory
        filter={{
          kind: "person",
          userId: person.user_id,
          entities: ["user_permissions", "user_roles"],
        }}
      />
    </div>
  );
}

/**
 * Three states, not a switch: a person's line can follow their role, or be
 * pinned on, or be pinned off. A two-state switch cannot express "follow the
 * role", which is the state almost every line should be in.
 */
function OverrideControl({
  value,
  disabled,
  onChange,
}: {
  value: "inherit" | "grant" | "revoke";
  disabled: boolean;
  onChange: (effect: "clear" | "grant" | "revoke") => void;
}) {
  const options = [
    { key: "inherit" as const, label: "Role", effect: "clear" as const },
    { key: "grant" as const, label: "Allow", effect: "grant" as const },
    { key: "revoke" as const, label: "Block", effect: "revoke" as const },
  ];
  return (
    <div className="mt-0.5 flex shrink-0 overflow-hidden rounded-md border">
      {options.map((o) => (
        <Button
          key={o.key}
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || o.key === value}
          onClick={() => onChange(o.effect)}
          className={cn(
            "h-7 rounded-none px-2 text-[11px] font-medium disabled:opacity-100",
            o.key === value
              ? o.key === "revoke"
                ? "bg-destructive/10 text-destructive"
                : "bg-primary/10 text-primary"
              : "text-muted-foreground",
          )}
        >
          {o.label}
        </Button>
      ))}
    </div>
  );
}

export { SourceBadge };
