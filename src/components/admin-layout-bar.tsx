import { useEffect, useState } from "react";
import { Eye, History, Loader2, Send, Users } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DASHBOARD_ROLE_KEYS, type LayoutEntry } from "@/lib/dashboard-cards";
import { ROLE_LABELS, type AppRole, type DashboardKey } from "@/lib/roles";
import {
  ALL_ROLES,
  countLayoutOverrides,
  loadLayoutEvents,
  publishOrgDefault,
  resetLayoutOverrides,
  type LayoutEvent,
  type LayoutScope,
} from "@/lib/org-layouts";

/**
 * Admin-only "set the layout for everyone" bar.
 *
 * The grid above is already previewing the selected role, so what the admin
 * sees here is exactly what that role gets. Publishing writes the org default;
 * it never touches anyone's personal layout unless the admin explicitly asks
 * to reset everyone, which is confirmed with the number of people affected.
 */

export function roleLabel(key: string): string {
  if (key === ALL_ROLES) return "All roles";
  return ROLE_LABELS[key as AppRole] ?? key;
}

export function AdminLayoutBar({
  adminRole,
  onRoleChange,
  onExit,
  activeRole,
  layout,
  userId,
}: {
  adminRole: string;
  onRoleChange: (role: string) => void;
  onExit: () => void;
  activeRole: DashboardKey;
  layout: LayoutEntry[];
  userId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ scope: LayoutScope; count: number } | null>(null);
  const [events, setEvents] = useState<LayoutEvent[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!historyOpen) return;
    loadLayoutEvents()
      .then(setEvents)
      .catch(() => setEvents([]));
  }, [historyOpen]);

  const publish = async (scope: LayoutScope, payload: unknown, label: string) => {
    setBusy(true);
    try {
      await publishOrgDefault(scope, adminRole, payload, userId);
      toast.success(`${label} published as the default for ${roleLabel(adminRole)}`);
    } catch {
      toast.error(`Could not publish the ${label.toLowerCase()}`);
    } finally {
      setBusy(false);
    }
  };

  const publishSidebar = async () => {
    const { data } = await supabase
      .from("user_view_prefs")
      .select("view_mode")
      .eq("user_id", userId)
      .eq("scope", "sidebar_order")
      .maybeSingle();
    if (!data?.view_mode) {
      toast.error("Rearrange your own sidebar first — there is nothing to publish yet.");
      return;
    }
    await publish("sidebar", JSON.parse(data.view_mode), "Sidebar order");
  };

  const publishSections = async () => {
    const { data } = await supabase
      .from("user_view_prefs")
      .select("view_mode")
      .eq("user_id", userId)
      .eq("scope", "hidden_sections")
      .maybeSingle();
    await publish(
      "sections",
      data?.view_mode ? JSON.parse(data.view_mode) : {},
      "Record page sections",
    );
  };

  const askReset = async (scope: LayoutScope) => {
    try {
      const count = await countLayoutOverrides(scope, adminRole);
      setConfirm({ scope, count });
    } catch {
      toast.error("Could not check how many people this affects");
    }
  };

  const doReset = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const n = await resetLayoutOverrides(confirm.scope, adminRole);
      toast.success(`Cleared personal layouts for ${n} ${n === 1 ? "person" : "people"}`);
    } catch {
      toast.error("Could not reset personal layouts");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <div className="rounded-md border border-dashed border-primary/50 bg-primary/5 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[13px] font-semibold">
          <Users className="h-3.5 w-3.5" aria-hidden />
          Set layout for everyone
        </span>

        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <Eye className="h-3.5 w-3.5" aria-hidden />
          Viewing as:
        </span>
        <Select value={adminRole} onValueChange={onRoleChange}>
          <SelectTrigger className="h-8 w-[13rem] text-[13px]" aria-label="Default layout role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_ROLES}>All roles</SelectItem>
            {DASHBOARD_ROLE_KEYS.map((r) => (
              <SelectItem key={r} value={r}>
                {roleLabel(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          disabled={busy}
          onClick={() => publish("dashboard", layout, "Dashboard layout")}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="mr-1 h-3.5 w-3.5" />
          )}
          Publish dashboard
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={publishSidebar}>
          Publish sidebar
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={publishSections}>
          Publish record sections
        </Button>

        <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="ghost" aria-label="Publish history">
              <History className="h-3.5 w-3.5" />
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Layout publish history</DialogTitle>
            </DialogHeader>
            <ul className="space-y-1 text-[13px]">
              {events.length === 0 && (
                <li className="text-muted-foreground">Nothing published yet.</li>
              )}
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap gap-1.5 border-b py-1.5">
                  <span className="font-medium">{e.actor_name ?? "Someone"}</span>
                  <span>
                    {e.action === "reset_all"
                      ? `reset ${e.affected_users ?? 0} personal ${e.scope} layouts`
                      : `published a ${e.scope} default`}
                  </span>
                  <span className="text-muted-foreground">for {roleLabel(e.role_key)}</span>
                  <span className="ml-auto text-muted-foreground">
                    {new Date(e.created_at).toLocaleString("en-US")}
                  </span>
                </li>
              ))}
            </ul>
          </DialogContent>
        </Dialog>

        <Button size="sm" variant="ghost" className="ml-auto" onClick={onExit}>
          Exit
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
        <span>
          Personal layouts still win. Previewing {roleLabel(adminRole)}
          {adminRole === ALL_ROLES ? ` (shown as ${roleLabel(activeRole)})` : ""}.
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[12px]"
          disabled={busy}
          onClick={() => askReset("dashboard")}
        >
          Reset everyone to this layout
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[12px]"
          disabled={busy}
          onClick={() => askReset("sidebar")}
        >
          Reset everyone's sidebar
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-[12px]"
          disabled={busy}
          onClick={() => askReset("sections")}
        >
          Reset everyone's record sections
        </Button>
      </div>

      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset everyone to the published default?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the personal{" "}
              {confirm?.scope === "dashboard"
                ? "dashboard layout"
                : confirm?.scope === "sidebar"
                  ? "sidebar order"
                  : "record page sections"}{" "}
              of{" "}
              <strong>
                {confirm?.count ?? 0} {confirm?.count === 1 ? "person" : "people"}
              </strong>{" "}
              in {roleLabel(adminRole)}. They will see the published default from their next load.
              Publish first if you have unsaved changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doReset}>Reset {confirm?.count ?? 0}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
