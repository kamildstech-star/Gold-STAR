import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types";

/** Current account and MFA checks shared by server functions and file routes. */
export async function validateSession(supabase: SupabaseClient<Database>, token: string) {
  const { data, error } = await supabase.auth.getClaims(token);
  if (error || !data?.claims) {
    throw new Error("Unauthorized: Invalid token");
  }

  if (!data.claims.sub) {
    throw new Error("Unauthorized: No user ID found in token");
  }

  // A customer portal session is never a staff session, whatever else about it
  // checks out. It would fail the profile check below anyway (customers have
  // no profile, and cannot be given one); this says so first and in words,
  // before any staff data is touched. See the client portal migrations
  // (20260928130000) for the database half of the same rule.
  const claimRole = (data.claims as { role?: unknown }).role;
  if (claimRole === "portal_customer") {
    throw new Error("Unauthorized: Customer portal sessions cannot use staff functions");
  }

  // Claims establish token identity, but do not establish current account
  // status or whether an enrolled second factor has been completed.
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user || userData.user.id !== data.claims.sub) {
    throw new Error("Unauthorized: User is no longer available");
  }
  if (userData.user.role === "portal_customer") {
    throw new Error("Unauthorized: Customer portal sessions cannot use staff functions");
  }
  if (
    userData.user.factors?.some((factor) => factor.status === "verified") &&
    data.claims.aal !== "aal2"
  ) {
    throw new Error("Unauthorized: Complete two-factor authentication");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_active,approval_status")
    .eq("user_id", data.claims.sub)
    .maybeSingle();
  if (
    profileError ||
    !profile ||
    profile.is_active !== true ||
    profile.approval_status !== "approved"
  ) {
    throw new Error("Unauthorized: Account access is not approved or active");
  }

  return data.claims;
}
