/**
 * SETTINGS HUB REGISTRY — the one list behind /admin
 * ===================================================
 *
 * Every screen under `/admin` is registered here once, with the area it
 * belongs to, a one-line description and the words someone might type when
 * looking for it. The layout's rail, the hub index cards, the breadcrumb and
 * the search box all read this list, so a page cannot be in the rail but
 * missing from search, or findable but breadcrumb-less.
 *
 * `admin-settings.test.ts` reads the routes directory and fails when an
 * `admin.*.tsx` route has no entry: a new settings page has to be given a home
 * before it ships.
 *
 * This module is free of React. It says nothing about WHO may open a page —
 * that decision belongs to `page-access.ts`, and `visibleSettingsPages` just
 * asks its resolver. There is deliberately no second access rule in here.
 *
 * TWO WORDS FOR TWO JOBS, since 2026-09-28:
 *  - SECTION is where a page sits in the navigation — Operations, Sales or
 *    System — and it is decided by ONE mapping, `SETTINGS_SECTION_LAYOUT`
 *    below. The rail, the hub cards and the breadcrumb read it.
 *  - AREA is what kind of page it is (People & access, Rates & catalogs, …).
 *    It no longer draws any navigation; it stays on each page so search keeps
 *    matching the words it matched before the regroup, and so a search result
 *    keeps its icon. Nobody should need to touch it to move a page.
 */

export type SettingsAreaId =
  | "people"
  | "organisation"
  | "sales"
  | "documents"
  | "rates"
  | "automation"
  | "reference"
  | "developer";

export type SettingsArea = {
  id: SettingsAreaId;
  label: string;
  /** One line under the area name on the hub index. */
  blurb: string;
};

/** Display order. Roughly: who → where → what we sell → paperwork → prices → plumbing. */
export const SETTINGS_AREAS: readonly SettingsArea[] = [
  {
    id: "people",
    label: "People & access",
    blurb: "Staff accounts, what each role can reach, pay terms and sign-in security.",
  },
  {
    id: "organisation",
    label: "Organization",
    blurb: "Offices, the regions they roll up to, and the markets chasers cover.",
  },
  {
    id: "sales",
    label: "Sales",
    blurb: "How deals move: pipeline stages, visit outcomes, client health and labels.",
  },
  {
    id: "documents",
    label: "Documents & messaging",
    blurb: "Contract and email templates with merge fields.",
  },
  {
    id: "rates",
    label: "Rates & catalogs",
    blurb: "Labor and equipment rates, estimate line items, supply items and gift costs.",
  },
  {
    id: "automation",
    label: "Automation & integrations",
    blurb: "Rules that create tasks or escalate, and every external connection.",
  },
  {
    id: "reference",
    label: "Reference data",
    blurb: "The choices behind dropdowns and the intake questionnaire.",
  },
  {
    id: "developer",
    label: "Developer",
    blurb: "Demo records and QA accounts. Not for day-to-day administration.",
  },
];

export const SETTINGS_AREA_BY_ID: ReadonlyMap<SettingsAreaId, SettingsArea> = new Map(
  SETTINGS_AREAS.map((a) => [a.id, a]),
);

// ------------------------------------------------------------------ sections

export type SettingsSectionId = "operations" | "sales" | "system";

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  /** One line under the section name on the hub index. */
  blurb: string;
};

