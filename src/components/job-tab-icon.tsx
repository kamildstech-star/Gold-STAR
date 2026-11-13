import {
  Calendar,
  CalendarClock,
  ClipboardList,
  Clock,
  DollarSign,
  Droplets,
  FileText,
  Globe,
  Home,
  Image,
  LayoutGrid,
  ListChecks,
  MessageSquare,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

import { T } from "@/components/bilingual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { JOB_TAB_LABEL, type JobTab } from "@/lib/job-tab-order";

/**
 * One icon per job tab (3 Nov redesign). Fifteen labels in a row are hard to
 * scan; an icon beside each one lets the eye find Billing or Pictures without
 * reading the strip.
 */
export const JOB_TAB_ICON: Record<JobTab, LucideIcon> = {
  general: Home,
  contacts: Users,
  tasks: ListChecks,
  billing: DollarSign,
  pictures: Image,
  documents: FileText,
  communications: MessageSquare,
  timeline: CalendarClock,
  schedule: Calendar,
  timecard: Clock,
  rooms: LayoutGrid,
  drying: Droplets,
  equipment: Wrench,
  ticket: ClipboardList,
  portal: Globe,
};

/**
 * The frame for a tab whose panel has no card of its own (Contacts, Tasks,
 * Communications, Timeline, Schedule, Drying log). Without it those tabs were
 * loose content on the page background while every other tab sat in cards;
 * this gives them the same header — icon and name — and the same edge.
 */
export function JobTabCard({ tab, children }: { tab: JobTab; children: React.ReactNode }) {
  const Icon = JOB_TAB_ICON[tab];
  return (
    <Card data-job-tab-card={tab}>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        <CardTitle>
          <T>{JOB_TAB_LABEL[tab]}</T>
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
