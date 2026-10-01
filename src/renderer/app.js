/**
 * 渲染进程主逻辑：列表、筛选、编辑器、设置、主题、双语。
 * 所有密钥明文默认不出主进程；此处只处理掩码与显式「显示」的结果。
 */
'use strict';

const api = window.vault;
const $ = (sel) => document.querySelector(sel);

const state = {
  records: [],
  settings: null,
  lang: 'zh',
  filter: { provider: 'all', favorites: false, q: '' },
  sort: 'updated',
  density: 'comfortable',
  revealed: new Map(),   // id -> { value, expiresAt, timer }
  bgDataUrl: '',
  info: null,
  status: null
};

const PROVIDERS = window.PROVIDERS || [];

/* ------------------------------- 工具 ------------------------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function provider(id) {
  return PROVIDERS.find((p) => p.id === id) || { id, zh: id, en: id, baseUrl: '', docs: '' };
}
function providerName(id) {
  const p = provider(id);
  return state.lang === 'en' ? p.en : p.zh;
}
function providerHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const locale = state.lang === 'en' ? 'en-US' : 'zh-CN';
  return d.toLocaleString(locale, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

async function call(fn, ...args) {
  const res = await fn(...args);
  if (res && res.ok === false) throw new Error(res.error || 'ERROR');
  return res ? res.data : null;
}

/* ----------------------------- 主题应用 ----------------------------- */

function applyTheme(theme) {
  const r = document.documentElement.style;
  r.setProperty('--accent', theme.accent);
  r.setProperty('--accent-2', theme.accent2);
  r.setProperty('--bg', theme.bg);
  r.setProperty('--surface', theme.surface);
  r.setProperty('--text', theme.text);
  r.setProperty('--muted', theme.muted);
  r.setProperty('--radius', theme.radius + 'px');
  r.setProperty('--line', theme.mode === 'dark' ? 'rgba(255,255,255,.11)' : 'rgba(0,0,0,.08)');
  r.setProperty('--shadow', theme.mode === 'dark'
    ? '0 1px 2px rgba(0,0,0,.3), 0 8px 24px rgba(0,0,0,.35)'
    : '0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06)');
  document.body.style.colorScheme = theme.mode === 'dark' ? 'dark' : 'light';
}

function applyBackground(bg) {
  const layer = $('#bgLayer');
  const r = document.documentElement.style;
  r.setProperty('--bg-image-opacity', String(bg.opacity));
  r.setProperty('--bg-blur', bg.blur + 'px');
  r.setProperty('--bg-dim', String(bg.dim));
  if (state.bgDataUrl) {
    layer.style.backgroundImage = `url("${state.bgDataUrl}")`;
    layer.style.backgroundSize = bg.size === 'repeat' ? 'auto' : bg.size;
    layer.style.backgroundRepeat = bg.size === 'repeat' ? 'repeat' : 'no-repeat';
  } else {
    layer.style.backgroundImage = 'none';
  }
}

/* -------------------------------- 启动 -------------------------------- */

async function init() {
  try {
    state.settings = await call(api.settings);
    state.lang = state.settings.language === 'en' ? 'en' : 'zh';
    state.sort = state.settings.list.sort || 'updated';
    state.density = state.settings.list.density || 'comfortable';
    state.info = await call(api.info);
    state.status = await call(api.status);

    applyTheme(state.settings.theme);
    const bg = await call(api.loadBackground);
    state.bgDataUrl = (bg && bg.dataUrl) || '';
    applyBackground(state.settings.background);

    await refresh();
    buildStaticUI();
    render();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif">${esc(window.t('loadFailed'))}: ${esc(err.message)}</div>`;
  }
}

async function refresh() {
  state.records = await call(api.list);
}

/* ---------------------------- 静态 UI 构建 ---------------------------- */

function buildStaticUI() {
  window.__lang = state.lang;
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh';

  // 文案
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = window.t(el.dataset.i18n); });
  $('#search').placeholder = window.t('search');
  $('#langBtn').textContent = state.lang === 'en' ? '中' : 'EN';
  $('#langBtn').title = window.t('language');
  $('#settingsBtn').title = window.t('settings');

  // 排序下拉
  const sortSel = $('#sortSelect');
  sortSel.innerHTML = ['updated', 'created', 'label', 'provider', 'usage']
    .map((k) => `<option value="${k}">${esc(window.t('sort' + k[0].toUpperCase() + k.slice(1)))}</option>`).join('');
  sortSel.value = state.sort;

  // 服务商下拉
  const provSel = $('#providerSelect');
  const counts = state.records.reduce((m, r) => (m[r.provider] = (m[r.provider] || 0) + 1, m), {});
  provSel.innerHTML = `<option value="all">${esc(window.t('allProviders'))}</option>` +
    PROVIDERS.map((p) => `<option value="${p.id}">${esc(state.lang === 'en' ? p.en : p.zh)} (${counts[p.id] || 0})</option>`).join('');
  provSel.value = state.filter.provider;

  // 密度切换
  $('#densitySeg').innerHTML = ['comfortable', 'compact']
    .map((d) => `<button data-density="${d}">${esc(window.t('density' + d[0].toUpperCase() + d.slice(1)))}</button>`).join('');
  $('#densitySeg').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.density === state.density);
    b.onclick = async () => {
      state.density = b.dataset.density;
      await call(api.saveSettings, { list: { density: state.density } });
      buildStaticUI(); render();
    };
  });
}

