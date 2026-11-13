import { useServerFn } from "@tanstack/react-start";
import { Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toastDbError } from "@/lib/db-errors";
import { documentFileUrl, uploadDocumentFile } from "@/lib/documents";
import {
  createRoomSketch,
  saveSketchAnnotations,
  type RoomSketch,
  type SketchAnnotation,
} from "@/lib/room-sketch";
import { readSketchPlan } from "@/lib/sketch-cleanup.functions";
import {
  PLAN_FONT,
  fitPlan,
  inkBounds,
  newPlanRoom,
  planBounds,
  planDrawing,
  planSvgMarkup,
  snapPlan,
  type Box,
  type DrawItem,
  type SketchPlan,
} from "@/lib/sketch-plan";
import { cn } from "@/lib/utils";

/** The longest edge sent to the model: enough to read handwriting, light to send. */
const READ_EDGE = 1600;

/** The longest edge the drawing is searched at for its ink. */
const INK_EDGE = 1000;

/** A canvas of the image at most `edge` long, on white. */
function drawn(bmp: ImageBitmap, edge: number) {
  const scale = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return { canvas, ctx };
}

/**
 * The rough sketch as a JPEG data URL no larger than READ_EDGE, and where its
 * drawing sits on the page (null when that cannot be told).
 */
async function readSketchImage(documentId: string): Promise<{ dataUrl: string; ink: Box | null }> {
  const res = await fetch(documentFileUrl(documentId), { credentials: "same-origin" });
  if (!res.ok) throw new Error("The sketch image could not be read.");
  const bmp = await createImageBitmap(await res.blob());
  const dataUrl = drawn(bmp, READ_EDGE).canvas.toDataURL("image/jpeg", 0.85);
  let ink: Box | null = null;
  try {
    const { canvas, ctx } = drawn(bmp, INK_EDGE);
    ink = inkBounds(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
    );
  } catch {
    ink = null;
  }
  return { dataUrl, ink };
}

/** The clean plan as a PNG at the sketch's own size, so the marks keep their places. */
async function planPng(plan: SketchPlan, w: number, h: number): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(planSvgMarkup(plan, w, h))}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return new Promise<Blob>((ok, fail) =>
    canvas.toBlob(
      (b) => (b ? ok(b) : fail(new Error("The clean plan could not be drawn."))),
      "image/png",
    ),
  );
}

type Drag =
  | { mode: "move" | "resize"; index: number; start: [number, number]; box: Box }
  /** The whole plan at once: moved, or scaled from its top-left corner. */
  | { mode: "moveAll" | "scaleAll"; start: [number, number]; plan: SketchPlan; box: Box };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** One drawing item as SVG. */
function Item({ d }: { d: DrawItem }) {
  if (d.t === "rect")
    return (
      <rect
        x={d.x}
        y={d.y}
        width={d.w}
        height={d.h}
        fill={d.fill}
        stroke={d.stroke}
        strokeWidth={d.sw}
      />
    );
  if (d.t === "line")
    return (
      <line
        x1={d.x1}
        y1={d.y1}
        x2={d.x2}
        y2={d.y2}
        stroke={d.stroke}
        strokeWidth={d.sw}
        strokeLinecap={d.cap}
      />
    );
  return (
    <text
      x={d.x}
      y={d.y}
      fontSize={d.size}
      fontWeight={d.weight}
      fill={d.fill}
      textAnchor={d.anchor}
      transform={d.rotate ? `rotate(${d.rotate} ${d.x} ${d.y})` : undefined}
    >
      {d.text}
    </text>
  );
}

/**
 * 11 Nov: "Clean up with AI". Reads the rough sketch into a plan, shows it
 * over the sketch for a person to check — drag a room to move it, its corner
 * to resize, rename it, fix a size — and saves it as a new sketch beside the
 * original, carrying the marks across.
 */
