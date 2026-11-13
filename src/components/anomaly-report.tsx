import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppContext } from "@/components/app-context";
import { fetchAnomalies, downloadCsv, type AnomalyRow, type Scope } from "@/lib/reports";
import { useExportGate } from "@/lib/export-guard";
import { ExportExcelButton } from "@/components/export-excel-button";
import type { ExportColumn } from "@/lib/export-table";
import { AlertTriangle, Download } from "lucide-react";

/** One column list feeds both the CSV and the Excel export. */
const ANOMALY_COLUMNS: ExportColumn<AnomalyRow>[] = [
  { key: "kind", label: "Type", get: (r) => r.kind },
  { key: "label", label: "Name", get: (r) => r.label },
  { key: "jobs", label: "Jobs", get: (r) => r.jobs, type: "number" },
  { key: "touchpoints", label: "Touchpoints", get: (r) => r.touchpoints, type: "number" },
  { key: "photos", label: "Photos", get: (r) => r.photos, type: "number" },
  { key: "leadsWorked", label: "Leads worked", get: (r) => r.leadsWorked, type: "number" },
  { key: "incidents", label: "Incidents", get: (r) => r.incidents, type: "number" },
  { key: "total", label: "Total activity", get: (r) => r.total, type: "number" },
];

const WINDOWS = [7, 14, 30, 60];

/**
 * Silence detector. A Texas location once ran two months with no jobs before
 * anyone noticed — this is the control that makes that impossible, and it sits
 * on the dashboard rather than inside a report nobody opens.
 */
export function AnomalyReport({
  scope,
  compact = false,
  defaultWindow = 14,
}: {
  scope?: Scope;
  compact?: boolean;
  defaultWindow?: number;
}) {
  const app = useAppContext();
  const exportGate = useExportGate();

  const [windowDays, setWindowDays] = useState(defaultWindow);
  const [loading, setLoading] = useState(true);
  const [locRows, setLocRows] = useState<AnomalyRow[]>([]);
  const [repRows, setRepRows] = useState<AnomalyRow[]>([]);

  const locations = useMemo(
    () => app.visibleLocations.map((l) => ({ id: l.id, code: l.code, name: l.name })),
    [app.visibleLocations],
  );

  const effectiveScope: Scope =
    scope !== undefined ? scope : app.currentLocationId ? [app.currentLocationId] : null;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAnomalies(effectiveScope, windowDays, locations)
      .then((r) => {
        if (cancelled) return;
        setLocRows(r.locations);
        setRepRows(r.reps);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays, locations.length, app.currentLocationId]);

  const silentLocs = locRows.filter((r) => r.total === 0);
  const silentReps = repRows.filter((r) => r.total === 0);

  if (compact) {
    if (loading) return null;
    if (silentLocs.length === 0 && silentReps.length === 0) return null;
    return (
      <div className="rounded-sm border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
        <div className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" />
          No activity in {windowDays} days
        </div>
        <div className="mt-1 text-muted-foreground">
          {silentLocs.length > 0 && (
            <div>Locations: {silentLocs.map((r) => r.label).join(" ·")}</div>
          )}
          {silentReps.length > 0 && (
            <div>
              People:{" "}
              {silentReps
                .slice(0, 8)
                .map((r) => r.label)
                .join(" ·")}
              {silentReps.length > 8 ? ` +${silentReps.length - 8} more` : ""}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Anomalies — who has gone quiet</CardTitle>
        <div className="flex items-center gap-2">
          <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
            <SelectTrigger className="h-8 w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOWS.map((w) => (
                <SelectItem key={w} value={String(w)}>
                  Last {w} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {exportGate.allowed && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void exportGate.runExport({
                  surface: "anomalies",
                  entity: "activity_anomalies",
                  recordCount: locRows.length + repRows.length,
                  filters: { window_days: windowDays },
                  download: () =>
                    downloadCsv(
                      `anomalies-${windowDays}d.csv`,
                      [...locRows, ...repRows],
                      ANOMALY_COLUMNS,
                    ),
                })
              }
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              CSV
            </Button>
          )}
          <ExportExcelButton
            report="anomalies"
            surface="anomalies"
            entity="activity_anomalies"
            filters={{ window_days: windowDays }}
            sheets={[
              { name: "Anomalies", rows: [...locRows, ...repRows], columns: ANOMALY_COLUMNS },
            ]}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <Section
              title="Locations"
              rows={locRows}
              emptyNote="No locations in scope."
              windowDays={windowDays}
            />
            <Section
              title="People"
              rows={repRows}
              emptyNote="No sales or field users yet. Assign roles in Admin → Users."
              windowDays={windowDays}
            />
            <p className="text-xs text-muted-foreground">
              Activity counted: jobs created, touchpoints logged, photos uploaded, lead contact
              attempts, and incidents. Owners, admins and developer accounts are excluded from the
              people list. Weekly email delivery of this digest is not wired yet — the query is
              structured for it.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  rows,
  emptyNote,
  windowDays,
}: {
  title: string;
  rows: AnomalyRow[];
  emptyNote: string;
  windowDays: number;
}) {
  if (rows.length === 0) {
    return (
      <div>
        <h3 className="mb-1 text-sm font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{emptyNote}</p>
      </div>
    );
  }
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      <ul className="divide-y rounded-sm border">
        {rows.map((r) => (
          <li
            key={`${r.kind}-${r.id}`}
            className="flex items-center justify-between gap-2 px-3 py-2"
          >
            <span className="text-sm">{r.label}</span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {r.jobs}j · {r.touchpoints}t · {r.photos}p · {r.leadsWorked}l · {r.incidents}i
              </span>
              {r.total === 0 ? (
                <Badge className="bg-destructive/15 text-destructive">Silent {windowDays}d</Badge>
              ) : (
                <Badge variant="outline">{r.total}</Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
