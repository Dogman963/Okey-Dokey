#!/usr/bin/env node
/**
 * 在真实 407px 视口下，实测搜索框等元素是否真的隐藏。
 * 这次不插 CSS，而是直接加载已构建的移动端产物（www/），
 * 完全等同于 APK 内的运行环境，避免我自己的加载时序干扰结论。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-www-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require('../src/main/index.js');

const WWW = path.join(__dirname, '..', 'mobile', 'www');

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1200));
  await main.webContents.executeJavaScript(`(async () => {
    await window.vault.create({ provider: 'custom', label: 'Gpt', credential: 'SYNTH-WWW-0001',
      note: '爱来自https://api.lyouth.de/', tags: ['生产'], baseUrl: 'https://api.lyouth.de', models: 'gpt-5.6-sol' });
    await window.vault.saveSettings({ language: 'en' });
    return true;
  })()`).catch(() => {});

  // 加载**已构建的移动端产物**（与 APK 内完全一致）
  const mwin = new BrowserWindow({
    width: 407, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'index.js'), contextIsolation: true }
  });
  await mwin.loadFile(path.join(WWW, 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));

  const wc = mwin.webContents;
  const run = (c) => wc.executeJavaScript(`(async () => { ${c} })()`);
  const out = {};

  try {
    // 注意：www/ 里的 platform.js 会尝试初始化 Capacitor，在桌面端会失败，
    // 所以 window.vault 可能不可用 —— 这里只关心静态布局与 CSS。
    out.isMobileClass = await run(`return document.documentElement.classList.contains('is-mobile');`);
    out.viewport = await run(`return { w: innerWidth, h: innerHeight };`);
    out.loadedCss = await run(`return [...document.styleSheets].map(s => s.href ? s.href.split('/').pop() : '(inline)');`);

    out.visibility = await run(`
      const pick = (sel) => { const el = document.querySelector(sel); if (!el) return { sel, exists: false };
        const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
        return { sel, display: cs.display, w: Math.round(r.width), h: Math.round(r.height),
                 visible: cs.display !== 'none' && r.width > 0 && r.height > 0 }; };
      return {
        searchWrap: pick('.search-wrap'),
        searchInput: pick('#search'),
        providerSelect: pick('#providerSelect'),
        densitySeg: pick('#densitySeg'),
        sortSelect: pick('#sortSelect')
      };
    `);

    const img = await wc.capturePage();
    const shot = path.join(__dirname, '..', 'docs', 'images', 'ui-mobile-www.png');
    fs.writeFileSync(shot, img.toPNG());
    out.screenshot = shot;
  } catch (e) { out.error = e.message; }
  finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }

  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
