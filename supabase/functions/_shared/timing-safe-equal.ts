/**
 * Compare two secrets without leaking where they diverge.
 *
 * `a === b` on a string returns as soon as a byte differs, so the time it takes
 * tells an attacker how much of a guessed signature or shared key was right —
 * which turns forging one from 256^n guesses into 256×n. Compare every byte
 * every time, and fold the length difference into the result rather than
 * returning early on it.
 *
 * Used for every inbound shared secret: the Falcon bridge signature and the
 * internal service key.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
