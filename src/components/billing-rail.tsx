/**
 * One right-hand rail on the Billing tab instead of two.
 *
 * The tab used to run three columns at desktop width: the line-item table, the
 * editor's own 20rem rail (Totals, Calculator, Carrier, Billing office), and
 * then the page's 20rem rail (Running cost, Bill to). Two rails side by side
 * read as one cluttered strip, and the nine-column line table -- the thing
 * people are actually working in -- got whatever was left, which by then was
 * not much.
 *
 * Mark, 2026-09-09: "move carrier biling office and totals to the right where
 * the runniong cost and bill to is."
 *
 * The cards cannot simply be moved. They belong to one estimate or one
 * invoice, they hold live inputs, and the page rail belongs to the job and
 * knows nothing about which document is open. So the editor keeps owning and
 * rendering them, and hands them to the page rail through a portal. No state
 * is lifted, nothing is duplicated, and an editor mounted anywhere else still
 * renders its own rail exactly as before.
 *
 * Both an estimate and an invoice can be open at once, so a group carries the
 * document it came from as a heading. Two cards both titled "Totals" with
 * nothing to tell them apart would be worse than the layout we started with.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const RailContext = createContext<HTMLElement | null>(null);

type Slot = (node: HTMLElement | null) => void;

/**
 * 1280px. Tailwind's `xl`, deliberately: the page rail is only a right-hand
 * column from `xl` up (`xl:grid-cols-[minmax(0,1fr)_20rem]`), and below that it
 * moves ABOVE the billing panel. Portalling there on a narrow screen would put
 * an invoice's totals above the estimates table, a long way from the invoice.
 * If the grid's breakpoint changes, change this with it.
 */
const RAIL_BREAKPOINT = 1280;

/**
 * Is the page rail actually a rail right now?
 *
 * SSR: returns false on the server and on the first client paint, same
 * contract as `useIsMobile` and for the same reason -- reading `window` during
 * render is a hydration mismatch. The cost is one frame with the cards in the
 * editor before they move, which is the cheaper of the two wrong answers.
 */
function useRailWidth() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${RAIL_BREAKPOINT}px)`);
    // `mql.matches`, not `innerWidth`: they disagree by a scrollbar width and
    // mixing them makes this flip state at the boundary.
    const onChange = () => setWide(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return wide;
}

/**
 * Where an editor's rail cards should go, or null to keep them where they are.
 * Editors also read this to decide whether to run their own second column.
 */
export function useBillingRailTarget(): HTMLElement | null {
  const el = useContext(RailContext);
  const wide = useRailWidth();
  return wide ? el : null;
}

/**
 * Wraps the Billing tab so anything inside can find the page rail. `rail` is
 * where an open document's cards go.
 *
 * There used to be a second slot, `estimates`, that the billing panel filled
 * with the job's estimates list (Mark, 16 Sep: "just have the sidebar"). David
 * asked on 22 Sep for estimates on the left of the money column instead, with
 * invoices beside them, so the panel renders the list in place and the slot
 * went.
 */
export function BillingRailProvider({
  children,
}: {
  children: (slots: { rail: Slot }) => ReactNode;
}) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  // Stable, so a slot's ref callback is not torn down and re-run every render.
  const slots = useMemo(() => ({ rail: setEl }), []);
  return <RailContext.Provider value={el}>{children(slots)}</RailContext.Provider>;
}

/**
 * Keeps an editor's rail cards inside it — for an editor shown in a pop-up
 * (the invoice review), where portalling them to the page rail behind the
 * overlay would hide them.
 */
export function NoBillingRail({ children }: { children: ReactNode }) {
  return <RailContext.Provider value={null}>{children}</RailContext.Provider>;
}

/**
 * An editor's rail. Rendered into the page rail when there is one, otherwise
 * in place, so this component is the only thing that has to know which.
 */
export function BillingRail({ label, children }: { label: string; children: ReactNode }) {
  const target = useBillingRailTarget();
  if (!target) return <div className="space-y-3">{children}</div>;

  return createPortal(
    <section className="space-y-3" aria-label={`${label} details`}>
      {/* Which document these belong to. Two open at once is ordinary here. */}
      <h2 className="px-0.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
        {label}
      </h2>
      {children}
    </section>,
    target,
  );
}
