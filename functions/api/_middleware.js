// Household auth: one shared passphrase (HOUSEHOLD_PIN) -> signed session cookie.
// Everything under /api except /api/login and /api/session requires the cookie.

const COOKIE = 'dd_session';
const MAX_AGE = 60 * 60 * 24 * 180; // 180 days — stay logged in on your phones

async function sign(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const pin = env.HOUSEHOLD_PIN;
  if (!pin) {
    return json({ error: 'Server not configured: set the HOUSEHOLD_PIN secret.' }, 500);
  }
  const secret = (env.SESSION_SECRET || '') + '|' + pin;
  const expected = await sign(secret, 'daddy-do-session-v1');

  if (url.pathname === '/api/login' && request.method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const given = String(body.pin || '');
    // Compare HMACs of the inputs so timing doesn't leak the PIN.
    const ok = safeEqual(await sign(secret, 'pin:' + given), await sign(secret, 'pin:' + pin));
    if (!ok) {
      await new Promise((r) => setTimeout(r, 800)); // slow down guessing
      return json({ error: 'Wrong passphrase' }, 401);
    }
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE}=${expected}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  if (url.pathname === '/api/logout' && request.method === 'POST') {
    return json({ ok: true }, 200, {
      'set-cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    });
  }

  const cookie = readCookie(request, COOKIE);
  const authed = cookie !== null && safeEqual(cookie, expected);

  if (url.pathname === '/api/session') return json({ authed });
  if (!authed) return json({ error: 'Not logged in' }, 401);

  try {
    return await next();
  } catch (err) {
    return json({ error: err.message || 'Server error' }, 500);
  }
}
