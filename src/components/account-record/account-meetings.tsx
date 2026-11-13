/**
 * The Meetings tab: what is booked, then what has happened.
 *
 * Booked meetings are tasks scheduled as a Meeting or Site visit (the
 * composer turns a future-dated meeting into one), and open the task pop-up
 * like any task. Past meetings are the meeting touchpoints — in person or
 * virtual, captured from the calendar or logged by hand — newest first.
 */
import { format } from "date-fns";
import { MapPin, Video } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyLine } from "@/components/ui-density";
import { AccountTaskList } from "@/components/account-record/account-task-list";
import { MEETING_ACTIVITY_KEYS } from "@/lib/account-tasks";

export type MeetingTouch = {
  id: string;
  type: string;
  occurred_at: string;
  notes: string | null;
  meeting_held: boolean | null;
  counts_toward_cadence: boolean | null;
  contact_id: string | null;
};

export function AccountMeetings({
  accountId,
  touches,
  contactName,
  onOpenTask,
}: {
  accountId: string;
  touches: MeetingTouch[];
  contactName: (id: string | null) => string | null;
  onOpenTask: (taskId: string) => void;
}) {
  const past = touches
    .filter((t) => t.type === "meeting_in_person" || t.type === "meeting_virtual")
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

  return (
    <div className="grid items-start gap-4 sm:gap-5 @min-[900px]:grid-cols-2">
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-[15px] font-semibold">Booked</h2>
        <AccountTaskList
          accountId={accountId}
          onOpen={onOpenTask}
          showDone
          filter={(t) => (MEETING_ACTIVITY_KEYS as readonly string[]).includes(t.activityKey ?? "")}
          emptyText="No meetings booked. Schedule one from General › Activity with a future date."
        />
      </section>
      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-2 text-[15px] font-semibold">Held</h2>
        {past.length === 0 ? (
          <EmptyLine>No meetings on record yet.</EmptyLine>
        ) : (
          <ul className="divide-y" data-testid="account-meetings-held">
            {past.map((m) => {
              const Icon = m.type === "meeting_virtual" ? Video : MapPin;
              const who = contactName(m.contact_id);
              return (
                <li key={m.id} className="flex items-start gap-2.5 py-2.5">
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[13.5px] font-medium">
                        {m.type === "meeting_virtual" ? "Virtual meeting" : "In-person meeting"}
                      </span>
                      {m.meeting_held === false ? (
                        <Badge variant="outline" className="text-[10.5px]">
                          Not held
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-[12px] text-muted-foreground">
                      {format(new Date(m.occurred_at), "EEE d MMM yyyy, h:mm a")}
                      {who ? ` · ${who}` : ""}
                    </div>
                    {m.notes ? (
                      <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px]">
                        {m.notes}
                      </p>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
