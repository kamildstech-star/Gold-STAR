import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import {
  createRaffle,
  DEFAULT_RAFFLE_TERMS,
  raffleDraftProblem,
  updateRaffle,
  type Raffle,
  type RaffleDraft,
  type RafflePrize,
  type RaffleWinner,
} from "@/lib/raffles";

/** `datetime-local` wants local wall time without a zone. */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function draftFrom(raffle: Raffle | null, prizes: RafflePrize[], showName: string): RaffleDraft {
  if (!raffle) {
    return {
      title: `${showName} prize draw`,
      headline: "Enter in 30 seconds for your chance to win",
      description: "",
      terms: DEFAULT_RAFFLE_TERMS,
      closes_at: null,
      ask_phone: true,
      require_phone: true,
      ask_company: true,
      max_entries: "",
      prizes: [{ name: "", description: "", value: "", quantity: "1" }],
    };
  }
  return {
    title: raffle.title,
    headline: raffle.headline ?? "",
    description: raffle.description ?? "",
    terms: raffle.terms ?? "",
    closes_at: raffle.closes_at,
    ask_phone: raffle.ask_phone,
    require_phone: raffle.require_phone,
    ask_company: raffle.ask_company,
    max_entries: raffle.max_entries == null ? "" : String(raffle.max_entries),
    prizes: prizes.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description ?? "",
      value: p.value == null ? "" : String(p.value),
      quantity: String(p.quantity),
    })),
  };
}

/**
 * New raffle, or edit one. Prizes are listed in the order they are drawn —
 * first is the grand prize. A prize that already has winners keeps them, so
 * it cannot be removed here (the database refuses it too).
 */
