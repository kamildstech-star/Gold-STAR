export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  public: {
    Tables: {
      account_compliance_requirements: {
        Row: {
          account_id: string;
          active: boolean;
          created_at: string;
          created_by: string | null;
          direction: string;
          id: string;
          is_demo: boolean;
          mandatory: boolean;
          must_name_account: boolean;
          notes: string | null;
          renewal_lead_days: number;
          requested_at: string | null;
          required_amount: number | null;
          required_currency: string;
          required_value: string | null;
          requirement_type: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          direction?: string;
          id?: string;
          is_demo?: boolean;
          mandatory?: boolean;
          must_name_account?: boolean;
          notes?: string | null;
          renewal_lead_days?: number;
          requested_at?: string | null;
          required_amount?: number | null;
          required_currency?: string;
          required_value?: string | null;
          requirement_type: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          direction?: string;
          id?: string;
          is_demo?: boolean;
          mandatory?: boolean;
          must_name_account?: boolean;
          notes?: string | null;
          renewal_lead_days?: number;
          requested_at?: string | null;
          required_amount?: number | null;
          required_currency?: string;
          required_value?: string | null;
          requirement_type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_compliance_requirements_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_compliance_requirements_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_compliance_requirements_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_compliance_requirements_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      account_focus_dismissals: {
        Row: {
          account_id: string;
          dismissal_reason: string | null;
          dismissal_reason_detail: string | null;
          dismissed_at: string;
          id: string;
          suggestion_key: string;
          user_id: string;
        };
        Insert: {
          account_id: string;
          dismissal_reason?: string | null;
          dismissal_reason_detail?: string | null;
          dismissed_at?: string;
          id?: string;
          suggestion_key: string;
          user_id: string;
        };
        Update: {
          account_id?: string;
          dismissal_reason?: string | null;
          dismissal_reason_detail?: string | null;
          dismissed_at?: string;
          id?: string;
          suggestion_key?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_focus_dismissals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_focus_dismissals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_focus_dismissals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
        ];
      };
      account_locations: {
        Row: {
          account_id: string;
          created_at: string;
          created_by: string | null;
          is_demo: boolean;
          location_id: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          location_id: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          location_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_locations_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_locations_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_locations_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_locations_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      account_notes: {
        Row: {
          account_id: string;
          acknowledged_at: string | null;
          acknowledged_by: string | null;
          body: string;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          fired_at: string | null;
          id: string;
          is_demo: boolean;
          is_pinned: boolean;
          trigger_on: string | null;
          trigger_type: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          acknowledged_at?: string | null;
          acknowledged_by?: string | null;
          body: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          fired_at?: string | null;
          id?: string;
          is_demo?: boolean;
          is_pinned?: boolean;
          trigger_on?: string | null;
          trigger_type?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          acknowledged_at?: string | null;
          acknowledged_by?: string | null;
          body?: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          fired_at?: string | null;
          id?: string;
          is_demo?: boolean;
          is_pinned?: boolean;
          trigger_on?: string | null;
          trigger_type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_notes_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_notes_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_notes_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_notes_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "account_notes_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_notes_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      account_properties: {
        Row: {
          account_id: string;
          active: boolean;
          address: string;
          address_key: string;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          name: string | null;
          notes: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          active?: boolean;
          address: string;
          address_key: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name?: string | null;
          notes?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          active?: boolean;
          address?: string;
          address_key?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name?: string | null;
          notes?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_properties_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_properties_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_properties_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
        ];
      };
      account_property_contacts: {
        Row: {
          contact_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          position_key: string | null;
          property_id: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          position_key?: string | null;
          property_id: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          position_key?: string | null;
          property_id?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_property_contacts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "account_property_contacts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_property_contacts_property_id_fkey";
            columns: ["property_id"];
            isOneToOne: false;
            referencedRelation: "account_properties";
            referencedColumns: ["id"];
          },
        ];
      };
      account_proposal_lines: {
        Row: {
          created_at: string;
          description: string;
          id: string;
          line_total: number | null;
          position: number;
          proposal_id: string;
          quantity: number;
          unit_price: number;
        };
        Insert: {
          created_at?: string;
          description: string;
          id?: string;
          line_total?: number | null;
          position?: number;
          proposal_id: string;
          quantity?: number;
          unit_price?: number;
        };
        Update: {
          created_at?: string;
          description?: string;
          id?: string;
          line_total?: number | null;
          position?: number;
          proposal_id?: string;
          quantity?: number;
          unit_price?: number;
        };
        Relationships: [
          {
            foreignKeyName: "account_proposal_lines_proposal_id_fkey";
            columns: ["proposal_id"];
            isOneToOne: false;
            referencedRelation: "account_proposals";
            referencedColumns: ["id"];
          },
        ];
      };
      account_proposals: {
        Row: {
          account_id: string;
          created_at: string;
          created_by: string | null;
          declined_at: string | null;
          declined_reason: string | null;
          document_id: string | null;
          expired_at: string | null;
          id: string;
          notes: string | null;
          pipeline_id: string | null;
          sent_at: string | null;
          sent_by: string | null;
          signed_at: string | null;
          stage_note: string | null;
          status: string;
          subtotal: number;
          template_id: string | null;
          template_version_id: string | null;
          terms: string | null;
          title: string;
          total: number;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          created_by?: string | null;
          declined_at?: string | null;
          declined_reason?: string | null;
          document_id?: string | null;
          expired_at?: string | null;
          id?: string;
          notes?: string | null;
          pipeline_id?: string | null;
          sent_at?: string | null;
          sent_by?: string | null;
          signed_at?: string | null;
          stage_note?: string | null;
          status?: string;
          subtotal?: number;
          template_id?: string | null;
          template_version_id?: string | null;
          terms?: string | null;
          title: string;
          total?: number;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          created_by?: string | null;
          declined_at?: string | null;
          declined_reason?: string | null;
          document_id?: string | null;
          expired_at?: string | null;
          id?: string;
          notes?: string | null;
          pipeline_id?: string | null;
          sent_at?: string | null;
          sent_by?: string | null;
          signed_at?: string | null;
          stage_note?: string | null;
          status?: string;
          subtotal?: number;
          template_id?: string | null;
          template_version_id?: string | null;
          terms?: string | null;
          title?: string;
          total?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_proposals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_proposals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_proposals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_proposals_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_proposals_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_proposals_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "document_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_proposals_template_version_id_fkey";
            columns: ["template_version_id"];
            isOneToOne: false;
            referencedRelation: "document_template_versions";
            referencedColumns: ["id"];
          },
        ];
      };
      account_referral_fees: {
        Row: {
          account_id: string;
          amount: number | null;
          basis: string;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          notes: string | null;
          rate_percent: number | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          amount?: number | null;
          basis?: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          notes?: string | null;
          rate_percent?: number | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          amount?: number | null;
          basis?: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          notes?: string | null;
          rate_percent?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_referral_fees_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_referral_fees_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_referral_fees_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_referral_fees_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "account_referral_fees_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      account_stage_history: {
        Row: {
          account_id: string;
          changed_at: string;
          changed_by: string | null;
          from_stage: string | null;
          from_stage_id: string | null;
          id: string;
          is_demo: boolean;
          reason: string | null;
          to_stage: string;
          to_stage_id: string | null;
        };
        Insert: {
          account_id: string;
          changed_at?: string;
          changed_by?: string | null;
          from_stage?: string | null;
          from_stage_id?: string | null;
          id?: string;
          is_demo?: boolean;
          reason?: string | null;
          to_stage: string;
          to_stage_id?: string | null;
        };
        Update: {
          account_id?: string;
          changed_at?: string;
          changed_by?: string | null;
          from_stage?: string | null;
          from_stage_id?: string | null;
          id?: string;
          is_demo?: boolean;
          reason?: string | null;
          to_stage?: string;
          to_stage_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "account_stage_history_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_stage_history_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_stage_history_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_stage_history_changed_by_profiles_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "account_stage_history_from_stage_id_fkey";
            columns: ["from_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_stage_history_to_stage_id_fkey";
            columns: ["to_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
        ];
      };
      account_tags: {
        Row: {
          account_id: string;
          created_at: string;
          created_by: string | null;
          is_demo: boolean;
          tag_id: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          tag_id: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_tags_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_tags_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_tags_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_tags_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "account_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      account_timeline_reads: {
        Row: {
          account_id: string;
          entry_count: number;
          fingerprint: string;
          generated_at: string;
          id: string;
          items: Json;
          latest_entry_at: string | null;
          model: string | null;
          status: string;
          user_id: string;
        };
        Insert: {
          account_id: string;
          entry_count?: number;
          fingerprint: string;
          generated_at?: string;
          id?: string;
          items?: Json;
          latest_entry_at?: string | null;
          model?: string | null;
          status?: string;
          user_id: string;
        };
        Update: {
          account_id?: string;
          entry_count?: number;
          fingerprint?: string;
          generated_at?: string;
          id?: string;
          items?: Json;
          latest_entry_at?: string | null;
          model?: string | null;
          status?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "account_timeline_reads_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_timeline_reads_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_timeline_reads_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
        ];
      };
      accounts: {
        Row: {
          account_type: string;
          account_type_detail: string | null;
          account_type_id: string | null;
          address_line1: string | null;
          annual_meeting_due_on: string | null;
          annual_meeting_missed_at: string | null;
          approval_due_on: string | null;
          approval_state: string;
          approved_at: string | null;
          approved_by: string | null;
          archived_at: string | null;
          archived_by: string | null;
          assigned_rep: string | null;
          certificates_email: string | null;
          city: string | null;
          client_since: string | null;
          created_at: string;
          created_by: string | null;
          email: string | null;
          estimated_annual_value: number | null;
          external_id: string | null;
          external_source: string | null;
          ghost_confirmed_at: string | null;
          ghost_confirmed_by: string | null;
          ghost_snoozed_at: string | null;
          ghost_snoozed_by: string | null;
          ghost_snoozed_until: string | null;
          ghost_warning_sent_at: string | null;
          ghosted_at: string | null;
          ghosted_escalated_at: string | null;
          goasted_at: string | null;
          goasted_escalated_at: string | null;
          green_light_date: string | null;
          health_changed_at: string | null;
          health_pipeline_id: string | null;
          health_stage_id: string | null;
          id: string;
          is_demo: boolean;
          is_multi_location: boolean;
          is_reference: boolean;
          last_in_person_at: string | null;
          lead_source_detail: string | null;
          lead_source_id: string | null;
          location_id: string;
          lost_reason: string | null;
          name: string;
          no_service_reason_code: string | null;
          no_service_reason_detail: string | null;
          no_service_retry_months: number | null;
          notes: string | null;
          onboarding_answers: Json | null;
          onboarding_applied_at: string | null;
          onboarding_applied_by: string | null;
          parent_account_id: string | null;
          phone: string | null;
          pipeline_id: string | null;
          postal_code: string | null;
          priority: string;
          reactivate_on: string | null;
          rule_clock_started_at: string;
          satisfaction_score: number | null;
          satisfaction_updated_at: string | null;
          satisfaction_updated_by: string | null;
          stage: string;
          stage_changed_at: string;
          stage_id: string | null;
          standing_note_urgent: boolean;
          standing_note: string | null;
          standing_note_kind: string;
          state: string | null;
          status: Database["public"]["Enums"]["account_status"];
          tradeshow_id: string | null;
          updated_at: string;
          website: string | null;
          what_they_do: string[];
        };
        Insert: {
          account_type?: string;
          account_type_detail?: string | null;
          account_type_id?: string | null;
          address_line1?: string | null;
          annual_meeting_due_on?: string | null;
          annual_meeting_missed_at?: string | null;
          approval_due_on?: string | null;
          approval_state?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          archived_at?: string | null;
          archived_by?: string | null;
          assigned_rep?: string | null;
          certificates_email?: string | null;
          city?: string | null;
          client_since?: string | null;
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          estimated_annual_value?: number | null;
          external_id?: string | null;
          external_source?: string | null;
          ghost_confirmed_at?: string | null;
          ghost_confirmed_by?: string | null;
          ghost_snoozed_at?: string | null;
          ghost_snoozed_by?: string | null;
          ghost_snoozed_until?: string | null;
          ghost_warning_sent_at?: string | null;
          ghosted_at?: string | null;
          ghosted_escalated_at?: string | null;
          goasted_at?: string | null;
          goasted_escalated_at?: string | null;
          green_light_date?: string | null;
          health_changed_at?: string | null;
          health_pipeline_id?: string | null;
          health_stage_id?: string | null;
          id?: string;
          is_demo?: boolean;
          is_multi_location?: boolean;
          is_reference?: boolean;
          last_in_person_at?: string | null;
          lead_source_detail?: string | null;
          lead_source_id?: string | null;
          location_id: string;
          lost_reason?: string | null;
          name: string;
          no_service_reason_code?: string | null;
          no_service_reason_detail?: string | null;
          no_service_retry_months?: number | null;
          notes?: string | null;
          onboarding_answers?: Json | null;
          onboarding_applied_at?: string | null;
          onboarding_applied_by?: string | null;
          parent_account_id?: string | null;
          phone?: string | null;
          pipeline_id?: string | null;
          postal_code?: string | null;
          priority?: string;
          reactivate_on?: string | null;
          rule_clock_started_at?: string;
          satisfaction_score?: number | null;
          satisfaction_updated_at?: string | null;
          satisfaction_updated_by?: string | null;
          stage?: string;
          stage_changed_at?: string;
          stage_id?: string | null;
          standing_note_urgent?: boolean;
          standing_note?: string | null;
          standing_note_kind?: string;
          state?: string | null;
          status?: Database["public"]["Enums"]["account_status"];
          tradeshow_id?: string | null;
          updated_at?: string;
          website?: string | null;
          what_they_do?: string[];
        };
        Update: {
          account_type?: string;
          account_type_detail?: string | null;
          account_type_id?: string | null;
          address_line1?: string | null;
          annual_meeting_due_on?: string | null;
          annual_meeting_missed_at?: string | null;
          approval_due_on?: string | null;
          approval_state?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          archived_at?: string | null;
          archived_by?: string | null;
          assigned_rep?: string | null;
          certificates_email?: string | null;
          city?: string | null;
          client_since?: string | null;
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          estimated_annual_value?: number | null;
          external_id?: string | null;
          external_source?: string | null;
          ghost_confirmed_at?: string | null;
          ghost_confirmed_by?: string | null;
          ghost_snoozed_at?: string | null;
          ghost_snoozed_by?: string | null;
          ghost_snoozed_until?: string | null;
          ghost_warning_sent_at?: string | null;
          ghosted_at?: string | null;
          ghosted_escalated_at?: string | null;
          goasted_at?: string | null;
          goasted_escalated_at?: string | null;
          green_light_date?: string | null;
          health_changed_at?: string | null;
          health_pipeline_id?: string | null;
          health_stage_id?: string | null;
          id?: string;
          is_demo?: boolean;
          is_multi_location?: boolean;
          is_reference?: boolean;
          last_in_person_at?: string | null;
          lead_source_detail?: string | null;
          lead_source_id?: string | null;
          location_id?: string;
          lost_reason?: string | null;
          name?: string;
          no_service_reason_code?: string | null;
          no_service_reason_detail?: string | null;
          no_service_retry_months?: number | null;
          notes?: string | null;
          onboarding_answers?: Json | null;
          onboarding_applied_at?: string | null;
          onboarding_applied_by?: string | null;
          parent_account_id?: string | null;
          phone?: string | null;
          pipeline_id?: string | null;
          postal_code?: string | null;
          priority?: string;
          reactivate_on?: string | null;
          rule_clock_started_at?: string;
          satisfaction_score?: number | null;
          satisfaction_updated_at?: string | null;
          satisfaction_updated_by?: string | null;
          stage?: string;
          stage_changed_at?: string;
          stage_id?: string | null;
          standing_note_urgent?: boolean;
          standing_note?: string | null;
          standing_note_kind?: string;
          state?: string | null;
          status?: Database["public"]["Enums"]["account_status"];
          tradeshow_id?: string | null;
          updated_at?: string;
          website?: string | null;
          what_they_do?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "accounts_account_type_id_fkey";
            columns: ["account_type_id"];
            isOneToOne: false;
            referencedRelation: "option_list_values";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_approved_by_profiles_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "accounts_archived_by_fkey";
            columns: ["archived_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "accounts_assigned_rep_profiles_fkey";
            columns: ["assigned_rep"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "accounts_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "accounts_health_pipeline_id_fkey";
            columns: ["health_pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_health_stage_id_fkey";
            columns: ["health_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_lead_source_id_fkey";
            columns: ["lead_source_id"];
            isOneToOne: false;
            referencedRelation: "option_list_values";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_parent_account_id_fkey";
            columns: ["parent_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "accounts_parent_account_id_fkey";
            columns: ["parent_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_parent_account_id_fkey";
            columns: ["parent_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "accounts_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_tradeshow_id_fkey";
            columns: ["tradeshow_id"];
            isOneToOne: false;
            referencedRelation: "tradeshows";
            referencedColumns: ["id"];
          },
        ];
      };
      activity_log: {
        Row: {
          actor_id: string | null;
          created_at: string;
          detail: Json;
          event_type: string;
          id: string;
          location_id: string | null;
          module: string;
          occurred_at: string;
          record_id: string | null;
          record_label: string | null;
          record_type: string | null;
          summary: string;
          via: string;
        };
        Insert: {
          actor_id?: string | null;
          created_at?: string;
          detail?: Json;
          event_type: string;
          id?: string;
          location_id?: string | null;
          module: string;
          occurred_at?: string;
          record_id?: string | null;
          record_label?: string | null;
          record_type?: string | null;
          summary: string;
          via?: string;
        };
        Update: {
          actor_id?: string | null;
          created_at?: string;
          detail?: Json;
          event_type?: string;
          id?: string;
          location_id?: string | null;
          module?: string;
          occurred_at?: string;
          record_id?: string | null;
          record_label?: string | null;
          record_type?: string | null;
          summary?: string;
          via?: string;
        };
        Relationships: [
          {
            foreignKeyName: "activity_log_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      affiliate_referrals: {
        Row: {
          account_id: string | null;
          affiliate_id: string;
          amount_owed: number | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          note: string | null;
          paid_on: string | null;
          referred_on: string;
          status: string;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          affiliate_id: string;
          amount_owed?: number | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          note?: string | null;
          paid_on?: string | null;
          referred_on?: string;
          status?: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          affiliate_id?: string;
          amount_owed?: number | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          note?: string | null;
          paid_on?: string | null;
          referred_on?: string;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "affiliate_referrals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "affiliate_referrals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "affiliate_referrals_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "affiliate_referrals_affiliate_id_fkey";
            columns: ["affiliate_id"];
            isOneToOne: false;
            referencedRelation: "affiliate_reps";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "affiliate_referrals_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      affiliate_reps: {
        Row: {
          commission_rate: number | null;
          company: string | null;
          created_at: string;
          created_by: string | null;
          email: string | null;
          full_name: string;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          notes: string | null;
          payout_terms: string | null;
          phone: string | null;
          status: string;
          updated_at: string;
        };
        Insert: {
          commission_rate?: number | null;
          company?: string | null;
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          full_name: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          notes?: string | null;
          payout_terms?: string | null;
          phone?: string | null;
          status?: string;
          updated_at?: string;
        };
        Update: {
          commission_rate?: number | null;
          company?: string | null;
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          full_name?: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          notes?: string | null;
          payout_terms?: string | null;
          phone?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "affiliate_reps_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      app_settings: {
        Row: {
          key: string;
          updated_at: string;
          updated_by: string | null;
          value: Json;
        };
        Insert: {
          key: string;
          updated_at?: string;
          updated_by?: string | null;
          value?: Json;
        };
        Update: {
          key?: string;
          updated_at?: string;
          updated_by?: string | null;
          value?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "app_settings_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      assistant_audit: {
        Row: {
          actor_user_id: string;
          created_at: string;
          effective_roles: string[];
          effective_user_id: string | null;
          feature: string;
          id: string;
          impersonation_id: string | null;
          model: string | null;
          outcome: string;
          question: string | null;
          redactions: string[];
          response_preview: string | null;
          retrieved: Json;
          scope: Json;
        };
        Insert: {
          actor_user_id: string;
          created_at?: string;
          effective_roles?: string[];
          effective_user_id?: string | null;
          feature: string;
          id?: string;
          impersonation_id?: string | null;
          model?: string | null;
          outcome?: string;
          question?: string | null;
          redactions?: string[];
          response_preview?: string | null;
          retrieved?: Json;
          scope?: Json;
        };
        Update: {
          actor_user_id?: string;
          created_at?: string;
          effective_roles?: string[];
          effective_user_id?: string | null;
          feature?: string;
          id?: string;
          impersonation_id?: string | null;
          model?: string | null;
          outcome?: string;
          question?: string | null;
          redactions?: string[];
          response_preview?: string | null;
          retrieved?: Json;
          scope?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "assistant_audit_actor_profiles_fkey";
            columns: ["actor_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      assistant_conversations: {
        Row: {
          created_at: string;
          id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      assistant_messages: {
        Row: {
          content: string;
          conversation_id: string;
          created_at: string;
          id: string;
          meta: Json;
          role: string;
          user_id: string;
        };
        Insert: {
          content?: string;
          conversation_id: string;
          created_at?: string;
          id?: string;
          meta?: Json;
          role: string;
          user_id: string;
        };
        Update: {
          content?: string;
          conversation_id?: string;
          created_at?: string;
          id?: string;
          meta?: Json;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "assistant_messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "assistant_conversations";
            referencedColumns: ["id"];
          },
        ];
      };
      automation_events: {
        Row: {
          action_kind: Database["public"]["Enums"]["automation_action_kind"];
          created_at: string;
          dedupe_key: string;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          reason: string;
          record_id: string;
          record_label: string | null;
          record_type: string;
          rule_id: string;
          run_id: string | null;
          target_user_id: string | null;
          task_id: string | null;
        };
        Insert: {
          action_kind: Database["public"]["Enums"]["automation_action_kind"];
          created_at?: string;
          dedupe_key: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          reason: string;
          record_id: string;
          record_label?: string | null;
          record_type: string;
          rule_id: string;
          run_id?: string | null;
          target_user_id?: string | null;
          task_id?: string | null;
        };
        Update: {
          action_kind?: Database["public"]["Enums"]["automation_action_kind"];
          created_at?: string;
          dedupe_key?: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          reason?: string;
          record_id?: string;
          record_label?: string | null;
          record_type?: string;
          rule_id?: string;
          run_id?: string | null;
          target_user_id?: string | null;
          task_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "automation_events_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_events_rule_id_fkey";
            columns: ["rule_id"];
            isOneToOne: false;
            referencedRelation: "automation_rules";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_events_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "automation_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_events_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      automation_rules: {
        Row: {
          actions: Json;
          conditions: Json;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          is_system: boolean;
          location_id: string | null;
          name: string;
          run_order: number;
          trigger_config: Json;
          trigger_type: Database["public"]["Enums"]["automation_trigger"];
          updated_at: string;
        };
        Insert: {
          actions?: Json;
          conditions?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          is_system?: boolean;
          location_id?: string | null;
          name: string;
          run_order?: number;
          trigger_config?: Json;
          trigger_type: Database["public"]["Enums"]["automation_trigger"];
          updated_at?: string;
        };
        Update: {
          actions?: Json;
          conditions?: Json;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          is_system?: boolean;
          location_id?: string | null;
          name?: string;
          run_order?: number;
          trigger_config?: Json;
          trigger_type?: Database["public"]["Enums"]["automation_trigger"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_rules_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "automation_rules_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      automation_runs: {
        Row: {
          action_count: number;
          error: string | null;
          evaluated_count: number;
          finished_at: string | null;
          id: string;
          is_demo: boolean;
          matched_count: number;
          rule_id: string | null;
          started_at: string;
          triggered_by: string | null;
        };
        Insert: {
          action_count?: number;
          error?: string | null;
          evaluated_count?: number;
          finished_at?: string | null;
          id?: string;
          is_demo?: boolean;
          matched_count?: number;
          rule_id?: string | null;
          started_at?: string;
          triggered_by?: string | null;
        };
        Update: {
          action_count?: number;
          error?: string | null;
          evaluated_count?: number;
          finished_at?: string | null;
          id?: string;
          is_demo?: boolean;
          matched_count?: number;
          rule_id?: string | null;
          started_at?: string;
          triggered_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "automation_runs_rule_id_fkey";
            columns: ["rule_id"];
            isOneToOne: false;
            referencedRelation: "automation_rules";
            referencedColumns: ["id"];
          },
        ];
      };
      automation_stage_windows: {
        Row: {
          created_at: string;
          created_by: string | null;
          escalate_days: number | null;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          pipeline_id: string;
          rot_days: number;
          stage_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          escalate_days?: number | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          pipeline_id: string;
          rot_days?: number;
          stage_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          escalate_days?: number | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          pipeline_id?: string;
          rot_days?: number;
          stage_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "automation_stage_windows_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "automation_stage_windows_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "automation_stage_windows_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: true;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
        ];
      };
      calendar_events: {
        Row: {
          accepted_count: number;
          account_id: string | null;
          attendees: Json;
          body_preview: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          declined_count: number;
          ends_at: string | null;
          event_type: string;
          external_id: string | null;
          id: string;
          is_all_day: boolean;
          is_cancelled: boolean;
          is_demo: boolean;
          job_id: string | null;
          last_modified_at: string | null;
          last_push_at: string | null;
          location_id: string | null;
          location_text: string | null;
          mailbox_id: string | null;
          meeting_held: boolean | null;
          notes: string | null;
          organizer_email: string | null;
          provider: Database["public"]["Enums"]["integration_provider"] | null;
          push_actor_id: string | null;
          push_identity_verified: boolean;
          recurrence: Json | null;
          recurrence_index: number | null;
          recurrence_master_id: string | null;
          response_status: string | null;
          series_master_id: string | null;
          starts_at: string | null;
          subject: string | null;
          sync_attempts: number;
          sync_direction: string;
          sync_error: string | null;
          sync_state: string;
          touchpoint_id: string | null;
          updated_at: string;
          user_id: string | null;
          web_link: string | null;
        };
        Insert: {
          accepted_count?: number;
          account_id?: string | null;
          attendees?: Json;
          body_preview?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          declined_count?: number;
          ends_at?: string | null;
          event_type?: string;
          external_id?: string | null;
          id?: string;
          is_all_day?: boolean;
          is_cancelled?: boolean;
          is_demo?: boolean;
          job_id?: string | null;
          last_modified_at?: string | null;
          last_push_at?: string | null;
          location_id?: string | null;
          location_text?: string | null;
          mailbox_id?: string | null;
          meeting_held?: boolean | null;
          notes?: string | null;
          organizer_email?: string | null;
          provider?: Database["public"]["Enums"]["integration_provider"] | null;
          push_actor_id?: string | null;
          push_identity_verified?: boolean;
          recurrence?: Json | null;
          recurrence_index?: number | null;
          recurrence_master_id?: string | null;
          response_status?: string | null;
          series_master_id?: string | null;
          starts_at?: string | null;
          subject?: string | null;
          sync_attempts?: number;
          sync_direction?: string;
          sync_error?: string | null;
          sync_state?: string;
          touchpoint_id?: string | null;
          updated_at?: string;
          user_id?: string | null;
          web_link?: string | null;
        };
        Update: {
          accepted_count?: number;
          account_id?: string | null;
          attendees?: Json;
          body_preview?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          declined_count?: number;
          ends_at?: string | null;
          event_type?: string;
          external_id?: string | null;
          id?: string;
          is_all_day?: boolean;
          is_cancelled?: boolean;
          is_demo?: boolean;
          job_id?: string | null;
          last_modified_at?: string | null;
          last_push_at?: string | null;
          location_id?: string | null;
          location_text?: string | null;
          mailbox_id?: string | null;
          meeting_held?: boolean | null;
          notes?: string | null;
          organizer_email?: string | null;
          provider?: Database["public"]["Enums"]["integration_provider"] | null;
          push_actor_id?: string | null;
          push_identity_verified?: boolean;
          recurrence?: Json | null;
          recurrence_index?: number | null;
          recurrence_master_id?: string | null;
          response_status?: string | null;
          series_master_id?: string | null;
          starts_at?: string | null;
          subject?: string | null;
          sync_attempts?: number;
          sync_direction?: string;
          sync_error?: string | null;
          sync_state?: string;
          touchpoint_id?: string | null;
          updated_at?: string;
          user_id?: string | null;
          web_link?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "calendar_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "calendar_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "calendar_events_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "calendar_events_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_events_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_events_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_events_mailbox_id_fkey";
            columns: ["mailbox_id"];
            isOneToOne: false;
            referencedRelation: "graph_mailboxes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_events_recurrence_master_id_fkey";
            columns: ["recurrence_master_id"];
            isOneToOne: false;
            referencedRelation: "calendar_events";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_events_touchpoint_id_fkey";
            columns: ["touchpoint_id"];
            isOneToOne: false;
            referencedRelation: "touchpoints";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "calendar_events_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      captured_communications: {
        Row: {
          account_id: string | null;
          body_preview: string | null;
          channel: string;
          contact_id: string | null;
          conversation_id: string | null;
          created_at: string;
          direction: Database["public"]["Enums"]["comm_direction"];
          duration_seconds: number | null;
          external_id: string;
          from_address: string | null;
          id: string;
          internet_message_id: string | null;
          is_auto_reply: boolean;
          is_demo: boolean;
          mailbox_id: string | null;
          occurred_at: string;
          outcome: string | null;
          provider: string;
          raw: Json;
          recording_consent_state: string | null;
          recording_url: string | null;
          subject: string | null;
          to_address: string | null;
          touchpoint_id: string | null;
          user_id: string | null;
          web_link: string | null;
        };
        Insert: {
          account_id?: string | null;
          body_preview?: string | null;
          channel: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          direction: Database["public"]["Enums"]["comm_direction"];
          duration_seconds?: number | null;
          external_id: string;
          from_address?: string | null;
          id?: string;
          internet_message_id?: string | null;
          is_auto_reply?: boolean;
          is_demo?: boolean;
          mailbox_id?: string | null;
          occurred_at?: string;
          outcome?: string | null;
          provider: string;
          raw?: Json;
          recording_consent_state?: string | null;
          recording_url?: string | null;
          subject?: string | null;
          to_address?: string | null;
          touchpoint_id?: string | null;
          user_id?: string | null;
          web_link?: string | null;
        };
        Update: {
          account_id?: string | null;
          body_preview?: string | null;
          channel?: string;
          contact_id?: string | null;
          conversation_id?: string | null;
          created_at?: string;
          direction?: Database["public"]["Enums"]["comm_direction"];
          duration_seconds?: number | null;
          external_id?: string;
          from_address?: string | null;
          id?: string;
          internet_message_id?: string | null;
          is_auto_reply?: boolean;
          is_demo?: boolean;
          mailbox_id?: string | null;
          occurred_at?: string;
          outcome?: string | null;
          provider?: string;
          raw?: Json;
          recording_consent_state?: string | null;
          recording_url?: string | null;
          subject?: string | null;
          to_address?: string | null;
          touchpoint_id?: string | null;
          user_id?: string | null;
          web_link?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "captured_communications_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "captured_communications_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "captured_communications_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "captured_communications_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "captured_communications_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "captured_communications_mailbox_id_fkey";
            columns: ["mailbox_id"];
            isOneToOne: false;
            referencedRelation: "graph_mailboxes";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "captured_communications_touchpoint_id_fkey";
            columns: ["touchpoint_id"];
            isOneToOne: false;
            referencedRelation: "touchpoints";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "captured_communications_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      certificate_sends: {
        Row: {
          account_id: string;
          cc_emails: string[];
          created_at: string;
          credential_id: string | null;
          document_id: string | null;
          error_message: string | null;
          expiry_at_send: string | null;
          id: string;
          is_demo: boolean;
          note: string | null;
          queued_at: string;
          requirement_id: string | null;
          sent_at: string | null;
          sent_by: string | null;
          sent_to: string;
          status: Database["public"]["Enums"]["certificate_send_status"];
          subject: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          cc_emails?: string[];
          created_at?: string;
          credential_id?: string | null;
          document_id?: string | null;
          error_message?: string | null;
          expiry_at_send?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          queued_at?: string;
          requirement_id?: string | null;
          sent_at?: string | null;
          sent_by?: string | null;
          sent_to: string;
          status?: Database["public"]["Enums"]["certificate_send_status"];
          subject?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          cc_emails?: string[];
          created_at?: string;
          credential_id?: string | null;
          document_id?: string | null;
          error_message?: string | null;
          expiry_at_send?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          queued_at?: string;
          requirement_id?: string | null;
          sent_at?: string | null;
          sent_by?: string | null;
          sent_to?: string;
          status?: Database["public"]["Enums"]["certificate_send_status"];
          subject?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "certificate_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "certificate_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "certificate_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "certificate_sends_credential_id_fkey";
            columns: ["credential_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_status";
            referencedColumns: ["credential_id"];
          },
          {
            foreignKeyName: "certificate_sends_credential_id_fkey";
            columns: ["credential_id"];
            isOneToOne: false;
            referencedRelation: "company_credentials";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "certificate_sends_credential_id_fkey";
            columns: ["credential_id"];
            isOneToOne: false;
            referencedRelation: "network_compliance_status";
            referencedColumns: ["credential_id"];
          },
          {
            foreignKeyName: "certificate_sends_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "certificate_sends_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_requirements";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "certificate_sends_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_status";
            referencedColumns: ["requirement_id"];
          },
          {
            foreignKeyName: "certificate_sends_sent_by_fkey";
            columns: ["sent_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      chase_assignment_rules: {
        Row: {
          arrival_timeout_minutes: number;
          created_at: string;
          description: string | null;
          id: string;
          is_active: boolean;
          key: string;
          label: string;
          max_responders: number;
          sort_order: number;
          updated_at: string;
          zone_exclusive: boolean;
        };
        Insert: {
          arrival_timeout_minutes?: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          key: string;
          label: string;
          max_responders?: number;
          sort_order?: number;
          updated_at?: string;
          zone_exclusive?: boolean;
        };
        Update: {
          arrival_timeout_minutes?: number;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          key?: string;
          label?: string;
          max_responders?: number;
          sort_order?: number;
          updated_at?: string;
          zone_exclusive?: boolean;
        };
        Relationships: [];
      };
      chase_saved_searches: {
        Row: {
          created_at: string;
          filters: Json;
          id: string;
          name: string;
          query: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          filters?: Json;
          id?: string;
          name: string;
          query?: string;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          filters?: Json;
          id?: string;
          name?: string;
          query?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      chaser_shifts: {
        Row: {
          auto_closed_at: string | null;
          ended_at: string | null;
          ended_lat: number | null;
          ended_lon: number | null;
          id: string;
          is_demo: boolean;
          location_id: string;
          needs_correction: boolean;
          overtime_escalated_at: string | null;
          overtime_notified_at: string | null;
          scheduled_end_at: string | null;
          scheduled_minutes: number | null;
          scheduled_start_at: string | null;
          started_at: string;
          started_lat: number | null;
          started_lon: number | null;
          user_id: string;
        };
        Insert: {
          auto_closed_at?: string | null;
          ended_at?: string | null;
          ended_lat?: number | null;
          ended_lon?: number | null;
          id?: string;
          is_demo?: boolean;
          location_id: string;
          needs_correction?: boolean;
          overtime_escalated_at?: string | null;
          overtime_notified_at?: string | null;
          scheduled_end_at?: string | null;
          scheduled_minutes?: number | null;
          scheduled_start_at?: string | null;
          started_at?: string;
          started_lat?: number | null;
          started_lon?: number | null;
          user_id: string;
        };
        Update: {
          auto_closed_at?: string | null;
          ended_at?: string | null;
          ended_lat?: number | null;
          ended_lon?: number | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string;
          needs_correction?: boolean;
          overtime_escalated_at?: string | null;
          overtime_notified_at?: string | null;
          scheduled_end_at?: string | null;
          scheduled_minutes?: number | null;
          scheduled_start_at?: string | null;
          started_at?: string;
          started_lat?: number | null;
          started_lon?: number | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "chaser_shifts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "chaser_shifts_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      chaser_territories: {
        Row: {
          created_at: string;
          digest_time: string;
          dispatch_whole_market: boolean;
          dispatch_zone_ids: string[];
          is_demo: boolean;
          market_id: string;
          primary_zone_id: string | null;
          shift_end_time: string | null;
          shift_start_time: string | null;
          updated_at: string;
          user_id: string;
          view_whole_market: boolean;
          view_zone_ids: string[];
        };
        Insert: {
          created_at?: string;
          digest_time?: string;
          dispatch_whole_market?: boolean;
          dispatch_zone_ids?: string[];
          is_demo?: boolean;
          market_id: string;
          primary_zone_id?: string | null;
          shift_end_time?: string | null;
          shift_start_time?: string | null;
          updated_at?: string;
          user_id: string;
          view_whole_market?: boolean;
          view_zone_ids?: string[];
        };
        Update: {
          created_at?: string;
          digest_time?: string;
          dispatch_whole_market?: boolean;
          dispatch_zone_ids?: string[];
          is_demo?: boolean;
          market_id?: string;
          primary_zone_id?: string | null;
          shift_end_time?: string | null;
          shift_start_time?: string | null;
          updated_at?: string;
          user_id?: string;
          view_whole_market?: boolean;
          view_zone_ids?: string[];
        };
        Relationships: [
          {
            foreignKeyName: "chaser_territories_market_id_fkey";
            columns: ["market_id"];
            isOneToOne: false;
            referencedRelation: "markets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "chaser_territories_primary_zone_id_fkey";
            columns: ["primary_zone_id"];
            isOneToOne: false;
            referencedRelation: "zones";
            referencedColumns: ["id"];
          },
        ];
      };
      client_critical_decisions: {
        Row: {
          decided_at: string;
          decided_by: string;
          decision: string;
          episode_id: string;
          id: string;
          is_demo: boolean;
          new_deadline: string | null;
          note: string | null;
          reassigned_from: string | null;
          reassigned_to: string | null;
        };
        Insert: {
          decided_at?: string;
          decided_by: string;
          decision: string;
          episode_id: string;
          id?: string;
          is_demo?: boolean;
          new_deadline?: string | null;
          note?: string | null;
          reassigned_from?: string | null;
          reassigned_to?: string | null;
        };
        Update: {
          decided_at?: string;
          decided_by?: string;
          decision?: string;
          episode_id?: string;
          id?: string;
          is_demo?: boolean;
          new_deadline?: string | null;
          note?: string | null;
          reassigned_from?: string | null;
          reassigned_to?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "client_critical_decisions_episode_id_fkey";
            columns: ["episode_id"];
            isOneToOne: false;
            referencedRelation: "client_critical_episodes";
            referencedColumns: ["id"];
          },
        ];
      };
      client_critical_episodes: {
        Row: {
          account_id: string;
          assigned_rep: string | null;
          created_at: string;
          deadline: string;
          extended_count: number;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          opened_at: string;
          reason: string;
          recovery_task_id: string | null;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          track: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          assigned_rep?: string | null;
          created_at?: string;
          deadline: string;
          extended_count?: number;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          opened_at?: string;
          reason: string;
          recovery_task_id?: string | null;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          track: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          assigned_rep?: string | null;
          created_at?: string;
          deadline?: string;
          extended_count?: number;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          opened_at?: string;
          reason?: string;
          recovery_task_id?: string | null;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          track?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "client_critical_episodes_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "client_critical_episodes_recovery_task_id_fkey";
            columns: ["recovery_task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      client_operations: {
        Row: {
          client_created_at: string | null;
          created_at: string;
          idempotency_key: string;
          kind: string;
          payload: Json;
          result: Json | null;
          user_id: string;
        };
        Insert: {
          client_created_at?: string | null;
          created_at?: string;
          idempotency_key: string;
          kind: string;
          payload?: Json;
          result?: Json | null;
          user_id?: string;
        };
        Update: {
          client_created_at?: string | null;
          created_at?: string;
          idempotency_key?: string;
          kind?: string;
          payload?: Json;
          result?: Json | null;
          user_id?: string;
        };
        Relationships: [];
      };
      commission_payouts: {
        Row: {
          amount: number;
          approved_at: string | null;
          approved_by: string | null;
          basis: string | null;
          basis_amount: number | null;
          created_at: string;
          created_by: string | null;
          expected_pay_date: string | null;
          id: string;
          is_demo: boolean;
          issued_on: string | null;
          job_id: string | null;
          kind: string;
          location_id: string;
          note: string | null;
          paid_at: string | null;
          period_end: string;
          period_start: string;
          rate_percent: number | null;
          source: string;
          split_percent: number;
          status: string;
          tier_key: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          amount?: number;
          approved_at?: string | null;
          approved_by?: string | null;
          basis?: string | null;
          basis_amount?: number | null;
          created_at?: string;
          created_by?: string | null;
          expected_pay_date?: string | null;
          id?: string;
          is_demo?: boolean;
          issued_on?: string | null;
          job_id?: string | null;
          kind: string;
          location_id: string;
          note?: string | null;
          paid_at?: string | null;
          period_end: string;
          period_start: string;
          rate_percent?: number | null;
          source?: string;
          split_percent?: number;
          status?: string;
          tier_key?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          amount?: number;
          approved_at?: string | null;
          approved_by?: string | null;
          basis?: string | null;
          basis_amount?: number | null;
          created_at?: string;
          created_by?: string | null;
          expected_pay_date?: string | null;
          id?: string;
          is_demo?: boolean;
          issued_on?: string | null;
          job_id?: string | null;
          kind?: string;
          location_id?: string;
          note?: string | null;
          paid_at?: string | null;
          period_end?: string;
          period_start?: string;
          rate_percent?: number | null;
          source?: string;
          split_percent?: number;
          status?: string;
          tier_key?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "commission_payouts_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "commission_payouts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      commission_plans: {
        Row: {
          basis: string;
          created_at: string;
          created_by: string | null;
          deal_source: string;
          effective_from: string;
          effective_to: string | null;
          flat_amount: number | null;
          id: string;
          is_demo: boolean;
          note: string | null;
          payment_type: string | null;
          rate_percent: number | null;
          tier_key: string | null;
          tiers: Json;
          updated_at: string;
          user_id: string;
          work_component: string | null;
        };
        Insert: {
          basis?: string;
          created_at?: string;
          created_by?: string | null;
          deal_source?: string;
          effective_from?: string;
          effective_to?: string | null;
          flat_amount?: number | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          payment_type?: string | null;
          rate_percent?: number | null;
          tier_key?: string | null;
          tiers?: Json;
          updated_at?: string;
          user_id: string;
          work_component?: string | null;
        };
        Update: {
          basis?: string;
          created_at?: string;
          created_by?: string | null;
          deal_source?: string;
          effective_from?: string;
          effective_to?: string | null;
          flat_amount?: number | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          payment_type?: string | null;
          rate_percent?: number | null;
          tier_key?: string | null;
          tiers?: Json;
          updated_at?: string;
          user_id?: string;
          work_component?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "commission_plans_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "commission_plans_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      commission_tiers: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          effective_from: string;
          effective_to: string | null;
          id: string;
          is_demo: boolean;
          key: string;
          label: string;
          min_amount: number;
          note: string | null;
          payment_type: string | null;
          rate_percent: number;
          sort_order: number;
          updated_at: string;
          work_component: string | null;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          is_demo?: boolean;
          key: string;
          label: string;
          min_amount?: number;
          note?: string | null;
          payment_type?: string | null;
          rate_percent: number;
          sort_order?: number;
          updated_at?: string;
          work_component?: string | null;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          is_demo?: boolean;
          key?: string;
          label?: string;
          min_amount?: number;
          note?: string | null;
          payment_type?: string | null;
          rate_percent?: number;
          sort_order?: number;
          updated_at?: string;
          work_component?: string | null;
        };
        Relationships: [];
      };
      company_credentials: {
        Row: {
          active: boolean;
          carrier: string | null;
          category: string;
          created_at: string;
          created_by: string | null;
          currency: string;
          document_id: string | null;
          effective_date: string | null;
          expiry_date: string | null;
          holder_location_id: string | null;
          holder_user_id: string | null;
          id: string;
          is_demo: boolean;
          issuer: string | null;
          kind: string;
          limit_aggregate: number | null;
          limit_occurrence: number | null;
          name: string | null;
          notes: string | null;
          policy_number: string | null;
          renewal_lead_days: number;
          state_code: string | null;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          carrier?: string | null;
          category: string;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          document_id?: string | null;
          effective_date?: string | null;
          expiry_date?: string | null;
          holder_location_id?: string | null;
          holder_user_id?: string | null;
          id?: string;
          is_demo?: boolean;
          issuer?: string | null;
          kind: string;
          limit_aggregate?: number | null;
          limit_occurrence?: number | null;
          name?: string | null;
          notes?: string | null;
          policy_number?: string | null;
          renewal_lead_days?: number;
          state_code?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          carrier?: string | null;
          category?: string;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          document_id?: string | null;
          effective_date?: string | null;
          expiry_date?: string | null;
          holder_location_id?: string | null;
          holder_user_id?: string | null;
          id?: string;
          is_demo?: boolean;
          issuer?: string | null;
          kind?: string;
          limit_aggregate?: number | null;
          limit_occurrence?: number | null;
          name?: string | null;
          notes?: string | null;
          policy_number?: string | null;
          renewal_lead_days?: number;
          state_code?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "company_credentials_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "company_credentials_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "vendor_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_credentials_holder_location_id_fkey";
            columns: ["holder_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_credentials_holder_user_id_fkey";
            columns: ["holder_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      company_holidays: {
        Row: {
          created_at: string;
          created_by: string | null;
          holiday_date: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          holiday_date: string;
          name: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          holiday_date?: string;
          name?: string;
        };
        Relationships: [];
      };
      compliance_requirement_documents: {
        Row: {
          created_at: string;
          created_by: string | null;
          document_id: string;
          is_demo: boolean;
          requirement_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          document_id: string;
          is_demo?: boolean;
          requirement_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          document_id?: string;
          is_demo?: boolean;
          requirement_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "compliance_requirement_documents_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "compliance_requirement_documents_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "vendor_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_requirement_documents_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_requirements";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_requirement_documents_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_status";
            referencedColumns: ["requirement_id"];
          },
        ];
      };
      compliance_requirement_files: {
        Row: {
          account_id: string;
          cert_sent_at: string | null;
          cert_sent_by: string | null;
          cert_sent_to: string | null;
          covered_amount: number | null;
          created_at: string;
          currency: string;
          effective_date: string | null;
          expiry_date: string | null;
          file_name: string;
          id: string;
          is_current: boolean;
          is_demo: boolean;
          issuer: string | null;
          mime_type: string | null;
          notes: string | null;
          policy_number: string | null;
          requirement_id: string;
          sent_to_agent_at: string | null;
          sent_to_agent_by: string | null;
          size_bytes: number | null;
          slot: string;
          storage_path: string;
          superseded_at: string | null;
          superseded_by: string | null;
          updated_at: string;
          uploaded_by: string | null;
          version: number;
        };
        Insert: {
          account_id: string;
          cert_sent_at?: string | null;
          cert_sent_by?: string | null;
          cert_sent_to?: string | null;
          covered_amount?: number | null;
          created_at?: string;
          currency?: string;
          effective_date?: string | null;
          expiry_date?: string | null;
          file_name: string;
          id?: string;
          is_current?: boolean;
          is_demo?: boolean;
          issuer?: string | null;
          mime_type?: string | null;
          notes?: string | null;
          policy_number?: string | null;
          requirement_id: string;
          sent_to_agent_at?: string | null;
          sent_to_agent_by?: string | null;
          size_bytes?: number | null;
          slot: string;
          storage_path: string;
          superseded_at?: string | null;
          superseded_by?: string | null;
          updated_at?: string;
          uploaded_by?: string | null;
          version?: number;
        };
        Update: {
          account_id?: string;
          cert_sent_at?: string | null;
          cert_sent_by?: string | null;
          cert_sent_to?: string | null;
          covered_amount?: number | null;
          created_at?: string;
          currency?: string;
          effective_date?: string | null;
          expiry_date?: string | null;
          file_name?: string;
          id?: string;
          is_current?: boolean;
          is_demo?: boolean;
          issuer?: string | null;
          mime_type?: string | null;
          notes?: string | null;
          policy_number?: string | null;
          requirement_id?: string;
          sent_to_agent_at?: string | null;
          sent_to_agent_by?: string | null;
          size_bytes?: number | null;
          slot?: string;
          storage_path?: string;
          superseded_at?: string | null;
          superseded_by?: string | null;
          updated_at?: string;
          uploaded_by?: string | null;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "compliance_requirement_files_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_requirements";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_status";
            referencedColumns: ["requirement_id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_sent_to_agent_by_fkey";
            columns: ["sent_to_agent_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_superseded_by_fkey";
            columns: ["superseded_by"];
            isOneToOne: false;
            referencedRelation: "account_compliance_status";
            referencedColumns: ["cert_file_id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_superseded_by_fkey";
            columns: ["superseded_by"];
            isOneToOne: false;
            referencedRelation: "compliance_requirement_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_requirement_files_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      compliance_send_log: {
        Row: {
          account_id: string;
          created_at: string;
          file_id: string | null;
          file_name: string | null;
          id: string;
          is_demo: boolean;
          note: string | null;
          requirement_id: string | null;
          requirement_label: string | null;
          sent_by: string | null;
          status: string;
          subject: string | null;
          to_email: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          created_at?: string;
          file_id?: string | null;
          file_name?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          requirement_id?: string | null;
          requirement_label?: string | null;
          sent_by?: string | null;
          status?: string;
          subject?: string | null;
          to_email: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          created_at?: string;
          file_id?: string | null;
          file_name?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          requirement_id?: string | null;
          requirement_label?: string | null;
          sent_by?: string | null;
          status?: string;
          subject?: string | null;
          to_email?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "compliance_send_log_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "compliance_send_log_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_send_log_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "compliance_send_log_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_status";
            referencedColumns: ["cert_file_id"];
          },
          {
            foreignKeyName: "compliance_send_log_file_id_fkey";
            columns: ["file_id"];
            isOneToOne: false;
            referencedRelation: "compliance_requirement_files";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_send_log_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_requirements";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "compliance_send_log_requirement_id_fkey";
            columns: ["requirement_id"];
            isOneToOne: false;
            referencedRelation: "account_compliance_status";
            referencedColumns: ["requirement_id"];
          },
        ];
      };
      contact_attempts: {
        Row: {
          account_id: string | null;
          author_id: string | null;
          channel: Database["public"]["Enums"]["contact_channel"];
          contact_id: string | null;
          created_at: string;
          duration_seconds: number | null;
          id: string;
          is_demo: boolean;
          lead_id: string;
          notes: string | null;
          occurred_at: string;
          outcome: string | null;
          recording_url: string | null;
        };
        Insert: {
          account_id?: string | null;
          author_id?: string | null;
          channel: Database["public"]["Enums"]["contact_channel"];
          contact_id?: string | null;
          created_at?: string;
          duration_seconds?: number | null;
          id?: string;
          is_demo?: boolean;
          lead_id: string;
          notes?: string | null;
          occurred_at?: string;
          outcome?: string | null;
          recording_url?: string | null;
        };
        Update: {
          account_id?: string | null;
          author_id?: string | null;
          channel?: Database["public"]["Enums"]["contact_channel"];
          contact_id?: string | null;
          created_at?: string;
          duration_seconds?: number | null;
          id?: string;
          is_demo?: boolean;
          lead_id?: string;
          notes?: string | null;
          occurred_at?: string;
          outcome?: string | null;
          recording_url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "contact_attempts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "contact_attempts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_attempts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "contact_attempts_author_id_profiles_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "contact_attempts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "contact_attempts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_attempts_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "fire_leads";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_methods: {
        Row: {
          contact_id: string;
          created_at: string;
          created_by: string | null;
          extension: string | null;
          id: string;
          is_demo: boolean;
          is_preferred: boolean;
          kind: string;
          label: string | null;
          updated_at: string;
          value: string;
        };
        Insert: {
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          extension?: string | null;
          id?: string;
          is_demo?: boolean;
          is_preferred?: boolean;
          kind?: string;
          label?: string | null;
          updated_at?: string;
          value: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          extension?: string | null;
          id?: string;
          is_demo?: boolean;
          is_preferred?: boolean;
          kind?: string;
          label?: string | null;
          updated_at?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_methods_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "contact_methods_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_methods_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      contact_note_dumps: {
        Row: {
          body: string;
          contact_id: string;
          created_at: string;
          created_by: string | null;
          id: string;
          source: string;
        };
        Insert: {
          body: string;
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          source?: string;
        };
        Update: {
          body?: string;
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_note_dumps_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "contact_note_dumps_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_relationship_facts: {
        Row: {
          category_key: string;
          contact_id: string;
          created_at: string;
          created_by: string | null;
          dump_id: string | null;
          id: string;
          source: string;
          updated_at: string;
          value: string;
        };
        Insert: {
          category_key: string;
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          dump_id?: string | null;
          id?: string;
          source?: string;
          updated_at?: string;
          value: string;
        };
        Update: {
          category_key?: string;
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          dump_id?: string | null;
          id?: string;
          source?: string;
          updated_at?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_relationship_facts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "contact_relationship_facts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_relationship_facts_dump_id_fkey";
            columns: ["dump_id"];
            isOneToOne: false;
            referencedRelation: "contact_note_dumps";
            referencedColumns: ["id"];
          },
        ];
      };
      contact_tags: {
        Row: {
          contact_id: string;
          created_at: string;
          created_by: string | null;
          is_demo: boolean;
          tag_id: string;
        };
        Insert: {
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          tag_id: string;
        };
        Update: {
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contact_tags_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "contact_tags_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contact_tags_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "contact_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      contacts: {
        Row: {
          account_id: string | null;
          anniversary_day: number | null;
          anniversary_month: number | null;
          archived_at: string | null;
          archived_by: string | null;
          best_time_to_reach: string | null;
          birthday_day: number | null;
          birthday_month: number | null;
          birthday_year: number | null;
          children: string | null;
          created_at: string;
          created_by: string | null;
          decision_role: string | null;
          decision_role_detail: string | null;
          dietary_notes: string | null;
          dislikes: string | null;
          email: string | null;
          external_id: string | null;
          external_source: string | null;
          family_notes: string | null;
          first_name: string | null;
          full_name: string;
          gift_policy_notes: string | null;
          hobbies: string | null;
          id: string;
          is_decision_maker: boolean;
          is_demo: boolean;
          is_primary: boolean;
          last_name: string | null;
          likes: string | null;
          linkedin_url: string | null;
          location_id: string;
          office_extension: string | null;
          office_phone: string | null;
          personal_preferences: string | null;
          phone: string | null;
          position_key: string | null;
          preferred_contact_method: string | null;
          relationship_notes: string | null;
          reports_to_contact_id: string | null;
          sports_teams: string | null;
          spouse_name: string | null;
          title: string | null;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          anniversary_day?: number | null;
          anniversary_month?: number | null;
          archived_at?: string | null;
          archived_by?: string | null;
          best_time_to_reach?: string | null;
          birthday_day?: number | null;
          birthday_month?: number | null;
          birthday_year?: number | null;
          children?: string | null;
          created_at?: string;
          created_by?: string | null;
          decision_role?: string | null;
          decision_role_detail?: string | null;
          dietary_notes?: string | null;
          dislikes?: string | null;
          email?: string | null;
          external_id?: string | null;
          external_source?: string | null;
          family_notes?: string | null;
          first_name?: string | null;
          full_name: string;
          gift_policy_notes?: string | null;
          hobbies?: string | null;
          id?: string;
          is_decision_maker?: boolean;
          is_demo?: boolean;
          is_primary?: boolean;
          last_name?: string | null;
          likes?: string | null;
          linkedin_url?: string | null;
          location_id: string;
          office_extension?: string | null;
          office_phone?: string | null;
          personal_preferences?: string | null;
          phone?: string | null;
          position_key?: string | null;
          preferred_contact_method?: string | null;
          relationship_notes?: string | null;
          reports_to_contact_id?: string | null;
          sports_teams?: string | null;
          spouse_name?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          anniversary_day?: number | null;
          anniversary_month?: number | null;
          archived_at?: string | null;
          archived_by?: string | null;
          best_time_to_reach?: string | null;
          birthday_day?: number | null;
          birthday_month?: number | null;
          birthday_year?: number | null;
          children?: string | null;
          created_at?: string;
          created_by?: string | null;
          decision_role?: string | null;
          decision_role_detail?: string | null;
          dietary_notes?: string | null;
          dislikes?: string | null;
          email?: string | null;
          external_id?: string | null;
          external_source?: string | null;
          family_notes?: string | null;
          first_name?: string | null;
          full_name?: string;
          gift_policy_notes?: string | null;
          hobbies?: string | null;
          id?: string;
          is_decision_maker?: boolean;
          is_demo?: boolean;
          is_primary?: boolean;
          last_name?: string | null;
          likes?: string | null;
          linkedin_url?: string | null;
          location_id?: string;
          office_extension?: string | null;
          office_phone?: string | null;
          personal_preferences?: string | null;
          phone?: string | null;
          position_key?: string | null;
          preferred_contact_method?: string | null;
          relationship_notes?: string | null;
          reports_to_contact_id?: string | null;
          sports_teams?: string | null;
          spouse_name?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "contacts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "contacts_archived_by_fkey";
            columns: ["archived_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "contacts_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "contacts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "contacts_reports_to_contact_id_fkey";
            columns: ["reports_to_contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "contacts_reports_to_contact_id_fkey";
            columns: ["reports_to_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      conversation_members: {
        Row: {
          conversation_id: string;
          is_admin: boolean;
          is_demo: boolean;
          joined_at: string;
          last_read_at: string;
          muted: boolean;
          user_id: string;
        };
        Insert: {
          conversation_id: string;
          is_admin?: boolean;
          is_demo?: boolean;
          joined_at?: string;
          last_read_at?: string;
          muted?: boolean;
          user_id: string;
        };
        Update: {
          conversation_id?: string;
          is_admin?: boolean;
          is_demo?: boolean;
          joined_at?: string;
          last_read_at?: string;
          muted?: boolean;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversation_members_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "conversation_members_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      conversations: {
        Row: {
          avatar_path: string | null;
          created_at: string;
          created_by: string;
          id: string;
          is_demo: boolean;
          kind: Database["public"]["Enums"]["conversation_kind"];
          last_message_at: string;
          last_message_preview: string | null;
          title: string | null;
          updated_at: string;
        };
        Insert: {
          avatar_path?: string | null;
          created_at?: string;
          created_by: string;
          id?: string;
          is_demo?: boolean;
          kind: Database["public"]["Enums"]["conversation_kind"];
          last_message_at?: string;
          last_message_preview?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Update: {
          avatar_path?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          is_demo?: boolean;
          kind?: Database["public"]["Enums"]["conversation_kind"];
          last_message_at?: string;
          last_message_preview?: string | null;
          title?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "conversations_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      dashboard_layouts: {
        Row: {
          card_key: string;
          created_at: string;
          hidden: boolean;
          id: string;
          position: number;
          role_key: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          card_key: string;
          created_at?: string;
          hidden?: boolean;
          id?: string;
          position?: number;
          role_key: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          card_key?: string;
          created_at?: string;
          hidden?: boolean;
          id?: string;
          position?: number;
          role_key?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      deal_reassignments: {
        Row: {
          account_id: string;
          batch_id: string | null;
          created_at: string;
          created_by: string | null;
          days_in_pipeline: number | null;
          do_differently: string | null;
          from_user_id: string | null;
          id: string;
          is_demo: boolean;
          reason: string;
          reason_note: string | null;
          stage_at_transfer: string | null;
          to_user_id: string;
        };
        Insert: {
          account_id: string;
          batch_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          days_in_pipeline?: number | null;
          do_differently?: string | null;
          from_user_id?: string | null;
          id?: string;
          is_demo?: boolean;
          reason: string;
          reason_note?: string | null;
          stage_at_transfer?: string | null;
          to_user_id: string;
        };
        Update: {
          account_id?: string;
          batch_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          days_in_pipeline?: number | null;
          do_differently?: string | null;
          from_user_id?: string | null;
          id?: string;
          is_demo?: boolean;
          reason?: string;
          reason_note?: string | null;
          stage_at_transfer?: string | null;
          to_user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "deal_reassignments_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "deal_reassignments_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "deal_reassignments_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "deal_reassignments_batch_id_fkey";
            columns: ["batch_id"];
            isOneToOne: false;
            referencedRelation: "reassignment_batches";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "deal_reassignments_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      document_events: {
        Row: {
          actor_id: string | null;
          actor_label: string | null;
          created_at: string;
          detail: Json;
          document_id: string;
          event_type: Database["public"]["Enums"]["document_event_type"];
          id: string;
          ip: unknown;
          is_demo: boolean;
          user_agent: string | null;
        };
        Insert: {
          actor_id?: string | null;
          actor_label?: string | null;
          created_at?: string;
          detail?: Json;
          document_id: string;
          event_type: Database["public"]["Enums"]["document_event_type"];
          id?: string;
          ip?: unknown;
          is_demo?: boolean;
          user_agent?: string | null;
        };
        Update: {
          actor_id?: string | null;
          actor_label?: string | null;
          created_at?: string;
          detail?: Json;
          document_id?: string;
          event_type?: Database["public"]["Enums"]["document_event_type"];
          id?: string;
          ip?: unknown;
          is_demo?: boolean;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "document_events_actor_id_profiles_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "document_events_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
        ];
      };
      document_folders: {
        Row: {
          account_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          job_id: string | null;
          location_id: string;
          name: string;
          parent_folder_id: string | null;
          project_id: string | null;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id?: string | null;
          location_id: string;
          name: string;
          parent_folder_id?: string | null;
          project_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id?: string | null;
          location_id?: string;
          name?: string;
          parent_folder_id?: string | null;
          project_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "document_folders_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "document_folders_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_folders_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "document_folders_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_folders_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_folders_parent_folder_id_fkey";
            columns: ["parent_folder_id"];
            isOneToOne: false;
            referencedRelation: "document_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_folders_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      document_send_items: {
        Row: {
          created_at: string;
          document_id: string;
          id: string;
          packet_id: string;
          requires_signature: boolean;
          sort_order: number;
        };
        Insert: {
          created_at?: string;
          document_id: string;
          id?: string;
          packet_id: string;
          requires_signature?: boolean;
          sort_order?: number;
        };
        Update: {
          created_at?: string;
          document_id?: string;
          id?: string;
          packet_id?: string;
          requires_signature?: boolean;
          sort_order?: number;
        };
        Relationships: [
          {
            foreignKeyName: "document_send_items_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_send_items_packet_id_fkey";
            columns: ["packet_id"];
            isOneToOne: false;
            referencedRelation: "document_send_packets";
            referencedColumns: ["id"];
          },
        ];
      };
      document_send_packets: {
        Row: {
          account_id: string | null;
          completed_at: string | null;
          created_at: string;
          created_by: string | null;
          expires_at: string;
          field_values: Json;
          first_viewed_at: string | null;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          last_reminder_at: string | null;
          location_id: string;
          message: string | null;
          recipient_email: string | null;
          recipient_name: string | null;
          reminder_count: number;
          reminder_days: number;
          replaced_by_packet_id: string | null;
          required_fields: Json;
          revoked_at: string | null;
          sent_at: string | null;
          single_use: boolean;
          subject: string;
          submission_count: number;
          token: string;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          field_values?: Json;
          first_viewed_at?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          last_reminder_at?: string | null;
          location_id: string;
          message?: string | null;
          recipient_email?: string | null;
          recipient_name?: string | null;
          reminder_count?: number;
          reminder_days?: number;
          replaced_by_packet_id?: string | null;
          required_fields?: Json;
          revoked_at?: string | null;
          sent_at?: string | null;
          single_use?: boolean;
          subject: string;
          submission_count?: number;
          token: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          completed_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          expires_at?: string;
          field_values?: Json;
          first_viewed_at?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          last_reminder_at?: string | null;
          location_id?: string;
          message?: string | null;
          recipient_email?: string | null;
          recipient_name?: string | null;
          reminder_count?: number;
          reminder_days?: number;
          replaced_by_packet_id?: string | null;
          required_fields?: Json;
          revoked_at?: string | null;
          sent_at?: string | null;
          single_use?: boolean;
          subject?: string;
          submission_count?: number;
          token?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "document_send_packets_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "document_send_packets_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_send_packets_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "document_send_packets_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_send_packets_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "document_send_packets_replaced_by_packet_id_fkey";
            columns: ["replaced_by_packet_id"];
            isOneToOne: false;
            referencedRelation: "document_send_packets";
            referencedColumns: ["id"];
          },
        ];
      };
      document_signatures: {
        Row: {
          captured_by: string | null;
          created_at: string;
          document_id: string;
          id: string;
          ip: unknown;
          is_demo: boolean;
          lat: number | null;
          lon: number | null;
          page_position: Json | null;
          provider: Database["public"]["Enums"]["signature_provider"];
          provider_ref: string | null;
          signature_data_url: string | null;
          signature_path: string | null;
          signed_at: string;
          signer_email: string | null;
          signer_name: string;
          signer_phone: string | null;
          signer_role: string | null;
          user_agent: string | null;
        };
        Insert: {
          captured_by?: string | null;
          created_at?: string;
          document_id: string;
          id?: string;
          ip?: unknown;
          is_demo?: boolean;
          lat?: number | null;
          lon?: number | null;
          page_position?: Json | null;
          provider?: Database["public"]["Enums"]["signature_provider"];
          provider_ref?: string | null;
          signature_data_url?: string | null;
          signature_path?: string | null;
          signed_at?: string;
          signer_email?: string | null;
          signer_name: string;
          signer_phone?: string | null;
          signer_role?: string | null;
          user_agent?: string | null;
        };
        Update: {
          captured_by?: string | null;
          created_at?: string;
          document_id?: string;
          id?: string;
          ip?: unknown;
          is_demo?: boolean;
          lat?: number | null;
          lon?: number | null;
          page_position?: Json | null;
          provider?: Database["public"]["Enums"]["signature_provider"];
          provider_ref?: string | null;
          signature_data_url?: string | null;
          signature_path?: string | null;
          signed_at?: string;
          signer_email?: string | null;
          signer_name?: string;
          signer_phone?: string | null;
          signer_role?: string | null;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "document_signatures_captured_by_profiles_fkey";
            columns: ["captured_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "document_signatures_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
        ];
      };
      document_template_versions: {
        Row: {
          body: string;
          change_note: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          merge_fields: Json;
          template_id: string;
          version: number;
        };
        Insert: {
          body: string;
          change_note?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          merge_fields?: Json;
          template_id: string;
          version: number;
        };
        Update: {
          body?: string;
          change_note?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          merge_fields?: Json;
          template_id?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "document_template_versions_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "document_template_versions_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "document_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      document_templates: {
        Row: {
          created_at: string;
          created_by: string | null;
          current_version: number;
          description: string | null;
          doc_type: Database["public"]["Enums"]["document_type"];
          id: string;
          is_active: boolean;
          is_demo: boolean;
          location_id: string | null;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          current_version?: number;
          description?: string | null;
          doc_type: Database["public"]["Enums"]["document_type"];
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          location_id?: string | null;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          current_version?: number;
          description?: string | null;
          doc_type?: Database["public"]["Enums"]["document_type"];
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          location_id?: string | null;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "document_templates_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "document_templates_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      documents: {
        Row: {
          account_id: string | null;
          contact_id: string | null;
          content_hash: string | null;
          created_at: string;
          created_by: string | null;
          declined_at: string | null;
          declined_reason: string | null;
          description: string | null;
          doc_type: Database["public"]["Enums"]["document_type"];
          expires_at: string | null;
          expiry_date: string | null;
          external_id: string | null;
          external_source: string | null;
          first_viewed_at: string | null;
          folder_id: string | null;
          id: string;
          incident_id: string | null;
          is_demo: boolean;
          job_id: string | null;
          last_reminder_at: string | null;
          location_id: string;
          locked_at: string | null;
          merge_data: Json;
          mime: string | null;
          name: string;
          project_id: string | null;
          provider: Database["public"]["Enums"]["signature_provider"] | null;
          provider_ref: string | null;
          reminder_count: number;
          rendered_body: string | null;
          sent_at: string | null;
          sent_to: string | null;
          signed_at: string | null;
          size_bytes: number | null;
          status: Database["public"]["Enums"]["document_status"];
          storage_bucket: string | null;
          storage_path: string | null;
          template_id: string | null;
          template_version_id: string | null;
          updated_at: string;
          voided_at: string | null;
          voided_by: string | null;
        };
        Insert: {
          account_id?: string | null;
          contact_id?: string | null;
          content_hash?: string | null;
          created_at?: string;
          created_by?: string | null;
          declined_at?: string | null;
          declined_reason?: string | null;
          description?: string | null;
          doc_type?: Database["public"]["Enums"]["document_type"];
          expires_at?: string | null;
          expiry_date?: string | null;
          external_id?: string | null;
          external_source?: string | null;
          first_viewed_at?: string | null;
          folder_id?: string | null;
          id?: string;
          incident_id?: string | null;
          is_demo?: boolean;
          job_id?: string | null;
          last_reminder_at?: string | null;
          location_id: string;
          locked_at?: string | null;
          merge_data?: Json;
          mime?: string | null;
          name: string;
          project_id?: string | null;
          provider?: Database["public"]["Enums"]["signature_provider"] | null;
          provider_ref?: string | null;
          reminder_count?: number;
          rendered_body?: string | null;
          sent_at?: string | null;
          sent_to?: string | null;
          signed_at?: string | null;
          size_bytes?: number | null;
          status?: Database["public"]["Enums"]["document_status"];
          storage_bucket?: string | null;
          storage_path?: string | null;
          template_id?: string | null;
          template_version_id?: string | null;
          updated_at?: string;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Update: {
          account_id?: string | null;
          contact_id?: string | null;
          content_hash?: string | null;
          created_at?: string;
          created_by?: string | null;
          declined_at?: string | null;
          declined_reason?: string | null;
          description?: string | null;
          doc_type?: Database["public"]["Enums"]["document_type"];
          expires_at?: string | null;
          expiry_date?: string | null;
          external_id?: string | null;
          external_source?: string | null;
          first_viewed_at?: string | null;
          folder_id?: string | null;
          id?: string;
          incident_id?: string | null;
          is_demo?: boolean;
          job_id?: string | null;
          last_reminder_at?: string | null;
          location_id?: string;
          locked_at?: string | null;
          merge_data?: Json;
          mime?: string | null;
          name?: string;
          project_id?: string | null;
          provider?: Database["public"]["Enums"]["signature_provider"] | null;
          provider_ref?: string | null;
          reminder_count?: number;
          rendered_body?: string | null;
          sent_at?: string | null;
          sent_to?: string | null;
          signed_at?: string | null;
          size_bytes?: number | null;
          status?: Database["public"]["Enums"]["document_status"];
          storage_bucket?: string | null;
          storage_path?: string | null;
          template_id?: string | null;
          template_version_id?: string | null;
          updated_at?: string;
          voided_at?: string | null;
          voided_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "documents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "documents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "documents_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "documents_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "documents_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "document_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: false;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "document_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_template_version_id_fkey";
            columns: ["template_version_id"];
            isOneToOne: false;
            referencedRelation: "document_template_versions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "documents_voided_by_profiles_fkey";
            columns: ["voided_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      email_events: {
        Row: {
          created_at: string;
          email_message_id: string | null;
          event_type: string;
          id: string;
          occurred_at: string;
          payload: Json;
          provider: string;
          provider_event_id: string;
          provider_message_id: string | null;
          recipient: string | null;
        };
        Insert: {
          created_at?: string;
          email_message_id?: string | null;
          event_type: string;
          id?: string;
          occurred_at?: string;
          payload?: Json;
          provider?: string;
          provider_event_id: string;
          provider_message_id?: string | null;
          recipient?: string | null;
        };
        Update: {
          created_at?: string;
          email_message_id?: string | null;
          event_type?: string;
          id?: string;
          occurred_at?: string;
          payload?: Json;
          provider?: string;
          provider_event_id?: string;
          provider_message_id?: string | null;
          recipient?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "email_events_email_message_id_fkey";
            columns: ["email_message_id"];
            isOneToOne: false;
            referencedRelation: "email_messages";
            referencedColumns: ["id"];
          },
        ];
      };
      email_logs: {
        Row: {
          account_id: string | null;
          contact_id: string | null;
          counterparty_email: string | null;
          created_at: string;
          direction: string;
          external_id: string;
          id: string;
          is_demo: boolean;
          occurred_at: string;
          preview: string | null;
          provider: Database["public"]["Enums"]["integration_provider"];
          subject: string | null;
          touchpoint_id: string | null;
          user_id: string | null;
        };
        Insert: {
          account_id?: string | null;
          contact_id?: string | null;
          counterparty_email?: string | null;
          created_at?: string;
          direction?: string;
          external_id: string;
          id?: string;
          is_demo?: boolean;
          occurred_at: string;
          preview?: string | null;
          provider?: Database["public"]["Enums"]["integration_provider"];
          subject?: string | null;
          touchpoint_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          account_id?: string | null;
          contact_id?: string | null;
          counterparty_email?: string | null;
          created_at?: string;
          direction?: string;
          external_id?: string;
          id?: string;
          is_demo?: boolean;
          occurred_at?: string;
          preview?: string | null;
          provider?: Database["public"]["Enums"]["integration_provider"];
          subject?: string | null;
          touchpoint_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "email_logs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "email_logs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_logs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "email_logs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "email_logs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_logs_touchpoint_id_fkey";
            columns: ["touchpoint_id"];
            isOneToOne: false;
            referencedRelation: "touchpoints";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_logs_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      email_messages: {
        Row: {
          account_id: string | null;
          attachment_url: string | null;
          attachments: Json;
          body_html: string;
          bounced_at: string | null;
          cancelled_at: string | null;
          category: Database["public"]["Enums"]["email_category"];
          cc_emails: string[];
          claimed_at: string | null;
          contact_id: string | null;
          created_at: string;
          delivered_at: string | null;
          delivery_attempts: number;
          delivery_reason: string | null;
          error: string | null;
          from_name: string | null;
          id: string;
          invoice_id: string | null;
          is_demo: boolean;
          job_id: string | null;
          last_attempt_at: string | null;
          location_id: string | null;
          log_touchpoint: boolean;
          next_attempt_at: string | null;
          opened_at: string | null;
          provider: string | null;
          provider_id: string | null;
          queued_at: string;
          release_at: string | null;
          released_at: string | null;
          reply_to: string | null;
          sent_at: string | null;
          sent_by: string | null;
          sent_from: string | null;
          status: Database["public"]["Enums"]["email_status"];
          subject: string;
          supply_request_id: string | null;
          template_id: string | null;
          template_key: string | null;
          to_emails: string[];
          touchpoint_id: string | null;
        };
        Insert: {
          account_id?: string | null;
          attachment_url?: string | null;
          attachments?: Json;
          body_html: string;
          bounced_at?: string | null;
          cancelled_at?: string | null;
          category?: Database["public"]["Enums"]["email_category"];
          cc_emails?: string[];
          claimed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          delivery_attempts?: number;
          delivery_reason?: string | null;
          error?: string | null;
          from_name?: string | null;
          id?: string;
          invoice_id?: string | null;
          is_demo?: boolean;
          job_id?: string | null;
          last_attempt_at?: string | null;
          location_id?: string | null;
          log_touchpoint?: boolean;
          next_attempt_at?: string | null;
          opened_at?: string | null;
          provider?: string | null;
          provider_id?: string | null;
          queued_at?: string;
          release_at?: string | null;
          released_at?: string | null;
          reply_to?: string | null;
          sent_at?: string | null;
          sent_by?: string | null;
          sent_from?: string | null;
          status?: Database["public"]["Enums"]["email_status"];
          subject: string;
          supply_request_id?: string | null;
          template_id?: string | null;
          template_key?: string | null;
          to_emails: string[];
          touchpoint_id?: string | null;
        };
        Update: {
          account_id?: string | null;
          attachment_url?: string | null;
          attachments?: Json;
          body_html?: string;
          bounced_at?: string | null;
          cancelled_at?: string | null;
          category?: Database["public"]["Enums"]["email_category"];
          cc_emails?: string[];
          claimed_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          delivered_at?: string | null;
          delivery_attempts?: number;
          delivery_reason?: string | null;
          error?: string | null;
          from_name?: string | null;
          id?: string;
          invoice_id?: string | null;
          is_demo?: boolean;
          job_id?: string | null;
          last_attempt_at?: string | null;
          location_id?: string | null;
          log_touchpoint?: boolean;
          next_attempt_at?: string | null;
          opened_at?: string | null;
          provider?: string | null;
          provider_id?: string | null;
          queued_at?: string;
          release_at?: string | null;
          released_at?: string | null;
          reply_to?: string | null;
          sent_at?: string | null;
          sent_by?: string | null;
          sent_from?: string | null;
          status?: Database["public"]["Enums"]["email_status"];
          subject?: string;
          supply_request_id?: string | null;
          template_id?: string | null;
          template_key?: string | null;
          to_emails?: string[];
          touchpoint_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "email_messages_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "email_messages_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_messages_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "email_messages_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "email_messages_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_messages_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_messages_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_messages_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_messages_sent_by_profiles_fkey";
            columns: ["sent_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "email_messages_supply_request_id_fkey";
            columns: ["supply_request_id"];
            isOneToOne: false;
            referencedRelation: "supply_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_messages_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "email_templates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "email_messages_touchpoint_id_fkey";
            columns: ["touchpoint_id"];
            isOneToOne: false;
            referencedRelation: "touchpoints";
            referencedColumns: ["id"];
          },
        ];
      };
      email_templates: {
        Row: {
          body: string;
          category: Database["public"]["Enums"]["email_category"];
          created_at: string;
          created_by: string | null;
          from_name: string | null;
          id: string;
          intake_form: boolean;
          is_active: boolean;
          is_demo: boolean;
          key: string;
          location_id: string | null;
          name: string;
          reply_to: string | null;
          signature: string | null;
          subject: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          body: string;
          category?: Database["public"]["Enums"]["email_category"];
          created_at?: string;
          created_by?: string | null;
          from_name?: string | null;
          id?: string;
          intake_form?: boolean;
          is_active?: boolean;
          is_demo?: boolean;
          key: string;
          location_id?: string | null;
          name: string;
          reply_to?: string | null;
          signature?: string | null;
          subject: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          body?: string;
          category?: Database["public"]["Enums"]["email_category"];
          created_at?: string;
          created_by?: string | null;
          from_name?: string | null;
          id?: string;
          intake_form?: boolean;
          is_active?: boolean;
          is_demo?: boolean;
          key?: string;
          location_id?: string | null;
          name?: string;
          reply_to?: string | null;
          signature?: string | null;
          subject?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "email_templates_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "email_templates_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      equipment: {
        Row: {
          asset_tag: string;
          created_at: string;
          created_by: string | null;
          daily_rate_cents: number | null;
          equipment_type: string;
          equipment_type_detail: string | null;
          external_tracker_id: string | null;
          id: string;
          is_demo: boolean;
          last_lat: number | null;
          last_lon: number | null;
          last_seen_at: string | null;
          location_id: string;
          make: string | null;
          model: string | null;
          notes: string | null;
          purchase_cost_cents: number | null;
          purchase_date: string | null;
          serial_number: string | null;
          status: Database["public"]["Enums"]["equipment_status"];
          tracker_address: string | null;
          tracker_battery_pct: number | null;
          tracker_heartbeat_status: string | null;
          tracker_location_name: string | null;
          tracker_location_status: string | null;
          tracker_provider: string | null;
          tracker_synced_at: string | null;
          updated_at: string;
        };
        Insert: {
          asset_tag: string;
          created_at?: string;
          created_by?: string | null;
          daily_rate_cents?: number | null;
          equipment_type: string;
          equipment_type_detail?: string | null;
          external_tracker_id?: string | null;
          id?: string;
          is_demo?: boolean;
          last_lat?: number | null;
          last_lon?: number | null;
          last_seen_at?: string | null;
          location_id: string;
          make?: string | null;
          model?: string | null;
          notes?: string | null;
          purchase_cost_cents?: number | null;
          purchase_date?: string | null;
          serial_number?: string | null;
          status?: Database["public"]["Enums"]["equipment_status"];
          tracker_address?: string | null;
          tracker_battery_pct?: number | null;
          tracker_heartbeat_status?: string | null;
          tracker_location_name?: string | null;
          tracker_location_status?: string | null;
          tracker_provider?: string | null;
          tracker_synced_at?: string | null;
          updated_at?: string;
        };
        Update: {
          asset_tag?: string;
          created_at?: string;
          created_by?: string | null;
          daily_rate_cents?: number | null;
          equipment_type?: string;
          equipment_type_detail?: string | null;
          external_tracker_id?: string | null;
          id?: string;
          is_demo?: boolean;
          last_lat?: number | null;
          last_lon?: number | null;
          last_seen_at?: string | null;
          location_id?: string;
          make?: string | null;
          model?: string | null;
          notes?: string | null;
          purchase_cost_cents?: number | null;
          purchase_date?: string | null;
          serial_number?: string | null;
          status?: Database["public"]["Enums"]["equipment_status"];
          tracker_address?: string | null;
          tracker_battery_pct?: number | null;
          tracker_heartbeat_status?: string | null;
          tracker_location_name?: string | null;
          tracker_location_status?: string | null;
          tracker_provider?: string | null;
          tracker_synced_at?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "equipment_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "equipment_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      equipment_alerts: {
        Row: {
          detail: string | null;
          equipment_id: string;
          first_seen_at: string;
          id: string;
          job_id: string | null;
          kind: string;
          last_seen_at: string;
          location_id: string | null;
          notified_at: string | null;
          placement_id: string | null;
          resolved_at: string | null;
        };
        Insert: {
          detail?: string | null;
          equipment_id: string;
          first_seen_at?: string;
          id?: string;
          job_id?: string | null;
          kind: string;
          last_seen_at?: string;
          location_id?: string | null;
          notified_at?: string | null;
          placement_id?: string | null;
          resolved_at?: string | null;
        };
        Update: {
          detail?: string | null;
          equipment_id?: string;
          first_seen_at?: string;
          id?: string;
          job_id?: string | null;
          kind?: string;
          last_seen_at?: string;
          location_id?: string | null;
          notified_at?: string | null;
          placement_id?: string | null;
          resolved_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "equipment_alerts_equipment_id_fkey";
            columns: ["equipment_id"];
            isOneToOne: false;
            referencedRelation: "equipment";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "equipment_alerts_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "equipment_alerts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "equipment_alerts_placement_id_fkey";
            columns: ["placement_id"];
            isOneToOne: false;
            referencedRelation: "equipment_placements";
            referencedColumns: ["id"];
          },
        ];
      };
      equipment_placements: {
        Row: {
          created_at: string;
          equipment_id: string;
          expected_retrieval_date: string | null;
          hour_meter_end: number | null;
          hour_meter_start: number | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          notes: string | null;
          placed_at: string;
          placed_by: string | null;
          placed_lat: number | null;
          placed_lon: number | null;
          retrieved_at: string | null;
          retrieved_by: string | null;
          return_condition: Database["public"]["Enums"]["equipment_condition"] | null;
          room_id: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          equipment_id: string;
          expected_retrieval_date?: string | null;
          hour_meter_end?: number | null;
          hour_meter_start?: number | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          notes?: string | null;
          placed_at?: string;
          placed_by?: string | null;
          placed_lat?: number | null;
          placed_lon?: number | null;
          retrieved_at?: string | null;
          retrieved_by?: string | null;
          return_condition?: Database["public"]["Enums"]["equipment_condition"] | null;
          room_id?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          equipment_id?: string;
          expected_retrieval_date?: string | null;
          hour_meter_end?: number | null;
          hour_meter_start?: number | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          notes?: string | null;
          placed_at?: string;
          placed_by?: string | null;
          placed_lat?: number | null;
          placed_lon?: number | null;
          retrieved_at?: string | null;
          retrieved_by?: string | null;
          return_condition?: Database["public"]["Enums"]["equipment_condition"] | null;
          room_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "equipment_placements_equipment_id_fkey";
            columns: ["equipment_id"];
            isOneToOne: false;
            referencedRelation: "equipment";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "equipment_placements_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "equipment_placements_placed_by_profiles_fkey";
            columns: ["placed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "equipment_placements_retrieved_by_profiles_fkey";
            columns: ["retrieved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "equipment_placements_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "job_rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      equipment_tracker_events: {
        Row: {
          battery_pct: number | null;
          created_at: string;
          equipment_id: string | null;
          id: string;
          lat: number | null;
          lon: number | null;
          occurred_at: string;
          provider: string;
          raw: Json;
          tracker_id: string;
        };
        Insert: {
          battery_pct?: number | null;
          created_at?: string;
          equipment_id?: string | null;
          id?: string;
          lat?: number | null;
          lon?: number | null;
          occurred_at: string;
          provider?: string;
          raw?: Json;
          tracker_id: string;
        };
        Update: {
          battery_pct?: number | null;
          created_at?: string;
          equipment_id?: string | null;
          id?: string;
          lat?: number | null;
          lon?: number | null;
          occurred_at?: string;
          provider?: string;
          raw?: Json;
          tracker_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "equipment_tracker_events_equipment_id_fkey";
            columns: ["equipment_id"];
            isOneToOne: false;
            referencedRelation: "equipment";
            referencedColumns: ["id"];
          },
        ];
      };
      escalation_events: {
        Row: {
          created_at: string;
          days_stale: number;
          id: string;
          is_demo: boolean;
          last_movement_at: string | null;
          location_id: string;
          notified_at: string;
          notified_user_id: string | null;
          owner_user_id: string | null;
          record_id: string;
          record_label: string | null;
          record_status: string | null;
          record_type: Database["public"]["Enums"]["escalation_record_type"];
          resolution_note: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          rule_id: string;
          state: Database["public"]["Enums"]["escalation_event_state"];
          step: number;
          target_kind: Database["public"]["Enums"]["escalation_target_kind"];
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          days_stale?: number;
          id?: string;
          is_demo?: boolean;
          last_movement_at?: string | null;
          location_id: string;
          notified_at?: string;
          notified_user_id?: string | null;
          owner_user_id?: string | null;
          record_id: string;
          record_label?: string | null;
          record_status?: string | null;
          record_type: Database["public"]["Enums"]["escalation_record_type"];
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          rule_id: string;
          state?: Database["public"]["Enums"]["escalation_event_state"];
          step?: number;
          target_kind: Database["public"]["Enums"]["escalation_target_kind"];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          days_stale?: number;
          id?: string;
          is_demo?: boolean;
          last_movement_at?: string | null;
          location_id?: string;
          notified_at?: string;
          notified_user_id?: string | null;
          owner_user_id?: string | null;
          record_id?: string;
          record_label?: string | null;
          record_status?: string | null;
          record_type?: Database["public"]["Enums"]["escalation_record_type"];
          resolution_note?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          rule_id?: string;
          state?: Database["public"]["Enums"]["escalation_event_state"];
          step?: number;
          target_kind?: Database["public"]["Enums"]["escalation_target_kind"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "escalation_events_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "escalation_events_notified_user_id_profiles_fkey";
            columns: ["notified_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "escalation_events_owner_user_id_profiles_fkey";
            columns: ["owner_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "escalation_events_resolved_by_profiles_fkey";
            columns: ["resolved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "escalation_events_rule_id_fkey";
            columns: ["rule_id"];
            isOneToOne: false;
            referencedRelation: "escalation_rules";
            referencedColumns: ["id"];
          },
        ];
      };
      escalation_rules: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          location_id: string;
          name: string;
          record_type: Database["public"]["Enums"]["escalation_record_type"];
          stale_days: number;
          statuses: string[];
          step2_days: number | null;
          step2_target_kind: Database["public"]["Enums"]["escalation_target_kind"] | null;
          step2_target_user_id: string | null;
          step3_days: number | null;
          step3_target_kind: Database["public"]["Enums"]["escalation_target_kind"] | null;
          step3_target_user_id: string | null;
          target_kind: Database["public"]["Enums"]["escalation_target_kind"];
          target_user_id: string | null;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id: string;
          name: string;
          record_type: Database["public"]["Enums"]["escalation_record_type"];
          stale_days: number;
          statuses?: string[];
          step2_days?: number | null;
          step2_target_kind?: Database["public"]["Enums"]["escalation_target_kind"] | null;
          step2_target_user_id?: string | null;
          step3_days?: number | null;
          step3_target_kind?: Database["public"]["Enums"]["escalation_target_kind"] | null;
          step3_target_user_id?: string | null;
          target_kind?: Database["public"]["Enums"]["escalation_target_kind"];
          target_user_id?: string | null;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string;
          name?: string;
          record_type?: Database["public"]["Enums"]["escalation_record_type"];
          stale_days?: number;
          statuses?: string[];
          step2_days?: number | null;
          step2_target_kind?: Database["public"]["Enums"]["escalation_target_kind"] | null;
          step2_target_user_id?: string | null;
          step3_days?: number | null;
          step3_target_kind?: Database["public"]["Enums"]["escalation_target_kind"] | null;
          step3_target_user_id?: string | null;
          target_kind?: Database["public"]["Enums"]["escalation_target_kind"];
          target_user_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "escalation_rules_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "escalation_rules_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "escalation_rules_step2_target_user_id_profiles_fkey";
            columns: ["step2_target_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "escalation_rules_step3_target_user_id_profiles_fkey";
            columns: ["step3_target_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "escalation_rules_target_user_id_profiles_fkey";
            columns: ["target_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      estimate_catalog_items: {
        Row: {
          code: string;
          created_at: string;
          default_cost: number;
          default_unit_price: number;
          description: string | null;
          header_id: string | null;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          name: string;
          short_name: string | null;
          sort_order: number;
          taxable: boolean;
          uom: string;
          updated_at: string;
        };
        Insert: {
          code: string;
          created_at?: string;
          default_cost?: number;
          default_unit_price?: number;
          description?: string | null;
          header_id?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name: string;
          short_name?: string | null;
          sort_order?: number;
          taxable?: boolean;
          uom?: string;
          updated_at?: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          default_cost?: number;
          default_unit_price?: number;
          description?: string | null;
          header_id?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name?: string;
          short_name?: string | null;
          sort_order?: number;
          taxable?: boolean;
          uom?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "estimate_catalog_items_header_id_fkey";
            columns: ["header_id"];
            isOneToOne: false;
            referencedRelation: "estimate_headers";
            referencedColumns: ["id"];
          },
        ];
      };
      estimate_headers: {
        Row: {
          code: string;
          created_at: string;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          name: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          code: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      estimate_lines: {
        Row: {
          catalog_item_id: string | null;
          code: string | null;
          created_at: string;
          description: string | null;
          estimate_id: string;
          id: string;
          is_discount: boolean;
          name: string;
          note: string | null;
          position: number;
          quantity: number;
          scope_id: string | null;
          short_name: string | null;
          subtotal: number | null;
          taxable: boolean;
          unit_cost: number;
          unit_price: number;
          uom: string;
          updated_at: string;
        };
        Insert: {
          catalog_item_id?: string | null;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          estimate_id: string;
          id?: string;
          is_discount?: boolean;
          name: string;
          note?: string | null;
          position?: number;
          quantity?: number;
          scope_id?: string | null;
          short_name?: string | null;
          subtotal?: number | null;
          taxable?: boolean;
          unit_cost?: number;
          unit_price?: number;
          uom?: string;
          updated_at?: string;
        };
        Update: {
          catalog_item_id?: string | null;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          estimate_id?: string;
          id?: string;
          is_discount?: boolean;
          name?: string;
          note?: string | null;
          position?: number;
          quantity?: number;
          scope_id?: string | null;
          short_name?: string | null;
          subtotal?: number | null;
          taxable?: boolean;
          unit_cost?: number;
          unit_price?: number;
          uom?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "estimate_lines_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "estimate_catalog_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "estimate_lines_estimate_id_fkey";
            columns: ["estimate_id"];
            isOneToOne: false;
            referencedRelation: "estimates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "estimate_lines_scope_id_fkey";
            columns: ["scope_id"];
            isOneToOne: false;
            referencedRelation: "estimate_scopes";
            referencedColumns: ["id"];
          },
        ];
      };
      estimate_scope_template_lines: {
        Row: {
          catalog_item_id: string | null;
          code: string | null;
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          position: number;
          quantity: number;
          taxable: boolean;
          template_id: string;
          unit_cost: number;
          unit_price: number;
          uom: string;
        };
        Insert: {
          catalog_item_id?: string | null;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          position?: number;
          quantity?: number;
          taxable?: boolean;
          template_id: string;
          unit_cost?: number;
          unit_price?: number;
          uom?: string;
        };
        Update: {
          catalog_item_id?: string | null;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          position?: number;
          quantity?: number;
          taxable?: boolean;
          template_id?: string;
          unit_cost?: number;
          unit_price?: number;
          uom?: string;
        };
        Relationships: [
          {
            foreignKeyName: "estimate_scope_template_lines_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "estimate_catalog_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "estimate_scope_template_lines_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "estimate_scope_templates";
            referencedColumns: ["id"];
          },
        ];
      };
      estimate_scope_templates: {
        Row: {
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "estimate_scope_templates_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "estimate_scope_templates_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      estimate_scopes: {
        Row: {
          created_at: string;
          estimate_id: string;
          id: string;
          name: string;
          notes: string | null;
          position: number;
          room_name: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          estimate_id: string;
          id?: string;
          name: string;
          notes?: string | null;
          position?: number;
          room_name?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          estimate_id?: string;
          id?: string;
          name?: string;
          notes?: string | null;
          position?: number;
          room_name?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "estimate_scopes_estimate_id_fkey";
            columns: ["estimate_id"];
            isOneToOne: false;
            referencedRelation: "estimates";
            referencedColumns: ["id"];
          },
        ];
      };
      estimates: {
        Row: {
          account_id: string | null;
          address: string | null;
          address_line2: string | null;
          call_date: string | null;
          closing_statement: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          current_version: number;
          customer_name: string | null;
          decided_at: string | null;
          estimate_date: string;
          id: string;
          is_demo: boolean;
          job_id: string;
          job_number: string | null;
          locality: string | null;
          location_id: string;
          notes: string | null;
          office_address: string | null;
          office_email: string | null;
          office_name: string | null;
          office_phone: string | null;
          postal_code: string | null;
          region: string | null;
          sent_at: string | null;
          seq: number | null;
          status: Database["public"]["Enums"]["estimate_status"];
          subtotal: number;
          tax: number;
          tax_rate: number;
          title: string | null;
          total: number;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          address?: string | null;
          address_line2?: string | null;
          call_date?: string | null;
          closing_statement?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          current_version?: number;
          customer_name?: string | null;
          decided_at?: string | null;
          estimate_date?: string;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          job_number?: string | null;
          locality?: string | null;
          location_id: string;
          notes?: string | null;
          office_address?: string | null;
          office_email?: string | null;
          office_name?: string | null;
          office_phone?: string | null;
          postal_code?: string | null;
          region?: string | null;
          sent_at?: string | null;
          seq?: number | null;
          status?: Database["public"]["Enums"]["estimate_status"];
          subtotal?: number;
          tax?: number;
          tax_rate?: number;
          title?: string | null;
          total?: number;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          address?: string | null;
          address_line2?: string | null;
          call_date?: string | null;
          closing_statement?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          current_version?: number;
          customer_name?: string | null;
          decided_at?: string | null;
          estimate_date?: string;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          job_number?: string | null;
          locality?: string | null;
          location_id?: string;
          notes?: string | null;
          office_address?: string | null;
          office_email?: string | null;
          office_name?: string | null;
          office_phone?: string | null;
          postal_code?: string | null;
          region?: string | null;
          sent_at?: string | null;
          seq?: number | null;
          status?: Database["public"]["Enums"]["estimate_status"];
          subtotal?: number;
          tax?: number;
          tax_rate?: number;
          title?: string | null;
          total?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "estimates_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "estimates_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "estimates_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "estimates_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "estimates_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "estimates_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "estimates_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "estimates_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      expense_requests: {
        Row: {
          account_id: string | null;
          amount: number;
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          decision_note: string | null;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          kind: string;
          location_id: string | null;
          merchant: string | null;
          purpose: string;
          requested_at: string;
          status: Database["public"]["Enums"]["expense_request_status"];
          threshold_at_request: number | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          account_id?: string | null;
          amount: number;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          kind?: string;
          location_id?: string | null;
          merchant?: string | null;
          purpose: string;
          requested_at?: string;
          status?: Database["public"]["Enums"]["expense_request_status"];
          threshold_at_request?: number | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          account_id?: string | null;
          amount?: number;
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          decision_note?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          kind?: string;
          location_id?: string | null;
          merchant?: string | null;
          purpose?: string;
          requested_at?: string;
          status?: Database["public"]["Enums"]["expense_request_status"];
          threshold_at_request?: number | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "expense_requests_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "expense_requests_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "expense_requests_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "expense_requests_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "expense_requests_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "expense_requests_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      expense_thresholds: {
        Row: {
          amount: number;
          created_at: string;
          created_by: string | null;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          role: Database["public"]["Enums"]["app_role"] | null;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          amount?: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          role?: Database["public"]["Enums"]["app_role"] | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          amount?: number;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          role?: Database["public"]["Enums"]["app_role"] | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "expense_thresholds_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "expense_thresholds_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      expenses: {
        Row: {
          account_id: string | null;
          amount: number;
          card_last4: string | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          kind: string;
          location_id: string | null;
          merchant: string | null;
          receipt_path: string | null;
          recurrence: string;
          recurring_from: string | null;
          recurring_until: string | null;
          reimbursed: boolean;
          reimbursed_at: string | null;
          request_id: string | null;
          spent_on: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          account_id?: string | null;
          amount: number;
          card_last4?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          kind: string;
          location_id?: string | null;
          merchant?: string | null;
          receipt_path?: string | null;
          recurrence?: string;
          recurring_from?: string | null;
          recurring_until?: string | null;
          reimbursed?: boolean;
          reimbursed_at?: string | null;
          request_id?: string | null;
          spent_on?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          account_id?: string | null;
          amount?: number;
          card_last4?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          kind?: string;
          location_id?: string | null;
          merchant?: string | null;
          receipt_path?: string | null;
          recurrence?: string;
          recurring_from?: string | null;
          recurring_until?: string | null;
          reimbursed?: boolean;
          reimbursed_at?: string | null;
          request_id?: string | null;
          spent_on?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "expenses_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "expenses_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "expenses_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "expenses_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "expenses_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "expenses_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "expenses_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "expense_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "expenses_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      export_audit: {
        Row: {
          created_at: string;
          entity: string;
          filters: Json;
          format: string;
          id: string;
          record_count: number;
          surface: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          entity: string;
          filters?: Json;
          format?: string;
          id?: string;
          record_count?: number;
          surface: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          entity?: string;
          filters?: Json;
          format?: string;
          id?: string;
          record_count?: number;
          surface?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "export_audit_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      feature_request_attachments: {
        Row: {
          byte_size: number | null;
          created_at: string;
          display_path: string | null;
          file_name: string | null;
          height: number | null;
          id: string;
          mime_type: string;
          request_id: string;
          storage_path: string;
          uploaded_by: string | null;
          width: number | null;
        };
        Insert: {
          byte_size?: number | null;
          created_at?: string;
          display_path?: string | null;
          file_name?: string | null;
          height?: number | null;
          id?: string;
          mime_type: string;
          request_id: string;
          storage_path: string;
          uploaded_by?: string | null;
          width?: number | null;
        };
        Update: {
          byte_size?: number | null;
          created_at?: string;
          display_path?: string | null;
          file_name?: string | null;
          height?: number | null;
          id?: string;
          mime_type?: string;
          request_id?: string;
          storage_path?: string;
          uploaded_by?: string | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "feature_request_attachments_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "feature_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "feature_request_attachments_uploaded_by_fkey";
            columns: ["uploaded_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      feature_request_comments: {
        Row: {
          author: string | null;
          body: string;
          created_at: string;
          id: string;
          is_demo: boolean;
          request_id: string;
          updated_at: string;
        };
        Insert: {
          author?: string | null;
          body: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          request_id: string;
          updated_at?: string;
        };
        Update: {
          author?: string | null;
          body?: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          request_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "feature_request_comments_author_fkey";
            columns: ["author"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "feature_request_comments_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "feature_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      feature_request_status_history: {
        Row: {
          changed_by: string | null;
          created_at: string;
          from_status: Database["public"]["Enums"]["feature_request_status"] | null;
          id: string;
          is_demo: boolean;
          note: string | null;
          request_id: string;
          to_status: Database["public"]["Enums"]["feature_request_status"];
        };
        Insert: {
          changed_by?: string | null;
          created_at?: string;
          from_status?: Database["public"]["Enums"]["feature_request_status"] | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          request_id: string;
          to_status: Database["public"]["Enums"]["feature_request_status"];
        };
        Update: {
          changed_by?: string | null;
          created_at?: string;
          from_status?: Database["public"]["Enums"]["feature_request_status"] | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          request_id?: string;
          to_status?: Database["public"]["Enums"]["feature_request_status"];
        };
        Relationships: [
          {
            foreignKeyName: "feature_request_status_history_changed_by_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "feature_request_status_history_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "feature_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      feature_request_votes: {
        Row: {
          created_at: string;
          is_demo: boolean;
          request_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          is_demo?: boolean;
          request_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          is_demo?: boolean;
          request_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "feature_request_votes_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "feature_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "feature_request_votes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      feature_requests: {
        Row: {
          category: string;
          created_at: string;
          description: string;
          dismissed_at: string | null;
          dismissed_reason: string | null;
          duplicate_of: string | null;
          id: string;
          is_demo: boolean;
          priority: Database["public"]["Enums"]["feature_request_priority"] | null;
          status: Database["public"]["Enums"]["feature_request_status"];
          submitted_by: string | null;
          submitter_job_title: string | null;
          submitter_location_id: string | null;
          submitter_location_name: string | null;
          submitter_name: string | null;
          submitter_role: string | null;
          title: string;
          updated_at: string;
        };
        Insert: {
          category?: string;
          created_at?: string;
          description?: string;
          dismissed_at?: string | null;
          dismissed_reason?: string | null;
          duplicate_of?: string | null;
          id?: string;
          is_demo?: boolean;
          priority?: Database["public"]["Enums"]["feature_request_priority"] | null;
          status?: Database["public"]["Enums"]["feature_request_status"];
          submitted_by?: string | null;
          submitter_job_title?: string | null;
          submitter_location_id?: string | null;
          submitter_location_name?: string | null;
          submitter_name?: string | null;
          submitter_role?: string | null;
          title: string;
          updated_at?: string;
        };
        Update: {
          category?: string;
          created_at?: string;
          description?: string;
          dismissed_at?: string | null;
          dismissed_reason?: string | null;
          duplicate_of?: string | null;
          id?: string;
          is_demo?: boolean;
          priority?: Database["public"]["Enums"]["feature_request_priority"] | null;
          status?: Database["public"]["Enums"]["feature_request_status"];
          submitted_by?: string | null;
          submitter_job_title?: string | null;
          submitter_location_id?: string | null;
          submitter_location_name?: string | null;
          submitter_name?: string | null;
          submitter_role?: string | null;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "feature_requests_duplicate_of_fkey";
            columns: ["duplicate_of"];
            isOneToOne: false;
            referencedRelation: "feature_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "feature_requests_submitted_by_fkey";
            columns: ["submitted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "feature_requests_submitter_location_id_fkey";
            columns: ["submitter_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      field_permissions: {
        Row: {
          entity: string;
          field: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          updated_at: string;
          updated_by: string | null;
          visible: boolean;
        };
        Insert: {
          entity?: string;
          field: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          updated_at?: string;
          updated_by?: string | null;
          visible?: boolean;
        };
        Update: {
          entity?: string;
          field?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          updated_at?: string;
          updated_by?: string | null;
          visible?: boolean;
        };
        Relationships: [];
      };
      field_ticket_crew_reviews: {
        Row: {
          created_at: string;
          crew_class: string;
          headcount_override: number | null;
          id: string;
          is_demo: boolean;
          minutes_each_override: number | null;
          note: string | null;
          review_state: string;
          reviewed_at: string;
          reviewed_by: string | null;
          ticket_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          crew_class: string;
          headcount_override?: number | null;
          id?: string;
          is_demo?: boolean;
          minutes_each_override?: number | null;
          note?: string | null;
          review_state: string;
          reviewed_at?: string;
          reviewed_by?: string | null;
          ticket_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          crew_class?: string;
          headcount_override?: number | null;
          id?: string;
          is_demo?: boolean;
          minutes_each_override?: number | null;
          note?: string | null;
          review_state?: string;
          reviewed_at?: string;
          reviewed_by?: string | null;
          ticket_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "field_ticket_crew_reviews_ticket_id_fkey";
            columns: ["ticket_id"];
            isOneToOne: false;
            referencedRelation: "field_work_tickets";
            referencedColumns: ["id"];
          },
        ];
      };
      field_work_tickets: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          captured_at: string | null;
          created_at: string;
          created_by: string | null;
          crew_chief_name: string | null;
          document_id: string | null;
          equip_air_mover: number | null;
          equip_dehumidifier: number | null;
          equip_generator: number | null;
          equip_hydroxyl: number | null;
          equip_injector: number | null;
          equip_ozone: number | null;
          equip_scrubber: number | null;
          equipment_left_tags: string[];
          gsr_crew_size: number | null;
          id: string;
          job_address: string | null;
          job_completed: boolean;
          job_end_time: string | null;
          job_id: string;
          job_start_time: string | null;
          job_types: string[];
          location_id: string;
          materials_used: string[];
          more_work_needed: boolean;
          scope_completed: string[];
          source: string;
          temp_crew_size: number | null;
          trash_disposition: string | null;
          unit_number: string | null;
          updated_at: string;
          work_date: string;
          work_notes: string | null;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          captured_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          crew_chief_name?: string | null;
          document_id?: string | null;
          equip_air_mover?: number | null;
          equip_dehumidifier?: number | null;
          equip_generator?: number | null;
          equip_hydroxyl?: number | null;
          equip_injector?: number | null;
          equip_ozone?: number | null;
          equip_scrubber?: number | null;
          equipment_left_tags?: string[];
          gsr_crew_size?: number | null;
          id?: string;
          job_address?: string | null;
          job_completed?: boolean;
          job_end_time?: string | null;
          job_id: string;
          job_start_time?: string | null;
          job_types?: string[];
          location_id: string;
          materials_used?: string[];
          more_work_needed?: boolean;
          scope_completed?: string[];
          source?: string;
          temp_crew_size?: number | null;
          trash_disposition?: string | null;
          unit_number?: string | null;
          updated_at?: string;
          work_date?: string;
          work_notes?: string | null;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          captured_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          crew_chief_name?: string | null;
          document_id?: string | null;
          equip_air_mover?: number | null;
          equip_dehumidifier?: number | null;
          equip_generator?: number | null;
          equip_hydroxyl?: number | null;
          equip_injector?: number | null;
          equip_ozone?: number | null;
          equip_scrubber?: number | null;
          equipment_left_tags?: string[];
          gsr_crew_size?: number | null;
          id?: string;
          job_address?: string | null;
          job_completed?: boolean;
          job_end_time?: string | null;
          job_id?: string;
          job_start_time?: string | null;
          job_types?: string[];
          location_id?: string;
          materials_used?: string[];
          more_work_needed?: boolean;
          scope_completed?: string[];
          source?: string;
          temp_crew_size?: number | null;
          trash_disposition?: string | null;
          unit_number?: string | null;
          updated_at?: string;
          work_date?: string;
          work_notes?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "field_work_tickets_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "field_work_tickets_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "field_work_tickets_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      fire_feed_areas: {
        Row: {
          active: boolean;
          center_lat: number | null;
          center_lon: number | null;
          county: string | null;
          created_at: string;
          id: string;
          label: string;
          locality: string | null;
          location_id: string | null;
          postal_codes: string[];
          radius_miles: number;
          state: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          active?: boolean;
          center_lat?: number | null;
          center_lon?: number | null;
          county?: string | null;
          created_at?: string;
          id?: string;
          label: string;
          locality?: string | null;
          location_id?: string | null;
          postal_codes?: string[];
          radius_miles?: number;
          state: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          active?: boolean;
          center_lat?: number | null;
          center_lon?: number | null;
          county?: string | null;
          created_at?: string;
          id?: string;
          label?: string;
          locality?: string | null;
          location_id?: string | null;
          postal_codes?: string[];
          radius_miles?: number;
          state?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fire_feed_areas_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      fire_feed_cursors: {
        Row: {
          cursor: string;
          query_key: string;
          source_id: string;
          updated_at: string;
        };
        Insert: {
          cursor: string;
          query_key: string;
          source_id: string;
          updated_at?: string;
        };
        Update: {
          cursor?: string;
          query_key?: string;
          source_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fire_feed_cursors_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "fire_feed_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      fire_feed_items: {
        Row: {
          area_id: string | null;
          created_at: string;
          decision: string;
          extracted_by: string | null;
          extraction: Json | null;
          id: string;
          incident_id: string | null;
          item_key: string;
          published_at: string | null;
          publisher: string | null;
          reason: string | null;
          run_id: string | null;
          source_id: string | null;
          source_kind: string;
          title: string | null;
          url: string | null;
        };
        Insert: {
          area_id?: string | null;
          created_at?: string;
          decision: string;
          extracted_by?: string | null;
          extraction?: Json | null;
          id?: string;
          incident_id?: string | null;
          item_key: string;
          published_at?: string | null;
          publisher?: string | null;
          reason?: string | null;
          run_id?: string | null;
          source_id?: string | null;
          source_kind: string;
          title?: string | null;
          url?: string | null;
        };
        Update: {
          area_id?: string | null;
          created_at?: string;
          decision?: string;
          extracted_by?: string | null;
          extraction?: Json | null;
          id?: string;
          incident_id?: string | null;
          item_key?: string;
          published_at?: string | null;
          publisher?: string | null;
          reason?: string | null;
          run_id?: string | null;
          source_id?: string | null;
          source_kind?: string;
          title?: string | null;
          url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fire_feed_items_area_id_fkey";
            columns: ["area_id"];
            isOneToOne: false;
            referencedRelation: "fire_feed_areas";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fire_feed_items_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: false;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fire_feed_items_run_id_fkey";
            columns: ["run_id"];
            isOneToOne: false;
            referencedRelation: "fire_feed_runs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fire_feed_items_source_id_fkey";
            columns: ["source_id"];
            isOneToOne: false;
            referencedRelation: "fire_feed_sources";
            referencedColumns: ["id"];
          },
        ];
      };
      fire_feed_runs: {
        Row: {
          decisions: Json | null;
          deferred: number;
          dry_run: boolean;
          errors: Json;
          extractor: Json;
          fetched: Json;
          finished_at: string | null;
          id: string;
          leads_created: number;
          merged: number;
          new_items: number;
          skipped: Json;
          started_at: string;
          status: string;
          trigger: string;
          triggered_by: string | null;
        };
        Insert: {
          decisions?: Json | null;
          deferred?: number;
          dry_run?: boolean;
          errors?: Json;
          extractor?: Json;
          fetched?: Json;
          finished_at?: string | null;
          id?: string;
          leads_created?: number;
          merged?: number;
          new_items?: number;
          skipped?: Json;
          started_at?: string;
          status?: string;
          trigger?: string;
          triggered_by?: string | null;
        };
        Update: {
          decisions?: Json | null;
          deferred?: number;
          dry_run?: boolean;
          errors?: Json;
          extractor?: Json;
          fetched?: Json;
          finished_at?: string | null;
          id?: string;
          leads_created?: number;
          merged?: number;
          new_items?: number;
          skipped?: Json;
          started_at?: string;
          status?: string;
          trigger?: string;
          triggered_by?: string | null;
        };
        Relationships: [];
      };
      fire_feed_sources: {
        Row: {
          area_id: string | null;
          config: Json;
          created_at: string;
          enabled: boolean;
          etag: string | null;
          id: string;
          kind: string;
          label: string;
          last_error: string | null;
          last_fetched_at: string | null;
          last_modified: string | null;
          last_status: number | null;
          poll_minutes: number;
          updated_at: string;
          updated_by: string | null;
          url: string | null;
        };
        Insert: {
          area_id?: string | null;
          config?: Json;
          created_at?: string;
          enabled?: boolean;
          etag?: string | null;
          id?: string;
          kind: string;
          label: string;
          last_error?: string | null;
          last_fetched_at?: string | null;
          last_modified?: string | null;
          last_status?: number | null;
          poll_minutes?: number;
          updated_at?: string;
          updated_by?: string | null;
          url?: string | null;
        };
        Update: {
          area_id?: string | null;
          config?: Json;
          created_at?: string;
          enabled?: boolean;
          etag?: string | null;
          id?: string;
          kind?: string;
          label?: string;
          last_error?: string | null;
          last_fetched_at?: string | null;
          last_modified?: string | null;
          last_status?: number | null;
          poll_minutes?: number;
          updated_at?: string;
          updated_by?: string | null;
          url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "fire_feed_sources_area_id_fkey";
            columns: ["area_id"];
            isOneToOne: false;
            referencedRelation: "fire_feed_areas";
            referencedColumns: ["id"];
          },
        ];
      };
      fire_leads: {
        Row: {
          account_id: string | null;
          address: string | null;
          agent_mailing_address: string | null;
          agent_name: string | null;
          approval_due_on: string | null;
          approval_state: string;
          approved_at: string | null;
          approved_by: string | null;
          archived_at: string | null;
          archived_by: string | null;
          assigned_rep: string | null;
          contact_email: string | null;
          contact_name: string | null;
          contact_phone: string | null;
          created_at: string;
          created_by: string | null;
          expected_close_date: string | null;
          geom: unknown;
          id: string;
          incident_date: string | null;
          intake_kind: string;
          is_demo: boolean;
          jurisdiction: string;
          lat: number | null;
          locality: string | null;
          location_id: string | null;
          lon: number | null;
          neighborhood: string | null;
          org_name: string | null;
          owner_mailing_address: string | null;
          owner_name: string | null;
          owner_role: string | null;
          pipeline_stage: Database["public"]["Enums"]["pipeline_stage"];
          postal_code: string | null;
          priority: number;
          region: string | null;
          rescind_date: string | null;
          source_first_seen_at: string;
          source_last_synced_at: string;
          source_record_id: string;
          source_ref: Json;
          source_system: string;
          stage_changed_at: string;
          status: Database["public"]["Enums"]["lead_status"];
          title: string | null;
          units_vacated: number | null;
          updated_at: string;
          vacate_type: string | null;
          value_amount: number | null;
        };
        Insert: {
          account_id?: string | null;
          address?: string | null;
          agent_mailing_address?: string | null;
          agent_name?: string | null;
          approval_due_on?: string | null;
          approval_state?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          archived_at?: string | null;
          archived_by?: string | null;
          assigned_rep?: string | null;
          contact_email?: string | null;
          contact_name?: string | null;
          contact_phone?: string | null;
          created_at?: string;
          created_by?: string | null;
          expected_close_date?: string | null;
          geom?: unknown;
          id?: string;
          incident_date?: string | null;
          intake_kind?: string;
          is_demo?: boolean;
          jurisdiction?: string;
          lat?: number | null;
          locality?: string | null;
          location_id?: string | null;
          lon?: number | null;
          neighborhood?: string | null;
          org_name?: string | null;
          owner_mailing_address?: string | null;
          owner_name?: string | null;
          owner_role?: string | null;
          pipeline_stage?: Database["public"]["Enums"]["pipeline_stage"];
          postal_code?: string | null;
          priority?: number;
          region?: string | null;
          rescind_date?: string | null;
          source_first_seen_at?: string;
          source_last_synced_at?: string;
          source_record_id?: string;
          source_ref?: Json;
          source_system?: string;
          stage_changed_at?: string;
          status?: Database["public"]["Enums"]["lead_status"];
          title?: string | null;
          units_vacated?: number | null;
          updated_at?: string;
          vacate_type?: string | null;
          value_amount?: number | null;
        };
        Update: {
          account_id?: string | null;
          address?: string | null;
          agent_mailing_address?: string | null;
          agent_name?: string | null;
          approval_due_on?: string | null;
          approval_state?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          archived_at?: string | null;
          archived_by?: string | null;
          assigned_rep?: string | null;
          contact_email?: string | null;
          contact_name?: string | null;
          contact_phone?: string | null;
          created_at?: string;
          created_by?: string | null;
          expected_close_date?: string | null;
          geom?: unknown;
          id?: string;
          incident_date?: string | null;
          intake_kind?: string;
          is_demo?: boolean;
          jurisdiction?: string;
          lat?: number | null;
          locality?: string | null;
          location_id?: string | null;
          lon?: number | null;
          neighborhood?: string | null;
          org_name?: string | null;
          owner_mailing_address?: string | null;
          owner_name?: string | null;
          owner_role?: string | null;
          pipeline_stage?: Database["public"]["Enums"]["pipeline_stage"];
          postal_code?: string | null;
          priority?: number;
          region?: string | null;
          rescind_date?: string | null;
          source_first_seen_at?: string;
          source_last_synced_at?: string;
          source_record_id?: string;
          source_ref?: Json;
          source_system?: string;
          stage_changed_at?: string;
          status?: Database["public"]["Enums"]["lead_status"];
          title?: string | null;
          units_vacated?: number | null;
          updated_at?: string;
          vacate_type?: string | null;
          value_amount?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "fire_leads_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "fire_leads_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "fire_leads_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "fire_leads_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "fire_leads_archived_by_fkey";
            columns: ["archived_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "fire_leads_assigned_rep_profiles_fkey";
            columns: ["assigned_rep"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "fire_leads_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "fire_leads_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      followup_rules: {
        Row: {
          created_at: string;
          created_by: string | null;
          due_in_days: number;
          id: string;
          is_active: boolean;
          name: string;
          priority: Database["public"]["Enums"]["task_priority"];
          require_meeting_held: boolean;
          run_order: number;
          task_description: string | null;
          task_title: string;
          touchpoint_type: Database["public"]["Enums"]["touchpoint_type"] | null;
          trigger_event: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          due_in_days?: number;
          id?: string;
          is_active?: boolean;
          name: string;
          priority?: Database["public"]["Enums"]["task_priority"];
          require_meeting_held?: boolean;
          run_order?: number;
          task_description?: string | null;
          task_title: string;
          touchpoint_type?: Database["public"]["Enums"]["touchpoint_type"] | null;
          trigger_event: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          due_in_days?: number;
          id?: string;
          is_active?: boolean;
          name?: string;
          priority?: Database["public"]["Enums"]["task_priority"];
          require_meeting_held?: boolean;
          run_order?: number;
          task_description?: string | null;
          task_title?: string;
          touchpoint_type?: Database["public"]["Enums"]["touchpoint_type"] | null;
          trigger_event?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "followup_rules_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      geocode_cache: {
        Row: {
          created_at: string;
          formatted_address: string | null;
          id: string;
          lat: number | null;
          lon: number | null;
          provider: string;
          query: string;
          raw: Json | null;
          resolved: boolean;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          formatted_address?: string | null;
          id?: string;
          lat?: number | null;
          lon?: number | null;
          provider?: string;
          query: string;
          raw?: Json | null;
          resolved?: boolean;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          formatted_address?: string | null;
          id?: string;
          lat?: number | null;
          lon?: number | null;
          provider?: string;
          query?: string;
          raw?: Json | null;
          resolved?: boolean;
          updated_at?: string;
        };
        Relationships: [];
      };
      gift_campaign_recipients: {
        Row: {
          account_id: string;
          approved: boolean;
          campaign_id: string;
          contact_id: string;
          created_at: string;
          excluded_reason: string | null;
          id: string;
          is_demo: boolean;
        };
        Insert: {
          account_id: string;
          approved?: boolean;
          campaign_id: string;
          contact_id: string;
          created_at?: string;
          excluded_reason?: string | null;
          id?: string;
          is_demo?: boolean;
        };
        Update: {
          account_id?: string;
          approved?: boolean;
          campaign_id?: string;
          contact_id?: string;
          created_at?: string;
          excluded_reason?: string | null;
          id?: string;
          is_demo?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "gift_campaign_recipients_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "gift_campaign_recipients_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_campaign_recipients_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "gift_campaign_recipients_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "gift_campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_campaign_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "gift_campaign_recipients_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      gift_campaigns: {
        Row: {
          catalog_item_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          name: string;
          notes: string | null;
          occasion: string;
          status: Database["public"]["Enums"]["gift_campaign_status"];
          target_month: number | null;
          target_year: number | null;
          updated_at: string;
        };
        Insert: {
          catalog_item_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          name: string;
          notes?: string | null;
          occasion?: string;
          status?: Database["public"]["Enums"]["gift_campaign_status"];
          target_month?: number | null;
          target_year?: number | null;
          updated_at?: string;
        };
        Update: {
          catalog_item_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          name?: string;
          notes?: string | null;
          occasion?: string;
          status?: Database["public"]["Enums"]["gift_campaign_status"];
          target_month?: number | null;
          target_year?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "gift_campaigns_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "gift_catalog";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_campaigns_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "gift_campaigns_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      gift_catalog: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          image_path: string | null;
          is_demo: boolean;
          name: string;
          unit_cost_cents: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          image_path?: string | null;
          is_demo?: boolean;
          name: string;
          unit_cost_cents?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          image_path?: string | null;
          is_demo?: boolean;
          name?: string;
          unit_cost_cents?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "gift_catalog_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      gift_sends: {
        Row: {
          account_id: string;
          campaign_id: string | null;
          catalog_item_id: string | null;
          contact_id: string | null;
          cost_cents: number;
          created_at: string;
          created_by: string | null;
          delivery_status: Database["public"]["Enums"]["gift_delivery_status"];
          id: string;
          is_demo: boolean;
          notes: string | null;
          sent_at: string;
          tracking_ref: string | null;
        };
        Insert: {
          account_id: string;
          campaign_id?: string | null;
          catalog_item_id?: string | null;
          contact_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          created_by?: string | null;
          delivery_status?: Database["public"]["Enums"]["gift_delivery_status"];
          id?: string;
          is_demo?: boolean;
          notes?: string | null;
          sent_at?: string;
          tracking_ref?: string | null;
        };
        Update: {
          account_id?: string;
          campaign_id?: string | null;
          catalog_item_id?: string | null;
          contact_id?: string | null;
          cost_cents?: number;
          created_at?: string;
          created_by?: string | null;
          delivery_status?: Database["public"]["Enums"]["gift_delivery_status"];
          id?: string;
          is_demo?: boolean;
          notes?: string | null;
          sent_at?: string;
          tracking_ref?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "gift_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "gift_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "gift_sends_campaign_id_fkey";
            columns: ["campaign_id"];
            isOneToOne: false;
            referencedRelation: "gift_campaigns";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_sends_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "gift_catalog";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "gift_sends_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "gift_sends_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      goals: {
        Row: {
          created_at: string;
          ends_on: string;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          location_id: string;
          metric: Database["public"]["Enums"]["goal_metric"];
          notes: string | null;
          parent_goal_id: string | null;
          period_type: Database["public"]["Enums"]["goal_period"];
          set_by: string | null;
          starts_on: string;
          subject_location_id: string | null;
          subject_user_id: string | null;
          target_value: number;
          updated_at: string;
          why: string | null;
        };
        Insert: {
          created_at?: string;
          ends_on: string;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          location_id: string;
          metric: Database["public"]["Enums"]["goal_metric"];
          notes?: string | null;
          parent_goal_id?: string | null;
          period_type: Database["public"]["Enums"]["goal_period"];
          set_by?: string | null;
          starts_on: string;
          subject_location_id?: string | null;
          subject_user_id?: string | null;
          target_value: number;
          updated_at?: string;
          why?: string | null;
        };
        Update: {
          created_at?: string;
          ends_on?: string;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          location_id?: string;
          metric?: Database["public"]["Enums"]["goal_metric"];
          notes?: string | null;
          parent_goal_id?: string | null;
          period_type?: Database["public"]["Enums"]["goal_period"];
          set_by?: string | null;
          starts_on?: string;
          subject_location_id?: string | null;
          subject_user_id?: string | null;
          target_value?: number;
          updated_at?: string;
          why?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "goals_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goals_parent_goal_id_fkey";
            columns: ["parent_goal_id"];
            isOneToOne: false;
            referencedRelation: "goals";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goals_set_by_fkey";
            columns: ["set_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "goals_subject_location_id_fkey";
            columns: ["subject_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "goals_subject_user_id_fkey";
            columns: ["subject_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      google_review_links: {
        Row: {
          account_id: string;
          click_count: number;
          contact_id: string | null;
          created_at: string;
          created_by: string;
          destination_url: string;
          first_clicked_at: string | null;
          id: string;
          is_active: boolean;
          last_clicked_at: string | null;
          location_id: string;
          token: string;
        };
        Insert: {
          account_id: string;
          click_count?: number;
          contact_id?: string | null;
          created_at?: string;
          created_by: string;
          destination_url: string;
          first_clicked_at?: string | null;
          id?: string;
          is_active?: boolean;
          last_clicked_at?: string | null;
          location_id: string;
          token?: string;
        };
        Update: {
          account_id?: string;
          click_count?: number;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string;
          destination_url?: string;
          first_clicked_at?: string | null;
          id?: string;
          is_active?: boolean;
          last_clicked_at?: string | null;
          location_id?: string;
          token?: string;
        };
        Relationships: [
          {
            foreignKeyName: "google_review_links_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "google_review_links_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "google_review_links_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "google_review_links_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "google_review_links_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "google_review_links_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "google_review_links_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      graph_mailboxes: {
        Row: {
          connection_id: string | null;
          created_at: string;
          display_name: string | null;
          enabled: boolean;
          events_delta_link: string | null;
          events_subscription_expires_at: string | null;
          events_subscription_id: string | null;
          graph_user_id: string | null;
          id: string;
          kind: string;
          last_delta_sync_at: string | null;
          last_error: string | null;
          last_message_at: string | null;
          location_id: string | null;
          messages_delta_link: string | null;
          messages_subscription_expires_at: string | null;
          messages_subscription_id: string | null;
          owner_user_id: string | null;
          sync_calendar: boolean;
          sync_mail: boolean;
          updated_at: string;
          upn: string;
          user_id: string | null;
        };
        Insert: {
          connection_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          enabled?: boolean;
          events_delta_link?: string | null;
          events_subscription_expires_at?: string | null;
          events_subscription_id?: string | null;
          graph_user_id?: string | null;
          id?: string;
          kind?: string;
          last_delta_sync_at?: string | null;
          last_error?: string | null;
          last_message_at?: string | null;
          location_id?: string | null;
          messages_delta_link?: string | null;
          messages_subscription_expires_at?: string | null;
          messages_subscription_id?: string | null;
          owner_user_id?: string | null;
          sync_calendar?: boolean;
          sync_mail?: boolean;
          updated_at?: string;
          upn: string;
          user_id?: string | null;
        };
        Update: {
          connection_id?: string | null;
          created_at?: string;
          display_name?: string | null;
          enabled?: boolean;
          events_delta_link?: string | null;
          events_subscription_expires_at?: string | null;
          events_subscription_id?: string | null;
          graph_user_id?: string | null;
          id?: string;
          kind?: string;
          last_delta_sync_at?: string | null;
          last_error?: string | null;
          last_message_at?: string | null;
          location_id?: string | null;
          messages_delta_link?: string | null;
          messages_subscription_expires_at?: string | null;
          messages_subscription_id?: string | null;
          owner_user_id?: string | null;
          sync_calendar?: boolean;
          sync_mail?: boolean;
          updated_at?: string;
          upn?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "graph_mailboxes_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "integration_connections";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "graph_mailboxes_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "graph_mailboxes_owner_user_id_fkey";
            columns: ["owner_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "graph_mailboxes_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      impersonation_audit: {
        Row: {
          actor_id: string | null;
          ended_at: string | null;
          ended_reason: string | null;
          id: string;
          preview_role: Database["public"]["Enums"]["app_role"] | null;
          started_at: string;
          target_user_id: string | null;
        };
        Insert: {
          actor_id?: string | null;
          ended_at?: string | null;
          ended_reason?: string | null;
          id?: string;
          preview_role?: Database["public"]["Enums"]["app_role"] | null;
          started_at?: string;
          target_user_id?: string | null;
        };
        Update: {
          actor_id?: string | null;
          ended_at?: string | null;
          ended_reason?: string | null;
          id?: string;
          preview_role?: Database["public"]["Enums"]["app_role"] | null;
          started_at?: string;
          target_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "impersonation_audit_actor_id_profiles_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "impersonation_audit_target_user_id_profiles_fkey";
            columns: ["target_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      incident_attempts: {
        Row: {
          attended_at: string;
          chaser_id: string | null;
          created_at: string;
          id: string;
          incident_id: string;
          is_demo: boolean;
          kept_live: boolean;
          note: string | null;
          reason_id: string | null;
          reason_label: string | null;
          sub_reason_id: string | null;
          sub_reason_label: string | null;
        };
        Insert: {
          attended_at?: string;
          chaser_id?: string | null;
          created_at?: string;
          id?: string;
          incident_id: string;
          is_demo?: boolean;
          kept_live?: boolean;
          note?: string | null;
          reason_id?: string | null;
          reason_label?: string | null;
          sub_reason_id?: string | null;
          sub_reason_label?: string | null;
        };
        Update: {
          attended_at?: string;
          chaser_id?: string | null;
          created_at?: string;
          id?: string;
          incident_id?: string;
          is_demo?: boolean;
          kept_live?: boolean;
          note?: string | null;
          reason_id?: string | null;
          reason_label?: string | null;
          sub_reason_id?: string | null;
          sub_reason_label?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "incident_attempts_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: false;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incident_attempts_reason_id_fkey";
            columns: ["reason_id"];
            isOneToOne: false;
            referencedRelation: "incident_outcome_reasons";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incident_attempts_sub_reason_id_fkey";
            columns: ["sub_reason_id"];
            isOneToOne: false;
            referencedRelation: "incident_outcome_reasons";
            referencedColumns: ["id"];
          },
        ];
      };
      incident_dispatches: {
        Row: {
          decline_reason: string | null;
          id: string;
          incident_id: string;
          is_demo: boolean;
          notified_at: string;
          release_reason: string | null;
          released_at: string | null;
          responded_at: string | null;
          response: Database["public"]["Enums"]["dispatch_response"];
          tier: number;
          user_id: string;
        };
        Insert: {
          decline_reason?: string | null;
          id?: string;
          incident_id: string;
          is_demo?: boolean;
          notified_at?: string;
          release_reason?: string | null;
          released_at?: string | null;
          responded_at?: string | null;
          response?: Database["public"]["Enums"]["dispatch_response"];
          tier: number;
          user_id: string;
        };
        Update: {
          decline_reason?: string | null;
          id?: string;
          incident_id?: string;
          is_demo?: boolean;
          notified_at?: string;
          release_reason?: string | null;
          released_at?: string | null;
          responded_at?: string | null;
          response?: Database["public"]["Enums"]["dispatch_response"];
          tier?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "incident_dispatches_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: false;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
        ];
      };
      incident_events: {
        Row: {
          actor_id: string | null;
          event_type: Database["public"]["Enums"]["chase_event_type"];
          id: string;
          incident_id: string;
          is_demo: boolean;
          lat: number | null;
          lon: number | null;
          occurred_at: string;
          payload: Json;
        };
        Insert: {
          actor_id?: string | null;
          event_type: Database["public"]["Enums"]["chase_event_type"];
          id?: string;
          incident_id: string;
          is_demo?: boolean;
          lat?: number | null;
          lon?: number | null;
          occurred_at?: string;
          payload?: Json;
        };
        Update: {
          actor_id?: string | null;
          event_type?: Database["public"]["Enums"]["chase_event_type"];
          id?: string;
          incident_id?: string;
          is_demo?: boolean;
          lat?: number | null;
          lon?: number | null;
          occurred_at?: string;
          payload?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "incident_events_actor_id_profiles_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "incident_events_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: false;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
        ];
      };
      incident_notes: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          id: string;
          incident_id: string;
          is_demo: boolean;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          id?: string;
          incident_id: string;
          is_demo?: boolean;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          id?: string;
          incident_id?: string;
          is_demo?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "incident_notes_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: false;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
        ];
      };
      incident_outcome_reasons: {
        Row: {
          allows_another_try: boolean;
          created_at: string;
          flags_bad_data: boolean;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          key: string;
          kills_lead: boolean;
          label: string;
          option_list_key: string | null;
          outcome_code: Database["public"]["Enums"]["incident_outcome"] | null;
          parent_id: string | null;
          sort_order: number;
          updated_at: string;
          wins_lead: boolean;
        };
        Insert: {
          allows_another_try?: boolean;
          created_at?: string;
          flags_bad_data?: boolean;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          key: string;
          kills_lead?: boolean;
          label: string;
          option_list_key?: string | null;
          outcome_code?: Database["public"]["Enums"]["incident_outcome"] | null;
          parent_id?: string | null;
          sort_order?: number;
          updated_at?: string;
          wins_lead?: boolean;
        };
        Update: {
          allows_another_try?: boolean;
          created_at?: string;
          flags_bad_data?: boolean;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          key?: string;
          kills_lead?: boolean;
          label?: string;
          option_list_key?: string | null;
          outcome_code?: Database["public"]["Enums"]["incident_outcome"] | null;
          parent_id?: string | null;
          sort_order?: number;
          updated_at?: string;
          wins_lead?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "incident_outcome_reasons_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "incident_outcome_reasons";
            referencedColumns: ["id"];
          },
        ];
      };
      incident_property_lookups: {
        Row: {
          created_at: string;
          id: string;
          incident_id: string;
          is_demo: boolean;
          last_sale_amount: number | null;
          last_sale_date: string | null;
          looked_up_by: string | null;
          mailing_address: string | null;
          owner_email: string | null;
          owner_name: string | null;
          owner_occupied: boolean | null;
          owner_phone: string | null;
          provider: string;
          raw: Json;
          unit_count: number | null;
          updated_at: string;
          year_built: number | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          incident_id: string;
          is_demo?: boolean;
          last_sale_amount?: number | null;
          last_sale_date?: string | null;
          looked_up_by?: string | null;
          mailing_address?: string | null;
          owner_email?: string | null;
          owner_name?: string | null;
          owner_occupied?: boolean | null;
          owner_phone?: string | null;
          provider: string;
          raw?: Json;
          unit_count?: number | null;
          updated_at?: string;
          year_built?: number | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          incident_id?: string;
          is_demo?: boolean;
          last_sale_amount?: number | null;
          last_sale_date?: string | null;
          looked_up_by?: string | null;
          mailing_address?: string | null;
          owner_email?: string | null;
          owner_name?: string | null;
          owner_occupied?: boolean | null;
          owner_phone?: string | null;
          provider?: string;
          raw?: Json;
          unit_count?: number | null;
          updated_at?: string;
          year_built?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "incident_property_lookups_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: true;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
        ];
      };
      incident_public_records: {
        Row: {
          assessed_value: number | null;
          created_at: string;
          fetched_at: string;
          fetched_by: string | null;
          incident_id: string;
          last_sale_amount: number | null;
          last_sale_date: string | null;
          note: string | null;
          owner_name: string | null;
          owner_withheld: boolean;
          parcel_address: string | null;
          parcel_id: string | null;
          property_class: string | null;
          property_class_label: string | null;
          source: string | null;
          source_label: string | null;
          source_vintage: string | null;
          status: string;
          unit_count: number | null;
          updated_at: string;
          year_built: number | null;
        };
        Insert: {
          assessed_value?: number | null;
          created_at?: string;
          fetched_at?: string;
          fetched_by?: string | null;
          incident_id: string;
          last_sale_amount?: number | null;
          last_sale_date?: string | null;
          note?: string | null;
          owner_name?: string | null;
          owner_withheld?: boolean;
          parcel_address?: string | null;
          parcel_id?: string | null;
          property_class?: string | null;
          property_class_label?: string | null;
          source?: string | null;
          source_label?: string | null;
          source_vintage?: string | null;
          status: string;
          unit_count?: number | null;
          updated_at?: string;
          year_built?: number | null;
        };
        Update: {
          assessed_value?: number | null;
          created_at?: string;
          fetched_at?: string;
          fetched_by?: string | null;
          incident_id?: string;
          last_sale_amount?: number | null;
          last_sale_date?: string | null;
          note?: string | null;
          owner_name?: string | null;
          owner_withheld?: boolean;
          parcel_address?: string | null;
          parcel_id?: string | null;
          property_class?: string | null;
          property_class_label?: string | null;
          source?: string | null;
          source_label?: string | null;
          source_vintage?: string | null;
          status?: string;
          unit_count?: number | null;
          updated_at?: string;
          year_built?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "incident_public_records_incident_id_fkey";
            columns: ["incident_id"];
            isOneToOne: true;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
        ];
      };
      incidents: {
        Row: {
          accepted_at: string | null;
          accepted_by: string | null;
          account_id: string | null;
          address: string | null;
          admin_route_reason: string | null;
          admin_routed: boolean;
          alarm_level: string | null;
          arrival_accuracy_m: number | null;
          arrival_method: string | null;
          arrived_at: string | null;
          arrived_lat: number | null;
          arrived_lon: number | null;
          bad_data: boolean;
          building_type: string | null;
          call_sign: string | null;
          claim_expires_at: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          dedupe_key: string | null;
          dispatched_at: string | null;
          duplicate_of: string | null;
          escalated_at: string | null;
          escalation_tier: number;
          eta_at: string | null;
          exclusivity: Database["public"]["Enums"]["incident_exclusivity"];
          exposure_group_id: string | null;
          external_ref: string | null;
          geom: unknown;
          id: string;
          incident_type: string;
          is_demo: boolean;
          is_exposure: boolean;
          job_id: string | null;
          lat: number | null;
          lifecycle: Database["public"]["Enums"]["incident_lifecycle"];
          locality: string | null;
          location_id: string | null;
          locked_at: string | null;
          locked_by: string | null;
          lon: number | null;
          market_id: string | null;
          matched_at: string | null;
          matched_fire_lead_id: string | null;
          needs_backup: boolean;
          needs_review: boolean;
          outcome: Database["public"]["Enums"]["incident_outcome"] | null;
          outcome_at: string | null;
          outcome_detail: string | null;
          outcome_notes: string | null;
          postal_code: string | null;
          raw_text: string | null;
          region: string | null;
          reported_at: string;
          review_reason: string | null;
          revisit_after: string | null;
          severity_key: string | null;
          source: string;
          source_links: Json;
          status: Database["public"]["Enums"]["incident_status"];
          units_dispatched: number | null;
          updated_at: string;
          worth_another_try: boolean;
          zone_id: string | null;
        };
        Insert: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          account_id?: string | null;
          address?: string | null;
          admin_route_reason?: string | null;
          admin_routed?: boolean;
          alarm_level?: string | null;
          arrival_accuracy_m?: number | null;
          arrival_method?: string | null;
          arrived_at?: string | null;
          arrived_lat?: number | null;
          arrived_lon?: number | null;
          bad_data?: boolean;
          building_type?: string | null;
          call_sign?: string | null;
          claim_expires_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          dedupe_key?: string | null;
          dispatched_at?: string | null;
          duplicate_of?: string | null;
          escalated_at?: string | null;
          escalation_tier?: number;
          eta_at?: string | null;
          exclusivity?: Database["public"]["Enums"]["incident_exclusivity"];
          exposure_group_id?: string | null;
          external_ref?: string | null;
          geom?: unknown;
          id?: string;
          incident_type?: string;
          is_demo?: boolean;
          is_exposure?: boolean;
          job_id?: string | null;
          lat?: number | null;
          lifecycle?: Database["public"]["Enums"]["incident_lifecycle"];
          locality?: string | null;
          location_id?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          lon?: number | null;
          market_id?: string | null;
          matched_at?: string | null;
          matched_fire_lead_id?: string | null;
          needs_backup?: boolean;
          needs_review?: boolean;
          outcome?: Database["public"]["Enums"]["incident_outcome"] | null;
          outcome_at?: string | null;
          outcome_detail?: string | null;
          outcome_notes?: string | null;
          postal_code?: string | null;
          raw_text?: string | null;
          region?: string | null;
          reported_at?: string;
          review_reason?: string | null;
          revisit_after?: string | null;
          severity_key?: string | null;
          source: string;
          source_links?: Json;
          status?: Database["public"]["Enums"]["incident_status"];
          units_dispatched?: number | null;
          updated_at?: string;
          worth_another_try?: boolean;
          zone_id?: string | null;
        };
        Update: {
          accepted_at?: string | null;
          accepted_by?: string | null;
          account_id?: string | null;
          address?: string | null;
          admin_route_reason?: string | null;
          admin_routed?: boolean;
          alarm_level?: string | null;
          arrival_accuracy_m?: number | null;
          arrival_method?: string | null;
          arrived_at?: string | null;
          arrived_lat?: number | null;
          arrived_lon?: number | null;
          bad_data?: boolean;
          building_type?: string | null;
          call_sign?: string | null;
          claim_expires_at?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          dedupe_key?: string | null;
          dispatched_at?: string | null;
          duplicate_of?: string | null;
          escalated_at?: string | null;
          escalation_tier?: number;
          eta_at?: string | null;
          exclusivity?: Database["public"]["Enums"]["incident_exclusivity"];
          exposure_group_id?: string | null;
          external_ref?: string | null;
          geom?: unknown;
          id?: string;
          incident_type?: string;
          is_demo?: boolean;
          is_exposure?: boolean;
          job_id?: string | null;
          lat?: number | null;
          lifecycle?: Database["public"]["Enums"]["incident_lifecycle"];
          locality?: string | null;
          location_id?: string | null;
          locked_at?: string | null;
          locked_by?: string | null;
          lon?: number | null;
          market_id?: string | null;
          matched_at?: string | null;
          matched_fire_lead_id?: string | null;
          needs_backup?: boolean;
          needs_review?: boolean;
          outcome?: Database["public"]["Enums"]["incident_outcome"] | null;
          outcome_at?: string | null;
          outcome_detail?: string | null;
          outcome_notes?: string | null;
          postal_code?: string | null;
          raw_text?: string | null;
          region?: string | null;
          reported_at?: string;
          review_reason?: string | null;
          revisit_after?: string | null;
          severity_key?: string | null;
          source?: string;
          source_links?: Json;
          status?: Database["public"]["Enums"]["incident_status"];
          units_dispatched?: number | null;
          updated_at?: string;
          worth_another_try?: boolean;
          zone_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "incidents_accepted_by_profiles_fkey";
            columns: ["accepted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "incidents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "incidents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "incidents_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "incidents_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "incidents_duplicate_of_fkey";
            columns: ["duplicate_of"];
            isOneToOne: false;
            referencedRelation: "incidents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_market_id_fkey";
            columns: ["market_id"];
            isOneToOne: false;
            referencedRelation: "markets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_matched_fire_lead_id_fkey";
            columns: ["matched_fire_lead_id"];
            isOneToOne: false;
            referencedRelation: "fire_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "incidents_zone_id_fkey";
            columns: ["zone_id"];
            isOneToOne: false;
            referencedRelation: "zones";
            referencedColumns: ["id"];
          },
        ];
      };
      intake_office_rules: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          location_id: string;
          match_kind: string;
          match_value: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id: string;
          match_kind: string;
          match_value: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id?: string;
          match_kind?: string;
          match_value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "intake_office_rules_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      intake_questions: {
        Row: {
          active: boolean;
          answer_type: string;
          ask_on_public_form: boolean;
          choices: Json;
          created_at: string;
          help_text: string | null;
          id: string;
          location_id: string | null;
          prompt: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          answer_type?: string;
          ask_on_public_form?: boolean;
          choices?: Json;
          created_at?: string;
          help_text?: string | null;
          id?: string;
          location_id?: string | null;
          prompt: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          answer_type?: string;
          ask_on_public_form?: boolean;
          choices?: Json;
          created_at?: string;
          help_text?: string | null;
          id?: string;
          location_id?: string | null;
          prompt?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "intake_questions_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      intake_requests: {
        Row: {
          created_at: string;
          created_by: string | null;
          email_message_id: string | null;
          expires_at: string;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          label: string | null;
          location_id: string | null;
          multi_use: boolean;
          note: string | null;
          recipient_email: string | null;
          recipient_name: string | null;
          revoked_at: string | null;
          standing: boolean;
          submitted_at: string | null;
          token: string;
          tradeshow_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          email_message_id?: string | null;
          expires_at?: string;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          label?: string | null;
          location_id?: string | null;
          multi_use?: boolean;
          note?: string | null;
          recipient_email?: string | null;
          recipient_name?: string | null;
          revoked_at?: string | null;
          standing?: boolean;
          submitted_at?: string | null;
          token?: string;
          tradeshow_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          email_message_id?: string | null;
          expires_at?: string;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          label?: string | null;
          location_id?: string | null;
          multi_use?: boolean;
          note?: string | null;
          recipient_email?: string | null;
          recipient_name?: string | null;
          revoked_at?: string | null;
          standing?: boolean;
          submitted_at?: string | null;
          token?: string;
          tradeshow_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "intake_requests_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "intake_requests_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "intake_requests_tradeshow_id_fkey";
            columns: ["tradeshow_id"];
            isOneToOne: false;
            referencedRelation: "tradeshows";
            referencedColumns: ["id"];
          },
        ];
      };
      intake_submissions: {
        Row: {
          account_id: string | null;
          answers: Json;
          created_at: string;
          field_review: Json;
          fields: Json;
          id: string;
          job_id: string | null;
          location_auto_assigned: boolean;
          location_id: string | null;
          location_route_detail: string | null;
          location_route_reason: string | null;
          location_set_at: string | null;
          location_set_by: string | null;
          photos: Json;
          request_id: string;
          reviewed_at: string | null;
          reviewed_by: string | null;
          source: string;
          source_excerpt: string | null;
          source_message_id: string | null;
          source_received_at: string | null;
          source_subject: string | null;
          status: string;
          submitted_by_email: string | null;
          submitted_by_name: string | null;
        };
        Insert: {
          account_id?: string | null;
          answers?: Json;
          created_at?: string;
          field_review?: Json;
          fields?: Json;
          id?: string;
          job_id?: string | null;
          location_auto_assigned?: boolean;
          location_id?: string | null;
          location_route_detail?: string | null;
          location_route_reason?: string | null;
          location_set_at?: string | null;
          location_set_by?: string | null;
          photos?: Json;
          request_id: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          source?: string;
          source_excerpt?: string | null;
          source_message_id?: string | null;
          source_received_at?: string | null;
          source_subject?: string | null;
          status?: string;
          submitted_by_email?: string | null;
          submitted_by_name?: string | null;
        };
        Update: {
          account_id?: string | null;
          answers?: Json;
          created_at?: string;
          field_review?: Json;
          fields?: Json;
          id?: string;
          job_id?: string | null;
          location_auto_assigned?: boolean;
          location_id?: string | null;
          location_route_detail?: string | null;
          location_route_reason?: string | null;
          location_set_at?: string | null;
          location_set_by?: string | null;
          photos?: Json;
          request_id?: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          source?: string;
          source_excerpt?: string | null;
          source_message_id?: string | null;
          source_received_at?: string | null;
          source_subject?: string | null;
          status?: string;
          submitted_by_email?: string | null;
          submitted_by_name?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "intake_submissions_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "intake_submissions_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "intake_submissions_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "intake_submissions_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "intake_submissions_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "intake_submissions_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "intake_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_connections: {
        Row: {
          config: Json;
          created_at: string;
          created_by: string | null;
          display_name: string | null;
          enabled: boolean;
          external_account_ref: string | null;
          id: string;
          last_error: string | null;
          last_event_at: string | null;
          last_sync_at: string | null;
          location_id: string | null;
          provider: Database["public"]["Enums"]["integration_provider"];
          revocation_for_user: string | null;
          revocation_pending: boolean;
          revocation_requested_at: string | null;
          status: Database["public"]["Enums"]["integration_status"];
          updated_at: string;
        };
        Insert: {
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          display_name?: string | null;
          enabled?: boolean;
          external_account_ref?: string | null;
          id?: string;
          last_error?: string | null;
          last_event_at?: string | null;
          last_sync_at?: string | null;
          location_id?: string | null;
          provider: Database["public"]["Enums"]["integration_provider"];
          revocation_for_user?: string | null;
          revocation_pending?: boolean;
          revocation_requested_at?: string | null;
          status?: Database["public"]["Enums"]["integration_status"];
          updated_at?: string;
        };
        Update: {
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          display_name?: string | null;
          enabled?: boolean;
          external_account_ref?: string | null;
          id?: string;
          last_error?: string | null;
          last_event_at?: string | null;
          last_sync_at?: string | null;
          location_id?: string | null;
          provider?: Database["public"]["Enums"]["integration_provider"];
          revocation_for_user?: string | null;
          revocation_pending?: boolean;
          revocation_requested_at?: string | null;
          status?: Database["public"]["Enums"]["integration_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_connections_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "integration_connections_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_credential_audit: {
        Row: {
          action: string;
          actor_email: string | null;
          actor_id: string | null;
          created_at: string;
          id: string;
          key_name: string;
          provider: string;
        };
        Insert: {
          action: string;
          actor_email?: string | null;
          actor_id?: string | null;
          created_at?: string;
          id?: string;
          key_name: string;
          provider: string;
        };
        Update: {
          action?: string;
          actor_email?: string | null;
          actor_id?: string | null;
          created_at?: string;
          id?: string;
          key_name?: string;
          provider?: string;
        };
        Relationships: [];
      };
      integration_credentials: {
        Row: {
          ciphertext: string;
          created_at: string;
          hint: string | null;
          id: string;
          is_public: boolean;
          iv: string;
          key_name: string;
          provider: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          ciphertext: string;
          created_at?: string;
          hint?: string | null;
          id?: string;
          is_public?: boolean;
          iv: string;
          key_name: string;
          provider: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          ciphertext?: string;
          created_at?: string;
          hint?: string | null;
          id?: string;
          is_public?: boolean;
          iv?: string;
          key_name?: string;
          provider?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      integration_events: {
        Row: {
          connection_id: string | null;
          direction: string;
          error: string | null;
          event_type: string;
          external_id: string | null;
          id: string;
          payload: Json;
          provider: Database["public"]["Enums"]["integration_provider"];
          received_at: string;
          status: string;
        };
        Insert: {
          connection_id?: string | null;
          direction?: string;
          error?: string | null;
          event_type: string;
          external_id?: string | null;
          id?: string;
          payload?: Json;
          provider: Database["public"]["Enums"]["integration_provider"];
          received_at?: string;
          status?: string;
        };
        Update: {
          connection_id?: string | null;
          direction?: string;
          error?: string | null;
          event_type?: string;
          external_id?: string | null;
          id?: string;
          payload?: Json;
          provider?: Database["public"]["Enums"]["integration_provider"];
          received_at?: string;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: "integration_events_connection_id_fkey";
            columns: ["connection_id"];
            isOneToOne: false;
            referencedRelation: "integration_connections";
            referencedColumns: ["id"];
          },
        ];
      };
      integration_test_results: {
        Row: {
          message: string | null;
          ok: boolean;
          provider: string;
          tested_at: string;
          tested_by: string | null;
        };
        Insert: {
          message?: string | null;
          ok?: boolean;
          provider: string;
          tested_at?: string;
          tested_by?: string | null;
        };
        Update: {
          message?: string | null;
          ok?: boolean;
          provider?: string;
          tested_at?: string;
          tested_by?: string | null;
        };
        Relationships: [];
      };
      invoice_lines: {
        Row: {
          catalog_item_id: string | null;
          code: string | null;
          created_at: string;
          description: string | null;
          id: string;
          invoice_id: string;
          is_discount: boolean;
          name: string;
          note: string | null;
          position: number;
          quantity: number;
          scope_id: string | null;
          subtotal: number | null;
          taxable: boolean;
          unit_cost: number;
          unit_price: number;
          uom: string;
          updated_at: string;
        };
        Insert: {
          catalog_item_id?: string | null;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          invoice_id: string;
          is_discount?: boolean;
          name: string;
          note?: string | null;
          position?: number;
          quantity?: number;
          scope_id?: string | null;
          subtotal?: number | null;
          taxable?: boolean;
          unit_cost?: number;
          unit_price?: number;
          uom?: string;
          updated_at?: string;
        };
        Update: {
          catalog_item_id?: string | null;
          code?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          invoice_id?: string;
          is_discount?: boolean;
          name?: string;
          note?: string | null;
          position?: number;
          quantity?: number;
          scope_id?: string | null;
          subtotal?: number | null;
          taxable?: boolean;
          unit_cost?: number;
          unit_price?: number;
          uom?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "invoice_lines_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "estimate_catalog_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_lines_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_lines_scope_id_fkey";
            columns: ["scope_id"];
            isOneToOne: false;
            referencedRelation: "invoice_scopes";
            referencedColumns: ["id"];
          },
        ];
      };
      invoice_payment_changes: {
        Row: {
          action: string;
          after_data: Json | null;
          before_data: Json;
          changed_by: string | null;
          created_at: string;
          id: string;
          invoice_id: string;
          payment_id: string;
          reason: string | null;
        };
        Insert: {
          action: string;
          after_data?: Json | null;
          before_data: Json;
          changed_by?: string | null;
          created_at?: string;
          id?: string;
          invoice_id: string;
          payment_id: string;
          reason?: string | null;
        };
        Update: {
          action?: string;
          after_data?: Json | null;
          before_data?: Json;
          changed_by?: string | null;
          created_at?: string;
          id?: string;
          invoice_id?: string;
          payment_id?: string;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "invoice_payment_changes_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
        ];
      };
      invoice_payments: {
        Row: {
          amount: number;
          change_reason: string | null;
          created_at: string;
          created_by: string | null;
          document_id: string | null;
          id: string;
          invoice_id: string;
          is_demo: boolean;
          method: string | null;
          notes: string | null;
          received_at: string;
          reference: string | null;
          updated_at: string | null;
          updated_by: string | null;
        };
        Insert: {
          amount: number;
          change_reason?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          id?: string;
          invoice_id: string;
          is_demo?: boolean;
          method?: string | null;
          notes?: string | null;
          received_at?: string;
          reference?: string | null;
          updated_at?: string | null;
          updated_by?: string | null;
        };
        Update: {
          amount?: number;
          change_reason?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          id?: string;
          invoice_id?: string;
          is_demo?: boolean;
          method?: string | null;
          notes?: string | null;
          received_at?: string;
          reference?: string | null;
          updated_at?: string | null;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "invoice_payments_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "invoice_payments_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoice_payments_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
        ];
      };
      invoice_scopes: {
        Row: {
          created_at: string;
          id: string;
          invoice_id: string;
          name: string;
          notes: string | null;
          position: number;
          room_name: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          invoice_id: string;
          name: string;
          notes?: string | null;
          position?: number;
          room_name?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          invoice_id?: string;
          name?: string;
          notes?: string | null;
          position?: number;
          room_name?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "invoice_scopes_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
        ];
      };
      invoices: {
        Row: {
          account_id: string | null;
          address: string | null;
          address_line2: string | null;
          adjuster_email: string | null;
          adjuster_name: string | null;
          approved_amount: number | null;
          billed_amount: number;
          carrier: string | null;
          carrier_shortfall: number | null;
          claim_number: string | null;
          closing_statement: string | null;
          collected_amount: number;
          created_at: string;
          created_by: string | null;
          current_version: number;
          customer_name: string | null;
          due_date: string | null;
          estimate_id: string | null;
          id: string;
          invoice_number: string;
          is_demo: boolean;
          issue_date: string;
          job_calculation_id: string | null;
          job_id: string | null;
          job_number: string | null;
          line_itemized: boolean;
          locality: string | null;
          location_id: string;
          notes: string | null;
          office_address: string | null;
          office_email: string | null;
          office_name: string | null;
          office_phone: string | null;
          photo_ids: string[] | null;
          photo_share_link_id: string | null;
          postal_code: string | null;
          region: string | null;
          sent_at: string | null;
          source_estimate_version: number | null;
          status: Database["public"]["Enums"]["invoice_status"];
          subtotal: number;
          tax: number;
          tax_rate: number;
          title: string | null;
          total: number;
          uncollected: number | null;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          address?: string | null;
          address_line2?: string | null;
          adjuster_email?: string | null;
          adjuster_name?: string | null;
          approved_amount?: number | null;
          billed_amount?: number;
          carrier?: string | null;
          carrier_shortfall?: number | null;
          claim_number?: string | null;
          closing_statement?: string | null;
          collected_amount?: number;
          created_at?: string;
          created_by?: string | null;
          current_version?: number;
          customer_name?: string | null;
          due_date?: string | null;
          estimate_id?: string | null;
          id?: string;
          invoice_number: string;
          is_demo?: boolean;
          issue_date?: string;
          job_calculation_id?: string | null;
          job_id?: string | null;
          job_number?: string | null;
          line_itemized?: boolean;
          locality?: string | null;
          location_id: string;
          notes?: string | null;
          office_address?: string | null;
          office_email?: string | null;
          office_name?: string | null;
          office_phone?: string | null;
          photo_ids?: string[] | null;
          photo_share_link_id?: string | null;
          postal_code?: string | null;
          region?: string | null;
          sent_at?: string | null;
          source_estimate_version?: number | null;
          status?: Database["public"]["Enums"]["invoice_status"];
          subtotal?: number;
          tax?: number;
          tax_rate?: number;
          title?: string | null;
          total?: number;
          uncollected?: number | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          address?: string | null;
          address_line2?: string | null;
          adjuster_email?: string | null;
          adjuster_name?: string | null;
          approved_amount?: number | null;
          billed_amount?: number;
          carrier?: string | null;
          carrier_shortfall?: number | null;
          claim_number?: string | null;
          closing_statement?: string | null;
          collected_amount?: number;
          created_at?: string;
          created_by?: string | null;
          current_version?: number;
          customer_name?: string | null;
          due_date?: string | null;
          estimate_id?: string | null;
          id?: string;
          invoice_number?: string;
          is_demo?: boolean;
          issue_date?: string;
          job_calculation_id?: string | null;
          job_id?: string | null;
          job_number?: string | null;
          line_itemized?: boolean;
          locality?: string | null;
          location_id?: string;
          notes?: string | null;
          office_address?: string | null;
          office_email?: string | null;
          office_name?: string | null;
          office_phone?: string | null;
          photo_ids?: string[] | null;
          photo_share_link_id?: string | null;
          postal_code?: string | null;
          region?: string | null;
          sent_at?: string | null;
          source_estimate_version?: number | null;
          status?: Database["public"]["Enums"]["invoice_status"];
          subtotal?: number;
          tax?: number;
          tax_rate?: number;
          title?: string | null;
          total?: number;
          uncollected?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "invoices_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "invoices_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "invoices_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "invoices_estimate_id_fkey";
            columns: ["estimate_id"];
            isOneToOne: false;
            referencedRelation: "estimates";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_job_calculation_id_fkey";
            columns: ["job_calculation_id"];
            isOneToOne: false;
            referencedRelation: "job_calculations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "invoices_photo_share_link_id_fkey";
            columns: ["photo_share_link_id"];
            isOneToOne: false;
            referencedRelation: "share_links";
            referencedColumns: ["id"];
          },
        ];
      };
      job_assignments: {
        Row: {
          created_at: string;
          end_date: string | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          role: string;
          start_date: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          end_date?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          role: string;
          start_date?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          end_date?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          role?: string;
          start_date?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_assignments_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_assignments_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      job_calculations: {
        Row: {
          address: string | null;
          address_line2: string | null;
          after_hours: number;
          contact_number: string | null;
          created_at: string;
          created_by: string;
          custom_lines: Json;
          customer_name: string | null;
          customer_price: number;
          days: number;
          email: string | null;
          emergency: boolean;
          equipment_profit: number;
          equipment_quantities: Json;
          garbage_fee: number;
          id: string;
          internal_cost: number;
          job_date: string;
          job_id: string | null;
          job_type: string;
          locality: string | null;
          location_id: string;
          miscellaneous_fee: number;
          note: string | null;
          overall_profit: number;
          postal_code: string | null;
          region: string | null;
          regular_hours: number;
          updated_at: string;
          workers: number;
        };
        Insert: {
          address?: string | null;
          address_line2?: string | null;
          after_hours?: number;
          contact_number?: string | null;
          created_at?: string;
          created_by: string;
          custom_lines?: Json;
          customer_name?: string | null;
          customer_price?: number;
          days?: number;
          email?: string | null;
          emergency?: boolean;
          equipment_profit?: number;
          equipment_quantities?: Json;
          garbage_fee?: number;
          id?: string;
          internal_cost?: number;
          job_date?: string;
          job_id?: string | null;
          job_type: string;
          locality?: string | null;
          location_id: string;
          miscellaneous_fee?: number;
          note?: string | null;
          overall_profit?: number;
          postal_code?: string | null;
          region?: string | null;
          regular_hours?: number;
          updated_at?: string;
          workers?: number;
        };
        Update: {
          address?: string | null;
          address_line2?: string | null;
          after_hours?: number;
          contact_number?: string | null;
          created_at?: string;
          created_by?: string;
          custom_lines?: Json;
          customer_name?: string | null;
          customer_price?: number;
          days?: number;
          email?: string | null;
          emergency?: boolean;
          equipment_profit?: number;
          equipment_quantities?: Json;
          garbage_fee?: number;
          id?: string;
          internal_cost?: number;
          job_date?: string;
          job_id?: string | null;
          job_type?: string;
          locality?: string | null;
          location_id?: string;
          miscellaneous_fee?: number;
          note?: string | null;
          overall_profit?: number;
          postal_code?: string | null;
          region?: string | null;
          regular_hours?: number;
          updated_at?: string;
          workers?: number;
        };
        Relationships: [
          {
            foreignKeyName: "job_calculations_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_calculations_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_calculations_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      job_contact_methods: {
        Row: {
          created_at: string;
          extension: string | null;
          id: string;
          is_demo: boolean;
          is_preferred: boolean;
          job_id: string;
          kind: string;
          label: string | null;
          updated_at: string;
          value: string;
        };
        Insert: {
          created_at?: string;
          extension?: string | null;
          id?: string;
          is_demo?: boolean;
          is_preferred?: boolean;
          job_id: string;
          kind: string;
          label?: string | null;
          updated_at?: string;
          value: string;
        };
        Update: {
          created_at?: string;
          extension?: string | null;
          id?: string;
          is_demo?: boolean;
          is_preferred?: boolean;
          job_id?: string;
          kind?: string;
          label?: string | null;
          updated_at?: string;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_contact_methods_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_contacts: {
        Row: {
          account_id: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          email: string | null;
          full_name: string | null;
          id: string;
          is_default_contact: boolean;
          is_demo: boolean;
          job_id: string;
          notes: string | null;
          phone: string | null;
          role: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          full_name?: string | null;
          id?: string;
          is_default_contact?: boolean;
          is_demo?: boolean;
          job_id: string;
          notes?: string | null;
          phone?: string | null;
          role?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          full_name?: string | null;
          id?: string;
          is_default_contact?: boolean;
          is_demo?: boolean;
          job_id?: string;
          notes?: string | null;
          phone?: string | null;
          role?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_contacts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "job_contacts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_contacts_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "job_contacts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "job_contacts_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_contacts_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_contacts_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_cost_lines: {
        Row: {
          created_at: string;
          created_by: string | null;
          direct_cost: number;
          equipment_cost: number;
          equipment_days: number;
          field_work_ticket_id: string | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          materials_cost: number;
          notes: string | null;
          revenue: number;
          subcontractor_cost: number;
          updated_at: string;
          work_component: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          direct_cost?: number;
          equipment_cost?: number;
          equipment_days?: number;
          field_work_ticket_id?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          materials_cost?: number;
          notes?: string | null;
          revenue?: number;
          subcontractor_cost?: number;
          updated_at?: string;
          work_component: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          direct_cost?: number;
          equipment_cost?: number;
          equipment_days?: number;
          field_work_ticket_id?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          materials_cost?: number;
          notes?: string | null;
          revenue?: number;
          subcontractor_cost?: number;
          updated_at?: string;
          work_component?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_cost_lines_field_work_ticket_id_fkey";
            columns: ["field_work_ticket_id"];
            isOneToOne: false;
            referencedRelation: "field_work_tickets";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_cost_lines_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_crew_lists: {
        Row: {
          created_at: string;
          created_by: string | null;
          job_id: string;
          names: string[];
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          job_id: string;
          names?: string[];
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          job_id?: string;
          names?: string[];
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_crew_lists_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: true;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_drying_readings: {
        Row: {
          captured_at: string;
          created_at: string;
          created_by: string | null;
          dew_point_f: number | null;
          equipment_id: string | null;
          grains_per_pound: number | null;
          id: string;
          is_baseline: boolean;
          is_demo: boolean;
          job_id: string;
          label: string | null;
          notes: string | null;
          observed_at: string | null;
          photo_mime: string | null;
          photo_path: string | null;
          photo_thumb_path: string | null;
          point: string;
          reading_date: string;
          relative_humidity: number;
          room_id: string | null;
          source: string;
          source_detail: string | null;
          temperature_f: number;
          updated_at: string;
          values_source: string;
        };
        Insert: {
          captured_at?: string;
          created_at?: string;
          created_by?: string | null;
          dew_point_f?: number | null;
          equipment_id?: string | null;
          grains_per_pound?: number | null;
          id?: string;
          is_baseline?: boolean;
          is_demo?: boolean;
          job_id: string;
          label?: string | null;
          notes?: string | null;
          observed_at?: string | null;
          photo_mime?: string | null;
          photo_path?: string | null;
          photo_thumb_path?: string | null;
          point: string;
          reading_date: string;
          relative_humidity: number;
          room_id?: string | null;
          source?: string;
          source_detail?: string | null;
          temperature_f: number;
          updated_at?: string;
          values_source?: string;
        };
        Update: {
          captured_at?: string;
          created_at?: string;
          created_by?: string | null;
          dew_point_f?: number | null;
          equipment_id?: string | null;
          grains_per_pound?: number | null;
          id?: string;
          is_baseline?: boolean;
          is_demo?: boolean;
          job_id?: string;
          label?: string | null;
          notes?: string | null;
          observed_at?: string | null;
          photo_mime?: string | null;
          photo_path?: string | null;
          photo_thumb_path?: string | null;
          point?: string;
          reading_date?: string;
          relative_humidity?: number;
          room_id?: string | null;
          source?: string;
          source_detail?: string | null;
          temperature_f?: number;
          updated_at?: string;
          values_source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_drying_readings_equipment_id_fkey";
            columns: ["equipment_id"];
            isOneToOne: false;
            referencedRelation: "equipment";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_drying_readings_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_drying_readings_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "job_rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      job_drying_resets: {
        Row: {
          created_at: string;
          id: string;
          job_id: string;
          note: string | null;
          previous_started_at: string | null;
          reset_at: string;
          reset_by: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          job_id: string;
          note?: string | null;
          previous_started_at?: string | null;
          reset_at?: string;
          reset_by?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          job_id?: string;
          note?: string | null;
          previous_started_at?: string | null;
          reset_at?: string;
          reset_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_drying_resets_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_field_changes: {
        Row: {
          changed_at: string;
          changed_by: string | null;
          field: string;
          id: string;
          job_id: string;
          new_value: string | null;
          old_value: string | null;
          reverts_id: string | null;
        };
        Insert: {
          changed_at?: string;
          changed_by?: string | null;
          field: string;
          id?: string;
          job_id: string;
          new_value?: string | null;
          old_value?: string | null;
          reverts_id?: string | null;
        };
        Update: {
          changed_at?: string;
          changed_by?: string | null;
          field?: string;
          id?: string;
          job_id?: string;
          new_value?: string | null;
          old_value?: string | null;
          reverts_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_field_changes_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_field_changes_reverts_id_fkey";
            columns: ["reverts_id"];
            isOneToOne: false;
            referencedRelation: "job_field_changes";
            referencedColumns: ["id"];
          },
        ];
      };
      job_intake_answers: {
        Row: {
          answer_bool: boolean | null;
          answer_date: string | null;
          answer_text: string | null;
          answered_by: string | null;
          created_at: string;
          id: string;
          job_id: string;
          question_id: string;
          source: string;
          updated_at: string;
        };
        Insert: {
          answer_bool?: boolean | null;
          answer_date?: string | null;
          answer_text?: string | null;
          answered_by?: string | null;
          created_at?: string;
          id?: string;
          job_id: string;
          question_id: string;
          source?: string;
          updated_at?: string;
        };
        Update: {
          answer_bool?: boolean | null;
          answer_date?: string | null;
          answer_text?: string | null;
          answered_by?: string | null;
          created_at?: string;
          id?: string;
          job_id?: string;
          question_id?: string;
          source?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_intake_answers_answered_by_fkey";
            columns: ["answered_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_intake_answers_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_intake_answers_question_id_fkey";
            columns: ["question_id"];
            isOneToOne: false;
            referencedRelation: "intake_questions";
            referencedColumns: ["id"];
          },
        ];
      };
      job_ledger_override_changes: {
        Row: {
          cell_key: string;
          changed_at: string;
          changed_by: string | null;
          id: number;
          job_id: string;
          new_value: number | null;
          old_value: number | null;
        };
        Insert: {
          cell_key: string;
          changed_at?: string;
          changed_by?: string | null;
          id?: never;
          job_id: string;
          new_value?: number | null;
          old_value?: number | null;
        };
        Update: {
          cell_key?: string;
          changed_at?: string;
          changed_by?: string | null;
          id?: never;
          job_id?: string;
          new_value?: number | null;
          old_value?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_ledger_override_changes_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_ledger_overrides: {
        Row: {
          cell_key: string;
          created_at: string;
          created_by: string | null;
          job_id: string;
          updated_at: string;
          updated_by: string | null;
          value: number;
        };
        Insert: {
          cell_key: string;
          created_at?: string;
          created_by?: string | null;
          job_id: string;
          updated_at?: string;
          updated_by?: string | null;
          value: number;
        };
        Update: {
          cell_key?: string;
          created_at?: string;
          created_by?: string | null;
          job_id?: string;
          updated_at?: string;
          updated_by?: string | null;
          value?: number;
        };
        Relationships: [
          {
            foreignKeyName: "job_ledger_overrides_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_moisture_points: {
        Row: {
          created_at: string;
          created_by: string | null;
          dry_standard: number | null;
          id: string;
          job_id: string;
          location: string | null;
          material: string;
          removed_at: string | null;
          room_id: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          dry_standard?: number | null;
          id?: string;
          job_id: string;
          location?: string | null;
          material: string;
          removed_at?: string | null;
          room_id?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          dry_standard?: number | null;
          id?: string;
          job_id?: string;
          location?: string | null;
          material?: string;
          removed_at?: string | null;
          room_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_moisture_points_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_moisture_points_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "job_rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      job_moisture_readings: {
        Row: {
          captured_at: string;
          created_at: string;
          created_by: string | null;
          id: string;
          job_id: string;
          moisture_pct: number;
          notes: string | null;
          point_id: string;
          reading_date: string;
          updated_at: string;
        };
        Insert: {
          captured_at?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id: string;
          moisture_pct: number;
          notes?: string | null;
          point_id: string;
          reading_date?: string;
          updated_at?: string;
        };
        Update: {
          captured_at?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id?: string;
          moisture_pct?: number;
          notes?: string | null;
          point_id?: string;
          reading_date?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_moisture_readings_point_id_job_id_fkey";
            columns: ["point_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "job_moisture_points";
            referencedColumns: ["id", "job_id"];
          },
        ];
      };
      job_notes: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          id: string;
          is_demo: boolean;
          job_id: string;
          updated_at: string;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          updated_at?: string;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_notes_author_id_profiles_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_notes_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_number_counters: {
        Row: {
          last_value: number;
          scope_key: string;
        };
        Insert: {
          last_value?: number;
          scope_key: string;
        };
        Update: {
          last_value?: number;
          scope_key?: string;
        };
        Relationships: [];
      };
      job_number_settings: {
        Row: {
          id: boolean;
          pattern: string;
          prefix: string;
          seq_padding: number;
          seq_scope: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          id?: boolean;
          pattern?: string;
          prefix?: string;
          seq_padding?: number;
          seq_scope?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          id?: boolean;
          pattern?: string;
          prefix?: string;
          seq_padding?: number;
          seq_scope?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_number_settings_updated_by_profiles_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      job_referral_costs: {
        Row: {
          account_id: string | null;
          amount: number;
          basis: string;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          note: string | null;
          paid_on: string | null;
          rate_percent: number | null;
          source_name: string | null;
          updated_at: string;
          work_component: string | null;
        };
        Insert: {
          account_id?: string | null;
          amount?: number;
          basis?: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          note?: string | null;
          paid_on?: string | null;
          rate_percent?: number | null;
          source_name?: string | null;
          updated_at?: string;
          work_component?: string | null;
        };
        Update: {
          account_id?: string | null;
          amount?: number;
          basis?: string;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          note?: string | null;
          paid_on?: string | null;
          rate_percent?: number | null;
          source_name?: string | null;
          updated_at?: string;
          work_component?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_referral_costs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "job_referral_costs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_referral_costs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "job_referral_costs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "job_referral_costs_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_referral_costs_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_reports: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          created_at: string;
          document_id: string | null;
          edited_narrative: string | null;
          generated_by: string | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          language: string;
          location_id: string | null;
          model: string | null;
          narrative: string;
          photo_ids: string[] | null;
          report_type: Database["public"]["Enums"]["job_report_type"];
          sections: Json | null;
          snapshot: Json;
          status: Database["public"]["Enums"]["job_report_status"];
          updated_at: string;
          version: number;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          document_id?: string | null;
          edited_narrative?: string | null;
          generated_by?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          language?: string;
          location_id?: string | null;
          model?: string | null;
          narrative: string;
          photo_ids?: string[] | null;
          report_type: Database["public"]["Enums"]["job_report_type"];
          sections?: Json | null;
          snapshot: Json;
          status?: Database["public"]["Enums"]["job_report_status"];
          updated_at?: string;
          version?: number;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          document_id?: string | null;
          edited_narrative?: string | null;
          generated_by?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          language?: string;
          location_id?: string | null;
          model?: string | null;
          narrative?: string;
          photo_ids?: string[] | null;
          report_type?: Database["public"]["Enums"]["job_report_type"];
          sections?: Json | null;
          snapshot?: Json;
          status?: Database["public"]["Enums"]["job_report_status"];
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "job_reports_approved_by_profiles_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_reports_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_reports_generated_by_profiles_fkey";
            columns: ["generated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_reports_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_reports_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      job_room_cabinets: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          job_id: string;
          kind: string;
          length_ft: number | null;
          room_id: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id: string;
          kind: string;
          length_ft?: number | null;
          room_id: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id?: string;
          kind?: string;
          length_ft?: number | null;
          room_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_room_cabinets_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_room_cabinets_room_id_job_id_fkey";
            columns: ["room_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "job_rooms";
            referencedColumns: ["id", "job_id"];
          },
        ];
      };
      job_room_openings: {
        Row: {
          created_at: string;
          created_by: string | null;
          height_in: number | null;
          id: string;
          job_id: string;
          kind: string;
          qty: number;
          room_id: string;
          updated_at: string;
          width_in: number | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          height_in?: number | null;
          id?: string;
          job_id: string;
          kind: string;
          qty?: number;
          room_id: string;
          updated_at?: string;
          width_in?: number | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          height_in?: number | null;
          id?: string;
          job_id?: string;
          kind?: string;
          qty?: number;
          room_id?: string;
          updated_at?: string;
          width_in?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_room_openings_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_room_openings_room_id_job_id_fkey";
            columns: ["room_id", "job_id"];
            isOneToOne: false;
            referencedRelation: "job_rooms";
            referencedColumns: ["id", "job_id"];
          },
        ];
      };
      job_rooms: {
        Row: {
          affected_materials: string[];
          created_at: string;
          created_by: string | null;
          extra_sf: number;
          floor: string | null;
          flooring: string | null;
          height_ft: number | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          length_ft: number | null;
          name: string;
          notes: string | null;
          sort_order: number;
          unit: string | null;
          updated_at: string;
          width_ft: number | null;
        };
        Insert: {
          affected_materials?: string[];
          created_at?: string;
          created_by?: string | null;
          extra_sf?: number;
          floor?: string | null;
          flooring?: string | null;
          height_ft?: number | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          length_ft?: number | null;
          name: string;
          notes?: string | null;
          sort_order?: number;
          unit?: string | null;
          updated_at?: string;
          width_ft?: number | null;
        };
        Update: {
          affected_materials?: string[];
          created_at?: string;
          created_by?: string | null;
          extra_sf?: number;
          floor?: string | null;
          flooring?: string | null;
          height_ft?: number | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          length_ft?: number | null;
          name?: string;
          notes?: string | null;
          sort_order?: number;
          unit?: string | null;
          updated_at?: string;
          width_ft?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_rooms_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_saved_filters: {
        Row: {
          created_at: string;
          filters: Json;
          id: string;
          is_demo: boolean;
          name: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          filters?: Json;
          id?: string;
          is_demo?: boolean;
          name: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          filters?: Json;
          id?: string;
          is_demo?: boolean;
          name?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_saved_filters_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      job_section_notes: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          id: string;
          is_demo: boolean;
          job_id: string;
          section_key: string;
          updated_at: string;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          section_key: string;
          updated_at?: string;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          section_key?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_section_notes_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_status_history: {
        Row: {
          changed_at: string;
          changed_by: string | null;
          from_status: Database["public"]["Enums"]["job_status"] | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          to_status: Database["public"]["Enums"]["job_status"];
        };
        Insert: {
          changed_at?: string;
          changed_by?: string | null;
          from_status?: Database["public"]["Enums"]["job_status"] | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          to_status: Database["public"]["Enums"]["job_status"];
        };
        Update: {
          changed_at?: string;
          changed_by?: string | null;
          from_status?: Database["public"]["Enums"]["job_status"] | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          to_status?: Database["public"]["Enums"]["job_status"];
        };
        Relationships: [
          {
            foreignKeyName: "job_status_history_changed_by_profiles_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_status_history_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_tags: {
        Row: {
          created_at: string;
          created_by: string | null;
          is_demo: boolean;
          job_id: string;
          tag_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          job_id: string;
          tag_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          job_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_tags_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "job_tags_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      job_task_sections: {
        Row: {
          active: boolean;
          added_when: string;
          builtin: boolean;
          created_at: string;
          created_by: string | null;
          due_rule: string;
          job_scopes: string[];
          key: string;
          label: string;
          sort_order: number;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          active?: boolean;
          added_when: string;
          builtin?: boolean;
          created_at?: string;
          created_by?: string | null;
          due_rule: string;
          job_scopes: string[];
          key?: string;
          label: string;
          sort_order?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          active?: boolean;
          added_when?: string;
          builtin?: boolean;
          created_at?: string;
          created_by?: string | null;
          due_rule?: string;
          job_scopes?: string[];
          key?: string;
          label?: string;
          sort_order?: number;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      job_task_seed_keys: {
        Row: {
          cadence_key: string;
          first_seeded_at: string;
          job_id: string;
        };
        Insert: {
          cadence_key: string;
          first_seeded_at?: string;
          job_id: string;
        };
        Update: {
          cadence_key?: string;
          first_seeded_at?: string;
          job_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "job_task_seed_keys_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      job_task_seeding_settings: {
        Row: {
          job_scope: string;
          seed_equipment_tasks: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          job_scope: string;
          seed_equipment_tasks?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          job_scope?: string;
          seed_equipment_tasks?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      job_task_templates: {
        Row: {
          active: boolean;
          created_at: string;
          description: string | null;
          group_key: string;
          id: string;
          sort_order: number;
          task_key: string;
          title: string;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          description?: string | null;
          group_key: string;
          id?: string;
          sort_order?: number;
          task_key?: string;
          title: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          description?: string | null;
          group_key?: string;
          id?: string;
          sort_order?: number;
          task_key?: string;
          title?: string;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_task_templates_section_fk";
            columns: ["group_key"];
            isOneToOne: false;
            referencedRelation: "job_task_sections";
            referencedColumns: ["key"];
          },
        ];
      };
      job_tm_forms: {
        Row: {
          captured_at: string | null;
          created_at: string;
          created_by: string | null;
          document_id: string | null;
          form_date: string;
          id: string;
          job_id: string;
          kind: string;
          payload: Json;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          captured_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          form_date: string;
          id?: string;
          job_id: string;
          kind: string;
          payload?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          captured_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          form_date?: string;
          id?: string;
          job_id?: string;
          kind?: string;
          payload?: Json;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "job_tm_forms_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "job_tm_forms_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      jobs: {
        Row: {
          account_id: string | null;
          additional_work_pending: boolean;
          address: string;
          address_line2: string | null;
          adjuster_email: string | null;
          adjuster_name: string | null;
          adjuster_phone: string | null;
          agreed_price: number | null;
          approved_amount: number | null;
          bill_to_account_id: string | null;
          bill_to_attention: string | null;
          billed_amount: number | null;
          billing_location_id: string | null;
          call_date: string | null;
          call_time: string | null;
          cash_payer_name: string | null;
          claim_number: string | null;
          collected_amount: number | null;
          commission_flat_amount: number | null;
          commission_paid_amount: number | null;
          commission_paid_by: string | null;
          commission_paid_on: string | null;
          commission_paid_ref: string | null;
          commission_rate_pct: number | null;
          commission_source: string | null;
          credit_locked_at: string | null;
          credit_rep_id: string | null;
          credit_requires_approval: boolean | null;
          credit_stage_key: string | null;
          community: string | null;
          completion_date: string | null;
          county: string | null;
          created_at: string;
          created_by: string | null;
          crew_chief: string | null;
          customer_kind: string | null;
          customer_name: string | null;
          deductible: number | null;
          deposit_amount: number | null;
          desk_adjuster_contact_id: string | null;
          desk_adjuster_email: string | null;
          desk_adjuster_name: string | null;
          desk_adjuster_phone: string | null;
          estimated_amount: number | null;
          external_id: string | null;
          external_source: string | null;
          field_adjuster_contact_id: string | null;
          field_adjuster_email: string | null;
          field_adjuster_name: string | null;
          field_adjuster_phone: string | null;
          field_next_step: string | null;
          fire_lead_id: string | null;
          first_response_at: string | null;
          geom: unknown;
          hoa: boolean | null;
          id: string;
          important_instructions_urgent: boolean;
          important_instructions: string | null;
          independent_reviewer_account_id: string | null;
          independent_reviewer_contact_id: string | null;
          independent_reviewer_email: string | null;
          independent_reviewer_firm: string | null;
          independent_reviewer_name: string | null;
          independent_reviewer_phone: string | null;
          initial_loss_description: string | null;
          insurance_agency: string | null;
          insurance_agency_account_id: string | null;
          insurance_agent_email: string | null;
          insurance_agent_name: string | null;
          insurance_agent_phone: string | null;
          insurance_carrier: string | null;
          insurance_carrier_account_id: string | null;
          insurance_kind: string | null;
          insurance_kind_detail: string | null;
          is_demo: boolean;
          is_large_loss: boolean;
          job_name: string | null;
          job_number: string;
          job_type: string | null;
          job_type_detail: string | null;
          lat: number | null;
          locality: string | null;
          location_id: string;
          lon: number | null;
          loss_date: string | null;
          loss_description: string | null;
          loss_description_detail: string | null;
          loss_type: string | null;
          loss_type_detail: string | null;
          loss_type_id: string | null;
          office_next_step: string | null;
          payment_terms: string | null;
          pipeline_id: string | null;
          policy_number: string | null;
          postal_code: string | null;
          primary_contact_id: string | null;
          priority: string | null;
          public_adjuster_account_id: string | null;
          public_adjuster_contact_id: string | null;
          public_adjuster_email: string | null;
          public_adjuster_name: string | null;
          public_adjuster_phone: string | null;
          referral_source_type: string | null;
          referral_source_type_detail: string | null;
          referred_by_account_id: string | null;
          referred_by_contact_id: string | null;
          referred_by_name: string | null;
          region: string | null;
          rehabbed_after_1978: boolean | null;
          reported_source_detail: string | null;
          reported_source_id: string | null;
          scope: string | null;
          stage_entered_at: string | null;
          stage_id: string | null;
          start_date: string | null;
          status: Database["public"]["Enums"]["job_status"];
          third_party_company: string | null;
          tradeshow_id: string | null;
          updated_at: string;
          water_category: number | null;
          water_class: number | null;
        };
        Insert: {
          account_id?: string | null;
          additional_work_pending?: boolean;
          address: string;
          address_line2?: string | null;
          adjuster_email?: string | null;
          adjuster_name?: string | null;
          adjuster_phone?: string | null;
          agreed_price?: number | null;
          approved_amount?: number | null;
          bill_to_account_id?: string | null;
          bill_to_attention?: string | null;
          billed_amount?: number | null;
          billing_location_id?: string | null;
          call_date?: string | null;
          call_time?: string | null;
          cash_payer_name?: string | null;
          claim_number?: string | null;
          collected_amount?: number | null;
          commission_flat_amount?: number | null;
          commission_paid_amount?: number | null;
          commission_paid_by?: string | null;
          commission_paid_on?: string | null;
          commission_paid_ref?: string | null;
          commission_rate_pct?: number | null;
          commission_source?: string | null;
          credit_locked_at?: string | null;
          credit_rep_id?: string | null;
          credit_requires_approval?: boolean | null;
          credit_stage_key?: string | null;
          community?: string | null;
          completion_date?: string | null;
          county?: string | null;
          created_at?: string;
          created_by?: string | null;
          crew_chief?: string | null;
          customer_kind?: string | null;
          customer_name?: string | null;
          deductible?: number | null;
          deposit_amount?: number | null;
          desk_adjuster_contact_id?: string | null;
          desk_adjuster_email?: string | null;
          desk_adjuster_name?: string | null;
          desk_adjuster_phone?: string | null;
          estimated_amount?: number | null;
          external_id?: string | null;
          external_source?: string | null;
          field_adjuster_contact_id?: string | null;
          field_adjuster_email?: string | null;
          field_adjuster_name?: string | null;
          field_adjuster_phone?: string | null;
          field_next_step?: string | null;
          fire_lead_id?: string | null;
          first_response_at?: string | null;
          geom?: unknown;
          hoa?: boolean | null;
          id?: string;
          important_instructions_urgent?: boolean;
          important_instructions?: string | null;
          independent_reviewer_account_id?: string | null;
          independent_reviewer_contact_id?: string | null;
          independent_reviewer_email?: string | null;
          independent_reviewer_firm?: string | null;
          independent_reviewer_name?: string | null;
          independent_reviewer_phone?: string | null;
          initial_loss_description?: string | null;
          insurance_agency?: string | null;
          insurance_agency_account_id?: string | null;
          insurance_agent_email?: string | null;
          insurance_agent_name?: string | null;
          insurance_agent_phone?: string | null;
          insurance_carrier?: string | null;
          insurance_carrier_account_id?: string | null;
          insurance_kind?: string | null;
          insurance_kind_detail?: string | null;
          is_demo?: boolean;
          is_large_loss?: boolean;
          job_name?: string | null;
          job_number: string;
          job_type?: string | null;
          job_type_detail?: string | null;
          lat?: number | null;
          locality?: string | null;
          location_id: string;
          lon?: number | null;
          loss_date?: string | null;
          loss_description?: string | null;
          loss_description_detail?: string | null;
          loss_type?: string | null;
          loss_type_detail?: string | null;
          loss_type_id?: string | null;
          office_next_step?: string | null;
          payment_terms?: string | null;
          pipeline_id?: string | null;
          policy_number?: string | null;
          postal_code?: string | null;
          primary_contact_id?: string | null;
          priority?: string | null;
          public_adjuster_account_id?: string | null;
          public_adjuster_contact_id?: string | null;
          public_adjuster_email?: string | null;
          public_adjuster_name?: string | null;
          public_adjuster_phone?: string | null;
          referral_source_type?: string | null;
          referral_source_type_detail?: string | null;
          referred_by_account_id?: string | null;
          referred_by_contact_id?: string | null;
          referred_by_name?: string | null;
          region?: string | null;
          rehabbed_after_1978?: boolean | null;
          reported_source_detail?: string | null;
          reported_source_id?: string | null;
          scope?: string | null;
          stage_entered_at?: string | null;
          stage_id?: string | null;
          start_date?: string | null;
          status?: Database["public"]["Enums"]["job_status"];
          third_party_company?: string | null;
          tradeshow_id?: string | null;
          updated_at?: string;
          water_category?: number | null;
          water_class?: number | null;
        };
        Update: {
          account_id?: string | null;
          additional_work_pending?: boolean;
          address?: string;
          address_line2?: string | null;
          adjuster_email?: string | null;
          adjuster_name?: string | null;
          adjuster_phone?: string | null;
          agreed_price?: number | null;
          approved_amount?: number | null;
          bill_to_account_id?: string | null;
          bill_to_attention?: string | null;
          billed_amount?: number | null;
          billing_location_id?: string | null;
          call_date?: string | null;
          call_time?: string | null;
          cash_payer_name?: string | null;
          claim_number?: string | null;
          collected_amount?: number | null;
          commission_flat_amount?: number | null;
          commission_paid_amount?: number | null;
          commission_paid_by?: string | null;
          commission_paid_on?: string | null;
          commission_paid_ref?: string | null;
          commission_rate_pct?: number | null;
          commission_source?: string | null;
          credit_locked_at?: string | null;
          credit_rep_id?: string | null;
          credit_requires_approval?: boolean | null;
          credit_stage_key?: string | null;
          community?: string | null;
          completion_date?: string | null;
          county?: string | null;
          created_at?: string;
          created_by?: string | null;
          crew_chief?: string | null;
          customer_kind?: string | null;
          customer_name?: string | null;
          deductible?: number | null;
          deposit_amount?: number | null;
          desk_adjuster_contact_id?: string | null;
          desk_adjuster_email?: string | null;
          desk_adjuster_name?: string | null;
          desk_adjuster_phone?: string | null;
          estimated_amount?: number | null;
          external_id?: string | null;
          external_source?: string | null;
          field_adjuster_contact_id?: string | null;
          field_adjuster_email?: string | null;
          field_adjuster_name?: string | null;
          field_adjuster_phone?: string | null;
          field_next_step?: string | null;
          fire_lead_id?: string | null;
          first_response_at?: string | null;
          geom?: unknown;
          hoa?: boolean | null;
          id?: string;
          important_instructions_urgent?: boolean;
          important_instructions?: string | null;
          independent_reviewer_account_id?: string | null;
          independent_reviewer_contact_id?: string | null;
          independent_reviewer_email?: string | null;
          independent_reviewer_firm?: string | null;
          independent_reviewer_name?: string | null;
          independent_reviewer_phone?: string | null;
          initial_loss_description?: string | null;
          insurance_agency?: string | null;
          insurance_agency_account_id?: string | null;
          insurance_agent_email?: string | null;
          insurance_agent_name?: string | null;
          insurance_agent_phone?: string | null;
          insurance_carrier?: string | null;
          insurance_carrier_account_id?: string | null;
          insurance_kind?: string | null;
          insurance_kind_detail?: string | null;
          is_demo?: boolean;
          is_large_loss?: boolean;
          job_name?: string | null;
          job_number?: string;
          job_type?: string | null;
          job_type_detail?: string | null;
          lat?: number | null;
          locality?: string | null;
          location_id?: string;
          lon?: number | null;
          loss_date?: string | null;
          loss_description?: string | null;
          loss_description_detail?: string | null;
          loss_type?: string | null;
          loss_type_detail?: string | null;
          loss_type_id?: string | null;
          office_next_step?: string | null;
          payment_terms?: string | null;
          pipeline_id?: string | null;
          policy_number?: string | null;
          postal_code?: string | null;
          primary_contact_id?: string | null;
          priority?: string | null;
          public_adjuster_account_id?: string | null;
          public_adjuster_contact_id?: string | null;
          public_adjuster_email?: string | null;
          public_adjuster_name?: string | null;
          public_adjuster_phone?: string | null;
          referral_source_type?: string | null;
          referral_source_type_detail?: string | null;
          referred_by_account_id?: string | null;
          referred_by_contact_id?: string | null;
          referred_by_name?: string | null;
          region?: string | null;
          rehabbed_after_1978?: boolean | null;
          reported_source_detail?: string | null;
          reported_source_id?: string | null;
          scope?: string | null;
          stage_entered_at?: string | null;
          stage_id?: string | null;
          start_date?: string | null;
          status?: Database["public"]["Enums"]["job_status"];
          third_party_company?: string | null;
          tradeshow_id?: string | null;
          updated_at?: string;
          water_category?: number | null;
          water_class?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "jobs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_bill_to_account_id_fkey";
            columns: ["bill_to_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_bill_to_account_id_fkey";
            columns: ["bill_to_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_bill_to_account_id_fkey";
            columns: ["bill_to_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_billing_location_id_fkey";
            columns: ["billing_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "jobs_crew_chief_profiles_fkey";
            columns: ["crew_chief"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "jobs_desk_adjuster_contact_id_fkey";
            columns: ["desk_adjuster_contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "jobs_desk_adjuster_contact_id_fkey";
            columns: ["desk_adjuster_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_field_adjuster_contact_id_fkey";
            columns: ["field_adjuster_contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "jobs_field_adjuster_contact_id_fkey";
            columns: ["field_adjuster_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_fire_lead_id_fkey";
            columns: ["fire_lead_id"];
            isOneToOne: false;
            referencedRelation: "fire_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_independent_reviewer_account_id_fkey";
            columns: ["independent_reviewer_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_independent_reviewer_account_id_fkey";
            columns: ["independent_reviewer_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_independent_reviewer_account_id_fkey";
            columns: ["independent_reviewer_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_independent_reviewer_contact_id_fkey";
            columns: ["independent_reviewer_contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "jobs_independent_reviewer_contact_id_fkey";
            columns: ["independent_reviewer_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_insurance_agency_account_id_fkey";
            columns: ["insurance_agency_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_insurance_agency_account_id_fkey";
            columns: ["insurance_agency_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_insurance_agency_account_id_fkey";
            columns: ["insurance_agency_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_insurance_carrier_account_id_fkey";
            columns: ["insurance_carrier_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_insurance_carrier_account_id_fkey";
            columns: ["insurance_carrier_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_insurance_carrier_account_id_fkey";
            columns: ["insurance_carrier_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_loss_type_id_fkey";
            columns: ["loss_type_id"];
            isOneToOne: false;
            referencedRelation: "option_list_values";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_primary_contact_id_fkey";
            columns: ["primary_contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "jobs_primary_contact_id_fkey";
            columns: ["primary_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_public_adjuster_account_id_fkey";
            columns: ["public_adjuster_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_public_adjuster_account_id_fkey";
            columns: ["public_adjuster_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_public_adjuster_account_id_fkey";
            columns: ["public_adjuster_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_public_adjuster_contact_id_fkey";
            columns: ["public_adjuster_contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "jobs_public_adjuster_contact_id_fkey";
            columns: ["public_adjuster_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_referred_by_account_id_fkey";
            columns: ["referred_by_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_referred_by_account_id_fkey";
            columns: ["referred_by_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_referred_by_account_id_fkey";
            columns: ["referred_by_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "jobs_referred_by_contact_id_fkey";
            columns: ["referred_by_contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "jobs_referred_by_contact_id_fkey";
            columns: ["referred_by_contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_reported_source_id_fkey";
            columns: ["reported_source_id"];
            isOneToOne: false;
            referencedRelation: "reported_sources";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "jobs_tradeshow_id_fkey";
            columns: ["tradeshow_id"];
            isOneToOne: false;
            referencedRelation: "tradeshows";
            referencedColumns: ["id"];
          },
        ];
      };
      labour_rates: {
        Row: {
          created_at: string;
          created_by: string | null;
          crew_class: string | null;
          effective_from: string;
          effective_to: string | null;
          hourly_rate: number;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          note: string | null;
          role: Database["public"]["Enums"]["app_role"] | null;
          updated_at: string;
          user_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          crew_class?: string | null;
          effective_from: string;
          effective_to?: string | null;
          hourly_rate: number;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          note?: string | null;
          role?: Database["public"]["Enums"]["app_role"] | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          crew_class?: string | null;
          effective_from?: string;
          effective_to?: string | null;
          hourly_rate?: number;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          note?: string | null;
          role?: Database["public"]["Enums"]["app_role"] | null;
          updated_at?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "labour_rates_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "labour_rates_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "labour_rates_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      layout_default_events: {
        Row: {
          action: string;
          actor_id: string | null;
          affected_users: number | null;
          created_at: string;
          id: string;
          payload: Json | null;
          role_key: string;
          scope: string;
        };
        Insert: {
          action: string;
          actor_id?: string | null;
          affected_users?: number | null;
          created_at?: string;
          id?: string;
          payload?: Json | null;
          role_key: string;
          scope: string;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          affected_users?: number | null;
          created_at?: string;
          id?: string;
          payload?: Json | null;
          role_key?: string;
          scope?: string;
        };
        Relationships: [];
      };
      layout_defaults: {
        Row: {
          created_at: string;
          id: string;
          payload: Json;
          published_at: string;
          published_by: string | null;
          role_key: string;
          scope: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          payload: Json;
          published_at?: string;
          published_by?: string | null;
          role_key?: string;
          scope: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          payload?: Json;
          published_at?: string;
          published_by?: string | null;
          role_key?: string;
          scope?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      lead_events: {
        Row: {
          actor_id: string | null;
          event_type: Database["public"]["Enums"]["lead_event_type"];
          id: string;
          is_demo: boolean;
          lead_id: string;
          occurred_at: string;
          payload: Json;
        };
        Insert: {
          actor_id?: string | null;
          event_type: Database["public"]["Enums"]["lead_event_type"];
          id?: string;
          is_demo?: boolean;
          lead_id: string;
          occurred_at?: string;
          payload?: Json;
        };
        Update: {
          actor_id?: string | null;
          event_type?: Database["public"]["Enums"]["lead_event_type"];
          id?: string;
          is_demo?: boolean;
          lead_id?: string;
          occurred_at?: string;
          payload?: Json;
        };
        Relationships: [
          {
            foreignKeyName: "lead_events_actor_id_profiles_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "lead_events_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "fire_leads";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_notes: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          id: string;
          is_demo: boolean;
          lead_id: string;
          updated_at: string;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          lead_id: string;
          updated_at?: string;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          lead_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lead_notes_author_id_profiles_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "lead_notes_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "fire_leads";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_stage_history: {
        Row: {
          changed_at: string;
          changed_by: string | null;
          from_stage: Database["public"]["Enums"]["pipeline_stage"] | null;
          id: string;
          is_demo: boolean;
          lead_id: string;
          to_stage: Database["public"]["Enums"]["pipeline_stage"];
        };
        Insert: {
          changed_at?: string;
          changed_by?: string | null;
          from_stage?: Database["public"]["Enums"]["pipeline_stage"] | null;
          id?: string;
          is_demo?: boolean;
          lead_id: string;
          to_stage: Database["public"]["Enums"]["pipeline_stage"];
        };
        Update: {
          changed_at?: string;
          changed_by?: string | null;
          from_stage?: Database["public"]["Enums"]["pipeline_stage"] | null;
          id?: string;
          is_demo?: boolean;
          lead_id?: string;
          to_stage?: Database["public"]["Enums"]["pipeline_stage"];
        };
        Relationships: [
          {
            foreignKeyName: "lead_stage_history_changed_by_profiles_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "lead_stage_history_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "fire_leads";
            referencedColumns: ["id"];
          },
        ];
      };
      lead_tags: {
        Row: {
          created_at: string;
          created_by: string | null;
          is_demo: boolean;
          lead_id: string;
          tag_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          lead_id: string;
          tag_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          lead_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "lead_tags_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "lead_tags_lead_id_fkey";
            columns: ["lead_id"];
            isOneToOne: false;
            referencedRelation: "fire_leads";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "lead_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      leaderboard_achievements: {
        Row: {
          active: boolean;
          color: string;
          created_at: string;
          description: string | null;
          icon: string;
          id: string;
          is_demo: boolean;
          key: string;
          metric: string;
          name: string;
          rarity: string;
          rule_key: string;
          sort_order: number;
          threshold: number;
          updated_at: string;
          window_kind: string;
        };
        Insert: {
          active?: boolean;
          color?: string;
          created_at?: string;
          description?: string | null;
          icon?: string;
          id?: string;
          is_demo?: boolean;
          key: string;
          metric?: string;
          name: string;
          rarity?: string;
          rule_key?: string;
          sort_order?: number;
          threshold?: number;
          updated_at?: string;
          window_kind?: string;
        };
        Update: {
          active?: boolean;
          color?: string;
          created_at?: string;
          description?: string | null;
          icon?: string;
          id?: string;
          is_demo?: boolean;
          key?: string;
          metric?: string;
          name?: string;
          rarity?: string;
          rule_key?: string;
          sort_order?: number;
          threshold?: number;
          updated_at?: string;
          window_kind?: string;
        };
        Relationships: [];
      };
      leaderboard_challenges: {
        Row: {
          active: boolean;
          bonus_text: string | null;
          created_at: string;
          description: string | null;
          ends_at: string;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          metric: string;
          name: string;
          starts_at: string;
          target: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          bonus_text?: string | null;
          created_at?: string;
          description?: string | null;
          ends_at?: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          metric?: string;
          name: string;
          starts_at?: string;
          target?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          bonus_text?: string | null;
          created_at?: string;
          description?: string | null;
          ends_at?: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          metric?: string;
          name?: string;
          starts_at?: string;
          target?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "leaderboard_challenges_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      leaderboard_kudos: {
        Row: {
          body: string;
          created_at: string;
          from_user_id: string;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          to_user_id: string;
          updated_at: string;
          user_achievement_id: string | null;
        };
        Insert: {
          body: string;
          created_at?: string;
          from_user_id: string;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          to_user_id: string;
          updated_at?: string;
          user_achievement_id?: string | null;
        };
        Update: {
          body?: string;
          created_at?: string;
          from_user_id?: string;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          to_user_id?: string;
          updated_at?: string;
          user_achievement_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "leaderboard_kudos_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "leaderboard_kudos_user_achievement_id_fkey";
            columns: ["user_achievement_id"];
            isOneToOne: false;
            referencedRelation: "user_achievements";
            referencedColumns: ["id"];
          },
        ];
      };
      location_group_members: {
        Row: {
          created_at: string;
          group_id: string;
          id: string;
          location_id: string;
        };
        Insert: {
          created_at?: string;
          group_id: string;
          id?: string;
          location_id: string;
        };
        Update: {
          created_at?: string;
          group_id?: string;
          id?: string;
          location_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "location_group_members_group_id_fkey";
            columns: ["group_id"];
            isOneToOne: false;
            referencedRelation: "location_groups";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "location_group_members_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      location_groups: {
        Row: {
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          name: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          name?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      location_members: {
        Row: {
          created_at: string;
          id: string;
          is_demo: boolean;
          location_id: string;
          role: Database["public"]["Enums"]["location_member_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          location_id: string;
          role?: Database["public"]["Enums"]["location_member_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string;
          role?: Database["public"]["Enums"]["location_member_role"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "location_members_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "location_members_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      location_regions: {
        Row: {
          created_at: string;
          id: string;
          location_id: string;
          region_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          location_id: string;
          region_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          location_id?: string;
          region_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "location_regions_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "location_regions_region_id_fkey";
            columns: ["region_id"];
            isOneToOne: false;
            referencedRelation: "regions";
            referencedColumns: ["id"];
          },
        ];
      };
      locations: {
        Row: {
          active: boolean;
          address: string;
          card_payment_url: string | null;
          card_payments_offered: boolean;
          code: string;
          created_at: string;
          ein: string | null;
          geom: unknown;
          id: string;
          lat: number;
          legal_entity_name: string | null;
          locality: string | null;
          logo_url: string | null;
          lon: number;
          manager_email: string | null;
          manager_extension: string | null;
          manager_mobile: string | null;
          manager_name: string | null;
          name: string;
          office_email: string | null;
          office_phone: string | null;
          payment_options_text: string | null;
          postal_code: string | null;
          region: string;
          region_id: string | null;
          territory: unknown;
          updated_at: string;
          zelle_email: string | null;
        };
        Insert: {
          active?: boolean;
          address: string;
          card_payment_url?: string | null;
          card_payments_offered?: boolean;
          code: string;
          created_at?: string;
          ein?: string | null;
          geom?: unknown;
          id?: string;
          lat: number;
          legal_entity_name?: string | null;
          locality?: string | null;
          logo_url?: string | null;
          lon: number;
          manager_email?: string | null;
          manager_extension?: string | null;
          manager_mobile?: string | null;
          manager_name?: string | null;
          name: string;
          office_email?: string | null;
          office_phone?: string | null;
          payment_options_text?: string | null;
          postal_code?: string | null;
          region: string;
          region_id?: string | null;
          territory?: unknown;
          updated_at?: string;
          zelle_email?: string | null;
        };
        Update: {
          active?: boolean;
          address?: string;
          card_payment_url?: string | null;
          card_payments_offered?: boolean;
          code?: string;
          created_at?: string;
          ein?: string | null;
          geom?: unknown;
          id?: string;
          lat?: number;
          legal_entity_name?: string | null;
          locality?: string | null;
          logo_url?: string | null;
          lon?: number;
          manager_email?: string | null;
          manager_extension?: string | null;
          manager_mobile?: string | null;
          manager_name?: string | null;
          name?: string;
          office_email?: string | null;
          office_phone?: string | null;
          payment_options_text?: string | null;
          postal_code?: string | null;
          region?: string;
          region_id?: string | null;
          territory?: unknown;
          updated_at?: string;
          zelle_email?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "locations_region_id_fkey";
            columns: ["region_id"];
            isOneToOne: false;
            referencedRelation: "regions";
            referencedColumns: ["id"];
          },
        ];
      };
      markets: {
        Row: {
          code: string;
          created_at: string;
          escalation_interval_seconds: number;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          name: string;
          shift_end_time: string | null;
          shift_start_time: string | null;
          updated_at: string;
        };
        Insert: {
          code: string;
          created_at?: string;
          escalation_interval_seconds?: number;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name: string;
          shift_end_time?: string | null;
          shift_start_time?: string | null;
          updated_at?: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          escalation_interval_seconds?: number;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name?: string;
          shift_end_time?: string | null;
          shift_start_time?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      message_attachments: {
        Row: {
          created_at: string;
          duration_seconds: number | null;
          height: number | null;
          id: string;
          is_demo: boolean;
          kind: Database["public"]["Enums"]["attachment_kind"];
          message_id: string;
          mime: string | null;
          size_bytes: number | null;
          storage_path: string;
          thumbnail_path: string | null;
          waveform_peaks: Json | null;
          width: number | null;
        };
        Insert: {
          created_at?: string;
          duration_seconds?: number | null;
          height?: number | null;
          id?: string;
          is_demo?: boolean;
          kind: Database["public"]["Enums"]["attachment_kind"];
          message_id: string;
          mime?: string | null;
          size_bytes?: number | null;
          storage_path: string;
          thumbnail_path?: string | null;
          waveform_peaks?: Json | null;
          width?: number | null;
        };
        Update: {
          created_at?: string;
          duration_seconds?: number | null;
          height?: number | null;
          id?: string;
          is_demo?: boolean;
          kind?: Database["public"]["Enums"]["attachment_kind"];
          message_id?: string;
          mime?: string | null;
          size_bytes?: number | null;
          storage_path?: string;
          thumbnail_path?: string | null;
          waveform_peaks?: Json | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "message_attachments_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
        ];
      };
      message_reactions: {
        Row: {
          created_at: string;
          emoji: string;
          is_demo: boolean;
          message_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          emoji: string;
          is_demo?: boolean;
          message_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          emoji?: string;
          is_demo?: boolean;
          message_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_reactions_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_reactions_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      message_receipts: {
        Row: {
          delivered_at: string;
          is_demo: boolean;
          message_id: string;
          read_at: string | null;
          user_id: string;
        };
        Insert: {
          delivered_at?: string;
          is_demo?: boolean;
          message_id: string;
          read_at?: string | null;
          user_id: string;
        };
        Update: {
          delivered_at?: string;
          is_demo?: boolean;
          message_id?: string;
          read_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "message_receipts_message_id_fkey";
            columns: ["message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "message_receipts_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      messages: {
        Row: {
          author_kind: string;
          body: string | null;
          conversation_id: string;
          deleted_at: string | null;
          edited_at: string | null;
          id: string;
          is_demo: boolean;
          metadata: Json;
          reply_to_message_id: string | null;
          sender_id: string;
          sent_at: string;
          shared_record_id: string | null;
          shared_record_type: string | null;
        };
        Insert: {
          author_kind?: string;
          body?: string | null;
          conversation_id: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          id?: string;
          is_demo?: boolean;
          metadata?: Json;
          reply_to_message_id?: string | null;
          sender_id: string;
          sent_at?: string;
          shared_record_id?: string | null;
          shared_record_type?: string | null;
        };
        Update: {
          author_kind?: string;
          body?: string | null;
          conversation_id?: string;
          deleted_at?: string | null;
          edited_at?: string | null;
          id?: string;
          is_demo?: boolean;
          metadata?: Json;
          reply_to_message_id?: string | null;
          sender_id?: string;
          sent_at?: string;
          shared_record_id?: string | null;
          shared_record_type?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey";
            columns: ["conversation_id"];
            isOneToOne: false;
            referencedRelation: "conversations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_reply_to_message_id_fkey";
            columns: ["reply_to_message_id"];
            isOneToOne: false;
            referencedRelation: "messages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "messages_sender_id_profiles_fkey";
            columns: ["sender_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      microsoft_connection_secrets: {
        Row: {
          refresh_token_ciphertext: string;
          refresh_token_iv: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          refresh_token_ciphertext: string;
          refresh_token_iv: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          refresh_token_ciphertext?: string;
          refresh_token_iv?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "microsoft_connection_secrets_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: true;
            referencedRelation: "microsoft_connections";
            referencedColumns: ["user_id"];
          },
        ];
      };
      microsoft_connections: {
        Row: {
          connected_at: string;
          display_name: string | null;
          last_error: string | null;
          last_refreshed_at: string | null;
          ms_user_id: string;
          scopes: string[];
          status: string;
          tenant_id: string;
          updated_at: string;
          upn: string;
          user_id: string;
        };
        Insert: {
          connected_at?: string;
          display_name?: string | null;
          last_error?: string | null;
          last_refreshed_at?: string | null;
          ms_user_id: string;
          scopes?: string[];
          status?: string;
          tenant_id: string;
          updated_at?: string;
          upn: string;
          user_id: string;
        };
        Update: {
          connected_at?: string;
          display_name?: string | null;
          last_error?: string | null;
          last_refreshed_at?: string | null;
          ms_user_id?: string;
          scopes?: string[];
          status?: string;
          tenant_id?: string;
          updated_at?: string;
          upn?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      money_events: {
        Row: {
          account_id: string | null;
          amount: number | null;
          created_at: string;
          created_by: string | null;
          event_type: Database["public"]["Enums"]["money_event_type"];
          id: string;
          invoice_id: string | null;
          is_demo: boolean;
          job_id: string | null;
          location_id: string | null;
          notes: string | null;
          reference: string | null;
          rep_user_id: string;
        };
        Insert: {
          account_id?: string | null;
          amount?: number | null;
          created_at?: string;
          created_by?: string | null;
          event_type: Database["public"]["Enums"]["money_event_type"];
          id?: string;
          invoice_id?: string | null;
          is_demo?: boolean;
          job_id?: string | null;
          location_id?: string | null;
          notes?: string | null;
          reference?: string | null;
          rep_user_id: string;
        };
        Update: {
          account_id?: string | null;
          amount?: number | null;
          created_at?: string;
          created_by?: string | null;
          event_type?: Database["public"]["Enums"]["money_event_type"];
          id?: string;
          invoice_id?: string | null;
          is_demo?: boolean;
          job_id?: string | null;
          location_id?: string | null;
          notes?: string | null;
          reference?: string | null;
          rep_user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "money_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "money_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "money_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "money_events_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "money_events_invoice_id_fkey";
            columns: ["invoice_id"];
            isOneToOne: false;
            referencedRelation: "invoices";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "money_events_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "money_events_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      network_memberships: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          entity_name: string;
          id: string;
          is_demo: boolean;
          joined_on: string | null;
          location_id: string;
          member_id: string | null;
          network_id: string;
          notes: string | null;
          programs: string[];
          renews_on: string | null;
          states_serviced: string[];
          status: Database["public"]["Enums"]["network_membership_status"];
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          entity_name: string;
          id?: string;
          is_demo?: boolean;
          joined_on?: string | null;
          location_id: string;
          member_id?: string | null;
          network_id: string;
          notes?: string | null;
          programs?: string[];
          renews_on?: string | null;
          states_serviced?: string[];
          status?: Database["public"]["Enums"]["network_membership_status"];
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          entity_name?: string;
          id?: string;
          is_demo?: boolean;
          joined_on?: string | null;
          location_id?: string;
          member_id?: string | null;
          network_id?: string;
          notes?: string | null;
          programs?: string[];
          renews_on?: string | null;
          states_serviced?: string[];
          status?: Database["public"]["Enums"]["network_membership_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "network_memberships_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "network_memberships_network_id_fkey";
            columns: ["network_id"];
            isOneToOne: false;
            referencedRelation: "networks";
            referencedColumns: ["id"];
          },
        ];
      };
      network_requirements: {
        Row: {
          active: boolean;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          mandatory: boolean;
          membership_id: string;
          notes: string | null;
          renewal_lead_days: number;
          required_amount: number | null;
          required_currency: string;
          required_value: string | null;
          requirement_type: string;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          mandatory?: boolean;
          membership_id: string;
          notes?: string | null;
          renewal_lead_days?: number;
          required_amount?: number | null;
          required_currency?: string;
          required_value?: string | null;
          requirement_type: string;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          mandatory?: boolean;
          membership_id?: string;
          notes?: string | null;
          renewal_lead_days?: number;
          required_amount?: number | null;
          required_currency?: string;
          required_value?: string | null;
          requirement_type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "network_requirements_membership_id_fkey";
            columns: ["membership_id"];
            isOneToOne: false;
            referencedRelation: "network_memberships";
            referencedColumns: ["id"];
          },
        ];
      };
      networks: {
        Row: {
          active: boolean;
          code: string | null;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          name: string;
          notes: string | null;
          updated_at: string;
          website: string | null;
        };
        Insert: {
          active?: boolean;
          code?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name: string;
          notes?: string | null;
          updated_at?: string;
          website?: string | null;
        };
        Update: {
          active?: boolean;
          code?: string | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name?: string;
          notes?: string | null;
          updated_at?: string;
          website?: string | null;
        };
        Relationships: [];
      };
      no_service_reasons: {
        Row: {
          code: string;
          created_at: string;
          is_active: boolean;
          label: string;
          sort_order: number;
        };
        Insert: {
          code: string;
          created_at?: string;
          is_active?: boolean;
          label: string;
          sort_order?: number;
        };
        Update: {
          code?: string;
          created_at?: string;
          is_active?: boolean;
          label?: string;
          sort_order?: number;
        };
        Relationships: [];
      };
      notification_preferences: {
        Row: {
          delivery: Database["public"]["Enums"]["notification_delivery"];
          email: boolean;
          id: string;
          in_app: boolean;
          is_demo: boolean;
          quiet_hours_end: number | null;
          quiet_hours_start: number | null;
          type: Database["public"]["Enums"]["notification_type"];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          delivery?: Database["public"]["Enums"]["notification_delivery"];
          email?: boolean;
          id?: string;
          in_app?: boolean;
          is_demo?: boolean;
          quiet_hours_end?: number | null;
          quiet_hours_start?: number | null;
          type: Database["public"]["Enums"]["notification_type"];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          delivery?: Database["public"]["Enums"]["notification_delivery"];
          email?: boolean;
          id?: string;
          in_app?: boolean;
          is_demo?: boolean;
          quiet_hours_end?: number | null;
          quiet_hours_start?: number | null;
          type?: Database["public"]["Enums"]["notification_type"];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notification_preferences_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      notifications: {
        Row: {
          body: string | null;
          created_at: string;
          entity_id: string | null;
          entity_type: string | null;
          href: string | null;
          id: string;
          is_demo: boolean;
          priority: Database["public"]["Enums"]["notification_priority"];
          read_at: string | null;
          title: string;
          type: Database["public"]["Enums"]["notification_type"];
          user_id: string;
        };
        Insert: {
          body?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          href?: string | null;
          id?: string;
          is_demo?: boolean;
          priority?: Database["public"]["Enums"]["notification_priority"];
          read_at?: string | null;
          title: string;
          type: Database["public"]["Enums"]["notification_type"];
          user_id: string;
        };
        Update: {
          body?: string | null;
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          href?: string | null;
          id?: string;
          is_demo?: boolean;
          priority?: Database["public"]["Enums"]["notification_priority"];
          read_at?: string | null;
          title?: string;
          type?: Database["public"]["Enums"]["notification_type"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      offboarding_checklists: {
        Row: {
          completed_at: string | null;
          created_at: string;
          id: string;
          initiated_by: string | null;
          is_demo: boolean;
          reason: string | null;
          started_at: string;
          status: Database["public"]["Enums"]["offboarding_status"];
          updated_at: string;
          user_id: string;
        };
        Insert: {
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          initiated_by?: string | null;
          is_demo?: boolean;
          reason?: string | null;
          started_at?: string;
          status?: Database["public"]["Enums"]["offboarding_status"];
          updated_at?: string;
          user_id: string;
        };
        Update: {
          completed_at?: string | null;
          created_at?: string;
          id?: string;
          initiated_by?: string | null;
          is_demo?: boolean;
          reason?: string | null;
          started_at?: string;
          status?: Database["public"]["Enums"]["offboarding_status"];
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "offboarding_checklists_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      offboarding_steps: {
        Row: {
          checklist_id: string;
          completed_at: string | null;
          completed_by: string | null;
          created_at: string;
          detail: string | null;
          id: string;
          is_demo: boolean;
          label: string;
          note: string | null;
          sort_order: number;
          step_key: string;
        };
        Insert: {
          checklist_id: string;
          completed_at?: string | null;
          completed_by?: string | null;
          created_at?: string;
          detail?: string | null;
          id?: string;
          is_demo?: boolean;
          label: string;
          note?: string | null;
          sort_order?: number;
          step_key: string;
        };
        Update: {
          checklist_id?: string;
          completed_at?: string | null;
          completed_by?: string | null;
          created_at?: string;
          detail?: string | null;
          id?: string;
          is_demo?: boolean;
          label?: string;
          note?: string | null;
          sort_order?: number;
          step_key?: string;
        };
        Relationships: [
          {
            foreignKeyName: "offboarding_steps_checklist_id_fkey";
            columns: ["checklist_id"];
            isOneToOne: false;
            referencedRelation: "offboarding_checklists";
            referencedColumns: ["id"];
          },
        ];
      };
      option_list_values: {
        Row: {
          active: boolean;
          created_at: string;
          id: string;
          is_default: boolean;
          key: string;
          label: string;
          list_id: string;
          location_id: string | null;
          metadata: Json;
          requires_detail: boolean;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          created_at?: string;
          id?: string;
          is_default?: boolean;
          key: string;
          label: string;
          list_id: string;
          location_id?: string | null;
          metadata?: Json;
          requires_detail?: boolean;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          created_at?: string;
          id?: string;
          is_default?: boolean;
          key?: string;
          label?: string;
          list_id?: string;
          location_id?: string | null;
          metadata?: Json;
          requires_detail?: boolean;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "option_list_values_list_id_fkey";
            columns: ["list_id"];
            isOneToOne: false;
            referencedRelation: "option_lists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "option_list_values_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      option_lists: {
        Row: {
          allow_location_scope: boolean;
          backed_by_enum: string | null;
          created_at: string;
          description: string | null;
          id: string;
          key: string;
          label: string;
          updated_at: string;
        };
        Insert: {
          allow_location_scope?: boolean;
          backed_by_enum?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          key: string;
          label: string;
          updated_at?: string;
        };
        Update: {
          allow_location_scope?: boolean;
          backed_by_enum?: string | null;
          created_at?: string;
          description?: string | null;
          id?: string;
          key?: string;
          label?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      page_reviews: {
        Row: {
          created_at: string;
          note: string | null;
          page_key: string;
          status: Database["public"]["Enums"]["page_review_status"];
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          created_at?: string;
          note?: string | null;
          page_key: string;
          status?: Database["public"]["Enums"]["page_review_status"];
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          created_at?: string;
          note?: string | null;
          page_key?: string;
          status?: Database["public"]["Enums"]["page_review_status"];
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "page_reviews_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      pay_structures: {
        Row: {
          base_salary_annual: number | null;
          created_at: string;
          created_by: string | null;
          draw_amount: number | null;
          draw_period: string | null;
          draw_recoverable: boolean;
          effective_from: string;
          effective_to: string | null;
          hourly_rate: number | null;
          hours_per_week: number | null;
          id: string;
          is_demo: boolean;
          note: string | null;
          pay_type: Database["public"]["Enums"]["pay_type"];
          salary_basis: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          base_salary_annual?: number | null;
          created_at?: string;
          created_by?: string | null;
          draw_amount?: number | null;
          draw_period?: string | null;
          draw_recoverable?: boolean;
          effective_from?: string;
          effective_to?: string | null;
          hourly_rate?: number | null;
          hours_per_week?: number | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          pay_type: Database["public"]["Enums"]["pay_type"];
          salary_basis?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          base_salary_annual?: number | null;
          created_at?: string;
          created_by?: string | null;
          draw_amount?: number | null;
          draw_period?: string | null;
          draw_recoverable?: boolean;
          effective_from?: string;
          effective_to?: string | null;
          hourly_rate?: number | null;
          hours_per_week?: number | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          pay_type?: Database["public"]["Enums"]["pay_type"];
          salary_basis?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pay_structures_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "pay_structures_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      permissions: {
        Row: {
          created_at: string;
          description: string | null;
          key: string;
          label: string;
          perm_group: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          key: string;
          label: string;
          perm_group?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          key?: string;
          label?: string;
          perm_group?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      photo_access_log: {
        Row: {
          action: Database["public"]["Enums"]["photo_access_action"];
          actor_id: string | null;
          actor_kind: Database["public"]["Enums"]["photo_access_actor_kind"];
          at: string;
          id: string;
          ip: unknown;
          photo_id: string | null;
          project_id: string | null;
          share_link_id: string | null;
          user_agent: string | null;
        };
        Insert: {
          action: Database["public"]["Enums"]["photo_access_action"];
          actor_id?: string | null;
          actor_kind: Database["public"]["Enums"]["photo_access_actor_kind"];
          at?: string;
          id?: string;
          ip?: unknown;
          photo_id?: string | null;
          project_id?: string | null;
          share_link_id?: string | null;
          user_agent?: string | null;
        };
        Update: {
          action?: Database["public"]["Enums"]["photo_access_action"];
          actor_id?: string | null;
          actor_kind?: Database["public"]["Enums"]["photo_access_actor_kind"];
          at?: string;
          id?: string;
          ip?: unknown;
          photo_id?: string | null;
          project_id?: string | null;
          share_link_id?: string | null;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "photo_access_log_actor_id_profiles_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "photo_access_log_photo_id_fkey";
            columns: ["photo_id"];
            isOneToOne: false;
            referencedRelation: "photos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photo_access_log_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photo_access_log_share_link_fk";
            columns: ["share_link_id"];
            isOneToOne: false;
            referencedRelation: "share_links";
            referencedColumns: ["id"];
          },
        ];
      };
      photo_annotations: {
        Row: {
          annotation: Json;
          author_id: string | null;
          created_at: string;
          id: string;
          is_demo: boolean;
          photo_id: string;
          updated_at: string;
        };
        Insert: {
          annotation: Json;
          author_id?: string | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          photo_id: string;
          updated_at?: string;
        };
        Update: {
          annotation?: Json;
          author_id?: string | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          photo_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "photo_annotations_author_id_profiles_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "photo_annotations_photo_id_fkey";
            columns: ["photo_id"];
            isOneToOne: false;
            referencedRelation: "photos";
            referencedColumns: ["id"];
          },
        ];
      };
      photo_comments: {
        Row: {
          author_id: string | null;
          body: string;
          created_at: string;
          deleted_at: string | null;
          id: string;
          is_demo: boolean;
          photo_id: string;
          reply_to_id: string | null;
          updated_at: string;
        };
        Insert: {
          author_id?: string | null;
          body: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          is_demo?: boolean;
          photo_id: string;
          reply_to_id?: string | null;
          updated_at?: string;
        };
        Update: {
          author_id?: string | null;
          body?: string;
          created_at?: string;
          deleted_at?: string | null;
          id?: string;
          is_demo?: boolean;
          photo_id?: string;
          reply_to_id?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "photo_comments_author_id_profiles_fkey";
            columns: ["author_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "photo_comments_photo_id_fkey";
            columns: ["photo_id"];
            isOneToOne: false;
            referencedRelation: "photos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photo_comments_reply_to_id_fkey";
            columns: ["reply_to_id"];
            isOneToOne: false;
            referencedRelation: "photo_comments";
            referencedColumns: ["id"];
          },
        ];
      };
      photo_folders: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          name: string;
          parent_folder_id: string | null;
          project_id: string;
          room_id: string | null;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name: string;
          parent_folder_id?: string | null;
          project_id: string;
          room_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name?: string;
          parent_folder_id?: string | null;
          project_id?: string;
          room_id?: string | null;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "photo_folders_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "photo_folders_parent_folder_id_fkey";
            columns: ["parent_folder_id"];
            isOneToOne: false;
            referencedRelation: "photo_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photo_folders_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photo_folders_room_id_fkey";
            columns: ["room_id"];
            isOneToOne: false;
            referencedRelation: "job_rooms";
            referencedColumns: ["id"];
          },
        ];
      };
      photo_tags: {
        Row: {
          created_at: string;
          created_by: string | null;
          is_demo: boolean;
          photo_id: string;
          tag_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          photo_id: string;
          tag_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          is_demo?: boolean;
          photo_id?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "photo_tags_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "photo_tags_photo_id_fkey";
            columns: ["photo_id"];
            isOneToOne: false;
            referencedRelation: "photos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photo_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      photo_variants: {
        Row: {
          error: string | null;
          generated_at: string | null;
          height: number | null;
          is_demo: boolean;
          photo_id: string;
          size_bytes: number | null;
          storage_path: string;
          variant: Database["public"]["Enums"]["photo_variant_kind"];
          width: number | null;
        };
        Insert: {
          error?: string | null;
          generated_at?: string | null;
          height?: number | null;
          is_demo?: boolean;
          photo_id: string;
          size_bytes?: number | null;
          storage_path: string;
          variant: Database["public"]["Enums"]["photo_variant_kind"];
          width?: number | null;
        };
        Update: {
          error?: string | null;
          generated_at?: string | null;
          height?: number | null;
          is_demo?: boolean;
          photo_id?: string;
          size_bytes?: number | null;
          storage_path?: string;
          variant?: Database["public"]["Enums"]["photo_variant_kind"];
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "photo_variants_photo_id_fkey";
            columns: ["photo_id"];
            isOneToOne: false;
            referencedRelation: "photos";
            referencedColumns: ["id"];
          },
        ];
      };
      photos: {
        Row: {
          captured_at: string | null;
          created_at: string;
          deleted_at: string | null;
          deleted_by: string | null;
          deleted_reason: string | null;
          exif_geom: unknown;
          exif_lat: number | null;
          exif_lon: number | null;
          exif_raw: Json;
          folder_id: string | null;
          height: number | null;
          id: string;
          is_demo: boolean;
          mime: string | null;
          project_id: string;
          size_bytes: number | null;
          storage_bucket: string;
          storage_path_original: string;
          storage_tier: Database["public"]["Enums"]["photo_storage_tier"];
          updated_at: string;
          upload_completed_at: string | null;
          upload_started_at: string | null;
          uploader_id: string | null;
          width: number | null;
        };
        Insert: {
          captured_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          deleted_by?: string | null;
          deleted_reason?: string | null;
          exif_geom?: unknown;
          exif_lat?: number | null;
          exif_lon?: number | null;
          exif_raw?: Json;
          folder_id?: string | null;
          height?: number | null;
          id: string;
          is_demo?: boolean;
          mime?: string | null;
          project_id: string;
          size_bytes?: number | null;
          storage_bucket?: string;
          storage_path_original: string;
          storage_tier?: Database["public"]["Enums"]["photo_storage_tier"];
          updated_at?: string;
          upload_completed_at?: string | null;
          upload_started_at?: string | null;
          uploader_id?: string | null;
          width?: number | null;
        };
        Update: {
          captured_at?: string | null;
          created_at?: string;
          deleted_at?: string | null;
          deleted_by?: string | null;
          deleted_reason?: string | null;
          exif_geom?: unknown;
          exif_lat?: number | null;
          exif_lon?: number | null;
          exif_raw?: Json;
          folder_id?: string | null;
          height?: number | null;
          id?: string;
          is_demo?: boolean;
          mime?: string | null;
          project_id?: string;
          size_bytes?: number | null;
          storage_bucket?: string;
          storage_path_original?: string;
          storage_tier?: Database["public"]["Enums"]["photo_storage_tier"];
          updated_at?: string;
          upload_completed_at?: string | null;
          upload_started_at?: string | null;
          uploader_id?: string | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "photos_deleted_by_profiles_fkey";
            columns: ["deleted_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "photos_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "photo_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photos_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "photos_uploader_id_profiles_fkey";
            columns: ["uploader_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      pipeline_ghost_events: {
        Row: {
          account_id: string;
          attempt_days: number;
          attempts: number;
          days_since_activity: number | null;
          from_stage_id: string | null;
          ghosted_at: string;
          ghosted_by: string | null;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          methods: string[];
          reason: string | null;
          source: string;
        };
        Insert: {
          account_id: string;
          attempt_days?: number;
          attempts?: number;
          days_since_activity?: number | null;
          from_stage_id?: string | null;
          ghosted_at?: string;
          ghosted_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          methods?: string[];
          reason?: string | null;
          source: string;
        };
        Update: {
          account_id?: string;
          attempt_days?: number;
          attempts?: number;
          days_since_activity?: number | null;
          from_stage_id?: string | null;
          ghosted_at?: string;
          ghosted_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          methods?: string[];
          reason?: string | null;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pipeline_ghost_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "pipeline_ghost_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pipeline_ghost_events_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
        ];
      };
      pipeline_stages: {
        Row: {
          advance_conditions: Json;
          advance_match: string;
          advance_min_count: number;
          advance_to_stage_id: string | null;
          auto_advance: boolean;
          color: string;
          created_at: string;
          description: string | null;
          id: string;
          is_active: boolean;
          is_computed: boolean;
          is_exit: boolean;
          is_intake: boolean;
          is_lost: boolean;
          is_won: boolean;
          key: string;
          name: string;
          pipeline_id: string;
          probability: number;
          requires_reason: boolean;
          sort_order: number;
          updated_at: string;
          wip_limit: number | null;
        };
        Insert: {
          advance_conditions?: Json;
          advance_match?: string;
          advance_min_count?: number;
          advance_to_stage_id?: string | null;
          auto_advance?: boolean;
          color?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_computed?: boolean;
          is_exit?: boolean;
          is_intake?: boolean;
          is_lost?: boolean;
          is_won?: boolean;
          key: string;
          name: string;
          pipeline_id: string;
          probability?: number;
          requires_reason?: boolean;
          sort_order?: number;
          updated_at?: string;
          wip_limit?: number | null;
        };
        Update: {
          advance_conditions?: Json;
          advance_match?: string;
          advance_min_count?: number;
          advance_to_stage_id?: string | null;
          auto_advance?: boolean;
          color?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_computed?: boolean;
          is_exit?: boolean;
          is_intake?: boolean;
          is_lost?: boolean;
          is_won?: boolean;
          key?: string;
          name?: string;
          pipeline_id?: string;
          probability?: number;
          requires_reason?: boolean;
          sort_order?: number;
          updated_at?: string;
          wip_limit?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "pipeline_stages_advance_to_stage_id_fkey";
            columns: ["advance_to_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "pipeline_stages_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
        ];
      };
      pipelines: {
        Row: {
          auto_advance_enabled: boolean;
          created_at: string;
          created_by: string | null;
          entity_type: string;
          id: string;
          is_active: boolean;
          is_default: boolean;
          kind: string;
          location_id: string | null;
          name: string;
          updated_at: string;
        };
        Insert: {
          auto_advance_enabled?: boolean;
          created_at?: string;
          created_by?: string | null;
          entity_type?: string;
          id?: string;
          is_active?: boolean;
          is_default?: boolean;
          kind?: string;
          location_id?: string | null;
          name: string;
          updated_at?: string;
        };
        Update: {
          auto_advance_enabled?: boolean;
          created_at?: string;
          created_by?: string | null;
          entity_type?: string;
          id?: string;
          is_active?: boolean;
          is_default?: boolean;
          kind?: string;
          location_id?: string | null;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pipelines_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "pipelines_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      planned_routes: {
        Row: {
          created_at: string;
          created_by: string;
          departure_at: string | null;
          end_point: Json;
          id: string;
          location_id: string | null;
          name: string;
          opened_in_maps_at: string | null;
          optimised: boolean;
          planned_for: string;
          start_point: Json;
          stops: Json;
          total_km: number | null;
          total_minutes: number | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string;
          departure_at?: string | null;
          end_point: Json;
          id?: string;
          location_id?: string | null;
          name: string;
          opened_in_maps_at?: string | null;
          optimised?: boolean;
          planned_for: string;
          start_point: Json;
          stops?: Json;
          total_km?: number | null;
          total_minutes?: number | null;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          departure_at?: string | null;
          end_point?: Json;
          id?: string;
          location_id?: string | null;
          name?: string;
          opened_in_maps_at?: string | null;
          optimised?: boolean;
          planned_for?: string;
          start_point?: Json;
          stops?: Json;
          total_km?: number | null;
          total_minutes?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "planned_routes_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_customers: {
        Row: {
          account_id: string | null;
          contact_id: string;
          created_at: string;
          created_by: string | null;
          disabled_at: string | null;
          disabled_by: string | null;
          display_name: string | null;
          email: string;
          id: string;
          user_id: string | null;
        };
        Insert: {
          account_id?: string | null;
          contact_id: string;
          created_at?: string;
          created_by?: string | null;
          disabled_at?: string | null;
          disabled_by?: string | null;
          display_name?: string | null;
          email: string;
          id?: string;
          user_id?: string | null;
        };
        Update: {
          account_id?: string | null;
          contact_id?: string;
          created_at?: string;
          created_by?: string | null;
          disabled_at?: string | null;
          disabled_by?: string | null;
          display_name?: string | null;
          email?: string;
          id?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portal_customers_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "portal_customers_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_customers_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "portal_customers_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: true;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "portal_customers_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: true;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_invitations: {
        Row: {
          account_id: string | null;
          created_at: string;
          created_by: string;
          expires_at: string;
          id: string;
          job_id: string | null;
          portal_customer_id: string;
          revoked_at: string | null;
          token_hash: string;
          used_at: string | null;
          used_by: string | null;
        };
        Insert: {
          account_id?: string | null;
          created_at?: string;
          created_by: string;
          expires_at: string;
          id?: string;
          job_id?: string | null;
          portal_customer_id: string;
          revoked_at?: string | null;
          token_hash: string;
          used_at?: string | null;
          used_by?: string | null;
        };
        Update: {
          account_id?: string | null;
          created_at?: string;
          created_by?: string;
          expires_at?: string;
          id?: string;
          job_id?: string | null;
          portal_customer_id?: string;
          revoked_at?: string | null;
          token_hash?: string;
          used_at?: string | null;
          used_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "portal_invitations_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "portal_invitations_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_invitations_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "portal_invitations_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_invitations_portal_customer_id_fkey";
            columns: ["portal_customer_id"];
            isOneToOne: false;
            referencedRelation: "portal_customers";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_job_shares: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          job_id: string;
          portal_customer_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id: string;
          portal_customer_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          job_id?: string;
          portal_customer_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "portal_job_shares_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "portal_job_shares_portal_customer_id_fkey";
            columns: ["portal_customer_id"];
            isOneToOne: false;
            referencedRelation: "portal_customers";
            referencedColumns: ["id"];
          },
        ];
      };
      portal_share_items: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          item_id: string;
          item_kind: string;
          share_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_id: string;
          item_kind: string;
          share_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_id?: string;
          item_kind?: string;
          share_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "portal_share_items_share_id_fkey";
            columns: ["share_id"];
            isOneToOne: false;
            referencedRelation: "portal_job_shares";
            referencedColumns: ["id"];
          },
        ];
      };
      price_list_assignments: {
        Row: {
          account_id: string | null;
          created_at: string;
          created_by: string | null;
          effective_from: string;
          effective_to: string | null;
          id: string;
          location_id: string | null;
          price_list_id: string;
          state_code: string | null;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          location_id?: string | null;
          price_list_id: string;
          state_code?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          location_id?: string | null;
          price_list_id?: string;
          state_code?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "price_list_assignments_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "price_list_assignments_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "price_list_assignments_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "price_list_assignments_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "price_list_assignments_price_list_id_fkey";
            columns: ["price_list_id"];
            isOneToOne: false;
            referencedRelation: "price_lists";
            referencedColumns: ["id"];
          },
        ];
      };
      price_list_items: {
        Row: {
          catalog_item_id: string;
          created_at: string;
          id: string;
          price_list_id: string;
          unit_price: number;
          updated_at: string;
        };
        Insert: {
          catalog_item_id: string;
          created_at?: string;
          id?: string;
          price_list_id: string;
          unit_price: number;
          updated_at?: string;
        };
        Update: {
          catalog_item_id?: string;
          created_at?: string;
          id?: string;
          price_list_id?: string;
          unit_price?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "price_list_items_catalog_item_id_fkey";
            columns: ["catalog_item_id"];
            isOneToOne: false;
            referencedRelation: "estimate_catalog_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "price_list_items_price_list_id_fkey";
            columns: ["price_list_id"];
            isOneToOne: false;
            referencedRelation: "price_lists";
            referencedColumns: ["id"];
          },
        ];
      };
      price_lists: {
        Row: {
          created_at: string;
          created_by: string | null;
          description: string | null;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          approval_status: string;
          approved_at: string | null;
          approved_by: string | null;
          created_at: string;
          deactivated_at: string | null;
          deactivated_by: string | null;
          email: string | null;
          employment_stage: string | null;
          employment_started_on: string | null;
          extension: string | null;
          full_name: string | null;
          is_active: boolean;
          is_demo: boolean;
          job_title: string | null;
          language: string;
          mobile_phone: string | null;
          primary_location_id: string | null;
          rejected_reason: string | null;
          updated_at: string;
          user_id: string;
          work_phone: string | null;
        };
        Insert: {
          approval_status?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          deactivated_at?: string | null;
          deactivated_by?: string | null;
          email?: string | null;
          employment_stage?: string | null;
          employment_started_on?: string | null;
          extension?: string | null;
          full_name?: string | null;
          is_active?: boolean;
          is_demo?: boolean;
          job_title?: string | null;
          language?: string;
          mobile_phone?: string | null;
          primary_location_id?: string | null;
          rejected_reason?: string | null;
          updated_at?: string;
          user_id: string;
          work_phone?: string | null;
        };
        Update: {
          approval_status?: string;
          approved_at?: string | null;
          approved_by?: string | null;
          created_at?: string;
          deactivated_at?: string | null;
          deactivated_by?: string | null;
          email?: string | null;
          employment_stage?: string | null;
          employment_started_on?: string | null;
          extension?: string | null;
          full_name?: string | null;
          is_active?: boolean;
          is_demo?: boolean;
          job_title?: string | null;
          language?: string;
          mobile_phone?: string | null;
          primary_location_id?: string | null;
          rejected_reason?: string | null;
          updated_at?: string;
          user_id?: string;
          work_phone?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_approved_by_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "profiles_deactivated_by_profiles_fkey";
            columns: ["deactivated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "profiles_primary_location_id_fkey";
            columns: ["primary_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      project_checklist_items: {
        Row: {
          body: string;
          checklist_id: string;
          created_at: string;
          done_at: string | null;
          done_by: string | null;
          id: string;
          is_demo: boolean;
          position: number;
          updated_at: string;
        };
        Insert: {
          body: string;
          checklist_id: string;
          created_at?: string;
          done_at?: string | null;
          done_by?: string | null;
          id?: string;
          is_demo?: boolean;
          position?: number;
          updated_at?: string;
        };
        Update: {
          body?: string;
          checklist_id?: string;
          created_at?: string;
          done_at?: string | null;
          done_by?: string | null;
          id?: string;
          is_demo?: boolean;
          position?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_checklist_items_checklist_id_fkey";
            columns: ["checklist_id"];
            isOneToOne: false;
            referencedRelation: "project_checklists";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_checklist_items_done_by_profiles_fkey";
            columns: ["done_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      project_checklists: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          position: number;
          project_id: string;
          title: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          position?: number;
          project_id: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          position?: number;
          project_id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_checklists_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "project_checklists_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_documents: {
        Row: {
          created_at: string;
          deleted_at: string | null;
          description: string | null;
          id: string;
          is_demo: boolean;
          mime: string | null;
          name: string;
          project_id: string;
          size_bytes: number | null;
          storage_bucket: string;
          storage_path: string;
          uploader_id: string | null;
        };
        Insert: {
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          mime?: string | null;
          name: string;
          project_id: string;
          size_bytes?: number | null;
          storage_bucket?: string;
          storage_path: string;
          uploader_id?: string | null;
        };
        Update: {
          created_at?: string;
          deleted_at?: string | null;
          description?: string | null;
          id?: string;
          is_demo?: boolean;
          mime?: string | null;
          name?: string;
          project_id?: string;
          size_bytes?: number | null;
          storage_bucket?: string;
          storage_path?: string;
          uploader_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "project_documents_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_documents_uploader_id_profiles_fkey";
            columns: ["uploader_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      project_labels: {
        Row: {
          created_at: string;
          is_demo: boolean;
          label: string;
          project_id: string;
        };
        Insert: {
          created_at?: string;
          is_demo?: boolean;
          label: string;
          project_id: string;
        };
        Update: {
          created_at?: string;
          is_demo?: boolean;
          label?: string;
          project_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_labels_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
      };
      project_members: {
        Row: {
          is_demo: boolean;
          joined_at: string;
          member_role: Database["public"]["Enums"]["project_member_role"];
          project_id: string;
          user_id: string;
        };
        Insert: {
          is_demo?: boolean;
          joined_at?: string;
          member_role?: Database["public"]["Enums"]["project_member_role"];
          project_id: string;
          user_id: string;
        };
        Update: {
          is_demo?: boolean;
          joined_at?: string;
          member_role?: Database["public"]["Enums"]["project_member_role"];
          project_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_members_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      project_stars: {
        Row: {
          is_demo: boolean;
          project_id: string;
          starred_at: string;
          user_id: string;
        };
        Insert: {
          is_demo?: boolean;
          project_id: string;
          starred_at?: string;
          user_id: string;
        };
        Update: {
          is_demo?: boolean;
          project_id?: string;
          starred_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "project_stars_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "project_stars_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      projects: {
        Row: {
          account_id: string | null;
          address: string;
          archived_at: string | null;
          created_at: string;
          created_by: string | null;
          customer_email: string | null;
          customer_name: string | null;
          customer_phone: string | null;
          description: string | null;
          geom: unknown;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          lat: number | null;
          locality: string | null;
          location_id: string;
          lon: number | null;
          loss_type: string | null;
          loss_type_detail: string | null;
          loss_type_id: string | null;
          name: string;
          overlay_settings: Json;
          postal_code: string | null;
          region: string | null;
          status: Database["public"]["Enums"]["project_status"];
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          address: string;
          archived_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_email?: string | null;
          customer_name?: string | null;
          customer_phone?: string | null;
          description?: string | null;
          geom?: unknown;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          lat?: number | null;
          locality?: string | null;
          location_id: string;
          lon?: number | null;
          loss_type?: string | null;
          loss_type_detail?: string | null;
          loss_type_id?: string | null;
          name: string;
          overlay_settings?: Json;
          postal_code?: string | null;
          region?: string | null;
          status?: Database["public"]["Enums"]["project_status"];
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          address?: string;
          archived_at?: string | null;
          created_at?: string;
          created_by?: string | null;
          customer_email?: string | null;
          customer_name?: string | null;
          customer_phone?: string | null;
          description?: string | null;
          geom?: unknown;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          lat?: number | null;
          locality?: string | null;
          location_id?: string;
          lon?: number | null;
          loss_type?: string | null;
          loss_type_detail?: string | null;
          loss_type_id?: string | null;
          name?: string;
          overlay_settings?: Json;
          postal_code?: string | null;
          region?: string | null;
          status?: Database["public"]["Enums"]["project_status"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "projects_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "projects_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "projects_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "projects_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "projects_loss_type_id_fkey";
            columns: ["loss_type_id"];
            isOneToOne: false;
            referencedRelation: "option_list_values";
            referencedColumns: ["id"];
          },
        ];
      };
      property_notes: {
        Row: {
          address: string;
          address_key: string;
          created_at: string;
          created_by: string | null;
          id: string;
          location_id: string | null;
          note: string;
          urgent: boolean;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          address: string;
          address_key: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id?: string | null;
          note: string;
          urgent?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          address?: string;
          address_key?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          location_id?: string | null;
          note?: string;
          urgent?: boolean;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "property_notes_created_by_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "property_notes_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "property_notes_updated_by_fkey";
            columns: ["updated_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      quote_line_items: {
        Row: {
          category: string;
          created_at: string;
          description: string;
          id: string;
          is_demo: boolean;
          line_total: number | null;
          position: number;
          quantity: number;
          quote_id: string;
          unit: string;
          unit_price: number;
          updated_at: string;
        };
        Insert: {
          category?: string;
          created_at?: string;
          description: string;
          id?: string;
          is_demo?: boolean;
          line_total?: number | null;
          position?: number;
          quantity?: number;
          quote_id: string;
          unit?: string;
          unit_price?: number;
          updated_at?: string;
        };
        Update: {
          category?: string;
          created_at?: string;
          description?: string;
          id?: string;
          is_demo?: boolean;
          line_total?: number | null;
          position?: number;
          quantity?: number;
          quote_id?: string;
          unit?: string;
          unit_price?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "quote_line_items_quote_id_fkey";
            columns: ["quote_id"];
            isOneToOne: false;
            referencedRelation: "quotes";
            referencedColumns: ["id"];
          },
        ];
      };
      quotes: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          job_id: string;
          location_id: string;
          notes: string | null;
          status: Database["public"]["Enums"]["quote_status"];
          submitted_at: string | null;
          subtotal: number;
          tax: number;
          title: string | null;
          total: number;
          updated_at: string;
          version: number;
          xactimate_reference: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id: string;
          location_id: string;
          notes?: string | null;
          status?: Database["public"]["Enums"]["quote_status"];
          submitted_at?: string | null;
          subtotal?: number;
          tax?: number;
          title?: string | null;
          total?: number;
          updated_at?: string;
          version?: number;
          xactimate_reference?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string;
          location_id?: string;
          notes?: string | null;
          status?: Database["public"]["Enums"]["quote_status"];
          submitted_at?: string | null;
          subtotal?: number;
          tax?: number;
          title?: string | null;
          total?: number;
          updated_at?: string;
          version?: number;
          xactimate_reference?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "quotes_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "quotes_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "quotes_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      rate_limit_counters: {
        Row: {
          attempts: number;
          blocked_until: string | null;
          bucket: string;
          first_seen_at: string;
          identity: string;
          last_seen_at: string;
          window_started_at: string;
        };
        Insert: {
          attempts?: number;
          blocked_until?: string | null;
          bucket: string;
          first_seen_at?: string;
          identity: string;
          last_seen_at?: string;
          window_started_at?: string;
        };
        Update: {
          attempts?: number;
          blocked_until?: string | null;
          bucket?: string;
          first_seen_at?: string;
          identity?: string;
          last_seen_at?: string;
          window_started_at?: string;
        };
        Relationships: [];
      };
      reassignment_batches: {
        Row: {
          account_count: number;
          created_at: string;
          created_by: string | null;
          do_differently: string | null;
          from_user_id: string;
          id: string;
          is_demo: boolean;
          reason: string;
          reason_note: string | null;
          to_user_id: string;
        };
        Insert: {
          account_count?: number;
          created_at?: string;
          created_by?: string | null;
          do_differently?: string | null;
          from_user_id: string;
          id?: string;
          is_demo?: boolean;
          reason: string;
          reason_note?: string | null;
          to_user_id: string;
        };
        Update: {
          account_count?: number;
          created_at?: string;
          created_by?: string | null;
          do_differently?: string | null;
          from_user_id?: string;
          id?: string;
          is_demo?: boolean;
          reason?: string;
          reason_note?: string | null;
          to_user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reassignment_batches_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      record_history: {
        Row: {
          actor_id: string | null;
          changed_columns: string[] | null;
          changes: Json | null;
          id: string;
          job_id: string;
          new_row: Json | null;
          occurred_at: string;
          old_row: Json | null;
          op: string;
          parent_id: string | null;
          restores_id: string | null;
          row_pk: string;
          seq: number;
          summary: string;
          table_name: string;
          txid: number;
        };
        Insert: {
          actor_id?: string | null;
          changed_columns?: string[] | null;
          changes?: Json | null;
          id?: string;
          job_id: string;
          new_row?: Json | null;
          occurred_at?: string;
          old_row?: Json | null;
          op: string;
          parent_id?: string | null;
          restores_id?: string | null;
          row_pk: string;
          seq?: never;
          summary: string;
          table_name: string;
          txid?: number;
        };
        Update: {
          actor_id?: string | null;
          changed_columns?: string[] | null;
          changes?: Json | null;
          id?: string;
          job_id?: string;
          new_row?: Json | null;
          occurred_at?: string;
          old_row?: Json | null;
          op?: string;
          parent_id?: string | null;
          restores_id?: string | null;
          row_pk?: string;
          seq?: never;
          summary?: string;
          table_name?: string;
          txid?: number;
        };
        Relationships: [
          {
            foreignKeyName: "record_history_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "record_history_parent_id_fkey";
            columns: ["parent_id"];
            isOneToOne: false;
            referencedRelation: "record_history";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "record_history_restores_id_fkey";
            columns: ["restores_id"];
            isOneToOne: false;
            referencedRelation: "record_history";
            referencedColumns: ["id"];
          },
        ];
      };
      record_revision_sends: {
        Row: {
          channel: string;
          id: string;
          note: string | null;
          recipient: string | null;
          revision_id: string;
          sent_at: string;
          sent_by: string | null;
        };
        Insert: {
          channel?: string;
          id?: string;
          note?: string | null;
          recipient?: string | null;
          revision_id: string;
          sent_at?: string;
          sent_by?: string | null;
        };
        Update: {
          channel?: string;
          id?: string;
          note?: string | null;
          recipient?: string | null;
          revision_id?: string;
          sent_at?: string;
          sent_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "record_revision_sends_revision_id_fkey";
            columns: ["revision_id"];
            isOneToOne: false;
            referencedRelation: "record_revisions";
            referencedColumns: ["id"];
          },
        ];
      };
      record_revisions: {
        Row: {
          change_summary: string | null;
          created_at: string;
          created_by: string | null;
          document_id: string | null;
          frozen: boolean;
          frozen_at: string | null;
          id: string;
          kind: string;
          location_id: string | null;
          record_id: string;
          snapshot: Json;
          total: number;
          updated_at: string;
          version: number;
        };
        Insert: {
          change_summary?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          frozen?: boolean;
          frozen_at?: string | null;
          id?: string;
          kind: string;
          location_id?: string | null;
          record_id: string;
          snapshot?: Json;
          total?: number;
          updated_at?: string;
          version: number;
        };
        Update: {
          change_summary?: string | null;
          created_at?: string;
          created_by?: string | null;
          document_id?: string | null;
          frozen?: boolean;
          frozen_at?: string | null;
          id?: string;
          kind?: string;
          location_id?: string | null;
          record_id?: string;
          snapshot?: Json;
          total?: number;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: "record_revisions_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "record_revisions_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      recording_consent_rules: {
        Row: {
          consent_type: string;
          disclosure_text: string;
          notes: string | null;
          requires_spoken_disclosure: boolean;
          state_code: string;
          state_name: string;
          updated_at: string;
        };
        Insert: {
          consent_type: string;
          disclosure_text: string;
          notes?: string | null;
          requires_spoken_disclosure?: boolean;
          state_code: string;
          state_name: string;
          updated_at?: string;
        };
        Update: {
          consent_type?: string;
          disclosure_text?: string;
          notes?: string | null;
          requires_spoken_disclosure?: boolean;
          state_code?: string;
          state_name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      referral_commission_rules: {
        Row: {
          account_id: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          effective_from: string | null;
          effective_to: string | null;
          id: string;
          kind: string;
          note: string | null;
          updated_at: string;
          updated_by: string | null;
          value: number;
        };
        Insert: {
          account_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          effective_from?: string | null;
          effective_to?: string | null;
          id?: string;
          kind: string;
          note?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          value: number;
        };
        Update: {
          account_id?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          effective_from?: string | null;
          effective_to?: string | null;
          id?: string;
          kind?: string;
          note?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          value?: number;
        };
        Relationships: [
          {
            foreignKeyName: "referral_commission_rules_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "referral_commission_rules_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "referral_commission_rules_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "referral_commission_rules_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "referral_commission_rules_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
        ];
      };
      region_members: {
        Row: {
          created_at: string;
          id: string;
          region_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          region_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          region_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "region_members_region_id_fkey";
            columns: ["region_id"];
            isOneToOne: false;
            referencedRelation: "regions";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "region_members_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      regions: {
        Row: {
          created_at: string;
          description: string | null;
          id: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          description?: string | null;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      reminders: {
        Row: {
          created_at: string;
          entity_id: string | null;
          entity_type: string | null;
          id: string;
          is_demo: boolean;
          offset_minutes: number | null;
          remind_at: string;
          sent_at: string | null;
          task_id: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: string;
          is_demo?: boolean;
          offset_minutes?: number | null;
          remind_at: string;
          sent_at?: string | null;
          task_id?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: string;
          is_demo?: boolean;
          offset_minutes?: number | null;
          remind_at?: string;
          sent_at?: string | null;
          task_id?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "reminders_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "reminders_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      rep_nudges: {
        Row: {
          created_at: string;
          dedupe_key: string;
          entity_id: string | null;
          entity_type: string;
          escalated_at: string | null;
          href: string | null;
          id: string;
          is_demo: boolean;
          kind: string;
          last_nudged_at: string;
          location_id: string | null;
          nudge_count: number;
          reason: string;
          resolved_at: string | null;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          dedupe_key: string;
          entity_id?: string | null;
          entity_type?: string;
          escalated_at?: string | null;
          href?: string | null;
          id?: string;
          is_demo?: boolean;
          kind: string;
          last_nudged_at?: string;
          location_id?: string | null;
          nudge_count?: number;
          reason: string;
          resolved_at?: string | null;
          title: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          dedupe_key?: string;
          entity_id?: string | null;
          entity_type?: string;
          escalated_at?: string | null;
          href?: string | null;
          id?: string;
          is_demo?: boolean;
          kind?: string;
          last_nudged_at?: string;
          location_id?: string | null;
          nudge_count?: number;
          reason?: string;
          resolved_at?: string | null;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "rep_nudges_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "rep_nudges_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      reported_sources: {
        Row: {
          active: boolean;
          code: string;
          created_at: string;
          id: string;
          is_referral: boolean;
          label: string;
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          active?: boolean;
          code: string;
          created_at?: string;
          id?: string;
          is_referral?: boolean;
          label: string;
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          active?: boolean;
          code?: string;
          created_at?: string;
          id?: string;
          is_referral?: boolean;
          label?: string;
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      role_change_audit: {
        Row: {
          action: string;
          actor_id: string | null;
          entity: string | null;
          id: string;
          new_value: Json | null;
          occurred_at: string;
          old_value: Json | null;
          target_user_id: string | null;
        };
        Insert: {
          action: string;
          actor_id?: string | null;
          entity?: string | null;
          id?: string;
          new_value?: Json | null;
          occurred_at?: string;
          old_value?: Json | null;
          target_user_id?: string | null;
        };
        Update: {
          action?: string;
          actor_id?: string | null;
          entity?: string | null;
          id?: string;
          new_value?: Json | null;
          occurred_at?: string;
          old_value?: Json | null;
          target_user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "role_change_audit_actor_id_profiles_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "role_change_audit_target_user_id_profiles_fkey";
            columns: ["target_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      role_permissions: {
        Row: {
          created_at: string;
          id: string;
          permission_key: string;
          role: Database["public"]["Enums"]["app_role"];
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          permission_key: string;
          role: Database["public"]["Enums"]["app_role"];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          permission_key?: string;
          role?: Database["public"]["Enums"]["app_role"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_key_fkey";
            columns: ["permission_key"];
            isOneToOne: false;
            referencedRelation: "permissions";
            referencedColumns: ["key"];
          },
        ];
      };
      sales_type_assignments: {
        Row: {
          created_at: string;
          created_by: string | null;
          effective_from: string;
          effective_to: string | null;
          id: string;
          is_demo: boolean;
          note: string | null;
          sales_type: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          sales_type: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          effective_from?: string;
          effective_to?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          sales_type?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "sales_type_assignments_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "sales_type_assignments_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      saved_reports: {
        Row: {
          created_at: string;
          definition: Json;
          id: string;
          location_id: string | null;
          name: string;
          shared: boolean;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          definition?: Json;
          id?: string;
          location_id?: string | null;
          name: string;
          shared?: boolean;
          updated_at?: string;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          definition?: Json;
          id?: string;
          location_id?: string | null;
          name?: string;
          shared?: boolean;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "saved_reports_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      scorecard_settings: {
        Row: {
          created_at: string;
          id: string;
          location_id: string | null;
          min_activity_events: number;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          location_id?: string | null;
          min_activity_events?: number;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          location_id?: string | null;
          min_activity_events?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "scorecard_settings_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      scorecard_weights: {
        Row: {
          component: string;
          created_at: string;
          direction: string;
          enabled: boolean;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          role_group: string;
          target: number;
          updated_at: string;
          weight: number;
        };
        Insert: {
          component: string;
          created_at?: string;
          direction?: string;
          enabled?: boolean;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          role_group: string;
          target?: number;
          updated_at?: string;
          weight?: number;
        };
        Update: {
          component?: string;
          created_at?: string;
          direction?: string;
          enabled?: boolean;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          role_group?: string;
          target?: number;
          updated_at?: string;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: "scorecard_weights_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      seasonal_sends: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          location_id: string | null;
          name: string;
          notes: string | null;
          occasion: string;
          recipient_count: number;
          sent_at: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          name: string;
          notes?: string | null;
          occasion?: string;
          recipient_count?: number;
          sent_at?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          location_id?: string | null;
          name?: string;
          notes?: string | null;
          occasion?: string;
          recipient_count?: number;
          sent_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "seasonal_sends_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "seasonal_sends_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      security_events: {
        Row: {
          actor_id: string | null;
          details: Json;
          event_type: string;
          id: string;
          occurred_at: string;
          subject_email: string | null;
          subject_id: string | null;
        };
        Insert: {
          actor_id?: string | null;
          details?: Json;
          event_type: string;
          id?: string;
          occurred_at?: string;
          subject_email?: string | null;
          subject_id?: string | null;
        };
        Update: {
          actor_id?: string | null;
          details?: Json;
          event_type?: string;
          id?: string;
          occurred_at?: string;
          subject_email?: string | null;
          subject_id?: string | null;
        };
        Relationships: [];
      };
      share_links: {
        Row: {
          allow_download_original: boolean;
          audience_role: string | null;
          created_at: string;
          created_by: string | null;
          display_options: Json;
          document_ids: string[] | null;
          expires_at: string;
          folder_id: string | null;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          kind: Database["public"]["Enums"]["share_link_kind"];
          note: string | null;
          photo_ids: string[] | null;
          project_id: string | null;
          revoked_at: string | null;
          revoked_by: string | null;
          token: string;
        };
        Insert: {
          allow_download_original?: boolean;
          audience_role?: string | null;
          created_at?: string;
          created_by?: string | null;
          display_options?: Json;
          document_ids?: string[] | null;
          expires_at: string;
          folder_id?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          kind: Database["public"]["Enums"]["share_link_kind"];
          note?: string | null;
          photo_ids?: string[] | null;
          project_id?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          token: string;
        };
        Update: {
          allow_download_original?: boolean;
          audience_role?: string | null;
          created_at?: string;
          created_by?: string | null;
          display_options?: Json;
          document_ids?: string[] | null;
          expires_at?: string;
          folder_id?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          kind?: Database["public"]["Enums"]["share_link_kind"];
          note?: string | null;
          photo_ids?: string[] | null;
          project_id?: string | null;
          revoked_at?: string | null;
          revoked_by?: string | null;
          token?: string;
        };
        Relationships: [
          {
            foreignKeyName: "share_links_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "share_links_folder_id_fkey";
            columns: ["folder_id"];
            isOneToOne: false;
            referencedRelation: "photo_folders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "share_links_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "share_links_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "share_links_revoked_by_profiles_fkey";
            columns: ["revoked_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      shift_corrections: {
        Row: {
          actor_id: string | null;
          field: string;
          id: string;
          is_demo: boolean;
          new_value: string | null;
          occurred_at: string;
          old_value: string | null;
          reason: string | null;
          shift_id: string;
        };
        Insert: {
          actor_id?: string | null;
          field: string;
          id?: string;
          is_demo?: boolean;
          new_value?: string | null;
          occurred_at?: string;
          old_value?: string | null;
          reason?: string | null;
          shift_id: string;
        };
        Update: {
          actor_id?: string | null;
          field?: string;
          id?: string;
          is_demo?: boolean;
          new_value?: string | null;
          occurred_at?: string;
          old_value?: string | null;
          reason?: string | null;
          shift_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shift_corrections_actor_id_profiles_fkey";
            columns: ["actor_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "shift_corrections_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
        ];
      };
      shifts: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          clock_in_at: string;
          clock_in_lat: number | null;
          clock_in_lon: number | null;
          clock_out_at: string | null;
          clock_out_lat: number | null;
          clock_out_lon: number | null;
          created_at: string;
          id: string;
          is_demo: boolean;
          location_id: string;
          notes: string | null;
          status: Database["public"]["Enums"]["shift_status"];
          total_minutes: number | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          clock_in_at?: string;
          clock_in_lat?: number | null;
          clock_in_lon?: number | null;
          clock_out_at?: string | null;
          clock_out_lat?: number | null;
          clock_out_lon?: number | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          location_id: string;
          notes?: string | null;
          status?: Database["public"]["Enums"]["shift_status"];
          total_minutes?: number | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          clock_in_at?: string;
          clock_in_lat?: number | null;
          clock_in_lon?: number | null;
          clock_out_at?: string | null;
          clock_out_lat?: number | null;
          clock_out_lon?: number | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          location_id?: string;
          notes?: string | null;
          status?: Database["public"]["Enums"]["shift_status"];
          total_minutes?: number | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "shifts_approved_by_profiles_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "shifts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "shifts_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      spatial_ref_sys: {
        Row: {
          auth_name: string | null;
          auth_srid: number | null;
          proj4text: string | null;
          srid: number;
          srtext: string | null;
        };
        Insert: {
          auth_name?: string | null;
          auth_srid?: number | null;
          proj4text?: string | null;
          srid: number;
          srtext?: string | null;
        };
        Update: {
          auth_name?: string | null;
          auth_srid?: number | null;
          proj4text?: string | null;
          srid?: number;
          srtext?: string | null;
        };
        Relationships: [];
      };
      stage_auto_advances: {
        Row: {
          account_id: string;
          conditions_met: Json;
          created_at: string;
          fired_at: string;
          from_stage_id: string | null;
          id: string;
          note: string | null;
          pipeline_id: string | null;
          rule_fingerprint: string;
          to_stage_id: string | null;
          undone_at: string | null;
          undone_by: string | null;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          conditions_met?: Json;
          created_at?: string;
          fired_at?: string;
          from_stage_id?: string | null;
          id?: string;
          note?: string | null;
          pipeline_id?: string | null;
          rule_fingerprint: string;
          to_stage_id?: string | null;
          undone_at?: string | null;
          undone_by?: string | null;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          conditions_met?: Json;
          created_at?: string;
          fired_at?: string;
          from_stage_id?: string | null;
          id?: string;
          note?: string | null;
          pipeline_id?: string | null;
          rule_fingerprint?: string;
          to_stage_id?: string | null;
          undone_at?: string | null;
          undone_by?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "stage_auto_advances_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "stage_auto_advances_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stage_auto_advances_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "stage_auto_advances_from_stage_id_fkey";
            columns: ["from_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stage_auto_advances_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stage_auto_advances_to_stage_id_fkey";
            columns: ["to_stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "stage_auto_advances_undone_by_fkey";
            columns: ["undone_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      supply_item_vendor_prices: {
        Row: {
          id: string;
          item_id: string;
          unit_price: number;
          updated_at: string;
          updated_by: string | null;
          vendor_id: string;
        };
        Insert: {
          id?: string;
          item_id: string;
          unit_price: number;
          updated_at?: string;
          updated_by?: string | null;
          vendor_id: string;
        };
        Update: {
          id?: string;
          item_id?: string;
          unit_price?: number;
          updated_at?: string;
          updated_by?: string | null;
          vendor_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "supply_item_vendor_prices_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "supply_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_item_vendor_prices_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "supply_vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      supply_items: {
        Row: {
          category: string | null;
          created_at: string;
          created_by: string | null;
          default_supplier: string | null;
          default_vendor_id: string | null;
          id: string;
          is_active: boolean;
          name: string;
          size: string | null;
          sku: string | null;
          sort_order: number;
          unit: string;
          unit_cost: number | null;
          updated_at: string;
        };
        Insert: {
          category?: string | null;
          created_at?: string;
          created_by?: string | null;
          default_supplier?: string | null;
          default_vendor_id?: string | null;
          id?: string;
          is_active?: boolean;
          name: string;
          size?: string | null;
          sku?: string | null;
          sort_order?: number;
          unit?: string;
          unit_cost?: number | null;
          updated_at?: string;
        };
        Update: {
          category?: string | null;
          created_at?: string;
          created_by?: string | null;
          default_supplier?: string | null;
          default_vendor_id?: string | null;
          id?: string;
          is_active?: boolean;
          name?: string;
          size?: string | null;
          sku?: string | null;
          sort_order?: number;
          unit?: string;
          unit_cost?: number | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "supply_items_default_vendor_id_fkey";
            columns: ["default_vendor_id"];
            isOneToOne: false;
            referencedRelation: "supply_vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      supply_purchases: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          item_id: string | null;
          item_label: string | null;
          location_id: string;
          note: string | null;
          purchased_on: string;
          quantity: number;
          receipt_id: string | null;
          request_id: string | null;
          supplier_account_id: string | null;
          supplier_name: string;
          total_cost: number;
          unit_price: number;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_id?: string | null;
          item_label?: string | null;
          location_id: string;
          note?: string | null;
          purchased_on?: string;
          quantity: number;
          receipt_id?: string | null;
          request_id?: string | null;
          supplier_account_id?: string | null;
          supplier_name: string;
          total_cost: number;
          unit_price: number;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_id?: string | null;
          item_label?: string | null;
          location_id?: string;
          note?: string | null;
          purchased_on?: string;
          quantity?: number;
          receipt_id?: string | null;
          request_id?: string | null;
          supplier_account_id?: string | null;
          supplier_name?: string;
          total_cost?: number;
          unit_price?: number;
        };
        Relationships: [
          {
            foreignKeyName: "supply_purchases_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "supply_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_purchases_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_purchases_receipt_id_fkey";
            columns: ["receipt_id"];
            isOneToOne: false;
            referencedRelation: "supply_receipts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_purchases_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "supply_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_purchases_supplier_account_id_fkey";
            columns: ["supplier_account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "supply_purchases_supplier_account_id_fkey";
            columns: ["supplier_account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_purchases_supplier_account_id_fkey";
            columns: ["supplier_account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
        ];
      };
      supply_receipts: {
        Row: {
          approved_lines: Json | null;
          created_at: string;
          id: string;
          job_id: string | null;
          location_id: string;
          note: string | null;
          parsed: Json | null;
          rejection_reason: string | null;
          request_id: string | null;
          reviewed_at: string | null;
          reviewed_by: string | null;
          status: string;
          storage_bucket: string;
          storage_path: string;
          uploaded_by: string | null;
        };
        Insert: {
          approved_lines?: Json | null;
          created_at?: string;
          id?: string;
          job_id?: string | null;
          location_id: string;
          note?: string | null;
          parsed?: Json | null;
          rejection_reason?: string | null;
          request_id?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          storage_bucket: string;
          storage_path: string;
          uploaded_by?: string | null;
        };
        Update: {
          approved_lines?: Json | null;
          created_at?: string;
          id?: string;
          job_id?: string | null;
          location_id?: string;
          note?: string | null;
          parsed?: Json | null;
          rejection_reason?: string | null;
          request_id?: string | null;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          status?: string;
          storage_bucket?: string;
          storage_path?: string;
          uploaded_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "supply_receipts_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_receipts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_receipts_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "supply_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      supply_request_lines: {
        Row: {
          created_at: string;
          delivered_quantity: number;
          id: string;
          item_id: string | null;
          other_label: string | null;
          quantity: number;
          request_id: string;
          unit: string | null;
          vendor_id: string | null;
        };
        Insert: {
          created_at?: string;
          delivered_quantity?: number;
          id?: string;
          item_id?: string | null;
          other_label?: string | null;
          quantity?: number;
          request_id: string;
          unit?: string | null;
          vendor_id?: string | null;
        };
        Update: {
          created_at?: string;
          delivered_quantity?: number;
          id?: string;
          item_id?: string | null;
          other_label?: string | null;
          quantity?: number;
          request_id?: string;
          unit?: string | null;
          vendor_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "supply_request_lines_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "supply_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_request_lines_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "supply_requests";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_request_lines_vendor_id_fkey";
            columns: ["vendor_id"];
            isOneToOne: false;
            referencedRelation: "supply_vendors";
            referencedColumns: ["id"];
          },
        ];
      };
      supply_requests: {
        Row: {
          created_at: string;
          decided_at: string | null;
          decided_by: string | null;
          delivered_at: string | null;
          delivery_address: string | null;
          denial_reason: string | null;
          id: string;
          job_id: string | null;
          location_id: string;
          needed_by: string | null;
          note: string | null;
          ordered_at: string | null;
          requester_id: string;
          status: Database["public"]["Enums"]["supply_request_status"];
          updated_at: string;
          vendor_email_skipped: boolean;
        };
        Insert: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          delivered_at?: string | null;
          delivery_address?: string | null;
          denial_reason?: string | null;
          id?: string;
          job_id?: string | null;
          location_id: string;
          needed_by?: string | null;
          note?: string | null;
          ordered_at?: string | null;
          requester_id: string;
          status?: Database["public"]["Enums"]["supply_request_status"];
          updated_at?: string;
          vendor_email_skipped?: boolean;
        };
        Update: {
          created_at?: string;
          decided_at?: string | null;
          decided_by?: string | null;
          delivered_at?: string | null;
          delivery_address?: string | null;
          denial_reason?: string | null;
          id?: string;
          job_id?: string | null;
          location_id?: string;
          needed_by?: string | null;
          note?: string | null;
          ordered_at?: string | null;
          requester_id?: string;
          status?: Database["public"]["Enums"]["supply_request_status"];
          updated_at?: string;
          vendor_email_skipped?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: "supply_requests_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_requests_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      supply_stock: {
        Row: {
          id: string;
          item_id: string;
          location_id: string;
          on_hand: number;
          updated_at: string;
        };
        Insert: {
          id?: string;
          item_id: string;
          location_id: string;
          on_hand?: number;
          updated_at?: string;
        };
        Update: {
          id?: string;
          item_id?: string;
          location_id?: string;
          on_hand?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "supply_stock_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "supply_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_stock_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      supply_stock_moves: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          item_id: string;
          job_id: string | null;
          location_id: string;
          note: string | null;
          qty: number;
          reason: string;
          request_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_id: string;
          job_id?: string | null;
          location_id: string;
          note?: string | null;
          qty: number;
          reason?: string;
          request_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          item_id?: string;
          job_id?: string | null;
          location_id?: string;
          note?: string | null;
          qty?: number;
          reason?: string;
          request_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "supply_stock_moves_item_id_fkey";
            columns: ["item_id"];
            isOneToOne: false;
            referencedRelation: "supply_items";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_stock_moves_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_stock_moves_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "supply_stock_moves_request_id_fkey";
            columns: ["request_id"];
            isOneToOne: false;
            referencedRelation: "supply_requests";
            referencedColumns: ["id"];
          },
        ];
      };
      supply_vendors: {
        Row: {
          created_at: string;
          created_by: string | null;
          email: string | null;
          id: string;
          name: string;
          note: string | null;
          phone: string | null;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          id?: string;
          name: string;
          note?: string | null;
          phone?: string | null;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          email?: string | null;
          id?: string;
          name?: string;
          note?: string | null;
          phone?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      sync_runs: {
        Row: {
          errors: Json;
          finished_at: string | null;
          id: string;
          new_count: number | null;
          owner_match_count: number | null;
          source_rows: number | null;
          source_system: string;
          started_at: string;
          success: boolean | null;
          upserted: number | null;
        };
        Insert: {
          errors?: Json;
          finished_at?: string | null;
          id?: string;
          new_count?: number | null;
          owner_match_count?: number | null;
          source_rows?: number | null;
          source_system: string;
          started_at?: string;
          success?: boolean | null;
          upserted?: number | null;
        };
        Update: {
          errors?: Json;
          finished_at?: string | null;
          id?: string;
          new_count?: number | null;
          owner_match_count?: number | null;
          source_rows?: number | null;
          source_system?: string;
          started_at?: string;
          success?: boolean | null;
          upserted?: number | null;
        };
        Relationships: [];
      };
      tags: {
        Row: {
          archived_at: string | null;
          color: string;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          name: string;
          scopes: Database["public"]["Enums"]["tag_scope"][];
          sort_order: number;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          color?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name: string;
          scopes?: Database["public"]["Enums"]["tag_scope"][];
          sort_order?: number;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          color?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          name?: string;
          scopes?: Database["public"]["Enums"]["tag_scope"][];
          sort_order?: number;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tags_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      tasks: {
        Row: {
          account_id: string | null;
          activity_type_id: string | null;
          assignee: string | null;
          automation_reason: string | null;
          automation_rule_id: string | null;
          cadence_key: string | null;
          completed_at: string | null;
          completion_note: string | null;
          contact_id: string | null;
          created_at: string;
          created_by: string | null;
          description: string | null;
          due_date: string | null;
          due_time: string | null;
          entity_id: string | null;
          entity_type: string | null;
          id: string;
          is_demo: boolean;
          job_id: string | null;
          location_id: string | null;
          priority: Database["public"]["Enums"]["task_priority"];
          source: string;
          status: Database["public"]["Enums"]["task_status"];
          title: string;
          updated_at: string;
        };
        Insert: {
          account_id?: string | null;
          activity_type_id?: string | null;
          assignee?: string | null;
          automation_reason?: string | null;
          automation_rule_id?: string | null;
          cadence_key?: string | null;
          completed_at?: string | null;
          completion_note?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          due_date?: string | null;
          due_time?: string | null;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          location_id?: string | null;
          priority?: Database["public"]["Enums"]["task_priority"];
          source?: string;
          status?: Database["public"]["Enums"]["task_status"];
          title: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string | null;
          activity_type_id?: string | null;
          assignee?: string | null;
          automation_reason?: string | null;
          automation_rule_id?: string | null;
          cadence_key?: string | null;
          completed_at?: string | null;
          completion_note?: string | null;
          contact_id?: string | null;
          created_at?: string;
          created_by?: string | null;
          description?: string | null;
          due_date?: string | null;
          due_time?: string | null;
          entity_id?: string | null;
          entity_type?: string | null;
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          location_id?: string | null;
          priority?: Database["public"]["Enums"]["task_priority"];
          source?: string;
          status?: Database["public"]["Enums"]["task_status"];
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "tasks_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "tasks_activity_type_id_fkey";
            columns: ["activity_type_id"];
            isOneToOne: false;
            referencedRelation: "option_list_values";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_assignee_profiles_fkey";
            columns: ["assignee"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "tasks_automation_rule_id_fkey";
            columns: ["automation_rule_id"];
            isOneToOne: false;
            referencedRelation: "automation_rules";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "tasks_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "tasks_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tasks_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      time_entries: {
        Row: {
          approved_at: string | null;
          approved_by: string | null;
          arrived_lat: number | null;
          arrived_lon: number | null;
          created_at: string;
          departed_lat: number | null;
          departed_lon: number | null;
          ended_at: string | null;
          entered_by: string | null;
          entry_type: Database["public"]["Enums"]["time_entry_type"];
          id: string;
          is_demo: boolean;
          job_id: string | null;
          minutes: number | null;
          notes: string | null;
          rejected_reason: string | null;
          shift_id: string | null;
          started_at: string;
          status: Database["public"]["Enums"]["time_entry_status"];
          updated_at: string;
          user_id: string;
          work_component: string | null;
          work_date: string | null;
        };
        Insert: {
          approved_at?: string | null;
          approved_by?: string | null;
          arrived_lat?: number | null;
          arrived_lon?: number | null;
          created_at?: string;
          departed_lat?: number | null;
          departed_lon?: number | null;
          ended_at?: string | null;
          entered_by?: string | null;
          entry_type?: Database["public"]["Enums"]["time_entry_type"];
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          minutes?: number | null;
          notes?: string | null;
          rejected_reason?: string | null;
          shift_id?: string | null;
          started_at: string;
          status?: Database["public"]["Enums"]["time_entry_status"];
          updated_at?: string;
          user_id: string;
          work_component?: string | null;
          work_date?: string | null;
        };
        Update: {
          approved_at?: string | null;
          approved_by?: string | null;
          arrived_lat?: number | null;
          arrived_lon?: number | null;
          created_at?: string;
          departed_lat?: number | null;
          departed_lon?: number | null;
          ended_at?: string | null;
          entered_by?: string | null;
          entry_type?: Database["public"]["Enums"]["time_entry_type"];
          id?: string;
          is_demo?: boolean;
          job_id?: string | null;
          minutes?: number | null;
          notes?: string | null;
          rejected_reason?: string | null;
          shift_id?: string | null;
          started_at?: string;
          status?: Database["public"]["Enums"]["time_entry_status"];
          updated_at?: string;
          user_id?: string;
          work_component?: string | null;
          work_date?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "time_entries_approved_by_profiles_fkey";
            columns: ["approved_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "time_entries_entered_by_profiles_fkey";
            columns: ["entered_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "time_entries_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "time_entries_shift_id_fkey";
            columns: ["shift_id"];
            isOneToOne: false;
            referencedRelation: "shifts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "time_entries_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      time_entry_corrections: {
        Row: {
          after_data: Json;
          before_data: Json;
          changed_by: string | null;
          created_at: string;
          id: string;
          is_demo: boolean;
          reason: string | null;
          time_entry_id: string;
        };
        Insert: {
          after_data: Json;
          before_data: Json;
          changed_by?: string | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          reason?: string | null;
          time_entry_id: string;
        };
        Update: {
          after_data?: Json;
          before_data?: Json;
          changed_by?: string | null;
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          reason?: string | null;
          time_entry_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "time_entry_corrections_changed_by_profiles_fkey";
            columns: ["changed_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "time_entry_corrections_time_entry_id_fkey";
            columns: ["time_entry_id"];
            isOneToOne: false;
            referencedRelation: "time_entries";
            referencedColumns: ["id"];
          },
        ];
      };
      tm_rate_codes: {
        Row: {
          active: boolean;
          code: string;
          created_at: string;
          label: string;
          section: string;
          sort_order: number;
          unit_note: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          active?: boolean;
          code: string;
          created_at?: string;
          label: string;
          section: string;
          sort_order?: number;
          unit_note?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          active?: boolean;
          code?: string;
          created_at?: string;
          label?: string;
          section?: string;
          sort_order?: number;
          unit_note?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      todo_items: {
        Row: {
          created_at: string;
          done_at: string | null;
          id: string;
          job_id: string | null;
          sort_order: number;
          task_id: string | null;
          title: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          done_at?: string | null;
          id?: string;
          job_id?: string | null;
          sort_order?: number;
          task_id?: string | null;
          title?: string | null;
          user_id?: string;
        };
        Update: {
          created_at?: string;
          done_at?: string | null;
          id?: string;
          job_id?: string | null;
          sort_order?: number;
          task_id?: string | null;
          title?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "todo_items_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "todo_items_task_id_fkey";
            columns: ["task_id"];
            isOneToOne: false;
            referencedRelation: "tasks";
            referencedColumns: ["id"];
          },
        ];
      };
      touchpoints: {
        Row: {
          account_id: string;
          capture_source: Database["public"]["Enums"]["capture_source"];
          contact_id: string | null;
          counts_toward_cadence: boolean;
          created_at: string;
          created_by: string | null;
          direction: Database["public"]["Enums"]["comm_direction"];
          duration_seconds: number | null;
          external_ref: string | null;
          id: string;
          is_demo: boolean;
          is_auto_reply: boolean;
          is_self_reported: boolean;
          lat: number | null;
          location_accuracy_m: number | null;
          lon: number | null;
          meeting_held: boolean | null;
          notes: string | null;
          occurred_at: string;
          place_label: string | null;
          proof_added_at: string | null;
          proof_kind: string | null;
          proof_path: string | null;
          replied_at: string | null;
          type: Database["public"]["Enums"]["touchpoint_type"];
        };
        Insert: {
          account_id: string;
          capture_source?: Database["public"]["Enums"]["capture_source"];
          contact_id?: string | null;
          counts_toward_cadence?: boolean;
          created_at?: string;
          created_by?: string | null;
          direction?: Database["public"]["Enums"]["comm_direction"];
          duration_seconds?: number | null;
          external_ref?: string | null;
          id?: string;
          is_demo?: boolean;
          is_auto_reply?: boolean;
          is_self_reported?: boolean;
          lat?: number | null;
          location_accuracy_m?: number | null;
          lon?: number | null;
          meeting_held?: boolean | null;
          notes?: string | null;
          occurred_at?: string;
          place_label?: string | null;
          proof_added_at?: string | null;
          proof_kind?: string | null;
          proof_path?: string | null;
          replied_at?: string | null;
          type: Database["public"]["Enums"]["touchpoint_type"];
        };
        Update: {
          account_id?: string;
          capture_source?: Database["public"]["Enums"]["capture_source"];
          contact_id?: string | null;
          counts_toward_cadence?: boolean;
          created_at?: string;
          created_by?: string | null;
          direction?: Database["public"]["Enums"]["comm_direction"];
          duration_seconds?: number | null;
          external_ref?: string | null;
          id?: string;
          is_demo?: boolean;
          is_auto_reply?: boolean;
          is_self_reported?: boolean;
          lat?: number | null;
          location_accuracy_m?: number | null;
          lon?: number | null;
          meeting_held?: boolean | null;
          notes?: string | null;
          occurred_at?: string;
          place_label?: string | null;
          proof_added_at?: string | null;
          proof_kind?: string | null;
          proof_path?: string | null;
          replied_at?: string | null;
          type?: Database["public"]["Enums"]["touchpoint_type"];
        };
        Relationships: [
          {
            foreignKeyName: "touchpoints_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "touchpoints_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "touchpoints_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "touchpoints_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["primary_contact_id"];
          },
          {
            foreignKeyName: "touchpoints_contact_id_fkey";
            columns: ["contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "touchpoints_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      touchpoints_dedupe_archive: {
        Row: {
          account_id: string;
          archived_at: string;
          capture_source: Database["public"]["Enums"]["capture_source"];
          contact_id: string | null;
          counts_toward_cadence: boolean;
          created_at: string;
          created_by: string | null;
          direction: Database["public"]["Enums"]["comm_direction"];
          duration_seconds: number | null;
          external_ref: string | null;
          id: string;
          is_demo: boolean;
          is_self_reported: boolean;
          kept_id: string | null;
          lat: number | null;
          location_accuracy_m: number | null;
          lon: number | null;
          meeting_held: boolean | null;
          notes: string | null;
          occurred_at: string;
          place_label: string | null;
          replied_at: string | null;
          type: Database["public"]["Enums"]["touchpoint_type"];
        };
        Insert: {
          account_id: string;
          archived_at?: string;
          capture_source?: Database["public"]["Enums"]["capture_source"];
          contact_id?: string | null;
          counts_toward_cadence?: boolean;
          created_at?: string;
          created_by?: string | null;
          direction?: Database["public"]["Enums"]["comm_direction"];
          duration_seconds?: number | null;
          external_ref?: string | null;
          id?: string;
          is_demo?: boolean;
          is_self_reported?: boolean;
          kept_id?: string | null;
          lat?: number | null;
          location_accuracy_m?: number | null;
          lon?: number | null;
          meeting_held?: boolean | null;
          notes?: string | null;
          occurred_at?: string;
          place_label?: string | null;
          replied_at?: string | null;
          type: Database["public"]["Enums"]["touchpoint_type"];
        };
        Update: {
          account_id?: string;
          archived_at?: string;
          capture_source?: Database["public"]["Enums"]["capture_source"];
          contact_id?: string | null;
          counts_toward_cadence?: boolean;
          created_at?: string;
          created_by?: string | null;
          direction?: Database["public"]["Enums"]["comm_direction"];
          duration_seconds?: number | null;
          external_ref?: string | null;
          id?: string;
          is_demo?: boolean;
          is_self_reported?: boolean;
          kept_id?: string | null;
          lat?: number | null;
          location_accuracy_m?: number | null;
          lon?: number | null;
          meeting_held?: boolean | null;
          notes?: string | null;
          occurred_at?: string;
          place_label?: string | null;
          replied_at?: string | null;
          type?: Database["public"]["Enums"]["touchpoint_type"];
        };
        Relationships: [];
      };
      tradeshow_attendees: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          role_note: string | null;
          tradeshow_id: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          role_note?: string | null;
          tradeshow_id: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          role_note?: string | null;
          tradeshow_id?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tradeshow_attendees_tradeshow_id_fkey";
            columns: ["tradeshow_id"];
            isOneToOne: false;
            referencedRelation: "tradeshows";
            referencedColumns: ["id"];
          },
        ];
      };
      tradeshow_lead_captures: {
        Row: {
          account_id: string;
          badge_raw: string | null;
          captured_at: string;
          created_at: string;
          created_by: string;
          is_demo: boolean;
          needs_review: boolean;
          reviewed_at: string | null;
          reviewed_by: string | null;
          tradeshow_id: string;
          updated_at: string;
        };
        Insert: {
          account_id: string;
          badge_raw?: string | null;
          captured_at?: string;
          created_at?: string;
          created_by: string;
          is_demo?: boolean;
          needs_review?: boolean;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          tradeshow_id: string;
          updated_at?: string;
        };
        Update: {
          account_id?: string;
          badge_raw?: string | null;
          captured_at?: string;
          created_at?: string;
          created_by?: string;
          is_demo?: boolean;
          needs_review?: boolean;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          tradeshow_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tradeshow_lead_captures_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: true;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "tradeshow_lead_captures_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: true;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tradeshow_lead_captures_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: true;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "tradeshow_lead_captures_tradeshow_id_fkey";
            columns: ["tradeshow_id"];
            isOneToOne: false;
            referencedRelation: "tradeshows";
            referencedColumns: ["id"];
          },
        ];
      };
      tradeshow_lead_media: {
        Row: {
          account_id: string;
          captured_at: string;
          created_at: string;
          created_by: string;
          duration_seconds: number | null;
          height: number | null;
          id: string;
          is_demo: boolean;
          kind: string;
          mime: string;
          size_bytes: number;
          storage_path: string;
          thumb_path: string | null;
          tradeshow_id: string;
          updated_at: string;
          waveform_peaks: number[] | null;
          width: number | null;
        };
        Insert: {
          account_id: string;
          captured_at?: string;
          created_at?: string;
          created_by: string;
          duration_seconds?: number | null;
          height?: number | null;
          id?: string;
          is_demo?: boolean;
          kind: string;
          mime: string;
          size_bytes?: number;
          storage_path: string;
          thumb_path?: string | null;
          tradeshow_id: string;
          updated_at?: string;
          waveform_peaks?: number[] | null;
          width?: number | null;
        };
        Update: {
          account_id?: string;
          captured_at?: string;
          created_at?: string;
          created_by?: string;
          duration_seconds?: number | null;
          height?: number | null;
          id?: string;
          is_demo?: boolean;
          kind?: string;
          mime?: string;
          size_bytes?: number;
          storage_path?: string;
          thumb_path?: string | null;
          tradeshow_id?: string;
          updated_at?: string;
          waveform_peaks?: number[] | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "tradeshow_lead_media_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "tradeshow_lead_media_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "tradeshow_lead_media_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "tradeshow_lead_media_tradeshow_id_fkey";
            columns: ["tradeshow_id"];
            isOneToOne: false;
            referencedRelation: "tradeshows";
            referencedColumns: ["id"];
          },
        ];
      };
      tradeshow_notes: {
        Row: {
          body: string;
          created_at: string;
          created_by: string | null;
          id: string;
          is_demo: boolean;
          tradeshow_id: string;
          updated_at: string;
        };
        Insert: {
          body: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          tradeshow_id: string;
          updated_at?: string;
        };
        Update: {
          body?: string;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_demo?: boolean;
          tradeshow_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tradeshow_notes_tradeshow_id_fkey";
            columns: ["tradeshow_id"];
            isOneToOne: false;
            referencedRelation: "tradeshows";
            referencedColumns: ["id"];
          },
        ];
      };
      tradeshows: {
        Row: {
          archived_at: string | null;
          city: string | null;
          cost: number;
          created_at: string;
          created_by: string | null;
          ends_on: string | null;
          id: string;
          is_demo: boolean;
          leads_captured: number;
          location_id: string | null;
          name: string;
          notes: string | null;
          starts_on: string | null;
          state: string | null;
          updated_at: string;
        };
        Insert: {
          archived_at?: string | null;
          city?: string | null;
          cost?: number;
          created_at?: string;
          created_by?: string | null;
          ends_on?: string | null;
          id?: string;
          is_demo?: boolean;
          leads_captured?: number;
          location_id?: string | null;
          name: string;
          notes?: string | null;
          starts_on?: string | null;
          state?: string | null;
          updated_at?: string;
        };
        Update: {
          archived_at?: string | null;
          city?: string | null;
          cost?: number;
          created_at?: string;
          created_by?: string | null;
          ends_on?: string | null;
          id?: string;
          is_demo?: boolean;
          leads_captured?: number;
          location_id?: string | null;
          name?: string;
          notes?: string | null;
          starts_on?: string | null;
          state?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tradeshows_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      translations: {
        Row: {
          corrected_at: string | null;
          corrected_by: string | null;
          created_at: string;
          created_by: string | null;
          entity_id: string;
          entity_type: string;
          field: string;
          id: string;
          lang: string;
          source: Database["public"]["Enums"]["translation_source"];
          source_hash: string | null;
          source_text: string | null;
          text: string;
          updated_at: string;
        };
        Insert: {
          corrected_at?: string | null;
          corrected_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          entity_id: string;
          entity_type: string;
          field: string;
          id?: string;
          lang: string;
          source?: Database["public"]["Enums"]["translation_source"];
          source_hash?: string | null;
          source_text?: string | null;
          text: string;
          updated_at?: string;
        };
        Update: {
          corrected_at?: string | null;
          corrected_by?: string | null;
          created_at?: string;
          created_by?: string | null;
          entity_id?: string;
          entity_type?: string;
          field?: string;
          id?: string;
          lang?: string;
          source?: Database["public"]["Enums"]["translation_source"];
          source_hash?: string | null;
          source_text?: string | null;
          text?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "translations_corrected_by_profiles_fkey";
            columns: ["corrected_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "translations_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      user_achievements: {
        Row: {
          achievement_id: string;
          created_at: string;
          earned_at: string;
          granted_by: string | null;
          id: string;
          is_demo: boolean;
          note: string | null;
          period_key: string;
          updated_at: string;
          user_id: string;
          value: number | null;
        };
        Insert: {
          achievement_id: string;
          created_at?: string;
          earned_at?: string;
          granted_by?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          period_key?: string;
          updated_at?: string;
          user_id: string;
          value?: number | null;
        };
        Update: {
          achievement_id?: string;
          created_at?: string;
          earned_at?: string;
          granted_by?: string | null;
          id?: string;
          is_demo?: boolean;
          note?: string | null;
          period_key?: string;
          updated_at?: string;
          user_id?: string;
          value?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "user_achievements_achievement_id_fkey";
            columns: ["achievement_id"];
            isOneToOne: false;
            referencedRelation: "leaderboard_achievements";
            referencedColumns: ["id"];
          },
        ];
      };
      user_day_mode: {
        Row: {
          day: string;
          mode: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          day?: string;
          mode?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          day?: string;
          mode?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_day_mode_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      user_device_permissions: {
        Row: {
          created_at: string;
          device_id: string;
          id: string;
          last_seen_at: string;
          location_denied_at: string | null;
          location_state: string;
          notifications_denied_at: string | null;
          notifications_state: string;
          platform: string | null;
          primed_at: string | null;
          updated_at: string;
          user_agent: string | null;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          device_id: string;
          id?: string;
          last_seen_at?: string;
          location_denied_at?: string | null;
          location_state?: string;
          notifications_denied_at?: string | null;
          notifications_state?: string;
          platform?: string | null;
          primed_at?: string | null;
          updated_at?: string;
          user_agent?: string | null;
          user_id: string;
        };
        Update: {
          created_at?: string;
          device_id?: string;
          id?: string;
          last_seen_at?: string;
          location_denied_at?: string | null;
          location_state?: string;
          notifications_denied_at?: string | null;
          notifications_state?: string;
          platform?: string | null;
          primed_at?: string | null;
          updated_at?: string;
          user_agent?: string | null;
          user_id?: string;
        };
        Relationships: [];
      };
      user_permissions: {
        Row: {
          created_at: string;
          effect: string;
          expires_at: string | null;
          granted_by: string | null;
          id: string;
          location_id: string | null;
          permission_key: string;
          reason: string | null;
          region_id: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          effect?: string;
          expires_at?: string | null;
          granted_by?: string | null;
          id?: string;
          location_id?: string | null;
          permission_key: string;
          reason?: string | null;
          region_id?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          effect?: string;
          expires_at?: string | null;
          granted_by?: string | null;
          id?: string;
          location_id?: string | null;
          permission_key?: string;
          reason?: string | null;
          region_id?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_permissions_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "user_permissions_permission_key_fkey";
            columns: ["permission_key"];
            isOneToOne: false;
            referencedRelation: "permissions";
            referencedColumns: ["key"];
          },
          {
            foreignKeyName: "user_permissions_region_id_fkey";
            columns: ["region_id"];
            isOneToOne: false;
            referencedRelation: "regions";
            referencedColumns: ["id"];
          },
        ];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          is_demo: boolean;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_demo?: boolean;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_roles_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      user_table_prefs: {
        Row: {
          created_at: string;
          prefs: Json;
          table_key: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          prefs?: Json;
          table_key: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          prefs?: Json;
          table_key?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_view_prefs: {
        Row: {
          scope: string;
          updated_at: string;
          user_id: string;
          view_mode: string;
        };
        Insert: {
          scope: string;
          updated_at?: string;
          user_id: string;
          view_mode: string;
        };
        Update: {
          scope?: string;
          updated_at?: string;
          user_id?: string;
          view_mode?: string;
        };
        Relationships: [
          {
            foreignKeyName: "user_view_prefs_user_id_profiles_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      vehicle_documents: {
        Row: {
          created_at: string;
          due_kind: string | null;
          file_name: string;
          id: string;
          is_current: boolean;
          maintenance_record_id: string | null;
          mime_type: string | null;
          size_bytes: number | null;
          storage_path: string;
          superseded_at: string | null;
          uploaded_by: string | null;
          vehicle_id: string;
        };
        Insert: {
          created_at?: string;
          due_kind?: string | null;
          file_name: string;
          id?: string;
          is_current?: boolean;
          maintenance_record_id?: string | null;
          mime_type?: string | null;
          size_bytes?: number | null;
          storage_path: string;
          superseded_at?: string | null;
          uploaded_by?: string | null;
          vehicle_id: string;
        };
        Update: {
          created_at?: string;
          due_kind?: string | null;
          file_name?: string;
          id?: string;
          is_current?: boolean;
          maintenance_record_id?: string | null;
          mime_type?: string | null;
          size_bytes?: number | null;
          storage_path?: string;
          superseded_at?: string | null;
          uploaded_by?: string | null;
          vehicle_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_documents_record_same_vehicle";
            columns: ["maintenance_record_id", "vehicle_id"];
            isOneToOne: false;
            referencedRelation: "vehicle_maintenance_records";
            referencedColumns: ["id", "vehicle_id"];
          },
          {
            foreignKeyName: "vehicle_documents_vehicle_id_fkey";
            columns: ["vehicle_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id"];
          },
        ];
      };
      vehicle_due_items: {
        Row: {
          created_at: string;
          due_odometer: number | null;
          due_on: string | null;
          id: string;
          kind: string;
          note: string | null;
          provider: string | null;
          reference: string | null;
          updated_at: string;
          updated_by: string | null;
          vehicle_id: string;
          warn_days: number;
          warn_miles: number;
        };
        Insert: {
          created_at?: string;
          due_odometer?: number | null;
          due_on?: string | null;
          id?: string;
          kind: string;
          note?: string | null;
          provider?: string | null;
          reference?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          vehicle_id: string;
          warn_days?: number;
          warn_miles?: number;
        };
        Update: {
          created_at?: string;
          due_odometer?: number | null;
          due_on?: string | null;
          id?: string;
          kind?: string;
          note?: string | null;
          provider?: string | null;
          reference?: string | null;
          updated_at?: string;
          updated_by?: string | null;
          vehicle_id?: string;
          warn_days?: number;
          warn_miles?: number;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_due_items_vehicle_id_fkey";
            columns: ["vehicle_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id"];
          },
        ];
      };
      vehicle_maintenance_records: {
        Row: {
          cost: number | null;
          created_at: string;
          created_by: string | null;
          id: string;
          kind: string;
          note: string | null;
          odometer: number | null;
          performed_on: string;
          updated_at: string;
          vehicle_id: string;
          vendor: string | null;
        };
        Insert: {
          cost?: number | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind: string;
          note?: string | null;
          odometer?: number | null;
          performed_on: string;
          updated_at?: string;
          vehicle_id: string;
          vendor?: string | null;
        };
        Update: {
          cost?: number | null;
          created_at?: string;
          created_by?: string | null;
          id?: string;
          kind?: string;
          note?: string | null;
          odometer?: number | null;
          performed_on?: string;
          updated_at?: string;
          vehicle_id?: string;
          vendor?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_maintenance_records_vehicle_id_fkey";
            columns: ["vehicle_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id"];
          },
        ];
      };
      vehicle_positions: {
        Row: {
          created_at: string;
          heading: number | null;
          id: string;
          ignition: boolean | null;
          is_demo: boolean;
          lat: number;
          lon: number;
          occurred_at: string;
          raw: Json;
          speed_mph: number | null;
          vehicle_id: string;
        };
        Insert: {
          created_at?: string;
          heading?: number | null;
          id?: string;
          ignition?: boolean | null;
          is_demo?: boolean;
          lat: number;
          lon: number;
          occurred_at: string;
          raw?: Json;
          speed_mph?: number | null;
          vehicle_id: string;
        };
        Update: {
          created_at?: string;
          heading?: number | null;
          id?: string;
          ignition?: boolean | null;
          is_demo?: boolean;
          lat?: number;
          lon?: number;
          occurred_at?: string;
          raw?: Json;
          speed_mph?: number | null;
          vehicle_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vehicle_positions_vehicle_id_fkey";
            columns: ["vehicle_id"];
            isOneToOne: false;
            referencedRelation: "vehicles";
            referencedColumns: ["id"];
          },
        ];
      };
      vehicles: {
        Row: {
          assigned_user_id: string | null;
          created_at: string;
          external_id: string;
          id: string;
          ignition: boolean | null;
          is_demo: boolean;
          label: string;
          last_lat: number | null;
          last_lon: number | null;
          last_position_at: string | null;
          location_id: string | null;
          provider: Database["public"]["Enums"]["integration_provider"];
          updated_at: string;
        };
        Insert: {
          assigned_user_id?: string | null;
          created_at?: string;
          external_id: string;
          id?: string;
          ignition?: boolean | null;
          is_demo?: boolean;
          label: string;
          last_lat?: number | null;
          last_lon?: number | null;
          last_position_at?: string | null;
          location_id?: string | null;
          provider?: Database["public"]["Enums"]["integration_provider"];
          updated_at?: string;
        };
        Update: {
          assigned_user_id?: string | null;
          created_at?: string;
          external_id?: string;
          id?: string;
          ignition?: boolean | null;
          is_demo?: boolean;
          label?: string;
          last_lat?: number | null;
          last_lon?: number | null;
          last_position_at?: string | null;
          location_id?: string | null;
          provider?: Database["public"]["Enums"]["integration_provider"];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "vehicles_assigned_user_id_profiles_fkey";
            columns: ["assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "vehicles_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
        ];
      };
      vendor_documents: {
        Row: {
          account_id: string;
          carrier: string | null;
          covered_amount: number | null;
          created_at: string;
          created_by: string | null;
          currency: string;
          effective_date: string | null;
          expiry_date: string | null;
          id: string;
          is_demo: boolean;
          issuer: string | null;
          kind: Database["public"]["Enums"]["vendor_doc_kind"];
          name: string | null;
          notes: string | null;
          policy_number: string | null;
          status: Database["public"]["Enums"]["vendor_doc_status"];
          storage_path: string | null;
          updated_at: string;
          verified_at: string | null;
          verified_by: string | null;
        };
        Insert: {
          account_id: string;
          carrier?: string | null;
          covered_amount?: number | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          effective_date?: string | null;
          expiry_date?: string | null;
          id?: string;
          is_demo?: boolean;
          issuer?: string | null;
          kind: Database["public"]["Enums"]["vendor_doc_kind"];
          name?: string | null;
          notes?: string | null;
          policy_number?: string | null;
          status?: Database["public"]["Enums"]["vendor_doc_status"];
          storage_path?: string | null;
          updated_at?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Update: {
          account_id?: string;
          carrier?: string | null;
          covered_amount?: number | null;
          created_at?: string;
          created_by?: string | null;
          currency?: string;
          effective_date?: string | null;
          expiry_date?: string | null;
          id?: string;
          is_demo?: boolean;
          issuer?: string | null;
          kind?: Database["public"]["Enums"]["vendor_doc_kind"];
          name?: string | null;
          notes?: string | null;
          policy_number?: string | null;
          status?: Database["public"]["Enums"]["vendor_doc_status"];
          storage_path?: string | null;
          updated_at?: string;
          verified_at?: string | null;
          verified_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "vendor_documents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "vendor_documents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "vendor_documents_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "vendor_documents_created_by_profiles_fkey";
            columns: ["created_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "vendor_documents_verified_by_fkey";
            columns: ["verified_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      zone_adjacency: {
        Row: {
          adjacent_zone_id: string;
          zone_id: string;
        };
        Insert: {
          adjacent_zone_id: string;
          zone_id: string;
        };
        Update: {
          adjacent_zone_id?: string;
          zone_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "zone_adjacency_adjacent_zone_id_fkey";
            columns: ["adjacent_zone_id"];
            isOneToOne: false;
            referencedRelation: "zones";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "zone_adjacency_zone_id_fkey";
            columns: ["zone_id"];
            isOneToOne: false;
            referencedRelation: "zones";
            referencedColumns: ["id"];
          },
        ];
      };
      zones: {
        Row: {
          created_at: string;
          id: string;
          is_active: boolean;
          is_demo: boolean;
          market_id: string;
          name: string;
          postal_codes: string[];
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          market_id: string;
          name: string;
          postal_codes?: string[];
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          is_active?: boolean;
          is_demo?: boolean;
          market_id?: string;
          name?: string;
          postal_codes?: string[];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "zones_market_id_fkey";
            columns: ["market_id"];
            isOneToOne: false;
            referencedRelation: "markets";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      account_certificate_last_send: {
        Row: {
          account_id: string | null;
          expiry_at_send: string | null;
          queued_at: string | null;
          send_id: string | null;
          sent_at: string | null;
          sent_by: string | null;
          sent_to: string | null;
          status: Database["public"]["Enums"]["certificate_send_status"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "certificate_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "certificate_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "certificate_sends_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "certificate_sends_sent_by_fkey";
            columns: ["sent_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      account_compliance_status: {
        Row: {
          account_id: string | null;
          account_name: string | null;
          carrier: string | null;
          category: string | null;
          cert_expiry_date: string | null;
          cert_file_id: string | null;
          cert_file_name: string | null;
          cert_policy_number: string | null;
          covered_amount: number | null;
          credential_id: string | null;
          credential_name: string | null;
          currency: string | null;
          days_to_expiry: number | null;
          direction: string | null;
          document_id: string | null;
          effective_date: string | null;
          effective_expiry: string | null;
          expiry_date: string | null;
          holder_location_id: string | null;
          holder_user_id: string | null;
          issuer: string | null;
          kind: string | null;
          limit_aggregate: number | null;
          location_id: string | null;
          mandatory: boolean | null;
          must_name_account: boolean | null;
          notes: string | null;
          policy_number: string | null;
          renewal_lead_days: number | null;
          requested_at: string | null;
          required_amount: number | null;
          required_currency: string | null;
          required_value: string | null;
          requirement_id: string | null;
          requirement_type: string | null;
          state_code: string | null;
          status: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "account_compliance_requirements_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "account_fire_rollup";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "account_compliance_requirements_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "accounts";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "account_compliance_requirements_account_id_fkey";
            columns: ["account_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_rule_state";
            referencedColumns: ["account_id"];
          },
          {
            foreignKeyName: "accounts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_credentials_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "vendor_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_credentials_holder_location_id_fkey";
            columns: ["holder_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_credentials_holder_user_id_fkey";
            columns: ["holder_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
        ];
      };
      account_fire_rollup: {
        Row: {
          account_id: string | null;
          account_type: string | null;
          approval_due_on: string | null;
          approval_state: string | null;
          assigned_rep: string | null;
          estimated_annual_value: number | null;
          last_in_person_at: string | null;
          last_loss_date: string | null;
          last_touch_at: string | null;
          lead_count: number | null;
          location_id: string | null;
          mailing_address: string | null;
          name: string | null;
          notes: string | null;
          open_count: number | null;
          pipeline_id: string | null;
          primary_contact_email: string | null;
          primary_contact_id: string | null;
          primary_contact_name: string | null;
          primary_contact_phone: string | null;
          priority: string | null;
          stage: string | null;
          stage_id: string | null;
          status: Database["public"]["Enums"]["account_status"] | null;
          touch_count: number | null;
          units_vacated: number | null;
          updated_at: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "accounts_assigned_rep_profiles_fkey";
            columns: ["assigned_rep"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "accounts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
        ];
      };
      geography_columns: {
        Row: {
          coord_dimension: number | null;
          f_geography_column: unknown;
          f_table_catalog: unknown;
          f_table_name: unknown;
          f_table_schema: unknown;
          srid: number | null;
          type: string | null;
        };
        Relationships: [];
      };
      geometry_columns: {
        Row: {
          coord_dimension: number | null;
          f_geometry_column: unknown;
          f_table_catalog: string | null;
          f_table_name: unknown;
          f_table_schema: unknown;
          srid: number | null;
          type: string | null;
        };
        Insert: {
          coord_dimension?: number | null;
          f_geometry_column?: unknown;
          f_table_catalog?: string | null;
          f_table_name?: unknown;
          f_table_schema?: unknown;
          srid?: number | null;
          type?: string | null;
        };
        Update: {
          coord_dimension?: number | null;
          f_geometry_column?: unknown;
          f_table_catalog?: string | null;
          f_table_name?: unknown;
          f_table_schema?: unknown;
          srid?: number | null;
          type?: string | null;
        };
        Relationships: [];
      };
      network_compliance_status: {
        Row: {
          carrier: string | null;
          category: string | null;
          covered_amount: number | null;
          credential_id: string | null;
          credential_name: string | null;
          currency: string | null;
          days_to_expiry: number | null;
          document_id: string | null;
          effective_date: string | null;
          entity_name: string | null;
          expiry_date: string | null;
          holder_location_id: string | null;
          holder_user_id: string | null;
          issuer: string | null;
          kind: string | null;
          limit_aggregate: number | null;
          location_id: string | null;
          mandatory: boolean | null;
          membership_id: string | null;
          network_id: string | null;
          network_name: string | null;
          notes: string | null;
          policy_number: string | null;
          renewal_lead_days: number | null;
          required_amount: number | null;
          required_currency: string | null;
          required_value: string | null;
          requirement_id: string | null;
          requirement_type: string | null;
          state_code: string | null;
          status: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "company_credentials_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "vendor_documents";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_credentials_holder_location_id_fkey";
            columns: ["holder_location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "company_credentials_holder_user_id_fkey";
            columns: ["holder_user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "network_memberships_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "network_memberships_network_id_fkey";
            columns: ["network_id"];
            isOneToOne: false;
            referencedRelation: "networks";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "network_requirements_membership_id_fkey";
            columns: ["membership_id"];
            isOneToOne: false;
            referencedRelation: "network_memberships";
            referencedColumns: ["id"];
          },
        ];
      };
      option_other_details: {
        Row: {
          detail: string | null;
          last_used: string | null;
          list_key: string | null;
          uses: number | null;
        };
        Relationships: [];
      };
      pipeline_rule_state: {
        Row: {
          account_id: string | null;
          assigned_rep: string | null;
          attempt_days: number | null;
          attempts: number | null;
          auto_ghost_due: boolean | null;
          clock_started_at: string | null;
          days_since_activity: number | null;
          exhausted: boolean | null;
          ghost_days: number | null;
          ghost_due_at: string | null;
          ghost_snoozed_at: string | null;
          ghost_snoozed_by: string | null;
          ghost_snoozed_until: string | null;
          ghost_warning_sent_at: string | null;
          goasted_at: string | null;
          green_light_date: string | null;
          in_rule_stage: boolean | null;
          is_demo: boolean | null;
          last_activity_at: string | null;
          last_reply_at: string | null;
          last_task_done_at: string | null;
          last_touch_at: string | null;
          location_id: string | null;
          methods: string[] | null;
          methods_count: number | null;
          name: string | null;
          need_attempts: number | null;
          need_days: number | null;
          need_methods: number | null;
          no_service_reason: string | null;
          no_service_reason_code: string | null;
          pipeline_id: string | null;
          replied: boolean | null;
          retry_at: string | null;
          rule_clock_started_at: string | null;
          snooze_used: boolean | null;
          snoozed: boolean | null;
          stage_changed_at: string | null;
          stage_id: string | null;
          stage_key: string | null;
          standard_met: boolean | null;
          warn_days: number | null;
          warning: boolean | null;
        };
        Relationships: [
          {
            foreignKeyName: "accounts_assigned_rep_profiles_fkey";
            columns: ["assigned_rep"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["user_id"];
          },
          {
            foreignKeyName: "accounts_location_id_fkey";
            columns: ["location_id"];
            isOneToOne: false;
            referencedRelation: "locations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_pipeline_id_fkey";
            columns: ["pipeline_id"];
            isOneToOne: false;
            referencedRelation: "pipelines";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "accounts_stage_id_fkey";
            columns: ["stage_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_stages";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string };
        Returns: undefined;
      };
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown };
        Returns: unknown;
      };
      _postgis_pgsql_version: { Args: never; Returns: string };
      _postgis_scripts_pgsql_version: { Args: never; Returns: string };
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown };
        Returns: number;
      };
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown };
        Returns: string;
      };
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_dwithin: {
        Args: {
          geog1: unknown;
          geog2: unknown;
          tolerance: number;
          use_spheroid?: boolean;
        };
        Returns: boolean;
      };
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown };
        Returns: number;
      };
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_sortablehash: { Args: { geom: unknown }; Returns: number };
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      _st_voronoi: {
        Args: {
          clip?: unknown;
          g1: unknown;
          return_polygons?: boolean;
          tolerance?: number;
        };
        Returns: unknown;
      };
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      account_client_since: { Args: { _account_id: string }; Returns: string };
      account_clocks_run: { Args: { _account_type: string }; Returns: boolean };
      account_compliance_indicator: {
        Args: { _account_id: string };
        Returns: string;
      };
      account_compliance_state: {
        Args: { _account_id: string };
        Returns: string;
      };
      account_email_reply_status: {
        Args: { _account_id: string };
        Returns: {
          cadence_met: boolean;
          emails_replied: number;
          emails_sent: number;
          last_outbound_at: string;
          last_reply_at: string;
          outbound_since_reply: number;
        }[];
      };
      account_focus: {
        Args: { _account_id: string };
        Returns: {
          action: string;
          detail: string;
          severity: string;
          sort_order: number;
          suggestion_key: string;
          title: string;
        }[];
      };
      account_is_active_client: {
        Args: { _account_id: string };
        Returns: boolean;
      };
      account_is_house_account: {
        Args: { _account_id: string };
        Returns: boolean;
      };
      account_job_roles: {
        Args: { _account_id: string };
        Returns: {
          job_count: number;
          role: string;
        }[];
      };
      accounts_at_address: {
        Args: { _address: string; _lat?: number; _lon?: number };
        Returns: {
          account_id: string;
          account_name: string;
          match_label: string;
          matched_by: string;
          owning_location_code: string;
          owning_location_id: string;
          owning_location_name: string;
          viewer_has_full_access: boolean;
        }[];
      };
      accounts_compliance_indicators: {
        Args: { _ids: string[] };
        Returns: {
          account_id: string;
          indicator: string;
        }[];
      };
      addauth: { Args: { "": string }; Returns: boolean };
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string;
              column_name: string;
              new_dim: number;
              new_srid_in: number;
              new_type: string;
              schema_name: string;
              table_name: string;
              use_typmod?: boolean;
            };
            Returns: string;
          }
        | {
            Args: {
              column_name: string;
              new_dim: number;
              new_srid: number;
              new_type: string;
              schema_name: string;
              table_name: string;
              use_typmod?: boolean;
            };
            Returns: string;
          }
        | {
            Args: {
              column_name: string;
              new_dim: number;
              new_srid: number;
              new_type: string;
              table_name: string;
              use_typmod?: boolean;
            };
            Returns: string;
          };
      admin_list_users: {
        Args: never;
        Returns: {
          approval_status: string;
          email: string;
          full_name: string;
          is_active: boolean;
          location_ids: string[];
          location_roles: string[];
          region_ids: string[];
          roles: Database["public"]["Enums"]["app_role"][];
          user_id: string;
        }[];
      };
      app_base_url: { Args: never; Returns: string };
      app_hook_url: {
        Args: { _hook: string; _override?: string };
        Returns: string;
      };
      apply_offline_op: {
        Args: {
          _client_created_at?: string;
          _key: string;
          _kind: string;
          _payload: Json;
        };
        Returns: Json;
      };
      approve_account_lead: {
        Args: { _account_id: string };
        Returns: undefined;
      };
      approve_supply_receipt: {
        Args: {
          _lines: Json;
          _purchased_on: string;
          _receipt_id: string;
          _supplier: string;
        };
        Returns: number;
      };
      avg_hours_by_loss_type: {
        Args: { _from: string; _to: string };
        Returns: {
          avg_days: number;
          avg_minutes: number;
          jobs: number;
          loss_type: string;
        }[];
      };
      award_achievements: { Args: never; Returns: number };
      calendar_local_recurrence_available: { Args: never; Returns: boolean };
      calendar_push_authorized_event: {
        Args: { _event_id: string };
        Returns: Json;
      };
      can_access_document_object: {
        Args: { _path: string; _user_id: string };
        Returns: boolean;
      };
      can_approve_leads: { Args: { _user_id: string }; Returns: boolean };
      can_approve_supply_receipt: {
        Args: { _location_id: string; _user_id: string };
        Returns: boolean;
      };
      can_create_job: {
        Args: { _location_id: string; _user_id: string };
        Returns: boolean;
      };
      can_create_labels: { Args: { _user_id: string }; Returns: boolean };
      can_edit_account_proposals: {
        Args: { _account_id: string; _user_id: string };
        Returns: boolean;
      };
      can_export: { Args: { _user_id: string }; Returns: boolean };
      can_manage_compliance_file_path: {
        Args: { _path: string };
        Returns: boolean;
      };
      can_manage_contact_row: {
        Args: { _contact_id: string; _user_id: string };
        Returns: boolean;
      };
      can_manage_job: {
        Args: { _job_id: string; _user_id: string };
        Returns: boolean;
      };
      can_manage_location: {
        Args: { _location_id: string; _user_id: string };
        Returns: boolean;
      };
      can_manage_project: {
        Args: { _project_id: string; _user_id: string };
        Returns: boolean;
      };
      can_manage_vehicle: {
        Args: { _user_id: string; _vehicle_id: string };
        Returns: boolean;
      };
      can_read_staff_email: { Args: { _user_id: string }; Returns: boolean };
      can_view_account_proposals: {
        Args: { _account_id: string; _user_id: string };
        Returns: boolean;
      };
      can_view_compliance_file_path: {
        Args: { _path: string };
        Returns: boolean;
      };
      can_view_contact_row: {
        Args: { _contact_id: string; _user_id: string };
        Returns: boolean;
      };
      can_view_finance: { Args: { _user_id: string }; Returns: boolean };
      can_view_job: {
        Args: { _job_id: string; _user_id: string };
        Returns: boolean;
      };
      can_view_lead: {
        Args: { _lead_id: string; _user_id: string };
        Returns: boolean;
      };
      can_view_location: {
        Args: { _location_id: string; _user_id: string };
        Returns: boolean;
      };
      can_view_person_scorecard: { Args: { _target: string }; Returns: boolean };
      can_view_project: {
        Args: { _project_id: string; _user_id: string };
        Returns: boolean;
      };
      can_view_tradeshow_lead_media: {
        Args: { _created_by: string; _tradeshow_id: string; _user_id: string };
        Returns: boolean;
      };
      can_view_vehicle: {
        Args: { _user_id: string; _vehicle_id: string };
        Returns: boolean;
      };
      can_write_translation: {
        Args: { _entity_id: string; _entity_type: string; _user_id: string };
        Returns: boolean;
      };
      capture_tradeshow_lead_account: {
        Args: {
          _account_id: string;
          _captured_at: string;
          _email?: string;
          _lead_source_id?: string;
          _location_id: string;
          _name: string;
          _notes?: string;
          _phone?: string;
          _pipeline_id?: string;
          _stage_id?: string;
          _tradeshow_id: string;
        };
        Returns: string;
      };
      chase_setting_num: {
        Args: { _default: number; _key: string };
        Returns: number;
      };
      chase_settings: { Args: never; Returns: Json };
      chase_settings_defaults: { Args: never; Returns: Json };
      chase_shift_overtime_sweep: { Args: never; Returns: Json };
      chat_shared_record_types: { Args: never; Returns: string[] };
      claim_due_held_emails: {
        Args: { _limit?: number };
        Returns: {
          account_id: string | null;
          attachment_url: string | null;
          attachments: Json;
          body_html: string;
          bounced_at: string | null;
          cancelled_at: string | null;
          category: Database["public"]["Enums"]["email_category"];
          cc_emails: string[];
          claimed_at: string | null;
          contact_id: string | null;
          created_at: string;
          delivered_at: string | null;
          delivery_attempts: number;
          delivery_reason: string | null;
          error: string | null;
          from_name: string | null;
          id: string;
          invoice_id: string | null;
          is_demo: boolean;
          job_id: string | null;
          last_attempt_at: string | null;
          location_id: string | null;
          log_touchpoint: boolean;
          next_attempt_at: string | null;
          opened_at: string | null;
          provider: string | null;
          provider_id: string | null;
          queued_at: string;
          release_at: string | null;
          released_at: string | null;
          reply_to: string | null;
          sent_at: string | null;
          sent_by: string | null;
          sent_from: string | null;
          status: Database["public"]["Enums"]["email_status"];
          subject: string;
          supply_request_id: string | null;
          template_id: string | null;
          template_key: string | null;
          to_emails: string[];
          touchpoint_id: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "email_messages";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      claim_incident: {
        Args: {
          _eta_minutes?: number;
          _incident_id: string;
          _lock_minutes?: number;
        };
        Returns: Json;
      };
      claim_new_lead: { Args: { _account_id: string }; Returns: string };
      claim_retryable_queued_emails: {
        Args: { _limit?: number; _only_id?: string };
        Returns: {
          account_id: string | null;
          attachment_url: string | null;
          attachments: Json;
          body_html: string;
          bounced_at: string | null;
          cancelled_at: string | null;
          category: Database["public"]["Enums"]["email_category"];
          cc_emails: string[];
          claimed_at: string | null;
          contact_id: string | null;
          created_at: string;
          delivered_at: string | null;
          delivery_attempts: number;
          delivery_reason: string | null;
          error: string | null;
          from_name: string | null;
          id: string;
          invoice_id: string | null;
          is_demo: boolean;
          job_id: string | null;
          last_attempt_at: string | null;
          location_id: string | null;
          log_touchpoint: boolean;
          next_attempt_at: string | null;
          opened_at: string | null;
          provider: string | null;
          provider_id: string | null;
          queued_at: string;
          release_at: string | null;
          released_at: string | null;
          reply_to: string | null;
          sent_at: string | null;
          sent_by: string | null;
          sent_from: string | null;
          status: Database["public"]["Enums"]["email_status"];
          subject: string;
          supply_request_id: string | null;
          template_id: string | null;
          template_key: string | null;
          to_emails: string[];
          touchpoint_id: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "email_messages";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      cleanup_rate_limit_counters: { Args: never; Returns: number };
      commission_overview: {
        Args: { _from: string; _to: string; _user_id: string };
        Returns: {
          collected_volume: number;
          pay_type: string;
          salary_period: number;
          signed_volume: number;
        }[];
      };
      commission_terms_on: {
        Args: { _on: string; _source: string; _user_id: string };
        Returns: {
          basis: string;
          flat_amount: number;
          plan_id: string;
          rate_percent: number;
          tiers: Json;
        }[];
      };
      company_money_summary: {
        Args: { _from: string; _location_id?: string; _to: string };
        Returns: {
          direct_costs: number;
          labour_cost: number;
          net_profit: number;
          open_claims_count: number;
          open_claims_value: number;
          received: number;
          referral_cost: number;
          rep_cost: number;
          total_revenue: number;
        }[];
      };
      complete_document_signing_atomic: {
        Args: {
          _attempt_id: string;
          _evidence: Json;
          _packet_id: string;
          _submission: Json;
          _token: string;
        };
        Returns: number;
      };
      compliance_status_of: {
        Args: {
          _covered: number;
          _expiry: string;
          _has_doc: boolean;
          _lead_days: number;
          _required: number;
        };
        Returns: string;
      };
      compute_job_commissions: { Args: { _job_id: string }; Returns: number };
      consume_rate_limit: {
        Args: {
          p_block_seconds?: number;
          p_bucket: string;
          p_identity: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: {
          allowed: boolean;
          attempt_count: number;
          retry_after_seconds: number;
        }[];
      };
      contact_gift_policy: { Args: { _contact: string }; Returns: string };
      contact_job_roles: {
        Args: { _contact_id: string };
        Returns: {
          job_count: number;
          role: string;
        }[];
      };
      convert_lead_to_opportunity: {
        Args: { _lead_id: string };
        Returns: string;
      };
      count_layout_overrides: {
        Args: { _role_key: string; _scope: string };
        Returns: number;
      };
      create_exposure_incident: {
        Args: {
          _address: string;
          _building_type?: string;
          _lat?: number;
          _lon?: number;
          _origin_incident_id: string;
          _postal_code?: string;
        };
        Returns: string;
      };
      credential_accounts_at_risk: {
        Args: { _credential_id: string };
        Returns: {
          account_id: string;
          account_name: string;
          location_id: string;
          requirement_type: string;
        }[];
      };
      credential_impact: {
        Args: { _credential_id: string };
        Returns: {
          account_count: number;
          account_names: string[];
          network_labels: string[];
        }[];
      };
      crew_rate_for: {
        Args: { _crew_class: string; _location_id: string; _on: string };
        Returns: number;
      };
      cron_secret: { Args: never; Returns: string };
      deactivate_user_now: {
        Args: { _reason?: string; _user_id: string };
        Returns: Json;
      };
      decline_incident: { Args: { _incident_id: string }; Returns: undefined };
      decline_incident_with_reason: {
        Args: { _incident_id: string; _reason?: string };
        Returns: undefined;
      };
      default_pipeline_for: {
        Args: { _entity_type?: string; _location_id: string };
        Returns: string;
      };
      demo_data_counts: {
        Args: never;
        Returns: {
          row_count: number;
          table_name: string;
        }[];
      };
      demo_data_total: { Args: never; Returns: number };
      demo_tables: { Args: never; Returns: string[] };
      demo_user_or_null: { Args: { _user: string }; Returns: string };
      director_rep_cost: {
        Args: { _from: string; _to: string };
        Returns: {
          commission_paid: number;
          full_name: string;
          revenue: number;
          salary_cost: number;
          user_id: string;
        }[];
      };
      director_rep_kpis: {
        Args: { _from: string; _to: string };
        Returns: {
          accounts_closed: number;
          accounts_touched: number;
          calls_made: number;
          full_name: string;
          jobs_signed_cash: number;
          jobs_signed_insurance: number;
          meetings_held: number;
          proposals_sent: number;
          stage_advances: number;
          user_id: string;
        }[];
      };
      disablelongtransactions: { Args: never; Returns: string };
      dispatch_incident_to_chaser: {
        Args: {
          _eta_minutes?: number;
          _incident_id: string;
          _reason?: string;
          _user_id: string;
        };
        Returns: Json;
      };
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string;
              column_name: string;
              schema_name: string;
              table_name: string;
            };
            Returns: string;
          }
        | {
            Args: {
              column_name: string;
              schema_name: string;
              table_name: string;
            };
            Returns: string;
          }
        | { Args: { column_name: string; table_name: string }; Returns: string };
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string;
              schema_name: string;
              table_name: string;
            };
            Returns: string;
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string };
      drying_weather_kick: { Args: never; Returns: undefined };
      effective_permissions: {
        Args: { _user_id: string };
        Returns: {
          allowed: boolean;
          expires_at: string;
          granted_by: string;
          label: string;
          location_id: string;
          override_id: string;
          perm_group: string;
          permission_key: string;
          reason: string;
          region_id: string;
          source: string;
          source_role: Database["public"]["Enums"]["app_role"];
        }[];
      };
      email_release_kick: { Args: never; Returns: undefined };
      enablelongtransactions: { Args: never; Returns: string };
      end_impersonation: { Args: never; Returns: boolean };
      enum_for_loss_type_key: { Args: { _k: string }; Returns: string };
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      escalate_incidents: { Args: never; Returns: Json };
      escalate_overdue_lead_approvals: { Args: never; Returns: number };
      estimate_catalog_item_costs: {
        Args: never;
        Returns: {
          default_cost: number;
          id: string;
        }[];
      };
      estimate_line_costs: {
        Args: { _estimate_id: string };
        Returns: {
          line_id: string;
          unit_cost: number;
        }[];
      };
      expense_threshold_for: { Args: { _user_id: string }; Returns: number };
      expire_stale_chase_claims: { Args: never; Returns: Json };
      expire_stale_dispatches: { Args: never; Returns: number };
      exposure_origin_address: {
        Args: { _incident_id: string };
        Returns: string;
      };
      field_ticket_crew_minutes: {
        Args: { _end: string; _start: string };
        Returns: number;
      };
      find_customer_duplicates: {
        Args: {
          _account_id?: string;
          _email?: string;
          _name?: string;
          _phone?: string;
        };
        Returns: {
          account_id: string;
          account_name: string;
          contact_id: string;
          email: string;
          full_name: string;
          match_reason: string;
          owning_location_code: string;
          owning_location_name: string;
          phone: string;
          title: string;
          viewer_has_full_access: boolean;
        }[];
      };
      fire_feed_kick: { Args: never; Returns: undefined };
      geometry: { Args: { "": string }; Returns: unknown };
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      geomfromewkt: { Args: { "": string }; Returns: unknown };
      get_active_impersonation: { Args: never; Returns: Json };
      get_user_scope: { Args: { _user_id: string }; Returns: Json };
      gettransactionid: { Args: never; Returns: unknown };
      gift_tag_name_for_policy: { Args: { _policy: string }; Returns: string };
      global_activity: {
        Args: {
          _actor?: string;
          _event_types?: string[];
          _from?: string;
          _limit?: number;
          _location?: string;
          _modules?: string[];
          _offset?: number;
          _record?: string;
          _search?: string;
          _to?: string;
        };
        Returns: {
          actor_id: string;
          actor_name: string;
          detail: Json;
          event_type: string;
          location_id: string;
          module: string;
          occurred_at: string;
          record_id: string;
          record_label: string;
          record_type: string;
          summary: string;
          via: string;
        }[];
      };
      goal_activity_actuals: {
        Args: { _from: string; _to: string; _users: string[] };
        Returns: {
          active_client_reach_outs: number;
          cold_calls: number;
          cold_emails: number;
          cold_leads_converted: number;
          fires_chased: number;
          new_deals_worked: number;
          user_id: string;
        }[];
      };
      graph_sync_kick: { Args: never; Returns: undefined };
      gsr_local_date: { Args: { _at: string }; Returns: string };
      has_any_role_text: {
        Args: { _roles: string[]; _user_id: string };
        Returns: boolean;
      };
      has_permission: {
        Args: { _key: string; _location_id?: string; _user_id: string };
        Returns: boolean;
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      has_role_text: {
        Args: { _role: string; _user_id: string };
        Returns: boolean;
      };
      hours_by_person_week: {
        Args: { _from: string; _to: string };
        Returns: {
          approved_minutes: number;
          full_name: string;
          minutes: number;
          user_id: string;
          week_start: string;
        }[];
      };
      incident_active_responders: {
        Args: { _incident_id: string };
        Returns: number;
      };
      incident_market_allowed: {
        Args: { _market_id: string; _user_id: string };
        Returns: boolean;
      };
      incident_rule: {
        Args: { _incident_id: string };
        Returns: {
          arrival_timeout_minutes: number;
          created_at: string;
          description: string | null;
          id: string;
          is_active: boolean;
          key: string;
          label: string;
          max_responders: number;
          sort_order: number;
          updated_at: string;
          zone_exclusive: boolean;
        };
        SetofOptions: {
          from: "*";
          to: "chase_assignment_rules";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      incident_tier_recipients: {
        Args: { _incident_id: string; _tier: number };
        Returns: {
          user_id: string;
        }[];
      };
      insurance_info_missing: {
        Args: { j: Database["public"]["Tables"]["jobs"]["Row"] };
        Returns: string[];
      };
      invoice_line_costs: {
        Args: { _invoice_id: string };
        Returns: {
          line_id: string;
          unit_cost: number;
        }[];
      };
      is_conversation_member: {
        Args: { _conv: string; _user: string };
        Returns: boolean;
      };
      is_employee: { Args: { _user_id: string }; Returns: boolean };
      is_lead_visible_to_field: {
        Args: { _lead_id: string; _user_id: string };
        Returns: boolean;
      };
      is_member_of: {
        Args: { _location_id: string; _user_id: string };
        Returns: boolean;
      };
      is_privileged: { Args: { _user_id: string }; Returns: boolean };
      is_regional_for: {
        Args: { _location_id: string; _user_id: string };
        Returns: boolean;
      };
      is_rep_only: { Args: { _user_id: string }; Returns: boolean };
      is_sales_lead: { Args: { _user_id: string }; Returns: boolean };
      is_sales_leadership: { Args: { _user_id: string }; Returns: boolean };
      is_staff_account: { Args: { _user_id: string }; Returns: boolean };
      job_automatic_task_candidates: {
        Args: { _only_seeded_groups: boolean };
        Returns: {
          description: string;
          due_date: string;
          group_key: string;
          job_id: string;
          kind: string;
          task_id: string;
          task_key: string;
          title: string;
        }[];
      };
      job_calculation_costs: {
        Args: { _calculation_id: string };
        Returns: {
          calculation_id: string;
          equipment_profit: number;
          internal_cost: number;
          overall_profit: number;
        }[];
      };
      job_checklist_scope: {
        Args: { _loss_type: string; _option_key: string; _option_label: string };
        Returns: string;
      };
      job_checklist_scope_of: { Args: { _value: string }; Returns: string };
      job_cost_breakdown: {
        Args: { _job_id: string };
        Returns: {
          direct_cost: number;
          equipment_cost: number;
          equipment_days: number;
          labour_cost: number;
          labour_minutes: number;
          margin: number;
          margin_pct: number;
          materials_cost: number;
          referral_cost: number;
          revenue: number;
          subcontractor_cost: number;
          total_cost: number;
          work_component: string;
        }[];
      };
      job_exposure_origin_address: {
        Args: { _job_id: string };
        Returns: string;
      };
      job_field_change_state: { Args: { _change_id: string }; Returns: Json };
      job_labour_summary: {
        Args: { _job_id: string };
        Returns: {
          approved_minutes: number;
          crew_days: number;
          days_on_site: number;
          headcount: number;
          labour_cost: number;
          total_minutes: number;
        }[];
      };
      job_ledger_cell_readable: {
        Args: { _cell_key: string; _job_id: string };
        Returns: boolean;
      };
      job_ledger_cell_writable: {
        Args: { _cell_key: string; _job_id: string };
        Returns: boolean;
      };
      job_person_hours: {
        Args: { _job_id: string };
        Returns: {
          cost: number;
          days: number;
          full_name: string;
          minutes: number;
          user_id: string;
        }[];
      };
      job_photo_day_counts: {
        Args: { _job_id: string; _tz?: string };
        Returns: {
          day: string;
          folder_id: string;
          n: number;
          source: string;
        }[];
      };
      job_profitability: {
        Args: { _job_id: string };
        Returns: {
          billed: number;
          collected: number;
          equipment_days: number;
          labour_cost: number;
          margin: number;
          margin_pct: number;
          total_minutes: number;
        }[];
      };
      job_referrer_commission: {
        Args: { _job_id: string; _revenue: number };
        Returns: {
          amount: number;
          kind: string;
          origin: string;
          value: number;
        }[];
      };
      job_revertable_fields: { Args: never; Returns: string[] };
      job_running_cost: {
        Args: { _job_id: string };
        Returns: {
          calculator_cost: number;
          commission_cost: number;
          equipment_cost: number;
          equipment_days: number;
          equipment_units: number;
          equipment_unpriced_units: number;
          expenses_cost: number;
          expenses_count: number;
          field_ticket_cost: number;
          field_ticket_equipment_cost: number;
          field_ticket_labour_cost: number;
          field_ticket_uncosted_minutes: number;
          field_tickets: number;
          field_tickets_unposted: number;
          labour_cost: number;
          labour_minutes: number;
          labour_uncosted_minutes: number;
          manual_cost: number;
          margin: number;
          margin_pct: number;
          materials_cost: number;
          referral_cost: number;
          referrer_commission_cost: number;
          revenue: number;
          revenue_basis: string;
          salesman_commission_cost: number;
          stock_used_cost: number;
          subcontractor_cost: number;
          total_cost: number;
        }[];
      };
      job_ticket_crew_hours: {
        Args: { _job_id: string };
        Returns: {
          cost: number;
          crew_chief_name: string;
          crew_class: string;
          headcount: number;
          minutes_each: number;
          note: string;
          office_minutes: number;
          problem: string;
          rate_missing: boolean;
          review_state: string;
          reviewed_at: string;
          ticket_headcount: number;
          ticket_id: string;
          ticket_minutes_each: number;
          total_minutes: number;
          work_date: string;
        }[];
      };
      jobs_scoped: {
        Args: { _ids?: string[] };
        Returns: {
          data: Json;
          id: string;
        }[];
      };
      kahi_sync_kick: { Args: never; Returns: undefined };
      latest_vehicle_positions: {
        Args: { _vehicle_ids: string[] };
        Returns: {
          lat: number;
          lon: number;
          occurred_at: string;
          vehicle_id: string;
        }[];
      };
      leaderboard_standings: {
        Args: { _from: string; _location_ids?: string[]; _to: string };
        Returns: {
          accounts_advanced: number;
          accounts_owned: number;
          active_client_reach_outs: number;
          activity_events: number;
          billed_value: number;
          cadence_health: number;
          calls_made: number;
          chase_acceptance: number;
          cold_calls: number;
          cold_emails: number;
          cold_leads_converted: number;
          collected_value: number;
          contracts_signed: number;
          fires_chased: number;
          full_name: string;
          incidents_accepted: number;
          incidents_dispatched: number;
          jobs_signed_cash: number;
          jobs_signed_insurance: number;
          jobs_signed_total: number;
          jobs_won: number;
          location_ids: string[];
          median_tta_minutes: number;
          meetings_held: number;
          money_visible: boolean;
          new_accounts: number;
          new_deals_worked: number;
          roles: Database["public"]["Enums"]["app_role"][];
          stage_advances: number;
          touchpoints: number;
          user_id: string;
        }[];
      };
      leads_require_approval: { Args: never; Returns: boolean };
      list_business_reps: {
        Args: never;
        Returns: {
          email: string;
          full_name: string;
          roles: Database["public"]["Enums"]["app_role"][];
          user_id: string;
        }[];
      };
      log_export: {
        Args: {
          _entity: string;
          _filters?: Json;
          _format?: string;
          _record_count: number;
          _surface: string;
        };
        Returns: string;
      };
      log_incident_outcome: {
        Args: {
          _incident_id: string;
          _note?: string;
          _reason_id: string;
          _revisit_after?: string;
          _sub_label?: string;
          _sub_reason_id?: string;
          _worth_another_try?: boolean;
        };
        Returns: Json;
      };
      log_photo_view: { Args: { _photo_id: string }; Returns: undefined };
      longtransactionsenabled: { Args: never; Returns: boolean };
      loss_type_key_for_enum: { Args: { _v: string }; Returns: string };
      mask_past_lead_address: { Args: { _addr: string }; Returns: string };
      match_incidents_to_fire_leads: {
        Args: never;
        Returns: {
          matched_count: number;
        }[];
      };
      move_account_back_to_pipeline: {
        Args: { _account_id: string; _reason: string; _stage_id: string };
        Returns: undefined;
      };
      my_chase_jobs: {
        Args: never;
        Returns: {
          address: string;
          commission_amount: number;
          commission_at: string;
          commission_state: string;
          days_in_stage: number;
          job_id: string;
          job_number: string;
          open_tasks: number;
          stage_name: string;
        }[];
      };
      my_chase_region: { Args: never; Returns: string };
      my_commission_summary: {
        Args: { _from: string; _to: string };
        Returns: {
          commission_paid: number;
          last_issued_on: string;
          pending_count: number;
          salary_paid: number;
        }[];
      };
      my_commission_tiers: {
        Args: never;
        Returns: {
          key: string;
          label: string;
          min_amount: number;
          rate_percent: number;
          sort_order: number;
          work_component: string;
        }[];
      };
      my_past_lead_summary: {
        Args: { _id: string };
        Returns: {
          accepted_at: string;
          address: string;
          arrived_at: string;
          id: string;
          incident_type: string;
          is_masked: boolean;
          lifecycle: Database["public"]["Enums"]["incident_lifecycle"];
          locality: string;
          my_attempts: Json;
          outcome: Database["public"]["Enums"]["incident_outcome"];
          postal_code: string;
          reported_at: string;
        }[];
      };
      my_standing_intake_link: { Args: never; Returns: string };
      my_visible_location_ids: { Args: never; Returns: string[] };
      nearest_location: {
        Args: { _lat: number; _lon: number; _max_miles?: number };
        Returns: string;
      };
      needs_you_today: {
        Args: { _all?: boolean; _user_id: string };
        Returns: {
          account_id: string;
          account_name: string;
          action: string;
          due_at: string;
          entity_id: string;
          item_key: string;
          kind: string;
          subtitle: string;
          title: string;
        }[];
      };
      network_membership_progress: {
        Args: { _membership_id: string };
        Returns: {
          complete: number;
          next_expiry: string;
          total: number;
          worst: string;
        }[];
      };
      next_job_number: { Args: never; Returns: string };
      normalize_address: { Args: { _addr: string }; Returns: string };
      notify_lead_approvers: {
        Args: { _account_id: string; _body: string; _title: string };
        Returns: undefined;
      };
      on_duty_chasers: {
        Args: { _location_id: string };
        Returns: {
          started_at: string;
          user_id: string;
        }[];
      };
      onboarding_add_requirement: {
        Args: {
          _account_id: string;
          _is_demo: boolean;
          _required_value: string;
          _type: string;
          _wording: string;
        };
        Returns: string;
      };
      onboarding_add_task: {
        Args: {
          _account_id: string;
          _assignee: string;
          _description: string;
          _due_in_days: number;
          _is_demo: boolean;
          _key: string;
          _location_id: string;
          _title: string;
        };
        Returns: string;
      };
      onboarding_answer_true: {
        Args: { _ans: Json; _key: string };
        Returns: boolean;
      };
      peek_rate_limit: {
        Args: {
          p_bucket: string;
          p_identity: string;
          p_limit: number;
          p_window_seconds: number;
        };
        Returns: {
          allowed: boolean;
          attempt_count: number;
          retry_after_seconds: number;
        }[];
      };
      person_accounts: {
        Args: { _user_id: string };
        Returns: {
          days_since_touch: number;
          id: string;
          last_touch: string;
          location_id: string;
          name: string;
          overdue: boolean;
          stage: string;
          status: Database["public"]["Enums"]["account_status"];
        }[];
      };
      person_chase: {
        Args: { _from: string; _to: string; _user_id: string };
        Returns: {
          accepted_at: string;
          address: string;
          arrived_at: string;
          id: string;
          job_id: string;
          outcome: Database["public"]["Enums"]["incident_outcome"];
          tta_minutes: number;
        }[];
      };
      person_jobs: {
        Args: { _from: string; _to: string; _user_id: string };
        Returns: {
          account_id: string;
          account_name: string;
          address: string;
          billed_amount: number;
          collected_amount: number;
          created_at: string;
          estimated_amount: number;
          id: string;
          job_name: string;
          job_number: string;
          loss_type: string;
          status: Database["public"]["Enums"]["job_status"];
        }[];
      };
      person_stalled: {
        Args: { _user_id: string };
        Returns: {
          days_stale: number;
          id: string;
          location_id: string;
          notified_at: string;
          record_id: string;
          record_label: string;
          record_status: string;
          record_type: Database["public"]["Enums"]["escalation_record_type"];
          step: number;
        }[];
      };
      person_timeline: {
        Args: { _from: string; _limit?: number; _to: string; _user_id: string };
        Returns: {
          detail: string;
          entity_id: string;
          entity_type: string;
          kind: string;
          link_id: string;
          occurred_at: string;
          title: string;
        }[];
      };
      pipeline_activate_client: {
        Args: { _account_id: string; _green_light_date?: string };
        Returns: undefined;
      };
      pipeline_apply_onboarding: {
        Args: { _account_id: string; _answers: Json };
        Returns: Json;
      };
      pipeline_cards_minimal: {
        Args: never;
        Returns: {
          account_id: string;
          account_name: string;
          owning_location_code: string;
          owning_location_id: string;
          owning_location_name: string;
          stage_id: string;
          stage_name: string;
        }[];
      };
      account_in_critical: { Args: { _account_id: string }; Returns: boolean };
      client_critical_decide: {
        Args: {
          _episode_id: string;
          _decision: string;
          _note?: string;
          _reassign_to?: string;
          _retry_months?: number;
        };
        Returns: string;
      };
      is_sales_manager: { Args: { _user_id: string }; Returns: boolean };
      followup_rule_settings: {
        Args: never;
        Returns: { starts_at: string; call_min_seconds: number }[];
      };
      rep_self_cleared_shares: {
        Args: never;
        Returns: {
          user_id: string;
          full_name: string;
          cleared: number;
          self_cleared: number;
        }[];
      };
      job_credit_snapshot: {
        Args: { _account_id: string };
        Returns: { rep: string; stage_key: string; requires_approval: boolean }[];
      };
      rep_critical_caps: {
        Args: never;
        Returns: {
          user_id: string;
          full_name: string;
          clients: number;
          critical: number;
          over_cap: boolean;
        }[];
      };
      rep_critical_share: {
        Args: { _user_id: string };
        Returns: { clients: number; critical: number; over_cap: boolean }[];
      };
      pipeline_ghost_manual: {
        Args: { _account_id: string; _reason?: string };
        Returns: undefined;
      };
      pipeline_ghost_sweep: { Args: never; Returns: number };
      pipeline_manual_ghost_signal: {
        Args: { _days?: number; _min_attempts?: number };
        Returns: {
          avg_attempts: number;
          last_ghost_at: string;
          low_effort_ghosts: number;
          low_effort_share: number;
          manual_ghosts: number;
          user_id: string;
        }[];
      };
      pipeline_mark_no_service: {
        Args: {
          _account_id: string;
          _reason?: string;
          _reason_code?: string;
          _retry_months?: number;
        };
        Returns: string;
      };
      pipeline_no_service_return_sweep: { Args: never; Returns: number };
      pipeline_outreach_stats: {
        Args: { _account_id: string; _since: string };
        Returns: {
          attempt_days: number;
          attempts: number;
          last_reply_at: string;
          last_task_done_at: string;
          last_touch_at: string;
          methods: string[];
          replied: boolean;
        }[];
      };
      pipeline_rule_settings: { Args: never; Returns: Json };
      pipeline_snooze_ghost: {
        Args: { _account_id: string; _days?: number };
        Returns: string;
      };
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string };
      portal_accept_invitation: {
        Args: { _token_hash: string; _user_id: string };
        Returns: string;
      };
      portal_file_refs: {
        Args: { _ids: string[]; _kind: string; _size?: string };
        Returns: {
          bucket: string;
          id: string;
          mime: string;
          name: string;
          path: string;
        }[];
      };
      portal_invitation_lookup: {
        Args: { _token_hash: string };
        Returns: {
          display_name: string;
          email: string;
          expires_at: string;
          portal_customer_id: string;
          status: string;
          user_id: string;
        }[];
      };
      portal_invite: {
        Args: {
          _account_id?: string;
          _contact_id: string;
          _email?: string;
          _job_id?: string;
          _token_hash: string;
          _valid_hours?: number;
        };
        Returns: {
          email: string;
          expires_at: string;
          invitation_id: string;
          portal_customer_id: string;
        }[];
      };
      portal_invoice: { Args: { _invoice_id: string }; Returns: Json };
      portal_job: { Args: { _job_id: string }; Returns: Json };
      portal_job_candidates: {
        Args: { _job_id: string };
        Returns: {
          contact_id: string;
          disabled: boolean;
          email: string;
          full_name: string;
          invite_expires_at: string;
          invite_live: boolean;
          invite_used_at: string;
          portal_customer_id: string;
          portal_email: string;
          relation: string;
          share_id: string;
          signed_up: boolean;
        }[];
      };
      portal_my_jobs: {
        Args: never;
        Returns: {
          address: string;
          documents: number;
          invoices: number;
          job_id: string;
          job_number: string;
          locality: string;
          photo_sets: number;
          region: string;
          shared_at: string;
        }[];
      };
      portal_photos: {
        Args: { _item_id: string; _job_id: string; _kind: string };
        Returns: {
          photo_id: string;
        }[];
      };
      portal_set_customer_disabled: {
        Args: { _disabled: boolean; _portal_customer_id: string };
        Returns: undefined;
      };
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string };
        Returns: number;
      };
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string };
        Returns: number;
      };
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string };
        Returns: string;
      };
      postgis_extensions_upgrade: { Args: never; Returns: string };
      postgis_full_version: { Args: never; Returns: string };
      postgis_geos_version: { Args: never; Returns: string };
      postgis_lib_build_date: { Args: never; Returns: string };
      postgis_lib_revision: { Args: never; Returns: string };
      postgis_lib_version: { Args: never; Returns: string };
      postgis_libjson_version: { Args: never; Returns: string };
      postgis_liblwgeom_version: { Args: never; Returns: string };
      postgis_libprotobuf_version: { Args: never; Returns: string };
      postgis_libxml_version: { Args: never; Returns: string };
      postgis_proj_version: { Args: never; Returns: string };
      postgis_scripts_build_date: { Args: never; Returns: string };
      postgis_scripts_installed: { Args: never; Returns: string };
      postgis_scripts_released: { Args: never; Returns: string };
      postgis_svn_version: { Args: never; Returns: string };
      postgis_type_name: {
        Args: {
          coord_dimension: number;
          geomname: string;
          use_new_name?: boolean;
        };
        Returns: string;
      };
      postgis_version: { Args: never; Returns: string };
      postgis_wagyu_version: { Args: never; Returns: string };
      prior_jobs_at_address: {
        Args: {
          _address: string;
          _exclude_job?: string;
          _lat?: number;
          _lon?: number;
        };
        Returns: {
          account_id: string;
          account_name: string;
          address: string;
          customer_kind: string;
          customer_name: string;
          job_date: string;
          job_id: string;
          job_number: string;
          loss_type: string;
          matched_by: string;
          owning_location_code: string;
          owning_location_id: string;
          owning_location_name: string;
          primary_contact_id: string;
          primary_contact_name: string;
          viewer_has_full_access: boolean;
        }[];
      };
      promote_todo_item: {
        Args: { _due_date?: string; _task_id: string; _todo_id: string };
        Returns: string;
      };
      prune_telemetry: {
        Args: { _keep_days?: number };
        Returns: {
          deleted: number;
          table_name: string;
        }[];
      };
      purge_demo_data: {
        Args: never;
        Returns: {
          deleted_count: number;
          table_name: string;
        }[];
      };
      rate_for: { Args: { _on: string; _user_id: string }; Returns: number };
      raven_sync_kick: { Args: { _mode?: string }; Returns: undefined };
      reassign_book_atomically: {
        Args: {
          _account_ids: string[];
          _do_differently?: string;
          _from_user_id: string;
          _move_tasks?: boolean;
          _reason: Database["public"]["Enums"]["reassignment_reason"];
          _reason_note?: string;
          _to_user_id: string;
        };
        Returns: Json;
      };
      recompute_all_commissions: { Args: never; Returns: number };
      record_activity: {
        Args: {
          _limit?: number;
          _offset?: number;
          _record_id: string;
          _record_type: string;
          _search?: string;
        };
        Returns: {
          actor_id: string;
          actor_name: string;
          detail: Json;
          event_type: string;
          location_id: string;
          module: string;
          occurred_at: string;
          record_id: string;
          record_label: string;
          record_type: string;
          summary: string;
          via: string;
        }[];
      };
      record_google_review_click: { Args: { _token: string }; Returns: string };
      record_history_covers: { Args: { _table: string }; Returns: boolean };
      record_history_display: {
        Args: { _image: Json; _table: string };
        Returns: Json;
      };
      record_history_display_value: {
        Args: { _column: string; _value: Json };
        Returns: Json;
      };
      record_history_id_type: { Args: { _table: string }; Returns: string };
      record_history_may_restore: {
        Args: {
          _op: string;
          _reverted: Json;
          _row: Json;
          _table: string;
          _uid: string;
        };
        Returns: boolean;
      };
      record_history_preview: { Args: { _history_id: string }; Returns: Json };
      record_history_reinsert: {
        Args: { _image: Json; _table: string };
        Returns: undefined;
      };
      record_history_state: {
        Args: {
          _h: Database["public"]["Tables"]["record_history"]["Row"];
          _uid: string;
        };
        Returns: Json;
      };
      record_last_movement: {
        Args: {
          _id: string;
          _type: Database["public"]["Enums"]["escalation_record_type"];
        };
        Returns: string;
      };
      recurrence_occurrences: {
        Args: { _freq: string; _from: string; _to: string };
        Returns: number;
      };
      reject_supply_receipt: {
        Args: { _reason: string; _receipt_id: string };
        Returns: undefined;
      };
      release_expired_claims: { Args: never; Returns: number };
      release_incident_claim: {
        Args: { _incident_id: string; _reason?: string };
        Returns: Json;
      };
      release_stale_incident_locks: { Args: never; Returns: number };
      rep_profitability: {
        Args: { _from: string; _location_id?: string; _to: string };
        Returns: {
          collected: number;
          commission_cost: number;
          expense_cost: number;
          full_name: string;
          job_count: number;
          net_contribution: number;
          revenue: number;
          salary_cost: number;
          total_rep_cost: number;
          user_id: string;
        }[];
      };
      replace_user_permission: {
        Args: {
          _effect: string;
          _expires_at?: string;
          _key: string;
          _location_id?: string;
          _reason?: string;
          _region_id?: string;
          _user_id: string;
        };
        Returns: string;
      };
      request_backup: { Args: { _incident_id: string }; Returns: undefined };
      reset_layout_overrides: {
        Args: { _role_key: string; _scope: string };
        Returns: number;
      };
      reset_rate_limit: {
        Args: { p_bucket: string; p_identity: string };
        Returns: undefined;
      };
      resolve_billing_location: {
        Args: { _lat?: number; _lon?: number; _region: string };
        Returns: string;
      };
      resolve_escalation_target: {
        Args: {
          _kind: Database["public"]["Enums"]["escalation_target_kind"];
          _location_id: string;
          _named: string;
          _owner: string;
          _record_id: string;
          _record_type: Database["public"]["Enums"]["escalation_record_type"];
        };
        Returns: string;
      };
      resolve_zone: {
        Args: { _postal_code: string };
        Returns: {
          market_id: string;
          zone_id: string;
        }[];
      };
      restore_record_history: { Args: { _history_id: string }; Returns: Json };
      revert_job_field_change: { Args: { _change_id: string }; Returns: Json };
      revoke_user_sessions: { Args: { _user_id: string }; Returns: number };
      rotate_my_standing_intake_link: { Args: never; Returns: string };
      run_compliance_alerts: {
        Args: never;
        Returns: {
          notified: number;
          tagged: number;
        }[];
      };
      run_credential_expiry_alerts: { Args: never; Returns: number };
      run_document_signature_reminders: { Args: never; Returns: number };
      run_escalation_scan: {
        Args: never;
        Returns: {
          raised: number;
          resolved: number;
        }[];
      };
      run_vehicle_due_alerts: { Args: never; Returns: number };
      running_cost_overview: {
        Args: { _limit?: number; _location_id?: string };
        Returns: {
          active_jobs: number;
          company_cost: number;
          company_revenue: number;
          job_id: string;
          job_number: string;
          location_id: string;
          margin: number;
          margin_pct: number;
          revenue: number;
          status: string;
          title: string;
          total_cost: number;
        }[];
      };
      sales_director_rep_deals: {
        Args: { _stale_days?: number; _user_id: string };
        Returns: {
          account_id: string;
          lost_reason: string;
          name: string;
          stage: string;
          stage_changed_at: string;
          status: string;
        }[];
      };
      sales_director_reps: {
        Args: { _from: string; _to: string };
        Returns: {
          active_client_reach_outs: number;
          active_client_reach_outs_target: number;
          appointments: number;
          appointments_target: number;
          calls: number;
          calls_target: number;
          cold_calls: number;
          cold_calls_target: number;
          cold_emails: number;
          cold_emails_target: number;
          cold_leads_converted: number;
          cold_leads_converted_target: number;
          fires_chased: number;
          fires_chased_target: number;
          full_name: string;
          jobs_target: number;
          jobs_won: number;
          location_id: string;
          new_deals_worked: number;
          new_deals_worked_target: number;
          revenue: number;
          revenue_target: number;
          user_id: string;
        }[];
      };
      sales_rep_metrics: {
        Args: { _from: string; _to: string };
        Returns: {
          accounts_closed: number;
          calls_made: number;
          full_name: string;
          jobs_signed_cash: number;
          jobs_signed_insurance: number;
          meetings_held: number;
          proposals_sent: number;
          stage_advances: number;
          user_id: string;
        }[];
      };
      save_supply_receipt_draft: {
        Args: { _parsed: Json; _receipt_id: string };
        Returns: string;
      };
      scorecard_account_client_since: {
        Args: { _account_id: string };
        Returns: string;
      };
      scorecard_action_counts: {
        Args: {
          _from: string;
          _keys: string[];
          _location_ids?: string[];
          _to: string;
        };
        Returns: {
          key: string;
          user_id: string;
          value: number;
        }[];
      };
      scorecard_count_outreach: {
        Args: {
          _audience: string;
          _ca_channels: string[];
          _from: string;
          _outbound: boolean;
          _people: string[];
          _to: string;
          _tp_types: string[];
        };
        Returns: {
          n: number;
          user_id: string;
        }[];
      };
      scorecard_count_stage_moves: {
        Args: {
          _from: string;
          _from_keys: string[];
          _people: string[];
          _to: string;
          _to_keys: string[];
        };
        Returns: {
          n: number;
          user_id: string;
        }[];
      };
      scorecard_identity: { Args: never; Returns: Json };
      scorecard_metrics: {
        Args: { _from: string; _to: string; _user_id?: string };
        Returns: {
          accounts_advanced: number;
          accounts_overdue: number;
          accounts_owned: number;
          activity_events: number;
          attempts_call: number;
          attempts_door: number;
          attempts_email: number;
          attempts_sms: number;
          billed_value: number;
          cadence_health: number;
          chase_acceptance: number;
          collected_value: number;
          contact_attempts: number;
          contracts_signed: number;
          email: string;
          full_name: string;
          gifts_sent: number;
          incidents_accepted: number;
          incidents_dispatched: number;
          jobs_won: number;
          location_ids: string[];
          median_tta_minutes: number;
          meetings_booked: number;
          meetings_held: number;
          meetings_logged: number;
          roles: Database["public"]["Enums"]["app_role"][];
          touchpoints: number;
          user_id: string;
        }[];
      };
      scorecard_metrics_raw: {
        Args: { _from: string; _to: string; _users: string[] };
        Returns: {
          accounts_advanced: number;
          billed_value: number;
          cadence_health: number;
          chase_acceptance: number;
          contact_attempts: number;
          jobs_won: number;
          median_tta_minutes: number;
          meetings_held: number;
          touchpoints: number;
        }[];
      };
      scorecard_money_visible: { Args: never; Returns: boolean };
      scorecard_people: {
        Args: never;
        Returns: {
          email: string;
          full_name: string;
          location_ids: string[];
          roles: Database["public"]["Enums"]["app_role"][];
          user_id: string;
        }[];
      };
      scorecard_team_medians: {
        Args: { _from: string; _location_id?: string; _to: string };
        Returns: {
          accounts_advanced: number;
          billed_value: number;
          cadence_health: number;
          chase_acceptance: number;
          cohort_size: number;
          contact_attempts: number;
          jobs_won: number;
          median_tta_minutes: number;
          meetings_held: number;
          touchpoints: number;
        }[];
      };
      search_accounts_minimal: {
        Args: { _query: string };
        Returns: {
          account_id: string;
          account_name: string;
          owning_location_code: string;
          owning_location_id: string;
          owning_location_name: string;
          primary_contact_name: string;
          status: Database["public"]["Enums"]["account_status"];
          viewer_has_full_access: boolean;
          what_they_do: string[];
        }[];
      };
      search_chase_incidents: {
        Args: { _q: string };
        Returns: {
          address: string;
          id: string;
          incident_type: Database["public"]["Enums"]["incident_type"];
          is_mine: boolean;
          lifecycle: Database["public"]["Enums"]["incident_lifecycle"];
          locality: string;
          postal_code: string;
          reported_at: string;
        }[];
      };
      search_customers_minimal: {
        Args: { _query: string };
        Returns: {
          account_id: string;
          account_name: string;
          account_type: string;
          email: string;
          id: string;
          kind: string;
          name: string;
          owner_contact_name: string;
          owning_location_code: string;
          owning_location_id: string;
          owning_location_name: string;
          phone: string;
          status: string;
          title: string;
          viewer_has_full_access: boolean;
        }[];
      };
      search_my_past_leads: {
        Args: { _q: string; _type?: string };
        Returns: {
          accepted_at: string;
          address: string;
          arrived_at: string;
          attempt_count: number;
          id: string;
          incident_type: string;
          is_masked: boolean;
          lifecycle: Database["public"]["Enums"]["incident_lifecycle"];
          locality: string;
          outcome: Database["public"]["Enums"]["incident_outcome"];
          postal_code: string;
          reported_at: string;
          status_code: string;
        }[];
      };
      seed_demo_addresses: {
        Args: never;
        Returns: {
          inserted_count: number;
          table_name: string;
        }[];
      };
      seed_demo_data: {
        Args: never;
        Returns: {
          inserted_count: number;
          table_name: string;
        }[];
      };
      seed_demo_extras: {
        Args: never;
        Returns: {
          inserted_count: number;
          table_name: string;
        }[];
      };
      seed_demo_jobs: {
        Args: never;
        Returns: {
          inserted_count: number;
          table_name: string;
        }[];
      };
      seed_demo_pipelines: {
        Args: never;
        Returns: {
          inserted_count: number;
          table_name: string;
        }[];
      };
      seed_demo_visits: {
        Args: never;
        Returns: {
          inserted_count: number;
          table_name: string;
        }[];
      };
      set_person_employment: {
        Args: { _user_id: string; _stage?: string; _started_on?: string };
        Returns: undefined;
      };
      set_commission_payout_status: {
        Args: { _id: string; _status: string };
        Returns: {
          amount: number;
          approved_at: string | null;
          approved_by: string | null;
          basis: string | null;
          basis_amount: number | null;
          created_at: string;
          created_by: string | null;
          expected_pay_date: string | null;
          id: string;
          is_demo: boolean;
          issued_on: string | null;
          job_id: string | null;
          kind: string;
          location_id: string;
          note: string | null;
          paid_at: string | null;
          period_end: string;
          period_start: string;
          rate_percent: number | null;
          source: string;
          split_percent: number;
          status: string;
          tier_key: string | null;
          updated_at: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "commission_payouts";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      set_goal_why: {
        Args: { _goal_id: string; _why: string };
        Returns: undefined;
      };
      show_limit: { Args: never; Returns: number };
      show_trgm: { Args: { "": string }; Returns: string[] };
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown };
            Returns: number;
          };
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number };
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number };
        Returns: string;
      };
      st_asewkt: { Args: { "": string }; Returns: string };
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number };
            Returns: string;
          }
        | {
            Args: {
              geom_column?: string;
              maxdecimaldigits?: number;
              pretty_bool?: boolean;
              r: Record<string, unknown>;
            };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string };
      st_asgml:
        | {
            Args: {
              geog: unknown;
              id?: string;
              maxdecimaldigits?: number;
              nprefix?: string;
              options?: number;
            };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown;
              id?: string;
              maxdecimaldigits?: number;
              nprefix?: string;
              options?: number;
              version: number;
            };
            Returns: string;
          }
        | {
            Args: {
              geom: unknown;
              id?: string;
              maxdecimaldigits?: number;
              nprefix?: string;
              options?: number;
              version: number;
            };
            Returns: string;
          };
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string };
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string };
        Returns: string;
      };
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string };
      st_asmvtgeom: {
        Args: {
          bounds: unknown;
          buffer?: number;
          clip_geom?: boolean;
          extent?: number;
          geom: unknown;
        };
        Returns: unknown;
      };
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number };
            Returns: string;
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number };
            Returns: string;
          }
        | { Args: { "": string }; Returns: string };
      st_astext: { Args: { "": string }; Returns: string };
      st_astwkb:
        | {
            Args: {
              geom: unknown;
              prec?: number;
              prec_m?: number;
              prec_z?: number;
              with_boxes?: boolean;
              with_sizes?: boolean;
            };
            Returns: string;
          }
        | {
            Args: {
              geom: unknown[];
              ids: number[];
              prec?: number;
              prec_m?: number;
              prec_z?: number;
              with_boxes?: boolean;
              with_sizes?: boolean;
            };
            Returns: string;
          };
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number };
        Returns: string;
      };
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number };
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown };
        Returns: unknown;
      };
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number };
            Returns: unknown;
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number };
            Returns: unknown;
          };
      st_centroid: { Args: { "": string }; Returns: unknown };
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown };
        Returns: unknown;
      };
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown };
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean;
          param_geom: unknown;
          param_pctconvex: number;
        };
        Returns: unknown;
      };
      st_contains: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_coorddim: { Args: { geometry: unknown }; Returns: number };
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number };
        Returns: unknown;
      };
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number };
        Returns: unknown;
      };
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean };
            Returns: number;
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number };
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number };
            Returns: number;
          };
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_dwithin: {
        Args: {
          geog1: unknown;
          geog2: unknown;
          tolerance: number;
          use_spheroid?: boolean;
        };
        Returns: boolean;
      };
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number };
            Returns: unknown;
          }
        | {
            Args: {
              dm?: number;
              dx: number;
              dy: number;
              dz?: number;
              geom: unknown;
            };
            Returns: unknown;
          };
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown };
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number };
        Returns: unknown;
      };
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number };
        Returns: unknown;
      };
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number };
        Returns: unknown;
      };
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number };
            Returns: unknown;
          };
      st_geogfromtext: { Args: { "": string }; Returns: unknown };
      st_geographyfromtext: { Args: { "": string }; Returns: unknown };
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string };
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown };
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean;
          g: unknown;
          max_iter?: number;
          tolerance?: number;
        };
        Returns: unknown;
      };
      st_geometryfromtext: { Args: { "": string }; Returns: unknown };
      st_geomfromewkt: { Args: { "": string }; Returns: unknown };
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown };
      st_geomfromgml: { Args: { "": string }; Returns: unknown };
      st_geomfromkml: { Args: { "": string }; Returns: unknown };
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown };
      st_geomfromtext: { Args: { "": string }; Returns: unknown };
      st_gmltosql: { Args: { "": string }; Returns: unknown };
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean };
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number };
        Returns: unknown;
      };
      st_hexagongrid: {
        Args: { bounds: unknown; size: number };
        Returns: Record<string, unknown>[];
      };
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown };
        Returns: number;
      };
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number };
        Returns: unknown;
      };
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown };
        Returns: Database["public"]["CompositeTypes"]["valid_detail"];
        SetofOptions: {
          from: "*";
          to: "valid_detail";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number };
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown };
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown };
        Returns: number;
      };
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string };
        Returns: unknown;
      };
      st_linefromtext: { Args: { "": string }; Returns: unknown };
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown };
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number };
        Returns: unknown;
      };
      st_locatebetween: {
        Args: {
          frommeasure: number;
          geometry: unknown;
          leftrightoffset?: number;
          tomeasure: number;
        };
        Returns: unknown;
      };
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number };
        Returns: unknown;
      };
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_makevalid: {
        Args: { geom: unknown; params: string };
        Returns: unknown;
      };
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: number;
      };
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number };
        Returns: unknown;
      };
      st_mlinefromtext: { Args: { "": string }; Returns: unknown };
      st_mpointfromtext: { Args: { "": string }; Returns: unknown };
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown };
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown };
      st_multipointfromtext: { Args: { "": string }; Returns: unknown };
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown };
      st_node: { Args: { g: unknown }; Returns: unknown };
      st_normalize: { Args: { geom: unknown }; Returns: unknown };
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string };
        Returns: unknown;
      };
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: boolean;
      };
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean };
        Returns: number;
      };
      st_pointfromtext: { Args: { "": string }; Returns: unknown };
      st_pointm: {
        Args: {
          mcoordinate: number;
          srid?: number;
          xcoordinate: number;
          ycoordinate: number;
        };
        Returns: unknown;
      };
      st_pointz: {
        Args: {
          srid?: number;
          xcoordinate: number;
          ycoordinate: number;
          zcoordinate: number;
        };
        Returns: unknown;
      };
      st_pointzm: {
        Args: {
          mcoordinate: number;
          srid?: number;
          xcoordinate: number;
          ycoordinate: number;
          zcoordinate: number;
        };
        Returns: unknown;
      };
      st_polyfromtext: { Args: { "": string }; Returns: unknown };
      st_polygonfromtext: { Args: { "": string }; Returns: unknown };
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown };
        Returns: unknown;
      };
      st_quantizecoordinates: {
        Args: {
          g: unknown;
          prec_m?: number;
          prec_x: number;
          prec_y?: number;
          prec_z?: number;
        };
        Returns: unknown;
      };
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number };
        Returns: unknown;
      };
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string };
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number };
        Returns: unknown;
      };
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown };
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number };
        Returns: unknown;
      };
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown };
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number };
        Returns: unknown;
      };
      st_squaregrid: {
        Args: { bounds: unknown; size: number };
        Returns: Record<string, unknown>[];
      };
      st_srid:
        { Args: { geog: unknown }; Returns: number } | { Args: { geom: unknown }; Returns: number };
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number };
        Returns: unknown[];
      };
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown };
        Returns: unknown;
      };
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number };
        Returns: unknown;
      };
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown };
        Returns: unknown;
      };
      st_tileenvelope: {
        Args: {
          bounds?: unknown;
          margin?: number;
          x: number;
          y: number;
          zoom: number;
        };
        Returns: unknown;
      };
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string };
            Returns: unknown;
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number };
            Returns: unknown;
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown };
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown };
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number };
            Returns: unknown;
          };
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number };
        Returns: unknown;
      };
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean };
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown };
      st_wkttosql: { Args: { "": string }; Returns: unknown };
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number };
        Returns: unknown;
      };
      staff_emails: {
        Args: { _user_ids: string[] };
        Returns: {
          email: string;
          full_name: string;
          user_id: string;
        }[];
      };
      staff_user_ids: { Args: never; Returns: string[] };
      stage_advance_evaluate: { Args: { _account_id: string }; Returns: string };
      stage_advance_sweep: { Args: never; Returns: number };
      stage_condition_label: { Args: { _cond: Json }; Returns: string };
      stage_condition_met: {
        Args: { _account_id: string; _cond: Json; _since: string };
        Returns: boolean;
      };
      stamp_arrival_from_action: {
        Args: {
          _accuracy_m?: number;
          _action: string;
          _incident_id: string;
          _lat?: number;
          _lon?: number;
        };
        Returns: boolean;
      };
      stamp_arrival_proximity: {
        Args: {
          _accuracy_m?: number;
          _incident_id: string;
          _lat: number;
          _lon: number;
        };
        Returns: boolean;
      };
      start_impersonation: {
        Args: {
          _preview_role: Database["public"]["Enums"]["app_role"];
          _target_user_id: string;
        };
        Returns: string;
      };
      submit_public_intake_atomic: {
        Args: { _request_id: string; _submission: Json; _token: string };
        Returns: string;
      };
      sweep_insurance_info_tasks: { Args: never; Returns: number };
      sync_insurance_info_task: {
        Args: { _job_id: string };
        Returns: undefined;
      };
      sync_job_automatic_tasks: {
        Args: { _dry_run?: boolean; _only_seeded_groups?: boolean };
        Returns: Json;
      };
      touchpoint_activity_days: {
        Args: { _since: string; _time_zone?: string };
        Returns: {
          created_by: string;
          day: string;
        }[];
      };
      touchpoint_method: {
        Args: { _type: Database["public"]["Enums"]["touchpoint_type"] };
        Returns: string;
      };
      tradeshow_roi: {
        Args: never;
        Returns: {
          accounts_created: number;
          billed_value: number;
          cost: number;
          jobs_won: number;
          leads_captured: number;
          name: string;
          starts_on: string;
          tradeshow_id: string;
        }[];
      };
      undo_exposure_incident: {
        Args: { _incident_id: string };
        Returns: boolean;
      };
      undo_stage_auto_advance: {
        Args: { _advance_id: string };
        Returns: boolean;
      };
      unlinked_carrier_names: {
        Args: never;
        Returns: {
          carrier_name: string;
          job_count: number;
        }[];
      };
      unlockrows: { Args: { "": string }; Returns: number };
      updategeometrysrid: {
        Args: {
          catalogn_name: string;
          column_name: string;
          new_srid_in: number;
          schema_name: string;
          table_name: string;
        };
        Returns: string;
      };
      user_market: { Args: { _user_id: string }; Returns: string };
      vehicle_document_vehicle_id: { Args: { _path: string }; Returns: string };
      views_missing_security_invoker: {
        Args: never;
        Returns: {
          view_name: string;
        }[];
      };
      visible_fields: {
        Args: { _entity?: string; _user_id: string };
        Returns: string[];
      };
    };
    Enums: {
      account_status: "prospect" | "onboarding" | "active" | "dormant" | "lost";
      account_type: "property_management" | "commercial" | "residential" | "other";
      app_role:
        | "admin"
        | "office"
        | "field"
        | "regional"
        | "owner"
        | "location_manager"
        | "sales_manager"
        | "sales_rep"
        | "field_chaser"
        | "crew"
        | "dev"
        | "sales_person"
        | "cold_caller"
        | "outside_sales_rep"
        | "sales_head";
      attachment_kind: "image" | "audio" | "video" | "file";
      automation_action_kind:
        | "create_task"
        | "assign_task"
        | "set_due_date"
        | "notify"
        | "move_stage"
        | "apply_flag"
        | "escalate"
        | "send_email";
      automation_trigger:
        | "stage_enter"
        | "stage_leave"
        | "stage_rot"
        | "task_past_due"
        | "no_activity"
        | "date_reached"
        | "deal_created"
        | "deal_won"
        | "deal_lost"
        | "job_stage_age";
      capture_source:
        "dialer" | "mailbox" | "calendar" | "sms" | "voice_note" | "manual" | "gift_engine";
      certificate_send_status: "queued" | "sent" | "failed";
      chase_event_type:
        | "created"
        | "dispatched"
        | "accepted"
        | "declined"
        | "arrived"
        | "outcome_logged"
        | "converted"
        | "escalated"
        | "matched_hpd"
        | "discarded";
      comm_direction: "outbound" | "inbound" | "not_applicable";
      contact_channel: "call" | "sms" | "email" | "door" | "other";
      contact_decision_role: "decision_maker" | "regional_manager" | "influencer" | "gatekeeper";
      conversation_kind: "direct" | "group";
      dispatch_response:
        "pending" | "accepted" | "declined" | "declined_race" | "no_response" | "no_action";
      document_event_type:
        | "generated"
        | "sent"
        | "viewed"
        | "signed"
        | "declined"
        | "voided"
        | "reminded"
        | "downloaded"
        | "hash_mismatch";
      document_status:
        | "draft"
        | "pending_signature"
        | "signed"
        | "active"
        | "expired"
        | "void"
        | "sent"
        | "viewed"
        | "declined";
      document_type:
        | "work_authorization"
        | "contract"
        | "coi"
        | "w9"
        | "carrier_correspondence"
        | "estimate"
        | "invoice"
        | "certificate"
        | "photo_report"
        | "other"
        | "service_agreement"
        | "certificate_of_completion"
        | "vendor_agreement"
        | "direction_to_pay"
        | "non_waiver"
        | "job_report";
      email_category:
        | "estimate"
        | "invoice"
        | "follow_up"
        | "seasonal"
        | "work_authorization"
        | "reminder"
        | "notification"
        | "payment_receipt";
      email_status:
        "queued" | "sent" | "delivered" | "opened" | "bounced" | "failed" | "held" | "cancelled";
      equipment_condition: "good" | "damaged" | "needs_service" | "missing" | "needs_cleaning";
      equipment_status: "available" | "on_job" | "in_transit" | "maintenance" | "lost" | "retired";
      equipment_type:
        | "air_mover"
        | "dehumidifier"
        | "air_scrubber"
        | "hepa"
        | "heater"
        | "generator"
        | "moisture_meter"
        | "other";
      escalation_event_state: "open" | "resolved" | "dismissed";
      escalation_record_type: "estimate" | "invoice" | "job" | "account" | "lead" | "compliance";
      escalation_target_kind:
        "named_user" | "record_owner" | "assignee" | "location_manager" | "collector";
      estimate_status: "draft" | "sent" | "approved" | "declined";
      expense_kind:
        "car_payment" | "auto_stipend" | "gas_card" | "company_card" | "general" | "reimbursement";
      expense_request_status: "pending" | "approved" | "declined" | "auto_approved" | "cancelled";
      feature_request_priority: "low" | "normal" | "high" | "urgent";
      feature_request_status:
        "new" | "reviewed" | "planned" | "in_progress" | "completed" | "dismissed";
      gift_campaign_status: "draft" | "approved" | "sending" | "sent" | "cancelled";
      gift_delivery_status: "queued" | "sent" | "delivered" | "returned" | "cancelled";
      gift_occasion: "birthday" | "jewish_holiday" | "seasonal" | "thank_you" | "other";
      gift_policy: "unknown" | "open" | "approval_required" | "prohibited";
      goal_metric:
        | "meetings_held"
        | "touchpoints"
        | "accounts_advanced"
        | "new_accounts"
        | "contracts_signed"
        | "jobs_won"
        | "billed_value"
        | "collected_value"
        | "median_tta_minutes"
        | "conversion_rate"
        | "cold_calls"
        | "cold_emails"
        | "new_deals_worked"
        | "cold_leads_converted"
        | "active_client_reach_outs"
        | "fires_chased";
      goal_period: "month" | "quarter" | "year";
      incident_exclusivity: "exclusive" | "shared";
      incident_lifecycle: "live" | "claimed" | "dead" | "won";
      incident_outcome:
        | "contract_signed"
        | "homeowner_declined"
        | "no_contact"
        | "competitor_present"
        | "not_real_loss"
        | "not_owner"
        | "going_direct"
        | "damage_too_minor"
        | "wrong_address";
      incident_status: "new" | "dispatched" | "accepted" | "on_scene" | "closed" | "discarded";
      incident_type: "fire" | "water" | "smoke" | "storm" | "other";
      integration_provider: "raven" | "callrail" | "outlook" | "kai";
      integration_status: "not_connected" | "connected" | "error" | "disabled";
      invoice_status: "draft" | "sent" | "partial" | "paid" | "disputed" | "written_off";
      job_assignment_role:
        | "crew_chief"
        | "technician"
        | "lead_technician"
        | "account_rep"
        | "project_manager"
        | "estimator"
        | "collector";
      job_loss_type:
        "water" | "fire" | "smoke" | "mold" | "biohazard" | "storm" | "cleaning" | "sewer";
      job_report_status: "draft" | "approved" | "superseded";
      job_report_type: "carrier_submission" | "customer_update" | "internal_review";
      job_status:
        | "new"
        | "scheduled"
        | "in_progress"
        | "drying"
        | "complete"
        | "invoiced"
        | "paid"
        | "cancelled";
      lead_event_type:
        | "new_lead"
        | "status_changed"
        | "stage_changed"
        | "assigned"
        | "note_added"
        | "contact_attempted"
        | "rescinded";
      lead_status: "open" | "rescinded";
      location_member_role: "manager" | "office" | "field";
      money_event_type: "payment_received" | "commission_issued";
      network_membership_status: "credentialing" | "compliant" | "lapsed";
      note_trigger: "none" | "next_call" | "next_meeting" | "next_stage_change" | "on_date";
      notification_delivery: "immediate" | "daily_digest" | "off";
      notification_priority: "low" | "normal" | "high" | "urgent";
      notification_type:
        | "lead_new"
        | "incident_new"
        | "incident_unaccepted"
        | "estimate_sent"
        | "estimate_viewed"
        | "estimate_approved"
        | "estimate_rejected"
        | "estimate_expiring"
        | "invoice_sent"
        | "invoice_viewed"
        | "invoice_partial_payment"
        | "invoice_paid"
        | "invoice_overdue_30"
        | "invoice_overdue_60"
        | "invoice_overdue_90"
        | "invoice_carrier_shortfall"
        | "task_due_today"
        | "task_overdue"
        | "account_touch_overdue"
        | "account_meeting_due"
        | "vendor_doc_expiring"
        | "job_assigned"
        | "job_status_changed"
        | "job_complete_equipment_out"
        | "chat_message"
        | "chat_mention"
        | "sync_failed"
        | "integration_disconnected"
        | "record_stalled"
        | "feature_request_status"
        | "automation_task"
        | "automation_escalation"
        | "expense_approval_request"
        | "expense_decision"
        | "book_reassigned"
        | "lead_approval"
        | "user_signup"
        | "supply_request"
        | "supply_status"
        | "rep_nudge"
        | "goal_pace"
        | "account_idle"
        | "achievement_unlocked"
        | "equipment_offsite"
        | "equipment_retrieval_overdue"
        | "equipment_idle"
        | "task_completed"
        | "vehicle_due"
        | "export_alert"
        | "email_reply_received";
      offboarding_status: "open" | "complete" | "cancelled";
      page_review_status: "unreviewed" | "in_review" | "approved";
      pay_type: "salary" | "draw" | "commission" | "combination";
      photo_access_action: "view" | "download" | "download_original";
      photo_access_actor_kind: "user" | "share_link";
      photo_storage_tier: "hot" | "cold";
      photo_variant_kind: "display" | "thumb";
      pipeline_stage:
        | "new"
        | "attempting_contact"
        | "contacted"
        | "appointment_set"
        | "quoted"
        | "won"
        | "lost"
        | "unqualified";
      project_member_role: "owner" | "collaborator";
      project_status: "active" | "archived";
      quote_category:
        | "labor"
        | "equipment"
        | "materials"
        | "disposal"
        | "mitigation"
        | "reconstruction"
        | "other";
      quote_status:
        "draft" | "internal_review" | "submitted" | "approved" | "rejected" | "superseded";
      reassignment_reason:
        "no_close_6_months" | "rep_departed" | "territory_change" | "account_request" | "other";
      sales_type: "in_house" | "cold_caller" | "field" | "outside_referral";
      share_link_kind:
        "project" | "photo_set" | "job_schedule" | "job_photos" | "job_drying_report";
      shift_status: "open" | "closed" | "approved" | "rejected";
      signature_provider: "native" | "docuseal" | "opensign";
      supply_request_status: "requested" | "approved" | "ordered" | "delivered" | "denied";
      tag_scope: "lead" | "job" | "contact" | "photo" | "project" | "account" | "opportunity";
      task_priority: "low" | "normal" | "high" | "urgent";
      task_status: "open" | "in_progress" | "done" | "cancelled";
      time_entry_status: "draft" | "submitted" | "approved" | "rejected";
      time_entry_type: "labour" | "travel" | "standby";
      touchpoint_type:
        | "call"
        | "email"
        | "meeting_in_person"
        | "meeting_virtual"
        | "gift"
        | "seasonal_send"
        | "other"
        | "text"
        | "linkedin"
        | "mail";
      translation_source: "machine" | "human";
      vendor_doc_kind: "coi" | "w9" | "agreement" | "other";
      vendor_doc_status: "missing" | "pending" | "active" | "expired";
    };
    CompositeTypes: {
      geometry_dump: {
        path: number[] | null;
        geom: unknown;
      };
      valid_detail: {
        valid: boolean | null;
        reason: string | null;
        location: unknown;
      };
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      account_status: ["prospect", "onboarding", "active", "dormant", "lost"],
      account_type: ["property_management", "commercial", "residential", "other"],
      app_role: [
        "admin",
        "office",
        "field",
        "regional",
        "owner",
        "location_manager",
        "sales_manager",
        "sales_rep",
        "field_chaser",
        "crew",
        "dev",
        "sales_person",
        "cold_caller",
        "outside_sales_rep",
        "sales_head",
      ],
      attachment_kind: ["image", "audio", "video", "file"],
      automation_action_kind: [
        "create_task",
        "assign_task",
        "set_due_date",
        "notify",
        "move_stage",
        "apply_flag",
        "escalate",
        "send_email",
      ],
      automation_trigger: [
        "stage_enter",
        "stage_leave",
        "stage_rot",
        "task_past_due",
        "no_activity",
        "date_reached",
        "deal_created",
        "deal_won",
        "deal_lost",
        "job_stage_age",
      ],
      capture_source: [
        "dialer",
        "mailbox",
        "calendar",
        "sms",
        "voice_note",
        "manual",
        "gift_engine",
      ],
      certificate_send_status: ["queued", "sent", "failed"],
      chase_event_type: [
        "created",
        "dispatched",
        "accepted",
        "declined",
        "arrived",
        "outcome_logged",
        "converted",
        "escalated",
        "matched_hpd",
        "discarded",
      ],
      comm_direction: ["outbound", "inbound", "not_applicable"],
      contact_channel: ["call", "sms", "email", "door", "other"],
      contact_decision_role: ["decision_maker", "regional_manager", "influencer", "gatekeeper"],
      conversation_kind: ["direct", "group"],
      dispatch_response: [
        "pending",
        "accepted",
        "declined",
        "declined_race",
        "no_response",
        "no_action",
      ],
      document_event_type: [
        "generated",
        "sent",
        "viewed",
        "signed",
        "declined",
        "voided",
        "reminded",
        "downloaded",
        "hash_mismatch",
      ],
      document_status: [
        "draft",
        "pending_signature",
        "signed",
        "active",
        "expired",
        "void",
        "sent",
        "viewed",
        "declined",
      ],
      document_type: [
        "work_authorization",
        "contract",
        "coi",
        "w9",
        "carrier_correspondence",
        "estimate",
        "invoice",
        "certificate",
        "photo_report",
        "other",
        "service_agreement",
        "certificate_of_completion",
        "vendor_agreement",
        "direction_to_pay",
        "non_waiver",
        "job_report",
      ],
      email_category: [
        "estimate",
        "invoice",
        "follow_up",
        "seasonal",
        "work_authorization",
        "reminder",
        "notification",
        "payment_receipt",
      ],
      email_status: [
        "queued",
        "sent",
        "delivered",
        "opened",
        "bounced",
        "failed",
        "held",
        "cancelled",
      ],
      equipment_condition: ["good", "damaged", "needs_service", "missing", "needs_cleaning"],
      equipment_status: ["available", "on_job", "in_transit", "maintenance", "lost", "retired"],
      equipment_type: [
        "air_mover",
        "dehumidifier",
        "air_scrubber",
        "hepa",
        "heater",
        "generator",
        "moisture_meter",
        "other",
      ],
      escalation_event_state: ["open", "resolved", "dismissed"],
      escalation_record_type: ["estimate", "invoice", "job", "account", "lead", "compliance"],
      escalation_target_kind: [
        "named_user",
        "record_owner",
        "assignee",
        "location_manager",
        "collector",
      ],
      estimate_status: ["draft", "sent", "approved", "declined"],
      expense_kind: [
        "car_payment",
        "auto_stipend",
        "gas_card",
        "company_card",
        "general",
        "reimbursement",
      ],
      expense_request_status: ["pending", "approved", "declined", "auto_approved", "cancelled"],
      feature_request_priority: ["low", "normal", "high", "urgent"],
      feature_request_status: [
        "new",
        "reviewed",
        "planned",
        "in_progress",
        "completed",
        "dismissed",
      ],
      gift_campaign_status: ["draft", "approved", "sending", "sent", "cancelled"],
      gift_delivery_status: ["queued", "sent", "delivered", "returned", "cancelled"],
      gift_occasion: ["birthday", "jewish_holiday", "seasonal", "thank_you", "other"],
      gift_policy: ["unknown", "open", "approval_required", "prohibited"],
      goal_metric: [
        "meetings_held",
        "touchpoints",
        "accounts_advanced",
        "new_accounts",
        "contracts_signed",
        "jobs_won",
        "billed_value",
        "collected_value",
        "median_tta_minutes",
        "conversion_rate",
        "cold_calls",
        "cold_emails",
        "new_deals_worked",
        "cold_leads_converted",
        "active_client_reach_outs",
        "fires_chased",
      ],
      goal_period: ["month", "quarter", "year"],
      incident_exclusivity: ["exclusive", "shared"],
      incident_lifecycle: ["live", "claimed", "dead", "won"],
      incident_outcome: [
        "contract_signed",
        "homeowner_declined",
        "no_contact",
        "competitor_present",
        "not_real_loss",
        "not_owner",
        "going_direct",
        "damage_too_minor",
        "wrong_address",
      ],
      incident_status: ["new", "dispatched", "accepted", "on_scene", "closed", "discarded"],
      incident_type: ["fire", "water", "smoke", "storm", "other"],
      integration_provider: ["raven", "callrail", "outlook", "kai"],
      integration_status: ["not_connected", "connected", "error", "disabled"],
      invoice_status: ["draft", "sent", "partial", "paid", "disputed", "written_off"],
      job_assignment_role: [
        "crew_chief",
        "technician",
        "lead_technician",
        "account_rep",
        "project_manager",
        "estimator",
        "collector",
      ],
      job_loss_type: ["water", "fire", "smoke", "mold", "biohazard", "storm", "cleaning", "sewer"],
      job_report_status: ["draft", "approved", "superseded"],
      job_report_type: ["carrier_submission", "customer_update", "internal_review"],
      job_status: [
        "new",
        "scheduled",
        "in_progress",
        "drying",
        "complete",
        "invoiced",
        "paid",
        "cancelled",
      ],
      lead_event_type: [
        "new_lead",
        "status_changed",
        "stage_changed",
        "assigned",
        "note_added",
        "contact_attempted",
        "rescinded",
      ],
      lead_status: ["open", "rescinded"],
      location_member_role: ["manager", "office", "field"],
      money_event_type: ["payment_received", "commission_issued"],
      network_membership_status: ["credentialing", "compliant", "lapsed"],
      note_trigger: ["none", "next_call", "next_meeting", "next_stage_change", "on_date"],
      notification_delivery: ["immediate", "daily_digest", "off"],
      notification_priority: ["low", "normal", "high", "urgent"],
      notification_type: [
        "lead_new",
        "incident_new",
        "incident_unaccepted",
        "estimate_sent",
        "estimate_viewed",
        "estimate_approved",
        "estimate_rejected",
        "estimate_expiring",
        "invoice_sent",
        "invoice_viewed",
        "invoice_partial_payment",
        "invoice_paid",
        "invoice_overdue_30",
        "invoice_overdue_60",
        "invoice_overdue_90",
        "invoice_carrier_shortfall",
        "task_due_today",
        "task_overdue",
        "account_touch_overdue",
        "account_meeting_due",
        "vendor_doc_expiring",
        "job_assigned",
        "job_status_changed",
        "job_complete_equipment_out",
        "chat_message",
        "chat_mention",
        "sync_failed",
        "integration_disconnected",
        "record_stalled",
        "feature_request_status",
        "automation_task",
        "automation_escalation",
        "expense_approval_request",
        "expense_decision",
        "book_reassigned",
        "lead_approval",
        "user_signup",
        "supply_request",
        "supply_status",
        "rep_nudge",
        "goal_pace",
        "account_idle",
        "achievement_unlocked",
        "equipment_offsite",
        "equipment_retrieval_overdue",
        "equipment_idle",
        "task_completed",
        "vehicle_due",
        "export_alert",
        "email_reply_received",
      ],
      offboarding_status: ["open", "complete", "cancelled"],
      page_review_status: ["unreviewed", "in_review", "approved"],
      pay_type: ["salary", "draw", "commission", "combination"],
      photo_access_action: ["view", "download", "download_original"],
      photo_access_actor_kind: ["user", "share_link"],
      photo_storage_tier: ["hot", "cold"],
      photo_variant_kind: ["display", "thumb"],
      pipeline_stage: [
        "new",
        "attempting_contact",
        "contacted",
        "appointment_set",
        "quoted",
        "won",
        "lost",
        "unqualified",
      ],
      project_member_role: ["owner", "collaborator"],
      project_status: ["active", "archived"],
      quote_category: [
        "labor",
        "equipment",
        "materials",
        "disposal",
        "mitigation",
        "reconstruction",
        "other",
      ],
      quote_status: ["draft", "internal_review", "submitted", "approved", "rejected", "superseded"],
      reassignment_reason: [
        "no_close_6_months",
        "rep_departed",
        "territory_change",
        "account_request",
        "other",
      ],
      sales_type: ["in_house", "cold_caller", "field", "outside_referral"],
      share_link_kind: ["project", "photo_set", "job_schedule", "job_photos", "job_drying_report"],
      shift_status: ["open", "closed", "approved", "rejected"],
      signature_provider: ["native", "docuseal", "opensign"],
      supply_request_status: ["requested", "approved", "ordered", "delivered", "denied"],
      tag_scope: ["lead", "job", "contact", "photo", "project", "account", "opportunity"],
      task_priority: ["low", "normal", "high", "urgent"],
      task_status: ["open", "in_progress", "done", "cancelled"],
      time_entry_status: ["draft", "submitted", "approved", "rejected"],
      time_entry_type: ["labour", "travel", "standby"],
      touchpoint_type: [
        "call",
        "email",
        "meeting_in_person",
        "meeting_virtual",
        "gift",
        "seasonal_send",
        "other",
        "text",
        "linkedin",
        "mail",
      ],
      translation_source: ["machine", "human"],
      vendor_doc_kind: ["coi", "w9", "agreement", "other"],
      vendor_doc_status: ["missing", "pending", "active", "expired"],
    },
  },
} as const;
