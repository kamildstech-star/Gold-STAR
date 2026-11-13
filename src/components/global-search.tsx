import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { jobSearchOr } from "@/lib/job-site-names";
import { JOB_STATUS_LABELS, type JobStatus } from "@/lib/jobs";
import { useMyPageAccess } from "@/lib/use-page-access";

/**
 * 6 Nov (David): "the open search — I even tried searching the job number in
 * Polaris, it wasn't pulling up any information." The top-bar search now
 * finds jobs too: by job number, name, address or customer, the same columns
 * the Jobs list searches (jobSearchOr), beside the companies it always found.
 */
type JobRow = {
  id: string;
  job_number: string | null;
  job_name: string | null;
  address: string | null;
  customer_name: string | null;
  status: string | null;
};

type Row = {
  account_id: string;
  account_name: string;
  owning_location_code: string;
  owning_location_name: string;
  status: string;
  primary_contact_name: string | null;
  viewer_has_full_access: boolean;
};

export function GlobalSearchButton() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  /*
   * The palette only offers what the person can open: jobs when the job page
   * is theirs, companies when the account page is, and only the companies
   * they have full access to. A row that does nothing when picked (another
   * branch's company) is not listed.
   */
  const pageAccess = useMyPageAccess();
  const searchJobs = pageAccess.canOpen("/jobs/x");
  const searchAccounts = pageAccess.canOpen("/accounts/x");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setRows([]);
      setJobs([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      const term = q.trim();
      const [accounts, jobRows] = await Promise.all([
        searchAccounts
          ? supabase.rpc("search_accounts_minimal", { _query: term })
          : Promise.resolve({ data: [] as Row[] }),
        searchJobs
          ? supabase
              .from("jobs")
              .select("id, job_number, job_name, address, customer_name, status")
              .or(jobSearchOr(term, false))
              .order("created_at", { ascending: false })
              .limit(8)
          : Promise.resolve({ data: [] as JobRow[] }),
      ]);
      if (!cancelled) {
        setRows(((accounts.data as Row[]) ?? []).filter((r) => r.viewer_has_full_access));
        setJobs(((jobRows.data ?? []) as JobRow[]) ?? []);
        setLoading(false);
      }
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, searchJobs, searchAccounts]);

  // Nothing this person could open from it: no search box at all.
  if (!searchJobs && !searchAccounts) return null;

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start gap-2 text-muted-foreground md:w-64"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        <span className="truncate">
          {searchJobs && searchAccounts
            ? "Search jobs and companies…"
            : searchJobs
              ? "Search jobs…"
              : "Search companies…"}
        </span>
        <kbd className="ml-auto hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] md:inline">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandInput
          placeholder={
            searchJobs && searchAccounts
              ? "Job #, address, customer or company…"
              : searchJobs
                ? "Job #, address or customer…"
                : "Company name…"
          }
          value={q}
          onValueChange={setQ}
        />
        <CommandList>
          {loading && <div className="p-3 text-xs text-muted-foreground">Searching…</div>}
          {!loading && q.trim().length < 2 && (
            <div className="p-3 text-xs text-muted-foreground">Type at least 2 characters.</div>
          )}
          {!loading && q.trim().length >= 2 && rows.length === 0 && jobs.length === 0 && (
            <CommandEmpty>No jobs or companies match.</CommandEmpty>
          )}
          {jobs.length > 0 && (
            <CommandGroup heading="Jobs">
              {jobs.map((j) => (
                <CommandItem
                  key={j.id}
                  /* cmdk hides an item whose value does not match the typed
                     text, so the value is the words a person searched for,
                     not the id (the id alone made every row vanish). */
                  value={[j.job_number, j.job_name, j.address, j.customer_name, j.id]
                    .filter(Boolean)
                    .join(" ")}
                  onSelect={() => {
                    setOpen(false);
                    navigate({ to: "/jobs/$id", params: { id: j.id } });
                  }}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {j.job_name || j.address || j.job_number || "Job"}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[j.job_number, j.customer_name, j.address !== j.job_name ? j.address : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  {j.status && (
                    <Badge variant="outline" className="shrink-0">
                      {JOB_STATUS_LABELS[j.status as JobStatus] ?? j.status}
                    </Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {rows.length > 0 && (
            <CommandGroup heading="Companies">
              {rows.map((r) => (
                <CommandItem
                  key={r.account_id}
                  value={[r.account_name, r.primary_contact_name, r.account_id]
                    .filter(Boolean)
                    .join(" ")}
                  onSelect={() => {
                    setOpen(false);
                    navigate({ to: "/accounts/$id", params: { id: r.account_id } });
                  }}
                  className="flex items-start justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{r.account_name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {r.primary_contact_name ?? "No primary contact"} · {r.status}
                    </div>
                  </div>
                  <Badge variant="outline" className="shrink-0">
                    {r.owning_location_code}
                  </Badge>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
    </>
  );
}
