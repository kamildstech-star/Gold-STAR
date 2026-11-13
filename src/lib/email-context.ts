/**
 * Email context sidebar — data layer.
 *
 * Everything the panel shows is a real relationship: a participant is a row in
 * `contacts` matched on the address that actually appeared in the message
 * headers, a role is the row in `job_contacts` for that person on that job, the
 * next activity is an open task on the linked record, and the linked record is
 * the account/job the sync (or a rep) attached to the thread.
 *
 * When an address matches nothing, we say so and offer to add it — a thread
 * from an unknown person is the cheapest contact the database will ever get.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type CapturedComm = Database["public"]["Tables"]["captured_communications"]["Row"];
export type ContactMethod = Database["public"]["Tables"]["contact_methods"]["Row"];

export type Participant = {
  /** Lower-cased address — the identity key for a participant. */
  address: string;
  /** Display name from the message headers, when the header carried one. */
  headerName: string | null;
  /** Set when the address matched a contact the signed-in user can see. */
  contact: {
    id: string;
    full_name: string;
    email: string | null;
    title: string | null;
    account_id: string | null;
    account_name: string | null;
    methods: ContactMethod[];
  } | null;
  /** Role on the linked record, from the job_contact_role option list. */
  roleKey: string | null;
  roleLabel: string | null;
};

export type NextActivity = {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null;
  status: string;
  source: string;
  priority: string;
};

export type LinkedRecord =
  | {
      kind: "account";
      id: string;
      name: string;
      value: number | null;
      ownerName: string | null;
      orgName: string | null;
      accountId: string;
      pipelineId: string | null;
      stageId: string | null;
      healthPipelineId: string | null;
      healthStageId: string | null;
    }
  | {
      kind: "job";
      id: string;
      name: string;
      value: number | null;
      ownerName: string | null;
      orgName: string | null;
      accountId: string | null;
      pipelineId: null;
      stageId: null;
      healthPipelineId: null;
      healthStageId: null;
      status: string;
    };

export type EmailContext = {
  participants: Participant[];
  next: NextActivity | null;
  linked: LinkedRecord | null;
};

/** "Someone <a@b.com>" / "a@b.com" → { name, address }. */
export function parseAddress(raw: string): { name: string | null; address: string } | null {
  const s = raw.trim();
  if (!s) return null;
  const angled = s.match(/^(.*)<([^>]+)>$/);
  if (angled) {
    const name = angled[1]!.trim().replace(/^["']|["']$/g, "");
    return { name: name || null, address: angled[2]!.trim().toLowerCase() };
  }
  if (!s.includes("@")) return null;
  return { name: null, address: s.toLowerCase() };
}

/** Collect every distinct address across a thread, in first-seen order. */
export function threadAddresses(messages: CapturedComm[]) {
  const out = new Map<string, string | null>();
  for (const m of messages) {
    for (const raw of [m.from_address, m.to_address]) {
      if (!raw) continue;
      for (const part of raw.split(/[;,]/)) {
        const parsed = parseAddress(part);
        if (!parsed) continue;
        if (!out.has(parsed.address)) out.set(parsed.address, parsed.name);
        else if (!out.get(parsed.address) && parsed.name) out.set(parsed.address, parsed.name);
      }
    }
  }
  return [...out.entries()].map(([address, headerName]) => ({ address, headerName }));
}

export async function fetchJobContactRoles() {
  const { data, error } = await supabase
    .from("option_list_values")
    .select("key,label,sort_order,active,option_lists!inner(key)")
    .eq("option_lists.key", "job_contact_role")
    .eq("active", true)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []).map((r) => ({ key: r.key, label: r.label }));
}

export async function fetchEmailContext(opts: {
  messages: CapturedComm[];
  accountId: string | null;
  jobId: string | null;
}): Promise<EmailContext> {
  const addrs = threadAddresses(opts.messages);
  const lowered = addrs.map((a) => a.address);

  const [contactsRes, roleValues] = await Promise.all([
    lowered.length
      ? supabase
          .from("contacts")
          .select(
            "id,full_name,email,title,account_id,accounts(name),contact_methods(id,contact_id,kind,label,value,extension,is_preferred,is_demo,created_by,created_at,updated_at)",
          )
          .in("email", lowered)
      : Promise.resolve({ data: [], error: null } as const),
    fetchJobContactRoles(),
  ]);
  if (contactsRes.error) throw contactsRes.error;

  const byEmail = new Map<string, (typeof contactsRes.data)[number]>();
  for (const c of contactsRes.data ?? []) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
  }

  // Role on the record: job_contacts is the explicit statement of who someone
  // is on this job. Fall back to nothing rather than guessing.
  const roleByContact = new Map<string, string>();
  const roleByEmail = new Map<string, string>();
  if (opts.jobId) {
    const { data } = await supabase
      .from("job_contacts")
      .select("contact_id,email,role")
      .eq("job_id", opts.jobId);
    for (const r of data ?? []) {
      if (r.contact_id) roleByContact.set(r.contact_id, r.role);
      if (r.email) roleByEmail.set(r.email.toLowerCase(), r.role);
    }
  }
  const roleLabel = (key: string | null) =>
    key ? (roleValues.find((v) => v.key === key)?.label ?? key.replace(/_/g, " ")) : null;

  const participants: Participant[] = addrs.map(({ address, headerName }) => {
    const c = byEmail.get(address);
    const rKey = (c ? roleByContact.get(c.id) : undefined) ?? roleByEmail.get(address) ?? null;
    return {
      address,
      headerName,
      contact: c
        ? {
            id: c.id,
            full_name: c.full_name,
            email: c.email,
            title: c.title,
            account_id: c.account_id,
            account_name: (c.accounts as { name: string } | null)?.name ?? null,
            methods: ((c.contact_methods ?? []) as ContactMethod[])
              .filter((m) => m.kind === "phone")
              .sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred)),
          }
        : null,
      roleKey: rKey,
      roleLabel: roleLabel(rKey),
    };
  });

  const [linked, next] = await Promise.all([
    fetchLinkedRecord(opts.accountId, opts.jobId),
    fetchNextActivity(opts.accountId, opts.jobId),
  ]);

  return { participants, next, linked };
}

