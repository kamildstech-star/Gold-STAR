import { useMemo, useRef, useState } from "react";
import { T } from "@/components/bilingual";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Eraser,
  Minus,
  Shapes,
  SquareDashed,
  MapPinned,
  PenLine,
  Save,
  Tag,
  Trash2,
  Undo2,
  Upload,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SketchCleanupDialog } from "@/components/sketch-cleanup-dialog";
import { ShadePatterns, ShadeSwatch, SketchDrawOptions } from "@/components/sketch-draw-options";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastDbError } from "@/lib/db-errors";
import { documentFileUrl, uploadDocumentFile } from "@/lib/documents";
import { todayLocal } from "@/lib/drying-log";
import { fetchJobRooms, roomLabel } from "@/lib/job-rooms";
import { downloadPdf, savePdfToDocuments } from "@/lib/pdf-actions";
import {
  isClosedShape,
  SKETCH_EQUIPMENT,
  SKETCH_EQUIPMENT_OFFERED,
  SKETCH_SHADES,
  SKETCH_SHADES_OFFERED,
  SKETCH_ROOM_SCOPES,
  SKETCH_WALL_CUTS,
  SKETCH_WALL_CUTS_OFFERED,
  areaPath,
  arrowHead,
  doubleDrywall,
  inkCss,
  isRealShape,
  shadeCss,
  shadeOf,
  shadesUsed,
  sketchPageName,
  stackOffset,
  straightenWall,
  wallCss,
  wallLegend,
  wallNormal,
  createRoomSketch,
  deleteRoomSketch,
  fetchRoomSketches,
  saveSketchAnnotations,
  thinPath,
  type Pt,
  type RoomSketch,
  type DrawStyle,
  type SketchAnnotation,
  type SketchEquipment,
  type SketchShade,
  type SketchShapeMark,
  type SketchWall,
  type SketchWallCut,
} from "@/lib/room-sketch";
import { cn } from "@/lib/utils";

const NO_ROOM = "__none";
/** Longest edge a sketch is stored at: sharp on a PDF page, light on a phone. */
const MAX_EDGE = 2000;

type SketchJob = {
  id: string;
  location_id: string;
  job_number: string | null;
  address: string | null;
};

type Raster = { blob: Blob; width: number; height: number };

/** A drawn page or image as a PNG no larger than MAX_EDGE, on white. */
async function toPng(source: CanvasImageSource, w: number, h: number): Promise<Raster> {
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob(
      (b) => (b ? ok(b) : fail(new Error("The sketch could not be read."))),
      "image/png",
    ),
  );
  return { blob, width: canvas.width, height: canvas.height };
}

/**
 * A picked image, or EVERY page of a picked PDF, as PNGs (5 Nov review, T12:
 * a 2-page sketch — 1st floor and 2nd floor — came in as page one only).
 * One raster per page, in page order.
 */
async function rasterize(file: File): Promise<Raster[]> {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const { openPdfDocument } = await import("@/lib/document-thumbnails");
    const pdf = await openPdfDocument(file);
    try {
      const out: Raster[] = [];
      for (let page = 1; page <= pdf.pageCount; page++) {
        const drawn = await pdf.renderPage({ page, maxEdge: MAX_EDGE });
        out.push(await toPng(drawn.canvas, drawn.canvas.width, drawn.canvas.height));
      }
      return out;
    } finally {
      pdf.close();
    }
  }
  const bmp = await createImageBitmap(file);
  return [await toPng(bmp, bmp.width, bmp.height)];
}

/**
 * FE12, 28 Oct — room sketches. Upload a raw sketch (a photo of paper, an
 * image or a PDF — every page, one sketch each) for a room or a floor, mark it up — shade
 * the affected areas, place equipment, add labels — and export a clean PDF
 * plan for the client. On the Rooms tab, beside the write-ups.
 */
