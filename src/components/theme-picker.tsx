import { Check, Palette as PaletteIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { PALETTES, useTheme, type Palette } from "@/lib/theme";
import { cn } from "@/lib/utils";

/**
 * Palette chooser. Applies live so a palette is judged on a real screen, not a
 * swatch sheet. Loss-type and status colours never change — only the chrome.
 */
export function PaletteChoices({ className }: { className?: string }) {
  const { palette, setPalette } = useTheme();
  return (
    <div className={cn("grid gap-1.5", className)}>
      {PALETTES.map((p) => {
        const active = palette === p.value;
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => setPalette(p.value as Palette)}
            aria-pressed={active}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md border px-2 py-1.5 text-left transition-colors",
              active ? "border-primary bg-accent" : "border-border hover:bg-hover",
            )}
          >
            <span className="flex shrink-0 overflow-hidden rounded-sm border border-border">
              {p.swatch.map((c) => (
                <span key={c} className="size-4" style={{ backgroundColor: c }} />
              ))}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium">{p.label}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {p.description}
              </span>
            </span>
            {active && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}

/** Compact trigger for page headers. */
export function PalettePickerButton({ className }: { className?: string }) {
  const { palette } = useTheme();
  const current = PALETTES.find((p) => p.value === palette);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className={className}>
          <PaletteIcon className="mr-1.5 size-4" />
          Theme: {current?.label ?? "Gold Star"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="px-1 pb-1.5 text-[11px] font-medium uppercase text-muted-foreground">
          Color theme
        </p>
        <PaletteChoices />
        <p className="px-1 pt-2 text-[11px] leading-tight text-muted-foreground">
          Applies everywhere, remembered on every device. Loss-type and status colors stay the same.
        </p>
      </PopoverContent>
    </Popover>
  );
}
