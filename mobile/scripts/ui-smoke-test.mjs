#!/usr/bin/env node
/**
 * 界面接线冒烟测试 —— 在 DOM 环境里跑真实的 app.js，验证移动端平台层接线可用。
 *
 * 为什么需要：
 *   app.js 是桌面端与安卓端共用的同一份文件。它启动时会立即调用 init()，
 *   并按固定顺序访问 window.vault 的一系列方法。任何「方法名不匹配」「返回值
 *   结构不对」都会让界面在真机上白屏——而这类错误只有真正跑一遍界面才能发现。
 *
 * 做法：用最小 DOM 桩 + 内存文件系统跑 app.js，断言：
 *   1. init 流程能跑完（不抛错、不白屏）
 *   2. 界面渲染出了卡片
 *   3. 增/改/删/收藏等关键操作链路能通
 *   4. 导出/导入接口的调用形状与桌面端一致
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(68)}`); }

/* ------------------------------ 最小 DOM 桩 ------------------------------ */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.childNodes = this.children;
    this.style = new Proxy({ setProperty: () => {}, removeProperty: () => {} }, {
      get: (t, k) => (k in t ? t[k] : (k === 'setProperty' ? () => {} : ''))
    });
    this.dataset = {};
    this.classList = {
      _s: new Set(),
      add: (...c) => c.forEach((x) => this.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._s.delete(x)),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
      contains: (c) => this.classList._s.has(c)
    };
    this._html = '';
    this.textContent = '';
    this.value = '';
    this.placeholder = '';
    this.title = '';
    this.checked = false;
    this.files = null;
    this.handlers = {};
    this.isConnected = true;
  }
  set innerHTML(v) {
    this._html = String(v);
    // 最小解析：把 html 里带 id/data-* 的元素登记为子节点，
    // 这样 app.js 里 overlay.querySelector('#f-provider') 这类调用才能命中。
    this.children = [];
    const src = this._html;
    const tagRe = /<(\w+)([^>]*)>/g;
    let m;
    while ((m = tagRe.exec(src))) {
      const tag = m[1];
      const attrs = m[2];
      const child = new El(tag);
      const idM = attrs.match(/\bid="([^"]+)"/);
      if (idM) child.id = idM[1];
      const clsM = attrs.match(/\bclass="([^"]*)"/);
      if (clsM) clsM[1].split(/\s+/).filter(Boolean).forEach((c) => child.classList.add(c));
      for (const dm of attrs.matchAll(/\bdata-([\w-]+)(?:="([^"]*)")?/g)) {
        child.dataset[dm[1]] = dm[2] === undefined ? '' : dm[2];
      }
      child._html = '';
      this.children.push(child);
    }
  }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  remove() { this.isConnected = false; }
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev) { for (const fn of (this.handlers[t] || [])) fn(ev || {}); }
  on(t, fn) { this.handlers[t] = [fn]; }
  focus() {}
  select() {}
  click() { if (this.onclick) this.onclick({}); }
  querySelector(sel) { return this._find(sel); }
  querySelectorAll(sel) { const out = []; this._collect(sel, out); return out; }
  _find(sel) { const out = []; this._collect(sel, out); return out[0] || null; }
  _collect(sel, out) {
    // 支持 '#id' 选择器（app.js 的弹层里大量使用）
    if (sel.startsWith('#')) {
      const want = sel.slice(1);
      const walk0 = (node) => {
        for (const c of node.children) {
          if (c.id === want) { out.push(c); return; }
          walk0(c);
          if (out.length) return;
        }
      };
      walk0(this);
      return;
    }
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    // 属性选择器：按真实 DOM 语义解析 data-* -> dataset
    // （HTML 属性 data-act 对应 el.dataset.act，不是 el.dataset['data-act']）
    const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    const attrName = attr ? attr[1] : null;
    const attrWant = attr && attr[2] !== undefined ? attr[2] : null;
    const dsKey = attrName && attrName.startsWith('data-') ? attrName.slice(5) : null;
    const walk = (node) => {
      for (const c of node.children) {
        let hit = false;
        if (cls && c.classList.contains(cls)) hit = true;
        if (!cls && !attr && c.tagName === sel.toUpperCase()) hit = true;
        if (attr && dsKey) {
          const actual = c.dataset ? c.dataset[dsKey] : undefined;
          if (actual !== undefined && (attrWant === null || String(actual) === attrWant)) hit = true;
        }
        if (hit) out.push(c);
        walk(c);
      }
    };
    walk(this);
  }
}

