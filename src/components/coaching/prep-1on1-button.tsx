import { Link } from "@tanstack/react-router";
import { ClipboardList } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * "Prep 1:1" — the manager opens the pack rather than assembling it. Placed on
 * any rep row or profile; the pack itself is RLS-scoped, so this is a
 * shortcut, not a permission.
 */
export function Prep1on1Button({
  userId,
  name,
  size = "sm",
  variant = "outline",
  label = "Prep 1:1",
}: {
  userId: string;
  name?: string | null;
  size?: "sm" | "default" | "icon";
  variant?: "outline" | "ghost" | "secondary" | "default";
  label?: string;
}) {
  return (
    <Button asChild size={size} variant={variant}>
      <Link
        to="/coaching/pack/$userId"
        params={{ userId }}
        search={{ name: name ?? "" }}
        onClick={(e) => e.stopPropagation()}
      >
        <ClipboardList className="mr-1 size-4" />
        {label}
      </Link>
    </Button>
  );
}
