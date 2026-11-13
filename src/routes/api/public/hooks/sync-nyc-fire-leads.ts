import { createFileRoute } from "@tanstack/react-router";

import { denyUnlessCron } from "@/lib/cron-auth";
import type { Json } from "@/integrations/supabase/types";

// NYC HPD fire-vacate lead sync.
// Full pull from Socrata every run — rescinds and status flips only show
// up on a full compare. Idempotent via unique (source_system, source_record_id).

const SOURCE_SYSTEM = "nyc_hpd_vacate";
const JURISDICTION = "NYC";

const HPD_VACATE_URL = "https://data.cityofnewyork.us/resource/tb8q-a3ar.json";
const HPD_REGISTRATION_CONTACTS_URL = "https://data.cityofnewyork.us/resource/feu5-w2e2.json";

const BORO_MAP: Record<string, string> = {
  MN: "Manhattan",
  BX: "Bronx",
  BK: "Brooklyn",
  QN: "Queens",
  SI: "Staten Island",
};

const OWNER_PRIORITY = [
  "CorporateOwner",
  "IndividualOwner",
  "HeadOfficer",
  "Agent",
  "Officer",
  "SiteManager",
  "Shareholder",
];

type VacateRow = {
  vacate_order_number?: string;
  vacate_effective_date?: string;
  actual_rescind_date?: string | null;
  house_number?: string;
  street_name?: string;
  boro_short_name?: string;
  postoce?: string;
  nta?: string;
  latitude?: string;
  longitude?: string;
  number_of_vacated_units?: string;
  vacate_type?: string;
  bbl?: string;
  bin?: string;
  building_id?: string;
  registration_id?: string;
  community_board?: string;
  council_district?: string;
  primary_vacate_reason?: string;
};

type ContactRow = {
  registrationid?: string;
  type?: string;
  corporationname?: string;
  firstname?: string;
  middleinitial?: string;
  lastname?: string;
  businesshousenumber?: string;
  businessstreetname?: string;
  businessapartment?: string;
  businesscity?: string;
  businessstate?: string;
  businesszip?: string;
};

type NormalizedLead = {
  source_system: string;
  source_record_id: string;
  jurisdiction: string;
  incident_date: string | null;
  address: string | null;
  locality: string | null;
  region: string;
  postal_code: string | null;
  neighborhood: string | null;
  lat: number | null;
  lon: number | null;
  units_vacated: number | null;
  vacate_type: string | null;
  status: "open" | "rescinded";
  rescind_date: string | null;
  source_ref: Json;
  owner_name: string | null;
  owner_role: string | null;
  owner_mailing_address: string | null;
  agent_name: string | null;
  agent_mailing_address: string | null;
  _registration_id: string | null;
};

function trimOrNull(v: string | undefined | null): string | null {
  if (v === undefined || v === null) return null;
  const t = String(v).trim();
  return t.length ? t : null;
}

