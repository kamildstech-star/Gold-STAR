import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Plus, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { UserPermissionsSection } from "@/components/user-permissions";
import { AccessHistory } from "@/components/access/access-history";
import { MultiLocationSelect } from "@/components/multi-location-select";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AdminUserRow } from "@/lib/admin.functions";
import { deactivateUserNow, restoreUserSignIn } from "@/lib/offboarding.functions";
import { ACCESS_HISTORY_KEY } from "@/lib/page-access-admin";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  ASSIGNABLE_ROLES,
  LOCATION_MEMBER_ROLES,
  LOCATION_MEMBER_ROLE_LABEL,
  type LocationMemberRole,
} from "@/lib/admin";
import { ROLE_LABELS, type AppRole } from "@/lib/roles";

export function UserEditor({ user, onChange }: { user: AdminUserRow; onChange: () => void }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const isSelf = user.user_id === app.userId;

  /* Read on its own so a database without the column still renders the
     editor; the select below explains itself in that case. */
  const primaryQ = useQuery({
    queryKey: ["profile-primary-location", user.user_id],
    queryFn: async (): Promise<{ id: string | null; migrated: boolean }> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("primary_location_id")
        .eq("user_id", user.user_id)
        .maybeSingle();
      if (error) {
        if (isMissingSchema(error)) return { id: null, migrated: false };
        throw error;
      }
      return { id: data?.primary_location_id ?? null, migrated: true };
    },
  });

  const setPrimary = useMutation({
    mutationFn: async (location_id: string) => {
      const { error } = await supabase
        .from("profiles")
        .update({ primary_location_id: location_id })
        .eq("user_id", user.user_id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Primary location set");
      qc.invalidateQueries({ queryKey: ["profile-primary-location", user.user_id] });
      if (isSelf) app.refresh();
      onChange();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bumpAll = () => {
    qc.invalidateQueries({ queryKey: [ACCESS_HISTORY_KEY] });
    onChange();
  };

  const addRole = useMutation({
    mutationFn: async (role: AppRole) => {
      const { error } = await supabase.from("user_roles").insert({ user_id: user.user_id, role });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role granted");
      bumpAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeRole = useMutation({
    mutationFn: async (role: AppRole) => {
      const { error } = await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", user.user_id)
        .eq("role", role);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Role revoked");
      bumpAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const setActive = useMutation({
    mutationFn: async (active: boolean) => {
      if (!active) {
        await deactivateUserNow({ data: { userId: user.user_id } });
        return;
      }
      const { error } = await supabase
        .from("profiles")
        .update({ is_active: active })
        .eq("user_id", user.user_id);
      if (error) throw error;
      try {
        await restoreUserSignIn({ data: { userId: user.user_id } });
      } catch (restoreError) {
        // Keep the toggle retryable if Auth did not accept the restoration.
        const { error: rollbackError } = await supabase
          .from("profiles")
          .update({ is_active: user.is_active })
          .eq("user_id", user.user_id);
        if (rollbackError) {
          throw new Error(
            "Sign-in restoration was not confirmed and the profile could not be restored to its previous state. Use Restore sign-in to retry.",
          );
        }
        throw restoreError;
      }
    },
    onSuccess: (_, active) => {
      toast.success(
        active ? "Account and sign-in restored" : "Sign-in blocked and offboarding started",
      );
      bumpAll();
    },
    onError: (e: Error) => {
      toast.error(e.message);
      bumpAll();
    },
  });

  const addMembership = useMutation({
    mutationFn: async (v: { location_ids: string[]; role: LocationMemberRole }) => {
      const { error } = await supabase.from("location_members").insert(
        v.location_ids.map((location_id) => ({
          user_id: user.user_id,
          location_id,
          role: v.role,
        })),
      );
      if (error) throw error;
    },
    onSuccess: (_, v) => {
      toast.success(
        v.location_ids.length === 1 ? "Location added" : `${v.location_ids.length} locations added`,
      );
      bumpAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  /*
   * Edit an assignment in place. David, 24 Sep: "I can't edit this? I can
   * only remove it and re-add?" The row is updated where it is — its role, or
   * the office it is for — and the history records it (a role change as one
   * line, an office move as removed + added; 20260928120000).
   */
  const editMembership = useMutation({
    mutationFn: async (v: {
      location_id: string;
      patch: { role?: LocationMemberRole; location_id?: string };
    }) => {
      const { data, error } = await supabase
        .from("location_members")
        .update(v.patch)
        .eq("user_id", user.user_id)
        .eq("location_id", v.location_id)
        .select("id");
      if (error) throw error;
      // RLS refuses by matching no row (your own assignments, or not an admin).
      if ((data ?? []).length === 0) throw new Error("That assignment could not be changed.");
    },
    onSuccess: () => {
      toast.success("Assignment updated");
      bumpAll();
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "update the assignment" });
    },
  });

  const removeMembership = useMutation({
    mutationFn: async (location_id: string) => {
      const { error } = await supabase
        .from("location_members")
        .delete()
        .eq("user_id", user.user_id)
        .eq("location_id", location_id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Location removed");
      bumpAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addRegion = useMutation({
    mutationFn: async (region_id: string) => {
      const { error } = await supabase
        .from("region_members")
        .insert({ user_id: user.user_id, region_id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Region added");
      bumpAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const removeRegion = useMutation({
    mutationFn: async (region_id: string) => {
      const { error } = await supabase
        .from("region_members")
        .delete()
        .eq("user_id", user.user_id)
        .eq("region_id", region_id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Region removed");
      bumpAll();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [newRole, setNewRole] = useState<AppRole | "">("");
  const [newLocs, setNewLocs] = useState<string[]>([]);
  const [newLocRole, setNewLocRole] = useState<LocationMemberRole>("field");
  const [newRegion, setNewRegion] = useState<string>("");

  const availableRoles = ASSIGNABLE_ROLES.filter((r) => !user.roles.includes(r));
  const availableLocs = app.allLocations.filter((l) => !user.location_ids.includes(l.id));
  const availableRegions = app.regions.filter((r) => !user.region_ids.includes(r.id));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <BackLink
            fallbackTo="/admin/users"
            label="All users"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" /> All users
          </BackLink>
          <h2 className="font-display text-[17px] font-semibold">
            {user.full_name || "Unnamed user"}
          </h2>
          <p className="font-mono text-xs text-muted-foreground">
            {user.email ?? "no email on file"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isSelf ? (
            <Badge variant="outline">You</Badge>
          ) : user.is_active ? (
            <Badge className="bg-success/15 text-success">Active</Badge>
          ) : (
            <Badge variant="secondary">Inactive</Badge>
          )}
        </div>
      </div>

      {isSelf && (
        <div className="flex items-start gap-2 rounded-sm border border-warning/40 bg-warning/10 p-3 text-xs">
          <ShieldAlert className="mt-0.5 size-4 text-warning" />
          <div>
            You cannot modify your own roles, memberships, or active status. This is enforced in the
            database and cannot be bypassed from the UI.
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="space-y-4">
          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Active</h3>
              <Switch
                checked={user.is_active}
                disabled={isSelf || setActive.isPending || app.writesDisabled}
                onCheckedChange={(v) => setActive.mutate(v)}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Deactivation blocks new sign-ins and starts offboarding. Existing access may remain
              until it expires. Reactivation restores sign-in and retains assigned roles and
              offices; review those assignments first. Linked integrations must be reviewed
              separately.
            </p>
            {user.is_active && !isSelf && (
              <Button
                variant="outline"
                size="sm"
                disabled={setActive.isPending || app.writesDisabled}
                onClick={() => setActive.mutate(true)}
              >
                Restore sign-in
              </Button>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Roles</h3>
            <div className="flex flex-wrap gap-1">
              {user.roles.length === 0 && (
                <span className="text-xs text-muted-foreground">No roles assigned.</span>
              )}
              {user.roles.map((r) => (
                <Badge key={r} variant="secondary" className="gap-1">
                  {ROLE_LABELS[r as AppRole] ?? r}
                  <button
                    type="button"
                    disabled={isSelf}
                    onClick={() => removeRole.mutate(r as AppRole)}
                    className="ml-1 rounded hover:bg-muted disabled:opacity-40"
                    aria-label={`Remove ${r}`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ))}
            </div>
            {!isSelf && availableRoles.length > 0 && (
              <div className="flex gap-2">
                <Select value={newRole} onValueChange={(v) => setNewRole(v as AppRole)}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Grant role…" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!newRole || addRole.isPending}
                  onClick={() => {
                    if (newRole) {
                      addRole.mutate(newRole as AppRole);
                      setNewRole("");
                    }
                  }}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Location memberships</h3>
            {user.location_ids.length === 0 ? (
              <p className="text-xs text-muted-foreground">Not a member of any location.</p>
            ) : (
              <ul className="space-y-1">
                {user.location_ids.map((id, i) => {
                  const loc = app.allLocations.find((l) => l.id === id);
                  const primary = primaryQ.data?.id === id;
                  return (
                    <li
                      key={id}
                      data-membership-row
                      className="flex flex-wrap items-center justify-between gap-2 rounded-sm border px-2 py-1.5 text-sm"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{loc?.code ?? "?"}</span>{" "}
                        <span className="text-muted-foreground">{loc?.name ?? ""}</span>
                        {primary ? (
                          <Badge className="ml-1 bg-primary/10 text-[10px] text-primary">
                            Primary
                          </Badge>
                        ) : null}
                      </span>
                      {isSelf ? (
                        <Badge variant="outline" className="text-[10px]">
                          {user.location_roles[i] ?? "?"}
                        </Badge>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Select
                            value={user.location_roles[i] ?? ""}
                            disabled={editMembership.isPending}
                            onValueChange={(v) =>
                              editMembership.mutate({
                                location_id: id,
                                patch: { role: v as LocationMemberRole },
                              })
                            }
                          >
                            <SelectTrigger
                              className="h-11 w-28 text-xs md:h-8"
                              aria-label={`Role at ${loc?.code ?? "this office"}`}
                            >
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
                          {availableLocs.length > 0 ? (
                            <Select
                              value=""
                              disabled={editMembership.isPending}
                              onValueChange={(v) =>
                                editMembership.mutate({
                                  location_id: id,
                                  patch: { location_id: v },
                                })
                              }
                            >
                              <SelectTrigger
                                className="h-11 w-32 text-xs md:h-8"
                                aria-label={`Move the ${loc?.code ?? ""} assignment to another office`}
                              >
                                <SelectValue placeholder="Move to…" />
                              </SelectTrigger>
                              <SelectContent>
                                {availableLocs.map((l) => (
                                  <SelectItem key={l.id} value={l.id}>
                                    {l.code} · {l.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : null}
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isSelf}
                        onClick={() => removeMembership.mutate(id)}
                      >
                        <X className="size-4" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {!isSelf && availableLocs.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <MultiLocationSelect
                  className="min-w-[12rem] flex-1"
                  locations={availableLocs}
                  value={newLocs}
                  onChange={setNewLocs}
                />
                <Select
                  value={newLocRole}
                  onValueChange={(v) => setNewLocRole(v as LocationMemberRole)}
                >
                  <SelectTrigger className="w-32">
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
                <Button
                  size="sm"
                  disabled={newLocs.length === 0 || addMembership.isPending}
                  onClick={() => {
                    if (newLocs.length === 0) return;
                    addMembership.mutate(
                      { location_ids: newLocs, role: newLocRole },
                      { onSuccess: () => setNewLocs([]) },
                    );
                  }}
                >
                  <Plus className="size-4" />
                  {newLocs.length > 1 ? <span className="ml-1">Add {newLocs.length}</span> : null}
                </Button>
              </div>
            )}

            {user.location_ids.length > 0 ? (
              <div className="space-y-1 pt-1">
                <div className="text-xs font-medium">Primary location</div>
                <p className="text-xs text-muted-foreground">
                  The office that pre-fills new jobs, accounts and estimates for this person. It
                  never limits what they can see — the memberships above do that.
                </p>
                {primaryQ.data && !primaryQ.data.migrated ? (
                  <p className="text-xs text-warning">
                    Not available yet — the primary-location migration has not been applied.
                  </p>
                ) : (
                  <Select
                    value={primaryQ.data?.id ?? ""}
                    onValueChange={(v) => setPrimary.mutate(v)}
                    disabled={primaryQ.isLoading || setPrimary.isPending}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Choose the primary office…" />
                    </SelectTrigger>
                    <SelectContent>
                      {user.location_ids.map((id) => {
                        const loc = app.allLocations.find((l) => l.id === id);
                        return (
                          <SelectItem key={id} value={id}>
                            {loc ? `${loc.code} · ${loc.name}` : id}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                )}
              </div>
            ) : null}
          </section>

          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Region memberships</h3>
            <p className="text-xs text-muted-foreground">
              Regions add locations on top of the memberships above. They never take any away, and
              they apply whatever role this person holds.
            </p>
            <div className="flex flex-wrap gap-1">
              {user.region_ids.length === 0 && (
                <span className="text-xs text-muted-foreground">
                  No regions yet — this person keeps the offices listed above.
                </span>
              )}
              {user.region_ids.map((rid) => {
                const r = app.regions.find((x) => x.id === rid);
                return (
                  <Badge key={rid} variant="secondary" className="gap-1">
                    {r?.name ?? "?"}
                    <button
                      type="button"
                      disabled={isSelf}
                      onClick={() => removeRegion.mutate(rid)}
                      className="ml-1 rounded hover:bg-muted disabled:opacity-40"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                );
              })}
            </div>
            {!isSelf && availableRegions.length > 0 && (
              <div className="flex gap-2">
                <Select value={newRegion} onValueChange={setNewRegion}>
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Add region…" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRegions.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  disabled={!newRegion || addRegion.isPending}
                  onClick={() => {
                    if (newRegion) {
                      addRegion.mutate(newRegion);
                      setNewRegion("");
                    }
                  }}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            )}
          </section>
        </div>

        <div className="space-y-4">
          <UserPermissionsSection userId={user.user_id} readOnly={isSelf} onChange={bumpAll} />

          <AccessHistory filter={{ kind: "person", userId: user.user_id }} />
        </div>
      </div>
    </div>
  );
}
