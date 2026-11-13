import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const LOCKED = "This page is locked. Enter the password again.";

export const unlockEnvKeys = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ password: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const { passwordMatches, issueToken, LOCKOUT_RULE } = await import("./env-keys.server");
    const { consumeLimit, peekLimit, resetLimit, clientIp } = await import("./rate-limit.server");
    const { getRequest } = await import("@tanstack/react-start/server");
    const expected = (process.env["ENV_VIEWER_PASSWORD"] ?? "").trim();
    if (!expected) return { ok: false as const, error: "This page has no password set yet." };

    const ip = clientIp(getRequest().headers);
    const peek = await peekLimit("env-keys", ip, LOCKOUT_RULE, "closed");
    if (!peek.allowed) {
      return {
        ok: false as const,
        error: peek.degraded
          ? "Temporarily unavailable. Try again in a minute."
          : `Too many wrong attempts. Try again in about ${Math.ceil(peek.retryAfterSeconds / 60)} minute(s).`,
      };
    }
    if (!passwordMatches(data.password, expected)) {
      const after = await consumeLimit("env-keys", ip, LOCKOUT_RULE, "closed");
      const left = Math.max(0, LOCKOUT_RULE.limit - after.attempts);
      return {
        ok: false as const,
        error: left > 0 ? `Incorrect password. ${left} attempt(s) left.` : "Too many wrong attempts. Locked for 15 minutes.",
      };
    }
    await resetLimit("env-keys", ip);
    return { ok: true as const, ...issueToken(expected) };
  });

export const listEnvKeys = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().min(1).max(200) }).parse(d))
  .handler(async ({ data }) => {
    const { tokenValid, secretStatus } = await import("./env-keys.server");
    const expected = (process.env["ENV_VIEWER_PASSWORD"] ?? "").trim();
    if (!expected || !tokenValid(data.token, expected)) return { ok: false as const, error: LOCKED };
    // Names, set/not-set and guidance only — never a value.
    return { ok: true as const, secrets: secretStatus() };
  });
