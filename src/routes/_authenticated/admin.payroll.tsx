import { createFileRoute, redirect } from "@tanstack/react-router";

// People and pay is now Settings › People: the commission tiers on the page,
// each person's pay and commission on their profile (Melly, 6 Nov). Kept so
// old links land.
export const Route = createFileRoute("/_authenticated/admin/payroll")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/people", replace: true });
  },
});
