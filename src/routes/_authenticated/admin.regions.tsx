import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MultiLocationSelect } from "@/components/multi-location-select";

export const Route = createFileRoute("/_authenticated/admin/regions")({
  component: RegionsAdmin,
});

function RegionsAdmin() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [pending, setPending] = useState<Record<string, string[]>>({});

  const regionsQ = useQuery({
    queryKey: ["admin-regions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("regions")
        .select("id, name, description")
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const locsQ = useQuery({
    queryKey: ["admin-regions-locs"],
    queryFn: async () => {
      const [{ data: locs, error }, { data: links, error: e2 }] = await Promise.all([
        supabase.from("locations").select("id, code, name").order("code"),
        supabase.from("location_regions").select("location_id, region_id"),
      ]);
      if (error) throw error;
      if (e2) throw e2;
      const byLoc = new Map<string, string[]>();
      for (const l of links ?? []) {
        const arr = byLoc.get(l.location_id) ?? [];
        arr.push(l.region_id);
        byLoc.set(l.location_id, arr);
      }
      return (locs ?? []).map((l) => ({ ...l, region_ids: byLoc.get(l.id) ?? [] }));
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("regions")
        .insert({ name: name.trim(), description: description || null });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Region created");
      setName("");
      setDescription("");
      qc.invalidateQueries({ queryKey: ["admin-regions"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("regions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Region deleted");
      qc.invalidateQueries({ queryKey: ["admin-regions"] });
      qc.invalidateQueries({ queryKey: ["admin-regions-locs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const toggleRegion = useMutation({
    mutationFn: async (v: { locationId: string; regionId: string; on: boolean }) => {
      if (v.on) {
        const { error } = await supabase
          .from("location_regions")
          .insert({ location_id: v.locationId, region_id: v.regionId });
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("location_regions")
          .delete()
          .eq("location_id", v.locationId)
          .eq("region_id", v.regionId);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-regions-locs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const addLocations = useMutation({
    mutationFn: async (v: { regionId: string; locationIds: string[] }) => {
      const { error } = await supabase.from("location_regions").insert(
        v.locationIds.map((location_id) => ({
          location_id,
          region_id: v.regionId,
        })),
      );
      if (error) throw error;
    },
    onSuccess: (_, v) => {
      toast.success(
        `${v.locationIds.length} location${v.locationIds.length === 1 ? "" : "s"} added`,
      );
      setPending((p) => ({ ...p, [v.regionId]: [] }));
      qc.invalidateQueries({ queryKey: ["admin-regions-locs"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="grid gap-3 md:grid-cols-[2fr_3fr]">
      <div className="space-y-3">
        <Card>
          <CardContent className="space-y-2 p-3">
            <Input
              placeholder="Region name (e.g. Mid-Atlantic)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <Button
              className="w-full"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              <Plus className="mr-2 size-4" /> Add region
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-0">
            {regionsQ.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : (regionsQ.data ?? []).length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No regions yet — add one on the left.
              </div>
            ) : (
              <ul className="divide-y">
                {(regionsQ.data ?? []).map((r) => {
                  const members = (locsQ.data ?? []).filter((l) => l.region_ids.includes(r.id));
                  const available = (locsQ.data ?? []).filter((l) => !l.region_ids.includes(r.id));
                  const picked = pending[r.id] ?? [];
                  return (
                    <li key={r.id} className="space-y-2 px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{r.name}</div>
                          {r.description && (
                            <div className="truncate text-xs text-muted-foreground">
                              {r.description}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{members.length} loc</Badge>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={remove.isPending}
                            onClick={() => remove.mutate(r.id)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </div>
                      {available.length > 0 && (
                        <div className="flex gap-2">
                          <MultiLocationSelect
                            className="min-w-[10rem] flex-1"
                            locations={available}
                            value={picked}
                            onChange={(next) => setPending((p) => ({ ...p, [r.id]: next }))}
                          />
                          <Button
                            size="sm"
                            disabled={picked.length === 0 || addLocations.isPending}
                            onClick={() =>
                              addLocations.mutate({ regionId: r.id, locationIds: picked })
                            }
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

      <div className="space-y-3">
        <div>
          <h2 className="font-display text-[17px] font-semibold">Location → Regions</h2>
          <p className="text-sm text-muted-foreground">
            An office can belong to any number of regions.
          </p>
        </div>
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Code</th>
                    <th className="px-3 py-2 font-medium">Location</th>
                    <th className="px-3 py-2 font-medium">Regions</th>
                  </tr>
                </thead>
                <tbody>
                  {(locsQ.data ?? []).map((l) => (
                    <tr key={l.id} className="border-t align-top">
                      <td className="px-3 py-2 font-mono">{l.code}</td>
                      <td className="px-3 py-2">{l.name}</td>
                      <td className="px-3 py-2">
                        {(regionsQ.data ?? []).length === 0 ? (
                          <span className="text-xs text-muted-foreground">No regions yet</span>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {(regionsQ.data ?? []).map((r) => {
                              const on = l.region_ids.includes(r.id);
                              return (
                                <button
                                  key={r.id}
                                  type="button"
                                  disabled={toggleRegion.isPending}
                                  onClick={() =>
                                    toggleRegion.mutate({
                                      locationId: l.id,
                                      regionId: r.id,
                                      on: !on,
                                    })
                                  }
                                  className={
                                    on
                                      ? "rounded border border-primary bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                                      : "rounded border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                                  }
                                >
                                  {r.name}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
