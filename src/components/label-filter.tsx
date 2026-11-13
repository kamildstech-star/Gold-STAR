import { useQuery } from "@tanstack/react-query";
import { Tag as TagIcon } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { fetchLabels, type LabelScope } from "@/lib/labels";

export const ALL_LABELS = "all";

export function LabelFilter({
  scope,
  value,
  onChange,
  className,
}: {
  scope: LabelScope;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const labelsQ = useQuery({ queryKey: ["labels", scope], queryFn: () => fetchLabels(scope) });

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className ?? "filter-chip w-[160px]"}>
        <TagIcon className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue placeholder="All labels" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_LABELS}>All labels</SelectItem>
        {(labelsQ.data ?? []).map((l) => (
          <SelectItem key={l.id} value={l.id}>
            <span className="flex items-center gap-2">
              <span className="size-2.5 rounded-full" style={{ backgroundColor: l.color }} />
              {l.name}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
