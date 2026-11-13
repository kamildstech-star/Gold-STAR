import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  Building2,
  FileSignature,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Scissors,
  Search,
  Star,
  Upload,
  Users,
} from "lucide-react";

import { AccountPicker, type PickedAccount } from "@/components/account-picker";
import { useAppContext } from "@/components/app-context";
import { HistoryButton } from "@/components/billing-costs/history";
import { Pager, usePaged } from "@/components/billing-costs/pager";
import { SaveBar } from "@/components/billing-costs/save-bar";
import { SEGMENT_TRACK, SegmentButton } from "@/components/billing-costs/segmented";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LoadError } from "@/components/ui-density";
import {
  EMPTY_AGREEMENT_DRAFT,
  agreementDraftSize,
  agreementDraftToChanges,
  agreementProblems,
  groupByClient,
  keyRates,
  linkLive,
  loadAgreements,
  loadJobMix,
  mostlyRegular,
  mostlyTm,
  overrideSummary,
  saveAgreements,
  saveStandard,
  standardDraftToChanges,
  standardKey,
  standardPrice,
  standardProblems,
  type Agreement,
  type AgreementDraft,
  type AgreementsData,
  type StandardDraft,
} from "@/lib/agreements";
import {
  CATALOG_CATEGORY_LABEL,
  CATALOG_UNIT_LABEL,
  UNITS_BY_CATEGORY,
  isValidCode,
  nameKey,
  normaliseCode,
  saveCatalog,
  type CatalogUnit,
} from "@/lib/catalog";
import { formatDateUS } from "@/lib/date-format";
import { toastDbError } from "@/lib/db-errors";
import { catalogCodeIndex, parsePriceListCsv } from "@/lib/price-lists";
import { loadTmAgreements, saveTmAgreements } from "@/lib/tm-agreements";
import { cn } from "@/lib/utils";

const KEY = ["billing-costs", "agreements"] as const;
const TM_KEY = ["billing-costs", "tm-agreements"] as const;

/**
 * Which agreements a list edits: the regular ones (over Standard) or the T&M
 * ones (over T&M Rates, src/lib/tm-agreements.ts). Same screens, own store.
 */
type AgreementBook = {
  key: readonly string[];
  save: (changes: readonly Record<string, unknown>[], note: string) => Promise<string | null>;
  history: "client_agreements" | "tm_rates";
  /** What silence follows, in a sentence ("follows Standard"). */
  standard: string;
  /** The same, as a row's label ("Standard $70.00"). */
  standardShort: string;
  /** The note when a client added mostly has the other kind of job. */
  mixNote: (name: string, mix: { jobs: number; tm_jobs: number } | undefined) => string | null;
  importExample: string;
};

const REGULAR_BOOK: AgreementBook = {
  key: KEY,
  save: saveAgreements,
  history: "client_agreements",
  standard: "Standard",
  standardShort: "Standard",
  mixNote: (name, mix) =>
    mostlyTm(mix)
      ? `Most of ${name}'s jobs are T&M (${mix!.tm_jobs} of ${mix!.jobs}) — those bill at T&M rates, not this agreement.`
      : null,
  importExample: "Code,Price\nGSC-LABOR-REG,62.00",
};

const TM_BOOK: AgreementBook = {
  key: TM_KEY,
  save: saveTmAgreements,
  history: "tm_rates",
  standard: "T&M Rates",
  standardShort: "T&M",
  mixNote: (name, mix) =>
    mostlyRegular(mix)
      ? `Most of ${name}'s jobs are regular (${mix!.jobs - mix!.tm_jobs} of ${mix!.jobs}) — those bill at General Rates, not this agreement.`
      : null,
  importExample: "Code,Rate\nPCT,85.00",
};
const localToday = () => new Date().toLocaleDateString("en-CA");
const usd = (v: number | null | undefined) => (v == null ? "—" : `$${v.toFixed(2)}`);

/**
 * Billing & Costs › Client Agreements (prompt 4). Standard rates first — what
 * every client without an agreement pays, per office — then each client
 * agreement: a list of exceptions over Standard. Rules in src/lib/agreements.ts;
 * the database resolves (regular_price_book). Owner and admin edit.
 */
