import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GanttChart } from "@/components/gantt-chart";
import { PublicPhotoGallery } from "@/components/public-photo-gallery";
import { fmtDate } from "@/lib/jobs";
import { loadJobShare } from "@/lib/job-share.functions";
import type { PublicSharePayload } from "@/lib/job-share";

export const Route = createFileRoute("/share/$token")({
  head: () => ({
    meta: [
      { title: "Gold Star Restoration" },
      {
        name: "description",
        content: "Shared from your restoration job. No account needed.",
      },
      /* A share link is handed to one person. It must never be indexed, and it
         must never be unfurled into a chat preview by a link scanner. */
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: PublicSharePage,
});

const GONE: Record<string, string> = {
  not_found: "This link is not valid. Ask your Gold Star contact to send a new one.",
  revoked: "This link has been turned off. Ask your Gold Star contact for a fresh one.",
  expired: "This link has expired. Ask your Gold Star contact for a fresh one.",
};

/**
 * The public share viewer.
 *
 * Deliberately a shell rather than a schedule page. A share link resolves to a
 * kind, and this route renders whatever that kind is — the schedule today, the
 * job's photographs next — so the second thing shared through this mechanism
 * does not need a second public route, a second token check and a second set
 * of expiry bugs.
 *
 * Nothing here filters anything. Everything the browser receives is already
 * everything the link permits, which is the only arrangement where "hidden"
 * survives a look at the network tab.
 */
function PublicSharePage() {
  const { token } = Route.useParams();
  const load = useServerFn(loadJobShare);

  const q = useQuery({
    queryKey: ["public-share", token],
    queryFn: () => load({ data: { token } }),
    retry: false,
  });

  if (q.isLoading) return <Frame>Loading…</Frame>;

  const payload = q.data as PublicSharePayload | undefined;

  /* A thrown query and a server-reported read failure are the same event to
     the person holding the phone, and neither may render as an empty chart. */
  if (q.isError || !payload || payload.status === "error") {
    return (
      <Frame>
        <Card className="w-full max-w-md">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <TriangleAlert className="size-4 shrink-0 text-destructive" />
            <CardTitle className="text-base">This page could not be loaded</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Something went wrong at our end, so nothing is shown. This does not mean there is
              nothing to see — please try again in a moment.
            </p>
            <Button variant="outline" size="sm" onClick={() => void q.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </Frame>
    );
  }

  if (payload.status === "gone") {
    return (
      <Frame>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-base">This link is no longer available</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {GONE[payload.reason]}
          </CardContent>
        </Card>
      </Frame>
    );
  }

  if (payload.status === "unsupported") {
    return (
      <Frame>
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-base">Nothing to show here yet</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            This link points to something this page cannot display. Ask your Gold Star contact to
            send it another way.
          </CardContent>
        </Card>
      </Frame>
    );
  }

  const { branding } = payload;

  return (
    /* overflow-x-hidden is the load-bearing bit on a phone: a wide chart and a
       wide grid both carry their own scrolling, and the page behind them must
       not gain one. */
    <div className="min-h-screen overflow-x-hidden bg-muted/40 pb-16">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          {branding.officeLogoUrl ? (
            <img
              src={branding.officeLogoUrl}
              alt={`${branding.companyName} logo`}
              className="h-9 w-auto"
            />
          ) : (
            <span className="text-base font-semibold">{branding.companyName}</span>
          )}
          {branding.officeName || branding.officePhone ? (
            <div className="ml-auto min-w-0 text-right text-xs text-muted-foreground">
              {branding.officeName ? <div className="truncate">{branding.officeName}</div> : null}
              {branding.officePhone ? (
                <a className="font-medium underline" href={`tel:${branding.officePhone}`}>
                  {branding.officePhone}
                </a>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-3 px-3 py-4 sm:px-4">
        <div className="rounded-lg border bg-background p-4">
          <h1 className="text-lg font-semibold">
            {payload.kind === "job_photos"
              ? "Photos from your job"
              : payload.kind === "job_drying_report"
                ? "Drying report"
                : "Your job schedule"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[payload.jobNumber ? `Job ${payload.jobNumber}` : null, payload.address]
              .filter(Boolean)
              .join(" · ") ||
              (payload.kind === "job_photos"
                ? "Pictures our crew took at your property."
                : payload.kind === "job_drying_report"
                  ? "The drying record for this property."
                  : "This is the current plan for the work at your property.")}
          </p>
          {payload.note ? <p className="mt-2 whitespace-pre-wrap text-sm">{payload.note}</p> : null}
        </div>

        {payload.kind === "job_drying_report" ? (
          <div className="space-y-3 rounded-lg border bg-background p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{payload.report.name}</p>
                <p className="text-xs text-muted-foreground">
                  Filed {fmtDate(payload.report.filedAt.slice(0, 10))}
                </p>
              </div>
              <div className="flex gap-2">
                <Button asChild size="sm" variant="outline">
                  <a href={payload.report.href} target="_blank" rel="noopener noreferrer">
                    Open the PDF
                  </a>
                </Button>
                <Button asChild size="sm">
                  <a href={`${payload.report.href}?download=1`}>Download</a>
                </Button>
              </div>
            </div>
          </div>
        ) : payload.kind === "job_photos" ? (
          payload.photos.photos.length === 0 && payload.photos.missing === 0 ? (
            <div className="rounded-lg border bg-background p-4 text-sm text-muted-foreground">
              There are no photographs on this link. Ask your Gold Star contact to send a new one.
            </div>
          ) : (
            <PublicPhotoGallery view={payload.photos} />
          )
        ) : (
          <GanttChart
            bars={payload.schedule.bars}
            today={payload.schedule.today}
            warning={
              payload.schedule.unread.length > 0
                ? "Part of this schedule could not be loaded, so some items may be missing from the chart."
                : undefined
            }
            footnote={
              payload.schedule.undated ? `Not drawn: ${payload.schedule.undated}.` : undefined
            }
            empty="No dates have been set on this job yet. Your Gold Star contact can tell you what is planned."
          />
        )}

        <p className="px-1 text-xs text-muted-foreground">
          {payload.kind === "job_photos"
            ? "This page is live — your Gold Star contact can add more pictures to this same link."
            : payload.kind === "job_drying_report"
              ? "This is the report as it was filed. Your Gold Star contact can send a newer one."
              : "This page is live — it shows the plan as it stands right now, and it will keep updating as the job moves."}{" "}
          It stops working on {fmtDate(payload.expiresAt.slice(0, 10))}, or sooner if we turn the
          link off.
        </p>
      </main>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/40 p-6 text-sm text-muted-foreground">
      {children}
    </div>
  );
}
