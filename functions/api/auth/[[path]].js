// /api/auth/* — accounts and household linking.
//
// Anyone can sign up with an email and password. Two accounts become a household by invite:
// one member invites the other's email, the other accepts (signed in with that email, or via
// the invite link). Until then the rest of the API is closed to them (see _middleware.js).
//
//   GET  status               -> { authed, user }
//   POST signup | login | logout | reset
//   GET  invite/:code         -> public: who sent an invite link (for the sign-up screen)
//   GET  link                 -> linking screen: household members, invites to me, invites I sent
//   POST invite               -> { email } invite someone to your household
//   POST invite/:id/cancel    -> withdraw an invite you sent
//   POST accept               -> { invite_id } or { code }
//   POST decline              -> { invite_id }
//   POST reset-code           -> { user_id } a member makes a one-time reset code for another (24 h)
//   GET  accounts             -> household members
//   PATCH me                  -> name / role / password
//   POST logout-everywhere

import {
  hashPassword, verifyPassword, checkPassword, makeSession, sessionCookie, clearCookie,
  newCode, hashCode,
} from '../../../lib/auth.js';
import { createHousehold, getMembers } from '../../../lib/household.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const bad = (msg, status = 400, extra = {}) => json({ error: msg, ...extra }, status);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;
const MAX_MEMBERS = 6;
const INVITE_DAYS = 14;

const publicUser = (u) => u && {
  id: u.id, email: u.email, name: u.name, role: u.role,
  household_id: u.household_id ?? null, linked: !!u.linked,
};

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('Enter a valid email address.');
  return e;
}
function cleanName(v) {
  const n = String(v || '').replace(/\s+/g, ' ').trim();
  if (n.length < 1 || n.length > 40) throw new Error('Name: 1–40 characters.');
  return n;
}
const cleanRole = (v) => (v === 'fixer' ? 'fixer' : 'requester');

async function withLinked(db, user) {
  if (!user.household_id) return { ...user, linked: false };
  const n = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE household_id = ?').bind(user.household_id).first();
  return { ...user, linked: n.n >= 2 };
}

async function signedIn(env, db, user, body = {}, status = 200) {
  const u = await withLinked(db, user);
  return json({ ok: true, ...body, user: publicUser(u) }, status, { 'set-cookie': sessionCookie(await makeSession(env, user)) });
}

const pendingInvite = (db, where, ...binds) => db.prepare(
  `SELECT i.*, u.name AS from_name, u.email AS from_email FROM invites i JOIN users u ON u.id = i.from_user
   WHERE i.status = 'pending' AND i.expires_at > datetime('now') AND ${where}`,
).bind(...binds).first();

// ---------- sign up / sign in ----------

async function signup(env, db, body) {
  const email = cleanEmail(body.email);
  const pwErr = checkPassword(body.password);
  if (pwErr) return bad(pwErr);
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    return bad('There’s already an account with that email. Sign in instead.', 409);
  }
  const user = await db.prepare(
    "INSERT INTO users (email, name, role, pw, last_login_at) VALUES (?, ?, ?, ?, datetime('now')) RETURNING *",
  ).bind(email, cleanName(body.name), cleanRole(body.role), await hashPassword(body.password)).first();
  return signedIn(env, db, user, {}, 201);
}

async function login(env, db, body) {
  let email;
  try { email = cleanEmail(body.email); } catch { await sleep(600); return bad('Wrong email or password.', 401); }
  const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) { await sleep(600); return bad('Wrong email or password.', 401); }
  if (user.locked_until && user.locked_until > new Date().toISOString().replace('T', ' ').slice(0, 19)) {
    return bad(`Too many wrong tries. Wait ${LOCK_MINUTES} minutes, or ask your partner for a reset code.`, 429);
  }
  if (!(await verifyPassword(String(body.password || ''), user.pw))) {
    const failed = user.failed + 1;
    await db.prepare(
      `UPDATE users SET failed = ?, locked_until = ${failed >= LOCK_AFTER ? `datetime('now', '+${LOCK_MINUTES} minutes')` : 'NULL'} WHERE id = ?`,
    ).bind(failed >= LOCK_AFTER ? 0 : failed, user.id).run();
    await sleep(600);
    return bad('Wrong email or password.', 401);
  }
  await db.prepare("UPDATE users SET failed = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();
  return signedIn(env, db, user);
}

// ---------- linking ----------

async function inviteInfo(db, code) {
  const inv = await pendingInvite(db, 'i.code_hash = ?', await hashCode(code));
  if (!inv) return bad('This invite has expired or was already used. Ask for a new one.', 404);
  return json({ from_name: inv.from_name, to_email: inv.to_email });
}

