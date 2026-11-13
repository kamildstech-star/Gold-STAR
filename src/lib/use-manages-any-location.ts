/**
 * Whether this person manages at least one office they can see — the rule
 * behind adding equipment (`equipment_insert`: can_manage_location). 13 Nov
 * (owner): what a role may not do does not show, so "New equipment" and
 * Import are hidden from someone who manages no office.
 *
 * true at once for owner/admin/dev; otherwise the database's own
 * can_manage_location, asked per office until one says yes. null while asking.
 */
import { useQuery } from "@tanstack/react-query";

import { useAppContext } from "@/components/app-context";
import { supabase } from "@/integrations/supabase/client";
import { isPrivileged } from "@/lib/roles";

export function useManagesAnyLocation(): boolean | null {
  const app = useAppContext();
  const privileged = isPrivileged(app.roles);
  const ids = app.visibleLocations.map((l) => l.id);
  const q = useQuery({
    queryKey: ["manages-any-location", app.userId, ids.join(",")],
    enabled: !privileged && !!app.userId && ids.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<boolean> => {
      for (const id of ids) {
        const { data, error } = await supabase.rpc("can_manage_location", {
          _user_id: app.userId!,
          _location_id: id,
        });
        if (!error && data === true) return true;
      }
      return false;
    },
  });
  if (privileged) return true;
  if (!app.userId || ids.length === 0) return false;
  return q.data ?? null;
}
