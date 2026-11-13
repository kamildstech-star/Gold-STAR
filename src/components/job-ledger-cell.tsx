import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Check, Loader2, RotateCcw } from "lucide-react";

import { NumberInput } from "@/components/ui/number-input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toastDbError } from "@/lib/db-errors";
import {
  LEDGER_CELL_SOURCES,
  isLedgerEditable,
  ledgerTotalExplanation,
  type LedgerRow,
  type LedgerTotalKey,
} from "@/lib/job-ledger";
import {
  LEDGER_OVERRIDES_KEY,
  clearLedgerOverride,
  saveLedgerOverride,
  type LedgerOverridesRead,
} from "@/lib/job-ledger-overrides";
import { cn } from "@/lib/utils";

/**
 * One cell of the Job ledger strip, as a spreadsheet cell. Mark, 2026-10-07:
 * "can we make each box editable".
 *
 * Excel's grammar, because that is what he is comparing it to: click or tap
 * to type in place, Enter or leaving the cell saves, Esc puts it back, Tab
 * goes to the next cell you can type in (Shift+Tab the one before). Emptying
 * a cell and saving is the same as "Back to calculated".
 *
 * What a cell may do is LEDGER_CELL_SOURCES (src/lib/job-ledger.ts): entries
 * and overrides take a figure; Referral and Commission are read from the
 * Commissions card; the two totals explain themselves instead of taking one.
 */

export type LedgerCellStatus = "saving" | "saved" | "error";

/** What a typed figure is saved as: a number, or null for "back to calculated". */
type CellWrite = { key: string; value: number | null };

/**
 * Saving a cell. The figure goes into the shared query cache first, so the
 * totals on every strip and card reading `useJobLedger` move as Enter is
 * pressed, not a round trip later; a refusal puts the cache back.
 */
export function useLedgerCellSave(jobId: string) {
  const qc = useQueryClient();
  const key = LEDGER_OVERRIDES_KEY(jobId);
  return useMutation({
    mutationFn: ({ key: cell, value }: CellWrite) =>
      value == null ? clearLedgerOverride(jobId, cell) : saveLedgerOverride(jobId, cell, value),
    onMutate: async ({ key: cell, value }: CellWrite) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<LedgerOverridesRead>(key);
      qc.setQueryData<LedgerOverridesRead>(key, (old) => {
        const values = { ...(old?.values ?? {}) };
        if (value == null) delete values[cell];
        else values[cell] = { value, updatedAt: new Date().toISOString() };
        return { available: true, values };
      });
      return { prev };
    },
    onError: (e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toastDbError(e, { action: "save the ledger cell" });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  });
}

/**
 * The strip's editing state: which cell is open, each cell's saving / saved /
 * error mark, and the moves between cells. Kept out of the strip so the strip
 * stays the table it was.
 */
export function useLedgerEditing(jobId: string, rows: LedgerRow[], order: string[]) {
  const save = useLedgerCellSave(jobId);
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, LedgerCellStatus | undefined>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => clearTimeout(t));
  }, []);

  // After Enter or Esc, the keyboard goes back to the cell it left, as in a
  // sheet. After a click elsewhere it does not: that click chose the focus.
  useEffect(() => {
    if (editing != null || !refocus.current) return;
    buttons.current.get(refocus.current)?.focus();
    refocus.current = null;
  }, [editing]);

  const write = useCallback(
    async (key: string, value: number | null) => {
      setStatus((s) => ({ ...s, [key]: "saving" }));
      const prior = timers.current.get(key);
      if (prior) clearTimeout(prior);
      try {
        await save.mutateAsync({ key, value });
        setStatus((s) => ({ ...s, [key]: "saved" }));
        timers.current.set(
          key,
          setTimeout(
            () => setStatus((s) => (s[key] === "saved" ? { ...s, [key]: undefined } : s)),
            2000,
          ),
        );
      } catch {
        setStatus((s) => ({ ...s, [key]: "error" }));
      }
    },
    [save],
  );

  const commit = useCallback(
    (key: string, typed: number | null) => {
      const row = rows.find((r) => r.key === key);
      if (!row) return;
      const change = ledgerCellChange(row, typed);
      if (change !== "unchanged") void write(key, change);
    },
    [rows, write],
  );

  const finish = useCallback(
    (key: string, typed: number | null | undefined, move: -1 | 0 | 1, viaKeyboard: boolean) => {
      // undefined = Esc: nothing is saved.
      if (typed !== undefined) commit(key, typed);
      const editable = order.filter(isLedgerEditable);
      const next = move === 0 ? null : editable[editable.indexOf(key) + move];
      if (next) {
        setEditing(next);
        return;
      }
      if (viaKeyboard) refocus.current = key;
      setEditing(null);
    },
    [commit, order],
  );

  return {
    editing,
    status,
    start: setEditing,
    finish,
    revert: (key: string) => void write(key, null),
    buttonRef: (key: string) => (el: HTMLButtonElement | null) => {
      buttons.current.set(key, el);
    },
  };
}

