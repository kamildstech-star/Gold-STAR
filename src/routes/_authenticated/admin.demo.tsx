import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AlertTriangle, Database, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isPrivileged } from "@/lib/roles";
import { fetchDemoCounts, purgeDemoData, seedDemoData } from "@/lib/demo-data";

export const Route = createFileRoute("/_authenticated/admin/demo")({
  head: () => ({
    meta: [
      { title: "Demo data — Recovery Hub" },
      {
        name: "description",
        content:
          "Seed or remove demonstration records. Removal is a single action and never touches real data.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DemoDataAdmin,
});

function DemoDataAdmin() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState("");

  const countsQ = useQuery({ queryKey: ["demo-counts"], queryFn: fetchDemoCounts });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["demo-counts"] });
    qc.invalidateQueries({ queryKey: ["demo-total"] });
  };

  const seed = useMutation({
    mutationFn: seedDemoData,
    onSuccess: (rows) => {
      const total = rows.reduce((s, r) => s + r.row_count, 0);
      toast.success(total > 0 ? `Seeded ${total} demo rows` : "Demo data already present");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const purge = useMutation({
    mutationFn: purgeDemoData,
    onSuccess: (rows) => {
      const total = rows.reduce((s, r) => s + r.row_count, 0);
      toast.success(`Removed ${total} demo rows`);
      setConfirm(false);
      setTyped("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const total = (countsQ.data ?? []).reduce((s, r) => s + r.row_count, 0);
  // The role may seed and remove; previewing another role (View As) shows the
  // buttons switched off, with the preview's reason.
  const allowed = isPrivileged(app.roles);
  const previewing = app.isImpersonating;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Every demo row is flagged, so removal is one action — real accounts, jobs, users, locations
        and the imported fire leads are never touched.
      </p>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <div className="mr-auto">
            <div className="text-[22px] font-semibold tabular-nums">
              {countsQ.isLoading ? "—" : total.toLocaleString("en-US")}
            </div>
            <div className="label-caps text-muted-foreground">Demo rows present</div>
          </div>
          {allowed && (
            <Button
              variant="outline"
              disabled={previewing || seed.isPending}
              onClick={() => seed.mutate()}
            >
              {seed.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Database className="mr-2 size-4" />
              )}
              Seed demo data
            </Button>
          )}
          {allowed && (
            <Button
              variant="destructive"
              disabled={previewing || total === 0 || purge.isPending}
              onClick={() => setConfirm(true)}
            >
              <Trash2 className="mr-2 size-4" /> Remove all demo data
            </Button>
          )}
        </CardContent>
      </Card>

      {allowed && previewing && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>Writes are disabled while previewing another role.</span>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Table</th>
                  <th className="px-3 py-2 text-right font-medium">Demo rows</th>
                </tr>
              </thead>
              <tbody>
                {countsQ.isLoading ? (
                  <tr>
                    <td colSpan={2} className="p-3 text-center text-muted-foreground">
                      Loading…
                    </td>
                  </tr>
                ) : total === 0 ? (
                  <tr>
                    <td colSpan={2} className="p-3 text-center text-muted-foreground">
                      No demo data present.
                    </td>
                  </tr>
                ) : (
                  (countsQ.data ?? []).map((r) => (
                    <tr key={r.table_name} className="border-t">
                      <td className="px-3 py-1.5 font-mono text-xs">{r.table_name}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {r.row_count.toLocaleString("en-US")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={confirm}
        onOpenChange={(v) => {
          setConfirm(v);
          if (!v) setTyped("");
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove all demo data?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              This deletes {total.toLocaleString("en-US")} flagged rows across the app. It cannot be
              undone. Records created by real users are not affected.
            </p>
            <div className="space-y-1">
              <Label>
                Type <span className="font-mono">REMOVE</span> to confirm
              </Label>
              <Input value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={typed !== "REMOVE" || purge.isPending}
              onClick={() => purge.mutate()}
            >
              {purge.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Remove demo data
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
