import { useMemo, useState, type FocusEvent } from "react";
import { AlertTriangle, Plus, Ruler, Scissors } from "lucide-react";
import { toast } from "sonner";

import { useLabelLanguage } from "@/components/bilingual";
import { RoomSelectItems } from "@/components/room-select-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MOISTURE_MATERIALS,
  MOISTURE_MATERIAL_LABEL,
  dryGoal,
  materialStatus,
  parseMoisturePct,
  summarizePoint,
  type MaterialStatus,
  type MoisturePoint,
  type MoistureReading,
} from "@/lib/drying-materials";
import {
  patchMoisturePoint,
  writeMoisturePoint,
  writeMoistureReading,
  type MoisturePointRow,
  type MoistureReadingRow,
} from "@/lib/drying-materials-data";
import { roomLabel, type JobRoom } from "@/lib/job-rooms";
import { newId, writeOrQueue } from "@/lib/offline-queue";
import { cn } from "@/lib/utils";

/**
 * Fixed material test points — the drawer under the day's readings.
 *
 * Heshy Landau's checklist (1 Sep, via David): per room, fixed points on the
 * structural materials, a Dry Standard for each, and a moisture reading every
 * day until the standard is met. The verdicts are src/lib/drying-materials.ts;
 * the tables are 20260928161000.
 *
 * Collapsed like the dehumidifier drawer, because the daily air readings are
 * the walk every tech does and this is the second, slower one with a pin
 * meter. Inside it the day's job is one box per point — the points were set up
 * once, on day one, and after that a tech only reads the numbers into them.
 *
 * Every write — a new point, a reading, a dry standard set later, material cut
 * out — goes through the offline queue. A point made in a basement is kept on
 * screen straight away so its first reading can be typed into it; the reading
 * queues behind the point and drains after it.
 */

const STATUS_TEXT: Record<MaterialStatus, { en: string; es: string }> = {
  dry: { en: "Dry", es: "Seco" },
  wet: { en: "Wet", es: "Mojado" },
  no_standard: { en: "No dry standard", es: "Sin estándar" },
  no_reading: { en: "Not read yet", es: "Sin lectura" },
};

function keepVisible(e: FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget;
  window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
}

function StatusBadge({ status }: { status: MaterialStatus }) {
  const { bi } = useLabelLanguage();
  const t = STATUS_TEXT[status];
  return (
    <Badge
      variant="outline"
      className={cn(
        "shrink-0",
        status === "dry" && "border-success/60 text-success",
        status === "wet" && "border-warning/60 text-warning",
      )}
    >
      {bi(t.en, t.es)}
    </Badge>
  );
}

