import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock, Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { AccessGroup } from "@/components/access/access-group";
import { AccessHistory } from "@/components/access/access-history";
import { useGroupState } from "@/components/access/use-group-state";
import { AccessRow } from "@/components/access/access-row";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ASSIGNABLE_ROLES, LEGACY_ROLES } from "@/lib/admin";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";
import {
  ACCESS_PAGE_ID,
  BREAK_GLASS_REASON,
  BREAK_GLASS_ROLE,
  PAGES,
  PAGE_AREAS,
  defaultAllows,
  isPagePermissionKey,
  resolveRolePages,
  wouldOrphanAccessPage,
  type AccessCandidate,
  type PageAccess,
  type PageDef,
} from "@/lib/page-access";
import {
  ACCESS_HISTORY_KEY,
  fetchRolePageState,
  setRoleAreaAccess,
  setRolePageAccess,
} from "@/lib/page-access-admin";
import { fetchPermissionCatalogue, setRolePermission, type PermissionRow } from "@/lib/permissions";

/** Roles carry no personal overrides, so nothing opens on its own. */
const NO_AUTO_OPEN: ReadonlySet<string> = new Set();

/**
 * "Pick one role and see plainly everything it can and cannot reach."
 *
 * One role at a time, down the page, grouped by area — no nine columns of
 * near-identical dots and nothing to scroll sideways for. The role list is a
 * narrow rail that stays put; the groups scroll.
 *
 * The groups are the collapsible rows Mark liked on the user page: closed by
 * default, `AREA  12/14` on every row, so the whole role is readable without
 * opening anything. Pages by area first, then capabilities by their group.
 *
 * Every role is editable and every page is a switch, Owner and Admin included.
 * The single exception is Developer, the recovery role: it is drawn read-only
 * with a padlock, because it is the guarantee that everything else can be
 * switched off safely. Switching the Access page away from everybody is still
 * allowed, after a confirm step that says who is left to let you back in.
 */
