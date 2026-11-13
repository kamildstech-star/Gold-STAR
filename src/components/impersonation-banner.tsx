import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { EyeOff, Info, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppContext } from "@/components/app-context";
import { endImpersonation, popReturnPath } from "@/lib/impersonation";
import { ROLE_LABELS } from "@/lib/roles";
import { VIEW_AS_ALLOWED_META, VIEW_AS_CAVEAT, roleListLabel } from "@/lib/view-as";
import { useRouter } from "@tanstack/react-router";

/**
 * Persistent, high-contrast banner rendered at the top of every screen
 * while impersonation is active. Uses a colour that appears nowhere else
 * in the app so it is impossible to forget you are in View As.
 *
 * It lives in the app shell, above the router outlet, so it survives every
 * navigation; it disappears with the identity on sign-out.
 */
export function ImpersonationBanner() {
  const { impersonation, viewingAsPerson, realRoles, refreshImpersonation } = useAppContext();
  const router = useRouter();
  const qc = useQueryClient();
  const [exiting, setExiting] = useState(false);

  const exitMut = useMutation({
    // Switching back is the one thing a read-only view must always allow.
    meta: VIEW_AS_ALLOWED_META,
    mutationFn: endImpersonation,
    onSuccess: async () => {
      await refreshImpersonation();
      qc.invalidateQueries();
      const back = popReturnPath();
      if (back) router.navigate({ to: back });
      toast.success(viewingAsPerson ? "Switched back to you" : "Exited View As");
    },
    onError: (e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Failed to exit");
      setExiting(false);
    },
  });

  if (!impersonation) return null;

  const exitButton = (label: string) => (
    <Button
      size="sm"
      variant="secondary"
      className="shrink-0 bg-card text-fuchsia-800 hover:bg-card/90 dark:text-fuchsia-300"
      disabled={exiting || exitMut.isPending}
      onClick={() => {
        setExiting(true);
        exitMut.mutate();
      }}
    >
      <EyeOff className="mr-1.5 size-4" />
      {label}
    </Button>
  );

  /*
   * Mark, 11 Oct: "I also want to be able to view as specific people." The
   * banner says whose eyes these are, that nothing can be changed, and — in
   * the tooltip — what a preview that is not a real sign-in cannot promise.
   */
  if (viewingAsPerson) {
    const detail = [roleListLabel(viewingAsPerson.roles), viewingAsPerson.officeName]
      .filter(Boolean)
      .join(", ");
    return (
      <div
        role="status"
        aria-live="polite"
        data-view-as="person"
        className="sticky top-0 z-50 border-b border-fuchsia-900/50 bg-fuchsia-700 text-white"
        style={{ background: "#a21caf" }}
      >
        <div className="flex items-center gap-3 px-3 py-2 text-sm">
          <ShieldAlert className="size-5 shrink-0" aria-hidden />
          <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
            <span className="font-semibold">Viewing as</span>
            <span className="truncate font-semibold">{viewingAsPerson.name}</span>
            <span className="opacity-90">({detail})</span>
            <span aria-hidden>—</span>
            <span className="rounded-sm bg-white/20 px-1.5 text-[12px] font-semibold uppercase tracking-wide">
              Read only
            </span>
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 self-center text-[11px] underline decoration-dotted underline-offset-2 opacity-90 hover:opacity-100"
                    aria-label="What this preview can and cannot show"
                    title={VIEW_AS_CAVEAT}
                  >
                    <Info className="size-3.5" aria-hidden />
                    Preview limits
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-sm leading-snug">
                  {VIEW_AS_CAVEAT}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {exitButton("Switch back")}
        </div>
      </div>
    );
  }

  const scope = impersonation.target_scope;
  const roleList = scope?.roles?.length
    ? scope.roles.map((r) => ROLE_LABELS[r] ?? r).join(",")
    : impersonation.preview_role
      ? `${ROLE_LABELS[impersonation.preview_role]} (preview)`
      : "no roles";
  const who =
    scope?.full_name ||
    scope?.email ||
    (impersonation.preview_role
      ? `${ROLE_LABELS[impersonation.preview_role]} preview`
      : "unknown user");
  const locCount = scope?.location_ids?.length ?? 0;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-50 border-b border-fuchsia-900/50 bg-fuchsia-700 text-white"
      style={{ background: "#a21caf" }}
    >
      <div className="flex items-center gap-3 px-3 py-2 text-sm">
        <ShieldAlert className="size-5 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">Viewing as</span>
            <span className="truncate font-medium">{who}</span>
            <span className="opacity-90">· {roleList}</span>
            {locCount > 0 && <span className="opacity-90">· {locCount} location(s)</span>}
          </div>
          <div className="text-[11px] opacity-80">
            Writes are disabled. Your real roles ({realRoles.length}) still bound what you can see —
            View As can only narrow, never widen.
          </div>
        </div>
        {exitButton("Exit View As")}
      </div>
    </div>
  );
}
