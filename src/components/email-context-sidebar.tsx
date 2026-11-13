import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Building2,
  Calendar,
  CheckSquare,
  ChevronDown,
  Copy,
  Link2,
  Link2Off,
  Mail,
  Phone,
  Plus,
  UserPlus,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { resolveContactLocationId } from "@/lib/contacts";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { useCan } from "@/lib/permissions";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { NewTaskDialog } from "@/components/task-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { fetchStages } from "@/lib/pipeline";
import { fmtMoney } from "@/lib/pipeline";
import { toastDbError } from "@/lib/db-errors";
import { cn } from "@/lib/utils";
import {
  fetchEmailContext,
  formatMethod,
  initialsOf,
  isOverdue,
  setThreadLink,
  telHref,
  type CapturedComm,
  type Participant,
} from "@/lib/email-context";

/**
 * The email context sidebar.
 *
 * A rep reading a thread should never have to leave it to find out who these
 * people are, what is scheduled next, and where the relationship stands. Three
 * stacked cards, all derived from real relationships — an address that matches
 * nothing says so and offers to add it, which is how the contact database grows
 * without anyone doing data entry.
 */
export function EmailContextSidebar({
  messages,
  accountId,
  jobId,
  onChanged,
  className,
}: {
  messages: CapturedComm[];
  accountId: string | null;
  jobId: string | null;
  onChanged?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useCollapsedPref();

  const ctxQuery = useQuery({
    queryKey: ["email-context", messages.map((m) => m.id).join(","), accountId, jobId],
    queryFn: () => fetchEmailContext({ messages, accountId, jobId }),
    enabled: messages.length > 0,
  });

  const ctx = ctxQuery.data;

  return (
    <aside
      className={cn(
        // Narrow screens: below the message, not squeezed beside it.
        "w-full shrink-0 space-y-2 lg:w-[320px]",
        className,
      )}
      aria-label="Email context"
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between rounded-[6px] border bg-muted/40 px-3 py-1.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        Context
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
      </button>

      {open ? (
        ctxQuery.isLoading ? (
          <Card>
            <div className="px-3 py-2.5 text-[13px] text-muted-foreground">Loading context…</div>
          </Card>
        ) : ctxQuery.error ? (
          <Card>
            <div className="px-3 py-2.5 text-[13px] text-destructive">
              Context unavailable — {(ctxQuery.error as Error).message}
            </div>
          </Card>
        ) : ctx ? (
          <>
            <PeopleCard
              participants={ctx.participants}
              onChanged={() => {
                ctxQuery.refetch();
                onChanged?.();
              }}
            />
            <NextActivityCard
              next={ctx.next}
              accountId={accountId}
              jobId={jobId}
              onChanged={() => {
                ctxQuery.refetch();
                onChanged?.();
              }}
            />
            <LinkedRecordCard
              linked={ctx.linked}
              messageIds={messages.map((m) => m.id)}
              onChanged={() => {
                ctxQuery.refetch();
                onChanged?.();
              }}
            />
          </>
        ) : null
      ) : null}
    </aside>
  );
}

/* --------------------------------------------------------------- primitives */

function Card({ children }: { children: React.ReactNode }) {
  return <section className="rounded-[6px] border bg-card">{children}</section>;
}

function CardHead({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
      <h3 className="text-[13px] font-semibold">{children}</h3>
      {action}
    </header>
  );
}

function MicroLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </span>
  );
}

function useCollapsedPref(): [boolean, (v: boolean) => void] {
  const KEY = "email-context-sidebar-open";
  const [open, setOpenState] = useState(true);
  useEffect(() => {
    const stored = window.localStorage.getItem(KEY);
    if (stored !== null) setOpenState(stored === "1");
  }, []);
  const setOpen = (v: boolean) => {
    setOpenState(v);
    window.localStorage.setItem(KEY, v ? "1" : "0");
  };
  return [open, setOpen];
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Copy blocked by the browser");
  }
}

/* ------------------------------------------------- 1. people in this thread */