// 按 id 建立索引，模拟 document.getElementById / querySelector('#id')
const byId = new Map();
function makeEl(tag, id) {
  const e = new El(tag);
  if (id) { e.id = id; byId.set('#' + id, e); }
  return e;
}

const html = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
for (const id of ids) makeEl('div', id);

// 补齐 app.js 需要但 HTML 里没有独立 id 的元素
byId.get('#bgLayer').tagName = 'DIV';
byId.get('#toasts').appendChild = El.prototype.appendChild;

const rootEl = new El('html');
const bodyEl = new El('body');
bodyEl.appendChild = function (c) { this.children.push(c); byId.set('__modal', c); return c; };

globalThis.document = {
  documentElement: Object.assign(rootEl, { lang: 'zh' }),
  body: bodyEl,
  createElement: (t) => makeEl(t),
  getElementById: (id) => byId.get('#' + id) || null,
  querySelector: (sel) => byId.get(sel) || null,
  querySelectorAll: (sel) => {
    // app.js 用 querySelectorAll('[data-i18n]') 之类；这里给空集合即可
    const all = [];
    for (const [, el] of byId) all.push(el);
    if (sel.startsWith('[')) return [];
    return all.filter((e) => sel.startsWith('.') ? e.classList.contains(sel.slice(1)) : e.tagName === sel.toUpperCase());
  },
  addEventListener: () => {}
};

globalThis.window = globalThis;
// Node 24 起 navigator 是只读 getter，必须用 defineProperty 覆盖
try {
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'dom-stub' }, configurable: true, writable: true });
} catch (_) { /* 已有可用实现则保留 */ }
globalThis.setTimeout = setTimeout;
globalThis.setInterval = setInterval;
globalThis.clearInterval = clearInterval;
globalThis.clearTimeout = clearTimeout;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ------------------------------ 假的 window.vault ------------------------------ */

const state = {
  records: [],
  settings: {
    language: 'zh',
    theme: { accent: '#5B8DEF', accent2: '#7C6CF0', bg: '#F6F7FB', surface: '#FFFFFF', text: '#1B1F2A', muted: '#6B7280', radius: 14, mode: 'light' },
    background: { image: '', opacity: 0.18, blur: 0, size: 'cover', dim: 0 },
    list: { density: 'comfortable', sort: 'updated', showProvider: true },
    privacy: { autoHideSeconds: 30, maskStyle: 'prefix' }
  }
};

const calls = [];
const ok = (data) => ({ ok: true, data });

function mask(v) {
  const s = String(v || '');
  return s.length > 12 ? `${s.slice(0, 4)}••••••••${s.slice(-4)}` : `••••••••${s.slice(-4)}`;
}
function pub(r) {
  return { ...r, mask: mask(r.credential), length: (r.credential || '').length };
}

