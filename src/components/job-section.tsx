import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { T } from "@/components/bilingual";
import { JOB_TAB_ICON } from "@/components/job-tab-icon";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TabsCount } from "@/components/ui/tabs";
import { JOB_TAB_LABEL, type JobTab } from "@/lib/job-tab-order";
import { cn } from "@/lib/utils";

const KEY = "job-section:collapsed";

function readCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * A former tab shown as a section of the General tab (5 Nov, round 2:
 * Equipment and Timeline): the old tab's icon, name and count in the
 * header, its content unchanged below. Collapsible, remembered per browser;
 * `defaultCollapsed` for one that should start folded (Timeline).
 *
 * `revealAt` opens it: the page sets it when a link or button asks for the
 * old tab (`?tab=equipment`, the header's on-site chip).
 */
export function JobSection({
  section,
  title,
  count,
  revealAt,
  defaultCollapsed = false,
  children,
  contentClassName,
}: {
  section: JobTab;
  /** Instead of the old tab's name ("All photos" for Pictures). */
  title?: string;
  count?: number;
  revealAt?: number;
  defaultCollapsed?: boolean;
  children: ReactNode;
  contentClassName?: string;
}) {
  const Icon = JOB_TAB_ICON[section];
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  useEffect(
    () => setCollapsed(readCollapsed()[section] ?? defaultCollapsed),
    [section, defaultCollapsed],
  );
  useEffect(() => {
    if (revealAt) setCollapsed(false);
  }, [revealAt]);
  const toggle = () =>
    setCollapsed((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(KEY, JSON.stringify({ ...readCollapsed(), [section]: next }));
      } catch {
        /* private mode: the choice lasts for the visit */
      }
      return next;
    });

  return (
    <Card data-job-section={section} className="scroll-mt-4">
      <CardHeader className="space-y-0 p-0">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex w-full items-center gap-2 px-[var(--card-padding)] py-[var(--card-padding-tight)] text-left"
        >
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <CardTitle className="flex items-center gap-2">
            <T>{title ?? JOB_TAB_LABEL[section]}</T>
            {count ? <TabsCount>{count}</TabsCount> : null}
          </CardTitle>
          <ChevronDown
            className={cn(
              "ml-auto size-4 text-muted-foreground transition-transform",
              collapsed && "-rotate-90",
            )}
            aria-hidden
          />
        </button>
      </CardHeader>
      {!collapsed && (
        <CardContent className={cn("border-t pt-[var(--card-padding)]", contentClassName)}>
          {children}
        </CardContent>
      )}
    </Card>
  );
}