/**
 * What saving `typed` into `row` means. Pure, so the rules a sheet user
 * expects are tested without a browser:
 *   - an empty cell is "back to calculated" (nothing to do if it already is);
 *   - typing the figure already shown changes nothing — in particular, typing
 *     the calculated figure into a calculated cell does not pin it as manual,
 *     which would quietly stop it following its source.
 */
export function ledgerCellChange(
  row: LedgerRow,
  typed: number | null,
): number | null | "unchanged" {
  if (typed == null) return row.manual ? null : "unchanged";
  if (row.manual) return typed === row.value ? "unchanged" : typed;
  if (row.calculated != null && typed === row.calculated) return "unchanged";
  return typed;
}

/** A figure in the strip's own format: whole dollars, plain counts, hours. */
export function formatLedgerFigure(kind: LedgerRow["kind"], value: number | null): string {
  if (value == null) return "—";
  if (kind === "money") {
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * The hover text for a cell: where the figure comes from, and what typing in
 * it does. On a phone there is no hover, so the same facts are on the cell
 * while it is being edited.
 */
export function ledgerCellTitle(
  row: LedgerRow | null,
  key: string,
  opts: { mayEdit: boolean; available: boolean },
): string | undefined {
  const src = LEDGER_CELL_SOURCES[key];
  const parts: string[] = [];
  if (row?.manual) {
    parts.push(
      `Manual figure, typed on the ledger. Calculated: ${formatLedgerFigure(row.kind, row.calculated ?? null)}.`,
    );
  } else if (row?.note) {
    parts.push(row.note);
  }
  if (src?.edit === "elsewhere") {
    parts.push(
      key === "labor_charge" || key === "supplies_charge"
        ? "The charge is set in Billing & Costs."
        : "Set on the Commissions card.",
    );
  }
  if (key === "billed" || key === "paid") {
    parts.push(
      "A figure typed here is for the ledger only: no invoice or payment is created, changed or deleted.",
    );
  }
  if (src?.edit === "total") parts.push("Click to see which cells add up to it.");
  if (opts.mayEdit && !opts.available && isLedgerEditable(key)) {
    parts.push("Typing into this cell is not available yet.");
  }
  return parts.length ? parts.join(" ") : undefined;
}

/**
 * A cell that takes a figure: the value as a button, the manual marker and
 * "Back to calculated" beside it, and the input in its place while editing.
 * The button is the keyboard's way in (Tab to it, Enter or Space); the strip
 * also opens the cell from a click on its label or anywhere in its box.
 */
export function LedgerEditableCell({
  row,
  editing,
  status,
  onStart,
  onFinish,
  onRevert,
  buttonRef,
  children,
}: {
  row: LedgerRow;
  editing: boolean;
  status: LedgerCellStatus | undefined;
  onStart: () => void;
  onFinish: (typed: number | null | undefined, move: -1 | 0 | 1, viaKeyboard: boolean) => void;
  onRevert: () => void;
  buttonRef: (el: HTMLButtonElement | null) => void;
  /** The cell's figure as the read-only strip shows it. */
  children: ReactNode;
}) {
  const entry = LEDGER_CELL_SOURCES[row.key]?.edit === "entry";
  if (editing) return <LedgerCellInput row={row} onFinish={onFinish} />;
  const calc = formatLedgerFigure(row.kind, row.calculated ?? null);
  const revertLabel = entry ? `Clear ${row.label}` : `Back to calculated (${calc})`;
  return (
    <span className="flex w-full items-center gap-1">
      {/* Fills the cell, so the figure's whole box is the button; the strip
          makes the label above and the cell's padding open it too. */}
      <button
        type="button"
        ref={buttonRef}
        onClick={onStart}
        aria-label={`Edit ${row.label}`}
        data-ledger-cell={row.key}
        className="-mx-1 inline-flex min-h-11 min-w-11 flex-1 items-center gap-1 rounded-sm px-1 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring md:min-h-0 md:min-w-0"
      >
        {children}
        {row.manual ? (
          <>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
            <span className="sr-only">(manual)</span>
          </>
        ) : null}
      </button>
      {row.manual ? (
        <button
          type="button"
          onClick={onRevert}
          aria-label={revertLabel}
          title={revertLabel}
          data-ledger-revert={row.key}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground md:size-5"
        >
          <RotateCcw className="size-3" />
        </button>
      ) : null}
      <LedgerCellStatusMark status={status} />
    </span>
  );
}

function LedgerCellInput({
  row,
  onFinish,
}: {
  row: LedgerRow;
  onFinish: (typed: number | null | undefined, move: -1 | 0 | 1, viaKeyboard: boolean) => void;
}) {
  const initial = row.value ?? null;
  const draft = useRef<number | null>(initial);
  const done = useRef(false);
  const finish = (typed: number | null | undefined, move: -1 | 0 | 1, viaKeyboard: boolean) => {
    // Enter, Esc and Tab end the edit and then blur follows as the input
    // goes; only the first of them counts.
    if (done.current) return;
    done.current = true;
    onFinish(typed, move, viaKeyboard);
  };
  const entry = LEDGER_CELL_SOURCES[row.key]?.edit === "entry";
  return (
    <span className="inline-flex flex-col gap-0.5">
      <NumberInput
        autoFocus
        defaultValue={initial}
        decimals={row.kind === "count" ? 0 : 2}
        allowNegative={row.kind === "money"}
        aria-label={`${row.label}: type a figure, Enter to save, Esc to cancel`}
        data-ledger-input={row.key}
        className="h-11 w-28 px-1.5 text-sm font-semibold tabular-nums md:h-7"
        onFocus={(e) => e.currentTarget.select()}
        onValueChange={(n) => {
          draft.current = n;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            finish(draft.current, 0, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish(undefined, 0, true);
          } else if (e.key === "Tab") {
            e.preventDefault();
            finish(draft.current, e.shiftKey ? -1 : 1, true);
          }
        }}
        onBlur={() => finish(draft.current, 0, false)}
      />
      {/* The hover text, for a phone that has no hover. */}
      <span className="text-[10px] font-normal text-muted-foreground">
        {entry ? "Empty clears it" : `Calc ${formatLedgerFigure(row.kind, row.calculated ?? null)}`}
      </span>
    </span>
  );
}

function LedgerCellStatusMark({ status }: { status: LedgerCellStatus | undefined }) {
  if (!status) return null;
  if (status === "saving") {
    return (
      <span className="inline-flex text-muted-foreground" title="Saving">
        <Loader2 aria-hidden className="size-3 animate-spin" />
        <span className="sr-only" role="status">
          Saving
        </span>
      </span>
    );
  }
  if (status === "saved") {
    return (
      <span className="inline-flex text-success" title="Saved">
        <Check aria-hidden className="size-3" />
        <span className="sr-only" role="status">
          Saved
        </span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex text-destructive"
      title="Not saved. The cell is back to its last figure."
    >
      <AlertCircle aria-hidden className="size-3" />
      <span className="sr-only" role="status">
        Not saved
      </span>
    </span>
  );
}

/**
 * A total, which is never typed: clicking it lists the cells that make it
 * up. Mark asked for every box to be editable; a typed total would disagree
 * with its own parts the moment one of them moved, so this is the answer to
 * "why can't I change it" — and to "why is it that number".
 */
export function LedgerTotalCell({
  totalKey,
  rows,
  cost,
  children,
}: {
  totalKey: LedgerTotalKey;
  rows: LedgerRow[];
  cost: {
    total_cost: number;
    revenue: number;
    referral_cost?: number;
    commission_cost?: number | null;
  } | null;
  children: ReactNode;
}) {
  if (!cost) return <>{children}</>;
  const label = rows.find((r) => r.key === totalKey)?.label ?? totalKey;
  const { lines, total, note } = ledgerTotalExplanation(totalKey, rows, cost);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: what adds up to it`}
          data-ledger-total={totalKey}
          className="-mx-1 inline-flex min-h-11 items-center rounded-sm px-1 underline decoration-dotted underline-offset-4 hover:bg-muted md:min-h-0"
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs">
        <p className="mb-2 font-semibold">{label}</p>
        <table className="w-full">
          <tbody>
            {lines.map((l) => (
              <tr key={l.label}>
                <td className="py-0.5 pr-2">
                  {l.sign < 0 ? "− " : "+ "}
                  {l.label}
                  {l.manual ? <span className="text-muted-foreground"> (manual)</span> : null}
                </td>
                <td className="py-0.5 text-right tabular-nums">
                  {formatLedgerFigure("money", l.value)}
                </td>
              </tr>
            ))}
            <tr className="border-t font-semibold">
              <td className="pt-1 pr-2">= {label}</td>
              <td className="pt-1 text-right tabular-nums">{formatLedgerFigure("money", total)}</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-2 text-muted-foreground">{note}</p>
      </PopoverContent>
    </Popover>
  );
}
