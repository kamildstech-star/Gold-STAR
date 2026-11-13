
insert into public.email_templates (key, name, category, subject, body, intake_form, is_active, signature)
select
  'request_for_info_pa',
  'Request for Info — PA',
  'notification',
  'Request for information — {Job.SiteAddress.Address1} (Job {Job.JobNumber})',
  '<p>Hello {Contact.FirstName},</p><p>We have been engaged on the loss below and need a few details confirmed before we can proceed with the file.</p><ul><li><strong>Site address:</strong> {Job.SiteAddress.Full}</li><li><strong>Insured name:</strong> {Job.CustomerName}</li><li><strong>Insured phone:</strong> {Job.CustomerPhone}</li><li><strong>Insured email:</strong> {Job.CustomerEmail}</li><li><strong>Date of loss:</strong> {Job.LossDate}</li><li><strong>Insurance carrier:</strong> {InsuranceCompany}</li><li><strong>Claim number:</strong> {Job.ClaimNumber}</li></ul><p>Please confirm or correct these details using the secure form below — it is prefilled with what we already have:</p><p>{IntakeLink}</p><p>Thank you,</p>',
  true,
  true,
  '{Sender.Name}<br/>{Office.Name} · {Office.Phone}<br/>{Company.LegalName}'
where not exists (select 1 from public.email_templates where key = 'request_for_info_pa');
