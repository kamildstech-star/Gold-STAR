import { AccountFollowupToggle } from "@/components/invoice-followup-panel";
import { RelationshipRollup } from "@/components/relationship-rollup";
import { HideablePage, HideableSection, HiddenSectionsBar } from "@/lib/hidden-sections";
import { RecordLoadError } from "@/components/record-load-error";
import { CompanyHierarchyMini } from "@/components/company-hierarchy-mini";
import { AccountSnapshot, accountSnapshotKey } from "@/components/account-snapshot";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, FileText, LayoutDashboard, MoreHorizontal, Undo2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { QuickComposer, type ComposerRequest } from "@/components/quick-composer";
import { focusDestination } from "@/lib/focus-destination";
import { AccountStandingNoteBanner } from "@/components/standing-notes";
import { ClientHealthLine } from "@/components/account-prospect/client-health-line";
import { ProspectRecordHeader } from "@/components/account-prospect/prospect-record-header";
import { ProspectStageLine } from "@/components/account-prospect/prospect-stage-line";
import { primaryContact } from "@/components/account-prospect/prospect-view-helpers";
import { useProspectStage } from "@/components/account-prospect/use-prospect-view";
import { ProspectSuggestionCard } from "@/components/account-prospect/prospect-suggestion-card";
import { ClientRecordCards } from "@/components/account-prospect/client-record-cards";
import { PolarisAccountPanel } from "@/components/account-prospect/polaris-account-panel";
import { AccountContactBoxes } from "@/components/account-record/account-contact-boxes";
import { AccountMeetings } from "@/components/account-record/account-meetings";
import { AccountTaskDialog } from "@/components/account-record/account-task-dialog";
import { AccountTaskList } from "@/components/account-record/account-task-list";
import { ContactDrawer } from "@/components/contact-drawer";
import { isOpenTask, useAccountTasks, useRefreshAccountActivity } from "@/lib/account-tasks";
import { useMyPermissions } from "@/lib/permissions";

import {
  Plus,
  Phone,
  Mail,
  Copy,
  ShieldAlert,
  Gift,
  Calendar,
  Globe,
  MapPin,
  User,
  Tag,
  Briefcase,
  Paperclip,
  CheckSquare,
  Clock,
  Pencil,
  ListChecks,
  Network,
  ShieldCheck,
  Users,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useLossTypes } from "@/lib/loss-categories";
import { resolveContactLocationId } from "@/lib/contacts";
import { type RelationshipFields } from "@/components/contact-relationship";
import { ContactRelationshipNotes } from "@/components/contact-relationship-notes";
import { toastDbError } from "@/lib/db-errors";
import { isMissingSchema } from "@/lib/schema-fallback";
import { StageAutoAdvanceBanner } from "@/components/stage-auto-advance-banner";
import { GhostCountdownBanner } from "@/components/ghost-countdown-banner";
import { AccountCompliance } from "@/components/account-compliance";
import { AccountHouseChip } from "@/components/account-header-chips";

