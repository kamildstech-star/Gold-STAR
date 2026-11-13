import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { intakeLinkUrl } from "./intake-inbox";
import { isMissingSchema } from "./schema-fallback";

/**
 * The signed-in person's standing intake link: one URL that never needs
 * minting again.
 *
 * David, 22 Sep: "the link shouldn't be a one-time link... I want to be able
 * to have this link saved and constantly just paste it... if one of the field
 * guys gets a phone call about a job, they could just send a link — not go
 * into the system, create a link, then send."
 *
 * It is a general link underneath (no job, no office, multi-use), so every
 * submission is routed to the closest office by the property it names — "one
 * link that automatically chooses the office based on the location they're
 * reporting." Nobody picks an office to get it, however many they belong to.
 *
 * The database hands it out (`my_standing_intake_link`, 20260925120000) rather
 * than this module inserting a row, because the intake_requests RLS keeps an
 * office-less request privileged-only and that should not be widened for a
 * field tech. Each person gets their own link so a departure or a leak is one
 * link revoked, not everyone's.
 */

export type StandingLinkState =
  | { status: "ready"; url: string }
  /** The migration is written but not applied yet — say so rather than fail. */
  | { status: "unavailable" };

const KEY = ["intake", "standing-link"] as const;

async function callLinkRpc(
  name: "my_standing_intake_link" | "rotate_my_standing_intake_link",
): Promise<StandingLinkState> {
  const { data, error } = await supabase.rpc(name as never);
  if (error) {
    if (isMissingSchema(error)) return { status: "unavailable" };
    throw error;
  }
  const token = typeof data === "string" ? data : "";
  if (token.length < 16) throw new Error("The intake link could not be created.");
  return { status: "ready", url: intakeLinkUrl(token) };
}

export function useStandingIntakeLink(enabled = true) {
  return useQuery({
    queryKey: KEY,
    queryFn: () => callLinkRpc("my_standing_intake_link"),
    enabled,
    // It does not change unless it is rotated, which updates the cache itself.
    staleTime: Infinity,
    retry: false,
  });
}

/** A new link for the caller; the old one stops working on its next load. */
export function useRotateStandingIntakeLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => callLinkRpc("rotate_my_standing_intake_link"),
    onSuccess: (next) => qc.setQueryData(KEY, next),
  });
}

/** What goes in the text or email, so a customer knows what they are opening. */
export function intakeLinkMessage(url: string): { subject: string; body: string } {
  return {
    subject: "Tell us about the damage",
    body: `Please use this form to tell us about the property and the damage, and add photos if you can:\n\n${url}\n\nWe will be in touch as soon as it comes in.`,
  };
}

/** A `mailto:` that opens the phone's own mail app with the link written in. */
export function intakeLinkMailto(url: string): string {
  const { subject, body } = intakeLinkMessage(url);
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
