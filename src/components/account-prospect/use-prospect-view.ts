/**
 * What an account is on the pipeline — a prospect, a won client, or closed
 * out — read from its Prospecting stage.
 *
 * An account is a prospect while it sits on an *open* Prospecting stage:
 * Ready, Active Outreach, Conversation Established. There is one account page
 * for all three (Melly, 6 Nov: no Overview / Full record); the kind decides
 * only what that page shows — the stage bar, proposals, the client cards.
 *
 * The pipeline is resolved by `pipelines.kind = 'prospecting'` with a name
 * fallback — never by a hardcoded id — through the same helpers Routes uses
 * (`src/lib/route-history.ts` imports these from `src/lib/visits.ts`), so the
 * two surfaces can never disagree about what counts as a deal.
 */
import { useQuery } from "@tanstack/react-query";

import {
  classifyStage,
  fetchProspectingStages,
  lookupStage,
  type ProspectingStageRow,
  type StopKind,
} from "@/lib/visits";

/**
 * Resolves the account's Prospecting stage and what it makes the account.
 * `kind` stays null until the stage table has loaded, so the page never draws
 * a prospect's stage bar on a client for a frame and then swaps.
 */
export function useProspectStage(
  stageId: string | null,
  stageKey: string | null,
): {
  loading: boolean;
  stage: ProspectingStageRow | null;
  kind: StopKind | null;
  /** True once resolved and the account is on an open Prospecting stage. */
  isProspect: boolean;
} {
  const stagesQ = useQuery({
    queryKey: ["prospecting-stages"],
    queryFn: fetchProspectingStages,
    staleTime: 5 * 60_000,
  });

  const stages = stagesQ.data ?? null;
  const stage = stages ? lookupStage(stages, stageId, stageKey) : null;
  const kind = stages ? classifyStage(stage) : null;

  return {
    loading: stagesQ.isLoading,
    stage,
    kind,
    isProspect: kind === "prospect",
  };
}

/* ------------------------------------------------------ open full record --*/

export type FullRecordDestination =
  /** Already on this account's page: nothing to navigate to. */
  | { kind: "switch" }
  /** Somewhere else: go to the account, with the layout set to full. */
  | { kind: "navigate"; to: "/accounts/$id"; params: { id: string } };

/**
 * What the drawer's "Open full record" has to do. Navigating to the route
 * the user is already on is a no-op, and the prospect/full choice lives in
 * the stored preference rather than the URL — so on the account's own page
 * the only thing that lands them on the full record is flipping the mode.
 */
export function fullRecordDestination(
  accountId: string,
  currentAccountId: string | null | undefined,
): FullRecordDestination {
  if (currentAccountId && currentAccountId === accountId) return { kind: "switch" };
  return { kind: "navigate", to: "/accounts/$id", params: { id: accountId } };
}
