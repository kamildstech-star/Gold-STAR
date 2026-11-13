import { useCondenseOnScroll } from "@/lib/use-condense-on-scroll";
import { useMyPermissions, type PermissionKey } from "@/lib/permissions";
import { useMyPageAccess } from "@/lib/use-page-access";
import { FEATURES } from "@/lib/feature-flags";
import {
  HiddenSectionsProvider,
  useHiddenSections,
  sectionLabel,
  registerSectionLabel,
} from "@/lib/hidden-sections";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useAppContext } from "./app-context";
import { LabelLanguageChoice, LanguageToggle, SpanishScreen, useLabelLanguage } from "./bilingual";
import { ImpersonationBanner } from "./impersonation-banner";
import { AssistantHeaderButton, AssistantPanelHost } from "./assistant-panel";
import { DemoDataBanner } from "./demo-data-banner";

import {
  ALL_ROLES,
  isMobileFirstRole,
  isPrivileged,
  PREVIEWABLE_ROLES,
  ROLE_LABELS,
  type AppRole,
} from "@/lib/roles";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  endImpersonationForSignOut,
  rememberReturnPath,
  startImpersonationPreview,
} from "@/lib/impersonation";
import { ViewAsPersonPicker } from "./view-as-person-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { DialerProvider } from "@/components/dialer";
import {
  KanbanSquare,
  BarChart3,
  Gauge,
  CalendarDays,
  CheckSquare,
  Briefcase,
  BriefcaseBusiness,
  Search,
  Building2,
  CalendarClock,
  Camera,
  Clock,
  ChevronsUpDown,
  Eye,
  EyeOff,
  ListChecks,
  LogOut,
  Mail,
  MessageSquare,
  ClipboardList,
  Inbox,
  PackageOpen,
  Phone,
  Radio,
  Shield,
  Calculator,
  Siren,
  Target,
  User,
  Bot,
  Truck,
  Sprout,
  FileSpreadsheet,
  FileText,
  Receipt,
  AlertTriangle,
  ShieldAlert,
  Lightbulb,
  Wallet,
  Zap,
  UsersRound,
  BadgeDollarSign,
  Monitor,
  Moon,
  PanelLeft,
  Sun,
  ChevronDown,
  GripVertical,
  Route,
  Tent,
  Trophy,
  History,
  ShieldCheck,
} from "lucide-react";
import { PALETTES, THEME_LABEL, useTheme, type Theme } from "@/lib/theme";
import { PaletteChoices } from "./theme-picker";

import { supabase } from "@/integrations/supabase/client";
import { pendingQueueCount } from "@/lib/supplies";
import { APPROVER_ROLES } from "@/lib/approval";
import { countUnassignedIntakes } from "@/lib/intake-inbox";
import { SyncBanner, SyncIndicator } from "@/components/offline/sync-banner";
import { toast } from "sonner";
import { AiCreditsChip } from "./ai-credits-chip";
import { GlobalSearchButton } from "./global-search";
import { SidebarNavSearch } from "./sidebar-nav-search";
import { searchableSettingsPages } from "@/lib/admin-settings";
import { IntakeLinkMenu } from "@/components/intake-link-menu";
import { NotificationBell } from "./notifications-panel";
import { BadgeUnlockToaster } from "@/components/leaderboard/badge-unlock-toaster";
import { BrandWatermark } from "./brand-watermark";
import {
  NAV_LABEL_PAGE,
  NavTrail,
  NavTrailInline,
  clearNavTrail,
  pageTitleFromPath,
} from "./nav-trail";
import { SuggestFeatureDialog } from "./feature-request-form";
import { InstallBanner, InstallMenuItem, IosInstallSheetHost } from "./install-prompt";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  PAGE_REVIEW_DOT_CLASS,
  PAGE_REVIEW_LABEL,
  PAGE_REVIEW_TEXT_CLASS,
  nextPageReviewStatus,
  pageKeyForPath,
  usePageReviewSummary,
  usePageReviews,
  useReviewMode,
  useSetPageReview,
  type PageReviewMap,
  type PageReviewStatus,
} from "@/lib/page-reviews";
import {
  EMPTY_ORDER,
  SIDEBAR_ORDER_EVENT,
  applyOrder,
  loadEffectiveSidebarOrder,
  saveSidebarOrder,
  type SidebarOrder,
} from "@/lib/sidebar-order";

type NavItem = {
  to: string;
  label: string;
  icon: React.ElementType;
  roles: AppRole[];
  /** Optional capability gate on top of the role list. */
  permission?: PermissionKey;
};

type NavGroup = { key: string; label: string; items: NavItem[] };

/** Hide-namespace for sidebar links, and where the trail reads route names. */
const SIDEBAR_PAGE = NAV_LABEL_PAGE;

const ALL_MGMT: AppRole[] = [
  "owner",
  "admin",
  "regional",
  "location_manager",
  "office",
  "sales_manager",
];

const PRIVILEGED: AppRole[] = ["owner", "admin", "dev"];