/* ------------------------------ 侧栏导航 ------------------------------ */

function renderSidebar() {
  const counts = state.records.reduce((m, r) => (m[r.provider] = (m[r.provider] || 0) + 1, m), {});
  const favCount = state.records.filter((r) => r.favorite).length;
  const nav = $('#sideNav');

  const items = [
    { id: 'all', label: window.t('all'), count: state.records.length, dot: 'var(--accent)' },
    { id: 'favorites', label: window.t('favorites'), count: favCount, dot: '#E9B949' }
  ].filter((it) => it.id !== 'favorites' || favCount > 0);

  let html = items.map((it) => {
    const on = it.id === 'favorites' ? state.filter.favorites : (!state.filter.favorites && state.filter.provider === 'all');
    return `<button class="side-item ${on ? 'on' : ''}" data-nav="${it.id}">
      <span class="dot" style="--dot:${it.dot}"></span>
      <span class="nm">${esc(it.label)}</span><span class="ct">${it.count}</span></button>`;
  }).join('');

  const used = PROVIDERS.filter((p) => counts[p.id]);
  const custom = Object.keys(counts).filter((id) => !PROVIDERS.some((p) => p.id === id));
  const allUsed = used.concat(custom.map((id) => ({ id, zh: id, en: id })));

  if (allUsed.length) {
    html += `<div class="side-title">${esc(window.t('provider'))}</div>`;
    html += allUsed.map((p) => {
      const on = !state.filter.favorites && state.filter.provider === p.id;
      return `<button class="side-item ${on ? 'on' : ''}" data-nav="p:${esc(p.id)}">
        <span class="dot" style="--dot:hsl(${providerHue(p.id)} 62% 58%)"></span>
        <span class="nm">${esc(state.lang === 'en' ? p.en : p.zh)}</span><span class="ct">${counts[p.id]}</span></button>`;
    }).join('');
  }

  nav.innerHTML = html;
  nav.querySelectorAll('[data-nav]').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.nav;
      if (v === 'all') { state.filter.provider = 'all'; state.filter.favorites = false; }
      else if (v === 'favorites') { state.filter.favorites = true; }
      else if (v.startsWith('p:')) { state.filter.provider = v.slice(2); state.filter.favorites = false; }
      $('#providerSelect').value = state.filter.provider;
      render();
    };
  });

  const provCount = Object.keys(counts).length;
  $('#vaultStat').innerHTML = `${esc(window.t('totalKeys', { n: state.records.length }))}<br>${esc(window.t('providersCount', { n: provCount }))}`;
}

/* ------------------------------- 过滤排序 ------------------------------- */

function visibleRecords() {
  const q = state.filter.q.trim().toLowerCase();
  let list = state.records.filter((r) => {
    if (state.filter.favorites && !r.favorite) return false;
    if (!state.filter.favorites && state.filter.provider !== 'all' && r.provider !== state.filter.provider) return false;
    if (!q) return true;
    const hay = [r.label, r.note, (r.tags || []).join(' '), r.provider, providerName(r.provider), r.models, r.baseUrl, r.mask]
      .join(' ').toLowerCase();
    return hay.includes(q);
  });
  const cmp = {
    updated: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
    created: (a, b) => String(b.createdAt).localeCompare(String(a.createdAt)),
    label: (a, b) => String(a.label).localeCompare(String(b.label), state.lang === 'en' ? 'en' : 'zh'),
    provider: (a, b) => providerName(a.provider).localeCompare(providerName(b.provider)),
    usage: (a, b) => (b.usageCount || 0) - (a.usageCount || 0)
  }[state.sort] || ((a, b) => 0);
  return list.sort(cmp);
}

/* ------------------------------- 卡片渲染 ------------------------------- */

function render() {
  renderSidebar();

  const list = visibleRecords();
  const grid = $('#grid');
  grid.className = 'grid' + (state.density === 'compact' ? ' compact' : '');
  grid.innerHTML = '';

  $('#listCount').textContent = window.t('totalKeys', { n: list.length });

  if (!state.records.length) {
    grid.innerHTML = emptyState(window.t('empty'), window.t('emptyHint'), false);
    return;
  }
  if (!list.length) {
    grid.innerHTML = emptyState(window.t('noMatch'), window.t('noMatchHint'), true);
    const b = grid.querySelector('[data-clear]');
    if (b) b.onclick = () => {
      state.filter = { provider: 'all', favorites: false, q: '' };
      $('#search').value = ''; $('#providerSelect').value = 'all';
      render();
    };
    return;
  }

  list.forEach((rec) => grid.appendChild(card(rec)));
}

