/**
 * The typed-sum evaluator, on its own so a UI box can use it without pulling in
 * the database client that estimates.ts carries. estimates.ts re-exports it:
 * every existing import keeps working.
 */
import { roundMoney } from "@/lib/money";

const round2 = roundMoney;

/**
 * The times signs a person actually types, rewritten to the one the parser
 * knows.
 *
 * David, measuring a room on the call: "5×5 should give 25." Nobody reaches
 * for the asterisk — they type the multiplication sign their keyboard or their
 * phone offers, or they type the letter x, which is what "5x5" has meant on
 * paper for a century. The parser only ever accepted `*`, so every one of
 * those came back null and the field silently reverted to its old number.
 *
 * `÷` is the same case as `×` and is replaced wherever it appears: nothing
 * else in arithmetic means it, so `10÷2` is 5. There is deliberately no
 * letter-shaped divide — `/` is on every keyboard, and no notation writes
 * division as a letter the way `x` has always written multiplication.
 *
 * The letter is the careful one. `×` is unambiguous and is replaced wherever
 * it appears, but `x` is a letter, so it counts as multiplication only where a
 * number or a closing bracket sits on its left and a number, a decimal point
 * or an opening bracket on its right: `5x5`, `5 x 5`, `(2+3)x4`, `5x.5`. A
 * bare `x`, or `5xy`, stays unparsable and the field keeps its saved value —
 * a wrong price is far worse than a refused one.
 *
 * The lookahead matters: consuming the digit on the right would make `2x3x4`
 * come out as `2*3x4`, because the scan would resume past it.
 *
 * `0x10` is the one case that looks like this rule and is not: it is hex, and
 * reading it as "zero times ten" would answer 0 to someone who meant 16. A
 * leading zero immediately before the x is therefore left alone, so `0x10`
 * stays unparsable while `10x5` and `20x3` — where the zero is part of a
 * larger number — still multiply.
 *
 * This only widens what is accepted. The character guard below rejects letters
 * outright, so no string that parses today can change meaning here.
 */
export function normalizeFormulaSymbols(src: string): string {
  return (
    src
      .replace(/[×✕✖⨯]/g, "*")
      .replace(/[÷∕]/g, "/")
      // `whole` is the string this pass is scanning, not `src` — the two happen
      // to be the same length today, and depending on that would be a trap.
      .replace(
        /([\d)])\s*[xX]\s*(?=[\d(.])/g,
        (match, left: string, offset: number, whole: string) => {
          const isHexPrefix = left === "0" && !/[\d.]$/.test(whole.slice(0, offset));
          return isHexPrefix ? match : `${left}*`;
        },
      )
  );
}

/**
 * A one-line arithmetic evaluator for the money fields.
 *
 * Hand-rolled rather than eval or new Function: the string comes out of a text
 * box on a page that also holds customer records, and handing that to the
 * interpreter turns a pricing field into a script host. Anything outside
 * digits, a decimal point, + - * / and brackets is refused up front, and a
 * malformed expression comes back as null instead of throwing — the caller
 * treats null as "leave the saved number alone".
 *
 * Grammar, lowest binding first:
 *   expr := term (('+' | '-') term)*
 *   term := unary (('*' | '/') unary)*
 *   unary := ('+' | '-') unary | primary
 *   primary := number | '(' expr ')'
 */
export function evalExpression(src: string): number | null {
  // The money boxes now group their digits ("1,250"), and a figure pasted off
  // an invoice arrives that way too. A comma is never anything else in a US
  // price, so it is dropped before the character guard rather than refused.
  const text = normalizeFormulaSymbols(src.trim()).replace(/,/g, "");
  if (!text || !/^[\d.+\-*/()\s]+$/.test(text)) return null;

  const tokens = text.match(/\d*\.?\d+|[+\-*/()]/g) ?? [];
  // Everything must have landed in a token. A stray "1." or ".." tokenises
  // partially, and partially is the failure mode worth catching.
  if (tokens.join("") !== text.replace(/\s+/g, "")) return null;

  let at = 0;
  const peek = () => tokens[at];
  const eat = (t: string) => (peek() === t ? (at++, true) : false);
  const fail = (): never => {
    throw new RangeError("unparsable expression");
  };

  function primary(): number {
    if (eat("(")) {
      const v = expr();
      if (!eat(")")) fail();
      return v;
    }
    const t = peek();
    if (t === undefined || !/^[\d.]/.test(t)) fail();
    at++;
    const n = Number(t);
    if (!Number.isFinite(n)) fail();
    return n;
  }

  function unary(): number {
    if (eat("-")) return -unary();
    if (eat("+")) return unary();
    return primary();
  }

  function term(): number {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) {
        const d = unary();
        // Dividing by nothing is a typo, not a price.
        if (d === 0) fail();
        v /= d;
      } else return v;
    }
  }

  function expr(): number {
    let v = term();
    for (;;) {
      if (eat("+")) v += term();
      else if (eat("-")) v -= term();
      else return v;
    }
  }

  try {
    const v = expr();
    if (at !== tokens.length || !Number.isFinite(v)) return null;
    return round2(v);
  } catch {
    return null;
  }
}

/** Why a typed sum was refused, in the words someone can act on. */
export function formulaError(text: string, worked: number | null): string {
  if (worked != null && worked < 0) return "Comes to below zero.";
  if (/\/\s*0+(\.0*)?\s*($|[-+*/)])/.test(text.replace(/[×✕✖⨯xX]/g, "*")))
    return "Can’t divide by zero.";
  // Short: it sits under boxes as narrow as a table cell.
  return "Not a valid sum — e.g. 34*56";
}
