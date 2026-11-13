import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { OptionListRow, OptionValue } from "@/lib/option-lists";

export const Route = createFileRoute("/_authenticated/admin/option-lists")({
  head: () => ({
    meta: [
      { title: "Dropdown options — Recovery Hub" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: OptionListsAdmin,
});

const SCOPES = ["daily", "monthly", "yearly", "global"] as const;

/* Spelled out, not derived. Stripping "ly" turns daily into "Every dai". */
const SCOPE_LABEL: Record<(typeof SCOPES)[number], string> = {
  daily: "Every day",
  monthly: "Every month",
  yearly: "Every year",
  global: "Never (continuous)",
};

function JobNumberCard() {
  const app = useAppContext();
  const qc = useQueryClient();
  const settingsQ = useQuery({
    queryKey: ["job-number-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("job_number_settings")
        .select("prefix, pattern, seq_padding, seq_scope")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const [draft, setDraft] = useState<{
    prefix: string;
    pattern: string;
    seq_padding: number;
    seq_scope: string;
  } | null>(null);
  const s = draft ??
    settingsQ.data ?? {
      prefix: "",
      pattern: "{YY}{MM}{DD}{SEQ}",
      seq_padding: 1,
      seq_scope: "daily",
    };

  const preview = useMemo(() => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return (
      s.prefix +
      s.pattern
        .replace("{YYYY}", String(d.getFullYear()))
        .replace("{YY}", String(d.getFullYear()).slice(2))
        .replace("{MM}", p2(d.getMonth() + 1))
        .replace("{DD}", p2(d.getDate()))
        .replace("{SEQ}", String(4).padStart(s.seq_padding, "0"))
    );
  }, [s]);

  const save = async () => {
    const { error } = await supabase
      .from("job_number_settings")
      .update({
        prefix: s.prefix,
        pattern: s.pattern,
        seq_padding: s.seq_padding,
        seq_scope: s.seq_scope,
        updated_by: app.userId,
      })
      .eq("id", true);
    if (error) {
      toastDbError(error, { action: "Saving job number format" });
      return;
    }
    toast.success("Job number format saved");
    qc.invalidateQueries({ queryKey: ["job-number-settings"] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Job number format</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Tokens: <code>{"{YY}"}</code> <code>{"{YYYY}"}</code> <code>{"{MM}"}</code>{" "}
          <code>{"{DD}"}</code> <code>{"{SEQ}"}</code>. Numbers are unique and cannot be changed
          once a job is created.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="grid gap-1.5">
            <Label>Prefix</Label>
            <Input
              className="h-9"
              value={s.prefix}
              onChange={(e) => setDraft({ ...s, prefix: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Pattern</Label>
            <Input
              className="h-9 font-mono"
              value={s.pattern}
              onChange={(e) => setDraft({ ...s, pattern: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Counter digits</Label>
            <Input
              className="h-9"
              type="number"
              min={1}
              max={8}
              value={s.seq_padding}
              onChange={(e) => setDraft({ ...s, seq_padding: Number(e.target.value) || 1 })}
            />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Counter resets</Label>
            <Select value={s.seq_scope} onValueChange={(v) => setDraft({ ...s, seq_scope: v })}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCOPES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {SCOPE_LABEL[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Next job looks like</Label>
            <div className="flex h-9 items-center rounded-md border px-3 font-mono text-sm">
              {preview}
            </div>
          </div>
        </div>
        <Button size="sm" onClick={save} disabled={app.writesDisabled}>
          Save format
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Free text is the escape hatch, not the destination — surface every carrier a
 * rep typed by hand so an admin can promote it to a proper reference account.
 */
function UnlinkedCarriersCard() {
  const q = useQuery({
    queryKey: ["unlinked-carrier-names"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("unlinked_carrier_names");
      if (error) throw error;
      return (data ?? []) as { carrier_name: string; job_count: number }[];
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Carriers typed by hand</CardTitle>
        <p className="text-xs text-muted-foreground">
          Jobs whose insurance company isn't linked to a CRM record. Add them as an insurance
          carrier account and the next job picks them from the list.
        </p>
      </CardHeader>
      <CardContent>
        {q.isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {q.error && (
          <p className="text-xs text-muted-foreground">Couldn't load the free-text carriers.</p>
        )}
        {!q.isLoading && !q.error && (q.data?.length ?? 0) === 0 && (
          <p className="text-xs text-muted-foreground">
            Nothing outstanding — every job's carrier is a linked record.
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {(q.data ?? []).map((r) => (
            <Badge key={r.carrier_name} variant="outline" className="font-normal">
              {r.carrier_name}
              <span className="ml-1 text-muted-foreground">· {r.job_count}</span>
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * What people are typing into "Please specify".
 *
 * Free text is a holding pen, not a home: anything that keeps coming back
 * should become a real option so it can be reported on. This lists the most
 * common entries per list so an admin can promote them.
 */
function OtherDetailsCard() {
  const q = useQuery({
    queryKey: ["option-other-details"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("option_other_details")
        .select("list_key, detail, uses, last_used")
        .order("uses", { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as {
        list_key: string;
        detail: string;
        uses: number;
        last_used: string | null;
      }[];
    },
  });
  const rows = q.data ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">“Other” free text</CardTitle>
        <p className="text-xs text-muted-foreground">
          What users typed after picking a value that asks them to specify. Frequent entries belong
          in the list above as real options.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {rows.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">Nothing specified yet.</div>
        ) : (
          <div className="divide-y">
            {rows.map((r, i) => (
              <div
                key={`${r.list_key}-${i}`}
                className="flex items-center gap-2 px-3 py-1.5 text-[13px]"
              >
                <Badge variant="outline" className="shrink-0 font-normal">
                  {r.list_key}
                </Badge>
                <span className="flex-1 truncate">{r.detail}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{r.uses}×</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function OptionListsAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [newKey, setNewKey] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newLocation, setNewLocation] = useState<string>("global");

  const listsQ = useQuery({
    queryKey: ["option-lists"],
    queryFn: async (): Promise<OptionListRow[]> => {
      const { data, error } = await supabase
        .from("option_lists")
        .select("id, key, label, description, backed_by_enum, allow_location_scope")
        .order("label");
      if (error) throw error;
      return (data ?? []) as OptionListRow[];
    },
  });

  const lists = listsQ.data ?? [];
  const active = lists.find((l) => l.id === selected) ?? lists[0] ?? null;

  const valuesQ = useQuery({
    queryKey: ["option-list-values", active?.id],
    enabled: !!active?.id,
    queryFn: async (): Promise<OptionValue[]> => {
      const { data, error } = await supabase
        .from("option_list_values")
        .select("id, key, label, sort_order, active, is_default, requires_detail, location_id")
        .eq("list_id", active!.id)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as OptionValue[];
    },
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["option-list-values", active?.id] });
    qc.invalidateQueries({ queryKey: ["option-list"] });
  };

  const patch = async (id: string, patchValues: Partial<OptionValue>) => {
    const { error } = await supabase
      .from("option_list_values")
      .update(patchValues as never)
      .eq("id", id);
    if (error) {
      toastDbError(error, { action: "Updating option" });
      return;
    }
    invalidate();
  };

  const addValue = async () => {
    if (!active || !newLabel.trim()) return;
    const key = (
      newKey.trim() ||
      newLabel
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
    ).slice(0, 64);
    const maxSort = Math.max(0, ...(valuesQ.data ?? []).map((v) => v.sort_order));
    const { error } = await supabase.from("option_list_values").insert({
      list_id: active.id,
      key,
      label: newLabel.trim(),
      sort_order: maxSort + 10,
      location_id: newLocation === "global" ? null : newLocation,
    });
    if (error) {
      toastDbError(error, { action: "Adding option" });
      return;
    }
    toast.success("Option added");
    setNewKey("");
    setNewLabel("");
    invalidate();
  };

  const removeValue = async (id: string) => {
    const { error } = await supabase.from("option_list_values").delete().eq("id", id);
    if (error) {
      toastDbError(error, { action: "Deleting option" });
      return;
    }
    invalidate();
  };

  return (
    <div className="space-y-3">
      <JobNumberCard />
      <UnlinkedCarriersCard />
      <OtherDetailsCard />

      <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Lists</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {lists.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setSelected(l.id)}
                className={cn(
                  "block w-full border-b px-3 py-2 text-left text-[13px] last:border-b-0 hover:bg-accent",
                  active?.id === l.id && "bg-accent font-medium",
                )}
              >
                {l.label}
              </button>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {active?.label ?? "Options"}
              {active?.backed_by_enum && (
                <Badge variant="secondary" className="ml-2 font-normal">
                  labels & order only
                </Badge>
              )}
            </CardTitle>
            {active?.description && (
              <p className="text-xs text-muted-foreground">{active.description}</p>
            )}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border">
              {(valuesQ.data ?? []).map((v) => (
                <div key={v.id} className="flex items-center gap-2 border-b p-2 last:border-b-0">
                  <Input
                    className="h-8 w-16"
                    type="number"
                    value={v.sort_order}
                    onChange={(e) => patch(v.id, { sort_order: Number(e.target.value) || 0 })}
                    disabled={app.writesDisabled}
                  />
                  <Input
                    className="h-8 flex-1"
                    value={v.label}
                    onChange={(e) => patch(v.id, { label: e.target.value })}
                    disabled={app.writesDisabled}
                  />
                  <code className="hidden w-40 shrink-0 truncate text-xs text-muted-foreground sm:block">
                    {v.key}
                  </code>
                  {v.location_id && (
                    <Badge variant="outline" className="shrink-0">
                      office
                    </Badge>
                  )}
                  <label
                    className="hidden shrink-0 items-center gap-1 text-[11px] text-muted-foreground md:flex"
                    title="Reveal a “Please specify” box when this value is chosen"
                  >
                    specify
                    <Switch
                      checked={v.requires_detail}
                      onCheckedChange={(c) => patch(v.id, { requires_detail: c })}
                      disabled={app.writesDisabled}
                    />
                  </label>
                  <Switch
                    checked={v.active}
                    onCheckedChange={(c) => patch(v.id, { active: c })}
                    disabled={app.writesDisabled}
                  />
                  {!active?.backed_by_enum && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => removeValue(v.id)}
                      disabled={app.writesDisabled}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              ))}
              {(valuesQ.data ?? []).length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">No options yet.</div>
              )}
            </div>

            <div className="grid gap-2 rounded-md border p-2 sm:grid-cols-4">
              <Input
                className="h-9"
                placeholder="Label shown to users"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
              />
              <Input
                className="h-9"
                placeholder="Stored key (optional)"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
              {active?.allow_location_scope ? (
                <Select value={newLocation} onValueChange={setNewLocation}>
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">All offices</SelectItem>
                    {app.visibleLocations.map((l) => (
                      <SelectItem key={l.id} value={l.id}>
                        {l.code} · {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <div className="flex h-9 items-center text-xs text-muted-foreground">
                  All offices
                </div>
              )}
              <Button
                size="sm"
                className="h-9"
                onClick={addValue}
                disabled={app.writesDisabled || !newLabel.trim() || !!active?.backed_by_enum}
              >
                <Plus className="mr-1 size-3.5" /> Add option
              </Button>
            </div>
            {active?.backed_by_enum && (
              <p className="text-xs text-muted-foreground">
                This list mirrors a database type, so values can't be added or removed here — but
                labels, ordering and which ones users see are yours to control.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