export function RoomSketchesPanel({ job }: { job: SketchJob }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [roomId, setRoomId] = useState<string>(NO_ROOM);
  const [floor, setFloor] = useState("");
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const roomsQ = useQuery({
    queryKey: ["job-rooms", job.id],
    queryFn: () => fetchJobRooms(job.id),
  });
  const listQ = useQuery({
    queryKey: ["room-sketches", job.id],
    queryFn: () => fetchRoomSketches(job.id),
  });
  const rooms = useMemo(() => roomsQ.data?.rooms ?? [], [roomsQ.data]);
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, roomLabel(r)])), [rooms]);
  const sketches = listQ.data?.sketches ?? [];
  const open = sketches.find((s) => s.id === openId) ?? null;
  const off = app.writesDisabled || !listQ.data?.available;

  const upload = async (file: File) => {
    setBusy(true);
    try {
      const rasters = await rasterize(file);
      const room = roomId === NO_ROOM ? null : roomId;
      const base =
        [room ? nameOf.get(room) : null, floor.trim() || null].filter(Boolean).join(" · ") ||
        file.name.replace(/\.[^.]+$/, "");
      // One sketch per page, each its own document, so every floor of a
      // multi-page PDF can be marked up (T12).
      let firstId: string | null = null;
      for (const [i, raster] of rasters.entries()) {
        const name = sketchPageName(base, i + 1, rasters.length);
        const doc = await uploadDocumentFile({
          file: new File([raster.blob], `sketch-${Date.now()}-${i + 1}.png`, {
            type: "image/png",
          }),
          scope: { locationId: job.location_id, jobId: job.id },
          docType: "other",
          userId: app.userId ?? null,
          name: `Sketch — ${name}.png`,
        });
        const id = await createRoomSketch({
          jobId: job.id,
          roomId: room,
          floorLabel: floor,
          name,
          documentId: doc.id,
          width: raster.width,
          height: raster.height,
          userId: app.userId ?? null,
        });
        firstId ??= id;
      }
      await qc.invalidateQueries({ queryKey: ["room-sketches", job.id] });
      setFloor("");
      if (rasters.length > 1)
        toast.success(`${rasters.length} pages added as ${rasters.length} sketches`);
      setOpenId(firstId);
    } catch (e) {
      toastDbError(e, { action: "Add the sketch" });
    } finally {
      setBusy(false);
    }
  };

  const remove = useMutation({
    mutationFn: (id: string) => deleteRoomSketch(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["room-sketches", job.id] }),
    onError: (e) => toastDbError(e, { action: "Remove the sketch" }),
  });

  return (
    <Card data-room-sketches>
      <CardHeader className="space-y-1 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <MapPinned className="size-4" /> Room sketches
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          A sketch per room or floor: shade the affected areas, place the equipment, export a plan
          for the client.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {listQ.data && !listQ.data.available && (
          <p className="border-l-2 border-muted-foreground/40 px-2 py-1 text-xs text-muted-foreground">
            Room sketches are waiting on a database update (migration 20261028130000). Nothing can
            be saved here until it is applied.
          </p>
        )}
        {listQ.isError && (
          <p className="text-sm text-destructive">
            Sketches could not be loaded — that is not the same as there being none.
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">
              <T>Room</T>
            </span>
            <Select value={roomId} onValueChange={setRoomId} disabled={off}>
              <SelectTrigger className="h-11 sm:h-9" aria-label="Room for the sketch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROOM}>
                  <T>Whole floor (no room)</T>
                </SelectItem>
                {rooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {roomLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">
              <T>Floor</T>
            </span>
            <Input
              className="h-11 sm:h-9"
              placeholder="1st floor"
              value={floor}
              disabled={off}
              onChange={(e) => setFloor(e.target.value)}
            />
          </label>
          <Button
            type="button"
            className="h-11 sm:h-9"
            disabled={off || busy}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-1.5 size-4" />
            {busy ? "Adding…" : "Upload sketch"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
        </div>

        {sketches.length === 0 && !listQ.isLoading ? (
          <p className="text-sm text-muted-foreground">
            <T>No sketches on this job yet.</T>
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {sketches.map((s) => (
              <li key={s.id} className="overflow-hidden rounded-md border">
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => setOpenId(s.id)}
                >
                  <SketchView sketch={s} className="aspect-[4/3] bg-muted" />
                  <span className="block truncate px-2 pt-1 text-[13px] font-medium">{s.name}</span>
                  <span className="block truncate px-2 pb-1 text-[11px] text-muted-foreground">
                    {s.room_id ? (nameOf.get(s.room_id) ?? "Room") : (s.floor_label ?? "Floor")} ·{" "}
                    {s.annotations.length} mark{s.annotations.length === 1 ? "" : "s"}
                  </span>
                </button>
                <div className="flex justify-end border-t px-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={`Remove ${s.name}`}
                    disabled={off || remove.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove the sketch "${s.name}"? Its file stays in Documents.`,
                        )
                      )
                        remove.mutate(s.id);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {open && (
        <SketchEditor
          key={open.id}
          sketch={open}
          job={job}
          readOnly={off}
          roomName={open.room_id ? (nameOf.get(open.room_id) ?? null) : null}
          onClose={() => setOpenId(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["room-sketches", job.id] })}
          onOpenSketch={async (id) => {
            await qc.invalidateQueries({ queryKey: ["room-sketches", job.id] });
            setOpenId(id);
          }}
        />
      )}
    </Card>
  );
}

/** The sketch with its markup drawn over it — the tile and the editor share it. */
function SketchView({
  sketch,
  annotations = sketch.annotations,
  draft,
  className,
  svgRef,
  svgProps,
  draftShade = "flood_cut",
  draftShape = null,
  draftWall = null,
  legend = false,
}: {
  sketch: RoomSketch;
  annotations?: readonly SketchAnnotation[];
  draft?: readonly Pt[] | null;
  className?: string;
  svgRef?: React.Ref<SVGSVGElement>;
  svgProps?: React.SVGProps<SVGSVGElement>;
  draftShade?: SketchShade;
  /** The shape being dragged out, drawn as it will be saved. */
  draftShape?: SketchShapeMark | null;
  /** The wall mark being dragged along a wall. */
  draftWall?: SketchWall | null;
  /** Draw the shading legend box on the sketch (the editor; the PDF has its own). */
  legend?: boolean;
}) {
  const { width: w, height: h } = sketch;
  const unit = Math.max(w, h);
  // One <defs> per sketch: ids must not collide when tiles share the page.
  const pid = (shade: SketchShade) => `shade-${sketch.id}-${shade}`;
  const used = shadesUsed(annotations);
  // 11 Nov: two marks of one cut on the same wall = double drywall, listed
  // only as double unless the cut is also drawn single somewhere.
  const doubled = doubleDrywall(annotations);
  const { walls } = wallLegend(annotations);
  return (
    <div className={cn("relative overflow-hidden", className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        className="absolute inset-0 size-full"
        preserveAspectRatio="xMidYMid meet"
        {...svgProps}
      >
        <image href={documentFileUrl(sketch.document_id)} x={0} y={0} width={w} height={h} />
        <ShadePatterns idFor={pid} size={unit / 70} stroke={unit / 450} />
        {annotations.map((a, i) => {
          if (a.kind !== "area") return null;
          const shade = shadeOf(a);
          const d = areaPath(a.points, w, h);
          return (
            <g key={i} data-shade={shade}>
              {/* A light wash of the colour under the pattern, so the area
                  reads as one shape; the pattern carries the meaning. */}
              <path d={d} fill={shadeFill(shade, pid)} stroke="none" />
              <path
                d={d}
                fill="none"
                stroke={shadeCss(shade, 0.95)}
                strokeWidth={unit / (SKETCH_SHADES[shade].pattern === "outline" ? 250 : 400)}
                strokeDasharray={
                  SKETCH_SHADES[shade].pattern === "outline"
                    ? `${unit / 90} ${unit / 160}`
                    : undefined
                }
              />
            </g>
          );
        })}
        {draft && draft.length > 1 && (
          <polyline
            points={draft.map(([x, y]) => `${x * w},${y * h}`).join(" ")}
            fill="none"
            stroke={shadeCss(draftShade)}
            strokeWidth={Math.max(w, h) / 300}
            strokeDasharray={`${Math.max(w, h) / 100}`}
          />
        )}
        {/* Wall marks (11 Nov): along the wall, over the shading. */}
        {[...annotations, ...(draftWall ? [draftWall] : [])].map((a, i) =>
          a.kind === "wall" ? (
            <WallMark key={`w${i}`} mark={a} w={w} h={h} stack={doubled.stack.get(i)} />
          ) : null,
        )}
        {[...annotations, ...(draftShape ? [draftShape] : [])].map((a, i) =>
          a.kind === "shape" ? <ShapeMark key={`s${i}`} mark={a} w={w} h={h} idFor={pid} /> : null,
        )}
        {annotations.map((a, i) => {
          const r = Math.max(w, h) / 70;
          if (a.kind === "marker") {
            return (
              <g key={`m${i}`}>
                <circle
                  cx={a.x * w}
                  cy={a.y * h}
                  r={r}
                  fill="#10243d"
                  stroke="#fff"
                  strokeWidth={r / 6}
                />
                <text
                  x={a.x * w}
                  y={a.y * h}
                  dy="0.35em"
                  textAnchor="middle"
                  fontSize={r * 1.15}
                  fontWeight={700}
                  fill="#fff"
                >
                  {SKETCH_EQUIPMENT[a.equipment].letter}
                </text>
              </g>
            );
          }
          if (a.kind === "label") {
            return (
              <text
                key={`l${i}`}
                x={a.x * w}
                y={a.y * h}
                fontSize={r * 1.2}
                fontWeight={600}
                fill="#10243d"
                stroke="#fff"
                strokeWidth={r / 4}
                paintOrder="stroke"
              >
                {a.text}
              </text>
            );
          }
          return null;
        })}
        {legend && (used.length > 0 || walls.length > 0 || doubled.cuts.length > 0) && (
          <ShadeLegend shades={used} walls={walls} doubles={doubled.cuts} idFor={pid} w={w} h={h} />
        )}
      </svg>
    </div>
  );
}

/** A line, arrow, circle or rectangle, in its ink (the Draw tool). */
function ShapeMark({
  mark,
  w,
  h,
  idFor,
}: {
  mark: SketchShapeMark;
  w: number;
  h: number;
  /** Pattern ids for a filled shape (6 Nov): the same <defs> the areas use. */
  idFor?: (s: SketchShade) => string;
}) {
  const [x1, y1] = [mark.from[0] * w, mark.from[1] * h];
  const [x2, y2] = [mark.to[0] * w, mark.to[1] * h];
  const filled = mark.shade && isClosedShape(mark.shape) && idFor ? mark.shade : null;
  const stroke = filled ? shadeCss(filled, 0.9) : inkCss(mark.ink);
  const sw = Math.max(w, h) / 320;
  const common = {
    stroke,
    strokeWidth: sw,
    fill: filled ? shadeFill(filled, idFor!) : "none",
    strokeLinecap: "round" as const,
  };
  if (mark.shape === "line") return <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} />;
  if (mark.shape === "arrow") {
    const [a, b] = arrowHead([x1, y1], [x2, y2], Math.max(w, h) / 45);
    return (
      <g>
        <line x1={x1} y1={y1} x2={x2} y2={y2} {...common} />
        <polyline
          points={`${a[0]},${a[1]} ${x2},${y2} ${b[0]},${b[1]}`}
          {...common}
          strokeLinejoin="round"
        />
      </g>
    );
  }
  const [x, y] = [Math.min(x1, x2), Math.min(y1, y2)];
  const [rw, rh] = [Math.abs(x2 - x1), Math.abs(y2 - y1)];
  if (mark.shape === "circle")
    return <ellipse cx={x + rw / 2} cy={y + rh / 2} rx={rw / 2} ry={rh / 2} {...common} />;
  return <rect x={x} y={y} width={rw} height={rh} {...common} />;
}

/** The fill for a preset: its pattern, or the original tint. */
function shadeFill(shade: SketchShade, idFor: (s: SketchShade) => string) {
  const p = SKETCH_SHADES[shade].pattern;
  if (p === "tint") return shadeCss(shade, 0.32);
  if (p === "solid") return shadeCss(shade, 0.6);
  if (p === "outline") return "none";
  return `url(#${idFor(shade)})`;
}

/** How thick a wall mark is drawn, from its cut's weight, at a sketch's scale. */
function wallStroke(cut: SketchWallCut, unit: number): number {
  const weight = SKETCH_WALL_CUTS[cut].weight;
  return weight === 2 ? unit / 110 : weight === 1 ? unit / 190 : unit / 330;
}

/** A wall cut's line width in a small picker or legend swatch. */
const swatchStroke = (cut: SketchWallCut) => [1.3, 2, 3.4][SKETCH_WALL_CUTS[cut].weight] ?? 2;

/**
 * A wall mark: dotted for a flood cut (round dots, bigger for the higher
 * cut), solid for a full wall demo, each in its cut's colour.
 */
function WallLine({
  x1,
  y1,
  x2,
  y2,
  cut,
  sw,
  double = false,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  cut: SketchWallCut;
  sw: number;
  double?: boolean;
}) {
  const dotted = SKETCH_WALL_CUTS[cut].line === "dotted";
  return (
    <line
      x1={x1}
      y1={y1}
      x2={x2}
      y2={y2}
      stroke={wallCss(cut)}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeDasharray={dotted ? `0 ${sw * 1.9}` : undefined}
      data-wall-cut={cut}
      data-double-drywall={double || undefined}
    />
  );
}

function WallMark({
  mark,
  w,
  h,
  stack,
}: {
  mark: SketchWall;
  w: number;
  h: number;
  /** Set when this mark is one of a double-drywall pair: drawn beside its twin. */
  stack?: { place: number; of: number };
}) {
  const unit = Math.max(w, h);
  const sw = wallStroke(mark.cut, unit);
  const [x1, y1, x2, y2] = [mark.from[0] * w, mark.from[1] * h, mark.to[0] * w, mark.to[1] * h];
  const [nx, ny] = wallNormal([x1, y1], [x2, y2]);
  const shift = stack ? stackOffset(stack.place, stack.of) * sw : 0;
  return (
    <WallLine
      x1={x1 + nx * shift}
      y1={y1 + ny * shift}
      x2={x2 + nx * shift}
      y2={y2 + ny * shift}
      cut={mark.cut}
      sw={sw}
      double={!!stack}
    />
  );
}

/** A wall cut's line, small, for a picker. */
function WallSwatch({ cut }: { cut: SketchWallCut }) {
  return (
    <svg viewBox="0 0 28 10" className="h-2.5 w-7 shrink-0" aria-hidden>
      <WallLine x1={3} y1={5} x2={25} y2={5} cut={cut} sw={swatchStroke(cut)} />
    </svg>
  );
}

/**
 * The legend box in the sketch's corner: a swatch and the name of each preset
 * used, then each wall cut used with its line (11 Nov).
 */
function ShadeLegend({
  shades,
  walls = [],
  doubles = [],
  idFor,
  w,
  h,
}: {
  shades: readonly SketchShade[];
  walls?: readonly SketchWallCut[];
  /** Cuts drawn twice on one wall (11 Nov): listed as double drywall. */
  doubles?: readonly SketchWallCut[];
  idFor: (s: SketchShade) => string;
  w: number;
  h: number;
}) {
  const u = Math.max(w, h) / 60;
  const row = u * 1.5;
  const labels = [
    ...shades.map((s) => SKETCH_SHADES[s].label),
    ...walls.map((c) => SKETCH_WALL_CUTS[c].label),
    ...doubles.map(doubleLabel),
  ];
  const width = u * Math.max(11, 3 + 0.47 * Math.max(0, ...labels.map((l) => l.length)));
  const height = row * labels.length + u;
  const x = u * 0.6;
  const y = h - height - u * 0.6;
  return (
    <g data-shade-legend>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={u * 0.3}
        fill="#fff"
        fillOpacity={0.92}
        stroke="#10243d"
        strokeOpacity={0.35}
        strokeWidth={u / 12}
      />
      {shades.map((s, i) => {
        const ry = y + u * 0.5 + i * row;
        return (
          <g key={s}>
            <rect
              x={x + u * 0.5}
              y={ry}
              width={u * 1.6}
              height={u}
              fill={shadeFill(s, idFor)}
              stroke={shadeCss(s, 0.95)}
              strokeWidth={u / 14}
            />
            <text
              x={x + u * 2.5}
              y={ry + u * 0.5}
              dy="0.35em"
              fontSize={u * 0.85}
              fontWeight={600}
              fill="#10243d"
            >
              {SKETCH_SHADES[s].label}
            </text>
          </g>
        );
      })}
      {walls.map((c, i) => {
        const ry = y + u * 0.5 + (shades.length + i) * row;
        return (
          <g key={c}>
            <WallLine
              x1={x + u * 0.6}
              y1={ry + u * 0.5}
              x2={x + u * 2}
              y2={ry + u * 0.5}
              cut={c}
              sw={wallStroke(c, Math.max(w, h)) * 0.9}
            />
            <text
              x={x + u * 2.5}
              y={ry + u * 0.5}
              dy="0.35em"
              fontSize={u * 0.85}
              fontWeight={600}
              fill="#10243d"
            >
              {SKETCH_WALL_CUTS[c].label}
            </text>
          </g>
        );
      })}
      {doubles.map((c, i) => {
        const ry = y + u * 0.5 + (shades.length + walls.length + i) * row;
        const sw = wallStroke(c, Math.max(w, h)) * 0.8;
        return (
          <g key={`double-${c}`} data-double-drywall-legend={c}>
            {[-1.1, 1.1].map((o) => (
              <WallLine
                key={o}
                x1={x + u * 0.6}
                y1={ry + u * 0.5 + o * sw}
                x2={x + u * 2}
                y2={ry + u * 0.5 + o * sw}
                cut={c}
                sw={sw}
              />
            ))}
            <text
              x={x + u * 2.5}
              y={ry + u * 0.5}
              dy="0.35em"
              fontSize={u * 0.85}
              fontWeight={600}
              fill="#10243d"
            >
              {doubleLabel(c)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/** The legend line for a doubled cut: "Double drywall – Flood cut 2 ft". */
const doubleLabel = (c: SketchWallCut) => `Double drywall – ${SKETCH_WALL_CUTS[c].label}`;

type Tool = "area" | "marker" | "label" | "shape" | "wall" | "room";

function SketchEditor({
  sketch,
  job,
  readOnly,
  roomName,
  onClose,
  onSaved,
  onOpenSketch,
}: {
  sketch: RoomSketch;
  job: SketchJob;
  readOnly: boolean;
  roomName: string | null;
  onClose: () => void;
  onSaved: () => void;
  /** Open another sketch in the editor: the clean plan just made from this one. */
  onOpenSketch?: (id: string) => void;
}) {
  const app = useAppContext();
  const [marks, setMarks] = useState<SketchAnnotation[]>(sketch.annotations);
  const [tool, setTool] = useState<Tool>("area");
  const [equipment, setEquipment] = useState<SketchEquipment>("dehumidifier");
  const [shade, setShade] = useState<SketchShade>("flood_cut");
  const [draft, setDraft] = useState<Pt[] | null>(null);
  /* The Draw tool: shape, ink and fill. 6 Nov: a circle or rectangle can be
     filled with a cut preset ("none" = outline only), so it lists in the
     legend like a shaded area. 12 Nov: every option is on show at once. */
  const [drawStyle, setDrawStyle] = useState<DrawStyle>({
    shape: "arrow",
    ink: "red",
    fill: "none",
  });
  const [shapeDraft, setShapeDraft] = useState<SketchShapeMark | null>(null);
  /* 11 Nov: the Wall tool — drag along a wall, pick what was done to it. */
  const [wallCut, setWallCut] = useState<SketchWallCut>("flood_2ft");
  const [wallDraft, setWallDraft] = useState<SketchWall | null>(null);
  /* 11 Nov: the Room tool — a box over the whole room, hatched by scope. */
  const [roomScope, setRoomScope] = useState<SketchShade>("floor_removal");
  const [busy, setBusy] = useState<"save" | "pdf" | null>(null);
  /* 11 Nov: "Clean up with AI" — the rough sketch redrawn as a clean plan. */
  const [cleaning, setCleaning] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const dirty = JSON.stringify(marks) !== JSON.stringify(sketch.annotations);

  /** A pointer position as 0..1 of the image, honoring the letterboxing. */
  const at = (e: React.PointerEvent): Pt | null => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const x = p.x / sketch.width;
    const y = p.y / sketch.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return [x, y];
  };

  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (readOnly) return;
    const p = at(e);
    if (!p) return;
    if (tool === "area") {
      e.currentTarget.setPointerCapture(e.pointerId);
      setDraft([p]);
    } else if (tool === "shape") {
      e.currentTarget.setPointerCapture(e.pointerId);
      const { shape, ink, fill } = drawStyle;
      setShapeDraft({
        kind: "shape",
        shape,
        from: p,
        to: p,
        ink,
        ...(fill !== "none" && isClosedShape(shape) ? { shade: fill } : {}),
      });
    } else if (tool === "room") {
      e.currentTarget.setPointerCapture(e.pointerId);
      setShapeDraft({
        kind: "shape",
        shape: "rect",
        from: p,
        to: p,
        ink: "navy",
        shade: roomScope,
      });
    } else if (tool === "wall") {
      e.currentTarget.setPointerCapture(e.pointerId);
      setWallDraft({ kind: "wall", from: p, to: p, cut: wallCut });
    } else if (tool === "marker") {
      setMarks((m) => [...m, { kind: "marker", x: p[0], y: p[1], equipment }]);
    } else {
      const text = window.prompt("Label")?.trim();
      if (text)
        setMarks((m) => [...m, { kind: "label", x: p[0], y: p[1], text: text.slice(0, 80) }]);
    }
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (wallDraft) {
      const p = at(e);
      if (p) setWallDraft((d) => (d ? { ...d, to: straightenWall(d.from, p) } : d));
      return;
    }
    if (shapeDraft) {
      const p = at(e);
      // 11 Nov: lines and arrows snap straight like wall marks; boxes and
      // circles span the drag as drawn.
      if (p)
        setShapeDraft((d) =>
          d ? { ...d, to: isClosedShape(d.shape) ? p : straightenWall(d.from, p) } : d,
        );
      return;
    }
    if (!draft) return;
    const p = at(e);
    if (p) setDraft((d) => (d ? thinPath([...d, p]) : d));
  };
  const up = () => {
    if (wallDraft) {
      const done = wallDraft;
      setWallDraft(null);
      if (isRealShape(done.from, done.to)) setMarks((m) => [...m, done]);
      return;
    }
    if (shapeDraft) {
      const done = shapeDraft;
      setShapeDraft(null);
      if (isRealShape(done.from, done.to)) setMarks((m) => [...m, done]);
      return;
    }
    if (!draft) return;
    const points = thinPath(draft);
    setDraft(null);
    if (points.length >= 3) setMarks((m) => [...m, { kind: "area", points, shade }]);
  };

  const save = async () => {
    setBusy("save");
    try {
      await saveSketchAnnotations(sketch.id, marks);
      onSaved();
      toast.success("Sketch saved");
    } catch (e) {
      toastDbError(e, { action: "Save the sketch" });
    } finally {
      setBusy(null);
    }
  };

  const exportPdf = async () => {
    setBusy("pdf");
    try {
      const res = await fetch(documentFileUrl(sketch.document_id), { credentials: "same-origin" });
      if (!res.ok) throw new Error("The sketch image could not be read.");
      const image = new Uint8Array(await res.arrayBuffer());
      const { buildRoomSketchPdf } = await import("@/lib/room-sketch-pdf");
      const bytes = await buildRoomSketchPdf({
        image,
        mime: res.headers.get("content-type") ?? "image/png",
        annotations: marks,
        title: [roomName ?? sketch.floor_label ?? sketch.name, "— affected area plan"].join(" "),
        subtitle:
          [job.job_number ? `Job ${job.job_number}` : null, job.address]
            .filter(Boolean)
            .join(" · ") || null,
        date: todayLocal(),
      });
      const filename = `Sketch plan - ${sketch.name}.pdf`.replace(/[\\/:*?"<>|]+/g, "-");
      await savePdfToDocuments({
        bytes,
        filename,
        name: `Sketch plan — ${sketch.name}`,
        docType: "other",
        locationId: job.location_id,
        jobId: job.id,
      }).catch((e) => toastDbError(e, { action: "File the plan in Documents" }));
      downloadPdf(bytes, filename);
    } catch (e) {
      toast.error("The plan could not be made", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const toolButton = (t: Tool, icon: React.ReactNode, label: string) => (
    <Button
      type="button"
      size="sm"
      variant={tool === t ? "default" : "outline"}
      className="h-10 sm:h-8"
      aria-pressed={tool === t}
      disabled={readOnly}
      onClick={() => setTool(t)}
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <Dialog
      open
      onOpenChange={(v) => {
        if (v) return;
        if (dirty && !window.confirm("Close without saving the marks?")) return;
        onClose();
      }}
    >
      <DialogContent className="flex max-h-[100svh] w-full max-w-5xl flex-col gap-3 overflow-hidden p-3 sm:p-4">
        <DialogHeader>
          <DialogTitle>{sketch.name}</DialogTitle>
          <DialogDescription>
            {tool === "area"
              ? "Draw around an affected area with your finger or the mouse."
              : tool === "marker"
                ? "Tap where the equipment sits."
                : tool === "shape"
                  ? "Pick a shape, a colour and a fill, then drag from one point to another. A filled shape takes its fill's colour and is listed in the legend."
                  : tool === "wall"
                    ? "Drag along a wall from one end to the other; it snaps straight. The line shows what was done to that wall. Draw the same cut twice on one wall for double drywall."
                    : tool === "room"
                      ? "Drag a box over the room; its lines show the scope — floor removal, ceiling removal or full gut."
                      : "Tap where the label goes."}
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex flex-wrap items-center gap-1.5"
          role="toolbar"
          aria-label="Markup tools"
        >
          {toolButton("area", <PenLine className="mr-1 size-4" />, "Shade area")}
          {tool === "area" && (
            <Select value={shade} onValueChange={(v) => setShade(v as SketchShade)}>
              <SelectTrigger className="h-10 w-[11rem] sm:h-8" aria-label="Shading">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKETCH_SHADES_OFFERED.map((k) => (
                  <SelectItem key={k} value={k}>
                    <span className="flex items-center gap-2">
                      <ShadeSwatch shade={k} />
                      {SKETCH_SHADES[k].label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {toolButton("marker", <MapPinned className="mr-1 size-4" />, "Equipment")}
          {tool === "marker" && (
            <Select value={equipment} onValueChange={(v) => setEquipment(v as SketchEquipment)}>
              <SelectTrigger className="h-10 w-[11rem] sm:h-8" aria-label="Equipment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKETCH_EQUIPMENT_OFFERED.map((k) => (
                  <SelectItem key={k} value={k}>
                    {SKETCH_EQUIPMENT[k].letter} — {SKETCH_EQUIPMENT[k].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {toolButton("label", <Tag className="mr-1 size-4" />, "Label")}
          {toolButton("shape", <Shapes className="mr-1 size-4" />, "Draw")}
          {toolButton("room", <SquareDashed className="mr-1 size-4" />, "Room")}
          {tool === "room" && (
            <Select value={roomScope} onValueChange={(v) => setRoomScope(v as SketchShade)}>
              <SelectTrigger className="h-10 w-[11rem] sm:h-8" aria-label="Room scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKETCH_ROOM_SCOPES.map((k) => (
                  <SelectItem key={k} value={k}>
                    <span className="flex items-center gap-2">
                      <ShadeSwatch shade={k} />
                      {SKETCH_SHADES[k].label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {toolButton("wall", <Minus className="mr-1 size-4" />, "Wall")}
          {tool === "wall" && (
            <Select value={wallCut} onValueChange={(v) => setWallCut(v as SketchWallCut)}>
              <SelectTrigger className="h-10 w-[11rem] sm:h-8" aria-label="Wall cut">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SKETCH_WALL_CUTS_OFFERED.map((k) => (
                  <SelectItem key={k} value={k}>
                    <span className="flex items-center gap-2">
                      <WallSwatch cut={k} />
                      {SKETCH_WALL_CUTS[k].label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-10 sm:h-8"
            disabled={readOnly || marks.length === 0}
            onClick={() => setMarks((m) => m.slice(0, -1))}
          >
            <Undo2 className="mr-1 size-4" /> Undo
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-10 sm:h-8"
            disabled={readOnly || marks.length === 0}
            onClick={() => window.confirm("Clear every mark on this sketch?") && setMarks([])}
          >
            <Eraser className="mr-1 size-4" /> Clear
          </Button>
        </div>

        {tool === "shape" && (
          <SketchDrawOptions value={drawStyle} onChange={setDrawStyle} disabled={readOnly} />
        )}

        <SketchView
          sketch={sketch}
          annotations={marks}
          draft={draft}
          draftShade={shade}
          draftShape={shapeDraft}
          draftWall={wallDraft}
          legend
          className="h-[60svh] rounded-md border bg-white sm:h-[66svh]"
          svgRef={svgRef}
          svgProps={{
            style: { touchAction: "none", cursor: readOnly ? "default" : "crosshair" },
            onPointerDown: down,
            onPointerMove: move,
            onPointerUp: up,
            onPointerCancel: () => {
              setDraft(null);
              setShapeDraft(null);
              setWallDraft(null);
            },
          }}
        />

        <div className="flex flex-wrap justify-end gap-2">
          {!readOnly && onOpenSketch && (
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-9"
              disabled={busy !== null || !app.userId}
              onClick={() => setCleaning(true)}
            >
              <Wand2 className="mr-1.5 size-4" /> Clean up with AI
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-9"
            disabled={busy !== null || !app.userId}
            onClick={() => void exportPdf()}
          >
            <Download className="mr-1.5 size-4" />
            {busy === "pdf" ? "Making the plan…" : "Export PDF plan"}
          </Button>
          <Button
            type="button"
            className="h-11 sm:h-9"
            disabled={readOnly || !dirty || busy !== null}
            onClick={() => void save()}
          >
            <Save className="mr-1.5 size-4" />
            {busy === "save" ? "Saving…" : "Save marks"}
          </Button>
        </div>
        {cleaning && onOpenSketch && (
          <SketchCleanupDialog
            sketch={sketch}
            job={job}
            marks={marks}
            onClose={() => setCleaning(false)}
            onCreated={(id) => {
              setCleaning(false);
              onOpenSketch(id);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
