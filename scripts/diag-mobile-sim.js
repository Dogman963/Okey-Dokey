#!/usr/bin/env node
/**
 * 精确复现手机端布局问题。
 *
 * 上一版失败的原因：主窗口有 minWidth:900，且设备仿真在该窗口上不生效。
 * 这次改为**另开一个无最小宽度约束的窗口**，加载同一份界面，
 * 注入 mobile.css 与 is-mobile 类，得到与手机等价的 407px 视口。
 *
 * 这样测出的坐标才与用户截图可比，才能定位「为什么会换行」。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-sim3-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require('../src/main/index.js');

const MOBILE_CSS = path.join(__dirname, '..', 'mobile', 'src', 'mobile.css');
const INDEX = path.join(__dirname, '..', 'src', 'renderer', 'index.html');

app.whenReady().then(async () => {
  // 主窗口先建好数据（走真实 IPC）
  const main = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1200));
  await main.webContents.executeJavaScript(`(async () => {
    await window.vault.create({ provider: 'custom', label: 'Claude', credential: 'SYNTH-SIM-0001',
      note: '爱来自https://api.lyouth.de/', tags: ['生产','备用'], baseUrl: 'https://api.lyouth.de', models: 'claude-sonnet-5' });
    await window.vault.create({ provider: 'deepseek', label: 'deepseek', credential: 'SYNTH-SIM-0002',
      note: '', tags: ['生产'], baseUrl: 'https://api.deepseek.com', models: 'deepseek-flash' });
    await window.vault.create({ provider: 'custom', label: 'Gpt', credential: 'SYNTH-SIM-0003',
      note: '爱来自https://api.lyouth.de/', tags: ['生产'], baseUrl: 'https://api.lyouth.de', models: 'gpt-5.6-sol' });
    await window.vault.saveSettings({ language: 'en' });
    return true;
  })()`).catch(() => {});

  // 关键：新开窗口，明确不设 minWidth
  const mwin = new BrowserWindow({
    width: 407, height: 900, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload', 'index.js'), contextIsolation: true, nodeIntegration: false }
  });
  await mwin.loadFile(INDEX);
  await new Promise((r) => setTimeout(r, 1200));

  const wc = mwin.webContents;
  const run = (c) => wc.executeJavaScript(`(async () => { ${c} })()`);

  const out = {};
  try {
    // 注入移动端样式 + is-mobile 类（真实移动端由构建与 boot.js 完成）
    await wc.insertCSS(fs.readFileSync(MOBILE_CSS, 'utf8'));
    await run(`document.documentElement.classList.add('is-mobile'); return true;`);
    await new Promise((r) => setTimeout(r, 600));

    out.viewport = await run(`return { w: innerWidth, h: innerHeight, dpr: devicePixelRatio };`);

    // 截图必须在样式注入**之后**抓，否则拍到的是无移动端适配的样子
    // （上一版就踩了这个时效陷：诊断显示已隐藏，截图却还能看到）
    const imgBefore = await wc.capturePage();
    out.screenshot = path.join(__dirname, '..', 'docs', 'images', 'ui-mobile-repro.png');
    fs.writeFileSync(out.screenshot, imgBefore.toPNG());

    out.visibility = await run(`
      const pick = (sel) => { const el = document.querySelector(sel); if (!el) return { sel, exists: false };
        const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
        return { sel, display: cs.display, visible: cs.display !== 'none' && r.width > 0, w: Math.round(r.width) }; };
      return {
        searchWrap: pick('.search-wrap'),
        providerSelect: pick('#providerSelect'),
        densitySeg: pick('#densitySeg'),
        sortSelect: pick('#sortSelect'),
        sortText: document.querySelector('#sortSelect') ? document.querySelector('#sortSelect').selectedOptions[0].textContent : null,
        aside: pick('aside')
      };
    `);

    // 操作按钮换行的真正原因：逐层量宽度
    out.actions = await run(`
      const card = document.querySelector('.card');
      if (!card) return { error: 'no card' };
      const top = card.querySelector('.card-top');
      const head = card.querySelector('.card-head');
      const actions = card.querySelector('.actions');
      const btns = [...card.querySelectorAll('.actions .btn')];
      const R = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), l: Math.round(r.left), r: Math.round(r.right), top: Math.round(r.top) }; };
      const rects = btns.map(b => ({ t: b.textContent.trim(), ...R(b) }));
      const rows = [...new Set(rects.map(x => x.top))];
      return {
        cardW: R(card).w,
        cardPadding: getComputedStyle(card).padding,
        topDir: getComputedStyle(top).flexDirection,
        headW: R(head).w,
        actionsW: R(actions).w,
        actionsDir: getComputedStyle(actions).flexDirection,
        actionsWrap: getComputedStyle(actions).flexWrap,
        actionsJustify: getComputedStyle(actions).justifyContent,
        btnCount: btns.length,
        sumBtnW: rects.reduce((s, x) => s + x.w, 0),
        neededOneRow: rects.reduce((s, x) => s + x.w, 0) + (rects.length - 1) * 6,
        rowCount: rows.length,
        // 各行靠右对齐后，左边缘是否参差不齐（视觉上的「重心偏移」）
        rowLefts: rows.map(t => Math.min(...rects.filter(x => x.top === t).map(x => x.l))),
        rows: rows.map(t => rects.filter(x => x.top === t).map(x => x.t + '(' + x.w + ')'))
      };
    `);

    // 筛选条：为什么不能一行放下
    out.filters = await run(`
      const nav = document.querySelector('#sideNav');
      const items = [...nav.querySelectorAll('.side-item')];
      const R = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), top: Math.round(r.top), l: Math.round(r.left) }; };
      const rects = items.map(i => ({ t: i.textContent.trim().replace(/\\s+/,' '), ...R(i) }));
      const rows = [...new Set(rects.map(x => x.top))];
      const cs = getComputedStyle(items[0]);
      return {
        navW: Math.round(nav.getBoundingClientRect().width),
        itemWrap: getComputedStyle(nav).flexWrap,
        itemCount: items.length,
        sumItemW: rects.reduce((s, x) => s + x.w, 0),
        neededOneRow: rects.reduce((s, x) => s + x.w, 0) + (rects.length - 1) * 8,
        itemPadding: cs.padding,
        itemFontSize: cs.fontSize,
        rowCount: rows.length,
        rows: rows.map(t => rects.filter(x => x.top === t).map(x => x.t + '(' + x.w + ')'))
      };
    `);

    const img = await wc.capturePage();
    const shot = path.join(__dirname, '..', 'docs', 'images', 'ui-mobile-repro-after.png');
    fs.writeFileSync(shot, img.toPNG());
    out.screenshot = shot;
  } catch (e) { out.error = e.message; }
  finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }

  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
