/**
 * The order of the cards on a job's Billing tab on a phone.
 *
 * David, 15 Oct: on the phone the money runs Estimates → Invoices →
 * Payments, and Commission goes to the BOTTOM; the job's other items sit
 * above the Expense tracker. Below `xl` the tab is one column, so this list
 * IS the phone's order; the page applies it with CSS `order` (the two
 * desktop columns are flattened with `display: contents` below `xl`), so
 * nothing is rendered twice and desktop keeps its two columns.
 *
 * `billing` is the one panel that holds Estimates, Invoices and Payments, in
 * that order, stacked on a phone (job-billing-panel.tsx). `open_document` is
 * where an open estimate's or invoice's own cards are portalled, kept right
 * under the money it belongs to.
 *
 * `cost_breakdown` (Cost by work component) is not on the page since 21 Oct
 * — the client found it repeated the running cost and the ledger — so it is
 * out of this list; the Expense tracker took its place. Its class is kept
 * below so restoring the card is putting it back here and on the page.
 */
export const JOB_BILLING_SECTIONS = [
  "billing",
  "open_document",
  "running_cost",
  "bill_to",
  "expenses",
  "commission",
] as const;
/** Sections the page can render; `cost_breakdown` only if the card is restored. */
type BillingSectionKey = JobBillingSection | "cost_breakdown";
export type JobBillingSection = (typeof JOB_BILLING_SECTIONS)[number];

/** Human names, for the test and for anyone reading the page. */
export const JOB_BILLING_SECTION_LABEL: Record<BillingSectionKey, string> = {
  billing: "Estimates, Invoices, Payments",
  open_document: "Open estimate / invoice",
  running_cost: "Running cost",
  bill_to: "Bill to",
  cost_breakdown: "Cost breakdown",
  expenses: "Expense tracker",
  commission: "Commission",
};

/**
 * The class each section's wrapper carries. Literal strings on purpose:
 * Tailwind only generates classes it can find written out in the source.
 * `empty:hidden` so a card that renders nothing (no money access, still
 * loading) leaves no gap in the column.
 */
const ORDER_CLASS: Record<BillingSectionKey, string> = {
  billing: "order-1 xl:order-none min-w-0 empty:hidden",
  open_document: "order-2 xl:order-none min-w-0 empty:hidden",
  running_cost: "order-3 xl:order-none min-w-0 empty:hidden",
  bill_to: "order-4 xl:order-none min-w-0 empty:hidden",
  cost_breakdown: "order-5 xl:order-none min-w-0 empty:hidden",
  expenses: "order-6 xl:order-none min-w-0 empty:hidden",
  commission: "order-7 xl:order-none min-w-0 empty:hidden",
};

export function billingOrderClass(section: BillingSectionKey): string {
  return ORDER_CLASS[section];
}

/** The phone order, top to bottom, read back from the classes the page uses. */
export function jobBillingMobileOrder(): JobBillingSection[] {
  const rank = (s: JobBillingSection) => Number(/order-(\d+)/.exec(ORDER_CLASS[s])![1]);
  return [...JOB_BILLING_SECTIONS].sort((a, b) => rank(a) - rank(b));
}
