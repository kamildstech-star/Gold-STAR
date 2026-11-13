import { useQuery } from "@tanstack/react-query";
import { User } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppContext } from "@/components/app-context";

export const EVERYONE = "everyone";

/**
 * Owner filter used on every list. Defaults to "Everyone" — bounded by RLS,
 * so a rep only ever sees the owners inside their own scope.
 */
export function OwnerFilter({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const app = useAppContext();

  const peopleQ = useQuery({
    queryKey: ["owner-filter-people"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name")
        .limit(500);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className ?? "filter-chip w-[170px]"}>
        <User className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue placeholder="Everyone" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={EVERYONE}>Everyone</SelectItem>
        {/* "Me" is the viewed person under View As — this only filters a list. */}
        {app.viewerUserId && <SelectItem value={app.viewerUserId}>Me</SelectItem>}
        <SelectItem value="unassigned">Unassigned</SelectItem>
        {(peopleQ.data ?? [])
          .filter((p) => p.user_id !== app.viewerUserId)
          .map((p) => (
            <SelectItem key={p.user_id} value={p.user_id}>
              {p.full_name ?? "Unnamed"}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
