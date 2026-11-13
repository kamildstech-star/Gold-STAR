-- Seed the client's real CONTRACT FOR SERVICES wording, verbatim, using their
-- own merge-key syntax. Legal text is not edited here or anywhere else.
do $$
declare t_id uuid;
begin
  select id into t_id from public.document_templates where name = 'CONTRACT FOR SERVICES' limit 1;

  if t_id is null then
    insert into public.document_templates (name, doc_type, location_id, description, is_active)
    values ('CONTRACT FOR SERVICES', 'contract', null,
            'Gold Star contract signed on glass. Legal wording verbatim; footer resolves per the job location.',
            true)
    returning id into t_id;
  else
    update public.document_templates
       set doc_type = 'contract',
           is_active = true,
           description = 'Gold Star contract signed on glass. Legal wording verbatim; footer resolves per the job location.'
     where id = t_id;
  end if;

  insert into public.document_template_versions (template_id, version, body, merge_fields, change_note)
  select t_id,
         coalesce((select max(version) from public.document_template_versions where template_id = t_id), 0) + 1,
         $gsbody${{LocationLogo}}

CONTRACT FOR SERVICES

Agreement: The undersigned, {Job.CustomerName} - {Job.SiteAddress.Community} (Owner/Agent) for the job site listed below, authorize Gold Star Restoration to enter my property, furnish materials, supply all equipment and perform all labor necessary to preserve and protect my property from further damage. Gold Star Restoration will only be providing mitigation services and will not be performing any repairs to the property or mold remediation.

Assignment of Insurance Benefits and Direct Payment Authorization: I hereby assign any and all insurance rights, benefits, and proceeds under any applicable insurance policies to Gold Star Restoration for the remediation services rendered only (this does not include any money for the reconstruction of your property). I also hereby authorize direct payment of any benefits or proceeds to Gold Star Restoration. I make this assignment and authorization in consideration of Gold Star Restoration's agreement to perform services and supply materials and otherwise perform its obligations under this contract including not requiring full payment at the time of service.

I believe the appropriate insurance carrier to be {Insurance Company}. I also hereby direct my insurance carrier(s) to release any and all information requested by Gold Star Restoration its representative, or its Attorney for the direct purpose of obtaining actual benefits to be paid by my insurance carrier(s) for services rendered or to be rendered. In this regard, I waive my privacy rights.

If payment is made directly to the Owner/Agent by an insurer, it shall be endorsed over to Gold Star Restoration within three business days. I agree that any portion of work, deductibles, betterment, depreciation, or additional work requested by the undersigned, not covered by insurance, must be made by the undersigned on or before its completion. I hereby appoint Gold Star Restoration as attorney in-fact authorizing Gold Star Restoration to endorse my name, and to deposit insurance check or drafts for Gold Star Restoration. Payment for services rendered by Gold Star Restoration is due upon completion of services. Late charges of 1.5% monthly are charged to any withheld insurance payments.

Gold Star Restoration Shall be entitled to reimbursement for costs of collection (including reasonable attorney's fees and costs) of unpaid amounts by owner/agent and for reasonable attorney's fees and costs for the breach or enforcement, of any terms of this entire service agreement.

Authorized Antimicrobial Agents: I understand that, in the best judgment of Gold Star Restoration, materials may be treated with a commercial antimicrobial and antimicrobial product as part of the restoration process. I understand it is beyond the expertise of Gold Star Restoration to determine if someone is sensitive to its application and will hold Gold Star Restoration harmless for its use.

Stop Work- Hold Harmless: In the event Gold Star Restoration is not allowed to perform its recommended procedures and/or drying equipment is removed prematurely, I agree to release and hold Gold Star Restoration harmless and indemnify Gold Star Restoration against all claims or actions that may result from such procedures.

Limitation of Liability: In no event shall Gold Star Restoration, its owners, officers, directors, employees, agents or affiliates be responsible for indirect, special, nominal, incidental, punitive or consequential losses or damages, or for any penalties, to the extent permitted by law.

Address: {Job.SiteAddress.Address1} / {Job.SiteAddress.City}, {Job.SiteAddress.State} {Job.SiteAddress.PostalCode}    Signature: {Signature}
Claim Number: {Job.ClaimNumber}    Signature Date: {SignatureDate}
Type of Loss: {Job.Type}    Job Primary Contact: {Job.CustomerName}
Date of Loss: {Job.LossDate}    Site Name: {Job.SiteAddress.Community}

{Office - Company Name} · {Office Address (Full)} · {Office Phone}
Toll Free: 877-95-WATER ~ www.GoldStarRestoration.com$gsbody$,
         '["LocationLogo", "Job.CustomerName", "Job.SiteAddress.Community", "Insurance Company", "Job.SiteAddress.Address1", "Job.SiteAddress.City", "Job.SiteAddress.State", "Job.SiteAddress.PostalCode", "Signature", "Job.ClaimNumber", "SignatureDate", "Job.Type", "Job.LossDate", "Office - Company Name", "Office Address (Full)", "Office Phone"]'::jsonb,
         'Client CONTRACT FOR SERVICES — exact wording, client merge-key syntax'
  where not exists (
    select 1 from public.document_template_versions v
     where v.template_id = t_id and v.body like '%{Office - Company Name}%'
       and v.version = (select max(version) from public.document_template_versions where template_id = t_id)
  );
end $$;