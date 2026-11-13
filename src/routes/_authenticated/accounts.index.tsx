/** Accounts merged into the Customers page — keep the old URL working. */
import { createFileRoute, redirect } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/accounts/")({
  beforeLoad: ({ search }) => {
    const s = search as { q?: string; status?: string };
    throw redirect({
      to: "/customers",
      search: {
        tab: "companies",
        q: s.q ?? "",
        status: s.status ?? "active_pipeline",
      },
      replace: true,
    });
  },
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput) => ({
    status: typeof raw.status === "string" && raw.status ? raw.status : "active_pipeline",
    q: typeof raw.q === "string" ? raw.q : "",
    sel: typeof raw.sel === "string" && raw.sel ? raw.sel : undefined,
  }),
});
