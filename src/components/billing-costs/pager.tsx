import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Billing & Costs lists show 50 rows a page. Search and filters run over the
 * whole list first — the page is only a window onto the result — and a new
 * search or filter starts again at page 1.
 *
 * Edits are kept across pages: every tab holds its draft above the rows, keyed
 * by item, so turning the page never drops one; the Save bar counts them all,
 * and leaving the screen still asks first.
 */
export const PAGE_SIZE = 50;

export function usePaged<T>(rows: readonly T[], resetKey: string, size = PAGE_SIZE) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [resetKey]);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(page, pages - 1);
  const from = at * size;
  return {
    rows: rows.slice(from, from + size),
    page: at,
    pages,
    total: rows.length,
    from,
    setPage,
    /** Turn to the page holding the row at this index of the full list. */
    showIndex: (i: number) => i >= 0 && setPage(Math.floor(i / size)),
  };
}

export function Pager({
  paged,
  noun = "items",
  pending = 0,
  className,
}: {
  paged: Pick<ReturnType<typeof usePaged>, "page" | "pages" | "total" | "from" | "setPage">;
  noun?: string;
  /** Unsaved edits in the tab: a reminder that other pages' edits are kept. */
  pending?: number;
  className?: string;
}) {
  const { page, pages, total, from, setPage } = paged;
  if (total === 0) return null;
  const to = Math.min(from + PAGE_SIZE, total);
  return (
    <nav
      aria-label={`Pages of ${noun}`}
      data-pager
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 px-1 py-2 text-xs text-muted-foreground md:px-3",
        className,
      )}
    >
      <p className="tabular-nums" aria-live="polite">
        <span className="font-medium text-foreground">
          {from + 1}–{to}
        </span>{" "}
        of {total} {noun}
        {pending > 0 && pages > 1 && (
          <span className="ml-1">· edits on other pages are kept until you save or discard</span>
        )}
      </p>
      {pages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-7"
            onClick={() => setPage(page - 1)}
            disabled={page === 0}
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden /> Prev
          </Button>
          <span className="px-2 tabular-nums">
            Page {page + 1} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-11 md:h-7"
            onClick={() => setPage(page + 1)}
            disabled={page >= pages - 1}
            aria-label="Next page"
          >
            Next <ChevronRight aria-hidden />
          </Button>
        </div>
      )}
    </nav>
  );
}
