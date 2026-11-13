import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type PickableLocation = { id: string; code: string; name: string };

/**
 * Batch location picker: search, checkboxes, and an "All locations" toggle.
 * Used anywhere admin used to grant offices one at a time.
 */
export function MultiLocationSelect({
  locations,
  value,
  onChange,
  placeholder = "Add locations…",
  disabled,
  className,
}: {
  locations: PickableLocation[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return locations;
    return locations.filter(
      (l) => l.code.toLowerCase().includes(t) || l.name.toLowerCase().includes(t),
    );
  }, [locations, q]);

  const allOn = locations.length > 0 && value.length === locations.length;

  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);

  const label =
    value.length === 0
      ? placeholder
      : allOn
        ? "All locations"
        : value.length === 1
          ? (locations.find((l) => l.id === value[0])?.code ?? "1 selected")
          : `${value.length} selected`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(
            "h-9 justify-start font-normal",
            value.length === 0 && "text-muted-foreground",
            className,
          )}
        >
          <Search className="mr-2 size-4 shrink-0" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
        <div className="border-b p-2">
          <Input
            autoFocus
            placeholder="Search offices…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8"
          />
        </div>
        <label className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
          <Checkbox
            checked={allOn}
            onCheckedChange={() => onChange(allOn ? [] : locations.map((l) => l.id))}
          />
          All locations
        </label>
        <div className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">No offices match.</p>
          ) : (
            filtered.map((l) => (
              <label
                key={l.id}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
              >
                <Checkbox checked={value.includes(l.id)} onCheckedChange={() => toggle(l.id)} />
                <span className="truncate">
                  <span className="font-medium">{l.code}</span>{" "}
                  <span className="text-muted-foreground">{l.name}</span>
                </span>
              </label>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
