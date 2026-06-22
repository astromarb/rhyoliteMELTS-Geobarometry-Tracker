import { supabase, cloudConfigured, SNAPSHOT_ID } from '../../lib/supabase.js';
import { isAdmin } from '../../lib/admin.js';

export const prerender = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// POST /api/snapshot/restore  { id: <history_row_id> }
// Copies the named history row's data back onto the main snapshot. The current
// main row is automatically archived by the snapshots_archive trigger.
export async function POST({ request, cookies }) {
  if (!cloudConfigured) return json({ error: 'cloud_not_configured' }, 503);
  if (!isAdmin(cookies))  return json({ error: 'unauthorized' }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'bad_json' }, 400); }
  const histId = Number(body?.id);
  if (!Number.isFinite(histId)) return json({ error: 'missing_id' }, 400);

  const { data: row, error: readErr } = await supabase
    .from('snapshot_history').select('data')
    .eq('id', histId).maybeSingle();
  if (readErr) return json({ error: readErr.message }, 500);
  if (!row)    return json({ error: 'not_found' }, 404);

  const { error: writeErr } = await supabase.from('snapshots').upsert({
    id: SNAPSHOT_ID,
    data: row.data,
    updated_at: new Date().toISOString(),
    updated_by: `restore from #${histId}`,
  });
  if (writeErr) return json({ error: writeErr.message }, 500);
  return json({ ok: true });
}
