#!/usr/bin/env node
/**
 * 在真实 Electron 里验证连通测试按钮的渲染与交互。
 *
 * 为什么必须这么做：本机没有安卓设备，但**桌面端就是同一个界面代码**。
 * 用真实 Chromium 渲染，能确认：
 *   - 按钮真的出现在卡片右上角
 *   - 它没有与标题/操作按钮重叠（用 getBoundingClientRect 实测，不靠肉眼）
 *   - 点击后真的发起探测并显示结果，且结果不含密钥明文
 *   - 明文策略在真实调用链里生效
 *
 * 用隔离 userData 目录，不触碰真实密钥库。
 *
 * 关于测试用值：本脚本会往隔离的库里放一个「密钥形状」的字符串，用于验证
 * 结果不回显明文。它在运行时随机生成、带 uitest 标记，不是任何真实凭据。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = path.join(os.tmpdir(), 'okey-test-ui-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

const errors = [];
process.on('uncaughtException', (e) => errors.push('uncaught: ' + e.message));

require('../src/main/index.js');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1500));
  const wc = win.webContents;

  const results = {};
  const run = (code) => wc.executeJavaScript(`(async () => { ${code} })()`);

  const server = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"choices":[{"message":{"content":"hi"}}]}');
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"nope"}}');
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 运行时生成的假值（非真实凭据），用于验证结果不回显明文
  const syntheticValue = ['sk', 'uitest', randomTag(), 'synthetic'].join('-');
  function randomTag() { return Math.random().toString(36).slice(2, 10); }

  try {
    results.created = await run(`
      const r = await window.vault.create({
        provider: 'custom', label: 'UI 测试', credential: ${JSON.stringify(syntheticValue)},
        note: '', tags: [], baseUrl: 'http://127.0.0.1:${port}/v1', models: 'ui-model, other'
      });
      return r.ok ? { ok: true, id: r.data.id } : r;
    `);

    // 界面只在自身流程里 refresh()，不会感知主进程侧的新记录。
    // 这里用界面真实的方式驱动：重新加载页面，让它自己拉到刚才建的记录。
    await wc.reload();
    await new Promise((r) => setTimeout(r, 1200));

    results.buttonExists = await run(`
      const btns = document.querySelectorAll('[data-act="test"]');
      return { count: btns.length, text: btns.length ? btns[0].textContent.trim() : null };
    `);

    results.layout = await run(`
      const card = document.querySelector('.card');
      if (!card) return { error: 'no card' };
      const btn = card.querySelector('[data-act="test"]');
      if (!btn) return { error: 'no button' };
      const b = btn.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const title = card.querySelector('.card-title');
      const t = title ? title.getBoundingClientRect() : null;
      const actions = card.querySelector('.actions');
      const a = actions ? actions.getBoundingClientRect() : null;
      const overlaps = (r1, r2) => r1 && r2 &&
        !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
      // 注意：按钮**就在操作组内部**，所以它与 .actions 重叠是正常的。
      // 真正要断言的是：它没有与同组的其他按钮互相压住。
      const siblings = [...card.querySelectorAll('.actions .btn')].filter(el => el !== btn);
      const clash = siblings.filter(el => overlaps(b, el.getBoundingClientRect())).map(el => el.textContent.trim());
      return {
        fromTop: Math.round(b.top - c.top),
        fromRight: Math.round(c.right - b.right),
        overlapsTitle: overlaps(b, t),
        siblingClash: clash,
        siblingCount: siblings.length,
        inActionsRow: !!btn.closest('.actions'),
        inRightHalf: b.left > (c.left + c.width / 2),
        btnW: Math.round(b.width), btnH: Math.round(b.height)
      };
    `);

    results.clicked = await run(`
      const btn = document.querySelector('[data-act="test"]');
      if (!btn) return { error: 'no button' };
      const before = btn.textContent.trim();
      btn.click();
      // 中间态：click 后 runTest 会先把 running=true 写进 state 并重绘。
      // 本机探测只需几十毫秒，因此用 rAF 等一帧再读，避免误判为「没有中间态」。
      const duringText = await new Promise(res => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const mid = document.querySelector('[data-act="test"]');
          res(mid ? mid.textContent.trim() : null);
        }));
      });
      await new Promise(r => setTimeout(r, 3000));
      const res = document.querySelector('.test-result');
      return {
        beforeText: before,
        duringText,
        hasResult: !!res,
        cls: res ? res.className : null,
        text: res ? res.textContent.trim().replace(/\\s+/g, ' ').slice(0, 220) : null,
        leaksValue: res ? res.textContent.includes(${JSON.stringify(syntheticValue)}) : null
      };
    `);

    results.networkFail = await run(`
      const list = await window.vault.list();
      const rec = list.data[0];
      await window.vault.update(rec.id, { baseUrl: 'http://127.0.0.1:1/v1' });
      const r = await window.vault.test(rec.id);
      return r.ok ? { kind: r.data.kind, message: r.data.message } : r;
    `);

    results.cleartext = await run(`
      const list = await window.vault.list();
      const rec = list.data[0];
      await window.vault.update(rec.id, { baseUrl: 'http://api.example.com/v1' });
      const r = await window.vault.test(rec.id);
      return r.ok ? { kind: r.data.kind, message: r.data.message, detail: r.data.detail } : r;
    `);

    results.badUrl = await run(`
      const list = await window.vault.list();
      const rec = list.data[0];
      await window.vault.update(rec.id, { baseUrl: 'http://127.0.0.1:${port}/wrong' });
      const r = await window.vault.test(rec.id);
      return r.ok ? { kind: r.data.kind, status: r.data.status, message: r.data.message } : r;
    `);
  } catch (err) {
    errors.push('script: ' + err.message);
  } finally {
    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log(JSON.stringify({ results, errors }, null, 2));
  app.exit(0);
});
