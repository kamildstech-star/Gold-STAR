-- Audit tables must survive user deletion, so their actor columns become nullable
-- and clear rather than cascade.
ALTER TABLE public.impersonation_audit ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.role_change_audit ALTER COLUMN target_user_id DROP NOT NULL;

DO $$
DECLARE
  r record;
  cname text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- hotfixed by hand; declared here so they survive future schema work
      ('conversation_members','user_id','CASCADE'),
      ('messages','sender_id','SET NULL'),
      ('message_receipts','user_id','CASCADE'),
      ('message_reactions','user_id','CASCADE'),
      ('job_assignments','user_id','CASCADE'),
      -- membership / ownership rows: meaningless without the person
      ('chaser_shifts','user_id','CASCADE'),
      ('job_saved_filters','user_id','CASCADE'),
      ('location_members','user_id','CASCADE'),
      ('notification_preferences','user_id','CASCADE'),
      ('notifications','user_id','CASCADE'),
      ('project_members','user_id','CASCADE'),
      ('project_stars','user_id','CASCADE'),
      ('region_members','user_id','CASCADE'),
      ('reminders','user_id','CASCADE'),
      ('shifts','user_id','CASCADE'),
      ('time_entries','user_id','CASCADE'),
      ('user_roles','user_id','CASCADE'),
      -- everything else: keep the record, drop the person reference
      ('account_stage_history','changed_by','SET NULL'),
      ('accounts','assigned_rep','SET NULL'),
      ('accounts','created_by','SET NULL'),
      ('calendar_events','user_id','SET NULL'),
      ('contact_attempts','author_id','SET NULL'),
      ('contacts','created_by','SET NULL'),
      ('conversations','created_by','SET NULL'),
      ('document_events','actor_id','SET NULL'),
      ('document_signatures','captured_by','SET NULL'),
      ('document_template_versions','created_by','SET NULL'),
      ('document_templates','created_by','SET NULL'),
      ('documents','created_by','SET NULL'),
      ('documents','voided_by','SET NULL'),
      ('email_logs','user_id','SET NULL'),
      ('email_messages','sent_by','SET NULL'),
      ('email_templates','created_by','SET NULL'),
      ('equipment','created_by','SET NULL'),
      ('equipment_placements','placed_by','SET NULL'),
      ('equipment_placements','retrieved_by','SET NULL'),
      ('escalation_events','notified_user_id','SET NULL'),
      ('escalation_events','owner_user_id','SET NULL'),
      ('escalation_events','resolved_by','SET NULL'),
      ('escalation_rules','created_by','SET NULL'),
      ('escalation_rules','step2_target_user_id','SET NULL'),
      ('escalation_rules','step3_target_user_id','SET NULL'),
      ('escalation_rules','target_user_id','SET NULL'),
      ('fire_leads','assigned_rep','SET NULL'),
      ('gift_campaigns','created_by','SET NULL'),
      ('gift_catalog','created_by','SET NULL'),
      ('gift_sends','created_by','SET NULL'),
      ('impersonation_audit','actor_id','SET NULL'),
      ('impersonation_audit','target_user_id','SET NULL'),
      ('incident_events','actor_id','SET NULL'),
      ('incidents','accepted_by','SET NULL'),
      ('incidents','created_by','SET NULL'),
      ('integration_connections','created_by','SET NULL'),
      ('invoice_payments','created_by','SET NULL'),
      ('invoices','created_by','SET NULL'),
      ('job_contacts','created_by','SET NULL'),
      ('job_notes','author_id','SET NULL'),
      ('job_number_settings','updated_by','SET NULL'),
      ('job_reports','approved_by','SET NULL'),
      ('job_reports','generated_by','SET NULL'),
      ('job_status_history','changed_by','SET NULL'),
      ('jobs','created_by','SET NULL'),
      ('jobs','crew_chief','SET NULL'),
      ('labour_rates','created_by','SET NULL'),
      ('labour_rates','user_id','SET NULL'),
      ('lead_events','actor_id','SET NULL'),
      ('lead_notes','author_id','SET NULL'),
      ('lead_stage_history','changed_by','SET NULL'),
      ('lead_tags','created_by','SET NULL'),
      ('photo_access_log','actor_id','SET NULL'),
      ('photo_annotations','author_id','SET NULL'),
      ('photo_comments','author_id','SET NULL'),
      ('photo_folders','created_by','SET NULL'),
      ('photo_tags','created_by','SET NULL'),
      ('photos','deleted_by','SET NULL'),
      ('photos','uploader_id','SET NULL'),
      ('profiles','deactivated_by','SET NULL'),
      ('project_checklist_items','done_by','SET NULL'),
      ('project_checklists','created_by','SET NULL'),
      ('project_documents','uploader_id','SET NULL'),
      ('projects','created_by','SET NULL'),
      ('quotes','created_by','SET NULL'),
      ('role_change_audit','actor_id','SET NULL'),
      ('role_change_audit','target_user_id','SET NULL'),
      ('seasonal_sends','created_by','SET NULL'),
      ('share_links','created_by','SET NULL'),
      ('share_links','revoked_by','SET NULL'),
      ('shift_corrections','actor_id','SET NULL'),
      ('shifts','approved_by','SET NULL'),
      ('tags','created_by','SET NULL'),
      ('tasks','assignee','SET NULL'),
      ('tasks','created_by','SET NULL'),
      ('time_entries','approved_by','SET NULL'),
      ('time_entries','entered_by','SET NULL'),
      ('time_entry_corrections','changed_by','SET NULL'),
      ('touchpoints','created_by','SET NULL'),
      ('translations','corrected_by','SET NULL'),
      ('translations','created_by','SET NULL'),
      ('vehicles','assigned_user_id','SET NULL'),
      ('vendor_documents','created_by','SET NULL')
    ) AS t(tbl, col, act)
  LOOP
    cname := r.tbl || '_' || r.col || '_profiles_fkey';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = cname AND conrelid = format('public.%I', r.tbl)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(user_id) ON DELETE %s',
        r.tbl, cname, r.col, r.act
      );
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';