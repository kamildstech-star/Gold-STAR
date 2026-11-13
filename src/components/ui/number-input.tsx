import * as React from "react";

import { Input } from "@/components/ui/input";
import { evalExpression, formulaError } from "@/lib/formula";
import { cn } from "@/lib/utils";
import {
  applyNumberInputEdit,
  formatNumberValue,
  parseNumberInput,
  stripSeparators,
} from "@/lib/number-input";

/**
 * A text box for a money amount or a large count that groups the digits as
 * you type: 1250000 reads 1,250,000 before you have taken your finger off the
 * key.
 *
 * Mark, on the Set Goals panel: "add commas for thousands millions hundred
 * thousands, etc". Until this existed every form carried its own bare
 * `inputMode="decimal"` box, so a revenue goal read "$ 100000" and each form
 * parsed the text its own way. This is the one place that formats and parses.
 *
 * It is deliberately NOT `type="number"`. A number input refuses commas
 * outright (the browser blanks the value), scrolls the value with the mouse
 * wheel when the box happens to be under the pointer, and shows a spinner
 * nobody uses on a money field. A text box with `inputMode` still brings up
 * the numeric keypad on a phone, which is the only thing `type="number"` was
 * buying.
 *
 * Contract: the caller never sees the formatted text. `onValueChange` gets the
 * parsed number (`null` for an empty box) and, second, the clean unformatted
 * string ("1250.5") for the forms that keep their draft as a string and parse
 * it on save. `onCommit` fires on blur with the parsed number for the
 * uncontrolled `defaultValue` tables that save a cell when you leave it.
 *
 * `value` may be a number or a numeric string, because both kinds of state
 * exist in the forms and rewriting every draft to a number was a bigger change
 * than the commas warranted.
 */
export interface NumberInputProps extends Omit<
  React.ComponentProps<"input">,
  "value" | "defaultValue" | "onChange" | "type" | "min" | "max" | "step"
> {
  value?: number | string | null;
  defaultValue?: number | string | null;
  /** Fractional digits accepted. Money is 2; a count is 0. */
  decimals?: number;
  /** Keep a leading minus. Off by default. */
  allowNegative?: boolean;
  /** Every keystroke: the parsed number (null when empty) and the clean digits. */
  onValueChange?: (value: number | null, clean: string) => void;
  /** On blur only: the parsed number. For cells that save when you leave them. */
  onCommit?: (value: number | null) => void;
  /**
   * Take a typed sum — "2*2", "3x4", "1,250 / 3" — and put the answer in the
   * box on blur. David, 24 Sep: "in the backend it should know that if I put
   * in two times two it's four." A plain number still groups as it is typed;
   * only a string with an operator is left alone until it is worked out.
   *
   * A sum that does not parse is NOT saved and is NOT silently swapped back
   * (29 Oct: "if someone writes wrong show message below field … so they know
   * the value is not okay"): the typing stays in the box, marked invalid, with
   * the reason underneath, until it is fixed or Escape puts the saved number
   * back. Nothing is committed while it is wrong.
   */
  allowMath?: boolean;
}

/** An operator after the first character, i.e. a sum rather than a signed number. */
const LOOKS_LIKE_SUM = /.[-+*/×÷xX()]|[*/×÷()]/;

