/**
 * The invoice follow-up sweep — run by the every-15-minutes automations hook
 * (run-automations), with the service role, so a reminder goes whether or not
 * anybody has the app open. Decisions are in invoice-followups.ts; this file
 * reads, claims each (invoice, rule, step) exactly once, and writes.
 *
 * Every reminder is an ordinary outbound email: an email_messages row,
 * status 'held' with the admin's send delay (at least a minute), on the job
 * and the invoice — so it is on the job's Communications tab and timeline,
 * can be cancelled in its window, and leaves through the same transport seam
 * as every other email (email-release → deliverEmailMessage). Nothing here
 * sends. With no client email on file, the office gets a task and a
 * notification instead of the reminder silently not happening.
 */
import { DEFAULT_SEND_DELAY_MINUTES, EMAIL_SEND_SETTINGS_KEY, parseSendDelay } from "./email-hold";
import { renderEmailTemplate, type EmailTemplateKey, isEmailTemplateKey } from "./email-templates";
import {
  FOLLOWUP_STATUSES,
  balanceDue,
  dueFollowup,
  followupRecipients,
  isFollowupEmail,
  normalizeSteps,
  sendTimeBlock,
  type FiredFollowup,
  type FollowupInvoice,
  type FollowupRule,
} from "./invoice-followups";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
type Db = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];
// The follow-up tables are newer than the generated types.
const t = (db: Db) => db as unknown as import("@supabase/supabase-js").SupabaseClient;

const usd = (n: number | null | undefined) =>
  n == null ? "" : Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });

type InvoiceRow = FollowupInvoice & {
  invoice_number: string;
  job_id: string | null;
  account_id: string | null;
  customer_name: string | null;
  due_date: string | null;
  adjuster_email: string | null;
};

export type FollowupSweepResult = {
  invoices: number;
  emailed: number;
  notified: number;
  skipped: number;
  errors: string[];
};

