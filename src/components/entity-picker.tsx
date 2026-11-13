import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, Info, Plus, Search, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAppContext } from "@/components/app-context";
import { ENTITY_KINDS, type EntityKind, type EntityOption } from "@/components/entity-kinds";

/**
 * The one picker.
 *
 * House rule: a picker is never a dead end. Every search resolves to one of
 * three things — a record, a "+ Add …" that opens a create dialog prefilled
 * with what was typed, or a plain instruction saying who can add it. A blank
 * "no results" is a bug: the rep either abandons the field, invents free text,
 * or leaves the form and loses their work.
 *
 * Entity behaviour (search, wording, who may create, which dialog) lives in
 * the registry in entity-kinds.tsx, so a new field is a registry entry rather
 * than another bespoke component.
 */

export type { EntityOption } from "@/components/entity-kinds";

function useDebounced(value: string, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function EntityPicker({
  kind,
  value,
  onChange,
  label,
  disabled,
  placeholder,
  reason,
  /** Extra scope handed to the registry: owning office, parent account, etc. */
  scope,
  /** Off inside a create dialog, so a picker cannot recurse into itself. */
  allowCreate = true,
  className,
}: {
  kind: EntityKind;
  value: EntityOption | null;
  onChange: (v: EntityOption | null) => void;
  label?: string | null;
  disabled?: boolean;
  placeholder?: string;
  reason?: string | null;
  scope?: Record<string, string | null | undefined>;
  allowCreate?: boolean;
  className?: string;
}) {
  const app = useAppContext();
  const config = ENTITY_KINDS[kind];
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const term = useDebounced(q.trim());
  const minChars = config.minChars ?? 0;
  const enabled = open && term.length >= minChars;

  const resultsQ = useQuery({
    queryKey: ["entity-picker", kind, term, scope ?? {}],
    enabled,
    queryFn: () => config.search(term, { scope: scope ?? {}, app }),
  });

  const rows = useMemo(() => resultsQ.data ?? [], [resultsQ.data]);
  // A record this person may not pick is not listed at all — no locked row.
  const selectable = rows.filter((r) => !r.locked);
  const loading = resultsQ.isFetching;
  const nothing = enabled && !loading && selectable.length === 0;

  const canCreate =
    allowCreate && !!config.Create && !app.writesDisabled && config.canCreate(app, scope ?? {});
  const createTerm = q.trim();

  const pick = (o: EntityOption) => {
    onChange(o);
    setOpen(false);
    setQ("");
  };

  return (
    <div className={className ?? "grid gap-1.5"}>
      {label === null ? null : <Label>{label ?? config.fieldLabel}</Label>}

      {value ? (
        <div className="flex items-center justify-between rounded-[6px] border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{value.label}</div>
            {value.sublabel && (
              <div className="truncate text-xs text-muted-foreground">{value.sublabel}</div>
            )}
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onChange(null)}
            aria-label={`Clear ${config.noun}`}
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}
      {reason && value ? <p className="text-[11px] text-muted-foreground">{reason}</p> : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {value ? (
            <Button
              type="button"
              variant="link"
              disabled={disabled}
              className="h-auto justify-start p-0 text-[11px] font-normal text-muted-foreground"
            >
              <Search className="mr-1 size-3" />
              Change {config.noun}
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className="h-9 w-full justify-start font-normal text-muted-foreground"
            >
              <Search className="mr-2 size-4" />
              {placeholder ?? config.placeholder}
            </Button>
          )}
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-0">
          <div className="border-b p-2">
            <Input
              autoFocus
              placeholder={config.searchPlaceholder ?? `Search ${config.noun}s…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {!enabled && minChars > 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                Type at least {minChars} characters.
              </p>
            )}
            {loading && <p className="px-2 py-3 text-xs text-muted-foreground">Searching…</p>}

            {selectable.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => pick(o)}
                className="flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left transition-colors hover:bg-accent"
              >
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{o.label}</div>
                  {o.sublabel && (
                    <div className="truncate text-xs text-muted-foreground">{o.sublabel}</div>
                  )}
                </div>
                {o.badge && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {o.badge}
                  </Badge>
                )}
              </button>
            ))}

            {/* Never a blank no-results: either a create, or where it comes from. */}
            {canCreate && createTerm.length >= Math.max(minChars, 1) ? (
              <div className="mt-1 border-t pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm font-medium text-primary hover:bg-accent"
                >
                  <Plus className="size-4 shrink-0" />
                  Add “{createTerm}” as {config.article ?? "a"} {config.noun}
                </button>
              </div>
            ) : nothing ? (
              <div className="mt-1 flex items-start gap-2 border-t px-2 pb-1 pt-2 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>{config.cannotCreateHint(app, scope ?? {})}</span>
              </div>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {config.Create && (
        <config.Create
          open={createOpen}
          onOpenChange={setCreateOpen}
          initialName={createTerm}
          scope={scope ?? {}}
          onCreated={(o) => pick(o)}
        />
      )}
    </div>
  );
}
