import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  REPLY_NOTIFICATION_TYPE,
  captureInfoReply,
  notifyReplyReceived,
  taskCadenceKey,
  type InfoReplyDeps,
} from "./info-reply.server";

/*
 * Mark, 13 Oct: "...shows that info that should be inputted into the correct
 * fields in the job not as a task". A reply to an info request that carries
 * readable answers files ONE pending suggestion and NO task; a reply with
 * nothing readable files one "Review reply" task; a re-sync files nothing.
 */

type Row = Record<string, unknown>;

/** Just enough of PostgREST: filters are recorded, reads return the table's rows. */
function fakeDb(
  tables: Record<string, Row[]>,
  opts: { insertError?: Record<string, unknown> } = {},
) {
  const inserts: { table: string; row: Row }[] = [];
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        ilike: chain,
        not: chain,
        is: chain,
        gte: chain,
        order: chain,
        limit: chain,
        in: chain,
        eq: chain,
        insert: async (row: Row) => {
          const err = opts.insertError?.[table];
          if (err) return { error: err };
          inserts.push({ table, row });
          (tables[table] ??= []).push(row);
          return { error: null };
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: lookup(table), error: null }),
      });
      return q;
    },
  };
  // Filters are not evaluated: each test seeds only the rows a read should see.
  const lookup = (table: string) => tables[table] ?? [];
  return { db: db as unknown as SupabaseClient, inserts };
}

const REQUEST = {
  id: "req-1",
  job_id: "job-1",
  created_at: "2026-10-12T13:00:00Z",
  created_by: "user-office",
  email_message_id: "em-1",
  recipient_email: "jane@example.com",
};
const BASE: Record<string, Row[]> = {
  intake_requests: [REQUEST],
  jobs: [{ id: "job-1", job_number: "GS-1001", account_id: "acc-1", location_id: "loc-1" }],
  email_messages: [
    {
      id: "em-1",
      job_id: "job-1",
      subject: "Request for information — 12 Main St",
      to_emails: ["jane@example.com"],
      created_at: "2026-10-12T13:00:05Z",
      body_html: "<p>Date of loss:</p><p>Is the power on?</p>",
    },
  ],
  intake_questions: [
    { id: "q-power", prompt: "Is the power on?", answer_type: "yes_no", choices: [] },
  ],
};

const tables = () => JSON.parse(JSON.stringify(BASE)) as Record<string, Row[]>;

const message = (over: Partial<Parameters<typeof captureInfoReply>[0]> = {}) => ({
  messageId: "graph-msg-1",
  from: "Jane@Example.com",
  fromName: "Jane Smith",
  subject: "RE: Request for information — 12 Main St",
  receivedAt: "2026-10-13T15:00:00Z",
  ...over,
});

const deps = (
  db: SupabaseClient,
  body: string,
  over: Partial<InfoReplyDeps> = {},
): InfoReplyDeps => ({
  db,
  fetchBody: vi.fn(async () => ({ contentType: "text", content: body })),
  isAutomated: vi.fn(async () => false),
  aiExtract: null,
  now: () => new Date("2026-10-13T15:05:00Z"),
  ...over,
});

describe("captureInfoReply", () => {
  it("files one pending suggestion with the values and the snippet, and no task", async () => {
    const { db, inserts } = fakeDb(tables());
    const outcome = await captureInfoReply(
      message(),
      deps(db, "Date of loss: 10/3\nPower on: yes\nPhone (732) 555-0142\n\nThanks, Jane"),
    );
    expect(outcome).toBe("suggested");
    // The suggestion, then the notice to whoever asked (13 Oct) — still no task.
    expect(inserts.map((i) => i.table)).toEqual(["intake_submissions", "notifications"]);
    const row = inserts[0]!.row;
    expect(row).toMatchObject({
      request_id: "req-1",
      job_id: "job-1",
      status: "pending",
      source: "email_reply",
      source_message_id: "graph-msg-1",
      submitted_by_email: "jane@example.com",
      submitted_by_name: "Jane Smith",
      fields: { loss_date: "2026-10-03" },
      answers: { "q-power": { bool: true } },
    });
    expect(String(row["source_excerpt"])).toContain("Date of loss: 10/3");
  });

  it("files a single Review reply task, for whoever asked, when nothing could be read", async () => {
    const { db, inserts } = fakeDb(tables());
    const outcome = await captureInfoReply(message(), deps(db, "I'll call you tomorrow about it."));
    expect(outcome).toBe("review_task");
    expect(inserts.map((i) => i.table)).toEqual(["tasks", "notifications"]);
    expect(inserts[0]!.row).toMatchObject({
      job_id: "job-1",
      assignee: "user-office",
      source: "info_reply",
      cadence_key: taskCadenceKey("graph-msg-1"),
      status: "open",
    });
    expect(String(inserts[0]!.row["title"])).toBe("Review reply from Jane Smith (job GS-1001)");
  });

  it("tries the extraction model only when the parser found nothing", async () => {
    const { db, inserts } = fakeDb(tables());
    const aiExtract = vi.fn(async () => ({ fields: { claim_number: "0042117" }, answers: {} }));
    const outcome = await captureInfoReply(
      message(),
      deps(db, "the claim they gave me is 0042117", { aiExtract }),
    );
    expect(aiExtract).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("suggested");
    expect(inserts[0]!.row["fields"]).toEqual({ claim_number: "0042117" });

    const second = fakeDb(tables());
    const unused = vi.fn();
    await captureInfoReply(
      message({ messageId: "graph-msg-2" }),
      deps(second.db, "Claim #: 1", { aiExtract: unused }),
    );
    expect(unused).not.toHaveBeenCalled();
  });

  it("ignores mail from someone we never asked, and replies on another thread", async () => {
    const none = fakeDb({ ...tables(), intake_requests: [] });
    expect(await captureInfoReply(message(), deps(none.db, "Date of loss: 10/3"))).toBe(
      "not_info_reply",
    );
    expect(none.inserts).toEqual([]);

    const t = tables();
    t["email_messages"]!.push({
      id: "em-2",
      job_id: "job-1",
      subject: "Your invoice GS-1001",
      to_emails: ["jane@example.com"],
      created_at: "2026-10-12T18:00:00Z",
    });
    const other = fakeDb(t);
    expect(
      await captureInfoReply(
        message({ subject: "RE: Your invoice GS-1001" }),
        deps(other.db, "Paid! Date of loss: 10/3"),
      ),
    ).toBe("not_info_reply");
    expect(other.inserts).toEqual([]);
  });

  it("skips out-of-office and anything already filed for this message", async () => {
    const ooo = fakeDb(tables());
    expect(
      await captureInfoReply(
        message(),
        deps(ooo.db, "Date of loss: 10/3", { isAutomated: async () => true }),
      ),
    ).toBe("automated");
    expect(ooo.inserts).toEqual([]);

    const t = tables();
    t["intake_submissions"] = [{ id: "s-1", source_message_id: "graph-msg-1" }];
    const again = fakeDb(t);
    expect(await captureInfoReply(message(), deps(again.db, "Date of loss: 10/3"))).toBe(
      "duplicate",
    );
    expect(again.inserts).toEqual([]);
  });

  it("keeps the reply as a task while the suggestion columns are not applied yet", async () => {
    const { db, inserts } = fakeDb(tables(), {
      insertError: {
        intake_submissions: { code: "42703", message: 'column "source" does not exist' },
      },
    });
    const outcome = await captureInfoReply(message(), deps(db, "Date of loss: 10/3"));
    expect(outcome).toBe("review_task");
    expect(inserts.map((i) => i.table)).toEqual(["tasks", "notifications"]);
  });
});

