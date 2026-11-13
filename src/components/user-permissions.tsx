import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  ShieldX,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppContext } from "@/components/app-context";
import { ROLE_LABELS } from "@/lib/roles";
import { isPagePermissionKey } from "@/lib/page-access";
import { ACCESS_HISTORY_KEY } from "@/lib/page-access-admin";
import {
  clearPermissionOverride,
  fetchEffectivePermissions,
  grantPermission,
  type EffectivePermission,
} from "@/lib/permissions";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Effective capabilities for one person, each labelled with why they have it.
 * "from sales_person" versus "granted by Mark, 11 Aug" — the source is the
 * point of the panel; a capability with no visible reason is a support ticket.
 */
export function UserPermissionsSection({
  userId,
  readOnly,
  onChange,
}: {
  userId: string;
  readOnly?: boolean;
  onChange?: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<EffectivePermission | null>(null);
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const q = useQuery({
    queryKey: ["user-permissions", userId],
    queryFn: () => fetchEffectivePermissions(userId),
  });

  const namesQ = useQuery({
    queryKey: ["permission-granters", userId],
    enabled: (q.data ?? []).some((p) => p.granted_by),
    queryFn: async () => {
      const ids = [...new Set((q.data ?? []).map((p) => p.granted_by).filter(Boolean))];
      if (ids.length === 0) return {} as Record<string, string>;
      const { supabase } = await import("@/integrations/supabase/client");
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", ids as string[]);
      return Object.fromEntries(
        (data ?? []).map((p) => [p.user_id, p.full_name ?? "someone"]),
      ) as Record<string, string>;
    },
  });

  const bump = () => {
    qc.invalidateQueries({ queryKey: ["user-permissions", userId] });
    qc.invalidateQueries({ queryKey: ["my-permissions"] });
    qc.invalidateQueries({ queryKey: ["person-access", userId] });
    qc.invalidateQueries({ queryKey: [ACCESS_HISTORY_KEY] });
    onChange?.();
  };

  const clear = useMutation({
    mutationFn: (id: string) => clearPermissionOverride(id),
    onSuccess: () => {
      toast.success("Override removed");
      bump();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const needle = search.trim().toLowerCase();

  const grouped = useMemo(() => {
    const g = new Map<string, EffectivePermission[]>();
    for (const p of q.data ?? []) {
      // Page access has its own screen (Settings -> Access -> People), where a
      // page can be shown with the area it belongs to. Listing seventy page
      // rows here would bury the dozen capabilities this panel is for.
      if (isPagePermissionKey(p.permission_key)) continue;
      if (
        needle &&
        !p.label.toLowerCase().includes(needle) &&
        !p.permission_key.toLowerCase().includes(needle)
      )
        continue;
      const arr = g.get(p.perm_group) ?? [];
      arr.push(p);
      g.set(p.perm_group, arr);
    }
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [q.data, needle]);

  /**
   * Collapsed by default — the list is long. A group opens on its own when it
   * carries something worth seeing: an explicit grant or revoke. Searching
   * opens everything, since a hidden match reads as "no results".
   */
  const autoOpen = useMemo(() => {
    const s = new Set<string>();
    for (const [group, items] of grouped) {
      if (items.some((p) => p.source === "granted" || p.source === "revoked")) s.add(group);
    }
    return s;
  }, [grouped]);

  function isOpen(group: string) {
    if (needle) return true;
    return open[group] ?? autoOpen.has(group);
  }

  function sourceLine(p: EffectivePermission): string {
    if (p.source === "role")
      return `from ${p.source_role ? (ROLE_LABELS[p.source_role] ?? p.source_role) : "role"}`;
    if (p.source === "granted" || p.source === "revoked") {
      const who = p.granted_by ? (namesQ.data?.[p.granted_by] ?? "an admin") : "an admin";
      const when = p.expires_at
        ? ` · expires ${new Date(p.expires_at).toLocaleDateString(DATE_LOCALE, US_DATE)}`
        : "";
      const scope = p.location_id
        ? ` · ${app.allLocations.find((l) => l.id === p.location_id)?.code ?? "location"}`
        : p.region_id
          ? ` · ${app.regions.find((r) => r.id === p.region_id)?.name ?? "region"}`
          : "";
      return `${p.source === "granted" ? "granted" : "revoked"} by ${who}${scope}${when}`;
    }
    return "not granted";
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Permissions</h3>
        <div className="relative w-52">
          <Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" />
          <Input
            className="h-8 pl-7 text-xs"
            placeholder="Search capabilities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      {q.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : grouped.length === 0 ? (
        <p className="text-xs text-muted-foreground">No capability matches that search.</p>
      ) : (
        <div className="space-y-2">
          {grouped.map(([group, items]) => {
            const opened = isOpen(group);
            const granted = items.filter((p) => p.allowed).length;
            return (
              <div key={group} className="rounded-sm border">
                <button
                  type="button"
                  onClick={() => setOpen((o) => ({ ...o, [group]: !opened }))}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent/40"
                >
                  {opened ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  <span className="flex-1">{group}</span>
                  <span className="font-mono normal-case">
                    {granted}/{items.length}
                  </span>
                </button>
                {opened && (
                  <ul className="divide-y border-t">
                    {items.map((p) => (
                      <li
                        key={p.permission_key}
                        className="flex items-center gap-2 px-2 py-1.5 text-xs"
                      >
                        {p.allowed ? (
                          <Check className="size-3.5 shrink-0 text-emerald-700 dark:text-emerald-400" />
                        ) : (
                          <Minus className="size-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{p.label}</div>
                          <div className="truncate text-[11px] text-muted-foreground">
                            {sourceLine(p)}
                          </div>
                        </div>
                        {p.source === "granted" && (
                          <Badge variant="secondary" className="gap-1">
                            <ShieldCheck className="size-3" /> Grant
                          </Badge>
                        )}
                        {p.source === "revoked" && (
                          <Badge variant="destructive" className="gap-1">
                            <ShieldX className="size-3" /> Revoke
                          </Badge>
                        )}
                        {p.expires_at && <Clock className="size-3 text-muted-foreground" />}
                        {!readOnly && (
                          <div className="flex shrink-0 gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5"
                              onClick={() => setEditing(p)}
                            >
                              <Plus className="size-3.5" />
                            </Button>
                            {p.override_id && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 px-1.5"
                                disabled={clear.isPending}
                                onClick={() => clear.mutate(p.override_id!)}
                              >
                                <X className="size-3.5" />
                              </Button>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <OverrideDialog
          permission={editing}
          userId={userId}
          onClose={() => setEditing(null)}
          onSaved={bump}
        />
      )}
    </section>
  );
}

function OverrideDialog({
  permission,
  userId,
  onClose,
  onSaved,
}: {
  permission: EffectivePermission;
  userId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const [effect, setEffect] = useState<"grant" | "revoke">(permission.allowed ? "revoke" : "grant");
  const [scope, setScope] = useState<string>(
    permission.location_id
      ? `loc:${permission.location_id}`
      : permission.region_id
        ? `reg:${permission.region_id}`
        : "all",
  );
  const [expires, setExpires] = useState<string>(
    permission.expires_at ? permission.expires_at.slice(0, 10) : "",
  );
  const [reason, setReason] = useState<string>(permission.reason ?? "");

  const save = useMutation({
    mutationFn: () =>
      grantPermission({
        userId,
        key: permission.permission_key,
        effect,
        locationId: scope.startsWith("loc:") ? scope.slice(4) : null,
        regionId: scope.startsWith("reg:") ? scope.slice(4) : null,
        expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null,
        reason: reason.trim() || null,
      }),
    onSuccess: () => {
      toast.success(effect === "grant" ? "Capability granted" : "Capability revoked");
      onSaved();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{permission.label}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Effect</label>
            <Select value={effect} onValueChange={(v) => setEffect(v as "grant" | "revoke")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="grant">Grant</SelectItem>
                <SelectItem value="revoke">Revoke</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Scope</label>
            <Select value={scope} onValueChange={setScope}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everywhere</SelectItem>
                {app.allLocations.map((l) => (
                  <SelectItem key={l.id} value={`loc:${l.id}`}>
                    {l.code} — {l.name}
                  </SelectItem>
                ))}
                {app.regions.map((r) => (
                  <SelectItem key={r.id} value={`reg:${r.id}`}>
                    Region: {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Expires (optional)</label>
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Reason</label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why this person needs it"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
