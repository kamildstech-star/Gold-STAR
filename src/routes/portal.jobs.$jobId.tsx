import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ChevronDown, ChevronRight, FileText, Images, Receipt } from "lucide-react";
import { toast } from "sonner";

import {
  PortalNotice,
  portalDate,
  portalMoney,
  requirePortalCustomer,
} from "@/components/portal/portal-shell";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  PORTAL_SIGNED_URL_SECONDS,
  fetchPortalJob,
  fetchPortalPhotoIds,
  type PortalPhotoSet,
} from "@/lib/portal";
import { portalSignedUrls } from "@/lib/portal.functions";

export const Route = createFileRoute("/portal/jobs/$jobId")({
  beforeLoad: requirePortalCustomer,
  component: PortalJobPage,
});

/**
 * One shared job, read-only: its shared documents, photo sets and invoices,
 * and nothing else. What is on this page is exactly what the database
 * returned for this customer — there is no hidden field here to filter out,
 * because none was ever sent.
 */
function PortalJobPage() {
  const { jobId } = Route.useParams();
  const sign = useServerFn(portalSignedUrls);
  const q = useQuery({
    queryKey: ["portal", "job", jobId],
    queryFn: () => fetchPortalJob(jobId),
  });

  if (q.isLoading) return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (q.isError)
    return (
      <PortalNotice title="This job could not be loaded">
        Please refresh the page. If it keeps happening, call your Gold Star office.
      </PortalNotice>
    );
  // Not shared, unshared a moment ago, or not a job at all: one answer for all
  // three, so a changed id tells nobody anything.
  if (!q.data)
    return (
      <div className="space-y-4">
        <BackLink />
        <PortalNotice title="This job isn't available">
          It may no longer be shared with you. Ask your Gold Star contact if you think it should be.
        </PortalNotice>
      </div>
    );

  const { job, documents, photo_sets, invoices } = q.data;

  const openDocument = async (id: string) => {
    // Opened before the await so a popup blocker sees a click, not a script.
    const tab = window.open("", "_blank", "noopener");
    try {
      const [link] = await sign({ data: { kind: "document", ids: [id] } });
      if (!link) throw new Error("gone");
      if (tab) tab.location.href = link.url;
      else window.location.href = link.url;
    } catch {
      tab?.close();
      toast.error("That document isn't available any more.");
      void q.refetch();
    }
  };

  return (
    <div className="space-y-5">
      <BackLink />
      <div>
        <h1 className="text-[18px] font-semibold">
          {[job.address, job.locality, job.region].filter(Boolean).join(", ") || "Your job"}
        </h1>
        {job.job_number && (
          <p className="text-[12px] text-muted-foreground">Job {job.job_number}</p>
        )}
      </div>

      <Section icon={FileText} title="Documents" empty="No documents shared.">
        {documents.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              onClick={() => void openDocument(d.id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[14px]">{d.name ?? "Document"}</span>
              <span className="shrink-0 text-[12px] text-muted-foreground">
                {portalDate(d.created_at)}
              </span>
            </button>
          </li>
        ))}
      </Section>

      <Section icon={Images} title="Photos" empty="No photos shared.">
        {photo_sets.map((s) => (
          <PhotoSet key={`${s.kind}:${s.id}`} jobId={jobId} set={s} />
        ))}
      </Section>

      <Section icon={Receipt} title="Invoices" empty="No invoices shared.">
        {invoices.map((v) => (
          <li key={v.id}>
            <Link
              to="/portal/invoices/$invoiceId"
              params={{ invoiceId: v.id }}
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40"
            >
              <Receipt className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[14px]">
                {v.invoice_number ? `Invoice ${v.invoice_number}` : (v.title ?? "Invoice")}
              </span>
              <span className="shrink-0 text-[12px] text-muted-foreground">
                {portalDate(v.issue_date)} · {portalMoney(v.total)}
              </span>
            </Link>
          </li>
        ))}
      </Section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to="/portal"
      className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Your jobs
    </Link>
  );
}

function Section({
  icon: Icon,
  title,
  empty,
  children,
}: {
  icon: typeof FileText;
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="rounded-xl border bg-card">
      <h2 className="flex items-center gap-2 border-b px-4 py-3 text-[14px] font-semibold">
        <Icon className="size-4 text-muted-foreground" />
        {title}
      </h2>
      {children.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y">{children}</ul>
      )}
    </section>
  );
}

function PhotoSet({ jobId, set }: { jobId: string; set: PortalPhotoSet }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const sign = useServerFn(portalSignedUrls);

  // Links are signed for five minutes; refetch a little before they lapse so
  // a customer leafing through slowly does not hit a dead thumbnail.
  const staleTime = (PORTAL_SIGNED_URL_SECONDS - 60) * 1000;
  const thumbs = useQuery({
    queryKey: ["portal", "photos", jobId, set.kind, set.id],
    enabled: open,
    staleTime,
    refetchInterval: staleTime,
    queryFn: async () => {
      const ids = await fetchPortalPhotoIds(jobId, set.kind, set.id);
      if (ids.length === 0) return [];
      const urls: { id: string; url: string }[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        urls.push(
          ...(await sign({ data: { kind: "photo", ids: ids.slice(i, i + 200), size: "thumb" } })),
        );
      }
      return urls;
    },
  });
  const full = useQuery({
    queryKey: ["portal", "photo", viewing],
    enabled: !!viewing,
    staleTime,
    queryFn: async () =>
      (await sign({ data: { kind: "photo", ids: [viewing!], size: "display" } }))[0]?.url ?? null,
  });

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate text-[14px]">{set.name ?? "Photos"}</span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {set.photo_count} photo{set.photo_count === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          {thumbs.isLoading ? (
            <p className="text-[12px] text-muted-foreground">Loading photos…</p>
          ) : (thumbs.data ?? []).length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No photos in this set.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {(thumbs.data ?? []).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setViewing(p.id)}
                  className="aspect-square overflow-hidden rounded-md border bg-muted"
                >
                  <img src={p.url} alt="" loading="lazy" className="size-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Dialog open={!!viewing} onOpenChange={(v) => !v && setViewing(null)}>
        <DialogContent className="max-w-3xl p-2">
          <DialogTitle className="sr-only">Photo</DialogTitle>
          {full.data ? (
            <img src={full.data} alt="" className="max-h-[80svh] w-full object-contain" />
          ) : (
            <p className="p-6 text-center text-[13px] text-muted-foreground">
              {full.isLoading ? "Loading…" : "This photo isn't available any more."}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </li>
  );
}
