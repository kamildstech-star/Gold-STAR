/**
 * Whole rows and whole cards are the click target.
 *
 * Three rules this enforces so we do not reinvent it per screen:
 *  - the primary name stays a real <a>, so middle-click and open-in-new-tab
 *    keep working; the row handler is additive, never a replacement;
 *  - the row is focusable and activates on Enter or Space;
 *  - a drag is not a click. On boards we measure pointer travel and ignore
 *    anything past a small threshold.
 *
 * Nested controls (checkboxes, menus, stage selects, label pills) must be
 * wrapped in <StopClick> or spread {stopRowClick} so they do not also fire
 * the row navigation.
 */
import * as React from "react";
import { useRouter } from "@tanstack/react-router";

import { useRowSelectIntercept } from "@/components/master-detail";

const DRAG_THRESHOLD_PX = 6;

/** Spread onto any control nested inside a clickable row or card. */
export const stopRowClick = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
};

export function StopClick({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span className={className} {...stopRowClick}>
      {children}
    </span>
  );
}

export type RowNavProps = {
  role: "link";
  tabIndex: number;
  onClick: (e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
};

/**
 * Row/card navigation props. Pass the same href you render on the primary
 * link so the two never disagree. Returns undefined when there is no target.
 */
export function useRowNav(href: string | null | undefined): RowNavProps | undefined {
  const router = useRouter();
  const intercept = useRowSelectIntercept();
  const origin = React.useRef<{ x: number; y: number } | null>(null);

  return React.useMemo(() => {
    if (!href) return undefined;
    const go = () => {
      // Inside a master-detail list the record opens in the side panel.
      if (intercept && href.startsWith(intercept.prefix)) {
        const id = href.slice(intercept.prefix.length);
        if (id && !id.includes("/")) {
          intercept.select(id);
          return;
        }
      }
      router.navigate({ to: href } as never);
    };
    return {
      role: "link" as const,
      tabIndex: 0,
      onPointerDown: (e: React.PointerEvent) => {
        origin.current = { x: e.clientX, y: e.clientY };
      },
      onClick: (e: React.MouseEvent) => {
        // Let the browser handle real links, modified clicks and form controls.
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest("a,button,input,select,textarea,[role='menuitem'],[data-no-row-nav]"))
          return;
        // A drag is not a tap.
        const from = origin.current;
        origin.current = null;
        if (
          from &&
          (Math.abs(e.clientX - from.x) > DRAG_THRESHOLD_PX ||
            Math.abs(e.clientY - from.y) > DRAG_THRESHOLD_PX)
        )
          return;
        if (window.getSelection()?.toString()) return;
        go();
      },
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          go();
        }
      },
    };
  }, [href, router, intercept]);
}

/** Visual affordance shared by every clickable row and card. */
export const ROW_NAV_CLASS =
  "cursor-pointer transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