export function SketchCleanupDialog({
  sketch,
  job,
  marks,
  onClose,
  onCreated,
}: {
  sketch: RoomSketch;
  job: { id: string; location_id: string };
  /** The marks on the rough sketch right now, saved or not. */
  marks: readonly SketchAnnotation[];
  onClose: () => void;
  onCreated: (sketchId: string) => void;
}) {
  const app = useAppContext();
  const read = useServerFn(readSketchPlan);
  const { width: w, height: h } = sketch;
  const unit = Math.max(w, h);
  const [plan, setPlan] = useState<SketchPlan | null>(null);
  const [phase, setPhase] = useState<"reading" | "review" | "saving" | "failed">("reading");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [underlay, setUnderlay] = useState(true);
  const [carry, setCarry] = useState(marks.length > 0);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);

  const run = useCallback(async () => {
    setPhase("reading");
    setError(null);
    try {
      const image = await readSketchImage(sketch.document_id);
      const res = await read({ data: { image_data_url: image.dataUrl } });
      if (!res.ok) {
        setError(res.error);
        setPhase("failed");
        return;
      }
      // Keep the model's layout and sizes; put them where the pen actually drew.
      setPlan(image.ink ? fitPlan(res.plan, image.ink) : res.plan);
      setSelected(null);
      setPhase("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The sketch could not be read.");
      setPhase("failed");
    }
  }, [read, sketch.document_id]);

  useEffect(() => {
    void run();
  }, [run]);

  const at = (e: React.PointerEvent): [number, number] | null => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return null;
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return [p.x / w, p.y / h];
  };

  const begin = (e: React.PointerEvent, index: number, mode: "move" | "resize") => {
    if (!plan) return;
    const p = at(e);
    if (!p) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const r = plan.rooms[index]!;
    drag.current = { mode, index, start: p, box: { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 } };
    setSelected(index);
  };

  const beginAll = (e: React.PointerEvent, mode: "moveAll" | "scaleAll") => {
    const box = plan ? planBounds(plan) : null;
    const p = at(e);
    if (!plan || !box || !p) return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { mode, start: p, plan, box };
    setSelected(null);
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = d ? at(e) : null;
    if (!d || !p) return;
    const dx = p[0] - d.start[0];
    const dy = p[1] - d.start[1];
    const b = d.box;
    if (d.mode === "moveAll" || d.mode === "scaleAll") {
      const to: Box =
        d.mode === "moveAll"
          ? (() => {
              const ox = Math.min(1 - b.x1, Math.max(-b.x0, dx));
              const oy = Math.min(1 - b.y1, Math.max(-b.y0, dy));
              return { x0: b.x0 + ox, y0: b.y0 + oy, x1: b.x1 + ox, y1: b.y1 + oy };
            })()
          : {
              x0: b.x0,
              y0: b.y0,
              x1: clamp01(Math.max(b.x0 + 0.05, b.x1 + dx)),
              y1: clamp01(Math.max(b.y0 + 0.05, b.y1 + dy)),
            };
      setPlan(fitPlan(d.plan, to));
      return;
    }
    const next: Box =
      d.mode === "move"
        ? (() => {
            const ox = Math.min(1 - b.x1, Math.max(-b.x0, dx));
            const oy = Math.min(1 - b.y1, Math.max(-b.y0, dy));
            return { x0: b.x0 + ox, y0: b.y0 + oy, x1: b.x1 + ox, y1: b.y1 + oy };
          })()
        : {
            x0: b.x0,
            y0: b.y0,
            x1: clamp01(Math.max(b.x0 + 0.02, b.x1 + dx)),
            y1: clamp01(Math.max(b.y0 + 0.02, b.y1 + dy)),
          };
    if (!("index" in d)) return;
    const index = d.index;
    setPlan((pl) =>
      pl ? { ...pl, rooms: pl.rooms.map((r, i) => (i === index ? { ...r, ...next } : r)) } : pl,
    );
  };

  const end = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.mode === "moveAll" || d.mode === "scaleAll") return;
    // Line the moved wall up with its neighbours, as the first read did.
    setPlan((pl) => (pl ? snapPlan(pl, 0.008) : pl));
  };

  const editRoom = (index: number, patch: Partial<SketchPlan["rooms"][number]>) =>
    setPlan((pl) =>
      pl ? { ...pl, rooms: pl.rooms.map((r, i) => (i === index ? { ...r, ...patch } : r)) } : pl,
    );

  const save = async () => {
    if (!plan) return;
    setPhase("saving");
    try {
      const blob = await planPng(plan, w, h);
      const name = `${sketch.name} (clean)`;
      const doc = await uploadDocumentFile({
        file: new File([blob], `sketch-clean-${Date.now()}.png`, { type: "image/png" }),
        scope: { locationId: job.location_id, jobId: job.id },
        docType: "other",
        userId: app.userId ?? null,
        name: `Sketch — ${name}.png`,
      });
      const id = await createRoomSketch({
        jobId: job.id,
        roomId: sketch.room_id,
        floorLabel: sketch.floor_label,
        name,
        documentId: doc.id,
        width: w,
        height: h,
        userId: app.userId ?? null,
      });
      if (carry && marks.length > 0) await saveSketchAnnotations(id, marks);
      toast.success("Clean plan saved beside the original sketch");
      onCreated(id);
    } catch (e) {
      setPhase("review");
      toastDbError(e, { action: "Save the clean plan" });
    }
  };

  const items = plan ? planDrawing(plan, w, h) : [];
  const handle = unit / 70;
  const all = plan ? planBounds(plan) : null;

  return (
    <Dialog open onOpenChange={(v) => !v && phase !== "saving" && onClose()}>
      <DialogContent className="flex max-h-[100svh] w-full max-w-6xl flex-col gap-3 overflow-hidden p-3 sm:p-4">
        <DialogHeader>
          <DialogTitle>Clean up with AI — {sketch.name}</DialogTitle>
          <DialogDescription>
            Check the clean plan against your sketch underneath. Drag a room to move it, or its blue
            corner to resize it; drag the orange frame to move the whole plan, or its orange corner
            to scale it. Fix any name or size on the right. The original sketch is kept.
          </DialogDescription>
        </DialogHeader>

        {phase === "reading" && (
          <div className="flex h-[50svh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            Reading the sketch — rooms, sizes and stairs…
          </div>
        )}

        {phase === "failed" && (
          <div className="flex h-[40svh] flex-col items-center justify-center gap-3 text-center">
            <p className="max-w-md text-sm text-destructive">{error}</p>
            <Button type="button" variant="outline" onClick={() => void run()}>
              <RefreshCw className="mr-1.5 size-4" /> Try again
            </Button>
          </div>
        )}

        {plan && (phase === "review" || phase === "saving") && (
          <div className="grid min-h-0 flex-1 gap-3 overflow-hidden lg:grid-cols-[minmax(0,1fr)_18rem]">
            <div className="min-h-0 overflow-hidden rounded-md border bg-white">
              <svg
                ref={svgRef}
                viewBox={`0 0 ${w} ${h}`}
                className="h-[55svh] w-full sm:h-[62svh]"
                preserveAspectRatio="xMidYMid meet"
                fontFamily={PLAN_FONT}
                style={{ touchAction: "none" }}
                onPointerMove={move}
                onPointerUp={end}
                onPointerCancel={end}
                onPointerDown={() => setSelected(null)}
                data-clean-plan
              >
                {items.slice(0, 1).map((d, i) => (
                  <Item key={`bg${i}`} d={d} />
                ))}
                {underlay && (
                  <image
                    href={documentFileUrl(sketch.document_id)}
                    x={0}
                    y={0}
                    width={w}
                    height={h}
                    opacity={0.28}
                  />
                )}
                {items.slice(1).map((d, i) => (
                  <Item key={i} d={d} />
                ))}
                {all && (
                  <g data-plan-frame>
                    {/* The whole plan: drag the frame's edge to move it all, the
                        corner square to scale it all. */}
                    <rect
                      x={all.x0 * w - handle}
                      y={all.y0 * h - handle}
                      width={(all.x1 - all.x0) * w + handle * 2}
                      height={(all.y1 - all.y0) * h + handle * 2}
                      fill="none"
                      stroke="rgb(217 119 6)"
                      strokeWidth={handle * 0.9}
                      strokeOpacity={0.55}
                      style={{ cursor: "move" }}
                      pointerEvents="stroke"
                      onPointerDown={(e) => beginAll(e, "moveAll")}
                    />
                    <rect
                      x={all.x1 * w + handle * 0.2}
                      y={all.y1 * h + handle * 0.2}
                      width={handle * 1.8}
                      height={handle * 1.8}
                      fill="rgb(217 119 6)"
                      stroke="#fff"
                      strokeWidth={handle / 4}
                      style={{ cursor: "nwse-resize" }}
                      onPointerDown={(e) => beginAll(e, "scaleAll")}
                      aria-label="Scale the whole plan"
                    />
                  </g>
                )}
                {plan.rooms.map((r, i) => {
                  const [x, y, bw, bh] = [r.x0 * w, r.y0 * h, (r.x1 - r.x0) * w, (r.y1 - r.y0) * h];
                  return (
                    <g key={`h${i}`} data-plan-room={r.name}>
                      <rect
                        x={x}
                        y={y}
                        width={bw}
                        height={bh}
                        fill={selected === i ? "rgb(31 115 219 / 0.08)" : "transparent"}
                        stroke={selected === i ? "rgb(31 115 219)" : "none"}
                        strokeWidth={unit / 300}
                        strokeDasharray={`${unit / 120} ${unit / 200}`}
                        style={{ cursor: "move" }}
                        onPointerDown={(e) => begin(e, i, "move")}
                      />
                      <circle
                        cx={x + bw}
                        cy={y + bh}
                        r={handle}
                        fill="rgb(31 115 219)"
                        stroke="#fff"
                        strokeWidth={handle / 4}
                        style={{ cursor: "nwse-resize" }}
                        onPointerDown={(e) => begin(e, i, "resize")}
                        aria-label={`Resize ${r.name}`}
                      />
                    </g>
                  );
                })}
              </svg>
            </div>

            <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
              <label className="space-y-1">
                <span className="block text-xs font-medium text-muted-foreground">
                  Floor heading
                </span>
                <Input
                  value={plan.title ?? ""}
                  placeholder="1st Floor"
                  onChange={(e) => setPlan({ ...plan, title: e.target.value || null })}
                />
              </label>
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs font-medium text-muted-foreground">
                  Rooms · {plan.rooms.length}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8"
                  onClick={() => {
                    setPlan({ ...plan, rooms: [...plan.rooms, newPlanRoom()] });
                    setSelected(plan.rooms.length);
                  }}
                >
                  <Plus className="mr-1 size-3.5" /> Add room
                </Button>
              </div>
              <ul className="space-y-2">
                {plan.rooms.map((r, i) => (
                  <li
                    key={i}
                    className={cn(
                      "space-y-1.5 rounded-md border p-2",
                      selected === i && "border-primary ring-1 ring-primary/40",
                    )}
                    onFocusCapture={() => setSelected(i)}
                  >
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="h-8"
                        aria-label="Room name"
                        value={r.name}
                        onChange={(e) => editRoom(i, { name: e.target.value })}
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0"
                        aria-label={`Remove ${r.name}`}
                        onClick={() => {
                          setPlan({ ...plan, rooms: plan.rooms.filter((_, j) => j !== i) });
                          setSelected(null);
                        }}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <Input
                        className="h-8"
                        aria-label={`${r.name} width`}
                        placeholder="Width"
                        value={r.width ?? ""}
                        onChange={(e) => editRoom(i, { width: e.target.value || null })}
                      />
                      <Input
                        className="h-8"
                        aria-label={`${r.name} length`}
                        placeholder="Length"
                        value={r.length ?? ""}
                        onChange={(e) => editRoom(i, { length: e.target.value || null })}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-2">
              <Checkbox checked={underlay} onCheckedChange={(v) => setUnderlay(v === true)} />
              Show my sketch underneath
            </label>
            {marks.length > 0 && (
              <label className="flex items-center gap-2">
                <Checkbox checked={carry} onCheckedChange={(v) => setCarry(v === true)} />
                Bring my {marks.length} mark{marks.length === 1 ? "" : "s"} onto the clean plan
              </label>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-9"
              disabled={phase === "reading" || phase === "saving"}
              onClick={() => void run()}
            >
              <RefreshCw className="mr-1.5 size-4" /> Read again
            </Button>
            <Button
              type="button"
              className="h-11 sm:h-9"
              disabled={!plan || plan.rooms.length === 0 || phase !== "review"}
              onClick={() => void save()}
            >
              <Save className="mr-1.5 size-4" />
              {phase === "saving" ? "Saving…" : "Save clean plan"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
