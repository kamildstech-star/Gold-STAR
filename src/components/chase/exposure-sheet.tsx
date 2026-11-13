import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Check, CloudOff, Plus, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { actionErrorMessage } from "@/lib/db-errors";
import { resolveNeighbourAddresses } from "@/lib/exposures.functions";
import {
  BUILDING_TYPE_LABEL,
  createExposure,
  undoExposure,
  type BuildingType,
} from "@/lib/exposures";
import type { Incident } from "@/lib/incidents";

const TYPES: BuildingType[] = ["multi_family", "row_house", "semi_detached", "detached"];

/** The building type carried on the incident, when it is one we understand. */
function inferBuildingType(incident: Incident): BuildingType | null {
  const raw = (incident.building_type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  const hit = TYPES.find((t) => raw.includes(t) || t.includes(raw));
  if (hit) return hit;
  if (raw.includes("apartment") || raw.includes("multi") || raw.includes("unit"))
    return "multi_family";
  if (raw.includes("attached") || raw.includes("row") || raw.includes("terrace"))
    return "row_house";
  return null;
}

type Added = { key: string; address: string; incidentId: string | null; queued: boolean };

/**
 * Add a damaged neighbor. Real addresses either side of the fire, laid out by
 * proximity, big enough to hit one-handed in the dark. A tap creates the lead
 * immediately — no confirm step, no typing. Typing is the override at the
 * bottom, for corner lots, rear buildings and bad numbering.
 */
export function ExposureSheet({
  open,
  onOpenChange,
  incident,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  incident: Incident;
  onCreated: () => void;
}) {
  const inferred = useMemo(() => inferBuildingType(incident), [incident]);
  const [buildingType, setBuildingType] = useState<BuildingType | null>(inferred);
  const [manual, setManual] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Added[]>([]);
  const resolve = useServerFn(resolveNeighbourAddresses);

  useEffect(() => {
    if (open) setBuildingType(inferred);
  }, [open, inferred]);

  const neighboursQ = useQuery({
    enabled: open,
    queryKey: ["chase", "neighbours", incident.id, buildingType],
    queryFn: () =>
      resolve({
        data: {
          address: incident.address ?? "",
          lat: incident.lat,
          lon: incident.lon,
          buildingType,
        },
      }),
  });

  const street = neighboursQ.data?.street ?? "";
  const failed = !!neighboursQ.data && !neighboursQ.data.resolved && !neighboursQ.isFetching;
  const derived = neighboursQ.data?.provider === "derived";

  // Nothing resolvable: drop straight into manual entry, street prefilled.
  useEffect(() => {
    if (failed && !manualOpen) {
      setManualOpen(true);
      setManual((v) => (v ? v : street ? ` ${street}` : ""));
    }
  }, [failed, manualOpen, street]);

  const addedKeys = new Set(added.map((a) => a.key));

  const add = async (address: string, lat?: number | null, lon?: number | null) => {
    const clean = address.trim();
    if (clean.length < 4) return;
    const key = clean.toLowerCase();
    if (addedKeys.has(key)) return;
    setBusy(true);
    try {
      const res = await createExposure({
        originIncidentId: incident.id,
        address: clean,
        lat,
        lon,
        postalCode: incident.postal_code,
        buildingType,
      });
      setAdded((prev) => [
        ...prev,
        { key, address: clean, incidentId: res.id, queued: res.queued },
      ]);
      setManual("");
      onCreated();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Could not add the exposure"));
    } finally {
      setBusy(false);
    }
  };

  const undo = async (item: Added) => {
    try {
      if (item.incidentId) await undoExposure(item.incidentId);
      setAdded((prev) => prev.filter((a) => a.key !== item.key));
      onCreated();
    } catch (e) {
      toast.error(actionErrorMessage(e, "Could not undo — the lead is already in play"));
    }
  };

  const all = neighboursQ.data?.neighbours ?? [];
  const units = all.filter((n) => n.tier === "unit");
  const immediate = all.filter((n) => n.tier === "immediate");
  const next = all.filter((n) => n.tier === "next");
  const across = all.filter((n) => n.tier === "across");

  const shortOf = (a: string) => a.split(",")[0];

  const TapBox = ({
    address,
    label,
    lat,
    lon,
    size,
  }: {
    address: string;
    label?: string;
    lat: number | null;
    lon: number | null;
    size: "lg" | "sm";
  }) => {
    const done = addedKeys.has(address.trim().toLowerCase());
    return (
      <button
        type="button"
        disabled={busy || done}
        onClick={() => void add(address, lat, lon)}
        className={
          "flex w-full flex-col items-start justify-center gap-1 rounded-lg border px-3 text-left transition-colors " +
          (size === "lg" ? "min-h-24 py-3" : "min-h-16 py-2.5") +
          (done ? " border-primary bg-primary/10" : " active:bg-accent disabled:opacity-60")
        }
      >
        <span
          className={"font-bold leading-tight " + (size === "lg" ? "text-[18px]" : "text-[15px]")}
        >
          {shortOf(address)}
        </span>
        <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
          {done ? <Check className="size-3 text-primary" /> : null}
          {done ? "Added" : label}
        </span>
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a damaged neighbor</DialogTitle>
          <DialogDescription>
            Tap an address — the lead is created straight away, with its own homeowner, contract and
            job. Nothing you do on it changes the others.
          </DialogDescription>
        </DialogHeader>

        {/* Only asked when the property data doesn't already tell us. */}
        {!inferred && (
          <div className="space-y-1.5 rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              What kind of building?
            </p>
            <div className="flex flex-wrap gap-1.5">
              {TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setBuildingType(buildingType === t ? null : t)}
                  className={
                    "min-h-9 rounded-full border px-3 py-1 text-[13px] " +
                    (buildingType === t
                      ? "border-primary bg-primary/10 font-semibold text-primary"
                      : "text-muted-foreground")
                  }
                >
                  {BUILDING_TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        )}

        {neighboursQ.isLoading && (
          <p className="text-[13px] text-muted-foreground">Finding the neighboring addresses…</p>
        )}

        {units.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Other units in this building
            </p>
            <div className="grid grid-cols-2 gap-2">
              {units.map((n) => (
                <TapBox key={n.address} {...n} size="lg" />
              ))}
            </div>
          </div>
        )}

        {immediate.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {immediate.map((n) => (
              <TapBox key={n.address} {...n} size="lg" />
            ))}
          </div>
        )}

        {next.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {next.map((n) => (
              <TapBox key={n.address} {...n} size="sm" />
            ))}
          </div>
        )}

        {across.length > 0 && (
          <div className="space-y-2">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Across the street
            </p>
            <div className="grid grid-cols-2 gap-2">
              {across.map((n) => (
                <TapBox key={n.address} {...n} size="sm" />
              ))}
            </div>
          </div>
        )}

        {derived && all.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            Numbers worked out from the fire address — check the door before you knock.
          </p>
        )}

        {neighboursQ.data?.refused && (
          <p className="text-[11px] text-muted-foreground">{neighboursQ.data.refused}</p>
        )}

        {/* What has just been added, each with an undo. */}
        {added.length > 0 && (
          <div className="space-y-1.5 border-t pt-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Added ({added.length})
            </p>
            {added.map((a) => (
              <div key={a.key} className="flex items-center justify-between gap-2 text-[13px]">
                <span className="flex min-w-0 items-center gap-1.5">
                  {a.queued ? (
                    <CloudOff className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <Check className="size-3.5 shrink-0 text-primary" />
                  )}
                  <span className="truncate">{shortOf(a.address)}</span>
                  {a.queued && (
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      queued — sends when you have signal
                    </span>
                  )}
                </span>
                <Button variant="ghost" size="sm" className="h-9" onClick={() => void undo(a)}>
                  <Undo2 className="mr-1 size-3.5" />
                  Undo
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Manual override, always available, at the bottom. */}
        <div className="space-y-2 border-t pt-3">
          {!manualOpen ? (
            <button
              type="button"
              className="min-h-11 text-[14px] font-medium underline"
              onClick={() => {
                setManualOpen(true);
                setManual((v) => (v ? v : street ? ` ${street}` : ""));
              }}
            >
              Enter address manually
            </button>
          ) : (
            <>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {street ? "Type the house number" : "Enter address manually"}
              </label>
              <div className="flex gap-2">
                <Input
                  value={manual}
                  onChange={(e) => setManual(e.target.value)}
                  placeholder="Address"
                  className="h-12 text-[16px]"
                  autoFocus
                />
                <Button
                  className="h-12 px-5"
                  disabled={busy || manual.trim().length < 4}
                  onClick={() => void add(manual)}
                >
                  <Plus className="size-5" />
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
