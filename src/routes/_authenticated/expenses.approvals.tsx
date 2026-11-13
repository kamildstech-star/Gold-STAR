import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Check, X } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import {
  EXPENSE_KINDS,
  EXPENSE_KIND_LABEL,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  decideRequest,
  listRequests,
  money,
} from "@/lib/expenses";
import { cn } from "@/lib/utils";
import { canApproveLeads } from "@/lib/approval";
import { useMyPermissions } from "@/lib/permissions";
import { PageHeader } from "@/components/ui-density";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn } from "@/lib/export-table";
import type { ExpenseRequest } from "@/lib/expenses";
import { optionsFrom, useManagedOptions } from "@/lib/managed-options";
import { FitText } from "@/components/ui/fit-text";
import { ReceiptsAwaitingPointer } from "@/components/supply-receipt-panel";

const EXPENSE_KIND_OPTS = optionsFrom(EXPENSE_KINDS, EXPENSE_KIND_LABEL);

type ApprovalRow = ExpenseRequest & { rep: string };

/** Kind labels come from the managed option list, so the sheet reads like the screen. */
function approvalColumns(kindLabel: (k: string) => string): ExportColumn<ApprovalRow>[] {
  return [
    { key: "requested_at", label: "Requested", get: (r) => r.requested_at, type: "datetime" },
    { key: "rep", label: "Rep", get: (r) => r.rep },
    { key: "amount", label: "Amount", get: (r) => r.amount, type: "money" },
    { key: "kind", label: "Type", get: (r) => kindLabel(r.kind) },
    { key: "merchant", label: "Where", get: (r) => r.merchant },
    { key: "purpose", label: "What for", get: (r) => r.purpose },
    { key: "status", label: "Status", get: (r) => REQUEST_STATUS_LABEL[r.status] ?? r.status },
    { key: "decision_note", label: "Note", get: (r) => r.decision_note },
    { key: "decided_at", label: "Decided", get: (r) => r.decided_at, type: "datetime" },
  ];
}

export const Route = createFileRoute("/_authenticated/expenses/approvals")({
  head: () => ({
    meta: [
      { title: "Spend approvals — Recovery Hub" },
      {
        name: "description",
        content:
          "One-tap approve or decline for rep spend above the threshold. Built for a phone — the rep is standing in a restaurant.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ApprovalsPage,
});

function ApprovalsPage() {
  const app = useAppContext();
  /*
   * A rep never approves their own entry. The sidebar hid this page from them,
   * which is not access control - typing the URL rendered the working Approve
   * button over their own pending request.
   */
  const permissions = useMyPermissions();
  const allowed = canApproveLeads(app.roles) && permissions.allowed.has("expenses.approve");
  const qc = useQueryClient();
  const [note, setNote] = useState<Record<string, string>>({});
  const kindLabel = useManagedOptions("expense_kind", EXPENSE_KIND_OPTS).label;

  const pendingQ = useQuery({
    queryKey: ["expense-approvals", app.userId, "pending"],
    enabled: allowed,
    queryFn: () => listRequests({ status: ["pending"] }),
    refetchInterval: 20_000,
  });
  const recentQ = useQuery({
    queryKey: ["expense-approvals", app.userId, "recent"],
    enabled: allowed,
    queryFn: () => listRequests({ status: ["approved", "declined"] }),
  });
  const namesQ = useQuery({
    queryKey: ["expense-approver-names", app.userId],
    enabled: allowed,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("user_id, full_name");
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name ?? p.user_id.slice(0, 8)]));
    },
  });

  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) => {
      if (!allowed || app.writesDisabled) throw new Error("Expense approvals are not permitted.");
      return decideRequest(id, approve, note[id]?.trim() || undefined);
    },
    onSuccess: (_d, v) => {
      toast.success(v.approve ? "Approved" : "Declined");
      void qc.invalidateQueries({ queryKey: ["expense-approvals"] });
    },
    onError: (e) => toastDbError(e, { action: "Decide request" }),
  });

  const pending = pendingQ.data ?? [];
  const names = namesQ.data;

  if (permissions.loading)
    return (
      <div className="page-shell w-full" role="status">
        Checking approval access...
      </div>
    );

  // Not an approver: nothing is drawn — no "limited to …" card. The sidebar
  // never offers this page without both the role and expenses.approve.
  if (!allowed) return null;

  const exportRows: ApprovalRow[] = [...pending, ...(recentQ.data ?? []).slice(0, 25)].map((r) => ({
    ...r,
    rep: names?.get(r.user_id) ?? "",
  }));

  return (
    <div className="page-shell w-full min-w-0 space-y-3">
      <PageHeader title="Spend approvals" />
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Anything under a rep's threshold goes through without you. These are the ones above it —
          answer in seconds, not minutes.
        </p>
        <ExportExcelButton
          report="spend-approvals"
          surface="expenses"
          entity="expense_requests"
          sheets={[
            { name: "Spend approvals", rows: exportRows, columns: approvalColumns(kindLabel) },
          ]}
        />
      </div>

      {/*
        Purchase receipts are their own queue (office stock spending, approved
        by whoever runs that office's purchasing) — but the person who checks
        this page should not have to remember a second one exists.
      */}
      <ReceiptsAwaitingPointer userId={app.userId} />

      {pendingQ.isLoading && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading approval requests...
        </p>
      )}
      {pendingQ.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load approval requests.{" "}
          <button type="button" className="underline" onClick={() => void pendingQ.refetch()}>
            Retry
          </button>
        </p>
      )}
      {recentQ.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load recent decisions.{" "}
          <button type="button" className="underline" onClick={() => void recentQ.refetch()}>
            Retry
          </button>
        </p>
      )}
      {pending.length === 0 && pendingQ.isSuccess ? (
        <Card>
          <CardContent className="py-8 text-center text-xs text-muted-foreground">
            Nothing waiting on you.
          </CardContent>
        </Card>
      ) : (
        pending.map((r) => (
          <Card key={r.id} className="border-warning/50">
            <CardContent className="space-y-2 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-lg font-semibold tabular-nums">{money(r.amount)}</span>
                <span className="text-xs text-muted-foreground">
                  {names?.get(r.user_id) ?? "—"}
                </span>
              </div>
              <div className="text-xs">
                <span className="font-medium">{kindLabel(r.kind)}</span>
                {r.merchant ? <span className="text-muted-foreground"> · {r.merchant}</span> : null}
              </div>
              <p className="text-xs text-muted-foreground">{r.purpose}</p>
              <Input
                className="h-9"
                placeholder="Note (optional)"
                value={note[r.id] ?? ""}
                onChange={(e) => setNote((n) => ({ ...n, [r.id]: e.target.value }))}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={decide.isPending || app.writesDisabled}
                  onClick={() => decide.mutate({ id: r.id, approve: false })}
                >
                  <X className="mr-1.5 size-4" /> Decline
                </Button>
                <Button
                  className="h-11"
                  disabled={decide.isPending || app.writesDisabled}
                  onClick={() => decide.mutate({ id: r.id, approve: true })}
                >
                  <Check className="mr-1.5 size-4" /> Approve
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}

      <Card>
        <CardContent className="p-0">
          <ul className="divide-y">
            {(recentQ.data ?? []).slice(0, 25).map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                <FitText className="w-16 shrink-0 tabular-nums">{money(r.amount)}</FitText>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {names?.get(r.user_id) ?? "—"} · {r.purpose}
                </span>
                <Badge
                  variant="outline"
                  className={cn("text-[10px]", REQUEST_STATUS_TONE[r.status])}
                >
                  {REQUEST_STATUS_LABEL[r.status]}
                </Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
