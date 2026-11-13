import { useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Camera, Check, Plus, Receipt as ReceiptIcon, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { localDateStr } from "@/lib/expenses";
import { readSupplyReceipt } from "@/lib/supply-receipts.functions";
import {
  BLANK_LINE,
  RECEIPT_APPROVAL_PENDING,
  RECEIPT_STAGE_LABEL,
  RECEIPT_STAGE_TONE,
  alertReceiptReviewer,
  approvalFormFrom,
  approvalFormTotal,
  approveReceipt,
  lineAmount,
  listSupplyReceipts,
  receiptApprovalAvailable,
  receiptDecision,
  receiptDecisionErrorText,
  receiptStage,
  receiptTotal,
  rejectReceipt,
  saveReceiptDraft,
  uploadSupplyReceipt,
  validateApprovalForm,
  type ApprovalForm,
  type EditableLine,
  type SupplyReceipt,
} from "@/lib/supply-receipts";
import { signedPhotoUrl } from "@/lib/job-photos";
import { cn } from "@/lib/utils";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Photograph a receipt from the till, and let somebody know.
 *
 * David, 17 Sep: "if somebody goes into Home Depot and just buys an item off
 * the shelf, they should be able to take a picture of the receipt and upload
 * it to the system... if the system can read the receipt, that'll be great...
 * But if not, at the very minimum it should send an alert to somebody — to be
 * determined — that a receipt was uploaded by so-and-so."
 *
 * The alert is the product; the read is the bonus. So the upload finishes — and
 * the reviewer is told — before any model is asked to look at it, and a receipt
 * nothing could read is a normal row with a normal "enter it by hand", not an
 * error.
 *
 * Mark, 5 Oct, added the half that was missing: "need to get approved just to
 * add to purchase tracking." So the upload is also the submission, and nothing
 * reaches purchase tracking until somebody other than the uploader approves
 * it in ReceiptReviewDialog. The database enforces that, not this file.
 *
 * `capture="environment"` on the input is what makes the camera open straight
 * away on a phone. A tech standing at a till should not be choosing a file.
 */
/**
 * The upload itself — picture, row, alert, then the read — shared by the
 * Spending card, an order's own "Attach receipt" and the crew's Receipts page.
 * One receipt system, several doorways: an order adds `requestId`, a job adds
 * `jobId`, and nothing else differs.
 */
export function useReceiptUpload(input: {
  locationId: string;
  userId: string;
  uploaderName: string;
  requestId?: string | null;
  jobId?: string | null;
}) {
  const { locationId, userId, uploaderName, requestId, jobId } = input;
  const qc = useQueryClient();
  const read = useServerFn(readSupplyReceipt);
  const [busy, setBusy] = useState(false);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const receipt = await uploadSupplyReceipt({
        file,
        locationId,
        jobId: jobId ?? null,
        requestId: requestId ?? null,
        userId,
        uploaderName,
      });

      /*
       * Everything below is the bonus. The picture is stored and the alert has
       * gone by this point, so a failure here leaves a perfectly usable
       * receipt waiting to be typed in rather than losing anything.
       */
      try {
        const dataUrl = await toDataUrl(file);
        const result = await read({ data: { image_data_url: dataUrl } });
        if (result.ok) {
          await saveReceiptDraft(receipt.id, result.draft);
          // A second alert only when the read added something worth acting on.
          await alertReceiptReviewer({
            receiptId: receipt.id,
            locationId,
            uploaderId: userId,
            uploaderName,
            draft: result.draft,
          });
          return { receipt, readable: true };
        }
        await saveReceiptDraft(receipt.id, null);
      } catch (err) {
        console.error("[supplies] receipt read failed", err);
      }
      return { receipt, readable: false };
    },
    onSuccess: (r) => {
      toast.success(requestId ? "Receipt attached to the order" : "Receipt sent for approval", {
        description: r.readable
          ? "Read into a draft. A manager checks it and approves it into purchase tracking."
          : "It could not be read automatically. A manager will enter it from the photo.",
      });
      void qc.invalidateQueries({ queryKey: ["supply-receipts"] });
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "upload this receipt" });
    },
    onSettled: () => setBusy(false),
  });

  const start = (file: File) => {
    setBusy(true);
    upload.mutate(file);
  };
  return { start, busy };
}

