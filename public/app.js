// Daddy-Do — household chore ticketing. Vanilla JS, no build step.

const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const modal = $('#modal');
const modalBody = $('#modal-body');

const PRIORITIES = {
  1: { label: 'P1 · Today', hint: 'Safety, leaks, broken essentials' },
  2: { label: 'P2 · This week', hint: 'Needs doing soon' },
  3: { label: 'P3 · When you can', hint: 'Normal request' },
  4: { label: 'P4 · Someday', hint: 'Nice to have / project' },
};
const SIZES = [
  { min: 15, label: 'XS · 15m' },
  { min: 30, label: 'S · 30m' },
  { min: 60, label: 'M · 1h' },
  { min: 180, label: 'L · 3h' },
  { min: 480, label: 'XL · day' },
];
const CATEGORIES = ['repair', 'cleaning', 'yard', 'errand', 'kids', 'admin', 'project', 'general'];
const CAT_ICON = {
  repair: '🔧', cleaning: '🧽', yard: '🌿', errand: '🚗', kids: '🧸', admin: '📄', project: '🏗️', general: '📌',
};
const STATUS_LABEL = {
  new: 'New', backlog: 'Backlog', scheduled: 'Scheduled', in_progress: 'In progress',
  blocked: 'Blocked', resolved: 'Done – check it', closed: 'Closed',
};

const state = {
  me: localStorage.getItem('dd_me') || '',
  tab: localStorage.getItem('dd_tab') || '',
  members: [],
  capacity: 240,
  tickets: [],
  stats: null,
  backlogFilter: 'all',
  notifs: [],
  unread: 0,
  lastNotifId: Number(localStorage.getItem('dd_last_notif') || 0),
  points: null,
  dictionary: [],
};
const HIDDEN_VIEWS = ['dict']; // reachable from Settings / Talk, not in the tab strip

// ---------- utils ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2600);
}

function fmtMin(m) {
  if (!m) return '0m';
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)}h`;
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function mondayOf(date = new Date(), offsetWeeks = 0) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = (d.getDay() + 6) % 7; // Mon=0
  d.setDate(d.getDate() - dow + offsetWeeks * 7);
  return isoDate(d);
}
const THIS_WEEK = () => mondayOf();
const NEXT_WEEK = () => mondayOf(new Date(), 1);

function daysAgo(sqlTs) {
  const t = new Date(sqlTs.replace(' ', 'T') + 'Z');
  return Math.floor((Date.now() - t.getTime()) / 86400000);
}
function ago(sqlTs) {
  const d = daysAgo(sqlTs);
  if (d <= 0) return 'today';
  if (d === 1) return 'yesterday';
  return `${d}d ago`;
}
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date(isoDate(new Date()) + 'T00:00:00');
  const due = new Date(dateStr + 'T00:00:00');
  return Math.round((due - today) / 86400000);
}
function dueText(t) {
  const n = daysUntil(t.due_date);
  if (n === null) return '';
  if (n < 0) return `<span class="overdue">⏰ overdue ${-n}d</span>`;
  if (n === 0) return '<span class="overdue">⏰ due today</span>';
  return `⏰ due in ${n}d`;
}

// Triage score: priority dominates, then due date, then age (so old P3s eventually surface).
function score(t) {
  let s = (5 - t.priority) * 100;
  const n = daysUntil(t.due_date);
  if (n !== null) s += n < 0 ? 250 : n <= 2 ? 150 : n <= 7 ? 60 : 0;
  s += Math.min(daysAgo(t.created_at), 60) * 2;
  return s;
}

function prettySched(t) {
  if (!t.scheduled_for) return '';
  const d = new Date(t.scheduled_for + 'T00:00:00');
  const n = daysUntil(t.scheduled_for);
  let day = n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (t.scheduled_time) {
    const [h, m] = t.scheduled_time.split(':').map(Number);
    day += ` ${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
  }
  return day;
}

// Mirrors the server's points rules (functions/api/[[route]].js) for previews.
const SIZE_POINTS = { 15: 10, 30: 20, 60: 35, 180: 80, 480: 180 };
const PRIORITY_MULT = { 1: 1.5, 2: 1.25, 3: 1, 4: 1 };
function pointsFor(t) {
  const base = SIZE_POINTS[t.estimate_min] ?? (t.estimate_min ? Math.round(t.estimate_min * 0.4) + 5 : 15);
  return Math.round(base * (PRIORITY_MULT[t.priority] || 1));
}
const LEVELS = [
  [0, 'Apprentice', '🔰'], [200, 'Handy', '🔧'], [500, 'Fix-it Pro', '🛠️'],
  [1000, 'Master of the House', '🏠'], [2000, 'Household Legend', '🏆'], [4000, 'Mythical', '⚡'],
];
function levelOf(lifetime) {
  let i = 0;
  while (i + 1 < LEVELS.length && lifetime >= LEVELS[i + 1][0]) i++;
  const [from, name, icon] = LEVELS[i];
  const next = LEVELS[i + 1];
  return { n: i + 1, name, icon, from, next: next?.[0], nextName: next?.[1], pct: next ? Math.round(((lifetime - from) / (next[0] - from)) * 100) : 100 };
}
const myTotals = (name = state.me) => (state.points?.totals || []).find((x) => x.member === name)
  || { balance: 0, lifetime: 0, last7: 0, last30: 0, jobs: 0, ontime: 0, thanks: 0 };

const isFixer = () => (state.members.find((m) => m.name === state.me) || {}).role === 'fixer';
const OPEN = ['new', 'backlog', 'scheduled', 'in_progress', 'blocked'];

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-user': encodeURIComponent(state.me || 'Someone'),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    renderLogin();
    throw new Error('Please log in');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function refresh() {
  const [t, s] = await Promise.all([api('/tickets'), api('/stats'), refreshNotifs(), refreshPoints()]);
  state.tickets = t.tickets;
  state.stats = s.stats;
}

async function refreshPoints() {
  try { state.points = await api('/points'); } catch { /* optional */ }
}

// Pull notifications; surface anything new as a toast + Android system notification.
async function refreshNotifs() {
  const r = await api('/notifications');
  state.notifs = r.notifications;
  state.unread = r.unread;
  const fresh = r.notifications.filter((n) => !n.read_at && n.id > state.lastNotifId);
  if (fresh.length) {
    const maxId = Math.max(...fresh.map((n) => n.id));
    const first = state.lastNotifId > 0; // don't blast on the very first load
    state.lastNotifId = maxId;
    localStorage.setItem('dd_last_notif', String(maxId));
    if (first) {
      toast(fresh.length === 1 ? `🔔 ${fresh[0].body.startsWith(fresh[0].actor) ? '' : fresh[0].actor + ': '}${fresh[0].body}` : `🔔 ${fresh.length} new updates`);
      for (const n of fresh.slice(0, 3)) systemNotify(n);
    }
  }
  updateBell();
}

async function systemNotify(n) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const opts = { body: n.body, tag: 'dd-' + n.id, icon: '/icon-192.png', badge: '/icon-192.png', data: { ticket: n.ticket_id } };
    if (reg) await reg.showNotification(`Daddy-Do · ${n.actor}`, opts);
  } catch { /* ignore */ }
}

function updateBell() {
  const b = $('#bell-count');
  if (!b) return;
  b.textContent = state.unread > 9 ? '9+' : String(state.unread);
  b.hidden = !state.unread;
}

async function patch(id, body, msg) {
  try {
    const r = await api(`/tickets/${id}`, { method: 'PATCH', body });
    const i = state.tickets.findIndex((x) => x.id === id);
    if (i >= 0) state.tickets[i] = { ...state.tickets[i], ...r.ticket };
    if (r.spawned) state.tickets.unshift(r.spawned);
    if (r.award) {
      toast(`⭐ +${r.award.points} pts${r.award.bonus ? ` (incl. +${r.award.bonus} on-time bonus)` : ''} — nice work!`);
      if (i >= 0) state.tickets[i].points_earned = r.award.points;
      refreshPoints().then(render);
    } else if (msg) toast(msg);
    api('/stats').then((s) => { state.stats = s.stats; });
    render();
    return r.ticket;
  } catch (e) {
    toast(e.message);
  }
}

// ---------- boot / auth ----------

async function boot() {
  try {
    const s = await fetch('/api/session').then((r) => r.json());
    if (!s.authed) return renderLogin(s.error);
    const settings = await api('/settings');
    state.members = settings.members;
    state.capacity = settings.capacity_min;
    state.dictionary = settings.dictionary || [];
    if (!state.members.some((m) => m.name === state.me)) return renderWhoAmI();
    await refresh();
    render();
    // Deep link from a tapped Android notification: /?ticket=123
    const tid = Number(new URLSearchParams(location.search).get('ticket'));
    if (tid) { history.replaceState(null, '', '/'); openTicket(tid); }
  } catch (e) {
    app.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

function renderLogin(err) {
  $('#tabs').hidden = true;
  $('#who').innerHTML = '';
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto">
      <h2>Household login</h2>
      <p class="muted small">Enter the household passphrase. You'll stay logged in on this device.</p>
      <form id="login">
        <input type="password" name="pin" class="big-input" placeholder="Passphrase" autocomplete="current-password" required>
        <p class="small" id="login-err" style="color:var(--p1)">${esc(err || '')}</p>
        <button class="btn primary block">Log in</button>
      </form>
    </div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/login', { method: 'POST', body: { pin: e.target.pin.value } });
      boot();
    } catch (er) {
      $('#login-err').textContent = er.message;
    }
  };
}

function renderWhoAmI() {
  $('#tabs').hidden = true;
  app.innerHTML = `
    <div class="card" style="max-width:420px;margin:40px auto">
      <h2>Who's using this phone?</h2>
      <div class="chips" style="margin-top:12px">
        ${state.members.map((m) => `<button class="chip" data-name="${esc(m.name)}">${esc(m.name)}
          <span class="muted small">${m.role === 'fixer' ? '(does the work)' : '(requests)'}</span></button>`).join('')}
      </div>
      <p class="muted small" style="margin-top:14px">You can rename people in Settings.</p>
    </div>`;
  app.querySelectorAll('[data-name]').forEach((b) => {
    b.onclick = async () => {
      state.me = b.dataset.name;
      localStorage.setItem('dd_me', state.me);
      state.tab = '';
      await refresh();
      render();
    };
  });
}

// ---------- layout ----------

