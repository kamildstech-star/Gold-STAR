import { createFileRoute, Link, useNavigate, type SearchSchemaInput } from "@tanstack/react-router";
import { T } from "@/components/bilingual";
import {
  NO_FOCUS,
  focusFromSearch,
  parseJobPageSearch,
  type JobPageFocus,
  type JobPageSearch,
} from "@/lib/job-page-search";
import { createProjectForJob } from "@/lib/photo-projects";
import { JobPhotos, JobPhotoStrip, useJobPhotos } from "@/components/job-photos";
import { toastDbError } from "@/lib/db-errors";
import { googleMapsSearchUrl } from "@/lib/maps-links";
import { addJobNote } from "@/lib/job-update";
import { jobDisplayName } from "@/lib/job-display-name";
import { JobRenameDialog } from "@/components/job-rename-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { RecordLoadError } from "@/components/record-load-error";
import { supabase } from "@/integrations/supabase/client";
import { TmJobCostRows } from "@/components/tm-job-cost-rows";
import { useAppContext } from "@/components/app-context";
import { useCan } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  JOB_ASSIGNMENT_ROLES,
  JOB_ASSIGNMENT_ROLE_LABELS,
  JOB_LOSS_LABELS,
  JOB_STATUS_LABELS,
  fmtDate,
  fmtMoney,
  type JobAssignmentRole,
  type JobLossType,
  type JobStatus,
} from "@/lib/jobs";
import { JobContactMethodsPanel } from "@/components/job-contact-methods";
import { JobContactsTab } from "@/components/job-contacts-tab";
import { ExposureOriginChip } from "@/components/exposure-origin-chip";
import { EquipmentOnSiteChip } from "@/components/equipment-on-site";
import { JobBadgeField, JobHeader, type JobHeaderAction } from "@/components/job-header";
import { JobField, SectionEdit, SectionEditToggle } from "@/components/job-inline-field";
import { JobPartyFields } from "@/components/job-party-fields";
import { RowSelect } from "@/components/row-inline-field";
import { Masonry } from "@/components/masonry";
import { JobContactShortcuts, JobTasksRail, useJobOpenTaskCount } from "@/components/job-side-rail";
import { useJobMoney } from "@/lib/job-money";
import { JobSectionNotes } from "@/components/job-section-notes";
import { JobNotices } from "@/components/job-notices";
import { JobTasksTab } from "@/components/job-tasks-tab";
import { JobCommunicationsTab } from "@/components/job-communications-tab";
import { JobTimelineTab } from "@/components/job-timeline-tab";
import { JobScheduleTab } from "@/components/job-schedule-tab";
import { JobGantt } from "@/components/job-gantt";
import { JobScheduleShare } from "@/components/job-schedule-share";
import { JobRoomsTab } from "@/components/job-rooms-tab";
import { JobDryingLog } from "@/components/job-drying-log";
import { useCanManageJob } from "@/lib/use-can-manage-job";
import {
  TAB_TRIGGER,
  Tabs,
  TabsContent,
  TabsCount,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { JobEmailDialog } from "@/components/job-email-dialog";
import { IntakeSubmissionsReview } from "@/components/intake-submissions-review";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJobContacts, removeFormerCustomerContacts } from "@/lib/job-relationships";

import { isClosedStage, stageBadgeStyle, useJobStages } from "@/lib/job-stages";
import {
  JOB_TAB_LABEL,
  JOB_TABS,
  JOB_TABS_IN_MORE,
  isJobSection,
  jobTabHome,
  jobTabOrder,
  stripFade,
  type JobTab,
} from "@/lib/job-tab-order";
import { JobEquipmentPanel } from "@/components/equipment-panel";
import { FieldWorkTicketPanel } from "@/components/field-work-ticket-panel";
import { TmFieldFormsPanel } from "@/components/tm-field-forms-panel";
import { fieldFormsFor, isTmJob } from "@/lib/field-forms-visibility";
import { supplyListKind } from "@/lib/job-supply-list";
import { JobPortalPanel } from "@/components/job-portal-panel";
import { BillingRailProvider } from "@/components/billing-rail";
import { JobBillingPanel } from "@/components/job-billing-panel";
import { JobBillToCard } from "@/components/job-billing-entity";
import { JobCommissionsCard } from "@/components/job-commissions-card";
import { JobLedgerStrip } from "@/components/job-ledger-panel";
import { JobRunningCostWidgets } from "@/components/job-running-cost-panel";
import { MoneyEventsCard } from "@/components/money-events-card";
import { JobLabourPanel } from "@/components/job-labour-panel";
import { DocumentsPanel } from "@/components/documents-panel";
import { JobReportPanel } from "@/components/job-report-panel";
import { PersonPicker } from "@/components/person-picker";
import { JobDispatchDialog } from "@/components/job-dispatch-dialog";
import { LargeLossExpensesCard } from "@/components/large-loss-expenses-card";
import { billingOrderClass } from "@/lib/job-billing-order";
import { ScopeOfWorkCard } from "@/components/scope-of-work-card";
import { JobWriteUpsPanel } from "@/components/job-write-ups-panel";
import { RoomSketchesPanel } from "@/components/room-sketches-panel";
import { JobComplianceWarning } from "@/components/compliance-badge";
import { ChevronDown, MapPin, Mail, Receipt, Truck } from "lucide-react";
import { cn } from "@/lib/utils";
import { DocumentSendDialog } from "@/components/document-send-dialog";
import { JobPropertyCard } from "@/components/job-property-card";
import { JOB_TAB_ICON, JobTabCard } from "@/components/job-tab-icon";
import { JobInnerTabs } from "@/components/job-inner-tabs";
import { JobSection } from "@/components/job-section";
import { JobMoneyStrip } from "@/components/job-money-strip";
import { siteNamesLine } from "@/lib/job-site-names";
import { JobReferralPanel } from "@/components/job-referral-panel";
import { FOLD_HEADER, PhoneFold } from "@/components/phone-fold";
import { JobQuestionnaireView } from "@/components/intake-questionnaire";
import {
  useLossTypes,
  usePaymentTypes,
  useInsuranceKinds,
  isInsuranceJob,
} from "@/lib/loss-categories";
import {
  UndeterminedJobTypeChip,
  RentersPolicyChip,
  ResolveJobTypePrompt,
} from "@/components/job-type-resolve";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";
import { syncAutomaticJobTasksForJob } from "@/lib/automatic-job-tasks";
import { insuranceRuleApplies, missingInsuranceInfo } from "@/lib/insurance-info-task";

const JOB_ROLE_OPTS = optionsFrom(JOB_ASSIGNMENT_ROLES, JOB_ASSIGNMENT_ROLE_LABELS);

