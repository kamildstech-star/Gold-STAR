import type { ReactNode } from "react";

import { T } from "@/components/bilingual";
import { JOB_TAB_ICON } from "@/components/job-tab-icon";
import { Tabs, TabsContent, TabsCount, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { JOB_TAB_LABEL, type JobTab } from "@/lib/job-tab-order";

export type InnerTab = {
  key: JobTab;
  /** Instead of the tab's own name ("All photos" for Pictures). */
  label?: string;
  count?: number;
  content: ReactNode;
};

/**
 * Tabs inside a job tab (5 Nov: "make tabs inside tabs" — the merged tabs
 * were one long page). Schedule | Tasks, Rooms | All photos, Contacts |
 * Communications, Drying log | Equipment: the tab's own content first, the
 * one merged into it second, each with its count. The same segmented strip
 * as the job's own tabs, a size smaller. Which one is open is the page's
 * `section` param, so a reload or an old link opens the same one.
 */
export function JobInnerTabs({
  value,
  onValueChange,
  tabs,
}: {
  value: JobTab;
  onValueChange: (next: JobTab) => void;
  tabs: readonly InnerTab[];
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(v) => onValueChange(v as JobTab)}
      className="space-y-3"
      data-job-inner-tabs
    >
      <TabsList className="max-md:w-full">
        {tabs.map((t) => {
          const Icon = JOB_TAB_ICON[t.key];
          return (
            <TabsTrigger key={t.key} value={t.key} className="h-8 text-[13px]">
              <Icon aria-hidden />
              <T>{t.label ?? JOB_TAB_LABEL[t.key]}</T>
              {t.count ? <TabsCount>{t.count}</TabsCount> : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.key} value={t.key} className="mt-0 space-y-3">
          {t.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
