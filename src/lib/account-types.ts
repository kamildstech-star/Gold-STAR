import { useMemo } from "react";
import { useOptionList, type OptionValue } from "./option-lists";

/**
 * Account type is a managed list, not an enum.
 *
 * Carriers, public adjusting firms, brokers, independent adjusters, referral
 * and trade partners all need somewhere to live, and the client will keep
 * adding kinds. The legacy `accounts.account_type` enum is kept in sync by a
 * database trigger so old reports keep working, but nothing in the UI may
 * hardcode the set.
 */

export const ACCOUNT_TYPE_LIST_KEY = "account_type";

/**
 * Types whose records are national reference data rather than one office's
 * book — every branch must see the same "State Farm".
 */
export const REFERENCE_TYPE_KEYS = [
  "insurance_carrier",
  "public_adjusting_firm",
  "insurance_broker",
  "adjusting_firm",
] as const;

export function isReferenceTypeKey(key: string | null | undefined) {
  return !!key && (REFERENCE_TYPE_KEYS as readonly string[]).includes(key);
}

export interface AccountTypeIndex {
  options: OptionValue[];
  isLoading: boolean;
  byId: Map<string, OptionValue>;
  byKey: Map<string, OptionValue>;
  idForKey: (key: string | null | undefined) => string | null;
  label: (idOrKey: string | null | undefined) => string;
}

export function useAccountTypes(includeInactive = false): AccountTypeIndex {
  const { options, isLoading } = useOptionList(ACCOUNT_TYPE_LIST_KEY, { includeInactive });
  return useMemo(() => {
    const byId = new Map(options.map((o) => [o.id, o]));
    const byKey = new Map(options.map((o) => [o.key, o]));
    return {
      options,
      isLoading,
      byId,
      byKey,
      idForKey: (key) => (key ? (byKey.get(key)?.id ?? null) : null),
      label: (idOrKey) => {
        if (!idOrKey) return "—";
        return byId.get(idOrKey)?.label ?? byKey.get(idOrKey)?.label ?? idOrKey;
      },
    };
  }, [options, isLoading]);
}
