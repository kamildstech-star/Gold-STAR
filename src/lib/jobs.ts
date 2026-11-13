import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { TONE } from "@/lib/tone";
export const JOB_LOSS_TYPES = [
  "water",
  "fire",
  "smoke",
  "sewer",
  "mold",
  "biohazard",
  "storm",
  "cleaning",
] as const;
export type JobLossType = (typeof JOB_LOSS_TYPES)[number];

export const JOB_STATUSES = [
  "new",
  "scheduled",
  "in_progress",
  "drying",
  "complete",
  "invoiced",
  "paid",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const OPEN_JOB_STATUSES: JobStatus[] = ["new", "scheduled", "in_progress", "drying"];

export const JOB_LOSS_LABELS: Record<JobLossType, string> = {
  water: "Water",
  fire: "Fire",
  smoke: "Smoke",
  sewer: "Sewer",
  mold: "Mold",
  biohazard: "Biohazard",
  storm: "Storm",
  cleaning: "Cleaning",
};

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  new: "New",
  scheduled: "Scheduled",
  in_progress: "In progress",
  drying: "Drying",
  complete: "Complete",
  invoiced: "Invoiced",
  paid: "Paid",
  cancelled: "Canceled",
};

export const JOB_STATUS_TONE: Record<JobStatus, string> = {
  new: TONE.info,
  scheduled: TONE.brand,
  in_progress: TONE.warning,
  drying: TONE.info,
  complete: TONE.success,
  invoiced: TONE.brand,
  paid: TONE.success,
  cancelled: TONE.neutral,
};

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

/**
 * Job type is now *how the work is paid for*, not what kind of work it is —
 * the service categories moved to loss type. Both live in managed option
 * lists (`job_type`, `loss_type`); these constants are a fallback only, for
 * the moment before the lists load.
 */
export const PAYMENT_TYPES = ["insurance", "cash", "reconstruction"] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

export const PAYMENT_TYPE_LABELS: Record<string, string> = {
  insurance: "Insurance",
  cash: "Cash",
  reconstruction: "Reconstruction",
};

export const CUSTOMER_KINDS = ["person", "company"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];

/** Restoration staffing roles — each answers a different question about a job. */
export const JOB_ASSIGNMENT_ROLES = [
  "lead_technician",
  "technician",
  "crew_chief",
  "account_rep",
  "project_manager",
  "estimator",
  "collector",
] as const;
export type JobAssignmentRole = (typeof JOB_ASSIGNMENT_ROLES)[number];

export const JOB_ASSIGNMENT_ROLE_LABELS: Record<string, string> = {
  lead_technician: "Lead Technician",
  technician: "Technician",
  crew_chief: "Crew Chief",
  account_rep: "Account Rep",
  project_manager: "Project Manager",
  estimator: "Estimator",
  collector: "Collector",
};

export const CONTACT_LABELS = ["Main", "Mobile", "Work", "Home", "Office", "Billing", "Other"];

export const CLOSED_STATUSES: JobStatus[] = ["complete", "invoiced", "paid", "cancelled"];

export type JobColumnKey =
  | "job_number"
  | "codes"
  | "job_name"
  | "job_type"
  | "status"
  | "call_date"
  | "loss_date"
  | "customer_name"
  | "address"
  | "locality"
  | "region"
  | "postal_code"
  | "county"
  | "loss_type"
  | "reported_source"
  | "insurance_carrier"
  | "estimated_amount"
  | "billed_amount"
  | "created_at";

/**
 * `sort` is the `jobs` column the header sorts on, and the list pages through
 * the database, so a column with no `sort` genuinely cannot be sorted: the
 * three that are missing it — status, loss type, reported source — are stored
 * as ids and joined to their labels in the browser, so ordering by the column
 * would order by a uuid and put "Water" next to "Fire" for no visible reason.
 * They stay unsortable rather than offering a control that lies.
 */
export const JOB_COLUMNS: {
  key: JobColumnKey;
  label: string;
  numeric?: boolean;
  sort?: string;
}[] = [
  { key: "job_number", label: "Job Number", sort: "job_number" },
  // No `sort`: these are derived chips (scope, additional work, equipment
  // count, days open), not a stored column, so there is nothing to order by.
  { key: "codes", label: "Status codes" },
  { key: "job_name", label: "Job Name", sort: "job_name" },
  { key: "job_type", label: "Payment", sort: "job_type" },
  { key: "status", label: "Job Status" },
  { key: "call_date", label: "Call Date", sort: "call_date" },
  // "Job date" in the office's vocabulary: when the loss happened, which is
  // what a claim is dated by. Call date is when they phoned us.
  { key: "loss_date", label: "Loss Date", sort: "loss_date" },
  { key: "customer_name", label: "Customer Name", sort: "customer_name" },
  { key: "address", label: "Address", sort: "address" },
  { key: "locality", label: "City", sort: "locality" },
  { key: "region", label: "State", sort: "region" },
  { key: "postal_code", label: "Zip", sort: "postal_code" },
  { key: "county", label: "County", sort: "county" },
  { key: "loss_type", label: "Loss Type" },
  { key: "reported_source", label: "Reported Source" },
  { key: "insurance_carrier", label: "Carrier", sort: "insurance_carrier" },
  { key: "estimated_amount", label: "Estimated", numeric: true, sort: "estimated_amount" },
  { key: "billed_amount", label: "Billed", numeric: true, sort: "billed_amount" },
  { key: "created_at", label: "Created", sort: "created_at" },
];

export const DEFAULT_JOB_COLUMNS: JobColumnKey[] = [
  "job_number",
  "codes",
  "job_name",
  "job_type",
  "status",
  "call_date",
  "customer_name",
  "address",
  "locality",
  "region",
];

export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v.length <= 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString(DATE_LOCALE, US_DATE);
}
