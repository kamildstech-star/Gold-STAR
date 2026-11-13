import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Plus, Receipt, Wallet, ReceiptText, Clock3, ShieldCheck } from "lucide-react";

import { useDefaultLocationId } from "@/components/location-picker";
import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastDbError } from "@/lib/db-errors";
import {
  EXPENSE_KINDS,
  EXPENSE_KIND_LABEL,
  REQUEST_STATUS_LABEL,
  REQUEST_STATUS_TONE,
  listExpenses,
  listRequests,
  logExpense,
  RECURRENCES,
  RECURRENCE_LABEL,
  type RecurrenceFreq,
  localDateStr,
  money,
  monthStartLocal,
  myThreshold,
  requestApproval,
  requestOutcomeMessage,
  summarise,
  type ExpenseKind,
} from "@/lib/expenses";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn } from "@/lib/export-table";
import { optionsFrom, useManagedOptions } from "@/lib/managed-options";
import type { Expense, ExpenseRequest } from "@/lib/expenses";

const EXPENSE_KIND_OPTS = optionsFrom(EXPENSE_KINDS, EXPENSE_KIND_LABEL);

/** Kind labels come from the managed option list, so the sheet reads like the screen. */
function requestColumns(kindLabel: (k: string) => string): ExportColumn<ExpenseRequest>[] {
  return [
    { key: "requested_at", label: "Requested", get: (r) => r.requested_at, type: "datetime" },
    { key: "amount", label: "Amount", get: (r) => r.amount, type: "money" },
    { key: "kind", label: "Type", get: (r) => kindLabel(r.kind) },
    { key: "merchant", label: "Where", get: (r) => r.merchant },
    { key: "purpose", label: "What for", get: (r) => r.purpose },
    { key: "status", label: "Status", get: (r) => REQUEST_STATUS_LABEL[r.status] ?? r.status },
    { key: "decision_note", label: "Note", get: (r) => r.decision_note },
  ];
}

function spendColumns(kindLabel: (k: string) => string): ExportColumn<Expense>[] {
  return [
    { key: "spent_on", label: "Date", get: (e) => e.spent_on, type: "date" },
    { key: "merchant", label: "Merchant", get: (e) => e.merchant },
    { key: "kind", label: "Type", get: (e) => kindLabel(e.kind) },
    { key: "amount", label: "Amount", get: (e) => e.amount, type: "money" },
    { key: "card_last4", label: "Card last 4", get: (e) => e.card_last4 },
    {
      key: "recurrence",
      label: "Frequency",
      get: (e) => RECURRENCE_LABEL[e.recurrence as RecurrenceFreq] ?? e.recurrence,
    },
    { key: "description", label: "Description", get: (e) => e.description },
    { key: "reimbursed", label: "Reimbursed", get: (e) => e.reimbursed },
  ];
}

