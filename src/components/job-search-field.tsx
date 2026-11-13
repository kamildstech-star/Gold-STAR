import { jobSearchOr, siteSearch } from "@/lib/job-site-names";
import { isMissingSchema } from "@/lib/schema-fallback";
import { useEffect, useState } from "react";
import { Briefcase, Search, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { OPEN_JOB_STATUSES } from "@/lib/jobs";

export type PickedJob = {
  id: string;
  job_number: string;
  address: string;
  locality: string | null;
  job_name: string | null;
  customer_name: string | null;
  account_id: string | null;
  location_id: string;
  loss_type_id: string | null;
  primary_contact_id: string | null;
};

const SELECT =
  "id,job_number,address,locality,job_name,customer_name,account_id,location_id,loss_type_id,primary_contact_id";

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Search open jobs by job number, address or customer name. */
export function JobSearchField({
  value,
  onChange,
  label = "Job",
  disabled,
  emptyHint = "No open jobs match. Leave blank to create a standalone album.",
}: {
  value: PickedJob | null;
  onChange: (job: PickedJob | null) => void;
  label?: string | null;
  disabled?: boolean;
  /** What "no match" says — the default is the photo album's, where this field started. */
  emptyHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [rows, setRows] = useState<PickedJob[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const term = dq.trim();
      // A fresh builder per attempt: PostgREST builders change in place.
      const run = (withSite: boolean) => {
        const query = supabase
          .from("jobs")
          .select(SELECT)
          .in("status", OPEN_JOB_STATUSES)
          .order("updated_at", { ascending: false })
          .limit(20);
        return term ? query.or(jobSearchOr(term, withSite)) : query;
      };
      let { data, error } = await run(siteSearch.on);
      // Before the site-name columns exist, search without them.
      if (term && error && siteSearch.on && isMissingSchema(error)) {
        siteSearch.on = false;
        ({ data, error } = await run(false));
      }
      if (!cancelled) {
        setRows((data ?? []) as PickedJob[]);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [dq, open]);

  return (
    <div className="space-y-1.5">
      {label ? <Label>{label}</Label> : null}
      {value ? (
        <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
          <Briefcase className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">
              {value.job_number} · {value.address}
            </div>
            {value.customer_name ? (
              <div className="truncate text-xs text-muted-foreground">{value.customer_name}</div>
            ) : null}
          </div>
          {!disabled && (
            <Button size="icon" variant="ghost" className="size-7" onClick={() => onChange(null)}>
              <X className="size-4" />
            </Button>
          )}
        </div>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="h-11 w-full justify-start font-normal text-muted-foreground"
              disabled={disabled}
            >
              <Search className="mr-2 size-4" />
              Search open jobs — number, address or customer
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(28rem,90vw)] p-0">
            <div className="border-b p-2">
              <Input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="e.g. GS-2026-00123, 42 Oak St, Smith"
                className="h-9"
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {loading ? (
                <div className="px-3 py-2.5 text-[13px] text-muted-foreground">Searching…</div>
              ) : rows.length === 0 ? (
                <div className="px-3 py-2.5 text-[13px] text-muted-foreground">{emptyHint}</div>
              ) : (
                rows.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    className="block w-full px-3 py-2 text-left hover:bg-accent"
                    onClick={() => {
                      onChange(j);
                      setOpen(false);
                    }}
                  >
                    <div className="truncate text-[13px] font-medium">
                      {j.job_number} · {j.address}
                      {j.locality ? `, ${j.locality}` : ""}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {j.customer_name ?? j.job_name ?? "—"}
                    </div>
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
