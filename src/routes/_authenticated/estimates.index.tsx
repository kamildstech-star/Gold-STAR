import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BriefcaseBusiness, Calculator, Plus, Search } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { useJobCreatableLocations } from "@/components/location-picker";
import { MetricStrip } from "@/components/metric-strip";
import { PageHeader } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { JOB_CALCULATOR_TYPE_LABEL, type JobCalculatorType } from "@/lib/job-calculator";
import { listJobCalculations } from "@/lib/job-calculations";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/estimates/")({
  head: () => ({
    meta: [
      { title: "Job Calculator · Recovery Hub" },
      {
        name: "description",
        content: "Price restoration work before creating or attaching a job.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: JobCalculatorIndex,
});

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function shortDate(value: string) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
  return date.toLocaleDateString(DATE_LOCALE, US_DATE);
}

function JobCalculatorIndex() {
  const app = useAppContext();
  // No job-creating role: no "Convert to job" anywhere on the list.
  const canCreateJob = useJobCreatableLocations().length > 0;
  const [search, setSearch] = useState("");
  const calculations = useQuery({
    queryKey: ["job-calculations", app.currentLocationId],
    queryFn: () => listJobCalculations(app.currentLocationId),
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return calculations.data ?? [];
    return (calculations.data ?? []).filter((row) =>
      [row.customer_name, row.address, row.locality, row.job?.job_number]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [calculations.data, search]);

  const attached = (calculations.data ?? []).filter((row) => row.job_id).length;

  return (
    <div className="space-y-4 p-3 sm:p-4">
      {/* The calculator is a pricing tool with its own front door, not the
          way into job creation — "New job" in the sidebar is that. An estimate
          becomes a job when somebody converts it, which is the action on every
          row below. */}
      <PageHeader
        title="Job Calculator"
        subtitle="Price restoration work. Convert an estimate to a job once it is sold."
      >
        <Button asChild>
          <Link to="/estimates/$id" params={{ id: "new" }}>
            <Plus className="mr-1.5 size-4" /> New estimate
          </Link>
        </Button>
      </PageHeader>

      <MetricStrip
        metrics={[
          {
            label: "Saved estimates",
            value: calculations.isLoading ? "—" : (calculations.data?.length ?? 0),
            icon: Calculator,
            note: `${attached} attached to jobs`,
          },
        ]}
      />

      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Customer, address or job number"
          className="pl-9"
        />
      </div>

      <div className="grid gap-3 md:hidden">
        {rows.map((row) => (
          // The card body is the link and the action sits beside it: a Convert
          // button nested inside an anchor is not a button you can press.
          <Card key={row.id} className="overflow-hidden">
            <Link to="/estimates/$id" params={{ id: row.id }} className="block">
              <CardContent className="space-y-2 p-3 transition-colors hover:bg-muted/30">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">
                      {row.customer_name || "Unnamed customer"}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[row.address, row.locality].filter(Boolean).join(", ") || "No address"}
                    </p>
                  </div>
                  <p className="shrink-0 font-semibold tabular-nums">{money(row.customer_price)}</p>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline">
                    {JOB_CALCULATOR_TYPE_LABEL[row.job_type as JobCalculatorType] ?? row.job_type}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {row.job?.job_number ? `Job ${row.job.job_number}` : "Not a job yet"} · Job date{" "}
                    {shortDate(row.job_date)}
                  </span>
                </div>
              </CardContent>
            </Link>
            {row.job_id || canCreateJob ? (
              <div className="border-t p-2">
                {row.job_id ? (
                  <Button asChild size="sm" variant="ghost" className="w-full">
                    <Link to="/jobs/$id" params={{ id: row.job_id }}>
                      <BriefcaseBusiness className="mr-1.5 size-4" /> Open job{" "}
                      {row.job?.job_number ?? ""}
                    </Link>
                  </Button>
                ) : (
                  <Button asChild size="sm" variant="outline" className="w-full">
                    <Link to="/jobs/new" search={{ calculatorId: row.id }}>
                      <BriefcaseBusiness className="mr-1.5 size-4" /> Convert to job
                    </Link>
                  </Button>
                )}
              </div>
            ) : null}
          </Card>
        ))}
      </div>

      <Card className="hidden overflow-hidden md:block">
        <CardContent className="p-0">
          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Customer</th>
                  <th className="px-3 py-2 text-left">Property</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Job</th>
                  <th className="px-3 py-2 text-left">Job date</th>
                  <th className="px-3 py-2 text-right">Customer price</th>
                  <th className="px-3 py-2 text-right">
                    <span className="sr-only">Convert to job</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link
                        to="/estimates/$id"
                        params={{ id: row.id }}
                        className="font-semibold text-primary hover:underline"
                      >
                        {row.customer_name || "Unnamed customer"}
                      </Link>
                    </td>
                    <td className="max-w-72 truncate px-3 py-2 text-muted-foreground">
                      {[row.address, row.locality].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="px-3 py-2">
                      {JOB_CALCULATOR_TYPE_LABEL[row.job_type as JobCalculatorType] ?? row.job_type}
                    </td>
                    <td className="px-3 py-2">
                      {row.job?.job_number ? (
                        <Link
                          to="/jobs/$id"
                          params={{ id: row.job_id! }}
                          className="text-primary hover:underline"
                        >
                          Job {row.job.job_number}
                        </Link>
                      ) : (
                        <Badge variant="outline">Not a job yet</Badge>
                      )}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{shortDate(row.job_date)}</td>
                    <td className="px-3 py-2 text-right font-semibold tabular-nums">
                      {money(row.customer_price)}
                    </td>
                    {/* David: "either out here on the main estimate page, like
                        convert to job, or when you click into the estimate".
                        Both, then — this is the one out here. It opens the new
                        job form filled in; it does not create anything. */}
                    <td className="px-3 py-2 text-right">
                      {row.job_id || !canCreateJob ? null : (
                        <Button asChild size="sm" variant="outline">
                          <Link to="/jobs/new" search={{ calculatorId: row.id }}>
                            <BriefcaseBusiness className="mr-1.5 size-4" /> Convert to job
                          </Link>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {!calculations.isLoading && rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            <Calculator className="mx-auto mb-2 size-5" />
            {search ? "No saved estimates match your search." : "No estimates yet."}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
