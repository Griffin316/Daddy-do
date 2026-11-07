// Daddy-Do REST API (Cloudflare Pages Function, D1 binding "DB").
// Auth is handled by _middleware.js. The acting user's name comes in X-User.

const STATUSES = ['new', 'backlog', 'scheduled', 'in_progress', 'blocked', 'resolved', 'closed'];
const OPEN_STATUSES = ['new', 'backlog', 'scheduled', 'in_progress', 'blocked'];
const EDITABLE = [
  'title', 'description', 'assignee', 'priority', 'estimate_min', 'category',
  'location', 'status', 'blocked_reason', 'due_date', 'sprint_week', 'recur_days',
  'scheduled_for', 'scheduled_time',
];
const STATUS_LABEL = {
  new: 'New', backlog: 'Backlog', scheduled: 'Scheduled', in_progress: 'In progress',
  blocked: 'Blocked', resolved: 'Done', closed: 'Closed',
};

// ---------- points rules ----------
// Base points by size, multiplied by urgency. Bonuses for finishing on time and for her ✓.
const SIZE_POINTS = { 15: 10, 30: 20, 60: 35, 180: 80, 480: 180 };
const PRIORITY_MULT = { 1: 1.5, 2: 1.25, 3: 1, 4: 1 };
const THANKS_POINTS = 10;
function basePoints(t) {
  const base = SIZE_POINTS[t.estimate_min] ?? (t.estimate_min ? Math.round(t.estimate_min * 0.4) + 5 : 15);
  return Math.round(base * (PRIORITY_MULT[t.priority] || 1));
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const bad = (msg, status = 400) => json({ error: msg }, status);

function actorOf(request) {
  const raw = request.headers.get('x-user') || 'Someone';
  return decodeURIComponent(raw).slice(0, 40);
}

function addDays(dateStr, days) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00Z') : new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function prettyDate(dateStr, time) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const s = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (!time) return s;
  const [h, m] = time.split(':').map(Number);
  return `${s}, ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h < 12 ? 'am' : 'pm'}`;
}

function clean(field, value) {
  switch (field) {
    case 'title': {
      const v = String(value ?? '').trim().slice(0, 200);
      if (!v) throw new Error('Title is required');
      return v;
    }
    case 'description': return String(value ?? '').slice(0, 5000);
    case 'assignee':
    case 'category':
    case 'location':
    case 'blocked_reason': return String(value ?? '').trim().slice(0, 120);
    case 'priority': {
      const n = Number(value);
      if (![1, 2, 3, 4].includes(n)) throw new Error('Priority must be 1-4');
      return n;
    }
    case 'estimate_min':
    case 'recur_days': {
      const n = Math.round(Number(value) || 0);
      if (n < 0 || n > 100000) throw new Error(`${field} out of range`);
      return n;
    }
    case 'status':
      if (!STATUSES.includes(value)) throw new Error('Unknown status');
      return value;
    case 'due_date':
    case 'sprint_week':
    case 'scheduled_for':
      if (value === null || value === '' || value === undefined) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
      return value;
    case 'scheduled_time':
      if (value === null || value === '' || value === undefined) return null;
      if (!/^\d{2}:\d{2}$/.test(value)) throw new Error('scheduled_time must be HH:MM');
      return value;
    default:
      throw new Error('Unknown field ' + field);
  }
}

async function audit(db, ticketId, author, body) {
  await db.prepare('INSERT INTO comments (ticket_id, author, body, is_system) VALUES (?, ?, ?, 1)')
    .bind(ticketId, author, body).run();
}

async function getTicket(db, id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').bind(id).first();
}

async function getMembers(db) {
  const s = await db.prepare("SELECT value FROM settings WHERE key = 'members'").first();
  return JSON.parse(s?.value || '[]');
}

// Who should hear about something `actor` did on ticket `t`?
// Fixer updates go to the requester; requester activity goes to the fixers.
function recipientsFor(t, actor, members) {
  const out = new Set();
  if (t.requester && t.requester !== actor) out.add(t.requester);
  if (actor === t.requester) {
    for (const m of members) if (m.role === 'fixer' && m.name !== actor) out.add(m.name);
    if (t.assignee && t.assignee !== actor) out.add(t.assignee);
  }
  return [...out];
}