export function MaterialPointsDrawer({
  jobId,
  date,
  dayWord,
  rooms,
  data,
  userId,
  disabled,
  onChanged,
}: {
  jobId: string;
  date: string;
  dayWord: string;
  rooms: JobRoom[];
  /** Null while the tables are not in this database yet. */
  data: { points: MoisturePoint[]; readings: MoistureReading[] } | null | undefined;
  userId: string | null;
  disabled: boolean;
  onChanged: () => void;
}) {
  const { bi } = useLabelLanguage();

  /** Written on this phone but not yet read back from the server. */
  const [heldPoints, setHeldPoints] = useState<MoisturePoint[]>([]);
  const [heldReadings, setHeldReadings] = useState<MoistureReading[]>([]);
  /** point id → the % typed for the day being logged. */
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const [adding, setAdding] = useState(false);
  const [newRoom, setNewRoom] = useState("");
  const [newMaterial, setNewMaterial] = useState<string>("drywall");
  const [newLocation, setNewLocation] = useState("");
  const [newStandard, setNewStandard] = useState("");

  // What this phone wrote wins over the server's copy of the same point, so a
  // dry standard set with no signal shows at once instead of the stale one.
  const points = useMemo(() => {
    const held = new Map(heldPoints.map((p) => [p.id, p]));
    const server = (data?.points ?? []).map((p) => held.get(p.id) ?? p);
    const ids = new Set(server.map((p) => p.id));
    return [...server, ...heldPoints.filter((p) => !ids.has(p.id))];
  }, [data, heldPoints]);

  const readings = useMemo(() => {
    const server = data?.readings ?? [];
    const ids = new Set(server.map((r) => r.id));
    return [...server, ...heldReadings.filter((r) => !ids.has(r.id))];
  }, [data, heldReadings]);

  const roomNames = useMemo(() => new Map(rooms.map((r) => [r.id, roomLabel(r)])), [rooms]);

  /** Grouped by room, the order they are walked. Removed material last. */
  const groups = useMemo(() => {
    const summaries = points.map((p) => summarizePoint(p, readings));
    const byRoom = new Map<string, typeof summaries>();
    for (const s of summaries) {
      const key = s.point.room_id ?? "";
      byRoom.set(key, [...(byRoom.get(key) ?? []), s]);
    }
    return [...byRoom.entries()].map(([roomId, list]) => ({
      roomId,
      name: roomId ? (roomNames.get(roomId) ?? "Room") : "No room",
      list: [...list].sort((a, b) => Number(a.removed) - Number(b.removed)),
    }));
  }, [points, readings, roomNames]);

  const active = points.filter((p) => !p.removed_at);
  const readToday = new Set(readings.filter((r) => r.reading_date === date).map((r) => r.point_id));
  const dryCount = active.filter((p) => summarizePoint(p, readings).status === "dry").length;

  const ready = Object.entries(typed)
    .map(([pointId, text]) => ({ pointId, pct: parseMoisturePct(text), text }))
    .filter((x) => x.text.trim());
  const bad = ready.filter((x) => x.pct == null);

  const addPoint = async () => {
    if (!userId) return;
    const standard = newStandard.trim() ? parseMoisturePct(newStandard) : null;
    if (newStandard.trim() && standard == null) {
      toast.error("The dry standard has to be a number — the reading on unaffected material.");
      return;
    }
    const row: MoisturePointRow = {
      id: newId(),
      job_id: jobId,
      room_id: newRoom || null,
      material: newMaterial,
      location: newLocation.trim() || null,
      dry_standard: standard,
      removed_at: null,
      created_at: new Date().toISOString(),
      created_by: userId,
    };
    try {
      const res = await writeOrQueue({
        kind: "moisture_point",
        id: row.id,
        payload: { op: "create", row } as unknown as Record<string, unknown>,
        label: `${MOISTURE_MATERIAL_LABEL[row.material] ?? row.material} test point`,
        write: () => writeMoisturePoint(row),
      });
      setHeldPoints((cur) => [...cur, row]);
      if (res.queued)
        toast.warning("Test point held on this device — it saves when you have signal.");
      else toast.success("Test point added");
      setNewLocation("");
      setNewStandard("");
      setAdding(false);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The test point could not be saved.");
    }
  };

  const patchPoint = async (
    point: MoisturePoint,
    patch: Partial<Pick<MoisturePoint, "dry_standard" | "removed_at">>,
    label: string,
  ) => {
    const change = { id: point.id, patch };
    try {
      const res = await writeOrQueue({
        kind: "moisture_point",
        id: newId(),
        payload: { op: "patch", change } as unknown as Record<string, unknown>,
        label,
        write: () => patchMoisturePoint(change),
      });
      setHeldPoints((cur) => [...cur.filter((p) => p.id !== point.id), { ...point, ...patch }]);
      if (res.queued)
        toast.warning(`${label} held on this device — it saves when you have signal.`);
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${label} could not be saved.`);
    }
  };

  /** The point whose dry standard is being typed inline, and the text. */
  const [stdFor, setStdFor] = useState<string | null>(null);
  const [stdText, setStdText] = useState("");
  /** A removal is two presses: the first arms it, the second records it. */
  const [armedRemove, setArmedRemove] = useState<string | null>(null);

  const openStandard = (point: MoisturePoint) => {
    setStdFor(point.id);
    setStdText(point.dry_standard == null ? "" : String(point.dry_standard));
  };

  const saveStandard = (point: MoisturePoint) => {
    const value = stdText.trim() ? parseMoisturePct(stdText) : null;
    if (stdText.trim() && value == null) {
      toast.error("The dry standard has to be a number.");
      return;
    }
    setStdFor(null);
    void patchPoint(point, { dry_standard: value }, "Dry standard");
  };

  const markRemoved = (point: MoisturePoint) => {
    // Cut out, not dried — a category 3 wall, an opened ceiling. The point and
    // its readings stay in the record; it just stops being asked for.
    if (armedRemove !== point.id) {
      setArmedRemove(point.id);
      return;
    }
    setArmedRemove(null);
    void patchPoint(point, { removed_at: new Date().toISOString() }, "Material removed");
  };

  const saveReadings = async () => {
    if (!userId || bad.length) {
      if (bad.length) toast.error("Each moisture reading has to be a number (0 or more).");
      return;
    }
    setBusy(true);
    let held = 0;
    const captured = new Date().toISOString();
    const saved: MoistureReading[] = [];
    try {
      for (const x of ready) {
        const row: MoistureReadingRow = {
          id: newId(),
          point_id: x.pointId,
          job_id: jobId,
          reading_date: date,
          moisture_pct: x.pct!,
          notes: null,
          captured_at: captured,
          created_by: userId,
        };
        const res = await writeOrQueue({
          kind: "moisture_reading",
          id: row.id,
          payload: row as unknown as Record<string, unknown>,
          label: `Moisture ${row.moisture_pct}% · ${row.reading_date}`,
          write: () => writeMoistureReading(row),
        });
        if (res.queued) held += 1;
        saved.push(row);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "A moisture reading could not be saved.");
    } finally {
      setBusy(false);
    }
    setHeldReadings((cur) => [...cur, ...saved]);
    setTyped({});
    if (saved.length) {
      if (held)
        toast.warning(`${held} of ${saved.length} held on this device until you have signal.`);
      else
        toast.success(`Logged ${saved.length} moisture reading${saved.length === 1 ? "" : "s"}.`);
    }
    onChanged();
  };

  return (
    <details className="group rounded-md border">
      <summary className="flex min-h-11 cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-sm font-medium">
        <Ruler className="size-4 shrink-0 text-muted-foreground" />
        {bi("Material moisture — fixed test points", "Humedad de materiales — puntos fijos")}
        <span className="text-[11px] font-normal text-muted-foreground">
          {data === null
            ? "pending migration"
            : data === undefined
              ? "loading"
              : active.length === 0
                ? "none set up"
                : `${dryCount} of ${active.length} at dry standard · ${[...readToday].filter((id) => active.some((p) => p.id === id)).length} read ${dayWord}`}
        </span>
      </summary>

      <div className="space-y-3 border-t p-3">
        <p className="text-[11px] text-muted-foreground">
          The same spot on the same material, read every day with the moisture meter until it
          reaches its dry standard — the reading on that material somewhere unaffected. Dry means
          within 10% of the standard.
        </p>

        {data === null ? (
          <p className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px]">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
            <span>
              Test points arrive with 20260928161000_drying_material_moisture_points — the tables
              are not in this database yet. If it has just been applied, reload.
            </span>
          </p>
        ) : (
          <>
            {data === undefined && (
              <p className="text-xs text-muted-foreground">Loading test points…</p>
            )}
            {data !== undefined && groups.length === 0 && (
              <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                No test points yet. Add one per wet material in each room — drywall, baseboard,
                subfloor, framing — on day one.
              </p>
            )}

            {groups.map((g) => (
              <div key={g.roomId || "none"} className="space-y-1.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {g.name}
                </p>
                <ul className="space-y-2">
                  {g.list.map((s) => {
                    const p = s.point;
                    const text = typed[p.id] ?? "";
                    const live = parseMoisturePct(text);
                    const liveStatus = live == null ? null : materialStatus(live, p.dry_standard);
                    const goal = dryGoal(p.dry_standard);
                    return (
                      <li
                        key={p.id}
                        className={cn(
                          "space-y-2 rounded-md border bg-background p-2",
                          s.removed && "opacity-60",
                        )}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-sm font-medium">
                              {bi(
                                MOISTURE_MATERIAL_LABEL[p.material] ?? p.material,
                                MOISTURE_MATERIALS.find((m) => m.key === p.material)?.es ?? "",
                              )}
                              {p.location && (
                                <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                  {p.location}
                                </span>
                              )}
                            </p>
                            <p className="text-[11px] tabular-nums text-muted-foreground">
                              {p.dry_standard == null
                                ? "No dry standard set"
                                : `Dry standard ${p.dry_standard}% · dry at ${goal}% or under`}
                              {s.latest &&
                                ` · last ${s.latest.moisture_pct}% (${s.latest.reading_date.slice(5)})`}
                              {s.metOn && ` · met ${s.metOn.slice(5)}`}
                            </p>
                          </div>
                          {s.removed ? (
                            <Badge variant="outline">{bi("Removed", "Retirado")}</Badge>
                          ) : (
                            <StatusBadge status={s.status} />
                          )}
                        </div>

                        {/* Progress from day one's reading to the goal. */}
                        {s.progress != null && !s.removed && (
                          <div
                            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                            role="meter"
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(s.progress * 100)}
                            aria-label="Progress toward the dry standard"
                          >
                            <div
                              className={cn(
                                "h-full rounded-full",
                                s.progress >= 1 ? "bg-success" : "bg-primary",
                              )}
                              style={{ width: `${Math.round(s.progress * 100)}%` }}
                            />
                          </div>
                        )}

                        {!s.removed && (
                          <div className="flex items-center gap-2">
                            <Input
                              className="h-11 flex-1 text-base"
                              inputMode="decimal"
                              aria-label={`Moisture % for ${MOISTURE_MATERIAL_LABEL[p.material] ?? p.material}${p.location ? `, ${p.location}` : ""}`}
                              placeholder={bi(`% ${dayWord}`, "%")}
                              value={text}
                              disabled={disabled}
                              onFocus={keepVisible}
                              onChange={(e) =>
                                setTyped((cur) => ({ ...cur, [p.id]: e.target.value }))
                              }
                            />
                            {liveStatus && <StatusBadge status={liveStatus} />}
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-11 shrink-0 px-2 text-[11px] text-muted-foreground"
                              disabled={disabled}
                              onClick={() => openStandard(p)}
                            >
                              {p.dry_standard == null
                                ? bi("Set standard", "Estándar")
                                : bi("Standard", "Estándar")}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className={cn(
                                "size-11 shrink-0 text-muted-foreground",
                                armedRemove === p.id && "text-destructive",
                              )}
                              aria-label="Material removed rather than dried"
                              title="Material removed rather than dried"
                              disabled={disabled}
                              onClick={() => markRemoved(p)}
                            >
                              <Scissors className="size-4" />
                            </Button>
                          </div>
                        )}

                        {armedRemove === p.id && (
                          <p className="text-[11px] text-destructive">
                            Tap the scissors again to record this material as removed, not dried.
                            Its readings stay on the log.
                          </p>
                        )}

                        {stdFor === p.id && (
                          <div className="flex items-center gap-2">
                            <Input
                              className="h-11 flex-1 text-base"
                              inputMode="decimal"
                              autoFocus
                              aria-label="Dry standard %"
                              placeholder="Unaffected reading %"
                              value={stdText}
                              onFocus={keepVisible}
                              onChange={(e) => setStdText(e.target.value)}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-11 shrink-0"
                              onClick={() => setStdFor(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              type="button"
                              className="h-11 shrink-0"
                              onClick={() => saveStandard(p)}
                            >
                              {bi("Save", "Guardar")}
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            {active.length > 0 && (
              <Button
                type="button"
                className="h-12 w-full"
                disabled={busy || disabled || ready.length === 0}
                onClick={() => void saveReadings()}
              >
                {ready.length === 0
                  ? bi(`Log moisture readings for ${dayWord}`, "Guardar lecturas")
                  : bi(
                      `Log ${ready.length} moisture reading${ready.length === 1 ? "" : "s"} for ${dayWord}`,
                      "Guardar lecturas",
                    )}
              </Button>
            )}

            {adding ? (
              <div className="space-y-2 rounded-md border border-dashed p-2">
                <p className="text-sm font-medium">{bi("New test point", "Nuevo punto")}</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {rooms.length > 0 && (
                    <Select value={newRoom} onValueChange={setNewRoom}>
                      <SelectTrigger className="h-11 w-full" aria-label="Room">
                        <SelectValue placeholder={bi("Room", "Habitación")} />
                      </SelectTrigger>
                      <SelectContent>
                        <RoomSelectItems rooms={rooms} />
                      </SelectContent>
                    </Select>
                  )}
                  <Select value={newMaterial} onValueChange={setNewMaterial}>
                    <SelectTrigger className="h-11 w-full" aria-label="Material">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MOISTURE_MATERIALS.map((m) => (
                        <SelectItem key={m.key} value={m.key}>
                          {bi(m.en, m.es)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Input
                  className="h-11"
                  placeholder="Where on it — e.g. north wall, 12 in up, left of door"
                  value={newLocation}
                  onFocus={keepVisible}
                  onChange={(e) => setNewLocation(e.target.value)}
                />
                <Input
                  className="h-11 text-base"
                  inputMode="decimal"
                  placeholder="Dry standard % (unaffected reading) — can be set later"
                  value={newStandard}
                  onFocus={keepVisible}
                  onChange={(e) => setNewStandard(e.target.value)}
                />
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11"
                    onClick={() => setAdding(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    className="h-11"
                    disabled={disabled || !userId}
                    onClick={() => void addPoint()}
                  >
                    {bi("Add point", "Agregar")}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full"
                disabled={disabled}
                onClick={() => setAdding(true)}
              >
                <Plus className="mr-1 size-4" />
                {bi("Add a test point", "Agregar punto de prueba")}
              </Button>
            )}
          </>
        )}
      </div>
    </details>
  );
}