function tabsFor() {
  const open = state.tickets.filter((t) => OPEN.includes(t.status));
  const mine = state.tickets.filter((t) => t.requester === state.me);
  const toVerify = mine.filter((t) => t.status === 'resolved').length;
  const untriaged = state.tickets.filter((t) => t.status === 'new').length;
  const week = open.filter((t) => t.sprint_week === THIS_WEEK()).length;
  if (isFixer()) {
    return [
      ['week', 'This week', week],
      ['triage', 'Triage', untriaged, true],
      ['talk', '🎙 Talk'],
      ['backlog', 'Backlog', open.filter((t) => t.status !== 'new' && t.sprint_week !== THIS_WEEK()).length],
      ['new', '+ New'],
      ['done', 'Done'],
      ['rewards', '🏆 Rewards'],
      ['settings', '⚙︎'],
    ];
  }
  return [
    ['talk', '🎙 Talk'],
    ['new', '+ Type it'],
    ['mine', 'My requests', toVerify, toVerify > 0],
    ['week', "This week's plan", week],
    ['all', 'Everything'],
    ['rewards', '🏆 Rewards'],
    ['settings', '⚙︎'],
  ];
}

function render() {
  const tabs = tabsFor();
  if (!tabs.some(([k]) => k === state.tab) && !HIDDEN_VIEWS.includes(state.tab)) state.tab = tabs[0][0];
  localStorage.setItem('dd_tab', state.tab);

  const pts = myTotals();
  $('#who').innerHTML = `
    ${isFixer() || pts.balance ? `<button class="pts-chip" id="pts-chip" title="Your points">⭐ ${pts.balance || 0}</button>` : ''}
    <button class="bell" id="bell" aria-label="Notifications">🔔<span class="badge" id="bell-count" hidden></span></button>
    <span class="me">${esc(state.me)}</span> <button class="link small" id="switch">switch</button>`;
  $('#bell').onclick = openNotifications;
  const pc = $('#pts-chip');
  if (pc) pc.onclick = () => { state.tab = 'rewards'; render(); };
  updateBell();
  $('#switch').onclick = () => { state.me = ''; localStorage.removeItem('dd_me'); renderWhoAmI(); };

  const nav = $('#tabs');
  nav.hidden = false;
  nav.innerHTML = tabs.map(([k, label, n, hot]) => `<button data-tab="${k}" class="${k === state.tab ? 'active' : ''}">
    ${esc(label)}${n ? ` <span class="${hot ? 'badge' : 'muted small'}">${n}</span>` : ''}</button>`).join('');
  nav.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; render(); window.scrollTo(0, 0); };
  });

  const views = {
    talk: viewVoice, new: viewNew, mine: viewMine, week: viewWeek, triage: viewTriage,
    backlog: viewBacklog, done: viewDone, all: viewAll, settings: viewSettings, rewards: viewRewards,
    dict: viewDictionary,
  };
  (views[state.tab] || viewNew)();
}

// ---------- ticket card ----------

function ticketCard(t, actions = []) {
  const meta = [
    `<span class="pill p${t.priority}">P${t.priority}</span>`,
    `<span class="status ${t.status}">${STATUS_LABEL[t.status]}</span>`,
    `${CAT_ICON[t.category] || '📌'} ${esc(t.category)}`,
    t.location ? `📍 ${esc(t.location)}` : '',
    t.scheduled_for && OPEN.includes(t.status) ? `<b class="sched">📅 ${esc(prettySched(t))}</b>` : '',
    t.estimate_min ? `⏱ ${fmtMin(t.estimate_min)}` : '<span>⏱ not sized</span>',
    dueText(t),
    t.points_earned ? `<b class="gold">⭐ ${t.points_earned}</b>` : (isFixer() && OPEN.includes(t.status) && t.estimate_min ? `<span class="muted">☆ ${pointsFor(t)} pts</span>` : ''),
    t.recur_days ? `🔁 every ${t.recur_days}d` : '',
    t.comment_count ? `💬 ${t.comment_count}` : '',
    `#${t.id} · ${esc(t.requester)} · ${ago(t.created_at)}`,
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');
  const blocked = t.status === 'blocked' && t.blocked_reason
    ? `<div class="small" style="margin-top:6px">🚧 ${esc(t.blocked_reason)}</div>` : '';
  const upd = t.last_update ? `<div class="last-upd small">💬 ${esc(t.last_update.length > 140 ? t.last_update.slice(0, 140) + '…' : t.last_update)}</div>` : '';
  const btns = actions.map(([key, label, cls = '']) =>
    `<button class="btn sm ${cls}" data-act="${key}" data-id="${t.id}">${label}</button>`).join('');
  return `<div class="card ticket p${t.priority}" data-open="${t.id}">
    <div class="title">${esc(t.title)}</div>
    <div class="meta">${meta}</div>${blocked}${upd}
    ${btns ? `<div class="actions">${btns}</div>` : ''}
  </div>`;
}

function wireCards(root, handlers) {
  root.querySelectorAll('[data-open]').forEach((el) => {
    el.onclick = (e) => {
      const btn = e.target.closest('[data-act]');
      const id = Number(el.dataset.open);
      if (btn) {
        e.stopPropagation();
        handlers[btn.dataset.act]?.(state.tickets.find((x) => x.id === id), btn);
      } else {
        openTicket(id);
      }
    };
  });
}

// Shared fixer actions
const fixerHandlers = {
  update: (t) => openUpdate(t),
  schedule: (t) => patch(t.id, { status: 'scheduled', sprint_week: THIS_WEEK() }, 'Added to this week'),
  next: (t) => patch(t.id, { status: 'scheduled', sprint_week: NEXT_WEEK() }, 'Planned for next week'),
  unplan: (t) => patch(t.id, { status: 'backlog', sprint_week: null }, 'Moved back to backlog'),
  start: (t) => patch(t.id, { status: 'in_progress', sprint_week: t.sprint_week || THIS_WEEK() }, 'Started'),
  done: (t) => openUpdate(t, 'resolved'),
  block: (t) => {
    const why = prompt('What is it blocked on? (e.g. "need parts from Home Depot", "need your decision on color")');
    if (why !== null) patch(t.id, { status: 'blocked', blocked_reason: why || 'waiting' }, 'Marked blocked');
  },
  unblock: (t) => patch(t.id, { status: t.sprint_week ? 'scheduled' : 'backlog' }, 'Unblocked'),
  close: (t) => patch(t.id, { status: 'closed' }, 'Closed ✓'),
  reopen: (t) => {
    const why = prompt("What's still not right?");
    if (why === null) return;
    patch(t.id, { status: 'backlog' }, 'Reopened').then(() => {
      if (why) api(`/tickets/${t.id}/comments`, { method: 'POST', body: { body: 'Reopened: ' + why } });
    });
  },
};

// ---------- views ----------

function viewNew() {
  const draft = { priority: 3, category: 'general', estimate_min: 0 };
  app.innerHTML = `
    <h2>${isFixer() ? 'New Do' : 'What needs doing?'}</h2>
    <form id="newf" class="card">
      <input name="title" class="big-input" placeholder="e.g. Kitchen faucet is dripping" maxlength="200" required autofocus>
      <label>How urgent?</label>
      <div class="chips" id="prio">
        ${Object.entries(PRIORITIES).map(([p, v]) => `<button type="button" class="chip ${+p === 3 ? 'on' : ''}" data-p="${p}" title="${esc(v.hint)}">${v.label}</button>`).join('')}
      </div>
      <p class="muted small" id="prio-hint">${PRIORITIES[3].hint}</p>
      <label>Category</label>
      <div class="chips" id="cats">
        ${CATEGORIES.map((c) => `<button type="button" class="chip ${c === 'general' ? 'on' : ''}" data-c="${c}">${CAT_ICON[c]} ${c}</button>`).join('')}
      </div>
      <details style="margin-top:12px">
        <summary class="muted">More details (optional)</summary>
        <label>Details</label>
        <textarea name="description" placeholder="Anything that helps — where, what you tried, links to parts…"></textarea>
        <div class="grid2">
          <div><label>Room / location</label><input type="text" name="location" placeholder="Kitchen"></div>
          <div><label>Needed by</label><input type="date" name="due_date"></div>
        </div>
        <label>Repeats?</label>
        <select name="recur_days">
          <option value="0">No</option><option value="7">Weekly</option><option value="14">Every 2 weeks</option>
          <option value="30">Monthly</option><option value="90">Every 3 months</option><option value="180">Every 6 months</option>
          <option value="365">Yearly</option>
        </select>
        ${isFixer() ? `<label>Size</label><div class="chips" id="sizes">${SIZES.map((s) => `<button type="button" class="chip" data-s="${s.min}">${s.label}</button>`).join('')}</div>` : ''}
      </details>
      <div style="margin-top:14px"><button class="btn primary block">Add Do</button></div>
    </form>
    <p class="muted small center">Tip: one Do per thing. Small, specific Do’s get done faster.</p>`;

  const pick = (container, attr, onPick) => container?.querySelectorAll(`[data-${attr}]`).forEach((b) => {
    b.onclick = () => {
      container.querySelectorAll('.chip').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      onPick(b.dataset[attr]);
    };
  });
  pick($('#prio'), 'p', (p) => { draft.priority = +p; $('#prio-hint').textContent = PRIORITIES[p].hint; });
  pick($('#cats'), 'c', (c) => { draft.category = c; });
  pick($('#sizes'), 's', (s) => { draft.estimate_min = +s; });

  $('#newf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const btn = f.querySelector('button.primary');
    btn.disabled = true;
    try {
      const body = {
        ...draft,
        title: f.title.value,
        description: f.description.value,
        location: f.location.value,
        due_date: f.due_date.value || null,
        recur_days: +f.recur_days.value,
      };
      const r = await api('/tickets', { method: 'POST', body });
      state.tickets.unshift({ ...r.ticket, comment_count: 0 });
      toast(`Do #${r.ticket.id} added`);
      viewNew();
      tabsRefresh();
    } catch (er) {
      toast(er.message);
      btn.disabled = false;
    }
  };
}

function tabsRefresh() {
  // Re-render tab badges without leaving the current view.
  const cur = state.tab;
  const nav = $('#tabs');
  const tabs = tabsFor();
  nav.innerHTML = tabs.map(([k, label, n, hot]) => `<button data-tab="${k}" class="${k === cur ? 'active' : ''}">
    ${esc(label)}${n ? ` <span class="${hot ? 'badge' : 'muted small'}">${n}</span>` : ''}</button>`).join('');
  nav.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { state.tab = b.dataset.tab; render(); };
  });
}

function statsBlock() {
  const s = state.stats || {};
  return `<div class="stats">
    <div class="stat"><b>${s.open || 0}</b><span>open Do’s</span></div>
    <div class="stat"><b>${s.done_7d || 0}</b><span>done last 7 days</span></div>
    <div class="stat"><b>${s.done_30d || 0}</b><span>done last 30 days</span></div>
    <div class="stat"><b>${fmtMin(s.minutes_30d || 0)}</b><span>chore time, 30 days</span></div>
    <div class="stat"><b>${s.avg_days_to_resolve != null ? s.avg_days_to_resolve.toFixed(1) + 'd' : '–'}</b><span>avg time to done</span></div>
  </div>`;
}

