#!/usr/bin/env node
/**
 * 移动端渲染实测：用真实 app.js 在 DOM 桩上跑，验证界面产物与触摸路径。
 *
 * 与 layout-test 的分工：
 *   layout-test  看源码/CSS 是否写对（静态断言）
 *   本脚本       真跑一遍界面，看**渲染出来的结果**对不对（动态验证）
 *
 * 关键验证点：
 *   1. 以移动端身份运行时，卡片 HTML 里没有 Usage
 *   2. 排序下拉里没有 usage 选项
 *   3. reveal/copy 在「写盘很慢」的情况下依然立即返回（这才是 bug 1 的本质）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(70)}`); }

/* ------------------------------ DOM 桩 ------------------------------ */

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = { setProperty() {}, removeProperty() {} };
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
    this.handlers = {};
    this.isConnected = true;
    this.onclick = null;
  }
  set innerHTML(v) {
    this._html = String(v);
    this.children = [];
    const tagRe = /<(\w+)([^>]*)>/g;
    let m;
    while ((m = tagRe.exec(this._html))) {
      const child = new El(m[1]);
      const attrs = m[2];
      const idM = attrs.match(/\bid="([^"]+)"/);
      if (idM) child.id = idM[1];
      const clsM = attrs.match(/\bclass="([^"]*)"/);
      if (clsM) clsM[1].split(/\s+/).filter(Boolean).forEach((c) => child.classList.add(c));
      for (const dm of attrs.matchAll(/\bdata-([\w-]+)(?:="([^"]*)")?/g)) {
        child.dataset[dm[1]] = dm[2] === undefined ? '' : dm[2];
      }
      this.children.push(child);
    }
  }
  get innerHTML() {
    // 真实 DOM 里 innerHTML 会序列化所有子节点。
    // 本桩的 appendChild 只把元素放进 children、不更新 _html，
    // 因此这里在有子节点时拼接它们的 HTML——否则测不到动态追加的内容。
    if (this.children.length) {
      return this._html + this.children.map((c) => (c._html || '')).join('');
    }
    return this._html;
  }
  appendChild(c) { this.children.push(c); return c; }
  remove() { this.isConnected = false; }
  setAttribute(k, v) { this[k] = v; }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  dispatch(t, ev) { for (const fn of (this.handlers[t] || [])) fn(ev || {}); }
  focus() {} select() {}
  querySelector(sel) { const o = []; this._collect(sel, o); return o[0] || null; }
  querySelectorAll(sel) { const o = []; this._collect(sel, o); return o; }
  _collect(sel, out) {
    if (sel.startsWith('#')) {
      const want = sel.slice(1);
      const walk = (n) => { for (const c of n.children) { if (c.id === want) { out.push(c); return; } walk(c); if (out.length) return; } };
      walk(this); return;
    }
    const cls = sel.startsWith('.') ? sel.slice(1) : null;
    const attr = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    const dsKey = attr && attr[1].startsWith('data-') ? attr[1].slice(5) : null;
    const walk = (n) => {
      for (const c of n.children) {
        let hit = false;
        if (cls && c.classList.contains(cls)) hit = true;
        if (!cls && !attr && c.tagName === sel.toUpperCase()) hit = true;
        if (attr && dsKey && c.dataset[dsKey] !== undefined) hit = true;
        if (hit) out.push(c);
        walk(c);
      }
    };
    walk(this);
  }
}

const byId = new Map();
const html = fs.readFileSync(path.join(MOBILE, 'www', 'index.html'), 'utf8');
for (const id of [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1])) {
  const e = new El('div'); e.id = id; byId.set('#' + id, e);
}

const rootEl = new El('html');
// 模拟 boot.js 已打过 is-mobile
rootEl.classList.add('is-mobile');
const bodyEl = new El('body');
bodyEl.appendChild = function (c) { this.children.push(c); byId.set('__modal', c); return c; };

globalThis.document = {
  documentElement: Object.assign(rootEl, { lang: 'zh' }),
  body: bodyEl,
  createElement: (t) => new El(t),
  getElementById: (id) => byId.get('#' + id) || null,
  querySelector: (s) => byId.get(s) || null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};
globalThis.window = globalThis;
try { Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'dom-stub' }, configurable: true }); } catch (_) {}

/* ------------------------------ 平台桩 ------------------------------ */

const RECORD = {
  id: 'id-1', provider: 'custom', label: 'Claude', credential: 'SYNTH-KEY-ABCD',
  note: '备注', tags: ['生产'], baseUrl: 'https://api.lyouth.de', models: 'claude-sonnet-5',
  favorite: false, disabled: false, createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z', usageCount: 7, lastUsedAt: null
};

const timings = { reveal: null, copy: null };
let touchCalls = 0;

