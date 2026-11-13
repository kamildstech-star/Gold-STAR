import { saveJobSiteNames } from "@/lib/job-site-names";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DetailSelect } from "@/components/detail-select";
import { toast } from "sonner";
import { isAccessError, toastDbError } from "@/lib/db-errors";
import { isMissingSchema } from "@/lib/schema-fallback";
import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { CompanyContactPicker, type PickedContact } from "@/components/company-contact-picker";
import { AccountContactPicker, type PickedPerson } from "@/components/account-contact-picker";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { DEFAULT_REPORTED_TIME, resolveJobName } from "@/lib/job-new-defaults";
import {
  CustomerPicker,
  PriorJobsBanner,
  customerFromPriorJob,
  emptyCustomer,
  type PickedCustomer,
} from "@/components/customer-picker";
import { useJobStages } from "@/lib/job-stages";
import { useOptionList, toDetailOptions } from "@/lib/option-lists";
import {
  useLossTypes,
  usePaymentTypes,
  useInsuranceKinds,
  isInsuranceJob,
} from "@/lib/loss-categories";
import { ContactMethodEditor, type DraftMethod } from "@/components/job-contact-methods";
import { contactMethodsError } from "@/lib/job-contact-methods";
import { LocationPicker, useJobCreatableLocations } from "@/components/location-picker";
import { billingMismatch, loadBillingOffices, type BillingOffice } from "@/lib/billing-entity";
import { useAccountInference, useAutoLinkedAccount } from "@/lib/account-inference";
import { IntakeQuestionnaire } from "@/components/intake-questionnaire";
import {
  linkIntakeToCreatedJob,
  loadIntakeSubmission,
  type IntakeInboxRow,
} from "@/lib/intake-inbox";
import { LoadError } from "@/components/ui-density";
import { CarrierConfirm } from "@/components/carrier-confirm";
import {
  saveJobIntakeAnswers,
  useIntakeQuestions,
  type IntakeAnswerDraft,
} from "@/lib/intake-questions";
import {
  attachJobCalculation,
  findCalculationCustomerInCrm,
  loadJobCalculation,
} from "@/lib/job-calculations";
import { jobPrefillFromCalculation, matchLossTypeId, needsCrmContact } from "@/lib/estimate-to-job";
import { createCustomerContact, loadContactMethods } from "@/lib/contacts";
import { derivedJobContacts } from "@/lib/job-relationships";
import type { SavedJobCalculation } from "@/lib/job-calculator";
import { automaticScopeTypeFor, syncAutomaticJobTasksForJob } from "@/lib/automatic-job-tasks";
import {
  clearFormDraft,
  draftAge,
  draftHasContent,
  loadFormDraft,
  makeDraftSaver,
  saveFormDraft,
} from "@/lib/form-draft";
import { RotateCcw } from "lucide-react";

type Search = { fromLead?: string; fromIntake?: string; calculatorId?: string };

