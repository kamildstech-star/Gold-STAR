import { useQuery } from "@tanstack/react-query";
import { Building2, Check } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Multi-select office filter. The `locations` query is bounded by RLS, so a
 * user only ever sees the offices they are allowed to work in.
 * Empty selection === all offices in scope.
 */
export function LocationFilter({
  value,
  onChange,
  className,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  className?: string;
}) {
  const locationsQ = useQuery({
    queryKey: ["location-filter-options"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("locations")
        .select("id, code, name")
        .order("code");
      if (error) throw error;
      return data ?? [];
    },
  });

  const options = locationsQ.data ?? [];
  const label =
    value.length === 0
      ? "All offices"
      : value.length === 1
        ? (options.find((o) => o.id === value[0])?.code ?? "1 office")
        : `${value.length} offices`;

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn("filter-chip w-[170px] text-left", className)}>
          <Building2 className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1">
        <div className="max-h-72 overflow-y-auto">
          {options.length === 0 ? (
            <div className="p-2 text-[12px] text-muted-foreground">No offices in your scope</div>
          ) : (
            options.map((o) => {
              const on = value.includes(o.id);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => toggle(o.id)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-muted"
                >
                  <span
                    className={cn(
                      "grid size-4 shrink-0 place-items-center rounded-[4px] border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {on ? <Check className="size-3" /> : null}
                  </span>
                  <span className="truncate">
                    <span className="font-medium">{o.code}</span>{" "}
                    <span className="text-muted-foreground">{o.name}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
        {value.length > 0 && (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full text-[12px]"
              onClick={() => onChange([])}
            >
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
