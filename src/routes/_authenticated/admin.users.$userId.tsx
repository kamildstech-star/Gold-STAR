import { createFileRoute, Link } from "@tanstack/react-router";
import { BackLink } from "@/components/back-link";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useWritesDisabled } from "@/components/app-context";
import { LoadError } from "@/components/ui-density";
import { UserEditor } from "@/components/user-editor";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { adminListUsers } from "@/lib/admin.functions";
import { isAccessError, toastDbError } from "@/lib/db-errors";
import { isMissingSchema } from "@/lib/schema-fallback";

export const Route = createFileRoute("/_authenticated/admin/users/$userId")({
  head: () => ({
    meta: [
      { title: "Edit user · Recovery Hub" },
      {
        name: "description",
        content:
          "Roles, location and region membership, per-capability permissions and change history for one user.",
      },
      { name: "robots", content: "noindex" },
      { property: "og:title", content: "Edit user · Recovery Hub" },
      {
        property: "og:description",
        content: "Manage a user's access, scope and capabilities.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: UserDetailPage,
});

function UserDetailPage() {
  const { userId } = Route.useParams();
  const listUsers = useServerFn(adminListUsers);

  const usersQ = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => listUsers(),
  });

  const user = (usersQ.data?.users ?? []).find((u) => u.user_id === userId) ?? null;

  if (usersQ.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (usersQ.error) {
    return <LoadError what="user" error={usersQ.error} onRetry={() => void usersQ.refetch()} />;
  }
  if (!user) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          That user is not in your list — they may have been removed or be outside your scope.
        </p>
        <BackLink fallbackTo="/admin/users" label="users" className="text-sm underline">
          Back to users
        </BackLink>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <UserEditor user={user} onChange={() => void usersQ.refetch()} />
      <ContactDetailsCard userId={user.user_id} />
    </div>
  );
}

const CONTACT_FIELDS = [
  { key: "job_title", label: "Job title", type: "text" },
  { key: "work_phone", label: "Work phone", type: "tel" },
  { key: "extension", label: "Extension", type: "text" },
  { key: "mobile_phone", label: "Mobile", type: "tel" },
] as const;

type ContactDetails = Record<(typeof CONTACT_FIELDS)[number]["key"], string>;

const EMPTY: ContactDetails = {
  job_title: "",
  work_phone: "",
  extension: "",
  mobile_phone: "",
};

/** The migration that adds the four columns — named in the note so the fix is findable. */
const CONTACT_MIGRATION = "20260826100000_profile_contact_details";

type ContactLoad =
  | { status: "ready"; details: Partial<ContactDetails> | null }
  /** The columns are not in the database yet. A retry cannot change that. */
  | { status: "needs-migration" }
  /** The columns exist but `authenticated` was never granted SELECT on them. */
  | { status: "not-granted" };

/**
 * What the staff directory reads. Kept here rather than in UserEditor because
 * these four are the only profile columns an admin edits about a *person*
 * rather than about their access, and because a person can maintain them
 * themselves — this card is the admin's way in, not the only one.
 */
function ContactDetailsCard({ userId }: { userId: string }) {
  const writes = useWritesDisabled();
  const [form, setForm] = useState<ContactDetails>(EMPTY);

  const detailsQ = useQuery({
    queryKey: ["profile-contact", userId],
    queryFn: async (): Promise<ContactLoad> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("job_title, work_phone, extension, mobile_phone")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) {
        // Same rule as every other panel that reads ahead of the applied
        // migrations: a missing column is a state to describe, not an error
        // to retry. profiles grants SELECT column by column, so a column that
        // exists but was never granted fails the same read differently.
        if (isMissingSchema(error)) return { status: "needs-migration" };
        if (isAccessError(error, { expectedToExist: false })) return { status: "not-granted" };
        throw error;
      }
      return {
        status: "ready",
        details: (data ?? null) as unknown as Partial<ContactDetails> | null,
      };
    },
  });

  const details = detailsQ.data?.status === "ready" ? detailsQ.data.details : null;

  useEffect(() => {
    if (!details) return;
    setForm({
      job_title: details.job_title ?? "",
      work_phone: details.work_phone ?? "",
      extension: details.extension ?? "",
      mobile_phone: details.mobile_phone ?? "",
    });
  }, [details]);

  const save = useMutation({
    mutationFn: async () => {
      // Blank means "not on file", not an empty string the directory would
      // render as a dead tel: link.
      const patch = {
        job_title: form.job_title.trim() || null,
        work_phone: form.work_phone.trim() || null,
        extension: form.extension.trim() || null,
        mobile_phone: form.mobile_phone.trim() || null,
      };
      // `as never`: integrations/supabase/types.ts is generated and won't carry
      // these four columns until the migration is applied and types regenerated.
      const { error } = await supabase
        .from("profiles")
        .update(patch as never)
        .eq("user_id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Contact details saved");
      void detailsQ.refetch();
    },
    onError: (e) => toastDbError(e, { action: "Saving contact details" }),
  });

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-[15px]">Contact details</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {detailsQ.error ? (
          <LoadError
            what="contact details"
            error={detailsQ.error}
            onRetry={() => void detailsQ.refetch()}
          />
        ) : detailsQ.data?.status === "needs-migration" ? (
          <p className="border-l-2 border-muted-foreground/40 px-2 py-1 text-xs text-muted-foreground">
            Contact details need a database update — the migration that adds job title, work phone,
            extension and mobile to <code>profiles</code> (<code>{CONTACT_MIGRATION}</code>) has not
            been applied yet. Nothing has been lost; the fields appear once it is.
          </p>
        ) : detailsQ.data?.status === "not-granted" ? (
          <p className="border-l-2 border-muted-foreground/40 px-2 py-1 text-xs text-muted-foreground">
            Contact details cannot be read yet — the columns exist on <code>profiles</code> but
            signed-in users have not been granted SELECT on them. The grant is part of{" "}
            <code>{CONTACT_MIGRATION}</code>; it needs to be applied in full.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {CONTACT_FIELDS.map((f) => (
                <div key={f.key} className="space-y-1">
                  <Label htmlFor={`contact-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`contact-${f.key}`}
                    type={f.type}
                    value={form[f.key]}
                    disabled={detailsQ.isLoading}
                    onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Button
                size="sm"
                disabled={writes.disabled || save.isPending || detailsQ.isLoading}
                onClick={() => save.mutate()}
              >
                Save
              </Button>
              <span className="text-xs text-muted-foreground">
                {writes.reason ??
                  "Shown to everyone in the staff directory; mobile is management-only."}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