const NAV_GROUPS: NavGroup[] = [
  {
    key: "overview",
    label: "Overview",
    items: [
      {
        to: "/",
        label: "Dashboard",
        icon: BarChart3,
        roles: [...ALL_MGMT, "sales_rep", "field_chaser", "field", "crew"],
      },
    ],
  },
  {
    key: "customers",
    label: "Customers",
    items: [
      {
        to: "/customers",
        label: "Customers",
        icon: Building2,
        roles: [...ALL_MGMT, "sales_rep", "field"],
      },
    ],
  },
  {
    key: "sales",
    label: "Sales",
    items: [
      {
        to: "/pipeline",
        label: "Pipeline",
        icon: KanbanSquare,
        roles: [...ALL_MGMT, "sales_rep"],
      },
      {
        to: "/farming",
        label: "Active Clients",
        icon: Sprout,
        roles: [...ALL_MGMT, "sales_rep"],
      },
      {
        to: "/routes",
        label: "Routes",
        icon: Route,
        roles: [...ALL_MGMT, "sales_rep", "field"],
      },
      {
        to: "/tradeshows",
        label: "Tradeshows",
        icon: Tent,
        roles: [...ALL_MGMT, "sales_rep"],
      },
      {
        to: "/leaderboard",
        label: "Leaderboard",
        icon: Trophy,
        roles: [...ALL_MGMT, "sales_rep"],
      },
      {
        to: "/team-goals",
        label: "Team Goals",
        icon: Target,
        roles: [...ALL_MGMT],
      },
      {
        to: "/sales-director",
        label: "Director Dashboard",
        icon: Gauge,
        roles: [...ALL_MGMT],
        permission: "sales_director.view",
      },
    ],
  },
  {
    key: "chase",
    label: "Chase",
    items: [
      {
        to: "/chase",
        label: "Chase cockpit",
        icon: Siren,
        roles: [
          "owner",
          "admin",
          "dev",
          "regional",
          "location_manager",
          "office",
          "sales_manager",
          "field_chaser",
          "field",
        ],
      },
      {
        to: "/chase/search",
        label: "Chase search",
        icon: Search,
        roles: ["owner", "admin", "dev", "regional", "location_manager", "office", "sales_manager"],
      },
      {
        // Chasers get the guarded, search-only view of their own past leads.
        to: "/chase/past-leads",
        label: "Past leads",
        icon: Search,
        roles: ["field_chaser", "field"],
      },
      {
        to: "/chase/jobs",
        label: "Your jobs",
        icon: Briefcase,
        roles: ["field_chaser", "field"],
      },
      // Dispatch is feature-flagged off (FEATURES.dispatch). Flip the flag to
      // bring this entry and the /chase/dispatch route back.
      ...(FEATURES.dispatch
        ? ([
            {
              to: "/chase/dispatch",
              label: "Dispatch",
              icon: Radio,
              roles: [
                "owner",
                "admin",
                "dev",
                "regional",
                "location_manager",
                "office",
                "sales_manager",
              ],
            },
          ] as NavItem[])
        : []),
      {
        to: "/chase/performance",
        label: "Chase performance",
        icon: BarChart3,
        roles: ["owner", "admin", "dev", "regional", "location_manager", "sales_manager"],
      },
      {
        to: "/chase/my-performance",
        label: "My performance",
        icon: BarChart3,
        roles: ["field_chaser", "field"],
      },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    items: [
      {
        to: "/jobs",
        label: "Jobs",
        icon: Briefcase,
        roles: [...ALL_MGMT, "crew"],
      },
      {
        /*
         * A long-standing complaint: people looking for "new job" landed on
         * the Job Calculator, because pricing a job was the only "new"
         * anything the Operations menu offered. The calculator keeps its own
         * entry two rows down; this one opens the job form itself. Crew are
         * left off deliberately — /jobs/new refuses them anyway.
         */
        to: "/jobs/new",
        label: "New job",
        icon: BriefcaseBusiness,
        roles: [...ALL_MGMT],
      },
      {
        // Directly under Jobs: a completed intake form is a lead with a clock
        // on it, and an inbox nobody passes is the same as no inbox.
        to: "/intake-inbox",
        label: "Intake forms",
        icon: Inbox,
        roles: [...ALL_MGMT],
      },
      {
        to: "/estimates",
        label: "Job Calculator",
        icon: FileSpreadsheet,
        roles: [...ALL_MGMT],
      },
      {
        to: "/projects",
        label: "Pictures",
        icon: Camera,
        roles: [...ALL_MGMT, "crew", "field", "field_chaser"],
      },
      /*
       * No standalone Camera entry. David, 20 Oct: it duplicated what each
       * job's Pictures tab does, so it is hidden. The Field Camera itself
       * stays — Pictures and Rooms still open it for their job (/camera?job=).
       * To bring the entry back, restore this item:
       *   { to: "/camera", label: "Camera", icon: Aperture,
       *     roles: [...ALL_MGMT, "crew", "field", "field_chaser"] }
       */
      {
        to: "/equipment",
        label: "Equipment",
        icon: PackageOpen,
        roles: [...ALL_MGMT, "crew", "field"],
      },
      {
        to: "/supplies",
        label: "Supplies",
        icon: ClipboardList,
        roles: [...ALL_MGMT, "crew", "field", "field_chaser", "sales_rep"],
      },
      {
        // Mark, 5 Oct: "Need area for crews to upload purchase receipts."
        // sales_head and dev approve receipts too (can_view_finance), so they
        // are listed even though ALL_MGMT leaves them out.
        to: "/receipts",
        label: "Receipts",
        icon: Receipt,
        roles: [...ALL_MGMT, "sales_head", "dev", "crew", "field", "field_chaser", "sales_rep"],
      },
      {
        to: "/timeclock",
        label: "Time clock",
        icon: Clock,
        roles: [...ALL_MGMT, "sales_rep", "field_chaser", "field", "crew"],
      },
      {
        to: "/fleet",
        label: "Fleet",
        icon: Truck,
        roles: ["owner", "regional", "location_manager", "admin", "dev"],
      },
      {
        to: "/vendors",
        label: "Vendors",
        icon: Building2,
        roles: [...ALL_MGMT],
      },
      {
        to: "/documents",
        label: "Documents",
        icon: FileText,
        roles: [...ALL_MGMT],
      },
      {
        to: "/billing",
        label: "Billing",
        icon: Receipt,
        roles: [...ALL_MGMT],
      },
      {
        to: "/timeclock/timesheets",
        label: "Timesheets",
        icon: CalendarClock,
        roles: ALL_MGMT,
      },
    ],
  },

  {
    key: "insight",
    label: "Insight",
    items: [
      {
        to: "/director",
        label: "Director",
        icon: Gauge,
        roles: ALL_MGMT,
        permission: "director.view",
      },
      {
        to: "/intelligence",
        label: "Intelligence",
        icon: Gauge,
        roles: [...ALL_MGMT, "sales_rep", "field_chaser"],
      },
      {
        to: "/goals",
        label: "Goals",
        icon: Target,
        roles: [...ALL_MGMT, "sales_rep", "field_chaser"],
      },
      {
        to: "/my-goals",
        label: "My goals",
        icon: Target,
        roles: [...ALL_MGMT, "sales_rep", "sales_person", "outside_sales_rep", "field_chaser"],
      },
      {
        to: "/coaching/nudges",
        label: "Nudges",
        icon: AlertTriangle,
        roles: [...ALL_MGMT, "sales_rep", "sales_person", "outside_sales_rep", "field_chaser"],
      },
      {
        to: "/stalled",
        label: "Stalled",
        icon: AlertTriangle,
        roles: [...ALL_MGMT],
      },
      {
        to: "/networks",
        label: "Networks",
        icon: ShieldAlert,
        roles: [...ALL_MGMT],
      },
      {
        to: "/compliance",
        label: "Compliance",
        icon: ShieldAlert,
        roles: [...ALL_MGMT, "sales_person", "sales_rep", "outside_sales_rep"],
      },
      {
        to: "/profitability",
        label: "Profitability",
        icon: BarChart3,
        roles: ["owner", "admin", "sales_head", "dev"],
      },
      {
        to: "/rep-cost",
        label: "Rep's cost",
        icon: BarChart3,
        roles: ["owner", "admin", "sales_head", "dev"],
      },
      {
        to: "/my-commissions",
        label: "My commissions",
        icon: BarChart3,
        roles: [
          ...ALL_MGMT,
          "sales_person",
          "sales_rep",
          "cold_caller",
          "outside_sales_rep",
          "field_chaser",
        ],
      },

      {
        to: "/reports",
        label: "Reports",
        icon: BarChart3,
        roles: [...ALL_MGMT],
      },
      {
        to: "/reports/weekly-sales",
        label: "Weekly sales",
        icon: BarChart3,
        roles: [...ALL_MGMT, "sales_person", "sales_rep", "cold_caller", "outside_sales_rep"],
      },

      {
        to: "/assistant",
        label: "AI tools",
        icon: Bot,
        roles: [...ALL_MGMT, "sales_rep"],
        permission: "ai.assistant",
      },
    ],
  },
  {
    key: "team",
    label: "Team",
    items: [
      {
        to: "/calendar",
        label: "Calendar",
        icon: CalendarDays,
        roles: [...ALL_MGMT, "sales_rep", "field_chaser", "field", "crew"],
      },
      {
        to: "/calls",
        label: "Calls",
        icon: Phone,
        roles: [
          ...ALL_MGMT,
          "sales_person",
          "sales_rep",
          "cold_caller",
          "outside_sales_rep",
          "field_chaser",
        ],
      },
      {
        to: "/tasks",
        label: "Tasks",
        icon: CheckSquare,
        roles: [...ALL_MGMT, "sales_rep", "field_chaser", "field", "crew"],
      },
      {
        to: "/todo",
        label: "My to-do",
        icon: ListChecks,
        roles: [...ALL_ROLES],
      },
      {
        to: "/mail",
        label: "Mail",
        icon: Mail,
        roles: [...ALL_MGMT, "sales_person", "sales_rep", "cold_caller", "outside_sales_rep"],
      },
      {
        to: "/chat",
        label: "Chat",
        icon: MessageSquare,
        roles: [...ALL_MGMT, "sales_rep", "field_chaser", "field", "crew"],
      },

      {
        to: "/expenses",
        label: "Expenses",
        icon: Wallet,
        roles: [
          ...ALL_MGMT,
          "sales_head",
          "dev",
          "sales_person",
          "sales_rep",
          "cold_caller",
          "outside_sales_rep",
          "field_chaser",
          "field",
        ],
      },
      {
        // Same list the page and the er_update_lead policy enforce. ALL_MGMT
        // showed this to regional/location/office/sales managers, who landed on
        // "limited to the Sales Head, owners and admins", and hid it from the
        // Sales Head — the one person the approvals queue is for.
        to: "/expenses/approvals",
        label: "Spend approvals",
        icon: BadgeDollarSign,
        roles: [...APPROVER_ROLES],
        // The page also needs the capability; without it the link would land
        // on an empty page.
        permission: "expenses.approve",
      },
      {
        to: "/feature-requests",
        label: "Feature requests",
        icon: Lightbulb,
        roles: [...ALL_MGMT, "dev", "sales_rep", "field_chaser", "field", "crew"],
      },
    ],
  },
  {
    key: "admin",
    label: "Admin",
    items: [
      {
        // The settings hub: areas, search, and every settings page beneath.
        // Landing on Users skipped the map and left the strip as the only way round.
        to: "/admin",
        label: "Admin",
        icon: Shield,
        roles: PRIVILEGED,
      },
      {
        // Billing & Costs rebuild (P2): every price and cost in one place —
        // its own item beside Admin. Settings › Operations links here too.
        to: "/admin/billing-costs",
        label: "Billing & Costs",
        icon: Calculator,
        roles: PRIVILEGED,
      },
      {
        // Mark: "this needs to have an admin menu to change and add". The
        // Sales Head is in the list because the weights are theirs to set;
        // `canOpen` still decides, same as every other item here.
        to: "/admin/scorecard",
        label: "Scorecard and points",
        icon: Trophy,
        roles: [...PRIVILEGED, "sales_head"],
      },
      {
        to: "/admin/escalations",
        label: "Escalation rules",
        icon: AlertTriangle,
        roles: PRIVILEGED,
      },
      {
        to: "/admin/automations",
        label: "Automations",
        icon: Zap,
        roles: PRIVILEGED,
      },
      {
        // Melly, 6 Nov: one People area in place of Reassign a book, People
        // and pay and Offboarding — each is now a tab on a person's profile.
        to: "/admin/people",
        label: "People",
        icon: UsersRound,
        roles: PRIVILEGED,
      },
    ],
  },
];

/**
 * The sidebar shows what the person can actually open.
 *
 * `canOpen` is the page layer — the same decision `PageAccessGate` enforces on
 * the route, so a link is never offered that would land on a refusal, and a
 * page an admin has switched off disappears from the menu. Hiding is the
 * courtesy; the gate is the enforcement.
 */
function itemsForRole(
  roles: AppRole[],
  allowed?: ReadonlySet<string>,
  canOpen?: (path: string) => boolean,
) {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        i.roles.some((r) => roles.includes(r)) &&
        (!i.permission || !allowed || allowed.has(i.permission)) &&
        (!canOpen || canOpen(i.to)),
    ),
  })).filter((g) => g.items.length > 0);
}

