import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, BadgeCheck, Paperclip, Plus } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { BackLink } from "@/components/back-link";
import { RecordLoadError } from "@/components/record-load-error";
import { PageHeader } from "@/components/ui-density";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { JOB_STATUS_LABELS } from "@/lib/jobs";
import { toastDbError } from "@/lib/db-errors";
import {
  VENDOR_DOC_KINDS,
  VENDOR_DOC_KIND_LABEL,
  VENDOR_JOB_LINK_LABEL,
  VENDOR_RENEWAL_LEAD_DAYS,
  VENDOR_STATE_LABEL,
  VENDOR_STATE_TONE,
  addVendorNote,
  createVendorDocument,
  daysToExpiry,
  expiryPhrase,
  fetchVendorAccount,
  fetchVendorDocumentsFor,
  fetchVendorJobs,
  fetchVendorNotes,
  formatDate,
  prettyRole,
  rollupVendorDocs,
  setVendorDocumentVerified,
  updateVendorDocument,
  vendorDocState,
  type VendorDocKind,
  type VendorDocStatus,
  type VendorDocument,
} from "@/lib/vendors";

/**
 * One vendor: what they owe us, what we have said about them, and what they
 * have actually worked on. The three sections are separate reads on purpose —
 * a blocked job history must not make the paperwork look unread.
 */

export const Route = createFileRoute("/_authenticated/vendors/$id")({
  head: () => ({
    meta: [
      { title: "Vendor · Recovery Hub" },
      {
        name: "description",
        content:
          "A vendor's insurance and license documents with expiry dates, their notes, and every job they have worked.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: VendorDetailPage,
});

function VendorDetailPage() {
  const { id } = Route.useParams();
  const app = useAppContext();
  const qc = useQueryClient();

  const accountQ = useQuery({
    queryKey: ["vendor-account", id],
    queryFn: () => fetchVendorAccount(id),
  });
  const docsQ = useQuery({
    queryKey: ["vendor-docs", id],
    queryFn: () => fetchVendorDocumentsFor(id),
  });
  const notesQ = useQuery({ queryKey: ["vendor-notes", id], queryFn: () => fetchVendorNotes(id) });
  const jobsQ = useQuery({ queryKey: ["vendor-jobs", id], queryFn: () => fetchVendorJobs(id) });

  if (accountQ.error) {
    return (
      <RecordLoadError
        error={accountQ.error}
        record="vendor"
        table="accounts"
        id={id}
        onRetry={() => void accountQ.refetch()}
      />
    );
  }
  if (accountQ.isLoading) {
    return <div className="px-5 py-6 text-[13px] text-muted-foreground">Loading vendor…</div>;
  }
  if (!accountQ.data) {
    return (
      <div className="px-5 py-6 text-[13px] text-muted-foreground">
        This vendor is not visible to you, or no longer exists.
      </div>
    );
  }

  const account = accountQ.data;
  const roll = rollupVendorDocs(docsQ.data ?? []);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["vendor-docs", id] });
    void qc.invalidateQueries({ queryKey: ["vendor-documents"] });
  };

  return (
    <div className="space-y-3 px-3 py-4 sm:px-4">
      <BackLink
        fallbackTo="/vendors"
        label="Vendors"
        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:underline"
      >
        <ArrowLeft className="size-3.5" /> Vendors
      </BackLink>

      <PageHeader
        title={account.name}
        subtitle={
          [account.city, account.state].filter(Boolean).join(", ") ||
          "No address on the account record"
        }
      >
        <div className="flex items-center gap-2">
          {!docsQ.error && !docsQ.isLoading && (
            <Badge
              variant="outline"
              className={`h-5 rounded-[4px] px-2 text-[11px] ${VENDOR_STATE_TONE[roll.state]}`}
            >
              {VENDOR_STATE_LABEL[roll.state]}
            </Badge>
          )}
          <Link
            to="/accounts/$id"
            params={{ id }}
            className="text-[12px] text-muted-foreground hover:underline"
          >
            Full account record
          </Link>
        </div>
      </PageHeader>

      <DocumentsSection
        accountId={id}
        docsQ={docsQ}
        disabled={app.writesDisabled}
        userId={app.userId}
        onChanged={refresh}
      />

      <NotesSection
        accountId={id}
        notesQ={notesQ}
        disabled={app.writesDisabled}
        userId={app.userId}
        onChanged={() => void qc.invalidateQueries({ queryKey: ["vendor-notes", id] })}
      />

      <JobsSection jobsQ={jobsQ} />
    </div>
  );
}

/* -------------------------------------------------------------- documents */

type DocsQuery = ReturnType<typeof useQuery<VendorDocument[], Error>>;

function DocumentsSection({
  accountId,
  docsQ,
  disabled,
  userId,
  onChanged,
}: {
  accountId: string;
  docsQ: DocsQuery;
  disabled: boolean;
  userId: string | null;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);

  if (docsQ.error) {
    return (
      <Section title="Insurance & license documents">
        <RecordLoadError
          error={docsQ.error}
          record="vendor paperwork"
          table="vendor_documents"
          id={accountId}
          onRetry={() => void docsQ.refetch()}
          compact
        />
      </Section>
    );
  }

  const docs = docsQ.data ?? [];
  const roll = rollupVendorDocs(docs);

  return (
    <Section
      title="Insurance & license documents"
      action={
        <Button
          size="sm"
          className="h-7 text-[12px]"
          disabled={disabled}
          onClick={() => setAdding(true)}
        >
          <Plus className="mr-1 size-3.5" /> Add document
        </Button>
      }
    >
      {!docsQ.isLoading && roll.missingKinds.length > 0 && (
        <p className="px-3 pt-2 text-[12px] text-muted-foreground">
          Nothing on file for{" "}
          <span className="font-medium text-foreground">
            {roll.missingKinds.map((k) => VENDOR_DOC_KIND_LABEL[k]).join(", ")}
          </span>
          . Until it is filed this vendor is unapproved, not simply undocumented.
        </p>
      )}

      <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="px-2 py-1.5 text-left font-medium">Document</th>
              <th className="px-2 py-1.5 text-left font-medium">State</th>
              <th className="px-2 py-1.5 text-left font-medium">Carrier / policy</th>
              <th className="px-2 py-1.5 text-left font-medium">Expires</th>
              <th className="px-2 py-1.5 text-left font-medium">Verified</th>
              <th className="px-2 py-1.5 text-left font-medium">File</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <DocumentRow
                key={d.id}
                doc={d}
                disabled={disabled}
                userId={userId}
                onChanged={onChanged}
              />
            ))}
            {docs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                  {docsQ.isLoading ? "Loading…" : "No documents filed for this vendor."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AddDocumentDialog
        open={adding}
        onOpenChange={setAdding}
        accountId={accountId}
        userId={userId}
        onSaved={onChanged}
      />
    </Section>
  );
}