/**
 * David, 22 Sep: "when I'm dealing with operations I don't need gifting and
 * all that... operational stuff and then sales stuff." Three sections, in
 * this order. His own detailed list has not arrived yet; see the layout below.
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "operations",
    label: "Operations",
    blurb: "Running jobs: supplies, equipment and labor rates, catalogs and job setup.",
  },
  {
    id: "sales",
    label: "Sales",
    blurb: "Winning and keeping work: pipelines, the leaderboard, gifting, chase and commissions.",
  },
  {
    id: "system",
    label: "System",
    blurb: "People and access, offices, email, automations, integrations and the rest.",
  },
];

export const SETTINGS_SECTION_BY_ID: ReadonlyMap<SettingsSectionId, SettingsSection> = new Map(
  SETTINGS_SECTIONS.map((s) => [s.id, s]),
);

/**
 * THE ONE MAPPING: which settings page sits in which section, in display order.
 *
 * Grouped by the project's own logic for now (decided 2026-09-28, pending
 * David's list). When his list lands, it is an edit to these three arrays and
 * nothing else — move a path between them, reorder within one. The URLs, the
 * pages, their search words and who may open them are untouched by it.
 * `admin-settings.test.ts` fails if a top-level page is missing here or listed
 * twice, so a move cannot lose a page.
 *
 * Sub-pages (`parent`) are not listed: they sit wherever their parent does.
 *
 * Calls made while grouping, for David to overrule:
 *  - Tags are labels on leads, jobs, accounts and photos — CRM that serves
 *    both sides — so they sit under Sales, once, per the rule for such items.
 *  - Dropdown options and Intake questions are job setup (job types, statuses,
 *    the job number, the incoming-job questionnaire), so Operations.
 *  - Territory (markets, ZIP zones, chaser dispatch) and Outcome reasons are
 *    the chase, so Sales.
 *  - Follow-up and Escalation rules are automations, so System beside
 *    Automations, even though follow-ups fire on a rep's activity.
 *  - People and pay (salary, draw, per-person commission split) stays with
 *    Users in System; the Commissions page — the sources a job's commission
 *    is picked from — is Sales.
 *  - Fleet, drying and trade shows have no settings screen to place yet.
 */
export const SETTINGS_SECTION_LAYOUT: Readonly<Record<SettingsSectionId, readonly string[]>> = {
  operations: [
    "/admin/supply-catalog",
    "/admin/job-checklists",
    "/admin/billing-costs",
    // Folded into Billing & Costs (prompt 3): hidden from the rail for anyone
    // who can open it, and their addresses redirect there.
    "/admin/tm-rate-codes",
    "/admin/equipment-rates",
    "/admin/estimate-catalog",
    "/admin/price-lists",
    "/admin/option-lists",
    "/admin/intake-questions",
  ],
  sales: [
    "/admin/pipelines",
    "/admin/scorecard",
    "/admin/gift-catalog",
    "/admin/territory",
    "/admin/fire-feed",
    "/admin/outcome-reasons",
    "/admin/client-health",
    "/admin/commissions",
    "/admin/tags",
  ],
  system: [
    "/admin/users",
    "/admin/permissions",
    "/admin/field-permissions",
    "/admin/people",
    "/admin/payroll",
    "/admin/offboarding",
    "/admin/security",
    "/admin/locations",
    "/admin/regions",
    "/admin/email-templates",
    "/admin/templates",
    "/admin/automations",
    "/admin/followup-rules",
    "/admin/escalations",
    "/admin/integrations",
    "/admin/ai-credits",
    "/admin/demo",
    "/admin/test-users",
  ],
};

/** path → [section, position], from the layout above. */
const SECTION_SLOT: ReadonlyMap<string, readonly [SettingsSectionId, number]> = new Map(
  (Object.entries(SETTINGS_SECTION_LAYOUT) as [SettingsSectionId, readonly string[]][]).flatMap(
    ([section, paths]) => paths.map((path, i) => [path, [section, i] as const] as const),
  ),
);

