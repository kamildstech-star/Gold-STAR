/**
 * The signed-in person's own email transport, live: would an email they send
 * right now go out, and through what. One query key (["email", "status"]) for
 * every screen that asks, so the composer's warning, the held row's warning
 * and the unsent row's wording agree with each other.
 *
 * The server function is imported when the query runs, not at module load:
 * held-email-controls sits under the account Timeline, whose render tests
 * stub @tanstack/react-start, and a static import would pull the whole
 * server-function module (and its auth middleware) into every one of them.
 */
import { useQuery } from "@tanstack/react-query";

import type { MyEmailTransport } from "@/lib/email-transport";

export const EMAIL_TRANSPORT_QUERY_KEY = ["email", "status"] as const;

export function useMyEmailTransport(enabled = true) {
  return useQuery({
    queryKey: EMAIL_TRANSPORT_QUERY_KEY,
    enabled,
    // Connecting Outlook happens on another page; a minute is soon enough to
    // notice, and focus refetches it anyway.
    staleTime: 60_000,
    queryFn: async (): Promise<(MyEmailTransport & { checked: boolean }) | null> => {
      const { emailStatus } = await import("@/lib/email.functions");
      const result = await emailStatus();
      return result.checked ? result : null;
    },
  });
}
