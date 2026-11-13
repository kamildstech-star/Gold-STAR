/**
 * A Bluetooth (HID) barcode scanner, read without a focused text box.
 *
 * Field report, 22 Oct: on an iPhone, opening a scanner put the on-screen
 * keyboard and its accessory bar (arrows and a tick) over the camera. The
 * cause was focus: the dialog handed focus to its first focusable element on
 * opening, which was the typed-tag box, and iOS answers a focused text box
 * with the keyboard. The scanners now never focus a text box by themselves —
 * it takes focus only when someone taps it.
 *
 * A Bluetooth scanner is a keyboard: it "types" the code and presses Enter.
 * Those keys reach the page with nothing focused, so they are collected here,
 * at the window, and handed over on Enter. Keys aimed at a real text box
 * (somebody typing a tag on purpose) are left to that box.
 *
 * Pure: a state and one key in, the next state and maybe a code out — so the
 * timing rules are tested without a DOM.
 */

/** A pause longer than this starts a new code: scanners type in a burst. */
export const HID_KEY_GAP_MS = 300;

/** Shorter than this, an Enter is a stray key, not a code. */
export const HID_MIN_LENGTH = 3;

export type HidCaptureState = { buffer: string; lastAt: number };

export const HID_EMPTY: HidCaptureState = { buffer: "", lastAt: 0 };

/**
 * One key. Printable single characters are collected; Enter (or Tab, which
 * some scanners send instead) hands over what was collected.
 */
export function hidCaptureStep(
  state: HidCaptureState,
  key: string,
  at: number,
): { state: HidCaptureState; code: string | null } {
  const fresh = at - state.lastAt > HID_KEY_GAP_MS;
  if (key === "Enter" || key === "Tab") {
    const code = fresh ? "" : state.buffer.trim();
    return {
      state: HID_EMPTY,
      code: code.length >= HID_MIN_LENGTH ? code : null,
    };
  }
  if (key.length !== 1) return { state, code: null }; // Shift, arrows, …
  return { state: { buffer: (fresh ? "" : state.buffer) + key, lastAt: at }, code: null };
}

/** Is this element a place a person types into? Keys aimed there are not ours. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!el || typeof (el as HTMLElement).tagName !== "string") return false;
  const node = el as HTMLElement;
  const tag = node.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = ((node as HTMLInputElement).type || "text").toLowerCase();
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
      type,
    );
  }
  return node.isContentEditable === true;
}

/**
 * Radix's open handler for a scanner dialog: keep focus off every text box.
 * The dialog itself takes focus instead, so the keyboard stays down on iOS,
 * screen readers still land inside the dialog, and a Bluetooth scanner's keys
 * still reach the window listener above.
 */
export function keepKeyboardDown(e: Event): void {
  e.preventDefault();
  const content = e.currentTarget as HTMLElement | null;
  content?.focus?.({ preventScroll: true });
}