function DocumentRow({
  doc,
  disabled,
  userId,
  onChanged,
}: {
  doc: VendorDocument;
  disabled: boolean;
  userId: string | null;
  onChanged: () => void;
}) {
  const state = vendorDocState(doc);
  const days = daysToExpiry(doc.expiry_date);

  const setExpiry = useMutation({
    mutationFn: (value: string) => updateVendorDocument(doc.id, { expiry_date: value || null }),
    onSuccess: () => {
      toast.success("Expiry updated");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "Updating the expiry date" }),
  });

  const verify = useMutation({
    mutationFn: () => setVendorDocumentVerified(doc.id, !doc.verified_at, userId),
    onSuccess: () => {
      toast.success(doc.verified_at ? "Verification cleared" : "Marked verified");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "Marking the document verified" }),
  });

  return (
    <tr className="border-t align-top">
      <td className="px-2 py-1.5">
        <div className="font-medium">{VENDOR_DOC_KIND_LABEL[doc.kind]}</div>
        {doc.name && <div className="text-[11px] text-muted-foreground">{doc.name}</div>}
        {doc.notes && <div className="mt-0.5 text-[11px] text-muted-foreground">{doc.notes}</div>}
      </td>
      <td className="px-2 py-1.5">
        <Badge
          variant="outline"
          className={`h-4 rounded-[4px] px-1.5 text-[10px] ${VENDOR_STATE_TONE[state]}`}
        >
          {VENDOR_STATE_LABEL[state]}
        </Badge>
      </td>
      <td className="px-2 py-1.5">
        <div>{doc.carrier ?? doc.issuer ?? "—"}</div>
        {doc.policy_number && (
          <div className="text-[11px] text-muted-foreground">{doc.policy_number}</div>
        )}
      </td>
      <td className="px-2 py-1.5">
        <Input
          type="date"
          className="h-7 w-36 text-[12px]"
          defaultValue={doc.expiry_date ?? ""}
          disabled={disabled || setExpiry.isPending}
          onBlur={(e) => {
            if ((e.target.value || null) !== doc.expiry_date) setExpiry.mutate(e.target.value);
          }}
        />
        <div
          className={`mt-0.5 text-[11px] ${
            days != null && days < 0
              ? "text-red-700 dark:text-red-400"
              : days != null && days <= VENDOR_RENEWAL_LEAD_DAYS
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground"
          }`}
        >
          {expiryPhrase(days)}
        </div>
      </td>
      <td className="px-2 py-1.5">
        <Button
          size="sm"
          variant={doc.verified_at ? "secondary" : "outline"}
          className="h-6 px-2 text-[11px]"
          disabled={disabled || verify.isPending}
          onClick={() => verify.mutate()}
        >
          <BadgeCheck className="mr-1 size-3" />
          {doc.verified_at ? formatDate(doc.verified_at) : "Mark verified"}
        </Button>
      </td>
      <td className="px-2 py-1.5 text-[11px] text-muted-foreground">
        {doc.storage_path ? (
          <span className="inline-flex items-center gap-1">
            <Paperclip className="size-3" />
            {/* The path is recorded but the `documents` bucket only grants
                access through a row in `documents`, so there is nothing to
                link to yet. Saying so beats a button that 403s. */}
            Path on record — download not wired
          </span>
        ) : (
          "No file attached"
        )}
      </td>
    </tr>
  );
}

