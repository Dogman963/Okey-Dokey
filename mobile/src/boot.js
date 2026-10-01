/**
 * 移动端启动入口（打包为 www/platform.js）。
 *
 * 关键点：界面脚本 app.js 在末尾会**立即**调用 init()，所以 window.vault 必须在
 * app.js 执行前就存在，且方法可同步取用。因此这里先挂一个「就绪后自动转发」的
 * 代理对象：每个方法都 await 平台初始化，再转发到真实实现。
 *
 * 这样 src/renderer/app.js 一行都不用改，桌面端与安卓端共用同一份界面代码。
 */
import { createVaultApi, setPendingImport } from './platform/vault-api.mjs';
import { App as CapApp } from '@capacitor/app';

const ready = createVaultApi();
let real = null;

ready.then((api) => { real = api; window.__vaultReady = true; })
     .catch((err) => { console.error('[okey] vault init failed', err); });

/** 生成一个「等待就绪再转发」的同名方法 */
function proxy(name) {
  return async (...args) => {
    try {
      const api = real || (await ready);
      const fn = api[name];
      if (typeof fn !== 'function') return { ok: false, error: 'NOT_SUPPORTED' };
      return await fn(...args);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };
}

const METHODS = [
  'status', 'info',
  'list', 'get', 'create', 'update', 'remove',
  'copy', 'reveal', 'test',
  'settings', 'saveSettings',
  'exportVault', 'importVault',
  'pickBackground', 'loadBackground', 'clearBackground',
  'createShortcut', 'openExternal', 'revealExternal',
  'shareExport'
];

const api = {};
for (const m of METHODS) api[m] = proxy(m);
api.ready = () => ready;

window.vault = api;

/* ------------------- 「用 Okey Dokey 打开」文件 ------------------- */

// 自定义协议/文件关联进来的内容，交给导入流程处理
CapApp.addListener('appUrlOpen', async (event) => {
  const url = event && event.url;
  if (!url) return;
  try {
    const text = await fetch(url).then((r) => r.text());
    if (!text) return;
    setPendingImport({ url, text });
    // 若界面已就绪，直接提示用户去「设置 → 数据」导入
    if (window.__openImportHint) window.__openImportHint();
  } catch (err) {
    console.warn('[okey] appUrlOpen failed', err);
  }
});

/* ------------------- 安卓返回键 ------------------- */

// 切到后台时把合并中的计数落盘：WebView 被冻结后定时器不会跑，
// 不 flush 就会丢掉这一批用量计数。
CapApp.addListener('appStateChange', async ({ isActive }) => {
  if (!isActive) {
    try {
      const api = real || (await ready);
      if (api && typeof api.flushPending === 'function') await api.flushPending();
    } catch (_) { /* 落盘失败不影响前台使用 */ }
  }
});

// 有弹层则先关弹层，否则退到后台（避免误退出丢状态）
CapApp.addListener('backButton', ({ canGoBack }) => {
  const overlay = document.querySelector('.overlay');
  if (overlay) {
    const x = overlay.querySelector('[data-x]');
    if (x) x.click(); else overlay.remove();
    return;
  }
  if (canGoBack && window.history.length > 1) { window.history.back(); return; }
  CapApp.minimizeApp();
});

/* ------------------- 移动端标记 ------------------- */

document.documentElement.classList.add('is-mobile');

// 暴露给界面：有「待导入文件」时给出提示入口
window.__openImportHint = () => {
  const s = document.querySelector('#settingsBtn');
  if (s) s.classList.add('attention');
};
