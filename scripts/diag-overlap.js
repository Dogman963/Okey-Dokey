#!/usr/bin/env node
/**
 * 精确诊断按钮与操作区的重叠情况，为修复提供准确坐标。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-overlap-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require('../src/main/index.js');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1500));
  const wc = win.webContents;
  const run = (c) => wc.executeJavaScript(`(async () => { ${c} })()`);

  const out = {};
  try {
    await run(`
      await window.vault.create({
        provider: 'custom', label: '重叠诊断', credential: 'SYNTH-OVL-0001',
        note: '这是一段备注', tags: ['生产'], baseUrl: 'http://127.0.0.1:9/v1', models: 'diag-model'
      });
      return true;
    `);
    await wc.reload();
    await new Promise((r) => setTimeout(r, 1200));

    out.geometry = await run(`
      const card = document.querySelector('.card');
      const btn = card.querySelector('[data-act="test"]');
      const actions = card.querySelector('.actions');
      const head = card.querySelector('.card-head');
      const title = card.querySelector('.card-title');
      const keyline = card.querySelector('.keyline');
      const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
        return { t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), l: Math.round(b.left), w: Math.round(b.width), h: Math.round(b.height) }; };
      return {
        card: r(card), btn: r(btn), actions: r(actions), head: r(head), title: r(title), keyline: r(keyline),
        cardPadTop: getComputedStyle(card).paddingTop,
        cardPadRight: getComputedStyle(card).paddingRight,
        winW: window.innerWidth
      };
    `);

    // 计算重叠面积
    out.overlapDetail = await run(`
      const card = document.querySelector('.card');
      const btn = card.querySelector('[data-act="test"]').getBoundingClientRect();
      const act = card.querySelector('.actions').getBoundingClientRect();
      const ox = Math.max(0, Math.min(btn.right, act.right) - Math.max(btn.left, act.left));
      const oy = Math.max(0, Math.min(btn.bottom, act.bottom) - Math.max(btn.top, act.top));
      return { overlapW: Math.round(ox), overlapH: Math.round(oy), overlapArea: Math.round(ox*oy),
               btnBottom: Math.round(btn.bottom), actTop: Math.round(act.top) };
    `);
  } catch (e) { out.error = e.message; }
  finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }

  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
