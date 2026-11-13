-- General intake links: one link for the website, routed by address.
--
-- 20260831190500 let an intake request exist without a job and gave it an
-- office (location_id) so RLS knew who was waiting on it. A link with NO office
-- was privileged-only and single-use. The client wants one link they can put
-- behind a button on their website, so a request with location_id NULL now
-- means "general": it can be submitted any number of times, and each
-- submission is handed to the office whose service area matches the address
-- the customer typed (falling back to a configured default office).
--
-- The office therefore has to live on the SUBMISSION, not only on the request:
-- two people using the same website link can land at two different offices.

ALTER TABLE public.intake_submissions
  ADD COLUMN IF NOT EXISTS location_id uuid REFERENCES public.locations(id),
  -- True when the office was chosen from the address rather than by a person.
  -- The inbox says so, so triage knows the routing is a guess to confirm.
  ADD COLUMN IF NOT EXISTS location_auto_assigned boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS intake_submissions_location_unassigned_idx
  ON public.intake_submissions(location_id) WHERE job_id IS NULL;

-- Visibility of a job-less submission: its own office first, then the office
-- its request was minted for, then privileged-only. Job-linked rows keep
-- exactly the visibility they had.
DROP POLICY IF EXISTS intake_submissions_select ON public.intake_submissions;
CREATE POLICY intake_submissions_select ON public.intake_submissions FOR SELECT TO authenticated
  USING (
    CASE
      WHEN job_id IS NOT NULL THEN public.can_view_job((SELECT auth.uid()), job_id)
      WHEN location_id IS NOT NULL THEN public.can_view_location((SELECT auth.uid()), location_id)
      ELSE EXISTS (
        SELECT 1 FROM public.intake_requests r
        WHERE r.id = request_id
          AND CASE
            WHEN r.location_id IS NOT NULL
              THEN public.can_view_location((SELECT auth.uid()), r.location_id)
            ELSE public.is_privileged((SELECT auth.uid()))
          END
      )
    END
  );

DROP POLICY IF EXISTS intake_submissions_write ON public.intake_submissions;
CREATE POLICY intake_submissions_write ON public.intake_submissions FOR ALL TO authenticated
  USING (
    CASE
      WHEN job_id IS NOT NULL THEN public.can_manage_job((SELECT auth.uid()), job_id)
      WHEN location_id IS NOT NULL THEN public.can_manage_location((SELECT auth.uid()), location_id)
      ELSE EXISTS (
        SELECT 1 FROM public.intake_requests r
        WHERE r.id = request_id
          AND CASE
            WHEN r.location_id IS NOT NULL
              THEN public.can_manage_location((SELECT auth.uid()), r.location_id)
            ELSE public.is_privileged((SELECT auth.uid()))
          END
      )
    END
  )
  WITH CHECK (
    CASE
      WHEN job_id IS NOT NULL THEN public.can_manage_job((SELECT auth.uid()), job_id)
      WHEN location_id IS NOT NULL THEN public.can_manage_location((SELECT auth.uid()), location_id)
      ELSE EXISTS (
        SELECT 1 FROM public.intake_requests r
        WHERE r.id = request_id
          AND CASE
            WHEN r.location_id IS NOT NULL
              THEN public.can_manage_location((SELECT auth.uid()), r.location_id)
            ELSE public.is_privileged((SELECT auth.uid()))
          END
      )
    END
  );

-- The fallback office for a general link whose address matches nothing lives
-- in app_settings under the key 'intake_general' as {"fallback_location_id":
-- "<uuid>"}; it is written from the intake inbox by a privileged user, so no
-- seed row is needed here.
