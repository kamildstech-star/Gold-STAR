import { createFileRoute } from "@tanstack/react-router";
import { useAppContext } from "@/components/app-context";
import { dashboardFor } from "@/lib/roles";
import {
  OwnerDashboard,
  RegionalDashboard,
  LocationManagerDashboard,
  SalesManagerDashboard,
  SalesRepDashboard,
  FieldChaserDashboard,
  CrewDashboard,
  AdminDashboard,
  NoRoleDashboard,
} from "@/components/dashboards";
import {
  SalesHeadDashboard,
  SalesPersonDashboard,
  ColdCallerDashboard,
  OutsideSalesRepDashboard,
} from "@/components/dashboards-sales";
import { DashboardGrid } from "@/components/dashboard-grid";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "Dashboard · Recovery Hub" },
      { name: "description", content: "Role-based dashboard for Gold Star Restoration." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: DashboardDispatch,
});

function DashboardDispatch() {
  const app = useAppContext();
  if (app.loading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;
  }
  const key = dashboardFor(app.primary);
  if (key === null) {
    return (
      <div className="page-shell min-w-0 overflow-x-clip">
        <NoRoleDashboard />
      </div>
    );
  }
  const body = (
    <>
      {key === "owner" && <OwnerDashboard />}
      {key === "regional" && <RegionalDashboard />}
      {key === "location_manager" && <LocationManagerDashboard />}
      {key === "sales_head" && <SalesHeadDashboard />}
      {key === "sales_person" && <SalesPersonDashboard />}
      {key === "cold_caller" && <ColdCallerDashboard />}
      {key === "outside_sales_rep" && <OutsideSalesRepDashboard />}
      {key === "sales_manager" && <SalesManagerDashboard />}
      {key === "sales_rep" && <SalesRepDashboard />}
      {key === "field_chaser" && <FieldChaserDashboard />}
      {key === "crew" && <CrewDashboard />}
      {key === "admin" && <AdminDashboard />}
    </>
  );
  return (
    <div className="page-shell min-w-0 overflow-x-clip">
      <DashboardGrid role={key} body={body} />
    </div>
  );
}