function emptyState(title, hint, withClear) {
  return `<div class="empty-state">
    <div class="ico">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <rect x="3" y="5" width="18" height="14" rx="3"></rect><path d="M8 10h8M8 14h5"></path>
      </svg>
    </div>
    <div class="big">${esc(title)}</div>
    <div>${esc(hint)}</div>
    ${withClear ? `<div style="margin-top:14px"><button class="btn" data-clear>${esc(window.t('clearFilters'))}</button></div>` : ''}
  </div>`;
}

function card(rec) {
  const el = document.createElement('div');
  el.className = 'card' + (rec.disabled ? ' disabled' : '');
  const rev = state.revealed.get(rec.id);
  const shown = rev ? rev.value : rec.mask;
  const hue = providerHue(rec.provider);
  const p = provider(rec.provider);

  el.innerHTML = `
    <div class="card-top">
      <div class="card-head">
        <div class="card-title">
          ${rec.favorite ? '<span class="fav" title="favorite">★</span>' : ''}
          <span class="nm">${esc(rec.label)}</span>
          <span class="badge" style="--accent:hsl(${hue} 62% 52%)"><span class="dot"></span>${esc(providerName(rec.provider))}</span>
          ${(rec.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>
        <div class="keyline">
          <span class="val" data-shown="${esc(shown)}">${esc(shown)}</span>
          <span class="reveal-timer" data-timer="${rec.id}"></span>
        </div>
      </div>
      <div class="actions">
        <button class="btn sm" data-act="reveal">${esc(rev ? window.t('hide') : window.t('reveal'))}</button>
        <button class="btn sm" data-act="copy">${esc(window.t('copy'))}</button>
        <button class="btn sm" data-act="edit">${esc(window.t('edit'))}</button>
        <button class="btn sm" data-act="fav" title="favorite">${rec.favorite ? '★' : '☆'}</button>
        <button class="btn sm danger" data-act="del">${esc(window.t('delete'))}</button>
      </div>
    </div>
    <div class="note-box" data-act="note" style="cursor:text" title="${esc(window.t('edit'))}">${rec.note ? esc(rec.note) : `<span class="empty-note">${esc(window.t('noNote'))}</span>`}</div>
    <div class="meta">
      <span>${esc(window.t('updated'))}: ${esc(fmtDate(rec.updatedAt))}</span>
      <span>${esc(window.t('usage'))}: ${rec.usageCount ? rec.usageCount + ' ' + window.t('times') : esc(window.t('neverUsed'))}</span>
      ${rec.baseUrl ? `<span>${esc(rec.baseUrl)}</span>` : ''}
      ${rec.models ? `<span>${esc(rec.models)}</span>` : ''}
    </div>`;

  el.querySelector('[data-act="reveal"]').onclick = () => toggleReveal(rec.id);
  el.querySelector('[data-act="copy"]').onclick = () => doCopy(rec.id);
  el.querySelector('[data-act="edit"]').onclick = () => openEditor(rec);
  el.querySelector('[data-act="note"]').onclick = () => openEditor(rec, 'note');
  el.querySelector('[data-act="fav"]').onclick = async () => {
    await call(api.update, rec.id, { favorite: !rec.favorite });
    await refresh(); render();
  };
  el.querySelector('[data-act="del"]').onclick = () => confirmDelete(rec);

  if (rev) startTimer(rec.id, el.querySelector(`[data-timer="${rec.id}"]`));
  return el;
}

/* ------------------------------ 显示与复制 ------------------------------ */

async function toggleReveal(id) {
  if (state.revealed.has(id)) { hideReveal(id); return; }
  const res = await call(api.reveal, id);
  const secs = Number(state.settings.privacy.autoHideSeconds || 0);
  state.revealed.set(id, { value: res.value, expiresAt: secs > 0 ? Date.now() + secs * 1000 : 0, timer: null });
  await refresh(); render();
}

function hideReveal(id) {
  const r = state.revealed.get(id);
  if (r && r.timer) clearInterval(r.timer);
  state.revealed.delete(id);
  render();
}

function startTimer(id, el) {
  const r = state.revealed.get(id);
  if (!r || !el) return;
  if (!r.expiresAt) { el.textContent = ''; return; }
  const tick = () => {
    const left = Math.max(0, Math.ceil((r.expiresAt - Date.now()) / 1000));
    if (el.isConnected) el.textContent = left + 's';
    if (left <= 0) { clearInterval(r.timer); hideReveal(id); }
  };
  r.timer = setInterval(tick, 250);
  tick();
}

async function doCopy(id) {
  const res = await call(api.copy, id);
  toast(`${window.t('copied')} · ${window.t('willClear', { n: res.autoClearSeconds })}`);
}

/* ------------------------------- 编辑器 ------------------------------- */