export function AccessRolePanel({
  roleCounts,
  people,
  writesDisabled,
}: {
  /** How many people hold each role, for the rail. */
  roleCounts: Map<string, number>;
  /** Everyone on the account, for the lockout check. */
  people: readonly AccessCandidate[];
  writesDisabled: boolean;
}) {
  const qc = useQueryClient();
  const [role, setRole] = useState<AppRole>("location_manager");
  const [search, setSearch] = useState("");

  const stateQ = useQuery({
    queryKey: ["role-page-state"],
    queryFn: fetchRolePageState,
  });
  const catalogueQ = useQuery({
    queryKey: ["permission-catalogue"],
    queryFn: fetchPermissionCatalogue,
  });

  const seeded = stateQ.data?.seeded ?? false;
  const known = stateQ.data?.known;

  const resolved = useMemo(
    () =>
      resolveRolePages({
        role,
        storedRolePages: stateQ.data?.byRole ?? new Map(),
        catalogueSeeded: seeded,
        knownPages: known,
      }),
    [role, stateQ.data, seeded, known],
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["role-page-state"] });
    qc.invalidateQueries({ queryKey: ["my-permissions"] });
    qc.invalidateQueries({ queryKey: [ACCESS_HISTORY_KEY] });
  };

  const togglePage = useMutation({
    mutationFn: (v: { pageId: string; on: boolean }) => setRolePageAccess(role, v.pageId, v.on),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleArea = useMutation({
    mutationFn: (v: { pageIds: string[]; on: boolean }) => setRoleAreaAccess(role, v.pageIds, v.on),
    onSuccess: () => {
      invalidate();
      toast.success("Area updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /**
   * The change that is waiting on a confirm, if any. Held rather than saved so
   * that "Cancel" is a true no-op and the switch snaps back on its own — the
   * row renders from `resolved`, which has not moved.
   */
  const [pending, setPending] = useState<{ pageIds: string[]; on: boolean } | null>(null);

  const runChange = (pageIds: string[], on: boolean) => {
    if (pageIds.length === 1) togglePage.mutate({ pageId: pageIds[0]!, on });
    else toggleArea.mutate({ pageIds, on });
  };

  /**
   * Save it, unless it would leave nobody at all able to open this screen — in
   * which case ask first. The change is never refused: Mark asked for a screen
   * with no locks on it, and this is a confirm, not a lock.
   */
  const requestChange = (pageIds: string[], on: boolean) => {
    const orphans = wouldOrphanAccessPage({
      people,
      storedRolePages: stateQ.data?.byRole ?? new Map(),
      catalogueSeeded: seeded,
      knownPages: known,
      personalOverrides: stateQ.data?.accessPageOverrides,
      change: { role, pageIds, on },
    });
    if (orphans) setPending({ pageIds, on });
    else runChange(pageIds, on);
  };

  const toggleCapability = useMutation({
    mutationFn: (v: { key: string; on: boolean }) => setRolePermission(role, v.key, v.on),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });

  const needle = search.trim().toLowerCase();
  const matches = (p: PageDef) =>
    !needle ||
    p.label.toLowerCase().includes(needle) ||
    p.path.toLowerCase().includes(needle) ||
    p.area.toLowerCase().includes(needle);

  const areas = PAGE_AREAS.map((area) => ({
    area,
    pages: PAGES.filter((p) => p.area === area && matches(p)),
  })).filter((a) => a.pages.length > 0);

  /** Capabilities by their catalogue group, the same grouping the user page uses. */
  const capabilityGroups = useMemo(() => {
    const g = new Map<string, PermissionRow[]>();
    for (const c of catalogueQ.data ?? []) {
      if (isPagePermissionKey(c.key)) continue;
      if (
        needle &&
        !c.label.toLowerCase().includes(needle) &&
        !c.key.toLowerCase().includes(needle) &&
        !c.perm_group.toLowerCase().includes(needle)
      )
        continue;
      const arr = g.get(c.perm_group) ?? [];
      arr.push(c);
      g.set(c.perm_group, arr);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalogueQ.data, needle]);

  const capabilityLabels = useMemo(
    () => new Map((catalogueQ.data ?? []).map((c) => [c.key, c.label])),
    [catalogueQ.data],
  );

  const roleCapabilities = stateQ.data?.capabilitiesByRole.get(role);
  // Owner/Admin/Dev used to be drawn as "has everything" here. They never did:
  // `effective_permissions()` has no privileged short-circuit, so the screen was
  // showing a tick the app did not honour. It now shows the stored row.
  const hasCapability = (key: string) => roleCapabilities?.has(key) ?? false;

  const groupKeys = useMemo(
    () => [...areas.map((a) => `area:${a.area}`), ...capabilityGroups.map(([g]) => `cap:${g}`)],
    [areas, capabilityGroups],
  );
  const groups = useGroupState({ autoOpen: NO_AUTO_OPEN, searching: needle.length > 0 });

  const allowedCount = PAGES.filter((p) => resolved.get(p.id)?.allowed).length;
  const busy = togglePage.isPending || toggleArea.isPending || toggleCapability.isPending;
  /**
   * The recovery role. Read-only here, and read-only in the database too, so
   * offering a switch would only produce a rejected write and a red toast.
   */
  const recoveryRole = role === BREAK_GLASS_ROLE;
  // Not seeded means there is no `page.<id>` row to point a grant at, so every
  // write would fail on the foreign key. Show the defaults, refuse the edit.
  const disabled = writesDisabled || busy || !seeded || recoveryRole;

  return (
    <div className="grid gap-3 lg:grid-cols-[210px_minmax(0,1fr)]">
      <RoleRail
        value={role}
        onChange={setRole}
        counts={roleCounts}
        stored={stateQ.data?.byRole ?? new Map()}
        seeded={seeded}
      />

      <div className="min-w-0 space-y-3">
        <div className="sticky top-0 z-10 -mx-1 space-y-2 bg-background px-1 pb-2 pt-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">{ROLE_LABELS[role]}</h2>
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
                placeholder="Search pages and capabilities…"
                className="h-8 pl-7 text-[13px]"
              />
            </div>
          </div>

          {recoveryRole ? (
            <Notice tone="info" icon={<Lock className="size-4" />}>
              <strong className="font-semibold">Developer is the recovery role.</strong>{" "}
              {BREAK_GLASS_REASON} It cannot be edited here, on the People tab, or by direct SQL —
              the database refuses the write. Every other role stays a switch precisely because this
              one does not. To take the recovery role away from somebody, remove the role on their
              user page.
            </Notice>
          ) : null}

          {allowedCount === 0 && seeded && !stateQ.isLoading ? (
            <Notice tone="warn" icon={<TriangleAlert className="size-4" />}>
              <strong className="font-semibold">{ROLE_LABELS[role]} reaches no page at all.</strong>{" "}
              Anyone whose only role is this one lands on a refusal wherever they go.
            </Notice>
          ) : null}

          {!seeded ? (
            <Notice tone="warn">
              <strong className="font-semibold">Page rules are not enabled yet.</strong> The page
              catalog arrives in a migration that has not been applied to this database. Until it
              is, the app uses the built-in defaults shown here — which is exactly how it behaves
              today — and these switches cannot be saved.
            </Notice>
          ) : null}
        </div>

        {stateQ.isLoading ? (
          <p className="px-1 text-[13px] text-muted-foreground">Loading…</p>
        ) : null}

        {areas.length === 0 && capabilityGroups.length === 0 && !stateQ.isLoading ? (
          <p className="px-1 text-[13px] text-muted-foreground">Nothing matches that search.</p>
        ) : null}

        <div className="space-y-2">
          {areas.map(({ area, pages }) => {
            const key = `area:${area}`;
            const on = pages.filter((p) => resolved.get(p.id)?.allowed).length;
            // Every page is configurable now, including the three essential
            // ones and the Access page itself.
            const configurable = pages;
            return (
              <AccessGroup
                key={key}
                title={area}
                count={on}
                total={pages.length}
                open={groups.isOpen(key)}
                onToggle={() => groups.toggle(key)}
                actions={
                  !disabled && configurable.length > 0 ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[12px]"
                        onClick={() =>
                          requestChange(
                            configurable.map((p) => p.id),
                            true,
                          )
                        }
                      >
                        Allow all
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-[12px]"
                        onClick={() =>
                          requestChange(
                            configurable.map((p) => p.id),
                            false,
                          )
                        }
                      >
                        Clear
                      </Button>
                    </>
                  ) : null
                }
              >
                {pages.map((p) => {
                  const a = resolved.get(p.id) as PageAccess;
                  // A page that exists in code but not in the catalogue has no
                  // row to write, so the switch would fail on the foreign key.
                  // Show its built-in default and say why it cannot be edited.
                  const uncatalogued = seeded && !!known && !known.has(p.id);
                  return (
                    <AccessRow
                      key={p.id}
                      label={p.label}
                      detail={p.path}
                      note={
                        recoveryRole
                          ? BREAK_GLASS_REASON
                          : uncatalogued
                            ? "New page — not in the database catalog yet, so it is using its " +
                              "built-in default. Apply the pending page-access migration to edit it."
                            : p.note
                      }
                      allowed={a.allowed}
                      source={a.source}
                      locked={recoveryRole}
                      disabled={disabled || uncatalogued}
                      onToggle={(next) => requestChange([p.id], next)}
                    />
                  );
                })}
              </AccessGroup>
            );
          })}

          {capabilityGroups.map(([group, items]) => {
            const key = `cap:${group}`;
            // The recovery role carries every capability too — reaching a screen
            // it cannot use would not be a way back in.
            const on = recoveryRole
              ? items.length
              : items.filter((c) => hasCapability(c.key)).length;
            return (
              <AccessGroup
                key={key}
                title={`Capabilities · ${group}`}
                hint="what this role may do once it is on a page"
                count={on}
                total={items.length}
                open={groups.isOpen(key)}
                onToggle={() => groups.toggle(key)}
              >
                {items.map((c) => {
                  const has = recoveryRole || hasCapability(c.key);
                  return (
                    <AccessRow
                      key={c.key}
                      label={c.label}
                      detail={c.key}
                      note={recoveryRole ? BREAK_GLASS_REASON : (c.description ?? undefined)}
                      allowed={has}
                      source={recoveryRole ? "break-glass" : has ? "role" : "denied"}
                      locked={recoveryRole}
                      disabled={writesDisabled || busy}
                      onToggle={(next) => toggleCapability.mutate({ key: c.key, on: next })}
                    />
                  );
                })}
              </AccessGroup>
            );
          })}
        </div>

        <AccessHistory filter={{ kind: "role", role }} labels={capabilityLabels} />
      </div>

      <LockoutConfirm
        open={pending !== null}
        role={role}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) runChange(pending.pageIds, pending.on);
          setPending(null);
        }}
      />
    </div>
  );
}

/**
 * The one confirm step on this screen.
 *
 * It appears only when saving would leave NOBODY able to open Settings →
 * Access: no active Owner or Admin who still holds it, and — since `dev` became
 * the recovery role — nobody active holding `dev` either, because one such
 * person is by itself a guaranteed way back in.
 *
 * So the consequence it names is no longer "unrecoverable". It is "you will
 * need someone with the Developer role", which is a thing an administrator can
 * arrange in thirty seconds *before* saving. The SQL runbook stays as the last
 * resort for the case where nobody holds it and nobody can be given it.
 *
 * It still does not refuse the change.
 */
function LockoutConfirm({
  open,
  role,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  role: AppRole;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>You will need someone with the Developer role</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-left">
              <p>
                Switching <strong>Access (this screen)</strong> off for{" "}
                <strong>{ROLE_LABELS[role]}</strong> leaves no active Owner or Admin who can reach
                Settings → Access. Nobody will be able to switch it back on, or change anyone&apos;s
                access at all, from inside the app.
              </p>
              <p>
                The way back is the <strong>Developer</strong> role: it always reaches every page
                and cannot be switched off. <strong>Nobody active holds it right now</strong>, so
                today there is no one to let you back in. Cancel, give somebody Developer on their
                user page, and this change stops being a lockout.
              </p>
              <p>
                Failing that, recovery is one SQL statement run against the database by someone with
                Supabase access — it is written out in{" "}
                <code className="font-mono text-[11px]">supabase/ACCESS_RECOVERY.md</code>.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Switch it off anyway
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "Expand all · Collapse all" — small, textual, beside the heading. */
export function ExpandCollapse({
  onExpand,
  onCollapse,
}: {
  onExpand: () => void;
  onCollapse: () => void;
}) {
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
      <button type="button" className="hover:text-foreground hover:underline" onClick={onExpand}>
        Expand all
      </button>
      <span aria-hidden>·</span>
      <button type="button" className="hover:text-foreground hover:underline" onClick={onCollapse}>
        Collapse all
      </button>
    </span>
  );
}

/** The role list. Fixed, always visible, never scrolled off sideways. */
function RoleRail({
  value,
  onChange,
  counts,
  stored,
  seeded,
}: {
  value: AppRole;
  onChange: (r: AppRole) => void;
  counts: Map<string, number>;
  stored: ReadonlyMap<AppRole, ReadonlySet<string>>;
  seeded: boolean;
}) {
  // Roles someone actually holds always appear, even the legacy ones, because
  // hiding a role that twelve people hold is how a rollout goes wrong.
  const roles = useMemo(() => {
    const set = new Set<AppRole>([...ASSIGNABLE_ROLES, "sales_head", "dev"]);
    for (const legacy of LEGACY_ROLES) if ((counts.get(legacy) ?? 0) > 0) set.add(legacy);
    for (const [r, n] of counts) if (n > 0) set.add(r as AppRole);
    return [...set];
  }, [counts]);

  return (
    <Card className="h-fit overflow-hidden lg:sticky lg:top-1">
      <CardContent className="p-1">
        <ul className="space-y-0.5">
          {roles.map((r) => {
            const active = r === value;
            const n = counts.get(r) ?? 0;
            // A real count for every role now, privileged ones included: they
            // are stored rows like anyone else, not an unconditional "all".
            const locked = r === BREAK_GLASS_ROLE;
            // The recovery role reaches everything from code, so its rail count
            // is the whole catalogue whatever happens to be stored.
            const pages = locked
              ? PAGES.length
              : seeded
                ? (stored.get(r)?.size ?? 0)
                : PAGES.filter((p) => defaultAllows(p, r)).length;
            return (
              <li key={r}>
                <button
                  type="button"
                  onClick={() => onChange(r)}
                  className={cn(
                    "flex min-h-11 w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors md:min-h-0",
                    active
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-foreground/[0.04]",
                  )}
                >
                  <span className="flex w-full items-center gap-1.5 text-[13px] font-medium">
                    <span className="truncate">{ROLE_LABELS[r]}</span>
                    {locked ? (
                      <Lock
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-label="Recovery role — cannot be changed"
                      />
                    ) : null}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {n} {n === 1 ? "person" : "people"} ·{" "}
                    <span className="font-mono">
                      {pages}/{PAGES.length}
                    </span>{" "}
                    pages
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

export function Notice({
  tone,
  icon,
  children,
}: {
  tone: "info" | "warn";
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]",
        tone === "warn"
          ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "border-border bg-muted/50 text-muted-foreground",
      )}
    >
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <span>{children}</span>
    </div>
  );
}
