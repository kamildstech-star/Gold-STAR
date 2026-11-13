/**
 * The job's Property card on the General tab (David, 21 Oct).
 *
 * - Whose job it is, in one small line at the top, so anybody opening the
 *   job can tell at a glance.
 * - The address, with "Correct address": a mistyped address is fixed here
 *   instead of deleting and remaking the job. See job-address-correction.ts
 *   for what follows the correction (map pin, property note, audit).
 * - Facility, building and community names — all optional.
 */
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ExternalLink, MapPin, Pencil, User } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { JobField, type JobRecordLike } from "@/components/job-inline-field";
import { LiveMap } from "@/components/live-map";
import { MapsLink } from "@/components/maps-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AddressSuggestion } from "@/lib/address.functions";
import { geocodeAddresses } from "@/lib/geocode.functions";
import {
  addressCorrectionPatch,
  carryPropertyNote,
  cleanAddressDraft,
  geocodeLine,
  placeChanged,
  type AddressDraft,
  type Coords,
} from "@/lib/job-address-correction";
import { updateJobFields } from "@/lib/job-update";

export type PropertyJob = JobRecordLike & {
  id: string;
  address: string;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  county: string | null;
  location_id: string;
  customer_name: string | null;
  community: string | null;
  building_name?: string | null;
  facility_name?: string | null;
  /** The geocoded pin; null until the address has been placed. */
  lat?: number | null;
  lon?: number | null;
};

const draftOf = (j: PropertyJob): AddressDraft => ({
  address: j.address ?? "",
  address_line2: j.address_line2,
  locality: j.locality,
  region: j.region,
  postal_code: j.postal_code,
  county: j.county,
});

/** "Kings County", never "Kings County County" — the field may already say it. */
export function countyLabel(county: string): string {
  const c = county.trim();
  return /\bcounty$/i.test(c) ? c : `${c} County`;
}

/** "Customer: …" — the line both the header and this card show. */
export function customerLine(job: { customer_name: string | null }, accountName?: string | null) {
  const name = job.customer_name?.trim() || accountName?.trim() || null;
  return name;
}

/** "Facility / Building / Community", empty parts left out. */
export function siteNamesLine(
  job: Pick<PropertyJob, "facility_name" | "building_name" | "community">,
): string {
  return [job.facility_name, job.building_name, job.community]
    .map((v) => (v ?? "").trim())
    .filter(Boolean)
    .join(" / ");
}

