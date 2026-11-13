import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { AccountFunctionPicker } from "@/components/account-function-picker";
import { AccountLocationsPicker } from "@/components/account-locations-picker";
import {
  accountLocationsKey,
  saveAccountMultiLocation,
  servingLocationIds,
  syncAccountLocations,
  useAccountLocations,
} from "@/lib/account-locations";
import { assertWritesEnabled } from "@/lib/write-guard";

/**
 * "What they do", the multi-location switch and the offices that serve this
 * account, editable in place. Compliance resolves certificates against every
 * office listed here, so this is the switch that makes one certificate cover
 * a multi-branch client — and the thing that puts a Jersey-owned company on
 * California's list.
 */
export function AccountProfileEditor({
  accountId,
  owningLocationId,
  isMultiLocation,
  whatTheyDo,
  onSaved,
  readOnly = false,
}: {
  accountId: string;
  owningLocationId: string;
  isMultiLocation: boolean;
  whatTheyDo: string[];
  onSaved: () => void;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [functions, setFunctions] = useState<string[]>(whatTheyDo);
  const [multi, setMulti] = useState(isMultiLocation);
  const [saving, setSaving] = useState(false);

  const servedQ = useAccountLocations(accountId);
  const extras = (ids: string[]) => ids.filter((id) => id !== owningLocationId);
  const [served, setServed] = useState<string[] | null>(null);
  const servedValue = served ?? extras(servedQ.data ?? []);

  const save = async () => {
    if (functions.length === 0) {
      toast.error("Pick at least one — What they do is required.");
      return;
    }
    setSaving(true);
    try {
      assertWritesEnabled(readOnly);
      const { error } = await supabase
        .from("accounts")
        .update({ what_they_do: functions })
        .eq("id", accountId);
      if (error) throw error;

      const flagStored = await saveAccountMultiLocation(accountId, multi);
      await syncAccountLocations(
        accountId,
        servingLocationIds(owningLocationId, servedValue, multi),
      );
      qc.invalidateQueries({ queryKey: accountLocationsKey(accountId) });
      onSaved();
      setEditing(false);
      toast.success(
        flagStored
          ? "Saved"
          : "Offices saved. The multi-location flag itself is not stored until the database migration is applied.",
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={readOnly}
        title={readOnly ? "Writes are disabled in this view." : undefined}
        onClick={() => {
          setFunctions(whatTheyDo);
          setMulti(isMultiLocation);
          setServed(extras(servedQ.data ?? []));
          setEditing(true);
        }}
      >
        Edit what they do & offices
      </Button>
    );
  }

  return (
    <div className="space-y-2 rounded-sm border p-2.5">
      <AccountFunctionPicker value={functions} onChange={setFunctions} />
      <AccountLocationsPicker
        value={servedValue}
        onChange={setServed}
        owningLocationId={owningLocationId}
        multi={multi}
        onMultiChange={setMulti}
      />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={saving || readOnly}>
          Save
        </Button>
      </div>
    </div>
  );
}
