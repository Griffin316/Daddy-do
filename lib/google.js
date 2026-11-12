// Google OAuth + Gmail API helpers (plain fetch; works in Cloudflare Workers).
//
// Privacy: email bodies are never stored. Only the OAuth refresh/access tokens (encrypted) and,
// for threads linked to a Do, the thread id + subject + correspondent are kept in D1.

import { encryptSecret, decryptSecret } from './secrets.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly', // read threads
  'https://www.googleapis.com/auth/gmail.compose',  // create drafts and send replies
];

// Overridable for local tests only.
const authUrl = (env) => env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const tokenUrl = (env) => env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const revokeUrl = (env) => env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const gmailBase = (env) => env.GMAIL_API_BASE || 'https://gmail.googleapis.com';

export class GmailError extends Error {
  constructor(message, status = 502, code = '') { super(message); this.status = status; this.code = code; }
}

// ---- app-wide OAuth client (set once by the site owner in Settings, or as Cloudflare secrets) ----
export async function oauthClient(env, db) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET, source: 'cloudflare' };
  }
  const { results } = await db.prepare("SELECT key, value FROM app_config WHERE key IN ('google_client_id','google_client_secret_enc')").all();
  const c = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const secret = c.google_client_secret_enc ? await decryptSecret(env, c.google_client_secret_enc) : null;
  return c.google_client_id && secret ? { id: c.google_client_id, secret, source: 'app' } : null;
}

export async function saveOauthClient(env, db, id, secret) {
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('google_client_id', ?)").bind(id),
    db.prepare("INSERT OR REPLACE INTO app_config (key, value) VALUES ('google_client_secret_enc', ?)").bind(await encryptSecret(env, secret)),
  ]);
}

export const redirectUri = (origin) => `${origin}/api/gmail/callback`;

