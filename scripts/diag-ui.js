#!/usr/bin/env node
/**
 * 诊断：为什么桌面端界面里查不到 .card？
 * 逐层排查：窗口是否加载完成 → 记录是否在库里 → 界面 state 里有没有记录 → 有没有渲染错误。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-diag-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require('../src/main/index.js');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1500));
  const wc = win.webContents;
  const out = {};

  const run = (code) => wc.executeJavaScript(`(async () => { ${code} })()`);

  try {
    out.url = wc.getURL();
    out.didFinishLoadFirst = wc.isLoading() === false;

    // 库里有多少记录
    out.vaultList = await run(`
      const r = await window.vault.list();
      return { ok: r.ok, count: r.data ? r.data.length : null, first: r.data && r.data[0] ? { label: r.data[0].label, provider: r.data[0].provider } : null };
    `);

    // 界面 DOM 现状
    out.dom = await run(`
      return {
        hasGrid: !!document.querySelector('#grid'),
        gridChildren: document.querySelector('#grid') ? document.querySelector('#grid').children.length : null,
        gridHtmlHead: document.querySelector('#grid') ? document.querySelector('#grid').innerHTML.slice(0, 160) : null,
        cardCount: document.querySelectorAll('.card').length,
        emptyState: !!document.querySelector('.empty-state'),
        bodyTextHead: document.body.textContent.trim().slice(0, 120)
      };
    `);

    // 渲染层是否报错
    out.jsErrors = await run(`
      return window.__domErrors || null;
    `).catch(() => null);

    // 关键：界面的 state 里是否有记录（app.js 的 state 不在 window 上，用间接方式判断）
    out.afterCreate = await run(`
      const r = await window.vault.create({
        provider: 'custom', label: '诊断用', credential: 'SYNTH-DIAG-0001',
        note: '', tags: [], baseUrl: 'http://127.0.0.1:9/v1', models: 'diag-model'
      });
      const after = await window.vault.list();
      return { created: r.ok, countNow: after.data.length };
    `);

    // 触发一次界面刷新：点击「全部」
    out.navClick = await run(`
      const nav = document.querySelector('[data-nav="all"]');
      if (!nav) return { noNav: true, navCount: document.querySelectorAll('[data-nav]').length };
      nav.click();
      return { clicked: true };
    `);
    await new Promise((r) => setTimeout(r, 800));

    out.afterNav = await run(`
      return {
        cardCount: document.querySelectorAll('.card').length,
        testBtnCount: document.querySelectorAll('[data-act="test"]').length,
        gridChildren: document.querySelector('#grid') ? document.querySelector('#grid').children.length : null,
        gridHead: document.querySelector('#grid') ? document.querySelector('#grid').innerHTML.slice(0, 200) : null
      };
    `);
  } catch (err) {
    out.error = err.message;
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
