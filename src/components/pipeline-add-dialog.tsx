import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
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
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LocationPicker } from "@/components/location-picker";
import { CustomerPicker, emptyCustomer, type PickedCustomer } from "@/components/customer-picker";
import { PRIORITIES, PRIORITY_LABEL, type PipelineStage, type Priority } from "@/lib/pipeline";

type LocationLite = { id: string; code: string; name: string };
type PersonLite = { user_id: string; full_name: string | null };

type Common = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  stages: PipelineStage[];
  locations: LocationLite[];
  people: PersonLite[];
  defaultLocationId: string | null;
  /** Set when the dialog is opened from a column's ghost "+" — land in that stage. */
  defaultStageId?: string | null;
  userId: string | null;
  onDone: () => void;
};

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
    qc.invalidateQueries({ queryKey: ["pipeline-won"] });
  };
}

export function AddOpportunityDialog(props: Common) {
  const { stages, people } = props;
  const invalidate = useInvalidate();
  const [customer, setCustomer] = React.useState<PickedCustomer>(() => emptyCustomer("company"));
  const name = customer.name;
  const existingId = customer.accountId;
  const [locationId, setLocationId] = React.useState(props.defaultLocationId ?? "");
  const [stageId, setStageId] = React.useState(props.defaultStageId ?? stages[0]?.id ?? "");
  const [rep, setRep] = React.useState(props.userId ?? "");
  const [priority, setPriority] = React.useState<Priority>("normal");
  const [lostReason, setLostReason] = React.useState("");

  React.useEffect(() => {
    if (props.open) {
      setCustomer(emptyCustomer("company"));
      setLocationId(props.defaultLocationId ?? "");
      setStageId(props.defaultStageId ?? stages[0]?.id ?? "");
      setRep(props.userId ?? "");
      setPriority("normal");
      setLostReason("");
    }
  }, [props.open, props.defaultLocationId, props.defaultStageId, props.userId, stages]);

  const stage = stages.find((s) => s.id === stageId);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("accounts").insert({
        name: name.trim(),
        location_id: locationId,
        stage_id: stageId,
        assigned_rep: rep || null,
        created_by: props.userId,
        priority,
        lost_reason: stage?.is_lost ? lostReason.trim() : null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Opportunity added");
      invalidate();
      props.onOpenChange(false);
      props.onDone();
    },
    onError: (e) => toastDbError(e, { action: "add the opportunity" }),
  });

  const valid =
    !existingId &&
    name.trim().length >= 2 &&
    locationId &&
    stageId &&
    (!stage?.is_lost || lostReason.trim().length > 0);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add opportunity</DialogTitle>
          <DialogDescription>
            An opportunity is an account in the relationship pipeline.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <div>
            <CustomerPicker
              kind="company"
              value={customer}
              onChange={setCustomer}
              label="Account name"
              allowCreate={false}
              autoFocus
            />
            {existingId && (
              <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-500">
                This account already exists — open it instead of adding a second one.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <LocationPicker
                value={locationId}
                onChange={setLocationId}
                label="Office"
                className="space-y-1"
              />
            </div>
            <div>
              <Label className="text-xs">Stage</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Owner</Label>
              <Select
                value={rep || "__none"}
                onValueChange={(v) => setRep(v === "__none" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Unassigned</SelectItem>
                  {people.map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name ?? p.user_id.slice(0, 8)}
                    </SelectItem>
                  ))}
                  {/* No inline user creation — invites carry role and office. */}
                  <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
                    Someone missing? Ask an admin to invite them.
                  </div>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {stage?.is_lost && (
            <div>
              <Label className="text-xs">Reason (required for a lost stage)</Label>
              <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BulkAddDialog(props: Common) {
  const { stages } = props;
  const invalidate = useInvalidate();
  const [text, setText] = React.useState("");
  const [locationId, setLocationId] = React.useState(props.defaultLocationId ?? "");
  const [stageId, setStageId] = React.useState(props.defaultStageId ?? stages[0]?.id ?? "");
  const [assignToMe, setAssignToMe] = React.useState(true);

  React.useEffect(() => {
    if (props.open) {
      setText("");
      setLocationId(props.defaultLocationId ?? "");
      setStageId(props.defaultStageId ?? stages[0]?.id ?? "");
    }
  }, [props.open, props.defaultLocationId, stages]);

  const names = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length >= 2);

  const stage = stages.find((s) => s.id === stageId);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("accounts").insert(
        names.map((n) => ({
          name: n,
          location_id: locationId,
          stage_id: stageId,
          assigned_rep: assignToMe ? props.userId : null,
          created_by: props.userId,
        })),
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`${names.length} opportunit${names.length === 1 ? "y" : "ies"} added`);
      invalidate();
      props.onOpenChange(false);
      props.onDone();
    },
    onError: (e) => toastDbError(e, { action: "add the opportunities" }),
  });

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Bulk add</DialogTitle>
          <DialogDescription>
            One account name per line. Details can follow later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          <Textarea
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={"Acme Property Group\nHarbour Point Management"}
          />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <LocationPicker
                value={locationId}
                onChange={setLocationId}
                label="Office"
                className="space-y-1"
              />
            </div>
            <div>
              <Label className="text-xs">Stage</Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  {stages
                    .filter((s) => !s.is_lost)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center gap-2 text-[13px]">
            <input
              type="checkbox"
              checked={assignToMe}
              onChange={(e) => setAssignToMe(e.target.checked)}
            />
            Assign all to me
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              names.length === 0 || !locationId || !stageId || !!stage?.is_lost || save.isPending
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : `Add ${names.length || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