export async function runInvoiceFollowupSweep(
  db: Db,
  now: Date = new Date(),
): Promise<FollowupSweepResult> {
  const result: FollowupSweepResult = {
    invoices: 0,
    emailed: 0,
    notified: 0,
    skipped: 0,
    errors: [],
  };
  const sdb = t(db);

  const { data: ruleRows, error: rulesErr } = await sdb
    .from("invoice_followup_rules")
    .select("id, name, location_id, is_active, steps")
    .eq("is_active", true);
  if (rulesErr) {
    // Before 20261022160000 there are no rules to run: nothing to do.
    if (/does not exist|schema cache/i.test(rulesErr.message)) return result;
    throw rulesErr;
  }
  const rules = ((ruleRows ?? []) as FollowupRule[]).map((r) => ({
    ...r,
    steps: normalizeSteps(r.steps),
  }));
  if (!rules.length) return result;

  // Only invoices that could be due: sent / part paid, not switched off.
  const { data: invRows, error: invErr } = await sdb
    .from("invoices")
    .select(
      "id, invoice_number, status, sent_at, issue_date, total, billed_amount, collected_amount, location_id, job_id, account_id, customer_name, due_date, adjuster_email, followup_mode, followup_rule_id",
    )
    .in("status", FOLLOWUP_STATUSES as string[])
    .neq("followup_mode", "off")
    .limit(2000);
  if (invErr) throw invErr;
  const invoices = (invRows ?? []) as InvoiceRow[];
  result.invoices = invoices.length;
  if (!invoices.length) return result;

  const ids = invoices.map((i) => i.id);
  const jobIds = [...new Set(invoices.map((i) => i.job_id).filter(Boolean))] as string[];
  const [{ data: firedRows }, { data: jobs }, { data: settings }, { data: templates }] =
    await Promise.all([
      sdb
        .from("invoice_followups")
        .select("invoice_id, rule_key, step_index")
        .in("invoice_id", ids),
      jobIds.length
        ? db.from("jobs").select("id, address, account_id, bill_to_account_id").in("id", jobIds)
        : Promise.resolve({
            data: [] as {
              id: string;
              address: string;
              account_id: string | null;
              bill_to_account_id: string | null;
            }[],
          }),
      db.from("app_settings").select("value").eq("key", EMAIL_SEND_SETTINGS_KEY).maybeSingle(),
      db
        .from("email_templates")
        .select("key, subject, body, is_active, location_id")
        .like("key", "invoice_followup%"),
    ]);
  const firedBy = new Map<string, FiredFollowup[]>();
  for (const f of (firedRows ?? []) as (FiredFollowup & { invoice_id: string })[]) {
    firedBy.set(f.invoice_id, [...(firedBy.get(f.invoice_id) ?? []), f]);
  }
  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));
  const accountIds = [
    ...new Set(
      invoices.flatMap((i) => {
        const j = i.job_id ? jobById.get(i.job_id) : null;
        return [i.account_id, j?.account_id, j?.bill_to_account_id];
      }),
    ),
  ].filter(Boolean) as string[];
  const { data: accounts } = accountIds.length
    ? await sdb.from("accounts").select("id, email, no_auto_followups").in("id", accountIds)
    : { data: [] };
  const accountById = new Map(
    (
      (accounts ?? []) as { id: string; email: string | null; no_auto_followups: boolean | null }[]
    ).map((a) => [a.id, a]),
  );
  const delayMinutes = Math.max(
    1,
    settings ? parseSendDelay(settings.value) : DEFAULT_SEND_DELAY_MINUTES,
  );

  for (const inv of invoices) {
    try {
      const job = inv.job_id ? jobById.get(inv.job_id) : undefined;
      const clientIds = [inv.account_id, job?.account_id, job?.bill_to_account_id].filter(
        Boolean,
      ) as string[];
      const exempt = clientIds.some((id) => accountById.get(id)?.no_auto_followups === true);
      const decision = dueFollowup({
        invoice: inv,
        rules,
        exempt,
        fired: firedBy.get(inv.id) ?? [],
        now,
      });
      if (!decision.act) continue;

      // Earlier steps that came due at the same time: recorded, not sent.
      for (const i of decision.skip) {
        const s = normalizeSteps(decision.rule.steps)[i]!;
        const { error } = await sdb.from("invoice_followups").insert({
          invoice_id: inv.id,
          rule_id: decision.rule.id,
          rule_key: decision.rule.id,
          step_index: i,
          days: s.days,
          template_key: s.template_key,
          outcome: "skipped",
          reason: `A later reminder (day ${decision.step.days}) was due at the same time.`,
        });
        if (!error) result.skipped += 1;
      }

      // CLAIM FIRST: the UNIQUE (invoice, rule, step) row is the lock, so a
      // step fires once however many sweeps overlap.
      const { data: claim, error: claimErr } = await sdb
        .from("invoice_followups")
        .insert({
          invoice_id: inv.id,
          rule_id: decision.rule.id,
          rule_key: decision.rule.id,
          step_index: decision.stepIndex,
          days: decision.step.days,
          template_key: decision.step.template_key,
          outcome: "emailed",
          scheduled_by: "sweep",
          reason: `${decision.daysSinceSent} days since sent; rule “${decision.rule.name}”, step ${decision.stepIndex + 1}.`,
        })
        .select("id")
        .single();
      if (claimErr) {
        if ((claimErr as { code?: string }).code === "23505") continue;
        throw claimErr;
      }
      const claimId = (claim as { id: string }).id;

      try {
        const { data: contacts } = inv.job_id
          ? await db
              .from("job_contacts")
              .select("email, is_default_contact")
              .eq("job_id", inv.job_id)
          : { data: [] };
        const billTo = job?.bill_to_account_id
          ? accountById.get(job.bill_to_account_id)
          : undefined;
        const client = inv.account_id ? accountById.get(inv.account_id) : undefined;
        const to = followupRecipients({
          adjusterEmail: inv.adjuster_email,
          billToEmail: billTo?.email ?? client?.email ?? null,
          jobContacts: contacts ?? [],
        });

        if (!to.length) {
          await notifyOffice(db, sdb, inv, claimId, decision.daysSinceSent);
          result.notified += 1;
          continue;
        }

        const { data: office } = inv.location_id
          ? await db
              .from("locations")
              .select("name, legal_entity_name, office_phone, card_payment_url")
              .eq("id", inv.location_id)
              .maybeSingle()
          : { data: null };
        const key = decision.step.template_key;
        const own = (templates ?? []).filter(
          (x) => x.key === key && x.location_id === inv.location_id,
        );
        const shared = (templates ?? []).filter((x) => x.key === key && !x.location_id);
        const engineKey: EmailTemplateKey = isEmailTemplateKey(key) ? key : "invoice_followup_1";
        const rendered = renderEmailTemplate(
          engineKey,
          {
            customer_name: inv.customer_name,
            invoice_number: inv.invoice_number,
            amount: usd(inv.total ?? inv.billed_amount),
            balance_remaining: usd(balanceDue(inv)),
            due_date: inv.due_date
              ? new Date(`${inv.due_date}T12:00:00`).toLocaleDateString(DATE_LOCALE, US_DATE)
              : null,
            days_since_sent: decision.daysSinceSent,
            job_address: job?.address ?? null,
            payment_link:
              (office as { card_payment_url?: string | null } | null)?.card_payment_url ?? null,
            company_name:
              (
                office as { legal_entity_name?: string | null; name?: string } | null
              )?.legal_entity_name?.trim() ||
              (office as { name?: string } | null)?.name ||
              "Gold Star Restoration",
            company_phone:
              (office as { office_phone?: string | null } | null)?.office_phone ?? null,
          },
          own.length ? own : shared,
        );
        if (!rendered.isActive) {
          await sdb
            .from("invoice_followups")
            .update({
              outcome: "cancelled",
              cancelled_at: now.toISOString(),
              cancel_reason: `The template ${key} is switched off in Admin → Email templates.`,
            })
            .eq("id", claimId);
          continue;
        }

        const { data: email, error: emailErr } = await db
          .from("email_messages")
          .insert({
            job_id: inv.job_id,
            invoice_id: inv.id,
            account_id: inv.account_id,
            location_id: inv.location_id,
            template_key: key,
            category: "reminder",
            to_emails: to,
            cc_emails: [],
            subject: rendered.subject,
            body_html: rendered.body,
            status: "held",
            release_at: new Date(now.getTime() + delayMinutes * 60_000).toISOString(),
            sent_by: null,
          } as never)
          .select("id")
          .single();
        if (emailErr) throw emailErr;
        await sdb
          .from("invoice_followups")
          .update({ email_message_id: (email as { id: string }).id, to_emails: to })
          .eq("id", claimId);
        result.emailed += 1;
      } catch (err) {
        // Release the claim so the next sweep retries rather than believing
        // this step went.
        await sdb.from("invoice_followups").delete().eq("id", claimId);
        throw err;
      }
    } catch (err) {
      result.errors.push(
        `${inv.invoice_number}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

/** No client email on file: a task and a notification for the office. */
async function notifyOffice(
  db: Db,
  sdb: ReturnType<typeof t>,
  inv: InvoiceRow,
  claimId: string,
  days: number,
) {
  const { data: managers } = inv.location_id
    ? await db
        .from("location_members")
        .select("user_id, created_at")
        .eq("location_id", inv.location_id)
        .eq("role", "manager")
        .order("created_at")
    : { data: [] };
  const people = [...new Set((managers ?? []).map((m) => m.user_id))];
  const title = `Follow up by hand: invoice ${inv.invoice_number} is ${days} days unpaid — no client email on file`;
  const { data: task } = await db
    .from("tasks")
    .insert({
      title,
      description:
        "The automated reminder could not be emailed: there is no email for the client, the bill-to company or the job's contacts. Call them, or add an email and the next reminder will go.",
      assignee: people[0] ?? null,
      due_date: new Date().toISOString().slice(0, 10),
      priority: "normal",
      status: "open",
      entity_type: "job",
      entity_id: inv.job_id,
      job_id: inv.job_id,
      account_id: inv.account_id,
      location_id: inv.location_id,
      source: "automation",
    } as never)
    .select("id")
    .single();
  for (const userId of people) {
    await db.from("notifications").insert({
      user_id: userId,
      type: "automation_task",
      title,
      body: "No client email on file for the automated invoice reminder.",
      entity_type: "job",
      entity_id: inv.job_id,
      href: inv.job_id ? `/jobs/${inv.job_id}?tab=billing` : "/billing",
      priority: "normal",
    } as never);
  }
  await sdb
    .from("invoice_followups")
    .update({
      outcome: "notified",
      task_id: (task as { id: string } | null)?.id ?? null,
      reason: "No client email on file — the office was asked to follow up by hand.",
    })
    .eq("id", claimId);
}

/**
 * The send-time check, called by deliverEmailMessage for every automated
 * reminder just before it leaves: the invoice and the client as they are NOW.
 * Returns why it must not go (and has cancelled it), or null to send.
 */
export async function blockFollowupAtSend(
  db: Db,
  row: { id: string; template_key?: string | null; invoice_id?: string | null },
): Promise<string | null> {
  if (!isFollowupEmail(row.template_key) || !row.invoice_id) return null;
  const sdb = t(db);
  const { data: inv } = await sdb
    .from("invoices")
    .select("id, status, followup_mode, total, billed_amount, collected_amount, account_id, job_id")
    .eq("id", row.invoice_id)
    .maybeSingle();
  const invoice = inv as
    | (Pick<
        FollowupInvoice,
        "status" | "followup_mode" | "total" | "billed_amount" | "collected_amount"
      > & {
        account_id: string | null;
        job_id: string | null;
      })
    | null;
  let exempt = false;
  if (invoice) {
    const { data: job } = invoice.job_id
      ? await db
          .from("jobs")
          .select("account_id, bill_to_account_id")
          .eq("id", invoice.job_id)
          .maybeSingle()
      : { data: null };
    const ids = [invoice.account_id, job?.account_id, job?.bill_to_account_id].filter(
      Boolean,
    ) as string[];
    if (ids.length) {
      const { data: accts } = await sdb.from("accounts").select("no_auto_followups").in("id", ids);
      exempt = ((accts ?? []) as { no_auto_followups: boolean | null }[]).some(
        (a) => a.no_auto_followups === true,
      );
    }
  }
  const reason = sendTimeBlock({ invoice, exempt });
  if (!reason) return null;
  await db
    .from("email_messages")
    .update({ status: "cancelled", error: `Not sent: ${reason}` } as never)
    .eq("id", row.id);
  await sdb
    .from("invoice_followups")
    .update({ outcome: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: reason })
    .eq("email_message_id", row.id);
  return reason;
}
