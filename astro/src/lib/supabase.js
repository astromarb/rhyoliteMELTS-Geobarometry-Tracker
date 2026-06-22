// Server-only Supabase client. Uses the service_role key, which bypasses
// RLS — never import this from anything that ships to the browser.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.SUPABASE_URL;
const key = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;

export const cloudConfigured = Boolean(url && key);

export const supabase = cloudConfigured
  ? createClient(url, key, { auth: { persistSession: false } })
  : null;

export const SNAPSHOT_ID = 'main';