export type SettingsPage = {
  /**
   * Route path. A `$param` segment matches any one segment, exactly as the
   * route file does (`admin.users.$userId.tsx` → `/admin/users/$userId`).
   */
  path: string;
  label: string;
  area: SettingsAreaId;
  /** One line. Shown under the title, on the hub card and in search results. */
  description: string;
  /** What someone types when hunting for this page — contents, synonyms, US/UK spellings. */
  keywords: readonly string[];
  /**
   * A screen reached from another settings page rather than from the rail
   * (a user's edit form, the Microsoft 365 sync detail). Breadcrumbs pass
   * through the parent; the rail and hub cards do not list it.
   */
  parent?: string;
  /**
   * For anyone who can open the named page, this one is a tab inside it and
   * is not listed separately. Field permissions lives as a tab on Access for
   * administrators, while sales leadership reach it only by its own route.
   */
  foldedInto?: string;
};

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  // ------------------------------------------------------------ People & access
  {
    path: "/admin/users",
    label: "Users",
    area: "people",
    description: "Invite staff, set roles and home locations, approve or deactivate accounts.",
    keywords: [
      "staff",
      "employees",
      "accounts",
      "invite",
      "roles",
      "deactivate",
      "pending",
      "approve",
      "sign-in",
      "view as",
      "email",
      "home location",
    ],
  },
  {
    path: "/admin/users/$userId",
    label: "Edit user",
    area: "people",
    parent: "/admin/users",
    description: "One person's roles, locations and contact details.",
    keywords: ["profile", "job title", "phone", "roles", "locations"],
  },
  {
    path: "/admin/people",
    label: "People",
    area: "people",
    description:
      "Everyone at Gold Star by stage, with each person's pay and commission, book of accounts and offboarding.",
    keywords: [
      "people",
      "staff",
      "employees",
      "hire",
      "hiring",
      "interviewing",
      "onboarding",
      "fire",
      "former",
      "payroll",
      "pay",
      "commission",
      "commission tiers",
      "salary",
      "draw",
      "reassign book",
      "reassign a book",
      "leaver",
      "offboarding",
      "lockout",
    ],
  },
  {
    path: "/admin/people/$userId",
    label: "Person",
    area: "people",
    parent: "/admin/people",
    description: "One person's stage, pay and commission, book of accounts and offboarding.",
    keywords: ["profile", "stage", "pay", "commission", "book", "offboarding"],
  },
  {
    path: "/admin/payroll",
    label: "People and pay",
    area: "people",
    // 6 Nov (Melly): retired; the address redirects to People.
    foldedInto: "/admin/people",
    description:
      "Sales type, salary or hourly rate, draw and per-source commission for each person, with effective dates.",
    keywords: [
      "payroll",
      "pay",
      "commission",
      "salary",
      "draw",
      "hourly rate",
      "compensation",
      "pay structure",
      "deal source",
      "effective from",
      "sales type",
    ],
  },
  {
    path: "/admin/offboarding",
    label: "Offboarding",
    area: "people",
    // 6 Nov (Melly): retired; the address redirects to People › Offboarding.
    foldedInto: "/admin/people",
    description: "Lock a leaver out in one action and track the hand-over checklist.",
    keywords: [
      "leaver",
      "left the company",
      "terminate",
      "revoke access",
      "lockout",
      "transfer number",
      "reassign book",
      "checklist",
      "mailbox",
      "card",
    ],
  },
  {
    path: "/admin/permissions",
    label: "Access",
    area: "people",
    description:
      "Which pages each role reaches, what a person gets on top of their role, and which job fields are visible.",
    keywords: [
      "permissions",
      "roles",
      "pages",
      "grant",
      "revoke",
      "capabilities",
      "page access",
      "field permissions",
      "who can see",
    ],
  },
  {
    path: "/admin/field-permissions",
    label: "Field permissions",
    area: "people",
    foldedInto: "/admin/permissions",
    description: "Which job fields each role can see. Enforced in the database, not just hidden.",
    keywords: ["job fields", "field visibility", "hide fields", "columns", "sales leadership"],
  },
  {
    path: "/admin/security",
    label: "Security",
    area: "people",
    description: "Two-factor adoption across staff, authenticator resets and sign-in protection.",
    keywords: [
      "2fa",
      "two-factor",
      "two factor",
      "mfa",
      "authenticator",
      "reset",
      "turnstile",
      "bot check",
      "captcha",
      "login",
      "sign-in",
      "password",
      "last sign-in",
      // TODO(remove after cutover): the Owner's storage file list for the move.
      "storage export",
      "file list",
      "new server",
    ],
  },

  // -------------------------------------------------------------- Organisation
  {
    path: "/admin/locations",
    label: "Locations",
    area: "organisation",
    description: "Offices: code, address, legal entity, manager, card payment link and logo.",
    keywords: [
      "office",
      "offices",
      "branch",
      "address",
      "ein",
      "legal entity",
      "logo",
      "phone",
      "manager email",
      "card payment url",
      "map",
      "coordinates",
      "location code",
    ],
  },
  {
    path: "/admin/regions",
    label: "Regions",
    area: "organisation",
    description: "Group offices into regions for reporting and regional managers.",
    keywords: ["region", "group locations", "mid-atlantic", "reporting", "regional manager"],
  },
  {
    path: "/admin/territory",
    label: "Territory",
    area: "organisation",
    description:
      "Markets, ZIP zones, which chasers are dispatched into each market, and which office an intake form goes to by state or ZIP.",
    keywords: [
      "intake office rules",
      "intake routing",
      "state rule",
      "office by state",
      "market",
      "markets",
      "zip",
      "zip codes",
      "zone",
      "zones",
      "chaser",
      "dispatch",
      "adjacency",
      "shift hours",
      "coverage",
      "chase",
    ],
  },

  {
    // Mark: "a feed that crawls google and x for fires in certain areas …
    // in place of bnn", then "I don't want to pay API fees." It feeds the
    // chase, so it sits beside Territory.
    path: "/admin/fire-feed",
    label: "Fire feed",
    area: "organisation",
    description:
      "Gold Star's own fire alerts in place of BNN: the towns to watch, free sources (Google News, RSS feeds), and what each run found.",
    keywords: [
      "bnn",
      "fire alerts",
      "fire leads",
      "news",
      "google news",
      "rss",
      "atom",
      "feed",
      "fire department",
      "watch areas",
      "towns",
      "incidents",
      "chase",
      "scanner",
      "breaking news",
    ],
  },

  // --------------------------------------------------------------------- Sales
  {
    path: "/admin/pipelines",
    label: "Pipelines",
    area: "sales",
    description: "Stage names, order, colors, probabilities, WIP limits and automatic progression.",
    keywords: [
      "stages",
      "stage",
      "deal",
      "deals",
      "funnel",
      "probability",
      "wip limit",
      "auto-advance",
      "lead approval",
      "sales head approval",
      "kanban",
      "won",
      "lost",
    ],
  },
  {
    path: "/admin/outcome-reasons",
    label: "Outcome reasons",
    area: "sales",
    description: "What a chaser records after a visit, and whether the lead survives it.",
    keywords: [
      "chase",
      "visit",
      "outcome",
      "decline",
      "lost reason",
      "not interested",
      "assignment rules",
      "chaser",
    ],
  },
  {
    path: "/admin/scorecard",
    label: "Scorecard and points",
    area: "sales",
    description:
      "Which actions earn leaderboard points, their weights and targets — company-wide or per office.",
    keywords: [
      "leaderboard",
      "points",
      "scorecard",
      "weights",
      "targets",
      "kpi",
      "kpis",
      "components",
      "actions",
      "cold calls",
      "intelligence",
      "minimum activity",
      "ranking",
    ],
  },
  {
    path: "/admin/client-health",
    label: "Client health",
    area: "sales",
    description:
      "Days since the last touchpoint before an active client counts as Watch or At Risk.",
    keywords: [
      "at risk",
      "watch",
      "touchpoint",
      "farming",
      "active clients",
      "thresholds",
      "days since",
      "health",
    ],
  },
  {
    path: "/admin/tags",
    label: "Tags",
    area: "sales",
    description:
      "Labels reps put on leads, jobs, accounts and photos: names, colors and who may create them.",
    keywords: [
      "labels",
      "label",
      "colour",
      "color",
      "lead labels",
      "scopes",
      "job labels",
      "photo labels",
      "who can create",
    ],
  },

  // ------------------------------------------------------ Documents & messaging
  {
    path: "/admin/templates",
    label: "Contract templates",
    area: "documents",
    description: "Versioned contract and work authorization templates with merge fields.",
    keywords: [
      "contract",
      "contracts",
      "work authorization",
      "work authorization",
      "signature",
      "e-sign",
      "merge fields",
      "document type",
      "versions",
      "change note",
    ],
  },
  {
    path: "/admin/email-templates",
    label: "Email templates",
    area: "documents",
    description: "Rich-text emails with merge keys that fill in from the job at send time.",
    keywords: ["email", "emails", "subject", "body", "merge keys", "category", "send"],
  },

  // ---------------------------------------------------------- Rates & catalogs
  {
    // Billing & Costs rebuild (29 Oct): one home for every price and cost.
    // T&M rate codes and Cost rates are folded in (prompt 3); Estimate
    // catalog and Price lists stay listed until Client Agreements (prompt 4).
    path: "/admin/billing-costs",
    label: "Billing & Costs",
    area: "rates",
    description:
      "Every price and cost in one place — general rates, T&M rates and rules, cost and cost rules, and the item catalogs.",
    keywords: [
      "billing",
      "costs",
      "billing and costs",
      "catalog",
      "catalogs",
      "items",
      "labor",
      "consumables",
      "ppe",
      "vehicle",
      "units",
      "rate codes",
      "archive",
    ],
  },
  {
    // The Labor tab of Cost rates, at its old address (23 Oct). Billing &
    // Costs prompt 3: redirects to Billing & Costs › Cost › Labor.
    path: "/admin/labour-rates",
    label: "Labor rates",
    area: "rates",
    parent: "/admin/equipment-rates",
    description:
      "What the crew costs — now Billing & Costs › Cost (the overhead engine); the charge rates are under Client Agreements.",
    keywords: ["labour", "labor", "hourly", "wage", "crew rate", "charge rate", "bill rate"],
  },
  {
    path: "/admin/equipment-rates",
    label: "Cost rates",
    area: "rates",
    // Billing & Costs prompt 3: retired; the address redirects to the Cost tab.
    foldedInto: "/admin/billing-costs",
    // David, 23 Oct: one menu item, three tabs — Labor, Materials & supplies,
    // Equipment — each with what it costs and what it is charged. Labor rates
    // is its Labor tab now (the old address still opens it).
    description:
      "Labor, materials & supplies and equipment — what each costs us and what it is charged to the customer.",
    keywords: [
      "labour",
      "labor",
      "labor rates",
      "hourly",
      "wage",
      "crew rate",
      "technician",
      "charge rate",
      "bill rate",
      "charge",
      "materials",
      "equipment",
      "daily rate",
      "supplies",
      "supply",
      "unit cost",
      "margin",
      "minimum margin",
      "dehumidifier",
      "air mover",
      "running cost",
      "equipment catalog",
    ],
  },
  {
    path: "/admin/estimate-catalog",
    label: "Estimate catalog",
    area: "rates",
    // Billing & Costs prompt 4: merged into Catalogs; the address redirects.
    foldedInto: "/admin/billing-costs",
    description: "Headers and line items estimators pick from when building a scope.",
    keywords: [
      "estimate",
      "estimates",
      "line items",
      "scope",
      "job calculator",
      "price list",
      "codes",
      "headers",
      "xactimate",
    ],
  },
  {
    path: "/admin/price-lists",
    // Billing & Costs prompt 4: agreements moved to Client Agreements; state
    // lists are still edited here, so the page stays (reached by its address
    // and search, folded under Billing & Costs in the rail).
    foldedInto: "/admin/billing-costs",
    label: "Price lists",
    area: "rates",
    description:
      "Customer agreements and per-office rates that override the default estimate catalog price.",
    keywords: [
      "price list",
      "price lists",
      "pricing",
      "agreement",
      "customer pricing",
      "client pricing",
      "override",
      "discount",
      "contract rate",
      "state pricing",
      "upload prices",
      "import prices",
    ],
  },
  {
    // David, 22 Sep: "if we could have that items catalog here, that'll be
    // great." The same editor as the Supplies page's Catalog tab.
    path: "/admin/supply-catalog",
    label: "Supply catalog",
    area: "rates",
    description:
      "The supply items crews order — names, sizes, packs and the categories the request form groups by.",
    keywords: [
      "supplies",
      "supply",
      "items",
      "items catalog",
      "purchasing",
      "purchasing list",
      "order form",
      "categories",
      "gloves",
      "consumables",
      "inventory",
    ],
  },
  {
    // Mark, with a screenshot of the Supply catalog: "like this for tasks".
    // The lines each job type puts on a job, edited the catalog's way.
    path: "/admin/job-checklists",
    label: "Job checklists",
    area: "automation",
    description:
      "The tasks each job type puts on a job automatically — add, rename, reorder or switch off a line.",
    keywords: [
      "tasks",
      "task list",
      "checklist",
      "checklists",
      "job tasks",
      "automatic tasks",
      "task templates",
      "monitoring",
      "pick up equipment",
      "water",
      "mold",
      "fire",
      "extraction",
      "remediation",
    ],
  },
  {
    // Mark, 7 Oct: "for a T&M job, there is a sign in sheet, rate codes and
    // the three pages that are used for each day." The Daily Supply List's
    // codes — the ones T&M Pro bills with — edited like Job checklists.
    path: "/admin/tm-rate-codes",
    label: "T&M rate codes",
    area: "rates",
    // Billing & Costs prompt 3: retired; the address redirects to T&M Rates.
    foldedInto: "/admin/billing-costs",
    description:
      "The codes on the T&M Daily Supply List and sign-in sheet — labor, consumables, equipment, PPE, vehicles.",
    keywords: [
      "t&m",
      "t & m",
      "time and materials",
      "rate code",
      "rate codes",
      "labor class",
      "t&m pro",
      "supply list",
      "daily supply list",
      "sign in sheet",
      "apm",
      "crew chief",
    ],
  },
  {
    // David, 24 Sep: "Mark Adelman gets 20%, Nissen Goldstein gets 15%. I just
    // have a dropdown, I select his name and his rate automatically deducts."
    path: "/admin/commissions",
    label: "Commissions",
    area: "rates",
    description:
      "Deals with referring companies and people (percent or flat fee), and the named people and roles a job's commission falls back to.",
    keywords: [
      "commission",
      "referrer",
      "referring company",
      "flat fee",
      "commissions",
      "commission rate",
      "salesman",
      "broker",
      "public adjuster",
      "pa",
      "referral",
      "rates",
    ],
  },
  {
    path: "/admin/gift-catalog",
    label: "Gift catalog",
    area: "rates",
    description: "Items, vendors and unit costs used by farming gift campaigns.",
    keywords: ["gifts", "gift", "fruit basket", "vendor", "campaign", "farming", "unit cost"],
  },

  // ------------------------------------------------- Automation & integrations
  {
    path: "/admin/automations",
    label: "Automations",
    area: "automation",
    description: "Rotting-deal rules, reminders and the internal tasks they create per trigger.",
    keywords: [
      "rules",
      "trigger",
      "rotting",
      "rot window",
      "stalled",
      "reminders",
      "tasks",
      "task automation",
      "priority flag",
    ],
  },
  {
    path: "/admin/followup-rules",
    label: "Follow-up rules",
    area: "automation",
    description: "The next task created for a rep after they log an activity.",
    keywords: ["follow-up", "follow up", "next task", "activity", "recap", "due in days"],
  },
  {
    path: "/admin/escalations",
    label: "Escalation rules",
    area: "automation",
    description:
      "Per location: how many quiet days before an estimate, invoice, job or lead escalates to a named person.",
    keywords: [
      "escalate",
      "escalation",
      "stalled",
      "quiet",
      "gone quiet",
      "invoice",
      "estimate",
      "named person",
      "location",
      "statuses to watch",
    ],
  },
  {
    path: "/admin/integrations",
    label: "Integrations",
    area: "automation",
    description: "Every external connection in one place, with whether data is actually arriving.",
    keywords: [
      "api",
      "api key",
      "keys",
      "webhook",
      "inbound endpoint",
      "microsoft 365",
      "google maps",
      "callrail",
      "companycam",
      "bnn",
      "fire alert",
      "fire feed",
      "google news",
      "replaces bnn",
      "e-signature",
      "email marketing",
      "dialer",
      "ai gateway",
      "sync",
      "status",
    ],
  },
  {
    path: "/admin/ai-credits",
    label: "AI credits",
    area: "automation",
    description:
      "Polaris, dictation, voice notes and document reading run on prepaid credits (100 credits = $1).",
    keywords: [
      "ai",
      "credits",
      "ai credits",
      "top up",
      "top-up",
      "balance",
      "polaris",
      "billing",
      "falcon",
      "stripe",
      "usage",
    ],
  },
  {
    path: "/admin/integrations/outlook",
    label: "Microsoft 365 sync",
    area: "automation",
    parent: "/admin/integrations",
    description: "Mailbox and calendar sync through Graph, and which mailboxes are synced.",
    keywords: [
      "outlook",
      "exchange",
      "graph",
      "mailbox",
      "mailboxes",
      "calendar",
      "email sync",
      "subscriptions",
      "shared office mailbox",
    ],
  },

  // ------------------------------------------------------------ Reference data
  {
    path: "/admin/option-lists",
    label: "Dropdown options",
    area: "reference",
    description:
      "The choices behind every dropdown — job types, loss types, statuses, sources — plus the job number format.",
    keywords: [
      "options",
      "dropdown",
      "dropdowns",
      "picklist",
      "lists",
      "job type",
      "insurance kind",
      "loss type",
      "water",
      "fire",
      "mold",
      "mould",
      "reconstruction",
      "loss description",
      "job status",
      "referral source",
      "contact role",
      "decision role",
      "position",
      "equipment type",
      "reported source",
      "competitor",
      "tpa",
      "decline reason",
      "lead source",
      "job number format",
      "prefix",
      "counter",
      "other free text",
      "carriers",
    ],
  },
  {
    path: "/admin/intake-questions",
    label: "Intake questions",
    area: "reference",
    description:
      "The questionnaire asked on every incoming job — question text, answer type and order.",
    keywords: [
      "intake",
      "questionnaire",
      "incoming job",
      "form",
      "questions",
      "choices",
      "how did this job arrive",
    ],
  },

  // ----------------------------------------------------------------- Developer
  {
    path: "/admin/demo",
    label: "Demo data",
    area: "developer",
    description: "Sample records for demonstrations, flagged so removal is one action.",
    keywords: ["sample", "seed", "demo", "remove demo", "fixtures", "demonstration"],
  },
  {
    path: "/admin/test-users",
    label: "Test users",
    area: "developer",
    description: "Seeded QA accounts with one-click View As for each scoped role.",
    keywords: ["qa", "view as", "impersonate", "role testing", "seeded accounts", "test"],
  },
];

