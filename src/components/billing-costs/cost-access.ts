import { useAppContext } from "@/components/app-context";
import { canViewFinance } from "@/lib/finance";
import { useCan } from "@/lib/permissions";
import { isPrivileged } from "@/lib/roles";

/**
 * Who may see and change money in Billing & Costs — the screen's mirror of the
 * database's rule (can_see_costs / can_manage_overhead, 20261031120000). The
 * database enforces it either way; this decides what the screen offers.
 *   seeCosts        owner/admin/dev, finance, or job.view_costs — never a seller
 *   editCosts       owner/admin/dev
 *   manageOverhead  owner and admin only
 */
export function useCostAccess() {
  const app = useAppContext();
  const viewCosts = useCan("job.view_costs");
  const roles = app.realRoles ?? [];
  return {
    seeCosts: isPrivileged(roles) || canViewFinance(roles) || viewCosts,
    editCosts: isPrivileged(roles),
    manageOverhead: roles.includes("owner") || roles.includes("admin"),
  };
}
