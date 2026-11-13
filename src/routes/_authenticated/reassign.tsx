import { createFileRoute, redirect } from "@tanstack/react-router";

// Reassign a book is now the Book tab of a person on Settings › People (Melly,
// 6 Nov: one People area instead of three pages). Kept so old links land.
export const Route = createFileRoute("/_authenticated/reassign")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/people", replace: true });
  },
});