function viewMine() {
  const mine = state.tickets.filter((t) => t.requester === state.me && t.status !== 'closed')
    .sort((a, b) => (a.status === 'resolved' ? -1 : 0) - (b.status === 'resolved' ? -1 : 0) || score(b) - score(a));
  const verify = mine.filter((t) => t.status === 'resolved');
  const rest = mine.filter((t) => t.status !== 'resolved');
  app.innerHTML = `
    ${statsBlock()}
    ${verify.length ? `<h3>Done — please check ✓</h3>${verify.map((t) => ticketCard(t, [['close', 'Looks good ✓', 'ok'], ['reopen', 'Not quite']])).join('')}` : ''}
    <h3>Open requests</h3>
    ${rest.length ? rest.map((t) => ticketCard(t, t.status === 'blocked' ? [['comment', 'Reply']] : [])).join('') : '<p class="empty">Nothing open. 🎉</p>'}`;
  wireCards(app, { ...fixerHandlers, comment: (t) => openTicket(t.id) });
}

function capacityBlock(weekTickets) {
  const planned = weekTickets.filter((t) => t.status !== 'resolved' && t.status !== 'closed')
    .reduce((n, t) => n + (t.estimate_min || 30), 0);
  const done = weekTickets.filter((t) => t.status === 'resolved' || t.status === 'closed')
    .reduce((n, t) => n + (t.estimate_min || 30), 0);
  const cap = state.capacity || 1;
  const pct = Math.min(100, Math.round(((planned + done) / cap) * 100));
  const cls = planned + done > cap ? 'over' : pct > 85 ? 'near' : '';
  return `<div class="card">
    <div class="row spread"><b>Capacity this week</b><span class="small">${fmtMin(planned + done)} of ${fmtMin(cap)} planned</span></div>
    <div class="capbar ${cls}"><div style="width:${pct}%"></div></div>
    <div class="small muted">${fmtMin(done)} done · ${fmtMin(planned)} to go${planned + done > cap ? ` · <b class="overdue">over by ${fmtMin(planned + done - cap)} — bump something to next week</b>` : ''}</div>
    ${isFixer() ? '<div class="row" style="margin-top:8px"><button class="btn sm" id="autofill">⚡ Auto-fill from backlog</button><span class="muted small">Unsized Do’s count as 30m.</span></div>' : ''}
  </div>`;
}

function viewWeek() {
  const wk = THIS_WEEK();
  const weekTickets = state.tickets.filter((t) => t.sprint_week === wk && t.status !== 'new')
    .sort((a, b) => score(b) - score(a));
  const blockedElsewhere = state.tickets.filter((t) => t.status === 'blocked' && t.sprint_week !== wk);
  const inProg = weekTickets.filter((t) => t.status === 'in_progress');
  const todo = weekTickets.filter((t) => t.status === 'scheduled');
  const blocked = weekTickets.filter((t) => t.status === 'blocked').concat(blockedElsewhere);
  const done = weekTickets.filter((t) => t.status === 'resolved' || t.status === 'closed');
  const fx = isFixer();
  const todoActs = fx ? [['update', '📝 Update', 'primary'], ['start', '▶ Start'], ['done', '✓ Done', 'ok'], ['next', '→ Next week']] : [];
  const progActs = fx ? [['update', '📝 Update', 'primary'], ['done', '✓ Done', 'ok']] : [];
  const blockActs = fx ? [['update', '📝 Update', 'primary'], ['unblock', 'Unblock']] : [];
  const p1Unplanned = state.tickets.filter((t) => t.priority === 1 && OPEN.includes(t.status) && t.sprint_week !== wk);

  app.innerHTML = `
    <h2>Week of ${wk}</h2>
    ${capacityBlock(weekTickets)}
    ${p1Unplanned.length ? `<div class="card" style="border-color:var(--p1)"><b class="overdue">⚠ ${p1Unplanned.length} P1 ${p1Unplanned.length === 1 ? 'Do' : 'Do’s'} not in this week's plan</b>
      ${p1Unplanned.map((t) => ticketCard(t, fx ? [['schedule', '+ Add to this week', 'primary']] : [])).join('')}</div>` : ''}
    ${inProg.length ? `<h3>In progress</h3>${inProg.map((t) => ticketCard(t, progActs)).join('')}` : ''}
    ${todo.length ? byDay(todo, todoActs) : `<h3>Planned</h3><p class="empty">Nothing planned yet.${fx ? ' Pull from Backlog or hit Auto-fill.' : ''}</p>`}
    ${blocked.length ? `<h3>Blocked</h3>${blocked.map((t) => ticketCard(t, blockActs)).join('')}` : ''}
    ${done.length ? `<h3>Done this week</h3>${done.map((t) => ticketCard(t)).join('')}` : ''}`;
  wireCards(app, fixerHandlers);
  const af = $('#autofill');
  if (af) af.onclick = autoFill;
}

