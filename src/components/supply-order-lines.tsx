import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toastDbError } from "@/lib/db-errors";
import type { SupplyItem, SupplyRequestFull } from "@/lib/supplies";
import {
  lineVendorId,
  presetVendor,
  resolveLineVendor,
  setLineVendor,
  type SupplyVendor,
} from "@/lib/supply-vendors";

/** Select value meaning "whatever the item's preset says". */
const USE_PRESET = "__preset__";

export type OrderLine = SupplyRequestFull["supply_request_lines"][number];

/** Name and size, the way David's sheet tells five filters apart. */
export function lineLabel(line: OrderLine): string {
  const name = line.supply_items?.name ?? line.other_label ?? "Item";
  const size = line.supply_items?.size?.trim();
  return size ? `${name} (${size})` : name;
}

export function lineQuantity(line: OrderLine): string {
  const qty = Number(line.quantity);
  const unit = line.unit ?? line.supply_items?.unit ?? "";
  return `${qty % 1 === 0 ? qty : qty.toFixed(2)} ${unit}`.trim();
}

/**
 * Who one order line is bought from, and the place to change it.
 *
 * David, 22 Sep: "we could obviously always in each order select a vendor."
 * The item's preset is what the line starts on and is labelled as such; a
 * choice made here is stored on the line alone and never moves the preset.
 */
export function LineVendorSelect({
  line,
  item,
  vendors,
  canEdit,
}: {
  line: OrderLine;
  item: SupplyItem | null;
  vendors: SupplyVendor[];
  canEdit: boolean;
}) {
  const qc = useQueryClient();
  const change = useMutation({
    mutationFn: (vendorId: string | null) => setLineVendor(line.id, vendorId),
    onSuccess: () => {
      toast.success("Vendor changed for this line");
      void qc.invalidateQueries({ queryKey: ["supply-requests"] });
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "change the line's vendor" });
    },
  });

  const resolved = resolveLineVendor(line, item, vendors);
  const usual = presetVendor(item, vendors);
  const own = lineVendorId(line);

  if (!canEdit || vendors.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {resolved ? resolved.vendor.name : "No vendor"}
        {resolved && resolved.source !== "line" ? " (usual)" : ""}
      </span>
    );
  }

  return (
    <Select
      value={own ?? USE_PRESET}
      disabled={change.isPending}
      onValueChange={(v) => change.mutate(v === USE_PRESET ? null : v)}
    >
      <SelectTrigger className="h-11 md:h-8" aria-label={`Vendor for ${lineLabel(line)}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={USE_PRESET}>
          {usual ? `${usual.vendor.name} (usual)` : "No vendor chosen"}
        </SelectItem>
        {vendors
          .filter((v) => v.id !== usual?.vendor.id || own === v.id)
          .map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {v.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
