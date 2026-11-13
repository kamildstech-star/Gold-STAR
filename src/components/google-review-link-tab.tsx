import { browserAppOrigin } from "@/lib/app-origin";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ExternalLink, Link2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import type { ActionContact } from "@/components/account-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  googleReviewTrackingUrl,
  normalizeGoogleReviewDestination,
} from "@/lib/google-review-links";

type ReviewLink = {
  id: string;
  token: string;
  destination_url: string;
  click_count: number;
  first_clicked_at: string | null;
  last_clicked_at: string | null;
  is_active: boolean;
  created_at: string;
};

export function GoogleReviewLinkTab({
  accountId,
  locationId,
  contacts,
  userId,
}: {
  accountId: string;
  locationId: string | null;
  contacts: ActionContact[];
  userId: string | null;
}) {
  const qc = useQueryClient();
  const key = ["google-review-links", accountId];
  const [destination, setDestination] = useState("");
  const [contactId, setContactId] = useState("none");
  const [copied, setCopied] = useState<string | null>(null);

  const links = useQuery({
    queryKey: key,
    queryFn: async (): Promise<ReviewLink[]> => {
      const { data, error } = await supabase
        .from("google_review_links")
        .select(
          "id,token,destination_url,click_count,first_clicked_at,last_clicked_at,is_active,created_at",
        )
        .eq("account_id", accountId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!userId || !locationId) throw new Error("This account needs an office before sharing.");
      const clean = normalizeGoogleReviewDestination(destination);
      if (!clean) throw new Error("Paste a secure Google or Google Maps review link.");
      const { data, error } = await supabase
        .from("google_review_links")
        .insert({
          account_id: accountId,
          contact_id: contactId === "none" ? null : contactId,
          location_id: locationId,
          destination_url: clean,
          created_by: userId,
        })
        .select(
          "id,token,destination_url,click_count,first_clicked_at,last_clicked_at,is_active,created_at",
        )
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: async (link) => {
      setDestination("");
      await qc.invalidateQueries({ queryKey: key });
      await copyLink(link.token);
      toast.success("Tracked review link created and copied");
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const copyLink = async (token: string) => {
    await navigator.clipboard.writeText(googleReviewTrackingUrl(token, browserAppOrigin()));
    setCopied(token);
    window.setTimeout(() => setCopied((current) => (current === token ? null : current)), 1800);
  };

  const rows = links.data ?? [];

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label>Google Business review link</Label>
          <Input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="https://g.page/r/.../review"
            inputMode="url"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Recipient (optional)</Label>
          <Select value={contactId} onValueChange={setContactId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No specific contact</SelectItem>
              {contacts.map((contact) => (
                <SelectItem key={contact.id} value={contact.id}>
                  {contact.full_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          disabled={create.isPending || !destination.trim() || !locationId}
          onClick={() => create.mutate()}
        >
          <Link2 className="mr-1.5 size-4" />
          {create.isPending ? "Creating…" : "Create link"}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <p className="text-[11.5px] text-muted-foreground">
          Opens are counted when this redirect is visited. Link-preview services may also count.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7"
          onClick={() => void links.refetch()}
        >
          <RefreshCw className="mr-1 size-3.5" /> Refresh
        </Button>
      </div>

      {links.isError ? (
        <p className="text-sm text-destructive">Review-link history could not be loaded.</p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          No tracked review links for this account yet.
        </p>
      ) : (
        <div className="divide-y rounded-md border">
          {rows.map((link) => {
            const url = googleReviewTrackingUrl(link.token, browserAppOrigin());
            return (
              <div key={link.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {link.click_count} open{link.click_count === 1 ? "" : "s"}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {link.last_clicked_at
                      ? `Last opened ${new Date(link.last_clicked_at).toLocaleString("en-US")}`
                      : "Not opened yet"}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7"
                  onClick={() => void copyLink(link.token)}
                >
                  {copied === link.token ? (
                    <Check className="mr-1 size-3.5" />
                  ) : (
                    <Copy className="mr-1 size-3.5" />
                  )}
                  {copied === link.token ? "Copied" : "Copy"}
                </Button>
                <Button variant="ghost" size="sm" className="h-7" asChild>
                  <a href={url} target="_blank" rel="noreferrer">
                    <ExternalLink className="mr-1 size-3.5" /> Open
                  </a>
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