async function linkState(db, me) {
  const members = me.household_id ? await getMembers(db, me.household_id) : [];
  const forMe = await db.prepare(
    `SELECT i.id, i.created_at, u.name AS from_name, u.email AS from_email FROM invites i JOIN users u ON u.id = i.from_user
     WHERE i.to_email = ? AND i.status = 'pending' AND i.expires_at > datetime('now') ORDER BY i.id DESC`,
  ).bind(me.email).all();
  const sent = await db.prepare(
    `SELECT id, to_email, status, created_at, expires_at FROM invites
     WHERE from_user = ? AND status = 'pending' AND expires_at > datetime('now') ORDER BY id DESC`,
  ).bind(me.id).all();
  return json({ user: publicUser(me), members, invites_for_me: forMe.results, sent: sent.results });
}

async function invite(db, me, body, origin) {
  const email = cleanEmail(body.email);
  if (email === me.email) return bad('That’s your own email. Enter your partner’s.');
  let hh = me.household_id;
  if (hh) {
    const members = await db.prepare('SELECT email FROM users WHERE household_id = ?').bind(hh).all();
    if (members.results.some((m) => m.email === email)) return bad('They’re already in your household.');
    if (members.results.length >= MAX_MEMBERS) return bad(`A household can have up to ${MAX_MEMBERS} people.`);
  } else {
    hh = await createHousehold(db); // your household starts when you send your first invite
    await db.prepare('UPDATE users SET household_id = ? WHERE id = ?').bind(hh, me.id).run();
  }
  const code = newCode();
  await db.batch([
    db.prepare("UPDATE invites SET status = 'cancelled' WHERE from_user = ? AND to_email = ? AND status = 'pending'").bind(me.id, email),
    db.prepare(`INSERT INTO invites (household_id, from_user, to_email, code_hash, expires_at)
                VALUES (?, ?, ?, ?, datetime('now', '+${INVITE_DAYS} days'))`).bind(hh, me.id, email, await hashCode(code)),
  ]);
  const exists = !!(await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first());
  return json({ ok: true, to_email: email, code, url: `${origin}/?invite=${code}`, has_account: exists, from_name: me.name });
}

async function accept(env, db, me, body) {
  let inv;
  if (body.code) inv = await pendingInvite(db, 'i.code_hash = ?', await hashCode(body.code));
  else inv = await pendingInvite(db, 'i.id = ? AND i.to_email = ?', Number(body.invite_id), me.email);
  if (!inv) return bad('This invite has expired, was withdrawn, or is for a different email.', 404);
  if (inv.from_user === me.id) return bad('That’s your own invite — send it to your partner.');

  if (me.household_id && me.household_id !== inv.household_id) {
    const others = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE household_id = ? AND id != ?')
      .bind(me.household_id, me.id).first();
    if (others.n > 0) return bad('You’re already linked with someone. One household per account.', 409);
  }
  const members = await getMembers(db, inv.household_id);
  if (members.length >= MAX_MEMBERS) return bad(`That household already has ${MAX_MEMBERS} people.`, 409);
  if (members.some((m) => m.name.toLowerCase() === me.name.toLowerCase())) {
    return bad(`${inv.from_name}'s household already has someone called ${me.name}. Change your name below, then accept.`, 409, { code: 'name_taken' });
  }

  // One transaction (D1 batch): either everything below happens or nothing does.
  const stmts = [db.prepare('UPDATE users SET household_id = ? WHERE id = ?').bind(inv.household_id, me.id)];
  const old = me.household_id;
  if (old && old !== inv.household_id) {
    // An empty household you started by inviting first: remove it (its invites reference it).
    stmts.push(
      db.prepare('DELETE FROM invites WHERE household_id = ?').bind(old),
      db.prepare('DELETE FROM settings WHERE household_id = ?').bind(old),
      db.prepare('DELETE FROM rewards WHERE household_id = ?').bind(old),
      db.prepare('DELETE FROM households WHERE id = ?').bind(old),
    );
  }
  stmts.push(
    db.prepare("UPDATE invites SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?").bind(inv.id),
    // Any other pending invites to this email are moot now.
    db.prepare("UPDATE invites SET status = 'cancelled' WHERE to_email = ? AND status = 'pending' AND id != ?").bind(me.email, inv.id),
    db.prepare("INSERT INTO notifications (household_id, recipient, ticket_id, actor, kind, body) VALUES (?, ?, NULL, ?, 'new', ?)")
      .bind(inv.household_id, inv.from_name, me.name, `🎉 ${me.name} accepted your invite. You're linked on Daddy-Do!`),
  );
  await db.batch(stmts);
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
  user.linked = true;
  return json({ ok: true, user: publicUser(user) });
}

