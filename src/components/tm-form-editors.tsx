/**
 * The three T&M sheets as phone forms: what goes inside the dialog.
 *
 * Built for the same crew, gloves and basement as the field work ticket:
 * every control is at least 44px tall, labels carry both languages through
 * the shared `bi()` / `<Bi>` (the person's own language), and nothing here
 * talks to the network — the dialog around it saves, and it saves offline.
 * Browser autofill is left alone on purpose; names and times are exactly what
 * it is good at.
 */
import { useMemo, useState } from "react";
import { Check, FileCheck2, Minus, PenLine, Plus, Search, Trash2, UserPlus } from "lucide-react";

import { Bi, useLabelLanguage } from "@/components/bilingual";
import { SignaturePad } from "@/components/signature-pad";
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
import { Textarea } from "@/components/ui/textarea";
import {
  CREW_STAFF_SLOTS,
  SIGNATURE_SIZE,
  rowSigned,
  type CrewChiefPayload,
  type SignInPayload,
  type SignInRow,
  type SupplyLine,
  type SupplyListPayload,
} from "@/lib/tm-forms";
import { codeIsPrinted, groupBySection, type TmRateCode } from "@/lib/tm-rate-codes";
import { cn } from "@/lib/utils";

/**
 * A name the sheet offers. Only the crew chief has a login (`userId`); the
 * rest are the job's uploaded crew list and sign by name alone.
 */
export type Person = { userId: string | null; name: string };

/** A native select styled like the inputs: on a phone it opens the OS picker, the best one there is. */
const SELECT =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function Field({
  en,
  es,
  children,
  className,
}: {
  en: string;
  es: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block min-w-0 space-y-1", className)}>
      <span className="block text-sm font-semibold leading-tight">
        <Bi en={en} es={es} />
      </span>
      {children}
    </label>
  );
}

/** The names a picker suggests: the crew chief, then the job's crew list. Free text always works. */
function PeopleList({ id, people }: { id: string; people: readonly Person[] }) {
  return (
    <datalist id={id}>
      {people.map((p) => (
        <option key={p.name} value={p.name} />
      ))}
    </datalist>
  );
}

/** Resize a drawn signature to the stored size, keeping its shape. */
export async function shrinkSignature(dataUrl: string): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const { width, height } = SIGNATURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  const scale = Math.min(width / img.width, height / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
  return canvas.toDataURL("image/png");
}

/* ------------------------------------------------------------------ */
/* Crew Sign In/Out Sheet                                              */
/* ------------------------------------------------------------------ */