export const SETTINGS_PAGE_BY_PATH: ReadonlyMap<string, SettingsPage> = new Map(
  SETTINGS_PAGES.map((p) => [p.path, p]),
);

/**
 * The section a page sits in: its own slot in the layout, else its parent's.
 * A page the layout forgot lands in System rather than vanishing from the
 * navigation — and the registry test fails, so it does not stay forgotten.
 */
export function settingsSectionOf(page: SettingsPage): SettingsSection {
  let cursor: SettingsPage | undefined = page;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.path)) {
    const slot = SECTION_SLOT.get(cursor.path);
    if (slot) return SETTINGS_SECTION_BY_ID.get(slot[0])!;
    seen.add(cursor.path);
    cursor = cursor.parent ? SETTINGS_PAGE_BY_PATH.get(cursor.parent) : undefined;
  }
  return SETTINGS_SECTION_BY_ID.get("system")!;
}

/** The hub itself. Registered here so the breadcrumb root has a label and a link. */
export const SETTINGS_ROOT = { path: "/admin", label: "Settings" } as const;

// ----------------------------------------------------------------- matching

function normalisePath(p: string): string {
  const noQuery = p.split("?")[0].split("#")[0];
  const trimmed = noQuery.length > 1 && noQuery.endsWith("/") ? noQuery.slice(0, -1) : noQuery;
  return trimmed || "/";
}

