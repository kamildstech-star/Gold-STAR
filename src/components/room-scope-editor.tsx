/**
 * A room's Scope, typed straight in.
 *
 * David, 12 Oct: the room-level "Notes" is now "Scope", and a line is typed
 * inline — the box is always there, no "+" to click first. Enter adds the line
 * and keeps the cursor in the box for the next one. Each line is one bullet of
 * the Scope-of-Work report (src/lib/scope-of-work.ts).
 */
import { useState } from "react";
import { Loader2, Plus, Sparkles, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addScopeLine, removeScopeLine, scopeLines } from "@/lib/scope-of-work";

export function RoomScopeEditor({
  roomLabel,
  notes,
  readOnly,
  onSave,
  onSuggest,
}: {
  roomLabel: string;
  /**
   * Scope lines suggested from this room's data and its photos (David,
   * 27 Oct). Offered as chips; nothing is added until one is clicked.
   */
  onSuggest?: () => Promise<string[]>;
  /** The room's `notes` column, one scope line per line. */
  notes: string | null;
  readOnly?: boolean;
  onSave: (next: string | null) => void | Promise<void>;
}) {
  const [typed, setTyped] = useState("");
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const lines = scopeLines(notes);

  const suggest = async () => {
    if (!onSuggest) return;
    setSuggesting(true);
    try {
      const got = await onSuggest();
      setSuggested(got);
      if (!got.length)
        toast.info(`Nothing new to suggest for ${roomLabel} from its data and photos.`);
    } catch (e) {
      toast.error(`Could not suggest scope: ${(e as Error).message}`);
    } finally {
      setSuggesting(false);
    }
  };

  const add = () => {
    if (!typed.trim()) return;
    void onSave(addScopeLine(notes, typed));
    setTyped("");
  };

  return (
    <div className="space-y-1" data-room-scope>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Scope
      </div>
      {lines.length > 0 && (
        <ul className="space-y-0.5">
          {lines.map((line, i) => (
            <li key={`${i}:${line}`} className="group flex items-start gap-1.5 text-xs">
              <span aria-hidden className="mt-0.5 text-muted-foreground">
                •
              </span>
              <span className="min-w-0 flex-1 break-words">{line}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove “${line}” from ${roomLabel}`}
                  onClick={() => void onSave(removeScopeLine(notes, i))}
                >
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <div className="flex items-center gap-1.5">
          <Input
            className="h-8 text-xs"
            value={typed}
            placeholder={lines.length ? "Add another line…" : "Type scope — e.g. demo drywall"}
            aria-label={`Scope for ${roomLabel}`}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            // A line half-typed when the user taps elsewhere is still kept.
            onBlur={add}
          />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            disabled={!typed.trim()}
            aria-label={`Add scope line to ${roomLabel}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={add}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      )}
      {!readOnly && onSuggest && (
        <div className="space-y-1">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={suggesting}
            onClick={() => void suggest()}
          >
            {suggesting ? (
              <Loader2 className="mr-1 size-3.5 animate-spin" />
            ) : (
              <Sparkles className="mr-1 size-3.5" />
            )}
            Suggest from room &amp; photos
          </Button>
          {suggested && suggested.length > 0 && (
            <div className="flex flex-wrap gap-1" data-scope-suggestions>
              {suggested.map((line) => (
                <button
                  key={line}
                  type="button"
                  className="rounded-full border border-dashed px-2 py-0.5 text-[11px] hover:bg-muted"
                  title="Add to this room's scope"
                  onClick={() => {
                    void onSave(addScopeLine(notes, line));
                    setSuggested((s) => (s ?? []).filter((l) => l !== line));
                  }}
                >
                  + {line}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {readOnly && lines.length === 0 && (
        <p className="text-xs text-muted-foreground">No scope for this room.</p>
      )}
    </div>
  );
}
