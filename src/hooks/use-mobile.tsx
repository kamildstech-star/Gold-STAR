import * as React from "react";

/**
 * 768px. Same number as Tailwind's `md`, deliberately — layout decisions made
 * in JS here and layout decisions made in CSS with `max-md:` have to agree, or
 * you get a sidebar that thinks it is a sheet inside a page that thinks it is
 * a desktop. If you change one, change both.
 */
const MOBILE_BREAKPOINT = 768;

/**
 * Is this a phone-width viewport?
 *
 * WIDTH ONLY. This does not tell you whether the user has a finger or a mouse
 * — a 1024px tablet is not "mobile" by this hook and still needs 44px targets.
 * For that, use the `touch:` variant (`@media (pointer: coarse)`, defined in
 * styles.css) rather than reaching for this.
 *
 * SSR: this app server-renders, so the hook must return the SAME value on the
 * server and on the client's first paint or React logs a hydration mismatch
 * and, worse, throws away the server markup for that subtree. It returns
 * `false` on both — layout is measured in an effect, after hydration. The cost
 * is one frame of desktop layout on a phone; the alternative is reading
 * `window` during render, which is the mismatch.
 *
 * Prefer a CSS breakpoint wherever a CSS breakpoint will do: CSS is correct on
 * the very first paint and this hook cannot be.
 */
export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    // Read `mql.matches`, not `innerWidth`: they disagree by a scrollbar width
    // on desktop browsers, so mixing them makes the hook flip state at the
    // boundary. The media query is the same thing CSS is evaluating.
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
