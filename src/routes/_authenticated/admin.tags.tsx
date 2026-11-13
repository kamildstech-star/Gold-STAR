import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { GripVertical, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LabelPill } from "@/components/label-pill";
import { useAppContext } from "@/components/app-context";
import { isPrivileged } from "@/lib/roles";
import {
  LABEL_COLORS,
  fetchLabelCreationSetting,
  setLabelCreationSetting,
  type Label,
  type LabelScope,
} from "@/lib/labels";

const SCOPES: LabelScope[] = [
  "lead",
  "opportunity",
  "account",
  "contact",
  "job",
  "photo",
  "project",
];

export const Route = createFileRoute("/_authenticated/admin/tags")({
  component: LabelsAdmin,
});

function LabelsAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const admin = isPrivileged(app.roles);
  const [order, setOrder] = useState<Label[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(LABEL_COLORS[0]);
  const [newScopes, setNewScopes] = useState<LabelScope[]>(["lead"]);

  const labelsQ = useQuery({
    queryKey: ["admin-labels"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tags")
        .select("id, name, color, scopes, sort_order, archived_at")
        .order("sort_order")
        .order("name");
      if (error) throw error;
      return (data ?? []) as unknown as Label[];
    },
  });

  useEffect(() => {
    if (labelsQ.data) setOrder(labelsQ.data);
  }, [labelsQ.data]);

  const settingQ = useQuery({ queryKey: ["label-setting"], queryFn: fetchLabelCreationSetting });

  const saveSetting = useMutation({
    mutationFn: (v: "everyone" | "privileged") => setLabelCreationSetting(v),
    onSuccess: () => {
      toast.success("Label permission updated");
      qc.invalidateQueries({ queryKey: ["label-setting"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("tags").insert({
        name: newName.trim(),
        color: newColor,
        scopes: newScopes,
        sort_order: order.length,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Label created");
      setNewName("");
      qc.invalidateQueries({ queryKey: ["admin-labels"] });
      qc.invalidateQueries({ queryKey: ["labels"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const patch = useMutation({
    mutationFn: async ({ id, values }: { id: string; values: Record<string, unknown> }) => {
      const { error } = await supabase
        .from("tags")
        .update(values as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-labels"] });
      qc.invalidateQueries({ queryKey: ["labels"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("tags").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Label deleted");
      qc.invalidateQueries({ queryKey: ["admin-labels"] });
      qc.invalidateQueries({ queryKey: ["labels"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const persistOrder = async (list: Label[]) => {
    await Promise.all(
      list.map((l, i) =>
        l.sort_order === i
          ? Promise.resolve()
          : supabase.from("tags").update({ sort_order: i }).eq("id", l.id),
      ),
    );
    qc.invalidateQueries({ queryKey: ["admin-labels"] });
    qc.invalidateQueries({ queryKey: ["labels"] });
  };

  const handleDrop = (target: number) => {
    if (dragIndex === null || dragIndex === target) return;
    const next = [...order];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(target, 0, moved);
    setOrder(next);
    setDragIndex(null);
    void persistOrder(next);
  };

  return (
    <div className="grid gap-3 md:grid-cols-[300px_1fr]">
      <div className="space-y-3">
        <Card>
          <CardContent className="space-y-2 p-3">
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-wide">
              Who can create labels
            </h2>
            {admin ? (
              <>
                <Select
                  value={settingQ.data ?? "privileged"}
                  onValueChange={(v) => saveSetting.mutate(v as "everyone" | "privileged")}
                >
                  <SelectTrigger className="h-8 text-[12.5px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="privileged">Managers and admins only</SelectItem>
                    <SelectItem value="everyone">Everyone</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  Uncontrolled label creation across 11 offices gets messy fast — keep this
                  restricted unless a team needs to move quickly.
                </p>
              </>
            ) : settingQ.data ? (
              <p className="text-[12.5px]" data-label-setting>
                {settingQ.data === "everyone" ? "Everyone" : "Managers and admins only"}
              </p>
            ) : null}
          </CardContent>
        </Card>

        {admin && (
          <Card>
            <CardContent className="space-y-2 p-3">
              <h2 className="font-display text-[13px] font-semibold uppercase tracking-wide">
                New label
              </h2>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Label name"
                className="h-8 text-[12.5px]"
              />
              <div className="flex flex-wrap gap-1">
                {LABEL_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewColor(c)}
                    className={`size-5 rounded-md border ${newColor === c ? "ring-2 ring-primary ring-offset-1" : "border-black/10"}`}
                    style={{ backgroundColor: c }}
                    aria-label={c}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-1">
                {SCOPES.map((s) => {
                  const on = newScopes.includes(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() =>
                        setNewScopes(on ? newScopes.filter((x) => x !== s) : [...newScopes, s])
                      }
                      className={`rounded-md border px-1.5 py-0.5 text-[11px] ${
                        on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"
                      }`}
                    >
                      {s}
                    </button>
                  );
                })}
              </div>
              <Button
                size="sm"
                className="h-8 w-full text-[12px]"
                disabled={!newName.trim() || newScopes.length === 0 || create.isPending}
                onClick={() => create.mutate()}
              >
                Add label
              </Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="border-b px-3 py-2">
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-wide">
              Labels ({order.length})
            </h2>
            {admin && (
              <p className="text-[11px] text-muted-foreground">
                Drag to reorder. Order is used everywhere.
              </p>
            )}
          </div>
          <ul className="divide-y">
            {order.map((l, i) => (
              <li
                key={l.id}
                draggable={admin}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(i)}
                className="group flex items-center gap-2 px-3 py-1.5"
              >
                {admin && (
                  <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/40" />
                )}
                {editing === l.id ? (
                  <InlineEdit
                    label={l}
                    onCancel={() => setEditing(null)}
                    onSave={(values) => {
                      patch.mutate({ id: l.id, values });
                      setEditing(null);
                    }}
                  />
                ) : (
                  <>
                    <LabelPill label={l} />
                    <div className="flex flex-1 flex-wrap gap-1">
                      {(l.scopes ?? []).map((s) => (
                        <Badge key={s} variant="outline" className="text-[10px]">
                          {s}
                        </Badge>
                      ))}
                    </div>
                    {admin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="size-7 p-0 opacity-0 group-hover:opacity-100"
                        aria-label={`Edit ${l.name}`}
                        onClick={() => setEditing(l.id)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                    )}
                    {admin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="size-7 p-0 opacity-0 group-hover:opacity-100"
                        aria-label={`Remove ${l.name}`}
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(l.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </>
                )}
              </li>
            ))}
            {order.length === 0 && (
              <li className="px-3 py-4 text-[12.5px] text-muted-foreground">No labels yet.</li>
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function InlineEdit({
  label,
  onSave,
  onCancel,
}: {
  label: Label;
  onSave: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  const [scopes, setScopes] = useState<LabelScope[]>(label.scopes ?? ["lead"]);

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1.5">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="h-7 w-[180px] text-[12px]"
      />
      <div className="flex gap-1">
        {LABEL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={`size-4 rounded-md border ${color === c ? "ring-2 ring-primary ring-offset-1" : "border-black/10"}`}
            style={{ backgroundColor: c }}
            aria-label={c}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {SCOPES.map((s) => {
          const on = scopes.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => setScopes(on ? scopes.filter((x) => x !== s) : [...scopes, s])}
              className={`rounded-md border px-1.5 py-0.5 text-[10px] ${
                on ? "border-primary bg-primary/10 text-primary" : "text-muted-foreground"
              }`}
            >
              {s}
            </button>
          );
        })}
      </div>
      <Button
        size="sm"
        className="h-7 text-[12px]"
        onClick={() => onSave({ name: name.trim(), color, scopes })}
      >
        Save
      </Button>
      <Button size="sm" variant="ghost" className="h-7 text-[12px]" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
