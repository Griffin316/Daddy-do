// Accounts: password hashing, signed session cookies and one-time codes (Web Crypto, Workers-safe).

const enc = new TextEncoder();
export const COOKIE = 'dd_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 180; // stay signed in on your phone for 180 days
const PBKDF2_ITER = 100000; // Workers' PBKDF2 maximum

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

const sessionSecret = (env) => {
  const s = env.SESSION_SECRET;
  if (!s) throw new Error('Server not configured: set the SESSION_SECRET secret.');
  return 'daddy-do/session/v2|' + s;
};

// ---- passwords ----
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
  return `pbkdf2$${PBKDF2_ITER}$${b64u(salt)}$${b64u(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored || '').split('$');
  if (alg !== 'pbkdf2') return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64u(salt), iterations: Number(iter) }, key, 256);
  return safeEqual(b64u(bits), hash);
}

export function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Use at least 8 characters for the password.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

// ---- sessions: "<payload>.<hmac>", payload = base64url(JSON {u: userId, v: sessionVersion, t: issuedAt}) ----
export async function makeSession(env, user) {
  const payload = b64u(enc.encode(JSON.stringify({ u: user.id, v: user.session_v, t: Date.now() })));
  return `${payload}.${await hmac(sessionSecret(env), payload)}`;
}

export async function readSession(env, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!safeEqual(sig, await hmac(sessionSecret(env), payload))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(unb64u(payload)));
    if (Date.now() - p.t > SESSION_MAX_AGE * 1000) return null;
    return p;
  } catch {
    return null;
  }
}

export const sessionCookie = (token) =>
  `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

export function readCookie(request, name = COOKIE) {
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

// ---- one-time codes (invites, password resets): easy to read aloud or type, stored hashed ----
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export async function hashCode(code) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode('daddy-do/code|' + normalizeCode(code)));
  return b64u(d);
}
