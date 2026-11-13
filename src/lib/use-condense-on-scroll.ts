import { useEffect, useState, type RefObject } from "react";

/**
 * On a phone, the content wins: the top bar and the bottom bar get out of the
 * way while you scroll down and come back the moment you scroll up.
 *
 * David, 24 Sep: "a majority of the people are going to be going on the
 * phone... a lot of the phone gets covered by the top section or by the side
 * section. If we could have more of the content that's relevant showing, that
 * would be a big help."
 *
 * Shared by the shell, so every screen inherits it; nothing is removed, only
 * tucked away while reading down, one flick up from being back. Desktop is
 * never condensed.
 */

/** Pixels scrolled before anything condenses, so a small nudge does nothing. */
export const CONDENSE_AFTER = 64;
/** Movement needed to change state, so a shaky thumb does not flicker it. */
export const CONDENSE_JITTER = 8;

/**
 * The scroller's size when the position was read. Optional so the plain
 * three-argument form keeps working; the hook always passes it.
 */
export type ScrollFrame = {
  /** scrollHeight - clientHeight: the furthest a real scroll can reach. */
  max: number;
  /** True when the scroller's size changed since the last reading. */
  resized?: boolean;
};

/**
 * Pure: the next state from where the scroll was and where it is now.
 *
 * David, 15 Oct: on some pages the screen "flickers like a seizure" when you
 * scroll too far. Two things moved the scroll position that were not the
 * thumb, and both used to read as a scroll UP:
 *
 *  - the rubber band — at the end of a page iOS lets the position run past
 *    the end and springs it back, and the spring back is an "up";
 *  - the bars themselves — folding the top bar makes the scroller taller, so
 *    at the bottom of a page the furthest reachable position shrinks and the
 *    browser pulls the position back with it. That "up" brought the bar back,
 *    which made the scroller shorter again, which let it scroll down again…
 *    every frame, on every page whose content ends near the screen's edge.
 *
 * So a reading past either end, or taken while the scroller is changing size
 * (the bar sliding, 200ms), changes nothing.
 */
export function nextCondensed(
  prev: boolean,
  lastY: number,
  y: number,
  frame?: ScrollFrame,
): boolean {
  if (frame?.resized) return prev;
  if (frame && (y < 0 || y > frame.max || lastY > frame.max)) return prev;
  if (y <= CONDENSE_AFTER) return false;
  const moved = y - lastY;
  if (Math.abs(moved) < CONDENSE_JITTER) return prev;
  return moved > 0;
}

const PHONE = "(max-width: 767.98px)";

export function useCondenseOnScroll(scroller: RefObject<HTMLElement | null>): boolean {
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof window === "undefined") return;
    const phone = window.matchMedia(PHONE);
    let lastY = el.scrollTop;
    let lastH = el.clientHeight;
    let lastSH = el.scrollHeight;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const y = el.scrollTop;
        const h = el.clientHeight;
        const sh = el.scrollHeight;
        const scroll: ScrollFrame = { max: sh - h, resized: h !== lastH || sh !== lastSH };
        setCondensed((prev) => (phone.matches ? nextCondensed(prev, lastY, y, scroll) : false));
        lastY = y;
        lastH = h;
        lastSH = sh;
      });
    };
    // Leaving phone width (rotating a tablet) must never leave a bar hidden.
    const onMedia = () => !phone.matches && setCondensed(false);
    el.addEventListener("scroll", onScroll, { passive: true });
    phone.addEventListener("change", onMedia);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      phone.removeEventListener("change", onMedia);
    };
  }, [scroller]);
  return condensed;
}
