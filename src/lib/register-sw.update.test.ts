import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { TAKEOVER_TIMEOUT_MS, applyUpdate, type UpdateEnv } from "./register-sw";

/**
 * The "Update available — Reload" toast, across more than one open tab.
 *
 * With clientsClaim the new worker takes over every open tab once Reload is
 * tapped in any one of them. The others must not reload by themselves (a
 * half-filled form, PR #269) — but their own Reload has to work when tapped,
 * which it did not: it posted SKIP_WAITING to a worker that was already
 * active, controllerchange never fired, and nothing happened.
 */
function fakeEnv() {
  const listeners: Array<() => void> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const env: UpdateEnv = {
    reload: vi.fn(),
    onControllerChange: (l) => void listeners.push(l),
    later: (fn, ms) => void timers.push({ fn, ms }),
  };
  return {
    env,
    controllerChange: () => listeners.forEach((l) => l()),
    runTimers: () => timers.forEach((t) => t.fn()),
    listeners,
    timers,
  };
}

describe("applyUpdate", () => {
  it("in the tab that asks first: activates the waiting worker and reloads on takeover", () => {
    const f = fakeEnv();
    const waiting = { postMessage: vi.fn() };
    expect(applyUpdate({ waiting }, f.env)).toBe("activating");
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(f.env.reload).not.toHaveBeenCalled();
    f.controllerChange();
    expect(f.env.reload).toHaveBeenCalledTimes(1);
  });

  it("in a tab the update already took over: Reload reloads, instead of doing nothing", () => {
    const f = fakeEnv();
    expect(applyUpdate({ waiting: null }, f.env)).toBe("reloading");
    expect(f.env.reload).toHaveBeenCalledTimes(1);
    // Nothing is armed to fire again later.
    expect(f.listeners).toHaveLength(0);
    expect(f.timers).toHaveLength(0);
  });

  it("reloads once, whichever of takeover and the fallback comes first", () => {
    const f = fakeEnv();
    applyUpdate({ waiting: { postMessage: vi.fn() } }, f.env);
    f.controllerChange();
    f.runTimers();
    f.controllerChange();
    expect(f.env.reload).toHaveBeenCalledTimes(1);
  });

  it("still reloads the tab that tapped if the worker never takes over", () => {
    const f = fakeEnv();
    applyUpdate({ waiting: { postMessage: vi.fn() } }, f.env);
    expect(f.timers.map((t) => t.ms)).toEqual([TAKEOVER_TIMEOUT_MS]);
    f.runTimers();
    expect(f.env.reload).toHaveBeenCalledTimes(1);
  });

  it("asks whichever worker is waiting when tapped, not the one first offered", () => {
    // A second deploy while the toast sat open replaces the waiting worker.
    const f = fakeEnv();
    const reg = { waiting: { postMessage: vi.fn() } };
    const first = reg.waiting;
    reg.waiting = { postMessage: vi.fn() };
    applyUpdate(reg, f.env);
    expect(first.postMessage).not.toHaveBeenCalled();
    expect(reg.waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
  });
});

describe("nothing reloads on its own", () => {
  const SW = readFileSync("src/lib/register-sw.ts", "utf8").replace(/\r\n/g, "\n");

  it("has exactly one reload and one controllerchange listener, both in the injected env", () => {
    expect(SW.match(/location\.reload\(\)/g)).toHaveLength(1);
    expect(SW.match(/addEventListener\("controllerchange"/g)).toHaveLength(1);
    const env = SW.match(/const BROWSER: UpdateEnv = \{[\s\S]*?\n\};/)![0];
    expect(env).toContain("window.location.reload()");
    expect(env).toContain('addEventListener("controllerchange", listener)');
  });

  it("only reaches that env through applyUpdate, and applyUpdate only from the toast's Reload", () => {
    expect(SW.match(/applyUpdate\(reg, BROWSER\)/g)).toHaveLength(1);
    const ready = SW.match(/const ready = \(\) => ([^;]*);/)![1];
    expect(ready).toBe("showUpdateToast(() => applyUpdate(reg, BROWSER))");
    const toast = SW.match(
      /function showUpdateToast\(apply: \(\) => void\): void \{[\s\S]*?\n\}/,
    )![0];
    expect(toast).toMatch(/action: \{ label: "Reload", onClick: apply \}/);
  });
});
