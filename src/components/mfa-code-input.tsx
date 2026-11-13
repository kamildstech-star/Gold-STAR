/**
 * Six-digit TOTP entry, shared by the sign-in challenge and the enrolment
 * confirmation so the two cannot drift apart. Submits itself the moment six
 * digits are present — a code is valid for thirty seconds and hunting for a
 * button costs a meaningful slice of that.
 */
import { useEffect } from "react";

import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";

export function MfaCodeInput({
  value,
  onChange,
  onComplete,
  disabled,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  onComplete: () => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  useEffect(() => {
    if (value.length === 6 && !disabled) onComplete();
    // onComplete is recreated each render by every caller; depending on it here
    // would re-fire the submit on any unrelated state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, disabled]);

  return (
    <InputOTP
      maxLength={6}
      value={value}
      onChange={onChange}
      disabled={disabled}
      autoFocus={autoFocus}
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label="Six-digit authentication code"
    >
      <InputOTPGroup>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}
