import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { PickedAccount } from "@/components/account-picker";
import type { PickedCustomer } from "@/components/customer-picker";

/**
 * The CRM account field should not sit empty waiting to be searched when the
 * form already knows enough to fill it. Resolution order, strongest evidence
 * first:
 *
 *   1. the customer picked from the type-ahead        → fill
 *   2. a prior job at this property address           → fill
 *   3. an account already tied to this building       → fill
 *   4. a lead / opportunity this record came from     → fill
 *   5. a close match on the typed customer name       → suggest only
 *
 * A fuzzy name match is weaker evidence than the rest, so it is offered for
 * confirmation rather than applied. Every outcome carries a human reason —
 * a field that fills itself with no explanation gets distrusted and cleared.
 */

export type AccountInferenceSource =
  "customer" | "prior_job" | "property" | "carried" | "name_match";

export interface AccountInference {
  account: PickedAccount;
  reason: string;
  source: AccountInferenceSource;
  /** Name matches are suggestions the rep confirms; everything else fills. */
  suggestionOnly: boolean;
}

export async function fetchPickedAccount(id: string): Promise<PickedAccount | null> {
  const { data, error } = await supabase
    .from("accounts")
    .select("id, name, location_id, contacts(full_name, phone, email, is_primary)")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  const contacts = (data.contacts ?? []) as Array<{
    full_name: string;
    phone: string | null;
    email: string | null;
    is_primary: boolean;
  }>;
  const primary = contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;
  return {
    id: data.id,
    name: data.name,
    location_id: data.location_id,
    primary_contact: primary
      ? { full_name: primary.full_name, phone: primary.phone, email: primary.email }
      : null,
  };
}

