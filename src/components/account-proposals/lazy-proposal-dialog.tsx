import { lazy } from "react";

/*
 * The proposal dialog, loaded on first open. It sends email and signing links
 * through server functions: the pipeline board does not otherwise need them,
 * and the account record's render tests mount the Proposals section with the
 * server runtime mocked away, so a static import would drag it in.
 */
export const LazyAccountProposalDialog = lazy(() =>
  import("@/components/account-proposals/proposal-dialog").then((m) => ({
    default: m.AccountProposalDialog,
  })),
);
