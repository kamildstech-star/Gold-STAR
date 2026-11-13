/**
 * "My to-do · 3 left" — the dashboard's cut of the list, as sticky notes or
 * as the list.
 *
 * David, 22 Sep: "on the dashboard, every user should have their tasks on
 * their dashboard also... maybe like sticky notes type of thing... your tasks
 * for that day, or for each property." The notes (todo-notes.tsx) are the
 * default and can be grouped by today, by day or by property; "List" is the
 * card as it was. The choice is kept per person. Showing or hiding the card
 * itself is the dashboard's own customization, unchanged — it is still the
 * `my_todo` card.
 *
 * The list needs the to-do migration; the notes also carry my assigned
 * tasks, so they show even where the list is not set up yet.
 */
import { Link } from "@tanstack/react-router";
import { ChevronRight, ListChecks } from "lucide-react";

import { TodoList } from "@/components/todo/todo-list";
import { TodoNotes, useTodoView } from "@/components/todo/todo-notes";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { todoSummary } from "@/lib/todo";
import { NOTE_GROUPING_LABEL, type NoteGrouping, type TodoCardView } from "@/lib/todo-notes";
import { useTodoList } from "@/lib/use-todo";
import { cn } from "@/lib/utils";

const VIEWS: { value: TodoCardView; label: string }[] = [
  ...(Object.keys(NOTE_GROUPING_LABEL) as NoteGrouping[]).map((g) => ({
    value: `notes:${g}` as TodoCardView,
    label: NOTE_GROUPING_LABEL[g],
  })),
  { value: "list", label: "List" },
];

export function MyTodoCard() {
  const { data, isLoading } = useTodoList();
  const [view, setView] = useTodoView();
  const notes = view.startsWith("notes:");
  if (!notes && !isLoading && !data.available) return null;
  return (
    <Card data-card="my_todo">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-1.5">
          <ListChecks className="h-4 w-4 text-muted-foreground" />
          My to-do
          {data.available ? (
            <span className="font-normal text-muted-foreground"> · {todoSummary(data.items)}</span>
          ) : null}
        </CardTitle>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Show my to-do as">
            {VIEWS.map((v) => (
              <button
                key={v.value}
                type="button"
                aria-pressed={view === v.value}
                onClick={() => setView(v.value)}
                className={cn(
                  "min-h-9 rounded px-2 text-[11px]",
                  view === v.value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                {v.label}
              </button>
            ))}
          </div>
          <Link
            to="/todo"
            className="inline-flex items-center gap-0.5 text-[12px] font-medium text-primary"
          >
            Full list
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <div className="text-[13px] text-muted-foreground">Loading…</div>
        ) : notes ? (
          <TodoNotes grouping={view.slice("notes:".length) as NoteGrouping} />
        ) : (
          <TodoList compact />
        )}
      </CardContent>
    </Card>
  );
}
