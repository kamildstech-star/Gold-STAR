import { useEffect, useRef } from "react";

import { HID_EMPTY, hidCaptureStep, isTypingTarget } from "@/lib/hid-scan-capture";

/**
 * While `enabled`, codes a Bluetooth scanner types with no text box focused
 * are handed to `onCode` — see hid-scan-capture.ts. A key aimed at a real
 * text box is left alone, so the typed-tag field keeps working as itself.
 */
export function useHidScanCapture(enabled: boolean, onCode: (code: string) => void): void {
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    let state = HID_EMPTY;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        state = HID_EMPTY;
        return;
      }
      const step = hidCaptureStep(state, e.key, Date.now());
      state = step.state;
      if (step.code) {
        // The Enter is the scanner's, not a click on whatever has focus.
        e.preventDefault();
        onCodeRef.current(step.code);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
