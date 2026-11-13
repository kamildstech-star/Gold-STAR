import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, FileText, Images, Receipt } from "lucide-react";

import { PortalNotice, portalDate, requirePortalCustomer } from "@/components/portal/portal-shell";
import { fetchMyPortalJobs } from "@/lib/portal";

export const Route = createFileRoute("/portal/")({
  beforeLoad: requirePortalCustomer,
  component: PortalHome,
});

function PortalHome() {
  const q = useQuery({ queryKey: ["portal", "jobs"], queryFn: fetchMyPortalJobs });

  if (q.isLoading) return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (q.isError)
    return (
      <PortalNotice title="Your jobs could not be loaded">
        Please refresh the page. If it keeps happening, call your Gold Star office.
      </PortalNotice>
    );

  const jobs = q.data ?? [];
  return (
    <div className="space-y-4">
      <h1 className="text-[18px] font-semibold">Your jobs</h1>
      {jobs.length === 0 ? (
        <PortalNotice title="Nothing has been shared with you yet">
          When your Gold Star contact shares a job with you, it appears here.
        </PortalNotice>
      ) : (
        <ul className="space-y-2">
          {jobs.map((j) => (
            <li key={j.job_id}>
              <Link
                to="/portal/jobs/$jobId"
                params={{ jobId: j.job_id }}
                className="flex items-center gap-3 rounded-xl border bg-card p-4 hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold">
                    {[j.address, j.locality, j.region].filter(Boolean).join(", ") || "Your job"}
                  </p>
                  <p className="text-[12px] text-muted-foreground">
                    {j.job_number ? `Job ${j.job_number} · ` : ""}shared {portalDate(j.shared_at)}
                  </p>
                  <p className="mt-1.5 flex flex-wrap gap-3 text-[12px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <FileText className="size-3.5" /> {j.documents} document
                      {j.documents === 1 ? "" : "s"}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Images className="size-3.5" /> {j.photo_sets} photo set
                      {j.photo_sets === 1 ? "" : "s"}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Receipt className="size-3.5" /> {j.invoices} invoice
                      {j.invoices === 1 ? "" : "s"}
                    </span>
                  </p>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