/** A hidden camera input and the button that opens it. */
export function ReceiptCameraButton({
  onFile,
  disabled,
  busy,
  label,
  size = "sm",
}: {
  onFile: (file: File) => void;
  disabled?: boolean;
  busy: boolean;
  label: string;
  /** "lg" is the crew page's one big button — a gloved thumb, at a till. */
  size?: "sm" | "default" | "lg";
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      <Button
        size={size === "lg" ? "lg" : size}
        variant={size === "default" ? "outline" : "default"}
        className={cn(
          size === "default" && "h-11 md:h-9",
          size === "lg" && "h-14 w-full text-base md:h-11 md:w-auto",
        )}
        disabled={disabled || busy}
        onClick={() => fileRef.current?.click()}
      >
        <Camera className={cn("mr-1.5", size === "lg" ? "size-5" : "size-4")} />
        {busy ? "Uploading…" : label}
      </Button>
    </>
  );
}

export function SupplyReceiptPanel({
  locationId,
  userId,
  uploaderName,
}: {
  locationId: string;
  userId: string;
  uploaderName: string;
}) {
  const { start, busy } = useReceiptUpload({ locationId, userId, uploaderName });

  const receiptsQ = useQuery({
    queryKey: ["supply-receipts", locationId],
    queryFn: () => listSupplyReceipts(locationId),
    enabled: !!locationId,
  });

  const receipts = receiptsQ.data ?? [];

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-base">Receipts</CardTitle>
        <ReceiptCameraButton
          onFile={start}
          disabled={!locationId}
          busy={busy}
          label="Photograph a receipt"
        />
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        <p className="text-xs text-muted-foreground">
          Bought something off the shelf? Photograph the receipt. A reviewer is told straight away,
          and it reaches purchase tracking once somebody other than the uploader approves it.{" "}
          <Link to="/receipts" className="underline underline-offset-2">
            All receipts
          </Link>
        </p>
        {receipts.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">No receipts uploaded yet.</p>
        ) : (
          <ReceiptList receipts={receipts} userId={userId} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Receipts as rows, with who uploaded each and which job it was for — names
 * and job numbers fetched once for the list rather than once per row.
 */
export function ReceiptList({
  receipts,
  userId,
  showUploader = true,
}: {
  receipts: SupplyReceipt[];
  userId: string;
  showUploader?: boolean;
}) {
  const people = useMemo(
    () => [...new Set(receipts.map((r) => r.uploaded_by).filter((v): v is string => !!v))],
    [receipts],
  );
  const jobs = useMemo(
    () => [...new Set(receipts.map((r) => r.job_id).filter((v): v is string => !!v))],
    [receipts],
  );

  const namesQ = useQuery({
    queryKey: ["supply-receipts", "people", people],
    enabled: showUploader && people.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", people);
      return new Map((data ?? []).map((p) => [p.user_id, p.full_name ?? ""]));
    },
  });
  const jobsQ = useQuery({
    queryKey: ["supply-receipts", "jobs", jobs],
    enabled: jobs.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("id, job_number, job_name")
        .in("id", jobs);
      return new Map(
        (data ?? []).map((j) => [j.id, [j.job_number, j.job_name].filter(Boolean).join(" · ")]),
      );
    },
  });

  return (
    <div className="space-y-2">
      {receipts.map((r) => (
        <ReceiptRow
          key={r.id}
          receipt={r}
          userId={userId}
          uploaderName={
            showUploader && r.uploaded_by
              ? r.uploaded_by === userId
                ? "You"
                : namesQ.data?.get(r.uploaded_by) || "A colleague"
              : null
          }
          jobLabel={r.job_id ? (jobsQ.data?.get(r.job_id) ?? "a job") : null}
        />
      ))}
    </div>
  );
}

/**
 * One receipt: what was read, where it stands, and — for somebody allowed to
 * decide it — the button that opens the approval.
 *
 * There is no "Confirm" any more. The old one wrote `supply_purchases`
 * straight from this row for whoever could see it, the uploader included, so
 * a manager could put their own spend into the books unchecked. Approving now
 * happens in ReceiptReviewDialog, through approve_supply_receipt, which
 * refuses the uploader and anybody without authority over the office.
 */
