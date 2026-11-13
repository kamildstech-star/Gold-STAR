import type { PhotoMarkupDoc } from "@/lib/photo-markup";

/**
 * The read path for markup: an SVG laid exactly over the image, so strokes stay
 * crisp at any zoom instead of blurring the way a scaled raster would.
 *
 * The viewBox carries the photo's own aspect rather than a flat 0..1 box —
 * stretching a square box onto a landscape photo would draw ellipses, not
 * circles.
 *
 * Shared by the job's photo viewer and the public share gallery. A second copy
 * would eventually draw the same annotation two different ways, and the whole
 * point of the share link's "hide markup" switch is that the recipient and the
 * sender are looking at the same marks.
 */
export function MarkupOverlay({
  doc,
  aspect,
  focus,
}: {
  doc: PhotoMarkupDoc;
  /** naturalWidth / naturalHeight. */
  aspect: number;
  /** Where a label is being typed, so an empty box still shows its spot. */
  focus?: [number, number] | null;
}) {
  const h = 1000 / aspect;
  return (
    <svg
      viewBox={`0 0 1000 ${h}`}
      preserveAspectRatio="none"
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {doc.strokes.map((s, i) =>
        s.points.length === 1 ? (
          <circle
            key={i}
            cx={s.points[0]![0] * 1000}
            cy={s.points[0]![1] * h}
            r={(s.width * 1000) / 2}
            fill={s.color}
          />
        ) : (
          <polyline
            key={i}
            points={s.points.map(([x, y]) => `${x * 1000},${y * h}`).join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width * 1000}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
      {doc.texts.map((t, i) => (
        <text
          key={`t${i}`}
          x={t.x * 1000}
          y={t.y * h}
          fontSize={t.size * 1000}
          fill={t.color}
          // Colour alone does not survive a photograph — yellow on a lit
          // ceiling is nothing at all. The glyphs are painted over their own
          // dark outline so a label reads against whatever is behind it.
          stroke="#0A0A0A"
          strokeWidth={t.size * 170}
          strokeLinejoin="round"
          paintOrder="stroke"
          textAnchor="middle"
          dominantBaseline="middle"
          fontWeight={700}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          {t.text}
        </text>
      ))}
      {focus && (
        <circle
          cx={focus[0] * 1000}
          cy={focus[1] * h}
          r={16}
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={4}
          strokeDasharray="9 7"
        />
      )}
    </svg>
  );
}