export function JobPropertyCard({
  job,
  accountName,
  onSaved,
  editOpen,
  onEditOpenChange,
  headerExtra,
  siteExtra,
  siteEditing = false,
  children,
}: {
  job: PropertyJob;
  accountName?: string | null;
  onSaved: () => void;
  /** Controlled from the page, so the header's pencil opens the same dialog. */
  editOpen: boolean;
  onEditOpenChange: (open: boolean) => void;
  /** Beside "Correct address" — the page's edit-all toggle for what follows. */
  headerExtra?: React.ReactNode;
  /** Under the site names, beside the address — the date of loss (David, 27 Oct). */
  siteExtra?: React.ReactNode;
  /** The page's Edit all is on: show facility, building and community as three fields. */
  siteEditing?: boolean;
  /**
   * Below the address and site names: the intake details (questionnaire, date
   * of loss, date and time reported, referral) — David, 23 Oct: one "Site
   * Info" card instead of separate Property and Intake cards.
   */
  children?: React.ReactNode;
}) {
  const app = useAppContext();
  const customer = customerLine(job, accountName);
  // `select("*")` returns the site-name columns once 20261021120000 is applied.
  const siteColumns = "building_name" in job || "facility_name" in job;
  const cityLine = [job.locality, [job.region, job.postal_code].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return (
    <Card className="h-full" data-job-property>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
        <CardTitle className="text-base">Site Info</CardTitle>
        <div className="flex items-center gap-1">{headerExtra}</div>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/*
         * 3 Nov mock-up: the map leads, full width, with Open in Maps on it;
         * under it the address and Correct address; then the site names in
         * their own box; then the fields. Nothing dropped — the address, the
         * customer line and the county are all still here.
         */}
        <div className="space-y-2.5">
          <PropertyMap job={job} />
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-2">
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                {customer ? (
                  <div
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                    data-property-customer
                  >
                    <User className="size-3" aria-hidden />
                    <span className="truncate">{customer}</span>
                  </div>
                ) : null}
                <div className="font-medium">
                  {job.address}
                  {job.address_line2 ? `, ${job.address_line2}` : ""}
                </div>
                {cityLine ? <div className="text-muted-foreground">{cityLine}</div> : null}
                {job.county ? (
                  <div className="text-xs text-muted-foreground">{countyLabel(job.county)}</div>
                ) : null}
              </div>
            </div>
            <Button
              size="sm"
              variant="link"
              className="h-auto shrink-0 px-0 py-0.5 text-[13px]"
              disabled={app.writesDisabled}
              onClick={() => onEditOpenChange(true)}
            >
              <Pencil className="size-3.5" />
              Correct address
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          {siteColumns && siteEditing ? (
            <>
              <JobField job={job} fieldKey="facility_name" onSaved={onSaved} />
              <JobField job={job} fieldKey="building_name" onSaved={onSaved} />
              <JobField job={job} fieldKey="community" onSaved={onSaved} />
            </>
          ) : siteColumns ? (
            /*
             * David, 27 Oct: facility, building and community on ONE line,
             * slash-separated. Display only — Edit all opens the three
             * fields. Empty parts are left out, so no dangling slashes.
             */
            <div className="rounded-lg border bg-muted/40 px-3.5 py-3" data-site-names>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Facility / Building / Community
              </div>
              <div className="mt-1 break-words text-[15px] font-semibold">
                {siteNamesLine(job) || "—"}
              </div>
            </div>
          ) : (
            <>
              <JobField job={job} fieldKey="community" onSaved={onSaved} />
              <p className="text-xs text-muted-foreground">
                Building and facility names arrive with the next database update.
              </p>
            </>
          )}
          {siteExtra}
        </div>

        {children ? <div className="space-y-1 pt-1">{children}</div> : null}
      </CardContent>

      <CorrectAddressDialog
        job={job}
        open={editOpen}
        onOpenChange={onEditOpenChange}
        onSaved={onSaved}
      />
    </Card>
  );
}

/**
 * The property on a map (27 Oct). The same Google basemap the rest of the app
 * uses, one pin, and "Open in Maps" for directions. A job whose address has
 * not been placed yet says so rather than showing an empty frame.
 */
function PropertyMap({ job }: { job: PropertyJob }) {
  const lat = job.lat ?? null;
  const lon = job.lon ?? null;
  const placed = lat != null && lon != null && Number.isFinite(lat) && Number.isFinite(lon);
  const line = [job.address, job.locality, job.region, job.postal_code].filter(Boolean).join(", ");
  /* `isolate`: the map's own z-indexes (Leaflet's panes, the button's 400)
     stay inside this box instead of showing through dialogs. */
  return (
    <div className="relative isolate min-w-0 overflow-hidden rounded-lg border" data-property-map>
      {placed ? (
        <LiveMap
          markers={[{ id: job.id, lat, lon, label: job.address }]}
          center={{ lat, lon }}
          height={200}
          maxFitZoom={16}
        />
      ) : (
        <div className="flex h-[200px] items-center justify-center border-dashed bg-muted/30 px-4 pb-10 text-center text-xs text-muted-foreground">
          No map pin yet — use Correct address to place this property.
        </div>
      )}
      <MapsLink
        query={placed ? { lat, lon } : line}
        className="absolute bottom-2.5 left-2.5 z-[400] inline-flex h-8 items-center gap-1.5 rounded-md border bg-card px-3 text-[13px] font-medium text-foreground shadow-[0_2px_6px_rgb(16_24_40_/_0.14)] hover:bg-muted"
      >
        <ExternalLink className="size-3.5" aria-hidden />
        Open in Maps
      </MapsLink>
    </div>
  );
}