function openEditor(rec, focusField) {
  const isNew = !rec;
  const r = rec || { provider: 'openai', label: '', note: '', tags: [], baseUrl: '', models: '', favorite: false };

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-hd"><h3>${esc(isNew ? window.t('newKey') : window.t('editKey'))}</h3><div class="spacer" style="flex:1"></div>
        <button class="btn sm ghost" data-x>✕</button></div>
      <div class="modal-bd">
        <div class="row2">
          <label class="fld"><span class="lbl">${esc(window.t('labelField'))}</span>
            <input type="text" id="f-label" value="${esc(r.label)}" placeholder="${esc(window.t('labelPlaceholder'))}" /></label>
          <label class="fld"><span class="lbl">${esc(window.t('providerField'))}</span>
            <select id="f-provider">
              ${PROVIDERS.map((p) => `<option value="${p.id}" ${p.id === r.provider ? 'selected' : ''}>${esc(state.lang === 'en' ? p.en : p.zh)}</option>`).join('')}
              ${PROVIDERS.some((p) => p.id === r.provider) ? '' : `<option value="${esc(r.provider)}" selected>${esc(r.provider)}</option>`}
            </select></label>
        </div>
        <label class="fld"><span class="lbl">${esc(window.t('credentialField'))}</span>
          <input type="password" id="f-credential" value="" placeholder="${esc(window.t('credentialPlaceholder'))}" autocomplete="off" spellcheck="false" />
          <div class="hint">${esc(isNew ? '' : window.t('credentialKeep') + ' · ' + window.t('copyHintPrefix') + (r.mask || ''))}</div>
        </label>
        <label class="fld"><span class="lbl">${esc(window.t('noteField'))}</span>
          <textarea id="f-note" placeholder="${esc(window.t('notePlaceholder'))}">${esc(r.note || '')}</textarea></label>
        <label class="fld"><span class="lbl">${esc(window.t('tagsField'))}</span>
          <input type="text" id="f-tags" value="${esc((r.tags || []).join(', '))}" placeholder="${esc(window.t('tagsPlaceholder'))}" /></label>
        <div class="row2">
          <label class="fld"><span class="lbl">${esc(window.t('baseUrlField'))}</span>
            <input type="text" id="f-base" value="${esc(r.baseUrl || provider(r.provider).baseUrl || '')}" /></label>
          <label class="fld"><span class="lbl">${esc(window.t('modelsField'))}</span>
            <input type="text" id="f-models" value="${esc(r.models || '')}" placeholder="${esc(window.t('modelsPlaceholder'))}" /></label>
        </div>
        <label class="fld" style="display:flex;align-items:center;gap:8px;margin-bottom:0">
          <input type="checkbox" id="f-fav" style="width:auto" ${r.favorite ? 'checked' : ''} />
          <span style="font-size:13px">${esc(window.t('favoriteField'))}</span>
        </label>
      </div>
      <div class="modal-ft">
        <button class="btn" data-x>${esc(window.t('cancel'))}</button>
        <button class="btn primary" data-save>${esc(window.t('save'))}</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-x]').forEach((b) => b.onclick = close);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  const provSel = overlay.querySelector('#f-provider');
  const baseInput = overlay.querySelector('#f-base');
  provSel.onchange = () => {
    const p = provider(provSel.value);
    if (!baseInput.value || PROVIDERS.some((x) => x.baseUrl === baseInput.value)) baseInput.value = p.baseUrl || '';
  };

  const focusTarget = focusField === 'note' ? '#f-note' : (isNew ? '#f-label' : '#f-note');
  overlay.querySelector(focusTarget).focus();

  overlay.querySelector('[data-save]').onclick = async () => {
    const payload = {
      label: overlay.querySelector('#f-label').value.trim(),
      provider: provSel.value,
      credential: overlay.querySelector('#f-credential').value,
      note: overlay.querySelector('#f-note').value,
      tags: overlay.querySelector('#f-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      baseUrl: baseInput.value.trim(),
      models: overlay.querySelector('#f-models').value.trim(),
      favorite: overlay.querySelector('#f-fav').checked
    };
    if (!payload.label || (isNew && !payload.credential)) { toast(window.t('required')); return; }
    if (isNew) {
      const created = await call(api.create, payload);
      toast(window.t('added', { label: created.label }));
    } else {
      await call(api.update, rec.id, payload);
      toast(window.t('saved'));
    }
    close();
    await refresh(); render();
  };
}

function confirmDelete(rec) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:min(430px,100%)">
      <div class="modal-hd"><h3>${esc(window.t('delete'))}</h3></div>
      <div class="modal-bd">${esc(window.t('confirmDelete', { label: rec.label }))}</div>
      <div class="modal-ft">
        <button class="btn" data-x>${esc(window.t('cancel'))}</button>
        <button class="btn danger" data-ok>${esc(window.t('delete'))}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('[data-x]').onclick = close;
  overlay.querySelector('[data-ok]').onclick = async () => {
    await call(api.remove, rec.id);
    state.revealed.delete(rec.id);
    close();
    toast(window.t('deleted', { label: rec.label }));
    await refresh(); render();
  };
}

