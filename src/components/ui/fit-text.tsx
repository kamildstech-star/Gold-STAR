import * as React from "react";

import { FIT_FLOOR, fitScale, overflowsAtFloor } from "@/lib/fit-text";
import { cn } from "@/lib/utils";

/**
 * Text that shrinks to fit its box instead of being cut off.
 *
 * Mark, from a screenshot of the dashboard where OUTSTANDING A/R read
 * "$394,…": "we need the words to be auto resizing so there are no ...
 * anywhere"
 *
 * Every big number in the app used to sit in a `truncate` box, which is the
 * class that draws the "…". That is the right call for a customer's name in a
 * table cell, where a shorter name is still the name, but a number with its
 * last digits missing is a different number. This wraps the value instead:
 * it renders at full size, and when the box is narrower than the text it
 * scales the text down by exactly the ratio needed, so "$394,821" in a
 * 122px tile comes out at 84% and every digit is there.
 *
 * How it measures. One ResizeObserver watches two things: the box, and the
 * span holding the text, which is never allowed to wrap so its layout width
 * is always "how wide would this be on one line at full size" — a transform
 * does not change a layout width, so that stays true after it is scaled.
 * Both widths arrive in the observer callback, so there is no `scrollWidth`
 * read anywhere and no forced layout — the box shrinking (sidebar opens,
 * Client 360 panel slides in) or the value changing (a refetch lands a
 * bigger number) each fire the observer on their own.
 *
 * Why `transform` and not `font-size`. The KPI strip is five tiles side by
 * side with a label and a delta chip under each numeral. Setting a smaller
 * font-size shrinks the line box, so the label in the one tile that needed
 * shrinking would sit higher than in its four neighbours. A transform leaves
 * layout untouched — the line box stays 32px tall, the label stays put, and
 * because layout never changes with the scale the observer cannot loop on
 * itself. The visual is scaled in the browser's compositor and re-rasterised
 * at the final scale, so the text is sharp, not a blurry bitmap.
 *
 * The floor. `minScale` stops a pathological value shrinking to nothing;
 * the default is half (`FIT_FLOOR`), so a 32px numeral bottoms out at 16px.
 * Below that the component gives up on one line: it drops the transform,
 * sets the font-size to the floor for real, and lets the value wrap onto a
 * second line, breaking anywhere it has to. Every digit is still visible.
 * There is no code path that produces an ellipsis. Only in that state is a
 * hidden, never-wrapping copy of the text mounted to keep measuring the
 * one-line width; the rest of the time the DOM holds the value exactly once,
 * so nothing that reads the text (a test, a copy to the clipboard) sees it
 * doubled.
 *
 * Nothing is animated. A number snapping to its new size on a resize is
 * fine, and it means there is nothing to gate behind prefers-reduced-motion.
 *
 * On the server there is no observer, so the first paint is the text at
 * full size; the observer's first delivery lands before the next paint after
 * hydration (it is set up in a layout effect), so a value that needs
 * shrinking does not flash at full size first.
 */
export function FitText({
  children,
  className,
  minScale = FIT_FLOOR,
  ...rest
}: Omit<React.ComponentProps<"span">, "children"> & {
  children: React.ReactNode;
  /** Lowest scale before the text is allowed to wrap instead. 0–1. */
  minScale?: number;
}) {
  const boxRef = React.useRef<HTMLSpanElement>(null);
  const [scale, setScale] = React.useState(1);
  const [wrapped, setWrapped] = React.useState(false);

  // The observer lives as long as the box does, and the widths it has seen
  // are kept across every delivery: a value change only reports the text, a
  // resize only reports the box. The one-line span is a different element on
  // each side of the wrapped switch, so it is swapped in and out of the SAME
  // observer through a callback ref rather than by rebuilding the observer.
  // Rebuilding it was tried first and oscillated: an observer created inside
  // a delivery cycle only gets the deeper of its two targets that cycle, so
  // the box width read as "unmeasured", which reads as "fits", which undid
  // the wrap that had just been decided.
  const observerRef = React.useRef<ResizeObserver | null>(null);
  const textElRef = React.useRef<HTMLSpanElement | null>(null);
  const widths = React.useRef({ available: 0, natural: 0 });
  const floorRef = React.useRef(minScale);
  floorRef.current = minScale;

  const setText = React.useCallback((el: HTMLSpanElement | null) => {
    const observer = observerRef.current;
    if (observer && textElRef.current) observer.unobserve(textElRef.current);
    textElRef.current = el;
    if (observer && el) observer.observe(el);
  }, []);

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === box) widths.current.available = entry.contentRect.width;
        else if (entry.target === textElRef.current)
          widths.current.natural = entry.contentRect.width;
      }
      const { natural, available } = widths.current;
      setScale(fitScale(natural, available, floorRef.current));
      setWrapped(overflowsAtFloor(natural, available, floorRef.current));
    });
    observer.observe(box);
    if (textElRef.current) observer.observe(textElRef.current);
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  // A new floor is a new decision on the same widths.
  React.useEffect(() => {
    const { natural, available } = widths.current;
    setScale(fitScale(natural, available, minScale));
    setWrapped(overflowsAtFloor(natural, available, minScale));
  }, [minScale]);

  return (
    <span
      ref={boxRef}
      data-fit-scale={scale}
      data-fit-wrapped={wrapped || undefined}
      // `min-w-0` so the box can be narrower than its text when it is itself
      // a flex item. The same rule as `truncate`: an ancestor flex item that
      // lacks `min-w-0` will refuse to shrink and the text will never need to.
      className={cn(
        "relative block min-w-0",
        wrapped ? "whitespace-normal" : "overflow-clip",
        className,
      )}
      {...rest}
    >
      {wrapped ? (
        <>
          <span style={{ fontSize: `${minScale}em`, overflowWrap: "anywhere" }}>{children}</span>
          {/* The measuring copy, only while wrapped. Hidden from readers and
              from the pointer; its only job is to have a width. */}
          <span
            ref={setText}
            aria-hidden
            className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap"
          >
            {children}
          </span>
        </>
      ) : (
        <span
          ref={setText}
          className="inline-block whitespace-nowrap align-top"
          // Always scaled about the left edge. A run of text wider than its
          // line is start-aligned by the browser whatever `text-align` says,
          // and scaled to fit it spans the box exactly, so there is nothing
          // for a right or centre origin to do except push it off the edge.
          // At scale 1 the caller's `text-align` places it as before.
          style={
            scale < 1 ? { transform: `scale(${scale})`, transformOrigin: "left center" } : undefined
          }
        >
          {children}
        </span>
      )}
    </span>
  );
}
