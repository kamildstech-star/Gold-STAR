import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  BriefcaseBusiness,
  Calculator,
  FileDown,
  Plus,
  Save,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { useAppContext } from "@/components/app-context";
import { CustomerPicker, emptyCustomer, type PickedCustomer } from "@/components/customer-picker";
import {
  LocationPicker,
  useJobCreatableLocations,
  useWritableLocations,
} from "@/components/location-picker";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  EQUIPMENT_DEFINITIONS,
  JOB_CALCULATOR_TYPES,
  JOB_CALCULATOR_TYPE_LABEL,
  calculateCustomerPricing,
  calculateInternalFigures,
  emptyJobCalculationInput,
  defaultCalculatorRates,
  toCustomerCalculation,
  emptyCustomLine,
  type EquipmentKey,
  type CustomLine,
  type JobCalculationInput,
} from "@/lib/job-calculator";
import { buildJobCalculatorPdf } from "@/lib/job-calculator-pdf";
import {
  RATE_SOURCE_LABEL,
  fetchCalculatorRates,
  type ResolvedCalculatorRates,
} from "@/lib/job-calculator-pricing";
import { today, type PriceContext } from "@/lib/price-lists";
import { normalizeStateCode } from "@/lib/us-states";
import {
  attachJobCalculation,
  listJobsForCalculation,
  loadJobCalculation,
  saveJobCalculation,
} from "@/lib/job-calculations";
import { useCan } from "@/lib/permissions";
import { useOwnLocationId } from "@/lib/use-own-location";
import {
  DEFAULT_QUICK_ESTIMATE_STATEMENTS,
  loadQuickEstimateStatements,
} from "@/lib/quick-estimate-statements";
import { FitText } from "@/components/ui/fit-text";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

/** An emptied box is 0 to the calculation; nothing here goes negative. */
function numberValue(value: number | null) {
  return value == null ? 0 : Math.max(0, value);
}

/**
 * Which prices this quote was worked out on, said plainly.
 *
 * Names the winning list when there is one, because "Customer price list" on
 * its own invites the next question. The counts are not shown: on a phone,
 * under the number, the useful fact is which agreement is in force, not that
 * it covered nineteen of twenty rates.
 */
function PriceSourceLine({
  resolved,
  loading,
}: {
  resolved: ResolvedCalculatorRates | null;
  loading: boolean;
}) {
  if (loading && !resolved) {
    return <span className="text-[11px] text-muted-foreground">Checking price lists…</span>;
  }
  const source = resolved?.sources.effective ?? "builtin";
  const name = resolved?.sources.listName;
  return (
    <span className="text-[11px] text-muted-foreground" data-testid="calculator-price-source">
      {RATE_SOURCE_LABEL[source]}
      {name ? ` · ${name}` : ""}
    </span>
  );
}

/**
 * One box for every figure on the calculator. Mark: "add commas for thousands
 * millions hundred thousands, etc" — the fees here are the ones that reach
 * four and five digits, and the counts share the box so the whole form
 * behaves the same way. `decimals` replaces the old `step`: 0 for a count,
 * 2 for hours in quarter-hours and for dollars.
 */
