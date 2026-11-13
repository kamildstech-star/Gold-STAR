import { useMemo, useState } from "react";

/**
 * Open/closed state for a set of groups, with the panel's rules: collapsed by
 * default, a group with something worth seeing opens on its own, and a search
 * opens everything because a hidden match reads as "no results".
 */
export function useGroupState(input: {
  /** Groups that should start open — the ones carrying an override. */
  autoOpen: ReadonlySet<string>;
  searching: boolean;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const { autoOpen, searching } = input;

  return useMemo(
    () => ({
      isOpen: (key: string) => (searching ? true : (open[key] ?? autoOpen.has(key))),
      toggle: (key: string) => setOpen((o) => ({ ...o, [key]: !(o[key] ?? autoOpen.has(key)) })),
      setAll: (keys: readonly string[], value: boolean) =>
        setOpen(Object.fromEntries(keys.map((k) => [k, value]))),
    }),
    [open, autoOpen, searching],
  );
}
