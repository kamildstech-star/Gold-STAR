/**
 * A customer's open balance and account statement (FE9, 28 Oct).
 *
 * "Open" means an invoice that has gone out (not a draft), has not been
 * written off, and still has money owed on it. The balance is the sum of what
 * is owed across all of them — every job of the customer's, not just the one
 * on screen. The statement lists those invoices, the payments already taken
 * against them, and the balance, as one PDF the office emails from the
 * account the same way an invoice goes (the composer; nothing is sent until
 * Send is pressed).
 */
import { supabase } from "@/integrations/supabase/client";
import { BILL_TO_ACCOUNT_FIELDS, billToLines, type BillToAccount } from "@/lib/bill-to";
import { embedLogo } from "@/lib/estimate-pdf";
import { outstandingBalance } from "@/lib/invoice-paid";
import {
  BAND,
  CONTENT_W,
  type Col,
  INK,
  LINE,
  MARGIN,
  MUTED,
  NAVY,
  Sheet,
  money,
  shortDate,
} from "@/lib/pdf-kit";
import { roundMoneyLoose } from "@/lib/money";

export type StatementInvoice = {
  id: string;
  invoice_number: string;
  issue_date: string;
  due_date: string | null;
  job_id: string | null;
  job_number: string | null;
  status: string;
  billed_amount: number;
  collected_amount: number;
  location_id: string;
};

export type StatementPayment = {
  invoice_id: string;
  amount: number;
  received_at: string;
  method: string | null;
  reference: string | null;
};

/** Statuses that never count toward what the customer owes. */
const NOT_OWED = new Set(["draft", "written_off"]);

/** An invoice the customer still owes money on. */
export function isOpenInvoice(
  inv: Pick<StatementInvoice, "status" | "billed_amount" | "collected_amount">,
): boolean {
  return !NOT_OWED.has(inv.status) && outstandingBalance(inv) > 0.005;
}

export type StatementTotals = { billed: number; paid: number; balance: number; count: number };

const round2 = roundMoneyLoose;

/** Totals over the open invoices only. */
export function statementTotals(invoices: readonly StatementInvoice[]): StatementTotals {
  const open = invoices.filter(isOpenInvoice);
  const billed = round2(open.reduce((s, i) => s + Number(i.billed_amount || 0), 0));
  const paid = round2(open.reduce((s, i) => s + Number(i.collected_amount || 0), 0));
  return { billed, paid, balance: round2(billed - paid), count: open.length };
}

const INVOICE_COLS =
  "id, invoice_number, issue_date, due_date, job_id, job_number, status, billed_amount, collected_amount, location_id";

async function accountInvoices(accountId: string): Promise<StatementInvoice[]> {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("account_id", accountId)
    .order("issue_date", { ascending: true });
  if (error) throw error;
  return ((data ?? []) as StatementInvoice[]).map((i) => ({
    ...i,
    billed_amount: Number(i.billed_amount) || 0,
    collected_amount: Number(i.collected_amount) || 0,
  }));
}

/** The customer's open balance across every job. Null when there is no customer. */
export async function accountOpenBalance(
  accountId: string | null | undefined,
): Promise<StatementTotals | null> {
  if (!accountId) return null;
  return statementTotals(await accountInvoices(accountId));
}

export type AccountStatement = {
  account: BillToAccount & { location_id?: string | null };
  invoices: StatementInvoice[];
  payments: StatementPayment[];
  totals: StatementTotals;
  /**
   * The office the most recent open invoice was issued from (its letterhead),
   * else the customer's own office.
   */
  locationId: string | null;
};

export async function loadAccountStatement(accountId: string): Promise<AccountStatement> {
  const [{ data: account, error: accErr }, all] = await Promise.all([
    supabase
      .from("accounts")
      .select(`${BILL_TO_ACCOUNT_FIELDS}, location_id`)
      .eq("id", accountId)
      .single(),
    accountInvoices(accountId),
  ]);
  if (accErr) throw accErr;
  const invoices = all.filter(isOpenInvoice);
  let payments: StatementPayment[] = [];
  if (invoices.length) {
    const { data, error } = await supabase
      .from("invoice_payments")
      .select("invoice_id, amount, received_at, method, reference")
      .in(
        "invoice_id",
        invoices.map((i) => i.id),
      )
      .order("received_at", { ascending: true });
    if (error) throw error;
    payments = ((data ?? []) as StatementPayment[]).map((p) => ({
      ...p,
      amount: Number(p.amount) || 0,
    }));
  }
  return {
    account: account as unknown as BillToAccount,
    invoices,
    payments,
    totals: statementTotals(invoices),
    locationId:
      invoices.at(-1)?.location_id ??
      (account as { location_id?: string | null } | null)?.location_id ??
      null,
  };
}

type Letterhead = {
  name?: string | null;
  legal_entity_name?: string | null;
  logo_url?: string | null;
  address?: string | null;
  locality?: string | null;
  region?: string | null;
  postal_code?: string | null;
  office_phone?: string | null;
  office_email?: string | null;
};

export type StatementPdf = {
  bytes: Uint8Array;
  filename: string;
  title: string;
  locationId: string | null;
};

