import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useWritesDisabled } from "@/components/app-context";
import { IntakeOfficeRulesCard } from "@/components/intake-office-rules-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastDbError } from "@/lib/db-errors";
import { shiftLengthLabel } from "@/lib/chase-shift";
import {
  fetchMarkets,
  fetchTerritories,
  fetchZoneAdjacency,
  fetchZones,
  type ChaserTerritory,
  type Market,
} from "@/lib/territory";

/**
 * Territory admin. Markets are the hard wall; zones are ZIP sets inside one.
 * The intake office rules at the bottom are a separate thing that lives here
 * because Mark asked for it here — see intake-office-rules-card.tsx.
 * Dispatch scope (what is pushed) and view scope (what can be browsed) are
 * deliberately separate fields — a chaser can be allowed to look at more of
 * their market than they get woken up for.
 */

export const Route = createFileRoute("/_authenticated/admin/territory")({
  head: () => ({
    meta: [
      { title: "Territory — Recovery Hub" },
      {
        name: "description",
        content:
          "Markets, ZIP zones, adjacency and chaser dispatch scope for the chase module, and the state and ZIP rules that send intake forms to an office.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: TerritoryAdmin,
});

function TerritoryAdmin() {
  const qc = useQueryClient();
  const { disabled } = useWritesDisabled();
  const [marketId, setMarketId] = useState<string>("");

  const marketsQ = useQuery({ queryKey: ["markets"], queryFn: fetchMarkets });
  const zonesQ = useQuery({ queryKey: ["zones"], queryFn: () => fetchZones() });
  const adjQ = useQuery({ queryKey: ["zone-adjacency"], queryFn: fetchZoneAdjacency });
  const terrQ = useQuery({ queryKey: ["chaser-territories"], queryFn: fetchTerritories });
  const peopleQ = useQuery({
    queryKey: ["territory", "people"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name");
      if (error) throw error;
      return (data ?? []).map((p) => ({ id: p.user_id, full_name: p.full_name }));
    },
  });

  const markets = marketsQ.data ?? [];
  const active = marketId || markets[0]?.id || "";
  const zones = (zonesQ.data ?? []).filter((z) => z.market_id === active);
  const nameOf = useMemo(
    () => new Map((peopleQ.data ?? []).map((p) => [p.id, p.full_name ?? "Unnamed"])),
    [peopleQ.data],
  );
  const zoneName = useMemo(
    () => new Map((zonesQ.data ?? []).map((z) => [z.id, z.name])),
    [zonesQ.data],
  );

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["markets"] });
    void qc.invalidateQueries({ queryKey: ["zones"] });
    void qc.invalidateQueries({ queryKey: ["zone-adjacency"] });
    void qc.invalidateQueries({ queryKey: ["chaser-territories"] });
  };

  return (
    <div className="space-y-3 p-3">
      <MarketsCard markets={markets} disabled={disabled} onChange={refresh} />

      <div className="flex items-center gap-2">
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">Market</Label>
        <Select value={active} onValueChange={setMarketId}>
          <SelectTrigger className="h-8 w-56">
            <SelectValue placeholder="Pick a market" />
          </SelectTrigger>
          <SelectContent>
            {markets.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {active && (
        <>
          <ZonesCard
            marketId={active}
            zones={zones}
            adjacency={adjQ.data ?? []}
            zoneName={zoneName}
            disabled={disabled}
            onChange={refresh}
          />
          <ChasersCard
            marketId={active}
            zones={zones}
            territories={terrQ.data ?? []}
            people={peopleQ.data ?? []}
            nameOf={nameOf}
            disabled={disabled}
            onChange={refresh}
          />
        </>
      )}

      {/* Not market-scoped: which office a customer's intake form lands in,
          set by state or ZIP, ahead of the closest-office guess. */}
      <IntakeOfficeRulesCard disabled={disabled} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function MarketsCard({
  markets,
  disabled,
  onChange,
}: {
  markets: Market[];
  disabled: boolean;
  onChange: () => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const add = async () => {
    if (!name.trim() || !code.trim()) {
      toast.error("Name and code are required");
      return;
    }
    const { error } = await supabase
      .from("markets")
      .insert({ name: name.trim(), code: code.trim().toUpperCase() });
    if (error) return toastDbError(error, { action: "save territory" });
    setName("");
    setCode("");
    onChange();
  };

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Markets</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {markets.map((m) => (
          <div key={m.id} className="flex items-center gap-2 border-b py-1.5 text-sm last:border-0">
            <span className="font-medium">{m.name}</span>
            <Badge variant="outline" className="text-[10px]">
              {m.code}
            </Badge>
            <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
              Escalate every
              <Input
                type="number"
                min={15}
                defaultValue={m.escalation_interval_seconds}
                disabled={disabled}
                className="h-7 w-20"
                onBlur={async (e) => {
                  const v = Number(e.target.value);
                  if (!Number.isFinite(v) || v < 15) return;
                  const { error } = await supabase
                    .from("markets")
                    .update({ escalation_interval_seconds: Math.round(v) })
                    .eq("id", m.id);
                  if (error) return toastDbError(error, { action: "save territory" });
                  onChange();
                }}
              />
              seconds
            </span>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              Default hours
              <Input
                type="time"
                className="h-7 w-24"
                disabled={disabled}
                defaultValue={(m.shift_start_time ?? "").slice(0, 5)}
                onBlur={async (e) => {
                  const { error } = await supabase
                    .from("markets")
                    .update({ shift_start_time: e.target.value || null })
                    .eq("id", m.id);
                  if (error) return toastDbError(error, { action: "save territory" });
                  onChange();
                }}
              />
              to
              <Input
                type="time"
                className="h-7 w-24"
                disabled={disabled}
                defaultValue={(m.shift_end_time ?? "").slice(0, 5)}
                onBlur={async (e) => {
                  const { error } = await supabase
                    .from("markets")
                    .update({ shift_end_time: e.target.value || null })
                    .eq("id", m.id);
                  if (error) return toastDbError(error, { action: "save territory" });
                  onChange();
                }}
              />
            </span>
          </div>
        ))}
        <div className="flex gap-2 pt-1">
          <Input
            placeholder="Market name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8"
          />
          <Input
            placeholder="Code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className="h-8 w-28"
          />
          <Button size="sm" disabled={disabled} onClick={add}>
            <Plus className="mr-1 size-4" /> Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ZonesCard({
  marketId,
  zones,
  adjacency,
  zoneName,
  disabled,
  onChange,
}: {
  marketId: string;
  zones: { id: string; name: string; postal_codes: string[] }[];
  adjacency: { zone_id: string; adjacent_zone_id: string }[];
  zoneName: Map<string, string>;
  disabled: boolean;
  onChange: () => void;
}) {
  const [name, setName] = useState("");
  const [zips, setZips] = useState("");

  const parseZips = (s: string) =>
    s
      .split(/[\s,]+/)
      .map((z) => z.trim())
      .filter(Boolean);

  const add = async () => {
    if (!name.trim()) return toast.error("Zone name is required");
    const { error } = await supabase
      .from("zones")
      .insert({ market_id: marketId, name: name.trim(), postal_codes: parseZips(zips) });
    if (error) return toastDbError(error, { action: "save territory" });
    setName("");
    setZips("");
    onChange();
  };

  const toggleAdjacent = async (a: string, b: string, on: boolean) => {
    // Adjacency is symmetric — both directions are written so tier 2 works
    // whichever side the incident lands on.
    if (on) {
      const { error } = await supabase.from("zone_adjacency").insert([
        { zone_id: a, adjacent_zone_id: b },
        { zone_id: b, adjacent_zone_id: a },
      ]);
      if (error) return toastDbError(error, { action: "save territory" });
    } else {
      const { error } = await supabase
        .from("zone_adjacency")
        .delete()
        .or(
          `and(zone_id.eq.${a},adjacent_zone_id.eq.${b}),and(zone_id.eq.${b},adjacent_zone_id.eq.${a})`,
        );
      if (error) return toastDbError(error, { action: "save territory" });
    }
    onChange();
  };

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Zones</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {zones.map((z) => {
          const neighbours = adjacency
            .filter((a) => a.zone_id === z.id)
            .map((a) => a.adjacent_zone_id);
          return (
            <div key={z.id} className="space-y-1.5 border-b pb-2 last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{z.name}</span>
                <span className="text-xs text-muted-foreground">
                  {z.postal_codes.length} ZIP{z.postal_codes.length === 1 ? "" : "s"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7"
                  disabled={disabled}
                  onClick={async () => {
                    const { error } = await supabase.from("zones").delete().eq("id", z.id);
                    if (error) return toastDbError(error, { action: "save territory" });
                    onChange();
                  }}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
              <Input
                defaultValue={z.postal_codes.join(", ")}
                disabled={disabled}
                className="h-8"
                placeholder="ZIP codes, comma separated"
                onBlur={async (e) => {
                  const { error } = await supabase
                    .from("zones")
                    .update({ postal_codes: parseZips(e.target.value) })
                    .eq("id", z.id);
                  if (error) return toastDbError(error, { action: "save territory" });
                  onChange();
                }}
              />
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="text-muted-foreground">Adjacent to</span>
                {zones
                  .filter((o) => o.id !== z.id)
                  .map((o) => (
                    <label key={o.id} className="flex items-center gap-1.5">
                      <Checkbox
                        checked={neighbours.includes(o.id)}
                        disabled={disabled}
                        onCheckedChange={(v) => toggleAdjacent(z.id, o.id, v === true)}
                      />
                      {zoneName.get(o.id) ?? o.name}
                    </label>
                  ))}
                {zones.length < 2 && <span className="text-muted-foreground">—</span>}
              </div>
            </div>
          );
        })}
        <div className="flex gap-2">
          <Input
            placeholder="Zone name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8"
          />
          <Input
            placeholder="ZIP codes"
            value={zips}
            onChange={(e) => setZips(e.target.value)}
            className="h-8"
          />
          <Button size="sm" disabled={disabled} onClick={add}>
            <Plus className="mr-1 size-4" /> Add
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ChasersCard({
  marketId,
  zones,
  territories,
  people,
  nameOf,
  disabled,
  onChange,
}: {
  marketId: string;
  zones: { id: string; name: string }[];
  territories: ChaserTerritory[];
  people: { id: string; full_name: string | null }[];
  nameOf: Map<string, string>;
  disabled: boolean;
  onChange: () => void;
}) {
  const [addUser, setAddUser] = useState("");
  const mine = territories.filter((t) => t.market_id === marketId);
  const unassigned = people.filter((p) => !territories.some((t) => t.user_id === p.id));

  const save = async (userId: string, patch: Partial<ChaserTerritory>) => {
    const { error } = await supabase.from("chaser_territories").update(patch).eq("user_id", userId);
    if (error) return toastDbError(error, { action: "save territory" });
    onChange();
  };

  const toggleIn = (arr: string[], id: string, on: boolean) =>
    on ? Array.from(new Set([...arr, id])) : arr.filter((x) => x !== id);

  return (
    <Card>
      <CardHeader className="py-3">
        <CardTitle className="text-sm">Chasers in this market</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {mine.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No chasers assigned. Incidents here escalate straight to admin.
          </p>
        )}
        {mine.map((t) => (
          <div key={t.user_id} className="space-y-2 border-b pb-3 last:border-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{nameOf.get(t.user_id) ?? "Unknown"}</span>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto size-7"
                disabled={disabled}
                onClick={async () => {
                  const { error } = await supabase
                    .from("chaser_territories")
                    .delete()
                    .eq("user_id", t.user_id);
                  if (error) return toastDbError(error, { action: "save territory" });
                  onChange();
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>

            <div className="flex items-center gap-2">
              <Label className="w-32 text-xs text-muted-foreground">Primary zone</Label>
              <Select
                value={t.primary_zone_id ?? "none"}
                onValueChange={(v) => save(t.user_id, { primary_zone_id: v === "none" ? null : v })}
              >
                <SelectTrigger className="h-8 w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {zones.map((z) => (
                    <SelectItem key={z.id} value={z.id}>
                      {z.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Label className="w-32 text-xs text-muted-foreground">Shift hours</Label>
              <Input
                type="time"
                className="h-8 w-28"
                disabled={disabled}
                defaultValue={(t.shift_start_time ?? "").slice(0, 5)}
                onBlur={(e) => save(t.user_id, { shift_start_time: e.target.value || null })}
              />
              <span className="text-xs text-muted-foreground">to</span>
              <Input
                type="time"
                className="h-8 w-28"
                disabled={disabled}
                defaultValue={(t.shift_end_time ?? "").slice(0, 5)}
                onBlur={(e) => save(t.user_id, { shift_end_time: e.target.value || null })}
              />
              <span className="text-xs text-muted-foreground">
                {shiftLengthLabel(t.shift_start_time, t.shift_end_time) ??
                  "Falls back to the market default"}
              </span>
            </div>

            <ScopeRow
              label="Dispatch scope"
              hint="What gets pushed to them"
              whole={t.dispatch_whole_market}
              selected={t.dispatch_zone_ids}
              zones={zones}
              disabled={disabled}
              onWhole={(v) => save(t.user_id, { dispatch_whole_market: v })}
              onToggle={(id, on) =>
                save(t.user_id, { dispatch_zone_ids: toggleIn(t.dispatch_zone_ids, id, on) })
              }
            />
            <ScopeRow
              label="View scope"
              hint="What they can browse"
              whole={t.view_whole_market}
              selected={t.view_zone_ids}
              zones={zones}
              disabled={disabled}
              onWhole={(v) => save(t.user_id, { view_whole_market: v })}
              onToggle={(id, on) =>
                save(t.user_id, { view_zone_ids: toggleIn(t.view_zone_ids, id, on) })
              }
            />
          </div>
        ))}

        <div className="flex gap-2">
          <Select value={addUser} onValueChange={setAddUser}>
            <SelectTrigger className="h-8 w-64">
              <SelectValue placeholder="Add a chaser to this market" />
            </SelectTrigger>
            <SelectContent>
              {unassigned.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.full_name ?? "Unnamed"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={disabled || !addUser}
            onClick={async () => {
              const { error } = await supabase
                .from("chaser_territories")
                .insert({ user_id: addUser, market_id: marketId });
              if (error) return toastDbError(error, { action: "save territory" });
              setAddUser("");
              onChange();
            }}
          >
            <Plus className="mr-1 size-4" /> Add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          A chaser belongs to exactly one market. Assigning them here moves them.
        </p>
      </CardContent>
    </Card>
  );
}

function ScopeRow({
  label,
  hint,
  whole,
  selected,
  zones,
  disabled,
  onWhole,
  onToggle,
}: {
  label: string;
  hint: string;
  whole: boolean;
  selected: string[];
  zones: { id: string; name: string }[];
  disabled: boolean;
  onWhole: (v: boolean) => void;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <div className="w-32 shrink-0">
        <div className="font-medium">{label}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
      </div>
      <label className="flex items-center gap-1.5">
        <Checkbox
          checked={whole}
          disabled={disabled}
          onCheckedChange={(v) => onWhole(v === true)}
        />
        Whole market
      </label>
      {!whole &&
        zones.map((z) => (
          <label key={z.id} className="flex items-center gap-1.5">
            <Checkbox
              checked={selected.includes(z.id)}
              disabled={disabled}
              onCheckedChange={(v) => onToggle(z.id, v === true)}
            />
            {z.name}
          </label>
        ))}
    </div>
  );
}