async function notify(db, recipients, ticketId, actor, kind, body) {
  if (!recipients.length) return;
  await db.batch(recipients.map((r) => db.prepare(
    'INSERT INTO notifications (recipient, ticket_id, actor, kind, body) VALUES (?, ?, ?, ?, ?)',
  ).bind(r, ticketId, actor, kind, body.slice(0, 500))));
}

// ---------- tickets ----------

const LIST_COLUMNS = `t.*,
  (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id AND c.is_system = 0) AS comment_count,
  (SELECT c.author || ': ' || c.body FROM comments c WHERE c.ticket_id = t.id AND c.is_system = 0
     ORDER BY c.id DESC LIMIT 1) AS last_update,
  (SELECT COALESCE(SUM(p.points), 0) FROM points p WHERE p.ticket_id = t.id AND p.points > 0) AS points_earned`;

async function listTickets(db, url) {
  const includeClosed = url.searchParams.get('closed') === '1';
  const sql = includeClosed
    ? `SELECT ${LIST_COLUMNS} FROM tickets t ORDER BY t.id DESC LIMIT 1000`
    : `SELECT ${LIST_COLUMNS} FROM tickets t
       WHERE t.status != 'closed' OR t.closed_at >= datetime('now', '-30 days')
       ORDER BY t.id DESC`;
  const { results } = await db.prepare(sql).all();
  return json({ tickets: results });
}

