import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import {
  Check,
  Copy,
  Eye,
  Link2,
  Mail,
  MailCheck,
  MoreHorizontal,
  Plus,
  Search,
  ShieldAlert,
  UserPlus,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { LoadError, WarningLine } from "@/components/ui-density";
import { StaffRosterPanel } from "@/components/admin/staff-roster-panel";
import { supabase } from "@/integrations/supabase/client";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

import {
  adminApproveUser,
  adminConfirmEmail,
  adminInviteLink,
  adminInviteUser,
  adminListUsers,
  adminRejectUser,
  adminResendInvite,
  type AdminUserRow,
} from "@/lib/admin.functions";
import { Textarea } from "@/components/ui/textarea";
import {
  ASSIGNABLE_ROLES,
  AUDIT_ACTION_LABEL,
  LOCATION_MEMBER_ROLES,
  LOCATION_MEMBER_ROLE_LABEL,
  relTime,
  type LocationMemberRole,
} from "@/lib/admin";
import { PREVIEWABLE_ROLES, ROLE_LABELS, type AppRole } from "@/lib/roles";
import {
  rememberReturnPath,
  startImpersonationAs,
  startImpersonationPreview,
} from "@/lib/impersonation";
import { useRouter } from "@tanstack/react-router";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * A user with a role but no location membership passes RLS on nothing and
 * sees an empty app. Same for a `regional` (or `owner`) holder with no
 * region. Surface both loudly rather than behind a filter — this has cost
 * real debugging time twice.
 */
function scopeGap(u: AdminUserRow): string | null {
  if (u.location_ids.length === 0) return "No location";
  if ((u.roles.includes("regional") || u.roles.includes("owner")) && u.region_ids.length === 0)
    return "No region";
  return null;
}

export const Route = createFileRoute("/_authenticated/admin/users/")({
  component: UsersAdmin,
});

function UsersAdmin() {
  const listUsers = useServerFn(adminListUsers);
  const app = useAppContext();
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [locFilter, setLocFilter] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive" | "pending">(
    "active",
  );
  const navigate = useNavigate();

  const usersQ = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => listUsers(),
  });

  // Query errors are logged and toasted globally by the QueryCache handler
  // in src/router.tsx; the inline LoadError below is the in-page surface.

  const users = usersQ.data?.users ?? [];
  const enrichmentWarning = usersQ.data?.enrichmentWarning ?? null;

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return users.filter((u) => {
      if (activeFilter === "pending" && u.approval_status !== "pending") return false;
      if (activeFilter === "active" && !u.is_active) return false;
      if (activeFilter === "inactive" && u.is_active) return false;
      if (roleFilter !== "all" && !u.roles.includes(roleFilter)) return false;
      if (locFilter !== "all" && !u.location_ids.includes(locFilter)) return false;
      if (!needle) return true;
      return (
        (u.full_name ?? "").toLowerCase().includes(needle) ||
        (u.email ?? "").toLowerCase().includes(needle)
      );
    });
  }, [users, q, roleFilter, locFilter, activeFilter]);

  const locById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of app.allLocations) m.set(l.id, l.code);
    return m;
  }, [app.allLocations]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {usersQ.isLoading
            ? "Loading…"
            : usersQ.error
              ? "Could not load users"
              : `${filtered.length} of ${users.length} shown`}
        </p>
        <div className="flex items-center gap-2">
          <RolePreviewMenu />
          <InviteDialog onDone={() => usersQ.refetch()} />
        </div>
      </div>

      {usersQ.error ? (
        <LoadError what="users" error={usersQ.error} onRetry={() => void usersQ.refetch()} />
      ) : null}

      {enrichmentWarning ? (
        <WarningLine>
          Last sign-in data is unavailable ({enrichmentWarning}). The user list itself is complete.
        </WarningLine>
      ) : null}

      <PendingBanner users={users} onDone={() => void usersQ.refetch()} />

      {/* The company roster import (22 Oct): who still needs an account. */}
      <StaffRosterPanel onChanged={() => void usersQ.refetch()} />

      <ScopeGapBanner users={users} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search name or email…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Any role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any role</SelectItem>
            {ASSIGNABLE_ROLES.map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABELS[r]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={locFilter} onValueChange={setLocFilter}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Any location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any location</SelectItem>
            {app.allLocations.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.code} · {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={activeFilter}
          onValueChange={(v) => setActiveFilter(v as typeof activeFilter)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active only</SelectItem>
            <SelectItem value="inactive">Inactive only</SelectItem>
            <SelectItem value="pending">Pending approval</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Roles</th>
                  <th className="px-3 py-2 font-medium">Locations</th>
                  <th className="px-3 py-2 font-medium">Regions</th>
                  <th className="px-3 py-2 font-medium">Last sign-in</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {usersQ.isLoading ? (
                  <tr>
                    <td colSpan={8} className="p-3 text-left text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : usersQ.error ? (
                  <tr>
                    <td colSpan={8} className="p-0">
                      <LoadError
                        what="users"
                        error={usersQ.error}
                        onRetry={() => void usersQ.refetch()}
                      />
                    </td>
                  </tr>
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="p-3 text-left text-muted-foreground">
                      No users match the current filters.
                    </td>
                  </tr>
                ) : (
                  filtered.map((u) => (
                    <tr
                      key={u.user_id}
                      onClick={() =>
                        navigate({
                          to: "/admin/users/$userId",
                          params: { userId: u.user_id },
                        })
                      }
                      className="cursor-pointer border-t transition-colors hover:bg-accent/40"
                    >
                      <td className="px-3 py-2 font-medium">
                        {u.full_name || <span className="text-muted-foreground">—</span>}
                        {u.user_id === app.userId && (
                          <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{u.email ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {u.roles.length === 0 ? (
                            <span className="text-xs text-muted-foreground">none</span>
                          ) : (
                            u.roles.slice(0, 3).map((r) => (
                              <Badge key={r} variant="secondary" className="text-[10px]">
                                {ROLE_LABELS[r as AppRole] ?? r}
                              </Badge>
                            ))
                          )}
                          {u.roles.length > 3 && (
                            <span className="text-xs text-muted-foreground">
                              +{u.roles.length - 3}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {scopeGap(u) && (
                            <Badge
                              variant="outline"
                              className="border-warning/60 bg-warning/10 text-[10px] text-warning"
                            >
                              <ShieldAlert className="mr-1 size-3" />
                              {scopeGap(u)}
                            </Badge>
                          )}
                          {u.location_ids.length === 0 ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : (
                            u.location_ids.map((id, i) => (
                              <Badge key={id} variant="outline" className="text-[10px]">
                                {locById.get(id) ?? "?"}
                                <span className="ml-1 text-muted-foreground">
                                  ({u.location_roles[i] ?? "?"})
                                </span>
                              </Badge>
                            ))
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {u.region_ids.length === 0 ? "—" : `${u.region_ids.length} region(s)`}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                        {enrichmentWarning ? "unknown" : relTime(u.last_sign_in_at)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {u.approval_status === "pending" ? (
                            <Badge className="bg-warning/15 text-warning">Pending approval</Badge>
                          ) : u.approval_status === "rejected" ? (
                            <Badge variant="destructive">Rejected</Badge>
                          ) : u.is_active ? (
                            <Badge className="bg-success/15 text-success">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                          {!enrichmentWarning && !u.email_confirmed_at && (
                            <Badge variant="outline" className="text-[10px]">
                              Unconfirmed
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <ViewAsButton
                            targetUserId={u.user_id}
                            disabledSelf={u.user_id === app.userId}
                          />
                          <UserActionsMenu user={u} onDone={() => void usersQ.refetch()} />
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ScopeGapBanner({ users }: { users: AdminUserRow[] }) {
  const gapped = users.filter((u) => u.is_active && scopeGap(u));
  if (gapped.length === 0) return null;
  return (
    <div className="rounded-sm border border-warning/50 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {gapped.length} user{gapped.length === 1 ? "" : "s"} cannot see anything
          </div>
          <p className="text-xs text-muted-foreground">
            Missing location or region membership. Until it is fixed the app looks empty to them.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {gapped.map((u) => (
              <Button key={u.user_id} size="sm" variant="outline" className="h-7 text-xs" asChild>
                <Link to="/admin/users/$userId" params={{ userId: u.user_id }}>
                  {u.full_name || u.email || "Unnamed"}
                  <span className="ml-1.5 text-muted-foreground">· {scopeGap(u)}</span>
                </Link>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function InviteDialog({ onDone }: { onDone: () => void }) {
  const invite = useServerFn(adminInviteUser);
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [locIds, setLocIds] = useState<string[]>([]);
  const [locRole, setLocRole] = useState<LocationMemberRole>("field");
  const [regionIds, setRegionIds] = useState<string[]>([]);

  // Roles that imply breadth need a matching scope, or the user signs in
  // to an app that shows them nothing.
  const needsRegion = roles.includes("regional") || roles.includes("owner");
  const missingLocation = locIds.length === 0;
  const missingRegion = needsRegion && regionIds.length === 0;

  const reset = () => {
    setEmail("");
    setFullName("");
    setRoles([]);
    setLocIds([]);
    setRegionIds([]);
    setLocRole("field");
  };

  const m = useMutation({
    mutationFn: () =>
      invite({
        data: {
          email,
          fullName: fullName || undefined,
          roles,
          locations: locIds.map((location_id) => ({
            location_id,
            role: locRole,
          })),
          regionIds,
        },
      }),
    onSuccess: (res: { user_id: string | null; warnings: string[] }) => {
      if (res.warnings?.length) {
        for (const w of res.warnings) toast.warning(w);
      } else {
        toast.success(`Invite sent to ${email}`);
      }
      reset();
      setOpen(false);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggle = <T,>(arr: T[], v: T) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <UserPlus className="mr-2 size-4" /> Invite user
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite user</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Email</Label>
            <Input
              type="email"
              placeholder="new.employee@goldstarrestoration.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Full name (optional)</Label>
            <Input
              placeholder="Jane Doe"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Roles</Label>
            <div className="flex flex-wrap gap-1.5">
              {ASSIGNABLE_ROLES.map((r) => {
                const on = roles.includes(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRoles((cur) => toggle(cur, r))}
                    className={`rounded-sm border px-2 py-1 text-xs transition-colors ${
                      on
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {ROLE_LABELS[r]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>
                Locations <span className="text-destructive">*</span>
              </Label>
              <Select value={locRole} onValueChange={(v) => setLocRole(v as LocationMemberRole)}>
                <SelectTrigger className="h-8 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCATION_MEMBER_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {LOCATION_MEMBER_ROLE_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {app.allLocations.map((l) => {
                const on = locIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setLocIds((cur) => toggle(cur, l.id))}
                    className={`truncate rounded-sm border px-2 py-1.5 text-left text-xs transition-colors ${
                      on
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {l.code} · {l.name}
                  </button>
                );
              })}
            </div>
            {missingLocation && (
              <p className="text-xs text-destructive">
                Pick at least one location. A user with a role but no location membership sees an
                empty app.
              </p>
            )}
          </div>

          {needsRegion && (
            <div className="space-y-1.5">
              <Label>
                Regions <span className="text-destructive">*</span>
              </Label>
              <p className="text-xs text-muted-foreground">
                {roles.includes("owner") ? "Owner" : "Regional Director"} access spans regions —
                assign the ones this user covers.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {app.regions.map((r) => {
                  const on = regionIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setRegionIds((cur) => toggle(cur, r.id))}
                      className={`rounded-sm border px-2 py-1 text-xs transition-colors ${
                        on
                          ? "border-primary bg-primary/10 font-medium text-primary"
                          : "text-muted-foreground hover:bg-accent"
                      }`}
                    >
                      {r.name}
                    </button>
                  );
                })}
              </div>
              {missingRegion && (
                <p className="text-xs text-destructive">Assign at least one region.</p>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            They receive an email with a link to set a password. Roles and memberships are applied
            immediately and can be changed later from their user page.
          </p>
        </div>
        <DialogFooter>
          <Button
            disabled={!email || missingLocation || missingRegion || m.isPending}
            onClick={() => m.mutate()}
          >
            <Mail className="mr-2 size-4" /> Send invite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useStartImpersonation() {
  const app = useAppContext();
  const qc = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: async (
      input: { kind: "user"; userId: string } | { kind: "role"; role: AppRole },
    ) => {
      if (input.kind === "user") return startImpersonationAs(input.userId);
      return startImpersonationPreview(input.role);
    },
    onSuccess: async () => {
      rememberReturnPath(window.location.pathname);
      await app.refreshImpersonation();
      qc.invalidateQueries();
      toast.success("View As started");
      router.navigate({ to: "/" });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not start View As"),
  });
}

function ViewAsButton({
  targetUserId,
  disabledSelf,
}: {
  targetUserId: string;
  disabledSelf: boolean;
}) {
  const app = useAppContext();
  const start = useStartImpersonation();
  const disabled = disabledSelf || app.isImpersonating || start.isPending;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={disabled}
      title={
        disabledSelf
          ? "You can't View As yourself"
          : app.isImpersonating
            ? "Exit current View As first"
            : "See the app as this user"
      }
      onClick={() => start.mutate({ kind: "user", userId: targetUserId })}
    >
      <Eye className="mr-1.5 size-4" />
      View As
    </Button>
  );
}

function RolePreviewMenu() {
  const app = useAppContext();
  const start = useStartImpersonation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={app.isImpersonating || start.isPending}
          title={app.isImpersonating ? "Exit current View As first" : "Preview a generic role"}
        >
          <Eye className="mr-1.5 size-4" />
          Preview role
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>Preview a role</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {PREVIEWABLE_ROLES.map((r) => (
          <DropdownMenuItem key={r} onClick={() => start.mutate({ kind: "role", role: r })}>
            {ROLE_LABELS[r]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Signups land as `pending`. Surface them at the top of the page so an
 * admin never has to go hunting — this gate is the only thing standing
 * between a stranger's signup and the app.
 */
function PendingBanner({ users, onDone }: { users: AdminUserRow[]; onDone: () => void }) {
  const pending = users.filter((u) => u.approval_status === "pending");
  if (pending.length === 0) return null;
  return (
    <div className="rounded-sm border border-warning/50 bg-warning/10 p-3">
      <div className="flex items-start gap-2">
        <UserPlus className="mt-0.5 size-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">
            {pending.length} signup{pending.length === 1 ? "" : "s"} waiting for approval
          </div>
          <p className="text-xs text-muted-foreground">
            They can sign in but see nothing until you assign a role and office.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {pending.map((u) => (
              <ApproveDialog key={u.user_id} user={u} onDone={onDone} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Per-row admin actions: approve, reject, confirm email, resend invite, copy invite link. */
function UserActionsMenu({ user, onDone }: { user: AdminUserRow; onDone: () => void }) {
  const confirmFn = useServerFn(adminConfirmEmail);
  const resendFn = useServerFn(adminResendInvite);
  const rejectFn = useServerFn(adminRejectUser);
  const linkFn = useServerFn(adminInviteLink);
  const [invite, setInvite] = useState<{ link: string; email: string } | null>(null);

  const confirmM = useMutation({
    mutationFn: () => confirmFn({ data: { userId: user.user_id } }),
    onSuccess: () => {
      toast.success("Email marked confirmed");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resendM = useMutation({
    mutationFn: () => resendFn({ data: { userId: user.user_id } }),
    onSuccess: () => toast.success("Invite email sent"),
    onError: (e: Error) => toast.error(e.message),
  });
  const linkM = useMutation({
    mutationFn: () => linkFn({ data: { userId: user.user_id } }),
    onSuccess: (got) => setInvite(got),
    onError: (e: Error) => toast.error(e.message),
  });
  const rejectM = useMutation({
    mutationFn: () => rejectFn({ data: { userId: user.user_id } }),
    onSuccess: () => {
      toast.success("Signup rejected");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7">
            <MoreHorizontal className="size-4" />
            <span className="sr-only">Actions</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!!user.email_confirmed_at || confirmM.isPending}
            onSelect={(e) => {
              e.preventDefault();
              confirmM.mutate();
            }}
          >
            <MailCheck className="mr-2 size-4" />
            {user.email_confirmed_at ? "Email confirmed" : "Confirm email"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={resendM.isPending}
            onSelect={(e) => {
              e.preventDefault();
              resendM.mutate();
            }}
          >
            <Mail className="mr-2 size-4" /> Resend invite
          </DropdownMenuItem>
          <DropdownMenuItem disabled={linkM.isPending} onSelect={() => linkM.mutate()}>
            <Link2 className="mr-2 size-4" />
            {linkM.isPending ? "Making link…" : "Copy invite link"}
          </DropdownMenuItem>
          {user.approval_status === "pending" && (
            <DropdownMenuItem
              disabled={rejectM.isPending}
              className="text-destructive focus:text-destructive"
              onSelect={(e) => {
                e.preventDefault();
                rejectM.mutate();
              }}
            >
              <X className="mr-2 size-4" /> Reject signup
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <InviteLinkDialog invite={invite} onClose={() => setInvite(null)} />
    </>
  );
}

/**
 * The invite link, shown to copy (27 Oct). Shown rather than copied straight
 * away: the link is made on the server after the click, and Safari refuses a
 * clipboard write that no longer follows a tap — so the Copy button here is
 * its own tap.
 */
function InviteLinkDialog({
  invite,
  onClose,
}: {
  invite: { link: string; email: string } | null;
  onClose: () => void;
}) {
  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.link);
      toast.success("Invite link copied");
    } catch {
      toast.error("Could not copy — select the link and copy it by hand.");
    }
  };
  return (
    <Dialog open={invite != null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Invite link</DialogTitle>
          <DialogDescription>
            Send this to {invite?.email} yourself — text, WhatsApp or email. It opens a page where
            they choose their own password. It works once and expires, so make a new one if it is
            not used soon.
          </DialogDescription>
        </DialogHeader>
        <Input
          readOnly
          value={invite?.link ?? ""}
          aria-label="Invite link"
          className="font-mono text-xs"
          onFocus={(e) => e.currentTarget.select()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => void copy()}>
            <Copy className="mr-2 size-4" />
            Copy link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Approve a pending signup by giving it a role and an office. */
function ApproveDialog({ user, onDone }: { user: AdminUserRow; onDone: () => void }) {
  const approve = useServerFn(adminApproveUser);
  const rejectFn = useServerFn(adminRejectUser);
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<AppRole[]>([]);
  const [locIds, setLocIds] = useState<string[]>([]);
  const [locRole, setLocRole] = useState<LocationMemberRole>("field");
  const [reason, setReason] = useState("");

  const toggle = <T,>(arr: T[], v: T) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const m = useMutation({
    mutationFn: () =>
      approve({
        data: {
          userId: user.user_id,
          roles,
          locations: locIds.map((location_id) => ({ location_id, role: locRole })),
          regionIds: [],
          confirmEmail: true,
        },
      }),
    onSuccess: (res: { warnings: string[] }) => {
      if (res.warnings?.length) for (const w of res.warnings) toast.warning(w);
      else toast.success("User approved");
      setOpen(false);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectM = useMutation({
    mutationFn: () => rejectFn({ data: { userId: user.user_id, reason: reason || undefined } }),
    onSuccess: () => {
      toast.success("Signup rejected");
      setOpen(false);
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const missing = roles.length === 0 || locIds.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 text-xs">
          {user.full_name || user.email || "Unnamed"}
          <span className="ml-1.5 text-muted-foreground">· review</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Approve {user.full_name || user.email}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="font-mono text-xs text-muted-foreground">{user.email}</p>

          <div className="space-y-1.5">
            <Label>
              Roles <span className="text-destructive">*</span>
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {ASSIGNABLE_ROLES.map((r) => {
                const on = roles.includes(r);
                return (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRoles((cur) => toggle(cur, r))}
                    className={`rounded-sm border px-2 py-1 text-xs transition-colors ${
                      on
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {ROLE_LABELS[r]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>
                Locations <span className="text-destructive">*</span>
              </Label>
              <Select value={locRole} onValueChange={(v) => setLocRole(v as LocationMemberRole)}>
                <SelectTrigger className="h-8 w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCATION_MEMBER_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {LOCATION_MEMBER_ROLE_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {app.allLocations.map((l) => {
                const on = locIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => setLocIds((cur) => toggle(cur, l.id))}
                    className={`truncate rounded-sm border px-2 py-1.5 text-left text-xs transition-colors ${
                      on
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {l.code} · {l.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1">
            <Label>Rejection reason (only used if you reject)</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Not a Gold Star employee"
            />
          </div>

          <div className="flex justify-between gap-2 pt-1">
            <Button
              variant="destructive"
              disabled={rejectM.isPending}
              onClick={() => rejectM.mutate()}
            >
              <X className="mr-2 size-4" /> Reject
            </Button>
            <Button disabled={missing || m.isPending} onClick={() => m.mutate()}>
              <Check className="mr-2 size-4" />
              {m.isPending ? "Approving…" : "Approve"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
