/**
 * Public share-link resolution.
 *
 * The recipient is not a user of this system, so the token is the only
 * credential and this function is deliberately unauthenticated. Three things
 * follow from that and none of them are negotiable.
 *
 * 1. It runs on the service role, on the server. The pending migration adds no
 *    anonymous RLS to `share_links` on purpose; opening those tables to `anon`
 *    to serve one page is a far larger blast radius than one server function.
 * 2. It re-checks revocation and expiry on every call. A link is live data, not
 *    a snapshot, so "was valid when created" is worth nothing.
 * 3. It returns only what `display_options` permits, and it strips the rest
 *    BEFORE the response is built. Filtering in React would leave every hidden
 *    crew name sitting in the recipient's network tab.
 */
import { createServerFn } from "@tanstack/react-start";

import { personLabel } from "./chat";
import { EQUIPMENT_TYPE_LABEL } from "./equipment";
import { JOB_ASSIGNMENT_ROLE_LABELS } from "./jobs";
import {
  buildGanttBars,
  todayDayNumber,
  type GanttAssignment,
  type GanttPlacement,
} from "./job-gantt";
import { isMissingSchema } from "./schema-fallback";
import {
  normalizeDisplayOptions,
  redactGanttBars,
  type PublicSharePayload,
  type ShareBarFallbacks,
} from "./job-share";

/** A token short enough to guess is not a token; refuse before touching the db. */
function validToken(token: unknown): string {
  if (typeof token !== "string" || token.length < 16 || token.length > 128)
    throw new Error("Invalid link.");
  return token;
}

const roleLabel = (role: string) => JOB_ASSIGNMENT_ROLE_LABELS[role] ?? role;
const equipmentLabel = (type: string | null) =>
  type ? (EQUIPMENT_TYPE_LABEL[type] ?? type) : "Equipment";