export const Route = createFileRoute("/_authenticated/jobs/new")({
  head: () => ({
    meta: [{ title: "New job · Recovery Hub" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    fromLead: typeof raw.fromLead === "string" ? raw.fromLead : undefined,
    fromIntake: typeof raw.fromIntake === "string" ? raw.fromIntake : undefined,
    calculatorId: typeof raw.calculatorId === "string" ? raw.calculatorId : undefined,
  }),
  component: NewJob,
});

function NewJob() {
  const app = useAppContext();
  const { fromLead, fromIntake, calculatorId } = Route.useSearch();
  const navigate = useNavigate();

  const [locationId, setLocationId] = useState<string>("");

  // Top of form — the order the office works in
  const [address, setAddress] = useState("");
  const [address2, setAddress2] = useState("");
  const [locality, setLocality] = useState("");
  const [region, setRegion] = useState("");
  const [postal, setPostal] = useState("");
  const [county, setCounty] = useState("");
  const [lat, setLat] = useState<string>("");
  const [lon, setLon] = useState<string>("");
  /* `null` until the name box is touched; until then the name is the address.
     See resolveJobName for David's words and the rule. */
  const [typedJobName, setTypedJobName] = useState<string | null>(null);
  const jobName = resolveJobName(typedJobName, address);
  const [community, setCommunity] = useState("");
  /* Building and facility names, beside the community (David, 21 Oct). */
  const [buildingName, setBuildingName] = useState("");
  const [facilityName, setFacilityName] = useState("");
  const [stageId, setStageId] = useState<string>("");

  // Customer
  const [customerKind, setCustomerKind] = useState<"person" | "company">("person");
  const [customer, setCustomer] = useState<PickedCustomer>(() => emptyCustomer("person"));
  const customerName = customer.name;
  const setCustomerName = (n: string) =>
    setCustomer((c) => ({ ...emptyCustomer(c.kind, n), methods: c.methods }));
  const [account, setAccount] = useState<PickedAccount | null>(null);
  const [carriedAccountId, setCarriedAccountId] = useState<string | null>(null);
  const [primaryContact, setPrimaryContact] = useState<PickedContact | null>(null);
  const [methods, setMethods] = useState<DraftMethod[]>([]);

  // Job type & detail
  // Payment type (cash vs insurance) and service category
  const [jobType, setJobType] = useState<string>("");
  const [jobTypeDetail, setJobTypeDetail] = useState("");
  const [lossTypeId, setLossTypeId] = useState<string>("");
  const [lossTypeDetail, setLossTypeDetail] = useState("");
  const [lossDescription, setLossDescription] = useState("");

  // Cash job — no carrier, no claim, no adjuster
  const [cashPayerName, setCashPayerName] = useState("");
  const [agreedPrice, setAgreedPrice] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");

  // Insurance — every field here is a CRM record, never loose text.
  const [carrierAccount, setCarrierAccount] = useState<PickedAccount | null>(null);
  const [insuranceKind, setInsuranceKind] = useState("");
  const [insuranceKindDetail, setInsuranceKindDetail] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [claim, setClaim] = useState("");
  const [deductible, setDeductible] = useState("");
  // Adjusters are people at the carrier, created inline from the picker.
  const [deskContact, setDeskContact] = useState<PickedPerson | null>(null);
  const [fieldContact, setFieldContact] = useState<PickedPerson | null>(null);
  /*
   * BC-CON-1.1: the carrier adjuster as their own pick. Until now the form
   * copied the desk adjuster into it; that is still the fallback when this is
   * left empty, so nothing a rep used to get for free goes missing.
   */
  const [adjusterContact, setAdjusterContact] = useState<PickedPerson | null>(null);
  // The insured's agency and the agent there — where most agents get typed first.
  const [agencyAccount, setAgencyAccount] = useState<PickedAccount | null>(null);
  const [agentContact, setAgentContact] = useState<PickedPerson | null>(null);
  const [paAccount, setPaAccount] = useState<PickedAccount | null>(null);
  const [paContact, setPaContact] = useState<PickedContact | null>(null);
  const [paPerson, setPaPerson] = useState<PickedPerson | null>(null);
  // Independent / third-party reviewer — a person at a reviewing firm.
  const [reviewerAccount, setReviewerAccount] = useState<PickedAccount | null>(null);
  const [reviewerContact, setReviewerContact] = useState<PickedPerson | null>(null);

  // Referral
  const [referralType, setReferralType] = useState("");
  const [referralTypeDetail, setReferralTypeDetail] = useState("");
  const [referralAccount, setReferralAccount] = useState<PickedAccount | null>(null);
  const [referralContact, setReferralContact] = useState<PickedContact | null>(null);

  // Intake
  const [sourceId, setSourceId] = useState("");
  const [sourceDetail, setSourceDetail] = useState("");
  const [sources, setSources] = useState<{ id: string; label: string }[]>([]);
  const intakeQuestions = useIntakeQuestions();
  const [intakeAnswers, setIntakeAnswers] = useState<IntakeAnswerDraft>({});
  // Reported = when the customer called us (response time is measured from here)
  const [callDate, setCallDate] = useState(new Date().toISOString().slice(0, 10));
  // 12:00 AM by David's call, not the clock at the moment of keying; see DEFAULT_REPORTED_TIME.
  const [callTime, setCallTime] = useState(DEFAULT_REPORTED_TIME);
  // Loss date = when the damage happened (carriers require it)
  const [lossDate, setLossDate] = useState("");

  // Compliance & scope
  const [addlWork, setAddlWork] = useState(false);
  const [rehabbed, setRehabbed] = useState<"unknown" | "yes" | "no">("unknown");
  const [scope, setScope] = useState("");
  const [importantInstructions, setImportantInstructions] = useState("");
  const [saving, setSaving] = useState(false);
  const [sourceCalculation, setSourceCalculation] = useState<SavedJobCalculation | null>(null);
  const loadedCalculationId = useRef<string | null>(null);

  /* ------------------------------------------------------------- the draft */
  /*
   * Mark, 5 Oct, looking at this page next to his other tabs: "when they
   * switch tabs, it doesnt keep things in the fields."
   *
   * The provider was unmounting the whole authenticated outlet on every tab
   * switch and that is fixed in app-context.tsx — but a browser may discard a
   * background tab whenever it wants the memory, and nothing this page does
   * can stop it. Forty-odd fields of intake is not something a rep should
   * ever re-key, so what they have typed is kept on the device. See
   * form-draft.ts for where it is kept, why, and how it is scoped to the
   * person who typed it.
   *
   * The key carries the source, so an estimate being converted and a blank
   * new job are separate drafts and never restore over each other.
   */
  const draftFormId =
    "job-new" +
    (calculatorId ? `:calc:${calculatorId}` : "") +
    (fromIntake ? `:intake:${fromIntake}` : "") +
    (fromLead ? `:lead:${fromLead}` : "");
  const draftOwnerId = app.userId;
  /*
   * Nothing is written and no prefill runs until we know whether there is a
   * draft. Both the restore and the three prefills (estimate, intake form,
   * lead) write the same boxes, and whichever landed last would win — which
   * on a slow connection is a coin toss.
   */
  const [draftPhase, setDraftPhase] = useState<"reading" | "ready">("reading");
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  // A restored draft is the rep's own later edit of whatever the source
  // prefilled, so the source must not write over it a second time.
  const draftRestored = useRef(false);

  const draftValues = {
    locationId,
    address,
    address2,
    locality,
    region,
    postal,
    county,
    lat,
    lon,
    typedJobName,
    community,
    buildingName,
    facilityName,
    stageId,
    customerKind,
    customer,
    account,
    carriedAccountId,
    primaryContact,
    methods,
    jobType,
    jobTypeDetail,
    lossTypeId,
    lossTypeDetail,
    lossDescription,
    cashPayerName,
    agreedPrice,
    depositAmount,
    paymentTerms,
    carrierAccount,
    insuranceKind,
    insuranceKindDetail,
    policyNumber,
    claim,
    deductible,
    deskContact,
    fieldContact,
    adjusterContact,
    agencyAccount,
    agentContact,
    paAccount,
    paContact,
    paPerson,
    reviewerAccount,
    reviewerContact,
    referralType,
    referralTypeDetail,
    referralAccount,
    referralContact,
    sourceId,
    sourceDetail,
    intakeAnswers,
    callDate,
    callTime,
    lossDate,
    addlWork,
    rehabbed,
    scope,
    importantInstructions,
  };

  /*
   * Boxes this page fills in for itself before anybody types: the office (the
   * location picker prefills it and then suggests the nearest branch from the
   * address), the stage, the payment type and the loss type. They are not
   * evidence that anyone did any work, so they do not make a draft.
   */
  const SELF_FILLED = ["locationId", "stageId", "jobType", "lossTypeId"] as const;

  /** The form as it opens, so an untouched page is never saved as a "draft". */
  const blankDraftValues = (): Record<string, unknown> => ({
    ...Object.fromEntries(Object.keys(draftValues).map((k) => [k, ""])),
    typedJobName: null,
    customerKind: "person",
    customer: emptyCustomer("person"),
    account: null,
    carriedAccountId: null,
    primaryContact: null,
    methods: [],
    carrierAccount: null,
    deskContact: null,
    fieldContact: null,
    adjusterContact: null,
    agencyAccount: null,
    agentContact: null,
    paAccount: null,
    paContact: null,
    paPerson: null,
    reviewerAccount: null,
    reviewerContact: null,
    referralAccount: null,
    referralContact: null,
    intakeAnswers: {},
    callDate: new Date().toISOString().slice(0, 10),
    callTime: DEFAULT_REPORTED_TIME,
    addlWork: false,
    rehabbed: "unknown",
  });

  /**
   * A stored draft is data from a previous session, so every field is checked
   * before it is put back. A draft written by a build that held a field
   * differently leaves that one box alone rather than putting an object where
   * the form expects a string.
   */
  const applyDraftValues = (v: Record<string, unknown>) => {
    const str = (k: string, set: (s: string) => void) => {
      if (typeof v[k] === "string") set(v[k] as string);
    };
    const bool = (k: string, set: (b: boolean) => void) => {
      if (typeof v[k] === "boolean") set(v[k] as boolean);
    };
    const nullableStr = (k: string, set: (s: string | null) => void) => {
      if (typeof v[k] === "string" || v[k] === null) set(v[k] as string | null);
    };
    const record = <T,>(k: string, set: (o: T) => void) => {
      const x = v[k];
      if (x === null || (typeof x === "object" && !Array.isArray(x))) set(x as T);
    };
    const list = <T,>(k: string, set: (a: T) => void) => {
      if (Array.isArray(v[k])) set(v[k] as T);
    };

    str("locationId", setLocationId);
    str("address", setAddress);
    str("address2", setAddress2);
    str("locality", setLocality);
    str("region", setRegion);
    str("postal", setPostal);
    str("county", setCounty);
    str("lat", setLat);
    str("lon", setLon);
    nullableStr("typedJobName", setTypedJobName);
    str("community", setCommunity);
    str("buildingName", setBuildingName);
    str("facilityName", setFacilityName);
    str("stageId", setStageId);
    if (v["customerKind"] === "person" || v["customerKind"] === "company")
      setCustomerKind(v["customerKind"]);
    record<PickedCustomer>("customer", (c) => c && setCustomer(c));
    record<PickedAccount | null>("account", setAccount);
    nullableStr("carriedAccountId", setCarriedAccountId);
    record<PickedContact | null>("primaryContact", setPrimaryContact);
    list<DraftMethod[]>("methods", setMethods);
    str("jobType", setJobType);
    str("jobTypeDetail", setJobTypeDetail);
    str("lossTypeId", setLossTypeId);
    str("lossTypeDetail", setLossTypeDetail);
    str("lossDescription", setLossDescription);
    str("cashPayerName", setCashPayerName);
    str("agreedPrice", setAgreedPrice);
    str("depositAmount", setDepositAmount);
    str("paymentTerms", setPaymentTerms);
    record<PickedAccount | null>("carrierAccount", setCarrierAccount);
    str("insuranceKind", setInsuranceKind);
    str("insuranceKindDetail", setInsuranceKindDetail);
    str("policyNumber", setPolicyNumber);
    str("claim", setClaim);
    str("deductible", setDeductible);
    record<PickedPerson | null>("deskContact", setDeskContact);
    record<PickedPerson | null>("fieldContact", setFieldContact);
    record<PickedPerson | null>("adjusterContact", setAdjusterContact);
    record<PickedAccount | null>("agencyAccount", setAgencyAccount);
    record<PickedPerson | null>("agentContact", setAgentContact);
    record<PickedAccount | null>("paAccount", setPaAccount);
    record<PickedContact | null>("paContact", setPaContact);
    record<PickedPerson | null>("paPerson", setPaPerson);
    record<PickedAccount | null>("reviewerAccount", setReviewerAccount);
    record<PickedPerson | null>("reviewerContact", setReviewerContact);
    str("referralType", setReferralType);
    str("referralTypeDetail", setReferralTypeDetail);
    record<PickedAccount | null>("referralAccount", setReferralAccount);
    record<PickedContact | null>("referralContact", setReferralContact);
    str("sourceId", setSourceId);
    str("sourceDetail", setSourceDetail);
    record<IntakeAnswerDraft>("intakeAnswers", (a) => a && setIntakeAnswers(a));
    str("callDate", setCallDate);
    str("callTime", setCallTime);
    str("lossDate", setLossDate);
    bool("addlWork", setAddlWork);
    if (v["rehabbed"] === "unknown" || v["rehabbed"] === "yes" || v["rehabbed"] === "no")
      setRehabbed(v["rehabbed"]);
    str("scope", setScope);
    str("importantInstructions", setImportantInstructions);
  };

  useEffect(() => {
    if (!draftOwnerId) return;
    let cancelled = false;
    void loadFormDraft(draftOwnerId, draftFormId, { now: Date.now() }).then((found) => {
      if (cancelled) return;
      if (found) {
        applyDraftValues(found.values as Record<string, unknown>);
        draftRestored.current = true;
        setRestoredAt(found.savedAt);
      }
      setDraftPhase("ready");
    });
    return () => {
      cancelled = true;
    };
    // Reading the draft is a one-shot per owner and form; applyDraftValues
    // closes over the setters, which are stable.
  }, [draftOwnerId, draftFormId]);

  const writeDraft = useRef<(values: Record<string, unknown>) => void>(() => {});
  writeDraft.current = (values) => {
    if (!draftOwnerId) return;
    void saveFormDraft(draftOwnerId, draftFormId, values, Date.now());
  };
  const [draftSaver] = useState(() =>
    makeDraftSaver<Record<string, unknown>>((v) => writeDraft.current(v)),
  );

  const forgetDraft = () => {
    draftSaver.cancel();
    setRestoredAt(null);
    if (draftOwnerId) void clearFormDraft(draftOwnerId, draftFormId);
  };

  /*
   * One write per pause in typing. The dependency is the serialised form
   * rather than the object, which is a new one on every render and would
   * restart the debounce forever.
   */
  const draftSignature = JSON.stringify(draftValues);
  useEffect(() => {
    if (draftPhase !== "ready" || !draftOwnerId) return;
    if (!draftHasContent(draftValues, blankDraftValues(), { ignore: SELF_FILLED })) return;
    draftSaver.queue(draftValues);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftSignature, draftPhase, draftOwnerId, draftSaver]);

  /*
   * The debounce is what a discarded tab races. Hiding the tab is the last
   * moment we are certainly still running, so whatever is pending goes out
   * then rather than 800ms later, which may never arrive.
   */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") draftSaver.flush();
    };
    const onPageHide = () => draftSaver.flush();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [draftSaver]);

  /**
   * An adjuster found by name carries their carrier with them. Picking one
   * before the insurance company fills the company in rather than making the
   * rep go back and choose what the person already told us.
   */
  const adoptCarrierFrom = (p: PickedPerson | null) => {
    if (!p?.account_id || carrierAccount) return;
    setCarrierAccount({ id: p.account_id, name: p.account_name ?? "" } as PickedAccount);
  };

  const paymentTypes = usePaymentTypes();
  const insuranceKinds = useInsuranceKinds();
  const lossTypes = useLossTypes(locationId || null);
  /*
   * Convert to job. David: "So I want to be able to take this over here and
   * flip it to a job."
   *
   * Flipping does not create anything — it opens this form with what the
   * estimate already knew, and every field stays editable. The mapping itself
   * is `jobPrefillFromCalculation`, pure and unit-tested, so what lands in
   * which box is decided in one place rather than in an effect nobody can run
   * outside a browser.
   *
   * Then the customer is resolved against the CRM: "The calculator should
   * technically really be tied into the CRM." A confident match arrives as a
   * linked contact with its account and its phones and emails; anything less
   * confident stays exactly as typed, and submitting is what puts that person
   * into the CRM.
   */
  useEffect(() => {
    if (!calculatorId || loadedCalculationId.current === calculatorId) return;
    // Wait for the draft answer: the estimate must not write over the edits
    // the rep already made to what it prefilled last time.
    if (draftPhase !== "ready") return;
    let cancelled = false;
    void loadJobCalculation(calculatorId)
      .then(async (calculation) => {
        if (cancelled) return;
        loadedCalculationId.current = calculatorId;
        // The calculation itself is still needed — submit() attaches it to
        // the job it creates — only the field prefill is skipped.
        setSourceCalculation(calculation);
        if (draftRestored.current) return;
        const prefill = jobPrefillFromCalculation(calculation);
        setLocationId(prefill.locationId);
        setAddress(prefill.address);
        setAddress2(prefill.addressLine2);
        setLocality(prefill.locality);
        setRegion(prefill.region);
        setPostal(prefill.postalCode);
        setAgreedPrice(prefill.agreedPrice);
        setCustomer((current) => ({
          ...current,
          name: prefill.customerName,
          phone: prefill.phone || null,
          email: prefill.email || null,
        }));
        if (prefill.methods.length) setMethods(prefill.methods);

        const match = await findCalculationCustomerInCrm(prefill);
        if (cancelled || !match) return;
        const crmMethods = await loadContactMethods(match.contact_id);
        if (cancelled) return;
        setCustomer((current) => ({
          ...current,
          contactId: match.contact_id,
          name: match.full_name,
          title: match.title,
          accountId: match.account_id,
          accountName: match.account_name,
          phone: match.phone ?? current.phone,
          email: match.email ?? current.email,
          methods: crmMethods,
        }));
        if (crmMethods.length) setMethods(crmMethods);
        if (match.account_id) {
          setAccount(
            (current) =>
              current ??
              ({ id: match.account_id, name: match.account_name ?? "" } as PickedAccount),
          );
        }
      })
      .catch((error) => toastDbError(error, { action: "Loading job calculation" }));
    return () => {
      cancelled = true;
    };
  }, [calculatorId, draftPhase]);

  useEffect(() => {
    if (!sourceCalculation || lossTypes.options.length === 0) return;
    const match = matchLossTypeId(lossTypes.options, sourceCalculation.jobType);
    if (match) setLossTypeId(match);
  }, [lossTypes.options, sourceCalculation]);

  const automaticScopeType = automaticScopeTypeFor(lossTypes.byId.get(lossTypeId)?.key);
  const insuranceJob = isInsuranceJob(jobType || paymentTypes.defaultKey);
  /* David's asterisk on the five critical insurance details — insurance-info-task.ts. */
  const insuranceRuleOn = (jobType || paymentTypes.defaultKey) === "insurance";
  const star = (label: string) => (insuranceRuleOn ? `${label} *` : label);
  useEffect(() => {
    if (!jobType && paymentTypes.defaultKey) setJobType(paymentTypes.defaultKey);
  }, [jobType, paymentTypes.defaultKey]);
  useEffect(() => {
    if (!lossTypeId && lossTypes.defaultId) setLossTypeId(lossTypes.defaultId);
  }, [lossTypeId, lossTypes.defaultId]);
  const { stages: jobStages, defaultStage } = useJobStages(locationId || null);
  useEffect(() => {
    if (!stageId && defaultStage) setStageId(defaultStage.id);
  }, [defaultStage, stageId]);
  const { options: lossPhrases } = useOptionList("loss_description", { locationId });
  const { options: referralTypes } = useOptionList("referral_source_type");

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("reported_sources")
        .select("id, label")
        .eq("active", true)
        .order("sort_order");
      setSources((data ?? []) as { id: string; label: string }[]);
    })();
  }, []);

  /**
   * A pick from the type-ahead brings its account, its person and its phones
   * and emails with it — the rep types once and everything else is already
   * known. Every field stays editable afterwards.
   */
  const applyCustomer = async (c: PickedCustomer) => {
    setCustomer(c);
    if (c.contactId) {
      setPrimaryContact({
        id: c.contactId,
        full_name: c.name,
        email: c.email,
        phone: c.phone,
      });
    } else if (!c.accountId) {
      setPrimaryContact(null);
    }
    if (c.methods.length) {
      setMethods((prev) => (prev.some((m) => m.value.trim()) ? prev : c.methods));
    }
    if (c.accountId && c.accountId !== account?.id) {
      const { data } = await supabase
        .from("accounts")
        .select("id, name, location_id")
        .eq("id", c.accountId)
        .maybeSingle();
      if (data) {
        setAccount({
          id: data.id,
          name: data.name,
          location_id: data.location_id,
          primary_contact: c.contactId
            ? { full_name: c.name, phone: c.phone, email: c.email }
            : null,
        });
        if (!locationId) setLocationId(data.location_id);
      }
    }
  };

  /*
   * A lead that arrived through the public intake form. Everything the person
   * typed is carried in and everything the form never asked for is left for
   * the office — a job created from a guess is worse than a job with blanks.
   */
  const [intake, setIntake] = useState<IntakeInboxRow | null>(null);
  const [intakeError, setIntakeError] = useState<unknown>(null);
  const [intakeLocationId, setIntakeLocationId] = useState<string | null>(null);
  useEffect(() => {
    if (!fromIntake) return;
    // Same ordering rule as the estimate above — the draft answer first.
    if (draftPhase !== "ready") return;
    let cancelled = false;
    loadIntakeSubmission(fromIntake)
      .then((row) => {
        if (cancelled || !row) return;
        // The submission is still needed whatever happens: submit() stamps it
        // with the job it became. Only the field prefill defers to the draft.
        setIntake(row);
        if (draftRestored.current) return;
        setIntakeLocationId(row.location_id ?? row.request?.location_id ?? null);
        const pick = (k: string) => (row.fields?.[k] ?? "").trim();
        if (pick("site_address")) setAddress(pick("site_address"));
        if (pick("customer_name")) setCustomerName(pick("customer_name"));
        const drafts: DraftMethod[] = [];
        if (pick("customer_phone"))
          drafts.push({
            kind: "phone",
            label: "",
            value: pick("customer_phone"),
            is_preferred: true,
          });
        if (pick("customer_email"))
          drafts.push({
            kind: "email",
            label: "",
            value: pick("customer_email"),
            is_preferred: !pick("customer_phone"),
          });
        if (drafts.length) setMethods(drafts);
        if (pick("loss_type_id")) setLossTypeId(pick("loss_type_id"));
        if (pick("loss_date")) setLossDate(pick("loss_date"));
        if (pick("claim_number")) setClaim(pick("claim_number"));
        if (pick("policy_number")) setPolicyNumber(pick("policy_number"));
        if (pick("notes")) setLossDescription(pick("notes"));
        setIntakeAnswers(
          Object.fromEntries(
            Object.entries(row.answers ?? {}).map(([id, a]) => [
              id,
              {
                question_id: id,
                answer_text: a.text?.trim() || null,
                answer_bool: a.bool ?? null,
                answer_date: a.date || null,
              },
            ]),
          ),
        );
      })
      .catch((e) => {
        if (!cancelled) setIntakeError(e);
      });
    return () => {
      cancelled = true;
    };
  }, [fromIntake, draftPhase]);

  // The CRM account resolves itself from whatever the form already knows.
  const inference = useAccountInference({
    customer,
    address,
    lat,
    lon,
    carriedAccountId,
    carriedFromLabel: fromLead ? "the original lead" : null,
    typedName: customerName,
  });
  const linked = useAutoLinkedAccount(inference, account, (a) => {
    setAccount(a);
    if (a) {
      if (!locationId) setLocationId(a.location_id);
    }
  });

  // Billing entity: the GSR location chosen above, full stop. It used to be a
  // second selector that could disagree with the job's own office, which is
  // how a Baltimore job ended up showing the North Carolina entity as its
  // biller. The state a job sits in still decides which entity is licensed to
  // bill it, so the offices are still loaded - but only to raise the advisory
  // below, never to offer a competing choice.
  const [billingOffices, setBillingOffices] = useState<BillingOffice[]>([]);
  useEffect(() => {
    loadBillingOffices()
      .then(setBillingOffices)
      .catch(() => setBillingOffices([]));
  }, []);
  const billingLocationId = locationId || null;
  const billingOffice = billingOffices.find((o) => o.id === billingLocationId) ?? null;
  const billingWarning = billingMismatch(billingOffice, region);

  const creatableLocations = useJobCreatableLocations();
  const canManage = creatableLocations.length > 0;

  // A lead routed to an office by its address (or minted for one) opens in
  // that office, when this user can create jobs there. Applied once: the
  // picker has usually already pre-filled the user's own office by the time
  // the submission loads, and the lead's office should win over that default.
  const intakeLocationApplied = useRef(false);
  useEffect(() => {
    if (!intakeLocationId || intakeLocationApplied.current) return;
    if (!creatableLocations.some((l) => l.id === intakeLocationId)) return;
    intakeLocationApplied.current = true;
    setLocationId(intakeLocationId);
  }, [intakeLocationId, creatableLocations]);
  const selectedOffice = creatableLocations.find((l) => l.id === locationId) ?? null;

  const today = new Date().toISOString().slice(0, 10);
  const lossInFuture = !!lossDate && lossDate > today;
  const reportedBeforeLoss = !!lossDate && !!callDate && callDate < lossDate;
  const lossIsStale = (() => {
    if (!lossDate) return false;
    const a = new Date(`${lossDate}T00:00:00`);
    const yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    return a < yearAgo;
  })();

  const submit = async () => {
    if (!locationId || !address.trim()) {
      toast.error("An address is required to create a job.");
      return;
    }
    if (lossInFuture) {
      toast.error("Date of loss cannot be in the future.");
      return;
    }
    if (reportedBeforeLoss) {
      toast.error("Reported date cannot precede the date of loss.");
      return;
    }
    const badMethod = contactMethodsError(methods);
    if (badMethod) {
      toast.error(badMethod);
      return;
    }
    setSaving(true);

    /*
     * David, on converting an estimate whose customer was only ever typed:
     * "I'll write David Stern here, and it saves it, not in the CRM or
     * wherever, but when I convert it to a job, it's gonna pull that to create
     * a new contact for the job."
     *
     * Only on a conversion, and only for a person the CRM does not already
     * hold — a job started from scratch keeps the old behaviour, where the
     * rep decides in the picker whether this is a record worth keeping.
     * Failing to create the contact must not lose the job: the name is on
     * `jobs.customer_name` regardless, so this reports and carries on.
     */
    let customerContactId = customer.contactId;
    if (
      sourceCalculation &&
      needsCrmContact({ customerKind, customerName, contactId: customerContactId })
    ) {
      try {
        const created = await createCustomerContact({
          fullName: customerName,
          accountId: account?.id ?? null,
          locationId,
          methods,
          createdBy: app.userId,
        });
        if (created) {
          customerContactId = created.id;
          setCustomer((c) => ({ ...c, contactId: created.id }));
          toast.success(`${created.full_name} added to the CRM`);
        }
      } catch (e) {
        toastDbError(e, { action: "Adding the estimate's customer to the CRM" });
      }
    }

    const { data, error } = await supabase
      .from("jobs")
      .insert({
        location_id: locationId,
        billing_location_id: billingLocationId,
        job_number: "", // assigned by the job-number trigger using the admin pattern
        job_name: jobName.trim() || null,
        community: community.trim() || null,
        stage_id: stageId || defaultStage?.id || null,
        start_date: sourceCalculation?.jobDate || null,
        job_type: jobType || null,
        job_type_detail: jobTypeDetail.trim() || null,
        customer_kind: customerKind,
        customer_name: customerName.trim() || null,
        primary_contact_id: customerContactId ?? primaryContact?.id ?? null,
        address: address.trim(),
        address_line2: address2.trim() || null,
        locality: locality.trim() || null,
        region: region.trim() || null,
        postal_code: postal.trim() || null,
        county: county.trim() || null,
        lat: lat ? Number(lat) : null,
        lon: lon ? Number(lon) : null,
        loss_type_id: lossTypeId,
        loss_type_detail: lossTypeDetail.trim() || null,
        loss_date: lossDate || null,
        loss_description: lossDescription.trim() || null,
        reported_source_id: sourceId || null,
        reported_source_detail: sourceDetail.trim() || null,
        // A lead that came through a trade show's intake form stays the
        // show's when it becomes a job — that is what the ROI block counts.
        tradeshow_id: intake?.request?.tradeshow_id ?? null,
        call_date: callDate || null,
        call_time: callTime || null,
        // Cash work carries no carrier / claim / adjuster data at all.
        cash_payer_name: insuranceJob ? null : cashPayerName.trim() || customerName.trim() || null,
        agreed_price: insuranceJob || !agreedPrice ? null : Number(agreedPrice),
        deposit_amount: insuranceJob || !depositAmount ? null : Number(depositAmount),
        payment_terms: insuranceJob ? null : paymentTerms.trim() || null,
        insurance_carrier_account_id: insuranceJob ? (carrierAccount?.id ?? null) : null,
        insurance_carrier: insuranceJob ? (carrierAccount?.name ?? null) : null,
        policy_number: insuranceJob ? policyNumber.trim() || null : null,
        insurance_kind: insuranceJob ? insuranceKind || null : null,
        insurance_kind_detail: insuranceJob ? insuranceKindDetail.trim() || null : null,
        claim_number: insuranceJob ? claim.trim() || null : null,
        deductible: insuranceJob && deductible ? Number(deductible) : null,
        desk_adjuster_contact_id: insuranceJob ? (deskContact?.id ?? null) : null,
        field_adjuster_contact_id: insuranceJob ? (fieldContact?.id ?? null) : null,
        desk_adjuster_name: insuranceJob ? (deskContact?.full_name ?? null) : null,
        desk_adjuster_email: insuranceJob ? (deskContact?.email ?? null) : null,
        desk_adjuster_phone: insuranceJob ? (deskContact?.phone ?? null) : null,
        field_adjuster_name: insuranceJob ? (fieldContact?.full_name ?? null) : null,
        field_adjuster_email: insuranceJob ? (fieldContact?.email ?? null) : null,
        field_adjuster_phone: insuranceJob ? (fieldContact?.phone ?? null) : null,
        adjuster_name: insuranceJob ? ((adjusterContact ?? deskContact)?.full_name ?? null) : null,
        adjuster_email: insuranceJob ? ((adjusterContact ?? deskContact)?.email ?? null) : null,
        adjuster_phone: insuranceJob ? ((adjusterContact ?? deskContact)?.phone ?? null) : null,
        insurance_agency_account_id: insuranceJob ? (agencyAccount?.id ?? null) : null,
        insurance_agency: insuranceJob ? (agencyAccount?.name ?? null) : null,
        insurance_agent_name: insuranceJob ? (agentContact?.full_name ?? null) : null,
        insurance_agent_email: insuranceJob ? (agentContact?.email ?? null) : null,
        insurance_agent_phone: insuranceJob ? (agentContact?.phone ?? null) : null,

        public_adjuster_account_id: insuranceJob ? (paAccount?.id ?? null) : null,
        public_adjuster_contact_id: insuranceJob ? (paContact?.id ?? null) : null,
        public_adjuster_name: insuranceJob
          ? (paContact?.full_name ?? paAccount?.name ?? null)
          : null,
        public_adjuster_email: insuranceJob ? (paContact?.email ?? null) : null,
        public_adjuster_phone: insuranceJob ? (paContact?.phone ?? null) : null,
        independent_reviewer_account_id: insuranceJob ? (reviewerAccount?.id ?? null) : null,
        independent_reviewer_contact_id: insuranceJob ? (reviewerContact?.id ?? null) : null,
        independent_reviewer_firm: insuranceJob ? (reviewerAccount?.name ?? null) : null,
        independent_reviewer_name: insuranceJob ? (reviewerContact?.full_name ?? null) : null,
        independent_reviewer_email: insuranceJob ? (reviewerContact?.email ?? null) : null,
        independent_reviewer_phone: insuranceJob ? (reviewerContact?.phone ?? null) : null,
        referral_source_type: referralType || null,
        referral_source_type_detail: referralTypeDetail.trim() || null,
        referred_by_account_id: referralAccount?.id ?? null,
        referred_by_contact_id: referralContact?.id ?? null,
        referred_by_name: referralContact?.full_name ?? null,
        additional_work_pending: addlWork,
        rehabbed_after_1978: rehabbed === "unknown" ? null : rehabbed === "yes",
        scope: scope.trim() || null,
        important_instructions: importantInstructions.trim() || null,
        account_id: account?.id ?? null,
        fire_lead_id: fromLead ?? null,
        created_by: app.userId,
      })
      .select("id, job_number")
      .single();
    if (error || !data) {
      setSaving(false);
      if (error && isAccessError(error)) {
        const office = selectedOffice ? `the ${selectedOffice.name} office` : "that office";
        toast.error(`You can't create jobs for ${office} — you're not a member.`);
        console.error("[db-error] Creating job (blocked by jobs_insert policy):", error);
      } else {
        toastDbError(error ?? new Error("no row returned"), { action: "Creating job" });
      }
      return;
    }

    /*
     * The carrier adjuster's and agent's record links (20261105120000) go in
     * their own update for the same reason as the site names below: until
     * that migration is applied the columns do not exist, and the job — with
     * the names, emails and phones already copied onto it — must still be
     * created. A missing column is simply skipped.
     */
    const links: Record<string, string> = {};
    if (insuranceJob && adjusterContact) links.adjuster_contact_id = adjusterContact.id;
    if (insuranceJob && agentContact) links.insurance_agent_contact_id = agentContact.id;
    if (Object.keys(links).length) {
      const { error: linkErr } = await supabase
        .from("jobs")
        .update(links as never)
        .eq("id", data.id);
      if (linkErr && !isMissingSchema(linkErr))
        toastDbError(linkErr, { action: "Linking the adjuster and agent records" });
    }

    // Their own update, after the insert: until 20261021120000 is applied the
    // columns do not exist, and the job must still be created.
    if (buildingName.trim() || facilityName.trim()) {
      try {
        const site = await saveJobSiteNames(data.id, {
          building_name: buildingName,
          facility_name: facilityName,
        });
        if (site === "missing") {
          toast.warning("Building and facility names were not saved", {
            description: "They need a database update first. The job itself is saved.",
          });
        }
      } catch (e) {
        toastDbError(e, { action: "Saving the building and facility names" });
      }
    }

    const rows = methods
      .filter((m) => m.value.trim())
      .map((m) => ({
        job_id: data.id,
        kind: m.kind,
        label: m.label || null,
        value: m.value.trim(),
        extension: m.extension?.trim() || null,
        is_preferred: m.is_preferred,
      }));
    if (rows.length) {
      const { error: cmErr } = await supabase.from("job_contact_methods").insert(rows);
      if (cmErr) toastDbError(cmErr, { action: "Saving customer contact methods" });
    }

    // Seed Related Contacts with the named people captured inline.
    const related = [
      /*
       * Mark, on job 2618851: "the main point of contact is missing". The
       * customer and the main point of contact were going onto the `jobs` row
       * only — `customer_name` and `primary_contact_id` — so a job with no
       * carrier and no referral opened on a Contacts tab that said there were
       * no contacts, on a job where two people had just been typed in.
       *
       * They are relationships like any other and belong in the list with the
       * adjusters. `derivedJobContacts` is the same function the tab uses to
       * show these two on jobs created before today, which is what keeps a job
       * created from here from listing the same person twice: whatever it
       * returns here is written, and on the next read it returns nothing
       * because the rows now account for those people.
       */
      ...derivedJobContacts([], {
        customer_name: customerName.trim() || null,
        account_id: account?.id ?? customer.accountId ?? null,
        account_name: account?.name ?? null,
        // Mirrors `primary_contact_id` above, precedence and all, so the row
        // and the column can never name different people.
        primary_contact: customerContactId
          ? {
              id: customerContactId,
              full_name: customerName.trim(),
              email: customer.email,
              phone: customer.phone,
            }
          : primaryContact,
      }).map((d) => ({
        role: d.role,
        contact_id: d.contact_id,
        account_id: d.account_id,
        full_name: d.full_name,
        email: d.email,
        phone: d.phone,
        notes: d.notes,
      })),
      deskContact && {
        role: "desk_adjuster",
        contact_id: deskContact.id,
        account_id: carrierAccount?.id ?? null,
        full_name: deskContact.full_name,
        email: deskContact.email,
        phone: deskContact.phone,
      },
      // Only when it is somebody other than the desk adjuster, who is listed above.
      adjusterContact &&
        adjusterContact.id !== deskContact?.id &&
        adjusterContact.id !== fieldContact?.id && {
          role: "adjuster",
          contact_id: adjusterContact.id,
          account_id: carrierAccount?.id ?? null,
          full_name: adjusterContact.full_name,
          email: adjusterContact.email,
          phone: adjusterContact.phone,
        },
      fieldContact && {
        role: "field_adjuster",
        contact_id: fieldContact.id,
        account_id: carrierAccount?.id ?? null,
        full_name: fieldContact.full_name,
        email: fieldContact.email,
        phone: fieldContact.phone,
      },

      paContact && {
        role: "public_adjuster",
        contact_id: paContact.id,
        account_id: paAccount?.id ?? null,
        full_name: paContact.full_name,
        email: paContact.email,
        phone: paContact.phone,
      },
      reviewerContact && {
        role: "independent_reviewer",
        contact_id: reviewerContact.id,
        account_id: reviewerAccount?.id ?? null,
        full_name: reviewerContact.full_name,
        email: reviewerContact.email,
        phone: reviewerContact.phone,
      },
      referralContact && {
        role: "referrer",
        contact_id: referralContact.id,
        account_id: referralAccount?.id ?? null,
        full_name: referralContact.full_name,
        email: referralContact.email,
        phone: referralContact.phone,
      },
    ].filter(Boolean) as Record<string, unknown>[];
    if (related.length) {
      const { error: jcErr } = await supabase
        .from("job_contacts")
        .insert(related.map((r) => ({ ...r, job_id: data.id, created_by: app.userId })) as never);
      if (jcErr) toastDbError(jcErr, { action: "Saving related contacts" });
    }

    try {
      await saveJobIntakeAnswers(data.id, intakeAnswers, app.userId);
    } catch (e) {
      toastDbError(e, { action: "Saving intake answers" });
    }

    // Cadence keys include the new job id, so retries reconcile this same
    // checklist instead of adding another copy.
    if (app.userId) {
      try {
        await syncAutomaticJobTasksForJob(data.id, app.userId);
      } catch (e) {
        toastDbError(e, { action: "Creating the job's scope tasks" });
      }
    }

    // Stamp the lead with the job it became, so it leaves the intake inbox and
    // the same form is never worked twice.
    if (intake) {
      try {
        await linkIntakeToCreatedJob(intake, data.id, app.userId);
      } catch (e) {
        toastDbError(e, { action: "Linking the intake form to the new job" });
      }
    }

    if (calculatorId) {
      try {
        await attachJobCalculation(calculatorId, data.id);
      } catch (e) {
        toastDbError(e, { action: "Attaching calculation to the new job" });
      }
    }

    setSaving(false);
    // The job exists now, so the draft is no longer a safety net — it is a
    // duplicate waiting to be re-opened. Only a created job clears it; every
    // failure above returns early and leaves it exactly where it was.
    forgetDraft();
    toast.success(`Job ${data.job_number} created`);
    navigate({ to: "/jobs/$id", params: { id: data.id }, search: {} as never });
  };

  if (!canManage) {
    return (
      <div className="mx-auto max-w-2xl p-3">
        <Card>
          <CardContent className="p-3 text-sm">
            Your role and office memberships don't allow creating jobs. Ask an admin to add you to
            an office with a job-creating role.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-4 py-4 pb-24">
      <h1 className="display-heavy text-[22px] leading-tight">
        New job {fromLead && <span className="text-sm text-muted-foreground">(from lead)</span>}
        {fromIntake && <span className="text-sm text-muted-foreground"> (from intake form)</span>}
        {/* Named for the button that got them here, so the screen confirms
            the conversion happened rather than looking like a blank form. */}
        {calculatorId && (
          <span className="text-sm text-muted-foreground"> (converted from an estimate)</span>
        )}
      </h1>

      {/*
        Say it, do not just do it. A form that silently fills itself in is the
        thing people distrust — they cannot tell what is theirs. This is the
        same inline notice the prior-jobs banner in this form uses, and it
        carries the way out: one button puts the form back to blank and throws
        the draft away.
      */}
      {restoredAt !== null ? (
        <div className="flex items-center justify-between gap-2 rounded-sm border border-primary/40 bg-primary/5 p-2 text-xs">
          <span className="min-w-0">
            Picked up where you left off — your unsaved draft from{" "}
            {draftAge(restoredAt, Date.now())}.
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-xs"
            onClick={() => {
              applyDraftValues(blankDraftValues());
              forgetDraft();
            }}
          >
            <RotateCcw className="mr-1 size-3.5" />
            Start over
          </Button>
        </div>
      ) : null}

      {/* An intake form that failed to load must not look like a blank form —
          saving now would create a job the lead is never linked to. */}
      {intakeError ? (
        <LoadError what="the intake form this job is being created from" error={intakeError} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Property & identity</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <AddressAutocomplete
            value={address}
            onValueChange={setAddress}
            autoFocus
            disabled={app.writesDisabled}
            onSelect={(s) => {
              setAddress(s.address || s.label);
              setLocality(s.locality ?? "");
              setRegion(s.region ?? "");
              setPostal(s.postal_code ?? "");
              setCounty(s.county ?? "");
              setLat(s.lat != null ? String(s.lat) : "");
              setLon(s.lon != null ? String(s.lon) : "");
            }}
          />
          <Input
            placeholder="Unit / floor (optional)"
            value={address2}
            onChange={(e) => setAddress2(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input
              placeholder="City"
              value={locality}
              onChange={(e) => setLocality(e.target.value)}
            />
            <Input placeholder="State" value={region} onChange={(e) => setRegion(e.target.value)} />
            <Input placeholder="Zip" value={postal} onChange={(e) => setPostal(e.target.value)} />
            <Input
              placeholder="County"
              value={county}
              onChange={(e) => setCounty(e.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Job name</Label>
              <Input value={jobName} onChange={(e) => setTypedJobName(e.target.value)} />
            </div>
          </div>

          {/* Where on the site — all optional, all searchable (David, 21 Oct). */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="grid gap-1.5">
              <Label htmlFor="job-facility">Facility name</Label>
              <Input
                id="job-facility"
                value={facilityName}
                onChange={(e) => setFacilityName(e.target.value)}
                placeholder="e.g. Sunrise Nursing Home"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-building">Building name</Label>
              <Input
                id="job-building"
                value={buildingName}
                onChange={(e) => setBuildingName(e.target.value)}
                placeholder="e.g. Building C"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="job-community">Community name</Label>
              <Input
                id="job-community"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                placeholder="Development or complex"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Job number</Label>
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-sm text-muted-foreground">
                Generated on save
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Job status</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  {jobStages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <LocationPicker
            value={locationId}
            onChange={setLocationId}
            lat={lat}
            lon={lon}
            // A restored office is the one they chose, so the nearest-branch
            // suggestion must not put it back to whatever is closest to the
            // address they also restored.
            chosen={restoredAt !== null}
            options={creatableLocations}
          />

          {/*
           * The billing entity is the GSR location above — one choice, not
           * two that could disagree. The advisory below stays because the
           * state a job sits in still decides which entity is licensed to
           * bill it; it informs rather than offering a second control.
           */}
          {billingWarning ? (
            <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-200">
              {billingWarning}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer</CardTitle>
          <p className="text-xs text-muted-foreground">
            Normally the insured, unless a company owns the property.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <PriorJobsBanner
            address={address}
            lat={lat}
            lon={lon}
            onAdopt={async (j) => {
              const c = await customerFromPriorJob(j);
              setCustomerKind(c.kind);
              await applyCustomer(c);
              toast.success(`Customer taken from job ${j.job_number}`);
            }}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Customer is</Label>
              <Select
                value={customerKind}
                onValueChange={(v) => {
                  const k = v as "person" | "company";
                  setCustomerKind(k);
                  setCustomer((c) => ({ ...c, kind: k }));
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="person">Individual (the insured)</SelectItem>
                  <SelectItem value="company">Company</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <CustomerPicker
              kind={customerKind}
              value={customer}
              onChange={(c) => void applyCustomer(c)}
              disabled={app.writesDisabled}
              defaultAccount={account}
              defaultLocationId={locationId}
            />
          </div>
          <CompanyContactPicker
            accountLabel="CRM account (owner / management company)"
            contactLabel="Point of contact"
            account={account}
            reason={linked.reason}
            suggestion={linked.suggestion}
            onAcceptSuggestion={linked.acceptSuggestion}
            onDismissSuggestion={linked.dismissSuggestion}
            onAccountChange={(a) => {
              linked.onManualChange(a);
              if (a) {
                setLocationId(a.location_id);
                if (!customerName) setCustomerName(a.name);
              }
            }}
            contact={primaryContact}
            onContactChange={(c) => {
              setPrimaryContact(c);
              if (c && !customerName && customerKind === "person") setCustomerName(c.full_name);
            }}
            disabled={app.writesDisabled}
          />
          <ContactMethodEditor value={methods} onChange={setMethods} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Job type & loss detail</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <DetailSelect
                label="Job type"
                placeholder="How is this paid for?"
                options={paymentTypes.options.map((t) => ({
                  value: t.key,
                  label: t.label,
                  requiresDetail: (t as { requires_detail?: boolean }).requires_detail,
                }))}
                value={jobType}
                onValueChange={setJobType}
                detail={jobTypeDetail}
                onDetailChange={setJobTypeDetail}
                className="contents"
                helper="How the work is paid for — this decides which billing fields the job carries."
              />
            </div>
            <div className="grid gap-1.5">
              <DetailSelect
                label="Loss type"
                placeholder="Choose service category"
                options={lossTypes.options.map((o) => ({
                  value: o.id,
                  label: o.label,
                  requiresDetail: (o as { requires_detail?: boolean }).requires_detail,
                }))}
                value={lossTypeId}
                onValueChange={setLossTypeId}
                detail={lossTypeDetail}
                onDetailChange={setLossTypeDetail}
                className="contents"
                helper="The service category of the work."
              />
            </div>

            {/*
             * Loss description sits with the loss type it describes, not below
             * the dates. It is what the intake person is holding in their head
             * while the caller is still on the phone.
             */}
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Loss description</Label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value="" onValueChange={(v) => setLossDescription(v)}>
                  <SelectTrigger className="sm:w-56">
                    <SelectValue placeholder="Common causes" />
                  </SelectTrigger>
                  <SelectContent>
                    {lossPhrases.map((p) => (
                      <SelectItem key={p.key} value={p.label}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="flex-1"
                  placeholder="e.g. broken pipe in kitchen"
                  value={lossDescription}
                  onChange={(e) => setLossDescription(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-1.5">
              <Label>Date of loss</Label>
              <Input
                type="date"
                max={today}
                value={lossDate}
                onChange={(e) => setLossDate(e.target.value)}
              />
              {lossInFuture ? (
                <p className="text-xs text-destructive">The loss date cannot be in the future.</p>
              ) : lossIsStale ? (
                <p className="text-xs text-amber-700 dark:text-amber-500">
                  This loss is more than a year old — carriers often deny stale claims.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">When the damage happened.</p>
              )}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Date reported</Label>
              <Input type="date" value={callDate} onChange={(e) => setCallDate(e.target.value)} />
              {reportedBeforeLoss ? (
                <p className="text-xs text-destructive">
                  Reported date cannot precede the date of loss.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  When the customer called us — response time is measured from here.
                </p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label>Time reported</Label>
              <Input type="time" value={callTime} onChange={(e) => setCallTime(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* A cash job has no carrier, no policy, no claim, no adjuster and no
          deductible — so none of it is asked for. */}
      {insuranceJob ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Insurance</CardTitle>
              {insuranceRuleOn ? (
                <p className="text-xs text-muted-foreground">
                  * Needed to bill the claim: carrier, policy #, claim #, a carrier adjuster and the
                  public adjuster. Until all five are in, the office has a task for it.
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-3">
              <DetailSelect
                label="Policy type"
                placeholder="Which policy is this?"
                options={insuranceKinds.options.map((o) => ({
                  value: o.key,
                  label: o.label,
                  requiresDetail: (o as { requires_detail?: boolean }).requires_detail,
                }))}
                value={insuranceKind}
                onValueChange={setInsuranceKind}
                detail={insuranceKindDetail}
                onDetailChange={setInsuranceKindDetail}
                helper="A renter's policy covers the tenant's contents, not the structure — it changes who pays."
              />
              {insuranceKind === "renters" && (
                <div className="rounded-sm border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent-foreground">
                  Renter&rsquo;s policy — confirm who is paying for structural work before scoping.
                </div>
              )}
              {/*
               * Carrier only. The contact half of CompanyContactPicker was
               * wired to nothing here - it rendered a "Carrier contact" box
               * that discarded whatever was put in it. The people who matter
               * at a carrier are the adjusters below.
               *
               * No free-text carrier: the picker's "+ Add …" creates the
               * reference account inline, so the data always accumulates.
               */}
              <AccountPicker
                label={star("Insurance company")}
                value={carrierAccount}
                onChange={(a) => {
                  setCarrierAccount(a);
                  setDeskContact(null);
                  setFieldContact(null);
                  setAdjusterContact(null);
                }}
                disabled={app.writesDisabled}
                typeKey="insurance_carrier"
                typeNoun="insurance carrier"
              />

              {/* A carrier typed into the public form is not a carrier record.
                  It is matched here and only becomes one when confirmed. */}
              {intake ? (
                <CarrierConfirm
                  name={intake.fields["insurance_carrier"]}
                  value={
                    carrierAccount
                      ? {
                          id: carrierAccount.id,
                          name: carrierAccount.name,
                          location_id: carrierAccount.location_id,
                        }
                      : null
                  }
                  onChange={(a) => setCarrierAccount(a ? { ...a, primary_contact: null } : null)}
                />
              ) : null}

              <div className="grid gap-2 sm:grid-cols-3">
                <Input
                  placeholder={star("Policy #")}
                  value={policyNumber}
                  onChange={(e) => setPolicyNumber(e.target.value)}
                />
                <Input
                  placeholder={star("Claim #")}
                  value={claim}
                  onChange={(e) => setClaim(e.target.value)}
                />
                <NumberInput
                  placeholder="Deductible"
                  decimals={2}
                  value={deductible}
                  onValueChange={(_, clean) => setDeductible(clean)}
                />
              </div>

              {/* Adjusters are people at the carrier, not free text — the same
                  handful recur job after job, so capture them once. */}
              <AccountContactPicker
                label="Carrier adjuster"
                accountId={carrierAccount?.id ?? null}
                accountName={carrierAccount?.name}
                value={adjusterContact}
                onChange={(p) => {
                  setAdjusterContact(p);
                  adoptCarrierFrom(p);
                }}
                disabled={app.writesDisabled}
                defaultTitle="Adjuster"
                searchTypeKey="insurance_carrier"
              />
              <div className="grid gap-2 sm:grid-cols-2">
                <AccountContactPicker
                  label={star("Desk adjuster")}
                  accountId={carrierAccount?.id ?? null}
                  accountName={carrierAccount?.name}
                  value={deskContact}
                  onChange={(p) => {
                    setDeskContact(p);
                    adoptCarrierFrom(p);
                  }}
                  disabled={app.writesDisabled}
                  defaultTitle="Desk adjuster"
                  searchTypeKey="insurance_carrier"
                />
                <AccountContactPicker
                  label="Field adjuster"
                  accountId={carrierAccount?.id ?? null}
                  accountName={carrierAccount?.name}
                  value={fieldContact}
                  onChange={(p) => {
                    setFieldContact(p);
                    adoptCarrierFrom(p);
                  }}
                  disabled={app.writesDisabled}
                  defaultTitle="Field adjuster"
                  searchTypeKey="insurance_carrier"
                />
              </div>
              {!carrierAccount && (
                <p className="text-xs text-muted-foreground">
                  Either order works — pick the carrier and browse its adjusters, or search the
                  adjuster by name and the carrier fills itself in.
                </p>
              )}

              {/* Independent / third-party reviewer — an engineer, consultant or
                  IA firm the carrier brings in. Firm is an account like a
                  carrier, so the next job with that firm prefills. */}
              <div className="space-y-2 border-t pt-3">
                <div className="text-xs font-medium text-muted-foreground">
                  Independent / third-party reviewer
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <AccountPicker
                    label="Reviewing firm"
                    value={reviewerAccount}
                    onChange={(a) => {
                      setReviewerAccount(a);
                      setReviewerContact(null);
                    }}
                    disabled={app.writesDisabled}
                    typeKey="adjusting_firm"
                    typeNoun="reviewing / independent adjusting firm"
                  />
                  <AccountContactPicker
                    label="Reviewer"
                    accountId={reviewerAccount?.id ?? null}
                    accountName={reviewerAccount?.name}
                    value={reviewerContact}
                    onChange={(p) => {
                      setReviewerContact(p);
                      if (!reviewerAccount && p?.account_id) {
                        setReviewerAccount({
                          id: p.account_id,
                          name: p.account_name ?? "",
                        } as PickedAccount);
                      }
                    }}
                    disabled={app.writesDisabled}
                    defaultTitle="Independent reviewer"
                    searchTypeKey="adjusting_firm"
                  />
                </div>
              </div>

              {/* BC-CON-1.1 — the insured's agency and the agent there. Same
                  pair as the reviewer: firm and person, either order, and a
                  new agent is saved under the agency for the next job. */}
              <div className="space-y-2 border-t pt-3">
                <div className="text-xs font-medium text-muted-foreground">
                  Insurance agency &amp; agent
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <AccountPicker
                    label="Agency"
                    value={agencyAccount}
                    onChange={(a) => {
                      setAgencyAccount(a);
                      setAgentContact(null);
                    }}
                    disabled={app.writesDisabled}
                    typeKey="insurance_broker"
                    typeNoun="insurance agency"
                  />
                  <AccountContactPicker
                    label="Agent"
                    accountId={agencyAccount?.id ?? null}
                    accountName={agencyAccount?.name}
                    value={agentContact}
                    onChange={(p) => {
                      setAgentContact(p);
                      if (!agencyAccount && p?.account_id) {
                        setAgencyAccount({
                          id: p.account_id,
                          name: p.account_name ?? "",
                        } as PickedAccount);
                      }
                    }}
                    disabled={app.writesDisabled}
                    defaultTitle="Insurance agent"
                    searchTypeKey="insurance_broker"
                  />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{star("Public adjuster")}</CardTitle>
              <p className="text-xs text-muted-foreground">
                Works for the insured, not the carrier.
              </p>
            </CardHeader>
            <CardContent>
              {/* Firm and person side by side, either order — same as the
                  carrier's adjusters and the reviewing firm. */}
              <div className="grid gap-2 sm:grid-cols-2">
                <AccountPicker
                  label="Public adjusting company"
                  value={paAccount}
                  onChange={(a) => {
                    setPaAccount(a);
                    setPaContact(null);
                  }}
                  disabled={app.writesDisabled}
                  typeKey="public_adjusting_firm"
                  typeNoun="public adjusting firm"
                />
                <AccountContactPicker
                  label="Public adjuster"
                  accountId={paAccount?.id ?? null}
                  accountName={paAccount?.name}
                  value={paPerson}
                  onChange={(p) => {
                    setPaPerson(p);
                    if (!paAccount && p?.account_id) {
                      setPaAccount({
                        id: p.account_id,
                        name: p.account_name ?? "",
                      } as PickedAccount);
                    }
                  }}
                  disabled={app.writesDisabled}
                  defaultTitle="Public adjuster"
                  searchTypeKey="public_adjusting_firm"
                />
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Payment</CardTitle>
            <p className="text-xs text-muted-foreground">
              Cash work is billed to the customer — no carrier, no claim, no approval step.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-1.5">
              <Label>Who is paying</Label>
              <Input
                placeholder="Defaults to the customer if left blank"
                value={cashPayerName}
                onChange={(e) => setCashPayerName(e.target.value)}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="grid gap-1.5">
                <Label className="text-xs">Agreed price</Label>
                <NumberInput
                  decimals={2}
                  placeholder="0.00"
                  value={agreedPrice}
                  onValueChange={(_, clean) => setAgreedPrice(clean)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Deposit taken</Label>
                <NumberInput
                  decimals={2}
                  placeholder="0.00"
                  value={depositAmount}
                  onValueChange={(_, clean) => setDepositAmount(clean)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs">Balance due</Label>
                <Input
                  readOnly
                  value={
                    agreedPrice
                      ? (Number(agreedPrice) - Number(depositAmount || 0)).toFixed(2)
                      : "—"
                  }
                  className="bg-muted/50"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Payment terms</Label>
              <Input
                placeholder="e.g. 50% on start, balance on completion"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value)}
              />
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Referral</CardTitle>
          <p className="text-xs text-muted-foreground">
            Company plus the individual, so referral credit is attributable to a person.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-1.5">
            <DetailSelect
              label="Referral source type"
              placeholder="Public adjuster, broker, salesperson…"
              options={toDetailOptions(referralTypes)}
              value={referralType}
              onValueChange={setReferralType}
              detail={referralTypeDetail}
              onDetailChange={setReferralTypeDetail}
              className="contents"
            />
          </div>
          <CompanyContactPicker
            accountLabel="Referring company"
            contactLabel="Referring contact"
            account={referralAccount}
            onAccountChange={setReferralAccount}
            contact={referralContact}
            onContactChange={setReferralContact}
            disabled={app.writesDisabled}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Intake</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <IntakeQuestionnaire
            questions={intakeQuestions.data ?? []}
            answers={intakeAnswers}
            onChange={setIntakeAnswers}
            sources={sources}
            sourceId={sourceId}
            onSourceChange={setSourceId}
            sourceDetail={sourceDetail}
            onSourceDetailChange={setSourceDetail}
          />
          <p className="text-xs text-muted-foreground">
            Date and time reported live in the loss detail section above.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compliance & scope</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div>
              <div className="text-sm font-medium">
                {automaticScopeType === "water"
                  ? "Additional remediation required"
                  : "Additional work pending"}
              </div>
              <div className="text-xs text-muted-foreground">
                {automaticScopeType === "water"
                  ? "Adds the Water · Remediation follow-up group when this job is created."
                  : "Scope beyond the approved estimate."}
              </div>
            </div>
            <Switch checked={addlWork} onCheckedChange={setAddlWork} />
          </div>
          <div className="rounded-md border p-3">
            <div className="text-sm font-medium">Built after 1978?</div>
            <p className="mb-2 text-xs text-muted-foreground">
              Lead-paint indicator. The EPA RRP rule turns on the year the property was built -
              housing built before 1978 is presumed to contain lead-based paint and requires
              certified lead-safe work practices.
            </p>
            <Select
              value={rehabbed}
              onValueChange={(v) => setRehabbed(v as "unknown" | "yes" | "no")}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unknown">Unknown</SelectItem>
                <SelectItem value="yes">Yes — rehabbed after 1978</SelectItem>
                <SelectItem value="no">No — pre-1978, RRP applies</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Textarea
            placeholder="Scope description"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            rows={5}
          />
          <div className="rounded-sm border-2 border-warning bg-warning/10 p-3">
            <div className="text-xs font-bold uppercase tracking-wide">Important instructions</div>
            <p className="mb-2 text-xs text-muted-foreground">
              Site access and safety — gate codes, key location, dog on site, no parking before 9am,
              asbestos suspected. Shown pinned to the crew and printed on the scope of work.
            </p>
            <Textarea
              value={importantInstructions}
              onChange={(e) => setImportantInstructions(e.target.value)}
              rows={3}
            />
          </div>
        </CardContent>
      </Card>

      {/*
        Pinned to the bottom of the scroller, so Create job is on screen from
        the first field rather than below the scope, the instructions and
        everything else this form asks for.

        bottom-0 and not above-mobile-nav: the scroller is the shell's <main>,
        which already pads 4rem for the phone's bottom nav, and a sticky box
        sticks inside that padding — so bottom-0 rests just above the nav on
        a phone and on the window's edge from md, where the padding is gone.
      */}
      <div className="sticky bottom-0 z-20 -mx-4 flex justify-end gap-2 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        <Button
          variant="outline"
          onClick={() => {
            // Cancel is the person saying they are done with this form, which
            // is the one unambiguous "throw it away". Navigating anywhere else
            // keeps the draft, because leaving to look something up is not
            // abandoning the job.
            forgetDraft();
            navigate({ to: "/jobs", search: {} as never });
          }}
        >
          Cancel
        </Button>
        <Button
          className="flex-1 sm:flex-none"
          onClick={submit}
          disabled={saving || app.writesDisabled}
        >
          {saving ? "Creating…" : "Create job"}
        </Button>
      </div>
    </div>
  );
}
