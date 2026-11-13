import { useMemo } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";

import { AccessPersonPanel } from "@/components/access/access-person-panel";
import { AccessRolePanel } from "@/components/access/access-role-panel";
import { FieldPermissionsPanel } from "@/components/access/field-permissions-panel";
import { useAppContext } from "@/components/app-context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { adminListUsers } from "@/lib/admin.functions";
import { isSalesLeadership, isPrivileged, type AppRole } from "@/lib/roles";

export const Route = createFileRoute("/_authenticated/admin/permissions")({
  head: () => ({
    meta: [
      { title: "Access · Recovery Hub" },
      {
        name: "description",
        content:
          "Choose which pages each role reaches, override it per person, and set what they may do once they are there.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AccessAdmin,
});

/**
 * Settings → Access.
 *
 * Replaces the capability matrix, which was nine near-identical columns of dots
 * that scrolled sideways with the header row out of sight. One subject at a
 * time — a role, or a person — down the page, grouped by area, at laptop width.
 */
function AccessAdmin() {
  const app = useAppContext();
  const listUsers = useServerFn(adminListUsers);
  const privileged = isPrivileged(app.roles);

  const usersQ = useQuery({
    queryKey: ["admin-users"],
    enabled: privileged,
    queryFn: () => listUsers(),
  });

  const people = useMemo(
    () =>
      (usersQ.data?.users ?? []).map((u) => ({
        user_id: u.user_id,
        full_name: u.full_name,
        email: u.email,
        roles: u.roles,
        is_active: u.is_active,
      })),
    [usersQ.data],
  );

  /** Shape the lockout check wants: who is active, and what do they hold. */
  const accessCandidates = useMemo(
    () =>
      people.map((p) => ({
        userId: p.user_id,
        isActive: p.is_active,
        roles: p.roles as AppRole[],
      })),
    [people],
  );

  const roleCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of people) {
      if (!p.is_active) continue;
      for (const r of p.roles) m.set(r, (m.get(r) ?? 0) + 1);
    }
    return m;
  }, [people]);

  // Sales leadership reach this screen only for job fields; the tab strip in
  // admin.tsx already narrows to it for them, and the layout refuses everyone
  // else outright.
  if (!privileged) {
    return (
      <div className="mx-auto max-w-4xl">
        <FieldPermissionsPanel />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* The title and summary are the Settings header's; only the rules that are not obvious stay. */}
      <div className="space-y-1 text-[13px] text-muted-foreground">
        <p>
          Every page is a switch, for every role — Owner and Admin included. What is stored here is
          the answer for all of them.
        </p>
        <p>
          <strong className="font-medium text-foreground">Developer is the one exception.</strong>{" "}
          It is the recovery role: it always reaches every page and every capability, from code, and
          it cannot be changed here or by direct SQL. That is what makes everything else safe to
          switch off — whatever you do on this screen, someone holding Developer can still sign in
          and put it back.
        </p>
        <p>
          A page that has never been set up falls back to its built-in default, which always
          includes Owner, Admin and Developer, so adding a page never locks an administrator out
          before someone remembers to tick it. Switching “Access (this screen)” off for everyone is
          allowed, after a confirm — the way back is a Developer account, or, if nobody holds one,
          the SQL in <code className="font-mono text-[11px]">supabase/ACCESS_RECOVERY.md</code>.
        </p>
      </div>

      <Tabs defaultValue="roles">
        <TabsList>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="people">People</TabsTrigger>
          <TabsTrigger value="fields">Job fields</TabsTrigger>
        </TabsList>

        <TabsContent value="roles" className="mt-3">
          <AccessRolePanel
            roleCounts={roleCounts}
            people={accessCandidates}
            writesDisabled={app.writesDisabled}
          />
        </TabsContent>

        <TabsContent value="people" className="mt-3">
          <AccessPersonPanel
            people={people}
            peopleLoading={usersQ.isLoading}
            writesDisabled={app.writesDisabled}
          />
        </TabsContent>

        <TabsContent value="fields" className="mt-3">
          {isSalesLeadership(app.roles) ? (
            <div className="max-w-4xl">
              <FieldPermissionsPanel />
            </div>
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Job field visibility is set by sales leadership.
            </p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
