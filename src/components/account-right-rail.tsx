import { AccountStatementButton } from "@/components/account-statement-button";
import { accountOpenBalance } from "@/lib/account-statement";
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { FileText, Files, Mail, Phone, Plus, Receipt, Search } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CONTACT_ROLE_LABEL, type ContactDecisionRole } from "@/lib/accounts";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type RailContact = {
  id: string;
  full_name: string;
  title: string | null;
  decision_role: ContactDecisionRole | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
};

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

function fmtDay(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);
}

/** Right rail — the people, exactly as the record page mockup lays them out. */
export function CompanyContactsCard({
  accountId,
  contacts,
  action,
}: {
  accountId: string;
  contacts: RailContact[];
  action?: React.ReactNode;
}) {
  const [q, setQ] = useState("");

  const lastTouch = useQuery({
    queryKey: ["account-contact-touches", accountId],
    queryFn: async () => {
      const { data } = await supabase
        .from("touchpoints")
        .select("contact_id,occurred_at")
        .eq("account_id", accountId)
        .order("occurred_at", { ascending: false })
        .limit(500);
      const map = new Map<string, string>();
      for (const t of data ?? []) {
        const cid = t.contact_id as string | null;
        if (cid && !map.has(cid)) map.set(cid, t.occurred_at as string);
      }
      return map;
    },
  });

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? contacts.filter((c) =>
          [c.full_name, c.title, c.email].filter(Boolean).join(" ").toLowerCase().includes(needle),
        )
      : contacts;
    return list.slice(0, 4);
  }, [contacts, q]);

  return (
    <section className="@container rounded-xl border bg-card">
      <div className="px-5 pb-3 pt-4">
        <h2 className="text-[17px] font-semibold text-foreground">Company Contacts</h2>
        <div className="mt-3 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search contacts"
              className="h-10 rounded-lg pl-9 text-[13px]"
            />
          </div>
          <div className="shrink-0">
            {action ?? (
              <Button variant="outline" size="sm" className="h-10 rounded-lg px-3 text-[13px]">
                <Plus className="mr-1 size-4" /> Add contact
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="divide-y">
        {shown.length === 0 ? (
          <p className="px-5 py-4 text-[13px] text-muted-foreground">
            No contacts yet — add the person you are actually building the relationship with.
          </p>
        ) : (
          shown.map((c) => {
            const touched = fmtDay(lastTouch.data?.get(c.id) ?? null);
            return (
              <div key={c.id} className="flex gap-3 px-5 py-4">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] font-semibold text-muted-foreground">
                  {initials(c.full_name)}
                </span>
                <div className="min-w-0 flex-1">
                  {/*
                    Names, titles and addresses are user data of any length —
                    each one is either broken onto the next line or ellipsised
                    with the full value on hover. Nothing runs past the card.
                  */}
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <Link
                      to="/contacts"
                      search={{ sel: c.id }}
                      title={c.full_name}
                      className="min-w-0 max-w-full break-words text-[15px] font-semibold text-foreground hover:underline"
                    >
                      {c.full_name}
                    </Link>
                    {c.phone && (
                      <a
                        href={`tel:${c.phone}`}
                        className="max-w-full shrink-0 truncate whitespace-nowrap text-[13px] text-link hover:underline"
                      >
                        {c.phone}
                      </a>
                    )}
                  </div>
                  <div className="mt-0.5 flex min-w-0 flex-col gap-x-3 @[24rem]:flex-row @[24rem]:items-baseline">
                    <span
                      title={c.title ?? undefined}
                      className="min-w-0 max-w-full truncate text-[13px] text-muted-foreground @[24rem]:flex-1"
                    >
                      {c.title ?? "—"}
                    </span>
                    {c.email && (
                      <a
                        href={`mailto:${c.email}`}
                        title={c.email}
                        className="min-w-0 max-w-full truncate text-[13px] text-link hover:underline @[24rem]:max-w-[55%] @[24rem]:shrink-0"
                      >
                        {c.email}
                      </a>
                    )}
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {c.is_primary && (
                      <span className="max-w-full truncate rounded-md bg-success/12 px-2 py-0.5 text-[11px] font-medium text-success">
                        Primary Contact
                      </span>
                    )}
                    {c.decision_role && (
                      <span className="max-w-full truncate rounded-md bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-foreground">
                        {CONTACT_ROLE_LABEL[c.decision_role]}
                      </span>
                    )}
                  </div>

                  <div className="mt-1.5 text-[12px] text-muted-foreground">
                    {touched ? `Last contacted ${touched}` : "No touch recorded"}
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <Button
                      asChild
                      variant="outline"
                      size="icon"
                      className="size-9 rounded-lg"
                      disabled={!c.phone}
                    >
                      <a href={c.phone ? `tel:${c.phone}` : undefined} aria-label="Call">
                        <Phone className="size-4 text-link" />
                      </a>
                    </Button>
                    <Button asChild variant="outline" size="icon" className="size-9 rounded-lg">
                      <a href={c.email ? `mailto:${c.email}` : undefined} aria-label="Email">
                        <Mail className="size-4 text-link" />
                      </a>
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {contacts.length > shown.length && (
        <div className="border-t px-5 py-3 text-center">
          <Link
            to="/contacts"
            search={{ sel: undefined }}
            className="text-[13px] font-medium text-link hover:underline"
          >
            View all contacts
          </Link>
        </div>
      )}
    </section>
  );
}

/** Files, documents and invoices — counts only, no amounts (money rule). */
const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

export function DocumentsInvoicesCard({
  accountId,
  onOpenFiles,
}: {
  accountId: string;
  onOpenFiles: () => void;
}) {
  const q = useQuery({
    queryKey: ["account-doc-counts", accountId],
    queryFn: async () => {
      const [docs, invs] = await Promise.all([
        supabase
          .from("documents")
          .select("id,name,doc_type,created_at")
          .eq("account_id", accountId)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase.from("invoices").select("id").eq("account_id", accountId).limit(200),
      ]);
      const rows = docs.data ?? [];
      const files = rows.filter((d) => (d.doc_type as string) !== "contract");
      return {
        files: files.length,
        documents: rows.length,
        invoices: (invs.data ?? []).length,
        recent: rows[0]
          ? { name: rows[0].name as string, at: fmtDay(rows[0].created_at as string) }
          : null,
      };
    },
  });

  const balanceQ = useQuery({
    queryKey: ["account-open-balance", accountId],
    queryFn: () => accountOpenBalance(accountId),
  });

  const tiles = [
    { key: "files", label: "Files", icon: Files, n: q.data?.files ?? 0, cta: "View files" },
    {
      key: "documents",
      label: "Documents",
      icon: FileText,
      n: q.data?.documents ?? 0,
      cta: "View documents",
    },
    {
      key: "invoices",
      label: "Invoices",
      icon: Receipt,
      n: q.data?.invoices ?? 0,
      cta: "View invoices",
    },
  ];

  return (
    <section className="@container rounded-xl border bg-card px-5 py-4">
      <h2 className="text-[17px] font-semibold text-foreground">Documents &amp; Invoices</h2>
      {/*
        Three columns only fit once the card is genuinely wide. In a narrow rail
        each tile becomes a full-width row — icon, label and count on one line,
        the action beneath — so nothing collides or wraps mid-phrase.
      */}
      <div className="mt-3 grid grid-cols-1 gap-2 @[24rem]:grid-cols-3 @[24rem]:gap-3">
        {tiles.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={onOpenFiles}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-accent @[24rem]:block @[24rem]:px-2 @[24rem]:py-3 @[24rem]:text-center"
          >
            <t.icon className="size-5 shrink-0 text-link @[24rem]:mx-auto" />
            <div className="min-w-0 truncate text-[15px] font-semibold text-foreground @[24rem]:mt-1.5">
              {t.label}
            </div>
            <div className="text-[22px] font-bold leading-tight text-foreground">{t.n}</div>
            <div className="col-span-2 col-start-2 row-start-2 truncate text-[12px] font-medium text-link @[24rem]:mt-1">
              {t.cta}
            </div>
          </button>
        ))}
      </div>
      {q.data?.recent && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3 text-[12px] text-muted-foreground">
          <span className="min-w-0 truncate" title={q.data.recent.name}>
            Recent: {q.data.recent.name}
          </span>
          <span className="shrink-0 whitespace-nowrap">{q.data.recent.at}</span>
        </div>
      )}
      {/* FE9: what the customer owes across every job, and the statement. */}
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
        data-account-balance
      >
        <div className="text-[13px]">
          <span className="text-muted-foreground">Open balance </span>
          <span className="font-semibold tabular-nums text-foreground">
            {balanceQ.data ? usd(balanceQ.data.balance) : balanceQ.isError ? "—" : "…"}
          </span>
          {balanceQ.data && balanceQ.data.count > 0 && (
            <span className="text-muted-foreground">
              {" "}
              · {balanceQ.data.count} open invoice{balanceQ.data.count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <AccountStatementButton accountId={accountId} />
      </div>
    </section>
  );
}