/*
 * David, 13 Oct: when a customer replies to a job email he wants to be told.
 * The person who sent the request gets a notice in the bell, linking to the
 * job, whichever way the reply was filed.
 */
describe("a reply notifies whoever asked", () => {
  it("names the sender, the job and how many updates wait, and links to the job", async () => {
    const { db, inserts } = fakeDb(tables());
    await captureInfoReply(
      message(),
      deps(db, "Date of loss: 10/3\nPower on: yes\n\nThanks, Jane"),
    );
    const notice = inserts.find((i) => i.table === "notifications")!.row;
    expect(notice).toMatchObject({
      user_id: "user-office",
      type: REPLY_NOTIFICATION_TYPE,
      priority: "high",
      title: "Jane Smith replied on job GS-1001",
      entity_type: "job",
      entity_id: "job-1",
      href: "/jobs/job-1",
    });
    expect(String(notice["body"])).toMatch(/2 suggested updates to review/);
    expect(String(notice["body"])).toMatch(/the rest stay waiting/);
  });

  it("points at the Review reply task when nothing could be read", async () => {
    const { db, inserts } = fakeDb(tables());
    await captureInfoReply(message(), deps(db, "I'll call you tomorrow about it."));
    const notice = inserts.find((i) => i.table === "notifications")!.row;
    expect(String(notice["body"])).toMatch(/Review reply/);
  });

  it("files nothing twice: a re-synced reply sends no second notice", async () => {
    const t = tables();
    const first = fakeDb(t);
    await captureInfoReply(message(), deps(first.db, "I'll call you tomorrow about it."));
    const again = fakeDb(t);
    expect(
      await captureInfoReply(message(), deps(again.db, "I'll call you tomorrow about it.")),
    ).toBe("duplicate");
    expect(again.inserts).toEqual([]);
  });

  /** A notifications table that refuses the first type it is given. */
  function refusingDb(code: string) {
    const rows: Row[] = [];
    let calls = 0;
    const db = {
      from: () => ({
        insert: async (row: Row) => {
          calls += 1;
          if (calls === 1) return { error: { code, message: "refused" } };
          rows.push(row);
          return { error: null };
        },
      }),
    } as unknown as SupabaseClient;
    return { db, rows };
  }

  it("still notifies, as an automation notice, before its own type is migrated", async () => {
    const { db, rows } = refusingDb("22P02");
    expect(
      await notifyReplyReceived(db, {
        userId: "u1",
        jobId: "j1",
        jobNumber: null,
        who: "Jane",
        items: 1,
      }),
    ).toBe(true);
    expect(rows[0]).toMatchObject({ type: "automation_task", title: "Jane replied on a job" });
  });

  it("never throws — the reply is already filed", async () => {
    const { db } = refusingDb("42501");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      notifyReplyReceived(db, {
        userId: "u1",
        jobId: "j1",
        jobNumber: "GS-1",
        who: "Jane",
        items: 0,
      }),
    ).resolves.toBe(false);
    spy.mockRestore();
  });

  it("notifies nobody when the request has no author", async () => {
    const { db, rows } = refusingDb("22P02");
    expect(
      await notifyReplyReceived(db, {
        userId: null,
        jobId: "j1",
        jobNumber: null,
        who: "Jane",
        items: 1,
      }),
    ).toBe(false);
    expect(rows).toEqual([]);
  });
});
