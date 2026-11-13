import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { useAppContext } from "@/components/app-context";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { rememberReturnPath, startImpersonationAs } from "@/lib/impersonation";
import { isPrivileged } from "@/lib/roles";
import {
  fetchPickablePeople,
  roleListLabel,
  searchPeople,
  VIEW_AS_ALLOWED_META,
  type PickablePerson,
} from "@/lib/view-as";

/**
 * The "View as person…" picker behind the sidebar's View As switcher.
 *
 * Mark, 11 Oct: "I also want to be able to view as specific people." Lists
 * active, approved staff by name with their roles and office, searchable by
 * any of the three. Picking someone opens a View As through the same audited
 * `start_impersonation` the Users page uses — a preview, never a sign-in.
 *
 * Shown to exactly the people who see "View as role" (isPrivileged on the
 * REAL roles), and start_impersonation refuses anyone else server-side.
 */
export function ViewAsPersonPicker({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const allowed = isPrivileged(app.realRoles);

  const people = useQuery({
    queryKey: ["view-as-people", app.userId, app.allLocations.length],
    enabled: open && allowed && !!app.userId,
    staleTime: 60_000,
    queryFn: () => fetchPickablePeople(app.userId, app.allLocations),
  });

  const start = useMutation({
    // Starting (or switching) a view is about the view itself, so it is
    // allowed while another person view is on; nothing is written in anyone
    // else's name — the audit row is the admin's.
    meta: VIEW_AS_ALLOWED_META,
    mutationFn: (person: PickablePerson) => startImpersonationAs(person.userId),
    onSuccess: async (_id, person) => {
      if (!app.isImpersonating) rememberReturnPath(window.location.pathname);
      await app.refreshImpersonation();
      qc.invalidateQueries();
      onOpenChange(false);
      setQuery("");
      toast.success(`Viewing as ${person.name} — read only`);
      navigate({ to: "/" });
    },
    onError: (e: unknown) =>
      toast.error(e instanceof Error ? e.message : "Could not start View As"),
  });

  const shown = useMemo(() => searchPeople(people.data ?? [], query), [people.data, query]);
  const current = app.viewingAsPerson?.userId ?? null;

  if (!allowed) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <DialogContent className="overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="px-4 pt-4">
          <DialogTitle>View as person</DialogTitle>
          <DialogDescription className="text-[12px]">
            See the app as this person sees it — their pages, offices and "my" lists. Read only; you
            stay signed in as yourself.
          </DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="rounded-none border-t">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search by name, role or office…"
            autoFocus
          />
          <CommandList className="max-h-[360px]">
            {people.isPending ? (
              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                Loading staff…
              </div>
            ) : people.isError ? (
              <div className="px-3 py-6 text-center text-[12px] text-destructive">
                Could not load staff.
              </div>
            ) : (
              <>
                <CommandEmpty>No active staff match "{query}".</CommandEmpty>
                <CommandGroup>
                  {shown.map((p) => (
                    <CommandItem
                      key={p.userId}
                      value={p.userId}
                      disabled={start.isPending || p.userId === current}
                      onSelect={() => start.mutate(p)}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="text-[13px] font-medium">
                        {p.name}
                        {p.userId === current ? " · viewing now" : ""}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {roleListLabel(p.roles)}
                        {p.officeName ? ` · ${p.officeName}` : ""}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