// Planned tickets grouped by their scheduled day; undated ones go under "Anytime this week".
function byDay(list, acts) {
  const groups = new Map();
  const sorted = [...list].sort((a, b) => (a.scheduled_for || '9999').localeCompare(b.scheduled_for || '9999')
    || (a.scheduled_time || '99').localeCompare(b.scheduled_time || '99') || score(b) - score(a));
  for (const t of sorted) {
    const key = t.scheduled_for || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  return [...groups].map(([day, ts]) => {
    let label = 'Anytime this week';
    if (day) {
      const n = daysUntil(day);
      const d = new Date(day + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
      label = `📅 ${n === 0 ? 'Today · ' : n === 1 ? 'Tomorrow · ' : n < 0 ? '⚠ Missed · ' : ''}${d}`;
    }
    return `<h3>${label}</h3>${ts.map((t) => ticketCard(t, acts)).join('')}`;
  }).join('');
}

async function autoFill() {
  const wk = THIS_WEEK();
  const used = state.tickets.filter((t) => t.sprint_week === wk && t.status !== 'new')
    .reduce((n, t) => n + (t.estimate_min || 30), 0);
  let room = state.capacity - used;
  const candidates = state.tickets.filter((t) => t.status === 'backlog' && t.sprint_week !== wk)
    .sort((a, b) => score(b) - score(a));
  const picked = [];
  for (const t of candidates) {
    const cost = t.estimate_min || 30;
    if (cost <= room) { picked.push(t); room -= cost; }
  }
  if (!picked.length) return toast(room <= 0 ? 'Week is already full' : 'Nothing in the backlog fits');
  if (!confirm(`Add ${picked.length} ${picked.length === 1 ? 'Do' : 'Do’s'} to this week?\n\n${picked.map((t) => `• ${t.title} (${fmtMin(t.estimate_min || 30)})`).join('\n')}`)) return;
  for (const t of picked) {
    await api(`/tickets/${t.id}`, { method: 'PATCH', body: { status: 'scheduled', sprint_week: wk } });
  }
  await refresh();
  toast(`Planned ${picked.length} ${picked.length === 1 ? 'Do' : 'Do’s'}`);
  render();
}

function viewTriage() {
  const list = state.tickets.filter((t) => t.status === 'new').sort((a, b) => score(b) - score(a));
  app.innerHTML = `
    <h2>Triage <span class="muted small">— size it, then accept, plan or decline</span></h2>
    ${list.length ? list.map((t) => `
      <div class="card ticket p${t.priority}" data-open="${t.id}">
        <div class="title">${esc(t.title)}</div>
        <div class="meta"><span class="pill p${t.priority}">P${t.priority}</span><span>${CAT_ICON[t.category] || ''} ${esc(t.category)}</span>
          ${t.location ? `<span>📍 ${esc(t.location)}</span>` : ''}<span>${dueText(t)}</span><span>#${t.id} · ${esc(t.requester)} · ${ago(t.created_at)}</span></div>
        ${t.description ? `<div class="small" style="margin-top:6px;white-space:pre-wrap">${esc(t.description)}</div>` : ''}
        <div class="chips" style="margin-top:10px">
          ${SIZES.map((s) => `<button class="chip ${t.estimate_min === s.min ? 'on' : ''}" data-act="size" data-min="${s.min}">${s.label}</button>`).join('')}
        </div>
        <div class="chips" style="margin-top:6px">
          ${[1, 2, 3, 4].map((p) => `<button class="chip ${t.priority === p ? 'on' : ''}" data-act="prio" data-p="${p}">P${p}</button>`).join('')}
        </div>
        <div class="actions">
          <button class="btn sm primary" data-act="update">📅 Schedule</button>
          <button class="btn sm" data-act="schedule">This week</button>
          <button class="btn sm" data-act="accept">Backlog</button>
          <button class="btn sm" data-act="decline">Won't do</button>
        </div>
      </div>`).join('') : '<p class="empty">Inbox zero. 📭</p>'}`;
  wireCards(app, {
    ...fixerHandlers,
    size: (t, b) => patch(t.id, { estimate_min: +b.dataset.min }),
    prio: (t, b) => patch(t.id, { priority: +b.dataset.p }),
    accept: (t) => patch(t.id, { status: 'backlog' }, 'Accepted to backlog'),
    decline: async (t) => {
      const why = prompt(`Why won't this get done? (${t.requester} will see this)`);
      if (why === null) return;
      await api(`/tickets/${t.id}/comments`, { method: 'POST', body: { body: "Won't do: " + (why || 'no reason given') } });
      patch(t.id, { status: 'closed' }, 'Declined');
    },
  });
}

function viewBacklog() {
  const wk = THIS_WEEK();
  let list = state.tickets.filter((t) => ['backlog', 'scheduled', 'blocked'].includes(t.status) && t.sprint_week !== wk);
  const f = state.backlogFilter;
  if (f === 'quick') list = list.filter((t) => t.estimate_min && t.estimate_min <= 30);
  else if (f === 'next') list = list.filter((t) => t.sprint_week === NEXT_WEEK());
  else if (f === 'unsized') list = list.filter((t) => !t.estimate_min);
  else if (CATEGORIES.includes(f)) list = list.filter((t) => t.category === f);
  list.sort((a, b) => score(b) - score(a));
  const total = list.reduce((n, t) => n + (t.estimate_min || 30), 0);

  app.innerHTML = `
    <h2>Backlog <span class="muted small">${list.length} ${list.length === 1 ? 'Do' : 'Do’s'} · ~${fmtMin(total)}</span></h2>
    <div class="chips" style="margin-bottom:12px" id="bf">
      ${[['all', 'All'], ['quick', '⚡ Quick wins ≤30m'], ['next', 'Next week'], ['unsized', 'Unsized'], ...CATEGORIES.map((c) => [c, CAT_ICON[c] + ' ' + c])]
        .map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
    </div>
    ${list.length ? list.map((t) => ticketCard(t,
      t.status === 'blocked' ? [['unblock', 'Unblock']]
        : t.sprint_week === NEXT_WEEK() ? [['schedule', '+ This week', 'primary'], ['unplan', 'Unplan']]
          : [['update', '📅 Schedule', 'primary'], ['schedule', '+ This week'], ['next', 'Next week'], ['done', '✓ Already done', 'ok']])).join('')
      : '<p class="empty">Nothing here.</p>'}
    <p class="muted small center">Sorted by priority, then due date, then age — old requests float up so nothing rots.</p>`;
  $('#bf').querySelectorAll('[data-f]').forEach((b) => {
    b.onclick = () => { state.backlogFilter = b.dataset.f; viewBacklog(); };
  });
  wireCards(app, fixerHandlers);
}

function viewDone() {
  const list = state.tickets.filter((t) => t.status === 'resolved' || t.status === 'closed')
    .sort((a, b) => (b.resolved_at || b.closed_at || '').localeCompare(a.resolved_at || a.closed_at || ''));
  app.innerHTML = `
    ${statsBlock()}
    <h3>Recently done (30 days)</h3>
    ${list.length ? list.map((t) => ticketCard(t, t.status === 'resolved' ? [['reopen', 'Reopen']] : [])).join('') : '<p class="empty">Nothing yet — go get one! 💪</p>'}`;
  wireCards(app, fixerHandlers);
}

function viewAll() {
  const groups = ['new', 'in_progress', 'scheduled', 'blocked', 'backlog', 'resolved'];
  const by = (s) => state.tickets.filter((t) => t.status === s).sort((a, b) => score(b) - score(a));
  app.innerHTML = `${statsBlock()}${groups.map((s) => {
    const l = by(s);
    return l.length ? `<h3>${STATUS_LABEL[s]} (${l.length})</h3>${l.map((t) => ticketCard(t)).join('')}` : '';
  }).join('')}`;
  wireCards(app, fixerHandlers);
}

function viewSettings() {
  app.innerHTML = `
    <h2>Settings</h2>
    <form id="sf" class="card">
      <label>Household members</label>
      <div id="members">
        ${state.members.map((m) => memberRow(m)).join('')}
      </div>
      <button type="button" class="btn sm" id="addm" style="margin-top:6px">+ Add person</button>
      <label style="margin-top:16px">Hours available for chores per week</label>
      <input type="number" name="cap" min="0" max="168" step="0.5" value="${state.capacity / 60}">
      <p class="muted small">Be honest — this is what "This week" plans against. Over-capacity shows red so you can negotiate what slips.</p>
      <button class="btn primary block" style="margin-top:12px">Save</button>
    </form>
    <div class="card row spread">
      <div class="grow" style="min-width:0"><b>📖 Household dictionary</b>
        <div class="muted small">${state.dictionary.length ? `${state.dictionary.length} names, words &amp; phrases` : 'Teach it names (Dr. Saan), and shorthand ("the usual")'}</div></div>
      <button type="button" class="btn sm primary" id="open-dict">Open</button>
    </div>
    <div class="card">
      <b>Speech recognition on this phone</b>
      <div class="chips" id="stt" style="margin-top:8px">
        <button type="button" class="chip ${sttPref() === 'whisper' ? 'on' : ''}" data-stt="whisper">🎯 Whisper (most accurate)</button>
        <button type="button" class="chip ${sttPref() === 'browser' ? 'on' : ''}" data-stt="browser" ${SpeechRec ? '' : 'disabled'}>⚡ Phone (live, instant)</button>
      </div>
      <p class="muted small">Whisper large-v3 turbo on Cloudflare: text appears a few seconds after you stop. Phone speech shows words as you talk but makes more mistakes.</p>
    </div>
    <div class="card">
      <b>Phone notifications</b>
      <p class="muted small">Get a buzz on this phone when there's an update, even when the app is in the background.</p>
      <div class="row">
        <button class="btn sm" id="notif-on">${'Notification' in window && Notification.permission === 'granted' ? '✓ Enabled — send a test' : '🔔 Enable notifications'}</button>
        <button class="btn sm" id="install" ${installPrompt ? '' : 'hidden'}>📲 Install app</button>
      </div>
    </div>
    <div class="card row spread">
      <span class="small muted">Logged in on this device</span>
      <button class="btn sm danger" id="logout">Log out</button>
    </div>`;
  $('#addm').onclick = () => $('#members').insertAdjacentHTML('beforeend', memberRow({ name: '', role: 'requester' }));
  $('#members').onclick = (e) => { if (e.target.dataset.rm !== undefined) e.target.closest('.row').remove(); };
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const members = [...$('#members').querySelectorAll('.row')].map((r) => ({
      name: r.querySelector('input').value.trim(), role: r.querySelector('select').value,
    })).filter((m) => m.name);
    try {
      const old = state.me;
      const r = await api('/settings', { method: 'PUT', body: { members, capacity_min: Math.round(+e.target.cap.value * 60) } });
      state.members = r.members;
      state.capacity = r.capacity_min;
      toast('Saved');
      if (!state.members.some((m) => m.name === old)) return renderWhoAmI();
      render();
    } catch (er) { toast(er.message); }
  };
  $('#notif-on').onclick = enableNotifications;
  $('#open-dict').onclick = () => { state.tab = 'dict'; render(); window.scrollTo(0, 0); };
  $('#stt').querySelectorAll('[data-stt]').forEach((b) => {
    b.onclick = () => { localStorage.setItem('dd_stt', b.dataset.stt); toast(b.dataset.stt === 'whisper' ? 'Using Whisper' : 'Using phone speech'); viewSettings(); };
  });
  $('#install').onclick = async () => { if (installPrompt) { installPrompt.prompt(); installPrompt = null; } };
  $('#logout').onclick = async () => { await api('/logout', { method: 'POST' }).catch(() => {}); renderLogin(); };
}

function memberRow(m) {
  return `<div class="row" style="margin-bottom:6px">
    <input type="text" class="grow" value="${esc(m.name)}" placeholder="Name" style="flex:1;width:auto">
    <select style="width:auto">
      <option value="fixer" ${m.role === 'fixer' ? 'selected' : ''}>Does the work</option>
      <option value="requester" ${m.role === 'requester' ? 'selected' : ''}>Requests</option>
    </select>
    <button type="button" class="btn sm danger" data-rm>✕</button>
  </div>`;
}

// ---------- voice brain-dump: speech → transcript → AI → reviewable tickets ----------

const voice = {
  transcript: '',
  interim: '',
  recording: false,
  engine: null, // 'speech' (browser) | 'server' (record + Whisper)
  rec: null,
  mediaRec: null,
  chunks: [],
  startedAt: 0,
  timer: null,
  busy: '',
  result: null, // { items, questions, not_tasks }
  machine: '', // what speech-to-text produced (before hand edits), for learning corrections
  learn: [],
  requester: '',
};

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
// Per-phone choice: 'whisper' (record → Cloudflare Whisper, most accurate) or 'browser' (live, phone's own engine).
const sttPref = () => localStorage.getItem('dd_stt') || 'whisper';

function viewVoice() {
  if (!voice.requester) voice.requester = isFixer() ? (state.members.find((m) => m.role === 'requester')?.name || state.me) : state.me;
  if (voice.result) return viewVoiceReview();
  const secs = voice.recording ? Math.floor((Date.now() - voice.startedAt) / 1000) : 0;
  app.innerHTML = `
    <h2>${isFixer() ? 'Capture what was asked' : 'Just say it'}</h2>
    <p class="muted small">Talk naturally — list as many things as you want. AI splits it into separate Do’s with steps, sizes and a shopping list. You review before anything is filed.</p>
    <div class="card center">
      <button id="mic" class="mic ${voice.recording ? 'on' : ''}" aria-label="${voice.recording ? 'Stop recording' : 'Start recording'}">
        ${voice.recording ? '■' : '🎙'}
      </button>
      <div class="lvl" id="lvl" ${voice.recording && voice.engine === 'server' ? '' : 'hidden'}><div></div></div>
      <div class="small muted" id="mic-status" style="margin-top:8px">
        ${voice.recording ? `Listening… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — tap to stop` : voice.busy || 'Tap to talk'}
      </div>
      <div class="small muted" style="margin-top:4px">${sttPref() === 'browser' && SpeechRec ? '⚡ Phone speech (live)' : '🎯 Whisper large-v3 turbo · text appears after you stop'} · <button class="link small" id="stt-switch">change</button></div>
    </div>
    <label>Transcript <span class="muted">(edit anything it mis-heard — or type / use your keyboard's mic)</span></label>
    <textarea id="tx" rows="7" placeholder="e.g. &quot;The kitchen faucet is dripping again, and can you put the Christmas lights up before the party on the 14th, oh and the smoke detector in the hallway keeps chirping…&quot;">${esc(voice.transcript + (voice.interim ? ' ' + voice.interim : ''))}</textarea>
    <p class="small" style="margin:6px 0 0"><button class="link small" id="teach">📖 Teach it a name or phrase</button> <span class="muted">· ${state.dictionary.length} known</span></p>
    ${isFixer() ? `<label>Who asked?</label><select id="reqr">${state.members.map((m) => `<option ${m.name === voice.requester ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
    <div class="row" style="margin-top:12px">
      <button class="btn primary grow" id="parse" ${voice.busy ? 'disabled' : ''}>✨ Turn into Do’s</button>
      <button class="btn" id="clear">Clear</button>
    </div>`;

  $('#mic').onclick = () => (voice.recording ? stopRecording() : startRecording());
  $('#stt-switch').onclick = () => { if (!voice.recording) { state.tab = 'settings'; render(); } };
  $('#teach').onclick = () => { if (!voice.recording) { voice.returnToTalk = true; state.tab = 'dict'; render(); window.scrollTo(0, 0); } };
  $('#tx').oninput = (e) => { voice.transcript = e.target.value; voice.interim = ''; };
  const rq = $('#reqr');
  if (rq) rq.onchange = (e) => { voice.requester = e.target.value; };
  $('#clear').onclick = () => { voice.transcript = ''; voice.interim = ''; voice.machine = ''; viewVoice(); };
  $('#parse').onclick = parseTranscript;
}

function setMicStatus(text) {
  const el = $('#mic-status');
  if (el) el.textContent = text;
}
function syncTranscriptBox() {
  const tx = $('#tx');
  if (tx) tx.value = (voice.transcript + (voice.interim ? ' ' + voice.interim : '')).trim();
}

async function startRecording() {
  voice.recording = true;
  voice.startedAt = Date.now();
  voice.engine = sttPref() === 'browser' && SpeechRec && !voice.forceServer ? 'speech' : 'server';
  try {
    if (voice.engine === 'speech') startSpeechRecognition();
    else await startMediaRecorder();
  } catch (e) {
    voice.recording = false;
    toast(e.message || 'Microphone unavailable');
  }
  viewVoice();
  clearInterval(voice.timer);
  voice.timer = setInterval(() => {
    if (!voice.recording) return clearInterval(voice.timer);
    const s = Math.floor((Date.now() - voice.startedAt) / 1000);
    setMicStatus(`Listening… ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} — tap to stop`);
  }, 500);
}

function startSpeechRecognition() {
  const rec = new SpeechRec();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onresult = (ev) => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const r = ev.results[i];
      if (r.isFinal) {
        const fixed = applyDictionary(r[0].transcript.trim());
        voice.machine = (voice.machine + ' ' + fixed.text).trim();
        voice.transcript = (voice.transcript + ' ' + fixed.text).trim();
        announceFixes(fixed.fixes);
      }
      else interim += r[0].transcript;
    }
    voice.interim = interim.trim();
    syncTranscriptBox();
  };
  rec.onerror = async (ev) => {
    if (ev.error === 'no-speech' || ev.error === 'aborted') return;
    // Browser speech service unavailable (common in iOS home-screen apps) → record + server Whisper.
    if (voice.recording && ['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(ev.error)) {
      voice.forceServer = true;
      voice.rec = null;
      if (ev.error === 'not-allowed') { voice.recording = false; toast('Microphone permission denied'); viewVoice(); return; }
      try { voice.engine = 'server'; await startMediaRecorder(); toast('Using server transcription'); } catch (e) { voice.recording = false; toast(e.message); viewVoice(); }
    }
  };
  // Mobile browsers end sessions after a pause — keep listening until the user taps stop.
  rec.onend = () => {
    if (voice.recording && voice.engine === 'speech') {
      try { rec.start(); } catch { /* already started */ }
    }
  };
  rec.start();
  voice.rec = rec;
}

async function startMediaRecorder() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    throw new Error('This browser cannot record audio — use your keyboard mic instead.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined);
  voice.chunks = [];
  mr.ondataavailable = (e) => { if (e.data.size) voice.chunks.push(e.data); };
  const stopMeter = startLevelMeter(stream);
  mr.onstop = async () => {
    stopMeter();
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(voice.chunks, { type: mr.mimeType || 'audio/webm' });
    if (!blob.size) return;
    voice.busy = '🎯 Transcribing with Whisper…';
    viewVoice();
    try {
      const text = await transcribeRecording(blob);
      if (text) {
        const fixed = applyDictionary(text);
        voice.machine = (voice.machine + ' ' + fixed.text).trim();
        voice.transcript = (voice.transcript + ' ' + fixed.text).trim();
        announceFixes(fixed.fixes);
      }
      else toast("Didn't catch any speech — try again a little closer to the phone");
    } catch (e) {
      toast(e.message);
    }
    voice.busy = '';
    viewVoice();
  };
  mr.start(1000);
  voice.mediaRec = mr;
}

// Live input level so she can see it's hearing her (Whisper text only arrives after stopping).
function startLevelMeter(stream) {
  let ctx; let raf = 0;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume?.().catch(() => {}); // created after an await, so Chrome may start it suspended
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      const bar = $('#lvl > div');
      if (bar) bar.style.width = `${Math.round(level * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* meter is optional */ }
  return () => { cancelAnimationFrame(raf); try { ctx?.close(); } catch { /* ignore */ } };
}

// ---- audio prep: decode → 16 kHz mono → split at pauses → WAV chunks → Whisper ----
const SR = 16000;
const CHUNK_TARGET_S = 90;  // ~2.9 MB of WAV per request
const CHUNK_SEARCH_S = 20;  // look back this far for the quietest spot to cut

async function toMono16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * SR), SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    return (await off.startRendering()).getChannelData(0);
  } finally {
    try { ctx.close(); } catch { /* ignore */ }
  }
}

function rms(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function splitAtPauses(samples) {
  const out = [];
  const target = CHUNK_TARGET_S * SR;
  const search = CHUNK_SEARCH_S * SR;
  const frame = SR / 10; // 100 ms
  let start = 0;
  while (samples.length - start > target + search / 2) {
    let best = start + target;
    let bestE = Infinity;
    for (let f = start + target - search; f < start + target; f += frame) {
      const e = rms(samples, f, f + frame);
      if (e < bestE) { bestE = e; best = f + frame / 2; }
    }
    out.push(samples.subarray(start, best));
    start = best;
  }
  out.push(samples.subarray(start));
  return out.filter((c) => c.length > SR * 0.5 && rms(c, 0, c.length) > 0.002); // drop near-silent bits
}

function encodeWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function sendChunk(body, contentType, context) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch('/api/transcribe', {
      method: 'POST', body, credentials: 'same-origin',
      headers: {
        'content-type': contentType,
        'x-user': encodeURIComponent(state.me),
        'x-context': encodeURIComponent(context.slice(-400)),
        'x-language': (navigator.language || 'en').slice(0, 2),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data.text || '';
    if (attempt === 1 || res.status < 500) throw new Error(data.error || `Transcription failed (HTTP ${res.status})`);
  }
  return '';
}

async function transcribeRecording(blob) {
  let chunks;
  try {
    chunks = splitAtPauses(await toMono16k(blob)).map(encodeWav);
  } catch {
    // Couldn't decode locally — send the original recording and let the server try.
    return sendChunk(blob, blob.type || 'audio/webm', voice.transcript);
  }
  let text = '';
  for (let i = 0; i < chunks.length; i++) {
    if (chunks.length > 1) setMicStatus(`🎯 Transcribing with Whisper… part ${i + 1} of ${chunks.length}`);
    const part = await sendChunk(chunks[i], 'audio/wav', (voice.transcript + ' ' + text).trim());
    text = (text + ' ' + part).trim();
  }
  return text;
}

function stopRecording() {
  voice.recording = false;
  clearInterval(voice.timer);
  if (voice.rec) { try { voice.rec.stop(); } catch { /* ignore */ } voice.rec = null; }
  if (voice.mediaRec && voice.mediaRec.state !== 'inactive') voice.mediaRec.stop();
  voice.mediaRec = null;
  if (voice.interim) { voice.transcript = (voice.transcript + ' ' + voice.interim).trim(); voice.interim = ''; }
  viewVoice();
}

async function parseTranscript() {
  if (voice.recording) stopRecording();
  const typed = ($('#tx')?.value || voice.transcript).trim();
  if (!typed) return toast('Say or type something first');
  const fixed = applyDictionary(typed);
  const text = fixed.text;
  announceFixes(fixed.fixes);
  // Words she corrected by hand in the transcript → offer to remember them.
  voice.learn = voice.machine ? learnCorrections(voice.machine, typed) : [];
  voice.transcript = text;
  voice.busy = '✨ Working out the Do’s…';
  viewVoice();
  try {
    const r = await api('/parse', { method: 'POST', body: { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    r.items.forEach((it) => { it.keep = !it.duplicate_of; });
    voice.result = r;
    if (!r.items.length) toast("Didn't find any Do’s in that");
  } catch (e) {
    toast(e.message);
  }
  voice.busy = '';
  viewVoice();
}

function buildDescription(it) {
  const parts = [];
  if (it.description) parts.push(it.description);
  if (it.steps.length) parts.push('Steps:\n' + it.steps.map((s) => `☐ ${s}`).join('\n'));
  if (it.shopping.length) parts.push('🛒 Need: ' + it.shopping.join(', '));
  if (it.source_quote) parts.push(`🗣 “${it.source_quote}”`);
  return parts.join('\n\n');
}

function viewVoiceReview() {
  const { items, questions, not_tasks: notTasks } = voice.result;
  const kept = items.filter((i) => i.keep).length;
  const mins = items.filter((i) => i.keep).reduce((n, i) => n + i.estimate_min, 0);
  const titleOf = (id) => state.tickets.find((t) => t.id === id)?.title || '';
  app.innerHTML = `
    <div class="row spread"><h2>${items.length} ${items.length === 1 ? 'Do' : 'Do’s'} found</h2>
      <button class="link" id="back">← Edit transcript</button></div>
    <p class="muted small">Untick anything you don't want, tweak, then file. ${isFixer() ? `Filed as requested by <b>${esc(voice.requester)}</b>.` : ''}</p>
    ${(voice.learn || []).length ? `<div class="card learn"><b>📖 Remember your corrections?</b>
      <p class="muted small">You fixed these in the transcript. Save them and they'll be corrected automatically next time.</p>
      ${voice.learn.map((l, i) => `<div class="row spread learn-row"><span class="small"><s>${esc(l.heard)}</s> → <b>${esc(l.text)}</b></span>
        <button class="btn sm" data-learn="${i}">${l.saved ? '✓ Saved' : 'Remember'}</button></div>`).join('')}
    </div>` : ''}
    ${questions.length ? `<div class="card" style="border-color:var(--warn)"><b>🤔 Worth clarifying</b><ul class="small">${questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>` : ''}
    <div id="props">
    ${items.map((it, i) => `
      <div class="card ticket p${it.priority} ${it.keep ? '' : 'off'}" data-i="${i}">
        <div class="row">
          <input type="checkbox" class="keep" ${it.keep ? 'checked' : ''} style="width:20px;height:20px">
          <input type="text" class="t grow" value="${esc(it.title)}" style="flex:1;width:auto;font-weight:600">
        </div>
        ${it.duplicate_of ? `<div class="small" style="margin-top:6px;color:var(--warn)">⚠ Looks like existing #${it.duplicate_of}: ${esc(titleOf(it.duplicate_of))} — unticked</div>` : ''}
        <div class="grid3">
          <select class="p">${[1, 2, 3, 4].map((p) => `<option value="${p}" ${it.priority === p ? 'selected' : ''}>${PRIORITIES[p].label}</option>`).join('')}</select>
          <select class="s">${SIZES.map((s) => `<option value="${s.min}" ${it.estimate_min === s.min ? 'selected' : ''}>${s.label}</option>`).join('')}</select>
          <select class="c">${CATEGORIES.map((c) => `<option ${it.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </div>
        <div class="meta">
          ${it.location ? `<span>📍 ${esc(it.location)}</span>` : ''}
          ${it.due_date ? `<span>⏰ by ${esc(it.due_date)}</span>` : ''}
          ${it.recur_days ? `<span>🔁 every ${it.recur_days}d</span>` : ''}
        </div>
        ${it.steps.length ? `<ol class="small steps">${it.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : ''}
        ${it.shopping.length ? `<div class="small">🛒 ${it.shopping.map(esc).join(' · ')}</div>` : ''}
        ${it.source_quote ? `<div class="small muted" style="margin-top:6px">🗣 “${esc(it.source_quote)}”</div>` : ''}
      </div>`).join('')}
    </div>
    ${notTasks.length ? `<details class="card"><summary class="muted small">Heard, but not Do’s (${notTasks.length})</summary><ul class="small">${notTasks.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    <button class="btn primary block" id="file" ${kept ? '' : 'disabled'}>Add ${kept} ${kept === 1 ? 'Do' : 'Do’s'} · ~${fmtMin(mins)}</button>
    <button class="btn block" id="discard" style="margin-top:8px">Discard</button>`;

  $('#back').onclick = () => { voice.result = null; viewVoice(); };
  app.querySelectorAll('[data-learn]').forEach((b) => {
    b.onclick = async () => {
      const l = voice.learn[+b.dataset.learn];
      if (l.saved) return;
      const dict = state.dictionary.map((e) => ({ ...e, heard: [...e.heard] }));
      const hit = dict.find((e) => e.kind === 'word' && e.text.toLowerCase() === l.text.toLowerCase());
      if (hit) { if (!hit.heard.some((h) => h.toLowerCase() === l.heard.toLowerCase())) hit.heard.push(l.heard); }
      else dict.push({ kind: 'word', text: l.text, heard: [l.heard], means: '' });
      if (await saveDictionary(dict)) { l.saved = true; toast(`📖 Remembered: “${l.heard}” → ${l.text}`); viewVoiceReview(); }
    };
  });
  $('#discard').onclick = () => { voice.result = null; voice.transcript = ''; voice.machine = ''; viewVoice(); };
  $('#props').querySelectorAll('[data-i]').forEach((card) => {
    const it = items[+card.dataset.i];
    card.querySelector('.keep').onchange = (e) => { it.keep = e.target.checked; viewVoiceReview(); };
    card.querySelector('.t').oninput = (e) => { it.title = e.target.value; };
    card.querySelector('.p').onchange = (e) => { it.priority = +e.target.value; viewVoiceReview(); };
    card.querySelector('.s').onchange = (e) => { it.estimate_min = +e.target.value; viewVoiceReview(); };
    card.querySelector('.c').onchange = (e) => { it.category = e.target.value; };
  });
  $('#file').onclick = async () => {
    const btn = $('#file');
    btn.disabled = true;
    const toFile = items.filter((i) => i.keep && i.title.trim());
    let ok = 0;
    for (const it of toFile) {
      btn.textContent = `Filing ${ok + 1}/${toFile.length}…`;
      try {
        const r = await api('/tickets', {
          method: 'POST',
          body: {
            title: it.title, description: buildDescription(it), priority: it.priority,
            category: it.category, location: it.location, due_date: it.due_date,
            estimate_min: it.estimate_min, recur_days: it.recur_days, requester: voice.requester,
          },
        });
        state.tickets.unshift({ ...r.ticket, comment_count: 0 });
        ok++;
      } catch (e) { toast(e.message); }
    }
    toast(`Added ${ok} ${ok === 1 ? 'Do' : 'Do’s'} 🎉`);
    voice.result = null;
    voice.transcript = '';
    api('/stats').then((s) => { state.stats = s.stats; });
    state.tab = isFixer() ? 'triage' : 'mine';
    render();
  };
}

// ---------- "Post update" dialog: status + schedule + message in one go ----------

function isoIn(days) { const d = new Date(); d.setDate(d.getDate() + days); return isoDate(d); }
function nextDow(dow) { // 0=Sun..6=Sat; today counts
  const d = new Date();
  d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
  return isoDate(d);
}

function openUpdate(t, presetStatus) {
  const u = {
    status: presetStatus || t.status,
    date: t.scheduled_for || '',
    time: t.scheduled_time || '',
  };
  const choices = [
    ['scheduled', '📅 Scheduled'], ['in_progress', '▶ Working on it'],
    ['blocked', '🚧 Blocked'], ['resolved', '✅ Done'],
  ];
  const draw = () => {
    const pts = pointsFor(t);
    const deadline = u.date || t.due_date;
    const onTime = deadline && isoDate(new Date()) <= deadline;
    modalBody.innerHTML = `
      <div class="row spread"><b>Update: ${esc(t.title)}</b><button class="btn sm" id="uclose">✕</button></div>
      <p class="muted small">${esc(t.requester)} gets notified with whatever you post here.</p>
      <label>Status</label>
      <div class="chips" id="ust">${choices.map(([k, l]) => `<button type="button" class="chip ${u.status === k ? 'on' : ''}" data-s="${k}">${l}</button>`).join('')}</div>
      ${u.status === 'resolved' ? `<div class="card gold-card small" style="margin-top:10px">⭐ Completing earns <b>${pts} pts</b>${onTime ? ` + <b>${Math.max(5, Math.round(pts * 0.25))}</b> on-time bonus` : ''}, plus <b>10</b> more when ${esc(t.requester)} approves.</div>` : ''}
      ${u.status !== 'resolved' ? `
        <label>When will you do it?</label>
        <div class="chips" id="uq">
          <button type="button" class="chip" data-d="${isoIn(0)}">Today</button>
          <button type="button" class="chip" data-d="${isoIn(1)}">Tomorrow</button>
          <button type="button" class="chip" data-d="${nextDow(6)}">Sat</button>
          <button type="button" class="chip" data-d="${nextDow(0)}">Sun</button>
          <button type="button" class="chip" data-d="">No date</button>
        </div>
        <div class="grid2" style="margin-top:6px">
          <input type="date" id="ud" value="${esc(u.date)}">
          <input type="time" id="ut" value="${esc(u.time)}">
        </div>` : ''}
      ${u.status === 'blocked' ? `<label>Blocked on</label><input type="text" id="ub" value="${esc(t.blocked_reason || '')}" placeholder="e.g. waiting on a part from Amazon">` : ''}
      <label>Message for ${esc(t.requester)} <span class="muted">(optional)</span></label>
      <textarea id="un" rows="3" placeholder="${u.status === 'resolved' ? 'e.g. New washer in — no more drip!' : 'e.g. Picked up the part, doing it Saturday morning'}"></textarea>
      <button class="btn primary block" id="usend" style="margin-top:12px">Post update</button>`;
    $('#uclose').onclick = () => modal.close();
    $('#ust').querySelectorAll('[data-s]').forEach((b) => {
      b.onclick = () => { keepNote(); u.status = b.dataset.s; draw(); };
    });
    $('#uq')?.querySelectorAll('[data-d]').forEach((b) => {
      b.onclick = () => { keepNote(); u.date = b.dataset.d; if (!u.date) u.time = ''; draw(); };
    });
    const ud = $('#ud'); const ut = $('#ut');
    if (ud) ud.onchange = () => { u.date = ud.value; };
    if (ut) ut.onchange = () => { u.time = ut.value; };
    if (u.note) $('#un').value = u.note;
    $('#usend').onclick = send;
  };
  const keepNote = () => { u.note = $('#un')?.value || ''; };
  const send = async () => {
    keepNote();
    const body = { note: u.note.trim() };
    if (u.status !== t.status) body.status = u.status;
    if (u.status !== 'resolved') {
      if ((u.date || null) !== (t.scheduled_for || null)) body.scheduled_for = u.date || null;
      if ((u.time || null) !== (t.scheduled_time || null)) body.scheduled_time = u.time || null;
      if (u.status === 'scheduled' && !u.date && !t.sprint_week) body.sprint_week = THIS_WEEK();
    }
    if (u.status === 'blocked') body.blocked_reason = $('#ub').value.trim() || 'waiting';
    if (Object.keys(body).length === 1 && !body.note) { modal.close(); return; }
    $('#usend').disabled = true;
    const r = await patch(t.id, body, `Update sent to ${t.requester} 🔔`);
    if (r) modal.close(); else $('#usend').disabled = false;
  };
  if (!modal.open) modal.showModal();
  draw();
}

// ---------- rewards / points ----------

function weekStreak(member) {
  const weeks = new Set((state.points?.weekly || []).filter((w) => w.member === member && w.pts > 0).map((w) => w.week));
  let wk = THIS_WEEK();
  const back = (iso) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() - 7); return isoDate(d); };
  if (!weeks.has(wk)) wk = back(wk); // this week isn't over yet
  let n = 0;
  while (weeks.has(wk)) { n++; wk = back(wk); }
  return n;
}

function viewRewards() {
  const fixers = state.members.filter((m) => m.role === 'fixer');
  const P = state.points || { rewards: [], history: [] };
  const me = isFixer();
  app.innerHTML = `
    ${fixers.map((f) => {
      const t = myTotals(f.name);
      const lv = levelOf(t.lifetime || 0);
      const streak = weekStreak(f.name);
      return `<div class="card score">
        <div class="row spread">
          <div><div class="lv">${lv.icon} Level ${lv.n} · ${esc(lv.name)}</div><div class="muted small">${esc(f.name)}</div></div>
          <div class="center"><div class="big-pts">⭐ ${t.balance || 0}</div><div class="muted small">points to spend</div></div>
        </div>
        <div class="capbar gold-bar"><div style="width:${lv.pct}%"></div></div>
        <div class="small muted">${lv.next ? `${lv.next - (t.lifetime || 0)} pts to ${esc(lv.nextName)}` : 'Max level — legend status'} · ${t.lifetime || 0} earned all-time</div>
        <div class="stats" style="margin:12px 0 0">
          <div class="stat"><b>${t.last7 || 0}</b><span>pts this week</span></div>
          <div class="stat"><b>${t.jobs || 0}</b><span>jobs done</span></div>
          <div class="stat"><b>${t.ontime || 0}</b><span>on time ⏱</span></div>
          <div class="stat"><b>${t.thanks || 0}</b><span>approved ✓</span></div>
          <div class="stat"><b>${streak}🔥</b><span>week streak</span></div>
        </div>
      </div>`;
    }).join('')}
    <h3>Reward shop</h3>
    ${P.rewards.length ? P.rewards.map((r) => {
      const bal = myTotals().balance || 0;
      return `<div class="card row spread">
        <div><span style="font-size:22px">${esc(r.emoji)}</span> <b>${esc(r.title)}</b><div class="muted small">⭐ ${r.cost} pts</div></div>
        <div class="row">
          ${me ? (bal >= r.cost ? `<button class="btn sm ok" data-redeem="${r.id}">Redeem</button>` : `<span class="muted small">${r.cost - bal} more</span>`) : ''}
          ${!me ? `<button class="btn sm danger" data-rm-reward="${r.id}">Remove</button>` : ''}
        </div>
      </div>`;
    }).join('') : '<p class="empty">No rewards yet.</p>'}
    ${!me ? `<form id="rf" class="card">
      <b>Add a reward</b>
      <div class="row" style="margin-top:8px">
        <input type="text" name="emoji" value="🎁" style="width:56px;text-align:center">
        <input type="text" name="title" placeholder="e.g. Saturday morning golf" style="flex:1;width:auto" required>
        <input type="number" name="cost" placeholder="pts" min="1" style="width:90px" required>
      </div>
      <button class="btn primary" style="margin-top:8px">Add reward</button>
      <p class="muted small">Rough guide: a 30-min job ≈ 20 pts, a 1-hour job ≈ 35, a half-day project ≈ 80–180.</p>
    </form>` : ''}
    <h3>Recent points</h3>
    ${P.history.length ? `<div class="card">${P.history.map((h) => `
      <div class="row spread hist">
        <span class="small">${h.kind === 'redeem' ? '🎁' : h.kind === 'ontime' ? '⏱' : h.kind === 'thanks' ? '✓' : '✅'} ${esc(h.title || h.note)}${h.kind === 'ontime' ? ' <span class="muted">(on time)</span>' : h.kind === 'thanks' ? ` <span class="muted">(${esc(h.note)})</span>` : ''}</span>
        <b class="${h.points > 0 ? 'gold' : 'muted'}">${h.points > 0 ? '+' : ''}${h.points}</b>
      </div>`).join('')}</div>` : '<p class="empty">Finish a Do to earn your first points! 💪</p>'}
    <details class="card small"><summary class="muted">How points work</summary>
      <p>Size: 15m = 10 · 30m = 20 · 1h = 35 · 3h = 80 · day = 180. P1 ×1.5, P2 ×1.25.<br>
      +25% if done on or before the scheduled day / due date. +10 when the requester approves ✓.<br>
      Reopened Do’s lose their points until they're really done.</p>
    </details>`;

  app.querySelectorAll('[data-redeem]').forEach((b) => {
    b.onclick = async () => {
      const r = P.rewards.find((x) => x.id === +b.dataset.redeem);
      if (!confirm(`Spend ${r.cost} pts on "${r.title}"?`)) return;
      try {
        await api(`/rewards/${r.id}/redeem`, { method: 'POST' });
        toast(`🎉 Enjoy: ${r.title}`);
        await refreshPoints();
        render();
      } catch (e) { toast(e.message); }
    };
  });
  app.querySelectorAll('[data-rm-reward]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Remove this reward?')) return;
      await api(`/rewards/${b.dataset.rmReward}`, { method: 'DELETE' });
      await refreshPoints();
      render();
    };
  });
  const rf = $('#rf');
  if (rf) {
    rf.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/rewards', { method: 'POST', body: { emoji: rf.emoji.value, title: rf.title.value, cost: +rf.cost.value } });
        toast('Reward added');
        await refreshPoints();
        render();
      } catch (er) { toast(er.message); }
    };
  }
}

// ---------- notification centre ----------

const NOTIF_ICON = { new: '🆕', status: '🔄', update: '💬', comment: '💬', scheduled: '📅', resolved: '✅', points: '⭐', reward: '🎉' };

function openNotifications() {
  const draw = () => {
    modalBody.innerHTML = `
      <div class="row spread"><b>🔔 Notifications</b>
        <div class="row">${state.unread ? '<button class="btn sm" id="nall">Mark all read</button>' : ''}<button class="btn sm" id="nclose">✕</button></div></div>
      ${'Notification' in window && Notification.permission !== 'granted'
        ? '<button class="btn sm block" id="nperm" style="margin-top:10px">📲 Also buzz my phone for updates</button>' : ''}
      <div style="margin-top:10px">
      ${state.notifs.length ? state.notifs.map((n) => `
        <div class="notif ${n.read_at ? '' : 'unread'}" data-n="${n.id}" data-t="${n.ticket_id || ''}">
          <span class="ni">${NOTIF_ICON[n.kind] || '🔔'}</span>
          <div class="grow"><div class="small">${esc(n.body)}</div><div class="muted small">${esc(n.actor)} · ${ago(n.created_at)}</div></div>
        </div>`).join('') : '<p class="empty">No notifications yet.</p>'}
      </div>`;
    $('#nclose').onclick = () => modal.close();
    const na = $('#nall');
    if (na) na.onclick = async () => {
      const r = await api('/notifications/read', { method: 'POST', body: {} });
      state.notifs = r.notifications; state.unread = r.unread; updateBell(); draw();
    };
    const np = $('#nperm');
    if (np) np.onclick = async () => { await enableNotifications(); draw(); };
    modalBody.querySelectorAll('[data-n]').forEach((el) => {
      el.onclick = async () => {
        const r = await api('/notifications/read', { method: 'POST', body: { ids: [+el.dataset.n] } });
        state.notifs = r.notifications; state.unread = r.unread; updateBell();
        if (el.dataset.t) openTicket(+el.dataset.t);
        else if (/pts|reward|cashed/i.test(el.textContent)) { modal.close(); state.tab = 'rewards'; render(); }
        else draw();
      };
    });
  };
  if (!modal.open) modal.showModal();
  draw();
}

async function enableNotifications() {
  if (!('Notification' in window)) return toast('This browser does not support notifications');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('Notifications blocked — allow them in Chrome site settings');
  const reg = await navigator.serviceWorker?.ready;
  await reg?.showNotification('Daddy-Do', { body: "✓ You'll get a buzz here when there's an update.", icon: '/icon-192.png', badge: '/icon-192.png' });
  toast('Notifications on 🔔');
  if (state.tab === 'settings') render();
}

// ---------- household dictionary: names, mis-hearings and shorthand ----------
// Spellings + phrases also prime Whisper (server) and act as a glossary for Claude (server).
// Here on the phone we fix listed mis-hearings right away and learn new ones from hand edits.

const reEsc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function applyDictionary(text) {
  const fixes = [];
  let out = text;
  const pairs = [];
  for (const e of state.dictionary) {
    if (e.kind !== 'word') continue;
    for (const h of e.heard) pairs.push([h, e.text]);
  }
  pairs.sort((a, b) => b[0].length - a[0].length); // longest phrase first
  for (const [heard, right] of pairs) {
    const words = heard.split(/\s+/).map((w) => reEsc(w.replace(/[.,!?;:]+$/, '')));
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${words.join('[\\s,.\\-]+')})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    out = out.replace(re, (m, pre, hit) => {
      if (hit === right) return m;
      fixes.push({ from: hit, to: right });
      return pre + right;
    });
  }
  return { text: out, fixes };
}

function announceFixes(fixes) {
  if (!fixes.length) return;
  const uniq = [...new Map(fixes.map((f) => [f.from.toLowerCase() + '→' + f.to, f])).values()];
  toast(`📖 Fixed: ${uniq.slice(0, 3).map((f) => `“${f.from}” → ${f.to}`).join(', ')}${uniq.length > 3 ? '…' : ''}`);
}

// Compare what speech-to-text wrote with what she ended up sending; short word swaps are
// likely mis-hearings ("doctor sand" → "Dr. Saan") worth remembering.
function learnCorrections(machine, edited) {
  const A = machine.split(/\s+/).filter(Boolean);
  const B = edited.split(/\s+/).filter(Boolean);
  if (!A.length || !B.length || A.length > 1500 || B.length > 1500) return [];
  const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const a = A.map(norm); const b = B.map(norm);
  const L = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out = [];
  let i = 0; let j = 0; let del = []; let ins = [];
  const flush = () => {
    const clean = (ws) => ws.join(' ').replace(/^[^\p{L}\p{N}]+|[.,!?;:]+$/gu, '');
    const heard = clean(del); const text = clean(ins);
    if (del.length && ins.length && del.length <= 4 && ins.length <= 4 && heard && text
      && norm(heard.replace(/\s/g, '')) !== norm(text.replace(/\s/g, ''))) out.push({ heard, text });
    del = []; ins = [];
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < b.length && (i === a.length || L[i][j + 1] >= L[i + 1][j])) ins.push(B[j++]);
    else del.push(A[i++]);
  }
  flush();
  const seen = new Set();
  return out.filter((x) => { const k = x.heard.toLowerCase() + '|' + x.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5);
}

async function saveDictionary(dict) {
  try {
    const r = await api('/settings', { method: 'PUT', body: { dictionary: dict } });
    state.dictionary = r.dictionary || [];
    return true;
  } catch (e) {
    toast(e.message);
    return false;
  }
}

const dictUi = { kind: 'word', editing: -1, test: 'Can you call doctor sand about Emma’s ear and do the usual on Saturday' };

function viewDictionary() {
  const D = state.dictionary;
  const words = D.map((e, i) => [e, i]).filter(([e]) => e.kind === 'word');
  const phrases = D.map((e, i) => [e, i]).filter(([e]) => e.kind === 'phrase');
  const ed = dictUi.editing >= 0 ? D[dictUi.editing] : null;
  if (ed) dictUi.kind = ed.kind;
  const k = dictUi.kind;
  const row = ([e, i]) => `<div class="dict-row">
      <div class="grow" style="min-width:0">
        ${e.kind === 'word'
          ? `<b>${esc(e.text)}</b>${e.heard.length ? `<div class="small muted">heard as: ${e.heard.map((h) => `“${esc(h)}”`).join(', ')}</div>` : ''}`
          : `<b>“${esc(e.text)}”</b><div class="small">→ ${esc(e.means)}</div>`}
        ${e.kind === 'word' && e.means ? `<div class="small muted">${esc(e.means)}</div>` : ''}
      </div>
      <div class="row" style="flex-wrap:nowrap">
        <button class="btn sm" data-edit="${i}">Edit</button>
        <button class="btn sm danger" data-del="${i}" aria-label="Delete ${esc(e.text)}">✕</button>
      </div>
    </div>`;
  app.innerHTML = `
    <div class="row spread"><h2>📖 Household dictionary</h2>
      <button class="link" id="dict-back">← ${voice.returnToTalk ? 'Back to Talk' : 'Settings'}</button></div>
    <p class="muted small">Teach the voice transcriber your family's words. Names get spelled right, known mis-hearings are fixed automatically, and Claude expands your shorthand into real jobs.</p>

    <form id="df" class="card">
      <b>${ed ? 'Edit entry' : 'Add an entry'}</b>
      <div class="chips" style="margin-top:8px" id="dkind">
        <button type="button" class="chip ${k === 'word' ? 'on' : ''}" data-k="word">Name / word</button>
        <button type="button" class="chip ${k === 'phrase' ? 'on' : ''}" data-k="phrase">Shorthand / expression</button>
      </div>
      ${k === 'word' ? `
        <label for="d-text">Correct spelling</label>
        <input type="text" id="d-text" maxlength="80" placeholder="Dr. Saan" value="${esc(ed?.text || '')}" required>
        <label for="d-heard">Often misheard as <span class="muted">(comma-separated, optional)</span></label>
        <input type="text" id="d-heard" maxlength="400" placeholder="doctor sand, doctor son, dr sahn" value="${esc(ed?.heard.join(', ') || '')}">
        <label for="d-means">Note <span class="muted">(optional, added to the Do)</span></label>
        <input type="text" id="d-means" maxlength="300" placeholder="Emma's pediatrician · (555) 010-4477" value="${esc(ed?.means || '')}">
      ` : `
        <label for="d-text">When we say</label>
        <input type="text" id="d-text" maxlength="80" placeholder="the usual" value="${esc(ed?.text || '')}" required>
        <label for="d-means">It means</label>
        <textarea id="d-means" rows="2" maxlength="300" placeholder="mow the front and back lawn, and take the bins to the curb Tuesday night" required>${esc(ed?.means || '')}</textarea>
      `}
      <div class="row" style="margin-top:10px">
        <button class="btn primary">${ed ? 'Save changes' : 'Add'}</button>
        ${ed ? '<button type="button" class="btn" id="d-cancel">Cancel</button>' : ''}
      </div>
    </form>

    <h3>Names &amp; words (${words.length})</h3>
    ${words.length ? `<div class="card">${words.map(row).join('')}</div>` : '<p class="empty small">Add doctors, teachers, kids, pets, streets, brands: anything it spells wrong.</p>'}
    <h3>Shorthand &amp; expressions (${phrases.length})</h3>
    ${phrases.length ? `<div class="card">${phrases.map(row).join('')}</div>` : '<p class="empty small">e.g. “the usual”, “Costco run”, “Grandma’s”, “the thing in the garage”.</p>'}

    <div class="card">
      <b>Try it</b>
      <label for="d-test">Type something the way it might be transcribed</label>
      <input type="text" id="d-test" value="${esc(dictUi.test)}">
      <div class="small" id="d-out" style="margin-top:8px"></div>
      <p class="muted small">Name fixes happen on the phone right away. Shorthand is expanded by Claude when you tap ✨ Turn into Do’s.</p>
    </div>`;

  const showTest = () => {
    const v = $('#d-test').value;
    dictUi.test = v;
    const r = applyDictionary(v);
    const used = state.dictionary.filter((e) => e.kind === 'phrase' && new RegExp(`(^|[^\\p{L}])${reEsc(e.text)}($|[^\\p{L}])`, 'iu').test(r.text));
    $('#d-out').innerHTML = `→ ${esc(r.text)}${used.length ? `<div class="muted" style="margin-top:4px">Claude will read ${used.map((e) => `“${esc(e.text)}” as <i>${esc(e.means)}</i>`).join('; ')}</div>` : ''}`;
  };
  $('#d-test').oninput = showTest;
  showTest();
  $('#dict-back').onclick = () => { state.tab = voice.returnToTalk ? 'talk' : 'settings'; voice.returnToTalk = false; dictUi.editing = -1; render(); };
  $('#dkind').querySelectorAll('[data-k]').forEach((b) => {
    b.onclick = () => { if (dictUi.editing < 0) { dictUi.kind = b.dataset.k; viewDictionary(); } };
  });
  const cancel = $('#d-cancel');
  if (cancel) cancel.onclick = () => { dictUi.editing = -1; viewDictionary(); };
  $('#df').onsubmit = async (e) => {
    e.preventDefault();
    const entry = {
      kind: dictUi.kind,
      text: $('#d-text').value,
      heard: $('#d-heard')?.value.split(',') || [],
      means: $('#d-means').value,
    };
    const dict = [...state.dictionary];
    if (dictUi.editing >= 0) dict[dictUi.editing] = entry; else dict.push(entry);
    if (await saveDictionary(dict)) {
      toast(dictUi.editing >= 0 ? 'Saved' : `📖 Added “${entry.text.trim()}”`);
      dictUi.editing = -1;
      viewDictionary();
    }
  };
  app.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => { dictUi.editing = +b.dataset.edit; viewDictionary(); window.scrollTo(0, 0); };
  });
  app.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const i = +b.dataset.del;
      if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Delete?'; return; } // in-page confirm
      const dict = state.dictionary.filter((_, j) => j !== i);
      if (await saveDictionary(dict)) { dictUi.editing = -1; toast('Removed'); viewDictionary(); }
    };
  });
}

// ---------- ticket detail modal ----------

async function openTicket(id) {
  modalBody.innerHTML = '<p class="muted">Loading…</p>';
  if (!modal.open) modal.showModal();
  let data;
  try { data = await api(`/tickets/${id}`); } catch (e) { modalBody.innerHTML = `<p>${esc(e.message)}</p>`; return; }
  const t = data.ticket;
  const fx = isFixer();
  const canEdit = fx || t.requester === state.me;
  if (state.notifs.some((n) => n.ticket_id === t.id && !n.read_at)) {
    api('/notifications/read', { method: 'POST', body: { ticket_id: t.id } }).then((r) => {
      state.notifs = r.notifications; state.unread = r.unread; updateBell();
    }).catch(() => {});
  }
  const earned = data.points.filter((p) => p.points > 0);
  modalBody.innerHTML = `
    <div class="row spread"><span class="muted small">#${t.id} · opened by ${esc(t.requester)} ${ago(t.created_at)}</span>
      <button class="btn sm" id="mclose">✕</button></div>
    <div class="row" style="margin-top:8px">
      <span class="status ${t.status}">${STATUS_LABEL[t.status]}</span>
      ${t.scheduled_for ? `<b class="sched">📅 ${esc(prettySched(t))}</b>` : ''}
      ${earned.length ? `<b class="gold">⭐ ${earned.reduce((n, p) => n + p.points, 0)} pts earned</b>` : (t.estimate_min ? `<span class="muted small">☆ worth ${pointsFor(t)} pts</span>` : '')}
    </div>
    ${fx && OPEN.includes(t.status) ? '<button class="btn primary block" id="mupd" style="margin-top:10px">📝 Post update / schedule</button>' : ''}
    <form id="ef">
      <input type="text" name="title" class="big-input" value="${esc(t.title)}" ${canEdit ? '' : 'disabled'} style="margin-top:8px">
      <label>Details</label>
      <textarea name="description" ${canEdit ? '' : 'disabled'}>${esc(t.description)}</textarea>
      <div class="grid2">
        <div><label>Status</label><select name="status" ${fx ? '' : 'disabled'}>
          ${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${t.status === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div><label>Priority</label><select name="priority" ${canEdit ? '' : 'disabled'}>
          ${Object.entries(PRIORITIES).map(([p, v]) => `<option value="${p}" ${t.priority === +p ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select></div>
        <div><label>Estimate</label><select name="estimate_min" ${fx ? '' : 'disabled'}>
          <option value="0">Not sized</option>
          ${SIZES.map((s) => `<option value="${s.min}" ${t.estimate_min === s.min ? 'selected' : ''}>${s.label}</option>`).join('')}
          ${t.estimate_min && !SIZES.some((s) => s.min === t.estimate_min) ? `<option value="${t.estimate_min}" selected>${fmtMin(t.estimate_min)}</option>` : ''}
        </select></div>
        <div><label>Category</label><select name="category" ${canEdit ? '' : 'disabled'}>
          ${CATEGORIES.map((c) => `<option ${t.category === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select></div>
        <div><label>Location</label><input type="text" name="location" value="${esc(t.location)}" ${canEdit ? '' : 'disabled'}></div>
        <div><label>Needed by</label><input type="date" name="due_date" value="${esc(t.due_date || '')}" ${canEdit ? '' : 'disabled'}></div>
        <div><label>Scheduled day</label><input type="date" name="scheduled_for" value="${esc(t.scheduled_for || '')}" ${fx ? '' : 'disabled'}></div>
        <div><label>Scheduled time</label><input type="time" name="scheduled_time" value="${esc(t.scheduled_time || '')}" ${fx ? '' : 'disabled'}></div>
        <div><label>Planned week (Monday)</label><input type="date" name="sprint_week" value="${esc(t.sprint_week || '')}" ${fx ? '' : 'disabled'}></div>
        <div><label>Repeat every (days, 0 = no)</label><input type="number" name="recur_days" min="0" value="${t.recur_days}" ${canEdit ? '' : 'disabled'}></div>
      </div>
      ${t.status === 'blocked' ? `<label>Blocked on</label><input type="text" name="blocked_reason" value="${esc(t.blocked_reason)}" ${fx ? '' : 'disabled'}>` : ''}
      <div class="row" style="margin-top:12px">
        ${canEdit ? '<button class="btn primary">Save changes</button>' : ''}
        ${fx ? '<button type="button" class="btn danger" id="del">Delete</button>' : ''}
      </div>
    </form>
    <h3>Activity</h3>
    <div id="comments">
      ${data.comments.map((c) => `<div class="comment ${c.is_system ? 'sys' : ''}">
        <span class="by">${esc(c.author)}</span> <span class="muted small">${ago(c.created_at)}</span><br>${c.is_system ? '⚙︎ ' : ''}<span style="white-space:pre-wrap">${esc(c.body)}</span></div>`).join('')}
    </div>
    <form id="cf" class="row" style="margin-top:8px">
      <input type="text" name="body" class="grow" placeholder="${fx ? `Post an update for ${esc(t.requester)}…` : 'Add a comment…'}" style="flex:1;width:auto">
      <button class="btn">Send</button>
    </form>`;

  $('#mclose').onclick = () => modal.close();
  const mu = $('#mupd');
  if (mu) mu.onclick = () => openUpdate(state.tickets.find((x) => x.id === t.id) || t);
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {};
    for (const el of f.elements) {
      if (!el.name || el.disabled) continue;
      body[el.name] = ['priority', 'estimate_min', 'recur_days'].includes(el.name) ? +el.value
        : ['due_date', 'sprint_week', 'scheduled_for', 'scheduled_time'].includes(el.name) ? (el.value || null) : el.value;
    }
    // Snap the planned week to its Monday.
    if (body.sprint_week) body.sprint_week = mondayOf(new Date(body.sprint_week + 'T00:00:00'));
    const r = await patch(t.id, body, 'Saved');
    if (r) openTicket(t.id);
  };
  const del = $('#del');
  if (del) {
    del.onclick = async () => {
      if (!confirm('Delete this Do permanently?')) return;
      await api(`/tickets/${t.id}`, { method: 'DELETE' });
      state.tickets = state.tickets.filter((x) => x.id !== t.id);
      modal.close();
      toast('Deleted');
      render();
    };
  }
  $('#cf').onsubmit = async (e) => {
    e.preventDefault();
    const text = e.target.body.value.trim();
    if (!text) return;
    await api(`/tickets/${t.id}/comments`, { method: 'POST', body: { body: text } });
    const tk = state.tickets.find((x) => x.id === t.id);
    if (tk) tk.comment_count = (tk.comment_count || 0) + 1;
    openTicket(t.id);
  };
}

modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });
modal.addEventListener('close', () => render());

// Keep both phones in sync without websockets: refresh when the app regains focus and every minute.
async function softRefresh() {
  if (!state.me) return;
  // Always check notifications (cheap); only re-render the page when it won't disrupt typing.
  if (modal.open || state.tab === 'talk' || document.activeElement?.matches('input, textarea, select')) {
    try { await refreshNotifs(); } catch { /* ignore */ }
    return;
  }
  try { await refresh(); render(); } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) softRefresh(); });
setInterval(softRefresh, 30000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Android/Chrome "Install app" prompt — offered from Settings.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });

boot();
