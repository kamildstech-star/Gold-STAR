import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { useCan } from "@/lib/permissions";
import { isPrivileged } from "@/lib/roles";
import { JOB_FIELD_BY_KEY } from "@/lib/job-fields";

/**
 * Field-level permissions, read at runtime.
 *
 * `field_permissions` is the admin-managed matrix of role × job field. A field
 * hidden for any of the caller's roles stays hidden, and money fields are
 * additionally gated on the cost capability — a coordinator can correct the
 * claim number on a paid job without ever seeing a dollar figure.
 */
export interface JobFieldAccess {
  canSee: (key: string) => boolean;
  canEdit: (key: string) => boolean;
  loading: boolean;
}

export function useJobFieldAccess(): JobFieldAccess {
  const app = useAppContext();
  const showMoney = useCan("job.view_costs");
  const privileged = isPrivileged(app.roles);

  const q = useQuery({
    queryKey: ["job-field-permissions"],
    queryFn: async () => {
      const { data } = await supabase
        .from("field_permissions")
        .select("field, role, visible")
        .eq("entity", "job");
      return (data ?? []) as { field: string; role: string; visible: boolean }[];
    },
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    const hidden = new Set<string>();
    if (!privileged) {
      for (const row of q.data ?? []) {
        if (!row.visible && app.roles.includes(row.role as never)) hidden.add(row.field);
      }
    }
    const canSee = (key: string) => {
      const def = JOB_FIELD_BY_KEY[key];
      if (def?.money && !showMoney) return false;
      return !hidden.has(key);
    };
    return {
      canSee,
      canEdit: (key: string) => canSee(key) && !app.writesDisabled,
      loading: q.isLoading,
    };
  }, [q.data, q.isLoading, app.roles, app.writesDisabled, privileged, showMoney]);
}
