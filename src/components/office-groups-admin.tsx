import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MultiLocationSelect } from "@/components/multi-location-select";
import { toastDbError } from "@/lib/db-errors";
import {
  loadOfficeGroupMembers,
  loadOfficeGroups,
  loadOfficeOptions,
  officeGroupKeys,
} from "@/lib/office-groups";

/**
 * Groups exist so the office picker on an estimate can be organised the way the
 * client thinks about their offices. They are labels, not permissions — see the
 * note in @/lib/office-groups.
 */
export function OfficeGroupsAdmin() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [pending, setPending] = useState<Record<string, string[]>>({});

  const groupsQ = useQuery({ queryKey: officeGroupKeys.groups, queryFn: loadOfficeGroups });
  const membersQ = useQuery({ queryKey: officeGroupKeys.members, queryFn: loadOfficeGroupMembers });
  const officesQ = useQuery({
    queryKey: [...officeGroupKeys.offices, false],
    queryFn: () => loadOfficeOptions(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: officeGroupKeys.groups });
    qc.invalidateQueries({ queryKey: officeGroupKeys.members });
    qc.invalidateQueries({ queryKey: officeGroupKeys.offices });
  };

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("location_groups").insert({ name: name.trim() });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Group created");
      setName("");
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "Creating the group" }),
  });

  const rename = useMutation({
    mutationFn: async (v: { id: string; name: string }) => {
      const { error } = await supabase
        .from("location_groups")
        .update({ name: v.name.trim() })
        .eq("id", v.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Group renamed");
      setRenaming(null);
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "Renaming the group" }),
  });

  /* Only the memberships cascade — the offices themselves are legal entities
     with live jobs and are never touched by deleting a label. */
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("location_groups").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Group deleted — the offices in it are unchanged");
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "Deleting the group" }),
  });

  const addOffices = useMutation({
    mutationFn: async (v: { groupId: string; locationIds: string[] }) => {
      const { error } = await supabase
        .from("location_group_members")
        .insert(v.locationIds.map((location_id) => ({ group_id: v.groupId, location_id })));
      if (error) throw error;
    },
    onSuccess: (_, v) => {
      toast.success(`${v.locationIds.length} office${v.locationIds.length === 1 ? "" : "s"} added`);
      setPending((p) => ({ ...p, [v.groupId]: [] }));
      invalidate();
    },
    onError: (e) => toastDbError(e, { action: "Adding offices to the group" }),
  });

  const removeOffice = useMutation({
    mutationFn: async (v: { groupId: string; locationId: string }) => {
      const { error } = await supabase
        .from("location_group_members")
        .delete()
        .eq("group_id", v.groupId)
        .eq("location_id", v.locationId);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e) => toastDbError(e, { action: "Removing the office from the group" }),
  });

  const loadFailed = groupsQ.isError || membersQ.isError || officesQ.isError;
  const groups = groupsQ.data ?? [];
  const offices = officesQ.data ?? [];
  const members = membersQ.data ?? [];

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-[17px] font-semibold">Office groups</h2>
        <p className="text-sm text-muted-foreground">
          Headings for the office picker on estimates. An office can sit in more than one group.
          Groups grant no access — use Regions for that.
        </p>
      </div>

      <Card>
        <CardContent className="flex gap-2 p-3">
          <Input
            placeholder="Group name (e.g. Gold Star brand)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !create.isPending) create.mutate();
            }}
          />
          <Button disabled={!name.trim() || create.isPending} onClick={() => create.mutate()}>
            <Plus className="mr-2 size-4" /> Add group
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loadFailed ? (
            <div className="p-4 text-sm text-destructive">
              Office groups could not be loaded — this is not &ldquo;there are no groups&rdquo;.
              Reload before adding one, or you will create a duplicate.
            </div>
          ) : groupsQ.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : groups.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No groups yet — every office shows under &ldquo;Other offices&rdquo; in the picker.
            </div>
          ) : (
            <ul className="divide-y">
              {groups.map((g) => {
                const memberIds = members
                  .filter((m) => m.group_id === g.id)
                  .map((m) => m.location_id);
                const inGroup = offices.filter((o) => memberIds.includes(o.id));
                const available = offices.filter((o) => !memberIds.includes(o.id));
                const picked = pending[g.id] ?? [];
                const editing = renaming?.id === g.id;
                return (
                  <li key={g.id} className="space-y-2 px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      {editing ? (
                        <div className="flex flex-1 items-center gap-1">
                          <Input
                            autoFocus
                            className="h-8"
                            value={renaming.name}
                            onChange={(e) => setRenaming({ id: g.id, name: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && renaming.name.trim())
                                rename.mutate(renaming);
                              if (e.key === "Escape") setRenaming(null);
                            }}
                          />
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!renaming.name.trim() || rename.isPending}
                            onClick={() => rename.mutate(renaming)}
                          >
                            <Check className="size-4" />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                            <X className="size-4" />
                          </Button>
                        </div>
                      ) : (
                        <div className="min-w-0 flex-1 text-sm font-medium">{g.name}</div>
                      )}
                      {!editing && (
                        <div className="flex items-center gap-1">
                          <Badge variant="outline">
                            {inGroup.length} office{inGroup.length === 1 ? "" : "s"}
                          </Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRenaming({ id: g.id, name: g.name })}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(g.id)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      )}
                    </div>

                    {inGroup.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {inGroup.map((o) => (
                          <button
                            key={o.id}
                            type="button"
                            disabled={removeOffice.isPending}
                            title="Remove from this group"
                            onClick={() => removeOffice.mutate({ groupId: g.id, locationId: o.id })}
                            className="group flex items-center gap-1 rounded border border-primary bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                          >
                            {o.code}
                            <X className="size-3 opacity-50 group-hover:opacity-100" />
                          </button>
                        ))}
                      </div>
                    )}

                    {available.length > 0 && (
                      <div className="flex gap-2">
                        <MultiLocationSelect
                          className="min-w-[10rem] flex-1"
                          locations={available}
                          value={picked}
                          onChange={(next) => setPending((p) => ({ ...p, [g.id]: next }))}
                          placeholder="Add offices…"
                        />
                        <Button
                          size="sm"
                          disabled={picked.length === 0 || addOffices.isPending}
                          onClick={() => addOffices.mutate({ groupId: g.id, locationIds: picked })}
                        >
                          <Plus className="size-4" />
                          {picked.length > 0 ? (
                            <span className="ml-1">Add {picked.length}</span>
                          ) : null}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
