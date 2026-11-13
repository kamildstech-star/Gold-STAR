/**
 * Is this an iPhone or an iPad?
 *
 * Asked because iOS and iPadOS are the one family where a `blob:` URL in an
 * `<iframe>` renders as a blank grey box instead of a PDF — the estimate
 * preview looked broken on exactly the device a rep is holding at a loss,
 * while generating and sharing the same file worked fine.
 *
 * THE IPAD PROBLEM. Since iPadOS 13 an iPad reports itself as a Mac:
 *
 *   Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ...
 *
 * — the same string a real MacBook sends, where the iframe works perfectly. So
 * the user-agent alone answers "Mac" for both and gets one of them wrong. The
 * tiebreak is `maxTouchPoints`: a Mac reports 0, an iPad reports 5. Desktop
 * Safari on a Mac with a touch-bar or a connected iPad still reports 0, so
 * this does not misfire on the machine the office uses.
 *
 * Pure and injectable so the cases can be tested without a browser — the
 * detection is the part worth pinning, not the dialog around it.
 */

/** Just the two things detection reads, so a test can hand over a literal. */
export interface PlatformProbe {
  userAgent: string;
  maxTouchPoints: number;
}

export function isIosLike(probe?: PlatformProbe | null): boolean {
  const nav =
    probe ??
    (typeof navigator === "undefined"
      ? null
      : { userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints ?? 0 });
  // SSR and the thumbnail-capture context have no navigator. Answering "not
  // iOS" there keeps the server rendering the same markup a desktop gets.
  if (!nav) return false;

  const ua = nav.userAgent ?? "";
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS in desktop mode. `> 1` rather than `> 0` for the same reason
  // detectPlatform() uses it: a stray 1 from a hybrid device is not an iPad.
  return /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
}
