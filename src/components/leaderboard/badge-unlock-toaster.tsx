import { useEffect } from "react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";

/**
 * The unlock moment. Badges are awarded by the automation engine, so the
 * person is usually not looking at the leaderboard when it happens — a live
 * toast is what makes it feel earned. The notification row and the wins feed
 * carry it afterwards.
 */
export function BadgeUnlockToaster() {
  const { userId } = useAppContext();

  useEffect(() => {
    if (!userId) return;
    const ch = supabase
      .channel(`badge-unlock:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "user_achievements",
          filter: `user_id=eq.${userId}`,
        },
        async (payload) => {
          const row = payload.new as { achievement_id: string };
          const { data } = await supabase
            .from("leaderboard_achievements")
            .select("name, description")
            .eq("id", row.achievement_id)
            .maybeSingle();
          toast.success(`Badge unlocked — ${data?.name ?? "New badge"}`, {
            description: data?.description ?? undefined,
          });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(ch);
    };
  }, [userId]);

  return null;
}