export function consentUrl(env, client, origin, state, loginHint) {
  const p = new URLSearchParams({
    client_id: client.id,
    redirect_uri: redirectUri(origin),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',  // we need a refresh token
    prompt: 'consent',       // ...every time, so reconnecting always yields one
    include_granted_scopes: 'true',
    state,
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `${authUrl(env)}?${p}`;
}

async function tokenRequest(env, params) {
  const res = await fetch(tokenUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.error === 'invalid_grant') throw new GmailError('Gmail access expired or was removed. Tap Connect Gmail again.', 401, 'reconnect');
    if (data.error === 'invalid_client') throw new GmailError('The Google client ID/secret in Settings → Gmail is wrong.', 500, 'bad_client');
    throw new GmailError(`Google sign-in failed: ${data.error_description || data.error || res.status}`);
  }
  return data;
}

export async function exchangeCode(env, client, origin, code) {
  return tokenRequest(env, {
    code, client_id: client.id, client_secret: client.secret, redirect_uri: redirectUri(origin), grant_type: 'authorization_code',
  });
}

export async function saveAccount(env, db, userId, email, tokens) {
  const exp = Date.now() + (Number(tokens.expires_in || 3600) - 60) * 1000;
  await db.prepare(
    `INSERT INTO gmail_accounts (user_id, email, refresh_enc, access_enc, access_exp, connected_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, refresh_enc = excluded.refresh_enc,
       access_enc = excluded.access_enc, access_exp = excluded.access_exp, connected_at = excluded.connected_at`,
  ).bind(userId, email, await encryptSecret(env, tokens.refresh_token), await encryptSecret(env, tokens.access_token), exp).run();
}

export const getAccount = (db, userId) => db.prepare('SELECT * FROM gmail_accounts WHERE user_id = ?').bind(userId).first();

// A valid access token for this user, refreshing it when needed.
async function accessToken(env, db, userId) {
  const acct = await getAccount(db, userId);
  if (!acct) throw new GmailError('Connect your Gmail first (⚙︎ Settings → Gmail).', 409, 'not_connected');
  if (acct.access_exp > Date.now()) {
    const tok = await decryptSecret(env, acct.access_enc);
    if (tok) return tok;
  }
  const client = await oauthClient(env, db);
  if (!client) throw new GmailError('Gmail isn’t set up on this site yet.', 503, 'not_configured');
  const refresh = await decryptSecret(env, acct.refresh_enc);
  if (!refresh) throw new GmailError('Gmail access needs to be renewed. Tap Connect Gmail again.', 401, 'reconnect');
  let data;
  try {
    data = await tokenRequest(env, { refresh_token: refresh, client_id: client.id, client_secret: client.secret, grant_type: 'refresh_token' });
  } catch (e) {
    if (e.code === 'reconnect') await db.prepare('DELETE FROM gmail_accounts WHERE user_id = ?').bind(userId).run();
    throw e;
  }
  const exp = Date.now() + (Number(data.expires_in || 3600) - 60) * 1000;
  await db.prepare('UPDATE gmail_accounts SET access_enc = ?, access_exp = ? WHERE user_id = ?')
    .bind(await encryptSecret(env, data.access_token), exp, userId).run();
  return data.access_token;
}

export async function revoke(env, db, userId) {
  const acct = await getAccount(db, userId);
  if (acct) {
    const refresh = await decryptSecret(env, acct.refresh_enc);
    if (refresh) await fetch(`${revokeUrl(env)}?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
  }
  await db.prepare('DELETE FROM gmail_accounts WHERE user_id = ?').bind(userId).run();
}

// ---- Gmail REST ----
export async function gmail(env, db, userId, path, { method = 'GET', body, token } = {}) {
  const tok = token || await accessToken(env, db, userId);
  const res = await fetch(`${gmailBase(env)}/gmail/v1/users/me/${path}`, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new GmailError('Gmail access needs to be renewed. Tap Connect Gmail again.', 401, 'reconnect');
  if (res.status === 403) throw new GmailError('Gmail refused that request (missing permission?). Reconnect Gmail and allow all requested access.', 403, 'reconnect');
  if (res.status === 404) throw new GmailError('That email thread no longer exists.', 404);
  if (res.status === 429) throw new GmailError('Gmail is rate-limiting — try again in a minute.', 429);
  if (!res.ok) throw new GmailError(`Gmail error ${res.status}`);
  return res.json();
}

export async function profileEmail(env, accessTokenValue) {
  const res = await fetch(`${gmailBase(env)}/gmail/v1/users/me/profile`, { headers: { authorization: `Bearer ${accessTokenValue}` } });
  if (!res.ok) throw new GmailError('Could not read your Gmail address after connecting.');
  return (await res.json()).emailAddress.toLowerCase();
}

// ---- message parsing ----
const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

function b64urlToText(data) {
  if (!data) return '';
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function htmlToText(html) {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function findPart(part, mime) {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data) return part;
  for (const p of part.parts || []) {
    const hit = findPart(p, mime);
    if (hit) return hit;
  }
  return null;
}

function attachmentNames(part, out = []) {
  if (!part) return out;
  if (part.filename) out.push(part.filename);
  for (const p of part.parts || []) attachmentNames(p, out);
  return out;
}

// Drop the quoted earlier messages that most mail apps append, so each message shows only what's new.
function stripQuoted(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^On .{5,200}wrote:\s*$/.test(l) || (/^On /.test(l) && /wrote:\s*$/.test(lines[i + 1] || ''))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From: .+/.test(l) && /^(Sent|Date): /.test(lines[i + 1] || '')) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const nameOf = (from) => (from.match(/^\s*"?([^"<]+?)"?\s*</)?.[1] || from.replace(/<.*>/, '')).trim() || from;
export const addrOf = (from) => (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();

export function parseMessage(msg, myEmail) {
  const plain = findPart(msg.payload, 'text/plain');
  const html = plain ? null : findPart(msg.payload, 'text/html');
  const raw = plain ? b64urlToText(plain.body.data) : html ? htmlToText(b64urlToText(html.body.data)) : (msg.snippet || '');
  const from = header(msg, 'From');
  return {
    id: msg.id,
    from,
    from_name: nameOf(from),
    from_me: addrOf(from) === myEmail,
    to: header(msg, 'To'),
    cc: header(msg, 'Cc'),
    reply_to: header(msg, 'Reply-To'),
    date: header(msg, 'Date'),
    ts: Number(msg.internalDate || 0),
    subject: header(msg, 'Subject'),
    message_id: header(msg, 'Message-ID') || header(msg, 'Message-Id'),
    references: header(msg, 'References'),
    text: stripQuoted(raw).slice(0, 6000),
    attachments: attachmentNames(msg.payload),
  };
}

export function threadSummary(thread, myEmail) {
  const msgs = thread.messages || [];
  const first = msgs[0] || {};
  const last = msgs[msgs.length - 1] || {};
  const lastFrom = header(last, 'From');
  const other = [...msgs].reverse().map((m) => header(m, 'From')).find((f) => addrOf(f) !== myEmail) || lastFrom;
  return {
    id: thread.id,
    subject: header(first, 'Subject') || '(no subject)',
    correspondent: nameOf(other),
    last_from: nameOf(lastFrom),
    last_from_me: addrOf(lastFrom) === myEmail,
    snippet: last.snippet || thread.snippet || '',
    count: msgs.length,
    ts: Number(last.internalDate || 0),
    unread: msgs.some((m) => (m.labelIds || []).includes('UNREAD')),
  };
}

// ---- building a reply ----
function encodeHeader(v) {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(v)))}?=`;
}
function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64url = (str) => b64(new TextEncoder().encode(str)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Reply to the latest message from someone else (or the last message if it's all you).
export function buildReply(parsedMsgs, myEmail, bodyText, replyAll = false) {
  const target = [...parsedMsgs].reverse().find((m) => !m.from_me) || parsedMsgs[parsedMsgs.length - 1];
  const to = target.from_me ? target.to : (target.reply_to || target.from);
  const ccList = replyAll
    ? [target.to, target.cc].join(',').split(',').map((s) => s.trim()).filter((s) => s && addrOf(s) !== myEmail && addrOf(s) !== addrOf(to))
    : [];
  const subj = target.subject || parsedMsgs[0]?.subject || '';
  const subject = /^re:/i.test(subj) ? subj : `Re: ${subj}`;
  const refs = [target.references, target.message_id].filter(Boolean).join(' ').trim();
  const lines = [
    `To: ${to}`,
    ...(ccList.length ? [`Cc: ${ccList.join(', ')}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    ...(target.message_id ? [`In-Reply-To: ${target.message_id}`] : []),
    ...(refs ? [`References: ${refs}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(new TextEncoder().encode(bodyText)).replace(/.{76}/g, '$&\r\n'),
  ];
  return { raw: b64url(lines.join('\r\n')), to, cc: ccList, subject };
}
