/**
 * Cards packed into columns by height, shortest column first.
 *
 * CSS `columns` balances to a target height and honours break-inside-avoid by
 * pushing a card that will not fit into the next column — which leaves the
 * previous one ending halfway down the screen. One tall card is enough to open
 * a hole the height of a monitor, which is exactly what the Insurance card did.
 *
 * Reassignment is stable because every column is the same width: moving a card
 * between columns cannot change its height, so measuring once is enough and
 * there is no measure/relayout loop.
 */
import { Children, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export function Masonry({
  children,
  columns = 2,
  className,
  gap = "0.75rem",
}: {
  children: ReactNode;
  /** Collapses to one column on a phone regardless. */
  columns?: number;
  className?: string;
  gap?: string;
}) {
  const items = useMemo(() => Children.toArray(children).filter(Boolean), [children]);
  const nodes = useRef<(HTMLDivElement | null)[]>([]);
  const [heights, setHeights] = useState<number[]>([]);
  const isMobile = useIsMobile();

  /*
   * One column on a phone, decided in JS rather than by a `md:` class.
   *
   * The class-only version still packed the cards into two DOM columns and let
   * the grid stack them, which on a phone put every card of column one before
   * every card of column two — the authored order was silently shuffled, and
   * Notes could land above Customer. Choosing the count here keeps the phone
   * rendering a single list in the order the page wrote it.
   */
  const cols = isMobile ? 1 : Math.max(1, columns);

  useEffect(() => {
    // One column needs no heights: it never has to choose where a card goes.
    if (cols < 2) return;
    const els = nodes.current.slice(0, items.length).filter(Boolean) as HTMLDivElement[];
    if (els.length === 0) return;

    const read = () => {
      const next = nodes.current
        .slice(0, items.length)
        .map((el) => (el ? el.getBoundingClientRect().height : 0));
      setHeights((prev) =>
        prev.length === next.length && prev.every((h, i) => Math.abs(h - next[i]!) < 1)
          ? prev
          : next,
      );
    };

    read();
    const ro = new ResizeObserver(read);
    els.forEach((el) => ro.observe(el));
    return () => ro.disconnect();
  }, [items.length, cols]);

  /*
   * Greedy: walk the cards in their authored order and drop each one into
   * whichever column is currently shortest. Order still matters — a card the
   * page put first lands high — but no column is left short while another runs
   * on. Before the first measurement this degrades to round-robin, which is
   * what the browser would have done anyway.
   */
  const assignment = useMemo(() => {
    if (cols < 2) return [items.map((_, i) => i)];
    const out: number[][] = Array.from({ length: cols }, () => []);
    const totals = new Array(cols).fill(0);
    items.forEach((_, i) => {
      let target = 0;
      for (let c = 1; c < cols; c++) if (totals[c] < totals[target]) target = c;
      out[target]!.push(i);
      totals[target] += heights[i] ?? 1;
    });
    return out;
  }, [items, cols, heights]);

  return (
    /*
     * The column count is set twice on purpose. The class guarantees one column
     * on a phone from the first painted frame — `useIsMobile` only reports
     * after mount, and a flash of two columns on a 360px screen is worse than
     * anything it buys. The JS count above is what puts the cards back in their
     * authored order once it does.
     */
    <div
      className={cn(
        "grid grid-cols-1 items-start md:grid-cols-[repeat(var(--cols),1fr)]",
        className,
      )}
      style={{ gap, ["--cols" as string]: String(cols) }}
    >
      {assignment.map((col, ci) => (
        <div key={ci} className="flex min-w-0 flex-col" style={{ gap }}>
          {col.map((i) => (
            <div
              key={i}
              ref={(el) => {
                nodes.current[i] = el;
              }}
              className="min-w-0"
            >
              {items[i]}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
