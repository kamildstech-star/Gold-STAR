/**
 * The Draw tool's options on a room sketch (12 Nov: "make it simple, give all
 * shades inside the Draw"). Three dropdowns became three rows of buttons, all
 * on show while Draw is on: the shape, every colour as a round swatch, and
 * every cut preset as a fill (or none). Picking a fill on a line or an arrow
 * turns it into a rectangle, so the fill always has somewhere to go.
 *
 * The preset patterns and their small swatch live here too: the sketch view,
 * its legend and every picker draw a preset the same way.
 */
import { ArrowUpRight, Check, Circle, Slash, Square } from "lucide-react";
import { useId, type ReactNode } from "react";

import {
  SKETCH_INKS,
  SKETCH_INKS_OFFERED,
  SKETCH_SHADES,
  SKETCH_SHADES_OFFERED,
  SKETCH_SHAPES,
  inkCss,
  isClosedShape,
  shadeCss,
  withDrawFill,
  withDrawShape,
  type DrawStyle,
  type SketchShade,
  type SketchShapeKind,
} from "@/lib/room-sketch";
import { cn } from "@/lib/utils";

/** One pattern per line preset: a pale wash with the preset's lines over it. */
export function ShadePatterns({
  idFor,
  size,
  stroke,
}: {
  idFor: (s: SketchShade) => string;
  size: number;
  stroke: number;
}) {
  return (
    <defs>
      {(Object.keys(SKETCH_SHADES) as SketchShade[]).map((k) => {
        const p = SKETCH_SHADES[k].pattern;
        if (p === "tint" || p === "solid" || p === "outline") return null;
        if (p === "dotted") {
          return (
            <pattern key={k} id={idFor(k)} patternUnits="userSpaceOnUse" width={size} height={size}>
              <rect width={size} height={size} fill={shadeCss(k, 0.12)} />
              <circle cx={size / 2} cy={size / 2} r={size * 0.17} fill={shadeCss(k, 0.95)} />
            </pattern>
          );
        }
        const line =
          p === "horizontal"
            ? `M 0 ${size / 2} H ${size}`
            : p === "vertical"
              ? `M ${size / 2} 0 V ${size}`
              : p === "diagonal_up"
                ? `M 0 ${size} L ${size} 0 M ${-size / 2} ${size / 2} L ${size / 2} ${-size / 2} M ${size / 2} ${size * 1.5} L ${size * 1.5} ${size / 2}`
                : `M 0 0 L ${size} ${size} M ${-size / 2} ${size / 2} L ${size / 2} ${size * 1.5} M ${size / 2} ${-size / 2} L ${size * 1.5} ${size / 2}`;
        return (
          <pattern key={k} id={idFor(k)} patternUnits="userSpaceOnUse" width={size} height={size}>
            <rect width={size} height={size} fill={shadeCss(k, 0.14)} />
            <path d={line} stroke={shadeCss(k, 0.95)} strokeWidth={stroke} />
          </pattern>
        );
      })}
    </defs>
  );
}

/** A small swatch of a preset, for the pickers. */
export function ShadeSwatch({ shade, className }: { shade: SketchShade; className?: string }) {
  // Its own ids: the picker shows the same swatch in the trigger and the list.
  const uid = useId().replace(/:/g, "");
  const idFor = (s: SketchShade) => `swatch-${uid}-${s}`;
  return (
    <svg viewBox="0 0 20 12" className={cn("h-3 w-5 shrink-0", className)} aria-hidden>
      <ShadePatterns idFor={idFor} size={5} stroke={1} />
      <rect
        width={20}
        height={12}
        fill={
          SKETCH_SHADES[shade].pattern === "solid"
            ? shadeCss(shade, 0.6)
            : SKETCH_SHADES[shade].pattern === "outline"
              ? "none"
              : `url(#${idFor(shade)})`
        }
        stroke={shadeCss(shade)}
        strokeWidth={1}
      />
    </svg>
  );
}

const SHAPE_ICONS: Record<SketchShapeKind, ReactNode> = {
  line: <Slash className="size-4" />,
  arrow: <ArrowUpRight className="size-4" />,
  circle: <Circle className="size-4" />,
  rect: <Square className="size-4" />,
};

/** A row of options under a small heading; wraps on a phone. */
function OptionRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1.5">
      <span className="w-12 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Pressed: the app's ring, so it reads in every palette, light and dark. */
const PRESSED = "border-primary ring-2 ring-primary ring-offset-1 ring-offset-background";

/**
 * Shape, colour and fill for the Draw tool, as tap-sized buttons (40px on a
 * phone, 32px on a desktop).
 */
export function SketchDrawOptions({
  value,
  onChange,
  disabled,
}: {
  value: DrawStyle;
  onChange: (next: DrawStyle) => void;
  disabled?: boolean;
}) {
  const filled = value.fill !== "none" && isClosedShape(value.shape);
  return (
    <div
      className="flex flex-col gap-2 rounded-md border bg-card p-2 text-card-foreground"
      aria-label="Draw options"
      data-draw-options
    >
      <OptionRow label="Shape">
        {(Object.keys(SKETCH_SHAPES) as SketchShapeKind[]).map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            aria-pressed={value.shape === k}
            aria-label={SKETCH_SHAPES[k]}
            title={SKETCH_SHAPES[k]}
            onClick={() => onChange(withDrawShape(value, k))}
            className={cn(
              "inline-flex size-10 items-center justify-center rounded-md border border-input bg-background text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 sm:size-8",
              value.shape === k && PRESSED,
            )}
          >
            {SHAPE_ICONS[k]}
          </button>
        ))}
      </OptionRow>

      <OptionRow label="Colour">
        {SKETCH_INKS_OFFERED.map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            aria-pressed={value.ink === k}
            aria-label={SKETCH_INKS[k].label}
            title={
              filled
                ? `${SKETCH_INKS[k].label} — a filled shape is drawn in its fill's colour`
                : SKETCH_INKS[k].label
            }
            onClick={() => onChange({ ...value, ink: k })}
            className={cn(
              "inline-flex size-10 items-center justify-center rounded-full border-2 border-background transition-transform hover:scale-105 disabled:opacity-50 sm:size-8",
              value.ink === k && PRESSED,
              filled && value.ink !== k && "opacity-60",
            )}
            style={{ backgroundColor: inkCss(k) }}
            data-ink={k}
          >
            {value.ink === k && (
              <Check className="size-4 text-white drop-shadow-[0_0_1px_rgb(0_0_0/0.9)]" />
            )}
          </button>
        ))}
      </OptionRow>

      <OptionRow label="Fill">
        {(["none", ...SKETCH_SHADES_OFFERED] as const).map((k) => {
          const on = k === "none" ? !filled : filled && value.fill === k;
          return (
            <button
              key={k}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onChange(withDrawFill(value, k))}
              className={cn(
                "inline-flex h-10 items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 sm:h-8 sm:px-2 sm:text-xs",
                on && PRESSED,
              )}
              data-fill={k}
            >
              {k === "none" ? (
                <span
                  className="h-4 w-6 shrink-0 rounded-sm border-2 border-foreground/70"
                  aria-hidden
                />
              ) : (
                <ShadeSwatch shade={k} className="h-4 w-6" />
              )}
              {k === "none" ? "No fill" : SKETCH_SHADES[k].label}
            </button>
          );
        })}
      </OptionRow>
    </div>
  );
}
