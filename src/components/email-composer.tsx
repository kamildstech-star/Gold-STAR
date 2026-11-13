import { textToEmailHtml } from "@/lib/safe-html";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WarningLine } from "@/components/ui-density";
import { sendEmail, emailStatus } from "@/lib/email.functions";
import { announceEmailSend } from "@/components/email-send-toast";
import { noTransportSentence } from "@/lib/email-transport";
import {
  EMAIL_CATEGORY_LABEL,
  parseRecipients,
  isValidEmail,
  renderTemplate,
  unresolvedVariables,
  type EmailCategory,
  type EmailTemplate,
} from "@/lib/email";

export type EmailComposerContext = {
  category: EmailCategory;
  to?: string[];
  accountId?: string | null;
  contactId?: string | null;
  jobId?: string | null;
  invoiceId?: string | null;
  locationId?: string | null;
  attachmentUrl?: string | null;
  /** Values substituted into {{placeholders}} in the chosen template. */
  variables?: Record<string, string | null | undefined>;
};

/**
 * Compose-and-send dialog. Nothing is ever sent silently: the exact subject
 * and body that will go out are editable and on screen before Send.
 */
export function EmailComposer({
  open,
  onOpenChange,
  context,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: EmailComposerContext;
  onSent?: () => void;
}) {
  const qc = useQueryClient();
  const send = useServerFn(sendEmail);
  const status = useServerFn(emailStatus);

  const [templateId, setTemplateId] = useState("none");
  const [to, setTo] = useState((context.to ?? []).join(", "));
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const configuredQuery = useQuery({
    queryKey: ["email", "status"],
    queryFn: () => status({}),
    enabled: open,
  });

  const templatesQuery = useQuery({
    queryKey: ["email-templates", context.category],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_templates")
        .select("*")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return (data ?? []) as EmailTemplate[];
    },
  });

  const templates = useMemo(
    () => (templatesQuery.data ?? []).filter((t) => t.category === context.category),
    [templatesQuery.data, context.category],
  );

  useEffect(() => {
    if (!open) return;
    setTo((context.to ?? []).join(", "));
  }, [open, context.to]);

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    const vars = context.variables ?? {};
    setSubject(renderTemplate(tpl.subject, vars));
    setBody(renderTemplate(tpl.body, vars) + (tpl.signature ? `\n\n${tpl.signature}` : ""));
  };

  const recipients = parseRecipients(to);
  const invalid = recipients.filter((r) => !isValidEmail(r));
  const missingVars = unresolvedVariables(`${subject}\n${body}`);
  // A failed check does not block a send; a definite "nothing carries it" does.
  const configured =
    (configuredQuery.data?.configured ?? false) || configuredQuery.data?.checked === false;

  const mutation = useMutation({
    mutationKey: ["email", "send"],
    mutationFn: async () => {
      const tpl = templates.find((t) => t.id === templateId);
      return send({
        data: {
          to: recipients,
          cc: parseRecipients(cc),
          subject,
          bodyHtml: textToEmailHtml(body),
          category: context.category,
          templateId: tpl?.id ?? null,
          templateKey: tpl?.key ?? null,
          accountId: context.accountId ?? null,
          contactId: context.contactId ?? null,
          jobId: context.jobId ?? null,
          invoiceId: context.invoiceId ?? null,
          locationId: context.locationId ?? null,
          attachmentUrl: context.attachmentUrl ?? null,
          replyTo: tpl?.reply_to ?? null,
          fromName: tpl?.from_name ?? null,
        },
      });
    },
    onSuccess: (result) => {
      announceEmailSend(result, {
        sent: result.touchpointLogged ? "Email sent and logged as a touchpoint" : "Email sent",
      });
      qc.invalidateQueries({ queryKey: ["email-log"] });
      qc.invalidateQueries({ queryKey: ["touchpoints"] });
      onOpenChange(false);
      onSent?.();
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Send email — {EMAIL_CATEGORY_LABEL[context.category]}</DialogTitle>
        </DialogHeader>

        {configuredQuery.isSuccess && !configured && (
          <WarningLine>
            {noTransportSentence(configuredQuery.data?.reason)}{" "}
            <Link to="/security" className="font-medium underline underline-offset-2">
              Open your Security page
            </Link>
          </WarningLine>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Template</Label>
            <Select value={templateId} onValueChange={applyTemplate}>
              <SelectTrigger>
                <SelectValue placeholder="No template — write from scratch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No template</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {templates.length === 0 && templatesQuery.isSuccess && (
              <p className="text-[12px] text-muted-foreground">
                No {EMAIL_CATEGORY_LABEL[context.category].toLowerCase()} templates yet.
              </p>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>To</Label>
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="name@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Cc</Label>
              <Input value={cc} onChange={(e) => setCc(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>Body</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={12} />
          </div>

          {invalid.length > 0 && (
            <WarningLine>Not a valid address: {invalid.join(", ")}</WarningLine>
          )}
          {missingVars.length > 0 && (
            <WarningLine>
              Unfilled placeholders still in the message: {missingVars.join(", ")}
            </WarningLine>
          )}
          {context.attachmentUrl && (
            <p className="text-[12px] text-muted-foreground">
              Attachment link included: {context.attachmentUrl}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={
              mutation.isPending ||
              !configured ||
              recipients.length === 0 ||
              invalid.length > 0 ||
              subject.trim().length === 0
            }
          >
            {mutation.isPending ? "Sending…" : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
