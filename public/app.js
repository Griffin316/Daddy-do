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
  new: 'New', backlog: 'Backlog', scheduled: 'This week', in_progress: 'In progress',
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
};

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
  const [t, s] = await Promise.all([api('/tickets'), api('/stats')]);
  state.tickets = t.tickets;
  state.stats = s.stats;
}

async function patch(id, body, msg) {
  try {
    const r = await api(`/tickets/${id}`, { method: 'PATCH', body });
    const i = state.tickets.findIndex((x) => x.id === id);
    if (i >= 0) state.tickets[i] = { ...state.tickets[i], ...r.ticket };
    if (r.spawned) state.tickets.unshift(r.spawned);
    if (msg) toast(msg);
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
    if (!state.members.some((m) => m.name === state.me)) return renderWhoAmI();
    await refresh();
    render();
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
      ['settings', '⚙︎'],
    ];
  }
  return [
    ['talk', '🎙 Talk'],
    ['new', '+ Type it'],
    ['mine', 'My requests', toVerify, toVerify > 0],
    ['week', "This week's plan", week],
    ['all', 'Everything'],
    ['settings', '⚙︎'],
  ];
}

function render() {
  const tabs = tabsFor();
  if (!tabs.some(([k]) => k === state.tab)) state.tab = tabs[0][0];
  localStorage.setItem('dd_tab', state.tab);

  $('#who').innerHTML = `${esc(state.me)} <button class="link small" id="switch">switch</button>`;
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
    backlog: viewBacklog, done: viewDone, all: viewAll, settings: viewSettings,
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
    t.estimate_min ? `⏱ ${fmtMin(t.estimate_min)}` : '<span>⏱ not sized</span>',
    dueText(t),
    t.recur_days ? `🔁 every ${t.recur_days}d` : '',
    t.comment_count ? `💬 ${t.comment_count}` : '',
    `#${t.id} · ${esc(t.requester)} · ${ago(t.created_at)}`,
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');
  const blocked = t.status === 'blocked' && t.blocked_reason
    ? `<div class="small" style="margin-top:6px">🚧 ${esc(t.blocked_reason)}</div>` : '';
  const btns = actions.map(([key, label, cls = '']) =>
    `<button class="btn sm ${cls}" data-act="${key}" data-id="${t.id}">${label}</button>`).join('');
  return `<div class="card ticket p${t.priority}" data-open="${t.id}">
    <div class="title">${esc(t.title)}</div>
    <div class="meta">${meta}</div>${blocked}
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
  schedule: (t) => patch(t.id, { status: 'scheduled', sprint_week: THIS_WEEK() }, 'Added to this week'),
  next: (t) => patch(t.id, { status: 'scheduled', sprint_week: NEXT_WEEK() }, 'Planned for next week'),
  unplan: (t) => patch(t.id, { status: 'backlog', sprint_week: null }, 'Moved back to backlog'),
  start: (t) => patch(t.id, { status: 'in_progress', sprint_week: t.sprint_week || THIS_WEEK() }, 'Started'),
  done: (t) => patch(t.id, { status: 'resolved' }, `Resolved — ${t.requester} will be asked to check it`),
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
    <h2>${isFixer() ? 'New ticket' : 'What needs doing?'}</h2>
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
      <div style="margin-top:14px"><button class="btn primary block">Submit ticket</button></div>
    </form>
    <p class="muted small center">Tip: one ticket per thing. Small, specific tickets get done faster.</p>`;

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
      toast(`Ticket #${r.ticket.id} filed`);
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
    <div class="stat"><b>${s.open || 0}</b><span>open tickets</span></div>
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
    ${isFixer() ? '<div class="row" style="margin-top:8px"><button class="btn sm" id="autofill">⚡ Auto-fill from backlog</button><span class="muted small">Unsized tickets count as 30m.</span></div>' : ''}
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
  const todoActs = fx ? [['start', '▶ Start'], ['done', '✓ Done', 'ok'], ['block', 'Blocked'], ['next', '→ Next week']] : [];
  const progActs = fx ? [['done', '✓ Done', 'ok'], ['block', 'Blocked']] : [];
  const blockActs = fx ? [['unblock', 'Unblock']] : [];
  const p1Unplanned = state.tickets.filter((t) => t.priority === 1 && OPEN.includes(t.status) && t.sprint_week !== wk);

  app.innerHTML = `
    <h2>Week of ${wk}</h2>
    ${capacityBlock(weekTickets)}
    ${p1Unplanned.length ? `<div class="card" style="border-color:var(--p1)"><b class="overdue">⚠ ${p1Unplanned.length} P1 ticket(s) not in this week's plan</b>
      ${p1Unplanned.map((t) => ticketCard(t, fx ? [['schedule', '+ Add to this week', 'primary']] : [])).join('')}</div>` : ''}
    ${inProg.length ? `<h3>In progress</h3>${inProg.map((t) => ticketCard(t, progActs)).join('')}` : ''}
    <h3>Planned</h3>
    ${todo.length ? todo.map((t) => ticketCard(t, todoActs)).join('') : `<p class="empty">Nothing planned yet.${fx ? ' Pull from Backlog or hit Auto-fill.' : ''}</p>`}
    ${blocked.length ? `<h3>Blocked</h3>${blocked.map((t) => ticketCard(t, blockActs)).join('')}` : ''}
    ${done.length ? `<h3>Done this week</h3>${done.map((t) => ticketCard(t)).join('')}` : ''}`;
  wireCards(app, fixerHandlers);
  const af = $('#autofill');
  if (af) af.onclick = autoFill;
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
  if (!confirm(`Add ${picked.length} ticket(s) to this week?\n\n${picked.map((t) => `• ${t.title} (${fmtMin(t.estimate_min || 30)})`).join('\n')}`)) return;
  for (const t of picked) {
    await api(`/tickets/${t.id}`, { method: 'PATCH', body: { status: 'scheduled', sprint_week: wk } });
  }
  await refresh();
  toast(`Planned ${picked.length} ticket(s)`);
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
          <button class="btn sm primary" data-act="schedule">This week</button>
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
    <h2>Backlog <span class="muted small">${list.length} tickets · ~${fmtMin(total)}</span></h2>
    <div class="chips" style="margin-bottom:12px" id="bf">
      ${[['all', 'All'], ['quick', '⚡ Quick wins ≤30m'], ['next', 'Next week'], ['unsized', 'Unsized'], ...CATEGORIES.map((c) => [c, CAT_ICON[c] + ' ' + c])]
        .map(([k, l]) => `<button class="chip ${f === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
    </div>
    ${list.length ? list.map((t) => ticketCard(t,
      t.status === 'blocked' ? [['unblock', 'Unblock']]
        : t.sprint_week === NEXT_WEEK() ? [['schedule', '+ This week', 'primary'], ['unplan', 'Unplan']]
          : [['schedule', '+ This week', 'primary'], ['next', 'Next week'], ['done', '✓ Already done', 'ok']])).join('')
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
  requester: '',
};

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

function viewVoice() {
  if (!voice.requester) voice.requester = isFixer() ? (state.members.find((m) => m.role === 'requester')?.name || state.me) : state.me;
  if (voice.result) return viewVoiceReview();
  const secs = voice.recording ? Math.floor((Date.now() - voice.startedAt) / 1000) : 0;
  app.innerHTML = `
    <h2>${isFixer() ? 'Capture what was asked' : 'Just say it'}</h2>
    <p class="muted small">Talk naturally — list as many things as you want. AI splits it into separate tickets with steps, sizes and a shopping list. You review before anything is filed.</p>
    <div class="card center">
      <button id="mic" class="mic ${voice.recording ? 'on' : ''}" aria-label="${voice.recording ? 'Stop recording' : 'Start recording'}">
        ${voice.recording ? '■' : '🎙'}
      </button>
      <div class="small muted" id="mic-status" style="margin-top:8px">
        ${voice.recording ? `Listening… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — tap to stop` : voice.busy || 'Tap to talk'}
      </div>
    </div>
    <label>Transcript <span class="muted">(edit anything it mis-heard — or type / use your keyboard's mic)</span></label>
    <textarea id="tx" rows="7" placeholder="e.g. &quot;The kitchen faucet is dripping again, and can you put the Christmas lights up before the party on the 14th, oh and the smoke detector in the hallway keeps chirping…&quot;">${esc(voice.transcript + (voice.interim ? ' ' + voice.interim : ''))}</textarea>
    ${isFixer() ? `<label>Who asked?</label><select id="reqr">${state.members.map((m) => `<option ${m.name === voice.requester ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>` : ''}
    <div class="row" style="margin-top:12px">
      <button class="btn primary grow" id="parse" ${voice.busy ? 'disabled' : ''}>✨ Turn into tickets</button>
      <button class="btn" id="clear">Clear</button>
    </div>`;

  $('#mic').onclick = () => (voice.recording ? stopRecording() : startRecording());
  $('#tx').oninput = (e) => { voice.transcript = e.target.value; voice.interim = ''; };
  const rq = $('#reqr');
  if (rq) rq.onchange = (e) => { voice.requester = e.target.value; };
  $('#clear').onclick = () => { voice.transcript = ''; voice.interim = ''; viewVoice(); };
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
  voice.engine = SpeechRec && !voice.forceServer ? 'speech' : 'server';
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
      if (r.isFinal) voice.transcript = (voice.transcript + ' ' + r[0].transcript.trim()).trim();
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
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
  const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  voice.chunks = [];
  mr.ondataavailable = (e) => { if (e.data.size) voice.chunks.push(e.data); };
  mr.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(voice.chunks, { type: mr.mimeType || 'audio/webm' });
    if (!blob.size) return;
    voice.busy = 'Transcribing…';
    viewVoice();
    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST', body: blob, credentials: 'same-origin',
        headers: { 'content-type': blob.type, 'x-user': encodeURIComponent(state.me) },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      voice.transcript = (voice.transcript + ' ' + data.text).trim();
    } catch (e) {
      toast(e.message);
    }
    voice.busy = '';
    viewVoice();
  };
  mr.start(1000);
  voice.mediaRec = mr;
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
  const text = ($('#tx')?.value || voice.transcript).trim();
  voice.transcript = text;
  if (!text) return toast('Say or type something first');
  voice.busy = '✨ Working out the to-dos…';
  viewVoice();
  try {
    const r = await api('/parse', { method: 'POST', body: { text, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } });
    r.items.forEach((it) => { it.keep = !it.duplicate_of; });
    voice.result = r;
    if (!r.items.length) toast("Didn't find any to-dos in that");
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
    <div class="row spread"><h2>${items.length} to-do${items.length === 1 ? '' : 's'} found</h2>
      <button class="link" id="back">← Edit transcript</button></div>
    <p class="muted small">Untick anything you don't want, tweak, then file. ${isFixer() ? `Filed as requested by <b>${esc(voice.requester)}</b>.` : ''}</p>
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
    ${notTasks.length ? `<details class="card"><summary class="muted small">Heard but not tickets (${notTasks.length})</summary><ul class="small">${notTasks.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}
    <button class="btn primary block" id="file" ${kept ? '' : 'disabled'}>File ${kept} ticket${kept === 1 ? '' : 's'} · ~${fmtMin(mins)}</button>
    <button class="btn block" id="discard" style="margin-top:8px">Discard</button>`;

  $('#back').onclick = () => { voice.result = null; viewVoice(); };
  $('#discard').onclick = () => { voice.result = null; voice.transcript = ''; viewVoice(); };
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
    toast(`Filed ${ok} ticket${ok === 1 ? '' : 's'} 🎉`);
    voice.result = null;
    voice.transcript = '';
    api('/stats').then((s) => { state.stats = s.stats; });
    state.tab = isFixer() ? 'triage' : 'mine';
    render();
  };
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
  modalBody.innerHTML = `
    <div class="row spread"><span class="muted small">#${t.id} · opened by ${esc(t.requester)} ${ago(t.created_at)}</span>
      <button class="btn sm" id="mclose">✕</button></div>
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
      <input type="text" name="body" class="grow" placeholder="Add a comment…" style="flex:1;width:auto">
      <button class="btn">Send</button>
    </form>`;

  $('#mclose').onclick = () => modal.close();
  $('#ef').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {};
    for (const el of f.elements) {
      if (!el.name || el.disabled) continue;
      body[el.name] = ['priority', 'estimate_min', 'recur_days'].includes(el.name) ? +el.value
        : ['due_date', 'sprint_week'].includes(el.name) ? (el.value || null) : el.value;
    }
    // Snap the planned week to its Monday.
    if (body.sprint_week) body.sprint_week = mondayOf(new Date(body.sprint_week + 'T00:00:00'));
    const r = await patch(t.id, body, 'Saved');
    if (r) openTicket(t.id);
  };
  const del = $('#del');
  if (del) {
    del.onclick = async () => {
      if (!confirm('Delete this ticket permanently?')) return;
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
  if (!state.me || modal.open || state.tab === 'talk' || document.activeElement?.matches('input, textarea')) return;
  try { await refresh(); render(); } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) softRefresh(); });
setInterval(softRefresh, 60000);

boot();
