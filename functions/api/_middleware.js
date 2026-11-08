// Accounts auth: a signed session cookie identifies the signed-in member (lib/auth.js).
// - context.data.user = the member (with household_id and `linked`)
// - /api/auth/* handles sign-up, sign-in and linking; the rest of the API needs a linked
//   household (two or more members), so data is never shared until the invite is accepted.

import { readCookie, readSession } from '../../lib/auth.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Reachable without signing in.
const PUBLIC = new Set([
  'GET /api/auth/status',
  'POST /api/auth/signup',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/reset',
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (!env.SESSION_SECRET) return json({ error: 'Server not configured: set the SESSION_SECRET secret.' }, 500);

  let user = null;
  try {
    const s = await readSession(env, readCookie(request));
    if (s) {
      user = await env.DB.prepare(
        `SELECT u.id, u.email, u.name, u.role, u.household_id, u.session_v,
                (SELECT COUNT(*) FROM users m WHERE m.household_id = u.household_id) AS members
         FROM users u WHERE u.id = ?`,
      ).bind(s.u).first();
      if (user && user.session_v !== s.v) user = null; // signed out everywhere / password changed
      if (user) user.linked = !!user.household_id && user.members >= 2;
    }
  } catch {
    user = null;
  }
  context.data.user = user;

  const path = url.pathname.replace(/\/+$/, '');
  const isPublic = PUBLIC.has(`${request.method} ${path}`) || (request.method === 'GET' && /^\/api\/auth\/invite\/[^/]+$/.test(path));
  if (isPublic) return run(next);
  if (!user) return json({ error: 'Not logged in' }, 401);
  if (!path.startsWith('/api/auth/') && !user.linked) {
    return json({ error: 'Link your account with your partner first.', code: 'not_linked' }, 403);
  }
  return run(next);
}

async function run(next) {
  try {
    return await next();
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}