export function RaffleDialog({
  open,
  onClose,
  tradeshowId,
  showName,
  raffle = null,
  prizes = [],
  winners = [],
  shows = [],
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** Empty when created from the Raffles board: the dialog then asks which show. */
  tradeshowId: string;
  showName: string;
  /** Shows to pick from when `tradeshowId` is empty. */
  shows?: { id: string; name: string }[];
  raffle?: Raffle | null;
  prizes?: RafflePrize[];
  winners?: RaffleWinner[];
  onSaved: (raffleId: string) => void;
}) {
  const app = useAppContext();
  const [d, setD] = React.useState<RaffleDraft>(() => draftFrom(raffle, prizes, showName));
  const pickShow = !raffle && !tradeshowId;
  const [pickedShow, setPickedShow] = React.useState("");
  React.useEffect(() => {
    if (open) {
      setPickedShow("");
      setD(draftFrom(raffle, prizes, showName || "Trade show"));
    }
    // Re-seed only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const drawnPrize = new Set(winners.map((w) => w.prize_id));
  const set = <K extends keyof RaffleDraft>(k: K, v: RaffleDraft[K]) =>
    setD((x) => ({ ...x, [k]: v }));
  const setPrize = (i: number, k: keyof RaffleDraft["prizes"][number], v: string) =>
    setD((x) => ({ ...x, prizes: x.prizes.map((p, j) => (j === i ? { ...p, [k]: v } : p)) }));

  const save = useMutation({
    mutationFn: async () => {
      const showId = tradeshowId || pickedShow;
      if (!raffle && !showId) throw new Error("Pick the trade show this raffle is for.");
      const problem = raffleDraftProblem(d);
      if (problem) throw new Error(problem);
      if (raffle) {
        await updateRaffle(raffle.id, d, prizes);
        return raffle.id;
      }
      return (await createRaffle({ tradeshowId: showId, draft: d, userId: app.userId })).id;
    },
    onSuccess: (id) => {
      toast.success(raffle ? "Raffle saved" : "Raffle created — the QR code is ready");
      onSaved(id);
    },
    onError: (e) =>
      e instanceof Error && !("code" in e)
        ? toast.error(e.message)
        : toastDbError(e, { action: raffle ? "save the raffle" : "create the raffle" }),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{raffle ? "Edit raffle" : "New raffle"}</DialogTitle>
          <DialogDescription>
            Visitors scan the QR code, fill a short form and are entered once. You draw the winners
            here when entries close.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {pickShow && (
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="rf-show">Trade show</Label>
                <Select
                  value={pickedShow}
                  onValueChange={(v) => {
                    const prev = shows.find((s) => s.id === pickedShow)?.name ?? "Trade show";
                    const next = shows.find((s) => s.id === v)?.name ?? "Trade show";
                    setPickedShow(v);
                    // Follow the show in the title until someone types their own.
                    setD((x) =>
                      x.title === `${prev} prize draw` ? { ...x, title: `${next} prize draw` } : x,
                    );
                  }}
                >
                  <SelectTrigger id="rf-show">
                    <SelectValue placeholder="Which show is this raffle for?" />
                  </SelectTrigger>
                  <SelectContent>
                    {shows.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="rf-title">Title</Label>
              <Input
                id="rf-title"
                value={d.title}
                maxLength={120}
                onChange={(e) => set("title", e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="rf-headline">Headline on the form</Label>
              <Input
                id="rf-headline"
                value={d.headline}
                maxLength={200}
                onChange={(e) => set("headline", e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="rf-desc">More detail (optional)</Label>
              <Textarea
                id="rf-desc"
                rows={2}
                value={d.description}
                maxLength={2000}
                placeholder="e.g. Winners announced at 3pm on the last day at booth #412."
                onChange={(e) => set("description", e.target.value)}
              />
            </div>
          </div>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold">Prizes</h3>
              <span className="text-[11px] text-muted-foreground">Drawn top to bottom</span>
            </div>
            {d.prizes.map((p, i) => {
              const locked = !!p.id && drawnPrize.has(p.id);
              return (
                <div
                  key={p.id ?? `new-${i}`}
                  className="grid grid-cols-[1fr_auto] gap-2 rounded-lg border p-2.5"
                >
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_96px_72px]">
                    <Input
                      aria-label={`Prize ${i + 1} name`}
                      placeholder={
                        i === 0 ? "Grand prize, e.g. YETI Tundra 45 cooler" : "Prize name"
                      }
                      value={p.name}
                      maxLength={120}
                      onChange={(e) => setPrize(i, "name", e.target.value)}
                    />
                    <Input
                      aria-label={`Prize ${i + 1} value in dollars`}
                      placeholder="Value $"
                      inputMode="decimal"
                      value={p.value}
                      onChange={(e) => setPrize(i, "value", e.target.value.replace(/[^\d.]/g, ""))}
                    />
                    <Input
                      aria-label={`Prize ${i + 1} quantity`}
                      title="How many winners get this prize"
                      placeholder="Qty"
                      inputMode="numeric"
                      value={p.quantity}
                      onChange={(e) => setPrize(i, "quantity", e.target.value.replace(/\D/g, ""))}
                    />
                    <Input
                      aria-label={`Prize ${i + 1} description`}
                      className="sm:col-span-3"
                      placeholder="Short description (optional)"
                      value={p.description}
                      maxLength={500}
                      onChange={(e) => setPrize(i, "description", e.target.value)}
                    />
                  </div>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    disabled={locked || d.prizes.length === 1}
                    title={locked ? "This prize has been drawn" : "Remove prize"}
                    onClick={() =>
                      setD((x) => ({ ...x, prizes: x.prizes.filter((_, j) => j !== i) }))
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              );
            })}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={d.prizes.length >= 20}
              onClick={() =>
                setD((x) => ({
                  ...x,
                  prizes: [...x.prizes, { name: "", description: "", value: "", quantity: "1" }],
                }))
              }
            >
              <Plus className="mr-1 size-3.5" /> Add prize
            </Button>
          </section>

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="rf-closes">Entries close (optional)</Label>
              <Input
                id="rf-closes"
                type="datetime-local"
                value={toLocalInput(d.closes_at)}
                onChange={(e) =>
                  set("closes_at", e.target.value ? new Date(e.target.value).toISOString() : null)
                }
              />
              <p className="text-[11px] text-muted-foreground">
                Leave empty to close by hand. Drawing always closes entries.
              </p>
              <Label htmlFor="rf-max" className="block pt-2">
                Max entries (optional)
              </Label>
              <Input
                id="rf-max"
                type="number"
                inputMode="numeric"
                min={1}
                max={100000}
                placeholder="No limit"
                value={d.max_entries}
                onChange={(e) => set("max_entries", e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground">
                The form stops taking entries once this many people have entered.
              </p>
            </div>
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-[12px] font-semibold">Form asks for</p>
              <Toggle label="Phone" checked={d.ask_phone} onChange={(v) => set("ask_phone", v)} />
              {d.ask_phone && (
                <Toggle
                  label="Phone is required"
                  checked={d.require_phone}
                  onChange={(v) => set("require_phone", v)}
                  indent
                />
              )}
              <Toggle
                label="Company and job title"
                checked={d.ask_company}
                onChange={(v) => set("ask_company", v)}
              />
              <p className="text-[11px] text-muted-foreground">Name and email are always asked.</p>
            </div>
          </section>

          <div className="space-y-1">
            <Label htmlFor="rf-terms">Official rules</Label>
            <Textarea
              id="rf-terms"
              rows={4}
              value={d.terms}
              maxLength={5000}
              onChange={(e) => set("terms", e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Shown under the form; entrants must accept them. Check them against your state&apos;s
              sweepstakes rules.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending || app.writesDisabled} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : raffle ? "Save" : "Create raffle"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  indent,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  indent?: boolean;
}) {
  return (
    <label
      className={`flex items-center justify-between gap-2 text-[13px] ${indent ? "pl-4" : ""}`}
    >
      {label}
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}