export function ClientAgreementsTab() {
  const app = useAppContext();
  const roles = app.realRoles ?? [];
  const canEdit = roles.includes("owner") || roles.includes("admin");
  const q = useQuery({ queryKey: KEY, queryFn: () => loadAgreements() });
  const [view, setView] = useState<"standard" | "agreements">("standard");

  if (q.isError) return <LoadError what="the client agreements" error={q.error} />;
  if (q.isLoading || !q.data)
    return <p className="p-3 text-sm text-muted-foreground">Loading the client agreements…</p>;
  if (!q.data.available) {
    return (
      <Card>
        <CardContent className="space-y-1 p-4 text-sm">
          <p className="font-medium">Client Agreements are not available yet.</p>
          <p className="text-muted-foreground">
            The database update that holds them (migration 20261101120000) has not been applied
            here. Until it is, documents price from the price lists exactly as before.
          </p>
        </CardContent>
      </Card>
    );
  }
  const data = q.data;
  const live = data.agreements.filter((a) => a.kind === "agreement" && !a.archived);

  return (
    <div className="space-y-3">
      <p
        className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-sm font-medium"
        data-agreements-caption
      >
        <Info className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        Applies to regular jobs only — T&amp;M jobs bill at T&amp;M rates.
      </p>
      <div className={SEGMENT_TRACK} role="group" aria-label="View">
        <SegmentButton
          className="h-11 md:h-8"
          on={view === "standard"}
          onClick={() => setView("standard")}
        >
          <Building2 aria-hidden /> Standard rates
        </SegmentButton>
        <SegmentButton
          className="h-11 md:h-8"
          on={view === "agreements"}
          onClick={() => setView("agreements")}
        >
          <FileSignature aria-hidden /> Client agreements ({live.length})
        </SegmentButton>
      </div>
      {view === "standard" ? (
        <StandardGrid data={data} canEdit={canEdit} />
      ) : (
        <AgreementsList data={data} canEdit={canEdit} />
      )}
    </div>
  );
}

/**
 * T&M Rates › Client agreements (BC-TM-AGR-1): the same agreements list over
 * T&M Rates. A new T&M job for a linked client bills at its agreement
 * (frozen); the office can switch a job on its record. Owner and admin edit.
 */