function promptDialog(title, label, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal" style="width:min(430px,100%)">
        <div class="modal-hd"><h3>${esc(title)}</h3></div>
        <div class="modal-bd">
          <label class="fld" style="margin-bottom:0"><span class="lbl">${esc(label)}</span>
            <input type="password" id="p-val" placeholder="${esc(placeholder || '')}" /></label>
        </div>
        <div class="modal-ft">
          <button class="btn" data-x>${esc(window.t('cancel'))}</button>
          <button class="btn primary" data-ok>${esc(window.t('confirm'))}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#p-val');
    input.focus();
    const done = (v) => { overlay.remove(); resolve(v); };
    overlay.querySelector('[data-x]').onclick = () => done(null);
    overlay.querySelector('[data-ok]').onclick = () => done(input.value);
    input.onkeydown = (e) => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); };
  });
}

/* -------------------------------- 设置 -------------------------------- */

const PRESETS = [
  { id: 'indigo', theme: { accent: '#5B8DEF', accent2: '#7C6CF0', bg: '#F6F7FB', surface: '#FFFFFF', text: '#1B1F2A', muted: '#6B7280', mode: 'light' } },
  { id: 'graphite', theme: { accent: '#8B93A7', accent2: '#5B6478', bg: '#14161C', surface: '#1C1F27', text: '#E8EAF0', muted: '#9AA1B2', mode: 'dark' } },
  { id: 'mint', theme: { accent: '#28B487', accent2: '#3FA7D6', bg: '#F4FAF7', surface: '#FFFFFF', text: '#16241E', muted: '#617A70', mode: 'light' } },
  { id: 'amber', theme: { accent: '#E08A34', accent2: '#D4574E', bg: '#FDF8F2', surface: '#FFFFFF', text: '#2A2119', muted: '#7C6A58', mode: 'light' } },
  { id: 'violet', theme: { accent: '#7C5CFF', accent2: '#B45CF0', bg: '#F7F5FE', surface: '#FFFFFF', text: '#1E1A2E', muted: '#6E6889', mode: 'light' } },
  { id: 'midnight', theme: { accent: '#4EA8F5', accent2: '#5E6CF7', bg: '#0E1420', surface: '#151C2B', text: '#E6ECF5', muted: '#8FA0B8', mode: 'dark' } }
];

