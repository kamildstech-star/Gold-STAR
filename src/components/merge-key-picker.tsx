/**
 * Searchable merge-key picker.
 *
 * The catalog now covers every column, so the old per-category dropdowns are
 * far too long to scan. Authors type what they mean ("adjuster", "zelle") and
 * see the resolved sample value beside each key — that is the only reliable way
 * to tell {Job.CustomerName} from {Job.BillingName}.
 */
import { useMemo, useState } from "react";
import { Variable } from "lucide-react";

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
import { MERGE_CATEGORIES, type MergeData } from "@/lib/merge-keys";

export function MergeKeyPicker({
  onInsert,
  sample,
  label = "Insert key",
}: {
  onInsert: (key: string) => void;
  /** Resolved values for a real record, shown beside each key. */
  sample?: MergeData;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  const groups = useMemo(
    () =>
      MERGE_CATEGORIES.map((c) => ({
        ...c,
        keys: c.keys.map((k) => ({
          ...k,
          value: sample?.[k.key] == null ? "" : String(sample[k.key]),
        })),
      })),
    [sample],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs">
          <Variable className="mr-1 size-3" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[380px] p-0">
        <Command>
          <CommandInput placeholder="Search keys — e.g. adjuster, zelle, expiry" />
          <CommandList className="max-h-[320px]">
            <CommandEmpty>No key matches that.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.id} heading={g.label}>
                {g.keys.map((k) => (
                  <CommandItem
                    key={`${g.id}:${k.key}`}
                    value={`${k.key} ${k.label} ${g.label}`}
                    onSelect={() => {
                      onInsert(k.key);
                      setOpen(false);
                    }}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="text-xs font-medium">{k.label}</span>
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-muted-foreground">{`{${k.key}}`}</span>
                      {k.value ? (
                        <span className="max-w-[45%] truncate text-[11px] text-muted-foreground/80">
                          {k.value}
                        </span>
                      ) : null}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
