import * as React from "react";

import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  groupHitsByArea,
  searchActions,
  type ActionDef,
  type ActionUnit,
} from "@/lib/action-catalogue";

/**
 * The catalogue picker: every action the CRM records, with the smart search.
 *
 * Built for the scorecard admin (Mark: "a list of actions they can choose
 * from ... with a serach function thats smart") and lifted out of that route
 * the day the weekly challenge needed the same list — Mark, on the
 * challenge's five-option Metric dropdown: "add the ability to add more
 * metrics, custom to the user". One picker, so the two screens never drift:
 * an action added to the catalogue shows up in both.
 *
 * cmdk's own filter is switched off; `searchActions` does the matching
 * (label, synonyms, description; prefixes; one typo) and the results come
 * grouped by area. `group` narrows the pool to one role group's actions —
 * the scorecard tabs want that — and leaving it off offers the whole
 * catalogue, which is what a challenge wants. Keys in `taken` stay visible
 * but cannot be picked, with `takenLabel` explaining why.
 */
export const UNIT_HINT: Record<ActionUnit, string> = {
  count: "per period",
  currency: "$ per period",
  percent: "0–1 (1 = 100%)",
  minutes: "minutes",
};

export function ActionPicker({
  open,
  group,
  taken,
  takenLabel = "Already added",
  title = "Add a component",
  description = "Search every action the CRM records and add one to the scorecard.",
  onClose,
  onPick,
}: {
  open: boolean;
  group?: "sales" | "chase";
  taken?: ReadonlySet<string>;
  takenLabel?: string;
  title?: string;
  description?: string;
  onClose: () => void;
  onPick: (a: ActionDef) => void;
}) {
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    if (open) setQ("");
  }, [open]);
  const groups = React.useMemo(() => groupHitsByArea(searchActions(q, { group })), [q, group]);
  return (
    <Dialog open={open} onOpenChange={(v) => (v ? null : onClose())}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground"
        >
          <CommandInput
            value={q}
            onValueChange={setQ}
            placeholder='Try "cold call", "showed up", "signed", "$"…'
          />
          <CommandList className="max-h-[60svh]">
            <CommandEmpty>
              Nothing matches. Try another word — "phone", "visit", "won".
            </CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.area} heading={g.label}>
                {g.hits.map(({ action }) => {
                  const used = taken?.has(action.key) ?? false;
                  return (
                    <CommandItem
                      key={action.key}
                      value={action.key}
                      disabled={used}
                      onSelect={() => !used && onPick(action)}
                      className="flex-col items-start gap-0.5"
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className="text-[13px] font-medium">{action.label}</span>
                        <span className="text-[10.5px] text-muted-foreground">
                          {UNIT_HINT[action.unit]}
                          {action.direction === "lower" ? " · lower is better" : ""}
                        </span>
                        {used ? (
                          <Badge variant="outline" className="ml-auto text-[10px]">
                            {takenLabel}
                          </Badge>
                        ) : null}
                      </div>
                      <span className="text-[11.5px] text-muted-foreground">
                        {action.description}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
