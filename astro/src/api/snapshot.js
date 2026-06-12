import { supabase, cloudConfigured, SNAPSHOT_ID } from '../lib/supabase.js';
import { isAdmin } from '../lib/admin.js';

export const prerender = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export async function GET() {
  if (!cloudConfigured) return json({ error: 'cloud_not_configured' }, 503);
  const { data, error } = await supabase
    .from('snapshots').select('data, updated_at, updated_by')
    .eq('id', SNAPSHOT_ID).maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: 'not_found' }, 404);
  return json(data);
}

export async function PUT({ request, cookies }) {
  if (!cloudConfigured) return json({ error: 'cloud_not_configured' }, 503);
  if (!isAdmin(cookies))  return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'bad_json' }, 400); }
  if (!body || typeof body !== 'object' || !body.data || typeof body.data !== 'object')
    return json({ error: 'missing_data' }, 400);

  const { error } = await supabase.from('snapshots').upsert({
    id: SNAPSHOT_ID,
    data: body.data,
    updated_at: new Date().toISOString(),
    updated_by: body.note ? String(body.note).slice(0, 200) : 'admin',
  });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
}