function PeopleCard({
  participants,
  onChanged,
}: {
  participants: Participant[];
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const person = participants[Math.min(selected, participants.length - 1)];

  if (!participants.length) {
    return (
      <Card>
        <CardHead>No participants found</CardHead>
        <div className="px-3 py-2.5 text-[13px] text-muted-foreground">
          This thread carries no readable addresses.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHead>
        {participants.length} {participants.length === 1 ? "person" : "people"} in this conversation
      </CardHead>

      <div className="flex flex-wrap gap-1 border-b px-2 py-2">
        {participants.map((p, i) => (
          <button
            key={p.address}
            type="button"
            onClick={() => setSelected(i)}
            title={p.contact?.full_name ?? p.headerName ?? p.address}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full border text-[11px] font-semibold",
              i === selected
                ? "border-primary bg-primary/10 text-primary ring-2 ring-primary/30"
                : "bg-muted text-muted-foreground",
              !p.contact && "border-dashed",
            )}
          >
            {initialsOf(p.contact?.full_name ?? p.headerName, p.address)}
          </button>
        ))}
      </div>

      {person ? <PersonDetail person={person} onChanged={onChanged} /> : null}
    </Card>
  );
}

function PersonDetail({ person, onChanged }: { person: Participant; onChanged: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  const name = person.contact?.full_name ?? person.headerName ?? person.address;

  return (
    <div className="space-y-2 px-3 py-2.5">
      <div>
        <div className="text-[14px] font-semibold leading-tight">{name}</div>
        <button
          type="button"
          onClick={() => copy(person.address)}
          className="mt-0.5 flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
        >
          <Mail className="h-3 w-3" />
          {person.address}
          <Copy className="h-3 w-3 opacity-50" />
        </button>
      </div>

      {person.contact ? (
        <>
          {person.contact.methods.length ? (
            <ul className="space-y-1">
              {person.contact.methods.map((m) => (
                <li key={m.id} className="flex items-center gap-1.5 text-[13px]">
                  <Phone className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <a href={telHref(m)} className="hover:underline">
                    {formatMethod(m)}
                  </a>
                  {m.is_preferred ? <MicroLabel>preferred</MicroLabel> : null}
                  <button
                    type="button"
                    onClick={() => copy(m.value + (m.extension ? ` ext.${m.extension}` : ""))}
                    className="ml-auto text-muted-foreground hover:text-foreground"
                    aria-label="Copy number"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="text-[12px] text-muted-foreground">No phone number on file.</div>
          )}

          {person.contact.account_name && person.contact.account_id ? (
            <Link
              to="/accounts/$id"
              params={{ id: person.contact.account_id }}

              className="flex items-center gap-1.5 text-[13px] text-primary hover:underline"
            >
              <Building2 className="h-3 w-3" />
              {person.contact.account_name}
            </Link>
          ) : null}

          {person.roleLabel ? (
            <div>
              <MicroLabel>{person.roleLabel}</MicroLabel>
            </div>
          ) : person.contact.title ? (
            <div className="text-[12px] text-muted-foreground">{person.contact.title}</div>
          ) : null}
        </>
      ) : (
        <div className="space-y-2">
          <div className="text-[12px] text-muted-foreground">Not in the CRM yet.</div>
          <Button size="sm" variant="outline" className="h-7" onClick={() => setAddOpen(true)}>
            <UserPlus className="mr-1 h-3.5 w-3.5" /> Add as contact
          </Button>
          <AddContactDialog
            open={addOpen}
            onOpenChange={setAddOpen}
            defaultName={person.headerName ?? ""}
            defaultEmail={person.address}
            defaultOrg={person.address.split("@")[1] ?? ""}
            onCreated={() => {
              setAddOpen(false);
              onChanged();
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Prefilled from the message headers — name, address, and the sending domain as
 * a starting organisation. The rep picks the account and confirms; nothing is
 * invented and nothing is typed twice.
 */
function AddContactDialog({
  open,
  onOpenChange,
  defaultName,
  defaultEmail,
  defaultOrg,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  defaultName: string;
  defaultEmail: string;
  defaultOrg: string;
  onCreated: () => void;
}) {
  const { userId } = useAppContext();
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const [name, setName] = useState(defaultName || defaultEmail.split("@")[0] || "");
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [phone, setPhone] = useState("");
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: async () => {
      if (!account) throw new Error("Pick the account this person belongs to");
      const { data, error } = await supabase
        .from("contacts")
        .insert({
          account_id: account.id,
          location_id: await resolveContactLocationId(account.id),
          full_name: name.trim(),
          email: defaultEmail,
          phone: phone.trim() || null,
          created_by: userId,
        })
        .select("id")
        .single();
      if (error) throw error;
      if (phone.trim()) {
        await supabase.from("contact_methods").insert({
          contact_id: data.id,
          kind: "phone",
          label: "Work",
          value: phone.trim(),
          is_preferred: true,
          created_by: userId,
        });
      }
    },
    onSuccess: () => {
      toast.success("Contact added");
      qc.invalidateQueries({ queryKey: ["email-context"] });
      onCreated();
    },
    onError: (e) => toastDbError(e, { action: "add contact" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add as contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-[12px]">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label className="text-[12px]">Email</Label>
            <Input value={defaultEmail} readOnly className="bg-muted" />
          </div>
          <AccountPicker value={account} onChange={setAccount} label="Organization / account" />
          <div className="text-[11px] text-muted-foreground">
            From the message headers: {defaultOrg}
          </div>
          <div>
            <Label className="text-[12px]">Phone (optional)</Label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button
            size="sm"
            disabled={writesDisabled || !name.trim() || !account || save.isPending}
            title={reason ?? undefined}
            onClick={() => save.mutate()}
          >
            Add contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------ 2. next activity */

function NextActivityCard({
  next,
  accountId,
  jobId,
  onChanged,
}: {
  next: { id: string; title: string; due_date: string | null; source: string } | null;
  accountId: string | null;
  jobId: string | null;
  onChanged: () => void;
}) {
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const qc = useQueryClient();

  const complete = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("tasks")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Activity completed");
      qc.invalidateQueries({ queryKey: ["tasks"] });
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "complete activity" }),
  });

  const addTrigger = (
    <button
      type="button"
      className="flex items-center gap-1 text-[12px] text-primary hover:underline"
      disabled={writesDisabled}
      title={reason ?? undefined}
    >
      <Plus className="h-3 w-3" /> Add activity
    </button>
  );

  const overdue = isOverdue(next?.due_date ?? null);

  return (
    <Card>
      <CardHead>Next activity</CardHead>
      <div className="space-y-2 px-3 py-2.5">
        {next ? (
          <div className="flex items-start gap-2">
            <Checkbox
              checked={false}
              disabled={writesDisabled || complete.isPending}
              onCheckedChange={() => complete.mutate(next.id)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-[13px] font-medium">
                {next.source === "calendar" ? (
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                ) : (
                  <CheckSquare className="h-3.5 w-3.5 text-muted-foreground" />
                )}
                <span className="truncate">{next.title}</span>
              </div>
              <div
                className={cn(
                  "text-[12px]",
                  overdue ? "font-medium text-destructive" : "text-muted-foreground",
                )}
              >
                {next.due_date
                  ? overdue
                    ? `Overdue · ${next.due_date}`
                    : next.due_date
                  : "No date"}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-[13px] text-muted-foreground">Nothing scheduled on this record.</div>
        )}

        {accountId || jobId ? (
          <NewTaskDialog
            link={{
              accountId,
              jobId,
              entityType: jobId ? "job" : "account",
              entityId: jobId ?? accountId,
            }}
            trigger={addTrigger}
            onCreated={onChanged}
          />
        ) : (
          <div className="text-[12px] text-muted-foreground">
            Link this thread to a record to schedule against it.
          </div>
        )}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------ 3. linked record */

function LinkedRecordCard({
  linked,
  messageIds,
  onChanged,
}: {
  linked: import("@/lib/email-context").LinkedRecord | null;
  messageIds: string[];
  onChanged: () => void;
}) {
  const app = useAppContext();
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const showMoney = useCan("job.view_costs");
  const [picked, setPicked] = useState<PickedAccount | null>(null);

  const relink = useMutation({
    mutationFn: async (accountId: string | null) => {
      await setThreadLink(messageIds, { accountId, jobId: null });
    },
    onSuccess: () => {
      toast.success("Thread updated");
      setPicked(null);
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "update thread link" }),
  });

  if (!linked) {
    return (
      <Card>
        <CardHead>Linked record</CardHead>
        <div className="space-y-2 px-3 py-2.5">
          <div className="text-[13px] text-muted-foreground">
            This thread is not attached to anything.
          </div>
          <AccountPicker value={picked} onChange={setPicked} label="Attach to" />
          <Button
            size="sm"
            className="h-7"
            disabled={!picked || writesDisabled || relink.isPending}
            title={reason ?? undefined}
            onClick={() => relink.mutate(picked!.id)}
          >
            <Link2 className="mr-1 h-3.5 w-3.5" /> Attach
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <CardHead
        action={
          <button
            type="button"
            className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-destructive"
            disabled={writesDisabled || relink.isPending}
            title={reason ?? "Unlink this thread"}
            onClick={() => relink.mutate(null)}
          >
            <Link2Off className="h-3 w-3" /> Unlink
          </button>
        }
      >
        Linked record
      </CardHead>
      <div className="space-y-2 px-3 py-2.5">
        {linked.kind === "account" ? (
          <Link
            to="/accounts/$id"
            params={{ id: linked.id }}
            className="block text-[14px] font-semibold text-primary hover:underline"
          >
            {linked.name}
          </Link>
        ) : (
          <Link
            to="/jobs/$id"
            params={{ id: linked.id }}
            className="block text-[14px] font-semibold text-primary hover:underline"
          >
            {linked.name}
          </Link>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[12px]">
          <dt className="text-muted-foreground">Owner</dt>
          <dd>{linked.ownerName ?? "Unassigned"}</dd>
          <dt className="text-muted-foreground">Organization</dt>
          <dd className="truncate">{linked.orgName ?? "—"}</dd>
        </dl>

        {linked.kind === "account" ? (
          <MiniStagePath
            pipelineId={linked.pipelineId}
            stageId={linked.stageId}
            healthPipelineId={linked.healthPipelineId}
            healthStageId={linked.healthStageId}
          />
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The record header's stage path, shrunk: chevrons plus the stage name beneath,
 * read-only. Farming stage is appended when the account has one — "Clients –
 * Active / Healthy" is one relationship state, not two.
 */
function MiniStagePath({
  pipelineId,
  stageId,
  healthPipelineId,
  healthStageId,
}: {
  pipelineId: string | null;
  stageId: string | null;
  healthPipelineId: string | null;
  healthStageId: string | null;
}) {
  const stagesQ = useQuery({
    queryKey: ["mini-stage-path", pipelineId],
    enabled: !!pipelineId,
    queryFn: () => fetchStages(pipelineId!),
  });
  const healthQ = useQuery({
    queryKey: ["mini-stage-path", healthPipelineId],
    enabled: !!healthPipelineId,
    queryFn: () => fetchStages(healthPipelineId!),
  });

  const stages = useMemo(() => (stagesQ.data ?? []).filter((s) => s.is_active), [stagesQ.data]);
  const activeIndex = stages.findIndex((s) => s.id === stageId);
  const label = useMemo(() => {
    const sales = stages.find((s) => s.id === stageId)?.name ?? null;
    const health = (healthQ.data ?? []).find((s) => s.id === healthStageId)?.name ?? null;
    return [sales, health].filter(Boolean).join(" / ") || "No stage";
  }, [stages, stageId, healthQ.data, healthStageId]);

  if (!pipelineId || !stages.length) {
    return <div className="text-[12px] text-muted-foreground">No pipeline stage.</div>;
  }

  return (
    <div>
      <div className="flex gap-[2px]">
        {stages.map((s, i) => (
          <span
            key={s.id}
            title={s.name}
            className={cn(
              "h-1.5 flex-1 first:rounded-l-[2px] last:rounded-r-[2px]",
              activeIndex >= 0 && i <= activeIndex ? "bg-primary" : "bg-muted",
            )}
            style={
              activeIndex >= 0 && i === activeIndex
                ? { backgroundColor: s.color || undefined }
                : undefined
            }
          />
        ))}
      </div>
      <div className="mt-1 text-[12px] font-medium">{label}</div>
    </div>
  );
}
