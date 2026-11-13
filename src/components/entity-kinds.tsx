import { useEffect, useState, type ComponentType } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";

type AppContextValue = ReturnType<typeof useAppContext>;
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LocationPicker } from "@/components/location-picker";
import { toastDbError } from "@/lib/db-errors";
import { EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABEL, type EquipmentType } from "@/lib/equipment";
import { isPrivileged } from "@/lib/roles";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";

const EQUIPMENT_TYPE_OPTS = optionsFrom(EQUIPMENT_TYPES, EQUIPMENT_TYPE_LABEL);

/**
 * Registry of pickable record types.
 *
 * Each entry answers the three questions the shared <EntityPicker> asks:
 * how do I search this, may this user create one, and which dialog does that.
 * Types with no Create are deliberate — users are invited by an admin, and
 * permission-gated reference data tells the user who to ask instead.
 */

export type EntityOption = {
  id: string;
  label: string;
  sublabel?: string | null;
  badge?: string | null;
  /** Shown but not selectable (cross-office minimal visibility). */
  locked?: boolean;
  note?: string | null;
};

export type EntityScope = Record<string, string | null | undefined>;

type SearchCtx = { scope: EntityScope; app: AppContextValue };

export type EntityCreateProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  initialName: string;
  scope: EntityScope;
  onCreated: (o: EntityOption) => void;
};

type EntityKindConfig = {
  noun: string;
  article?: "a" | "an";
  fieldLabel: string;
  placeholder: string;
  searchPlaceholder?: string;
  minChars?: number;
  search: (term: string, ctx: SearchCtx) => Promise<EntityOption[]>;
  canCreate: (app: AppContextValue, scope: EntityScope) => boolean;
  /** What to do when there is no match and no create right. Never blank. */
  cannotCreateHint: (app: AppContextValue, scope: EntityScope) => string;
  Create?: ComponentType<EntityCreateProps>;
};

/* ------------------------------------------------------------------ */
/* Equipment                                                           */
/* ------------------------------------------------------------------ */