const STATUS_CHOICES: { value: VendorDocStatus; label: string }[] = [
  { value: "active", label: "Received and in force" },
  { value: "pending", label: "Requested, not received" },
  { value: "missing", label: "Not held" },
];

function AddDocumentDialog({
  open,
  onOpenChange,
  accountId,
  userId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  userId: string | null;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<VendorDocKind>("coi");
  const [status, setStatus] = useState<VendorDocStatus>("active");
  const [name, setName] = useState("");
  const [carrier, setCarrier] = useState("");
  const [policy, setPolicy] = useState("");
  const [amount, setAmount] = useState("");
  const [effective, setEffective] = useState("");
  const [expiry, setExpiry] = useState("");
  const [notes, setNotes] = useState("");

  const save = useMutation({
    mutationFn: () =>
      createVendorDocument(
        accountId,
        {
          kind,
          status,
          name: name.trim() || null,
          carrier: carrier.trim() || null,
          policy_number: policy.trim() || null,
          covered_amount: amount.trim() ? Number(amount) : null,
          effective_date: effective || null,
          expiry_date: expiry || null,
          notes: notes.trim() || null,
        },
        userId,
      ),
    onSuccess: () => {
      toast.success("Document filed");
      onOpenChange(false);
      setName("");
      setCarrier("");
      setPolicy("");
      setAmount("");
      setEffective("");
      setExpiry("");
      setNotes("");
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "Filing the vendor document" }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a vendor document</DialogTitle>
        </DialogHeader>
        {/* One column on a phone — two 45px-wide fields is not a form. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Type">
            <Select value={kind} onValueChange={(v) => setKind(v as VendorDocKind)}>
              <SelectTrigger className="h-11 text-base sm:h-8 sm:text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENDOR_DOC_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {VENDOR_DOC_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {/* `expired` is deliberately not offered — it is read off the expiry
              date, so it can never be set to something the date contradicts. */}
          <Field label="Status">
            <Select value={status} onValueChange={(v) => setStatus(v as VendorDocStatus)}>
              <SelectTrigger className="h-11 text-base sm:h-8 sm:text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_CHOICES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Description" className="sm:col-span-2">
            <Input
              className="h-11 text-base sm:h-8 sm:text-[12px]"
              placeholder="General liability — 2026 renewal"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Carrier / issuer">
            <Input
              className="h-11 text-base sm:h-8 sm:text-[12px]"
              value={carrier}
              onChange={(e) => setCarrier(e.target.value)}
            />
          </Field>
          <Field label="Policy number">
            <Input
              className="h-11 text-base sm:h-8 sm:text-[12px]"
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
            />
          </Field>
          <Field label="Effective">
            <Input
              type="date"
              className="h-11 text-base sm:h-8 sm:text-[12px]"
              value={effective}
              onChange={(e) => setEffective(e.target.value)}
            />
          </Field>
          <Field label="Expires">
            <Input
              type="date"
              className="h-11 text-base sm:h-8 sm:text-[12px]"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
            />
          </Field>
          <Field label="Covered amount" className="sm:col-span-2">
            <NumberInput
              decimals={2}
              className="h-11 text-base sm:h-8 sm:text-[12px]"
              placeholder="1,000,000"
              value={amount}
              onValueChange={(_, clean) => setAmount(clean)}
            />
          </Field>
          <Field label="Notes" className="sm:col-span-2">
            <Textarea
              rows={2}
              className="text-base sm:text-[12px]"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>
        <p className="text-[11px] text-muted-foreground">
          The certificate itself cannot be attached yet — file storage for vendor documents is not
          wired, so this records the evidence, not the PDF.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ notes */

function NotesSection({
  accountId,
  notesQ,
  disabled,
  userId,
  onChanged,
}: {
  accountId: string;
  notesQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchVendorNotes>>, Error>>;
  disabled: boolean;
  userId: string | null;
  onChanged: () => void;
}) {
  const [body, setBody] = useState("");

  const add = useMutation({
    mutationFn: () => addVendorNote(accountId, body, userId),
    onSuccess: () => {
      setBody("");
      onChanged();
    },
    onError: (e) => toastDbError(e, { action: "Saving the note" }),
  });

  return (
    <Section title="Notes">
      {notesQ.error ? (
        <RecordLoadError
          error={notesQ.error}
          record="vendor notes"
          table="account_notes"
          id={accountId}
          onRetry={() => void notesQ.refetch()}
          compact
        />
      ) : (
        <div className="space-y-2 p-3">
          <div className="flex gap-2">
            <Textarea
              rows={2}
              className="text-base sm:text-[12px]"
              placeholder="What happened, so the next person does not have to ask."
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <Button
              className="h-8 self-end text-[12px]"
              disabled={disabled || !body.trim() || add.isPending}
              onClick={() => add.mutate()}
            >
              Add
            </Button>
          </div>
          {(notesQ.data ?? []).map((n) => (
            <div key={n.id} className="rounded-[6px] border px-2 py-1.5 text-[12px]">
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {formatDate(n.created_at)}
                {n.is_pinned ? " · pinned" : ""}
              </p>
            </div>
          ))}
          {!notesQ.isLoading && (notesQ.data ?? []).length === 0 && (
            <p className="text-[12px] text-muted-foreground">No notes on this vendor yet.</p>
          )}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------ job history */

function JobsSection({
  jobsQ,
}: {
  jobsQ: ReturnType<typeof useQuery<Awaited<ReturnType<typeof fetchVendorJobs>>, Error>>;
}) {
  return (
    <Section title="Job history">
      {jobsQ.error ? (
        <RecordLoadError
          error={jobsQ.error}
          record="job history"
          table="jobs"
          onRetry={() => void jobsQ.refetch()}
          compact
        />
      ) : (
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-muted text-[11px] uppercase text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">Job</th>
                <th className="px-2 py-1.5 text-left font-medium">Address</th>
                <th className="px-2 py-1.5 text-left font-medium">How they are attached</th>
                <th className="px-2 py-1.5 text-left font-medium">Started</th>
                <th className="px-2 py-1.5 text-left font-medium">Completed</th>
                <th className="px-2 py-1.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(jobsQ.data ?? []).map((j) => (
                <tr key={j.jobId} className="border-t">
                  <td className="px-2 py-1.5">
                    <Link
                      to="/jobs/$id"
                      params={{ id: j.jobId }}
                      className="font-medium hover:underline"
                    >
                      {j.jobNumber}
                    </Link>
                  </td>
                  <td className="px-2 py-1.5">{j.address}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {j.links
                      .map((l) =>
                        l.role
                          ? `${VENDOR_JOB_LINK_LABEL[l.link]} — ${prettyRole(l.role)}`
                          : VENDOR_JOB_LINK_LABEL[l.link],
                      )
                      .join(" · ")}
                  </td>
                  <td className="px-2 py-1.5">{formatDate(j.startedOn)}</td>
                  <td className="px-2 py-1.5">{formatDate(j.completedOn)}</td>
                  <td className="px-2 py-1.5">{JOB_STATUS_LABELS[j.status] ?? j.status}</td>
                </tr>
              ))}
              {(jobsQ.data ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} className="px-2 py-6 text-center text-muted-foreground">
                    {jobsQ.isLoading
                      ? "Loading…"
                      : "No jobs name this vendor as a party, an account or a referrer."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ shell */

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[6px] border bg-card">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-[13px] font-medium">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={className}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <div className="mt-1">{children}</div>
    </div>
  );
}
