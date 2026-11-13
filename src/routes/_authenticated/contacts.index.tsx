/** Contacts merged into the Customers page — keep the old URL working. */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/contacts/")({
  beforeLoad: ({ search }) => {
    throw redirect({
      to: "/customers",
      search: {
        tab: "people",
        q: "",
        status: "all",
        sel: (search as { sel?: string }).sel,
      },
      replace: true,
    });
  },
  validateSearch: (raw: Record<string, unknown>) => ({
    sel: typeof raw.sel === "string" && raw.sel ? raw.sel : undefined,
  }),
});
