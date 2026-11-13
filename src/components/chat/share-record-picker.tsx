import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Building2, Briefcase, Search } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { supportedShareTypes, type SharePickerType as Kind } from "@/lib/chat-records";

interface ShareRecordPickerProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (type: Kind, id: string, label: string) => void;
}

export function ShareRecordPicker({ open, onOpenChange, onPick }: ShareRecordPickerProps) {
  const [tab, setTab] = useState<Kind>("job");
  const [q, setQ] = useState("");

  const capabilities = useQuery({
    queryKey: ["chat-share-capabilities"],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () => {
      // The RPC is introduced by the sharing migration; old schemas stay usable.
      const { data, error } = await supabase.rpc("chat_shared_record_types" as never);
      return supportedShareTypes(error ? null : data);
    },
  });
  const types = capabilities.data ?? supportedShareTypes(null);
  const extraQ = useQuery({
    queryKey: ["share-extra", tab, q],
    enabled: open && types.includes(tab) && (tab === "project" || tab === "invoice"),
    queryFn: async () => {
      if (tab === "project") {
        let query = supabase
          .from("projects")
          .select("id,name,address")
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(20);
        if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
        const { data, error } = await query;
        if (error) throw error;
        return (data ?? []).map((r) => ({ id: r.id, label: r.name, detail: r.address }));
      }
      let query = supabase
        .from("invoices")
        .select("id,invoice_number,customer_name,status")
        .order("created_at", { ascending: false })
        .limit(20);
      if (q.trim()) query = query.ilike("invoice_number", `%${q.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []).map((r) => ({
        id: r.id,
        label: r.invoice_number,
        detail: `${r.customer_name ?? ""} · ${r.status}`,
      }));
    },
  });
  const jobsQ = useQuery({
    queryKey: ["share-jobs", q],
    enabled: open && tab === "job",
    queryFn: async () => {
      let query = supabase
        .from("jobs")
        .select("id, job_number, address, status")
        .order("created_at", { ascending: false })
        .limit(20);
      if (q.trim()) {
        query = query.or(`job_number.ilike.%${q.trim()}%,address.ilike.%${q.trim()}%`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const accountsQ = useQuery({
    queryKey: ["share-accounts", q],
    enabled: open && tab === "account",
    queryFn: async () => {
      let query = supabase
        .from("accounts")
        .select("id, name, status, account_type")
        .order("updated_at", { ascending: false })
        .limit(20);
      if (q.trim()) query = query.ilike("name", `%${q.trim()}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const pick = (type: Kind, id: string, label: string) => {
    onPick(type, id, label);
    onOpenChange(false);
    setQ("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share a record</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder={`Search ${tab}s…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as Kind)}>
          <TabsList className="flex flex-wrap h-auto">
            <TabsTrigger value="job">
              <Briefcase className="mr-1 size-4" /> Jobs
            </TabsTrigger>
            <TabsTrigger value="account">
              <Building2 className="mr-1 size-4" /> Accounts
            </TabsTrigger>
            {types.includes("project") && <TabsTrigger value="project">Projects</TabsTrigger>}
            {types.includes("invoice") && <TabsTrigger value="invoice">Invoices</TabsTrigger>}
          </TabsList>
          <TabsContent value="job">
            <Results>
              {jobsQ.isError && (
                <Empty>
                  Could not load jobs.{" "}
                  <button type="button" className="underline" onClick={() => void jobsQ.refetch()}>
                    Retry
                  </button>
                </Empty>
              )}
              {(jobsQ.data ?? []).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pick("job", r.id, r.job_number)}
                  className="w-full border-b p-2 text-left text-sm last:border-0 hover:bg-accent/50"
                >
                  <div className="font-mono text-xs font-semibold">{r.job_number}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.address} · {r.status}
                  </div>
                </button>
              ))}
              {(jobsQ.data ?? []).length === 0 && !jobsQ.isLoading && !jobsQ.isError && (
                <Empty>No jobs match.</Empty>
              )}
            </Results>
          </TabsContent>
          <TabsContent value="account">
            <Results>
              {accountsQ.isError && (
                <Empty>
                  Could not load accounts.{" "}
                  <button
                    type="button"
                    className="underline"
                    onClick={() => void accountsQ.refetch()}
                  >
                    Retry
                  </button>
                </Empty>
              )}
              {(accountsQ.data ?? []).map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => pick("account", r.id, r.name)}
                  className="w-full border-b p-2 text-left text-sm last:border-0 hover:bg-accent/50"
                >
                  <div className="font-medium">{r.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.account_type} · {r.status}
                  </div>
                </button>
              ))}
              {(accountsQ.data ?? []).length === 0 &&
                !accountsQ.isLoading &&
                !accountsQ.isError && <Empty>No accounts match.</Empty>}
            </Results>
          </TabsContent>
          {(["project", "invoice"] as const)
            .filter((t) => types.includes(t))
            .map((kind) => (
              <TabsContent key={kind} value={kind}>
                <Results>
                  {extraQ.isLoading && <Empty>Loading…</Empty>}
                  {extraQ.isError && (
                    <Empty>
                      Could not load records.{" "}
                      <button
                        type="button"
                        className="underline"
                        onClick={() => void extraQ.refetch()}
                      >
                        Retry
                      </button>
                    </Empty>
                  )}
                  {(extraQ.data ?? []).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => pick(kind, r.id, r.label)}
                      className="w-full border-b p-2 text-left text-sm last:border-0 hover:bg-accent/50"
                    >
                      <div className="font-medium">{r.label}</div>
                      <div className="text-xs text-muted-foreground">{r.detail}</div>
                    </button>
                  ))}
                  {extraQ.isSuccess && !extraQ.data.length && <Empty>No records match.</Empty>}
                </Results>
              </TabsContent>
            ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function Results({ children }: { children: React.ReactNode }) {
  return <div className={cn("mt-2 max-h-80 overflow-y-auto rounded-sm border")}>{children}</div>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="p-4 text-center text-sm text-muted-foreground">{children}</div>;
}