function openSettings(tab = 'appearance') {
  const s = state.settings;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal" style="width:min(760px,100%)">
      <div class="modal-hd"><h3>${esc(window.t('settings'))}</h3><div style="flex:1"></div>
        <button class="btn sm ghost" data-x>✕</button></div>
      <div class="tabs">
        ${['appearance', 'security', 'data', 'about'].map((t) =>
          `<button data-tab="${t}" class="${t === tab ? 'on' : ''}">${esc(window.t(t))}</button>`).join('')}
      </div>
      <div class="modal-bd" id="setBody"></div>
      <div class="modal-ft"><button class="btn primary" data-x>${esc(window.t('close'))}</button></div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelectorAll('[data-x]').forEach((b) => b.onclick = close);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const body = overlay.querySelector('#setBody');
  const renderTab = (t) => {
    overlay.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    if (t === 'appearance') body.innerHTML = tabAppearance();
    if (t === 'security') body.innerHTML = tabSecurity();
    if (t === 'data') body.innerHTML = tabData();
    if (t === 'about') body.innerHTML = tabAbout();
    wire(t);
  };
  overlay.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => renderTab(b.dataset.tab));
  renderTab(tab);

  /* ---- 各标签页 ---- */
  function tabAppearance() {
    const th = state.settings.theme;
    const bg = state.settings.background;
    return `
      <div class="section">
        <h4>${esc(window.t('theme'))}</h4>
        <div class="swatches">
          ${PRESETS.map((p) => `<div class="swatch ${sameTheme(p.theme, th) ? 'on' : ''}" data-preset="${p.id}"
              title="${p.id}"><i style="background:${p.theme.bg}"></i><i style="background:linear-gradient(135deg,${p.theme.accent},${p.theme.accent2})"></i></div>`).join('')}
          <div style="align-self:center;font-size:12px;color:var(--muted)">${esc(window.t('themeAuto'))}</div>
        </div>
        <div class="row3">
          <label class="fld"><span class="lbl">${esc(window.t('accentColor'))}</span><input type="color" id="c-accent" value="${th.accent}"></label>
          <label class="fld"><span class="lbl">${esc(window.t('accent2Color'))}</span><input type="color" id="c-accent2" value="${th.accent2}"></label>
          <label class="fld"><span class="lbl">${esc(window.t('bgColor'))}</span><input type="color" id="c-bg" value="${th.bg}"></label>
          <label class="fld"><span class="lbl">${esc(window.t('surfaceColor'))}</span><input type="color" id="c-surface" value="${th.surface}"></label>
          <label class="fld"><span class="lbl">${esc(window.t('textColor'))}</span><input type="color" id="c-text" value="${th.text}"></label>
          <label class="fld"><span class="lbl">${esc(window.t('mutedColor'))}</span><input type="color" id="c-muted" value="${th.muted}"></label>
        </div>
        <label class="fld"><span class="lbl">${esc(window.t('radius'))} · ${th.radius}px</span>
          <input type="range" id="c-radius" min="0" max="24" value="${th.radius}"></label>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="btn sm" id="c-reset">${esc(window.t('resetTheme'))}</button>
          <div class="seg" id="c-mode">
            <button data-mode="light" class="${th.mode === 'light' ? 'on' : ''}">${esc(window.t('themeLight'))}</button>
            <button data-mode="dark" class="${th.mode === 'dark' ? 'on' : ''}">${esc(window.t('themeDark'))}</button>
          </div>
        </div>
      </div>
      <div class="section">
        <h4>${esc(window.t('bgImage'))}</h4>
        <div class="sub">${esc(window.t('bgOpacity'))} / ${esc(window.t('bgBlur'))}</div>
        <div class="row3">
          <label class="fld"><span class="lbl">${esc(window.t('bgOpacity'))} · ${Math.round(bg.opacity * 100)}%</span>
            <input type="range" id="b-op" min="0" max="100" value="${Math.round(bg.opacity * 100)}"></label>
          <label class="fld"><span class="lbl">${esc(window.t('bgBlur'))} · ${bg.blur}px</span>
            <input type="range" id="b-blur" min="0" max="40" value="${bg.blur}"></label>
          <label class="fld"><span class="lbl">${esc(window.t('bgDim'))} · ${Math.round(bg.dim * 100)}%</span>
            <input type="range" id="b-dim" min="0" max="100" value="${Math.round(bg.dim * 100)}"></label>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn sm" id="b-pick">${esc(window.t('pickImage'))}</button>
          <button class="btn sm danger" id="b-clear">${esc(window.t('removeImage'))}</button>
          <select id="b-size" style="width:auto;min-width:130px">
            ${['cover', 'contain', 'repeat'].map((k) =>
              `<option value="${k}" ${bg.size === k ? 'selected' : ''}>${esc(window.t(k === 'cover' ? 'sizeCover' : k === 'contain' ? 'sizeContain' : 'sizeRepeat'))}</option>`).join('')}
          </select>
        </div>
      </div>`;
  }

  function tabSecurity() {
    const pv = state.settings.privacy;
    return `
      <div class="section">
        <h4>${esc(window.t('autoHide'))}</h4>
        <div class="sub">${esc(window.t('autoHideHint'))}</div>
        <label class="fld" style="max-width:260px">
          <input type="number" id="p-auto" min="0" max="600" value="${pv.autoHideSeconds}"
            style="width:100%;border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:8px 10px">
        </label>
      </div>
      <div class="section">
        <h4>${esc(window.t('maskStyle'))}</h4>
        <div class="sub">${esc(window.t('copyHintPrefix'))}<code class="path">${esc(exampleMask())}</code></div>
        <select id="p-mask" style="max-width:280px">
          ${[['prefix', 'maskPrefix'], ['tail', 'maskTail'], ['full', 'maskShort']].map(([v, k]) =>
            `<option value="${v}" ${pv.maskStyle === v ? 'selected' : ''}>${esc(window.t(k))}</option>`).join('')}
        </select>
      </div>
      <div class="section">
        <h4>${esc(window.t('localKey'))}</h4>
        <div class="sub">${esc(window.t('localKeyDesc'))}</div>
        <div class="warn"><span>⚠</span><span>${esc(window.t('localKeyWarn'))}</span></div>
        <div style="margin-top:12px">
          <div class="kv"><span class="k">${esc(window.t('keyFile'))}</span><span class="v"><code class="path">${esc(state.status.keyPath)}</code></span></div>
          <div class="kv"><span class="k">${esc(window.t('vaultFile'))}</span><span class="v"><code class="path">${esc(state.status.vaultPath)}</code></span></div>
          <div class="kv"><span class="k">${esc(window.t('storageNote'))}</span><span class="v">AES-256-GCM · scrypt(N=16384)</span></div>
        </div>
        <button class="btn sm" id="s-open" style="margin-top:10px">${esc(window.t('openDir'))}</button>
      </div>`;
  }

  function tabData() {
    return `
      <div class="section">
        <h4>${esc(window.t('backup'))}</h4>
        <div class="sub">${esc(window.t('exportEncDesc'))}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="d-exp-enc">${esc(window.t('exportEnc'))}</button>
          <button class="btn" id="d-exp-plain">${esc(window.t('exportPlain'))}</button>
        </div>
      </div>
      <div class="section">
        <h4>${esc(window.t('importVault'))}</h4>
        <div class="sub">${esc(window.t('importDesc'))}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" id="d-imp-merge">${esc(window.t('importVault'))}</button>
        </div>
      </div>
      <div class="section">
        <h4>${esc(window.t('dangerZone'))}</h4>
        <div class="sub">${esc(window.t('exportPlainDesc'))}</div>
      </div>`;
  }

  function tabAbout() {
    return `
      <div class="section">
        <h4>${esc(window.t('about'))}</h4>
        <div class="kv"><span class="k">${esc(window.t('version'))}</span><span class="v">${esc(state.info.version)} · Electron ${esc(state.info.electron)}</span></div>
        <div class="kv"><span class="k">${esc(window.t('exePath'))}</span><span class="v"><code class="path">${esc(state.info.exePath || '—')}</code></span></div>
        <div class="kv"><span class="k">${esc(window.t('dataDir'))}</span><span class="v"><code class="path">${esc(state.info.dataDir)}</code></span></div>
        <div class="kv"><span class="k">${esc(window.t('language'))}</span><span class="v">${esc(state.lang === 'en' ? 'English' : '简体中文')}</span></div>
        <button class="btn sm" id="a-lang" style="margin-top:8px">${esc(window.t('language'))}</button>
        ${state.info.packaged ? `<div class="sub" style="margin-top:16px">${esc(window.t('portableHint'))}</div>
          <button class="btn sm" id="a-shortcut">${esc(window.t('shortcut'))}</button>` : ''}
        <div class="hint" style="margin-top:12px">${esc(window.t('toggleHelp'))}</div>
      </div>`;
  }

  /* ---- 交互绑定 ---- */
  function wire(t) {
    if (t === 'appearance') {
      overlay.querySelectorAll('[data-preset]').forEach((sw) => sw.onclick = async () => {
        const p = PRESETS.find((x) => x.id === sw.dataset.preset);
        state.settings.theme = { ...state.settings.theme, ...p.theme };
        applyTheme(state.settings.theme);
        await call(api.saveSettings, { theme: state.settings.theme });
        renderTab('appearance');
      });
      const bindColor = (id, key) => {
        const el = overlay.querySelector(id);
        if (!el) return;
        el.oninput = () => {
          state.settings.theme[key] = el.value;
          applyTheme(state.settings.theme);
        };
        el.onchange = async () => { await call(api.saveSettings, { theme: state.settings.theme }); renderTab('appearance'); };
      };
      bindColor('#c-accent', 'accent'); bindColor('#c-accent2', 'accent2');
      bindColor('#c-bg', 'bg'); bindColor('#c-surface', 'surface');
      bindColor('#c-text', 'text'); bindColor('#c-muted', 'muted');

      const rad = overlay.querySelector('#c-radius');
      if (rad) {
        rad.oninput = () => { state.settings.theme.radius = Number(rad.value); applyTheme(state.settings.theme); };
        rad.onchange = async () => { await call(api.saveSettings, { theme: state.settings.theme }); renderTab('appearance'); };
      }
      const reset = overlay.querySelector('#c-reset');
      if (reset) reset.onclick = async () => {
        state.settings.theme = { ...PRESETS[0].theme, radius: 14 };
        applyTheme(state.settings.theme);
        await call(api.saveSettings, { theme: state.settings.theme });
        renderTab('appearance');
      };
      overlay.querySelectorAll('#c-mode button').forEach((b) => b.onclick = async () => {
        const p = PRESETS.find((x) => x.theme.mode === b.dataset.mode) || PRESETS[0];
        state.settings.theme = { ...state.settings.theme, ...p.theme };
        applyTheme(state.settings.theme);
        await call(api.saveSettings, { theme: state.settings.theme });
        renderTab('appearance');
      });

      const bindRange = (id, key) => {
        const el = overlay.querySelector(id);
        if (!el) return;
        el.oninput = () => {
          state.settings.background[key] = key === 'opacity' || key === 'dim' ? Number(el.value) / 100 : Number(el.value);
          applyBackground(state.settings.background);
          const lbl = el.previousElementSibling;
          const unit = key === 'blur' ? 'px' : '%';
          lbl.textContent = lbl.textContent.split('·')[0] + '· ' + (key === 'blur' ? el.value + unit : el.value + unit);
        };
        el.onchange = async () => { await call(api.saveSettings, { background: state.settings.background }); };
      };
      bindRange('#b-op', 'opacity'); bindRange('#b-blur', 'blur'); bindRange('#b-dim', 'dim');

      const pick = overlay.querySelector('#b-pick');
      if (pick) pick.onclick = async () => {
        const res = await window.vault.pickBackground();
        if (res.ok === false) { toast(res.error); return; }
        if (res.data && res.data.canceled) return;
        state.bgDataUrl = res.data.dataUrl;
        state.settings.background.image = res.data.path;
        applyBackground(state.settings.background);
      };
      const clear = overlay.querySelector('#b-clear');
      if (clear) clear.onclick = async () => {
        await call(api.clearBackground);
        state.bgDataUrl = '';
        state.settings.background.image = '';
        applyBackground(state.settings.background);
      };
      const size = overlay.querySelector('#b-size');
      if (size) size.onchange = async () => {
        state.settings.background.size = size.value;
        applyBackground(state.settings.background);
        await call(api.saveSettings, { background: state.settings.background });
      };
    }

    if (t === 'security') {
      const auto = overlay.querySelector('#p-auto');
      if (auto) auto.onchange = async () => {
        state.settings.privacy.autoHideSeconds = Math.max(0, Math.min(600, Number(auto.value) || 0));
        await call(api.saveSettings, { privacy: state.settings.privacy });
      };
      const maskSel = overlay.querySelector('#p-mask');
      if (maskSel) maskSel.onchange = async () => {
        state.settings.privacy.maskStyle = maskSel.value;
        await call(api.saveSettings, { privacy: state.settings.privacy });
        await refresh(); render();
        renderTab('security');
      };
      const open = overlay.querySelector('#s-open');
      if (open) open.onclick = () => api.revealExternal(state.info.dataDir);
    }

    if (t === 'data') {
      const expEnc = overlay.querySelector('#d-exp-enc');
      if (expEnc) expEnc.onclick = async () => {
        const pass = await promptDialog(window.t('exportEnc'), window.t('passphrase'));
        if (!pass) return;
        if (pass.length < 6) { toast(window.t('passphrase')); return; }
        const res = await window.vault.exportVault({ mode: 'encrypted', passphrase: pass });
        if (res.ok === false) { toast(res.error); return; }
        if (res.data.canceled) return;
        toast(window.t('exportDone', { path: res.data.path }));
      };
      const expPlain = overlay.querySelector('#d-exp-plain');
      if (expPlain) expPlain.onclick = async () => {
        const res = await window.vault.exportVault({ mode: 'plain' });
        if (res.ok === false) { toast(res.error); return; }
        if (res.data.canceled) return;
        toast(window.t('exportDone', { path: res.data.path }));
      };
      const imp = overlay.querySelector('#d-imp-merge');
      if (imp) imp.onclick = async () => {
        let pass = await promptDialog(window.t('importVault'), window.t('importPassphrase'));
        if (pass === null) return;
        if (!pass) pass = '';
        let res = await window.vault.importVault({ mode: 'merge', passphrase: pass });
        if (res.ok === false) { toast(res.error); return; }
        if (res.data.canceled) return;
        toast(window.t('importDone', { n: res.data.counts.total }));
        state.settings = await call(api.settings);
        await refresh(); render(); buildStaticUI();
        renderTab('data');
      };
    }

    if (t === 'about') {
      const lang = overlay.querySelector('#a-lang');
      if (lang) lang.onclick = async () => { close(); await switchLang(); openSettings('about'); };

      const sc = overlay.querySelector('#a-shortcut');
      if (sc) sc.onclick = async () => {
        const res = await window.vault.createShortcut();
        if (res.ok === false) { toast(res.error); return; }
        const names = (res.data.created || []).map((l) =>
          l === 'desktop' ? (state.lang === 'en' ? 'Desktop' : '桌面') : (state.lang === 'en' ? 'Start menu' : '开始菜单'));
        toast(names.length ? window.t('shortcutDone', { list: names.join(' / ') }) : window.t('shortcutNone'));
      };
    }
  }
}

