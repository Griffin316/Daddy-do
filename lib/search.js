// Semantic search over a household's Do's (Workers AI embeddings, stored in D1).
//
// Each Do becomes a few short passages (title + details, each comment, linked email subjects).
// Passages are embedded with @cf/baai/bge-base-en-v1.5 (Cloudflare-hosted, zero data retention),
// normalised and stored as int8 (768 bytes) base64 in search_chunks. A query is embedded the same
// way and compared against every passage of the household (fine for thousands of passages).
// Indexing is lazy: before each search, Do's changed since they were last indexed are re-indexed.

export const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '; // bge retrieval hint
const MAX_CHARS = 1400;          // ~350 tokens, under the model's 512-token limit
const MAX_CHUNKS_PER_DO = 16;
const REINDEX_PER_SEARCH = 120;  // bound work per request; the rest catches up next search
const BATCH = 50;
export const STRONG = 0.52; // below this, results are 'closest matches', not confident hits

const STATUS = {
  new: 'new request', backlog: 'in the backlog', scheduled: 'scheduled', in_progress: 'in progress',
  blocked: 'blocked', resolved: 'done', closed: 'closed',
};

// ---- vectors ----
function toInt8B64(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((vec[i] / n) * 127)));
  let s = '';
  const u = new Uint8Array(q.buffer);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Int8Array(u.buffer);
}
function normalize(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(vec, (v) => v / n);
}
function dot(q, int8) {
  let s = 0;
  for (let i = 0; i < q.length; i++) s += q[i] * int8[i];
  return s / 127;
}

export async function embed(env, texts) {
  if (!env.AI) throw new Error('Search needs the Workers AI binding "AI".');
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = await env.AI.run(EMBED_MODEL, { text: texts.slice(i, i + BATCH), pooling: 'cls' });
    out.push(...r.data);
  }
  return out;
}

// ---- passages for one Do ----
const clip = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);

function chunksFor(t, comments, threads) {
  const meta = [
    `${t.title}.`,
    `Status: ${STATUS[t.status] || t.status}.`,
    t.category && t.category !== 'general' ? `Category: ${t.category}.` : '',
    t.location ? `Location: ${t.location}.` : '',
    `Requested by ${t.requester}${t.created_at ? ` on ${t.created_at.slice(0, 10)}` : ''}.`,
    t.scheduled_for ? `Scheduled for ${t.scheduled_for}${t.scheduled_time ? ` at ${t.scheduled_time}` : ''}.` : '',
    t.due_date ? `Needed by ${t.due_date}.` : '',
    t.status === 'blocked' && t.blocked_reason ? `Blocked on: ${t.blocked_reason}.` : '',
    t.resolved_at ? `Done on ${t.resolved_at.slice(0, 10)}.` : '',
    t.description ? `Details: ${t.description}` : '',
  ].filter(Boolean).join(' ');
  const chunks = [{ kind: 'do', text: clip(meta) }];
  // People's comments: one passage each (they hold the facts: quotes, names, part numbers).
  for (const c of comments.filter((x) => !x.is_system)) {
    chunks.push({ kind: 'comment', text: clip(`${t.title} — ${c.author} on ${c.created_at.slice(0, 10)}: ${c.body}`) });
  }
  // Status history: one combined passage.
  const hist = comments.filter((x) => x.is_system).map((c) => `${c.created_at.slice(0, 10)} ${c.author}: ${c.body}`).join('; ');
  if (hist) chunks.push({ kind: 'history', text: clip(`${t.title} — history: ${hist}`) });
  for (const th of threads) chunks.push({ kind: 'email', text: clip(`${t.title} — email with ${th.correspondent}: ${th.subject}`) });
  return chunks.slice(0, MAX_CHUNKS_PER_DO);
}

