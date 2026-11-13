/**
 * The company's people on General, as up to two small boxes.
 *
 * Melly, 6 Nov: "instead of these people like this, maybe just make them like
 * widgets, like boxes, and you can click in and see their information" — and
 * "if I click on the person ... it'll take me to their contact with all their
 * information". A box carries the name and the role only; the phone and the
 * email live once, in the contact itself (and the Contacts tab), so the page
 * stops showing the same number in three places.
 */
import { ChevronRight, Plus, UserRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { initials } from "@/lib/active-clients";
import { cn } from "@/lib/utils";

export type ContactBox = {
  id: string;
  full_name: string;
  title: string | null;
  is_primary: boolean;
};

export function AccountContactBoxes({
  contacts,
  onOpen,
  onSeeAll,
  onAdd,
  max = 2,
  addDisabled,
}: {
  contacts: ContactBox[];
  onOpen: (contactId: string) => void;
  onSeeAll: () => void;
  onAdd: () => void;
  max?: number;
  addDisabled?: boolean;
}) {
  const shown = contacts.slice(0, max);
  const more = contacts.length - shown.length;

  return (
    <section className="@container rounded-xl border bg-card p-4" aria-label="Contacts">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Contacts</h2>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[12px]"
          onClick={onAdd}
          disabled={addDisabled}
        >
          <Plus className="mr-1 size-3.5" /> Add
        </Button>
      </div>
      {shown.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No contacts yet.</p>
      ) : (
        <div className="grid gap-2 @min-[34rem]:grid-cols-2" data-testid="account-contact-boxes">
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onOpen(c.id)}
              className="group flex min-w-0 items-center gap-2.5 rounded-lg border bg-background px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[12px] font-semibold text-primary"
              >
                {initials(c.full_name) || <UserRound className="size-4" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{c.full_name}</span>
                <span className="block truncate text-[12px] text-muted-foreground">
                  {c.title || (c.is_primary ? "Primary contact" : "Contact")}
                </span>
              </span>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </button>
          ))}
        </div>
      )}
      {more > 0 ? (
        <button
          type="button"
          onClick={onSeeAll}
          className={cn("mt-2 text-[12.5px] font-medium text-primary hover:underline")}
        >
          +{more} more · See all contacts
        </button>
      ) : null}
    </section>
  );
}
