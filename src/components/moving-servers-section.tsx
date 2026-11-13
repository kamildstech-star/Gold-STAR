// TODO(remove after cutover): the Owner's tools for moving the app off
// Lovable. Delete this section (and everything in it) once the move is done.
/**
 * "Moving servers" on /admin/security — one Owner-only place for the one-off
 * tools the move needs (Transfer secrets now; the storage file list belongs
 * here too). Each card is gated by its own server function; this heading is
 * hidden from everyone else only so admins are not shown buttons that would
 * refuse them.
 */
import type { ReactNode } from "react";

import { useAppContext } from "@/components/app-context";

export function MovingServersSection({ children }: { children: ReactNode }) {
  const app = useAppContext();
  if (!app.roles.includes("owner")) return null;
  return (
    <section className="space-y-2 pt-2" aria-labelledby="moving-servers-heading">
      <div>
        <h2
          id="moving-servers-heading"
          className="display-heavy text-[15px] uppercase tracking-[0.05em]"
        >
          Moving servers
        </h2>
        <p className="text-sm text-muted-foreground">
          Owner only, temporary. One-off tools for moving Recovery Hub to its new host.
        </p>
      </div>
      {children}
    </section>
  );
}