// Re-index Do's that changed since they were last indexed.
export async function ensureIndexed(env, db, hh) {
  const { results: stale } = await db.prepare(
    `SELECT t.* FROM tickets t
     LEFT JOIN (SELECT ticket_id, MAX(indexed_at) AS ia FROM search_chunks WHERE household_id = ? GROUP BY ticket_id) s
       ON s.ticket_id = t.id
     WHERE t.household_id = ? AND (s.ia IS NULL OR t.updated_at > s.ia)
     ORDER BY t.updated_at DESC LIMIT ?`,
  ).bind(hh, hh, REINDEX_PER_SEARCH).all();
  if (!stale.length) return 0;
  const ids = stale.map((t) => t.id);
  const ph = ids.map(() => '?').join(',');
  const { results: comments } = await db.prepare(
    `SELECT ticket_id, author, body, is_system, created_at FROM comments WHERE household_id = ? AND ticket_id IN (${ph}) ORDER BY id`,
  ).bind(hh, ...ids).all();
  const { results: threads } = await db.prepare(
    `SELECT ticket_id, subject, correspondent FROM ticket_threads WHERE household_id = ? AND ticket_id IN (${ph})`,
  ).bind(hh, ...ids).all();
  const all = [];
  for (const t of stale) {
    for (const c of chunksFor(t, comments.filter((x) => x.ticket_id === t.id), threads.filter((x) => x.ticket_id === t.id))) {
      all.push({ ticket_id: t.id, ...c });
    }
  }
  const vecs = await embed(env, all.map((c) => c.text));
  const stmts = [db.prepare(`DELETE FROM search_chunks WHERE household_id = ? AND ticket_id IN (${ph})`).bind(hh, ...ids)];
  all.forEach((c, i) => stmts.push(db.prepare(
    "INSERT INTO search_chunks (household_id, ticket_id, kind, text, vec, indexed_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
  ).bind(hh, c.ticket_id, c.kind, c.text, toInt8B64(vecs[i]))));
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  return stale.length;
}

const terms = (q) => [...new Set(q.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'.-]*/gu) || [])].filter((w) => w.length >= 3);

// Returns [{ ticket, score, snippet, kind }] best first.
export async function search(env, db, hh, q, { limit = 12 } = {}) {
  await ensureIndexed(env, db, hh);
  const [qv] = await embed(env, [QUERY_PREFIX + q]);
  const qn = normalize(qv);
  const { results: chunks } = await db.prepare('SELECT ticket_id, kind, text, vec FROM search_chunks WHERE household_id = ?').bind(hh).all();
  const words = terms(q);
  const best = new Map();
  for (const c of chunks) {
    let s = dot(qn, fromB64(c.vec));
    // Hybrid boost: exact words matter for names, part numbers and amounts.
    const lower = c.text.toLowerCase();
    const hits = words.filter((w) => lower.includes(w)).length;
    if (words.length) s += 0.06 * (hits / words.length) + (hits === words.length ? 0.04 : 0);
    const cur = best.get(c.ticket_id);
    if (!cur || s > cur.score) best.set(c.ticket_id, { score: s, snippet: c.text, kind: c.kind });
  }
  const ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score);
  if (!ranked.length) return [];
  const top = ranked[0][1].score;
  // Scores measured on real household data: clear hits land around 0.55–0.75, unrelated text ~0.45.
  // Keep results close to the best one; the caller flags weak sets via `strong`.
  const keep = ranked.filter(([, r]) => r.score >= Math.max(0.44, top - 0.12)).slice(0, limit);
  const ids = keep.map(([id]) => id);
  const { results: tickets } = await db.prepare(
    `SELECT id, title, status, priority, category, location, requester, scheduled_for, scheduled_time, due_date,
            estimate_min, created_at, updated_at, resolved_at, closed_at
     FROM tickets WHERE household_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  ).bind(hh, ...ids).all();
  const byId = new Map(tickets.map((t) => [t.id, t]));
  return keep.filter(([id]) => byId.has(id)).map(([id, r]) => ({
    ticket: byId.get(id), score: Math.round(r.score * 1000) / 1000, kind: r.kind, strong: r.score >= STRONG,
    snippet: r.snippet.length > 260 ? r.snippet.slice(0, 257) + '…' : r.snippet,
  }));
}
