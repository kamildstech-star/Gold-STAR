import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import { AlertTriangle, Building2, Receipt } from "lucide-react";
import { JobField, SectionEdit } from "@/components/job-inline-field";
import { fetchBillToAccount } from "@/lib/bill-to";
import {
  billingDocImpact,
  billingMismatch,
  entityLabel,
  loadBillingOffices,
  officeLabel,
  resolveBillingOffice,
  setJobBillingLocation,
  type BillingOffice,
} from "@/lib/billing-entity";

/** Only what this card reads; the whole job row is what actually comes in. */
export type BillToJob = {
  id: string;
  location_id: string;
  billing_location_id: string | null;
  account_id: string | null;
  customer_name: string | null;
  bill_to_account_id: string | null;
  bill_to_attention: string | null;
  region: string | null;
  lat: number | null;
  lon: number | null;
};

type Props = {
  job: BillToJob;
  canEdit?: boolean;
  /** A bill-to edit changed the job row — the page needs to re-read it. */
  onSaved?: () => void;
  onBillingLocationChanged?: (locationId: string) => void;
  /**
   * Sidebar density. The card used to run the full width of the Billing tab
   * and read as the tab's subject; in a 20rem rail it is one fact among
   * several, so the explanatory paragraph goes and the type steps down.
   */
  compact?: boolean;
};

/**
 * Who this job is billed to.
 *
 * This card used to name the Gold Star entity doing the billing, which read to
 * everyone as the customer's billing entity. It now names the party the
 * invoice is addressed to — the property manager, the landlord's LLC, the
 * carrier — falling back to the job's own customer, which is what most jobs
 * bill. The issuing entity is still settable, as the subordinate line at the
 * bottom: it is our identity, not the customer's, and it is read far less
 * often than it used to be shown.
 */