export function TmClientAgreements() {
  const app = useAppContext();
  const roles = app.realRoles ?? [];
  const canEdit = roles.includes("owner") || roles.includes("admin");
  const q = useQuery({ queryKey: TM_KEY, queryFn: () => loadTmAgreements() });

  if (q.isError) return <LoadError what="the T&M client agreements" error={q.error} />;
  if (q.isLoading || !q.data)
    return <p className="p-3 text-sm text-muted-foreground">Loading the T&amp;M agreements…</p>;
  if (!q.data.available) {
    return (
      <Card>
        <CardContent className="space-y-1 p-4 text-sm">
          <p className="font-medium">T&amp;M client agreements are not available yet.</p>
          <p className="text-muted-foreground">
            The database update that holds them (migration 20261107120000) has not been applied
            here. Until it is, every T&amp;M job bills at T&amp;M Rates.
          </p>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3" data-tm-agreements>
      <p className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-sm font-medium">
        <Info className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        Applies to T&amp;M jobs only — a new T&amp;M job for a linked client bills at its agreement;
        every other line follows T&amp;M Rates.
      </p>
      <AgreementsList data={q.data} canEdit={canEdit} book={TM_BOOK} />
    </div>
  );
}

/* ------------------------------------------------------------- Standard */

function StandardGrid({ data, canEdit }: { data: AgreementsData; canEdit: boolean }) {
  const qc = useQueryClient();
  const today = localToday();
  const [office, setOffice] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /*
   * 6 Nov (David, Athar): the rate book reads as tabs per job type — Sewage,
   * Bio, Fire & Smoke, Mold, Water … — the same headers the invoice picker
   * groups by, rather than one long list with labor repeated under each.
   * "all" is every item; "none" the items under no header yet.
   */
  const [header, setHeader] = useState<string>("all");
  const headers = data.headers ?? [];
  const unheaded = data.items.some((i) => i.active && !i.header_id);
  const [draft, setDraft] = useState<StandardDraft>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const problems = useMemo(() => standardProblems(draft), [draft]);
  const pending = Object.keys(draft).length;
  const officeName = (id: string | null) =>
    id ? (data.offices.find((o) => o.id === id)?.name ?? "Office") : "Company";
  const items = data.items.filter(
    (i) =>
      i.active &&
      (header === "all" || (header === "none" ? !i.header_id : i.header_id === header)) &&
      (!search.trim() || `${i.code} ${i.name}`.toLowerCase().includes(search.trim().toLowerCase())),
  );
  const paged = usePaged(items, `${search}|${office}|${header}`);
  /** The item dialog: "new", or the code of the item being edited. */
  const [itemOpen, setItemOpen] = useState<string | null>(null);

  function edit(code: string, scope: string | null, value: string) {
    setDraft((d) => ({ ...d, [standardKey(code, scope)]: { value } }));
  }
  function reset(code: string, scope: string) {
    setDraft((d) => ({ ...d, [standardKey(code, scope)]: { reset: true } }));
  }
  async function save() {
    if (problems.size || !pending) return;
    setSaving(true);
    try {
      const n = await saveStandard(standardDraftToChanges(draft), note);
      toast.success(`Saved ${n} Standard rate${n === 1 ? "" : "s"}`, {
        description: "Every agreement line that follows Standard moves with it.",
      });
      setDraft({});
      setNote("");
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ["document-pricing"] });
    } catch (err) {
      toastDbError(err, { action: "Saving Standard rates" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={cn("space-y-3", pending > 0 && "pb-36 md:pb-24")} data-standard-rates>
      {headers.length > 0 && (
        <div className={SEGMENT_TRACK} role="tablist" aria-label="Job type" data-rate-headers>
          <SegmentButton on={header === "all"} onClick={() => setHeader("all")}>
            All
          </SegmentButton>
          {headers.map((h) => (
            <SegmentButton key={h.id} on={header === h.id} onClick={() => setHeader(h.id)}>
              {h.name}
            </SegmentButton>
          ))}
          {unheaded && (
            <SegmentButton on={header === "none"} onClick={() => setHeader("none")}>
              No job type
            </SegmentButton>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={office ?? "default"}
          onValueChange={(v) => setOffice(v === "default" ? null : v)}
        >
          <SelectTrigger className="h-11 w-full sm:w-56 md:h-8" aria-label="Office">
            <Building2 className="mr-1 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">Company Standard</SelectItem>
            {data.offices.map((o) => (
              <SelectItem key={o.id} value={o.id}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative min-w-0 flex-1 basis-48">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by code or name"
            aria-label="Search Standard rates"
            className="h-11 pl-8 md:h-8"
          />
        </div>
        {canEdit && (
          <Button
            variant="outline"
            className="h-11 md:h-8"
            onClick={() => setItemOpen("new")}
            data-add-regular-item
          >
            <Plus aria-hidden /> Add item
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        What every client without an agreement pays. An office&rsquo;s own price overrides the
        company Standard there. Changes take effect today; documents already priced keep their
        lines, and jobs keep the rates they were created with.
      </p>
      <Card className="max-md:border-0 max-md:bg-transparent max-md:shadow-none">
        <CardContent className="p-0">
          <div className="hidden md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 border-b bg-muted px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[9rem_minmax(0,1fr)_4rem_9rem_10rem] md:gap-3">
            <span>Code</span>
            <span>Name</span>
            <span>Unit</span>
            <span>Company</span>
            <span>{office ? officeName(office) : ""}</span>
          </div>
          <div className="space-y-2 md:space-y-0 md:divide-y">
            {items.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                Nothing matches.
              </p>
            )}
            {paged.rows.map((i) => {
              const dKey = standardKey(i.code, null);
              const dEdit = draft[dKey];
              const dflt = standardPrice(data.standard, i.code, null, today);
              const oKey = office ? standardKey(i.code, office) : null;
              const oEdit = oKey ? draft[oKey] : undefined;
              const own = office ? standardPrice(data.standard, i.code, office, today) : null;
              const overridden = own?.source === "office" && !(oEdit && "reset" in oEdit);
              return (
                <div
                  key={i.id}
                  data-standard-row={i.code}
                  className={cn(
                    "space-y-2 rounded-lg border p-3 md:grid md:grid-cols-[9rem_minmax(0,1fr)_4rem_9rem_10rem] md:items-start md:gap-3 md:space-y-0 md:rounded-none md:border-0 md:px-3 md:py-2",
                    (dEdit || oEdit) && "bg-muted/50 shadow-[inset_3px_0_0_var(--gold)]",
                  )}
                >
                  <span className="block font-mono text-xs md:pt-2">{i.code}</span>
                  <span className="flex items-start gap-1 text-sm md:pt-1.5">
                    <span className="min-w-0">{i.name}</span>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={() => setItemOpen(i.code)}
                        className="-my-1 shrink-0 rounded p-1 text-muted-foreground hover:bg-hover hover:text-foreground"
                        aria-label={`Edit ${i.code}`}
                        title="Edit the item"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </span>
                  <span className="block text-xs text-muted-foreground md:pt-2">{i.uom}</span>
                  <div>
                    <div className="flex items-center gap-1">
                      {/* With an office picked, the company column is there to
                          compare against — it is edited under Company Standard. */}
                      {office || !canEdit ? (
                        <span
                          className="h-11 w-24 pl-3 text-sm leading-[2.75rem] tabular-nums text-muted-foreground md:h-8 md:leading-8"
                          aria-label={`Company Standard for ${i.code}`}
                          data-company-readonly
                        >
                          {dEdit && "value" in dEdit
                            ? `$${dEdit.value}`
                            : dflt
                              ? usd(dflt.value)
                              : "Not set"}
                        </span>
                      ) : (
                        <>
                          <span className="text-sm text-muted-foreground">$</span>
                          <Input
                            value={
                              dEdit && "value" in dEdit
                                ? dEdit.value
                                : dflt
                                  ? dflt.value.toFixed(2)
                                  : ""
                            }
                            onChange={(e) => edit(i.code, null, e.target.value)}
                            inputMode="decimal"
                            placeholder="Set a rate"
                            aria-label={`Company Standard for ${i.code}`}
                            aria-invalid={problems.has(dKey) || undefined}
                            className={cn(
                              "h-11 w-24 tabular-nums md:h-8",
                              !dflt && "placeholder:text-destructive",
                              problems.has(dKey) && "border-destructive",
                            )}
                          />
                        </>
                      )}
                      <HistoryButton
                        book="client_agreements"
                        itemKey={i.code}
                        label={`${i.code} Standard`}
                        officeName={officeName}
                      />
                    </div>
                    {problems.has(dKey) && (
                      <p className="mt-1 text-xs text-destructive">{problems.get(dKey)}</p>
                    )}
                  </div>
                  {office && oKey ? (
                    <div>
                      <div className="flex items-center gap-1">
                        {canEdit ? (
                          <>
                            <span className="text-sm text-muted-foreground">$</span>
                            <Input
                              value={
                                oEdit && "value" in oEdit
                                  ? oEdit.value
                                  : overridden
                                    ? own!.value.toFixed(2)
                                    : ""
                              }
                              onChange={(e) => edit(i.code, office, e.target.value)}
                              inputMode="decimal"
                              placeholder={dflt ? `${dflt.value.toFixed(2)} (company)` : "Set"}
                              aria-label={`${officeName(office)} price for ${i.code}`}
                              className={cn(
                                "h-11 w-28 tabular-nums md:h-8",
                                overridden && "border-dashed border-link",
                              )}
                            />
                          </>
                        ) : (
                          <span
                            className={cn(
                              "pl-3 text-sm leading-[2.75rem] tabular-nums md:leading-8",
                              !overridden && "text-muted-foreground",
                            )}
                            aria-label={`${officeName(office)} price for ${i.code}`}
                          >
                            {overridden ? usd(own!.value) : dflt ? usd(dflt.value) : "Not set"}
                          </span>
                        )}
                        {overridden && canEdit && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-11 w-11 md:h-8 md:w-8"
                            onClick={() => reset(i.code, office)}
                            aria-label={`Reset ${i.code} at ${officeName(office)} to the company Standard`}
                            title="Reset to the company Standard"
                          >
                            <RotateCcw aria-hidden />
                          </Button>
                        )}
                      </div>
                      {!overridden && !oEdit && (
                        <p className="mt-0.5 text-[11px] text-muted-foreground">from company</p>
                      )}
                    </div>
                  ) : (
                    <span />
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
      <Pager paged={paged} noun="items" pending={pending} />
      {itemOpen && (
        <ItemDialog
          key={itemOpen}
          data={data}
          code={itemOpen === "new" ? null : itemOpen}
          onClose={() => setItemOpen(null)}
        />
      )}
      {canEdit && (
        <SaveBar
          pending={pending}
          problems={problems.size}
          note={note}
          onNote={setNote}
          saving={saving}
          onSave={() => void save()}
          onDiscard={() => {
            setDraft({});
            setNote("");
          }}
          hint="Takes effect today. Agreements' inherited lines follow at once."
        />
      )}
    </div>
  );
}

/**
 * Add an item to regular pricing, or rename / retire one, from Standard rates.
 * It is a Catalogs item (catalog_save): a new one goes in Services or
 * Equipment, which the database mirrors into the regular price book; a rename
 * or a retirement reaches the documents' item list the same way. A new item
 * can take its company Standard price in the same go.
 */
function ItemDialog({
  data,
  code,
  onClose,
}: {
  data: AgreementsData;
  /** null = a new item. */
  code: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const item = code ? (data.items.find((i) => i.code === code) ?? null) : null;
  const [form, setForm] = useState({
    code: "",
    name: item?.name ?? "",
    category: "service" as "service" | "equipment",
    unit: "piece" as CatalogUnit,
    price: "",
    active: item?.active ?? true,
  });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const newCode = normaliseCode(form.code);
  const clash = data.items.find(
    (i) => i.code !== code && nameKey(i.name) === nameKey(form.name) && form.name.trim(),
  );
  const problems: string[] = [];
  if (!item) {
    if (!isValidCode(newCode))
      problems.push("A code is letters, numbers and dashes, up to 24 (e.g. SVC-ODOR).");
    else if (data.items.some((i) => i.code === newCode))
      problems.push(`${newCode} is already an item.`);
  }
  if (!form.name.trim()) problems.push("An item needs a name.");
  if (clash) problems.push(`${clash.code} is already called that.`);
  const price = form.price.trim() ? Number(form.price.replace(/[$,\s]/g, "")) : null;
  if (price != null && (Number.isNaN(price) || price < 0))
    problems.push("The price is dollars and cents, 0 or more.");
  const changed = item ? form.name.trim() !== item.name || form.active !== item.active : true;

  async function save() {
    if (problems.length || !changed || !note.trim()) return;
    setBusy(true);
    try {
      if (item) {
        const change: Record<string, unknown> = { op: "update", code: item.code };
        if (form.name.trim() !== item.name) change.name = form.name.trim();
        if (form.active !== item.active) change.active = form.active;
        await saveCatalog([change], note);
        toast.success(`${item.code} saved`);
      } else {
        await saveCatalog(
          [
            {
              op: "create",
              code: newCode,
              name: form.name.trim(),
              category: form.category,
              unit: form.unit,
              ...(form.category === "equipment" ? { in_tm: false } : {}),
            },
          ],
          note,
        );
        if (price != null) {
          await saveStandard(
            standardDraftToChanges({ [standardKey(newCode, null)]: { value: price.toFixed(2) } }),
            note,
          );
        }
        toast.success(`${newCode} added`, {
          description: "It is in Catalogs too, and priced on regular jobs.",
        });
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: KEY }),
        qc.invalidateQueries({ queryKey: ["billing-costs", "catalog"] }),
        qc.invalidateQueries({ queryKey: ["document-pricing"] }),
      ]);
      onClose();
    } catch (err) {
      toastDbError(err, { action: item ? "Saving the item" : "Adding the item" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md" data-regular-item-dialog>
        <DialogHeader>
          <DialogTitle>{item ? `Edit ${item.code}` : "Add an item"}</DialogTitle>
          <DialogDescription>
            {item
              ? "Renaming reaches estimates and invoices made from now on. An inactive item stops being offered on new documents."
              : "A regular-pricing item, kept in Catalogs. Set its company Standard price here or later."}
          </DialogDescription>
        </DialogHeader>
        {!item && (
          <label className="text-sm">
            Code
            <Input
              value={form.code}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              placeholder="e.g. SVC-ODOR"
              className="mt-1 h-11 font-mono uppercase md:h-9"
            />
          </label>
        )}
        <label className="text-sm">
          Name
          <Input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="mt-1 h-11 md:h-9"
          />
        </label>
        {item ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
            />
            Active — offered on new estimates and invoices
          </label>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-sm">
              Kind
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v as typeof f.category }))}
              >
                <SelectTrigger className="mt-1 h-11 md:h-9" aria-label="Kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["service", "equipment"] as const).map((c) => (
                    <SelectItem key={c} value={c}>
                      {CATALOG_CATEGORY_LABEL[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="text-sm">
              Unit
              <Select
                value={form.unit}
                onValueChange={(v) => setForm((f) => ({ ...f, unit: v as CatalogUnit }))}
              >
                <SelectTrigger className="mt-1 h-11 md:h-9" aria-label="Unit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UNITS_BY_CATEGORY[form.category].map((u) => (
                    <SelectItem key={u} value={u}>
                      {CATALOG_UNIT_LABEL[u]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <label className="col-span-2 text-sm">
              Company Standard price (optional)
              <div className="mt-1 flex items-center gap-1">
                <span className="text-sm text-muted-foreground">$</span>
                <Input
                  value={form.price}
                  onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="h-11 w-32 tabular-nums md:h-9"
                />
              </div>
            </label>
          </div>
        )}
        <label className="text-sm">
          Why (required)
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. New odor treatment service"
            className="mt-1 h-11 md:h-9"
          />
        </label>
        {problems.length > 0 && (form.code || form.name) && (
          <ul className="space-y-0.5 text-xs text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="cta"
            disabled={busy || problems.length > 0 || !changed || !note.trim()}
            onClick={() => void save()}
          >
            {busy ? "Saving…" : item ? "Save" : "Add item"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ----------------------------------------------------------- agreements */

function AgreementsList({
  data,
  canEdit,
  book = REGULAR_BOOK,
}: {
  data: AgreementsData;
  canEdit: boolean;
  book?: AgreementBook;
}) {
  const qc = useQueryClient();
  const today = localToday();
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const agreements = data.agreements.filter((a) => a.kind === "agreement" && !a.archived);
  const others = data.agreements.filter((a) => a.kind !== "agreement" || a.archived);
  const mixQ = useQuery({
    queryKey: [...book.key, "mix", agreements.map((a) => a.id).join(",")],
    enabled: canEdit,
    queryFn: () => loadJobMix(agreements.flatMap((a) => a.clients.map((c) => c.accountId))),
  });
  const mix = mixQ.data ?? new Map();
  const groups = groupByClient(agreements, today);
  const selected = data.agreements.find((a) => a.id === open) ?? null;

  return (
    <div className="space-y-3" data-agreements-list>
      {canEdit && (
        <Button variant="cta" className="h-11 md:h-8" onClick={() => setCreating(true)}>
          <Plus aria-hidden /> New agreement
        </Button>
      )}
      {agreements.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No client agreements yet — every client pays {book.standard}.
        </p>
      )}
      {groups.map((g) => (
        <section key={g.client} className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Users className="h-3.5 w-3.5" aria-hidden /> {g.client}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {g.agreements.map((a) => {
              const liveClients = a.clients.filter((c) => linkLive(c, today));
              const jobs = liveClients.reduce((n, c) => n + (mix.get(c.accountId)?.jobs ?? 0), 0);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setOpen(a.id)}
                  className="rounded-lg border bg-card p-3 text-left hover:bg-hover"
                  data-agreement-card={a.id}
                >
                  <p className="flex items-center gap-2 font-medium">
                    {a.name}
                    {a.fullCopy && (
                      <Badge variant="outline" className="normal-case tracking-normal">
                        full copy
                      </Badge>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {overrideSummary(a, data.items, book.standard)}
                  </p>
                  <ul className="mt-1 space-y-0.5 text-sm">
                    {keyRates(a, data.items).map((k) => (
                      <li key={k.code} className="flex justify-between gap-2">
                        <span className="truncate">{k.name}</span>
                        <span className="tabular-nums">
                          {usd(k.price)}/{k.uom}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {liveClients.length
                      ? liveClients.map((c) => c.accountName).join(", ")
                      : "No client linked"}
                    {canEdit && ` · ${jobs} job${jobs === 1 ? "" : "s"}`}
                    {a.effectiveFrom && ` · from ${formatDateUS(a.effectiveFrom)}`}
                  </p>
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {others.length > 0 && (
        <details className="rounded-lg border bg-card">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
            Other price lists ({others.length}) — read only
          </summary>
          <ul className="divide-y text-sm">
            {others.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2 px-3 py-2">
                <span>{a.name}</span>
                <span className="text-xs text-muted-foreground">
                  {a.archived
                    ? "archived"
                    : a.kind === "office"
                      ? `office list — now Standard for ${a.scopes.join(", ")}`
                      : `state list — ${a.scopes.join(", ")}`}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {selected && (
        <AgreementDialog
          key={selected.id}
          agreement={selected}
          data={data}
          canEdit={canEdit && selected.kind === "agreement" && !selected.archived}
          book={book}
          onClose={() => setOpen(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: book.key })}
        />
      )}
      {creating && (
        <NewAgreementDialog
          data={data}
          book={book}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await qc.invalidateQueries({ queryKey: book.key });
            if (id) setOpen(id);
          }}
        />
      )}
    </div>
  );
}

function NewAgreementDialog({
  data,
  book,
  onClose,
  onCreated,
}: {
  data: AgreementsData;
  book: AgreementBook;
  onClose: () => void;
  onCreated: (id: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [from, setFrom] = useState(localToday());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const taken = data.agreements.some(
    (a) => !a.archived && a.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            New {book === TM_BOOK ? "T&M client agreement" : "client agreement"}
          </DialogTitle>
          <DialogDescription>
            Starts with no exceptions — every line follows {book.standard} until you change one.
          </DialogDescription>
        </DialogHeader>
        <label className="text-sm">
          Name
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 h-11 md:h-9"
            aria-invalid={taken || undefined}
          />
        </label>
        {taken && (
          <p className="text-xs text-destructive">There is already an agreement called that.</p>
        )}
        <label className="text-sm">
          Effective from
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="mt-1 h-11 md:h-9"
          />
        </label>
        <label className="text-sm">
          Why (optional)
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 h-11 md:h-9"
            placeholder="e.g. Signed 2026 rate sheet"
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="cta"
            disabled={busy || !name.trim() || taken}
            onClick={async () => {
              setBusy(true);
              try {
                /* 4 Nov: "why" is optional. The change log still needs a
                   line (the save refuses an empty one), so a blank says
                   what was done. */
                const id = await book.save(
                  [{ op: "create", name: name.trim(), effective_from: from }],
                  note.trim() || `New agreement: ${name.trim()}`,
                );
                toast.success(`${name.trim()} created`);
                onCreated(id);
              } catch (err) {
                toastDbError(err, { action: "Creating the agreement" });
              } finally {
                setBusy(false);
              }
            }}
          >
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The agreement's exceptions as they will be after Save. */
function effectiveLines(a: Agreement, draft: AgreementDraft): Map<string, number> {
  const out = new Map(a.lines);
  for (const [code, raw] of Object.entries(draft.lines)) {
    if (raw.trim() === "") out.delete(code);
    else out.set(code, Number(raw.replace(/[$,\s]/g, "")) || 0);
  }
  return out;
}

function AgreementDialog({
  agreement: a,
  data,
  canEdit,
  book,
  onClose,
  onSaved,
}: {
  agreement: Agreement;
  data: AgreementsData;
  canEdit: boolean;
  book: AgreementBook;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = localToday();
  const [draft, setDraft] = useState<AgreementDraft>(EMPTY_AGREEMENT_DRAFT);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [onlyOverridden, setOnlyOverridden] = useState(a.lines.size > 0);
  const [picked, setPicked] = useState<PickedAccount | null>(null);
  const [tmNote, setTmNote] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [itemSearch, setItemSearch] = useState("");
  const problems = agreementProblems(draft);
  const pending = agreementDraftSize(draft);
  /** Lines saying exactly what the company Standard says today (P5 answer 4). */
  const sameAsStandard = data.items.filter((i) => {
    const v = a.lines.get(i.code);
    return v != null && v === standardPrice(data.standard, i.code, null, today, data.lens)?.value;
  });
  const liveClients = a.clients.filter(
    (c) => linkLive(c, today) && !draft.unlink.includes(c.assignmentId),
  );

  const value = (code: string) => {
    const d = draft.lines[code];
    if (d !== undefined) return d;
    const v = a.lines.get(code);
    return v == null ? "" : v.toFixed(2);
  };
  const needle = itemSearch.trim().toLowerCase();
  const items = data.items.filter(
    (i) =>
      i.active &&
      (!onlyOverridden || a.lines.has(i.code) || draft.lines[i.code] !== undefined) &&
      (!needle || `${i.code} ${i.name}`.toLowerCase().includes(needle)),
  );
  const paged = usePaged(items, `${onlyOverridden}|${needle}`);

  async function addClient(acc: PickedAccount) {
    setPicked(null);
    if (
      draft.link.some((l) => l.accountId === acc.id) ||
      liveClients.some((c) => c.accountId === acc.id)
    )
      return;
    setDraft((d) => ({ ...d, link: [...d.link, { accountId: acc.id, primary: false }] }));
    const mix = (await loadJobMix([acc.id])).get(acc.id);
    setTmNote(book.mixNote(acc.name, mix));
  }
  function importCsv() {
    const result = parsePriceListCsv(importText, catalogCodeIndex(data.items));
    const codeOf = new Map(data.items.map((i) => [i.id, i.code]));
    setDraft((d) => {
      const lines = { ...d.lines };
      for (const r of result.rows) {
        const code = codeOf.get(r.catalog_item_id);
        if (code) lines[code] = r.unit_price.toFixed(2);
      }
      return { ...d, lines };
    });
    toast.success(`${result.rows.length} line${result.rows.length === 1 ? "" : "s"} read`, {
      description: result.problems.length
        ? `${result.problems.length} row(s) skipped: ${result.problems
            .slice(0, 3)
            .map((p) => `line ${p.line}`)
            .join(", ")}`
        : "Review them, then save.",
    });
    setImportText("");
    setOnlyOverridden(true);
  }
  async function save(extra: Record<string, unknown>[] = [], closes = true) {
    if (problems.size || (!pending && !extra.length)) return;
    setSaving(true);
    // A blank "why" says what was done, for the change log (4 Nov).
    const op = extra[0]?.op;
    const said =
      note.trim() ||
      (op === "archive"
        ? `Archived ${a.name}`
        : op === "strip_standard"
          ? `Removed lines equal to ${book.standard} from ${a.name}`
          : `Updated ${a.name}`);
    try {
      await book.save([...agreementDraftToChanges(a.id, draft), ...extra], said);
      toast.success(extra.length && closes ? `${a.name} archived` : `${a.name} saved`);
      setDraft(EMPTY_AGREEMENT_DRAFT);
      setNote("");
      onSaved();
      if (extra.length && closes) onClose();
    } catch (err) {
      toastDbError(err, { action: "Saving the agreement" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl" data-agreement-dialog>
        <DialogHeader>
          <DialogTitle>
            {canEdit ? (
              <Input
                value={draft.rename ?? a.name}
                onChange={(e) => setDraft((d) => ({ ...d, rename: e.target.value }))}
                aria-label="Agreement name"
                className="h-9 text-base font-semibold"
              />
            ) : (
              a.name
            )}
          </DialogTitle>
          <DialogDescription data-override-summary>
            {overrideSummary({ lines: effectiveLines(a, draft) }, data.items, book.standard)}
            {a.effectiveFrom && ` · effective ${formatDateUS(a.effectiveFrom)}`}
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-2">
          <h4 className="text-sm font-medium">Applies to</h4>
          <ul className="flex flex-wrap gap-2">
            {liveClients.map((c) => (
              <li key={c.assignmentId}>
                <Badge variant="secondary" className="gap-1 normal-case tracking-normal">
                  {c.primary && <Star className="h-3 w-3" aria-label="Primary" />}
                  {c.accountName}
                  <span className="text-muted-foreground">
                    · from {formatDateUS(c.effectiveFrom)}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      className="ml-1 text-link hover:underline"
                      onClick={() =>
                        setDraft((d) => ({ ...d, unlink: [...d.unlink, c.assignmentId] }))
                      }
                      aria-label={`End ${c.accountName}'s link`}
                    >
                      End
                    </button>
                  )}
                </Badge>
              </li>
            ))}
            {draft.link.map((l) => (
              <li key={l.accountId}>
                <Badge variant="outline" className="normal-case tracking-normal">
                  new client — added on save
                </Badge>
              </li>
            ))}
            {!liveClients.length && !draft.link.length && (
              <li className="text-sm text-muted-foreground">No client yet.</li>
            )}
          </ul>
          {canEdit && (
            <div className="max-w-sm">
              <AccountPicker
                value={picked}
                onChange={(acc) => acc && void addClient(acc)}
                label="Link a client"
              />
            </div>
          )}
          {tmNote && (
            <p className="flex items-start gap-1.5 text-xs text-warning" data-tm-attach-note>
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> {tmNote}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">Rates</h4>
            <Input
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Search by code or name"
              aria-label={`Search ${a.name} rates`}
              className="h-11 min-w-0 flex-1 basis-40 md:h-8"
            />
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={onlyOverridden}
                onChange={(e) => setOnlyOverridden(e.target.checked)}
              />
              Only the overridden items
            </label>
          </div>
          <div className="divide-y rounded-md border">
            {paged.rows.map((i) => {
              const std = standardPrice(data.standard, i.code, null, today, data.lens);
              const v = value(i.code);
              const overrides = v.trim() !== "";
              return (
                <div
                  key={i.id}
                  className="grid grid-cols-[minmax(0,1fr)_7rem_8rem] items-center gap-2 px-3 py-1.5 text-sm"
                >
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-xs text-muted-foreground">
                      {i.label ?? i.code}
                    </span>{" "}
                    {i.name}
                  </span>
                  <span className="text-right text-xs tabular-nums text-muted-foreground">
                    {book.standardShort} {usd(std?.value)}
                  </span>
                  {canEdit ? (
                    <Input
                      value={v}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, lines: { ...d.lines, [i.code]: e.target.value } }))
                      }
                      inputMode="decimal"
                      placeholder={`follows ${book.standard}`}
                      aria-label={`${a.name} price for ${i.code}`}
                      aria-invalid={problems.has(i.code) || undefined}
                      className={cn(
                        "h-11 tabular-nums md:h-8",
                        overrides && "border-dashed border-link",
                        problems.has(i.code) && "border-destructive",
                      )}
                    />
                  ) : (
                    <span
                      className={cn(
                        "text-sm tabular-nums",
                        !overrides && "text-xs text-muted-foreground",
                      )}
                      aria-label={`${a.name} price for ${i.code}`}
                    >
                      {overrides ? `$${v}` : `follows ${book.standard}`}
                    </span>
                  )}
                </div>
              );
            })}
            {items.length === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">
                {needle
                  ? "Nothing matches."
                  : `No overrides — every item follows ${book.standard}. Untick the box to set one.`}
              </p>
            )}
          </div>
          <Pager paged={paged} noun="items" className="px-0 md:px-0" />
          {canEdit && (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-link">
                <Upload className="mr-1 inline h-3 w-3" aria-hidden /> Import a sheet (Code,Price)
              </summary>
              <Textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={book.importExample}
                className="mt-2 font-mono text-xs"
                rows={4}
              />
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                disabled={!importText.trim()}
                onClick={importCsv}
              >
                Read the sheet
              </Button>
            </details>
          )}
        </section>

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why? (optional, for the change log)"
              aria-label="Note for the change log"
              className="h-11 min-w-0 basis-full md:h-9 sm:basis-auto sm:flex-1"
            />
            <HistoryButton book={book.history} itemKey={a.id} label={a.name} />
            {sameAsStandard.length > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="h-11 md:h-9" data-strip-standard>
                    <Scissors aria-hidden /> Strip {sameAsStandard.length} line
                    {sameAsStandard.length === 1 ? "" : "s"} equal to {book.standard}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 space-y-2 p-3" align="end">
                  <p className="text-sm">
                    These lines say exactly what {book.standard} says, so they drop and follow{" "}
                    {book.standard} from now on:
                  </p>
                  <ul className="max-h-40 overflow-y-auto text-xs" data-strip-preview>
                    {sameAsStandard.map((i) => (
                      <li key={i.code} className="flex justify-between gap-2">
                        <span className="truncate">
                          <span className="font-mono">{i.label ?? i.code}</span> {i.name}
                        </span>
                        <span className="tabular-nums">{usd(a.lines.get(i.code))}</span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="cta"
                    className="w-full"
                    disabled={saving}
                    onClick={() => void save([{ op: "strip_standard", agreement_id: a.id }], false)}
                  >
                    Strip them
                  </Button>
                </PopoverContent>
              </Popover>
            )}
            <Button
              variant="outline"
              className="h-11 border-destructive/50 text-destructive hover:bg-destructive/10 md:h-9"
              disabled={saving}
              onClick={() => void save([{ op: "archive", agreement_id: a.id }])}
            >
              <Archive aria-hidden /> Archive
            </Button>
            <Button
              variant="cta"
              className="h-11 md:h-9"
              disabled={saving || !pending || problems.size > 0}
              onClick={() => void save()}
            >
              {saving
                ? "Saving…"
                : `Save${pending ? ` ${pending} change${pending === 1 ? "" : "s"}` : ""}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
