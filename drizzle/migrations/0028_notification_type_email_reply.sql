-- A notice when a customer replies to a job email.
--
-- WRITTEN, NOT APPLIED. One enum value. Nothing existing changes. Until this is
-- applied the notice is sent as an 'automation_task' notification instead
-- (src/lib/info-reply.server.ts, notifyReplyReceived), so nobody misses it in
-- the meantime; this value lets it be named and switched off on its own under
-- Settings › Notifications.
--
-- David, 13 Oct: a reply to a request-for-information email landed on the job
-- (as suggested updates, or a "Review reply" task) with nothing telling anyone
-- it had arrived. The person who sent the request is now notified.

ALTER TYPE public.notification_type ADD VALUE IF NOT EXISTS 'email_reply_received';