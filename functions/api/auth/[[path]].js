// /api/auth/* — household accounts.
//
//   GET  status            -> { setup_needed, authed, user }
//   POST setup             -> first account; needs the old household passphrase (HOUSEHOLD_PIN)
//   POST login / logout
//   POST invite            -> one-time link for the partner to join (7 days)
//   GET  invite/:code      -> what the invite is for (shown on the join screen)
//   POST join              -> create an account from an invite; linked to the household
//   POST reset-code        -> a member makes a one-time password-reset code for another (24 h)
//   POST reset             -> set a new password with that code
//   GET  accounts          -> household members
//   PATCH me               -> change your name, role or password
//   POST logout-everywhere -> sign out all your devices
//
// One site = one household. Names are what appear on Do's, so a rename updates every reference.

import {
  hashPassword, verifyPassword, checkPassword, makeSession, sessionCookie, clearCookie,
  newCode, hashCode, pinMatches,
} from '../../../lib/auth.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

const publicUser = (u) => u && { id: u.id, name: u.name, username: u.username, role: u.role };

function cleanUsername(v) {
  const u = String(v || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(u)) throw new Error('Username: 3–30 letters, numbers, dots, dashes or underscores.');
  return u;
}
function cleanName(v) {
  const n = String(v || '').replace(/\s+/g, ' ').trim();
  if (n.length < 1 || n.length > 40) throw new Error('Name: 1–40 characters.');
  return n;
}
const cleanRole = (v) => (v === 'fixer' ? 'fixer' : 'requester');

// settings.members mirrors the accounts; the rest of the app (notifications, Whisper prompt) reads it.
async function syncMembers(db) {
  const { results } = await db.prepare('SELECT name, role FROM users ORDER BY id').all();
  await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('members', ?)")
    .bind(JSON.stringify(results.map((u) => ({ name: u.name, role: u.role })))).run();
}

async function signedIn(env, user, body, status = 200) {
  return json({ ...body, user: publicUser(user) }, status, { 'set-cookie': sessionCookie(await makeSession(env, user)) });
}

async function nameTaken(db, name, exceptId = 0) {
  return db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE AND id != ?').bind(name, exceptId).first();
}

async function createUser(db, { username, name, role, password }) {
  if (await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) throw new Error('That username is taken.');
  if (await nameTaken(db, name)) throw new Error(`Someone in the household is already called ${name}.`);
  const user = await db.prepare(
    'INSERT INTO users (username, name, role, pw, last_login_at) VALUES (?, ?, ?, ?, datetime(\'now\')) RETURNING *',
  ).bind(username, name, role, await hashPassword(password)).first();
  await syncMembers(db);
  return user;
}

async function useCode(db, code, kind) {
  const row = await db.prepare(
    "SELECT * FROM codes WHERE code_hash = ? AND kind = ? AND used_at IS NULL AND expires_at > datetime('now')",
  ).bind(await hashCode(code), kind).first();
  return row || null;
}

// ---------- handlers ----------

async function status(db, user) {
  const n = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return json({ setup_needed: n.n === 0, authed: !!user, user: publicUser(user) });
}

async function setup(env, db, body) {
  const n = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  if (n.n > 0) return bad('This household is already set up. Sign in, or ask for an invite link.', 409);
  if (!(await pinMatches(env, body.pin))) {
    await sleep(800);
    return bad('That household passphrase is wrong.', 401);
  }
  const pwErr = checkPassword(body.password);
  if (pwErr) return bad(pwErr);
  const user = await createUser(db, {
    username: cleanUsername(body.username), name: cleanName(body.name), role: cleanRole(body.role), password: body.password,
  });
  return signedIn(env, user, { ok: true });
}