function NumberField({
  label,
  value,
  onChange,
  decimals = 0,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  decimals?: number;
  suffix?: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <Label>{label}</Label>
      <div className="relative">
        <NumberInput
          decimals={decimals}
          value={value}
          onValueChange={(n) => onChange(numberValue(n))}
          className={suffix ? "pr-14" : undefined}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Where the calculator opened from decides two things: what is already typed
 * and what happens after Save.
 *
 * Opened from a job it pops up in a dialog with the job's address, customer
 * and office already in, saves straight onto that job and closes. Opened from
 * the Estimates page it is a full page that starts blank and, once saved, can
 * be attached to a job or carried into intake. Nothing about the arithmetic
 * differs.
 */
export type JobCalculatorEditorProps = {
  calculationId?: string;
  /** Values typed before the user gets there — the job's address and so on. */
  prefill?: Partial<JobCalculationInput> & { locationId?: string };
  /** Attach every save to this job. Set when the calculator opened from one. */
  jobId?: string;
  /** In a dialog: no page chrome, and the action bar scrolls with the form. */
  embedded?: boolean;
  onSaved?: (calculationId: string) => void;
};

export function JobCalculatorEditor({
  calculationId,
  prefill,
  jobId,
  embedded = false,
  onSaved,
}: JobCalculatorEditorProps) {
  const app = useAppContext();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const writableLocations = useWritableLocations();
  // No job-creating role: no "Convert to job" button.
  const canCreateJob = useJobCreatableLocations().length > 0;
  const canSeeCosts = useCan("job.view_costs");
  const canSeeMargin = useCan("job.view_margin");
  const [locationId, setLocationId] = useState(prefill?.locationId ?? app.currentLocationId ?? "");
  const [input, setInput] = useState<JobCalculationInput>(() => {
    const { locationId: _omit, ...values } = prefill ?? {};
    return { ...emptyJobCalculationInput(), ...values };
  });
  const [preview, setPreview] = useState<{
    bytes: Uint8Array;
    filename: string;
    title: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [jobSearch, setJobSearch] = useState("");
  /**
   * The CRM record behind the typed customer name, while this editor is open.
   * `job_calculations` has columns for the name, the number and the email but
   * none for a contact or an account, so nothing here is saved — it keeps the
   * type-ahead showing "linked" after a pick instead of re-searching the name
   * the pick just filled in. Converting to a job resolves the link again from
   * the saved name, so a reload loses nothing that matters.
   */
  const [customerLink, setCustomerLink] = useState<PickedCustomer | null>(null);
  // Typing over a linked name unlinks it; so does loading a saved estimate.
  const pickedCustomer =
    customerLink && customerLink.name === input.customerName
      ? customerLink
      : emptyCustomer("person", input.customerName);

  const calculationQuery = useQuery({
    queryKey: ["job-calculation", calculationId],
    enabled: Boolean(calculationId),
    queryFn: () => loadJobCalculation(calculationId!),
  });

  const jobsQuery = useQuery({
    queryKey: ["job-calculation-attach-jobs", locationId],
    enabled: attachOpen && Boolean(locationId),
    queryFn: () => listJobsForCalculation(locationId),
  });

  const attachableJobs = useMemo(() => {
    const needle = jobSearch.trim().toLowerCase();
    if (!needle) return jobsQuery.data ?? [];
    return (jobsQuery.data ?? []).filter((job) =>
      [job.job_number, job.customer_name, job.address, job.locality]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }, [jobSearch, jobsQuery.data]);

  /*
   * Which office a new sheet is filed under.
   *
   * It used to fall to `writableLocations[0]` — whichever office happened to
   * sort first, which nobody chose and which the lists then filter on. A sheet
   * priced with the sidebar on "All my locations" landed in a stranger's office
   * and was gone from the list the moment the context resolved to a real one,
   * which is what "it disappears when I come back" looked like. The viewer's
   * own office is at least an answer they can predict, and the picker below
   * still overrides it.
   */
  /*
   * Read once and shown, never edited here. A failed read falls back to the
   * built-in wording rather than leaving the card blank, because an estimate
   * must price whether or not Settings could be reached.
   */
  const statementsQuery = useQuery({
    queryKey: ["quick-estimate-statements"],
    queryFn: loadQuickEstimateStatements,
  });
  const statements = statementsQuery.data ?? DEFAULT_QUICK_ESTIMATE_STATEMENTS;

  const ownLocationId = useOwnLocationId();
  useEffect(() => {
    if (locationId) return;
    const mine = ownLocationId && writableLocations.some((l) => l.id === ownLocationId);
    setLocationId(mine ? ownLocationId : (writableLocations[0]?.id ?? ""));
  }, [locationId, ownLocationId, writableLocations]);

  const addCustomLine = () =>
    setInput((prev) => ({ ...prev, customLines: [...prev.customLines, emptyCustomLine()] }));

  const updateCustomLine = (index: number, patch: Partial<CustomLine>) =>
    setInput((prev) => ({
      ...prev,
      customLines: prev.customLines.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    }));

  const removeCustomLine = (index: number) =>
    setInput((prev) => ({
      ...prev,
      customLines: prev.customLines.filter((_, i) => i !== index),
    }));

  useEffect(() => {
    if (!calculationQuery.data) return;
    const saved = calculationQuery.data;
    setLocationId(saved.locationId);
    setInput({
      jobDate: saved.jobDate,
      jobType: saved.jobType,
      customerName: saved.customerName,
      contactNumber: saved.contactNumber,
      email: saved.email,
      address: saved.address,
      addressLine2: saved.addressLine2,
      locality: saved.locality,
      region: saved.region,
      postalCode: saved.postalCode,
      days: saved.days,
      workers: saved.workers,
      regularHours: saved.regularHours,
      afterHours: saved.afterHours,
      emergency: saved.emergency,
      garbageFee: saved.garbageFee,
      miscellaneousFee: saved.miscellaneousFee,
      equipment: saved.equipment,
      note: saved.note ?? "",
      customLines: saved.customLines ?? [],
    });
  }, [calculationQuery.data]);

  /*
   * WHICH PRICES THIS QUOTE IS ON.
   *
   * The state is the one the WORK is in, not the office that sold it, so it
   * comes off the property address typed on this form. A calculator estimate
   * usually has no job yet, so there is no `jobs.region` to read; when the
   * address has not been filled in, the picked customer's account address is
   * the fallback, and failing both the state layer is simply skipped.
   */
  const typedState = normalizeStateCode(input.region);
  const accountStateQuery = useQuery({
    queryKey: ["calculator-account-state", pickedCustomer.accountId],
    enabled: Boolean(pickedCustomer.accountId) && !typedState,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("state")
        .eq("id", pickedCustomer.accountId!)
        .maybeSingle();
      if (error) throw error;
      return data?.state ?? null;
    },
  });

  const priceContext = useMemo<PriceContext>(
    () => ({
      accountId: pickedCustomer.accountId,
      locationId: locationId || null,
      stateCode: typedState ?? normalizeStateCode(accountStateQuery.data),
      onDate: input.jobDate || today(),
    }),
    [pickedCustomer.accountId, locationId, typedState, accountStateQuery.data, input.jobDate],
  );

  /*
   * Never blocks and never fails the screen: `fetchCalculatorRates` answers
   * with the workbook constants when the catalog, the price-list tables or the
   * connection are not there, so the calculator prices the same as it always
   * did while the query is in flight or after it fails.
   */
  const ratesQuery = useQuery({
    queryKey: [
      "calculator-rates",
      priceContext.accountId,
      priceContext.locationId,
      priceContext.stateCode,
      priceContext.onDate,
    ],
    staleTime: 5 * 60_000,
    queryFn: () => fetchCalculatorRates(priceContext),
  });

  const resolvedRates: ResolvedCalculatorRates | null = ratesQuery.data ?? null;
  // Memoised so the pricing memo below is not invalidated on every render by
  // a fresh constants object.
  const fallbackRates = useMemo(() => defaultCalculatorRates(), []);
  const rates = resolvedRates?.rates ?? fallbackRates;

  const pricing = useMemo(() => calculateCustomerPricing(input, rates), [input, rates]);
  // The internal figures exist only for a holder of job.view_costs. For
  // anyone else the arithmetic is not run: the numbers are in no memo, no
  // state and no DOM node — not hidden, absent. Under View As `canSeeCosts`
  // is the previewed role's answer (useMyPermissions), so an admin previewing
  // Sales Person gets exactly what the rep gets.
  const internal = useMemo(
    () => (canSeeCosts ? calculateInternalFigures(input, pricing) : null),
    [canSeeCosts, input, pricing],
  );
  const update = <K extends keyof JobCalculationInput>(key: K, value: JobCalculationInput[K]) =>
    setInput((current) => ({ ...current, [key]: value }));
  const updateEquipment = (key: EquipmentKey, value: number) =>
    setInput((current) => ({
      ...current,
      equipment: { ...current.equipment, [key]: value },
    }));

  const save = useMutation({
    mutationFn: () => {
      if (!app.userId) throw new Error("You must be signed in.");
      if (!locationId) throw new Error("Choose a GSR location before saving.");
      if (!input.jobDate) throw new Error("Choose a job date before saving.");
      return saveJobCalculation({
        id: calculationId,
        locationId,
        createdBy: app.userId,
        input,
        // The rates on screen — the customer's price list when they have one.
        rates,
      });
    },
    onSuccess: async (saved) => {
      // Opened from a job, the calculation belongs to it — nobody should have
      // to find it in the list afterwards and attach it by hand.
      if (jobId && saved.jobId !== jobId) {
        try {
          await attachJobCalculation(saved.id, jobId);
        } catch (error) {
          toast.error(
            `Saved, but could not attach it to this job: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      toast.success("Estimate saved");
      await queryClient.invalidateQueries({ queryKey: ["job-calculations"] });
      await queryClient.invalidateQueries({ queryKey: ["job-calculation", saved.id] });
      /*
       * THE HAND-OFF. David, 17 Sep: "the job calculator, it's still not
       * talking to the estimates over here."
       *
       * Billing → Estimates reads both sources under the key
       * ["billing-estimates", locationId]. The merge that was built on 16 Sep
       * is correct; nothing ever told that list a calculation had been saved.
       * So a Billing page already in the cache went on showing the list from
       * before the save, and the estimate he had just priced was not in it.
       */
      await queryClient.invalidateQueries({ queryKey: ["billing-estimates"] });
      if (jobId) {
        await queryClient.invalidateQueries({ queryKey: ["job-calculations-for-job", jobId] });
      }
      onSaved?.(saved.id);
      if (!calculationId && !embedded) {
        void navigate({ to: "/estimates/$id", params: { id: saved.id } });
      }
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const attach = useMutation({
    mutationFn: async (jobId: string) => {
      if (!calculationId) throw new Error("Save this estimate before attaching it.");
      await attachJobCalculation(calculationId, jobId);
    },
    onSuccess: async () => {
      setAttachOpen(false);
      setJobSearch("");
      toast.success("Estimate attached to job");
      await queryClient.invalidateQueries({ queryKey: ["job-calculation", calculationId] });
      await queryClient.invalidateQueries({ queryKey: ["job-calculations"] });
      // A deleted calculation has to leave the Billing list too.
      await queryClient.invalidateQueries({ queryKey: ["billing-estimates"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  /** Attach and Continue only mean anything for a saved, unattached estimate. */
  const showSecondaryActions = Boolean(calculationId && !embedded && !calculationQuery.data?.jobId);

  async function showCustomerPdf() {
    setPreviewing(true);
    try {
      const built = await buildJobCalculatorPdf(toCustomerCalculation(input, pricing));
      setPreview(built);
      setPreviewOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not build the customer PDF");
    } finally {
      setPreviewing(false);
    }
  }

  if (calculationId && calculationQuery.isLoading) {
    return <div className="p-4 text-sm text-muted-foreground">Loading estimate…</div>;
  }

  if (calculationId && calculationQuery.error) {
    return (
      <div className="p-4 text-sm text-destructive">
        Could not load this estimate: {String(calculationQuery.error)}
      </div>
    );
  }

  return (
    // No pb-28 reserving room for the action bar: the bar is in flow now, so
    // it takes its own space however many rows it wraps onto.
    <div className={embedded ? "space-y-4" : "mx-auto max-w-6xl space-y-4 px-3 py-4 sm:px-4"}>
      {!embedded && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button asChild size="icon" variant="ghost">
              <BackLink fallbackTo="/estimates" label="saved estimates">
                <ArrowLeft className="size-4" />
              </BackLink>
            </Button>
            <div className="min-w-0">
              {/* The screen names itself exactly as the nav item does. The
                  new/saved distinction moves to the subtitle so the title is
                  the one stable label users navigated to. */}
              <h1 className="display-heavy truncate text-[22px] leading-tight">Job Calculator</h1>
              {/* Not "Step 1 of job intake": this is a pricing tool people
                  open on its own, and calling it step one is what sent anyone
                  after a new job into the calculator. Converting is an action
                  on a saved estimate, not the next page of a wizard. */}
              <p className="text-sm text-muted-foreground">
                {calculationId ? "Saved estimate" : "New estimate"} · Pricing tool
              </p>
            </div>
          </div>
          {calculationQuery.data?.jobId ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/jobs/$id" params={{ id: calculationQuery.data.jobId }}>
                <BriefcaseBusiness className="mr-1.5 size-4" /> Open job
              </Link>
            </Button>
          ) : null}
        </div>
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_19rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Job and customer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {/*
               * The address first, and optional. Nothing in the arithmetic
               * needs it — it is what the customer PDF prints and what a
               * later attach matches on — so the calculator opens straight
               * away and the address is typed here, or is already here when
               * it opened from a job. Google Places fills city, state and ZIP
               * from one pick.
               */}
              <AddressAutocomplete
                id="calculator-address"
                label="Property address (optional)"
                value={input.address}
                onValueChange={(value) => update("address", value)}
                onSelect={(suggestion) => {
                  update("address", suggestion.address || suggestion.label);
                  update("locality", suggestion.locality ?? "");
                  update("region", suggestion.region ?? "");
                  update("postalCode", suggestion.postal_code ?? "");
                }}
                disabled={app.writesDisabled}
              />
              <div className="grid gap-2 sm:grid-cols-4">
                <Input
                  value={input.addressLine2}
                  onChange={(event) => update("addressLine2", event.target.value)}
                  placeholder="Unit / floor"
                  aria-label="Unit or floor"
                />
                <Input
                  value={input.locality}
                  onChange={(event) => update("locality", event.target.value)}
                  placeholder="City"
                  aria-label="City"
                />
                <Input
                  value={input.region}
                  onChange={(event) => update("region", event.target.value)}
                  placeholder="State"
                  aria-label="State"
                />
                <Input
                  value={input.postalCode}
                  onChange={(event) => update("postalCode", event.target.value)}
                  placeholder="ZIP"
                  aria-label="ZIP"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <LocationPicker
                  value={locationId}
                  onChange={setLocationId}
                  disabled={Boolean(calculationId) || app.writesDisabled}
                  noPrefill={Boolean(calculationId) || Boolean(prefill?.locationId)}
                />
                <div className="grid gap-1.5">
                  <Label>Job date</Label>
                  <Input
                    type="date"
                    required
                    value={input.jobDate}
                    onChange={(event) => update("jobDate", event.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {/*
                 * David: "The calculator should technically really be tied
                 * into the CRM ... if there's a customer name, it should pull
                 * into here when we start typing it, or if not, then it's just
                 * customer name."
                 *
                 * So: the same type-ahead every other intake form uses, not a
                 * second one. Picking a record fills the number and the inbox
                 * from the CRM; typing a name nobody has heard of still saves,
                 * and converting to a job is what puts that person into the
                 * CRM. `job_calculations` stores the name, not the link, so
                 * the link is a convenience for this session — the job form
                 * resolves it again on convert, from what was saved.
                 */}
                <CustomerPicker
                  kind="person"
                  value={pickedCustomer}
                  onChange={(picked) => {
                    setCustomerLink(picked.contactId || picked.accountId ? picked : null);
                    setInput((current) => ({
                      ...current,
                      customerName: picked.name,
                      // A record with no number on file must not wipe the one
                      // the rep just took down over the phone.
                      contactNumber: picked.phone ?? current.contactNumber,
                      email: picked.email ?? current.email,
                    }));
                  }}
                  disabled={app.writesDisabled}
                  defaultLocationId={locationId || null}
                />
                <div className="grid gap-1.5">
                  <Label>Phone</Label>
                  <Input
                    type="tel"
                    value={input.contactNumber}
                    onChange={(event) => update("contactNumber", event.target.value)}
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Email</Label>
                <Input
                  type="email"
                  value={input.email}
                  onChange={(event) => update("email", event.target.value)}
                />
              </div>
            </CardContent>
          </Card>

          {/*
            Job type sits at the head of the priced list rather than up in the
            job's address block. David, 16 Sep, found it "awkward" separated at
            the top — and it belongs here: it is what sets the supply rate per
            day that the lines below are costed against, so it reads as the
            first choice of the estimate rather than a detail of the customer.
          */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Job type</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-[minmax(0,1fr)_12rem] items-center gap-3 py-1">
                <p className="text-sm text-muted-foreground">
                  Sets the supplies rate charged for each day on this job.
                </p>
                <Select
                  value={input.jobType}
                  onValueChange={(value) =>
                    update("jobType", value as JobCalculationInput["jobType"])
                  }
                >
                  <SelectTrigger aria-label="Job type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {JOB_CALCULATOR_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {JOB_CALCULATOR_TYPE_LABEL[type]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Crew and labor</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <NumberField
                  label="Days"
                  value={input.days}
                  onChange={(value) => update("days", value)}
                />
                <NumberField
                  label="Workers"
                  value={input.workers}
                  onChange={(value) => update("workers", value)}
                />
                <NumberField
                  label="Regular hours"
                  value={input.regularHours}
                  onChange={(value) => update("regularHours", value)}
                  decimals={2}
                  suffix="/ day"
                />
                <NumberField
                  label="After-hours"
                  value={input.afterHours}
                  onChange={(value) => update("afterHours", value)}
                  decimals={2}
                  suffix="/ day"
                />
              </div>
              <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-2.5">
                <div>
                  <Label htmlFor="job-calculator-emergency">Emergency response</Label>
                  <p className="text-xs text-muted-foreground">Adds David's worker bonus.</p>
                </div>
                <Switch
                  id="job-calculator-emergency"
                  checked={input.emergency}
                  onCheckedChange={(checked) => update("emergency", checked)}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Equipment</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {EQUIPMENT_DEFINITIONS.map((item) => (
                <div
                  key={item.key}
                  className="grid grid-cols-[minmax(0,1fr)_6.5rem] items-center gap-3 border-b py-2 last:border-0"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{item.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.customerRate > 0
                        ? `${money(item.customerRate)} / ${item.unit}`
                        : "Price pending"}
                    </p>
                  </div>
                  <NumberInput
                    aria-label={`${item.label} quantity`}
                    decimals={2}
                    value={input.equipment[item.key] ?? 0}
                    onValueChange={(n) => updateEquipment(item.key, numberValue(n))}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Other fees</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  label="Garbage"
                  value={input.garbageFee}
                  onChange={(value) => update("garbageFee", value)}
                  decimals={2}
                />
                <NumberField
                  label="Miscellaneous"
                  value={input.miscellaneousFee}
                  onChange={(value) => update("miscellaneousFee", value)}
                  decimals={2}
                />
              </div>

              {/*
                Blank lines, added at the bottom and typed into — David, 16 Sep.
                The catalogue above is fixed on purpose, so this is where a job
                that needs a permit, a specialist sub or a one-off charge gets
                said in words instead of being folded into "Miscellaneous".
                A row left completely empty is dropped on save, so adding three
                and using one costs nothing.
              */}
              {input.customLines.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  {input.customLines.map((line, index) => (
                    <div
                      key={index}
                      className="grid grid-cols-[minmax(0,1fr)_7rem_2.5rem] items-center gap-2"
                    >
                      <Input
                        value={line.label}
                        placeholder="What is it?"
                        aria-label={`Line ${index + 1} description`}
                        onChange={(event) => updateCustomLine(index, { label: event.target.value })}
                      />
                      <NumberInput
                        aria-label={`Line ${index + 1} amount`}
                        decimals={2}
                        value={line.amount}
                        onValueChange={(n) => updateCustomLine(index, { amount: numberValue(n) })}
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        aria-label={`Remove line ${index + 1}`}
                        onClick={() => removeCustomLine(index)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <Button
                type="button"
                size="sm"
                variant="outline"
                className="w-full sm:w-auto"
                onClick={addCustomLine}
              >
                <Plus className="mr-1.5 size-4" />
                Add item
              </Button>
            </CardContent>
          </Card>

          {/*
            The statements and the one note. David, 17 Sep: the quick estimate
            has no opening or closing statement, and "I'm thinking if we should
            just have presets... and maybe a small little section if we want to
            put in a note."

            The presets are shown read-only on purpose. He priced this screen
            for a driveway — "open it up quickly... tap, tap, tap, and you have
            your estimate" — so the statements are never something to type or
            approve here; they are set once in Admin and then simply print. The
            note is the one box, and skipping it is the normal case.
          */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Statements &amp; note</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="mb-1 font-medium text-foreground">Opening</p>
                <p>{statements.opening}</p>
                <p className="mb-1 mt-3 font-medium text-foreground">Closing</p>
                <p>{statements.closing}</p>
                <p className="mt-3 text-[11px]">
                  Both print on every quick estimate. An admin edits them under Settings.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="calc-note" className="text-xs">
                  Note (optional)
                </Label>
                <Textarea
                  id="calc-note"
                  rows={3}
                  value={input.note}
                  placeholder="Anything specific to this job. Leave it empty and nothing prints."
                  onChange={(e) => setInput((prev) => ({ ...prev, note: e.target.value }))}
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <aside className={embedded ? "min-w-0 space-y-3" : "min-w-0 space-y-3 lg:sticky lg:top-4"}>
          <Card className="overflow-hidden">
            <CardHeader className="bg-muted/40 pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Calculator className="size-4" /> Estimate
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-4">
              <div className="space-y-2 text-sm">
                <SummaryRow label="Labor" value={pricing.laborCustomerPrice} />
                <SummaryRow label="Equipment" value={pricing.equipmentCustomerPrice} />
                <SummaryRow label="Supplies" value={pricing.supplyCost} />
                <SummaryRow label="Truck" value={pricing.truckCustomerPrice} />
                <SummaryRow label="Garbage" value={input.garbageFee} />
                <SummaryRow label="Miscellaneous" value={input.miscellaneousFee} />
              </div>
              <div className="border-t pt-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Customer price
                </p>
                <FitText
                  className="mt-1 text-2xl font-bold tabular-nums"
                  data-testid="calculator-customer-price"
                >
                  {money(pricing.customerPrice)}
                </FitText>
              </div>
              {/* Internal cost and profit exist only for a viewer who may see
                  them (job.view_costs, job.view_margin). Anyone else gets no
                  box, no "Hidden", no "n/a" — the rows are simply not there. */}
              {internal ? (
                <>
                  <div className="rounded-md bg-muted/50 p-3 text-sm">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Internal cost
                    </p>
                    <div className="mt-1 flex" data-testid="calculator-internal-cost">
                      <span className="font-semibold tabular-nums">
                        {money(internal.internalCost)}
                      </span>
                    </div>
                  </div>
                  {canSeeMargin ? (
                    <div className="grid grid-cols-2 gap-2">
                      <PrivateMetric
                        label="Equipment profit"
                        value={internal.equipmentProfit}
                        testId="calculator-equipment-profit"
                      />
                      <PrivateMetric
                        label="Overall profit"
                        value={internal.overallProfit}
                        testId="calculator-overall-profit"
                      />
                    </div>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    Customer PDFs include the customer price and billable lines only. Internal
                    values are always excluded.
                  </p>
                </>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>

      {/*
       * Sticky, not fixed. Fixed at bottom-0 put the bar underneath the app's mobile
       * bottom nav, which is also fixed at bottom-0, is opaque and sits a
       * layer higher — so below `md` the actions were painted over and
       * untappable, which is what "not showing up on mobile" was.
       *
       * Sticky also means the bar reserves its own height in flow, so it can
       * wrap onto two rows on a narrow screen without the page having to
       * guess a matching bottom padding. <main> is the page's scroll
       * container; inside a dialog the dialog is, and there is no bottom nav
       * to clear.
       *
       * `bottom-0`, NOT `above-mobile-nav`. This bar is sticky inside the app
       * shell's <main>, and <main> already reserves pb-[calc(4rem+env(safe-area-
       * inset-bottom))] below md for the fixed phone nav. A sticky element is held
       * inside its scroll container's padding edge, so bottom-0 already docks it
       * on top of the nav — notched iPhones included, since the padding carries
       * the same inset the nav does. above-mobile-nav (4rem) is for something
       * positioned against the VIEWPORT; here it counted the nav twice and
       * floated the bar 71px clear of it at 375px, rows showing underneath.
       */}
      <div
        className={
          embedded
            ? "sticky bottom-0 z-10 -mx-1 border-t bg-background/95 px-1 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85"
            : "sticky bottom-0 z-30 -mx-3 border-t bg-background/95 px-3 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 sm:-mx-4 sm:px-4"
        }
      >
        <div className="mx-auto flex max-w-6xl flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          {/* The summary rail is a full form's scroll away on a phone, so the
              one number being watched rides along with the buttons — and, with
              price lists in play, WHICH prices it was worked out on. A number
              that silently changed because a customer was picked, with nothing
              on screen saying so, is the failure this line exists to prevent. */}
          <div className="flex flex-col gap-0.5 sm:hidden">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Customer price
              </span>
              <span
                className="text-lg font-bold tabular-nums"
                data-testid="calculator-customer-price-bar"
              >
                {money(pricing.customerPrice)}
              </span>
            </div>
            <PriceSourceLine resolved={resolvedRates} loading={ratesQuery.isLoading} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <Button variant="outline" onClick={showCustomerPdf} disabled={previewing}>
              <FileDown className="mr-1.5 size-4" />
              {previewing ? "Building PDF…" : "Customer PDF"}
            </Button>
            {showSecondaryActions ? (
              <>
                <AttachToJobDialog
                  open={attachOpen}
                  onOpenChange={setAttachOpen}
                  search={jobSearch}
                  onSearchChange={setJobSearch}
                  jobs={attachableJobs}
                  loading={jobsQuery.isLoading}
                  attaching={attach.isPending}
                  onAttach={(jobId) => attach.mutate(jobId)}
                />
                {/* David: "when you click into the estimate, it should have a
                    option there to do it." Named for what it does — the old
                    "Continue to job intake" read like a wizard step nobody had
                    asked to start. It opens the new job form with this
                    estimate's property, customer and price already in it; the
                    job is created there, by the one form that creates jobs.
                    Too wide to share a row with anything at 375px. */}
                {canCreateJob && (
                  <Button asChild variant="outline" className="col-span-2 sm:col-auto">
                    <Link to="/jobs/new" search={{ calculatorId: calculationId }}>
                      <BriefcaseBusiness className="mr-1.5 size-4" /> Convert to job
                    </Link>
                  </Button>
                )}
              </>
            ) : null}
            {/* With the secondary actions present the two-column phone grid
                would leave Save half-width in the bottom-left corner. The
                primary action takes the whole row instead. */}
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending || app.writesDisabled}
              className={showSecondaryActions ? "col-span-2 sm:col-auto" : undefined}
            >
              <Save className="mr-1.5 size-4" /> {save.isPending ? "Saving…" : "Save estimate"}
            </Button>
          </div>
        </div>
      </div>

      <PdfPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        title={preview?.title ?? "Customer estimate"}
        bytes={preview?.bytes ?? null}
        filename={preview?.filename ?? "estimate.pdf"}
      />
    </div>
  );
}

function AttachToJobDialog({
  open,
  onOpenChange,
  search,
  onSearchChange,
  jobs,
  loading,
  attaching,
  onAttach,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  search: string;
  onSearchChange: (value: string) => void;
  jobs: Array<{
    id: string;
    job_number: string;
    customer_name: string | null;
    address: string | null;
    locality: string | null;
  }>;
  loading: boolean;
  attaching: boolean;
  onAttach: (jobId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline">Attach to existing job</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85svh] w-[min(40rem,calc(100vw-1.5rem))] overflow-hidden">
        <DialogHeader>
          <DialogTitle>Attach estimate to a job</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Job number, customer or address"
            className="pl-9"
          />
        </div>
        <div className="max-h-[55svh] overflow-y-auto rounded-md border">
          {jobs.map((job) => (
            <button
              key={job.id}
              type="button"
              disabled={attaching}
              onClick={() => onAttach(job.id)}
              className="flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left last:border-0 hover:bg-muted/50 disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {job.customer_name || job.address || "Unnamed job"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[job.address, job.locality].filter(Boolean).join(", ") || "No address"}
                </span>
              </span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {job.job_number}
              </span>
            </button>
          ))}
          {!loading && jobs.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">No matching jobs.</p>
          ) : null}
          {loading ? (
            <p className="p-6 text-center text-sm text-muted-foreground">Loading jobs…</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{money(value)}</span>
    </div>
  );
}

/** A margin figure — only ever drawn for a viewer allowed to see it. */
function PrivateMetric({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border p-2.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <FitText className="mt-1 font-semibold tabular-nums" data-testid={testId}>
        {money(value)}
      </FitText>
    </div>
  );
}
