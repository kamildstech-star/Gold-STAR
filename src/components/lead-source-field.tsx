import { useMemo, useState } from "react";
import { Check, Pencil, Route as RouteIcon, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { DetailSelect, requiresDetailFor } from "@/components/detail-select";
import { useOptionList, toDetailOptions } from "@/lib/option-lists";
import { toastDbError } from "@/lib/db-errors";
import { assertWritesEnabled } from "@/lib/write-guard";

/**
 * Where a pipeline account came from. Values are admin-managed rows in the
 * `lead_source` option list (Broker, Adjuster, Fire chase, Tradeshow,
 * Affiliate…), stored on `accounts.lead_source_id` with a companion
 * `lead_source_detail` free-text column for "Other" and anything else an admin
 * flags as needing a specific.
 */
export function useLeadSources() {
  const { options, isLoading } = useOptionList("lead_source");
  return useMemo(
    () => ({
      isLoading,
      options,
      // The select works in option *ids* because that is what the column stores.
      detailOptions: toDetailOptions(options).map((o, i) => ({
        ...o,
        value: options[i]!.id,
      })),
      label: (id: string | null | undefined) =>
        id ? (options.find((o) => o.id === id)?.label ?? "—") : "—",
    }),
    [options, isLoading],
  );
}

export function LeadSourcePicker({
  valueId,
  onValueChange,
  detail,
  onDetailChange,
  label = "Lead source",
  className,
}: {
  valueId: string;
  onValueChange: (id: string) => void;
  detail: string;
  onDetailChange: (v: string) => void;
  label?: string;
  className?: string;
}) {
  const sources = useLeadSources();
  return (
    <DetailSelect
      label={label}
      placeholder={sources.isLoading ? "Loading…" : "Where did they come from?"}
      options={sources.detailOptions}
      value={valueId}
      onValueChange={onValueChange}
      detail={detail}
      onDetailChange={onDetailChange}
      detailLabel="Source detail"
      detailPlaceholder="Who referred them, which show, which campaign"
      className={className}
    />
  );
}

/** Inline, editable row for the account record — matches DrawerField layout. */
export function AccountLeadSourceRow({
  accountId,
  valueId,
  detail,
  onSaved,
  readOnly,
}: {
  accountId: string;
  valueId: string | null;
  detail: string | null;
  onSaved?: () => void;
  readOnly?: boolean;
}) {
  const sources = useLeadSources();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(valueId ?? "");
  const [draftDetail, setDraftDetail] = useState(detail ?? "");
  const [busy, setBusy] = useState(false);

  const begin = () => {
    if (readOnly) return;
    setDraft(valueId ?? "");
    setDraftDetail(detail ?? "");
    setEditing(true);
  };

  const commit = async () => {
    assertWritesEnabled(!!readOnly);
    setBusy(true);
    const needsDetail = requiresDetailFor(sources.detailOptions, draft);
    const { error } = await supabase
      .from("accounts")
      .update({
        lead_source_id: draft || null,
        lead_source_detail: needsDetail ? draftDetail.trim() || null : null,
      })
      .eq("id", accountId);
    setBusy(false);
    if (error) {
      toastDbError(error, { action: "Saving lead source" });
      return;
    }
    setEditing(false);
    onSaved?.();
  };

  const display = valueId
    ? `${sources.label(valueId)}${detail ? ` — ${detail}` : ""}`
    : "Not recorded";

  return (
    <div className="group grid grid-cols-[16px_72px_minmax(0,1fr)_auto] items-start gap-2 px-4 py-[7px] hover:bg-accent/40">
      <RouteIcon className="mt-0.5 size-3.5 text-muted-foreground" />
      <span className="truncate pt-0.5 text-[12px] text-muted-foreground">Source</span>
      {editing ? (
        <div className="min-w-0">
          <LeadSourcePicker
            label=""
            valueId={draft}
            onValueChange={setDraft}
            detail={draftDetail}
            onDetailChange={setDraftDetail}
          />
        </div>
      ) : readOnly ? (
        <span
          className={
            "min-w-0 break-words text-left text-[12.5px] " +
            (valueId ? "" : "text-muted-foreground")
          }
        >
          {display}
        </span>
      ) : (
        <button
          type="button"
          onClick={begin}
          className={
            "min-w-0 break-words text-left text-[12.5px] " +
            "cursor-text " +
            (valueId ? "" : "text-muted-foreground")
          }
        >
          {display}
        </button>
      )}
      {editing ? (
        <span className="flex items-center gap-0.5">
          <Button
            size="sm"
            variant="ghost"
            className="size-6 p-0"
            disabled={busy}
            onClick={() => void commit()}
          >
            <Check className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="size-6 p-0"
            onClick={() => setEditing(false)}
          >
            <X className="size-3.5" />
          </Button>
        </span>
      ) : (
        <span className="w-4">
          {!readOnly && (
            <Pencil className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          )}
        </span>
      )}
    </div>
  );
}