export async function fetchNextActivity(
  accountId: string | null,
  jobId: string | null,
): Promise<NextActivity | null> {
  if (!accountId && !jobId) return null;
  let q = supabase
    .from("tasks")
    .select("id,title,due_date,due_time,status,source,priority")
    .eq("status", "open")
    .order("due_date", { ascending: true, nullsFirst: false })
    .limit(1);
  q = jobId ? q.eq("job_id", jobId) : q.eq("account_id", accountId!);
  const { data, error } = await q;
  if (error) throw error;
  return (data?.[0] as NextActivity | undefined) ?? null;
}

export async function fetchLinkedRecord(
  accountId: string | null,
  jobId: string | null,
): Promise<LinkedRecord | null> {
  if (jobId) {
    const { data } = await supabase
      .from("jobs")
      .select(
        "id,job_number,job_name,status,account_id,estimated_amount,accounts!jobs_account_id_fkey(name)",
      )
      .eq("id", jobId)
      .maybeSingle();
    if (!data) return null;
    return {
      kind: "job",
      id: data.id,
      name: data.job_name ? `${data.job_number} · ${data.job_name}` : data.job_number,
      value: data.estimated_amount,
      ownerName: null,
      orgName: (data.accounts as { name: string } | null)?.name ?? null,
      accountId: data.account_id,
      pipelineId: null,
      stageId: null,
      healthPipelineId: null,
      healthStageId: null,
      status: data.status,
    };
  }
  if (!accountId) return null;
  const { data } = await supabase
    .from("accounts")
    .select(
      "id,name,estimated_annual_value,assigned_rep,pipeline_id,stage_id,health_pipeline_id,health_stage_id,profiles!accounts_assigned_rep_profiles_fkey(full_name)",
    )
    .eq("id", accountId)
    .maybeSingle();
  if (!data) return null;
  const owner = data.profiles as { full_name: string } | null;
  return {
    kind: "account",
    id: data.id,
    name: data.name,
    value: data.estimated_annual_value,
    ownerName: owner?.full_name ?? null,
    orgName: data.name,
    accountId: data.id,
    pipelineId: data.pipeline_id,
    stageId: data.stage_id,
    healthPipelineId: data.health_pipeline_id,
    healthStageId: data.health_stage_id,
  };
}

/** Attach (or detach) every message in a thread to a record, in one action. */
export async function setThreadLink(
  messageIds: string[],
  link: { accountId: string | null; jobId: string | null; contactId?: string | null },
) {
  if (!messageIds.length) return;
  const { error } = await supabase
    .from("captured_communications")
    .update({
      account_id: link.accountId,
      contact_id: link.contactId ?? null,
    })
    .in("id", messageIds);
  if (error) throw error;
}

export function isOverdue(due: string | null): boolean {
  if (!due) return false;
  const today = new Date().toISOString().slice(0, 10);
  return due < today;
}

export function initialsOf(name: string | null, address: string) {
  const base = (name ?? address.split("@")[0] ?? "").replace(/[._-]+/g, " ").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  if (!parts.length) return address.slice(0, 2).toUpperCase();
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** "561-221-0900 ext.114 (Work)" */
export function formatMethod(m: ContactMethod) {
  const ext = m.extension ? ` ext.${m.extension}` : "";
  const label = m.label ? ` (${m.label})` : "";
  return `${m.value}${ext}${label}`;
}

export function telHref(m: ContactMethod) {
  const digits = m.value.replace(/[^\d+]/g, "");
  return `tel:${digits}${m.extension ? `,${m.extension.replace(/\D/g, "")}` : ""}`;
}