function CorrectAddressDialog({
  job,
  open,
  onOpenChange,
  onSaved,
}: {
  job: PropertyJob;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const geocode = useServerFn(geocodeAddresses);
  const [draft, setDraft] = useState<AddressDraft>(() => draftOf(job));
  /** The suggestion picked, while the street still reads as it did. */
  const [picked, setPicked] = useState<(Coords & { address: string }) | null>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setDraft(draftOf(job));
    setPicked(null);
  };

  const set = (k: keyof AddressDraft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const pick = (s: AddressSuggestion) => {
    setDraft((d) => ({
      address: s.address,
      address_line2: s.unit ?? d.address_line2,
      locality: s.locality ?? d.locality,
      region: s.region ?? d.region,
      postal_code: s.postal_code ?? d.postal_code,
      county: s.county ?? d.county,
    }));
    setPicked(
      s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon, address: s.address } : null,
    );
  };

  const save = async () => {
    const before = draftOf(job);
    const after = cleanAddressDraft(draft);
    if (!after.address) return toast.error("A street address is required.");
    setSaving(true);
    try {
      let coords: Coords | null = null;
      let located: "picked" | "found" | "none" | "kept" = "kept";
      if (placeChanged(before, after)) {
        if (picked && picked.address.trim() === after.address) {
          coords = { lat: picked.lat, lon: picked.lon };
          located = "picked";
        } else {
          try {
            const res = await geocode({ data: { addresses: [geocodeLine(after)], maxNew: 1 } });
            const hit = res.rows.find((r) => r.resolved && r.lat != null && r.lon != null);
            if (hit) {
              coords = { lat: Number(hit.lat), lon: Number(hit.lon) };
              located = "found";
            } else located = "none";
          } catch {
            located = "none";
          }
        }
      }
      const patch = addressCorrectionPatch(before, after, coords);
      if (!Object.keys(patch).length) {
        onOpenChange(false);
        return;
      }
      const ok = await updateJobFields(job.id, patch);
      if (!ok) return;
      let carried = false;
      if (patch.address !== undefined) {
        carried = await carryPropertyNote({
          from: before.address,
          to: after.address,
          userId: app.userId ?? null,
          locationId: job.location_id,
        }).catch(() => false);
      }
      toast.success("Address corrected", {
        description: [
          located === "picked" || located === "found"
            ? "The map position moved with it."
            : located === "none"
              ? "The new address could not be placed on the map, so the old pin was cleared."
              : null,
          carried ? "The property note came across to the corrected address." : null,
          "The change is in History and can be reverted.",
        ]
          .filter(Boolean)
          .join(" "),
      });
      onOpenChange(false);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Correct the address</DialogTitle>
          <DialogDescription className="text-xs">
            Fixes a mistyped address on this job — no need to delete and remake it. The map position
            and the property note follow the correction.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <AddressAutocomplete
            id="job-address-correct"
            label="Street address"
            value={draft.address}
            onValueChange={(v) => {
              set("address")(v);
              if (picked && v.trim() !== picked.address.trim()) setPicked(null);
            }}
            onSelect={pick}
          />
          <div className="grid gap-1.5">
            <Label htmlFor="job-address-unit">Unit / floor</Label>
            <Input
              id="job-address-unit"
              value={draft.address_line2 ?? ""}
              onChange={(e) => set("address_line2")(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input
              aria-label="City"
              placeholder="City"
              value={draft.locality ?? ""}
              onChange={(e) => set("locality")(e.target.value)}
            />
            <Input
              aria-label="State"
              placeholder="State"
              value={draft.region ?? ""}
              onChange={(e) => set("region")(e.target.value)}
            />
            <Input
              aria-label="Zip"
              placeholder="Zip"
              value={draft.postal_code ?? ""}
              onChange={(e) => set("postal_code")(e.target.value)}
            />
            <Input
              aria-label="County"
              placeholder="County"
              value={draft.county ?? ""}
              onChange={(e) => set("county")(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || app.writesDisabled}>
            {saving ? "Saving…" : "Save address"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