function toNumber(v: number | string | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return parseNumberInput(v);
  return null;
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(function NumberInput(
  {
    value,
    defaultValue,
    decimals = 0,
    allowNegative = false,
    onValueChange,
    onCommit,
    onBlur,
    inputMode,
    allowMath = false,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const controlled = value !== undefined;
  const [text, setText] = React.useState(() =>
    formatNumberValue(toNumber(controlled ? value : defaultValue), decimals),
  );
  /** A typed sum that could not be worked out: the box keeps it and says why. */
  const [error, setError] = React.useState<string | null>(null);
  const errorId = React.useId();

  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const setRefs = React.useCallback(
    (el: HTMLInputElement | null) => {
      inputRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // Resync from the prop only when the parent's number genuinely differs from
  // what the box says. Comparing numbers rather than strings is what lets a
  // half-typed "1,250." survive the parent echoing 1250 back to us.
  const parsedText = parseNumberInput(text);
  React.useEffect(() => {
    if (!controlled) return;
    const next = toNumber(value);
    if (next === parsedText) return;
    // An emptied box whose parent coerces empty to 0 (`n ?? 0`) stays empty
    // instead of snapping back to "0" under the typist. React's own
    // type="number" has the same special case, and the forms rely on it.
    if (next === 0 && text === "") return;
    setText(formatNumberValue(next, decimals));
    // parsedText is derived from text; re-running on every keystroke would
    // fight the typist, so only the prop is watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, controlled, decimals]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = e.target;
    if (error) setError(null);
    if (allowMath && LOOKS_LIKE_SUM.test(el.value)) {
      // A sum in progress: keep it as typed; it is worked out on blur.
      setText(el.value);
      return;
    }
    const inputType = (e.nativeEvent as Partial<InputEvent>).inputType;
    const edit = applyNumberInputEdit(
      el.value,
      el.selectionStart ?? el.value.length,
      { decimals, allowNegative },
      text,
      inputType,
    );
    // Write the formatted text and the caret straight into the DOM now, in
    // the same tick as the keystroke. Waiting for React to re-render would
    // let the browser paint the raw text first and then throw the caret to
    // the end when the controlled value is restored.
    el.value = edit.text;
    el.setSelectionRange(edit.caret, edit.caret);
    setText(edit.text);
    onValueChange?.(parseNumberInput(edit.text), stripSeparators(edit.text));
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    if (allowMath && LOOKS_LIKE_SUM.test(text)) {
      const worked = evalExpression(text);
      if (worked == null || (!allowNegative && worked < 0)) {
        // Keep what was typed so it can be fixed; save nothing.
        setError(formulaError(text, worked));
        onBlur?.(e);
        return;
      }
      const canonical = formatNumberValue(worked, decimals);
      setText(canonical);
      setError(null);
      onValueChange?.(worked, stripSeparators(canonical));
      onCommit?.(worked);
      onBlur?.(e);
      return;
    }
    // Tidy what was typed into its canonical form: "1250." → "1,250",
    // "-" → "". The number does not change, so nothing is emitted for it.
    const n = parseNumberInput(text);
    const canonical = formatNumberValue(n, decimals);
    if (canonical !== text) setText(canonical);
    onCommit?.(n);
    onBlur?.(e);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (allowMath && e.key === "Enter" && LOOKS_LIKE_SUM.test(text)) {
      // Enter works the sum out, as leaving the box does.
      e.preventDefault();
      e.currentTarget.blur();
    } else if (e.key === "Escape" && error) {
      // Escape gives up on the bad sum and shows the saved number again.
      e.preventDefault();
      setError(null);
      setText(formatNumberValue(toNumber(controlled ? value : defaultValue), decimals));
    }
    onKeyDown?.(e);
  };

  const input = (
    <Input
      {...rest}
      ref={setRefs}
      type="text"
      // The phone keypad; "decimal" is the one with a point on it. A box that
      // takes a sum needs * / + on the phone too, with no keypad pop-up any
      // more to supply them — so it gets the full keyboard.
      inputMode={inputMode ?? (allowMath ? "text" : decimals > 0 ? "decimal" : "numeric")}
      autoComplete={rest.autoComplete ?? "off"}
      value={text}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      aria-invalid={error ? true : rest["aria-invalid"]}
      aria-describedby={
        error
          ? [rest["aria-describedby"], errorId].filter(Boolean).join(" ")
          : rest["aria-describedby"]
      }
      className={cn(error && "border-destructive focus-visible:ring-destructive", rest.className)}
    />
  );
  if (!allowMath) return input;
  // Always the same wrapper for a sum box, so the input is never remounted
  // (and never loses focus) as the message comes and goes.
  return (
    <span className="flex min-w-0 flex-col gap-0.5" data-formula-field>
      {input}
      {error && (
        <span id={errorId} role="alert" className="text-xs leading-snug text-destructive">
          {error}
        </span>
      )}
    </span>
  );
});

export { NumberInput };
