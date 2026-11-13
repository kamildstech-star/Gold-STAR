import {
  BILLING_POSITION,
  buildOrgTree,
  type HierarchyContact,
  type OrgNode,
} from "@/lib/company-hierarchy";

/**
 * The people chart of one company: the sketch the client drew — Company, then
 * Owner/CEO, Regionals, Asset managers, Building supers — with Billing off to
 * one side, because Billing is who you ring about a payment, not a rung on the
 * ladder you climb when a super does not pick up.
 *
 * Pure: it reshapes the rows the hierarchy panel already read. Nothing here is
 * stored, so the chart and the list can never disagree.
 */
export interface OrgChartModel {
  /** The reporting tree, minus the people set aside below. */
  placed: OrgNode[];
  /** Billing with nobody reporting to them — drawn beside the company. */
  billing: HierarchyContact[];
  /**
   * No position, no manager and nobody under them: a contact the structure
   * has not been told about yet. Most companies start with everyone here, so
   * they are listed under the chart rather than drawn as a row of boxes that
   * look like a flat org with forty bosses.
   */
  unplaced: HierarchyContact[];
}

export function orgChartModel(rows: HierarchyContact[]): OrgChartModel {
  const managers = new Set(rows.map((r) => r.reports_to_contact_id).filter(Boolean));
  const billing = rows.filter((r) => r.position_key === BILLING_POSITION && !managers.has(r.id));
  const billingIds = new Set(billing.map((r) => r.id));
  const { roots } = buildOrgTree(rows.filter((r) => !billingIds.has(r.id)));

  const placed: OrgNode[] = [];
  const unplaced: HierarchyContact[] = [];
  for (const n of roots) {
    const loose =
      !n.contact.position_key && !n.contact.reports_to_contact_id && n.children.length === 0;
    if (loose) unplaced.push(n.contact);
    else placed.push(n);
  }
  return { placed, billing, unplaced };
}

/**
 * How a position is drawn on the chart: the sketch's colours, as tokens.
 * 6 Nov (David): "each level of position has a different colour" — the
 * regional tier and the people on site got tones of their own, and the job
 * Contacts tab colours its position pills the same way (ORG_TONE_TAG).
 */
export type OrgTone = "lead" | "region" | "asset" | "site" | "billing" | "plain";

export function orgTone(positionKey: string | null | undefined): OrgTone {
  if (positionKey === "owner_ceo" || positionKey === "executive") return "lead";
  if (positionKey === "regional") return "region";
  if (positionKey === "asset_manager") return "asset";
  if (positionKey === "building_super" || positionKey === "maintenance") return "site";
  if (positionKey === BILLING_POSITION) return "billing";
  return "plain";
}

/** The pill classes per tone — one map for the chart, the mini card and the job Contacts tab. */
export const ORG_TONE_TAG: Record<OrgTone, string> = {
  lead: "bg-accent text-accent-foreground",
  region: "bg-primary/10 text-primary",
  asset: "bg-success/10 text-success",
  site: "bg-info/10 text-info",
  billing: "bg-warning/10 text-warning",
  plain: "bg-muted text-muted-foreground",
};

/** Two letters for an avatar: first and last word of the name. */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0][0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1][0] ?? "") : (words[0][1] ?? "");
  return (first + last).toUpperCase();
}
