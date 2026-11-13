/**
 * The Client 360 cards, on the account record.
 *
 * Mark, with the Active Clients board and a prospect record side by side:
 * "When clicking on an active client, it's supposed to have the same look as
 * the pipeline, which is this page on the second screenshot. Just the cards
 * that are actually relevant to the active clients?"
 *
 * The board's Client 360 panel was the only place a client's satisfaction,
 * reminders, claim and milestones were ever drawn. A record that lands a rep
 * on the pipeline's layout and leaves those behind is a worse page than the
 * panel it replaces, so they come along — as the SAME components, mounted
 * from `client-360-sections.tsx` and `client-retention-panel.tsx`, not
 * redrawn. The panel and this page cannot disagree about a milestone.
 *
 * Which of the panel's sections, and why:
 *
 *   Satisfaction     the score, editable — nowhere else on the record
 *   Reminders        pending follow-ups with Done — nowhere else either
 *
 * Three that came along at first and went again. Mark, of Claim Details,
 * Milestones and Open Tasks on a client viewed in the prospect layout: "these
 * should not show with prospect on active clients." They are the JOB's cards
 * — carrier and claim, the status ladder, the task list — and on a client with
 * no open job they drew "No open job", six greyed Upcoming rungs and a
 * read-only task list, which is three boxes saying nothing. The job page and
 * the Client 360 panel still show them; the account record does not.
 *
 *   Touch history    NOT here. It is the record of what happened, and the
 *                    Timeline card under the dock is the full version of it.
 *                    The panel carries an eight-row excerpt because the
 *                    panel is not on the record; this page is.
 *   Recent Messages  NOT here, for the same reason — they are on the Timeline.
 *   Invoices         NOT here. Read-only in the panel, and the record's full
 *                    layout has Documents & invoices for the real thing.
 *   Client identity  NOT here. The panel edits the name and address inline
 *                    because it has no header; this page has one, and Edit.
 */
import { useQueryClient } from "@tanstack/react-query";

import { Client360Section, SatisfactionSection } from "@/components/client-360-sections";
import { ReminderList } from "@/components/client-retention-panel";
import { useAccountEditRights } from "@/lib/client-360-edit";
import { cn } from "@/lib/utils";

export function ClientRecordCards({
  accountId,
  locationId,
  assignedRep,
  satisfaction,
  onChanged,
  className,
}: {
  accountId: string;
  /** The owning office and the rep — the two halves of the edit policy. */
  locationId: string | null;
  assignedRep: string | null;
  /** `accounts.satisfaction_score`, as the record read it. */
  satisfaction: number | null;
  /** The record's own refresh, so a saved score shows on the header too. */
  onChanged: () => void;
  className?: string;
}) {
  const qc = useQueryClient();

  const rights = useAccountEditRights({ locationId, assignedRep });

  const saved = () => {
    onChanged();
    // The board's rows carry the score too; a save here must reach them.
    void qc.invalidateQueries({ queryKey: ["active-clients"] });
  };

  return (
    <div data-testid="client-record-cards" className={cn("flex min-w-0 flex-col gap-2", className)}>
      <SatisfactionSection
        accountId={accountId}
        score={satisfaction}
        canEdit={rights.allowed}
        onSaved={saved}
      />
      <Client360Section title="Reminders">
        <ReminderList accountId={accountId} />
      </Client360Section>
    </div>
  );
}