function EquipmentCreateDialog({
  open,
  onOpenChange,
  initialName,
  scope,
  onCreated,
}: EntityCreateProps) {
  const qc = useQueryClient();
  const [assetTag, setAssetTag] = useState(initialName);
  const [type, setType] = useState<EquipmentType>("air_mover");
  const [locationId, setLocationId] = useState(scope.locationId ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setAssetTag(initialName);
      setLocationId(scope.locationId ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialName]);

  const save = async () => {
    if (!assetTag.trim() || !locationId) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("equipment")
      .insert({
        asset_tag: assetTag.trim(),
        equipment_type: type,
        location_id: locationId,
        is_demo: false,
      })
      .select("id, asset_tag, equipment_type")
      .single();
    setSaving(false);
    if (error || !data) {
      toastDbError(error ?? new Error("no row"), { action: "Adding equipment" });
      return;
    }
    toast.success("Equipment added");
    void qc.invalidateQueries({ queryKey: ["equipment"] });
    onOpenChange(false);
    onCreated({
      id: data.id,
      label: data.asset_tag,
      sublabel: EQUIPMENT_TYPE_LABEL[data.equipment_type as EquipmentType],
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add equipment</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Asset tag</Label>
            <Input value={assetTag} onChange={(e) => setAssetTag(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as EquipmentType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ManagedOptionItems listKey="equipment_type" fallback={EQUIPMENT_TYPE_OPTS} />
              </SelectContent>
            </Select>
          </div>
          <LocationPicker value={locationId} onChange={setLocationId} />
          <p className="text-[11px] text-muted-foreground">
            Serial, cost and tracker tag can be filled in later in the register.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !assetTag.trim() || !locationId}>
            {saving ? "Saving…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Gift catalogue item                                                 */
/* ------------------------------------------------------------------ */

function GiftItemCreateDialog({ open, onOpenChange, initialName, onCreated }: EntityCreateProps) {
  const qc = useQueryClient();
  const [name, setName] = useState(initialName);
  const [cost, setCost] = useState("");
  const [desc, setDesc] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const { data, error } = await supabase
      .from("gift_catalog")
      .insert({
        name: name.trim(),
        description: desc.trim() || null,
        unit_cost_cents: cost ? Math.round(Number(cost) * 100) : 0,
        active: true,
        is_demo: false,
      })
      .select("id, name, unit_cost_cents")
      .single();
    setSaving(false);
    if (error || !data) {
      toastDbError(error ?? new Error("no row"), { action: "Adding catalog item" });
      return;
    }
    toast.success("Item added");
    void qc.invalidateQueries({ queryKey: ["gift-catalog"] });
    onOpenChange(false);
    onCreated({
      id: data.id,
      label: data.name,
      sublabel: `$${((data.unit_cost_cents ?? 0) / 100).toFixed(2)}`,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a gift item</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <div className="grid gap-1.5">
            <Label>Unit cost (optional)</Label>
            <NumberInput
              decimals={2}
              placeholder="0.00"
              value={cost}
              onValueChange={(_, clean) => setCost(clean)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Notes (optional)</Label>
            <Textarea rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Option-list value (permission gated)                                */
/* ------------------------------------------------------------------ */

function OptionValueCreateDialog({
  open,
  onOpenChange,
  initialName,
  scope,
  onCreated,
}: EntityCreateProps) {
  const qc = useQueryClient();
  const [name, setName] = useState(initialName);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  const save = async () => {
    const listId = scope.listId;
    if (!name.trim() || !listId) return;
    setSaving(true);
    const key = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    const { data, error } = await supabase
      .from("option_list_values")
      .insert({ list_id: listId, key, label: name.trim(), active: true })
      .select("id, label")
      .single();
    setSaving(false);
    if (error || !data) {
      toastDbError(error ?? new Error("no row"), { action: "Adding option" });
      return;
    }
    void qc.invalidateQueries({ queryKey: ["option-list-values"] });
    void qc.invalidateQueries({ queryKey: ["loss-types"] });
    onOpenChange(false);
    onCreated({ id: data.id, label: data.label });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add an option</DialogTitle>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label>Label</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          <p className="text-[11px] text-muted-foreground">
            Everyone in the company sees this option from now on.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || !name.trim() || !scope.listId}>
            {saving ? "Saving…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Registry                                                            */
/* ------------------------------------------------------------------ */

export const ENTITY_KINDS: Record<string, EntityKindConfig> = {
  equipment: {
    noun: "unit of equipment",
    fieldLabel: "Equipment",
    placeholder: "Find a unit…",
    searchPlaceholder: "Asset tag…",
    search: async (term, { scope }) => {
      let sel = supabase
        .from("equipment")
        .select("id, asset_tag, equipment_type, status, location_id")
        .eq("status", "available");
      if (scope.locationId) sel = sel.eq("location_id", scope.locationId);
      if (term) sel = sel.ilike("asset_tag", `%${term}%`);
      const { data, error } = await sel.order("asset_tag").limit(25);
      if (error) throw error;
      return (data ?? []).map((e) => ({
        id: e.id,
        label: e.asset_tag,
        sublabel: EQUIPMENT_TYPE_LABEL[e.equipment_type as EquipmentType],
      }));
    },
    canCreate: (app) => app.roles.length > 0,
    cannotCreateHint: () => "No available unit here. Ask an admin to register it.",
    Create: EquipmentCreateDialog,
  },

  gift_item: {
    noun: "gift item",
    fieldLabel: "Gift item",
    placeholder: "Choose an item…",
    search: async (term) => {
      let sel = supabase
        .from("gift_catalog")
        .select("id, name, unit_cost_cents, active")
        .eq("active", true);
      if (term) sel = sel.ilike("name", `%${term}%`);
      const { data, error } = await sel.order("name").limit(25);
      if (error) throw error;
      return (data ?? []).map((g) => ({
        id: g.id,
        label: g.name,
        sublabel: `$${((g.unit_cost_cents ?? 0) / 100).toFixed(2)}`,
      }));
    },
    canCreate: (app) => isPrivileged(app.roles),
    cannotCreateHint: () => "Not in the catalog. Ask an admin to add it under Admin → Gifts.",
    Create: GiftItemCreateDialog,
  },

  option_value: {
    noun: "option",
    fieldLabel: "Option",
    placeholder: "Choose…",
    search: async (term, { scope }) => {
      if (!scope.listId) return [];
      let sel = supabase
        .from("option_list_values")
        .select("id, label, active")
        .eq("list_id", scope.listId)
        .eq("active", true);
      if (term) sel = sel.ilike("label", `%${term}%`);
      const { data, error } = await sel.order("sort_order").limit(50);
      if (error) throw error;
      return (data ?? []).map((v) => ({ id: v.id, label: v.label }));
    },
    canCreate: (app, scope) => isPrivileged(app.roles) && !!scope.listId,
    cannotCreateHint: () => "No matching option. Ask an admin to add it under Admin → Dropdowns.",
    Create: OptionValueCreateDialog,
  },

  // Deliberately create-free: inviting a user carries roles, office
  // membership and access, so it stays an admin flow.
  user: {
    noun: "user",
    fieldLabel: "Person",
    placeholder: "Find a colleague…",
    minChars: 1,
    search: async (term) => {
      let sel = supabase.from("profiles").select("user_id, full_name, is_active");
      if (term) sel = sel.ilike("full_name", `%${term}%`);
      const { data, error } = await sel.order("full_name").limit(25);
      if (error) throw error;
      return (data ?? [])
        .filter((p) => p.is_active !== false)
        .map((p) => ({ id: p.user_id, label: p.full_name ?? "Unnamed user" }));
    },
    canCreate: () => false,
    cannotCreateHint: () => "No matching user. Ask an admin to invite them.",
  },

  document_template: {
    noun: "document template",
    fieldLabel: "Template",
    placeholder: "Choose a template…",
    search: async (term, { scope }) => {
      let sel = supabase
        .from("document_templates")
        .select("id, name, doc_type, location_id, is_active")
        .eq("is_active", true);
      if (scope.locationId) sel = sel.eq("location_id", scope.locationId);
      if (term) sel = sel.ilike("name", `%${term}%`);
      const { data, error } = await sel.order("name").limit(25);
      if (error) throw error;
      return (data ?? []).map((t) => ({
        id: t.id,
        label: t.name,
        sublabel: String(t.doc_type ?? ""),
      }));
    },
    canCreate: () => false,
    cannotCreateHint: () =>
      "No matching template. Templates are written under Admin → Documents — ask an admin.",
  },

  location: {
    noun: "office",
    fieldLabel: "Office",
    placeholder: "Choose an office…",
    search: async (term, { app }) =>
      app.visibleLocations
        .filter((l) => !term || `${l.code} ${l.name}`.toLowerCase().includes(term.toLowerCase()))
        .map((l) => ({ id: l.id, label: `${l.code} · ${l.name}` })),
    canCreate: () => false,
    cannotCreateHint: () => "No matching office. Ask an admin to add it.",
  },
};

export type EntityKind =
  "equipment" | "gift_item" | "option_value" | "user" | "document_template" | "location";
