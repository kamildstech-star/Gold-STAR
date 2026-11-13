/**
 * THE ROUNDING RULE for money (Billing & Costs, decided 30 Oct 2026):
 * INTEGER CENTS, HALF AWAY FROM ZERO.
 *
 * A dollar figure becomes whole cents exactly once per line, and a total is
 * the sum of those cents. Half a cent rounds away from zero: $0.125 → $0.13,
 * −$0.125 → −$0.13 — the same as Postgres ROUND(x, 2) on a numeric.
 *
 * Why not `Math.round(n * 100) / 100`: binary floats cannot hold most cent
 * values, so 1.005 * 100 is 100.49999999999999 and rounds DOWN to $1.00 where
 * a person (and Postgres) says $1.01. `toCents` first trims the product to 15
 * significant digits — the precision a double actually carries — which turns
 * that artefact back into 100.5 before rounding.
 *
 * Call sites move here area by area as each joins the shared engine (the T&M
 * bill first, prompt 2); the rest still carry their own copies until then.
 */

/** Dollars → whole cents, half away from zero. Throws on NaN/Infinity: never a silent $0. */
export function toCents(dollars: number): number {
  if (!Number.isFinite(dollars)) throw new Error(`Not a money amount: ${dollars}`);
  const cents = Math.round(Number((Math.abs(dollars) * 100).toPrecision(15)));
  return dollars < 0 ? -cents : cents;
}

export function fromCents(cents: number): number {
  return cents / 100;
}

/** A dollar amount rounded to the cent by the rule above. */
export function roundMoney(dollars: number): number {
  return fromCents(toCents(dollars));
}

/** Sum of amounts, each already a cent figure, without float drift. */
export function sumMoney(amounts: readonly number[]): number {
  return fromCents(amounts.reduce((s, a) => s + toCents(a), 0));
}

/** amount × percent / 100, to the cent. */
export function percentOf(amount: number, percent: number): number {
  return roundMoney((amount * percent) / 100);
}

/**
 * Hours × an hourly rate, to the cent — the one multiplication every labor
 * figure uses (T&M bill, job ledger, field tickets). Which RATE applies (the
 * person's own, else their role's, on the work date) is the caller's lookup;
 * the database's rate_for() is the rule.
 */
export function laborAmount(hours: number, rate: number): number {
  return roundMoney(hours * rate);
}

/**
 * roundMoney for the call sites that predate this module (P5): the same rule
 * for every real amount, and a non-number passed through untouched — as their
 * private `Math.round(n * 100) / 100` did — so incomplete data shows as it
 * always did instead of throwing on a screen.
 */
export function roundMoneyLoose(dollars: number): number {
  return Number.isFinite(dollars) ? roundMoney(dollars) : dollars;
}
