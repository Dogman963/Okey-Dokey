#!/usr/bin/env node
/**
 * 检查不同窗口宽度下，操作按钮行（含新增的「测试」）是否溢出或换行错乱。
 * 尤其关注窄屏 —— 现在操作组有 6 个按钮，比之前多一个。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-width-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require('../src/main/index.js');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1500));
  const wc = win.webContents;
  const run = (c) => wc.executeJavaScript(`(async () => { ${c} })()`);

  const out = [];
  try {
    await run(`
      await window.vault.create({
        provider: 'custom', label: '一个比较长的标题用来挤压布局', credential: 'SYNTH-W-0001',
        note: '备注', tags: ['生产','备用'], baseUrl: 'http://127.0.0.1:9/v1', models: 'some-quite-long-model-name-here'
      });
      return true;
    `);

    // 依次测试几种宽度
    const widths = [1180, 1000, 900, 820, 700, 560, 420, 360];
    for (const w of widths) {
      win.setSize(w, 800);
      await wc.reload();
      await new Promise((r) => setTimeout(r, 900));
      const r = await run(`
        const card = document.querySelector('.card');
        if (!card) return { error: 'no card' };
        const actions = card.querySelector('.actions');
        const btns = [...card.querySelectorAll('.actions .btn')];
        if (!btns.length) return { error: 'no buttons' };
        const ar = actions.getBoundingClientRect();
        const cardR = card.getBoundingClientRect();
        const rects = btns.map(b => { const x = b.getBoundingClientRect(); return { t: b.textContent.trim(), l: Math.round(x.left), r: Math.round(x.right), top: Math.round(x.top), bottom: Math.round(x.bottom) }; });
        // 行数：按 top 去重
        const rows = [...new Set(rects.map(x => x.top))].length;
        // 是否有按钮超出卡片右边界（溢出）
        const overflow = rects.filter(x => x.r > Math.round(cardR.right) + 1).map(x => x.t);
        // 是否有两按钮互相压住
        const clash = [];
        for (let i=0;i<rects.length;i++) for (let j=i+1;j<rects.length;j++) {
          const a=rects[i], b=rects[j];
          if (!(a.r<=b.l || a.l>=b.r || a.bottom<=b.top || a.top>=b.bottom)) clash.push(a.t+'/'+b.t);
        }
        const testBtn = btns.find(b => b.dataset.act === 'test');
        return {
          winW: window.innerWidth,
          btnCount: btns.length,
          rows,
          overflow,
          clash,
          testBtnText: testBtn ? testBtn.textContent.trim() : null,
          actionsW: Math.round(ar.width),
          cardInnerW: Math.round(cardR.width)
        };
      `);
      out.push(r);
    }
  } catch (e) { out.push({ error: e.message }); }
  finally { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} }

  console.log(JSON.stringify(out, null, 2));
  app.exit(0);
});