/** The statement as a customer-facing PDF. */
export async function buildAccountStatementPdf(
  st: AccountStatement,
  today = new Date(),
): Promise<StatementPdf> {
  let loc: Letterhead = {};
  if (st.locationId) {
    const { data } = await supabase
      .from("locations")
      .select(
        "name, legal_entity_name, logo_url, address, locality, region, postal_code, office_phone, office_email",
      )
      .eq("id", st.locationId)
      .maybeSingle();
    loc = (data as Letterhead | null) ?? {};
  }
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const s = await Sheet.create("customer");
  const top = s.y;
  const logo = await embedLogo(s, loc.logo_url ?? null);
  if (logo) {
    const w = 128;
    const h = (logo.height / logo.width) * w;
    logo.draw(s.page, { x: MARGIN, y: top - h, width: w, height: h });
    s.y = top - Math.max(h, 40) - 10; // clear of the logo's lowest line (12 Nov)
  } else {
    s.text(loc.legal_entity_name || loc.name || "Gold Star Restoration", MARGIN, top - 14, {
      size: 15,
      bold: true,
      color: NAVY,
    });
    s.y = top - 26;
  }
  let oy = top - 4;
  for (const line of [
    loc.name,
    loc.address,
    [loc.locality, loc.region, loc.postal_code].filter(Boolean).join(", "),
    loc.office_phone,
    loc.office_email,
  ].filter(Boolean) as string[]) {
    s.text(line, MARGIN, oy, { size: 8, color: MUTED, align: "right", width: CONTENT_W });
    oy -= 10.5;
  }
  s.y = Math.min(s.y, oy) - 10;

  s.ensure(34);
  s.y -= 22;
  s.text("ACCOUNT STATEMENT", MARGIN, s.y, { size: 20, bold: true, color: NAVY });
  s.y -= 12;
  s.rule(NAVY, 1.2);

  s.y -= 12;
  s.text("BILL TO", MARGIN, s.y, { size: 7.5, bold: true, color: NAVY });
  s.y -= 14;
  billToLines({ account: st.account, attention: null, explicit: false }).forEach((l, i) => {
    s.text(l, MARGIN, s.y, { size: 8.5, bold: i === 0 });
    s.y -= 11.5;
  });

  const boxes = [
    { label: "Statement date", value: shortDate(iso) },
    { label: "Open invoices", value: String(st.totals.count) },
    { label: "Paid to date", value: money(st.totals.paid) },
    { label: "Balance due", value: money(st.totals.balance) },
  ];
  const bw = CONTENT_W / boxes.length;
  s.ensure(48);
  s.y -= 44;
  boxes.forEach((b, i) => {
    const x = MARGIN + i * bw;
    s.box(x, s.y, bw, 40, i === 3 ? BAND : undefined, LINE);
    s.text(b.label.toUpperCase(), x + 10, s.y + 26, { size: 7, bold: true, color: MUTED });
    s.text(b.value, x + 10, s.y + 10, { size: 11, bold: true, color: i === 3 ? NAVY : INK });
  });

  s.sectionLabel("Open invoices");
  if (!st.invoices.length) {
    s.y -= 14;
    s.text("Nothing is owed on this account.", MARGIN, s.y, { size: 9, color: MUTED });
  } else {
    const cols: Col[] = [
      { key: "num", label: "Invoice #", width: 90 },
      { key: "job", label: "Job", width: 80 },
      { key: "date", label: "Date", width: 70 },
      { key: "due", label: "Due", width: 70 },
      { key: "billed", label: "Billed", width: 0, align: "right" },
      { key: "paid", label: "Paid", width: 70, align: "right" },
      { key: "bal", label: "Balance", width: 72, align: "right" },
    ];
    cols[4]!.width = CONTENT_W - cols.reduce((n, c) => n + c.width, 0);
    s.tableHeader(cols);
    for (const i of st.invoices) {
      s.tableRow(cols, {
        num: i.invoice_number,
        job: i.job_number ?? "—",
        date: shortDate(i.issue_date),
        due: shortDate(i.due_date) || "On receipt",
        billed: money(i.billed_amount),
        paid: money(i.collected_amount),
        bal: { text: money(outstandingBalance(i)), bold: true },
      });
    }
  }

  if (st.payments.length) {
    const numberOf = new Map(st.invoices.map((i) => [i.id, i.invoice_number]));
    s.sectionLabel("Payments received");
    const cols: Col[] = [
      { key: "date", label: "Date", width: 80 },
      { key: "inv", label: "Invoice #", width: 100 },
      { key: "method", label: "Method", width: 100 },
      { key: "ref", label: "Reference", width: 0 },
      { key: "amount", label: "Amount", width: 86, align: "right" },
    ];
    cols[3]!.width = CONTENT_W - cols.reduce((n, c) => n + c.width, 0);
    s.tableHeader(cols);
    for (const p of st.payments) {
      s.tableRow(cols, {
        date: shortDate(p.received_at),
        inv: numberOf.get(p.invoice_id) ?? "—",
        method: p.method || "—",
        ref: p.reference || "—",
        amount: money(p.amount),
      });
    }
  }

  s.ensure(30);
  s.y -= 22;
  s.text(`Balance due: ${money(st.totals.balance)}`, MARGIN, s.y, {
    size: 12,
    bold: true,
    color: NAVY,
    align: "right",
    width: CONTENT_W,
  });

  const name = (st.account.name || "Customer").replace(/[^\w.-]+/g, "_").slice(0, 60);
  return {
    bytes: await s.save(),
    filename: `Statement_${name}_${iso}.pdf`,
    title: `Account statement — ${st.account.name || "Customer"} — ${shortDate(iso)}`,
    locationId: st.locationId,
  };
}
