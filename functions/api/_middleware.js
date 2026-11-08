// Accounts auth: a signed session cookie identifies the signed-in member (lib/auth.js).
// The member is put on context.data.user; every API route uses it as the acting person,
// so a phone can no longer just claim to be "Mom" or "Dad".

import { readCookie, readSession } from '../../lib/auth.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

// Reachable without signing in.
const PUBLIC = new Set([
  'GET /api/auth/status',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/join',
  'POST /api/auth/reset',
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if (!env.SESSION_SECRET && !env.HOUSEHOLD_PIN) {
    return json({ error: 'Server not configured: set the SESSION_SECRET secret.' }, 500);
  }

  let user = null;
  try {
    const s = await readSession(env, readCookie(request));
    if (s) {
      user = await env.DB.prepare('SELECT id, username, name, role, session_v FROM users WHERE id = ?').bind(s.u).first();
      if (user && user.session_v !== s.v) user = null; // signed out everywhere / password changed
    }
  } catch {
    user = null;
  }
  context.data.user = user;

  const key = `${request.method} ${url.pathname.replace(/\/+$/, '')}`;
  const isPublic = PUBLIC.has(key) || (request.method === 'GET' && url.pathname.startsWith('/api/auth/invite/'));
  if (!user && !isPublic) return json({ error: 'Not logged in' }, 401);

  try {
    return await next();
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}