async function login(env, db, body) {
  let username;
  try { username = cleanUsername(body.username); } catch { await sleep(600); return bad('Wrong username or password.', 401); }
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  if (!user) { await sleep(600); return bad('Wrong username or password.', 401); }
  if (user.locked_until && user.locked_until > new Date().toISOString().replace('T', ' ').slice(0, 19)) {
    return bad(`Too many wrong tries. Wait ${LOCK_MINUTES} minutes, or ask your partner for a reset code.`, 429);
  }
  if (!(await verifyPassword(String(body.password || ''), user.pw))) {
    const failed = user.failed + 1;
    await db.prepare(
      `UPDATE users SET failed = ?, locked_until = ${failed >= LOCK_AFTER ? `datetime('now', '+${LOCK_MINUTES} minutes')` : 'NULL'} WHERE id = ?`,
    ).bind(failed >= LOCK_AFTER ? 0 : failed, user.id).run();
    await sleep(600);
    return bad('Wrong username or password.', 401);
  }
  await db.prepare("UPDATE users SET failed = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();
  return signedIn(env, user, { ok: true });
}

async function createInvite(db, me, body, origin) {
  const code = newCode();
  const role = body.role ? cleanRole(body.role) : (me.role === 'fixer' ? 'requester' : 'fixer');
  const nameHint = body.name ? cleanName(body.name) : null;
  const row = await db.prepare(
    "INSERT INTO codes (code_hash, kind, role, name_hint, created_by, expires_at) VALUES (?, 'invite', ?, ?, ?, datetime('now', '+7 days')) RETURNING expires_at",
  ).bind(await hashCode(code), role, nameHint, me.id).first();
  return json({ code, role, url: `${origin}/?invite=${code}`, expires_at: row.expires_at });
}

async function inviteInfo(db, code) {
  const row = await useCode(db, code, 'invite');
  if (!row) return bad('This invite link has expired or was already used. Ask for a new one.', 404);
  const by = await db.prepare('SELECT name FROM users WHERE id = ?').bind(row.created_by).first();
  return json({ valid: true, role: row.role, name_hint: row.name_hint, invited_by: by?.name || 'Someone' });
}

async function join(env, db, body) {
  const invite = await useCode(db, body.code, 'invite');
  if (!invite) return bad('This invite link has expired or was already used. Ask for a new one.', 404);
  const pwErr = checkPassword(body.password);
  if (pwErr) return bad(pwErr);
  const user = await createUser(db, {
    username: cleanUsername(body.username), name: cleanName(body.name), role: invite.role || 'requester', password: body.password,
  });
  await db.batch([
    db.prepare("UPDATE codes SET used_at = datetime('now') WHERE id = ?").bind(invite.id),
    db.prepare("INSERT INTO notifications (recipient, ticket_id, actor, kind, body) SELECT name, NULL, ?, 'new', ? FROM users WHERE id = ?")
      .bind(user.name, `🎉 ${user.name} joined the household on Daddy-Do`, invite.created_by),
  ]);
  return signedIn(env, user, { ok: true }, 201);
}

async function createResetCode(db, me, body) {
  const target = await db.prepare('SELECT id, name FROM users WHERE id = ?').bind(Number(body.user_id)).first();
  if (!target) return bad('No such member.', 404);
  const code = newCode();
  await db.prepare(
    "INSERT INTO codes (code_hash, kind, user_id, created_by, expires_at) VALUES (?, 'reset', ?, ?, datetime('now', '+24 hours'))",
  ).bind(await hashCode(code), target.id, me.id).run();
  return json({ code, for: target.name, expires_in_hours: 24 });
}

async function resetPassword(env, db, body) {
  const row = await useCode(db, body.code, 'reset');
  if (!row) { await sleep(600); return bad('That reset code is wrong or has expired.', 404); }
  const pwErr = checkPassword(body.password);
  if (pwErr) return bad(pwErr);
  const user = await db.prepare(
    "UPDATE users SET pw = ?, session_v = session_v + 1, failed = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ? RETURNING *",
  ).bind(await hashPassword(body.password), row.user_id).first();
  await db.prepare("UPDATE codes SET used_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return signedIn(env, user, { ok: true });
}

async function accounts(db, me) {
  const { results } = await db.prepare('SELECT id, name, username, role, last_login_at FROM users ORDER BY id').all();
  return json({ accounts: results.map((u) => ({ ...u, you: u.id === me.id })) });
}

async function updateMe(env, db, me, body) {
  const full = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
  const stmts = [];
  let reissue = false;
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (name !== full.name) {
      if (await nameTaken(db, name, me.id)) return bad(`Someone in the household is already called ${name}.`);
      const old = full.name;
      // Names are how Do's, comments, notifications and points refer to people: rename them all.
      stmts.push(
        db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, me.id),
        db.prepare('UPDATE tickets SET requester = ? WHERE requester = ?').bind(name, old),
        db.prepare('UPDATE tickets SET assignee = ? WHERE assignee = ?').bind(name, old),
        db.prepare('UPDATE comments SET author = ? WHERE author = ?').bind(name, old),
        db.prepare('UPDATE notifications SET recipient = ? WHERE recipient = ?').bind(name, old),
        db.prepare('UPDATE notifications SET actor = ? WHERE actor = ?').bind(name, old),
        db.prepare('UPDATE points SET member = ? WHERE member = ?').bind(name, old),
      );
    }
  }
  if (body.role !== undefined) stmts.push(db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(cleanRole(body.role), me.id));
  if (body.password !== undefined) {
    if (!(await verifyPassword(String(body.current_password || ''), full.pw))) {
      await sleep(600);
      return bad('Your current password is wrong.', 401);
    }
    const pwErr = checkPassword(body.password);
    if (pwErr) return bad(pwErr);
    stmts.push(db.prepare('UPDATE users SET pw = ?, session_v = session_v + 1 WHERE id = ?').bind(await hashPassword(body.password), me.id));
    reissue = true; // other devices get signed out; keep this one signed in
  }
  if (stmts.length) await db.batch(stmts);
  await syncMembers(db);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
  return reissue ? signedIn(env, user, { ok: true }) : json({ ok: true, user: publicUser(user) });
}

// ---------- router ----------

export async function onRequest({ request, env, params, data }) {
  const db = env.DB;
  const me = data.user;
  const [a, b] = params.path || [];
  const m = request.method;
  const body = m === 'GET' ? {} : await request.json().catch(() => ({}));
  const origin = new URL(request.url).origin;

  try {
    if (a === 'status' && m === 'GET') return await status(db, me);
    if (a === 'setup' && m === 'POST') return await setup(env, db, body);
    if (a === 'login' && m === 'POST') return await login(env, db, body);
    if (a === 'logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    if (a === 'invite' && b && m === 'GET') return await inviteInfo(db, b);
    if (a === 'join' && m === 'POST') return await join(env, db, body);
    if (a === 'reset' && m === 'POST') return await resetPassword(env, db, body);

    if (!me) return bad('Not logged in', 401);
    if (a === 'invite' && !b && m === 'POST') return await createInvite(db, me, body, origin);
    if (a === 'reset-code' && m === 'POST') return await createResetCode(db, me, body);
    if (a === 'accounts' && m === 'GET') return await accounts(db, me);
    if (a === 'me' && m === 'PATCH') return await updateMe(env, db, me, body);
    if (a === 'logout-everywhere' && m === 'POST') {
      await db.prepare('UPDATE users SET session_v = session_v + 1 WHERE id = ?').bind(me.id).run();
      return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    }
    return bad('Not found', 404);
  } catch (err) {
    return bad(err.message || 'Bad request');
  }
}
