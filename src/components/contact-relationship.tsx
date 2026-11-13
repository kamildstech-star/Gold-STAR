import { useState } from "react";
import { Cake, Heart, Pencil } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useWritesDisabled } from "@/components/app-context";

/**
 * The fields that make an account survive a rep change. Same contact record
 * Operations uses — not a parallel one.
 */
export type RelationshipFields = {
  spouse_name: string | null;
  children: string | null;
  family_notes: string | null;
  personal_preferences: string | null;
  likes: string | null;
  dislikes: string | null;
  hobbies: string | null;
  sports_teams: string | null;
  dietary_notes: string | null;
  birthday_month: number | null;
  birthday_day: number | null;
  birthday_year: number | null;
  anniversary_month: number | null;
  anniversary_day: number | null;
  preferred_contact_method: string | null;
  best_time_to_reach: string | null;
  relationship_notes: string | null;
};

const TEXT_FIELDS: { key: keyof RelationshipFields; label: string; long?: boolean }[] = [
  { key: "spouse_name", label: "Spouse / partner" },
  { key: "children", label: "Children" },
  { key: "hobbies", label: "Hobbies" },
  { key: "sports_teams", label: "Teams they follow" },
  { key: "likes", label: "Likes" },
  { key: "dislikes", label: "Dislikes" },
  { key: "dietary_notes", label: "Dietary notes" },
  { key: "preferred_contact_method", label: "Preferred contact method" },
  { key: "best_time_to_reach", label: "Best time to reach" },
  { key: "family_notes", label: "Family notes", long: true },
  { key: "personal_preferences", label: "Personal preferences", long: true },
  { key: "relationship_notes", label: "Relationship notes", long: true },
];

function monthDay(m: number | null, d: number | null): string | null {
  if (!m || !d) return null;
  return `${m}/${d}`;
}

export function ContactRelationship({
  contactId,
  contactName,
  fields,
  onSaved,
}: {
  contactId: string;
  contactName: string;
  fields: RelationshipFields;
  onSaved: () => void;
}) {
  const { disabled, reason } = useWritesDisabled();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RelationshipFields>(fields);
  const [saving, setSaving] = useState(false);

  const filled = TEXT_FIELDS.filter((f) => {
    const v = draft[f.key];
    return typeof v === "string" && v.trim().length > 0;
  });
  const bday = monthDay(fields.birthday_month, fields.birthday_day);
  const anniv = monthDay(fields.anniversary_month, fields.anniversary_day);

  const save = async () => {
    setSaving(true);
    const payload: Record<string, unknown> = {};
    for (const f of TEXT_FIELDS) {
      const v = draft[f.key];
      payload[f.key] = typeof v === "string" && v.trim() ? v.trim() : null;
    }
    for (const k of [
      "birthday_month",
      "birthday_day",
      "birthday_year",
      "anniversary_month",
      "anniversary_day",
    ] as const) {
      const v = draft[k];
      payload[k] = v == null || Number.isNaN(v) ? null : v;
    }
    const { error } = await supabase
      .from("contacts")
      .update(payload as never)
      .eq("id", contactId);
    setSaving(false);
    if (error) {
      toast.error("Could not save", { description: error.message });
      return;
    }
    toast.success("Relationship details saved");
    setOpen(false);
    onSaved();
  };

  return (
    <div className="mt-3 rounded-sm border border-dashed p-2 text-xs">
      <div className="flex items-center gap-2">
        <Heart className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Relationship</span>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            if (o) setDraft(fields);
            setOpen(o);
          }}
        >
          <DialogTrigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-6 px-2 text-[11px]"
              disabled={disabled}
              title={reason ?? undefined}
            >
              <Pencil className="mr-1 size-3" />
              Edit
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Relationship details · {contactName}</DialogTitle>
              <DialogDescription>
                Birthdays, family, preferences. This is what keeps an account when the rep changes.
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 grid grid-cols-3 gap-2">
                <div>
                  <Label className="text-[11px]">Birthday month</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={draft.birthday_month ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        birthday_month: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
                <div>
                  <Label className="text-[11px]">Day</Label>
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={draft.birthday_day ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        birthday_day: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
                <div>
                  <Label className="text-[11px]">Year (optional)</Label>
                  <Input
                    type="number"
                    value={draft.birthday_year ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        birthday_year: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
              </div>

              <div className="col-span-2 grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-[11px]">Anniversary month</Label>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    value={draft.anniversary_month ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        anniversary_month: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
                <div>
                  <Label className="text-[11px]">Anniversary day</Label>
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={draft.anniversary_day ?? ""}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        anniversary_day: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
              </div>

              {TEXT_FIELDS.map((f) => (
                <div key={f.key} className={f.long ? "col-span-2" : ""}>
                  <Label className="text-[11px]">{f.label}</Label>
                  {f.long ? (
                    <Textarea
                      rows={2}
                      value={(draft[f.key] as string | null) ?? ""}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    />
                  ) : (
                    <Input
                      value={(draft[f.key] as string | null) ?? ""}
                      onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving || disabled}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
        {bday && (
          <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5">
            <Cake className="size-3" /> {bday}
          </span>
        )}
        {anniv && <span className="rounded-md border px-1.5 py-0.5">Anniversary {anniv}</span>}
        {filled.map((f) => (
          <span key={f.key} className="rounded-md border px-1.5 py-0.5">
            <span className="text-foreground">{f.label}:</span>{" "}
            {String(fields[f.key] ?? "").slice(0, 60)}
          </span>
        ))}
        {!bday && !anniv && filled.length === 0 && (
          <span>Nothing recorded yet. Birthday and family details go here.</span>
        )}
      </div>
    </div>
  );
}