function segments(p: string): string[] {
  return normalisePath(p).split("/").filter(Boolean);
}

/**
 * Does `pattern` own `pathname`? Exact segment match, `$param` matches any one
 * segment, and a pattern owns everything beneath it (so `/admin/users` owns
 * `/admin/users/abc` unless a longer pattern claims it).
 */
export function settingsPathMatches(pattern: string, pathname: string): boolean {
  const want = segments(pattern);
  const have = segments(pathname);
  if (have.length < want.length) return false;
  return want.every((seg, i) => seg.startsWith("$") || seg === have[i]);
}

/** Longest-pattern match, or null for `/admin` itself and anything unregistered. */
export function settingsPageForPath(pathname: string): SettingsPage | null {
  let best: SettingsPage | null = null;
  for (const page of SETTINGS_PAGES) {
    if (!settingsPathMatches(page.path, pathname)) continue;
    if (!best || segments(page.path).length > segments(best.path).length) best = page;
  }
  return best;
}

export type SettingsBreadcrumb = {
  section: SettingsSection;
  /** Ancestors first, the current page last. */
  trail: SettingsPage[];
};

/**
 * Settings › Section › [Parent › …] › Page. Null on the hub index or an
 * unregistered path, where the layout shows the plain "Settings" title.
 */
export function settingsBreadcrumb(pathname: string): SettingsBreadcrumb | null {
  const page = settingsPageForPath(pathname);
  if (!page) return null;
  const trail: SettingsPage[] = [page];
  let cursor: SettingsPage | undefined = page;
  const seen = new Set<string>([page.path]);
  while (cursor?.parent) {
    const parent = SETTINGS_PAGE_BY_PATH.get(cursor.parent);
    if (!parent || seen.has(parent.path)) break;
    seen.add(parent.path);
    trail.unshift(parent);
    cursor = parent;
  }
  return { section: settingsSectionOf(page), trail };
}

