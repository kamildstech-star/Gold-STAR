import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RecordTimeline } from "@/components/record-timeline";
import { Link } from "@tanstack/react-router";
import { Archive, Building2, Gift, Mail, Phone, Star, Undo2, User } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { fetchGiftPolicy } from "@/lib/gift-policy";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DetailDrawer, DrawerField, DrawerSection } from "@/components/detail-drawer";
import { personNameWrite, splitFullName } from "@/lib/person-name";
import { isMissingSchema } from "@/lib/schema-fallback";
import { RelationshipRollup } from "@/components/relationship-rollup";
import { ContactRelationshipNotes } from "@/components/contact-relationship-notes";
import { LabelPicker } from "@/components/label-picker";
import { CONTACT_POSITION_LABEL, CONTACT_POSITION_OPTIONS } from "@/lib/company-hierarchy";
import { useManagedOptions } from "@/lib/managed-options";
import { CONTACT_DECISION_ROLES, CONTACT_ROLE_LABEL } from "@/lib/accounts";
import { optionsFrom } from "@/lib/managed-options";

const CONTACT_ROLE_OPTS = optionsFrom(CONTACT_DECISION_ROLES, CONTACT_ROLE_LABEL);

/** Radix Select refuses an empty string as a value, so "unset" needs a token. */
const NO_POSITION = "__none";

export type ContactDrawerRow = {
  id: string;
  full_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  is_primary: boolean;
  decision_role: string | null;
  /* Nullable: callers that read the contact row straight from Postgres hand
     over a null here, not a missing key. */
  gift_policy?: string | null;
  archived_at?: string | null;
  account: { id: string; name: string } | null;
};

const GIFT_POLICY_LABEL: Record<string, string> = {
  unknown: "Policy unknown",
  open: "Gifts allowed",
  approval_required: "Pre-approval required",
  prohibited: "Gifts prohibited",
};

const CONTACT_COLUMNS =
  "id, full_name, first_name, last_name, title, email, phone, birthday_month, birthday_day, spouse_name, children, family_notes, personal_preferences, decision_role, position_key, is_primary, archived_at";
/** The same list before 20260913120000 added the name pair. */
const CONTACT_COLUMNS_LEGACY =
  "id, full_name, title, email, phone, birthday_month, birthday_day, spouse_name, children, family_notes, personal_preferences, decision_role, position_key, is_primary, archived_at";