export const loadJobShare = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string }) => ({ token: validToken(data?.token) }))
  .handler(async ({ data }): Promise<PublicSharePayload> => {
    /* Fails OPEN. The token is the real gate and the caller has already proved
       they hold one; a counter store that is down must not tell a customer
       their photographs are gone. `publicTokenRead` was written for this page
       and the /intake and /sign ones, and this was the one still missing it. */
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("share:read", RATE_LIMITS.publicTokenRead, "open");

    const { supabaseAdmin: db } = await import("@/integrations/supabase/client.server");

    const BASE =
      "id, kind, job_id, expires_at, revoked_at, note, display_options, allow_download_original";
    let { data: link, error: linkError } = await db
      .from("share_links")
      .select(`${BASE}, photo_ids, document_ids`)
      .eq("token", data.token)
      .maybeSingle();

    /* `document_ids` arrives with the photo-share migration. Until it lands,
       PostgREST rejects the WHOLE select — which would take the schedule links
       down with it, and those have been working for weeks. Read the columns
       that predate it instead. */
    if (linkError && isMissingSchema(linkError)) {
      const retry = await db.from("share_links").select(BASE).eq("token", data.token).maybeSingle();
      link = retry.data ? { ...retry.data, photo_ids: null, document_ids: null } : null;
      linkError = retry.error;
    }

    /* A read that failed is not a link that is missing. Saying "not found"
       here would tell a customer their link is dead when the database simply
       blinked. */
    if (linkError) return { status: "error" };
    if (!link) return { status: "gone", reason: "not_found" };
    if (link.revoked_at) return { status: "gone", reason: "revoked" };
    if (new Date(link.expires_at).getTime() < Date.now())
      return { status: "gone", reason: "expired" };

    /* Photo links share this table and this route: one token check, one expiry
       check, one set of "no longer available" wording for both kinds. */
    if (link.kind === "job_photos" && link.job_id) {
      const { buildJobPhotoShare } = await import("./photo-share.server");
      const built = await buildJobPhotoShare(db, {
        token: data.token,
        job_id: link.job_id,
        photo_ids: link.photo_ids,
        document_ids: link.document_ids,
        display_options: link.display_options,
        allow_download_original: link.allow_download_original,
      });
      if (built.status !== "ok") return { status: "error" };

      const { data: photoLoc } =
        built.opts.contact && built.brandLocationId
          ? await db
              .from("locations")
              .select("name, office_phone, logo_url")
              .eq("id", built.brandLocationId)
              .maybeSingle()
          : { data: null };

      return {
        status: "ok",
        kind: "job_photos",
        branding: {
          companyName: "Gold Star Restoration",
          officeName: built.opts.contact ? (photoLoc?.name ?? null) : null,
          officePhone: built.opts.contact ? (photoLoc?.office_phone ?? null) : null,
          officeLogoUrl: photoLoc?.logo_url ?? null,
        },
        note: link.note,
        expiresAt: link.expires_at,
        jobNumber: built.jobNumber,
        address: built.address,
        photos: { photos: built.photos, missing: built.missing },
      };
    }

    /* A filed report sent as a link (David, 13 Oct). The page names the
       report and fetches its bytes through the share byte route, which checks
       this same token again on every request. */
    if ((link.kind as string) === "job_drying_report" && link.job_id) {
      const { reportShareFileHref, reportShareServes } = await import("./report-share");
      const docId = (link.document_ids ?? [])[0] ?? "";
      const [{ data: doc, error: docError }, { data: job }] = await Promise.all([
        docId
          ? db
              .from("documents")
              .select("id, name, created_at, job_id, mime, storage_path")
              .eq("id", docId)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null }),
        db
          .from("jobs")
          .select("job_number, address, location_id")
          .eq("id", link.job_id)
          .maybeSingle(),
      ]);
      if (docError) return { status: "error" };
      const served = reportShareServes(
        { ...link, document_ids: link.document_ids ?? null },
        docId,
        doc ?? null,
      );
      if (served !== "ok" || !doc) return { status: "gone", reason: "not_found" };
      const { data: loc } = job?.location_id
        ? await db
            .from("locations")
            .select("name, office_phone, logo_url")
            .eq("id", job.location_id)
            .maybeSingle()
        : { data: null };
      return {
        status: "ok",
        kind: "job_drying_report",
        branding: {
          companyName: "Gold Star Restoration",
          officeName: loc?.name ?? null,
          officePhone: loc?.office_phone ?? null,
          officeLogoUrl: loc?.logo_url ?? null,
        },
        note: link.note,
        expiresAt: link.expires_at,
        jobNumber: job?.job_number ?? null,
        address: job?.address ?? null,
        report: {
          name: doc.name,
          filedAt: doc.created_at,
          href: reportShareFileHref(data.token, doc.id),
        },
      };
    }

    /* A live link this viewer cannot render. Say so rather than 404ing it. */
    if (link.kind !== "job_schedule" || !link.job_id) return { status: "unsupported" };

    const opts = normalizeDisplayOptions(link.display_options);

    const { data: job, error: jobError } = await db
      .from("jobs")
      .select(
        "job_number, address, loss_date, call_date, start_date, completion_date, location_id, billing_location_id",
      )
      .eq("id", link.job_id)
      .maybeSingle();
    if (jobError || !job) return { status: "error" };

    /* Only read a list the link actually permits. Nothing that is switched off
       is ever fetched, so it cannot leak through a later mistake. */
    const [crewRes, placeRes] = await Promise.all([
      opts.crew
        ? db
            .from("job_assignments")
            .select("id, role, start_date, end_date, profiles:user_id(full_name)")
            .eq("job_id", link.job_id)
        : Promise.resolve({ data: [], error: null }),
      opts.equipment
        ? db
            .from("equipment_placements")
            .select(
              "id, placed_at, retrieved_at, expected_retrieval_date, equipment:equipment_id(asset_tag, equipment_type)",
            )
            .eq("job_id", link.job_id)
            .order("placed_at")
        : Promise.resolve({ data: [], error: null }),
    ]);

    const crew = (crewRes.data ?? []) as unknown as GanttAssignment[];
    const placements = (placeRes.data ?? []) as unknown as GanttPlacement[];

    const today = todayDayNumber();
    const build = buildGanttBars({
      job,
      crew,
      placements,
      today,
      roleLabel,
      equipmentLabel,
      personLabel,
    });

    const fallbacks: ShareBarFallbacks = {
      crewRole: Object.fromEntries(crew.map((a) => [`crew-${a.id}`, roleLabel(a.role)])),
      equipmentType: Object.fromEntries(
        placements.map((p) => [
          `equip-${p.id}`,
          equipmentLabel(p.equipment?.equipment_type ?? null),
        ]),
      ),
    };

    const undatedParts = [
      build.undated.crew > 0 ? `${build.undated.crew} crew assignment(s) with no dates` : null,
      build.undated.equipment > 0
        ? `${build.undated.equipment} placement(s) with no placed date`
        : null,
    ].filter((v): v is string => v != null);

    const brandLocationId = job.billing_location_id ?? job.location_id;
    const { data: loc } = opts.contact
      ? await db
          .from("locations")
          .select("name, office_phone, logo_url")
          .eq("id", brandLocationId)
          .maybeSingle()
      : { data: null };

    return {
      status: "ok",
      kind: "job_schedule",
      branding: {
        companyName: "Gold Star Restoration",
        officeName: opts.contact ? (loc?.name ?? null) : null,
        officePhone: opts.contact ? (loc?.office_phone ?? null) : null,
        officeLogoUrl: loc?.logo_url ?? null,
      },
      note: link.note,
      expiresAt: link.expires_at,
      jobNumber: opts.job_number ? job.job_number : null,
      address: opts.address ? job.address : null,
      schedule: {
        bars: redactGanttBars(build.bars, opts, fallbacks),
        today,
        undated: opts.undated_note && undatedParts.length ? undatedParts.join(", ") : null,
        unread: [crewRes.error ? "crew" : null, placeRes.error ? "equipment" : null].filter(
          (v): v is string => v != null,
        ),
      },
    };
  });
