import { supabase, cloudConfigured, SNAPSHOT_ID } from '../../lib/supabase.js';
import { isAdmin } from '../../lib/admin.js';

export const prerender = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// GET /api/snapshot/history          → list (metadata only, no payload)
// GET /api/snapshot/history?id=42    → single full row (admin only)
export async function GET({ url, cookies }) {
  if (!cloudConfigured) return json({ error: 'cloud_not_configured' }, 503);

  const id = url.searchParams.get('id');
  if (id) {
    if (!isAdmin(cookies)) return json({ error: 'unauthorized' }, 401);
    const { data, error } = await supabase
      .from('snapshot_history').select('id, snapshot_id, data, saved_at, saved_by, note')
      .eq('id', Number(id)).maybeSingle();
    if (error) return json({ error: error.message }, 500);
    if (!data)  return json({ error: 'not_found' }, 404);
    return json(data);
  }

  const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
  const { data, error } = await supabase
    .from('snapshot_history').select('id, saved_at, saved_by, note')
    .eq('snapshot_id', SNAPSHOT_ID)
    .order('saved_at', { ascending: false })
    .limit(limit);
  if (error) return json({ error: error.message }, 500);
  return json({ history: data });
}