export const Route = createFileRoute("/_authenticated/expenses/")({
  head: () => ({
    meta: [
      { title: "My expenses — Recovery Hub" },
      {
        name: "description",
        content:
          "Car allowance, gas card, company card and reimbursements in one running picture, with one-tap approval requests from the phone.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ExpensesPage,
});

function ExpensesPage() {
  const app = useAppContext();
  // "My expenses" is the viewed person's under View As — reads only; the
  // forms below record as app.userId.
  const subjectId = app.viewerUserId!;
  const from = monthStartLocal();
  const kindLabel = useManagedOptions("expense_kind", EXPENSE_KIND_OPTS).label;

  const thresholdQ = useQuery({
    queryKey: ["expense-threshold", subjectId],
    queryFn: () => myThreshold(subjectId),
  });
  const expensesQ = useQuery({
    queryKey: ["expenses", subjectId, from],
    queryFn: () => listExpenses({ userId: subjectId, from }),
  });
  const requestsQ = useQuery({
    queryKey: ["expense-requests", subjectId],
    queryFn: () => listRequests({ userId: subjectId }),
  });

  const expenses = expensesQ.data ?? [];
  const s = summarise(expenses);
  const threshold = thresholdQ.data ?? 50;

  const pendingCount = (requestsQ.data ?? []).filter((r) => r.status === "pending").length;

  return (
    <div className="page-shell w-full min-w-0 space-y-3">
      <PageHeader title="My expenses">
        {thresholdQ.isSuccess && <RequestSheet threshold={threshold} />}
      </PageHeader>

      <MetricStrip
        metrics={[
          {
            label: "This month",
            value: expensesQ.isSuccess ? money(s.total) : "Unavailable",
            icon: Wallet,
          },
          {
            label: "Unreimbursed",
            value: expensesQ.isSuccess ? money(s.unreimbursed) : "Unavailable",
            icon: ReceiptText,
          },
          {
            label: "Awaiting approval",
            value: requestsQ.isSuccess ? pendingCount.toLocaleString("en-US") : "Unavailable",
            icon: Clock3,
            tone: pendingCount > 0 ? "warning" : "default",
          },
          {
            label: "Approval needed above",
            value: thresholdQ.isSuccess ? money(threshold) : "Unavailable",
            icon: ShieldCheck,
          },
        ]}
      />

      {thresholdQ.isError && (
        <p role="alert" className="text-sm text-destructive">
          Your approval limit could not be loaded.{" "}
          <button type="button" className="underline" onClick={() => void thresholdQ.refetch()}>
            Retry
          </button>
        </p>
      )}
      <Tabs defaultValue="requests">
        <TabsList>
          <TabsTrigger value="requests">My requests</TabsTrigger>
          <TabsTrigger value="spend">Spend</TabsTrigger>
        </TabsList>

        <TabsContent value="requests" className="pt-2">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-sm">Approval requests</CardTitle>
              <ExportExcelButton
                report="expense-approvals"
                surface="expenses"
                entity="expense_requests"
                filters={{ user: subjectId }}
                sheets={[
                  {
                    name: "Approvals",
                    rows: requestsQ.data ?? [],
                    columns: requestColumns(kindLabel),
                  },
                ]}
              />
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y">
                {requestsQ.isLoading && (
                  <li role="status" className="p-4 text-sm text-muted-foreground">
                    Loading your requests...
                  </li>
                )}
                {requestsQ.isError && (
                  <li role="alert" className="p-4 text-sm text-destructive">
                    Could not load your requests.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void requestsQ.refetch()}
                    >
                      Retry
                    </button>
                  </li>
                )}
                {(requestsQ.data ?? []).map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs font-medium">
                        {money(r.amount)}
                        <span className="text-muted-foreground">{kindLabel(r.kind)}</span>
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {r.merchant ? `${r.merchant} — ` : ""}
                        {r.purpose}
                      </div>
                      {r.decision_note ? (
                        <div className="truncate text-[11px] text-muted-foreground">
                          Note: {r.decision_note}
                        </div>
                      ) : null}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn("text-[10px]", REQUEST_STATUS_TONE[r.status])}
                    >
                      {REQUEST_STATUS_LABEL[r.status]}
                    </Badge>
                  </li>
                ))}
                {(requestsQ.data ?? []).length === 0 && requestsQ.isSuccess && (
                  <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                    Nothing requested yet.
                    {thresholdQ.isSuccess &&
                      ` Anything under ${money(threshold)} just goes through.`}
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="spend" className="pt-2">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Receipt className="size-4" /> This month
              </CardTitle>
              <div className="flex items-center gap-1.5">
                <ExportExcelButton
                  report="expenses"
                  surface="expenses"
                  entity="expenses"
                  filters={{ user: subjectId, from }}
                  sheets={[{ name: "Spend", rows: expenses, columns: spendColumns(kindLabel) }]}
                />
                <LogSheet />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <ul className="divide-y">
                {expensesQ.isLoading && (
                  <li role="status" className="p-4 text-sm text-muted-foreground">
                    Loading your spend...
                  </li>
                )}
                {expensesQ.isError && (
                  <li role="alert" className="p-4 text-sm text-destructive">
                    Could not load your spend.{" "}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => void expensesQ.refetch()}
                    >
                      Retry
                    </button>
                  </li>
                )}
                {expenses.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 px-3 py-2 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground">{e.spent_on}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {e.merchant ?? kindLabel(e.kind)}
                      {e.card_last4 ? (
                        <span className="ml-1 text-muted-foreground">···{e.card_last4}</span>
                      ) : null}
                    </span>
                    <span className="tabular-nums">{money(e.amount)}</span>
                  </li>
                ))}
                {expenses.length === 0 && expensesQ.isSuccess && (
                  <li className="px-3 py-6 text-center text-xs text-muted-foreground">
                    No spend recorded this month.
                  </li>
                )}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RequestSheet({ threshold }: { threshold: number }) {
  const app = useAppContext();
  const defaultLocationId = useDefaultLocationId();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExpenseKind>("company_card");
  const [amount, setAmount] = useState("");
  const [merchant, setMerchant] = useState("");
  const [purpose, setPurpose] = useState("");

  const amt = Number(amount) || 0;
  const needsApproval = amt > threshold;

  const submit = useMutation({
    mutationFn: async () => {
      if (!amt) throw new Error("Enter an amount.");
      if (!purpose.trim()) throw new Error("Say what it's for.");
      return requestApproval({
        userId: app.userId!,
        locationId: defaultLocationId,
        kind,
        amount: amt,
        merchant: merchant.trim() || null,
        purpose: purpose.trim(),
      });
    },
    onSuccess: (r) => {
      toast.success(requestOutcomeMessage(r.status, threshold));
      setOpen(false);
      setAmount("");
      setMerchant("");
      setPurpose("");
      void qc.invalidateQueries({ queryKey: ["expense-requests"] });
    },
    onError: (e) => toastDbError(e, { action: "Request approval" }),
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 size-3.5" /> Request approval
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[90vh] overflow-auto">
        <SheetHeader>
          <SheetTitle className="text-sm">Spend approval</SheetTitle>
        </SheetHeader>
        <div className="space-y-3 pt-3">
          <div>
            <Label className="text-xs">Amount</Label>
            <NumberInput
              decimals={2}
              className="h-12 text-lg"
              value={amount}
              onValueChange={(_, clean) => setAmount(clean)}
              placeholder="0.00"
              autoFocus
            />
            <p
              className={cn(
                "mt-1 text-[11px]",
                needsApproval ? "text-warning" : "text-muted-foreground",
              )}
            >
              {needsApproval
                ? `Above your ${money(threshold)} limit — the Sales Head has to sign off first.`
                : `Under your ${money(threshold)} limit — goes through with no approval.`}
            </p>
          </div>
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ExpenseKind)}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ManagedOptionItems listKey="expense_kind" fallback={EXPENSE_KIND_OPTS} />
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Where</Label>
            <Input
              className="h-11"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">What for</Label>
            <Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </div>
          <Button
            className="h-12 w-full"
            disabled={submit.isPending || app.writesDisabled}
            onClick={() => submit.mutate()}
          >
            {needsApproval ? "Send for approval" : "Record it"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function LogSheet() {
  const app = useAppContext();
  const defaultLocationId = useDefaultLocationId();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ExpenseKind>("company_card");
  const [amount, setAmount] = useState("");
  const [spentOn, setSpentOn] = useState(localDateStr(new Date()));
  const [merchant, setMerchant] = useState("");
  const [last4, setLast4] = useState("");
  const [recurrence, setRecurrence] = useState<RecurrenceFreq>("one_off");
  const [recurringUntil, setRecurringUntil] = useState("");

  const save = useMutation({
    mutationFn: async () => {
      const amt = Number(amount) || 0;
      if (!amt) throw new Error("Enter an amount.");
      await logExpense({
        userId: app.userId!,
        locationId: defaultLocationId,
        kind,
        amount: amt,
        spentOn,
        merchant: merchant.trim() || null,
        description: null,
        cardLast4: last4.trim() || null,
        recurrence,
        recurringFrom: recurrence === "one_off" ? null : spentOn,
        recurringUntil: recurrence === "one_off" ? null : recurringUntil || null,
      });
    },
    onSuccess: () => {
      toast.success("Recorded");
      setOpen(false);
      setAmount("");
      setMerchant("");
      void qc.invalidateQueries({ queryKey: ["expenses"] });
    },
    onError: (e) => toastDbError(e, { action: "Log expense" }),
  });

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline">
          Log spend
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="max-h-[90dvh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-sm">Log spend</SheetTitle>
        </SheetHeader>
        <div className="space-y-3 pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Amount</Label>
              <NumberInput
                className="h-11"
                decimals={2}
                value={amount}
                onValueChange={(_, clean) => setAmount(clean)}
              />
            </div>
            <div>
              <Label className="text-xs">Date</Label>
              <Input
                className="h-11"
                type="date"
                value={spentOn}
                onChange={(e) => setSpentOn(e.target.value)}
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as ExpenseKind)}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ManagedOptionItems listKey="expense_kind" fallback={EXPENSE_KIND_OPTS} />
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Merchant</Label>
              <Input
                className="h-11"
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Card last 4</Label>
              <Input
                className="h-11"
                inputMode="numeric"
                maxLength={4}
                value={last4}
                onChange={(e) => setLast4(e.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Frequency</Label>
              <Select value={recurrence} onValueChange={(v) => setRecurrence(v as RecurrenceFreq)}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RECURRENCES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {RECURRENCE_LABEL[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {recurrence !== "one_off" && (
              <div>
                <Label className="text-xs">Ends (optional)</Label>
                <Input
                  className="h-11"
                  type="date"
                  value={recurringUntil}
                  onChange={(e) => setRecurringUntil(e.target.value)}
                />
              </div>
            )}
          </div>
          {recurrence !== "one_off" && (
            <p className="text-xs text-muted-foreground">
              Recurring charges repeat from this date and count toward total rep cost each period.
            </p>
          )}
          <Button
            className="h-12 w-full"
            disabled={save.isPending || app.writesDisabled}
            onClick={() => save.mutate()}
          >
            Save
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