export function ContactDrawer({
  contact,
  onOpenChange,
  onChanged,
}: {
  contact: ContactDrawerRow | null;
  onOpenChange: (v: boolean) => void;
  onChanged?: () => void;
}) {
  const qc = useQueryClient();

  const detailQ = useQuery({
    queryKey: ["contact-drawer", contact?.id],
    enabled: !!contact,
    queryFn: async () => {
      /* `first_name`/`last_name` arrive with 20260913120000. Naming a column
         PostgREST does not know fails the WHOLE read, so the pair is asked for
         and the pre-pair list is the fallback — the drawer then splits
         `full_name` for display, which is what the backfill will store anyway. */
      const read = (columns: string) =>
        supabase.from("contacts").select(columns).eq("id", contact!.id).maybeSingle();

      let { data, error } = (await read(CONTACT_COLUMNS)) as { data: unknown; error: unknown };
      if (error && isMissingSchema(error)) {
        ({ data, error } = (await read(CONTACT_COLUMNS_LEGACY)) as {
          data: unknown;
          error: unknown;
        });
      }
      if (error) throw error;
      return (data ?? null) as Record<string, unknown> | null;
    },
  });

  const policyQ = useQuery({
    queryKey: ["contact-gift-policy", contact?.id],
    enabled: !!contact,
    queryFn: () => fetchGiftPolicy(contact!.id),
  });

  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const decisionRoles = useManagedOptions("contact_decision_role", CONTACT_ROLE_OPTS);

  const patch = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      const write = (v: Record<string, unknown>) =>
        supabase
          .from("contacts")
          .update(v as never)
          .eq("id", contact!.id);

      let { error } = await write(values);
      if (error && isMissingSchema(error)) {
        /* Drop the pair and keep the composed name, so editing a name on an
           un-migrated database does exactly what it did before. */
        const { first_name: _f, last_name: _l, ...rest } = values;
        void _f;
        void _l;
        if (Object.keys(rest).length === 0) return;
        ({ error } = await write(rest));
      }
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contact-drawer", contact?.id] });
      onChanged?.();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const archive = useMutation({
    mutationFn: async (archived: boolean) => {
      const { error } = await supabase
        .from("contacts")
        .update({ archived_at: archived ? new Date().toISOString() : null } as never)
        .eq("id", contact!.id);
      if (error) throw error;
    },
    onSuccess: (_d, archived) => {
      toast.success(archived ? "Contact archived" : "Contact restored");
      qc.invalidateQueries({ queryKey: ["contact-drawer", contact?.id] });
      onChanged?.();
      if (archived) onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = (detailQ.data ?? {}) as Record<string, string | number | null | boolean>;

  /*
   * The pair to show. When 20260913120000 has been applied the columns are
   * authoritative; before that they come back undefined and the same
   * first-space rule the backfill uses derives them from `full_name`, so the
   * drawer reads identically either way and a save always carries the
   * composed name.
   */
  const currentFullName = ((d.full_name as string) ?? contact?.full_name ?? "").trim();
  const derivedName = splitFullName(currentFullName);
  const nameParts = {
    firstName: ((d.first_name as string | null) ?? derivedName.firstName) || "",
    lastName: ((d.last_name as string | null) ?? derivedName.lastName) || "",
  };

  const isArchived = !!d.archived_at;
  const prohibited = (policyQ.data ?? contact?.gift_policy) === "prohibited";

  return (
    <DetailDrawer
      open={!!contact}
      onOpenChange={onOpenChange}
      title={contact?.full_name ?? ""}
      subtitle={contact?.account?.name ?? "No account"}
      headerExtra={
        <div className="flex flex-wrap items-center gap-1.5">
          {contact?.is_primary && (
            <Badge variant="secondary" className="text-[10px]">
              <Star className="mr-1 size-3" />
              Primary
            </Badge>
          )}
          {prohibited && (
            <Badge variant="destructive" className="text-[10px]">
              <Gift className="mr-1 size-3" />
              Gifts prohibited
            </Badge>
          )}
          {isArchived && (
            <Badge variant="outline" className="text-[10px]">
              Archived
            </Badge>
          )}
        </div>
      }
      footer={
        <div className="flex items-center justify-between gap-2">
          {contact?.account ? (
            <Button asChild size="sm" variant="secondary" className="h-8 text-[12px]">
              <Link to="/accounts/$id" params={{ id: contact.account.id }}>
                Open account
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-[12px]"
            disabled={archive.isPending}
            onClick={() => archive.mutate(!isArchived)}
          >
            {isArchived ? (
              <>
                <Undo2 className="mr-1.5 size-3.5" />
                Restore
              </>
            ) : (
              <>
                <Archive className="mr-1.5 size-3.5" />
                Archive
              </>
            )}
          </Button>
        </div>
      }
    >
      {contact && (
        <>
          <DrawerSection title="Job relationships">
            <div className="px-4 py-2">
              <RelationshipRollup contactId={contact.id} />
            </div>
          </DrawerSection>

          <DrawerSection title="Labels">
            <div className="px-4 py-1.5">
              <LabelPicker scope="contact" recordId={contact.id} />
            </div>
          </DrawerSection>

          <DrawerSection title="ACCOUNT">
            {/* Mark: "there is no way to edit a contact". Title, email and
                phone were editable; the name was not, so a misspelling on the
                record everyone reads was permanent. Nor were the two fields
                that decide where somebody sits in their company. */}
            {/*
             * Two boxes over one. On a database where 20260913120000 has not
             * been applied the columns come back undefined, so the pair is
             * derived from `full_name` by the same first-space rule the
             * backfill uses — the drawer shows the same answer either way, and
             * the write below always carries the composed name.
             */}
            <DrawerField
              icon={User}
              label="First name"
              value={nameParts.firstName}
              onSave={(v) => {
                const next = personNameWrite(v, nameParts.lastName, currentFullName);
                if (!next.full_name) {
                  toast.error("A contact needs a name.");
                  return;
                }
                patch.mutate(next);
              }}
            />
            <DrawerField
              icon={User}
              label="Last name"
              value={nameParts.lastName}
              onSave={(v) => {
                const next = personNameWrite(nameParts.firstName, v, currentFullName);
                if (!next.full_name) {
                  toast.error("A contact needs a name.");
                  return;
                }
                patch.mutate(next);
              }}
            />
            {/*
             * Position leads and Title follows it, because they answer
             * different questions and used to sit side by side answering
             * neither clearly: Position is where they sit in THEIR company and
             * is the field the org chart is drawn from; Title is just what is
             * printed on their card. Decision role — what they are to US in a
             * sale — moved to the Relationship section below.
             */}
            <DrawerField
              icon={Building2}
              label="Position"
              value={(d.position_key as string) ?? ""}
              display={
                CONTACT_POSITION_LABEL[(d.position_key as string) ?? ""] ?? "Position not set"
              }
              options={[
                { value: NO_POSITION, label: "No position" },
                ...positions.options.map((o) => ({ value: o.key, label: o.label })),
              ]}
              onSave={(v) => patch.mutate({ position_key: v === NO_POSITION ? null : v })}
              hint="Where they sit in their company — this draws the org chart."
            />
            <DrawerField
              icon={User}
              label="Custom title (optional)"
              value={(d.title as string) ?? contact.title}
              onSave={(v) => patch.mutate({ title: v || null })}
              hint="Only if their own wording differs from the position above."
            />
            <DrawerField
              icon={Mail}
              label="Email"
              value={(d.email as string) ?? contact.email}
              type="email"
              onSave={(v) => patch.mutate({ email: v || null })}
            />
            <DrawerField
              icon={Phone}
              label="Phone"
              value={(d.phone as string) ?? contact.phone}
              type="tel"
              onSave={(v) => patch.mutate({ phone: v || null })}
            />
            <DrawerField
              icon={Gift}
              label="Gift policy"
              value={GIFT_POLICY_LABEL[(policyQ.data ?? contact.gift_policy) as string] ?? "—"}
              readOnly
            />
          </DrawerSection>

          <DrawerSection title="History">
            <RecordTimeline type="contact" id={contact.id} emptyLabel="No recorded activity yet." />
          </DrawerSection>

          <DrawerSection title="Relationship">
            {/* A sales concept, so it sits with the seller's other notes
                rather than beside the two fields about their employer. */}
            <DrawerField
              icon={Building2}
              label="Decision role"
              value={(d.decision_role as string) ?? contact.decision_role ?? ""}
              display={
                decisionRoles.options.find(
                  (r) => r.key === ((d.decision_role as string) ?? contact.decision_role),
                )?.label ?? "Not known yet"
              }
              options={[
                { value: NO_POSITION, label: "Not known yet" },
                ...decisionRoles.options.map((r) => ({ value: r.key, label: r.label })),
              ]}
              onSave={(v) => patch.mutate({ decision_role: v === NO_POSITION ? null : v })}
              hint="What they are to us in a sale — not their job."
            />
            <ContactRelationshipNotes
              contactId={contact.id}
              contactName={contact.full_name}
              birthdayMonth={(d.birthday_month as number) ?? null}
              birthdayDay={(d.birthday_day as number) ?? null}
              onSaved={() => detailQ.refetch()}
            />
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}