// --------------------------------------------------------------- visibility

/**
 * The pages a person is offered in the rail, the hub cards and search.
 *
 * `canOpen` is `useMyPageAccess().canOpen` — the same resolver the route gate
 * enforces — so nobody is ever shown a link that lands on a refusal, and the
 * narrowing for sales leadership (who reach exactly Field permissions) falls
 * out of the page catalogue rather than being restated here.
 *
 * Sub-pages (`parent`) are reached from their parent, not listed. A page that
 * is `foldedInto` another is hidden from anyone who can open that other page.
 */
export function visibleSettingsPages(canOpen: (path: string) => boolean): SettingsPage[] {
  return SETTINGS_PAGES.filter((p) => {
    if (p.parent) return false;
    if (!canOpen(p.path)) return false;
    if (p.foldedInto && canOpen(p.foldedInto)) return false;
    return true;
  });
}

/** Sub-pages that can be searched for: every openable page that is not parameterised. */
export function searchableSettingsPages(canOpen: (path: string) => boolean): SettingsPage[] {
  const listed = new Set(visibleSettingsPages(canOpen).map((p) => p.path));
  return SETTINGS_PAGES.filter((p) => {
    if (listed.has(p.path)) return true;
    if (!p.parent) return false;
    if (p.path.includes("$")) return false;
    return canOpen(p.path);
  });
}

