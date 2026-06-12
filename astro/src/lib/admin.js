// Admin cookie helpers. The cookie value is the ADMIN_TOKEN itself; httpOnly
// keeps it out of client JS. Compared in constant time on every write.

const COOKIE = 'rmt_admin';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function eq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function isAdmin(cookies) {
  const token = import.meta.env.ADMIN_TOKEN;
  if (!token) return false;
  const got = cookies.get(COOKIE)?.value;
  return Boolean(got) && eq(got, token);
}

export function setAdminCookie(cookies) {
  const token = import.meta.env.ADMIN_TOKEN;
  if (!token) return false;
  cookies.set(COOKIE, token, {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: MAX_AGE,
  });
  return true;
}

export function clearAdminCookie(cookies) {
  cookies.delete(COOKIE, { path: '/' });
}

export function checkToken(submitted) {
  const token = import.meta.env.ADMIN_TOKEN;
  return Boolean(token) && eq(String(submitted ?? ''), token);
}
