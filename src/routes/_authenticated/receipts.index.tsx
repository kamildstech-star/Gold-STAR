import { createFileRoute, Link } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useAppContext } from "@/components/app-context";
import { LocationPicker, useDefaultLocationId } from "@/components/location-picker";
import {
  ReceiptCameraButton,
  ReceiptList,
  useReceiptUpload,
  useReceiptsAwaitingMe,
} from "@/components/supply-receipt-panel";
import { PageHeader } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { canApproveLeads } from "@/lib/approval";
import { useMyPermissions } from "@/lib/permissions";
import {
  RECEIPT_APPROVAL_PENDING,
  isReceiptApprover,
  listSupplyReceipts,
  receiptApprovalAvailable,
} from "@/lib/supply-receipts";

/**
 * Receipts — the crew's place to hand one in, and the approver's queue.
 *
 * Mark, 5 Oct: "Need area for crews to upload purchase receipts. It should
 * probably be tied to purchasing, AI to read the items and need to get
 * approved just to add to purchase tracking."
 *
 * The upload already existed, but only inside Supplies → Spending, a tab a
 * crew member is not shown. So this page is that same upload (the same
 * `useReceiptUpload`, the same row, the same reviewer alert) with the camera
 * button first and nothing between it and the thumb, plus the crew member's
 * own receipts and where each one stands — waiting, approved, or not approved
 * and why. It is on the crew's phone bar, so it is two taps from anywhere:
 * Receipts, then the button.
 *
 * Opened from a job (`?job=`), the receipt is filed against that job and in
 * that job's office.
 */
type ReceiptsSearch = { job?: string; tab?: "mine" | "approve" };

export const Route = createFileRoute("/_authenticated/receipts/")({
  head: () => ({
    meta: [
      { title: "Receipts — Recovery Hub" },
      {
        name: "description",
        content:
          "Photograph a purchase receipt at the till. A manager approves it into purchase tracking.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): ReceiptsSearch => ({
    job: typeof raw.job === "string" && raw.job ? raw.job : undefined,
    tab: raw.tab === "approve" ? "approve" : raw.tab === "mine" ? "mine" : undefined,
  }),
  component: ReceiptsPage,
});

function ReceiptsPage() {
  const app = useAppContext();
  const userId = app.userId!;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const defaultLocation = useDefaultLocationId();
  const [locationId, setLocationId] = useState("");
  const approver = isReceiptApprover(app.roles);
  const permissions = useMyPermissions();
  // The same test the Spend approvals page applies to itself.
  const seesSpendApprovals =
    canApproveLeads(app.roles) && permissions.allowed.has("expenses.approve");

  const jobQ = useQuery({
    queryKey: ["receipts", "job", search.job],
    enabled: !!search.job,
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("id, job_number, job_name, location_id")
        .eq("id", search.job!)
        .maybeSingle();
      return data;
    },
  });
  const job = jobQ.data ?? null;
  // A receipt for a job belongs to the job's office; the insert policy checks it.
  const officeId = job?.location_id ?? (locationId || defaultLocation || "");

  const { start, busy } = useReceiptUpload({
    locationId: officeId,
    userId,
    uploaderName: app.fullName ?? "A colleague",
    jobId: job?.id ?? null,
  });

  const mineQ = useQuery({
    queryKey: ["supply-receipts", "mine", userId],
    queryFn: () => listSupplyReceipts(null, { uploadedBy: userId }),
  });
  const awaitingQ = useReceiptsAwaitingMe(userId, approver);
  const queueQ = useQuery({
    queryKey: ["supply-receipts", "queue"],
    enabled: approver,
    queryFn: () => listSupplyReceipts(null, { pending: true }),
  });
  const availableQ = useQuery({
    queryKey: ["supply-receipts", "approval-available"],
    enabled: approver,
    staleTime: Infinity,
    queryFn: receiptApprovalAvailable,
  });

  const mine = mineQ.data ?? [];
  const queue = queueQ.data ?? [];
  const awaiting = awaitingQ.data?.length ?? 0;
  const tab = search.tab ?? (approver && awaiting > 0 ? "approve" : "mine");

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader
        title="Receipts"
        subtitle="Photograph it at the till. A manager approves it into purchase tracking."
      />

      <Card>
        <CardContent className="space-y-3 p-3">
          {search.job && (
            <p className="text-sm">
              For job{" "}
              <span className="font-medium">
                {job ? [job.job_number, job.job_name].filter(Boolean).join(" · ") : "…"}
              </span>{" "}
              <Link
                to="/receipts"
                search={{}}
                className="text-xs text-muted-foreground underline underline-offset-2"
              >
                Not for a job
              </Link>
            </p>
          )}
          {!search.job && (
            <LocationPicker
              label="Office"
              value={locationId || defaultLocation || ""}
              onChange={setLocationId}
            />
          )}
          <ReceiptCameraButton
            size="lg"
            onFile={start}
            busy={busy}
            disabled={!officeId || (!!search.job && !job)}
            label="Photograph a receipt"
          />
          <p className="text-xs text-muted-foreground">
            The receipt is read automatically where it can be. Nothing reaches purchase tracking
            until somebody other than you approves it, and you will be told either way.
          </p>
        </CardContent>
      </Card>

      <Tabs
        value={tab}
        onValueChange={(v) => void navigate({ search: (s) => ({ ...s, tab: v as "mine" }) })}
      >
        <TabsList>
          <TabsTrigger value="mine">My receipts</TabsTrigger>
          {approver && (
            <TabsTrigger value="approve">
              To approve
              {awaiting > 0 && (
                <Badge className="ml-1.5 h-4 min-w-4 rounded-full px-1 text-[10px] tabular-nums">
                  {awaiting}
                </Badge>
              )}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="mine" className="pt-2">
          {mineQ.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : mine.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              You have not uploaded any receipts yet.
            </p>
          ) : (
            <ReceiptList receipts={mine} userId={userId} showUploader={false} />
          )}
        </TabsContent>

        {approver && (
          <TabsContent value="approve" className="space-y-2 pt-2">
            {availableQ.data === false && (
              <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
                {RECEIPT_APPROVAL_PENDING}
              </p>
            )}
            {queueQ.isLoading ? (
              <p className="p-4 text-sm text-muted-foreground">Loading…</p>
            ) : queue.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                Nothing waiting. Receipts uploaded in your offices appear here.
              </p>
            ) : (
              <>
                {queue.some((r) => r.uploaded_by === userId) && (
                  <p className="text-xs text-muted-foreground">
                    Receipts you uploaded are listed without a Review button — somebody else has to
                    approve those.
                  </p>
                )}
                <ReceiptList receipts={queue} userId={userId} />
              </>
            )}
            {seesSpendApprovals && (
              <p className="text-xs text-muted-foreground">
                Rep spend requests are a separate queue, under{" "}
                <Link to="/expenses/approvals" className="underline underline-offset-2">
                  Spend approvals
                </Link>
                .
              </p>
            )}
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