export type SettingsGroup = { section: SettingsSection; pages: SettingsPage[] };

/**
 * Pages bucketed by section, sections in display order and pages in layout
 * order. Sections with nothing to show are dropped.
 */
export function groupSettingsPages(pages: readonly SettingsPage[]): SettingsGroup[] {
  const pos = (p: SettingsPage) => SECTION_SLOT.get(p.path)?.[1] ?? Number.MAX_SAFE_INTEGER;
  return SETTINGS_SECTIONS.map((section) => ({
    section,
    pages: pages
      .filter((p) => settingsSectionOf(p).id === section.id)
      .sort((a, b) => pos(a) - pos(b)),
  })).filter((g) => g.pages.length > 0);
}

// ------------------------------------------------------------------- search

export type SettingsSearchHit = {
  page: SettingsPage;
  score: number;
  /** Which part matched, so the result row can say why it is there. */
  matched: "label" | "keyword" | "area" | "description";
};

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019\u00b4\u0060]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2010-\u2015]/g, "-");
}

function tokens(q: string): string[] {
  return fold(q)
    .split(/[\s,/]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Does `hay` contain `needle` at the start of a word? "recon" matches "reconstruction". */
function wordPrefix(hay: string, needle: string): boolean {
  if (hay.startsWith(needle)) return true;
  return hay.includes(" " + needle) || hay.includes("-" + needle);
}

function scoreToken(
  page: SettingsPage,
  groupLabels: string,
  tok: string,
): SettingsSearchHit["matched"] | null {
  const label = fold(page.label);
  if (label === tok || wordPrefix(label, tok)) return "label";
  if (label.includes(tok)) return "label";
  for (const k of page.keywords) {
    const kk = fold(k);
    if (kk === tok || wordPrefix(kk, tok) || kk.includes(tok)) return "keyword";
  }
  if (wordPrefix(fold(groupLabels), tok)) return "area";
  if (fold(page.description).includes(tok)) return "description";
  return null;
}

const WEIGHT: Record<SettingsSearchHit["matched"], number> = {
  label: 100,
  keyword: 40,
  area: 15,
  description: 10,
};

/**
 * Find settings pages by name or by what they contain.
 *
 * Every token in the query has to match the page somewhere (label, keyword,
 * area or description), so "email template" narrows rather than widens. A
 * title match outranks a keyword match, which outranks an area or description
 * match; ties keep registry order so results are stable.
 */
export function searchSettingsPages(
  query: string,
  pages: readonly SettingsPage[],
  limit = 8,
): SettingsSearchHit[] {
  const toks = tokens(query);
  if (toks.length === 0) return [];
  const hits: SettingsSearchHit[] = [];
  for (const page of pages) {
    // The old area's name AND the new section's: "developer" or "rates" still
    // finds what it found before the regroup, and "operations" now works too.
    const areaLabel = `${SETTINGS_AREA_BY_ID.get(page.area)?.label ?? ""} ${settingsSectionOf(page).label}`;
    let score = 0;
    let best: SettingsSearchHit["matched"] | null = null;
    let all = true;
    for (const tok of toks) {
      const m = scoreToken(page, areaLabel, tok);
      if (!m) {
        all = false;
        break;
      }
      score += WEIGHT[m];
      if (!best || WEIGHT[m] > WEIGHT[best]) best = m;
    }
    if (!all || !best) continue;
    // A whole-label match ("tags") beats a page that merely mentions the word.
    if (fold(page.label) === toks.join(" ")) score += 50;
    hits.push({ page, score, matched: best });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