async function createTicket(db, request, actor) {
  const body = await request.json().catch(() => ({}));
  const t = {
    title: clean('title', body.title),
    description: clean('description', body.description ?? ''),
    priority: clean('priority', body.priority ?? 3),
    category: clean('category', body.category ?? 'general') || 'general',
    location: clean('location', body.location ?? ''),
    due_date: clean('due_date', body.due_date ?? null),
    estimate_min: clean('estimate_min', body.estimate_min ?? 0),
    assignee: clean('assignee', body.assignee ?? ''),
    recur_days: clean('recur_days', body.recur_days ?? 0),
  };
  const members = await getMembers(db);
  // Allow filing on behalf of another household member (e.g. Dad captures what Mom asked for).
  let requester = actor;
  if (body.requester && members.some((m) => m.name === String(body.requester))) requester = String(body.requester);

  const row = await db.prepare(
    `INSERT INTO tickets (title, description, requester, priority, category, location, due_date,
                          estimate_min, assignee, recur_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(t.title, t.description, requester, t.priority, t.category, t.location, t.due_date,
    t.estimate_min, t.assignee, t.recur_days).first();
  await audit(db, row.id, actor, requester === actor ? 'Opened ticket' : `Opened ticket on behalf of ${requester}`);
  if (requester === actor) {
    // Let the fixer(s) know a new request arrived.
    const fixers = members.filter((m) => m.role === 'fixer' && m.name !== actor).map((m) => m.name);
    await notify(db, fixers, row.id, actor, 'new', `New P${row.priority} request: ${row.title}`);
  }
  return json({ ticket: row }, 201);
}

async function awardCompletion(db, t, actor, members) {
  const already = await db.prepare(
    "SELECT 1 FROM points WHERE ticket_id = ? AND kind = 'complete'",
  ).bind(t.id).first();
  if (already) return null;
  const actorIsFixer = members.some((m) => m.name === actor && m.role === 'fixer');
  const earner = actorIsFixer ? actor
    : (t.assignee || members.find((m) => m.role === 'fixer')?.name || actor);
  const base = basePoints(t);
  const stmts = [db.prepare(
    "INSERT INTO points (member, ticket_id, kind, points, note) VALUES (?, ?, 'complete', ?, ?)",
  ).bind(earner, t.id, base, t.title)];
  let bonus = 0;
  const deadline = t.scheduled_for || t.due_date;
  const today = new Date().toISOString().slice(0, 10);
  if (deadline && today <= deadline) {
    bonus = Math.max(5, Math.round(base * 0.25));
    stmts.push(db.prepare(
      "INSERT INTO points (member, ticket_id, kind, points, note) VALUES (?, ?, 'ontime', ?, ?)",
    ).bind(earner, t.id, bonus, 'On-time bonus'));
  }
  await db.batch(stmts);
  return { member: earner, points: base + bonus, base, bonus };
}

async function updateTicket(db, request, actor, id) {
  const before = await getTicket(db, id);
  if (!before) return bad('Not found', 404);
  const body = await request.json().catch(() => ({}));
  const note = String(body.note || '').trim().slice(0, 2000);
  const members = await getMembers(db);

  // Scheduling a specific day also plans it into that week and marks it Scheduled.
  if (body.scheduled_for) {
    if (!('sprint_week' in body)) body.sprint_week = mondayOf(String(body.scheduled_for));
    if (!('status' in body) && ['new', 'backlog'].includes(before.status)) body.status = 'scheduled';
  }
  if ('scheduled_for' in body && !body.scheduled_for) body.scheduled_time = null;

  const sets = [];
  const vals = [];
  const changes = {};
  for (const f of EDITABLE) {
    if (!(f in body)) continue;
    const v = clean(f, body[f]);
    if (v === before[f]) continue;
    sets.push(`${f} = ?`);
    vals.push(v);
    changes[f] = v;
  }
  if (!sets.length && !note) return json({ ticket: before });

  if ('status' in changes) {
    if (changes.status === 'resolved') sets.push("resolved_at = datetime('now')");
    if (changes.status === 'closed') {
      sets.push("closed_at = datetime('now')");
      // Closing straight from triage = "won't do", which shouldn't count as work done.
      if (before.status !== 'new') sets.push("resolved_at = COALESCE(resolved_at, datetime('now'))");
    }
    if (OPEN_STATUSES.includes(changes.status)) sets.push('resolved_at = NULL, closed_at = NULL');
    if (changes.status !== 'blocked' && !('blocked_reason' in changes)) sets.push("blocked_reason = ''");
  }
  sets.push("updated_at = datetime('now')");

  const after = await db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
    .bind(...vals, id).first();

  // Human-readable audit trail
  const notes = [];
  if ('status' in changes) {
    let n = `${STATUS_LABEL[before.status]} → ${STATUS_LABEL[changes.status]}`;
    if (changes.status === 'blocked' && after.blocked_reason) n += ` (${after.blocked_reason})`;
    notes.push(n);
  }
  if ('scheduled_for' in changes || 'scheduled_time' in changes) {
    notes.push(after.scheduled_for ? `📅 Scheduled for ${prettyDate(after.scheduled_for, after.scheduled_time)}` : 'Unscheduled');
  } else if ('sprint_week' in changes) {
    notes.push(changes.sprint_week ? `Planned for week of ${changes.sprint_week}` : 'Removed from weekly plan');
  }
  if ('priority' in changes) notes.push(`Priority P${before.priority} → P${changes.priority}`);
  if ('estimate_min' in changes) notes.push(`Estimate set to ${changes.estimate_min} min`);
  if ('assignee' in changes) notes.push(changes.assignee ? `Assigned to ${changes.assignee}` : 'Unassigned');
  if ('due_date' in changes) notes.push(changes.due_date ? `Due ${changes.due_date}` : 'Due date cleared');
  if (notes.length) await audit(db, id, actor, notes.join(' · '));
  if (note) {
    await db.prepare('INSERT INTO comments (ticket_id, author, body) VALUES (?, ?, ?)').bind(id, actor, note).run();
  }

  // ---- points ----
  let award = null;
  const nowDone = changes.status === 'resolved' || (changes.status === 'closed' && before.status !== 'new');
  if (nowDone) award = await awardCompletion(db, after, actor, members);
  if (changes.status === 'closed' && before.status === 'resolved' && actor === after.requester) {
    const earned = await db.prepare(
      "SELECT member FROM points WHERE ticket_id = ? AND kind = 'complete'",
    ).bind(id).first();
    const dup = await db.prepare("SELECT 1 FROM points WHERE ticket_id = ? AND kind = 'thanks'").bind(id).first();
    if (earned && !dup && earned.member !== actor) {
      await db.prepare(
        "INSERT INTO points (member, ticket_id, kind, points, note) VALUES (?, ?, 'thanks', ?, ?)",
      ).bind(earned.member, id, THANKS_POINTS, `${actor} approved ✓`).run();
      await notify(db, [earned.member], id, actor, 'points',
        `${actor} approved “${after.title}” ✓ +${THANKS_POINTS} pts`);
    }
  }
  if ('status' in changes && OPEN_STATUSES.includes(changes.status) && ['resolved', 'closed'].includes(before.status)) {
    // Reopened: take back the points; they'll be re-earned when it's really done.
    await db.prepare("DELETE FROM points WHERE ticket_id = ? AND kind IN ('complete','ontime','thanks')").bind(id).run();
  }

  // ---- notifications ----
  const recipients = recipientsFor(after, actor, members);
  let kind = note ? 'update' : 'status';
  let msg = notes.join(' · ');
  if (changes.status === 'resolved') {
    kind = 'resolved';
    msg = `✅ Done: “${after.title}” — please check it`;
  } else if ('scheduled_for' in changes && after.scheduled_for) {
    kind = 'scheduled';
    msg = `📅 “${after.title}” scheduled for ${prettyDate(after.scheduled_for, after.scheduled_time)}`;
  } else if (msg) {
    msg = `“${after.title}”: ${msg}`;
  } else {
    msg = `Update on “${after.title}”`;
  }
  if (note) msg += ` — ${note}`;
  // Points/priority-only tweaks are noise; only notify on meaningful changes.
  const approvedOnly = changes.status === 'closed' && before.status === 'resolved' && !note; // "+10 pts" notice covers it
  const meaningful = !approvedOnly && (note || ['status', 'scheduled_for', 'scheduled_time', 'due_date', 'sprint_week'].some((f) => f in changes));
  if (meaningful) await notify(db, recipients, id, actor, kind, msg);

  // ---- recurring chores: closing spawns the next occurrence ----
  let spawned = null;
  if (changes.status === 'closed' && after.recur_days > 0) {
    spawned = await db.prepare(
      `INSERT INTO tickets (title, description, requester, assignee, priority, estimate_min, category,
                            location, status, due_date, recur_days)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?) RETURNING *`,
    ).bind(after.title, after.description, after.requester, after.assignee, after.priority,
      after.estimate_min, after.category, after.location,
      addDays(null, after.recur_days), after.recur_days).first();
    await audit(db, spawned.id, actor, `Recurring chore — next occurrence of #${id}`);
    await audit(db, id, actor, `Next occurrence created: #${spawned.id}`);
  }

  return json({ ticket: after, spawned, award });
}

