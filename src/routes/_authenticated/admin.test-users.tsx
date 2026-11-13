import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { isPrivileged, ROLE_LABELS, type AppRole } from "@/lib/roles";
import { rememberReturnPath, startImpersonationAs } from "@/lib/impersonation";

/** Shared password for every seeded QA account. Demo-only, never a real user. */
const TEST_PASSWORD = "GoldStar!Test2026";
const TEST_EMAIL_PREFIX = "mark+";
const TEST_EMAIL_DOMAIN = "@falconmarketing.com";

export const Route = createFileRoute("/_authenticated/admin/test-users")({
  head: () => ({
    meta: [
      { title: "Test users — Recovery Hub" },
      {
        name: "description",
        content:
          "Seeded QA accounts for permission testing, with one-click View As for each scoped role.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TestUsersAdmin,
});

interface TestUserRow {
  user_id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  roles: AppRole[];
  locations: string[];
  regions: string[];
}

async function fetchTestUsers(): Promise<TestUserRow[]> {
  const { data: profiles, error } = await supabase
    .from("profiles")
    .select("user_id, email, full_name, is_active")
    .like("email", `${TEST_EMAIL_PREFIX}%${TEST_EMAIL_DOMAIN}`)
    .eq("is_active", true)
    .order("email");
  if (error) throw error;

  const ids = (profiles ?? []).map((p) => p.user_id);
  if (ids.length === 0) return [];

  const [rolesRes, locRes, regRes] = await Promise.all([
    supabase.from("user_roles").select("user_id, role").in("user_id", ids),
    supabase.from("location_members").select("user_id, locations(name, code)").in("user_id", ids),
    supabase.from("region_members").select("user_id, regions(name)").in("user_id", ids),
  ]);

  const byUser = <T,>(rows: T[] | null, pick: (r: T) => [string, string | null]) => {
    const m = new Map<string, string[]>();
    for (const r of rows ?? []) {
      const [uid, val] = pick(r);
      if (!val) continue;
      m.set(uid, [...(m.get(uid) ?? []), val]);
    }
    return m;
  };

  const roleMap = byUser(rolesRes.data, (r: { user_id: string; role: string }) => [
    r.user_id,
    r.role,
  ]);
  const locMap = byUser(
    locRes.data as { user_id: string; locations: { name: string; code: string } | null }[] | null,
    (r) => [r.user_id, r.locations?.code ?? r.locations?.name ?? null],
  );
  const regMap = byUser(
    regRes.data as { user_id: string; regions: { name: string } | null }[] | null,
    (r) => [r.user_id, r.regions?.name ?? null],
  );

  return (profiles ?? []).map((p) => ({
    user_id: p.user_id,
    email: p.email ?? "",
    full_name: p.full_name,
    is_active: p.is_active ?? true,
    roles: (roleMap.get(p.user_id) ?? []) as AppRole[],
    locations: (locMap.get(p.user_id) ?? []).sort(),
    regions: regMap.get(p.user_id) ?? [],
  }));
}

function TestUsersAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const usersQ = useQuery({ queryKey: ["test-users"], queryFn: fetchTestUsers });

  const viewAs = useMutation({
    mutationFn: (userId: string) => startImpersonationAs(userId),
    onSuccess: async () => {
      rememberReturnPath("/admin/test-users");
      await app.refreshImpersonation();
      qc.invalidateQueries();
      toast.success("Viewing as test user — writes are disabled");
      navigate({ to: "/" });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not start View As"),
  });

  if (!isPrivileged(app.roles)) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Test users are restricted to admins, owners and developers.
        </CardContent>
      </Card>
    );
  }

  const rows = usersQ.data ?? [];

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="text-sm">
            <div className="font-medium">Shared password</div>
            <div className="text-muted-foreground text-xs">
              Every seeded QA account uses the same password. Demo accounts only.
            </div>
          </div>
          <Input readOnly value={TEST_PASSWORD} className="h-8 w-56 font-mono text-xs" />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => {
              void navigator.clipboard.writeText(TEST_PASSWORD);
              toast.success("Password copied");
            }}
          >
            <Copy className="mr-1 size-3.5" /> Copy
          </Button>
          <Badge variant="secondary" className="ml-auto">
            {rows.length} accounts
          </Badge>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {usersQ.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No seeded test accounts found.</div>
          ) : (
            <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Email</th>
                    <th className="px-3 py-2 text-left font-medium">Roles</th>
                    <th className="px-3 py-2 text-left font-medium">Scope</th>
                    <th className="px-3 py-2 text-right font-medium">QC</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.user_id} className="border-t">
                      <td className="px-3 py-1.5">{u.full_name ?? "—"}</td>
                      <td className="px-3 py-1.5 font-mono text-xs text-muted-foreground">
                        {u.email}
                      </td>
                      <td className="px-3 py-1.5">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.map((r) => (
                            <Badge key={r} variant="outline" className="text-[11px]">
                              {ROLE_LABELS[r] ?? r}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-1.5 text-xs text-muted-foreground">
                        {[...u.regions.map((r) => `Region: ${r}`), ...u.locations].join(", ") ||
                          "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          disabled={viewAs.isPending}
                          onClick={() => viewAs.mutate(u.user_id)}
                        >
                          {viewAs.isPending && viewAs.variables === u.user_id ? (
                            <Loader2 className="mr-1 size-3.5 animate-spin" />
                          ) : (
                            <Eye className="mr-1 size-3.5" />
                          )}
                          View as
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
