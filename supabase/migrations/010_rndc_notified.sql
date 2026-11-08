-- The assistant tells the person (WhatsApp) whether the manifest reached the Ministry (RNDC) once the background watcher knows.
-- This timestamp makes that notice happen exactly once even if two watcher invocations overlap.
alter table public.silog_confirmaciones add column if not exists rndc_notified_at timestamptz;
