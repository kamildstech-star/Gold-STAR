import { useEffect, useRef, useState } from "react";
import { Calculator, ChevronDown, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { cn } from "@/lib/utils";
import { evalExpression, fmtMoney, round2 } from "@/lib/estimates";

const KEYS = ["7", "8", "9", "/", "4", "5", "6", "*", "1", "2", "3", "-", "0", ".", "(", ")"];
/** Backspace and clear are the only two keys that are not literal text. */
const BACKSPACE = "\b";
const CLEAR = "C";

/** Applies one key press to an expression. Shared so the two mountings agree. */
function applyKey(text: string, ch: string) {
  if (ch === BACKSPACE) return text.slice(0, -1);
  if (ch === CLEAR) return "";
  return text + ch;
}

/** The keypad of the sidebar calculator panel. */
function Keypad({ onTap, keyClass }: { onTap: (ch: string) => void; keyClass: string }) {
  return (
    <div className="grid grid-cols-4 gap-1">
      {[...KEYS, "+", BACKSPACE, CLEAR].map((k) => (
        <Button
          key={k}
          variant="outline"
          size="sm"
          tabIndex={-1}
          className={keyClass}
          onClick={() => onTap(k)}
        >
          {k === BACKSPACE ? "⌫" : k}
        </Button>
      ))}
    </div>
  );
}

/**
 * A money box that can do arithmetic: type "1250 / 3" or "45 * 1.2" and leave
 * the box (or press Enter) and the answer is what is saved.
 *
 * It used to carry a keypad pop-up behind a calculator button. 29 Oct: "please
 * don't show [it], just make [the] field" — so it is now exactly the plain box
 * below: the sum is worked out when you leave it, and a sum that cannot be
 * worked out is shown as an error under the box and saved as nothing until it
 * is fixed. On a phone the box brings up the full keyboard, which has the
 * operators the numeric pad lacked (the pad was the only reason for the
 * keypad).
 *
 * `format` is kept so the call sites need not change; with no running result
 * to print any more it is unused.
 */
export function CalcInput({
  format: _format,
  ...props
}: {
  value: number;
  onCommit: (n: number) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  format?: (n: number) => string;
}) {
  return <PlainNumberInput {...props} />;
}

/**
 * A money box with no keypad, that still works out a typed sum.
 *
 * David, on the 9 September call: the quantity field should read a typed
 * formula, and "unit price needs no calculator" — so there is no keypad button
 * here, one less thing in the tab strip of a nine-column row. On 24 Sep he
 * added: "in the backend it should know that if I put in two times two it's
 * four." So a sum typed straight into the box ("2*2", "3x4") is worked out on
 * blur by the shared NumberInput (`allowMath`); a plain number groups its
 * digits as it is typed.
 *
 * Same contract as `CalcInput` so the swap is local to the field: hold a
 * draft while typing, commit on blur or Enter, revert on Escape, and fail
 * closed — an emptied box or a sum that does not parse restores the saved
 * number rather than writing a zero over it.
 */
export function PlainNumberInput({
  value,
  onCommit,
  disabled,
  className,
  title,
}: {
  value: number;
  onCommit: (n: number) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [draft, setDraft] = useState<number | null>(value ?? 0);

  // Resync only when the saved number genuinely moves under us, so a
  // half-typed figure is never stamped on by a refetch.
  const saved = useRef(value);
  useEffect(() => {
    if (value !== saved.current) {
      saved.current = value;
      setDraft(value ?? 0);
    }
  }, [value]);

  const commit = (n: number | null) => {
    if (n == null) {
      setDraft(value ?? 0);
      return;
    }
    const next = round2(n);
    setDraft(next);
    if (next !== round2(value ?? 0)) onCommit(next);
  };

  return (
    <NumberInput
      decimals={2}
      // A typed sum is worked out on blur — no keypad, which is what David
      // turned down on 9 Sep ("unit price needs no calculator"), but "two
      // times two" still comes out as four (24 Sep).
      allowMath
      enterKeyHint="done"
      disabled={disabled}
      title={title}
      value={draft}
      onValueChange={setDraft}
      // 16px on a phone, or iOS zooms the page in on focus and never back.
      className={cn("text-base sm:text-[13px]", className)}
      onCommit={commit}
      onKeyDown={(e) => {
        // A sum's Enter is the box's own: it works the sum out and commits.
        if (e.defaultPrevented) return;
        if (e.key === "Enter") {
          e.preventDefault();
          commit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(value ?? 0);
        }
      }}
    />
  );
}

/**
 * The same calculator, mounted in the estimate and invoice sidebars rather than
 * under a money field.
 *
 * The popover exists to price one line. This one is for the sums that are not
 * tied to a field yet — squaring off a room, adding up three subcontractor
 * quotes — while the document stays on screen. Having no field to write to,
 * there is nothing to Apply; Copy is the useful equivalent.
 *
 * It sits below Totals and ALWAYS starts collapsed. It used to remember being
 * opened for the rest of the browser session, so once somebody had used it,
 * every invoice after that came up with a keypad already open beside it —
 * David, 24 Sep: "I don't like this calculator here in the background — it
 * probably shouldn't pop up automatically." Now it opens only when pressed.
 */
export function CalculatorPanel() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const result = evalExpression(text);

  const toggle = () => setOpen((o) => !o);

  const copy = () => {
    if (result == null) return;
    void navigator.clipboard
      .writeText(String(result))
      .then(() => toast.success(`Copied ${fmtMoney(result)}`))
      .catch(() => toast.error("Could not reach the clipboard — select the result and copy it."));
  };

  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex min-h-11 w-full items-center gap-2 px-4 py-2 text-left text-sm font-medium"
      >
        <Calculator className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">Calculator</span>
        {/* The running result stays visible while collapsed — otherwise
            reopening it is the only way to know it still holds anything. */}
        {!open && result != null && text !== "" && (
          <span className="tabular-nums text-xs text-muted-foreground">{fmtMoney(result)}</span>
        )}
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t p-3">
          <Input
            inputMode="decimal"
            enterKeyHint="done"
            placeholder="e.g. 12.5 * 3 + 40"
            aria-label="Expression"
            value={text}
            // 16px on a phone: anything smaller zooms iOS in and never back.
            className="h-11 text-base sm:h-8 sm:text-[13px]"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5">
            <span className="flex-1 text-base font-semibold tabular-nums">
              {result == null ? "—" : fmtMoney(result)}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-9 shrink-0"
              disabled={result == null}
              onClick={copy}
            >
              <Copy className="size-3.5" /> Copy
            </Button>
          </div>
          <Keypad onTap={(ch) => setText((t) => applyKey(t, ch))} keyClass="h-11 px-0 text-base" />
        </div>
      )}
    </Card>
  );
}
