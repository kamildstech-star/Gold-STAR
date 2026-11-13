import { createFileRoute, redirect } from "@tanstack/react-router";

// Offboarding is now the Offboarding tab of a person on Settings › People, and
// everyone mid-offboarding is the Offboarding count on that page (Melly,
// 6 Nov). Kept so old links land.
export const Route = createFileRoute("/_authenticated/admin/offboarding")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/people", search: { stage: "offboarding" }, replace: true });
  },
});