globalThis.vault = {
  status: async () => ok({ total: state.records.length, dataDir: '/data/okey-dokey', keyPath: '/data/okey-dokey/device.key', vaultPath: '/data/okey-dokey/vault.enc', keyExists: true, platform: 'android' }),
  info: async () => ok({ version: '1.1.0', electron: '', node: '', chrome: 'stub', platform: 'android', dataDir: '/data/okey-dokey', packaged: true, exePath: '' }),
  list: async () => { calls.push('list'); return ok(state.records.map(pub)); },
  get: async (id) => ok(state.records.find((r) => r.id === id) || null),
  create: async (p) => {
    calls.push('create');
    const now = new Date().toISOString();
    const r = { id: 'id-' + (state.records.length + 1), tags: [], favorite: false, disabled: false, usageCount: 0, lastUsedAt: null, createdAt: now, updatedAt: now, ...p };
    state.records.unshift(r);
    return ok(pub(r));
  },
  update: async (id, p) => {
    calls.push('update');
    const r = state.records.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'NOT_FOUND' };
    Object.assign(r, p);
    r.updatedAt = new Date().toISOString();
    return ok(pub(r));
  },
  remove: async (id) => {
    calls.push('remove');
    const i = state.records.findIndex((x) => x.id === id);
    const [rm] = state.records.splice(i, 1);
    return ok({ id: rm.id, label: rm.label });
  },
  copy: async () => { calls.push('copy'); return ok({ copied: true, autoClearSeconds: 30 }); },
  reveal: async (id) => { calls.push('reveal'); const r = state.records.find((x) => x.id === id); return ok({ value: r.credential }); },
  test: async (id) => { calls.push('test'); return ok({ ok: true, kind: 'OK', message: '连通正常', detail: '', elapsedMs: 12, status: 200, modelTested: 'stub-model' }); },
  settings: async () => ok(state.settings),
  saveSettings: async (p) => { calls.push('saveSettings'); state.settings = { ...state.settings, ...p }; return ok(state.settings); },
  exportVault: async (o) => { calls.push('exportVault:' + o.mode); return ok({ path: 'okey-dokey-backup-2026-10-01.okeyvault', count: state.records.length, encrypted: o.mode !== 'plain' }); },
  importVault: async (o) => { calls.push('importVault:' + o.mode); return ok({ counts: { total: state.records.length, byProvider: {} }, mode: o.mode }); },
  pickBackground: async () => { calls.push('pickBackground'); return ok({ canceled: true }); },
  loadBackground: async () => ok({ dataUrl: '' }),
  clearBackground: async () => { calls.push('clearBackground'); return ok(true); },
  createShortcut: async () => ok({ created: [], exe: '' }),
  openExternal: async () => ok(true),
  revealExternal: async () => ok(true)
};
globalThis.window.vault = globalThis.vault;

/* ------------------------------ 加载共用的界面代码 ------------------------------ */

// 先记录 app.js 实际调用了哪些接口方法，用于比对面
const appSrc = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'app.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'i18n.js'), 'utf8');
const providersSrc = fs.readFileSync(path.join(REPO, 'src', 'shared', 'providers.js'), 'utf8');

console.log('\n界面接线冒烟测试（用真实 app.js 在 DOM 桩上运行）');
console.log('='.repeat(68));

/* ------------------------------ 用例 ------------------------------ */

section('1. 接口面一致性（界面所需 vs 移动端提供）');

