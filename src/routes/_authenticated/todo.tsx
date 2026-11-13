import { createFileRoute, Link } from "@tanstack/react-router";

import { TodoList } from "@/components/todo/todo-list";
import { EmptyLine, LoadError, PageHeader } from "@/components/ui-density";
import { partitionTodo } from "@/lib/todo";
import { useTodoList } from "@/lib/use-todo";

/**
 * /todo — the rep's own list, in full.
 *
 * Mark: "Can we add a to do list (linked to jobs) which would be user
 * specific & potentially tied to tasks the in jobs where you can choose to
 * add that task to the to do list"
 *
 * Not /tasks. That page is the work assigned to you; this is what you chose
 * to keep in front of you — some of it tasks (yours or somebody else's,
 * bookmarked from a job), some of it your own notes. The list is
 * `TodoList`; this file is the frame: the header count, the load states,
 * and what to say before the migration is applied.
 */
export const Route = createFileRoute("/_authenticated/todo")({
  head: () => ({
    meta: [
      { title: "My to-do · Recovery Hub" },
      {
        name: "description",
        content: "Your own to-do list: job tasks you bookmarked and quick notes to yourself.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: TodoPage,
});

function TodoPage() {
  const list = useTodoList();
  const { open, doneToday } = partitionTodo(list.data.items);

  return (
    <div className="space-y-3 p-3 md:p-4">
      <PageHeader
        title="My to-do"
        count={list.data.available ? `${open.length} left` : undefined}
        subtitle={
          list.data.available
            ? doneToday.length > 0
              ? `${doneToday.length} done today`
              : "Job tasks you bookmarked, and notes to yourself."
            : undefined
        }
      >
        <Link to="/tasks" className="text-[12px] text-primary hover:underline">
          Tasks assigned to me
        </Link>
      </PageHeader>

      {list.isError ? (
        <LoadError what="your to-do list" error={list.error} onRetry={() => list.refetch()} />
      ) : list.isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : !list.data.available ? (
        <EmptyLine className="rounded-md border">
          Your to-do list is not set up yet — it arrives with the next database update. Until then,
          your tasks are on the Tasks page.
        </EmptyLine>
      ) : (
        <div className="max-w-3xl">
          <TodoList />
        </div>
      )}
    </div>
  );
}