function ReceiptRow({
  receipt,
  userId,
  uploaderName,
  jobLabel,
}: {
  receipt: SupplyReceipt;
  userId: string;
  uploaderName?: string | null;
  jobLabel?: string | null;
}) {
  const [reviewing, setReviewing] = useState(false);
  const draft = receipt.parsed;
  const confirmed = receipt.approved_lines;
  const total = confirmed ? Number(confirmed.total) : draft ? receiptTotal(draft) : null;
  const stage = receiptStage(receipt.status);
  const decision = receiptDecision(receipt, userId);

  const openPicture = async () => {
    const url = await signedPhotoUrl(receipt.storage_bucket, receipt.storage_path);
    if (url) window.open(url, "_blank", "noopener");
    else toast.error("That receipt image could not be opened.");
  };

  const detail = [
    new Date(receipt.created_at).toLocaleDateString(DATE_LOCALE, US_DATE),
    uploaderName ? `by ${uploaderName}` : null,
    jobLabel ? `for ${jobLabel}` : null,
    stage === "pending" && draft
      ? `${draft.lines.length} line${draft.lines.length === 1 ? "" : "s"} read`
      : null,
    stage === "pending" && receipt.status === "unreadable" ? "could not be read" : null,
  ].filter(Boolean);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border p-2">
      <ReceiptIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <span className="truncate">
            {confirmed?.supplier ?? draft?.supplier ?? "Receipt"}
            {total != null ? ` · $${total.toFixed(2)}` : ""}
          </span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[11px] font-medium",
              RECEIPT_STAGE_TONE[stage],
            )}
          >
            {RECEIPT_STAGE_LABEL[stage]}
          </span>
        </p>
        <p className="text-xs text-muted-foreground">{detail.join(" · ")}</p>
        {stage === "rejected" && receipt.rejection_reason && (
          <p className="mt-1 text-xs text-destructive">Reason: {receipt.rejection_reason}</p>
        )}
      </div>
      <Button size="sm" variant="ghost" className="h-9" onClick={openPicture}>
        View
      </Button>
      {decision.allowed ? (
        <Button size="sm" className="h-9" onClick={() => setReviewing(true)}>
          <Check className="mr-1 size-3.5" /> Review
        </Button>
      ) : null}
      {decision.allowed && reviewing && (
        <ReceiptReviewDialog receipt={receipt} open={reviewing} onOpenChange={setReviewing} />
      )}
    </div>
  );
}

/**
 * The approver's screen: the photo beside the AI's draft, every figure
 * editable, then Approve or Not approved.
 *
 * What is written to purchase tracking is what is in these boxes when Approve
 * is pressed, not what the model read — a misread quantity is the approver's
 * to fix here, and `parsed` keeps the model's version for comparison.
 */
