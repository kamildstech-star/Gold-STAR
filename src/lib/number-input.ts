/**
 * The arithmetic behind the formatted number box (`NumberInput`).
 *
 * Mark, looking at the Set Goals panel where a revenue goal read "$ 100000":
 * "add commas for thousands millions hundred thousands, etc". He wants the
 * commas in the box while he types, not only on the report afterwards, so the
 * box has to re-group the digits on every keystroke and the caret has to stay
 * where the typist expects it while it does. That second part is where these
 * components usually go wrong (the cursor jumps to the end the moment a comma
 * appears), so the caret maths lives here as pure functions where it can be
 * unit-tested without a DOM.
 *
 * Grouping is hard-coded to en-US. The business is American; a rep on a
 * laptop with a European locale must not see "1.250.000" in a US invoice, and
 * the parser must not read "1,5" as one and a half.
 */

export interface NumberInputOptions {
  /** Fractional digits the box will accept: 2 for money, 0 for a count. */
  decimals: number;
  /** Whether a leading minus is kept. Off by default: almost nothing here goes negative. */
  allowNegative?: boolean;
}

const SEPARATOR = ",";

/** Insert en-US thousands separators into a run of digits. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, SEPARATOR);
}

/**
 * Turn a number into the text the box shows for it: grouped integer part,
 * fraction trimmed of trailing zeros. `null`/`undefined`/`NaN` → "" so a
 * nullable column renders as an empty box rather than "NaN".
 *
 * Trailing zeros are dropped rather than padded ("1,250.5", not "1,250.50")
 * because the same box is used for square feet and hours, where "12.50" reads
 * as false precision. The money *display* elsewhere goes through `fmtMoney`.
 */
export function formatNumberValue(value: number | null | undefined, decimals: number): string {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) return "";
  const fixed = Math.abs(value).toFixed(Math.max(0, decimals));
  const [intPart, frac = ""] = fixed.split(".");
  const trimmedFrac = frac.replace(/0+$/, "");
  const sign = value < 0 && Number(fixed) !== 0 ? "-" : "";
  return sign + groupDigits(intPart!) + (trimmedFrac ? "." + trimmedFrac : "");
}

/** The box's text with the separators taken back out: "1,250.5" → "1250.5". */
export function stripSeparators(text: string): string {
  return text.split(SEPARATOR).join("");
}

/**
 * Read a number out of whatever is in the box. `null` for empty or for text
 * that is not a number yet ("-", "."), so a caller can tell "cleared" from 0.
 */
export function parseNumberInput(text: string | null | undefined): number | null {
  if (text == null) return null;
  const clean = stripSeparators(String(text)).trim();
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

export interface NumberInputEdit {
  /** The formatted text the box should now show. */
  text: string;
  /** Where the caret should sit inside `text`. */
  caret: number;
}

/**
 * Take the raw contents of the box after an edit — a pasted "$1,250,000.00",
 * a letter somebody typed, the previous formatted text with one more digit in
 * it — and produce the cleaned, grouped text plus where the caret belongs.
 *
 * The caret rule: count the characters that *survive* the clean-up to the
 * left of the caret, then place the caret after that many surviving
 * characters in the reformatted text. Separators are never counted, so a
 * comma appearing or vanishing to the left of the cursor cannot move it
 * relative to the digits.
 *
 * `previousText`/`inputType` exist for one case: Backspace on a comma. The
 * browser deletes the comma and nothing else; if we merely regrouped, the
 * comma would come straight back and the key would appear dead. So a backspace
 * that removed only a separator is treated as deleting the digit before it
 * (and forward-delete, the digit after), which is what the typist meant.
 */
export function applyNumberInputEdit(
  rawText: string,
  rawCaret: number,
  options: NumberInputOptions,
  previousText?: string,
  inputType?: string,
): NumberInputEdit {
  let text = rawText;
  let caret = Math.max(0, Math.min(rawCaret, text.length));

  if (previousText != null && previousText.length === text.length + 1) {
    if (inputType === "deleteContentBackward" && previousText[caret] === SEPARATOR) {
      const removedOnlySeparator =
        previousText.slice(0, caret) + previousText.slice(caret + 1) === text;
      if (removedOnlySeparator && caret > 0) {
        text = text.slice(0, caret - 1) + text.slice(caret);
        caret -= 1;
      }
    } else if (inputType === "deleteContentForward" && previousText[caret] === SEPARATOR) {
      const removedOnlySeparator =
        previousText.slice(0, caret) + previousText.slice(caret + 1) === text;
      if (removedOnlySeparator && caret < text.length) {
        text = text.slice(0, caret) + text.slice(caret + 1);
      }
    }
  }

  const decimals = Math.max(0, options.decimals);
  const allowNegative = options.allowNegative === true;

  let negative = false;
  let intDigits = "";
  let frac = "";
  let seenDot = false;
  let survivingLeftOfCaret = 0;
  // Index of a lone leading "0" that a later digit replaces ("0" then "5"
  // should read "5", not "05"). It counted as surviving when it was kept, so
  // it has to be un-counted if it was left of the caret.
  let leadingZeroAt = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    let kept = false;
    if (ch === "-") {
      if (allowNegative && !negative && intDigits === "" && !seenDot) {
        negative = true;
        kept = true;
      }
    } else if (ch >= "0" && ch <= "9") {
      if (seenDot) {
        if (frac.length < decimals) {
          frac += ch;
          kept = true;
        }
      } else if (intDigits === "0") {
        // Replace the placeholder zero rather than growing "0" into "05".
        intDigits = ch;
        kept = true;
        if (leadingZeroAt >= 0 && leadingZeroAt < caret) survivingLeftOfCaret -= 1;
        leadingZeroAt = -1;
      } else {
        intDigits += ch;
        kept = true;
        if (intDigits === "0") leadingZeroAt = i;
      }
    } else if (ch === "." && decimals > 0 && !seenDot) {
      seenDot = true;
      kept = true;
    }
    if (kept && i < caret) survivingLeftOfCaret += 1;
  }

  const formatted = (negative ? "-" : "") + groupDigits(intDigits) + (seenDot ? "." + frac : "");

  return { text: formatted, caret: caretAfterSurvivors(formatted, survivingLeftOfCaret) };
}

/** Position just after the n-th non-separator character of `text`. */
function caretAfterSurvivors(text: string, n: number): number {
  let seen = 0;
  let i = 0;
  while (i < text.length && seen < n) {
    if (text[i] !== SEPARATOR) seen += 1;
    i += 1;
  }
  return i;
}
