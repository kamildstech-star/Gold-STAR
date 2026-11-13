import { createFileRoute, redirect } from "@tanstack/react-router";

/*
 * Settings › Cost rates — retired in Billing & Costs prompt 3. Its Labor tab is
 * the overhead engine (the crew wage) and Client Agreements (the charge rates,
 * until prompt 4); its Materials & supplies tab is Cost › Supplies book; its
 * Equipment tab is Cost › Equipment (a type's day cost reaches its units as
 * before; a unit's own is on its page); the minimum margin is in General
 * rules. The "Labor by office" table's job is the Cost tab's Compare offices
 * view. The address is kept so old links and bookmarks still work.
 */
export const Route = createFileRoute("/_authenticated/admin/equipment-rates")({
  beforeLoad: ({ search }) => {
    const tab = (search as { tab?: string }).tab;
    throw redirect({
      to: "/admin/billing-costs",
      search: tab === "equipment" ? { tab: "cost", ccat: "equipment" } : { tab: "cost" },
      replace: true,
    });
  },
});
