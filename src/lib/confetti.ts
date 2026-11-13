/**
 * A short burst of confetti, with no dependency.
 *
 * Mark, on dragging a deal into Active Clients: "it should automatically move
 * the client to active status and trigger a quick confetti animation to
 * celebrate the win."
 *
 * Winning a client is the thing this whole board exists for, and it happens a
 * handful of times a week. A canvas that draws itself, falls over in about a
 * second and removes itself is worth more than a package for that.
 *
 * It never blocks anything: pointer-events are off, it sits above the page,
 * and it tidies up after itself whether or not the component that fired it is
 * still mounted.
 */

const DURATION_MS = 1400;
const COUNT = 90;
const GRAVITY = 0.0016;

/** Gold Star's own palette, so the celebration looks like the product. */
const COLORS = ["#C8A227", "#E8B923", "#1B5FA8", "#2E8B57", "#E81820", "#FFFFFF"];

type Piece = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
};

/**
 * True when the viewer has asked for less motion. Exported so callers can make
 * the same decision about anything they pair with this.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Fire once. Returns a function that stops it early — used when the page
 * navigates away mid-burst rather than leaving a canvas behind.
 */
export function celebrate(): () => void {
  // Nothing to do off the browser, and nothing to do for somebody who has
  // asked for less motion. Silently, because a missing celebration is not an
  // error worth telling anyone about.
  if (typeof document === "undefined" || prefersReducedMotion()) return () => {};

  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999";
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  const pieces: Piece[] = Array.from({ length: COUNT }, () => {
    // Thrown up and outward from just below the middle, like a party popper.
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
    const speed = 0.35 + Math.random() * 0.5;
    return {
      x: w / 2 + (Math.random() - 0.5) * w * 0.3,
      y: h * 0.55,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.02,
      w: 6 + Math.random() * 5,
      h: 9 + Math.random() * 6,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    };
  });

  let raf = 0;
  let start = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    canvas.remove();
  };

  const frame = (now: number) => {
    if (stopped) return;
    if (!start) start = now;
    const elapsed = now - start;
    if (elapsed >= DURATION_MS) return stop();

    const dt = 16;
    ctx.clearRect(0, 0, w, h);
    // Fades out over the last third rather than vanishing mid-air.
    ctx.globalAlpha = Math.max(0, Math.min(1, (DURATION_MS - elapsed) / (DURATION_MS / 3)));

    for (const p of pieces) {
      p.vy += GRAVITY * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    raf = requestAnimationFrame(frame);
  };

  raf = requestAnimationFrame(frame);
  return stop;
}