async function ticketDetail(db, id) {
  const ticket = await getTicket(db, id);
  if (!ticket) return bad('Not found', 404);
  const { results } = await db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY id ASC')
    .bind(id).all();
  const pts = await db.prepare('SELECT * FROM points WHERE ticket_id = ? ORDER BY id').bind(id).all();
  return json({ ticket, comments: results, points: pts.results });
}

async function addComment(db, request, actor, id) {
  const ticket = await getTicket(db, id);
  if (!ticket) return bad('Not found', 404);
  const body = await request.json().catch(() => ({}));
  const text = String(body.body || '').trim().slice(0, 5000);
  if (!text) return bad('Comment is empty');
  const row = await db.prepare(
    'INSERT INTO comments (ticket_id, author, body) VALUES (?, ?, ?) RETURNING *',
  ).bind(id, actor, text).first();
  await db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").bind(id).run();
  const members = await getMembers(db);
  await notify(db, recipientsFor(ticket, actor, members), id, actor, 'comment', `💬 “${ticket.title}”: ${text}`);
  return json({ comment: row }, 201);
}

async function deleteTicket(db, id) {
  await db.batch([
    db.prepare('DELETE FROM comments WHERE ticket_id = ?').bind(id),
    db.prepare('DELETE FROM notifications WHERE ticket_id = ?').bind(id),
    db.prepare('DELETE FROM tickets WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

// ---------- notifications ----------

async function listNotifications(db, actor) {
  const { results } = await db.prepare(
    'SELECT * FROM notifications WHERE recipient = ? ORDER BY id DESC LIMIT 60',
  ).bind(actor).all();
  const unread = await db.prepare(
    'SELECT COUNT(*) AS n FROM notifications WHERE recipient = ? AND read_at IS NULL',
  ).bind(actor).first();
  return json({ notifications: results, unread: unread.n });
}

async function markRead(db, request, actor) {
  const body = await request.json().catch(() => ({}));
  if (Array.isArray(body.ids) && body.ids.length) {
    const ids = body.ids.map(Number).filter(Number.isInteger).slice(0, 200);
    await db.prepare(
      `UPDATE notifications SET read_at = datetime('now')
       WHERE recipient = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
    ).bind(actor, ...ids).run();
  } else if (body.ticket_id) {
    await db.prepare(
      "UPDATE notifications SET read_at = datetime('now') WHERE recipient = ? AND read_at IS NULL AND ticket_id = ?",
    ).bind(actor, Number(body.ticket_id)).run();
  } else {
    await db.prepare(
      "UPDATE notifications SET read_at = datetime('now') WHERE recipient = ? AND read_at IS NULL",
    ).bind(actor).run();
  }
  return listNotifications(db, actor);
}

// ---------- points & rewards ----------

async function pointsSummary(db) {
  const members = await getMembers(db);
  const totals = await db.prepare(`
    SELECT member,
      SUM(points) AS balance,
      SUM(CASE WHEN points > 0 THEN points ELSE 0 END) AS lifetime,
      SUM(CASE WHEN points > 0 AND created_at >= datetime('now','-7 days') THEN points ELSE 0 END) AS last7,
      SUM(CASE WHEN points > 0 AND created_at >= datetime('now','-30 days') THEN points ELSE 0 END) AS last30,
      SUM(CASE WHEN kind = 'complete' THEN 1 ELSE 0 END) AS jobs,
      SUM(CASE WHEN kind = 'ontime' THEN 1 ELSE 0 END) AS ontime,
      SUM(CASE WHEN kind = 'thanks' THEN 1 ELSE 0 END) AS thanks
    FROM points GROUP BY member`).all();
  const weekly = await db.prepare(`
    SELECT member, date(created_at, 'weekday 0', '-6 days') AS week, SUM(points) AS pts
    FROM points WHERE points > 0 AND created_at >= datetime('now', '-120 days')
    GROUP BY member, week ORDER BY week DESC`).all();
  const history = await db.prepare(`
    SELECT p.*, t.title FROM points p LEFT JOIN tickets t ON t.id = p.ticket_id
    ORDER BY p.id DESC LIMIT 40`).all();
  const rewards = await db.prepare('SELECT * FROM rewards WHERE active = 1 ORDER BY cost').all();
  return json({
    members,
    totals: totals.results,
    weekly: weekly.results,
    history: history.results,
    rewards: rewards.results,
  });
}

async function createReward(db, request) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || '').trim().slice(0, 100);
  const cost = Math.round(Number(body.cost) || 0);
  const emoji = String(body.emoji || '🎁').slice(0, 8);
  if (!title) return bad('Reward needs a name');
  if (cost <= 0 || cost > 100000) return bad('Cost must be a positive number of points');
  const row = await db.prepare('INSERT INTO rewards (title, cost, emoji) VALUES (?, ?, ?) RETURNING *')
    .bind(title, cost, emoji).first();
  return json({ reward: row }, 201);
}

async function redeemReward(db, actor, id) {
  const reward = await db.prepare('SELECT * FROM rewards WHERE id = ? AND active = 1').bind(id).first();
  if (!reward) return bad('Reward not found', 404);
  const bal = await db.prepare('SELECT COALESCE(SUM(points),0) AS b FROM points WHERE member = ?').bind(actor).first();
  if (bal.b < reward.cost) return bad(`Not enough points — you have ${bal.b}, need ${reward.cost}`);
  await db.prepare(
    "INSERT INTO points (member, kind, points, note) VALUES (?, 'redeem', ?, ?)",
  ).bind(actor, -reward.cost, `${reward.emoji} ${reward.title}`).run();
  const members = await getMembers(db);
  await notify(db, members.filter((m) => m.name !== actor).map((m) => m.name), null, actor, 'reward',
    `🎉 ${actor} cashed in ${reward.cost} pts for: ${reward.emoji} ${reward.title}`);
  return json({ ok: true, balance: bal.b - reward.cost });
}

// ---------- settings & stats ----------

async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(results.map((r) => [r.key, r.value]));
  return json({
    members: JSON.parse(s.members || '[]'),
    capacity_min: Number(s.capacity_min || 240),
  });
}

async function putSettings(db, request) {
  const body = await request.json().catch(() => ({}));
  const stmts = [];
  if (Array.isArray(body.members)) {
    const members = body.members
      .map((m) => ({ name: String(m.name || '').trim().slice(0, 40), role: m.role === 'fixer' ? 'fixer' : 'requester' }))
      .filter((m) => m.name);
    if (!members.length) return bad('Need at least one member');
    stmts.push(db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('members', JSON.stringify(members)));
  }
  if (body.capacity_min !== undefined) {
    const n = Math.max(0, Math.min(10080, Math.round(Number(body.capacity_min) || 0)));
    stmts.push(db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .bind('capacity_min', String(n)));
  }
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

async function stats(db) {
  const row = await db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('new','backlog','scheduled','in_progress','blocked') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS untriaged,
      SUM(CASE WHEN status IN ('resolved','closed') AND resolved_at >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS done_7d,
      SUM(CASE WHEN status IN ('resolved','closed') AND resolved_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS done_30d,
      SUM(CASE WHEN status IN ('resolved','closed') AND resolved_at >= datetime('now','-30 days') THEN estimate_min ELSE 0 END) AS minutes_30d,
      AVG(CASE WHEN resolved_at >= datetime('now','-30 days')
               THEN julianday(resolved_at) - julianday(created_at) END) AS avg_days_to_resolve
    FROM tickets`).first();
  return json({ stats: row });
}

// ---------- router ----------

export async function onRequest({ request, env, params }) {
  const db = env.DB;
  if (!db) return bad('D1 binding "DB" is missing', 500);
  const parts = params.route || [];
  const method = request.method;
  const actor = actorOf(request);
  const url = new URL(request.url);

  try {
    const [res, id, sub] = parts;
    const numId = id !== undefined && id !== 'read' ? Number(id) : null;
    if (numId !== null && !Number.isInteger(numId)) return bad('Bad id');

    if (res === 'tickets') {
      if (id === undefined && method === 'GET') return await listTickets(db, url);
      if (id === undefined && method === 'POST') return await createTicket(db, request, actor);
      if (sub === undefined && method === 'GET') return await ticketDetail(db, numId);
      if (sub === undefined && method === 'PATCH') return await updateTicket(db, request, actor, numId);
      if (sub === undefined && method === 'DELETE') return await deleteTicket(db, numId);
      if (sub === 'comments' && method === 'POST') return await addComment(db, request, actor, numId);
    }
    if (res === 'notifications') {
      if (id === undefined && method === 'GET') return await listNotifications(db, actor);
      if (id === 'read' && method === 'POST') return await markRead(db, request, actor);
    }
    if (res === 'points' && method === 'GET') return await pointsSummary(db);
    if (res === 'rewards') {
      if (id === undefined && method === 'POST') return await createReward(db, request);
      if (sub === undefined && method === 'DELETE') {
        await db.prepare('UPDATE rewards SET active = 0 WHERE id = ?').bind(numId).run();
        return json({ ok: true });
      }
      if (sub === 'redeem' && method === 'POST') return await redeemReward(db, actor, numId);
    }
    if (res === 'settings' && method === 'GET') return await getSettings(db);
    if (res === 'settings' && method === 'PUT') return await putSettings(db, request);
    if (res === 'stats' && method === 'GET') return await stats(db);
    return bad('Not found', 404);
  } catch (err) {
    return bad(err.message || 'Bad request');
  }
}
