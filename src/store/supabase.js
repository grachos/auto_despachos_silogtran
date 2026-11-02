// Server-side Supabase client (service key; never expose to clients).
import { createClient } from '@supabase/supabase-js';

let client = null;

export function supabase() {
  if (!client) {
    client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
