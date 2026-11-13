import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { PageHeader } from "@/components/ui-density";
import { RecordLoadError } from "@/components/record-load-error";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CredentialsLibrary } from "@/components/credentials-library";
import {
  COMPLIANCE_STATUS_LABEL,
  COMPLIANCE_STATUS_TONE,
  fetchComplianceQueue,
  fetchRequirementTypes,
  formatLimit,
  requirementLabel,
  type ComplianceStatus,
} from "@/lib/compliance";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/compliance")({
  head: () => ({
    meta: [
      { title: "Vendor compliance — Gold Star Recovery Hub" },
      {
        name: "description",
        content:
          "Every insurance certificate, endorsement and vendor agreement expiring across all accounts, sorted by date and filterable by office.",
      },
      { property: "og:title", content: "Vendor compliance — Gold Star Recovery Hub" },
      {
        property: "og:description",
        content:
          "An expired certificate does not announce itself — it quietly removes you from the approved-vendor list.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: CompliancePage,
});

const STATUSES: (ComplianceStatus | "all" | "unsatisfied")[] = [
  "unsatisfied",
  "all",
  "expired",
  "insufficient",
  "missing",
  "expiring_soon",
  "satisfied",
];

function CompliancePage() {
  const [locationId, setLocationId] = useState("all");
  const [status, setStatus] = useState<string>("unsatisfied");
  const [q, setQ] = useState("");

  const locations = useQuery({
    queryKey: ["locations-min"],
    queryFn: async () => {
      const { data, error } = await supabase.from("locations").select("id, name").order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const types = useQuery({ queryKey: ["compliance-types"], queryFn: fetchRequirementTypes });

  const rows = useQuery({
    queryKey: ["compliance-queue", locationId],
    queryFn: () => fetchComplianceQueue({ locationId: locationId === "all" ? null : locationId }),
  });

  const filtered = useMemo(() => {
    const all = rows.data ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((r) => {
      if (status === "unsatisfied" && r.status === "satisfied") return false;
      if (status !== "all" && status !== "unsatisfied" && r.status !== status) return false;
      if (needle && !(r.account_name ?? "").toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [rows.data, status, q]);

  const counts = useMemo(() => {
    const all = rows.data ?? [];
    return {
      expired: all.filter((r) => r.status === "expired").length,
      soon: all.filter((r) => r.status === "expiring_soon").length,
      short: all.filter((r) => r.status === "insufficient").length,
      missing: all.filter((r) => r.status === "missing").length,
    };
  }, [rows.data]);

  if (rows.error) {
    return (
      <RecordLoadError
        error={rows.error}
        record="compliance"
        table="account_compliance_status"
        onRetry={() => void rows.refetch()}
      />
    );
  }

  return (
    <div className="space-y-3">
      <PageHeader title="Compliance" />
      <p className="text-sm text-muted-foreground">
        Certificates get renewed in batches by one person, so this is the whole book by expiry date
        rather than account by account.
      </p>

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue" className="text-[12px]">
            Requirements
          </TabsTrigger>
          <TabsTrigger value="library" className="text-[12px]">
            Credentials library
          </TabsTrigger>
        </TabsList>
        <TabsContent value="library" className="mt-3">
          <CredentialsLibrary locationId={locationId === "all" ? null : locationId} />
        </TabsContent>
        <TabsContent value="queue" className="mt-3 space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Metric label="Expired" value={counts.expired} tone="text-red-700 dark:text-red-400" />
            <Metric
              label="Under limit"
              value={counts.short}
              tone="text-orange-700 dark:text-orange-400"
            />
            <Metric
              label="Missing"
              value={counts.missing}
              tone="text-slate-700 dark:text-slate-400"
            />
            <Metric
              label="Expiring soon"
              value={counts.soon}
              tone="text-amber-700 dark:text-amber-400"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-56 text-[12px]"
              placeholder="Search account"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-8 w-44 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s === "all"
                      ? "All statuses"
                      : s === "unsatisfied"
                        ? "Needs action"
                        : COMPLIANCE_STATUS_LABEL[s as ComplianceStatus]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="h-8 w-48 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All offices</SelectItem>
                {(locations.data ?? []).map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-[6px] border">
            <table className="w-full text-[12px]">
              <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">Account</th>
                  <th className="px-2 py-1.5 text-left font-medium">Requirement</th>
                  <th className="px-2 py-1.5 text-left font-medium">Status</th>
                  <th className="px-2 py-1.5 text-left font-medium">Required</th>
                  <th className="px-2 py-1.5 text-left font-medium">Held</th>
                  <th className="px-2 py-1.5 text-left font-medium">Expires</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.requirement_id} className="border-t hover:bg-muted/40">
                    <td className="px-2 py-1.5">
                      <Link
                        to="/accounts/$id"
                        params={{ id: r.account_id }}
                        className="hover:underline"
                      >
                        {r.account_name ?? "Account"}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5">
                      {requirementLabel(r.requirement_type, types.data)}
                      {!r.mandatory && (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                          opt
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge
                        variant="outline"
                        className={`h-4 rounded-[4px] px-1.5 text-[10px] ${COMPLIANCE_STATUS_TONE[r.status]}`}
                      >
                        {COMPLIANCE_STATUS_LABEL[r.status]}
                      </Badge>
                    </td>
                    <td className="px-2 py-1.5">
                      {formatLimit(r.required_amount, r.required_currency)}
                    </td>
                    <td className="px-2 py-1.5">
                      {formatLimit(r.covered_amount, r.currency ?? "USD")}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.expiry_date
                        ? new Date(`${r.expiry_date}T00:00:00`).toLocaleDateString(
                            DATE_LOCALE,
                            US_DATE,
                          )
                        : "—"}
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                      {rows.isLoading ? "Loading…" : "Nothing to chase here."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-[6px] border bg-card px-3 py-2">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${tone}`}>{value}</div>
    </div>
  );
}
