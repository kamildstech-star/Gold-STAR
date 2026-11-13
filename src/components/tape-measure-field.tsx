import { useEffect, useId, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatFeet, formatInches, parseFeet, parseInches } from "@/lib/tape-measure";

/**
 * A length box for a crew standing in a room with a tape.
 *
 * It opens the phone's number pad (`inputMode="decimal"`), because that is
 * what a measurement is typed on — but an iPhone's number pad has no ' or "
 * and no space, so `12'6"` cannot be typed on it. Two mark keys appear under
 * the box while it has the keyboard and add them without closing it:
 * 1 2 ′ 6 ″. On Android, and
 * on a laptop, `12-6`, `12 6` and `12.5` work as typed. Whatever goes in is
 * read by `tape-measure.ts`; what was understood is written back in feet and
 * inches when the box is left, and a length it cannot read turns red instead
 * of being saved as a guess.
 *
 * `onDraft` reports every keystroke's reading, so the takeoff tiles move as
 * the crew types rather than after they tap away.
 */
export function TapeField({
  label,
  value,
  unit,
  onCommit,
  onDraft,
  placeholder,
  readOnly,
  className,
}: {
  label: string;
  value: number | null;
  /** "ft": bare numbers are feet (room sizes, cabinet runs). "in": bare numbers are inches (doors). */
  unit: "ft" | "in";
  onCommit: (next: number | null) => void;
  onDraft?: (next: number | null | undefined) => void;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
}) {
  const id = useId();
  const show = (v: number | null) => (unit === "ft" ? formatFeet(v) : formatInches(v));
  const parse = unit === "ft" ? parseFeet : parseInches;
  const [text, setText] = useState(show(value));
  const [bad, setBad] = useState(false);
  const focused = useRef(false);
  /** Mirrors `focused` for rendering the mark keys. */
  const [active, setActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // A value that changes underneath (another device, a held write landing)
  // is shown — but never over what the crew is typing right now.
  useEffect(() => {
    if (!focused.current) setText(show(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, unit]);

  const change = (next: string) => {
    setText(next);
    if (bad) setBad(false);
    if (onDraft) onDraft(next.trim() ? (parse(next) ?? undefined) : null);
  };

  const commit = () => {
    focused.current = false;
    setActive(false);
    // Leaving the box without changing it saves nothing. The box shows the
    // value rounded to an eighth, and reading that back would quietly round
    // the stored figure every time someone tapped through.
    if (text === show(value)) return;
    const trimmed = text.trim();
    const next = trimmed ? parse(trimmed) : null;
    if (trimmed && next == null) {
      setBad(true);
      return;
    }
    setBad(false);
    setText(show(next));
    onDraft?.(undefined);
    if (next !== value) onCommit(next);
  };

  /** Adds a mark without letting the box lose focus (which would commit half a length). */
  const mark = (m: "'" | '"') => {
    change(text.replace(/\s+$/, "") + m);
    inputRef.current?.focus();
  };

  const hint = unit === "ft" ? `Try 12'6", 12-6 or 12.5` : `Try 32 or 2'8"`;

  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        ref={inputRef}
        id={id}
        inputMode="decimal"
        enterKeyHint="done"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        readOnly={readOnly}
        placeholder={placeholder ?? (unit === "ft" ? `12'6"` : `32"`)}
        aria-invalid={bad || undefined}
        className={cn(
          "h-12 text-lg tabular-nums",
          bad && "border-destructive focus-visible:ring-destructive",
        )}
        onFocus={() => {
          focused.current = true;
          setActive(true);
        }}
        onChange={(e) => change(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      {/* Only while the box has the keyboard: that is the only time a mark
          can be typed, and two full-width keys are a thumb's size. */}
      {active && !readOnly && (
        <div className="flex gap-1">
          {(["'", '"'] as const).map((m) => (
            <button
              key={m}
              type="button"
              tabIndex={-1}
              aria-label={m === "'" ? "Type a foot mark" : "Type an inch mark"}
              // Neither press may move focus: by click time the box would
              // already have blurred and committed half a length.
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => mark(m)}
              className="flex h-10 flex-1 items-center justify-center gap-1 rounded-md border bg-muted text-sm text-muted-foreground hover:bg-hover"
            >
              <span className="font-mono text-base text-foreground">{m === "'" ? "′" : "″"}</span>
              {m === "'" ? "feet" : "inches"}
            </button>
          ))}
        </div>
      )}
      {bad && <p className="text-[11px] text-destructive">Could not read that. {hint}</p>}
    </div>
  );
}

/**
 * The +/- SF box. A phone's number pad has no minus key, so the sign is its
 * own button: an L-shape adds, a column or a stair cut-out takes away.
 */
export function SignedSfField({
  label,
  value,
  onCommit,
  onDraft,
  readOnly,
}: {
  label: string;
  value: number;
  onCommit: (next: number) => void;
  onDraft?: (next: number | undefined) => void;
  readOnly?: boolean;
}) {
  const id = useId();
  const [negative, setNegative] = useState(value < 0);
  const [text, setText] = useState(value ? String(Math.abs(value)) : "");
  const focused = useRef(false);

  useEffect(() => {
    if (focused.current) return;
    setNegative(value < 0);
    setText(value ? String(Math.abs(value)) : "");
  }, [value]);

  const read = (t: string, neg: boolean): number | null => {
    const trimmed = t.trim();
    if (!trimmed) return 0;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return null;
    return neg ? -n : n;
  };

  const commitWith = (t: string, neg: boolean) => {
    const next = read(t, neg);
    if (next == null) {
      setText(value ? String(Math.abs(value)) : "");
      setNegative(value < 0);
      return;
    }
    onDraft?.(undefined);
    if (next !== value) onCommit(next);
  };

  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <div className="flex gap-1">
        <Button
          type="button"
          variant="outline"
          className="h-12 w-12 shrink-0"
          disabled={readOnly}
          aria-label={
            negative
              ? "Taking square feet off — tap to add instead"
              : "Adding square feet — tap to take off instead"
          }
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const neg = !negative;
            setNegative(neg);
            if (text.trim()) commitWith(text, neg);
          }}
        >
          {negative ? <Minus className="!size-5" /> : <Plus className="!size-5" />}
        </Button>
        <Input
          id={id}
          inputMode="decimal"
          enterKeyHint="done"
          autoComplete="off"
          value={text}
          readOnly={readOnly}
          placeholder="0"
          className="h-12 min-w-0 flex-1 text-lg tabular-nums"
          onFocus={() => {
            focused.current = true;
          }}
          onChange={(e) => {
            setText(e.target.value);
            const n = read(e.target.value, negative);
            onDraft?.(n == null ? undefined : n);
          }}
          onBlur={() => {
            focused.current = false;
            commitWith(text, negative);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
    </div>
  );
}