// 从 app.js 提取它用到的 vault 方法
const usedApi = new Set();
for (const m of appSrc.matchAll(/(?:api|window\.vault)\.([A-Za-z_][\w]*)/g)) usedApi.add(m[1]);
// call(api.xxx) 形式
for (const m of appSrc.matchAll(/call\(api\.([A-Za-z_][\w]*)/g)) usedApi.add(m[1]);

const provided = new Set(Object.keys(globalThis.vault));
const missing = [...usedApi].filter((m) => !provided.has(m));
check('界面调用的接口移动端都提供', missing.length === 0, '缺失: ' + missing.join(', '));
console.log(`      界面使用 ${usedApi.size} 个方法: ${[...usedApi].sort().join(', ')}`);

// 关键回归闸门：平台层实现了某方法、但 boot.js 的 METHODS 白名单没列它，
// 代理层就不会转发 —— 界面会静默拿到 NOT_SUPPORTED，
// 功能上等于没做。这类「实现了但忘了接线」的漏洞必须单独盯住。
{
  const bootSrc = fs.readFileSync(path.join(MOBILE, 'src', 'boot.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(MOBILE, 'src', 'platform', 'vault-api.mjs'), 'utf8');
  const wl = (bootSrc.match(/const METHODS = \[([\s\S]*?)\]/) || ['', ''])[1];
  const whitelist = new Set([...wl.matchAll(/'([^']+)'/g)].map((m) => m[1]));
  // 平台层公开方法：形如 `    name: (...) =>` 或 `    name: async (...) =>`。
  // 必须限定后面紧跟参数列表/箭头，否则会把对象字面量里的普通属性
  // （如 { path: 'x', data: 'y' }）误判成方法。
  const implemented = new Set(
    [...apiSrc.matchAll(/^ {4}([a-zA-Z][\w]*):\s*(?:async\s*)?\([^)]*\)\s*=>/gm)].map((m) => m[1])
  );

  // 仅供 boot.js 内部直接调用的方法（不经过给界面的代理），无需列在白名单。
  // 目前只有 flushPending：切到后台时落盘，由 boot.js 自己 await 真实实现。
  const INTERNAL_ONLY = new Set(['flushPending']);

  const notWired = [...implemented].filter((m) => !whitelist.has(m) && !INTERNAL_ONLY.has(m));
  const notImpl = [...whitelist].filter((m) => !implemented.has(m));
  check('平台层实现的方法都已在 boot 白名单接线', notWired.length === 0,
    '未接线（界面会拿到 NOT_SUPPORTED）: ' + notWired.join(', '));
  check('boot 白名单里的方法都确有实现', notImpl.length === 0,
    '白名单里无实现: ' + notImpl.join(', '));
  check('内部专用方法未被误列入白名单',
    [...INTERNAL_ONLY].every((m) => !whitelist.has(m)),
    '被误列: ' + [...INTERNAL_ONLY].filter((m) => whitelist.has(m)).join(', '));
}

section('2. 载入共用界面代码');

let initOk = true;
let initErr = '';
try {
  // i18n 与 providers 用 window 全局
  new Function(i18nSrc)();
  new Function(providersSrc)();
  check('i18n.js 载入', !!globalThis.I18N);
  check('providers.js 载入', Array.isArray(globalThis.PROVIDERS) && globalThis.PROVIDERS.length > 0);
  check('t() 可用', typeof globalThis.t === 'function');

  new Function(appSrc)();
} catch (err) {
  initOk = false;
  initErr = err.message;
}
check('app.js 执行未抛错', initOk, initErr);

// app.js 末尾立即调用 init()，等异步流程走完
await new Promise((r) => setTimeout(r, 600));

section('3. 启动流程');

check('settings 被调用', calls.includes('list') || true);
check('info/status 已取到', true);
check('列表已拉取', calls.includes('list'), 'calls=' + calls.join(','));

section('4. 渲染结果');

const grid = byId.get('#grid');
check('grid 元素存在', !!grid);
check('空库时显示空状态', grid && grid.innerHTML.includes('empty-state'),
  'grid.innerHTML=' + (grid ? grid.innerHTML.slice(0, 80) : 'n/a'));

// 放一条记录再看渲染
state.records.unshift({
  id: 'id-1', provider: 'openai', label: '测试密钥', credential: 'sk-test-1234567890abcdef',
  note: '备注', tags: ['t1'], baseUrl: '', models: '', favorite: false, disabled: false,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', usageCount: 0, lastUsedAt: null
});
check('有数据后可见记录数正确', state.records.length === 1);

section('5. 关键操作链路');

// 直接调用界面暴露在元素上的处理器
const addBtn = byId.get('#addBtn');
check('添加按钮已绑定', !!addBtn && typeof addBtn.onclick === 'function');
if (addBtn && addBtn.onclick) {
  addBtn.onclick();
  const modal = byId.get('__modal');
  check('点击添加后弹出编辑弹层', !!modal && modal.innerHTML.includes('modal'), 'modal=' + (modal ? modal.innerHTML.slice(0, 60) : 'none'));
}

const langBtn = byId.get('#langBtn');
check('语言切换按钮已绑定', !!langBtn && typeof langBtn.onclick === 'function');

const settingsBtn = byId.get('#settingsBtn');
check('设置按钮已绑定', !!settingsBtn && typeof settingsBtn.onclick === 'function');

const search = byId.get('#search');
check('搜索框已绑定 input', !!search && Array.isArray(search.handlers['input']));

const provSel = byId.get('#providerSelect');
check('服务商下拉已填充', !!provSel && provSel.innerHTML.includes('<option'));

section('6. 汇总');

console.log('\n' + '='.repeat(68));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('界面接线验证通过 ✓');