export function JobBillToCard({
  job,
  canEdit = true,
  onSaved,
  onBillingLocationChanged,
  compact = false,
}: Props) {
  const payerId = job.bill_to_account_id ?? job.account_id ?? null;

  const payer = useQuery({
    queryKey: ["job-bill-to-account", payerId],
    enabled: !!payerId,
    queryFn: () => fetchBillToAccount(payerId!),
    staleTime: 60_000,
  });

  const explicit = !!job.bill_to_account_id;
  const account = payer.data ?? null;

  return (
    <Card>
      <CardHeader className={compact ? "p-4 pb-2" : "pb-3"}>
        <CardTitle className={`flex items-center gap-2 ${compact ? "text-sm" : "text-base"}`}>
          <Receipt className="h-4 w-4 text-muted-foreground" />
          Bill to
          {explicit ? (
            <Badge variant="outline" className="ml-1 font-normal">
              not the customer
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className={compact ? "space-y-2.5 p-4 pt-0" : "space-y-3"}>
        {/*
         * The address block as the invoice will print it. A failed read is
         * said out loud: an empty card here is indistinguishable from "bills
         * the customer", and the two lead to very different invoices.
         */}
        {payer.isError ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            Could not read the bill-to account. This is not &ldquo;nobody is set&rdquo; — it is
            unknown. Reload before sending anything from this job.
          </p>
        ) : payerId && payer.isLoading ? (
          <p className="text-sm text-muted-foreground">Reading the payer…</p>
        ) : (
          <div className="space-y-0.5 text-sm">
            <p className="font-medium">{account?.name || job.customer_name || "—"}</p>
            {job.bill_to_attention ? (
              <p className="text-muted-foreground">Attn: {job.bill_to_attention}</p>
            ) : null}
            {account?.address_line1 ? <p>{account.address_line1}</p> : null}
            {[account?.city, account?.state, account?.postal_code].filter(Boolean).length ? (
              <p>
                {[account?.city, account?.state, account?.postal_code].filter(Boolean).join(", ")}
              </p>
            ) : null}
            {account?.email ? <p className="text-muted-foreground">{account.email}</p> : null}
            {payerId && !payer.isLoading && !account ? (
              <p className="text-muted-foreground">
                That account is not visible to you — another office owns it. The invoice still
                prints it.
              </p>
            ) : null}
          </div>
        )}

        {/* In the rail the one-line version says enough; the long form
            explains when to set a party, which the field label already implies. */}
        <p className="text-xs text-muted-foreground">
          {explicit
            ? "Invoices and estimates are addressed here instead of the customer."
            : compact
              ? "Defaults to the job's customer."
              : "Defaults to the job's customer. Set a party here when the bill goes to a property manager, a landlord's company or the carrier."}
        </p>

        <div className={`space-y-1.5 border-t text-sm ${compact ? "pt-2.5" : "pt-3"}`}>
          {/*
           * SectionEdit gives the account field the shape of a control rather
           * than dead text — it does not unlock it, relation fields open their
           * own dialog either way. The attention line stays click-to-edit so
           * the card does not sit with an open input in it.
           */}
          <SectionEdit editing>
            <JobField job={job} fieldKey="bill_to_account_id" label="Bill to" onSaved={onSaved} />
          </SectionEdit>
          <JobField job={job} fieldKey="bill_to_attention" label="Attention" onSaved={onSaved} />
        </div>

        <Separator />

        <IssuingEntityLine
          jobId={job.id}
          billingLocationId={job.billing_location_id}
          jobLocationId={job.location_id}
          region={job.region}
          lat={job.lat}
          lon={job.lon}
          canEdit={canEdit}
          onChanged={onBillingLocationChanged}
        />
      </CardContent>
    </Card>
  );
}

/**
 * Which Gold Star entity issues the paperwork. Subordinate to the bill-to
 * above but never removable: an unresolved job generates documents with no
 * EIN and no payment link, and without this control there would be no way to
 * fix one. The office also decides the logo, phone, card link and Zelle
 * address, so all of that lives behind the same button.
 */
function IssuingEntityLine({
  jobId,
  billingLocationId,
  jobLocationId,
  region,
  lat,
  lon,
  canEdit,
  onChanged,
}: {
  jobId: string;
  billingLocationId: string | null;
  jobLocationId: string;
  region: string | null;
  lat?: number | null;
  lon?: number | null;
  canEdit: boolean;
  onChanged?: (locationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<string | null>(billingLocationId ?? null);
  const [saving, setSaving] = useState(false);
  const [impact, setImpact] = useState<{ unsent: number; sent: number } | null>(null);

  const officesQ = useQuery({
    queryKey: ["billing-offices"],
    queryFn: loadBillingOffices,
    staleTime: 5 * 60_000,
  });
  const offices = officesQ.data ?? [];

  useEffect(() => setValue(billingLocationId ?? null), [billingLocationId]);
  useEffect(() => {
    billingDocImpact(jobId)
      .then(setImpact)
      .catch(() => setImpact(null));
  }, [jobId]);

  const selected = offices.find((o) => o.id === value) ?? null;
  const suggestion = resolveBillingOffice(offices, region, lat, lon);
  const mismatch = billingMismatch(selected, region);
  const unresolved = !value;

  const save = async (next: string) => {
    setSaving(true);
    try {
      await setJobBillingLocation(jobId, next);
      setValue(next);
      onChanged?.(next);
      const office = offices.find((o) => o.id === next) ?? null;
      if (impact?.sent) {
        toast.warning(
          `${impact.sent} document${impact.sent === 1 ? "" : "s"} already went out under the previous entity — those stay as sent. Unsent documents now bill as ${entityLabel(office)}.`,
        );
      } else {
        toast.success(
          `This job now bills as ${entityLabel(office)}. Unsent documents re-resolved.`,
        );
      }
      setImpact(await billingDocImpact(jobId).catch(() => impact ?? { unsent: 0, sent: 0 }));
    } catch (e) {
      toastDbError(e, { action: "change the billing office" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {unresolved ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="font-medium">No Gold Star entity is billing this job</p>
            <p className="text-muted-foreground">
              {suggestion.reason ??
                "This address is outside every office's footprint — pick the entity that will bill it."}{" "}
              Until it is set, documents print with no EIN and no payment link.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={!canEdit}
              onClick={() => setOpen(true)}
            >
              Choose entity
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <Building2 className="h-3.5 w-3.5 shrink-0" />
          <span>Bills as</span>
          <button
            type="button"
            className="font-medium text-foreground underline decoration-dotted underline-offset-2 disabled:no-underline"
            disabled={!canEdit}
            onClick={() => setOpen(true)}
          >
            {selected ? officeLabel(selected) : officesQ.isError ? "unknown" : "…"}
          </button>
          {selected && selected.id !== jobLocationId ? (
            <Badge variant="outline" className="font-normal">
              differs from operating office
            </Badge>
          ) : null}
          {mismatch ? (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-700 dark:text-amber-400" />
          ) : null}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Which Gold Star entity bills this job?</DialogTitle>
            <DialogDescription>
              Each office is its own legal entity. Its EIN, logo, phone, payment link and Zelle
              address go on every document, estimate, invoice and email this job produces.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/*
             * An offices read that failed used to arrive as an empty select,
             * which reads as "there are no offices" — the one thing that is
             * never true.
             */}
            {officesQ.isError ? (
              <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                Could not load the offices. The list below is empty because the read failed, not
                because there are none.
              </p>
            ) : null}

            <Select
              value={value ?? undefined}
              onValueChange={save}
              disabled={!canEdit || saving || offices.length === 0}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={officesQ.isLoading ? "Loading offices…" : "Choose a billing office"}
                />
              </SelectTrigger>
              <SelectContent>
                {offices.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {officeLabel(o)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {suggestion.office && suggestion.office.id === value ? (
              <p className="text-xs text-muted-foreground">{suggestion.reason}</p>
            ) : null}

            {selected ? <EntityDetails office={selected} /> : null}

            {mismatch ? (
              <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-800 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {mismatch}
              </p>
            ) : null}

            {impact?.sent ? (
              <p className="text-xs text-muted-foreground">
                {impact.sent} document{impact.sent === 1 ? " has" : "s have"} already gone out under
                the current entity. Changing the office only re-resolves the {impact.unsent} unsent
                one{impact.unsent === 1 ? "" : "s"}.
              </p>
            ) : null}

            {suggestion.office && value && suggestion.office.id !== value ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => save(suggestion.office!.id)}
                disabled={saving}
              >
                Use suggested: {officeLabel(suggestion.office)}
              </Button>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function EntityDetails({ office }: { office: BillingOffice }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
      <div className="col-span-2">
        <dt className="text-xs text-muted-foreground">Legal entity</dt>
        <dd className="font-medium">{entityLabel(office)}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">State</dt>
        <dd>{office.region ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">EIN</dt>
        <dd>{office.ein ?? "—"}</dd>
      </div>
      {/*
       * Phone and email used to be printed by the "Billing office" card on
       * every open invoice and estimate, from each document's own snapshot of
       * them. That card went — it repeated the Bills-as line above — so the
       * details land here instead, read off the live office row rather than
       * off whatever was copied onto the document the day it was created.
       */}
      <div>
        <dt className="text-xs text-muted-foreground">Office phone</dt>
        <dd>{office.office_phone ?? "—"}</dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">Office email</dt>
        <dd className="truncate" title={office.office_email ?? undefined}>
          {office.office_email ?? "—"}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-xs text-muted-foreground">Payment link</dt>
        <dd className="truncate">
          {office.card_payment_url ? (
            <a
              className="text-primary underline underline-offset-2"
              href={office.card_payment_url}
              target="_blank"
              rel="noreferrer"
            >
              {office.card_payment_url}
            </a>
          ) : (
            "—"
          )}
        </dd>
      </div>
      <div className="col-span-2">
        <dt className="text-xs text-muted-foreground">Zelle / QuickPay</dt>
        <dd>{office.zelle_email ?? "—"}</dd>
      </div>
    </dl>
  );
}