function bottomNavForRole(role: AppRole | null): NavItem[] {
  if (role === "crew") {
    return [
      { to: "/", label: "Today", icon: BarChart3, roles: ["crew"] },
      { to: "/jobs", label: "Jobs", icon: Briefcase, roles: ["crew"] },
      { to: "/timeclock", label: "Clock", icon: Clock, roles: ["crew"] },
      // Two taps from anywhere — this, then the camera button — because the
      // crew member is standing at a till with the receipt in their hand.
      { to: "/receipts", label: "Receipts", icon: Receipt, roles: ["crew"] },
    ];
  }
  // field_chaser / field — chase is the whole product on mobile.
  return [
    { to: "/chase", label: "Chase", icon: Siren, roles: ["field_chaser"] },
    { to: "/chase/jobs", label: "Jobs", icon: Briefcase, roles: ["field_chaser"] },
    { to: "/timeclock", label: "Clock", icon: Clock, roles: ["field_chaser"] },
    { to: "/receipts", label: "Receipts", icon: Receipt, roles: ["field_chaser"] },
  ];
}

/** Supply requests waiting on this user's approval, for the sidebar badge.
 *  RLS already limits the queue to offices the user manages, so a plain count
 *  is the whole answer — non-managers simply see zero. */
function usePendingSupplies(userId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const n = await pendingQueueCount(userId);
      if (!cancelled) setCount(n);
    };
    load();
    const t = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [userId]);
  return count;
}

/** Intake forms waiting to become a job, for the sidebar badge. A badge is a
 *  hint and not a result: it stays dark when the count cannot be read, and the
 *  inbox page itself is what reports a failed read. */
function usePendingIntakes(userId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const n = await countUnassignedIntakes();
      if (!cancelled) setCount(n);
    };
    load();
    const t = setInterval(load, 120_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [userId]);
  return count;
}

