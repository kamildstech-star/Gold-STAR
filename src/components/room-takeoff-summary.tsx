import type { ReactNode } from "react";
import { Ruler } from "lucide-react";

import { FLOORING_NOT_RECORDED, type JobTakeoff, type TakeoffRoomInput } from "@/lib/room-takeoff";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The job's takeoffs at the top of the Rooms tab: what an estimator asks for
 * first (floor SF, wall SF, baseboard LF, door slabs, cabinet LF), the floor
 * area by covering, and — in a multi-unit building — the same per unit.
 *
 * It says how many rooms have no size yet. A total that quietly leaves out
 * the three rooms nobody measured reads as the whole job, and that is how an
 * estimate comes up a bedroom short.
 */
export function RoomTakeoffSummary<R extends TakeoffRoomInput>({
  takeoff,
  multiUnit,
  showParts,
  actions,
}: {
  takeoff: JobTakeoff<R>;
  multiUnit: boolean;
  /** Doors and cabinets exist on this database (migration 20261006140000). */
  showParts: boolean;
  /** Export buttons, from the tab — this card only shows numbers. */
  actions?: ReactNode;
}) {
  const t = takeoff.total;
  if (t.rooms === 0) return null;
  const flooring = Object.entries(t.flooringSf).sort((a, b) => b[1] - a[1]);
  // All "Not recorded" says nothing — it is what every room reads before the
  // flooring column exists, and before anyone has picked one.
  const showFlooring = flooring.some(([name]) => name !== FLOORING_NOT_RECORDED);

  return (
    <section className="space-y-2 rounded-md border p-3" aria-label="Takeoffs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Ruler className="size-4 text-muted-foreground" /> Takeoffs
          <span className="font-normal text-muted-foreground">
            · {t.rooms - t.unmeasured} of {t.rooms} room{t.rooms === 1 ? "" : "s"} measured
          </span>
        </h3>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
        <Figure label="Floor SF" value={t.floorSf} />
        <Figure label="Wall SF" value={t.wallSf} />
        <Figure label="Baseboard LF" value={t.baseboardLf} />
        {showParts && <Figure label="Door slabs" value={t.doorSlabs} />}
        {showParts && <Figure label="Cabinet LF" value={t.cabinetLfTotal} />}
      </div>

      {showFlooring && (
        <p className="text-xs text-muted-foreground">
          {flooring.map(([name, sf], i) => (
            <span key={name}>
              {i > 0 && " · "}
              {name} <span className="tabular-nums text-foreground">{fmt(sf)}</span> SF
            </span>
          ))}
        </p>
      )}

      {multiUnit && (
        <div className="-mx-3 overflow-x-auto md:max-h-[75svh] md:overflow-auto px-3">
          <table className="w-full min-w-[30rem] text-xs">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-1.5 pr-2 font-medium">Unit</th>
                <th className="px-2 text-right font-medium">Floor SF</th>
                <th className="px-2 text-right font-medium">Wall SF</th>
                <th className="px-2 text-right font-medium">Baseboard LF</th>
                {showParts && <th className="px-2 text-right font-medium">Door slabs</th>}
                {showParts && <th className="pl-2 text-right font-medium">Cabinet LF</th>}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {takeoff.units.map((u) => (
                <tr key={u.label ?? "__no_unit__"} className="border-b last:border-b-0">
                  <td className="py-1.5 pr-2">
                    {u.label ?? "No unit"}
                    {u.unmeasured > 0 && (
                      <span className="text-muted-foreground"> · {u.unmeasured} unmeasured</span>
                    )}
                  </td>
                  <td className="px-2 text-right">{fmt(u.floorSf)}</td>
                  <td className="px-2 text-right">{fmt(u.wallSf)}</td>
                  <td className="px-2 text-right">{fmt(u.baseboardLf)}</td>
                  {showParts && <td className="px-2 text-right">{fmt(u.doorSlabs)}</td>}
                  {showParts && <td className="pl-2 text-right">{fmt(u.cabinetLfTotal)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border bg-card px-2 py-1.5 text-center">
      <div className="text-base font-semibold tabular-nums">{fmt(value)}</div>
      <div className="text-[11px] leading-tight text-muted-foreground">{label}</div>
    </div>
  );
}
