/**
 * "Add to register", inside the scanner, for a plate the register has never
 * heard of (CEO, 26 Oct). The tag exactly as read, a type and a home office
 * guessed from the tag (both changeable), optional notes; one confirm and the
 * unit joins the scan session's list like any scanned unit. The rules — plate
 * shape, no twins, who may add, the audit — are src/lib/equipment-add-from-scan.ts
 * and the add_equipment_from_scan function.
 */
import { useEffect, useState } from "react";
import { Loader2, PlusCircle, ShieldAlert } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { useLabelLanguage } from "@/components/bilingual";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";
import {
  addDefaults,
  addEquipmentFromScan,
  mayAddToRegister,
  type AddFromScanResult,
  type AddVia,
} from "@/lib/equipment-add-from-scan";
import { isPrivileged } from "@/lib/roles";

export type AddToRegisterConfig = {
  via: AddVia;
  jobId: string | null;
  jobLocationId: string | null;
};

export function AddToRegisterPanel({
  tag,
  config,
  onDone,
  onCancel,
  onNotPermitted,
}: {
  tag: string;
  config: AddToRegisterConfig;
  /** The unit, created or found; the scanner puts it on the list. */
  onDone: (result: Extract<AddFromScanResult, { kind: "created" | "existing" }>) => void;
  onCancel: () => void;
  /**
   * This person may not add to the register in any office. The panel renders
   * nothing and the scanner says the tag is unregistered — no "your role
   * cannot" notice.
   */
  onNotPermitted?: () => void;
}) {
  const app = useAppContext();
  const { bi } = useLabelLanguage();
  const offices = app.visibleLocations.map((l) => ({ id: l.id, code: l.code, name: l.name }));
  const defaults = addDefaults(tag, {
    offices,
    jobLocationId: config.jobLocationId,
    primaryLocationId: app.primaryLocationId,
  });
  const [type, setType] = useState(defaults.equipmentType);
  const [officeId, setOfficeId] = useState(defaults.officeId);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The offices this person may add a unit to — the register's own rule,
   * asked per office. null while asking. Only those offices are offered; with
   * none, the panel is not shown at all.
   */
  const [permitted, setPermitted] = useState<string[] | null>(null);
  const officeKey = offices.map((o) => o.id).join(",");

  useEffect(() => {
    let live = true;
    setPermitted(null);
    if (app.writesDisabled) return;
    const ids = officeKey ? officeKey.split(",") : [];
    if (isPrivileged(app.roles)) {
      setPermitted(ids);
      return;
    }
    if (!app.userId || ids.length === 0) {
      setPermitted([]);
      return;
    }
    const userId = app.userId;
    // Unknown counts as "try": the server refuses anyone it should.
    void Promise.all(
      ids.map((id) =>
        mayAddToRegister(supabase as never, userId, id).then(
          (ok) => ok,
          () => true,
        ),
      ),
    ).then((oks) => {
      if (live) setPermitted(ids.filter((_, i) => oks[i]));
    });
    return () => {
      live = false;
    };
  }, [app.userId, app.roles, app.writesDisabled, officeKey]);

  // The guessed office is not one this person may add to: start on one they may.
  useEffect(() => {
    if (permitted && permitted.length > 0 && !permitted.includes(officeId)) {
      setOfficeId(permitted[0]);
    }
  }, [permitted, officeId]);

  const notPermitted = permitted !== null && permitted.length === 0;
  useEffect(() => {
    if (notPermitted) onNotPermitted?.();
    // Said once, when the answer comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notPermitted]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await addEquipmentFromScan(supabase as never, {
        tag,
        equipmentType: type,
        officeId,
        notes,
        via: config.via,
        jobId: config.jobId,
      });
      if (res.kind === "not_permitted") {
        // The server's rule is the last word: drop this office from the list.
        setPermitted((p) => (p ?? []).filter((id) => id !== officeId));
        return;
      }
      if (res.kind === "not_a_tag") {
        setError(
          `${tag} is not one of our asset tags, so it cannot be added. Scan the plate again.`,
        );
        return;
      }
      onDone(res);
    } catch (e) {
      setError(
        `${tag} could not be added — ${e instanceof Error ? e.message : "the register did not answer"}. Nothing was saved; try again.`,
      );
    } finally {
      setBusy(false);
    }
  };

  // Still asking, or no office this person may add to: nothing at all.
  if (!app.writesDisabled && (permitted === null || permitted.length === 0)) return null;
  const officeChoices = offices.filter((o) => permitted?.includes(o.id));

  return (
    <div className="space-y-2 rounded-sm border border-primary/40 p-2.5" data-add-to-register>
      <p className="text-sm">
        {bi("Add to the register:", "Agregar al registro:")}{" "}
        <span className="font-mono font-semibold">{tag}</span>
      </p>
      {app.writesDisabled ? (
        <div className="flex gap-2 text-sm text-muted-foreground" data-add-preview-off>
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <span>Adding equipment is switched off while viewing as someone else.</span>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{bi("Type", "Tipo")}</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-11 sm:h-8" aria-label="Equipment type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(EQUIPMENT_TYPE_LABEL).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {defaults.typeFromTag && (
              <p className="text-[11px] text-muted-foreground">From the tag&rsquo;s letters.</p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{bi("Home office", "Oficina")}</Label>
            <Select value={officeId} onValueChange={setOfficeId}>
              <SelectTrigger className="h-11 sm:h-8" aria-label="Home office">
                <SelectValue placeholder="Pick the office" />
              </SelectTrigger>
              <SelectContent>
                {officeChoices.map((o) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.code} · {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label className="text-xs">{bi("Notes (optional)", "Notas (opcional)")}</Label>
            <Input
              className="h-11 sm:h-8"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Make, model, condition…"
            />
          </div>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" className="h-11 sm:h-8" onClick={onCancel}>
          {bi("Not now", "Ahora no")}
        </Button>
        {!app.writesDisabled && (
          <Button
            type="button"
            className="h-11 sm:h-8"
            disabled={busy || !officeId}
            onClick={() => void confirm()}
            data-add-to-register-confirm
          >
            {busy ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <PlusCircle className="mr-1.5 size-4" />
            )}
            {bi("Add and continue", "Agregar y seguir")}
          </Button>
        )}
      </div>
    </div>
  );
}