/** Small hook to keep an unread-count for the sidebar badge fresh. */
function useUnreadChats(userId: string | null): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    // One batched read instead of a count per conversation: the old shape ran
    // dozens of queries every 30s per open tab and dominated database load.
    const load = async () => {
      if (typeof document !== "undefined" && document.hidden) return;
      const { data: memb } = await supabase
        .from("conversation_members")
        .select("conversation_id, last_read_at")
        .eq("user_id", userId);
      if (!memb || memb.length === 0) {
        if (!cancelled) setCount(0);
        return;
      }
      const oldestRead = memb.reduce(
        (min, m) => (new Date(m.last_read_at) < new Date(min) ? m.last_read_at : min),
        memb[0]!.last_read_at,
      );
      const { data: rows } = await supabase
        .from("messages")
        .select("conversation_id, sent_at")
        .in(
          "conversation_id",
          memb.map((m) => m.conversation_id),
        )
        .gt("sent_at", oldestRead)
        .neq("sender_id", userId)
        .is("deleted_at", null)
        .limit(2000);
      const readBy = new Map(memb.map((m) => [m.conversation_id, new Date(m.last_read_at)]));
      let total = 0;
      for (const r of rows ?? []) {
        const readAt = readBy.get(r.conversation_id);
        if (readAt && new Date(r.sent_at) > readAt) total += 1;
      }
      if (!cancelled) setCount(total);
    };
    load();
    const iv = setInterval(load, 60_000);
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const ch = supabase
      .channel(`unread-badge:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(load, 1500);
      })
      .subscribe();
    return () => {
      cancelled = true;
      clearInterval(iv);
      if (debounce) clearTimeout(debounce);
      supabase.removeChannel(ch);
    };
  }, [userId]);
  return count;
}

export function AppShell({ children }: { children: ReactNode }) {
  const app = useAppContext();
  // Counted here, once, and handed to the sidebar and the bar. The hook polls
  // and holds a realtime channel named for the user; a second caller would
  // double the polling and open a duplicate channel.
  const unreadChats = useUnreadChats(app.userId);
  const { allowed } = useMyPermissions();
  // The scrollport the phone bars watch; see use-condense-on-scroll.ts.
  const mainRef = useRef<HTMLElement | null>(null);
  const condensed = useCondenseOnScroll(mainRef);

  return (
    <HiddenSectionsProvider
      userId={app.userId}
      roles={app.roles}
      persistEnabled={!app.isImpersonating}
    >
      <SpanishScreen />
      <DialerProvider>
        <SidebarProvider className="h-svh min-h-svh overflow-hidden">
          {/* h-svh, not h-screen: on iOS `100vh` is the LARGE viewport, so a
          `h-screen` shell is taller than the visible page and its bottom row
          hides under Safari's toolbar. */}
          <div className="flex h-svh w-full min-w-0 flex-col overflow-hidden">
            <BadgeUnlockToaster />
            <IosInstallSheetHost />
            <ImpersonationBanner />
            <DemoDataBanner />

            <div className="flex min-h-0 flex-1">
              <AppSidebar unreadChats={unreadChats} />
              <SidebarInset className="min-h-0 min-w-0 overflow-hidden">
                {/*
                  On a phone the bar folds away while scrolling down and comes
                  back on scroll up (use-condense-on-scroll.ts). Folded by its
                  grid row rather than hidden, so it slides and nothing jumps.
                */}
                <div
                  data-condensed={condensed ? "true" : undefined}
                  className="grid grid-rows-[1fr] transition-[grid-template-rows] duration-200 max-md:data-[condensed=true]:grid-rows-[0fr]"
                >
                  <div className="min-h-0 overflow-hidden">
                    <TopBar />
                  </div>
                </div>
                <NavTrail />
                <main
                  ref={mainRef}
                  className={cn(
                    // The working area is explicitly the light ground. It used
                    // to inherit it, which meant nothing in the shell stated
                    // the dark-rail / light-content contrast on purpose.
                    "min-h-0 flex-1 overflow-auto bg-background [--table-sticky-top:2.5rem]",
                    // No rubber band on the page's own scroller: the bounce
                    // past the end was half of the over-scroll flicker
                    // (David, 15 Oct; see use-condense-on-scroll.ts).
                    "overscroll-y-none",
                    // Room for the bottom bar, which every role gets on a phone
                    // now — plus the home indicator sitting underneath it. Without
                    // the env() the last row of every list ends up under the bar.
                    "pb-[calc(4rem+env(safe-area-inset-bottom,0px))] md:pb-0",
                  )}
                >
                  {/*
                   * Queued offline writes were visible on exactly one screen, the
                   * chase cockpit. Every other queued write - a timeclock punch, a
                   * note, a field ticket filled in a basement - sat on the device
                   * with nothing on screen saying so. The queue's whole promise is
                   * that the user can see their work is held, so it belongs in the
                   * shell rather than on whichever page remembered to mount it.
                   */}
                  {/*
                   * One content container for all 110 pages: capped width so
                   * a table does not run 2,400px edge to edge on a wide
                   * monitor, and centred so the light working area reads as a
                   * deliberate surface next to the dark rail rather than as
                   * whatever is left over.
                   */}
                  <div className="mx-auto w-full min-w-0 max-w-[var(--content-max)]">
                    <SyncBanner />
                    {/* Phones, dashboard only, once per fortnight at most. */}
                    <InstallBanner />
                    {children}
                  </div>
                </main>
                <MobileBottomNav condensed={condensed} unreadChats={unreadChats} />
              </SidebarInset>
            </div>
            {allowed.has("ai.assistant") && <AssistantPanelHost />}
          </div>
        </SidebarProvider>
      </DialerProvider>
    </HiddenSectionsProvider>
  );
}

/**
 * Which sidebar sections are folded. Remembered per person on this device so a
 * rep who only ever uses Sales does not scroll past six other groups.
 */
function useSidebarGroupCollapse(userId: string | null | undefined) {
  const key = `rh.sidebar.groups.${userId ?? "anon"}`;
  const [collapsedGroups, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key);
      setCollapsed(raw ? (JSON.parse(raw) as Record<string, boolean>) : {});
    } catch {
      setCollapsed({});
    }
  }, [key]);

  const toggleGroup = (groupKey: string) =>
    setCollapsed((prev) => {
      const next = { ...prev, [groupKey]: !prev[groupKey] };
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* private mode — session-only */
      }
      return next;
    });

  return { collapsedGroups, toggleGroup };
}

/**
 * Personal ordering of the sidebar. Loads the saved arrangement, applies it on
 * top of whatever the role is allowed to see, and writes changes back.
 */
function useSidebarOrder(
  userId: string | null | undefined,
  enabled: boolean,
  roles: readonly string[],
) {
  const [order, setOrder] = useState<SidebarOrder>(EMPTY_ORDER);
  const roleKey = roles.join(",");

  const refresh = useCallback(() => {
    if (!userId || !enabled) {
      setOrder(EMPTY_ORDER);
      return;
    }
    // Personal order wins; otherwise the organisation default applies.
    loadEffectiveSidebarOrder(userId, roleKey ? roleKey.split(",") : [])
      .then(setOrder)
      .catch(() => setOrder(EMPTY_ORDER));
  }, [userId, enabled, roleKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener(SIDEBAR_ORDER_EVENT, onChanged);
    return () => window.removeEventListener(SIDEBAR_ORDER_EVENT, onChanged);
  }, [refresh]);

  const persist = useCallback(
    (next: SidebarOrder) => {
      setOrder(next);
      if (!userId || !enabled) return;
      saveSidebarOrder(userId, next).catch(() => toast.error("Could not save your sidebar order"));
    },
    [userId, enabled],
  );

  return { order, persist };
}

function SortableNavItem({
  id,
  children,
  className,
}: {
  id: string;
  children: (handle: ReactNode) => ReactNode;
  className?: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  const style = { transform: CSS.Translate.toString(transform), transition };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label="Reorder"
      onClick={(e) => e.preventDefault()}
      className="hidden shrink-0 cursor-grab touch-none rounded p-0.5 text-sidebar-foreground/50 opacity-0 transition-opacity hover:text-sidebar-foreground focus-visible:opacity-100 active:cursor-grabbing group-hover/sortable:opacity-100 md:block group-data-[collapsible=icon]:!hidden"
    >
      <GripVertical className="size-3.5" aria-hidden />
    </button>
  );

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("group/sortable relative", isDragging && "z-20 opacity-80", className)}
    >
      {children(handle)}
    </div>
  );
}

function AppSidebar({ unreadChats }: { unreadChats: number }) {
  const app = useAppContext();
  const { t } = useLabelLanguage();
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  const { allowed } = useMyPermissions();
  const pageAccess = useMyPageAccess();
  const roleGroups = itemsForRole(app.roles, allowed, pageAccess.canOpen);
  const mobileFirst = isMobileFirstRole(app.primary);
  const pendingSupplies = usePendingSupplies(app.userId);
  const pendingIntakes = usePendingIntakes(app.userId);
  const { collapsedGroups, toggleGroup } = useSidebarGroupCollapse(app.userId);
  const { isMobile, setOpenMobile, state: sidebarState, setOpen: setSidebarOpen } = useSidebar();
  // Role preview shows that role's default arrangement, and never writes.
  const orderable = !app.isImpersonating;
  const { order, persist } = useSidebarOrder(app.userId, orderable, app.roles);

  // Saved order layered on top of the role-gated groups — never adds anything.
  const groups = useMemo(() => {
    const ordered = applyOrder(roleGroups, order.groups, (g) => g.key);
    return ordered.map((g) => ({
      ...g,
      items: applyOrder(g.items, order.items[g.key], (i) => i.to),
    }));
  }, [roleGroups, order]);

  // Personal hide list for sidebar links. Applied on top of the role-gated
  // groups, so it can only ever remove what the role already allowed.
  const hidden = useHiddenSections();
  const hiddenNav = hidden.hiddenKeys(SIDEBAR_PAGE);
  useEffect(() => {
    for (const g of groups) {
      for (const i of g.items) registerSectionLabel(SIDEBAR_PAGE, i.to, i.label);
    }
  }, [groups]);
  const visibleGroups = useMemo(
    () =>
      groups
        .map((g) => ({ ...g, items: g.items.filter((i) => !hiddenNav.includes(i.to)) }))
        .filter((g) => g.items.length > 0),
    [groups, hiddenNav],
  );

  // Menu search reads the list above — role, page access and personal hides
  // already applied — so it can only narrow what is drawn. Settings pages join
  // the results only when the menu itself offers a way into settings, and then
  // only the ones the settings hub would list for this person.
  const linksIntoSettings = visibleGroups.some((g) =>
    g.items.some((i) => i.to === "/admin" || i.to.startsWith("/admin/")),
  );
  const searchSettings = useMemo(
    () => (linksIntoSettings ? searchableSettingsPages(pageAccess.canOpen) : []),
    [linksIntoSettings, pageAccess.canOpen],
  );
  const expandSidebar = useCallback(() => {
    if (isMobile) setOpenMobile(true);
    else setSidebarOpen(true);
  }, [isMobile, setOpenMobile, setSidebarOpen]);

  // Client-review pass. Real roles only, so a role preview never shows it, and
  // it stays off until this person turns it on. Everyone else sees the sidebar
  // exactly as it has always looked.
  const canReview = isPrivileged(app.realRoles) && !app.isImpersonating;
  const { reviewMode, toggleReviewMode } = useReviewMode(app.userId, canReview);
  const reviews = usePageReviews(reviewMode);
  const setReview = useSetPageReview(app.userId);
  const reviewOn = reviewMode && reviews.available;
  const reviewedKeys = useMemo(
    () => visibleGroups.flatMap((g) => g.items.map((i) => pageKeyForPath(i.to))),
    [visibleGroups],
  );
  const reviewCounts = usePageReviewSummary(reviewedKeys, reviews.statuses);
  const cycleReview = useCallback(
    (to: string, statuses: PageReviewMap) => {
      const key = pageKeyForPath(to);
      const current = statuses[key] ?? "unreviewed";
      setReview.mutate({ pageKey: key, status: nextPageReviewStatus(current) });
    },
    [setReview],
  );

  // On phones the sidebar is a sheet; selecting any nav item should dismiss it
  // so the page underneath is visible again.
  const closeMobileSidebar = () => {
    if (isMobile) setOpenMobile(false);
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const onGroupDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const keys = groups.map((g) => g.key);
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    persist({ ...order, groups: arrayMove(keys, from, to) });
  };

  const onItemDragEnd = (groupKey: string) => (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const g = groups.find((x) => x.key === groupKey);
    if (!g) return;
    const keys = g.items.map((i) => i.to);
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    persist({
      ...order,
      items: { ...order.items, [groupKey]: arrayMove(keys, from, to) },
    });
  };

  // Only the deepest matching nav entry lights up, so /chase/search never
  // also highlights /chase.
  const allPaths = groups.flatMap((g) => g.items.map((i) => i.to));
  const isActive = (to: string) => {
    if (to === "/") return currentPath === "/";
    if (currentPath === to) return true;
    if (!currentPath.startsWith(to + "/")) return false;
    return !allPaths.some(
      (p) =>
        p !== to && p.length > to.length && (currentPath === p || currentPath.startsWith(p + "/")),
    );
  };

  // Sidebar always stays visible as an icon rail when collapsed; it never
  // fully disappears so navigation is always one click or drag away.
  return (
    <Sidebar collapsible="icon" resizable className="relative">
      {/*
        The brand lockup. This is the one place the identity is stated, so it
        gets real height and a gold rule under it rather than sharing the
        generic hairline every other divider uses.
      */}
      <SidebarHeader className="shrink-0 p-0">
        <div className="flex items-center gap-2.5 border-b border-[var(--sidebar-border)] px-3 py-3 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0">
          <img
            src="/gold-star-badge.png"
            alt=""
            aria-hidden
            className="size-8 shrink-0 object-contain"
          />

          {/* The brand is a name: Google Translate (top-bar G·ES) leaves it alone. */}
          <div className="notranslate min-w-0 group-data-[collapsible=icon]:hidden" translate="no">
            {/*
              --brand-gold-text (#7e6c1c) is tuned for LIGHT grounds and gave
              ~3.2:1 here, below AA. --sidebar-gold is 7.2:1 on the rail.
            */}
            <div className="display-heavy truncate text-[16px] uppercase leading-tight tracking-[0.08em] text-[var(--sidebar-gold)]">
              Gold Star
            </div>
            <div className="label-caps truncate text-[var(--sidebar-foreground)]/80">
              Recovery Hub
            </div>
          </div>
        </div>
        <span aria-hidden className="gold-rule-thin opacity-70" />
      </SidebarHeader>

      <SidebarContent className="scroll-dark scroll-fade relative min-h-0 flex-1 gap-1.5 overflow-y-auto overflow-x-hidden px-1.5 py-1.5 group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:[scrollbar-width:none] group-data-[collapsible=icon]:[&::-webkit-scrollbar]:w-0 group-data-[collapsible=icon]:[&::-webkit-scrollbar]:hidden">
        <BrandWatermark />

        {canReview && (
          <button
            type="button"
            onClick={toggleReviewMode}
            aria-pressed={reviewMode}
            title="Mark each page unreviewed / in review / approved while walking the client through the app"
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md border px-1.5 py-1 text-[12px] transition-colors group-data-[collapsible=icon]:hidden",
              reviewMode
                ? "border-[var(--brand-gold)]/70 bg-sidebar-accent/40 text-sidebar-foreground"
                : "border-dashed border-sidebar-border/70 text-sidebar-foreground/70 hover:text-sidebar-foreground",
            )}
          >
            <CheckSquare className="size-3.5 shrink-0" aria-hidden />
            <span className="flex-1 truncate text-left">Review mode</span>
            <span className="label-caps shrink-0 text-[10px]">{reviewMode ? "On" : "Off"}</span>
          </button>
        )}

        <SidebarNavSearch
          groups={visibleGroups}
          settingsPages={searchSettings}
          isActive={isActive}
          collapsed={!isMobile && sidebarState === "collapsed"}
          onExpand={expandSidebar}
          onNavigate={closeMobileSidebar}
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onGroupDragEnd}
          >
            <SortableContext
              items={visibleGroups.map((g) => g.key)}
              strategy={verticalListSortingStrategy}
            >
              {visibleGroups.map((g) => (
                <SortableNavItem key={g.key} id={g.key}>
                  {(groupHandle) => (
                    <SidebarGroup
                      // Each group is its own box: separation without extra padding.
                      className={cn(
                        // Box sizes to its content: never shrinks, never scrolls, never clips.
                        "h-auto w-full min-w-0 shrink-0 grow-0 basis-auto overflow-visible rounded-md border border-sidebar-border/70 bg-sidebar-accent/25 px-1 py-1",
                        // Collapsed: the box wraps the icon rail exactly, no side overflow.
                        "group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-1",
                      )}
                    >
                      <SidebarGroupLabel
                        asChild
                        className="cursor-pointer select-none hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:!mt-0 group-data-[collapsible=icon]:hidden"
                      >
                        <div className="flex items-center gap-1">
                          {groupHandle}
                          <button
                            type="button"
                            onClick={() => toggleGroup(g.key)}
                            aria-expanded={!collapsedGroups[g.key]}
                            className="flex min-w-0 flex-1 items-center gap-1"
                          >
                            <span className="flex-1 truncate text-left">{t(g.label)}</span>
                            <ChevronDown
                              className={cn(
                                "size-3.5 shrink-0 transition-transform",
                                collapsedGroups[g.key] && "-rotate-90",
                              )}
                              aria-hidden
                            />
                          </button>
                        </div>
                      </SidebarGroupLabel>
                      <SidebarGroupContent
                        className={cn(
                          // Group collapse only applies when the sidebar shows labels;
                          // in the icon rail every group stays open.
                          collapsedGroups[g.key] && "hidden",
                          "group-data-[collapsible=icon]:!block",
                        )}
                      >
                        <DndContext
                          sensors={sensors}
                          collisionDetection={closestCenter}
                          onDragEnd={onItemDragEnd(g.key)}
                        >
                          <SortableContext
                            items={g.items.map((i) => i.to)}
                            strategy={verticalListSortingStrategy}
                          >
                            <SidebarMenu className="gap-0.5 group-data-[collapsible=icon]:items-center">
                              {g.items.map((n) => {
                                const Icon = n.icon;
                                const active = isActive(n.to);
                                const badge =
                                  n.to === "/chat" && unreadChats > 0
                                    ? unreadChats
                                    : n.to === "/supplies" && pendingSupplies > 0
                                      ? pendingSupplies
                                      : n.to === "/intake-inbox" && pendingIntakes > 0
                                        ? pendingIntakes
                                        : null;
                                // Off outside review mode, so the label keeps its own colour.
                                const reviewKey = pageKeyForPath(n.to);
                                const reviewStatus: PageReviewStatus = reviewOn
                                  ? (reviews.statuses[reviewKey] ?? "unreviewed")
                                  : "unreviewed";
                                return (
                                  <SortableNavItem key={n.to} id={n.to}>
                                    {(itemHandle) => (
                                      <SidebarMenuItem className="group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:w-full group-data-[collapsible=icon]:justify-center">
                                        <SidebarMenuButton
                                          asChild
                                          isActive={active}
                                          tooltip={badge ? `${t(n.label)} · ${badge}` : t(n.label)}
                                          className="group-data-[collapsible=icon]:!mx-0 group-data-[collapsible=icon]:!w-8 group-data-[collapsible=icon]:!gap-0 group-data-[collapsible=icon]:!justify-center group-data-[collapsible=icon]:!p-0 group-data-[collapsible=icon]:!text-center"
                                        >
                                          <Link
                                            to={n.to as string}
                                            search={{} as never}
                                            onClick={closeMobileSidebar}
                                            // Only in review mode: keep the badge clear of the status dot.
                                            className={cn(reviewOn && "pr-7")}
                                          >
                                            <Icon />
                                            <span
                                              className={cn(
                                                "group-data-[collapsible=icon]:hidden",
                                                reviewOn && PAGE_REVIEW_TEXT_CLASS[reviewStatus],
                                              )}
                                            >
                                              {t(n.label)}
                                            </span>

                                            {badge && (
                                              <Badge className="ml-auto h-5 min-w-5 rounded-full bg-[var(--brand-gold)] px-1.5 text-[10px] tabular-nums text-[var(--brand-gold-foreground)] group-data-[collapsible=icon]:hidden">
                                                {badge > 99 ? "99+" : badge}
                                              </Badge>
                                            )}
                                          </Link>
                                        </SidebarMenuButton>
                                        <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
                                          {reviewOn && (
                                            <button
                                              type="button"
                                              aria-label={`${n.label} — ${PAGE_REVIEW_LABEL[reviewStatus]}. Click to change.`}
                                              title={`${PAGE_REVIEW_LABEL[reviewStatus]} — click to change`}
                                              onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                cycleReview(n.to, reviews.statuses);
                                              }}
                                              className="grid shrink-0 place-items-center rounded p-0.5 group-data-[collapsible=icon]:!hidden"
                                            >
                                              <span
                                                className={cn(
                                                  "size-2.5 rounded-full border",
                                                  PAGE_REVIEW_DOT_CLASS[reviewStatus],
                                                )}
                                                aria-hidden
                                              />
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            aria-label={`Hide ${n.label}`}
                                            title={`Hide ${n.label}`}
                                            onClick={(e) => {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              hidden.hide(SIDEBAR_PAGE, n.to);
                                            }}
                                            className="hidden rounded p-0.5 text-sidebar-foreground/60 hover:text-sidebar-foreground group-hover/menu-item:block group-data-[collapsible=icon]:!hidden"
                                          >
                                            <EyeOff className="size-3.5" aria-hidden />
                                          </button>
                                          {itemHandle}
                                        </div>
                                      </SidebarMenuItem>
                                    )}
                                  </SortableNavItem>
                                );
                              })}
                            </SidebarMenu>
                          </SortableContext>
                        </DndContext>
                      </SidebarGroupContent>
                    </SidebarGroup>
                  )}
                </SortableNavItem>
              ))}
            </SortableContext>
          </DndContext>

          {hiddenNav.length > 0 && (
            <div className="rounded-md border border-dashed border-sidebar-border/70 px-2 py-1.5 text-[11px] text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
              <div className="flex items-center justify-between gap-1">
                <span>Hidden ({hiddenNav.length})</span>
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-sidebar-foreground"
                  onClick={() => hidden.showAll(SIDEBAR_PAGE)}
                >
                  Show all
                </button>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {hiddenNav.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className="flex items-center gap-1 rounded border border-sidebar-border/60 px-1.5 py-0.5 hover:text-sidebar-foreground"
                    onClick={() => hidden.show(SIDEBAR_PAGE, k)}
                  >
                    <Eye className="size-3" aria-hidden />
                    {sectionLabel(SIDEBAR_PAGE, k)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </SidebarNavSearch>
      </SidebarContent>

      <SidebarFooter className="shrink-0 gap-2 border-t border-sidebar-border/60 p-2">
        {reviewMode && (
          <div className="rounded-md border border-dashed border-sidebar-border/70 px-2 py-1 text-[11px] leading-tight text-sidebar-foreground/70 group-data-[collapsible=icon]:hidden">
            {reviews.available ? (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className={PAGE_REVIEW_TEXT_CLASS.approved}>
                  {reviewCounts.approved} approved
                </span>
                <span aria-hidden>·</span>
                <span className={PAGE_REVIEW_TEXT_CLASS.in_review}>
                  {reviewCounts.in_review} in review
                </span>
                <span aria-hidden>·</span>
                <span>{reviewCounts.unreviewed} unreviewed</span>
              </span>
            ) : (
              <span>Review statuses unavailable — the page_reviews table isn't there yet.</span>
            )}
          </div>
        )}
        {/* 12 Nov: a short footer, so the menu above keeps the room — the two
            pickers side by side, the help links on one line. */}
        <div
          className="grid grid-cols-2 gap-2 empty:hidden group-data-[collapsible=icon]:hidden [&>*:only-child]:col-span-2"
          data-sidebar-pickers
        >
          <LocationSwitcher />
          <RolePreviewSwitcher />
        </div>
        <UserMenu />
        <div className="flex items-center justify-between gap-2 group-data-[collapsible=icon]:hidden">
          <SuggestFeatureAction />
          <EmergencyLine />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function LocationSwitcher() {
  const app = useAppContext();
  if (app.visibleLocations.length <= 1) return null;
  const selected = app.visibleLocations.find((l) => l.id === app.currentLocationId) ?? null;

  return (
    <div className="min-w-0 group-data-[collapsible=icon]:hidden">
      <div className="label-caps mb-1 truncate px-1 text-muted-foreground">Context</div>
      <Select
        value={app.currentLocationId ?? "__all"}
        onValueChange={(v) => app.setCurrentLocationId(v === "__all" ? null : v)}
      >
        <SelectTrigger className="sidebar-control h-8 w-full text-[12px]">
          <SelectValue>
            {selected ? `${selected.code} · ${selected.name}` : "All my locations"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="sidebar-popover">
          <SelectItem value="__all">All my locations</SelectItem>
          {app.visibleLocations.map((l) => (
            <SelectItem key={l.id} value={l.id}>
              {l.code} · {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 *"Whose eyes am I looking through" — distinct from the Context location
 * picker above it, which answers"which office am I looking at". Only
 * owner / admin / dev ever see this; it lists every role in app_role
 * whether or not a user holds it, so the whole system is inspectable.
 *
 * Safety: activation goes through the SECURITY DEFINER start_impersonation
 * RPC (audited server-side), it can only narrow the actor's effective role
 * set, and it disables writes for the whole session.
 */
function RolePreviewSwitcher() {
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);

  const start = useMutation({
    mutationFn: (role: AppRole) => startImpersonationPreview(role),
    onSuccess: async () => {
      rememberReturnPath(window.location.pathname);
      await app.refreshImpersonation();
      qc.invalidateQueries();
      toast.success("Role preview started — writes are disabled");
      navigate({ to: "/" });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not start preview"),
  });

  if (!isPrivileged(app.realRoles)) return null;

  const active = app.impersonation?.preview_role ?? null;
  const person = app.viewingAsPerson;
  // A role preview can only start from your own view; "View as person…" can
  // switch straight from one person to another (start_impersonation closes
  // the previous audit row as `replaced`).
  const otherViewActive = app.isImpersonating && !active;

  return (
    <div className="min-w-0 group-data-[collapsible=icon]:hidden">
      <div className="label-caps mb-1 truncate px-1 text-[var(--brand-gold)]">View as</div>
      <Select
        value={person ? "__person" : (active ?? "__self")}
        disabled={start.isPending}
        onValueChange={(v) => {
          if (v === "__self") return;
          // Mark, 11 Oct: "I also want to be able to view as specific people."
          if (v === "__person") {
            setPickerOpen(true);
            return;
          }
          if (otherViewActive) return;
          start.mutate(v as AppRole);
        }}
      >
        <SelectTrigger
          className={`sidebar-control h-8 w-full border-dashed text-[12px] ${
            active || person
              ? "border-fuchsia-400 bg-fuchsia-500/25 text-fuchsia-50"
              : "border-[var(--brand-gold)]/70"
          }`}
          title={
            person
              ? `Viewing as ${person.name}. Switch back from the banner, or pick another person.`
              : "Read-only preview. Narrows what you see; never widens it."
          }
        >
          <span className="!flex min-w-0 items-center gap-1.5 overflow-hidden">
            <Eye className="size-3.5 shrink-0" aria-hidden />
            <SelectValue>
              {person ? person.name : active ? ROLE_LABELS[active] : "My own roles"}
            </SelectValue>
          </span>
        </SelectTrigger>
        <SelectContent className="sidebar-popover">
          <SelectItem value="__self" disabled>
            My own roles
          </SelectItem>
          {/* Always selectable, so picking it again reopens the picker. */}
          <SelectItem value="__person" onPointerUp={() => person && setPickerOpen(true)}>
            {person ? `${person.name} · change person…` : "View as person…"}
          </SelectItem>
          {PREVIEWABLE_ROLES.map((r) => (
            <SelectItem
              key={r}
              value={r}
              disabled={otherViewActive}
              title={otherViewActive ? "Switch back first" : undefined}
            >
              {ROLE_LABELS[r]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Said while a preview is on; the picker's tooltip says it before. */}
      {(active || person) && (
        <p className="mt-1 px-1 text-[11px] leading-tight text-muted-foreground">
          Read-only preview.
        </p>
      )}
      <ViewAsPersonPicker open={pickerOpen} onOpenChange={setPickerOpen} />
    </div>
  );
}

const THEME_OPTIONS: { value: Theme; icon: typeof Sun }[] = [
  { value: "light", icon: Sun },
  { value: "dark", icon: Moon },
  { value: "system", icon: Monitor },
];

function UserMenu() {
  const app = useAppContext();
  const { t } = useLabelLanguage();
  const navigate = useNavigate();
  const { theme, setTheme, palette } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const handleSignOut = async () => {
    // A View As ends with the sign-in; close its audit row while the session
    // that opened it can still do so.
    if (app.isImpersonating) await endImpersonationForSignOut();
    await supabase.auth.signOut();
    clearNavTrail(); // the next person on this tab must not inherit a trail
    toast.success("Signed out");
    navigate({ to: "/auth" });
  };

  const label = app.primary ? ROLE_LABELS[app.primary] : "No role assigned";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              tooltip={app.fullName || app.email || "Account"}
              className="h-8 data-[state=open]:bg-sidebar-accent"
            >
              <div className="grid size-6 shrink-0 place-items-center rounded-sm bg-accent">
                <User className="size-3.5" />
              </div>
              <span className="flex-1 truncate text-left text-[12px] leading-none group-data-[collapsible=icon]:hidden">
                {app.fullName || app.email || "Account"}
                <span className="text-muted-foreground"> · {label}</span>
              </span>
              <ChevronsUpDown className="ml-auto size-3.5 group-data-[collapsible=icon]:hidden" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-64">
            <DropdownMenuLabel className="flex flex-col">
              <span className="truncate text-sm">{app.fullName || "Account"}</span>
              <span className="truncate text-[11px] font-normal text-muted-foreground">
                {app.email}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase text-muted-foreground">
              Roles
            </DropdownMenuLabel>
            {app.roles.length === 0 ? (
              <DropdownMenuItem disabled className="text-xs">
                None
              </DropdownMenuItem>
            ) : (
              app.roles.map((r) => (
                <DropdownMenuItem key={r} disabled className="text-xs">
                  {ROLE_LABELS[r]}
                  {r === app.primary ? " · primary" : ""}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-[11px] font-medium uppercase text-muted-foreground">
              Appearance
            </DropdownMenuLabel>
            <div className="px-2 pb-1.5">
              <div className="grid grid-cols-3 gap-1 rounded-[6px] border border-border bg-muted/40 p-0.5">
                {THEME_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setTheme(o.value)}
                    aria-pressed={theme === o.value}
                    className={cn(
                      "flex items-center justify-center gap-1 rounded-[4px] px-1.5 py-1 text-[11px] font-medium transition-colors",
                      theme === o.value
                        ? "bg-background text-foreground shadow-[0_0_0_1px_var(--border)]"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <o.icon className="size-3.5" />
                    {THEME_LABEL[o.value]}
                  </button>
                ))}
              </div>
            </div>
            {/*
             * David, 24 Sep, on the bilingual field cards: "I don't know if I
             * like all the Spanish." Each person's own choice, next to the
             * theme, because it is the same kind of thing: how the app reads
             * to me. See src/lib/label-language.ts for the role defaults.
             */}
            <DropdownMenuLabel className="text-[11px] font-medium uppercase text-muted-foreground">
              {t("Language")}
            </DropdownMenuLabel>
            <div className="px-2 pb-1.5">
              <LabelLanguageChoice />
            </div>
            {/*
             * Mark: "this should be a collapsable menu, and should default to
             * collapsed."
             *
             * Five palette rows made the user menu mostly about paint, and
             * pushed Security and Sign out -- the two things people actually
             * open this menu for -- below the fold on a laptop. The current
             * palette's name sits in the header so nobody has to expand it to
             * see what is set. Collapsed on every open, not remembered: this is
             * a menu, and a menu that reopens half-unfolded is a surprise.
             */}
            <button
              type="button"
              onClick={() => setPaletteOpen((v) => !v)}
              aria-expanded={paletteOpen}
              aria-controls="user-menu-palette"
              className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-medium uppercase text-muted-foreground hover:text-foreground"
            >
              <span>Color theme</span>
              <span className="flex items-center gap-1 normal-case">
                {PALETTES.find((p) => p.value === palette)?.label}
                <ChevronDown
                  className={cn("size-3.5 transition-transform", paletteOpen && "rotate-180")}
                  aria-hidden
                />
              </span>
            </button>
            <div id="user-menu-palette" hidden={!paletteOpen} className="px-2 pb-1.5">
              <PaletteChoices />
            </div>
            <DropdownMenuSeparator />
            {/* "Install app" / "Install on iPhone"; nothing on a browser that
                cannot install, or once it already is. See install-prompt.tsx. */}
            <InstallMenuItem />
            <DropdownMenuItem asChild>
              <Link to="/security">
                <ShieldCheck className="mr-2 size-4" />
                Security &amp; two-factor
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleSignOut}>
              <LogOut className="mr-2 size-4" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/**
 * Always-reachable way to raise a problem. A tech noticing something mid-job
 * will not go hunting through a menu for it.
 */
function SuggestFeatureAction() {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0 group-data-[collapsible=icon]:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-8 items-center gap-1.5 rounded-md px-1 py-1 text-[12px] text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      >
        <Lightbulb className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">Suggest a feature</span>
      </button>
      <SuggestFeatureDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** Permanent reference to the emergency line — text only, not a CTA. */
function EmergencyLine() {
  return (
    <a
      href="tel:+18779592837"
      className="flex min-h-8 shrink-0 items-center gap-1.5 px-1 text-[12px] text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden"
    >
      <Phone className="size-3 shrink-0 text-[var(--brand-gold-text)]" aria-hidden />
      <span className="text-[var(--brand-gold-text)] font-medium">1-877-95-WATER</span>
    </a>
  );
}

function TopBar() {
  const { t } = useLabelLanguage();
  const { allowed } = useMyPermissions();
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  const title = pageTitleFromPath(currentPath);
  const app = useAppContext();
  const pageAccess = useMyPageAccess();
  // Real roles, not effective: View As must not hand the feed to a rep preview.
  // And only when the page itself opens for this person — never a link that
  // lands on the access refusal.
  const showHistory = isPrivileged(app.realRoles) && pageAccess.canOpen("/history");
  return (
    <div className="z-30 shrink-0">
      <header className="flex h-12 items-center gap-2 border-b bg-card pl-[max(0.75rem,env(safe-area-inset-left,0px))] pr-[max(0.75rem,env(safe-area-inset-right,0px))] md:pl-4 md:pr-4">
        {/* Exactly one sidebar toggle app-wide. */}
        <SidebarTrigger className="-ml-1" />

        <div className="flex min-w-0 flex-1 items-center gap-1">
          {/* On a phone the bar carries the back control and the record's own
              name; the trail row below is hidden and the generic route title
              ("Job", over a page that names the job) is not shown at all. */}
          <NavTrailInline title={title} className="min-w-0 md:hidden" />
          <h1 className="display-heavy hidden min-w-0 truncate text-[16px] tracking-[0.01em] md:block">
            {t(title)}
          </h1>
        </div>
        {/* Right side: Polaris (mark and name) and the AI credits balance for
            Owners, Admins and Developers. */}
        {allowed.has("ai.assistant") && <AssistantHeaderButton />}
        <AiCreditsChip />
        <div className="hidden sm:block">
          <GlobalSearchButton />
        </div>
        {showHistory ? (
          <Button asChild size="sm" variant="ghost" className="gap-1.5 px-2">
            <Link to="/history" title="Activity history">
              <History className="size-4" />
              <span className="hidden md:inline text-xs">{t("History")}</span>
            </Link>
          </Button>
        ) : null}
        {/* Every employee, field roles included: the standing intake link is
            for whoever takes the call. The database refuses anyone else. */}
        <IntakeLinkMenu />
        <SyncIndicator className="mr-1" />
        {/* English or Español, one tap away on every screen — BC-LANG-1. */}
        <LanguageToggle />
        <NotificationBell />
      </header>
    </div>
  );
}

/**
 * The phone bottom bar.
 *
 * This used to be gated on `isMobileFirstRole` — field_chaser, field, crew —
 * and every other role got nothing at all on a phone. That gate answers the
 * wrong question. "Mobile-first role" means *this person's whole job happens on
 * a phone*; it does not mean they are the only person holding one. An office
 * manager approving a supply request from the truck, a regional checking a job
 * at 9pm, an owner looking at a number in a meeting — all on phones, all
 * previously left with a 28px hamburger in the top-left corner as their only
 * way to move around, at the far end of the screen from their thumb.
 *
 * So: everyone gets a bar, and everyone gets Menu at the end of it. The field
 * roles keep their hand-picked four, because for them it is the product.
 * Everyone else gets their own first three nav
 * destinations — role-gated, permission-gated and personal-hide-list-gated,
 * exactly like the sidebar, so nothing appears here that they cannot open —
 * plus Menu, which opens the full sidebar sheet. Deriving the list rather than
 * hardcoding it is the point: a hardcoded `/jobs` would 404 for half the roles.
 */
function MobileBottomNav({
  condensed = false,
  unreadChats = 0,
}: {
  condensed?: boolean;
  unreadChats?: number;
}) {
  const app = useAppContext();
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  const { allowed } = useMyPermissions();
  const pageAccess = useMyPageAccess();
  const { t } = useLabelLanguage();
  const { setOpenMobile } = useSidebar();
  const hidden = useHiddenSections();
  const mobileFirst = isMobileFirstRole(app.primary);

  const hiddenNav = hidden.hiddenKeys(SIDEBAR_PAGE);
  const items = (
    mobileFirst
      ? bottomNavForRole(app.primary)
      : itemsForRole(app.roles, allowed, pageAccess.canOpen)
          .flatMap((g) => g.items)
          .filter((i) => !hiddenNav.includes(i.to))
  )
    // The mobile bar is hardcoded per field role, so it needs the same page
    // check the derived list gets for free.
    .filter((i) => pageAccess.canOpen(i.to))
    // Four tabs and Menu: five cells, the most iOS and Android put on a tab
    // bar. Receipts took the fifth tab on 5 Oct and made six; Mark moved Chat
    // into Menu rather than squeeze them. Adding a tab means choosing one to
    // move, not raising this number.
    .slice(0, mobileFirst ? 4 : 3);

  // A field role with no bar is a bug worth surfacing as "no bar"; a desk role
  // with no derived destinations still gets Menu, which is the whole sidebar.
  if (items.length === 0 && mobileFirst) return null;

  const isActive = (to: string) =>
    to === "/" ? currentPath === "/" : currentPath === to || currentPath.startsWith(to + "/");

  // Chat lives behind Menu for field roles now, and for a desk role whose
  // three tabs it did not make. Without this, a crew member would have no way
  // to know a message was waiting short of opening the sidebar to look.
  const chatBehindMenu = unreadChats > 0 && !items.some((i) => i.to === "/chat");

  // min-h-14 + pb-safe: 56px of bar is a comfortable thumb target for a gloved
  // hand, and the safe-area padding keeps it off the iOS home indicator rather
  // than under it.
  const cell =
    "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 border-t-2 px-1 py-2 text-[11px] leading-tight";

  return (
    <nav
      data-mobile-bottom-nav
      data-condensed={condensed ? "true" : undefined}
      className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-card pb-safe px-safe transition-transform duration-200 data-[condensed=true]:translate-y-full md:hidden"
    >
      {items.map((n) => {
        const Icon = n.icon;
        const active = isActive(n.to);
        return (
          <Link
            key={n.to}
            to={n.to as string}
            search={{} as never}
            className={cn(
              cell,
              active
                ? "border-primary font-semibold text-primary"
                : "border-transparent text-muted-foreground",
            )}
          >
            <Icon className="size-5" />
            <span className="max-w-full truncate">{t(n.label)}</span>
          </Link>
        );
      })}
      {/*
       * Menu for field roles too. Their bar was four fixed tabs with no way
       * into the sidebar except the top-left trigger, which hides while
       * scrolling — so Equipment, Pictures, Tasks, Sign out and "Install app"
       * (the user menu lives in the sidebar footer) were the far corner of the
       * screen from a thumb for exactly the people who are always on a phone.
       * Mark: "iphone and android, should be a way to install it". Five cells
       * are 72px each at 360px wide.
       */}
      <button
        type="button"
        onClick={() => setOpenMobile(true)}
        aria-label={chatBehindMenu ? `Menu, ${unreadChats} unread messages` : undefined}
        className={cn(cell, "border-transparent text-muted-foreground")}
      >
        <span className="relative">
          <PanelLeft className="size-5" />
          {chatBehindMenu && (
            <span
              data-unread-dot
              aria-hidden
              className="absolute -right-1 -top-1 size-2.5 rounded-full bg-primary ring-2 ring-card"
            />
          )}
        </span>
        <span>{t("Menu")}</span>
      </button>
    </nav>
  );
}