async function decline(db, me, body) {
  await db.prepare("UPDATE invites SET status = 'declined' WHERE id = ? AND to_email = ? AND status = 'pending'")
    .bind(Number(body.invite_id), me.email).run();
  return linkState(db, me);
}

async function cancelInvite(db, me, id) {
  await db.prepare("UPDATE invites SET status = 'cancelled' WHERE id = ? AND from_user = ? AND status = 'pending'")
    .bind(Number(id), me.id).run();
  return linkState(db, me);
}

// ---------- passwords & account ----------

async function createResetCode(db, me, body) {
  const target = await db.prepare('SELECT id, name FROM users WHERE id = ? AND household_id = ?')
    .bind(Number(body.user_id), me.household_id).first();
  if (!target || !me.household_id) return bad('You can only make reset codes for people in your household.', 404);
  const code = newCode();
  await db.prepare(
    "INSERT INTO reset_codes (code_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, datetime('now', '+24 hours'))",
  ).bind(await hashCode(code), target.id, me.id).run();
  return json({ code, for: target.name, expires_in_hours: 24 });
}

async function resetPassword(env, db, body) {
  const row = await db.prepare(
    "SELECT * FROM reset_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
  ).bind(await hashCode(body.code)).first();
  if (!row) { await sleep(600); return bad('That reset code is wrong or has expired.', 404); }
  const pwErr = checkPassword(body.password);
  if (pwErr) return bad(pwErr);
  const user = await db.prepare(
    "UPDATE users SET pw = ?, session_v = session_v + 1, failed = 0, locked_until = NULL, last_login_at = datetime('now') WHERE id = ? RETURNING *",
  ).bind(await hashPassword(body.password), row.user_id).first();
  await db.prepare("UPDATE reset_codes SET used_at = datetime('now') WHERE id = ?").bind(row.id).run();
  return signedIn(env, db, user);
}

async function accounts(db, me) {
  if (!me.household_id) return json({ accounts: [] });
  const { results } = await db.prepare(
    'SELECT id, name, email, role, last_login_at FROM users WHERE household_id = ? ORDER BY id',
  ).bind(me.household_id).all();
  return json({ accounts: results.map((u) => ({ ...u, you: u.id === me.id })) });
}

async function updateMe(env, db, me, body) {
  const full = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
  const stmts = [];
  let reissue = false;
  if (body.name !== undefined) {
    const name = cleanName(body.name);
    if (name !== full.name) {
      const hh = full.household_id;
      if (hh) {
        const clash = await db.prepare('SELECT 1 FROM users WHERE household_id = ? AND id != ? AND lower(name) = lower(?)')
          .bind(hh, me.id, name).first();
        if (clash) return bad(`Someone in your household is already called ${name}.`);
      }
      stmts.push(db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(name, me.id));
      if (hh) {
        // Names are how Do's, comments, notifications and points refer to people: rename them all.
        const old = full.name;
        for (const [table, col] of [['tickets', 'requester'], ['tickets', 'assignee'], ['comments', 'author'],
          ['notifications', 'recipient'], ['notifications', 'actor'], ['points', 'member']]) {
          stmts.push(db.prepare(`UPDATE ${table} SET ${col} = ? WHERE household_id = ? AND ${col} = ?`).bind(name, hh, old));
        }
      }
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
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
  user.linked = me.linked;
  return reissue ? signedIn(env, db, user) : json({ ok: true, user: publicUser(user) });
}

// ---------- router ----------

export async function onRequest({ request, env, params, data }) {
  const db = env.DB;
  const me = data.user;
  const [a, b, c] = params.path || [];
  const m = request.method;
  const body = m === 'GET' ? {} : await request.json().catch(() => ({}));
  const origin = new URL(request.url).origin;

  try {
    if (a === 'status' && m === 'GET') return json({ authed: !!me, user: publicUser(me) });
    if (a === 'signup' && m === 'POST') return await signup(env, db, body);
    if (a === 'login' && m === 'POST') return await login(env, db, body);
    if (a === 'logout' && m === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    if (a === 'reset' && m === 'POST') return await resetPassword(env, db, body);
    if (a === 'invite' && b && !c && m === 'GET') return await inviteInfo(db, b);

    if (!me) return bad('Not logged in', 401);
    if (a === 'link' && m === 'GET') return await linkState(db, me);
    if (a === 'invite' && !b && m === 'POST') return await invite(db, me, body, origin);
    if (a === 'invite' && b && c === 'cancel' && m === 'POST') return await cancelInvite(db, me, b);
    if (a === 'accept' && m === 'POST') return await accept(env, db, me, body);
    if (a === 'decline' && m === 'POST') return await decline(db, me, body);
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
