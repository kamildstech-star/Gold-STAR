import { describe, expect, it } from "vitest";

import {
  consume,
  createMemoryRateLimiter,
  signInDelayMs,
  type RateLimitRule,
  type RateLimitState,
} from "./rate-limit";

const T0 = Date.parse("2026-09-03T12:00:00.000Z");
const RULE: RateLimitRule = { limit: 3, windowSeconds: 60 };
const LOCKING: RateLimitRule = { limit: 3, windowSeconds: 60, blockSeconds: 900 };

/** Replays `n` attempts from empty and hands back the last decision. */
function run(n: number, rule: RateLimitRule, startMs = T0, stepMs = 0) {
  let state: RateLimitState | null = null;
  let decision = consume(state, rule, startMs);
  state = decision.next;
  for (let i = 1; i < n; i += 1) {
    decision = consume(state, rule, startMs + i * stepMs);
    state = decision.next;
  }
  return { decision, state };
}

describe("consume — under, at, and over the limit", () => {
  it("allows the first attempt and counts down the remainder", () => {
    const { decision } = run(1, RULE);
    expect(decision.allowed).toBe(true);
    expect(decision.attempts).toBe(1);
    expect(decision.remaining).toBe(2);
    expect(decision.retryAfterSeconds).toBe(0);
  });

  it("allows attempts under the limit", () => {
    const { decision } = run(2, RULE);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(1);
  });

  it("allows the attempt that lands exactly on the limit", () => {
    const { decision } = run(3, RULE);
    expect(decision.allowed).toBe(true);
    expect(decision.attempts).toBe(3);
    expect(decision.remaining).toBe(0);
  });

  it("refuses the first attempt over the limit and says how long to wait", () => {
    const { decision } = run(4, RULE);
    expect(decision.allowed).toBe(false);
    expect(decision.attempts).toBe(4);
    expect(decision.remaining).toBe(0);
    // Whole window still ahead: all four attempts landed at T0.
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it("keeps refusing every further attempt inside the window", () => {
    const { decision } = run(9, RULE);
    expect(decision.allowed).toBe(false);
  });
});

describe("consume — window rollover", () => {
  it("refuses at the last millisecond of the window", () => {
    const over = run(4, RULE).state;
    const decision = consume(over, RULE, T0 + RULE.windowSeconds * 1000 - 1);
    expect(decision.allowed).toBe(false);
  });

  it("opens a fresh window once the old one has elapsed", () => {
    const over = run(4, RULE).state;
    const decision = consume(over, RULE, T0 + RULE.windowSeconds * 1000);
    expect(decision.allowed).toBe(true);
    expect(decision.attempts).toBe(1);
    expect(decision.next.windowStartedAt).toBe(T0 + RULE.windowSeconds * 1000);
  });

  it("does not roll over early when attempts are spread across the window", () => {
    // Four attempts 10s apart all sit inside one 60s window.
    const { decision } = run(4, RULE, T0, 10_000);
    expect(decision.allowed).toBe(false);
    expect(decision.attempts).toBe(4);
    expect(decision.retryAfterSeconds).toBe(30);
  });
});

describe("consume — lockout", () => {
  it("holds the identity out past the end of the window", () => {
    const locked = run(4, LOCKING).state;
    expect(locked.blockedUntil).toBe(T0 + 900_000);

    const afterWindow = consume(locked, LOCKING, T0 + 61_000);
    expect(afterWindow.allowed).toBe(false);
    expect(afterWindow.retryAfterSeconds).toBe(839);
  });

  it("does not extend the lockout while it is being hammered", () => {
    const locked = run(4, LOCKING).state;
    const probe = consume(locked, LOCKING, T0 + 100_000);
    expect(probe.next.blockedUntil).toBe(locked.blockedUntil);
    expect(probe.next.attempts).toBe(locked.attempts);
  });

  it("lets the identity back in when the lockout expires", () => {
    const locked = run(4, LOCKING).state;
    const decision = consume(locked, LOCKING, T0 + 900_000);
    expect(decision.allowed).toBe(true);
    expect(decision.attempts).toBe(1);
    expect(decision.next.blockedUntil).toBeNull();
  });
});

describe("separate identities do not share a bucket", () => {
  it("exhausting one email leaves another untouched", () => {
    const limiter = createMemoryRateLimiter();
    for (let i = 0; i < 4; i += 1) limiter.consume("signin:email", "alice", RULE, T0);

    expect(limiter.consume("signin:email", "alice", RULE, T0).allowed).toBe(false);
    expect(limiter.consume("signin:email", "bob", RULE, T0).allowed).toBe(true);
  });

  it("the same identity in a different bucket keeps its own budget", () => {
    const limiter = createMemoryRateLimiter();
    for (let i = 0; i < 4; i += 1) limiter.consume("signin:ip", "203.0.113.7", RULE, T0);

    expect(limiter.consume("signin:ip", "203.0.113.7", RULE, T0).allowed).toBe(false);
    expect(limiter.consume("hook:ip", "203.0.113.7", RULE, T0).allowed).toBe(true);
  });

  it("a reset clears only the identity it names", () => {
    const limiter = createMemoryRateLimiter();
    for (let i = 0; i < 4; i += 1) {
      limiter.consume("signin:email", "alice", RULE, T0);
      limiter.consume("signin:email", "bob", RULE, T0);
    }

    limiter.reset("signin:email", "alice");
    expect(limiter.consume("signin:email", "alice", RULE, T0).allowed).toBe(true);
    expect(limiter.consume("signin:email", "bob", RULE, T0).allowed).toBe(false);
  });
});

describe("signInDelayMs", () => {
  it("does not punish a single mistyped password", () => {
    expect(signInDelayMs(0)).toBe(0);
    expect(signInDelayMs(1)).toBe(0);
  });

  it("grows with each further failure", () => {
    expect(signInDelayMs(2)).toBe(1000);
    expect(signInDelayMs(3)).toBe(2000);
    expect(signInDelayMs(4)).toBe(4000);
    expect(signInDelayMs(5)).toBe(8000);
  });

  it("caps so a locked-out person is never left staring at a frozen form", () => {
    expect(signInDelayMs(6)).toBe(10_000);
    expect(signInDelayMs(50)).toBe(10_000);
  });
});
