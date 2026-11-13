/**
 * The tradeshow add/edit form.
 *
 * Mark, of the Edit button on a show's own page: "This edit button doesn't work
 * at all. It just takes you back to the page for trade shows." It did exactly
 * that -- navigated to the list with a tooltip saying "Edit from the list" --
 * because this dialog lived inside the list page and nowhere else. Now it is
 * its own component and both pages open it.
 */
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LocationPicker } from "@/components/location-picker";
import { toastDbError } from "@/lib/db-errors";
import { saveTradeshow, type Tradeshow } from "@/lib/tradeshows";

export function ShowDialog({
  show,
  onClose,
  onSaved,
}: {
  show: Tradeshow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = React.useState(show?.name ?? "");
  const [city, setCity] = React.useState(show?.city ?? "");
  const [state, setState] = React.useState(show?.state ?? "");
  const [startsOn, setStartsOn] = React.useState(show?.starts_on ?? "");
  const [endsOn, setEndsOn] = React.useState(show?.ends_on ?? "");
  const [cost, setCost] = React.useState(String(show?.cost ?? ""));
  const [leads, setLeads] = React.useState(String(show?.leads_captured ?? ""));
  const [notes, setNotes] = React.useState(show?.notes ?? "");
  const [locationId, setLocationId] = React.useState<string>(show?.location_id ?? "");

  const save = useMutation({
    mutationFn: () =>
      saveTradeshow({
        id: show?.id,
        name: name.trim(),
        city: city.trim() || null,
        state: state.trim() || null,
        starts_on: startsOn || null,
        ends_on: endsOn || null,
        cost: Number(cost) || 0,
        leads_captured: Number(leads) || 0,
        notes: notes.trim() || null,
        location_id: locationId || null,
      }),
    onSuccess: () => {
      toast.success(show ? "Show updated" : "Show added");
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "save show" }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{show ? "Edit show" : "Add show"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <div>
            <Label className="text-[11px]">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px]">City</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} className="h-8" />
            </div>
            <div>
              <Label className="text-[11px]">State</Label>
              <Input value={state} onChange={(e) => setState(e.target.value)} className="h-8" />
            </div>
            <div>
              <Label className="text-[11px]">Starts</Label>
              <Input
                type="date"
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-[11px]">Ends</Label>
              <Input
                type="date"
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-[11px]">Cost</Label>
              <NumberInput
                decimals={2}
                value={cost}
                onValueChange={(_, clean) => setCost(clean)}
                className="h-8"
              />
            </div>
            <div>
              <Label className="text-[11px]">Legacy lead estimate</Label>
              <Input
                inputMode="numeric"
                value={leads}
                onChange={(e) => setLeads(e.target.value)}
                className="h-8"
              />
              <p className="mt-1 text-[10.5px] text-muted-foreground">
                Used only if attributed-account ROI data is unavailable.
              </p>
            </div>
          </div>
          <div>
            <Label className="text-[11px]">Office</Label>
            <LocationPicker value={locationId} onChange={setLocationId} />
          </div>
          <div>
            <Label className="text-[11px]">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
