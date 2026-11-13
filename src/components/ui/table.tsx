import * as React from "react";

import { cn } from "@/lib/utils";

export type TableProps = React.HTMLAttributes<HTMLTableElement> & {
  /**
   * Opt in to the card-per-row fallback below md. Each `TableCell` needs a
   * `data-label` for its header text; a cell without one renders full-width
   * with no label (use that for the identity cell and the actions cell).
   * Desktop is untouched. Full documentation lives with the `table-cards`
   * rules at the bottom of `src/styles.css`.
   */
  cards?: boolean;
};

/**
 * Dense operations table: 32px rows, 13px body, 11px uppercase headers,
 * hairline row rules. Numeric cells should add `text-right font-mono tabular-nums`.
 *
 * MOBILE: below md the wrapper becomes the horizontal scroller. Without this a
 * wide table pushes `<main>` sideways and takes the page header, the toolbar
 * and everything else with it — the single worst thing this app does on a
 * phone. `overscroll-x-contain` stops that scroll chaining out to the page (and
 * to Safari's back-swipe) when the table reaches its end.
 */
const Table = React.forwardRef<HTMLTableElement, TableProps>(
  ({ className, cards, ...props }, ref) => (
    <div className="relative w-full max-md:overflow-x-auto max-md:overscroll-x-contain">
      <table
        ref={ref}
        data-table-cards={cards ? "" : undefined}
        className={cn("w-full caption-bottom border-collapse text-[13px]", className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  // `max-md:static` is the price of the wrapper's horizontal scroller. Sticky
  // resolves against the nearest scrollport, and below md that is now the
  // wrapper — which never scrolls vertically, so a sticky header would simply
  // sit at the top of the table and never move. Static is honest. Contained
  // sideways scrolling is worth more on a 390px screen than a 24px header row
  // that follows you down.
  <thead
    ref={ref}
    className={cn(
      "sticky top-[var(--table-sticky-top,0px)] z-10 bg-muted max-md:static [&_tr]:border-b",
      className,
    )}
    {...props}
  />
));
TableHeader.displayName = "TableHeader";

const TableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tbody ref={ref} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
));
TableBody.displayName = "TableBody";

const TableFooter = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn("border-t bg-muted/60 font-medium [&>tr]:last:border-b-0", className)}
    {...props}
  />
));
TableFooter.displayName = "TableFooter";

const TableRow = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        "border-b transition-colors hover:bg-accent/60 data-[state=selected]:bg-accent",
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      "h-[var(--th-h,1.75rem)] px-[var(--cell-px,0.5rem)] text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className,
    )}
    {...props}
  />
));
TableHead.displayName = "TableHead";

const TableCell = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement>
>(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      "h-[var(--td-h,2rem)] px-[var(--cell-px,0.5rem)] py-1 align-middle [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:translate-y-[2px]",
      className,
    )}
    {...props}
  />
));
TableCell.displayName = "TableCell";

const TableCaption = React.forwardRef<
  HTMLTableCaptionElement,
  React.HTMLAttributes<HTMLTableCaptionElement>
>(({ className, ...props }, ref) => (
  <caption ref={ref} className={cn("mt-2 text-xs text-muted-foreground", className)} {...props} />
));
TableCaption.displayName = "TableCaption";

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption };
