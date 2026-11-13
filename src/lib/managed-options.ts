import { useMemo } from "react";
import { useOptionList } from "./option-lists";

/**
 * Classification lists (account type, loss type, incident type, expense kind…)
 * are admin-managed rows in `option_list_values`, not Postgres enums — the
 * client adds "Property" as an account type without a deploy.
 *
 * The hardcoded arrays that used to drive these selects stay behind as a
 * fallback for the first render and for the rare case the list hasn't loaded,
 * so a slow query never leaves a dropdown empty.
 */
export interface ManagedOption {
  key: string;
  label: string;
}

export interface ManagedOptions {
  options: ManagedOption[];
  keys: string[];
  label: (key: string | null | undefined) => string;
}

export function optionsFrom(
  keys: readonly string[],
  labels: Record<string, string>,
): ManagedOption[] {
  return keys.map((k) => ({ key: k, label: labels[k] ?? k }));
}

export function useManagedOptions(
  listKey: string,
  fallback: ManagedOption[],
  opts: { locationId?: string | null } = {},
): ManagedOptions {
  const { options } = useOptionList(listKey, { locationId: opts.locationId });
  return useMemo(() => {
    const list: ManagedOption[] = options.length
      ? options.map((o) => ({ key: o.key, label: o.label }))
      : fallback;
    const map = new Map(list.map((o) => [o.key, o.label]));
    for (const f of fallback) if (!map.has(f.key)) map.set(f.key, f.label);
    return {
      options: list,
      keys: list.map((o) => o.key),
      label: (key) => (key ? (map.get(key) ?? key) : "—"),
    };
  }, [options, fallback]);
}