function num(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeName(s: string) {
  return s
    .toLowerCase()
    .replace(/\b(inc|llc|llp|ltd|corp|co|company|group|properties|property|management|mgmt)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface AccountInferenceInput {
  customer?: PickedCustomer | null;
  address?: string;
  lat?: string | number | null;
  lon?: string | number | null;
  /** Account carried over from a lead or opportunity conversion. */
  carriedAccountId?: string | null;
  carriedFromLabel?: string | null;
  /** Typed customer / company name, used only for the weak name match. */
  typedName?: string;
  enabled?: boolean;
}

export function useAccountInference(input: AccountInferenceInput): AccountInference | null {
  const {
    customer,
    address = "",
    lat,
    lon,
    carriedAccountId = null,
    carriedFromLabel = null,
    typedName = "",
    enabled = true,
  } = input;

  const addr = address.trim();
  const la = num(lat);
  const lo = num(lon);
  const name = (customer?.name || typedName).trim();

  // 1. Straight from the picked customer.
  const fromCustomer = useQuery({
    queryKey: ["acct-infer-customer", customer?.accountId],
    enabled: enabled && !!customer?.accountId,
    queryFn: async () => fetchPickedAccount(customer!.accountId!),
  });

  // 4. Carried through a conversion.
  const fromCarried = useQuery({
    queryKey: ["acct-infer-carried", carriedAccountId],
    enabled: enabled && !!carriedAccountId,
    queryFn: async () => fetchPickedAccount(carriedAccountId!),
  });

  // 2. Prior jobs at this property.
  const fromPriorJob = useQuery({
    queryKey: ["acct-infer-prior", addr, la, lo],
    enabled: enabled && (addr.length >= 4 || (la !== undefined && lo !== undefined)),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("prior_jobs_at_address", {
        _address: addr,
        _lat: la,
        _lon: lo,
      });
      if (error) throw error;
      const rows = (
        (data ?? []) as unknown as Array<{
          account_id: string | null;
          viewer_has_full_access: boolean;
        }>
      ).filter((r) => r.account_id && r.viewer_has_full_access);
      if (rows.length === 0) return null;
      const acct = await fetchPickedAccount(rows[0]!.account_id!);
      return acct
        ? { acct, count: rows.filter((r) => r.account_id === rows[0]!.account_id).length }
        : null;
    },
  });

  // 3. A building already tied to an account.
  const fromProperty = useQuery({
    queryKey: ["acct-infer-property", addr, la, lo],
    enabled: enabled && (addr.length >= 4 || (la !== undefined && lo !== undefined)),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("accounts_at_address", {
        _address: addr,
        _lat: la,
        _lon: lo,
      });
      if (error) throw error;
      const rows = (
        (data ?? []) as unknown as Array<{
          account_id: string;
          matched_by: string;
          viewer_has_full_access: boolean;
        }>
      ).filter((r) => r.viewer_has_full_access);
      if (rows.length === 0) return null;
      const acct = await fetchPickedAccount(rows[0]!.account_id);
      return acct ? { acct, matchedBy: rows[0]!.matched_by } : null;
    },
  });

  // 5. Weak: a close name match.
  const debounced = useDebounced(name, 350);
  const fromName = useQuery({
    queryKey: ["acct-infer-name", debounced],
    enabled: enabled && debounced.length >= 4,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id, name")
        .ilike("name", `%${debounced}%`)
        .limit(5);
      if (error) throw error;
      const target = normalizeName(debounced);
      const hit = (data ?? []).find((a) => {
        const n = normalizeName(a.name);
        return n === target || n.startsWith(target) || target.startsWith(n);
      });
      return hit ? fetchPickedAccount(hit.id) : null;
    },
  });

  if (!enabled) return null;

  if (customer?.accountId && fromCustomer.data) {
    const who =
      customer.kind === "person" && customer.name ? `contact ${customer.name}` : customer.name;
    return {
      account: fromCustomer.data,
      reason: who ? `From ${who}` : "From the selected customer",
      source: "customer",
      suggestionOnly: false,
    };
  }

  if (fromPriorJob.data) {
    const { acct, count } = fromPriorJob.data;
    return {
      account: acct,
      reason: `Linked from ${count} previous job${count === 1 ? "" : "s"} at this address`,
      source: "prior_job",
      suggestionOnly: false,
    };
  }

  if (fromProperty.data) {
    return {
      account: fromProperty.data.acct,
      reason:
        fromProperty.data.matchedBy === "account_address"
          ? "This address is on file for this account"
          : "This building is already one of their properties",
      source: "property",
      suggestionOnly: false,
    };
  }

  if (carriedAccountId && fromCarried.data) {
    return {
      account: fromCarried.data,
      reason: carriedFromLabel
        ? `Carried from ${carriedFromLabel}`
        : "Carried from the original lead",
      source: "carried",
      suggestionOnly: false,
    };
  }

  if (fromName.data) {
    return {
      account: fromName.data,
      reason: `Name looks like “${fromName.data.name}” — confirm to link`,
      source: "name_match",
      suggestionOnly: true,
    };
  }

  return null;
}

function useDebounced(value: string, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Wires an inference into a form's account state. The rep always wins: once
 * they pick or clear the field by hand, inference stops overriding it.
 */
export function useAutoLinkedAccount(
  inference: AccountInference | null,
  account: PickedAccount | null,
  setAccount: (a: PickedAccount | null) => void,
) {
  const manual = useRef(false);
  const [reason, setReason] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);

  useEffect(() => {
    if (manual.current) return;
    if (!inference || inference.suggestionOnly) return;
    if (dismissed.includes(inference.account.id)) return;
    if (account?.id === inference.account.id) {
      if (reason !== inference.reason) setReason(inference.reason);
      return;
    }
    if (account) return; // something is already linked — don't fight it
    setAccount(inference.account);
    setReason(inference.reason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inference?.account.id, inference?.reason, account?.id]);

  const suggestion =
    inference && inference.suggestionOnly && !account && !dismissed.includes(inference.account.id)
      ? inference
      : null;

  return {
    reason: account ? reason : null,
    suggestion,
    acceptSuggestion: () => {
      if (!suggestion) return;
      manual.current = true;
      setAccount(suggestion.account);
      setReason(suggestion.reason.replace(/ — confirm to link$/, ""));
    },
    dismissSuggestion: () => {
      if (!suggestion) return;
      setDismissed((d) => [...d, suggestion.account.id]);
    },
    onManualChange: (a: PickedAccount | null) => {
      manual.current = true;
      setReason(null);
      setAccount(a);
    },
  };
}
