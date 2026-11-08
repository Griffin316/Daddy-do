// Small at-rest encryption for API keys entered in the app (e.g. the Gemini key pasted on a phone).
// AES-GCM with a key derived from the SESSION_SECRET Cloudflare secret, so a copy of the
// database alone doesn't reveal the API key. Values are stored as "v1:<iv>:<ciphertext>" (base64).

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function aesKey(env) {
  const material = env.SESSION_SECRET;
  if (!material) throw new Error('SESSION_SECRET is not set');
  const hash = await crypto.subtle.digest('SHA-256', enc.encode('daddy-do/app-secrets/v1|' + material));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(env, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), enc.encode(plain));
  return `v1:${b64(iv)}:${b64(ct)}`;
}

export async function decryptSecret(env, stored) {
  if (!stored || !stored.startsWith('v1:')) return null;
  try {
    const [, iv, ct] = stored.split(':');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(env), unb64(ct));
    return dec.decode(pt);
  } catch {
    return null; // SESSION_SECRET changed, or the value is corrupt: treat as not set
  }
}

// Gemini key: a Cloudflare secret wins; otherwise the one this household saved in Settings.
export async function geminiKey(env, db, hh) {
  if (env.GEMINI_API_KEY) return { key: env.GEMINI_API_KEY, source: 'cloudflare' };
  const row = await db.prepare("SELECT value FROM settings WHERE household_id = ? AND key = 'gemini_key_enc'").bind(hh).first();
  const key = row ? await decryptSecret(env, row.value) : null;
  return key ? { key, source: 'app' } : { key: null, source: null };
}

export const keyHint = (k) => (k ? `…${k.slice(-4)}` : '');