import { DealTimeline } from "@/components/deal-timeline";
import { DocumentsPanel } from "@/components/documents-panel";
import { AccountProposalsSection } from "@/components/account-proposals/account-proposals-section";
import { CompanyContactsCard, DocumentsInvoicesCard } from "@/components/account-right-rail";
import { CompanyHierarchyPanel } from "@/components/company-hierarchy-panel";
import { CONTACT_POSITION_OPTIONS } from "@/lib/company-hierarchy";
import { LabelPicker } from "@/components/label-picker";
import { LabelPills } from "@/components/label-pill";
import { fetchLabelMap } from "@/lib/labels";
import { DrawerField, DrawerSection } from "@/components/detail-drawer";
import { useSectionCollapse } from "@/components/master-detail";
import type { Touchpoint as TimelineTouchpoint } from "@/lib/timeline";
import {
  AccountEmailAction,
  LogTouchDialog,
  MoveBackToPipelineDialog,
} from "@/components/account-actions";
import { useAccountClientHealth } from "@/components/client-health-badge";
import { CriticalEpisodeNote } from "@/components/critical-clients-card";
import { accountClocks } from "@/lib/account-clocks";
import { isActiveClient, useReversionRights } from "@/lib/pipeline-reversion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import {
  CONTACT_DECISION_ROLES,
  CONTACT_ROLE_LABEL,
  GIFT_POLICIES,
  GIFT_POLICY_LABEL,
  GIFT_POLICY_LABEL as _GIFT_POLICY_LABEL,
  cadenceHealth,
  daysSinceTs,
  HEALTH_LABEL,
  nextInPersonDueLabel,
  type AccountStatus,
  type AccountType,
  type ContactDecisionRole,
  type GiftPolicy,
} from "@/lib/accounts";
import { fetchGiftPolicies, setGiftPolicyTag } from "@/lib/gift-policy";
import { useAccountFunctionLabels } from "@/components/account-function-picker";
import { AccountProfileEditor } from "@/components/account-profile-editor";
import { AccountDrawer } from "@/components/account-drawer";
import { AccountLeadSourceRow } from "@/components/lead-source-field";
import { assertWritesEnabled } from "@/lib/write-guard";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";
import { Tabs, TabsContent, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";

const CONTACT_ROLE_OPTS = optionsFrom(CONTACT_DECISION_ROLES, CONTACT_ROLE_LABEL);

const CARD_TITLE = "text-[14px] font-semibold normal-case tracking-normal text-foreground";

type Account = {
  id: string;
  name: string;
  account_type: AccountType;
  status: AccountStatus;
  location_id: string;
  /** Worked from more than one office — see account_locations for which. */
  is_multi_location?: boolean;
  assigned_rep: string | null;
  what_they_do: string[];
  notes: string | null;
  parent_account_id: string | null;
  updated_at: string;
  pipeline_id: string | null;
  stage_id: string | null;
  /** Legacy stage key — still the fallback when `stage_id` is unset. */
  stage: string | null;
  stage_changed_at: string | null;
  health_pipeline_id: string | null;
  health_stage_id: string | null;
  health_changed_at: string | null;
  created_at: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  address_line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  estimated_annual_value: number | null;
  lead_source_id: string | null;
  lead_source_detail: string | null;
  /** The Client 360 score, shown and edited on the prospect layout's cards. */
  satisfaction_score: number | null;
};

type Contact = {
  id: string;
  full_name: string;
  title: string | null;
  decision_role: ContactDecisionRole | null;
  /* Read by the prospect contact card's expander; the query selects *. */
  position_key: string | null;
  email: string | null;
  phone: string | null;
  birthday_month: number | null;
  birthday_day: number | null;
  gift_policy: GiftPolicy;
  gift_policy_notes: string | null;
  is_primary: boolean;
} & RelationshipFields;
type Touchpoint = TimelineTouchpoint;

/**
 * The account page's tabs, in order (Melly, 6 Nov): General first — the
 * sales dashboard — then the detail tabs "if you want to get into the
 * details: tasks, timeline, contacts, meetings, documents", then the ones the
 * record already had.
 */
const ACCOUNT_TABS = [
  { value: "general", label: "General", icon: LayoutDashboard },
  { value: "tasks", label: "Tasks", icon: CheckSquare },
  { value: "timeline", label: "Timeline", icon: Clock },
  { value: "contacts", label: "Contacts", icon: Users },
  { value: "meetings", label: "Meetings", icon: CalendarDays },
  { value: "documents", label: "Documents", icon: FileText },
  { value: "hierarchy", label: "Hierarchy", icon: Network },
  { value: "compliance", label: "Compliance", icon: ShieldCheck },
  { value: "details", label: "Details", icon: ListChecks },
] as const;
type AccountTab = (typeof ACCOUNT_TABS)[number]["value"];
type AccountSearch = { tab?: AccountTab };

/** The composer on General: Files and Documents are the Documents tab's. */
const GENERAL_COMPOSER_TABS = ["activity", "email", "sms", "invoice", "review"] as const;

export const Route = createFileRoute("/_authenticated/accounts/$id")({
  head: () => ({
    meta: [{ title: "Account · Recovery Hub" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  validateSearch: (raw: Record<string, unknown>): AccountSearch => {
    const t = raw.tab;
    return ACCOUNT_TABS.some((x) => x.value === t) ? { tab: t as AccountTab } : {};
  },
  component: AccountDetail,
});

function copy(value: string) {
  navigator.clipboard
    .writeText(value)
    .then(() => toast.success("Copied"))
    .catch(() => toast.error("Copy failed"));
}

/**
 * What the account does — Property Manager, Broker, Public Adjuster and so on.
 * Coloured pills, inline add/remove through the shared label picker.
 */
function AccountTagsRow({ accountId }: { accountId: string }) {
  const labelsQ = useQuery({
    queryKey: ["account-detail-labels", accountId],
    queryFn: () => fetchLabelMap("account", [accountId]),
  });
  const list = labelsQ.data?.[accountId] ?? [];
  return (
    <div className="flex items-start gap-2 px-4 py-1.5">
      <Tag className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="text-[11px] text-muted-foreground">Tags</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <LabelPills labels={list} max={8} />
          <LabelPicker
            scope="account"
            recordId={accountId}
            onSaved={() => labelsQ.refetch()}
            trigger={
              <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]">
                <Plus className="size-3" />
                Tag
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The deal record page — Pipedrive proportions. The stage path runs the full
 * width across the top; the data sits in a narrow left rail; the right-hand
 * three quarters lead with the actions a rep opens the deal to take, and the
 * timeline fills everything beneath them. Act or catch up, neither requires
 * a scroll.
 */
function AccountDetail() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const [userId, setUserId] = useState<string | null>(null);
  const { collapsed, toggle } = useSectionCollapse("deal-page");

  /** Arriving from the compliance badge on the list lands on that section. */
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#compliance") return;
    if (collapsed.compliance) toggle("compliance");
    setTab("compliance");
    const t = window.setTimeout(
      () => document.getElementById("compliance")?.scrollIntoView({ behavior: "smooth" }),
      200,
    );
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const lossTypes = useLossTypes();
  const functionLabel = useAccountFunctionLabels();
  const [filesOpen, setFilesOpen] = useState(false);
  const [accountEditing, setAccountEditing] = useState(false);
  const [moveBackOpen, setMoveBackOpen] = useState(false);
  /**
   * Which tab is open. On the URL (`?tab=tasks`) so a link can land on one and
   * a reload keeps it; General when nothing says otherwise.
   */
  const search = Route.useSearch();
  const routeNavigate = Route.useNavigate();
  const tab: AccountTab = search.tab ?? "general";
  const setTab = (next: AccountTab) =>
    void routeNavigate({
      search: (p: AccountSearch) => ({ ...p, tab: next === "general" ? undefined : next }),
      replace: true,
    });
  /** Open a tab, then scroll to a card on it once it is laid out. */
  const showOnTab = (next: AccountTab, scroll?: () => void) => {
    setTab(next);
    if (scroll) window.setTimeout(scroll, 80);
  };
  const [composerTab, setComposerTab] = useState<{ tab: ComposerRequest; token: number } | null>(
    null,
  );
  /** The task open in the pop-up (log, complete, next). */
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  /** The contact open in the contact drawer — a box on General opens it. */
  const [drawerContactId, setDrawerContactId] = useState<string | null>(null);
  const { allowed: permissions } = useMyPermissions();
  const canUseAssistant = permissions.has("ai.assistant");
  const tasksQ = useAccountTasks(id);
  /** A history filter the Focus banner asked the Timeline card to show. */
  const [timelineFilter, setTimelineFilter] = useState<{ filter: string; token: number } | null>(
    null,
  );
  /** Bumped by Focus's "Add contact"; the contacts card opens its own form. */
  const [newContactRequest, setNewContactRequest] = useState<number | null>(null);
  const actionBarRef = useRef<HTMLDivElement | null>(null);
  const contactsRef = useRef<HTMLDivElement | null>(null);

  /**
   * Focus never acts on its own — it opens the surface the suggestion is
   * about, and `focusDestination` (shared with the prospect layout) decides
   * which. This used to be a private table here that sent `view_tasks` and
   * `add_contact` to composer tabs, which is why "See tasks" opened Add
   * activity and "Add contact" opened Add note.
   */
  /** The composer on General, open on a tab or an activity type, in view. */
  function openComposer(request: ComposerRequest) {
    setComposerTab({ tab: request, token: Date.now() });
    showOnTab("general", () =>
      actionBarRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }),
    );
  }

  function runFocusAction(action: string) {
    const destination = focusDestination(action);
    if (!destination) return;
    if (destination.kind === "composer") {
      openComposer(destination.tab === "activity" ? "meeting" : destination.tab);
      return;
    }
    if (destination.kind === "add_contact") {
      setTab("contacts");
      setNewContactRequest(Date.now());
      return;
    }
    if (destination.kind === "view_contacts") {
      showOnTab("contacts", () =>
        contactsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
      return;
    }
    if (destination.kind === "timeline") {
      // "See tasks" is the Tasks tab now; any other slice is the Timeline's.
      if (destination.filter === "activities") {
        setTab("tasks");
        return;
      }
      setTab("timeline");
      setTimelineFilter({ filter: destination.filter, token: Date.now() });
    }
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  const accountQuery = useQuery({
    queryKey: ["account", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("accounts").select("*").eq("id", id).single();
      if (error) throw error;
      return data as Account;
    },
  });
  // "Move back to pipeline" is a manager-of-this-office call. Anyone else gets
  // no More-actions menu at all rather than a dialog that refuses on save.
  const reversion = useReversionRights(accountQuery.data?.location_id ?? null);

  const locationQuery = useQuery({
    queryKey: ["location", accountQuery.data?.location_id],
    enabled: !!accountQuery.data?.location_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("locations")
        .select("id,code,name,region")
        .eq("id", accountQuery.data!.location_id)
        .maybeSingle();
      return data;
    },
  });

  const app = useAppContext();

  const ownerQuery = useQuery({
    queryKey: ["account-owner", accountQuery.data?.assigned_rep],
    enabled: !!accountQuery.data?.assigned_rep,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id,full_name")
        .eq("user_id", accountQuery.data!.assigned_rep!)
        .maybeSingle();
      return data;
    },
  });

  const contactsQuery = useQuery({
    queryKey: ["contacts", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .eq("account_id", id)
        .order("is_primary", { ascending: false })
        .order("created_at");
      if (error) throw error;
      const rows = data ?? [];
      const policies = await fetchGiftPolicies(rows.map((r) => r.id));
      return rows.map((r) => ({
        ...r,
        gift_policy: policies.get(r.id) ?? "unknown",
      })) as unknown as Contact[];
    },
  });

  const touchpointsQuery = useQuery({
    queryKey: ["touchpoints", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("touchpoints")
        .select("*")
        .eq("account_id", id)
        .order("occurred_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Touchpoint[];
    },
  });

  const jobsQuery = useQuery({
    queryKey: ["account-jobs", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("jobs")
        .select("id,job_number,status")
        .eq("account_id", id)
        .order("created_at", { ascending: false })
        .limit(5);
      if (error) throw error;
      return data ?? [];
    },
  });

  /*
   * One refresh for every write on the page. Melly, 6 Nov: a saved note did
   * not show "until refresh" — this used to leave out the timeline's own
   * feed, so the note was saved and the history did not move. The list lives
   * in `useRefreshAccountActivity` and includes it now.
   */
  const invalidate = useRefreshAccountActivity(id);

  const patch = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      assertWritesEnabled(app.writesDisabled, app.writesDisabledReason);
      const { error } = await supabase
        .from("accounts")
        .update(values as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
    onError: (e) => toastDbError(e, { action: "update this deal" }),
  });

  const cadence = useMemo(() => {
    const list = touchpointsQuery.data ?? [];
    const last = list[0]?.occurred_at ?? null;
    const lastInPerson = list.find((t) => t.type === "meeting_in_person")?.occurred_at ?? null;
    // Only touches that count toward cadence move the health clock — an
    // unanswered outbound email is an attempt, not contact.
    const lastCounted = list.find((t) => t.counts_toward_cadence !== false)?.occurred_at ?? null;
    return { last, lastCounted, lastInPerson, health: cadenceHealth(last, lastInPerson) };
  }, [touchpointsQuery.data]);

  // Shares the Tags row's query key, so the header costs no extra round trip.
  const accountLabelsQ = useQuery({
    queryKey: ["account-detail-labels", id],
    queryFn: () => fetchLabelMap("account", [id]),
  });
  const accountLabelNames = useMemo(
    () => (accountLabelsQ.data?.[id] ?? []).map((l) => l.name),
    [accountLabelsQ.data, id],
  );

  /**
   * Mark: "The type decides whether the follow-up clock runs at all." A
   * homeowner is a one-time job with no future sale to protect, so the header
   * says "No clock" rather than counting silent days at a record that was
   * never going to be called again.
   */
  const clocks = useMemo(
    () =>
      accountClocks({
        account_type: accountQuery.data?.account_type ?? null,
        what_they_do: accountQuery.data?.what_they_do ?? null,
        assigned_rep: accountQuery.data?.assigned_rep ?? null,
      }),
    [
      accountQuery.data?.account_type,
      accountQuery.data?.what_they_do,
      accountQuery.data?.assigned_rep,
    ],
  );

  // One definition of client health, shared with the Active Clients board.
  const clientHealth = useAccountClientHealth({
    lastTouchAt: cadence.lastCounted,
    sinceAt: accountQuery.data?.stage_changed_at ?? accountQuery.data?.created_at ?? null,
    healthStageId: accountQuery.data?.health_stage_id ?? null,
    clocksRun: clocks.relationshipClock,
  });

  /**
   * Where the account stands decides what the one layout shows, never which
   * layout. Melly, 6 Nov: "we're working with like six different layouts ...
   * one page" — no Overview / Full record. A prospect keeps the green stage
   * bar and has no proposals ("you're not gonna need proposals here"); a won
   * client has the health rail in its place, its proposals, and its Client
   * 360 cards. Everything else is the same page.
   */
  const prospect = useProspectStage(
    accountQuery.data?.stage_id ?? null,
    accountQuery.data?.stage ?? null,
  );

  if (accountQuery.isLoading || prospect.loading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading account…</div>;
  }
  if (accountQuery.error || !accountQuery.data) {
    return (
      <RecordLoadError
        error={accountQuery.error}
        record="account"
        table="accounts"
        id={id}
        onRetry={() => accountQuery.refetch()}
      />
    );
  }
  const account = accountQuery.data;
  const loc = locationQuery.data;
  const contacts = contactsQuery.data ?? [];
  const activeClient = isActiveClient(account);
  const isClient = prospect.kind === "client" || activeClient;
  const address =
    [account.address_line1, account.city, account.state].filter(Boolean).join(", ") || account.name;
  const openTaskCount = (tasksQ.data ?? []).filter(isOpenTask).length;
  const drawerContact = contacts.find((c) => c.id === drawerContactId) ?? null;

  const save = (field: string) => async (next: string) => {
    await patch.mutateAsync({ [field]: next || null });
  };

  return (
    <HideablePage pageKey="account-detail">
      <div data-record-surface className="min-h-full bg-muted/50">
        <HiddenSectionsBar className="mx-4 mt-2" />
        <ProspectRecordHeader
          accountId={id}
          name={account.name}
          status={account.status}
          accountType={account.account_type}
          isMultiLocation={account.is_multi_location}
          place={
            [account.city, account.state].filter(Boolean).join(", ") ||
            loc?.name ||
            "Unknown office"
          }
          ownerName={ownerQuery.data?.full_name ?? null}
          contactName={primaryContact(contacts)?.full_name ?? null}
          contactCount={contacts.length}
          onOpenCompany={() => setTab("details")}
          onOpenContact={() => setTab("contacts")}
          onEdit={() => setAccountEditing(true)}
          editDisabled={app.writesDisabled}
          editReason={app.writesDisabledReason ?? null}
          chipsExtra={<AccountHouseChip labels={accountLabelNames} />}
          headerExtra={
            <>
              <AccountFollowupToggle accountId={id} />
              <Button
                variant="outline"
                disabled={app.writesDisabled}
                title={app.writesDisabledReason ?? undefined}
                onClick={() => setAccountEditing(true)}
              >
                <Pencil className="mr-1.5 size-4" />
                <span className="max-sm:sr-only">Edit Account</span>
              </Button>
              {activeClient && reversion.allowed ? (
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="More actions">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setMoveBackOpen(true)}>
                      <Undo2 className="mr-2 size-4" /> Move back to pipeline
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </>
          }
        >
          {prospect.kind === "client" && clientHealth ? (
            <>
              <ClientHealthLine
                accountId={id}
                accountName={account.name}
                verdict={clientHealth}
                onMoved={invalidate}
              />
              <CriticalEpisodeNote accountId={id} />
            </>
          ) : (
            <ProspectStageLine
              accountId={id}
              accountName={account.name}
              accountType={account.account_type}
              whatTheyDo={account.what_they_do}
              pipelineId={account.pipeline_id}
              currentStageId={account.stage_id}
              changedAt={account.stage_changed_at}
              onMoved={invalidate}
            />
          )}
        </ProspectRecordHeader>
        {activeClient && reversion.allowed ? (
          <MoveBackToPipelineDialog
            accountId={id}
            accountName={account.name}
            locationId={account.location_id}
            status={account.status}
            open={moveBackOpen}
            onOpenChange={setMoveBackOpen}
            onMoved={() => {
              invalidate();
              qc.invalidateQueries({ queryKey: ["active-clients"] });
            }}
          />
        ) : null}

        {/* The numbers, then anything the account is shouting about. */}
        <div className="mx-auto max-w-[1600px] space-y-4 px-3 pt-4 sm:space-y-5 sm:px-6 sm:pt-6">
          <AccountSnapshot accountId={id} contactCount={contacts.length} showProposals={isClient} />
          <AccountStandingNoteBanner accountId={id} />
          <StageAutoAdvanceBanner accountId={id} />
          <GhostCountdownBanner accountId={id} accountName={account.name} />
        </div>

        {/*
          Melly, 6 Nov, pointing at a job: "why don't we do the same layout ...
          boxes on top and then ... this big bar", and the first tab "is going
          to be like a dashboard ... general". The job page's own tab bar
          (ui/tabs), pinned while the record scrolls from tablet width up.
          Every panel stays mounted (forceMount) so a half-written note
          survives a look at another tab.
        */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as AccountTab)}>
          <div className="z-30 mt-4 border-y bg-card md:sticky md:top-0">
            <div className="edge-fade mx-auto max-w-[1600px] overflow-x-auto px-2 py-2 sm:px-4">
              <TabsList className="w-max" aria-label="Account sections">
                {ACCOUNT_TABS.map((t) => {
                  const count =
                    t.value === "tasks"
                      ? openTaskCount
                      : t.value === "contacts"
                        ? contacts.length
                        : 0;
                  return (
                    <TabsTrigger key={t.value} value={t.value} className="h-9 text-sm">
                      <t.icon aria-hidden />
                      {t.label}
                      {count > 0 ? <TabsCount>{count}</TabsCount> : null}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </div>
          </div>

          <div className="@container mx-auto max-w-[1600px] p-3 sm:p-6">
            {/* General — the sales dashboard for this account ------------------ */}
            <TabsContent
              value="general"
              forceMount
              className="mt-0 data-[state=inactive]:hidden"
              data-testid="account-general"
            >
              <div className="grid items-start gap-4 sm:gap-5 @min-[900px]:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)]">
                <div className="min-w-0 space-y-4 sm:space-y-5">
                  <ProspectSuggestionCard
                    accountId={id}
                    onAction={(s) => runFocusAction(s.action)}
                    canAction={(s) => focusDestination(s.action) !== null}
                  />

                  <section className="rounded-xl border bg-card p-4" aria-label="Open tasks">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <h2 className="text-[15px] font-semibold">Open tasks</h2>
                      <button
                        type="button"
                        onClick={() => setTab("tasks")}
                        className="text-[12.5px] font-medium text-primary hover:underline"
                      >
                        All tasks
                      </button>
                    </div>
                    <AccountTaskList
                      accountId={id}
                      onOpen={setOpenTaskId}
                      limit={5}
                      onSeeAll={() => setTab("tasks")}
                    />
                  </section>

                  <div ref={actionBarRef}>
                    <QuickComposer
                      accountId={id}
                      accountName={account.name}
                      locationId={account.location_id}
                      address={address}
                      contacts={contacts}
                      userId={userId}
                      defaultStateCode={loc?.region ?? null}
                      requestTab={composerTab}
                      onCreated={invalidate}
                      tabs={GENERAL_COMPOSER_TABS}
                    />
                  </div>

                  <HideableSection sectionKey="timeline" label="Timeline">
                    <DealTimeline
                      accountId={id}
                      userId={userId}
                      pageSize={6}
                      hideAdd
                      onOpenTask={setOpenTaskId}
                      onChanged={invalidate}
                    />
                  </HideableSection>
                </div>

                <aside className="min-w-0 space-y-4 sm:space-y-5">
                  <AccountContactBoxes
                    contacts={contacts}
                    onOpen={setDrawerContactId}
                    onSeeAll={() => setTab("contacts")}
                    onAdd={() => {
                      setTab("contacts");
                      setNewContactRequest(Date.now());
                    }}
                    addDisabled={app.writesDisabled}
                  />
                  {prospect.kind === "client" ? (
                    <ClientRecordCards
                      accountId={id}
                      locationId={account.location_id}
                      assignedRep={account.assigned_rep ?? null}
                      satisfaction={account.satisfaction_score ?? null}
                      onChanged={invalidate}
                    />
                  ) : null}
                  {canUseAssistant ? (
                    <PolarisAccountPanel accountId={id} accountName={account.name} />
                  ) : null}
                </aside>
              </div>
            </TabsContent>

            {/* Tasks — every task on the account, each opens the pop-up ---------- */}
            <TabsContent
              value="tasks"
              forceMount
              className="mt-0 max-w-3xl data-[state=inactive]:hidden"
            >
              <section className="rounded-xl border bg-card p-4">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-[15px] font-semibold">Tasks</h2>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={() => openComposer("activity")}
                    disabled={app.writesDisabled}
                  >
                    <Plus className="mr-1 size-3.5" /> Schedule an activity
                  </Button>
                </div>
                <AccountTaskList accountId={id} onOpen={setOpenTaskId} showDone />
              </section>
            </TabsContent>

            {/* Timeline — the whole history -------------------------------------- */}
            <TabsContent value="timeline" forceMount className="mt-0 data-[state=inactive]:hidden">
              <DealTimeline
                accountId={id}
                userId={userId}
                requestFilter={timelineFilter}
                hideAdd
                onOpenTask={setOpenTaskId}
                onChanged={invalidate}
              />
            </TabsContent>

            {/* Contacts — the company's people, and the chart they sit in ------ */}
            <TabsContent value="contacts" forceMount className="mt-0 data-[state=inactive]:hidden">
              <div className="grid items-start gap-4 sm:gap-5 @min-[900px]:grid-cols-[minmax(0,1fr)_minmax(19rem,26rem)]">
                <HideableSection sectionKey="contacts" label="Contacts">
                  <div ref={contactsRef} id="contacts">
                    <CompanyContactsCard
                      accountId={id}
                      contacts={contacts}
                      action={
                        <NewContactDialog
                          accountId={id}
                          userId={userId}
                          openRequest={newContactRequest}
                          onCreated={invalidate}
                        />
                      }
                    />
                  </div>
                </HideableSection>

                <HideableSection sectionKey="company-hierarchy" label="Company hierarchy">
                  <CompanyHierarchyMini accountId={id} onOpenChart={() => setTab("hierarchy")} />
                </HideableSection>
              </div>
            </TabsContent>

            {/* Meetings — booked, then held -------------------------------------- */}
            <TabsContent value="meetings" forceMount className="mt-0 data-[state=inactive]:hidden">
              <AccountMeetings
                accountId={id}
                touches={touchpointsQuery.data ?? []}
                contactName={(cid) => contacts.find((c) => c.id === cid)?.full_name ?? null}
                onOpenTask={setOpenTaskId}
              />
            </TabsContent>

            {/* Documents — the paperwork, invoices and (clients) proposals ------- */}
            <TabsContent value="documents" forceMount className="mt-0 data-[state=inactive]:hidden">
              <div className="grid items-start gap-4 sm:gap-5 @min-[900px]:grid-cols-[minmax(0,1fr)_minmax(19rem,24rem)]">
                <div className="min-w-0 rounded-xl border bg-card p-4">
                  <DocumentsPanel
                    accountId={id}
                    locationId={account.location_id}
                    address={address}
                    allowAuthorization={false}
                  />
                </div>
                <aside className="min-w-0 space-y-4 sm:space-y-5">
                  <HideableSection sectionKey="documents" label="Documents & invoices">
                    <DocumentsInvoicesCard accountId={id} onOpenFiles={() => setFilesOpen(true)} />
                  </HideableSection>
                  {isClient ? (
                    <HideableSection sectionKey="proposals" label="Proposals">
                      <AccountProposalsSection
                        accountId={id}
                        accountName={account.name}
                        onChanged={invalidate}
                      />
                    </HideableSection>
                  ) : null}
                </aside>
              </div>
            </TabsContent>

            {/* Hierarchy — the org chart at full width ---------------------------- */}
            <TabsContent value="hierarchy" forceMount className="mt-0 data-[state=inactive]:hidden">
              <CompanyHierarchyPanel accountId={id} accountName={account.name} initialView="tree" />
            </TabsContent>

            {/* Compliance --------------------------------------------------------- */}
            <TabsContent
              value="compliance"
              forceMount
              className="mt-0 max-w-3xl [&_section]:border-b-0 data-[state=inactive]:hidden"
            >
              <HideableSection sectionKey="compliance" label="Compliance & records">
                <div id="compliance" className="rounded-xl border bg-card py-1.5">
                  <DrawerSection
                    title="Compliance & Records"
                    titleClassName={CARD_TITLE}
                    collapsible
                    collapsed={collapsed.compliance}
                    onToggle={() => toggle("compliance")}
                  >
                    <AccountCompliance accountId={id} locationId={account.location_id} />
                  </DrawerSection>
                </div>
              </HideableSection>
            </TabsContent>

            {/* Details — the data ------------------------------------------------ */}
            <TabsContent value="details" forceMount className="mt-0 data-[state=inactive]:hidden">
              <div className="grid items-start gap-4 sm:gap-5 @min-[900px]:grid-cols-2">
                <div className="min-w-0 space-y-4">
                  <div
                    className={cn(
                      "rounded-xl border p-4 text-[13px]",
                      cadence.health === "overdue"
                        ? "border-destructive/30 bg-destructive/8 text-destructive"
                        : cadence.health === "never"
                          ? "border-warning/30 bg-warning/10"
                          : cadence.health === "due_soon"
                            ? "border-warning/30 bg-warning/10"
                            : "border-success/30 bg-success/10 text-success",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex max-w-full whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-bold uppercase tracking-wide",
                        cadence.health === "overdue"
                          ? "bg-destructive text-destructive-foreground"
                          : cadence.health === "never"
                            ? "bg-warning text-warning-foreground"
                            : cadence.health === "due_soon"
                              ? "bg-warning text-warning-foreground"
                              : "bg-success text-success-foreground",
                      )}
                    >
                      {HEALTH_LABEL[cadence.health]}
                    </span>
                    <div className="mt-2 text-[13px] font-medium">
                      {cadence.last
                        ? `Last touch ${daysSinceTs(cadence.last)}d ago`
                        : "No touch ever recorded."}
                      {" · "}
                      {nextInPersonDueLabel(cadence.lastInPerson)}
                    </div>
                  </div>

                  <HideableSection sectionKey="relationship" label="Relationship rollup">
                    <RelationshipRollup accountId={id} className="rounded-xl border bg-card p-4" />
                  </HideableSection>
                </div>
                <div className="min-w-0 space-y-4 [&_section]:border-b-0">
                  <div id="account-details" className="rounded-xl border bg-card py-1.5">
                    <DrawerSection
                      title="Account Details"
                      titleClassName={CARD_TITLE}
                      collapsible
                      collapsed={collapsed.details}
                      onToggle={() => toggle("details")}
                    >
                      <DrawerField
                        icon={User}
                        label="Owner"
                        readOnly
                        display={ownerQuery.data?.full_name ?? "Unassigned"}
                      />
                      <DrawerField
                        icon={Phone}
                        label="Phone"
                        value={account.phone}
                        onSave={save("phone")}
                        type="tel"
                        readOnly={app.writesDisabled}
                      />
                      <DrawerField
                        icon={Mail}
                        label="Email"
                        value={account.email}
                        onSave={save("email")}
                        type="email"
                        readOnly={app.writesDisabled}
                      />
                      <DrawerField
                        icon={Globe}
                        label="Website"
                        value={account.website}
                        onSave={save("website")}
                        readOnly={app.writesDisabled}
                      />
                      <DrawerField
                        icon={MapPin}
                        label="Address"
                        value={account.address_line1}
                        onSave={save("address_line1")}
                        readOnly={app.writesDisabled}
                        display={
                          [account.address_line1, account.city, account.state, account.postal_code]
                            .filter(Boolean)
                            .join(", ") || "—"
                        }
                      />
                      <DrawerField
                        icon={Tag}
                        label="What they do"
                        readOnly
                        display={
                          account.what_they_do.length ? (
                            <span className="flex flex-wrap gap-1">
                              {account.what_they_do.map((t) => (
                                <span
                                  key={t}
                                  className="pill max-w-full truncate"
                                  title={functionLabel(t)}
                                >
                                  {functionLabel(t)}
                                </span>
                              ))}
                            </span>
                          ) : (
                            "—"
                          )
                        }
                      />
                      <AccountLeadSourceRow
                        accountId={id}
                        valueId={account.lead_source_id}
                        detail={account.lead_source_detail}
                        onSaved={() => accountQuery.refetch()}
                        readOnly={app.writesDisabled}
                      />
                      <AccountProfileEditor
                        accountId={id}
                        owningLocationId={account.location_id}
                        isMultiLocation={account.is_multi_location ?? false}
                        whatTheyDo={account.what_they_do}
                        onSaved={() => accountQuery.refetch()}
                        readOnly={app.writesDisabled}
                      />
                      <AccountTagsRow accountId={id} />
                      {/* Corporate-client policy (client item 18): never chase. */}
                      <div className="px-3 pb-2">
                        <AccountFollowupToggle accountId={id} />
                      </div>
                    </DrawerSection>
                  </div>

                  <div className="rounded-xl border bg-card py-1.5">
                    <DrawerSection
                      title="Linked Jobs"
                      titleClassName={CARD_TITLE}
                      collapsible
                      collapsed={collapsed.linked}
                      onToggle={() => toggle("linked")}
                    >
                      <div className="space-y-1 px-4 py-1.5 text-[12px]">
                        {(jobsQuery.data ?? []).length === 0 ? (
                          <span className="text-muted-foreground">
                            No jobs on this account yet.
                          </span>
                        ) : (
                          (jobsQuery.data ?? []).map((j) => (
                            <Link
                              key={j.id}
                              to="/jobs/$id"
                              params={{ id: j.id }}
                              className="flex items-center gap-2 hover:underline"
                            >
                              <Briefcase className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 truncate">{j.job_number}</span>
                              <span className="ml-auto max-w-[55%] shrink-0 truncate text-[11px] text-muted-foreground">
                                {j.status}
                              </span>
                            </Link>
                          ))
                        )}
                      </div>
                    </DrawerSection>
                  </div>
                  {account.notes && (
                    <div className="[&_section]:border-b-0">
                      <div className="rounded-xl border bg-card py-1.5">
                        <DrawerSection
                          titleClassName={CARD_TITLE}
                          title="Notes"
                          collapsible
                          collapsed={collapsed.notes}
                          onToggle={() => toggle("notes")}
                        >
                          <p className="whitespace-pre-wrap break-words px-4 py-1.5 text-[12px] text-muted-foreground">
                            {account.notes}
                          </p>
                        </DrawerSection>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <AccountTaskDialog
          accountId={id}
          taskId={openTaskId}
          userId={userId}
          onOpenChange={(open) => !open && setOpenTaskId(null)}
          onChanged={invalidate}
        />
        <ContactDrawer
          contact={
            drawerContact
              ? { ...drawerContact, account: { id: account.id, name: account.name } }
              : null
          }
          onOpenChange={(open) => !open && setDrawerContactId(null)}
          onChanged={invalidate}
        />
        <Dialog open={filesOpen} onOpenChange={setFilesOpen}>
          <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Files on {account.name}</DialogTitle>
            </DialogHeader>
            <DocumentsPanel
              accountId={id}
              locationId={account.location_id}
              address={
                [account.address_line1, account.city, account.state].filter(Boolean).join(", ") ||
                account.name
              }
              allowAuthorization={false}
            />
          </DialogContent>
        </Dialog>
        <AccountDrawer
          accountId={accountEditing ? account.id : null}
          name={account.name}
          subtitle={
            [account.city, account.state].filter(Boolean).join(", ") || loc?.name || undefined
          }
          onOpenChange={(open) => !open && setAccountEditing(false)}
          onChanged={invalidate}
        />
      </div>
    </HideablePage>
  );
}

/**
 * Email to the account's primary contact. Every send is logged and, because
 * it goes to a known contact, also writes a touchpoint — the cadence engine
 * counts it without anyone logging it by hand.
 */

function NewContactDialog({
  accountId,
  userId,
  openRequest,
  onCreated,
}: {
  accountId: string;
  userId: string | null;
  /** A timestamp from Focus's "Add contact"; each new one opens the form. */
  openRequest?: number | null;
  onCreated: () => void;
}) {
  const writes = useWritesDisabled();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (openRequest != null) setOpen(true);
  }, [openRequest]);
  const [fullName, setFullName] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<ContactDecisionRole | "none">("none");
  const [position, setPosition] = useState("none");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [month, setMonth] = useState("");
  const [day, setDay] = useState("");
  const [officePhone, setOfficePhone] = useState("");
  const [officeExt, setOfficeExt] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [gift, setGift] = useState<GiftPolicy>("unknown");
  const [giftNotes, setGiftNotes] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    assertWritesEnabled(writes.disabled, writes.reason);
    if (!userId || fullName.trim().length < 2) return;
    setSaving(true);
    const base = {
      account_id: accountId,
      location_id: await resolveContactLocationId(accountId),
      full_name: fullName.trim(),
      title: title.trim() || null,
      decision_role: role === "none" ? null : role,
      email: email.trim() || null,
      phone: phone.trim() || null,
      birthday_month: month ? Number(month) : null,
      birthday_day: day ? Number(day) : null,
      gift_policy_notes: giftNotes.trim() || null,
      office_phone: officePhone.trim() || null,
      office_extension: officeExt.trim() || null,
      linkedin_url: linkedin.trim() || null,
      is_decision_maker: role === "decision_maker",
      is_primary: isPrimary,
      created_by: userId,
    };
    // The position column ships ahead of its migration being applied. Adding a
    // contact must not start failing because of a field that is optional
    // anyway — retry without it rather than losing the whole person.
    let { data: inserted, error } = await supabase
      .from("contacts")
      .insert({ ...base, position_key: position === "none" ? null : position })
      .select("id")
      .single();
    if (error && isMissingSchema(error)) {
      ({ data: inserted, error } = await supabase
        .from("contacts")
        .insert(base)
        .select("id")
        .single());
    }
    if (!error && inserted) await setGiftPolicyTag(inserted.id, gift);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Contact added");
    setOpen(false);
    setFullName("");
    setTitle("");
    setRole("none");
    setPosition("none");
    setEmail("");
    setPhone("");
    setMonth("");
    setDay("");
    setOfficePhone("");
    setOfficeExt("");
    setLinkedin("");
    setGift("unknown");
    setGiftNotes("");
    setIsPrimary(false);
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          disabled={writes.disabled}
          title={writes.reason ?? undefined}
        >
          <Plus className="mr-1.5 size-4" />
          Add
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Full name</Label>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="h-11"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} className="h-11" />
            </div>
            <div className="space-y-1.5">
              <Label>Decision role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as ContactDecisionRole | "none")}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  <ManagedOptionItems
                    listKey="contact_decision_role"
                    fallback={CONTACT_ROLE_OPTS}
                  />
                </SelectContent>
              </Select>
            </div>
          </div>
          {/*
            Position, not title. Title is what their card says; this is the box
            they occupy in their own company, and it is what the escalation path
            on a job is ordered by.
          */}
          <div className="space-y-1.5">
            <Label>Position in their company</Label>
            <Select value={position} onValueChange={setPosition}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">—</SelectItem>
                <ManagedOptionItems
                  listKey="contact_position"
                  fallback={CONTACT_POSITION_OPTIONS}
                />
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} className="h-11" />
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Birthday month (1–12)</Label>
              <Input
                inputMode="numeric"
                value={month}
                onChange={(e) => setMonth(e.target.value.replace(/[^\d]/g, ""))}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Birthday day (1–31)</Label>
              <Input
                inputMode="numeric"
                value={day}
                onChange={(e) => setDay(e.target.value.replace(/[^\d]/g, ""))}
                className="h-11"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Office phone</Label>
              <Input
                value={officePhone}
                onChange={(e) => setOfficePhone(e.target.value)}
                className="h-11"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Extension</Label>
              <Input
                value={officeExt}
                onChange={(e) => setOfficeExt(e.target.value)}
                className="h-11"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>LinkedIn</Label>
            <Input
              value={linkedin}
              onChange={(e) => setLinkedin(e.target.value)}
              placeholder="linkedin.com/in/…"
              className="h-11"
            />
          </div>

          <div className="space-y-1.5 rounded-sm border p-3">
            <Label className="flex items-center gap-2">
              <Gift className="size-4" /> Gift & hospitality policy
            </Label>
            <p className="text-xs text-muted-foreground">
              Many property-management companies forbid contacts accepting anything from vendors.
              People have been fired over it. Record what you know — default is"Unknown" so it stays
              visible.
            </p>
            <Select value={gift} onValueChange={(v) => setGift(v as GiftPolicy)}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {GIFT_POLICIES.map((g) => (
                  <SelectItem key={g} value={g}>
                    {GIFT_POLICY_LABEL[g]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Textarea
              value={giftNotes}
              onChange={(e) => setGiftNotes(e.target.value)}
              placeholder="Source of this policy (e.g. contact told me directly, per their vendor code of conduct)"
              rows={2}
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isPrimary} onCheckedChange={(v) => setIsPrimary(v === true)} />
            Primary contact
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={saving || fullName.trim().length < 2 || writes.disabled}
            title={writes.reason ?? undefined}
          >
            {saving ? "Saving…" : "Add contact"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
