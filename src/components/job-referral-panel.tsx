import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { CompanyContactPicker, type PickedContact } from "@/components/company-contact-picker";
import type { PickedAccount } from "@/components/account-picker";
import { Button } from "@/components/ui/button";
import { refreshJobCommission } from "@/lib/use-job-commission";

/**
 * The person who referred the job — referral credit (gifts, commissions)
 * attributes to that individual. Picked by name first (David, 13 Oct); a
 * company, when set, rides along to narrow the search and for reporting.
 */
export function JobReferralPanel({
  jobId,
  accountId,
  contactId,
  referredByName,
  disabled,
  onSaved,
}: {
  jobId: string;
  accountId: string | null;
  contactId: string | null;
  referredByName: string | null;
  disabled?: boolean;
  onSaved?: () => void;
}) {
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [contact, setContact] = useState<PickedContact | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (accountId) {
        const { data } = await supabase
          .from("accounts")
          .select("id, name, account_type, city, state")
          .eq("id", accountId)
          .maybeSingle();
        if (!cancelled && data) setAccount(data as unknown as PickedAccount);
      } else if (!cancelled) setAccount(null);

      if (contactId) {
        const { data } = await supabase
          .from("contacts")
          .select("id, full_name, email, phone")
          .eq("id", contactId)
          .maybeSingle();
        if (!cancelled && data) setContact(data as PickedContact);
      } else if (!cancelled) setContact(null);

      if (!cancelled) setDirty(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, contactId]);

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("jobs")
      .update({
        referred_by_account_id: account?.id ?? null,
        referred_by_contact_id: contact?.id ?? null,
        referred_by_name: contact?.full_name ?? account?.name ?? null,
      })
      .eq("id", jobId);
    setSaving(false);
    if (error) return toastDbError(error, { action: "save the referral" });
    toast.success("Referral saved");
    setDirty(false);
    // The Commissions card pays whoever is picked here (Mark, 7 Oct: "it will
    // pull the referring company from general").
    refreshJobCommission(qc, jobId);
    onSaved?.();
  }

  return (
    <div className="space-y-2 pt-2">
      {/*
       * David, 21 Oct: one way to name the referrer. The separate "New
       * referrer" button is gone — type their name in "Referred by" and the
       * list offers "Add contact", which creates the person and picks them.
       * Their commission deal is set on the Commissions card or under
       * Admin → Commissions, as for anybody else.
       */}
      <div className="text-xs font-medium text-muted-foreground">Referral</div>
      {/* David, 13 Oct (and earlier): the referral is a PERSON — pick them by
          name. The company is only there to narrow the search; the person is
          who the job records and who the commission is paid to. */}
      <CompanyContactPicker
        personFirst
        accountLabel="Their company (optional — narrows the list)"
        contactLabel="Referred by"
        account={account}
        onAccountChange={(a) => {
          setAccount(a);
          setContact(null);
          setDirty(true);
        }}
        contact={contact}
        onContactChange={(c) => {
          setContact(c);
          setDirty(true);
        }}
        disabled={disabled}
      />
      {!account && !contact && referredByName && (
        <p className="text-xs text-muted-foreground">Recorded as “{referredByName}”.</p>
      )}
      {dirty && !disabled && (
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save referral"}
        </Button>
      )}
    </div>
  );
}
