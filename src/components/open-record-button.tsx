import { useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import type { ActivityEntry } from "@/lib/activity";
import {
  RECORD_DELETED_MESSAGE,
  activityHasTarget,
  resolveActivityTarget,
  supabaseRecordLookup,
  type ActivityTarget,
  type RecordLookup,
} from "@/lib/activity-open";
import { toastDbError } from "@/lib/db-errors";

/**
 * History's "Open record": resolves the entry to the record itself when
 * pressed (src/lib/activity-open.ts) and goes there through the router's
 * typed navigation. A button, not a link, because where it goes needs a read
 * first — and a record that is gone gets a toast instead of a dead click.
 */
export function OpenRecordButton({
  entry,
  className,
  children = "Open record",
  lookup = supabaseRecordLookup,
}: {
  entry: ActivityEntry;
  className?: string;
  children?: ReactNode;
  /** Tests pass their own; the app reads the database. */
  lookup?: RecordLookup;
}) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!activityHasTarget(entry)) return null;

  const go = (t: ActivityTarget) => {
    switch (t.kind) {
      case "deleted":
        toast.error(RECORD_DELETED_MESSAGE);
        return;
      case "job":
        void navigate({ to: "/jobs/$id", params: { id: t.jobId }, search: t.search });
        return;
      case "account":
        void navigate({ to: "/accounts/$id", params: { id: t.id } });
        return;
      case "estimate":
        void navigate({ to: "/estimates/$id", params: { id: t.id } });
        return;
      case "contact":
        void navigate({ to: "/contacts", search: { sel: t.id } });
        return;
      case "user":
        void navigate({ to: "/admin/users/$userId", params: { userId: t.id } });
        return;
      case "page":
        switch (t.to) {
          case "/pipeline":
            void navigate({ to: "/pipeline" });
            return;
          case "/tasks":
            void navigate({ to: "/tasks" });
            return;
          case "/documents":
            void navigate({ to: "/documents" });
            return;
          case "/billing":
            void navigate({ to: "/billing" });
            return;
          case "/mail":
            void navigate({ to: "/mail" });
            return;
          case "/admin/automations":
            void navigate({ to: "/admin/automations" });
            return;
        }
    }
  };

  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      data-open-record=""
      className={className ?? "underline underline-offset-2 disabled:opacity-60"}
      onClick={async () => {
        setBusy(true);
        try {
          const target = await resolveActivityTarget(entry, lookup);
          if (target) go(target);
        } catch (e) {
          toastDbError(e, { action: "open that record" });
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </button>
  );
}