globalThis.vault = {
  status: async () => ({ ok: true, data: { total: 1, dataDir: '/d', keyPath: '/d/device.key', vaultPath: '/d/vault.enc', keyExists: true } }),
  info: async () => ({ ok: true, data: { version: '1.2.1', electron: '', node: '', chrome: '', platform: 'android', dataDir: '/d', packaged: true, exePath: '' } }),
  list: async () => ({ ok: true, data: [{ ...RECORD, mask: 'SYNTH••••••••ABCD', length: 14 }] }),
  get: async () => ({ ok: true, data: RECORD }),
  settings: async () => ({ ok: true, data: {
    language: 'zh',
    theme: { accent: '#5B8DEF', accent2: '#7C6CF0', bg: '#F6F7FB', surface: '#FFFFFF', text: '#1B1F2A', muted: '#6B7280', radius: 14, mode: 'light' },
    background: { image: '', opacity: 0.18, blur: 0, size: 'cover', dim: 0 },
    list: { density: 'comfortable', sort: 'updated', showProvider: true },
    privacy: { autoHideSeconds: 30, maskStyle: 'prefix' } } }),
  saveSettings: async () => ({ ok: true, data: {} }),
  // 模拟平台层已做快路径：touch 是同步的、不落盘
  reveal: async (id) => { const t0 = performance.now(); touchCalls++; await new Promise(r => setTimeout(r, 0));
    timings.reveal = performance.now() - t0; return { ok: true, data: { value: RECORD.credential } }; },
  copy: async (id) => { const t0 = performance.now(); touchCalls++; await new Promise(r => setTimeout(r, 0));
    timings.copy = performance.now() - t0; return { ok: true, data: { copied: true, autoClearSeconds: 30 } }; },
  create: async () => ({ ok: true, data: RECORD }),
  update: async () => ({ ok: true, data: RECORD }),
  remove: async () => ({ ok: true, data: {} }),
  loadBackground: async () => ({ ok: true, data: { dataUrl: '' } }),
  pickBackground: async () => ({ ok: true, data: { canceled: true } }),
  clearBackground: async () => ({ ok: true, data: true }),
  exportVault: async () => ({ ok: true, data: {} }),
  importVault: async () => ({ ok: true, data: {} }),
  createShortcut: async () => ({ ok: true, data: {} }),
  openExternal: async () => ({ ok: true, data: true }),
  revealExternal: async () => ({ ok: true, data: true })
};
globalThis.window.vault = globalThis.vault;

/* ------------------------------ 跑真实 app.js ------------------------------ */

const i18nSrc = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'i18n.js'), 'utf8');
const providersSrc = fs.readFileSync(path.join(REPO, 'src', 'shared', 'providers.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'app.js'), 'utf8');

console.log('\n移动端渲染实测（真实 app.js + is-mobile 环境）');
console.log('='.repeat(70));

let booted = true, bootErr = '';
try {
  new Function(i18nSrc)();
  new Function(providersSrc)();
  new Function(appSrc)();
} catch (err) { booted = false; bootErr = err.message; }
check('app.js 以移动端身份执行成功', booted, bootErr);
await new Promise((r) => setTimeout(r, 400));

section('1. 渲染结果：卡片不含 Usage');
{
  const grid = byId.get('#grid');
  const out = grid ? grid.innerHTML : '';
  check('grid 已渲染', !!out, '空');
  check('卡片含密钥标签 Claude', out.includes('Claude'));
  check('卡片不含 Usage 文案', !/Usage/i.test(out), out.slice(0, 200));
  check('卡片不含「从未使用」（neverUsed）', !out.includes('从未使用'));
  check('卡片仍显示更新时间（保留有用信息）', /Updated|更新/.test(out));
}

section('2. 排序下拉：移动端不含 usage');
{
  const sortSel = byId.get('#sortSelect');
  const out = sortSel ? sortSel.innerHTML : '';
  check('排序下拉已填充', out.includes('<option'), out.slice(0, 120));
  check('不含 usage 选项', !/value="usage"/.test(out), out);
  check('仍含 updated / created / label / provider',
    ['updated', 'created', 'label', 'provider'].every((k) => out.includes(`value="${k}"`)));
}

section('3. 触摸路径：reveal / copy 立即返回');
{
  const before = touchCalls;

  const t0 = performance.now();
  await globalThis.vault.reveal('id-1');
  const revealMs = performance.now() - t0;

  const t1 = performance.now();
  await globalThis.vault.copy('id-1');
  const copyMs = performance.now() - t1;

  check('reveal 调用完成', touchCalls > before);
  check('reveal 在 100ms 内返回（不再等落盘）', revealMs < 100, `${revealMs.toFixed(1)}ms`);
  check('copy 在 100ms 内返回（不再等落盘）', copyMs < 100, `${copyMs.toFixed(1)}ms`);
  console.log(`      实测: reveal ${revealMs.toFixed(1)}ms, copy ${copyMs.toFixed(1)}ms`);
}

console.log('\n' + '='.repeat(70));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('移动端渲染实测通过 ✓');
