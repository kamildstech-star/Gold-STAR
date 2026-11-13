import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * One drag handle for every resizable panel in the app — the left nav and the
 * right detail panel behave identically because they are literally the same
 * control. It owns pointer capture and the hover/drag affordance; the panel
 * owns what a given cursor position means in its own units.
 */
export function ResizeHandle({
  label,
  onMove,
  onCommit,
  onReset,
  className,
}: {
  label: string;
  /** Called continuously during the drag with the pointer's page X. */
  onMove: (clientX: number) => void;
  /** Called once when the drag ends — persist here, not on every frame. */
  onCommit?: () => void;
  /** Double-click restores the default width. */
  onReset?: () => void;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);

  const start = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const move = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      onMove(e.clientX);
    },
    [dragging, onMove],
  );

  const end = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      setDragging(false);
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      onCommit?.();
    },
    [dragging, onCommit],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      data-dragging={dragging ? "true" : undefined}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      // A wide invisible hit area over a hairline: easy to grab, quiet to look at.
      className={cn(
        "group/resize relative w-1.5 shrink-0 cursor-col-resize touch-none select-none bg-border/60 transition-colors",
        "hover:bg-primary/50 data-[dragging=true]:bg-primary",
        "after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5 after:content-['']",
        className,
      )}
    />
  );
}
