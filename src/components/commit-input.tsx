import type { ComponentProps } from "react";

import { Input } from "@/components/ui/input";

/**
 * A text cell that saves when you leave it — the contract the unit cost box
 * has had on this page since it existed, now that the name, unit and category
 * are editable too.
 *
 * Uncontrolled, so typing never re-renders the table; `key` on the saved value
 * pulls the box back to the truth after the list refetches. A commit that the
 * database refuses (a duplicate name, most of it) puts the saved text back
 * itself, because a red toast over a box still showing the rejected word is
 * how somebody ends up believing it saved.
 */
export function CommitInput({
  value,
  placeholder,
  onCommit,
  ...rest
}: {
  value: string | null;
  placeholder?: string;
  onCommit: (next: string) => Promise<boolean>;
} & Omit<ComponentProps<typeof Input>, "value" | "defaultValue" | "onCommit">) {
  const saved = value ?? "";
  return (
    <Input
      key={saved}
      className="h-8"
      defaultValue={saved}
      placeholder={placeholder}
      onBlur={async (e) => {
        const box = e.currentTarget;
        const next = box.value.trim();
        if (next === saved.trim()) return;
        const ok = await onCommit(next);
        if (!ok) box.value = saved;
      }}
      {...rest}
    />
  );
}
