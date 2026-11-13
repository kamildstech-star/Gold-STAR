/**
 * Person picker. Search staff by name, see their avatar and role, pick one.
 *
 * Scoped to the people who can actually be assigned to the record's location,
 * so a Brooklyn job never offers a Houston tech. Nobody types a UUID.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, User } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { personPrimaryLabel, personSearchValue, personSecondaryLabel } from "@/lib/person-picker";

export interface PickablePerson {
  user_id: string;
  full_name: string | null;
  email: string | null;
  roles: string[];
}

function initials(name: string | null, email: string | null): string {
  const base = (name ?? email ?? "?").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/** Active staff assignable to `locationId` (everyone active when it is null). */
export function useAssignablePeople(locationId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["assignable-people", locationId ?? "all"],
    enabled,
    queryFn: async (): Promise<PickablePerson[]> => {
      let scoped: string[] | null = null;
      if (locationId) {
        const { data } = await supabase
          .from("location_members")
          .select("user_id")
          .eq("location_id", locationId);
        scoped = (data ?? []).map((r) => r.user_id);
      }

      let q = supabase
        .from("profiles")
        .select("user_id, full_name, email")
        .eq("is_active", true)
        .order("full_name");
      if (scoped) {
        if (scoped.length === 0) return [];
        q = q.in("user_id", scoped);
      }
      const { data: people, error } = await q;
      if (error) throw error;
      const ids = (people ?? []).map((p) => p.user_id);
      if (ids.length === 0) return [];

      const { data: roles } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("user_id", ids);
      const byUser = new Map<string, string[]>();
      for (const r of roles ?? []) {
        byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.role as string]);
      }

      return (people ?? []).map((p) => ({
        user_id: p.user_id,
        full_name: p.full_name,
        email: p.email,
        roles: byUser.get(p.user_id) ?? [],
      }));
    },
  });
}

export function PersonPicker({
  value,
  onChange,
  locationId,
  placeholder = "Search people…",
  exclude = [],
  className,
  disabled,
}: {
  value: string | null;
  onChange: (userId: string | null) => void;
  /** Restricts the list to members of this location. */
  locationId?: string | null;
  placeholder?: string;
  /** People already on the record. */
  exclude?: string[];
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useAssignablePeople(locationId, true);

  const people = useMemo(
    () => (data ?? []).filter((p) => !exclude.includes(p.user_id) || p.user_id === value),
    [data, exclude, value],
  );
  const selected = people.find((p) => p.user_id === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn("w-full justify-between font-normal", className)}
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2">
              <Avatar className="size-5">
                <AvatarFallback className="text-[10px]">
                  {initials(selected.full_name, selected.email)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate">{personPrimaryLabel(selected)}</span>
            </span>
          ) : (
            <span className="flex items-center gap-2 text-muted-foreground">
              <User className="size-4" /> {placeholder}
            </span>
          )}
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(22rem,90vw)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search by name or email…" />
          <CommandList>
            <CommandEmpty>
              {isLoading
                ? "Loading…"
                : locationId
                  ? "Nobody at this location can be assigned."
                  : "No people found."}
            </CommandEmpty>
            <CommandGroup>
              {people.map((p) => (
                <CommandItem
                  key={p.user_id}
                  value={personSearchValue(p)}
                  onSelect={() => {
                    onChange(p.user_id === value ? null : p.user_id);
                    setOpen(false);
                  }}
                  className="gap-2"
                >
                  <Avatar className="size-7">
                    <AvatarFallback className="text-[11px]">
                      {initials(p.full_name, p.email)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{personPrimaryLabel(p)}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {personSecondaryLabel(p)}
                    </span>
                  </span>
                  {value === p.user_id && <Check className="size-4" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