export function ReceiptReviewDialog({
  receipt,
  open,
  onOpenChange,
}: {
  receipt: SupplyReceipt;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const today = useMemo(() => localDateStr(new Date()), []);
  const [form, setForm] = useState<ApprovalForm>(() => approvalFormFrom(receipt.parsed, today));
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const pictureQ = useQuery({
    queryKey: ["supply-receipts", "picture", receipt.id],
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: () => signedPhotoUrl(receipt.storage_bucket, receipt.storage_path),
  });
  const availableQ = useQuery({
    queryKey: ["supply-receipts", "approval-available"],
    enabled: open,
    staleTime: Infinity,
    queryFn: receiptApprovalAvailable,
  });

  const done = (message: string) => {
    toast.success(message);
    void qc.invalidateQueries({ queryKey: ["supply-receipts"] });
    void qc.invalidateQueries({ queryKey: ["supply-purchases"] });
    onOpenChange(false);
  };

  const approve = useMutation({
    mutationFn: async () => {
      const checked = validateApprovalForm(form, today);
      if (!checked.ok) throw new Error(checked.error);
      return approveReceipt({
        receiptId: receipt.id,
        supplier: checked.supplier,
        purchasedOn: checked.purchasedOn,
        lines: checked.lines,
      });
    },
    onSuccess: (n) => done(`Approved — ${n} line${n === 1 ? "" : "s"} added to purchase tracking`),
    onError: (e) => toast.error(receiptDecisionErrorText(e, "Approving this receipt")),
  });

  const reject = useMutation({
    mutationFn: async () => {
      if (!reason.trim()) {
        throw new Error("Say why, so the person who uploaded it knows what to fix.");
      }
      await rejectReceipt(receipt.id, reason.trim());
    },
    onSuccess: () => done("Sent back with your reason"),
    onError: (e) => toast.error(receiptDecisionErrorText(e, "Rejecting this receipt")),
  });

  const setLine = (i: number, patch: Partial<EditableLine>) =>
    setForm((f) => ({ ...f, lines: f.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));

  const total = approvalFormTotal(form);
  const printed = receipt.parsed?.total ?? null;
  const busy = approve.isPending || reject.isPending;
  const unavailable = availableQ.data === false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[95svh] max-w-5xl gap-3 p-4 md:p-6">
        <DialogHeader>
          <DialogTitle>Review receipt</DialogTitle>
        </DialogHeader>

        {unavailable && (
          <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
            {RECEIPT_APPROVAL_PENDING}
          </p>
        )}

        <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="rounded-md border bg-muted/30 p-1">
            {pictureQ.data ? (
              <a href={pictureQ.data} target="_blank" rel="noopener noreferrer">
                <img
                  src={pictureQ.data}
                  alt="The receipt as photographed"
                  className="max-h-[40svh] w-full object-contain md:max-h-[70svh]"
                />
              </a>
            ) : (
              <p className="p-6 text-center text-sm text-muted-foreground">
                {pictureQ.isLoading ? "Loading the photo…" : "The photo could not be loaded."}
              </p>
            )}
          </div>

          <div className="min-w-0 space-y-3">
            {receipt.status === "unreadable" && (
              <p className="text-sm text-muted-foreground">
                The receipt could not be read automatically. Enter what was bought from the photo.
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="receipt-supplier">Supplier</Label>
                <Input
                  id="receipt-supplier"
                  value={form.supplier}
                  onChange={(e) => setForm((f) => ({ ...f, supplier: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="receipt-date">Bought on</Label>
                <Input
                  id="receipt-date"
                  type="date"
                  value={form.purchasedOn}
                  onChange={(e) => setForm((f) => ({ ...f, purchasedOn: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="hidden grid-cols-[minmax(0,1fr)_5rem_6rem_6rem_2.25rem] gap-2 text-xs text-muted-foreground md:grid">
                <span>Item</span>
                <span>Qty</span>
                <span>Unit price</span>
                <span>Line total</span>
                <span />
              </div>
              {form.lines.map((line, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2 rounded-md border p-2 md:grid-cols-[minmax(0,1fr)_5rem_6rem_6rem_2.25rem] md:border-0 md:p-0"
                >
                  <Input
                    className="col-span-4 md:col-span-1"
                    aria-label={`Line ${i + 1} item`}
                    placeholder="What was bought"
                    value={line.label}
                    onChange={(e) => setLine(i, { label: e.target.value })}
                  />
                  <NumberInput
                    aria-label={`Line ${i + 1} quantity`}
                    placeholder="Qty"
                    decimals={2}
                    allowMath
                    value={line.quantity}
                    onValueChange={(n) => setLine(i, { quantity: n })}
                  />
                  <NumberInput
                    aria-label={`Line ${i + 1} unit price`}
                    placeholder="Unit $"
                    decimals={2}
                    allowMath
                    value={line.unitPrice}
                    onValueChange={(n) => setLine(i, { unitPrice: n })}
                  />
                  <NumberInput
                    aria-label={`Line ${i + 1} total`}
                    placeholder={lineAmount({ ...line, total: null })?.toFixed(2) ?? "Total $"}
                    decimals={2}
                    allowMath
                    value={line.total}
                    onValueChange={(n) => setLine(i, { total: n })}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-9"
                    aria-label={`Remove line ${i + 1}`}
                    disabled={form.lines.length === 1}
                    onClick={() =>
                      setForm((f) => ({ ...f, lines: f.lines.filter((_, j) => j !== i) }))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-9"
                onClick={() => setForm((f) => ({ ...f, lines: [...f.lines, { ...BLANK_LINE }] }))}
              >
                <Plus className="mr-1 size-3.5" /> Add line
              </Button>
            </div>

            <div className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-2">
              <span className="text-sm">
                Total to purchase tracking{" "}
                <span className="font-semibold tabular-nums">${total.toFixed(2)}</span>
              </span>
              {printed != null && Math.abs(printed - total) >= 0.01 && (
                <span className="text-xs text-warning">
                  The receipt reads ${printed.toFixed(2)} — tax or a missed line?
                </span>
              )}
            </div>

            {rejecting ? (
              <div className="space-y-2 rounded-md border p-2">
                <Label htmlFor="receipt-reason">Why is it not approved?</Label>
                <Textarea
                  id="receipt-reason"
                  rows={2}
                  placeholder="The uploader sees this on their receipt."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button variant="ghost" className="h-10" onClick={() => setRejecting(false)}>
                    Back
                  </Button>
                  <Button
                    variant="destructive"
                    className="h-10"
                    disabled={busy || unavailable}
                    onClick={() => reject.mutate()}
                  >
                    <X className="mr-1 size-4" /> Send back
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="outline"
                  className="h-10"
                  disabled={busy || unavailable}
                  onClick={() => setRejecting(true)}
                >
                  Not approved…
                </Button>
                <Button
                  className="h-10"
                  disabled={busy || unavailable}
                  onClick={() => approve.mutate()}
                >
                  <Check className="mr-1 size-4" /> Approve into purchase tracking
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The receipts attached to one supply order, and the button to attach one.
 *
 * David, 22 Sep: "when I place an order... can we have like a thingy here to
 * upload a copy of the receipt? I know we have it under spending, but I want
 * to just connect my receipts for all the items straight to that item. And
 * then also obviously it's going to be tied to spending."
 *
 * Same upload, same draft, same reviewer alert and the same approval as the
 * Spending card — the receipt shows there too, because it IS the same row.
 * Approving it records the purchase against this order: the approval function
 * carries the receipt's request_id onto every line.
 */
export function OrderReceipts({
  requestId,
  locationId,
  userId,
  uploaderName,
  receipts,
}: {
  requestId: string;
  locationId: string;
  userId: string;
  uploaderName: string;
  /** Loaded once for the whole queue rather than per order. */
  receipts: SupplyReceipt[];
}) {
  const { start, busy } = useReceiptUpload({ locationId, userId, uploaderName, requestId });
  return (
    <div className="space-y-2">
      {receipts.length > 0 && <ReceiptList receipts={receipts} userId={userId} />}
      <ReceiptCameraButton
        onFile={start}
        busy={busy}
        size="default"
        label={receipts.length ? "Attach another receipt" : "Attach receipt"}
      />
    </div>
  );
}

/**
 * How many receipts are waiting on this person's decision. Other people's
 * pending receipts are only visible to somebody who may approve them (the
 * SELECT policy), so "visible, pending, not mine" is the whole count.
 */
export function useReceiptsAwaitingMe(userId: string | null, enabled = true) {
  return useQuery({
    queryKey: ["supply-receipts", "awaiting", userId],
    enabled: enabled && !!userId,
    refetchInterval: 120_000,
    queryFn: async () => {
      const rows = await listSupplyReceipts(null, { pending: true });
      return rows.filter((r) => receiptDecision(r, userId).allowed);
    },
  });
}

/**
 * The pointer from Spend approvals to the receipt queue.
 *
 * Rep spend requests and purchase receipts stay two queues — one is permission
 * for a person to spend, the other is office stock spending — but an approver
 * should not have to remember that the second one exists. So the first one
 * says so whenever something is waiting there.
 */
export function ReceiptsAwaitingPointer({ userId }: { userId: string | null }) {
  const q = useReceiptsAwaitingMe(userId);
  const n = q.data?.length ?? 0;
  if (n === 0) return null;
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-2 p-3">
        <span className="text-sm">
          <ReceiptIcon className="mr-1.5 inline size-4 text-muted-foreground" aria-hidden />
          {n} purchase receipt{n === 1 ? " is" : "s are"} also waiting for approval.
        </span>
        <Button asChild size="sm" variant="outline" className="h-9">
          <Link to="/receipts" search={{ tab: "approve" }}>
            Review receipts
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** The model wants a data URL; the upload wants a Blob. One read, both uses. */
async function toDataUrl(file: Blob): Promise<string> {
  const { resizeToWebp } = await import("@/lib/photos");
  const variant = await resizeToWebp(file, 1600, 0.82);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(variant.blob);
  });
}