export function SignInEditor({
  value,
  onChange,
  laborCodes,
  people,
  newId,
}: {
  value: SignInPayload;
  onChange: (next: SignInPayload) => void;
  laborCodes: readonly TmRateCode[];
  people: readonly Person[];
  newId: () => string;
}) {
  const { bi } = useLabelLanguage();
  const [signing, setSigning] = useState<string | null>(null);
  const byName = useMemo(
    () => new Map(people.map((p) => [p.name.trim().toLowerCase(), p.userId])),
    [people],
  );

  const patch = (id: string, change: Partial<SignInRow>) =>
    onChange({ ...value, rows: value.rows.map((r) => (r.id === id ? { ...r, ...change } : r)) });

  const add = (person?: Person) =>
    onChange({
      ...value,
      rows: [
        ...value.rows,
        {
          id: newId(),
          userId: person?.userId ?? null,
          employee: person?.name ?? "",
          rateCode: "",
          timeIn: "",
          lunchStart: "",
          lunchEnd: "",
          timeOut: "",
          lodging: "",
          signature: null,
          signedAt: null,
        },
      ],
    });

  const remove = (id: string) =>
    onChange({
      ...value,
      rows: value.rows.filter((r) => r.id !== id),
      removed: [...value.removed, id],
    });

  const signingRow = value.rows.find((r) => r.id === signing) ?? null;
  // A code no longer offered still shows on a row that carries it.
  const codeOptions = (current: string) =>
    current && !laborCodes.some((c) => c.code === current)
      ? [...laborCodes, { code: current, label: current } as TmRateCode]
      : laborCodes;
  const signed = value.rows.filter(rowSigned).length;
  // The crew list, less whoever is already on today's sheet.
  const onSheet = new Set(value.rows.map((r) => r.employee.trim().toLowerCase()));
  const notYetOn = people.filter((p) => !onSheet.has(p.name.trim().toLowerCase()));

  return (
    <div className="space-y-4">
      <HeaderFields value={value} onChange={(h) => onChange({ ...value, ...h })} />
      <PeopleList id="tm-sign-in-people" people={people} />

      <div className="flex items-baseline justify-between gap-2">
        <span>
          <span className="block text-sm font-semibold">{bi("Crew", "Personal")}</span>
          <span className="block text-xs text-muted-foreground">
            <Bi en="Each person signs their own row" es="Firme cada quien su renglón" />
          </span>
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value.rows.length} · {signed} ✍
        </span>
      </div>

      {value.rows.length === 0 && (
        <p className="rounded-sm border border-dashed p-4 text-sm text-muted-foreground">
          {bi("Nobody on the sheet yet.", "Todavía no hay nadie en la hoja.")}
        </p>
      )}

      <ol className="space-y-3">
        {value.rows.map((r, i) => (
          <li key={r.id} data-sign-in-row className="space-y-3 rounded-[8px] border p-3">
            <div className="flex items-end gap-2">
              <Field en={`${i + 1}. Employee`} es="Empleado" className="flex-1">
                <Input
                  className="h-11"
                  list="tm-sign-in-people"
                  value={r.employee}
                  onChange={(e) => {
                    const employee = e.target.value;
                    patch(r.id, {
                      employee,
                      userId: byName.get(employee.trim().toLowerCase()) ?? null,
                    });
                  }}
                />
              </Field>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0"
                aria-label={`Remove ${r.employee || `row ${i + 1}`}`}
                onClick={() => remove(r.id)}
              >
                <Trash2 />
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field en="Rate code" es="Código">
                <select
                  className={SELECT}
                  value={r.rateCode}
                  onChange={(e) => patch(r.id, { rateCode: e.target.value })}
                >
                  <option value="">—</option>
                  {codeOptions(r.rateCode).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} · {c.label}
                    </option>
                  ))}
                </select>
              </Field>
              {/* David, 12 Oct: a plain yes / blank toggle, not a list. */}
              <div className="block min-w-0 space-y-1">
                <span className="block text-sm font-semibold leading-tight">
                  <Bi en="Hotel - Per Diem" es="Hotel - Viáticos" />
                </span>
                <Button
                  type="button"
                  variant={r.lodging ? "default" : "outline"}
                  className="h-11 w-full justify-start"
                  aria-pressed={!!r.lodging}
                  aria-label={`Hotel - Per Diem for ${r.employee || `row ${i + 1}`}`}
                  onClick={() => patch(r.id, { lodging: r.lodging ? "" : "yes" })}
                >
                  {r.lodging ? (
                    <>
                      <Check className="mr-1.5 size-4" />
                      {bi("Yes", "Sí")}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{bi("No", "No")}</span>
                  )}
                </Button>
              </div>
              <Field en="Time in" es="Entrada">
                <Input
                  type="time"
                  className="h-11"
                  value={r.timeIn}
                  onChange={(e) => patch(r.id, { timeIn: e.target.value })}
                />
              </Field>
              <Field en="Time out" es="Salida">
                <Input
                  type="time"
                  className="h-11"
                  value={r.timeOut}
                  onChange={(e) => patch(r.id, { timeOut: e.target.value })}
                />
              </Field>
              <Field en="Lunch start" es="Inicio de almuerzo">
                <Input
                  type="time"
                  className="h-11"
                  value={r.lunchStart}
                  onChange={(e) => patch(r.id, { lunchStart: e.target.value })}
                />
              </Field>
              <Field en="Lunch end" es="Fin de almuerzo">
                <Input
                  type="time"
                  className="h-11"
                  value={r.lunchEnd}
                  onChange={(e) => patch(r.id, { lunchEnd: e.target.value })}
                />
              </Field>
            </div>
            {r.signature ? (
              <div className="flex items-center gap-3">
                <img
                  src={r.signature}
                  alt={`Signature of ${r.employee || "this row"}`}
                  className="h-11 w-36 rounded-sm border bg-white object-contain"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-11"
                  onClick={() => setSigning(r.id)}
                >
                  {bi("Sign again", "Firmar de nuevo")}
                </Button>
              </div>
            ) : r.paperSigned ? (
              <p
                className="flex h-11 items-center gap-1.5 rounded-sm border border-dashed px-3 text-sm text-muted-foreground"
                data-paper-signed
              >
                <FileCheck2 className="size-4 shrink-0" />
                {bi(
                  "Signed on the paper sheet (filed in Documents)",
                  "Firmado en la hoja de papel (en Documentos)",
                )}
              </p>
            ) : (
              <Button
                type="button"
                variant="outline"
                className="h-11 w-full"
                disabled={!r.employee.trim()}
                onClick={() => setSigning(r.id)}
              >
                <PenLine className="mr-1.5 size-4" />
                {bi("Sign", "Firmar")}
              </Button>
            )}
          </li>
        ))}
      </ol>

      {/* "Add person" picks from the crew chief and the job's uploaded crew
          list — never every user in the system (David, 12 Oct). A name that
          is not on the list is still typed into a blank row. */}
      <div className="flex flex-col gap-2 sm:flex-row">
        {notYetOn.length > 0 && (
          <select
            className={cn(SELECT, "sm:flex-1")}
            aria-label={bi("Add person from the crew list", "Agregar persona de la lista")}
            value=""
            onChange={(e) => {
              const person = notYetOn.find((p) => p.name === e.target.value);
              if (person) add(person);
            }}
          >
            <option value="">{bi("Add from crew list…", "Agregar de la lista…")}</option>
            {notYetOn.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full sm:w-auto"
          onClick={() => add()}
        >
          <UserPlus className="mr-1.5 size-4" />
          {bi("Add person", "Agregar persona")}
        </Button>
      </div>

      <SignatureDialog
        row={signingRow}
        onClose={() => setSigning(null)}
        onSigned={(signature) => {
          if (signingRow) {
            patch(signingRow.id, { signature, signedAt: new Date().toISOString() });
          }
          setSigning(null);
        }}
      />
    </div>
  );
}

/**
 * One person signs their own row, on whichever phone is to hand. The words
 * above the pad say what the signature means — the times on the row are theirs.
 */
function SignatureDialog({
  row,
  onClose,
  onSigned,
}: {
  row: SignInRow | null;
  onClose: () => void;
  onSigned: (signature: string) => void;
}) {
  const { bi } = useLabelLanguage();
  const [drawn, setDrawn] = useState<string | null>(null);
  return (
    <Dialog
      open={row != null}
      onOpenChange={(open) => {
        if (!open) {
          setDrawn(null);
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{row?.employee || bi("Signature", "Firma")}</DialogTitle>
          <DialogDescription>
            {bi(
              "I confirm the times on my row are correct.",
              "Confirmo que las horas de mi renglón son correctas.",
            )}
          </DialogDescription>
        </DialogHeader>
        {/* Keyed by row so a second person never draws over the first one's lines. */}
        <SignaturePad key={row?.id ?? "none"} height={180} onChange={setDrawn} />
        <DialogFooter>
          <Button
            className="h-12 w-full sm:w-auto"
            disabled={!drawn}
            onClick={async () => {
              if (!drawn) return;
              onSigned(await shrinkSignature(drawn).catch(() => drawn));
              setDrawn(null);
            }}
          >
            {bi("Done", "Listo")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Job Name and Job Location, prefilled from the job and editable — every sheet has them. */
function HeaderFields({
  value,
  onChange,
}: {
  value: { jobName: string; jobLocation: string };
  onChange: (next: { jobName: string; jobLocation: string }) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field en="Job name" es="Nombre del trabajo">
        <Input
          className="h-11"
          value={value.jobName}
          onChange={(e) => onChange({ ...value, jobName: e.target.value })}
        />
      </Field>
      <Field en="Job location" es="Ubicación del trabajo">
        <Input
          className="h-11"
          value={value.jobLocation}
          onChange={(e) => onChange({ ...value, jobLocation: e.target.value })}
        />
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Daily Crew Chief                                                    */
/* ------------------------------------------------------------------ */

export function CrewChiefEditor({
  value,
  onChange,
  people,
}: {
  value: CrewChiefPayload;
  onChange: (next: CrewChiefPayload) => void;
  people: readonly Person[];
}) {
  const set = (change: Partial<CrewChiefPayload>) => onChange({ ...value, ...change });
  const named = value.staff.filter((s) => s.trim()).length;
  return (
    <div className="space-y-4">
      <HeaderFields value={value} onChange={(h) => set(h)} />
      <PeopleList id="tm-crew-chief-people" people={people} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field en="Supervisor" es="Supervisor">
          <Input
            className="h-11"
            list="tm-crew-chief-people"
            value={value.supervisor}
            onChange={(e) => set({ supervisor: e.target.value })}
          />
        </Field>
        <Field en="Work zone" es="Zona de trabajo">
          <Input
            className="h-11"
            value={value.workZone}
            onChange={(e) => set({ workZone: e.target.value })}
          />
        </Field>
        <Field en="Crew chief" es="Jefe de equipo">
          <Input
            className="h-11"
            list="tm-crew-chief-people"
            value={value.crewChief}
            onChange={(e) => set({ crewChief: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field en="Crew number" es="Número de tripulación">
            <Input
              className="h-11"
              inputMode="numeric"
              value={value.crewNumber}
              onChange={(e) => set({ crewNumber: e.target.value })}
            />
          </Field>
          <Field en="Crew size" es="Tamaño de la tripulación">
            <Input
              className="h-11"
              inputMode="numeric"
              value={value.crewSize}
              onChange={(e) => set({ crewSize: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-2">
          <span>
            <span className="block text-sm font-semibold">
              <Bi en="Crew staff name" es="Nombre del personal de la cuadrilla" />
            </span>
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {named}/{CREW_STAFF_SLOTS}
          </span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {value.staff.map((name, i) => (
            <Input
              key={i}
              className="h-11"
              list="tm-crew-chief-people"
              aria-label={`Crew staff ${i + 1}`}
              placeholder={`${i + 1}`}
              value={name}
              onChange={(e) =>
                set({ staff: value.staff.map((s, j) => (j === i ? e.target.value : s)) })
              }
            />
          ))}
        </div>
      </section>

      <Field en="Daily work notes" es="Notas de trabajo diarias">
        <Textarea rows={8} value={value.notes} onChange={(e) => set({ notes: e.target.value })} />
      </Field>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Daily Supply List                                                   */
/* ------------------------------------------------------------------ */

export function SupplyListEditor({
  value,
  onChange,
  catalogue,
  onlyCodes = null,
  previousLines,
}: {
  value: SupplyListPayload;
  onChange: (next: SupplyListPayload) => void;
  catalogue: readonly TmRateCode[];
  /**
   * FE10: a regular job's condensed list — only these codes are offered (a
   * code already on the sheet stays). null offers the whole catalogue.
   */
  onlyCodes?: ReadonlySet<string> | null;
  /** Yesterday's lines, for "Same as last sheet"; null when there is none. */
  previousLines: readonly SupplyLine[] | null;
}) {
  const { bi } = useLabelLanguage();
  const [query, setQuery] = useState("");
  const qty = useMemo(() => new Map(value.lines.map((l) => [l.code, l.qty])), [value.lines]);

  const setQty = (code: string, n: number) => {
    const next = Math.max(0, Math.round(n * 100) / 100);
    const rest = value.lines.filter((l) => l.code !== code);
    onChange({ ...value, lines: next > 0 ? [...rest, { code, qty: next }] : rest });
  };

  const q = query.trim().toLowerCase();
  const groups = groupBySection(catalogue)
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        // Switched-off codes are not offered, but one already on this sheet stays.
        (r) =>
          (r.active || qty.has(r.code)) &&
          (!onlyCodes || onlyCodes.has(r.code) || qty.has(r.code)) &&
          (!q || r.code.toLowerCase().includes(q) || r.label.toLowerCase().includes(q)),
      ),
    }))
    .filter((g) => g.rows.length > 0);
  const used = value.lines.length;

  return (
    <div className="space-y-4">
      <HeaderFields value={value} onChange={(h) => onChange({ ...value, ...h })} />
      <Field en="Total crew amount" es="Total del personal" className="sm:max-w-[12rem]">
        <Input
          className="h-11"
          inputMode="numeric"
          value={value.totalCrew}
          onChange={(e) => onChange({ ...value, totalCrew: e.target.value })}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="h-11 pl-9"
            placeholder={bi("Find a code or item", "Buscar código o artículo")}
            aria-label="Find a rate code"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {previousLines && previousLines.length > 0 && used === 0 && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            onClick={() => onChange({ ...value, lines: [...previousLines] })}
          >
            {bi("Same as last sheet", "Igual que la última")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {used} {bi("lines used today", "renglones usados hoy")} ·{" "}
        {bi("only lines with a quantity are kept", "solo se guardan los que tienen cantidad")}
      </p>

      {groups.length === 0 && (
        <p className="rounded-sm border border-dashed p-4 text-sm text-muted-foreground">
          {bi("Nothing matches.", "No hay resultados.")}
        </p>
      )}

      {groups.map((g) => {
        const inGroup = g.rows.filter((r) => qty.has(r.code)).length;
        return (
          <details
            key={g.section}
            data-supply-section={g.section}
            // Searching opens every section that has a match; otherwise the
            // sections already used today start open.
            open={q ? true : inGroup > 0 || undefined}
            className="rounded-[8px] border"
          >
            <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm font-semibold">
              {g.label}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">
                {inGroup > 0 ? `${inGroup} ✓ · ` : ""}
                {g.rows.length}
              </span>
            </summary>
            <ul className="divide-y border-t">
              {g.rows.map((r) => {
                const n = qty.get(r.code) ?? 0;
                return (
                  <li
                    key={r.code}
                    data-supply-line
                    className={cn("flex items-center gap-2 px-3 py-2", n > 0 && "bg-primary/5")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm leading-tight">{r.label}</span>
                      {codeIsPrinted(r) && (
                        <span className="font-mono text-xs text-muted-foreground">{r.code}</span>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-11"
                        aria-label={`One less ${r.label}`}
                        disabled={n <= 0}
                        onClick={() => setQty(r.code, n - 1)}
                      >
                        <Minus />
                      </Button>
                      <Input
                        className="h-11 w-16 text-center tabular-nums"
                        inputMode="decimal"
                        aria-label={`Quantity of ${r.label}`}
                        value={n > 0 ? String(n) : ""}
                        onChange={(e) =>
                          setQty(r.code, Number(e.target.value.replace(",", ".")) || 0)
                        }
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-11"
                        aria-label={`One more ${r.label}`}
                        onClick={() => setQty(r.code, n + 1)}
                      >
                        <Plus />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
