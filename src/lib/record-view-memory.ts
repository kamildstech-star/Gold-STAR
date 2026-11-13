import { useEffect, useRef, type RefObject } from "react";

/**
 * Where somebody was on a record: which tab, and how far down.
 *
 * David, 22 Sep, on a job record: "if I go here now, and now I go back to
 * it... it still jumps out of that screen. It has to save where you're at."
 *
 * This is not the token-refresh teardown fixed on 17 Sep (tab-switch-state
 * test) — that was the whole tree remounting while he was in another browser
 * tab. This is ordinary in-app navigation: leave the job for the calendar, come
 * back, and the route component mounts fresh. Two things died with it:
 *
 *   - the open tab, which was `useState("general")` and nothing else;
 *   - the scroll position. The router's scroll restoration cannot help: the
 *     page scrolls inside the shell's <main>, not the window, and the record
 *     shows "Loading…" first, so at the moment the router would restore there
 *     is no page tall enough to scroll.
 *
 * So the record remembers both itself, keyed by record, for the browser
 * session (sessionStorage survives a reload; the in-memory copy covers a
 * browser that refuses storage). The scroll is put back once the record has
 * loaded, and keeps trying for a moment while tabs fill in beneath it.
 */

export type RecordView = { tab?: string; scrollTop?: number };

type Store = Pick<Storage, "getItem" | "setItem">;

const memory = new Map<string, RecordView>();
const storageKey = (key: string) => `record-view:${key}`;

function sessionStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function recallRecordView(key: string, store: Store | null = sessionStore()): RecordView {
  const held = memory.get(key);
  if (held) return held;
  try {
    const raw = store?.getItem(storageKey(key));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as RecordView;
    const view: RecordView = {};
    if (typeof parsed.tab === "string") view.tab = parsed.tab;
    if (typeof parsed.scrollTop === "number" && Number.isFinite(parsed.scrollTop)) {
      view.scrollTop = Math.max(0, parsed.scrollTop);
    }
    memory.set(key, view);
    return view;
  } catch {
    return {};
  }
}

export function rememberRecordView(
  key: string,
  patch: RecordView,
  store: Store | null = sessionStore(),
): void {
  const next = { ...recallRecordView(key, store), ...patch };
  memory.set(key, next);
  try {
    store?.setItem(storageKey(key), JSON.stringify(next));
  } catch {
    // Quota or a locked-down browser: the in-memory copy still covers the session.
  }
}

/** For tests: forget the in-memory copies. */
export function _resetRecordViewMemory(): void {
  memory.clear();
}

/** How long a restore keeps trying while tabs load their data beneath it. */
const RESTORE_WINDOW_MS = 2000;

/**
 * Keep a record's scroll position in its scroll container.
 *
 * `anchor` is any element inside the record; the container is the nearest
 * <main>, which is the shell's scrollport. `ready` is false while the record
 * is loading — nothing is saved or restored against a "Loading…" line.
 *
 * The restore gives up the moment the person scrolls themselves: a page that
 * yanks them back down after they have started reading is worse than one that
 * forgot.
 */
export function useRecordScrollMemory(
  key: string,
  ready: boolean,
  anchor: RefObject<HTMLElement | null>,
): void {
  const restoredFor = useRef<string | null>(null);

  useEffect(() => {
    if (!ready) return;
    const port = anchor.current?.closest("main");
    if (!port) return;

    let cancelled = false;
    let frame = 0;
    const stop = () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };

    if (restoredFor.current !== key) {
      restoredFor.current = key;
      const target = recallRecordView(key).scrollTop ?? 0;
      if (target > 0) {
        const until = performance.now() + RESTORE_WINDOW_MS;
        const step = () => {
          if (cancelled) return;
          const max = port.scrollHeight - port.clientHeight;
          port.scrollTop = Math.min(target, Math.max(0, max));
          if (max >= target || performance.now() > until) return;
          frame = requestAnimationFrame(step);
        };
        step();
      } else {
        port.scrollTop = 0;
      }
    }

    // A person's own scroll ends any restore still in flight.
    const byHand = () => stop();
    port.addEventListener("wheel", byHand, { passive: true });
    port.addEventListener("touchstart", byHand, { passive: true });
    port.addEventListener("keydown", byHand);

    let pending = 0;
    const onScroll = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        /* Leaving the record swaps the page under <main>, which clamps its
           scroll and fires one last event after the record is gone. That is
           the NEXT page's position, not this record's — the detached ref is
           how to tell. */
        if (!anchor.current?.isConnected) return;
        rememberRecordView(key, { scrollTop: port.scrollTop });
      });
    };
    port.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      stop();
      cancelAnimationFrame(pending);
      port.removeEventListener("wheel", byHand);
      port.removeEventListener("touchstart", byHand);
      port.removeEventListener("keydown", byHand);
      port.removeEventListener("scroll", onScroll);
    };
  }, [key, ready, anchor]);
}
