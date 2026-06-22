import { checkToken, setAdminCookie, clearAdminCookie, isAdmin } from '../lib/admin.js';

export const prerender = false;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// GET  /api/auth         → { admin: bool }
// POST /api/auth { token } → sets httpOnly admin cookie if token matches
// DELETE /api/auth       → clears cookie
export function GET({ cookies }) {
  return json({ admin: isAdmin(cookies) });
}

export async function POST({ request, cookies }) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'bad_json' }, 400); }
  if (!checkToken(body?.token)) return json({ error: 'invalid_token' }, 401);
  setAdminCookie(cookies);
  return json({ ok: true });
}

export function DELETE({ cookies }) {
  clearAdminCookie(cookies);
  return json({ ok: true });
}
