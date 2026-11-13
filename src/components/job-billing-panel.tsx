import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { JobRateSource } from "@/components/billing-costs/job-rate-source";
import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JobCalculatorDialog, type CalculatorJobSeed } from "@/components/job-calculator-dialog";
import { SendReceiptButton } from "@/components/send-receipt-button";
import { BILLING_BOX, BillingBoxList } from "@/components/billing-boxes";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import {
  INVOICE_STATUSES,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  daysOutstanding,
  fmtUsd,
  type InvoiceStatus,
} from "@/lib/billing";
import {
  outstandingBalance,
  resolveInvoiceStatusSelection,
  statusUnchangedMessage,
} from "@/lib/invoice-paid";
import {
  ESTIMATE_STATUS_LABEL,
  ESTIMATE_STATUS_TONE,
  estimateLabel,
  type EstimateStatus,
} from "@/lib/estimates";
import {
  convertCalculationToInvoice,
  convertEstimateToInvoice,
  invoiceVariance,
} from "@/lib/estimate-invoice";
import { ResolveJobTypePrompt } from "@/components/job-type-resolve";
import { isUndeterminedJobType } from "@/lib/loss-categories";
import {
  ChevronDown,
  FileText,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { deleteDraftInvoice, invoiceDeleteRule } from "@/lib/invoice-delete";
import { undoableDelete, type Undoable } from "@/lib/undoable-delete";
import { fetchManagesOffice } from "@/lib/pipeline-reversion";
import { PaymentEditDialog } from "@/components/payment-edit-dialog";
import { AddPaymentDialog } from "@/components/add-payment-dialog";
import { PAYMENT_METHODS, payableInvoices, splitSiblings } from "@/lib/add-payment";
import { describePaymentChange, listPaymentChanges, type PaymentChange } from "@/lib/payment-edits";
import { documentFileUrl } from "@/lib/documents";
import { isMissingSchema } from "@/lib/schema-fallback";
import { createEstimateFromJob } from "@/lib/estimates";
import { createInvoiceFromJob } from "@/lib/invoices";
import { EstimateEditor } from "@/components/estimate-editor";
import { EstimatesRailList } from "@/components/estimates-rail-list";
import { mergeJobEstimates, type BillingEstimate } from "@/lib/billing-estimates";
import { NO_DELETE, deleteEstimateRow, fetchDeleteSupport } from "@/lib/estimate-delete";
import { listJobCalculationsForJob } from "@/lib/job-calculations";
import { InvoiceEditor } from "@/components/invoice-editor";
import { ReportFiltersButton } from "@/components/report-filters-dialog";
import { DocumentPreviewButton } from "@/components/document-preview-button";
import { RevisionHistoryButton } from "@/components/revision-history";
import { AccountDiscountCallout } from "@/components/standing-notes";
import { FitText } from "@/components/ui/fit-text";
import { refreshJobMoney } from "@/lib/use-job-commission";
import { JobReferralFeeLine } from "@/components/job-commissions-card";
import { InvoiceReviewDialog } from "@/components/invoice-review-dialog";
import { TmBillDialog } from "@/components/tm-bill-dialog";
import { isTmJob } from "@/lib/field-forms-visibility";
import type { TmBill } from "@/lib/tm-bill";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Text under 16px makes iOS zoom the page in on focus and never zoom back, so
 * every dialog field grows to a thumb-sized 44px box with 16px text below the
 * breakpoint and returns to the dense desktop size above it. Kept identical to
 * the two editors; belongs in the Input primitive once that lands.
 */
const MOBILE_FIELD = "h-11 text-base sm:h-8 sm:text-[13px]";

type Estimate = {
  id: string;
  seq: number | null;
  status: EstimateStatus;
  title: string | null;
  total: number;
  estimate_date: string;
  current_version: number | null;
};

type Invoice = {
  id: string;
  invoice_number: string;
  carrier: string | null;
  claim_number: string | null;
  issue_date: string;
  due_date: string | null;
  billed_amount: number;
  line_itemized: boolean;
  current_version: number | null;
  source_estimate_version: number | null;
  approved_amount: number | null;
  collected_amount: number;
  carrier_shortfall: number;
  uncollected: number;
  status: InvoiceStatus;
  estimate_id: string | null;
  /** Set when it went out; not cleared by moving it back to draft. */
  sent_at: string | null;
  /** The Quick Estimate it was converted from; null before 20261006161000. */
  job_calculation_id: string | null;
  /** Who raised it: they may record its payments (invoice_payments_write). */
  created_by: string | null;
};

const INVOICE_COLUMNS =
  "id, invoice_number, carrier, claim_number, issue_date, due_date, billed_amount, approved_amount, collected_amount, carrier_shortfall, uncollected, status, estimate_id, line_itemized, current_version, source_estimate_version, sent_at, created_by";

type Payment = {
  id: string;
  invoice_id: string;
  amount: number;
  received_at: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  created_by: string | null;
  /** The photographed cheque or remittance, if one was attached. */
  document_id: string | null;
  /** Shared by the rows of one split payment — see `splitSiblings`. */
  created_at: string | null;
};

const PAYMENT_COLUMNS =
  "id, invoice_id, amount, received_at, method, reference, notes, created_by, created_at";

export function JobBillingPanel({
  jobId,
  jobType,
  onJobTypeResolved,
  jobLocationId,
  jobAccountId,
  carrier,
  claimNumber,
  adjusterName,
  adjusterEmail,
  calculatorSeed,
}: {
  jobId: string;
  jobType?: string | null;
  onJobTypeResolved?: (key: string) => void;
  jobLocationId: string;
  jobAccountId: string | null;
  carrier: string | null;
  claimNumber: string | null;
  adjusterName: string | null;
  adjusterEmail: string | null;
  /**
   * The job, in the shape the Job Calculator seeds itself from. Optional so the
   * panel still renders for a caller that has not got it; the basic-estimate
   * button simply does not appear without it.
   */
  calculatorSeed?: CalculatorJobSeed;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const disabled = app.writesDisabled;
  const [estimates, setEstimates] = useState<Estimate[]>([]);
  /** The Job Calculator sheets attached to this job; listed with the estimates. */
  const [calculations, setCalculations] = useState<
    Awaited<ReturnType<typeof listJobCalculationsForJob>>
  >([]);
  const [converting, setConverting] = useState<string | null>(null);
  /**
   * Whether `invoices.job_calculation_id` exists yet. Until it does there is
   * nowhere to record which Quick Estimate an invoice came from, so nothing
   * could stop one being invoiced twice — and Convert is not offered on it.
   */
  const [calcConvertSupported, setCalcConvertSupported] = useState(false);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  /**
   * An empty payment list and a payment list we failed to fetch look identical
   * on screen, and one of them is a lie. Keep them apart.
   */
  const [paymentsFailed, setPaymentsFailed] = useState(false);
  /**
   * Whether `invoice_payments.document_id` exists yet. Assumed present until a
   * read says otherwise, so the control is offered the moment the migration
   * lands; when it is absent the dialog says so rather than throwing.
   */
  const [attachmentsSupported, setAttachmentsSupported] = useState(true);
  const [recordedBy, setRecordedBy] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  /** Estimate expanded inline — a child record is built where the parent is. */
  const [openEstimateId, setOpenEstimateId] = useState<string | null>(null);
  const openEstimate = estimates.find((e) => e.id === openEstimateId) ?? null;
  const [creating, setCreating] = useState(false);
  /**
   * The row is in the split; the editor opens under it, full width. On a
   * phone the split has stacked, so a tap on an estimate row would open an
   * editor below the whole invoice list, out of sight. Bring it up.
   */
  const openEstimateRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!openEstimateId) return;
    openEstimateRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [openEstimateId]);

  /*
   * `loading` blanks this whole card — including the estimate editor expanded
   * inside it. The editor autosaves on every field blur and calls back here,
   * so re-raising the flag on a background reload unmounted the document the
   * user was typing into: that is the flash. The flag is now the first-paint
   * skeleton only; every later reload swaps the data underneath.
   */
  const loadedOnce = useRef(false);

  const load = useCallback(async () => {
    if (!loadedOnce.current) setLoading(true);
    // Every reload follows a change to an estimate, invoice or payment, and
    // those are the commission's base: the Commissions card and the ledger
    // strip re-read the running cost with it (Mark, 7 Oct: "auto calculate as
    // the charges get added"). The first paint reads it anyway.
    if (loadedOnce.current) refreshJobMoney(qc, jobId);
    const { data: est } = await supabase
      .from("estimates")
      .select("id, seq, status, title, total, estimate_date, current_version")
      .eq("job_id", jobId)
      .order("seq", { ascending: false });
    setEstimates((est ?? []) as Estimate[]);
    // A database without the calculator table yet still has its estimates;
    // the list shows what it can read rather than failing over the half it
    // cannot.
    setCalculations(await listJobCalculationsForJob(jobId).catch(() => []));

    // Asked for with the Quick Estimate link, then without it: an unapplied
    // column fails the whole read, and the invoices must not vanish over it.
    const runInvoices = (cols: string) =>
      supabase
        .from("invoices")
        .select(cols)
        .eq("job_id", jobId)
        .order("issue_date", { ascending: false });
    let invRes = await runInvoices(`${INVOICE_COLUMNS}, job_calculation_id`);
    const linkSupported = !(invRes.error && isMissingSchema(invRes.error));
    if (!linkSupported) invRes = await runInvoices(INVOICE_COLUMNS);
    setCalcConvertSupported(linkSupported && !invRes.error);
    const invRows = ((invRes.data ?? []) as unknown as Invoice[]).map((i) => ({
      ...i,
      job_calculation_id: i.job_calculation_id ?? null,
    }));
    setInvoices(invRows);

    if (invRows.length) {
      const runPayments = (cols: string) =>
        supabase
          .from("invoice_payments")
          .select(cols)
          .in(
            "invoice_id",
            invRows.map((r) => r.id),
          )
          .order("received_at", { ascending: false })
          // Two cheques on the same day still have an order; received_at alone loses it.
          .order("created_at", { ascending: false });

      /*
       * Ask for the attachment column, then retry without it. `document_id`
       * ships in a migration that has not been applied, and PostgREST fails
       * the WHOLE read on one unknown column — so without the retry an
       * unshipped column would blank every payment record on this job. The day
       * it lands the attachments appear with no code change.
       */
      let payRes = await runPayments(`${PAYMENT_COLUMNS}, document_id`);
      let supported = true;
      if (payRes.error && isMissingSchema(payRes.error)) {
        supported = false;
        payRes = await runPayments(PAYMENT_COLUMNS);
      }
      setAttachmentsSupported(supported);
      setPaymentsFailed(!!payRes.error);
      const payRows = ((payRes.data ?? []) as unknown as Payment[]).map((p) => ({
        ...p,
        document_id: p.document_id ?? null,
      }));
      setPayments(payRows);

      const authorIds = [
        ...new Set(payRows.map((p) => p.created_by).filter((v): v is string => !!v)),
      ];
      if (authorIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", authorIds);
        setRecordedBy(Object.fromEntries((profs ?? []).map((p) => [p.user_id, p.full_name ?? ""])));
      } else {
        setRecordedBy({});
      }
    } else {
      setPayments([]);
      setPaymentsFailed(false);
      setRecordedBy({});
    }
    loadedOnce.current = true;
    setLoading(false);
  }, [jobId, qc]);

  useEffect(() => {
    load();
  }, [load]);

  const typeUnresolved = isUndeterminedJobType(jobType);

  /**
   * Creates the estimate right here, prefilled from the job. The user is
   * already on the job — sending them to a list to re-pick it is nonsense.
   */
  const newEstimate = async () => {
    if (!app.userId) return toast.error("Not signed in.");
    if (typeUnresolved) {
      return toast.error("Set the job type first — it is still Undetermined.");
    }
    setCreating(true);
    try {
      const { data: job, error } = await supabase
        .from("jobs")
        .select(
          "id, job_number, location_id, customer_name, account_id, address, address_line2, locality, region, postal_code, call_date",
        )
        .eq("id", jobId)
        .single();
      if (error) throw error;
      const row = await createEstimateFromJob(job, app.userId);
      await load();
      setOpenEstimateId(row.id);
      toast.success("Draft estimate created from this job.");
    } catch (e) {
      toastDbError(e, { action: "Creating the estimate" });
    } finally {
      setCreating(false);
    }
  };

  const convert = async (estimateId: string) => {
    if (typeUnresolved) {
      return toast.error("Set the job type first — it is still Undetermined.");
    }
    setConverting(estimateId);
    try {
      const res = await convertEstimateToInvoice(estimateId, app.userId);
      toast.success(res.existing ? "That estimate is already invoiced." : "Invoice created.");
      await load();
      // A converted estimate is a new draft too — the same review pop-up.
      if (!res.existing) {
        setReviewInvoiceId(res.invoiceId);
      }
    } catch (e) {
      toastDbError(e, { action: "Converting the estimate to an invoice" });
    } finally {
      setConverting(null);
    }
  };

  /* ---------------- deleting an estimate ---------------- */

  /*
   * Mark, 2026-10-06, of an empty ESTIMATE-2 draft: "add a delete button
   * here". The repo's pattern for a delete a thumb can slip into is the
   * section notes' (#285): the row goes at once, a toast offers Undo for six
   * seconds, and the DELETE is only sent when the window closes — so Undo is
   * "never sent", which works for anyone who could delete. After that the
   * Timeline's Restore (#300) brings it back; Delete is only offered where
   * the database says it can (`fetchDeleteSupport`).
   */
  const deleteSupportQ = useQuery({
    queryKey: ["estimate-delete-support"],
    queryFn: fetchDeleteSupport,
    staleTime: 10 * 60_000,
  });
  const deleteSupport = deleteSupportQ.data ?? NO_DELETE;
  const [removing, setRemoving] = useState<Set<string>>(() => new Set());
  const pendingDeletes = useRef(new Map<string, { job: Undoable; toastId: string | number }>());
  const unhide = (key: string) =>
    setRemoving((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  const removeEstimate = (row: BillingEstimate) => {
    if (row.source === "quote" || pendingDeletes.current.has(row.key)) return;
    const kind = row.source;
    setRemoving((prev) => new Set(prev).add(row.key));
    if (kind === "estimate" && openEstimateId === row.id) setOpenEstimateId(null);
    const job = undoableDelete({
      commit: async () => {
        await deleteEstimateRow(kind, row.id);
        await load();
        unhide(row.key);
        void qc.invalidateQueries({ queryKey: ["billing-estimates"] });
        void qc.invalidateQueries({ queryKey: ["record-history", jobId] });
        void qc.invalidateQueries({ queryKey: ["record-activity", "job", jobId] });
      },
      restore: () => unhide(row.key),
      onError: (error) => toastDbError(error, { action: "Deleting the estimate" }),
    });
    const settle = () => {
      pendingDeletes.current.delete(row.key);
      void job.settle();
    };
    const label = kind === "calculator" ? `${row.jobType ?? "Quick"} estimate` : row.title;
    const toastId = toast(`${label} deleted`, {
      description: "Restore it later from the job's Timeline.",
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          pendingDeletes.current.delete(row.key);
          job.undo();
        },
      },
      onAutoClose: settle,
      onDismiss: settle,
    });
    pendingDeletes.current.set(row.key, { job, toastId });
  };

  // A hidden page sends what is pending, as the section notes do: Sonner
  // pauses its clock while hidden, and a pocketed phone would leave the
  // delete hanging until the app was next opened.
  useEffect(() => {
    const pending = pendingDeletes.current;
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      for (const [key, { job, toastId }] of pending) {
        pending.delete(key);
        void job.settle();
        toast.dismiss(toastId);
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, []);

  /** A Quick Estimate, through the same writer and bill-to as `convert`. */
  const convertCalculation = async (calculationId: string) => {
    if (typeUnresolved) {
      return toast.error("Set the job type first — it is still Undetermined.");
    }
    setConverting(calculationId);
    try {
      const res = await convertCalculationToInvoice(calculationId, app.userId);
      toast.success(res.existing ? "That estimate is already invoiced." : "Invoice created.");
      await load();
    } catch (e) {
      toastDbError(e, { action: "Converting the Quick Estimate to an invoice" });
    } finally {
      setConverting(null);
    }
  };

  /* ---------------- invoices ---------------- */

  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  // The T&M bill (26 Oct): the job's facts it is priced by, loaded on open.
  const [tmBillJob, setTmBillJob] = useState<Awaited<ReturnType<typeof jobPrefill>> | null>(null);
  const [quickDraft, setQuickDraft] = useState({ billed: "", due: "", description: "" });
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  /**
   * A just-made draft, in the review pop-up (David, 21 Oct). Every create path
   * opens it; closing it returns to the list (27 Oct: invoices open as
   * pop-ups now, so it no longer chains into a second one).
   */
  const [reviewInvoiceId, setReviewInvoiceId] = useState<string | null>(null);
  const openInvoice = invoices.find((i) => i.id === openInvoiceId) ?? null;
  /** The open invoice is a pop-up over the tab (27 Oct), not an editor below it. */
  const [creatingInvoice, setCreatingInvoice] = useState(false);

  /** Everything an invoice snapshots off this job, fetched once per create. */
  const jobPrefill = async () => {
    const { data, error } = await supabase
      .from("jobs")
      .select(
        "id, job_number, location_id, customer_name, account_id, address, address_line2, locality, region, postal_code, call_date, insurance_carrier, claim_number, adjuster_name, adjuster_email",
      )
      .eq("id", jobId)
      .single();
    if (error) throw error;
    return data;
  };

  /**
   * The full builder is the default: carrier, claim, address and office
   * branding all come off the job, and the amount comes from the lines.
   */
  const newInvoice = async (opts?: {
    quick?: boolean;
    billed?: number;
    due?: string | null;
    /** Simple mode: what the one amount is for. */
    description?: string | null;
    /** Pull the job's approved hours and scanned equipment straight in. */
    pull?: boolean;
    /** The T&M bill's category lines (26 Oct). */
    tmBill?: TmBill;
    /** Itemized day by day, or category totals (3 Nov). */
    tmBillLayout?: "itemized" | "summary";
  }) => {
    if (!app.userId) return toast.error("Not signed in.");
    if (typeUnresolved) {
      return toast.error("Set the job type first — it is still Undetermined.");
    }
    setCreatingInvoice(true);
    try {
      const job = await jobPrefill();
      const row = await createInvoiceFromJob(job, app.userId, {
        quick: opts?.quick,
        billedAmount: opts?.billed,
        dueDate: opts?.due ?? null,
        title: opts?.description ?? null,
      });
      /*
        David, 13 Oct: "generate invoice from the job ledger is not working" —
        this button used to stop here, at an empty invoice. It now pulls the
        job in, through the same code as the editor's Pull from job panel.
      */
      let pulled: { lines: number; amount: number; heldBack: number } | null = null;
      let tmBilled: TmBill | null = null;
      if (opts?.tmBill) {
        try {
          const { insertTmBill } = await import("@/lib/tm-bill-run");
          await insertTmBill(supabase as never, row, opts.tmBill, opts.tmBillLayout);
          tmBilled = opts.tmBill;
        } catch (e) {
          // The invoice exists, empty; the bill can be made again or typed in.
          toastDbError(e, { action: "Fill the invoice from the T&M bill" });
        }
      }
      if (opts?.pull) {
        try {
          const { pullJobIntoInvoice } = await import("@/lib/invoice-pull-run");
          pulled = await pullJobIntoInvoice(supabase as never, row);
        } catch (e) {
          // The invoice exists; the editor's panel shows the job and a retry.
          toastDbError(e, { action: "Pull the job into the invoice" });
        }
      }
      await load();
      setQuickOpen(false);
      setQuickDraft({ billed: "", due: "", description: "" });
      setReviewInvoiceId(row.id);
      if (opts?.tmBill) setTmBillJob(null);
      if (tmBilled) {
        toast.success("T&M bill drafted — one line per category", {
          description: tmBilled.unpricedCodes.length
            ? `No rate for ${tmBilled.unpricedCodes.join(", ")} — those went in at $0. Review every line before sending.`
            : "Review the lines — edit or delete anything before sending.",
        });
      } else if (pulled && pulled.lines > 0) {
        toast.success(
          `Invoice created with ${pulled.lines} line${pulled.lines === 1 ? "" : "s"} from the job`,
          {
            description: "Review the lines — edit or delete anything before sending.",
          },
        );
      } else if (pulled) {
        toast.info("Invoice created — nothing approved to pull yet", {
          description: pulled.heldBack
            ? "Hours are waiting for approval. Pull from job in the invoice lets you include them."
            : "No approved hours or scanned equipment on the job yet.",
        });
      } else {
        toast.success(opts?.quick ? "Quick invoice created." : "Invoice created from this job.");
      }
    } catch (e) {
      toastDbError(e, { action: "Creating the invoice" });
    } finally {
      setCreatingInvoice(false);
    }
  };

  const createQuickInvoice = () => {
    const billed = Number(quickDraft.billed);
    if (!billed || billed <= 0) return toast.error("Billed amount is required.");
    void newInvoice({
      quick: true,
      billed,
      due: quickDraft.due || null,
      description: quickDraft.description.trim() || null,
    });
  };

  const patchInvoice = async (
    id: string,
    patch: Partial<{
      status: InvoiceStatus;
      sent_at: string | undefined;
      approved_amount: number | null;
    }>,
  ) => {
    const { error } = await supabase.from("invoices").update(patch).eq("id", id);
    if (error) return toastDbError(error, { action: "Updating the invoice" });
    // The editor expanded under this row keeps its own copy of the invoice.
    // Without this its status badge goes on showing what the row no longer says.
    void qc.invalidateQueries({ queryKey: ["invoice", id] });
    load();
  };

  /** Held by id, not by row — `load()` replaces the invoice objects underneath. */
  const [historyId, setHistoryId] = useState<string | null>(null);
  const historyInvoice = invoices.find((i) => i.id === historyId) ?? null;
  /** The payment being corrected, if any. */
  const [editingPayment, setEditingPayment] = useState<Payment | null>(null);
  /* The trail of corrections, written by the database on every edit and
     removal (20260927121000). Empty before that migration, never an error. */
  const changesQ = useQuery({
    queryKey: ["payment-changes", jobId, invoices.map((i) => i.id).join(",")],
    queryFn: () => listPaymentChanges(invoices.map((i) => i.id)),
    enabled: invoices.length > 0,
  });
  const afterPaymentChange = () => {
    void load();
    void qc.invalidateQueries({ queryKey: ["payment-changes"] });
    void qc.invalidateQueries({ queryKey: ["billing-payments"] });
  };

  /**
   * The Add payment dialog (`add-payment-dialog.tsx`): open, and which
   * invoice to tick when a Record payment button on one opened it.
   *
   * `revertsTo` is set only when it was opened by picking "Paid" in a status
   * dropdown, and holds the status the invoice keeps if nothing is recorded;
   * null from the buttons, where no status change is pending and so there is
   * nothing to say on cancel.
   */
  const [payOpen, setPayOpen] = useState<{
    preselectId: string | null;
    revertsTo: InvoiceStatus | null;
  } | null>(null);

  /**
   * Who may record a payment on this invoice: the invoice_payments write
   * policy, clause for clause — a manager of the office, or whoever raised the
   * invoice. Only hides what the database would refuse; RLS still decides.
   */
  const canRecordOn = (inv: Invoice) =>
    managesOffice === true || (!!app.userId && inv.created_by === app.userId);

  /**
   * Every way into a payment opens the one dialog. From an invoice it is
   * ticked with that invoice's balance; from the Payments card nothing is
   * ticked and the person chooses (Mark, 2026-10-07: "allow them to check an
   * invoice it's applying to").
   */
  const openPayment = (inv?: Invoice, opts?: { revertsTo?: InvoiceStatus }) => {
    setPayOpen({ preselectId: inv?.id ?? null, revertsTo: opts?.revertsTo ?? null });
  };

  /**
   * The one way an invoice becomes Paid from the UI. Mark: "payments should be
   * recorded when an invoice is marked paid" — so with a balance outstanding
   * this opens the payment dialog instead of writing the status, and the
   * rollup trigger sets Paid once the money is in. See `lib/invoice-paid.ts`
   * for why a zero balance is allowed to write through.
   */
  const markPaid = (inv: Invoice) => {
    const decision = resolveInvoiceStatusSelection("paid", inv);
    if (decision.action === "collect") {
      // Not offered to someone who may not record it (see mayMarkPaid).
      if (!canRecordOn(inv)) return;
      return openPayment(inv, { revertsTo: inv.status });
    }
    void patchInvoice(inv.id, { status: "paid" });
  };

  /** Paid is on offer only where this person could go through with it. */
  const mayMarkPaid = (inv: Invoice) =>
    resolveInvoiceStatusSelection("paid", inv).action !== "collect" || canRecordOn(inv);

  const closePayment = (saved: boolean) => {
    // Dismissing after picking "Paid" leaves the status alone — the dropdown
    // is controlled by the row, so it never moved. Say which status it kept,
    // or the refusal looks like a dropped click.
    if (!saved && payOpen?.revertsTo) toast.info(statusUnchangedMessage(payOpen.revertsTo));
    setPayOpen(null);
    if (saved) {
      for (const inv of invoices) void qc.invalidateQueries({ queryKey: ["invoice", inv.id] });
      void qc.invalidateQueries({ queryKey: ["billing-payments"] });
      void load();
    }
  };

  /* ---------------- deleting a draft invoice ---------------- */

  /*
   * Mark, 2026-10-06: "need a delete or undo". Only an untouched draft, only
   * for a manager of the office (invoices_delete is can_manage_location, so
   * the button asks the same function), and behind the section notes' Undo
   * (#285): the row goes at once, the DELETE is sent when the toast's six
   * seconds are up. See src/lib/invoice-delete.ts for why there is no Void.
   */
  const managesQ = useQuery({
    // The same key the pipeline's manager check uses, so the answer is shared.
    queryKey: ["manages-office", app.userId, jobLocationId],
    enabled: Boolean(app.userId),
    staleTime: 5 * 60_000,
    queryFn: () => fetchManagesOffice(app.userId as string, jobLocationId),
  });
  // A failed check is a "no", never a stale yes; null while it is out.
  const managesOffice = managesQ.isSuccess ? managesQ.data : managesQ.isError ? false : null;
  const [removingInvoices, setRemovingInvoices] = useState<Set<string>>(() => new Set());
  const pendingInvoiceDeletes = useRef(
    new Map<string, { job: Undoable; toastId: string | number }>(),
  );
  const unhideInvoice = (id: string) =>
    setRemovingInvoices((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const visibleInvoices = invoices.filter((i) => !removingInvoices.has(i.id));
  /* 5 Nov (T6): a bin on a Draft invoice's box, to clear $0 practice
     invoices. Asked once in a dialog, then the same delete as the menu's
     (Undo still in the toast); the database refuses anything but an
     untouched draft whatever the path (20261006181000). */
  const [confirmDelete, setConfirmDelete] = useState<Invoice | null>(null);
  const canDeleteFromList = (inv: Invoice) =>
    inv.status === "draft" &&
    invoiceDeleteRule(inv, {
      paymentRecords:
        payments.filter((p) => p.invoice_id === inv.id).length +
        (changesQ.data ?? []).filter((c) => c.invoice_id === inv.id).length,
      manager: managesOffice,
    }).allowed;

  const removeInvoice = (inv: Invoice) => {
    if (pendingInvoiceDeletes.current.has(inv.id)) return;
    setRemovingInvoices((prev) => new Set(prev).add(inv.id));
    if (openInvoiceId === inv.id) setOpenInvoiceId(null);
    const job = undoableDelete({
      commit: async () => {
        await deleteDraftInvoice(inv.id);
        await load();
        unhideInvoice(inv.id);
        void qc.invalidateQueries({ queryKey: ["job-ledger-invoices", jobId] });
        void qc.invalidateQueries({ queryKey: ["billing-payments"] });
        void qc.invalidateQueries({ queryKey: ["record-activity", "job", jobId] });
      },
      restore: () => unhideInvoice(inv.id),
      onError: (error) => toastDbError(error, { action: "Deleting the invoice" }),
    });
    const settle = () => {
      pendingInvoiceDeletes.current.delete(inv.id);
      void job.settle();
    };
    const toastId = toast(`${inv.invoice_number} deleted`, {
      description: "A draft that was never sent. Undo puts it straight back.",
      duration: 6000,
      action: {
        label: "Undo",
        onClick: () => {
          pendingInvoiceDeletes.current.delete(inv.id);
          job.undo();
        },
      },
      onAutoClose: settle,
      onDismiss: settle,
    });
    pendingInvoiceDeletes.current.set(inv.id, { job, toastId });
  };

  // A hidden page sends what is pending, as the section notes do.
  useEffect(() => {
    const pending = pendingInvoiceDeletes.current;
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      for (const [id, { job, toastId }] of pending) {
        pending.delete(id);
        void job.settle();
        toast.dismiss(toastId);
      }
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, []);

  /*
   * What Add payment offers: the invoices on the card (so never a draft
   * waiting out its Undo) that can take money by #301's rule, narrowed to
   * the ones this person may record on. A Record payment button adds its own
   * invoice even when it is paid — that has always been allowed.
   */
  const payable = payableInvoices(visibleInvoices, { canRecord: canRecordOn });
  const payDialogInvoices = payableInvoices(visibleInvoices, {
    canRecord: canRecordOn,
    include: payOpen?.preselectId,
  });
  /*
   * Shown to anyone who could record a payment here: a manager of the office
   * (even before there is an invoice — the button then says to create one),
   * or someone with an invoice of their own on the job. Hidden for the rest,
   * who would only meet RLS's refusal.
   */
  const showAddPayment = managesOffice === true || payable.length > 0;
  /** "split across …" on the Payments list — rows saved together. */
  const siblings = splitSiblings(payments);

  /*
   * What the invoice card used to carry below its number — approved and
   * collected, the balance, Record payment and the ⋯ menu — now heads the
   * invoice pop-up, so the card stays short and nothing is lost.
   */
  const invoiceTools = (i: (typeof invoices)[number]) => {
    // A Quick Estimate's invoice is compared with its
    // sheet, as a document's is with its scope (#298).
    const srcTotal =
      estimates.find((e) => e.id === i.estimate_id)?.total ??
      calculations.find((c) => c.id === i.job_calculation_id)?.customer_price;
    const variance = srcTotal == null ? null : invoiceVariance(i.billed_amount, srcTotal);
    const n = payments.filter((p) => p.invoice_id === i.id).length;
    const deleteRule = invoiceDeleteRule(i, {
      paymentRecords: n + (changesQ.data ?? []).filter((c) => c.invoice_id === i.id).length,
      manager: managesOffice,
    });

    return (
      <div className="space-y-2 rounded-lg border bg-muted/30 p-3 text-xs" data-invoice-tools>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {/* Carrier and claim are the pop-up's own subtitle, just above. */}
          {i.status === "paid" ? null : (
            <span>{daysOutstanding(i.due_date, i.issue_date)} days out</span>
          )}
          <span
            className={cn(
              "text-[11px]",
              variance == null || variance === 0
                ? "text-muted-foreground"
                : variance > 0
                  ? "text-warning"
                  : "text-info",
            )}
          >
            {variance == null
              ? "no estimate"
              : variance === 0
                ? "matches estimate"
                : `${variance > 0 ? "+" : "−"}${fmtUsd(Math.abs(variance))} vs estimate`}
          </span>
        </div>
        <div className="mt-1.5 grid grid-cols-3 gap-2">
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground">Approved</div>
            <NumberInput
              className="h-11 w-full text-right font-mono text-base sm:h-7 sm:text-xs"
              decimals={2}
              defaultValue={i.approved_amount}
              placeholder="not ruled"
              aria-label={`Approved amount for ${i.invoice_number}`}
              onCommit={(next) => {
                if (next !== i.approved_amount) patchInvoice(i.id, { approved_amount: next });
              }}
              disabled={disabled}
            />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] text-muted-foreground">Collected</div>
            {/* The collected figure is the way into what made
              it up — date, method, reference, the photo. */}
            <button
              type="button"
              onClick={() => setHistoryId(i.id)}
              className="min-h-11 text-left font-mono text-sm tabular-nums underline-offset-2 hover:underline sm:min-h-0"
              title={
                paymentsFailed
                  ? "Payment detail failed to load — open for the invoice's own figure."
                  : n
                    ? `${n} payment record${n === 1 ? "" : "s"} — date, method, reference and notes`
                    : "No payment recorded against this invoice yet"
              }
            >
              {fmtUsd(i.collected_amount)}
              {n > 1 && (
                <span className="ml-1 text-[10px] text-muted-foreground">{n} payments</span>
              )}
            </button>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-[11px] text-muted-foreground">Balance due</div>
            <div
              className={cn(
                "font-mono text-sm font-semibold tabular-nums",
                outstandingBalance(i) <= 0 && "text-success",
              )}
            >
              {fmtUsd(Math.max(0, outstandingBalance(i)))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {/* Opens Add payment with this invoice ticked. */}
          {canRecordOn(i) ? (
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-11 sm:h-7"
              onClick={() => openPayment(i)}
              disabled={disabled}
            >
              <Plus className="mr-1 h-3.5 w-3.5" />
              Record payment
            </Button>
          ) : (
            <span className="ml-auto" />
          )}
          {/* Non-modal, as the Payments card's menu: a modal
            menu handing focus to a dialog as it closes can
            leave the page refusing clicks. */}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" aria-label={`More for ${i.invoice_number}`}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-72">
              <DropdownMenuItem onSelect={() => setHistoryId(i.id)}>
                Payment history
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {deleteRule.allowed ? (
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive"
                  disabled={disabled}
                  onSelect={() => removeInvoice(i)}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Delete draft
                </DropdownMenuItem>
              ) : (
                <>
                  <DropdownMenuItem disabled>
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    Delete
                  </DropdownMenuItem>
                  <p className="px-2 pb-1.5 text-[11px] text-muted-foreground">
                    {deleteRule.reason}
                  </p>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <AlertDialog open={!!confirmDelete} onOpenChange={(v) => !v && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete draft {confirmDelete?.invoice_number}?</AlertDialogTitle>
            <AlertDialogDescription>
              This draft was never sent and has no payments. It is removed from the job; you can
              undo for a few seconds afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmDelete) removeInvoice(confirmDelete);
                setConfirmDelete(null);
              }}
            >
              Delete draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {tmBillJob && (
        <TmBillDialog
          open={!!tmBillJob}
          onOpenChange={(o) => !o && setTmBillJob(null)}
          job={tmBillJob}
          creating={creatingInvoice}
          onCreateDraft={(bill, layout) => void newInvoice({ tmBill: bill, tmBillLayout: layout })}
        />
      )}
      <InvoiceReviewDialog
        invoiceId={reviewInvoiceId}
        onOpenChange={(v) => {
          if (v || !reviewInvoiceId) return;
          // The review pop-up has its own Edit tab; closing it returns to the list.
          setReviewInvoiceId(null);
          void load();
        }}
        onChanged={() => void load()}
        onMarkPaid={() => {
          const inv = invoices.find((i) => i.id === reviewInvoiceId);
          if (inv) markPaid(inv);
        }}
        canMarkPaid={(() => {
          const inv = invoices.find((i) => i.id === reviewInvoiceId);
          return inv ? mayMarkPaid(inv) : false;
        })()}
        extra={<JobReferralFeeLine jobId={jobId} />}
      />
      <AccountDiscountCallout accountId={jobAccountId ?? null} />
      <ResolveJobTypePrompt jobId={jobId} jobType={jobType} onResolved={onJobTypeResolved} />
      {/* Billing & Costs P4: which rates this job prices at. */}
      <JobRateSource job={{ id: jobId, account_id: jobAccountId, job_type: jobType ?? null }} />
      {/*
       * ESTIMATES LEFT, INVOICES RIGHT, PAYMENTS UNDERNEATH.
       *
       * David, 22 Sep, walking a job: "estimates should be here on the left
       * side, and invoices on the right side... the split screen makes more
       * sense. And then we have to have payments also, payments underneath it."
       *
       * THIS SUPERSEDES THE 16 SEP RAIL PLACEMENT, at the client's request.
       * Mark, 2026-09-16, of an Estimates card here beside an Estimate panel in
       * the rail: "and the estimates is a duplicate, just have the sidebar" —
       * so the list moved to the rail. /billing got David's split on 22 Sep;
       * the job tab kept Mark's rail until this change. Mark's actual rule
       * still holds: there is ONE estimates list and ONE Detailed-estimate
       * button on the job, merged the way /billing merges (lib/billing-
       * estimates). It is simply on the left of the money column now instead of
       * in the rail. The rail keeps what is the job's rather than a document's:
       * running cost, the ledger, bill-to, and an open document's own cards.
       *
       * A container query, not a viewport breakpoint: the money column is
       * full width below `xl` and shares the screen with the rail above it, so
       * only its own width says whether two columns fit. Narrower than that —
       * a phone — they stack in reading order: Estimates, Invoices, Payments.
       *
       * Mark, 2026-10-05, looking at the two cards side by side: "these need to
       * line up better and the invoices box needs to be the same size, and the
       * buttons should look like the invoices, and the split shou.d be 50/50."
       *
       * So the split is literally half and half (`@3xl:grid-cols-2`, which is
       * `repeat(2, minmax(0, 1fr))`) instead of the old 1fr/2fr that gave the
       * invoice table the larger share. Estimates had a floor of 20rem from its
       * days in the rail; half of the `@3xl` container is already wider than
       * that, so the floor was doing nothing but fighting the even split and it
       * has gone. The nine-column invoice table was the reason for the bigger
       * share, and it has not needed one since the editors started opening full
       * width underneath — the table scrolls inside its own card.
       *
       * SAME SIZE means equal height too, so the grid stretches (no
       * `items-start`) and both cards are `h-full`. Stretching, not a fixed
       * height: a job with three estimates must not clip, and the taller card
       * should be whichever one actually has more in it.
       */}
      <div className="@container">
        <div className="grid gap-3 @3xl:grid-cols-2">
          <section aria-label="Estimates" className="min-w-0">
            <Card className="h-full">
              {/*
                The header is the Invoices header, class for class — same
                default card padding, same bottom border, same flex row — so
                the two titles sit on one baseline and both bodies start at the
                same height. Estimates used to run `p-4 pb-2` / `p-4 pt-0` with
                no rule under the title, which is most of why the pair read as
                ragged. Keep the two strings identical if either moves.

                `flex-wrap` is on both: the estimate buttons carry wider words
                than the invoice ones, and below about 340px — a small phone,
                which the crews do carry — they ran off the end of the card.
                Wrapping under the title costs nothing at any width where they
                fit, and the cards are stacked by then anyway.
              */}
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Estimates</CardTitle>
                <div className="flex items-center gap-2">
                  {/*
                    Two ways in, because David asked for a simpler one. "Quick Estimate"
                    — his own name for it on 17 Sep, replacing "Basic estimate" — opens
                    the Job Calculator — the plain click-down list of labour,
                    equipment and fees, already filled in from this job — and what it
                    saves lands in this same list, labelled as the calculator's.
                    "Detailed" is the carrier-facing document with scopes, versions and
                    line catalogue, which is the right tool for a negotiation and far too
                    much for a number on a driveway.

                    Both are `outline` now, in the header, auto width: Mark asked
                    for "the buttons should look like the invoices", and Invoices
                    runs Quick invoice and + New invoice as a matched outline pair
                    up there. Quick Estimate was the filled primary and carried a
                    calculator icon; nothing in the history says that emphasis was
                    asked for — David's 17 Sep note about Quick invoice was the
                    opposite complaint, that it did not read as a button at all —
                    and a filled button next to an outline one is exactly the
                    mismatch he is pointing at. Matched to Invoices.
                  */}
                  {calculatorSeed && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => setCalculatorOpen(true)}
                    >
                      Quick Estimate
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={disabled || creating}
                    onClick={() => void newEstimate()}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {creating ? "Creating…" : "Detailed estimate"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <EstimatesRailList
                  rows={mergeJobEstimates(estimates, calculations).filter(
                    (r) => !removing.has(r.key),
                  )}
                  estimates={estimates}
                  invoices={invoices}
                  loading={loading}
                  openId={openEstimateId}
                  onOpen={setOpenEstimateId}
                  onConvert={(id) => void convert(id)}
                  onConvertCalculation={
                    calcConvertSupported ? (id) => void convertCalculation(id) : undefined
                  }
                  converting={converting}
                  disabled={disabled}
                  deleteSupport={deleteSupport}
                  onDelete={removeEstimate}
                />
              </CardContent>
            </Card>
          </section>

          <section aria-label="Invoices" className="min-w-0">
            <Card className="h-full">
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                <CardTitle className="text-base">Invoices</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  {/*
                    David, 17 Sep: "why is the quick invoice like a button, like the
                    other one? It's clickable, but it doesn't show up as a button."
                    It was `ghost` — no border, no fill — sitting beside an `outline`
                    neighbour that does the same kind of thing. Matched to it.
                  */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setQuickOpen(true)}
                    disabled={disabled || creatingInvoice}
                  >
                    Quick invoice
                  </Button>
                  {/*
                    David, 22 Oct: "a third button here that accomplishes the
                    pull from job invoice… near the quick invoice and new
                    invoice — to eliminate additional steps in the office."
                    One press does what Quick invoice → Pull from job did: a
                    draft with the job's approved hours (at the office's
                    charge rate, Settings › Labor rates) and its scanned
                    equipment, opened in the review pop-up. Nothing is sent.
                  */}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void newInvoice({ pull: true })}
                    disabled={disabled || creatingInvoice}
                    title="A draft invoice of the job's field items: approved hours at the charge rate, plus scanned equipment"
                    data-field-items-invoice
                  >
                    Field items
                  </Button>
                  {/*
                    David, 26 Oct: the weekly T&M invoice package ("Lallypak
                    Week 1") from the daily T&M forms — T&M jobs only.
                    See src/lib/tm-bill.ts.
                  */}
                  {isTmJob(jobType) && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void jobPrefill()
                          .then(setTmBillJob)
                          .catch((e) => toastDbError(e, { action: "Open the T&M bill" }))
                      }
                      disabled={disabled || creatingInvoice}
                      title="The week's T&M bill from the daily sign-in sheets, supply lists and equipment"
                      data-tm-bill
                    >
                      T&amp;M bill
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void newInvoice()}
                    disabled={disabled || creatingInvoice}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    {creatingInvoice ? "Creating…" : "New invoice"}
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {visibleInvoices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing billed yet. The customer is never invoiced — invoices here are raised
                    against the carrier.
                  </p>
                ) : (
                  <>
                    {/*
                      The referral line and the Billed / Approved / Collected /
                      Absorbed tiles that sat here are gone (31 Oct): the job
                      ledger above already shows Billed, Paid, Referral and
                      Commission.
                    */}
                    {/*
                      ONE ROW PER INVOICE, NOT A TABLE. Mark, 2026-10-06: "need to
                      rework this box to make more sense". It was an eight-column
                      table in half a split — about 400–600px at desktop widths —
                      so the invoice number broke across three lines, the carrier
                      wrapped under it, and the card grew a sideways scrollbar.
                      No table of these columns fits the width this card actually
                      has, at any screen size, so each invoice is a row laid out
                      like the Estimates rows beside it (#267): the number on one
                      line and the billed amount opposite, who it is billed to
                      underneath, then the money, then the actions. On a phone
                      this is the card-per-row shape `<Table cards>` gives a
                      table, without a table that never fits anywhere else.
                    */}
                    {/*
                      Two invoices side by side once the card is wide enough
                      for two (29 Oct: "show two box in one row"). A container
                      query, not a screen breakpoint: this card is half a split
                      at desktop widths and the whole width on a phone.
                    */}
                    <BillingBoxList label="Invoices" data-invoice-boxes>
                      {visibleInvoices.map((i) => {
                        const open = openInvoiceId === i.id;
                        const balance = Math.max(0, outstandingBalance(i));
                        /* The card says which invoice and where it stands; the
                             money controls, payments and the rest are in the
                             pop-up the number opens (3 Nov: "only mandatory
                             things … show in pop up detail"). */
                        return (
                          <li
                            key={i.id}
                            className={cn(BILLING_BOX, open && "border-primary/40 bg-primary/5")}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex min-w-0 items-baseline gap-1.5">
                                {/* The number opens the invoice pop-up. */}
                                <button
                                  type="button"
                                  className="whitespace-nowrap rounded-sm font-mono text-[13px] font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={() => setOpenInvoiceId(i.id)}
                                  aria-haspopup="dialog"
                                  title={`Open ${i.invoice_number}`}
                                >
                                  {i.invoice_number}
                                </button>
                                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                                  v{i.current_version ?? 1}
                                </span>
                              </div>
                              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                                <Badge className={INVOICE_STATUS_TONE[i.status]}>
                                  {INVOICE_STATUS_LABEL[i.status]}
                                </Badge>
                                {/* 4 Nov: Preview sits by the status, PDF stays by the amount. */}
                                <span className="-my-1">
                                  <DocumentPreviewButton
                                    kind="invoice"
                                    id={i.id}
                                    iconOnly
                                    size="icon"
                                    variant="ghost"
                                  />
                                </span>
                                {balance > 0 ? (
                                  <span className="truncate text-[11px] tabular-nums text-muted-foreground">
                                    {fmtUsd(balance)} due
                                  </span>
                                ) : i.billed_amount > 0 ? (
                                  <span className="text-[11px] font-medium text-success">
                                    Settled
                                  </span>
                                ) : null}
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-0.5">
                              <span className="font-mono text-sm font-semibold tabular-nums">
                                {fmtUsd(i.billed_amount)}
                              </span>
                              <div className="-mr-1.5 flex items-center">
                                {canDeleteFromList(i) && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="size-8 text-muted-foreground hover:text-destructive"
                                    aria-label={`Delete draft ${i.invoice_number}`}
                                    title="Delete this draft"
                                    disabled={disabled}
                                    onClick={() => setConfirmDelete(i)}
                                    data-invoice-delete
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                )}
                                <ReportFiltersButton kind="invoice" id={i.id} variant="ghost" />
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </BillingBoxList>
                  </>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
      </div>

      {/*
       * The open estimate. A nine-column line table has one place it fits,
       * and it is not half a split; the editor expands here, under the split
       * and the full width of the money column, and its own header carries the
       * Sheet/Table toggle, Convert, Preview and Versions. This strip only says
       * which document is open and closes it.
       */}
      {openEstimate && (
        <div
          ref={openEstimateRef}
          className="scroll-mt-[var(--job-header-h,0px)] rounded-sm border"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                className="grid size-11 shrink-0 place-items-center text-muted-foreground sm:size-5"
                onClick={() => setOpenEstimateId(null)}
                aria-label="Collapse estimate"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
              <span className="font-mono text-xs text-primary">
                {estimateLabel(openEstimate.seq)}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                v{openEstimate.current_version ?? 1}
              </span>
              <span className="truncate text-sm font-medium">{openEstimate.title ?? "Scope"}</span>
              <Badge className={ESTIMATE_STATUS_TONE[openEstimate.status]}>
                {ESTIMATE_STATUS_LABEL[openEstimate.status]}
              </Badge>
            </div>
            <span className="font-mono text-sm font-semibold">{fmtUsd(openEstimate.total)}</span>
          </div>
          <div className="border-t bg-muted/20 p-3">
            <EstimateEditor estimateId={openEstimate.id} embedded onChanged={() => void load()} />
          </div>
        </div>
      )}

      {/*
       * The open invoice, the same way and for the same reason. It used to
       * open as a row inside the invoice table; with the table now the right
       * half of a split, an editor inside it would get half the width its line
       * table needs. Expanding a row opens it here instead, under the split.
       */}
      <Dialog
        open={openInvoice != null}
        onOpenChange={(v) => {
          if (!v) setOpenInvoiceId(null);
        }}
      >
        <DialogContent
          className="flex max-h-[92svh] w-full max-w-5xl flex-col gap-0 p-0"
          data-invoice-open
        >
          {openInvoice && (
            <>
              <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left">
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{openInvoice.invoice_number}</span>
                  <span className="font-mono text-xs font-normal text-muted-foreground">
                    v{openInvoice.current_version ?? 1}
                  </span>
                  <span className="ml-auto font-mono text-base">
                    {fmtUsd(openInvoice.billed_amount)}
                  </span>
                </DialogTitle>
                <DialogDescription>
                  {openInvoice.carrier ?? "No carrier"} ·{" "}
                  {openInvoice.claim_number ? `claim ${openInvoice.claim_number}` : "no claim #"}
                </DialogDescription>
              </DialogHeader>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                {invoiceTools(openInvoice)}
                <InvoiceEditor
                  invoiceId={openInvoice.id}
                  embedded
                  onChanged={() => void load()}
                  onMarkPaid={() => markPaid(openInvoice)}
                  canMarkPaid={mayMarkPaid(openInvoice)}
                />
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/*
       * PAYMENTS, underneath — David: "payments underneath it". Every payment
       * on the job, across its invoices, newest first: the rows the Collected
       * figures above are made of. A row opens that invoice's payment
       * history, which is where a payment is corrected.
       *
       * Mark, 2026-10-06, of this card saying "Use Record payment on the
       * invoice it pays": "add a add payment button here". The card used to
       * send people off to find the invoice row. Add payment is in the header
       * now, shaped and placed like the Estimates and Invoices header buttons
       * (#267 matched those two; the header and body classes below are
       * theirs, so all three cards start on one rhythm).
       *
       * Mark, 2026-10-07, showing JobNimbus's Add Payment: "make this pop up
       * for add payment, just with our look, and allow them to check an
       * invoice it's applying to." So it no longer guesses the invoice or
       * asks in a menu: it opens the Add payment dialog with nothing ticked,
       * the same dialog every Record payment button opens ticked. It is
       * hidden for anyone the invoice_payments write policy would refuse.
       * With no invoice it is disabled and the sentence underneath says why —
       * a payment has to belong to an invoice, and making one up to hang it
       * on would put a figure on the carrier's books that nobody chose.
       */}
      <section aria-label="Payments" className="min-w-0">
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <CardTitle className="text-base">Payments</CardTitle>
            {showAddPayment ? (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || payable.length === 0}
                title={
                  payable.length === 0
                    ? "A payment is recorded against an invoice — create the invoice first."
                    : undefined
                }
                onClick={() => openPayment()}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add payment
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-3">
            {paymentsFailed ? (
              <p className="text-sm text-destructive">
                Payment records could not be loaded, so this list is missing rather than empty. The
                collected figures on the invoices come from the invoices themselves and are still
                correct.
              </p>
            ) : payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {invoices.length === 0
                  ? "No payments yet. A payment is recorded against an invoice, so create the invoice first — Quick invoice takes a single amount."
                  : "No payment recorded yet. Add payment records one against the invoice it pays."}
              </p>
            ) : (
              <Table cards>
                <TableHeader>
                  <TableRow>
                    <TableHead>Received</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Method</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Recorded by</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => {
                    const inv = invoices.find((i) => i.id === p.invoice_id);
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="whitespace-nowrap text-sm tabular-nums">
                          {new Date(p.received_at + "T00:00:00").toLocaleDateString(
                            DATE_LOCALE,
                            US_DATE,
                          )}
                        </TableCell>
                        <TableCell data-label="Invoice" className="font-mono text-xs">
                          {inv?.invoice_number ?? "Invoice"}
                          {/* One cheque split across invoices is a row per
                              invoice; say which others it paid. */}
                          {siblings.has(p.id) ? (
                            <span className="block font-sans text-[11px] text-muted-foreground">
                              Split across{" "}
                              {[p, ...siblings.get(p.id)!]
                                .map(
                                  (r) =>
                                    invoices.find((i) => i.id === r.invoice_id)?.invoice_number ??
                                    "an invoice",
                                )
                                .join(", ")}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell data-label="Method" className="text-sm">
                          {p.method ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell data-label="Reference" className="font-mono text-xs">
                          {p.reference ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell
                          data-label="Amount"
                          className="text-right font-mono text-sm tabular-nums"
                        >
                          {fmtUsd(p.amount, { cents: true })}
                        </TableCell>
                        <TableCell
                          data-label="Recorded by"
                          className="text-xs text-muted-foreground"
                        >
                          {p.created_by ? recordedBy[p.created_by] || "Unnamed user" : "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-col gap-1 sm:flex-row sm:justify-end">
                            {/* The receipt for this payment (built 2 Sep, on
                                no screen until 12 Nov): preview it, or file
                                it and open the email composer. */}
                            <span
                              data-payment-receipt
                              className="contents [&_button]:h-11 [&_button]:w-full sm:[&_button]:h-7 sm:[&_button]:w-auto"
                            >
                              <SendReceiptButton paymentId={p.id} jobId={jobId} />
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-11 w-full sm:h-7 sm:w-auto"
                              onClick={() => setHistoryId(p.invoice_id)}
                            >
                              History
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      {calculatorSeed && (
        <JobCalculatorDialog
          open={calculatorOpen}
          onOpenChange={(open) => {
            setCalculatorOpen(open);
            // A calculation saved in there attaches to this job, so the
            // estimates list should show it on the way back out.
            if (!open) void load();
          }}
          job={calculatorSeed}
        />
      )}

      <Dialog open={quickOpen} onOpenChange={setQuickOpen}>
        {/* On a phone a centred box is what puts the confirm button under the
            software keyboard: take the width, cap the height, let the body
            scroll so the footer is always reachable. */}
        <DialogContent className="max-h-[85svh] max-w-[calc(100vw-1.5rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Quick invoice</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {/*
              The flagship path. David, 24 Sep: "It should pull in — we had 30
              hours of labor and 15 pieces of equipment... you're essentially
              writing up the bill as you do the job." It opens an itemized
              invoice with the job's breakdown beside it; the lines go in on
              one press and stay editable. Works the same on a cash job.
            */}
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-sm font-medium">Build it from the job</p>
              <p className="text-xs text-muted-foreground">
                The approved hours and the scanned equipment, priced at this customer&rsquo;s charge
                rates — you check and edit the lines before anything is sent.
              </p>
              <Button
                className="mt-2 h-11 w-full sm:h-8 sm:w-auto"
                disabled={disabled || creatingInvoice}
                onClick={() => {
                  setQuickOpen(false);
                  void newInvoice({ pull: true });
                }}
              >
                Pull from job
              </Button>
            </div>
            <p className="text-sm font-medium" data-simple-invoice>
              Simple mode
            </p>
            <p className="text-sm text-muted-foreground">
              Description, amount and due date — no line items, no tax. Carrier, claim and billing
              office come from this job. Use <span className="font-medium">New invoice</span> for
              the full builder.
            </p>
            <div>
              <Label>Description</Label>
              <Input
                className={MOBILE_FIELD}
                value={quickDraft.description}
                onChange={(e) => setQuickDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="e.g. Water mitigation, 3 days"
                maxLength={200}
              />
            </div>
            <div>
              <Label>Billed amount</Label>
              <NumberInput
                decimals={2}
                allowMath
                className={MOBILE_FIELD}
                value={quickDraft.billed}
                onValueChange={(_, clean) => setQuickDraft((d) => ({ ...d, billed: clean }))}
              />
            </div>
            <div>
              <Label>Due date</Label>
              <Input
                type="date"
                className={MOBILE_FIELD}
                value={quickDraft.due}
                onChange={(e) => setQuickDraft((d) => ({ ...d, due: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              className="h-11 w-full sm:h-8 sm:w-auto"
              onClick={createQuickInvoice}
              disabled={disabled || creatingInvoice}
            >
              Create quick invoice
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!historyInvoice} onOpenChange={(v) => !v && setHistoryId(null)}>
        <DialogContent className="max-h-[85svh] max-w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-2xl">
          <DialogHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
            <DialogTitle>Payment history · {historyInvoice?.invoice_number}</DialogTitle>
            {historyInvoice && canRecordOn(historyInvoice) ? (
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-8"
                disabled={disabled}
                onClick={() => {
                  setHistoryId(null);
                  openPayment(historyInvoice);
                }}
              >
                <Plus className="mr-1 h-3.5 w-3.5" /> Record payment
              </Button>
            ) : null}
          </DialogHeader>
          {historyInvoice && (
            <PaymentHistory
              invoice={historyInvoice}
              rows={payments.filter((p) => p.invoice_id === historyInvoice.id)}
              failed={paymentsFailed}
              recordedBy={recordedBy}
              canEdit={!disabled}
              onEdit={setEditingPayment}
              changes={(changesQ.data ?? []).filter((c) => c.invoice_id === historyInvoice.id)}
            />
          )}
        </DialogContent>
      </Dialog>

      {editingPayment ? (
        <PaymentEditDialog
          key={editingPayment.id}
          payment={editingPayment}
          methods={PAYMENT_METHODS}
          invoiceNumber={
            invoices.find((i) => i.id === editingPayment.invoice_id)?.invoice_number ?? "Invoice"
          }
          open
          onOpenChange={(v) => !v && setEditingPayment(null)}
          onSaved={afterPaymentChange}
        />
      ) : null}

      <AddPaymentDialog
        open={!!payOpen}
        jobId={jobId}
        jobLocationId={jobLocationId}
        jobAccountId={jobAccountId}
        invoices={payDialogInvoices}
        preselectId={payOpen?.preselectId ?? null}
        attachmentsSupported={attachmentsSupported}
        disabled={disabled}
        userId={app.userId ?? null}
        onClose={closePayment}
      />
    </div>
  );
}

/**
 * The photographed cheque, served through `/api/documents/:id/file` — that
 * route is same-origin and authorises the read, where a `blob:` URL is refused
 * outright by an ad blocker.
 *
 * A remittance advice is as often a PDF, and an `<img>` cannot show one. A
 * source that will not render collapses to the plain link rather than leaving a
 * broken frame that reads as a lost photo.
 */
function PaymentAttachment({ documentId }: { documentId: string }) {
  const [renderable, setRenderable] = useState(true);
  const url = documentFileUrl(documentId);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title="Open the filed image"
      className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-sm border"
    >
      {renderable ? (
        <img
          src={url}
          alt="Payment attachment"
          onError={() => setRenderable(false)}
          className="h-full w-full object-cover"
        />
      ) : (
        <Paperclip className="h-4 w-4" />
      )}
    </a>
  );
}

/**
 * The invoice's own collected_amount / uncollected are the figures of record —
 * they are what every other screen, report and export quotes. Summing the
 * payment rows here would be a second, competing answer, so the sum is used
 * only to check the detail against the record, never to replace it.
 */
function PaymentHistory({
  invoice,
  rows,
  failed,
  recordedBy,
  canEdit,
  onEdit,
  changes,
}: {
  invoice: Invoice;
  rows: Payment[];
  failed: boolean;
  recordedBy: Record<string, string>;
  canEdit: boolean;
  /** David, 24 Sep: "payments have to be editable." */
  onEdit: (p: Payment) => void;
  /** What has been corrected or removed on this invoice, newest first. */
  changes: PaymentChange[];
}) {
  const collected = Number(invoice.collected_amount);
  const detailSum = rows.reduce((s, p) => s + Number(p.amount), 0);
  /* Half a cent of slack — these are numeric columns summed in float. */
  const short = collected - detailSum;
  const reconciled = Math.abs(short) < 0.005;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Tile label="Billed" value={fmtUsd(invoice.billed_amount)} />
        <Tile label="Paid" value={fmtUsd(collected)} />
        <Tile
          label="Outstanding"
          value={fmtUsd(Number(invoice.uncollected))}
          tone={Number(invoice.uncollected) > 0 ? "text-destructive" : undefined}
        />
      </div>

      {failed ? (
        <p className="text-sm text-destructive">
          The payment records for this invoice could not be loaded, so the breakdown below is
          missing rather than empty. {fmtUsd(collected)} is the invoice's own collected figure and
          is unaffected.
        </p>
      ) : (
        <>
          {!reconciled && (
            <p className="text-xs text-warning">
              These {rows.length} record{rows.length === 1 ? "" : "s"} add to{" "}
              <span className="tabular-nums">{fmtUsd(detailSum, { cents: true })}</span>, but the
              invoice is carrying{" "}
              <span className="tabular-nums">{fmtUsd(collected, { cents: true })}</span> as
              collected. The invoice figure is the one shown above and the one to trust — the detail
              here is incomplete
              {short > 0 ? " (a payment landed without a record)" : " (a record is not counted)"}.
            </p>
          )}
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No payment has been recorded against this invoice yet. Use{" "}
              <span className="font-medium">Record payment</span> to add one.
            </p>
          ) : (
            // Cards below md, like the Payments list on the tab itself. Seven
            // columns in a 344px dialog scrolled sideways, with Edit last.
            <Table cards>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead>Photo</TableHead>
                  <TableHead>Recorded by</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((p) => (
                  <Fragment key={p.id}>
                    <TableRow className={p.notes ? "border-b-0" : undefined}>
                      <TableCell className="whitespace-nowrap text-sm">
                        {new Date(p.received_at + "T00:00:00").toLocaleDateString(
                          DATE_LOCALE,
                          US_DATE,
                        )}
                      </TableCell>
                      <TableCell
                        data-label="Amount"
                        className="text-right font-mono text-sm tabular-nums"
                      >
                        {fmtUsd(p.amount, { cents: true })}
                      </TableCell>
                      <TableCell data-label="Method" className="text-sm">
                        {p.method ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell data-label="Reference" className="font-mono text-xs">
                        {p.reference ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell data-label="Photo">
                        {p.document_id ? (
                          <PaymentAttachment documentId={p.document_id} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell data-label="Recorded by" className="text-xs text-muted-foreground">
                        {p.created_by ? recordedBy[p.created_by] || "Unnamed user" : "—"}
                      </TableCell>
                      {/* The note joins its own card on a phone. md:hidden is
                          enough here: the card rules only exist below md. */}
                      {p.notes && (
                        <TableCell data-label="Note" className="text-xs md:hidden">
                          {p.notes}
                        </TableCell>
                      )}
                      {/* With nothing to show, the actions cell would be an
                          empty 40px line on the card. The important flag is
                          needed because the card rules are unlayered and
                          beat any plain utility (styles.css, section 6). */}
                      <TableCell className={canEdit ? "text-right" : "text-right max-md:hidden!"}>
                        {canEdit ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-11 w-full sm:h-7 sm:w-auto"
                            aria-label={`Correct the ${fmtUsd(p.amount, { cents: true })} payment`}
                            onClick={() => onEdit(p)}
                          >
                            <Pencil className="mr-1 h-3.5 w-3.5" /> Edit
                          </Button>
                        ) : null}
                      </TableCell>
                    </TableRow>
                    {/* Desktop only: below md the note is a line on the
                        card above, and this row would be a card of its own. */}
                    {p.notes && (
                      <TableRow className="max-md:hidden!">
                        <TableCell colSpan={7} className="pt-0 text-xs text-muted-foreground">
                          {p.notes}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          )}
          {changes.length ? (
            <section aria-label="Corrections" className="space-y-1 border-t pt-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                History of changes
              </h3>
              <ul className="space-y-1 text-xs">
                {changes.map((c) => (
                  <li key={c.id}>
                    <span className="font-medium">{describePaymentChange(c)}</span>
                    <span className="text-muted-foreground">
                      {" "}
                      — {c.changed_by_name ?? "a colleague"},{" "}
                      {new Date(c.created_at).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {c.reason ? ` · “${c.reason}”` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone?: string;
  /** What the figure counts, on hover — the line under the tiles says the rest. */
  hint?: string;
}) {
  return (
    <div className="rounded-sm border bg-card p-2" title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <FitText className={`font-mono text-lg font-semibold ${tone ?? ""}`}>{value}</FitText>
    </div>
  );
}
