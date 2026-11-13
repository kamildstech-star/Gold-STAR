/**
 * "Add to my to-do" wherever a task row appears — the job page's Tasks tab,
 * the account Timeline's ⋯ menu, Needs-you-today and /tasks.
 *
 * Mark: "...tied to tasks the in jobs where you can choose to add that task
 * to the to do list". The choosing happens here: a bookmark glyph on the
 * row, filled when the task is on my list, and the same thing as a menu
 * entry for rows whose actions live in a ⋯ menu. Both are the one
 * `useTodoPin` hook, so a row cannot show a state the list does not hold.
 *
 * Nothing renders until the list is known to exist: before the migration is
 * applied there is no list to add to, and a glyph that does nothing is worse
 * than no glyph.
 */
import { Bookmark, BookmarkCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { toastDbError } from "@/lib/db-errors";
import { TODO_QUEUED_MESSAGE } from "@/lib/todo";
import { useTodoPin, type TodoPinSnapshot } from "@/lib/use-todo";
import { cn } from "@/lib/utils";

export const PIN_LABEL = "Add to my to-do";
export const UNPIN_LABEL = "Remove from my to-do";

function useToggle(taskId: string | null | undefined, snapshot?: TodoPinSnapshot) {
  const pin = useTodoPin(taskId, snapshot);
  const run = async () => {
    try {
      const r = await pin.toggle();
      if (r.queued) toast.info(TODO_QUEUED_MESSAGE);
      else toast.success(r.pinned ? "Added to my to-do" : "Removed from my to-do");
    } catch (e) {
      toastDbError(e, { action: "update your to-do list" });
    }
  };
  return { ...pin, run };
}

/** The glyph. Sized to sit in a row's action cluster. */
export function TodoPinButton({
  taskId,
  snapshot,
  disabled,
  className,
}: {
  taskId: string | null | undefined;
  snapshot?: TodoPinSnapshot;
  disabled?: boolean;
  className?: string;
}) {
  const pin = useToggle(taskId, snapshot);
  if (!pin.available) return null;
  const label = pin.pinned ? UNPIN_LABEL : PIN_LABEL;
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn(
        "size-6 shrink-0",
        pin.pinned
          ? "text-primary hover:text-primary"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
      disabled={disabled || pin.pending}
      title={label}
      aria-label={label}
      aria-pressed={pin.pinned}
      data-todo-pinned={pin.pinned ? "true" : "false"}
      onClick={(e) => {
        e.stopPropagation();
        void pin.run();
      }}
    >
      {pin.pinned ? <BookmarkCheck className="size-3.5" /> : <Bookmark className="size-3.5" />}
    </Button>
  );
}

/** The same toggle as a ⋯ menu entry, for rows whose actions live in one. */
export function TodoPinMenuItem({
  taskId,
  snapshot,
  disabled,
}: {
  taskId: string | null | undefined;
  snapshot?: TodoPinSnapshot;
  disabled?: boolean;
}) {
  const pin = useToggle(taskId, snapshot);
  if (!pin.available) return null;
  return (
    <DropdownMenuItem
      disabled={disabled || pin.pending}
      data-todo-pinned={pin.pinned ? "true" : "false"}
      onSelect={() => void pin.run()}
    >
      {pin.pinned ? (
        <BookmarkCheck className="mr-2 size-3.5 text-primary" />
      ) : (
        <Bookmark className="mr-2 size-3.5" />
      )}
      {pin.pinned ? UNPIN_LABEL : PIN_LABEL}
    </DropdownMenuItem>
  );
}