function parseFloatOrNull(v: string | undefined | null): number | null {
  if (!v) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseIntOrNull(v: string | undefined | null): number | null {
  if (!v) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function toDate(v: string | undefined | null): string | null {
  const t = trimOrNull(v);
  if (!t) return null;
  return t.slice(0, 10);
}

function normalize(row: VacateRow): NormalizedLead | null {
  const orderNumber = trimOrNull(row.vacate_order_number);
  if (!orderNumber) return null;

  const house = trimOrNull(row.house_number);
  const street = trimOrNull(row.street_name);
  const address = [house, street].filter(Boolean).join(" ") || null;
  const borough = row.boro_short_name
    ? (BORO_MAP[row.boro_short_name.toUpperCase()] ?? row.boro_short_name)
    : null;

  const rescind = toDate(row.actual_rescind_date);

  return {
    source_system: SOURCE_SYSTEM,
    source_record_id: orderNumber,
    jurisdiction: JURISDICTION,
    incident_date: toDate(row.vacate_effective_date),
    address,
    locality: borough,
    region: "NY",
    postal_code: trimOrNull(row.postoce),
    neighborhood: trimOrNull(row.nta),
    lat: parseFloatOrNull(row.latitude),
    lon: parseFloatOrNull(row.longitude),
    units_vacated: parseIntOrNull(row.number_of_vacated_units),
    vacate_type: trimOrNull(row.vacate_type),
    status: rescind ? "rescinded" : "open",
    rescind_date: rescind,
    source_ref: {
      bbl: trimOrNull(row.bbl),
      bin: trimOrNull(row.bin),
      building_id: trimOrNull(row.building_id),
      registration_id: trimOrNull(row.registration_id),
      community_board: trimOrNull(row.community_board),
      council_district: trimOrNull(row.council_district),
      primary_vacate_reason: trimOrNull(row.primary_vacate_reason),
    },
    owner_name: null,
    owner_role: null,
    owner_mailing_address: null,
    agent_name: null,
    agent_mailing_address: null,
    _registration_id: trimOrNull(row.registration_id),
  };
}

function formatContactName(c: ContactRow): string | null {
  const corp = trimOrNull(c.corporationname);
  if (corp) return corp;
  const parts = [c.firstname, c.middleinitial, c.lastname]
    .map((p) => trimOrNull(p))
    .filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function formatMailingAddress(c: ContactRow): string | null {
  const line1 = [c.businesshousenumber, c.businessstreetname]
    .map((p) => trimOrNull(p))
    .filter(Boolean)
    .join(" ");
  const apt = trimOrNull(c.businessapartment);
  const cityStateZip = [
    trimOrNull(c.businesscity),
    trimOrNull(c.businessstate),
    trimOrNull(c.businesszip),
  ]
    .filter(Boolean)
    .join(", ");
  const parts = [line1, apt ? `Apt ${apt}` : null, cityStateZip].filter((p): p is string =>
    Boolean(p && p.length),
  );
  return parts.length ? parts.join(", ") : null;
}

async function fetchAllVacateOrders(): Promise<VacateRow[]> {
  const limit = 1000;
  let offset = 0;
  const out: VacateRow[] = [];
  // Socrata caps at 50k rows; fire orders are ~1.7k open + historical, well under.
  for (let page = 0; page < 100; page++) {
    const url = `${HPD_VACATE_URL}?$where=${encodeURIComponent(
      "primary_vacate_reason like '%Fire%'",
    )}&$limit=${limit}&$offset=${offset}&$order=vacate_order_number`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HPD vacate fetch failed ${res.status}: ${await res.text()}`);
    }
    const page_rows = (await res.json()) as VacateRow[];
    out.push(...page_rows);
    if (page_rows.length < limit) break;
    offset += limit;
  }
  return out;
}

async function fetchOwnersByRegistrationIds(regIds: string[]): Promise<Map<string, ContactRow[]>> {
  const map = new Map<string, ContactRow[]>();
  const chunk = 100;
  for (let i = 0; i < regIds.length; i += chunk) {
    const slice = regIds.slice(i, i + chunk);
    const quoted = slice.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    const url = `${HPD_REGISTRATION_CONTACTS_URL}?$where=${encodeURIComponent(
      `registrationid in (${quoted})`,
    )}&$limit=50000`;
    const res = await fetch(url);
    if (!res.ok) {
      // Don't fail the sync; owner enrichment is best-effort.
      console.warn(
        `[sync-nyc] contacts fetch failed ${res.status} for chunk starting ${i}: ${await res
          .text()
          .catch(() => "")}`,
      );
      continue;
    }
    const rows = (await res.json()) as ContactRow[];
    for (const r of rows) {
      const key = r.registrationid;
      if (!key) continue;
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    }
  }
  return map;
}

function pickOwnerAndAgent(contacts: ContactRow[]) {
  const byType = new Map<string, ContactRow[]>();
  for (const c of contacts) {
    const t = trimOrNull(c.type);
    if (!t) continue;
    const list = byType.get(t) ?? [];
    list.push(c);
    byType.set(t, list);
  }
  let owner: ContactRow | null = null;
  let ownerRole: string | null = null;
  for (const role of OWNER_PRIORITY) {
    const list = byType.get(role);
    if (list && list.length) {
      owner = list[0];
      ownerRole = role;
      break;
    }
  }
  const agent = (byType.get("Agent") ?? [])[0] ?? null;
  return { owner, ownerRole, agent };
}

export const Route = createFileRoute("/api/public/hooks/sync-nyc-fire-leads")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        /*
         * This runs a full HPD ingest under the service role. Without a check
         * anyone who knew the URL could loop it: dozens of Socrata calls from
         * our IP per request, thousands of upserts, and the open-data quota
         * burned. Matches the guard the other cron hooks use.
         */
        const denied = denyUnlessCron(request);
        if (denied) return denied;

        /* After the credential check, never before: a database round trip per
           anonymous request would be the amplification the limiter exists to
           stop. Volumetric floods belong to Cloudflare WAF. */
        const { throttleWebhook } = await import("@/lib/rate-limit.server");
        const throttled = await throttleWebhook(request, "sync-nyc-fire-leads", true);
        if (throttled) return throttled;

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const run = await supabaseAdmin
          .from("sync_runs")
          .insert({ source_system: SOURCE_SYSTEM })
          .select("id")
          .single();
        if (run.error || !run.data) {
          return new Response(
            JSON.stringify({ error: "failed to open sync_run", detail: run.error }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        const runId = run.data.id;
        const errors: Json[] = [];

        try {
          const rawRows = await fetchAllVacateOrders();
          const normalized: NormalizedLead[] = [];
          for (const r of rawRows) {
            const n = normalize(r);
            if (n) normalized.push(n);
          }

          // Owner enrichment
          const regIds = Array.from(
            new Set(
              normalized.map((n) => n._registration_id).filter((v): v is string => Boolean(v)),
            ),
          );
          let ownerMap: Map<string, ContactRow[]> = new Map();
          try {
            ownerMap = await fetchOwnersByRegistrationIds(regIds);
          } catch (e) {
            errors.push({ stage: "owner_fetch", error: String(e) });
          }

          let ownerMatchCount = 0;
          for (const n of normalized) {
            if (!n._registration_id) continue;
            const contacts = ownerMap.get(n._registration_id);
            if (!contacts || !contacts.length) continue;
            const { owner, ownerRole, agent } = pickOwnerAndAgent(contacts);
            if (owner) {
              n.owner_name = formatContactName(owner);
              n.owner_role = ownerRole;
              n.owner_mailing_address = formatMailingAddress(owner);
            }
            if (agent) {
              n.agent_name = formatContactName(agent);
              n.agent_mailing_address = formatMailingAddress(agent);
            }
            if (n.owner_name || n.agent_name) ownerMatchCount++;
          }

          // Snapshot existing natural keys so we can count genuinely new rows
          // and emit new_lead events only for them.
          const naturalKeys = normalized.map((n) => n.source_record_id);
          const existingKeys = new Set<string>();
          const chunk = 500;
          for (let i = 0; i < naturalKeys.length; i += chunk) {
            const slice = naturalKeys.slice(i, i + chunk);
            const { data, error } = await supabaseAdmin
              .from("fire_leads")
              .select("source_record_id")
              .eq("source_system", SOURCE_SYSTEM)
              .in("source_record_id", slice);
            if (error) throw new Error(`existing lookup: ${error.message}`);
            for (const row of data ?? []) existingKeys.add(row.source_record_id);
          }

          // Upsert in batches. SOURCE columns only — the app owns CRM columns.
          const syncedAt = new Date().toISOString();
          let upserted = 0;
          const newLeadIds: { id: string; source_record_id: string }[] = [];
          for (let i = 0; i < normalized.length; i += chunk) {
            const slice = normalized.slice(i, i + chunk);
            const rows = slice.map((n) => {
              const { _registration_id: _r, ...rest } = n;
              return {
                ...rest,
                source_last_synced_at: syncedAt,
              };
            });
            const { data, error } = await supabaseAdmin
              .from("fire_leads")
              .upsert(rows, {
                onConflict: "source_system,source_record_id",
                ignoreDuplicates: false,
              })
              .select("id, source_record_id");
            if (error) throw new Error(`upsert: ${error.message}`);
            upserted += data?.length ?? 0;
            for (const row of data ?? []) {
              if (!existingKeys.has(row.source_record_id)) {
                newLeadIds.push(row);
              }
            }
          }

          if (newLeadIds.length) {
            const events = newLeadIds.map((r) => ({
              lead_id: r.id,
              event_type: "new_lead" as const,
              payload: { source_system: SOURCE_SYSTEM, source_record_id: r.source_record_id },
            }));
            for (let i = 0; i < events.length; i += chunk) {
              const { error } = await supabaseAdmin
                .from("lead_events")
                .insert(events.slice(i, i + chunk));
              if (error) errors.push({ stage: "lead_events", error: error.message });
            }
          }

          const summary = {
            source_rows: rawRows.length,
            upserted,
            new_count: newLeadIds.length,
            owner_match_count: ownerMatchCount,
            errors,
            success: true,
          };

          await supabaseAdmin
            .from("sync_runs")
            .update({
              finished_at: new Date().toISOString(),
              source_rows: summary.source_rows,
              upserted: summary.upserted,
              new_count: summary.new_count,
              owner_match_count: summary.owner_match_count,
              errors: summary.errors,
              success: true,
            })
            .eq("id", runId);

          return new Response(JSON.stringify(summary), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          await supabaseAdmin
            .from("sync_runs")
            .update({
              finished_at: new Date().toISOString(),
              errors: [...errors, { fatal: message } as Json] as Json[],
              success: false,
            })
            .eq("id", runId);
          return new Response(JSON.stringify({ error: message, errors }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
