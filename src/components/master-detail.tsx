import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ResizeHandle } from "@/components/resize-handle";

/**
 * Master-detail split. The list stays on the left and stays scrollable; the
 * record opens beside it so a manager can walk a list of overdue accounts with
 * the arrow keys and never trigger a page load.
 *
 * On mobile there is no room for a split, so the detail falls back to the
 * full-screen sheet the drawers already render.
 */

type DetailSurface = {
  /** True when the detail is rendered inline in the split panel. */
  inPanel: boolean;
  close: () => void;
  /** Full-record route for the expand control. */
  expandHref?: string;
};

const SurfaceCtx = createContext<DetailSurface | null>(null);

/**
 * Lets rows and cards deep inside a list open the side panel instead of
 * navigating away. Any row nav whose href starts with `prefix` is intercepted.
 */
type RowSelect = { prefix: string; select: (id: string) => void };
const RowSelectCtx = createContext<RowSelect | null>(null);
export function useRowSelectIntercept() {
  return useContext(RowSelectCtx);
}

export function useDetailSurface() {
  return useContext(SurfaceCtx);
}

const MIN_PCT = 28;
const MAX_PCT = 68;

function widthKey(k: string) {
  return `md.width.${k}`;
}

export function useIsNarrow(query = "(max-width: 1023px)") {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return narrow;
}

/** Remembered collapsed state for the panel's sections. */
export function useSectionCollapse(scope: string) {
  const key = `md.sections.${scope}`;
  const [state, setState] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) setState(JSON.parse(raw) as Record<string, boolean>);
    } catch {
      /* ignore */
    }
  }, [key]);
  const write = useCallback(
    (next: Record<string, boolean>) => {
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    },
    [key],
  );
  const toggle = useCallback(
    (id: string) => setState((prev) => write({ ...prev, [id]: !prev[id] })),
    [write],
  );
  /** Expand or collapse every known section in one action. */
  const setAll = useCallback(
    (ids: string[], collapsedValue: boolean) =>
      setState((prev) =>
        write({ ...prev, ...Object.fromEntries(ids.map((id) => [id, collapsedValue])) }),
      ),
    [write],
  );
  return { collapsed: state, toggle, setAll };
}

export function MasterDetail({
  storageKey,
  selectedId,
  onSelect,
  order,
  detail,
  expandHref,
  interceptPrefix,
  children,
}: {
  storageKey: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Visible row order, used for arrow-key navigation. */
  order: string[];
  detail: ReactNode;
  expandHref?: string;
  /** Route prefix (e.g. "/accounts/") whose row clicks select instead of navigate. */
  interceptPrefix?: string;
  children: ReactNode;
}) {
  const narrow = useIsNarrow();
  const containerRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(44);

  useEffect(() => {
    const raw = localStorage.getItem(widthKey(storageKey));
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n)) setPct(Math.min(MAX_PCT, Math.max(MIN_PCT, n)));
  }, [storageKey]);

  const open = !!selectedId;

  // Arrow keys walk the list; escape closes. Typing in a field is left alone.
  useEffect(() => {
    if (!open || narrow) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      if (e.key === "Escape" && !typing) {
        onSelect(null);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const i = order.indexOf(selectedId!);
      if (i === -1) return;
      const next = order[e.key === "ArrowDown" ? i + 1 : i - 1];
      if (!next) return;
      e.preventDefault();
      onSelect(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, narrow, order, selectedId, onSelect]);

  const onDrag = (clientX: number) => {
    if (!containerRef.current) return;
    const r = containerRef.current.getBoundingClientRect();
    setPct(Math.min(MAX_PCT, Math.max(MIN_PCT, ((r.right - clientX) / r.width) * 100)));
  };
  const commit = () => localStorage.setItem(widthKey(storageKey), String(Math.round(pct)));

  const wrap = (node: ReactNode) =>
    interceptPrefix ? (
      <RowSelectCtx.Provider value={{ prefix: interceptPrefix, select: onSelect }}>
        {node}
      </RowSelectCtx.Provider>
    ) : (
      node
    );

  if (narrow) {
    // The drawer renders itself as a full-screen sheet here.
    return (
      <SurfaceCtx.Provider value={{ inPanel: false, close: () => onSelect(null), expandHref }}>
        {wrap(children)}
        {detail}
      </SurfaceCtx.Provider>
    );
  }

  return (
    <div ref={containerRef} className="flex w-full items-stretch gap-0">
      <div className="min-w-0 flex-1 overflow-x-hidden">{wrap(children)}</div>
      {open && (
        <>
          <ResizeHandle
            label="Resize detail panel"
            onMove={onDrag}
            onCommit={commit}
            onReset={() => {
              setPct(44);
              localStorage.setItem(widthKey(storageKey), "44");
            }}
            className="sticky top-0 h-[calc(100vh-150px)]"
          />
          <div
            className="sticky top-0 h-[calc(100vh-150px)] min-w-0 shrink-0 overflow-hidden border-l bg-card"
            style={{ width: `${pct}%` }}
          >
            <SurfaceCtx.Provider value={{ inPanel: true, close: () => onSelect(null), expandHref }}>
              {detail}
            </SurfaceCtx.Provider>
          </div>
        </>
      )}
    </div>
  );
}
