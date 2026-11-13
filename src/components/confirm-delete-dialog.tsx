import type { ReactNode } from "react";
import { Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
/**
 * The one "are you sure?" before a delete on the Documents and Pictures tabs.
 * The confirm button stays a plain Button (not AlertDialogAction) so the
 * dialog stays up, showing progress, until the delete has answered.
 */
export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  busy = false,
  disabled = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  /** Extra lines under the description: what is kept, what goes with it. */
  children?: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  /** Nothing to delete (e.g. only signed documents picked). */
  disabled?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(v) => !busy && onOpenChange(v)}>
      <AlertDialogContent className="max-h-[85svh] overflow-y-auto">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm text-muted-foreground">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {children ? <div className="space-y-2 text-sm text-foreground">{children}</div> : null}
        <AlertDialogFooter>
          <AlertDialogCancel className="h-11 sm:h-9" disabled={busy}>
            Cancel
          </AlertDialogCancel>
          <Button
            variant="destructive"
            className="h-11 sm:h-9"
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Trash2 className="mr-1.5 size-4" />
            )}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
