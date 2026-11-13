import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_LABELS, isSalesLeadership, type AppRole } from "@/lib/roles";

/**
 * Job field visibility, lifted out of its own route so it can sit as a tab
 * beside page and capability access.
 *
 * It stays a distinct tab rather than being merged into the page list because
 * it is a different kind of control with a different audience: it masks fields
 * inside the job payload (enforced when the job is fetched, not just hidden),
 * and sales leadership configure it without being administrators.
 */
type PermRow = {
  id: string;
  entity: string;
  field: string;
  role: AppRole;
  visible: boolean;
};

/** Roles worth configuring. Owner/admin/dev always see everything. */
const CONFIGURABLE_ROLES: AppRole[] = [
  "sales_person",
  "outside_sales_rep",
  "cold_caller",
  "field_chaser",
  "crew",
  "location_manager",
  "regional",
  "sales_head",
];

export function FieldPermissionsPanel() {
  const app = useAppContext();
  const allowed = isSalesLeadership(app.roles);
  const [rows, setRows] = useState<PermRow[]>([]);
  const [role, setRole] = useState<AppRole>("sales_person");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingField, setSavingField] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("field_permissions")
        .select("id,entity,field,role,visible")
        .eq("entity", "job")
        .order("field");
      if (cancelled) return;
      if (error) toast.error("Could not load field permissions", { description: error.message });
      setRows((data ?? []) as PermRow[]);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  const forRole = useMemo(
    () =>
      rows
        .filter((r) => r.role === role)
        .filter((r) => (q ? r.field.toLowerCase().includes(q.toLowerCase()) : true))
        .sort((a, b) => a.field.localeCompare(b.field)),
    [rows, role, q],
  );

  const hiddenCount = rows.filter((r) => r.role === role && !r.visible).length;

  const toggle = async (row: PermRow, next: boolean) => {
    if (app.writesDisabled) {
      toast.error("Writes are disabled while View As is active.");
      return;
    }
    setSavingField(row.id);
    const { error } = await supabase
      .from("field_permissions")
      .update({ visible: next, updated_by: app.userId, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    setSavingField(null);
    if (error) {
      toast.error("Could not save", { description: error.message });
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, visible: next } : r)));
  };

  const bulk = async (next: boolean) => {
    if (app.writesDisabled) return;
    const ids = forRole.map((r) => r.id);
    if (ids.length === 0) return;
    const { error } = await supabase
      .from("field_permissions")
      .update({ visible: next, updated_by: app.userId, updated_at: new Date().toISOString() })
      .in("id", ids);
    if (error) {
      toast.error("Could not save", { description: error.message });
      return;
    }
    setRows((prev) => prev.map((r) => (ids.includes(r.id) ? { ...r, visible: next } : r)));
    toast.success(next ? "All shown fields enabled" : "All shown fields hidden");
  };

  if (!allowed) {
    return (
      <div className="mx-auto max-w-lg text-sm">
        <Card>
          <CardContent className="p-4">
            <strong className="font-semibold">Sales Head and Owner only.</strong>
            <p className="mt-1 text-muted-foreground">
              Field visibility decides what every rep can read. Only sales leadership configures it.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5 text-base">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            Job field visibility
          </CardTitle>
          <CardDescription>
            Row-level access decides which jobs a person can open. This decides which fields they
            can read once they do. It is enforced when the job is fetched, so hiding a field here
            removes it from the response — not just from the screen.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={role} onValueChange={(v) => setRole(v as AppRole)}>
              <SelectTrigger className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CONFIGURABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find a field"
                className="w-[220px] pl-7"
              />
            </div>
            <span className="text-[12px] text-muted-foreground">
              {hiddenCount} hidden for {ROLE_LABELS[role]}
            </span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => bulk(true)}>
                <Eye className="mr-1.5 h-3.5 w-3.5" /> Show all
              </Button>
              <Button size="sm" variant="outline" onClick={() => bulk(false)}>
                <EyeOff className="mr-1.5 h-3.5 w-3.5" /> Hide all
              </Button>
            </div>
          </div>

          <div className="rounded-md border">
            {loading ? (
              <div className="px-3 py-4 text-sm text-muted-foreground">Loading…</div>
            ) : forRole.length === 0 ? (
              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                No fields match that search.
              </div>
            ) : (
              forRole.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 border-b px-3 py-1.5 text-[13px] last:border-b-0"
                >
                  <span className="font-mono text-[12px]">{r.field}</span>
                  <span className="ml-auto text-[11px] text-muted-foreground">
                    {r.visible ? "Visible" : "Hidden"}
                  </span>
                  <Switch
                    checked={r.visible}
                    disabled={savingField === r.id || app.writesDisabled}
                    onCheckedChange={(v) => toggle(r, v)}
                  />
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