function sameTheme(a, b) {
  return ['accent', 'accent2', 'bg', 'surface', 'text', 'mode'].every((k) => a[k] === b[k]);
}

/** 用当前掩码样式展示一个示例，便于用户直观比较 */
function exampleMask() {
  const st = (state.settings.privacy && state.settings.privacy.maskStyle) || 'prefix';
  const sample = 'sk-example-1234567890abcdef';
  const tail = sample.slice(-4);
  if (st === 'tail') return '••••••••' + tail;
  if (st === 'full') return '••••••••••••';
  return sample.slice(0, 4) + '••••••••' + tail;
}

/* ------------------------------- 语言 ------------------------------- */

async function switchLang() {
  state.lang = state.lang === 'en' ? 'zh' : 'en';
  window.__lang = state.lang;
  await call(api.saveSettings, { language: state.lang });
  buildStaticUI();
  render();
}

/* ------------------------------ 事件绑定 ------------------------------ */

$('#search').addEventListener('input', (e) => { state.filter.q = e.target.value; render(); });
$('#providerSelect').addEventListener('change', (e) => {
  state.filter.provider = e.target.value; state.filter.favorites = false; render();
});
$('#sortSelect').addEventListener('change', async (e) => {
  state.sort = e.target.value;
  await call(api.saveSettings, { list: { sort: state.sort } });
  render();
});
$('#addBtn').onclick = () => openEditor(null);
$('#settingsBtn').onclick = () => openSettings('appearance');
$('#langBtn').onclick = switchLang;

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); openEditor(null); }
});

init();