export const Route = createFileRoute("/_authenticated/jobs/$id")({
  head: () => ({
    meta: [{ title: "Job · Recovery Hub" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  /*
   * `?tab=pictures&photo=<id>` and the like: which tab to open and which
   * record on it to bring forward — what History's "Open record" sends. See
   * job-page-search.ts. `tab` stays on the URL (a reload keeps it); the
   * record params are taken back off once read.
   */
  validateSearch: (raw: JobPageSearch & SearchSchemaInput): JobPageSearch =>
    parseJobPageSearch(raw as Record<string, unknown>),
  component: JobDetail,
});

/**
 * A typed copy of a party that also has a record picker — shown only while it
 * holds something and the picker is still empty (old jobs), so the General
 * tab does not ask twice and nothing already typed disappears (23 Oct).
 */
function legacyOnly(typed: string | null | undefined, record: string | null | undefined): boolean {
  return !!typed?.trim() && !record;
}

type Job = {
  id: string;
  job_number: string;
  job_name: string | null;
  job_type: string | null;
  customer_kind: string | null;
  customer_name: string | null;
  address_line2: string | null;
  county: string | null;
  community: string | null;
  /** From 20261021120000; absent until it is applied (select("*")). */
  building_name?: string | null;
  facility_name?: string | null;
  reported_source_id: string | null;
  call_date: string | null;
  call_time: string | null;
  initial_loss_description: string | null;
  deductible: number | null;
  independent_reviewer_firm: string | null;
  independent_reviewer_name: string | null;
  independent_reviewer_email: string | null;
  independent_reviewer_phone: string | null;
  public_adjuster_name: string | null;
  public_adjuster_email: string | null;
  public_adjuster_phone: string | null;
  insurance_agency: string | null;
  insurance_agent_name: string | null;
  insurance_agent_email: string | null;
  insurance_agent_phone: string | null;
  referred_by_account_id: string | null;
  referred_by_contact_id: string | null;
  referred_by_name: string | null;
  third_party_company: string | null;
  additional_work_pending: boolean | null;
  rehabbed_after_1978: boolean | null;
  location_id: string;
  billing_location_id: string | null;
  lat: number | null;
  lon: number | null;
  address: string;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  loss_type: JobLossType;
  loss_type_id: string | null;
  cash_payer_name: string | null;
  agreed_price: number | null;
  deposit_amount: number | null;
  payment_terms: string | null;
  status: JobStatus;
  stage_id: string | null;
  loss_date: string | null;
  first_response_at: string | null;
  start_date: string | null;
  completion_date: string | null;
  crew_chief: string | null;
  insurance_carrier: string | null;
  insurance_carrier_account_id: string | null;
  insurance_agency_account_id: string | null;
  primary_contact_id: string | null;
  desk_adjuster_contact_id: string | null;
  field_adjuster_contact_id: string | null;
  public_adjuster_account_id: string | null;
  public_adjuster_contact_id: string | null;
  independent_reviewer_account_id: string | null;
  independent_reviewer_contact_id: string | null;
  policy_number: string | null;
  desk_adjuster_name: string | null;
  desk_adjuster_email: string | null;
  desk_adjuster_phone: string | null;
  field_adjuster_name: string | null;
  field_adjuster_email: string | null;
  field_adjuster_phone: string | null;
  insurance_kind: string | null;
  insurance_kind_detail: string | null;
  claim_number: string | null;
  adjuster_name: string | null;
  adjuster_email: string | null;
  adjuster_phone: string | null;
  estimated_amount: number | null;
  billed_amount: number | null;
  collected_amount: number | null;
  scope: string | null;
  important_instructions: string | null;
  important_instructions_urgent?: boolean | null;
  account_id: string | null;
  bill_to_account_id: string | null;
  bill_to_attention: string | null;
  fire_lead_id: string | null;
  created_at: string;
};

type Assignment = { id: string; user_id: string; role: string; name: string };
type Note = { id: string; author_id: string | null; body: string; created_at: string };
type History = { id: string; from_status: string | null; to_status: string; changed_at: string };

function JobDetail() {
  const { id } = Route.useParams();
  const app = useAppContext();
  const showMoney = useCan("job.view_costs");
  // T11: billed and paid for sellers — never cost, rates or margin.
  const showBilling = useCan("job.view_billing");
  const [job, setJob] = useState<Job | null>(null);
  const lossTypes = useLossTypes(null);
  const paymentTypes = usePaymentTypes();
  const insuranceJob = isInsuranceJob(job?.job_type);
  /* J1, 5 Nov: a T&M job can still have a carrier and a claim, so the
     Insurance card shows on it too; its Payment card stays as it is. */
  const showInsuranceCard = insuranceJob || isTmJob(job?.job_type);
  const fieldForms = fieldFormsFor(job?.job_type);
  /*
   * The asterisk on the five fields the office cannot bill without, and the
   * reason the "Insurance info missing" task exists. David, 22 Sep: "the four
   * or five critical stuff that should have like an asterisk". Only on jobs
   * the rule applies to — see insurance-info-task.ts.
   */
  const insuranceJobFields = job as Parameters<typeof missingInsuranceInfo>[0] | null;
  const starred = !!insuranceJobFields && insuranceRuleApplies(insuranceJobFields);
  const star = (label: string) => (starred ? `${label} *` : label);
  const insuranceMissing = insuranceJobFields ? missingInsuranceInfo(insuranceJobFields) : [];
  const insuranceKinds = useInsuranceKinds();
  const [loadError, setLoadError] = useState<unknown>(null);
  /*
   * Section pencils. Every card that holds editable fields opens all of them at
   * once rather than asking for a click per value — one flag per card so
   * unlocking Customer does not put Insurance into edit mode too.
   */
  const [editInsurance, setEditInsurance] = useState(false);
  /** 13 Nov: on a phone, Insurance is two tabs — the claim and carrier, or the public adjuster and agency. */
  const [insuranceTab, setInsuranceTab] = useState<"carrier" | "public_adjuster">("carrier");
  const [editCustomer, setEditCustomer] = useState(false);
  /** The address correction (David, 21 Oct) — from the header or the Property card. */
  const [addressEditOpen, setAddressEditOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [editIntake, setEditIntake] = useState(false);
  const [editReferral, setEditReferral] = useState(false);
  const [editPayment, setEditPayment] = useState(false);
  const [editAssignees, setEditAssignees] = useState(false);
  const [editNotes, setEditNotes] = useState(false);
  /** Estimated / billed / collected, derived so General and Billing agree. */
  const money = useJobMoney(id);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [loading, setLoading] = useState(true);
  const [newNote, setNewNote] = useState("");
  const [addUserId, setAddUserId] = useState("");
  const [addRole, setAddRole] = useState<JobAssignmentRole>("lead_technician");
  const [sourceLabel, setSourceLabel] = useState<string | null>(null);
  const [gearOut, setGearOut] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  /* The stage list itself is resolved by the badge's picker; the page only
     needs the lookup to render the current stage. */
  const { stageById } = useJobStages(job?.location_id ?? null);
  /*
   * The open tab lives on the URL (`?tab=billing`), so a reload keeps the job
   * AND the tab it was on (FE4, 28 Oct). A job opened from anywhere without a
   * `?tab=` still lands on General — David, 20 Oct: "opening a job always
   * lands on General" — because a plain link names no tab. Switching tabs
   * replaces the history entry rather than pushing one, so Back leaves the
   * job instead of walking back through its tabs. General is the default and
   * is kept off the URL.
   */
  const search = Route.useSearch();
  const routeNavigate = useNavigate();
  const tab: JobTab = search.tab ?? "general";
  /*
   * 5 Nov: four tabs became inner tabs of others (Schedule | Tasks, …).
   * Asking for one — a button, a link — opens the tab it joined with that
   * inner tab open. Which inner tab is open is `section` on the URL, so a
   * reload keeps it.
   */
  const setTab = useCallback(
    (next: string) => {
      if (!(JOB_TABS as readonly string[]).includes(next)) return;
      const asked = next as JobTab;
      const home = jobTabHome(asked);
      void routeNavigate({
        to: "/jobs/$id",
        params: { id },
        search:
          home === "general"
            ? isJobSection(asked)
              ? { section: asked }
              : {}
            : isJobSection(asked)
              ? { tab: home, section: asked }
              : { tab: home },
        replace: true,
      });
    },
    [id, routeNavigate],
  );
  /*
   * Round 2: Equipment (and Timeline) are sections of General, not inner
   * tabs. A link that asks for one opens it and scrolls to it.
   */
  const sectionAsked =
    search.section && ["general", "billing"].includes(jobTabHome(search.section))
      ? search.section
      : null;
  const [revealed, setRevealed] = useState<{ key: JobTab; at: number } | null>(null);
  useEffect(() => {
    if (sectionAsked) setRevealed({ key: sectionAsked, at: Date.now() });
  }, [sectionAsked]);
  const revealAt = (key: JobTab) => (revealed?.key === key ? revealed.at : undefined);
  useEffect(() => {
    if (!revealed || loading || tab !== jobTabHome(revealed.key)) return;
    const go = () => {
      const el = document.querySelector<HTMLElement>(`[data-job-section="${revealed.key}"]`);
      if (!el) return;
      el.scrollIntoView({ block: "start" });
      const scroller = el.closest("main");
      const pin = tabPinRef.current?.offsetHeight ?? 0;
      if (scroller) scroller.scrollTop -= pin + 8;
    };
    // General loads its cards, photos and gear in turn, each pushing the
    // sections below further down, so the scroll is repeated while it settles.
    const timers = [80, 500, 1200, 2500, 4000].map((ms) => window.setTimeout(go, ms));
    const stop = () => timers.forEach((t) => window.clearTimeout(t));
    window.addEventListener("wheel", stop, { once: true, passive: true });
    window.addEventListener("touchmove", stop, { once: true, passive: true });
    return () => {
      stop();
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
    };
  }, [revealed, tab, loading]);
  /** The inner tab open on `home`: the URL's section when it belongs there. */
  const innerTab = (home: JobTab): JobTab =>
    search.section && jobTabHome(search.section) === home ? search.section : home;
  const setInnerTab = (home: JobTab, next: JobTab) =>
    void routeNavigate({
      to: "/jobs/$id",
      params: { id },
      search: next === home ? { tab: home } : { tab: home, section: next },
      replace: true,
    });
  /*
   * A link that names a record on a tab (History's "Open record": a photo, a
   * report, a document, a task). Hand the record to the tab and take the
   * record params back off the URL — they are an instruction, not state, and
   * the same link pressed again has to work again. The tab itself stays.
   */
  const [focus, setFocus] = useState<JobPageFocus>(NO_FOCUS);
  useEffect(() => {
    if (!search.photo && !search.report && !search.doc && !search.task) return;
    setFocus(
      focusFromSearch(
        { photo: search.photo, report: search.report, doc: search.doc, task: search.task },
        Date.now(),
      ),
    );
    void routeNavigate({
      to: "/jobs/$id",
      params: { id },
      search: search.tab
        ? { tab: search.tab, ...(search.section ? { section: search.section } : {}) }
        : {},
      replace: true,
    });
  }, [
    id,
    search.tab,
    search.photo,
    search.report,
    search.doc,
    search.task,
    search.section,
    routeNavigate,
  ]);
  const jobPhotos = useJobPhotos(id);
  const openTaskCount = useJobOpenTaskCount(id);
  const [emailOpen, setEmailOpen] = useState(false);
  const [contractEmailOpen, setContractEmailOpen] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  /** Bumped when a suggested phone/email is applied, so the Customer card re-reads its list. */
  const [contactMethodsVersion, setContactMethodsVersion] = useState(0);

  // The same database function used by job RLS decides whether this action is
  // visible. The insert remains protected even if somebody calls it directly.
  const canManageJob = useCanManageJob(id);

  // The default related contact drives the header quick actions.
  const jobContactsQ = useQuery({
    queryKey: ["job-contacts", id],
    queryFn: () => fetchJobContacts(id),
  });
  const defaultContact =
    jobContactsQ.data?.find((c) => c.is_default_contact) ?? jobContactsQ.data?.[0] ?? null;

  // Photos live on the linked project album, if there is one.
  const projectQ = useQuery({
    queryKey: ["job-project", id],
    queryFn: async () => {
      const { data } = await supabase
        .from("projects")
        .select("id")
        .eq("job_id", id)
        .limit(1)
        .maybeSingle();
      return data?.id ?? null;
    },
  });
  const projectId = projectQ.data ?? null;
  // Named rather than inline: the drying log's mount is read by a test that
  // stops at the first ">", and an arrow has one.
  const refetchAlbum = () => void projectQ.refetch();
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const navigate = useNavigate();

  // loss -> reported -> first response, the chain property managers ask about
  const responseChain = (() => {
    const out: string[] = [];
    if (!job) return out;
    const reportedAt = job.call_date
      ? new Date(`${job.call_date}T${(job.call_time ?? "00:00:00").slice(0, 8)}`)
      : null;
    const lossAt = job.loss_date ? new Date(`${job.loss_date}T00:00:00`) : null;
    const span = (ms: number) => {
      const mins = Math.max(0, Math.round(ms / 60000));
      if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"}`;
      const hrs = Math.round(mins / 60);
      if (hrs < 48) return `${hrs} hour${hrs === 1 ? "" : "s"}`;
      const days = Math.round(hrs / 24);
      return `${days} day${days === 1 ? "" : "s"}`;
    };
    if (lossAt && reportedAt && reportedAt >= lossAt) {
      out.push(`Reported ${span(reportedAt.getTime() - lossAt.getTime())} after loss`);
    }
    if (reportedAt && job.first_response_at) {
      const fr = new Date(job.first_response_at);
      if (fr >= reportedAt) {
        out.push(`First response ${span(fr.getTime() - reportedAt.getTime())} after report`);
      }
    }
    return out;
  })();

  const loadGearCount = async () => {
    const { count } = await supabase
      .from("equipment_placements")
      .select("id", { count: "exact", head: true })
      .eq("job_id", id)
      .is("retrieved_at", null);
    setGearOut(count ?? 0);
  };

  /*
   * Which job is on screen, so a refresh can tell itself apart from a first
   * load. `reload()` runs after nearly every save on this page, and it used to
   * put the whole record behind "Loading…" each time: every tab's contents
   * unmounted and <main> dropped back to the top. That is the other half of
   * David's "it has to save where you're at" — the position died on a save as
   * well as on a trip away. Only a job not yet shown gets the loading shell;
   * a refresh updates in place.
   */
  const shownJobId = useRef<string | null>(null);

  /* One customer per job: a new Account replaces the old customer on the
     Contacts list rather than sitting beside it (4 Nov). */
  const queryClient = useQueryClient();
  const replaceCustomerContact = async (before: Record<string, unknown>) => {
    try {
      const removed = await removeFormerCustomerContacts(id, {
        accountId: (before["account_id"] as string | null) ?? null,
        customerName: (before["customer_name"] as string | null) ?? null,
      });
      if (removed > 0)
        toast.success(
          `Contacts: the previous customer was replaced${removed > 1 ? ` (${removed} people)` : ""}`,
        );
    } catch (e) {
      toastDbError(e, { action: "Replacing the customer on Contacts" });
    }
    void queryClient.invalidateQueries({ queryKey: ["job-contacts", id] });
    void queryClient.invalidateQueries({ queryKey: ["job-contacts-origin", id] });
  };

  const reload = async () => {
    loadGearCount();

    if (shownJobId.current !== id) setLoading(true);
    const { data: j, error: jErr } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (jErr || !j) {
      shownJobId.current = null;
      setLoadError(jErr ?? null);
      setJob(null);
      setLoading(false);
      return;
    }
    setLoadError(null);
    setJob(j as Job);
    shownJobId.current = id;
    const srcId = (j as Job).reported_source_id;
    if (srcId) {
      const { data: src } = await supabase
        .from("reported_sources")
        .select("label")
        .eq("id", srcId)
        .maybeSingle();
      setSourceLabel(src?.label ?? null);
    } else {
      setSourceLabel(null);
    }
    const [asRes, nRes, hRes] = await Promise.all([
      supabase.from("job_assignments").select("id, user_id, role").eq("job_id", id),
      supabase
        .from("job_notes")
        .select("id, author_id, body, created_at")
        .eq("job_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("job_status_history")
        .select("id, from_status, to_status, changed_at")
        .eq("job_id", id)
        .order("changed_at", { ascending: false }),
    ]);
    const userIds = (asRes.data ?? []).map((a) => a.user_id);
    const profs: Record<string, string> = {};
    if (userIds.length) {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", userIds);
      for (const p of data ?? []) profs[p.user_id] = p.full_name || p.user_id.slice(0, 8);
    }
    setAssignments(
      (asRes.data ?? []).map((a) => ({
        ...a,
        name: profs[a.user_id] ?? a.user_id.slice(0, 8),
      })),
    );
    setNotes((nRes.data ?? []) as Note[]);
    setHistory((hRes.data ?? []) as History[]);
    setLoading(false);
  };

  const syncScopeTasks = async () => {
    if (app.userId) {
      try {
        await syncAutomaticJobTasksForJob(id, app.userId);
      } catch (error) {
        toastDbError(error, { action: "Synchronizing the job's scope tasks" });
      }
    }
    await reload();
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /*
   * The right rail sticks below the header strip, not below the viewport top.
   *
   * Both are sticky inside the same scroll container (<main> in the app shell,
   * which carries overflow-auto), so a rail pinned at top-2 slides underneath
   * the header — which is z-30 and opaque — and looks like it scrolled away. A
   * hard-coded offset would be wrong the moment the badge row wraps onto a
   * second line or the title runs long, so the height is measured.
   */
  const headerRef = useRef<HTMLDivElement | null>(null);
  const tabStripRef = useRef<HTMLDivElement | null>(null);
  const tabPinRef = useRef<HTMLDivElement | null>(null);
  const [headerH, setHeaderH] = useState(0);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    // Measure what actually sticks. Below md the header box is
    // display:contents (no box, height 0) and only the tab row pins, so the
    // offset the Billing tab scrolls an invoice to is the row's height.
    const read = () => {
      const row = tabPinRef.current;
      const pinned = row && getComputedStyle(el).display === "contents" ? row : el;
      setHeaderH(pinned.getBoundingClientRect().height);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    if (tabPinRef.current) ro.observe(tabPinRef.current);
    return () => ro.disconnect();
  }, [loading]);

  /*
   * The Billing tab's ledger strip is pinned under the header too (Mark,
   * 2026-10-06: "have this sticky as well on the billing page"), so on that
   * tab what sticks is the header plus the strip. The rail and the editors'
   * scroll target clear both, or they slide under the strip the way the rail
   * once slid under the header.
   */
  const ledgerPinRef = useRef<HTMLDivElement | null>(null);
  const [ledgerH, setLedgerH] = useState(0);
  useEffect(() => {
    const el = ledgerPinRef.current;
    if (!el) return;
    const read = () => setLedgerH(el.getBoundingClientRect().height);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading, tab]);

  /*
   * Twelve tabs do not fit on a phone, so the strip scrolls. Landing on a tab
   * that is off-screen to the right leaves the page looking like it opened on
   * the wrong one, so the active trigger is scrolled into view.
   */
  useEffect(() => {
    const wrapper = tabStripRef.current;
    const active = wrapper?.querySelector<HTMLElement>('[data-state="active"]');
    if (!wrapper || !active) return;
    // Which element scrolls depends on the width. Below md the TabsList
    // itself is the scroller (`max-md:w-full overflow-x-auto` in ui/tabs.tsx
    // beats the `w-max` below), so scrolling only the wrapper did nothing on
    // exactly the screens the strip overflows — a remembered Drying log tab
    // opened with General highlighted in view and Drying log off to the right.
    const list = wrapper.querySelector<HTMLElement>('[role="tablist"]');
    const strip = list && list.scrollWidth > list.clientWidth ? list : wrapper;
    const s = strip.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    // Centre where there is room; assigning scrollLeft clamps at both ends.
    strip.scrollLeft += a.left - s.left - (s.width - a.width) / 2;
  }, [tab, loading]);

  /*
   * Fade whichever edge of the strip has tabs past it. Scroll events do not
   * bubble, so the listener captures on the wrapper and hears whichever of
   * the two possible scrollers moved — the list below md, the wrapper above.
   */
  const allTabs = jobTabOrder(app.primary);
  const tabOrder = allTabs.filter((t) => !JOB_TABS_IN_MORE.includes(t));
  const moreTabs = allTabs.filter((t) => JOB_TABS_IN_MORE.includes(t));
  const [tabFade, setTabFade] = useState({ start: false, end: false });
  useEffect(() => {
    const wrapper = tabStripRef.current;
    if (!wrapper) return;
    const update = () => {
      const list = wrapper.querySelector<HTMLElement>('[role="tablist"]');
      const strip = list && list.scrollWidth > list.clientWidth ? list : wrapper;
      const next = stripFade(strip);
      setTabFade((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    wrapper.addEventListener("scroll", update, { capture: true, passive: true });
    // The triggers too: a webfont landing or the Pictures count appearing
    // widens the strip without resizing the box it scrolls in.
    const ro = new ResizeObserver(update);
    ro.observe(wrapper);
    wrapper.querySelectorAll('[role="tab"]').forEach((t) => ro.observe(t));
    return () => {
      wrapper.removeEventListener("scroll", update, { capture: true });
      ro.disconnect();
    };
  }, [loading]);

  if (loading) return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;
  if (!job) {
    return (
      <div className="mx-auto max-w-2xl">
        <RecordLoadError
          error={loadError}
          record="job"
          table="jobs"
          id={id}
          onRetry={() => void reload()}
        />
      </div>
    );
  }

  const loc = app.allLocations.find((l) => l.id === job.location_id);
  const mapUrl = googleMapsSearchUrl(job.address) ?? undefined;

  /*
   * The one place a stage change is written, so the header badge cannot slip
   * past the guard the old Update button enforced.
   */
  const applyStage = async (next: string) => {
    if (!next || next === job.stage_id) return;
    // Closing a job with equipment still assigned to it is exactly how 20 units
    // go missing off one site. Warn loudly and make the manager confirm.
    if (isClosedStage(stageById.get(next)) && gearOut > 0 && !confirmClose) {
      setConfirmClose(true);
      toast.error(
        `${gearOut} item${gearOut === 1 ? "" : "s"} still assigned to this job. Retrieve them on the Equipment tab, or choose that stage again to close anyway.`,
      );
      return;
    }
    const { error } = await supabase.from("jobs").update({ stage_id: next }).eq("id", job.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Status updated");
    setConfirmClose(false);
    reload();
  };

  const addNote = async () => {
    const body = newNote.trim();
    if (!body || !app.userId) return;
    try {
      // Through the queue: a note typed in a basement used to fail on the
      // insert and be lost with the toast. Held here, it says so and uploads
      // itself, and the timestamp is when it was typed.
      const { queued } = await addJobNote({ jobId: job.id, authorId: app.userId, body });
      setNewNote("");
      if (queued) {
        toast.warning("Held on this phone", {
          description: "The note uploads by itself when you have signal.",
        });
      }
      reload();
    } catch (e) {
      toastDbError(e, { action: "Adding the note" });
    }
  };

  const addAssignment = async () => {
    if (!addUserId.trim()) return;
    const { error } = await supabase
      .from("job_assignments")
      .insert({ job_id: job.id, user_id: addUserId.trim(), role: addRole });
    if (error) return toast.error(error.message);
    setAddUserId("");
    reload();
  };

  const removeAssignment = async (aid: string) => {
    const { error } = await supabase.from("job_assignments").delete().eq("id", aid);
    if (error) return toast.error(error.message);
    reload();
  };

  const changeAssignmentRole = async (aid: string, role: string) => {
    const { error } = await supabase.from("job_assignments").update({ role }).eq("id", aid);
    if (error) return toastDbError(error, { action: "Changing the crew role" });
    reload();
  };

  const editNote = async (nid: string, body: string) => {
    const { error } = await supabase.from("job_notes").update({ body }).eq("id", nid);
    if (error) return toastDbError(error, { action: "Editing the note" });
    reload();
  };

  /*
   * Three buttons on a desktop, one overflow menu on a phone — the header
   * decides which, so the page only says what the actions are. The old "Email"
   * shortcut (a bare mailto to the default contact) is gone: the rail now
   * offers call/text/email per named person, and two differently-behaved email
   * buttons an inch apart was the actual confusion.
   */
  const headerActions: JobHeaderAction[] = [
    ...(canManageJob === true && !app.writesDisabled
      ? [
          {
            key: "dispatch-crew",
            label: "Dispatch crew",
            icon: <Truck className="mr-1 size-3.5" />,
            onSelect: () => setDispatchOpen(true),
            primary: true,
          },
        ]
      : []),
    {
      key: "send-email",
      label: "Send email",
      icon: <Mail className="mr-1 size-3.5" />,
      onSelect: () => setEmailOpen(true),
    },
    /*
     * 3 Nov: no Add contact here — it only switched to the Contacts tab, which
     * is one tap away in the strip below. Directions and Upload receipt live in
     * the ⋯ menu: they leave the page, and the map card has its own link.
     */
    {
      key: "directions",
      label: "Directions",
      icon: <MapPin className="mr-1 size-3.5" />,
      href: mapUrl,
      overflow: true,
    },
    {
      // Something bought for this job is filed against it, in its office, and
      // goes through the same approval as any other receipt.
      key: "upload-receipt",
      label: "Upload receipt",
      icon: <Receipt className="mr-1 size-3.5" />,
      onSelect: () => void navigate({ to: "/receipts", search: { job: job.id } }),
      overflow: true,
    },
  ];

  /*
   * The job's side rail: Reach someone, Amounts, Needs attention. On a
   * desktop it is the aside beside the cards; on a phone (10 Nov, David:
   * "the first thing should probably be customer info, then followed by site
   * info ... amounts don't have to be up on top, and neither does need
   * attention") it renders after Customer, Site and Insurance, each folded.
   */
  const jobRail = (
    <>
      <JobContactShortcuts jobId={job.id} onOpenTab={() => setTab("contacts")} />
      {/*
       * 3 Nov: Estimated / Billed / Collected / Outstanding moved into
       * the stat cards above the tabs (JobMoneyStrip), so they show on
       * every tab and are not listed twice here. What stays is what the
       * cards do not carry: the internal T&M job cost, the way into
       * Billing. A role that sees no figures gets no Amounts card at all.
       */}
      {showMoney ? (
        <PhoneFold title="Amounts">
          <Card>
            <CardHeader className={FOLD_HEADER}>
              <CardTitle className="text-base">Amounts</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              {/* TM7: what the job cost, from the T&M data — cost viewers only. */}
              <TmJobCostRows
                job={job}
                billed={money.data?.billed ?? 0}
                collected={money.data?.collected ?? 0}
              />
              {money.isError ? null : (
                <button
                  type="button"
                  onClick={() => setTab("billing")}
                  className="pt-1 text-left text-[12px] text-primary hover:underline"
                >
                  {money.data?.hasRecords
                    ? "Open Billing"
                    : "No estimates or invoices yet — open Billing"}
                </button>
              )}
            </CardContent>
          </Card>
        </PhoneFold>
      ) : null}
      <JobTasksRail jobId={job.id} onOpenTab={() => setTab("tasks")} />
    </>
  );

  /*
   * The width cap grows with the display. 4xl keeps the General tab's
   * two-column masonry readable on a laptop, but Billing carries a nine-column
   * line-item table that was being crushed into a third of a desktop screen
   * while the rest of the monitor sat empty.
   */
  return (
    <div
      data-job-page
      className="mx-auto max-w-4xl space-y-2 px-2 py-2 sm:space-y-3 sm:px-4 sm:py-4 xl:max-w-6xl 2xl:max-w-[100rem]"
    >
      {/* No back button here. The trail directly above this row already ends in
          this job and starts with a back control to where the user came from —
          which is more often a board or a search than the Jobs list this one
          hardcoded. Two navigation rows, one of them wrong, cost 56px. */}
      <Tabs value={tab} onValueChange={setTab} className="space-y-3">
        {/* The bleed matches the page's own gutter (px-2, sm:px-4). A fixed
            -mx-4 stuck out 8px each side on a phone and the whole job page
            wobbled sideways under a thumb.

            Sticky from md up only. On a phone the title, address, badge row
            and tabs pinned together were about 175px — a third of an iPhone
            SE on every tab, over the drying cards and the ticket a crew is
            actually filling in. Below md the box dissolves (display:contents)
            so the name and address scroll away with the page and only the tab
            strip stays, which is what you need to move between tabs. */}
        <div
          ref={headerRef}
          /*
           * 3 Nov: display:contents at every width, so only the tab row pins —
           * the money cards sit between the header and the tabs (the client
           * wanted them above the tabs), and pinned they would cover a third
           * of a laptop screen on every tab.
           */
          className="contents"
        >
          <JobRenameDialog
            open={renameOpen}
            onOpenChange={setRenameOpen}
            jobId={job.id}
            current={job.job_name}
            fallback={jobDisplayName({ customer_name: job.customer_name, address: job.address })}
            onSaved={() => void reload()}
          />
          <JobHeader
            sticky={false}
            jobNumber={job.job_number}
            jobName={jobDisplayName(job) ?? ""}
            address={[job.address, job.locality, job.region, job.postal_code]
              .filter(Boolean)
              .join(", ")}
            primaryContactName={defaultContact?.full_name ?? job.customer_name}
            primaryContactRole={defaultContact?.role ?? null}
            // Not when the title already is the customer (no job name set).
            customerName={
              job.job_name && job.customer_name !== job.job_name ? job.customer_name : null
            }
            siteLine={siteNamesLine(job)}
            onEditAddress={app.writesDisabled ? undefined : () => setAddressEditOpen(true)}
            onEditName={app.writesDisabled ? undefined : () => setRenameOpen(true)}
            actions={headerActions}
            badges={
              <>
                {/*
                 * Every badge here is the job's own value, so every one of them
                 * is a way to change it. The stage writes through applyStage so
                 * a badge cannot close a job that still has equipment on site —
                 * the guard the Update button used to own.
                 */}
                {/*
                 * 3 Nov: each badge is ONE pill — its colour, a small label and
                 * the value — not a coloured chip inside an outlined pill.
                 */}
                <JobBadgeField
                  job={job}
                  fieldKey="stage_id"
                  label="Stage"
                  onCommit={(v) => applyStage(String(v ?? ""))}
                  pillStyle={
                    stageById.get(job.stage_id ?? "")
                      ? stageBadgeStyle(stageById.get(job.stage_id ?? "")?.color)
                      : undefined
                  }
                >
                  {stageById.get(job.stage_id ?? "")?.name ?? "—"}
                </JobBadgeField>
                <JobBadgeField
                  job={job}
                  fieldKey="job_type"
                  label="Job type"
                  onSaved={() => void reload()}
                  pillClassName={paymentTypes.tone(job.job_type)}
                >
                  {job.job_type ? paymentTypes.label(job.job_type) : "Job type"}
                </JobBadgeField>
                {/*
                 * loss_type_id has no JOB_FIELDS entry — the column stores an
                 * option row id while the managed-option machinery is keyed by
                 * option key — so the ids are handed over explicitly.
                 */}
                <JobBadgeField
                  job={job}
                  fieldKey="loss_type_id"
                  label="Loss type"
                  onSaved={() => void syncScopeTasks()}
                  options={lossTypes.options.map((o) => ({ value: o.id, label: o.label }))}
                  pillClassName={lossTypes.badge(job.loss_type_id)}
                >
                  {job.loss_type_id
                    ? lossTypes.label(job.loss_type_id)
                    : ((JOB_LOSS_LABELS as Record<string, string>)[job.loss_type] ??
                      String(job.loss_type ?? "—"))}
                </JobBadgeField>
                <JobBadgeField
                  job={job}
                  fieldKey="location_id"
                  label="Office"
                  onSaved={() => void reload()}
                  options={app.allLocations.map((l) => ({
                    value: l.id,
                    label: `${l.code} · ${l.name}`,
                  }))}
                >
                  {loc?.code ?? "Office"}
                </JobBadgeField>
                <UndeterminedJobTypeChip jobType={job.job_type} />
                <RentersPolicyChip kind={job.insurance_kind} />
                <ExposureOriginChip jobId={job.id} />
                {/* David, 24 Sep: "and probably on the main job page". */}
                <EquipmentOnSiteChip jobId={job.id} onOpen={() => setTab("equipment")} />
              </>
            }
          />
          {/*
           * Below md this row is the only part of the header that stays put:
           * the header box above is display:contents there, so the row sticks
           * against the whole page instead of inside a 175px block — hence its
           * own bleed, background and rule on a phone. From md up it is a
           * plain row inside the sticky header.
           *
           * The fade lives on the inner scroller, not on this row: a mask hides
           * everything the element paints, background included, so on the
           * pinned row it let the page show through at both ends.
           */}
          <div className="mt-3">
            <JobMoneyStrip
              money={money.data}
              isLoading={money.isLoading}
              isError={money.isError}
              showMoney={showMoney}
              showBilling={showBilling}
              onOpenBilling={() => setTab("billing")}
            />
          </div>
          {/* 3 Nov: the job's notices are about the job, the property and the
              customer — not one tab — so they sit above the tabs too. */}
          <div className="mt-3 empty:hidden">
            <JobNotices
              jobId={job.id}
              accountId={job.account_id ?? null}
              address={job.address}
              locationId={job.location_id}
              importantInstructions={job.important_instructions}
              importantInstructionsUrgent={!!job.important_instructions_urgent}
              rehabbedAfter1978={job.rehabbed_after_1978}
              onInstructionsChange={(v, urgent) =>
                setJob((prev) =>
                  prev
                    ? { ...prev, important_instructions: v, important_instructions_urgent: urgent }
                    : prev,
                )
              }
            />
          </div>
          <div
            ref={tabPinRef}
            className="sticky top-0 z-30 -mx-2 mb-3 border-b bg-background/95 px-2 pt-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-4 sm:px-4"
          >
            <div
              ref={tabStripRef}
              data-fade-start={tabFade.start || undefined}
              data-fade-end={tabFade.end || undefined}
              className="edge-fade @container -mx-1 overflow-x-auto px-1 pb-1"
            >
              {/*
               * 3 Nov redesign: a segmented strip — the tabs sit in one tray and
               * the open one is a raised white button with an icon and, where
               * the page already knows it, a count.
               */}
              <TabsList className="w-max">
                {tabOrder.map((t) => {
                  const Icon = JOB_TAB_ICON[t];
                  /* The database's count, not the loaded rows: the album pages
                     now, so what is loaded is only the first page (#286). */
                  const count =
                    t === "pictures"
                      ? (jobPhotos.tally?.total ?? 0)
                      : t === "tasks"
                        ? openTaskCount
                        : t === "equipment"
                          ? gearOut
                          : 0;
                  return (
                    <TabsTrigger
                      key={t}
                      value={t}
                      className={cn(
                        "h-9 text-sm",
                        /* 5 Nov: all eleven tabs fit a desktop bar without
                           scrolling. Where it is narrower than they need with
                           icons, the icons go and the labels and counts stay;
                           narrower still (a laptop with the sidebar open) the
                           labels step down to 13px with tighter padding. */
                        "md:px-2.5 md:@max-[82rem]:[&>svg:first-child]:hidden",
                        "md:@max-[66rem]:px-2 md:@max-[66rem]:text-[13px]",
                      )}
                    >
                      <Icon aria-hidden />
                      <T>{JOB_TAB_LABEL[t]}</T>
                      {count > 0 && <TabsCount>{count}</TabsCount>}
                    </TabsTrigger>
                  );
                })}
                {moreTabs.length > 0 && (
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger
                      data-state={moreTabs.includes(tab as JobTab) ? "active" : "inactive"}
                      className={cn(TAB_TRIGGER, "h-9 text-sm")}
                      data-job-tab-more
                    >
                      {moreTabs.includes(tab as JobTab) ? (
                        <>
                          {(() => {
                            const Icon = JOB_TAB_ICON[tab as JobTab];
                            return <Icon aria-hidden />;
                          })()}
                          <T>{JOB_TAB_LABEL[tab as JobTab]}</T>
                        </>
                      ) : (
                        <T>More</T>
                      )}
                      <ChevronDown aria-hidden />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {moreTabs.map((t) => {
                        const Icon = JOB_TAB_ICON[t];
                        return (
                          <DropdownMenuItem key={t} onSelect={() => setTab(t)}>
                            <Icon className="mr-2 size-4" aria-hidden />
                            <T>{JOB_TAB_LABEL[t]}</T>
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </TabsList>
            </div>
          </div>
        </div>

        <JobEmailDialog jobId={job.id} open={emailOpen} onOpenChange={setEmailOpen} />
        <JobDispatchDialog
          open={dispatchOpen}
          onOpenChange={setDispatchOpen}
          job={{
            id: job.id,
            jobNumber: job.job_number,
            address: [job.address, job.locality, job.region, job.postal_code]
              .filter(Boolean)
              .join(", "),
            locationId: job.location_id,
          }}
          exclude={assignments.map((assignment) => assignment.user_id)}
          onDispatched={() => void reload()}
        />

        {/* "New info from <sender>": what the customer sent back — by the
            intake link or by replying to the request email — waiting to be
            applied to the fields below, one by one or all at once. */}
        <IntakeSubmissionsReview
          jobId={job.id}
          job={job as unknown as Record<string, unknown>}
          onApplied={() => {
            setContactMethodsVersion((v) => v + 1);
            void reload();
          }}
        />

        <JobComplianceWarning accountId={job.account_id ?? null} />

        <TabsContent value="general" className="space-y-3 [overflow-wrap:anywhere]">
          {/*
           * Money and open work follow you down the page. Both were buried in
           * the card flow, so answering "what is outstanding" or "what is
           * still open" meant scrolling back to the top every time.
           */}
          <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="min-w-0 space-y-3">
              {job.additional_work_pending && (
                <div className="flex flex-wrap gap-2">
                  <div className="flex-1 rounded-sm border bg-muted/40 p-3 text-sm">
                    <div className="font-semibold">Additional work pending</div>
                    Scope beyond the approved estimate is outstanding.
                  </div>
                </div>
              )}

              {/*
               * Masonry, not a grid: a short card stops where its content ends
               * instead of stretching to its tallest sibling. Nothing spans the
               * full width - a lone full-bleed card leaves the rest of a desktop
               * screen empty and pushes everything else below the fold.
               */}
              {/*
               * David, 23 Oct (his mock-up): Customer Info and Site Info side
               * by side, the Insurance card under both, then the rest. The
               * Intake card's details (questionnaire, dates reported) are part
               * of Site Info now — fewer sections, nothing repeated.
               *
               * David, 23 Oct (voice note): the two top boxes the same size,
               * Site Info cut at the referral; under Insurance, Referral on
               * the left and Scope of work by room on the right.
               */}
              <div
                className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2 lg:items-stretch"
                data-general-top
              >
                {/* 6 Nov (David): on a phone every section folds and opens on
                    a tap; Customer Info, the first one, starts open. Desktop
                    is unchanged (phone-fold.tsx). */}
                <PhoneFold
                  title="Customer Info"
                  defaultOpen
                  className="h-full"
                  actions={
                    <SectionEditToggle
                      editing={editCustomer}
                      onToggle={() => setEditCustomer((v) => !v)}
                      disabled={app.writesDisabled}
                    />
                  }
                >
                  <Card className="h-full">
                    <CardHeader
                      className={cn(
                        "flex flex-row items-center justify-between gap-2 space-y-0 pb-3",
                        FOLD_HEADER,
                      )}
                    >
                      <CardTitle className="text-base">Customer Info</CardTitle>
                      <SectionEditToggle
                        editing={editCustomer}
                        onToggle={() => setEditCustomer((v) => !v)}
                        disabled={app.writesDisabled}
                      />
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <SectionEdit editing={editCustomer}>
                        {/*
                         * The CRM-backed pair. customer_name is a typed string kept for
                         * documents and merge tokens; these two are the real records, so
                         * the second job for this customer finds them instead of
                         * re-typing a name that only nearly matches.
                         *
                         * 3 Nov: no separate Individual/Company row — Account shows the
                         * typed name until an account is picked, and picking one writes
                         * its name back into customer_name.
                         */}
                        <JobField
                          job={job}
                          fieldKey="account_id"
                          label="Company"
                          emptyText={job.customer_name}
                          onSaved={() => void reload()}
                          onWritten={(_next, before) => replaceCustomerContact(before)}
                        />
                        <JobField
                          job={job}
                          fieldKey="primary_contact_id"
                          label="Main point of contact"
                          onSaved={() => void reload()}
                        />
                        {/* 3 Nov mock-up: the phones and emails under a rule. */}
                        <div className="border-t pt-3">
                          <JobContactMethodsPanel
                            jobId={job.id}
                            contactId={job.primary_contact_id}
                            disabled={app.writesDisabled}
                            version={contactMethodsVersion}
                          />
                        </div>
                        <JobSectionNotes jobId={job.id} sectionKey="customer" showLabel />
                        <JobSectionNotes jobId={job.id} sectionKey="property" showLabel />
                      </SectionEdit>
                    </CardContent>
                  </Card>
                </PhoneFold>
                <PhoneFold title="Site Info" className="h-full">
                  <JobPropertyCard
                    job={job}
                    onSaved={() => void reload()}
                    editOpen={addressEditOpen}
                    onEditOpenChange={setAddressEditOpen}
                    headerExtra={
                      <SectionEditToggle
                        editing={editIntake}
                        onToggle={() => setEditIntake((v) => !v)}
                        disabled={app.writesDisabled}
                      />
                    }
                    siteEditing={editIntake}
                    siteExtra={
                      /* David, 27 Oct: date of loss up with the address block. */
                      <SectionEdit editing={editIntake}>
                        <JobField
                          job={job}
                          label="Date of loss"
                          fieldKey="loss_date"
                          onSaved={() => void reload()}
                        />
                      </SectionEdit>
                    }
                  >
                    <SectionEdit editing={editIntake}>
                      {/*
                       * David, 27 Oct: the questionnaire reads as straight content
                       * of Site Info — no box around it — and Date reported / Time
                       * reported are not shown here (they stay on the job record).
                       */}
                      <JobQuestionnaireView
                        jobId={job.id}
                        reportedSourceLabel={sourceLabel}
                        userId={app.userId}
                        disabled={app.writesDisabled}
                      />
                      {responseChain.length > 0 && (
                        <p className="pt-2 text-xs text-muted-foreground">
                          {responseChain.join(" · ")}
                        </p>
                      )}
                      {job.initial_loss_description && (
                        <p className="whitespace-pre-wrap pt-2 text-muted-foreground">
                          {job.initial_loss_description}
                        </p>
                      )}
                      <JobSectionNotes jobId={job.id} sectionKey="job_loss" showLabel />
                    </SectionEdit>
                  </JobPropertyCard>
                </PhoneFold>
              </div>

              {/* 12 Nov: on a phone the photos come up here, above Insurance and
                  the public adjuster, where they are seen; desktop keeps them at
                  the bottom of General (below). */}
              <div className="md:hidden" data-phone-photo-strip>
                <JobPhotoStrip
                  album={jobPhotos}
                  job={job}
                  onSaved={jobPhotos.reload}
                  onOpenTab={() => setTab("pictures")}
                />
              </div>

              {showInsuranceCard && (
                <PhoneFold
                  title="Insurance"
                  actions={
                    <SectionEditToggle
                      editing={editInsurance}
                      onToggle={() => setEditInsurance((v) => !v)}
                      disabled={app.writesDisabled}
                    />
                  }
                >
                  <Card className="@container">
                    <CardHeader
                      className={cn(
                        "flex flex-row items-center justify-between gap-2 space-y-0 pb-3",
                        FOLD_HEADER,
                      )}
                    >
                      <CardTitle className="text-base">Insurance</CardTitle>
                      <SectionEditToggle
                        editing={editInsurance}
                        onToggle={() => setEditInsurance((v) => !v)}
                        disabled={app.writesDisabled}
                      />
                    </CardHeader>
                    <CardContent className="space-y-4 text-sm">
                      {starred ? (
                        <p
                          data-insurance-required
                          className={
                            insuranceMissing.length
                              ? "rounded-md bg-warning/10 px-3 py-2 text-xs text-warning"
                              : "text-xs text-muted-foreground"
                          }
                        >
                          {insuranceMissing.length
                            ? `* Needed to bill this claim. Still missing: ${insuranceMissing.join(", ")}. An office task stays open until all five are filled in.`
                            : "* Every critical insurance detail is on the job."}
                        </p>
                      ) : null}
                      <SectionEdit editing={editInsurance}>
                        {/*
                          David, 23 Oct: two halves. Left — the claim and the
                          carrier's people; right — who acts for the insured
                          (public adjuster, agency) and the notes.
                        */}
                        {/* 13 Nov: on a phone the two halves are tabs inside
                            Insurance, instead of the public adjuster folded at
                            the bottom. Desktop shows both halves, unchanged. */}
                        <Tabs
                          value={insuranceTab}
                          onValueChange={(v) => setInsuranceTab(v as typeof insuranceTab)}
                          className="mb-4 md:hidden"
                        >
                          <TabsList className="flex w-full" aria-label="Insurance sections">
                            <TabsTrigger
                              value="carrier"
                              className="flex-1"
                              data-insurance-tab="carrier"
                            >
                              Carrier &amp; claim
                            </TabsTrigger>
                            <TabsTrigger
                              value="public_adjuster"
                              className="flex-1"
                              data-insurance-tab="public_adjuster"
                            >
                              Public adjuster &amp; agency
                            </TabsTrigger>
                          </TabsList>
                        </Tabs>
                        <div className="grid grid-cols-1 gap-x-8 gap-y-5 @[48rem]:grid-cols-2">
                          <div
                            className={cn(
                              "min-w-0 space-y-4",
                              insuranceTab !== "carrier" && "max-md:hidden",
                            )}
                          >
                            {/* The claim itself — what everything else hangs off. */}
                            <div className="grid grid-cols-1 gap-x-6 gap-y-1 @[30rem]:grid-cols-2">
                              {/*
                               * Carrier account is the CRM record and drives the adjuster
                               * lookups below; insurance_carrier is the typed string kept
                               * for documents and merge tokens.
                               */}
                              <JobField
                                job={job}
                                label={star("Carrier")}
                                fieldKey="insurance_carrier_account_id"
                                onSaved={() => void reload()}
                              />
                              {!job.insurance_carrier_account_id && (
                                <JobField
                                  job={job}
                                  label={star("Carrier (typed)")}
                                  fieldKey="insurance_carrier"
                                  onSaved={() => void reload()}
                                />
                              )}
                              <JobField
                                job={job}
                                label={star("Policy #")}
                                fieldKey="policy_number"
                                onSaved={() => void reload()}
                              />
                              <JobField
                                job={job}
                                label={star("Claim #")}
                                fieldKey="claim_number"
                                onSaved={() => void reload()}
                              />
                              {/* 6 Nov (David): "policy type — this is not
                                working": it was a read-only line. Now the
                                same inline field as the rest of the card,
                                with its detail (the list's requires_detail). */}
                              <div className="flex items-center gap-2">
                                <div className="min-w-0 flex-1">
                                  <JobField
                                    job={job}
                                    label="Policy type"
                                    fieldKey="insurance_kind"
                                    onSaved={() => void reload()}
                                  />
                                </div>
                                <RentersPolicyChip kind={job.insurance_kind} />
                              </div>
                              {(job.insurance_kind_detail ||
                                insuranceKinds.options.find((o) => o.key === job.insurance_kind)
                                  ?.requires_detail) && (
                                <JobField
                                  job={job}
                                  label="Policy type detail"
                                  fieldKey="insurance_kind_detail"
                                  onSaved={() => void reload()}
                                />
                              )}
                              <JobField
                                job={job}
                                label="Deductible"
                                fieldKey="deductible"
                                onSaved={() => void reload()}
                              />
                            </div>

                            {/* Who to call. One column per party. */}
                            {/* Two per row at every size — three squeezed the longer
                    group headings onto two lines. */}
                            <div className="grid grid-cols-1 gap-x-6 gap-y-5 border-t pt-4 @[30rem]:grid-cols-2">
                              <PartyGroup title={star("Carrier adjuster")}>
                                <JobPartyFields
                                  job={job}
                                  slot="carrier_adjuster"
                                  onSaved={() => void reload()}
                                />
                              </PartyGroup>

                              <PartyGroup title="Desk adjuster">
                                {/* 28 Oct: "Contact can come out, we have name right
                                  under." Shown only for an old job whose
                                  adjuster is a linked contact with no name typed. */}
                                {legacyOnly(
                                  job.desk_adjuster_contact_id,
                                  job.desk_adjuster_name,
                                ) && (
                                  <JobField
                                    job={job}
                                    label="Contact"
                                    fieldKey="desk_adjuster_contact_id"
                                    onSaved={() => void reload()}
                                  />
                                )}
                                <JobPartyFields
                                  job={job}
                                  slot="desk_adjuster"
                                  onSaved={() => void reload()}
                                />
                              </PartyGroup>

                              <PartyGroup title="Field adjuster">
                                {/* 28 Oct: "Contact can come out, we have name right
                                  under." Shown only for an old job whose
                                  adjuster is a linked contact with no name typed. */}
                                {legacyOnly(
                                  job.field_adjuster_contact_id,
                                  job.field_adjuster_name,
                                ) && (
                                  <JobField
                                    job={job}
                                    label="Contact"
                                    fieldKey="field_adjuster_contact_id"
                                    onSaved={() => void reload()}
                                  />
                                )}
                                <JobPartyFields
                                  job={job}
                                  slot="field_adjuster"
                                  onSaved={() => void reload()}
                                />
                              </PartyGroup>

                              <PartyGroup title="Independent / third-party reviewer">
                                <JobField
                                  job={job}
                                  label="Firm"
                                  fieldKey="independent_reviewer_account_id"
                                  onSaved={() => void reload()}
                                />
                                {/* The typed copies (David: repetitive) only while
                                they hold something the pickers do not. */}
                                {legacyOnly(
                                  job.independent_reviewer_firm,
                                  job.independent_reviewer_account_id,
                                ) && (
                                  <JobField
                                    job={job}
                                    label="Firm (typed)"
                                    fieldKey="independent_reviewer_firm"
                                    onSaved={() => void reload()}
                                  />
                                )}
                                {/* An old job linked to a reviewer with no name
                                  copied onto it still shows who it was. */}
                                {legacyOnly(
                                  job.independent_reviewer_contact_id,
                                  job.independent_reviewer_name,
                                ) && (
                                  <JobField
                                    job={job}
                                    label="Contact"
                                    fieldKey="independent_reviewer_contact_id"
                                    onSaved={() => void reload()}
                                  />
                                )}
                                <JobPartyFields
                                  job={job}
                                  slot="independent_reviewer"
                                  onSaved={() => void reload()}
                                />
                              </PartyGroup>
                            </div>
                          </div>

                          {/* 28 Oct: a line down the middle splits the two halves. */}
                          <div
                            className="min-w-0 space-y-4 @[48rem]:border-l @[48rem]:pl-8"
                            data-insurance-right
                          >
                            {/* 6 Nov (David): "public adjuster should be a
                              separate box on the phone" — 13 Nov: its own tab
                              there now (above), rather than a fold. */}
                            <div
                              className={cn(
                                "min-w-0",
                                insuranceTab !== "public_adjuster" && "max-md:hidden",
                              )}
                              data-insurance-pa
                            >
                              <div className="grid grid-cols-1 gap-x-6 gap-y-5 @[30rem]:grid-cols-2">
                                <PartyGroup title={star("Public adjuster (for the insured)")}>
                                  <JobField
                                    job={job}
                                    label="Firm"
                                    fieldKey="public_adjuster_account_id"
                                    onSaved={() => void reload()}
                                  />
                                  {legacyOnly(
                                    job.public_adjuster_contact_id,
                                    job.public_adjuster_name,
                                  ) && (
                                    <JobField
                                      job={job}
                                      label="Contact"
                                      fieldKey="public_adjuster_contact_id"
                                      onSaved={() => void reload()}
                                    />
                                  )}
                                  <JobPartyFields
                                    job={job}
                                    slot="public_adjuster"
                                    onSaved={() => void reload()}
                                  />
                                </PartyGroup>

                                <PartyGroup title="Insurance agency &amp; agent">
                                  <JobField
                                    job={job}
                                    label="Agency"
                                    fieldKey="insurance_agency_account_id"
                                    onSaved={() => void reload()}
                                  />
                                  {legacyOnly(
                                    job.insurance_agency,
                                    job.insurance_agency_account_id,
                                  ) && (
                                    <JobField
                                      job={job}
                                      label="Agency (typed)"
                                      fieldKey="insurance_agency"
                                      onSaved={() => void reload()}
                                    />
                                  )}
                                  <JobPartyFields
                                    job={job}
                                    slot="insurance_agent"
                                    onSaved={() => void reload()}
                                  />
                                </PartyGroup>
                              </div>
                            </div>

                            <div className="space-y-3 border-t pt-4">
                              <JobSectionNotes jobId={job.id} sectionKey="insurance" showLabel />
                              <JobSectionNotes
                                jobId={job.id}
                                sectionKey="public_adjuster"
                                showLabel
                              />
                            </div>
                          </div>
                        </div>
                      </SectionEdit>
                    </CardContent>
                  </Card>
                </PhoneFold>
              )}

              {/* Phone only: the rail right after Insurance (see jobRail). */}
              <div className="space-y-3 md:hidden">{jobRail}</div>

              {/* Stretched (3 Nov): a short Scope card next to an open Referral
                  search left a page-height hole beside it. */}
              <div
                className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2 lg:items-stretch"
                data-general-referral-row
              >
                <PhoneFold
                  title="Referral"
                  className="h-full"
                  actions={
                    <SectionEditToggle
                      editing={editReferral}
                      onToggle={() => setEditReferral((v) => !v)}
                      disabled={app.writesDisabled}
                    />
                  }
                >
                  <Card className="h-full">
                    <CardHeader
                      className={cn(
                        "flex flex-row items-center justify-between gap-2 space-y-0 pb-3",
                        FOLD_HEADER,
                      )}
                    >
                      <CardTitle className="text-base">Referral</CardTitle>
                      <SectionEditToggle
                        editing={editReferral}
                        onToggle={() => setEditReferral((v) => !v)}
                        disabled={app.writesDisabled}
                      />
                    </CardHeader>
                    <CardContent className="space-y-3 text-sm">
                      <SectionEdit editing={editReferral}>
                        <JobReferralPanel
                          jobId={job.id}
                          accountId={job.referred_by_account_id}
                          contactId={job.referred_by_contact_id}
                          referredByName={job.referred_by_name}
                          disabled={app.writesDisabled}
                          onSaved={() => void reload()}
                        />
                        <JobSectionNotes jobId={job.id} sectionKey="referral" showLabel />
                      </SectionEdit>
                    </CardContent>
                  </Card>
                </PhoneFold>
                {/* The rooms' scope, on the job's front page too, so the office
                    and the crew on site read one scope (David, 12 Oct), with
                    Translate on it (23 Oct). An older single scope text still
                    shows in it. */}
                <PhoneFold title="Scope of work by room" className="h-full">
                  <ScopeOfWorkCard job={job} legacyScope={job.scope} className="h-full" />
                </PhoneFold>
              </div>

              <Masonry columns={2}>
                {insuranceJob ? null : (
                  <PhoneFold
                    title="Payment"
                    actions={
                      <SectionEditToggle
                        editing={editPayment}
                        onToggle={() => setEditPayment((v) => !v)}
                        disabled={app.writesDisabled}
                      />
                    }
                  >
                    <Card>
                      <CardHeader
                        className={cn(
                          "flex flex-row items-start justify-between gap-2 space-y-0 pb-3",
                          FOLD_HEADER,
                        )}
                      >
                        <div className="min-w-0 space-y-1.5">
                          <CardTitle className="text-base">Payment</CardTitle>
                          <p className="text-xs text-muted-foreground">
                            Cash work — billed to the customer, no carrier approval step.
                          </p>
                        </div>
                        <SectionEditToggle
                          editing={editPayment}
                          onToggle={() => setEditPayment((v) => !v)}
                          disabled={app.writesDisabled}
                        />
                      </CardHeader>
                      <CardContent className="space-y-1 text-sm">
                        <SectionEdit editing={editPayment}>
                          <JobField
                            job={job}
                            label="Payer"
                            fieldKey="cash_payer_name"
                            onSaved={() => void reload()}
                          />
                          <JobField
                            job={job}
                            label="Terms"
                            fieldKey="payment_terms"
                            onSaved={() => void reload()}
                          />
                          {showMoney && (
                            <>
                              <JobField
                                job={job}
                                label="Agreed price"
                                fieldKey="agreed_price"
                                onSaved={() => void reload()}
                              />
                              <JobField
                                job={job}
                                label="Deposit taken"
                                fieldKey="deposit_amount"
                                onSaved={() => void reload()}
                              />
                              <Field
                                label="Balance due"
                                value={
                                  job.agreed_price != null
                                    ? fmtMoney(job.agreed_price - (job.deposit_amount ?? 0))
                                    : null
                                }
                              />
                            </>
                          )}
                        </SectionEdit>
                      </CardContent>
                    </Card>
                  </PhoneFold>
                )}

                <PhoneFold
                  title="Assignees"
                  actions={
                    <SectionEditToggle
                      editing={editAssignees}
                      onToggle={() => setEditAssignees((v) => !v)}
                      disabled={app.writesDisabled}
                    />
                  }
                >
                  <Card>
                    <CardHeader
                      className={cn(
                        "flex flex-row items-center justify-between gap-2 space-y-0 pb-3",
                        FOLD_HEADER,
                      )}
                    >
                      <CardTitle className="text-base">Assignees</CardTitle>
                      <SectionEditToggle
                        editing={editAssignees}
                        onToggle={() => setEditAssignees((v) => !v)}
                        disabled={app.writesDisabled}
                      />
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {assignments.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No one assigned.</div>
                      ) : (
                        <ul className="space-y-1 text-sm">
                          {assignments.map((a) => (
                            <li
                              key={a.id}
                              className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5"
                            >
                              <span className="min-w-0 flex-1">
                                {a.name}{" "}
                                {/* The role is the only field on this row; who the
                            person is changes on the Schedule tab, which also
                            carries their on-site dates. */}
                                {editAssignees && !app.writesDisabled ? (
                                  <RowSelect
                                    value={a.role}
                                    options={JOB_ROLE_OPTS}
                                    className="ml-2 w-[170px]"
                                    onSave={(v) => changeAssignmentRole(a.id, v)}
                                  />
                                ) : (
                                  <Badge variant="outline" className="ml-2">
                                    {JOB_ASSIGNMENT_ROLE_LABELS[a.role as JobAssignmentRole] ??
                                      a.role}
                                  </Badge>
                                )}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={app.writesDisabled}
                                onClick={() => removeAssignment(a.id)}
                              >
                                Remove
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <div className="flex flex-wrap items-end gap-2">
                        <div className="min-w-[220px] flex-1">
                          <Label className="text-xs">Person</Label>
                          <PersonPicker
                            value={addUserId || null}
                            onChange={(id) => setAddUserId(id ?? "")}
                            locationId={job.location_id}
                            exclude={assignments.map((a) => a.user_id)}
                            placeholder="Search crew…"
                          />
                        </div>
                        <Select
                          value={addRole}
                          onValueChange={(v) => setAddRole(v as JobAssignmentRole)}
                        >
                          <SelectTrigger className="w-[170px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <ManagedOptionItems
                              listKey="job_assignment_role"
                              fallback={JOB_ROLE_OPTS}
                            />
                          </SelectContent>
                        </Select>
                        <Button size="sm" onClick={addAssignment} disabled={!addUserId}>
                          Add
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                </PhoneFold>

                <PhoneFold
                  title="Notes"
                  actions={
                    <SectionEditToggle
                      editing={editNotes}
                      onToggle={() => setEditNotes((v) => !v)}
                      disabled={app.writesDisabled}
                    />
                  }
                >
                  <Card>
                    <CardHeader
                      className={cn(
                        "flex flex-row items-center justify-between gap-2 space-y-0 pb-3",
                        FOLD_HEADER,
                      )}
                    >
                      <CardTitle className="text-base">Notes</CardTitle>
                      <SectionEditToggle
                        editing={editNotes}
                        onToggle={() => setEditNotes((v) => !v)}
                        disabled={app.writesDisabled}
                      />
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex gap-2">
                        <Textarea
                          value={newNote}
                          onChange={(e) => setNewNote(e.target.value)}
                          rows={2}
                          placeholder="Add a note…"
                        />
                        <Button onClick={addNote} disabled={!newNote.trim()}>
                          Save
                        </Button>
                      </div>
                      {notes.length === 0 ? (
                        <div className="text-sm text-muted-foreground">No notes yet.</div>
                      ) : (
                        <ul className="space-y-2">
                          {notes.map((n) => (
                            <li key={n.id} className="rounded border p-2 text-sm">
                              {editNotes && !app.writesDisabled ? (
                                /*
                                 * Uncontrolled and saved on blur, like every other
                                 * inline edit on this page. A blanked note is a
                                 * deletion by accident, so an empty box is ignored —
                                 * Remove is not this control's job.
                                 */
                                <Textarea
                                  defaultValue={n.body}
                                  rows={3}
                                  onBlur={(e) => {
                                    const next = e.target.value.trim();
                                    if (next && next !== n.body) void editNote(n.id, next);
                                  }}
                                />
                              ) : (
                                <div className="whitespace-pre-wrap">{n.body}</div>
                              )}
                              <div className="mt-1 text-[11px] text-muted-foreground">
                                {new Date(n.created_at).toLocaleString("en-US")}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                </PhoneFold>
              </Masonry>
            </div>

            {/*
             * Desktop and tablet only. On a phone the same cards render after
             * Insurance instead (jobRail, 10 Nov). Before that the rail came first on a phone: below `xl` this is one column, so
             * the rail used to land under every card on the page — the money and
             * the overdue work, the two things checked most, were the last things
             * you could reach. `order-1` only bites while the grid is single
             * column; from `md` up the source order (cards, then rail) stands.
             *
             * The sticky offset clears the pinned header strip above it, measured
             * rather than guessed because the badge row wraps. Without it the rail
             * pinned at 8px and slid under an opaque z-30 header, which is what
             * "the rail is not sticky" actually looked like.
             */}
            <aside
              className="min-w-0 space-y-3 max-md:hidden xl:sticky xl:max-h-[calc(100svh_-_var(--job-header-h))] xl:overflow-y-auto"
              style={{
                ["--job-header-h" as string]: `${Math.round(headerH) + 16}px`,
                top: "var(--job-header-h)",
              }}
            >
              {jobRail}
            </aside>
          </div>

          {/*
           * Work order, Assignees and Notes stood one per row across the full
           * width, each holding a few lines of content. Masonry so a short card
           * stops where its content ends rather than stretching to its tallest
           * neighbour.
           */}

          {/* 6 Nov evening (David, ops): the photo gallery is back at the
              bottom of General, as it was — the newest photos at a glance,
              "View all" opens the Pictures tab. Full width: a strip squeezed
              into a masonry column was too small to recognise a room in. */}
          <div className="max-md:hidden">
            <JobPhotoStrip
              album={jobPhotos}
              job={job}
              onSaved={jobPhotos.reload}
              onOpenTab={() => setTab("pictures")}
            />
          </div>

          {/* J3, 5 Nov (round 2): the Timeline is a section of General, folded
              by default so General stays short. */}
          <JobSection
            section="timeline"
            defaultCollapsed
            revealAt={revealAt("timeline")}
            contentClassName="space-y-3"
          >
            <JobTimelineTab jobId={job.id} />
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Status history</CardTitle>
              </CardHeader>
              <CardContent>
                {history.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No history.</div>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {history.map((h) => (
                      <li key={h.id} className="flex items-center justify-between border-b py-1.5">
                        <span>
                          {h.from_status
                            ? `${JOB_STATUS_LABELS[h.from_status as JobStatus] ?? h.from_status} → `
                            : ""}
                          {JOB_STATUS_LABELS[h.to_status as JobStatus] ?? h.to_status}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {new Date(h.changed_at).toLocaleString("en-US")}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </JobSection>
        </TabsContent>

        <TabsContent value="contacts" className="space-y-3">
          {/* M3, 5 Nov: Contacts | Communications. */}
          <JobInnerTabs
            value={innerTab("contacts")}
            onValueChange={(v) => setInnerTab("contacts", v)}
            tabs={[
              {
                key: "contacts",
                content: (
                  <JobTabCard tab="contacts">
                    <JobContactsTab jobId={job.id} />
                  </JobTabCard>
                ),
              },
              {
                key: "communications",
                content: (
                  <JobTabCard tab="communications">
                    <JobCommunicationsTab jobId={job.id} accountId={job.account_id ?? null} />
                  </JobTabCard>
                ),
              },
              {
                /* 6 Nov: what the customer is shown sits with the customer's people. */
                key: "portal",
                content: <JobPortalPanel jobId={job.id} />,
              },
            ]}
          />
        </TabsContent>

        <TabsContent value="billing" className="space-y-3">
          {/*
           * The job ledger across the top of the money view. David, 22 Sep:
           * "on this job we're three days, 18 guys, 500 hours, costing us
           * XYZ." It reads the ledger's own rows and shows money only to who
           * may see costs. It is the whole ledger: the card that listed the
           * same rows in the rail is gone (Mark, 2026-10-07: "remove the job
           * ledger box at the right side").
           *
           * Pinned. Mark, 2026-10-06: "have this sticky as well on the
           * billing page" — as well as the header and tab strip above it,
           * which already stay put. It sticks inside <main>, the scroller, so
           * its `top` is the measured height of whatever is pinned above it:
           * the whole header from md up, only the tab row below md (#282).
           * Measured, not hard-coded, for the reason the rail's offset is: the
           * header grows when its badges wrap. z-20 keeps it under the header
           * (z-30) and over the cards; the background is opaque enough that
           * nothing reads through it. `empty:hidden` because the strip renders
           * nothing until the ledger has loaded, and an empty pinned bar
           * would be a stripe of padding over the page.
           */}
          <div
            ref={ledgerPinRef}
            className="sticky z-20 -mx-2 bg-background/95 px-2 py-1 backdrop-blur empty:hidden supports-[backdrop-filter]:bg-background/80 sm:-mx-4 sm:px-4"
            style={{ top: Math.round(headerH) }}
          >
            <JobLedgerStrip jobId={job.id} showMoney={showMoney} showBilling={showBilling} />
          </div>
          {/*
           * Same shape as General: the work in the wide column, the facts in
           * a rail on the right. Bill-to used to run the full width of the tab
           * as the first card, which made "who pays" look like the tab's
           * subject and pushed the estimates a screen down. It is one address
           * block; it lives in the rail.
           *
           * Below `xl` the grid is one column in David's phone order (15 Oct,
           * see below) — the money first, Commission last. The nine-column
           * line-item table keeps the whole width.
           */}
          {/* One rail, not two: the open estimate's or invoice's own cards are
              portalled into the aside below rather than sitting in a second
              20rem strip of their own. See components/billing-rail.tsx. */}
          <BillingRailProvider>
            {(slots) => (
              <div
                className="grid items-start gap-3"
                /* On the grid, not the aside: the money column uses it too, as
                   the scroll margin that keeps an estimate opened from the
                   rail from landing under the pinned header. On this tab the
                   pinned ledger strip is part of what is pinned. */
                style={{
                  ["--job-header-h" as string]: `${Math.round(headerH + ledgerH) + 16}px`,
                }}
              >
                {/*
                 * The two columns get their own grid from `xl` up, so the
                 * sticky rail is confined to them and cannot ride down over a
                 * full-width row placed after this wrapper (the Expense tracker
                 * sat there 20–21 Oct; it is now in the money column). Below
                 * `xl` this wrapper is `contents` like the columns inside it,
                 * so every card is still a row of the outer grid and the phone
                 * order holds.
                 */}
                <div className="contents xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-3">
                  {/*
                   * David, 15 Oct: on a phone the money runs Estimates →
                   * Invoices → Payments, the job's other items follow, then the
                   * Expense tracker, and Commission sits at the bottom. Below
                   * `xl` both columns are `contents`, so every card is a row of
                   * the one grid and `billingOrderClass` (lib/job-billing-order)
                   * sets the phone order; from `xl` up the two columns are back
                   * and the classes do nothing.
                   */}
                  <div className="contents min-w-0 xl:block xl:space-y-3">
                    <div className={billingOrderClass("billing")}>
                      {showMoney ? (
                        <JobBillingPanel
                          jobId={job.id}
                          jobType={job.job_type}
                          onJobTypeResolved={(k) => setJob((j) => (j ? { ...j, job_type: k } : j))}
                          jobLocationId={job.location_id}
                          jobAccountId={job.account_id ?? null}
                          carrier={job.insurance_carrier}
                          claimNumber={job.claim_number}
                          adjusterName={job.adjuster_name}
                          adjusterEmail={job.adjuster_email}
                          calculatorSeed={job}
                        />
                      ) : (
                        <MoneyEventsCard jobId={job.id} />
                      )}
                    </div>
                    {/*
                     * Where Cost by work component was. Client, 21 Oct: it
                     * repeated the running cost and the job ledger, so it is
                     * hidden and the Expense tracker takes its place — money
                     * column, under Estimates, Invoices and Payments. Only the
                     * card is gone: the cost lines and referral costs typed on
                     * it stay in the running cost (job_running_cost reads the
                     * tables, not the card). To bring it back, render
                     *   <div className={billingOrderClass("cost_breakdown")}>
                     *     <JobCostBreakdown jobId={job.id} />
                     *   </div>
                     * here (import from @/components/job-cost-breakdown) and
                     * put "cost_breakdown" back in JOB_BILLING_SECTIONS.
                     *
                     * The tracker: David, 13 Oct — contractors, supplies and
                     * equipment on a large job, with receipts, switched on per
                     * job; named the Expense tracker on 15 Oct. Switched off
                     * it is only its switch. On a phone it keeps its place
                     * above Commission (billingOrderClass).
                     */}
                    {showMoney && (
                      <div className={billingOrderClass("expenses")}>
                        <LargeLossExpensesCard job={job} />
                      </div>
                    )}
                  </div>

                  <aside
                    className="contents xl:sticky xl:block xl:max-h-[calc(100svh_-_var(--job-header-h))] xl:space-y-3 xl:overflow-y-auto"
                    style={{ top: "var(--job-header-h)" }}
                  >
                    {/*
                     * No Estimates card here any more. Mark, 2026-09-16: "and
                     * the estimates is a duplicate, just have the sidebar" put
                     * the one estimates list in this rail. David, 22 Sep, walking
                     * a job: "estimates should be here on the left side, and
                     * invoices on the right side... and then we have to have
                     * payments also, payments underneath it." The client's ask
                     * superseded the rail placement: the same single list now
                     * sits on the left of the money column, invoices beside it,
                     * payments underneath — see JobBillingPanel. The rail keeps
                     * what belongs to the job rather than to one document.
                     */}
                    {showMoney && (
                      <div className={billingOrderClass("running_cost")}>
                        <JobRunningCostWidgets jobId={job.id} />
                      </div>
                    )}
                    <div className={billingOrderClass("bill_to")}>
                      <JobBillToCard
                        job={job}
                        compact
                        canEdit={!app.writesDisabled}
                        onSaved={() => void reload()}
                        onBillingLocationChanged={(loc) =>
                          setJob((j) => (j ? { ...j, billing_location_id: loc } : j))
                        }
                      />
                    </div>
                    {/*
                    Where the Job ledger card was. Mark, 2026-10-07: "remove
                    the job ledger box at the right side" — its rows are the
                    pinned strip above — and the same day: "we want to replace
                    the ledger to be replaced with a card called commissions".
                    The Commissions card keeps the stop-gap's source, rate and
                    paid status, and adds the General tab's referrer, their
                    deal, and the salesmen. Last, on a phone and in the rail
                    (David, 15 Oct).
                  */}
                    {showMoney && (
                      <div className={billingOrderClass("commission")}>
                        <JobCommissionsCard jobId={job.id} />
                      </div>
                    )}
                    {/* Where an open estimate or invoice puts its own cards. Empty,
                  and so invisible, whenever nothing is expanded. */}
                    <div
                      ref={slots.rail}
                      className={`space-y-3 ${billingOrderClass("open_document")}`}
                    />
                  </aside>
                </div>
              </div>
            )}
          </BillingRailProvider>
          {/* J3, 5 Nov (round 2): labor hours and rates sit with the billing. */}
          {/* Not a cost viewer: no Timecard section at all, not a notice. */}
          {showMoney && (
            <JobSection section="timecard" revealAt={revealAt("timecard")}>
              <JobLabourPanel jobId={job.id} />
            </JobSection>
          )}
        </TabsContent>

        <TabsContent value="documents" className="space-y-3">
          {/*
           * David, 21 Oct: nine contracts in ten are emailed, so emailing the
           * service agreement is the primary action here and signing on the
           * iPad at the property is the second. The signing flow itself is
           * unchanged — same dialog the contract page and Documents use.
           */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-sm border p-3">
            <div className="text-sm">
              <div className="font-medium">Contract — service agreement</div>
              <div className="text-muted-foreground">
                Email it to the customer to sign, or sign it on an iPad at the property (works
                offline).
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                asChild
                className="order-2 sm:order-1"
                title="Sign the agreement on a tablet at the property"
              >
                <Link to="/contract/$jobId" params={{ jobId: job.id }}>
                  Sign on site
                </Link>
              </Button>
              <Button
                className="order-1 sm:order-2"
                disabled={app.writesDisabled}
                onClick={() => setContractEmailOpen(true)}
                data-contract-email
              >
                <Mail className="mr-1.5 size-4" aria-hidden />
                Email contract to sign
              </Button>
            </div>
            <DocumentSendDialog
              open={contractEmailOpen}
              onOpenChange={setContractEmailOpen}
              jobId={job.id}
              accountId={job.account_id ?? null}
              locationId={job.location_id}
              onSent={() => undefined}
              presetDocTypes={["service_agreement", "contract"]}
            />
          </div>
          {/*
           * David, 22 Sep: "reports should be like a half a window and then
           * documents the second half... Documents on the left side, AI reports
           * on the right side... for me to scroll down to documents at the
           * bottom of the page always could be a little obnoxious." Documents
           * used to sit under the whole report panel. Below `lg` the halves
           * stack, Documents first, since that is what he was scrolling for.
           */}
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <section aria-label="Documents" className="min-w-0">
              <DocumentsPanel
                jobId={job.id}
                accountId={job.account_id ?? null}
                locationId={job.location_id}
                address={job.address}
                jobNumber={job.job_number}
                lossType={job.loss_type}
                focusDocument={focus.doc}
                tmJob={isTmJob(job.job_type)}
                fieldTicketJob={fieldForms.ticket === "full"}
              />
            </section>
            <section aria-label="AI reports" className="min-w-0">
              <JobReportPanel
                jobId={job.id}
                focusReport={focus.report}
                jobNumber={job.job_number}
                address={job.address}
                locationId={job.location_id}
                accountId={job.account_id ?? null}
                lossType={job.loss_type}
              />
            </section>
          </div>
        </TabsContent>

        <TabsContent value="schedule" className="space-y-3">
          <JobScheduleShare jobId={job.id} />
          <JobGantt jobId={job.id} />
          <JobTabCard tab="schedule">
            <JobScheduleTab jobId={job.id} />
          </JobTabCard>
        </TabsContent>

        {/* 6 Nov: Tasks is a tab of its own again (it was an inner tab of
            Schedule from 5 Nov). David: "tasks could be up here" — the General
            tab's Needs attention list only shows what is due today, tomorrow
            or overdue, so the full list has to be one tap away. */}
        <TabsContent value="tasks" className="space-y-3">
          <JobTabCard tab="tasks">
            <JobTasksTab
              jobId={job.id}
              focusTask={focus.task}
              locationId={job.location_id}
              accountId={job.account_id ?? null}
              jobTypeKey={job.loss_type}
              additionalWorkPending={!!job.additional_work_pending}
              onJobChanged={() => void reload()}
            />
          </JobTabCard>
        </TabsContent>

        {/*
         * 6 Nov evening (David): the notices at the top of the job showed a
         * second time here (account note, property note, on-site warning).
         * They are on every tab already, above the strip, so Rooms no longer
         * repeats them. Pictures is its own tab again (below).
         */}
        <TabsContent value="rooms" className="space-y-3">
          <JobRoomsTab
            job={job}
            projectId={projectId}
            onAlbumCreated={() => void projectQ.refetch()}
            photoCountByFolder={jobPhotos.tally?.byFolder ?? null}
            onPhotosLanded={() => void jobPhotos.reload()}
            /* 5 Nov: the room sketches sit above Takeoffs (FE12). */
            beforeTakeoffs={<RoomSketchesPanel job={job} />}
          />
          {/* FE11: the write-up sheet — completed work, room by room. */}
          <JobWriteUpsPanel jobId={job.id} />
        </TabsContent>

        {/* 6 Nov evening (David, ops): "Pictures should be on the top bar —
            don't hide or consolidate it under any other option." */}
        <TabsContent value="pictures" className="space-y-3">
          <JobPhotos
            job={{
              id: job.id,
              job_number: job.job_number,
              address: job.address,
              job_name: job.job_name,
              customer_name: job.customer_name,
              account_id: job.account_id,
              location_id: job.location_id,
              loss_type_id: job.loss_type_id,
            }}
            album={jobPhotos}
            focusPhoto={focus.photo}
          />
          {projectId && (
            <Button size="sm" variant="outline" asChild>
              <Link to="/projects/$id" params={{ id: projectId }}>
                Open album for folders, annotations &amp; share links
              </Link>
            </Button>
          )}
        </TabsContent>

        <TabsContent value="drying">
          <JobTabCard tab="drying">
            <JobDryingLog
              jobId={job.id}
              jobNumber={job.job_number}
              address={[job.address, job.locality, job.region, job.postal_code]
                .filter(Boolean)
                .join(", ")}
              album={{ job, projectId, onAlbumCreated: refetchAlbum }}
            />
          </JobTabCard>
        </TabsContent>

        {/* 6 Nov: Equipment is a tab on the strip again (5 Nov had folded it
            into Drying log, then General). David: "Equipment should be up here
            on top" — the crew places, scans and retrieves gear all day. */}
        <TabsContent value="equipment" className="space-y-3">
          <JobEquipmentPanel
            jobId={job.id}
            jobLocationId={job.location_id}
            jobStatus={job.status}
            onChanged={() => void syncScopeTasks()}
          />
        </TabsContent>

        <TabsContent value="ticket" className="space-y-3">
          {/* Mark: "available under field form, only when T&M is selected, and
              the new ticket currently there should be for insurance and cash
              jobs." What each job type gets is decided in
              src/lib/field-forms-visibility.ts. */}
          {/* FE10: the job type picks the material list — T&M jobs the three
              daily sheets with the detailed rate sheet, every other job a
              daily supply list of the condensed ten (job-supply-list.ts). */}
          {/* 6 Nov (David, on a self-pay job that used to be T&M): the daily
              supply list "should be hidden when the job is a different one".
              Only a T&M job shows the daily sheets; every other job keeps the
              field work ticket alone. */}
          {fieldForms.tmForms && (
            <TmFieldFormsPanel
              job={job}
              crew={assignments.map((a) => ({ userId: a.user_id, name: a.name, role: a.role }))}
              supplyList={supplyListKind(job.job_type)}
            />
          )}
          <FieldWorkTicketPanel
            jobId={job.id}
            locationId={job.location_id}
            jobAddress={job.address}
            unitNumber={job.address_line2}
            readOnly={fieldForms.ticket === "history"}
            /* A ticket can raise additional_work_pending through the database,
               so the job has to be re-read or the banner above lags a refresh —
               and that flag is what seeds the Water · Remediation checklist, so
               reconcile the tasks first (syncScopeTasks reloads after). */
            onSaved={() => void syncScopeTasks()}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** One party on the claim — heading plus its contact rows. */
function PartyGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="mb-1.5 border-b pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {children}
    </div>
  );
}

/** Read-only twin of JobField. Same grid, or the two misalign side by side. */
function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="grid grid-cols-[minmax(5rem,9rem)_minmax(0,1fr)] items-start gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0">{value ?? "—"}</span>
    </div>
  );
}
