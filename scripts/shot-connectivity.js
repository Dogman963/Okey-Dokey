#!/usr/bin/env node
/**
 * 截一张带测试按钮与测试结果的界面图，用于人工确认视觉呈现。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = path.join(os.tmpdir(), 'okey-shot-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

const OUT = path.join(__dirname, '..', 'docs', 'images', 'ui-connectivity-test.png');

require('../src/main/index.js');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  win.setSize(1180, 820);
  await new Promise((r) => setTimeout(r, 1500));
  const wc = win.webContents;
  const run = (c) => wc.executeJavaScript(`(async () => { ${c} })()`);

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

  try {
    // 三条记录：成功 / 失败 / 未填地址，便于一张图看到三种状态
    await run(`
      await window.vault.create({ provider: 'custom', label: '可用端点', credential: ['sk','shot','aaaaaaaa','synthetic'].join('-'),
        note: '本地桩服务', tags: ['生产'], baseUrl: 'http://127.0.0.1:${port}/v1', models: 'ui-model' });
      await window.vault.create({ provider: 'deepseek', label: '写错地址', credential: ['sk','shot','bbbbbbbb','synthetic'].join('-'),
        note: '故意指向错误路径', tags: ['测试'], baseUrl: 'http://127.0.0.1:${port}/wrong', models: 'deepseek-chat' });
      await window.vault.create({ provider: 'custom', label: '公网明文', credential: ['sk','shot','cccccccc','synthetic'].join('-'),
        note: '会被明文策略拦下', tags: [], baseUrl: 'http://api.example.com/v1', models: 'some-model' });
      return true;
    `);
    await wc.reload();
    await new Promise((r) => setTimeout(r, 1500));

    // 依次点三条记录的「测试」
    for (let i = 0; i < 3; i++) {
      await run(`
        const btns = document.querySelectorAll('[data-act="test"]');
        if (btns[${i}]) btns[${i}].click();
        return true;
      `);
      await new Promise((r) => setTimeout(r, 1800));
    }
    await new Promise((r) => setTimeout(r, 500));

    const img = await wc.capturePage();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, img.toPNG());
    console.log('saved: ' + OUT);
  } catch (e) {
    console.error('err: ' + e.message);
  } finally {
    server.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  app.exit(0);
});
