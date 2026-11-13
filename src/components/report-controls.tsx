import { useNavigate } from "@tanstack/react-router";
import {
  COMPARE_MODES,
  PERIOD_PRESETS,
  describeSelection,
  toDateStr,
  type CompareMode,
  type PeriodPreset,
} from "@/lib/period";
import type { PeriodSearch, ResolvedSelection } from "@/lib/report-search";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Location = {
  id: string;
  code: string;
  name: string;
  region_id: string | null;
  region_ids?: string[];
};
type Region = { id: string; name: string };

/**
 * Period, comparison period and scope — the three controls that sit at the top
 * of Reports and Sales Intelligence alike. They write straight to the URL, so
 * the selection survives a move between the two screens and can be shared.
 */
export function ReportControls({
  search,
  resolved,
  locations,
  regions,
  canPickMine = true,
}: {
  search: PeriodSearch;
  resolved: ResolvedSelection;
  locations: Location[];
  regions: Region[];
  canPickMine?: boolean;
}) {
  const navigate = useNavigate();

  const patch = (next: Partial<PeriodSearch>) => {
    navigate({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search: ((prev: any) => ({ ...prev, ...next })) as any,
      replace: true,
    });
  };

  const usedRegions = regions.filter((r) =>
    locations.some((l) => (l.region_ids ?? (l.region_id ? [l.region_id] : [])).includes(r.id)),
  );

  return (
    <div className="space-y-2 border-b bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Period">
          <Select
            value={search.period}
            onValueChange={(v) => {
              const preset = v as PeriodPreset;
              patch({
                period: preset,
                ...(preset === "custom" && !search.from
                  ? { from: toDateStr(resolved.range.from), to: toDateStr(resolved.range.to) }
                  : {}),
              });
            }}
          >
            <SelectTrigger className="h-8 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_PRESETS.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="From">
          <Input
            type="date"
            className="h-8 w-[140px]"
            value={
              search.period === "custom" ? (search.from ?? "") : toDateStr(resolved.range.from)
            }
            disabled={search.period !== "custom"}
            onChange={(e) => patch({ period: "custom", from: e.target.value })}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            className="h-8 w-[140px]"
            value={search.period === "custom" ? (search.to ?? "") : toDateStr(resolved.range.to)}
            disabled={search.period !== "custom"}
            onChange={(e) => patch({ period: "custom", to: e.target.value })}
          />
        </Field>

        <Field label="Compare to">
          <Select value={search.cmp} onValueChange={(v) => patch({ cmp: v as CompareMode })}>
            <SelectTrigger className="h-8 w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPARE_MODES.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {search.cmp === "custom" && (
          <>
            <Field label="Compare from">
              <Input
                type="date"
                className="h-8 w-[140px]"
                value={search.cfrom ?? ""}
                onChange={(e) => patch({ cfrom: e.target.value })}
              />
            </Field>
            <Field label="Compare to">
              <Input
                type="date"
                className="h-8 w-[140px]"
                value={search.cto ?? ""}
                onChange={(e) => patch({ cto: e.target.value })}
              />
            </Field>
          </>
        )}

        <Field label="Scope">
          {/* `resolved.scope`, not `search.scope`: with nothing in the URL the
              report is already showing the viewer's own office, and the picker
              has to say so rather than sitting blank on "All". */}
          <Select value={resolved.scope} onValueChange={(v) => patch({ scope: v })}>
            <SelectTrigger className="h-8 w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations you can see</SelectItem>
              {canPickMine && <SelectItem value="mine">My team only</SelectItem>}
              {usedRegions.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Regions</SelectLabel>
                  {usedRegions.map((r) => (
                    <SelectItem key={r.id} value={`region:${r.id}`}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              <SelectGroup>
                <SelectLabel>Locations</SelectLabel>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={`loc:${l.id}`}>
                    {l.code} · {l.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <p className="text-[12px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground">
          {describeSelection(resolved.range, resolved.compare)}
        </span>
        <span> · {resolved.scopeLabel}</span>
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="label-caps text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
