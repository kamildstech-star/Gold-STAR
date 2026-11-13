import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Loader2, MapPin, Plus, Save } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { OfficeGroupsAdmin } from "@/components/office-groups-admin";
import { adminGeocode } from "@/lib/admin.functions";
import { missingBillingDetails } from "@/lib/billing-entity";

export const Route = createFileRoute("/_authenticated/admin/locations")({
  component: LocationsAdmin,
});

type Loc = {
  id: string;
  code: string;
  name: string;
  address: string;
  locality: string | null;
  region: string;
  postal_code: string | null;
  lat: number;
  lon: number;
  active: boolean;
  region_id: string | null;
  office_phone: string | null;
  office_email: string | null;
  manager_name: string | null;
  manager_extension: string | null;
  manager_mobile: string | null;
  manager_email: string | null;
  /* Printed on the estimate and invoice PDFs. */
  legal_entity_name: string | null;
  ein: string | null;
  payment_options_text: string | null;
  card_payment_url: string | null;
  zelle_email: string | null;
  card_payments_offered: boolean | null;
  logo_url: string | null;
};

function LocationsAdmin() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Loc | null>(null);
  const [creating, setCreating] = useState(false);

  const locsQ = useQuery({
    queryKey: ["admin-locations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations")
        .select(
          "id, code, name, address, locality, region, postal_code, lat, lon, active, region_id, office_phone, office_email, manager_name, manager_extension, manager_mobile, manager_email, legal_entity_name, ein, payment_options_text, card_payment_url, zelle_email, card_payments_offered, logo_url",
        )

        .order("code");
      if (error) throw error;
      return (data ?? []) as Loc[];
    },
  });

  const locRegionsQ = useQuery({
    queryKey: ["admin-location-regions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("location_regions")
        .select("location_id, region_id");
      if (error) throw error;
      return data ?? [];
    },
  });

  const regionsQ = useQuery({
    queryKey: ["admin-locations-regions"],
    queryFn: async () => {
      const { data, error } = await supabase.from("regions").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["admin-locations"] });
    qc.invalidateQueries({ queryKey: ["admin-location-regions"] });
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{locsQ.data?.length ?? 0} configured</p>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-2 size-4" /> New location
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Code</th>
                  <th className="px-3 py-2 font-medium">Name</th>
                  <th className="px-3 py-2 font-medium">Address</th>
                  <th className="px-3 py-2 font-medium">Region</th>
                  <th className="px-3 py-2 font-medium">Manager</th>
                  <th className="px-3 py-2 font-medium">Billing</th>

                  <th className="px-3 py-2 text-right font-medium">Lat / Lon</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {locsQ.isError ? (
                  <tr>
                    <td colSpan={8} className="p-3 text-center text-destructive">
                      Locations could not be loaded — this is not &ldquo;no locations exist&rdquo;.
                      Reload before adding one.
                    </td>
                  </tr>
                ) : locsQ.isLoading ? (
                  <tr>
                    <td colSpan={8} className="p-3 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : (
                  (locsQ.data ?? []).map((l) => {
                    const linked = (locRegionsQ.data ?? [])
                      .filter((lr) => lr.location_id === l.id)
                      .map((lr) => lr.region_id);
                    const regionIds = linked.length ? linked : l.region_id ? [l.region_id] : [];
                    const region =
                      regionIds.length === 0
                        ? undefined
                        : {
                            name: regionIds
                              .map((rid) => regionsQ.data?.find((r) => r.id === rid)?.name)
                              .filter(Boolean)
                              .join(", "),
                          };
                    return (
                      <tr
                        key={l.id}
                        className="cursor-pointer border-t transition-colors hover:bg-accent/40"
                        onClick={() => setEditing(l)}
                      >
                        <td className="px-3 py-2 font-mono">{l.code}</td>
                        <td className="px-3 py-2 font-medium">{l.name}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {l.address}
                          {l.locality ? `, ${l.locality}` : ""}, {l.region} {l.postal_code}
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">{region?.name ?? "—"}</td>
                        <td className="px-3 py-2">
                          {l.manager_name ? (
                            <div className="leading-tight">
                              <div className="font-medium">{l.manager_name}</div>
                              <div className="text-xs tabular-nums text-muted-foreground">
                                {l.manager_mobile ?? l.office_phone ?? "—"}
                                {l.manager_extension ? ` · x${l.manager_extension}` : ""}
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          {(() => {
                            const missing = missingBillingDetails(l);
                            if (missing.length === 0) {
                              return <Badge className="bg-success/15 text-success">Complete</Badge>;
                            }
                            return (
                              <div className="leading-tight">
                                <Badge className="bg-warning/15 text-warning">
                                  Billing details missing
                                </Badge>
                                <div className="mt-1 text-xs text-muted-foreground">
                                  No {missing.join(" · no ")}
                                </div>
                              </div>
                            );
                          })()}
                        </td>

                        <td className="px-3 py-2 text-right font-mono text-xs text-muted-foreground">
                          {l.lat.toFixed(4)}, {l.lon.toFixed(4)}
                        </td>
                        <td className="px-3 py-2">
                          {l.active ? (
                            <Badge className="bg-success/15 text-success">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Disabled</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="border-t pt-4">
        <OfficeGroupsAdmin />
      </div>

      <LocationEditor
        loc={editing}
        regions={regionsQ.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={invalidate}
      />
      <LocationEditor
        loc={creating ? EMPTY : null}
        regions={regionsQ.data ?? []}
        onClose={() => setCreating(false)}
        onSaved={invalidate}
        isNew
      />
    </div>
  );
}

const EMPTY: Loc = {
  id: "",
  code: "",
  name: "",
  address: "",
  locality: "",
  region: "",
  postal_code: "",
  lat: 40.68,
  lon: -73.94,
  active: true,
  region_id: null,
  office_phone: "",
  office_email: "",
  manager_name: "",
  manager_extension: "",
  manager_mobile: "",
  manager_email: "",
  legal_entity_name: "",
  ein: "",
  payment_options_text: "",
  card_payment_url: "",
  zelle_email: "",
  card_payments_offered: true,
  logo_url: "",
};

function LocationEditor({
  loc,
  regions,
  onClose,
  onSaved,
  isNew,
}: {
  loc: Loc | null;
  regions: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
  isNew?: boolean;
}) {
  const geocode = useServerFn(adminGeocode);
  const [form, setForm] = useState<Loc | null>(loc);
  const [geoLoading, setGeoLoading] = useState(false);
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  if (loc && loadedFor !== loc.id) {
    setLoadedFor(loc.id);
    setRegionIds([]);
    if (!isNew) {
      void supabase
        .from("location_regions")
        .select("region_id")
        .eq("location_id", loc.id)
        .then(({ data }) => setRegionIds((data ?? []).map((d) => d.region_id)));
    }
  }

  // reset when loc changes
  if (loc && form?.id !== loc.id && !isNew) {
    setForm(loc);
  }
  if (loc && !form && isNew) {
    setForm(loc);
  }

  const save = useMutation({
    mutationFn: async () => {
      if (!form) return;
      const payload = {
        code: form.code.trim(),
        name: form.name.trim(),
        address: form.address.trim(),
        locality: form.locality || null,
        region: form.region.trim(),
        postal_code: form.postal_code || null,
        lat: form.lat,
        lon: form.lon,
        active: form.active,
        office_phone: form.office_phone || null,
        office_email: form.office_email || null,
        manager_name: form.manager_name || null,
        manager_extension: form.manager_extension || null,
        manager_mobile: form.manager_mobile || null,
        manager_email: form.manager_email || null,
        legal_entity_name: form.legal_entity_name || null,
        ein: form.ein || null,
        payment_options_text: form.payment_options_text || null,
        card_payment_url: form.card_payment_url || null,
        zelle_email: form.zelle_email || null,
        card_payments_offered: form.card_payments_offered !== false,
        logo_url: form.logo_url || null,
      };
      let locationId = form.id;
      if (isNew) {
        const { data, error } = await supabase
          .from("locations")
          .insert(payload)
          .select("id")
          .single();
        if (error) throw error;
        locationId = data.id;
      } else {
        const { error } = await supabase.from("locations").update(payload).eq("id", form.id);
        if (error) throw error;
      }
      const { data: current, error: curErr } = await supabase
        .from("location_regions")
        .select("region_id")
        .eq("location_id", locationId);
      if (curErr) throw curErr;
      const have = (current ?? []).map((c) => c.region_id);
      const toAdd = regionIds.filter((r) => !have.includes(r));
      const toRemove = have.filter((r) => !regionIds.includes(r));
      if (toAdd.length) {
        const { error } = await supabase
          .from("location_regions")
          .insert(toAdd.map((region_id) => ({ location_id: locationId, region_id })));
        if (error) throw error;
      }
      if (toRemove.length) {
        const { error } = await supabase
          .from("location_regions")
          .delete()
          .eq("location_id", locationId)
          .in("region_id", toRemove);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success(isNew ? "Location created" : "Location saved");
      onSaved();
      onClose();
      setForm(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const runGeocode = async () => {
    if (!form) return;
    setGeoLoading(true);
    try {
      const parts = [form.address, form.locality, form.region, form.postal_code]
        .filter(Boolean)
        .join(",");
      const res = await geocode({ data: { address: parts } });
      if (!res) {
        toast.error("No match found");
        return;
      }
      setForm({ ...form, lat: res.lat, lon: res.lon });
      toast.success(`Matched: ${res.display_name}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGeoLoading(false);
    }
  };

  const open = !!loc;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          onClose();
          setForm(null);
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isNew ? "New location" : form?.name || "Edit location"}</DialogTitle>
        </DialogHeader>
        {form && (
          <div className="grid gap-3">
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <div className="space-y-1">
                <Label>Code</Label>
                <Input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                  placeholder="NY"
                  maxLength={8}
                />
              </div>
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Street address</Label>
              <Input
                value={form.address}
                onChange={(e) => setForm({ ...form, address: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label>City</Label>
                <Input
                  value={form.locality ?? ""}
                  onChange={(e) => setForm({ ...form, locality: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>State</Label>
                <Input
                  value={form.region}
                  onChange={(e) => setForm({ ...form, region: e.target.value })}
                  maxLength={4}
                />
              </div>
              <div className="space-y-1">
                <Label>ZIP</Label>
                <Input
                  value={form.postal_code ?? ""}
                  onChange={(e) => setForm({ ...form, postal_code: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Regions</Label>
              <div className="flex flex-wrap gap-1.5">
                {regions.length === 0 && (
                  <span className="text-xs text-muted-foreground">No regions defined</span>
                )}
                {regions.map((r) => {
                  const on = regionIds.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() =>
                        setRegionIds(
                          on ? regionIds.filter((x) => x !== r.id) : [...regionIds, r.id],
                        )
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
              <p className="text-xs text-muted-foreground">
                An office can belong to any number of regions.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>Office phone</Label>
                <Input
                  value={form.office_phone ?? ""}
                  onChange={(e) => setForm({ ...form, office_phone: e.target.value })}
                  placeholder="(718) 555-0100"
                />
              </div>
              <div className="space-y-1">
                <Label>Office email</Label>
                <Input
                  type="email"
                  value={form.office_email ?? ""}
                  onChange={(e) => setForm({ ...form, office_email: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Manager name</Label>
                <Input
                  value={form.manager_name ?? ""}
                  onChange={(e) => setForm({ ...form, manager_name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Manager extension</Label>
                <Input
                  value={form.manager_extension ?? ""}
                  onChange={(e) => setForm({ ...form, manager_extension: e.target.value })}
                  placeholder="204"
                />
              </div>
              <div className="space-y-1">
                <Label>Manager mobile</Label>
                <Input
                  value={form.manager_mobile ?? ""}
                  onChange={(e) => setForm({ ...form, manager_mobile: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Manager email</Label>
                <Input
                  type="email"
                  value={form.manager_email ?? ""}
                  onChange={(e) => setForm({ ...form, manager_email: e.target.value })}
                />
              </div>
            </div>

            {/* Document identity — everything below prints on the estimate
                and invoice PDFs for jobs at this office. */}
            <div className="rounded-md border p-3 space-y-3">
              <div className="space-y-0.5">
                <p className="text-xs font-medium text-muted-foreground">
                  Printed documents &amp; billing identity
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Used on invoices, contracts, estimates and customer emails for every job billed to
                  this office — editing the EIN or a payment link changes what customers receive.
                </p>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Legal entity name</Label>
                  <Input
                    placeholder="Gold Star Restoration LLC-CA"
                    value={form.legal_entity_name ?? ""}
                    onChange={(e) => setForm({ ...form, legal_entity_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>EIN</Label>
                  <Input
                    className="font-mono"
                    value={form.ein ?? ""}
                    onChange={(e) => setForm({ ...form, ein: e.target.value })}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label>Payment options text</Label>
                <Textarea
                  rows={3}
                  value={form.payment_options_text ?? ""}
                  onChange={(e) => setForm({ ...form, payment_options_text: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Card payment URL</Label>
                  <Input
                    value={form.card_payment_url ?? ""}
                    onChange={(e) => setForm({ ...form, card_payment_url: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Zelle / QuickPay email</Label>
                  <Input
                    value={form.zelle_email ?? ""}
                    onChange={(e) => setForm({ ...form, zelle_email: e.target.value })}
                    placeholder="HeshyL@GoldStarRestoration.com"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Logo URL</Label>
                  <Input
                    value={form.logo_url ?? ""}
                    onChange={(e) => setForm({ ...form, logo_url: e.target.value })}
                  />
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={form.card_payments_offered !== false}
                  onChange={(e) => setForm({ ...form, card_payments_offered: e.target.checked })}
                />
                <span>
                  This office offers card payments
                  <span className="block text-xs text-muted-foreground">
                    Untick where cards are not accepted — the card bullet is then dropped from
                    emails and invoices instead of being flagged as missing.
                  </span>
                </span>
              </label>
              {missingBillingDetails(form).length > 0 ? (
                <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning">
                  Billing details missing: no {missingBillingDetails(form).join(" · no ")}.
                </p>
              ) : null}
            </div>

            <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
              <div className="space-y-1">
                <Label>Lat</Label>
                <Input
                  type="number"
                  step="0.000001"
                  value={form.lat}
                  onChange={(e) => setForm({ ...form, lat: Number(e.target.value) })}
                  className="font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label>Lon</Label>
                <Input
                  type="number"
                  step="0.000001"
                  value={form.lon}
                  onChange={(e) => setForm({ ...form, lon: Number(e.target.value) })}
                  className="font-mono"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={runGeocode}
                disabled={geoLoading || !form.address}
              >
                {geoLoading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <MapPin className="size-4" />
                )}
                <span className="ml-1">Geocode</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Uses OpenStreetMap Nominatim. Verify the result — the geocoder is free and
              occasionally imprecise for suite/building addresses.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button
            onClick={() => save.mutate()}
            disabled={
              !form || !form.code || !form.name || !form.address || !form.region || save.isPending
            }
          >
            <Save className="mr-2 size-4" /> Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
