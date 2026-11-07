// Daddy-Do REST API (Cloudflare Pages Function, D1 binding "DB").
// Auth is handled by _middleware.js. The acting user's name comes in X-User.

const STATUSES = ['new', 'backlog', 'scheduled', 'in_progress', 'blocked', 'resolved', 'closed'];
const OPEN_STATUSES = ['new', 'backlog', 'scheduled', 'in_progress', 'blocked'];
const EDITABLE = [
  'title', 'description', 'assignee', 'priority', 'estimate_min', 'category',
  'location', 'status', 'blocked_reason', 'due_date', 'sprint_week', 'recur_days',
];
const STATUS_LABEL = {
  new: 'New', backlog: 'Backlog', scheduled: 'Scheduled', in_progress: 'In progress',
  blocked: 'Blocked', resolved: 'Resolved', closed: 'Closed',
};

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
      if (value === null || value === '' || value === undefined) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
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

// ---------- handlers ----------

async function listTickets(db, url) {
  const includeClosed = url.searchParams.get('closed') === '1';
  const sql = includeClosed
    ? `SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id AND c.is_system = 0) AS comment_count
       FROM tickets t ORDER BY t.id DESC LIMIT 1000`
    : `SELECT t.*, (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id AND c.is_system = 0) AS comment_count
       FROM tickets t
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
  const row = await db.prepare(
    `INSERT INTO tickets (title, description, requester, priority, category, location, due_date,
                          estimate_min, assignee, recur_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  ).bind(t.title, t.description, actor, t.priority, t.category, t.location, t.due_date,
    t.estimate_min, t.assignee, t.recur_days).first();
  await audit(db, row.id, actor, 'Opened ticket');
  return json({ ticket: row }, 201);
}

async function updateTicket(db, request, actor, id) {
  const before = await getTicket(db, id);
  if (!before) return bad('Not found', 404);
  const body = await request.json().catch(() => ({}));

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
  if (!sets.length) return json({ ticket: before });

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
  if ('priority' in changes) notes.push(`Priority P${before.priority} → P${changes.priority}`);
  if ('sprint_week' in changes) {
    notes.push(changes.sprint_week ? `Planned for week of ${changes.sprint_week}` : 'Removed from weekly plan');
  }
  if ('estimate_min' in changes) notes.push(`Estimate set to ${changes.estimate_min} min`);
  if ('assignee' in changes) notes.push(changes.assignee ? `Assigned to ${changes.assignee}` : 'Unassigned');
  if ('due_date' in changes) notes.push(changes.due_date ? `Due ${changes.due_date}` : 'Due date cleared');
  if (notes.length) await audit(db, id, actor, notes.join(' · '));

  // Recurring chores: closing spawns the next occurrence.
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

  return json({ ticket: after, spawned });
}

async function ticketDetail(db, id) {
  const ticket = await getTicket(db, id);
  if (!ticket) return bad('Not found', 404);
  const { results } = await db.prepare('SELECT * FROM comments WHERE ticket_id = ? ORDER BY id ASC')
    .bind(id).all();
  return json({ ticket, comments: results });
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
  return json({ comment: row }, 201);
}

async function deleteTicket(db, id) {
  await db.batch([
    db.prepare('DELETE FROM comments WHERE ticket_id = ?').bind(id),
    db.prepare('DELETE FROM tickets WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
}

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
    const numId = id !== undefined ? Number(id) : null;
    if (id !== undefined && !Number.isInteger(numId)) return bad('Bad id');

    if (res === 'tickets') {
      if (id === undefined && method === 'GET') return await listTickets(db, url);
      if (id === undefined && method === 'POST') return await createTicket(db, request, actor);
      if (sub === undefined && method === 'GET') return await ticketDetail(db, numId);
      if (sub === undefined && method === 'PATCH') return await updateTicket(db, request, actor, numId);
      if (sub === undefined && method === 'DELETE') return await deleteTicket(db, numId);
      if (sub === 'comments' && method === 'POST') return await addComment(db, request, actor, numId);
    }
    if (res === 'settings' && method === 'GET') return await getSettings(db);
    if (res === 'settings' && method === 'PUT') return await putSettings(db, request);
    if (res === 'stats' && method === 'GET') return await stats(db);
    return bad('Not found', 404);
  } catch (err) {
    return bad(err.message || 'Bad request');
  }
}
