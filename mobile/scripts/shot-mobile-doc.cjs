#!/usr/bin/env node
/**
 * 抓移动端文档截图（最终版）。
 *
 * 关键点（都是实测踩出来的）：
 *   1. preload 运行在 sandbox 下，只能用 electron 模块，不能用 fs/path。
 *   2. 用桌面页面 + 专用 preload（返回移动端 info/status），这样既有真实卡片
 *      数据、又呈现移动端身份。
 *   3. IS_MOBILE 在 app.js 加载时求值 —— is-mobile 类必须在那之前就存在。
 *      因此这里生成一个临时 HTML：在 app.js 之前插入 mobile.css 与打类的脚本，
 *      模拟真实移动端的加载顺序（boot.js 先打类，app.js 后求值）。
 *      事后补加类是不行的（这也是前几次失败的原因）。
 *   4. 窗口必须可见，否则合成器不产新帧、capturePage 给旧帧。
 *      截图后回读 DOM 校验，不一致就拒绝保存。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-shotdoc-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'));

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
const SHOT_PRELOAD = path.join(__dirname, 'shot-preload.cjs');
const MOBILE_CSS = path.join(__dirname, '..', 'src', 'mobile.css');
const IMG = path.join(__dirname, '..', '..', 'docs', 'images');

const hardTimer = setTimeout(() => {
  console.error('[硬超时] 强制退出');
  try { app.exit(2); } catch (_) { process.exit(2); }
}, 150 * 1000);
hardTimer.unref?.();

/** 生成「移动端等价」的 index.html：并入 mobile.css，并在 app.js 之前打 is-mobile 类 */
function buildMobileIndex() {
  let html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');

  // 1. 把 mobile.css 接在 styles.css 之后（与真实移动端构建一致）
  html = html.replace(
    '<link rel="stylesheet" href="styles.css" />',
    '<link rel="stylesheet" href="styles.css" />\n  <link rel="stylesheet" href="mobile.css" />'
  );

  // 2. 在 app.js 之前插入「打 is-mobile 类」的脚本，
  //    模拟 boot.js 在同步段先打类、app.js 随后求值 IS_MOBILE 的顺序。
  //
  //    注意：不能用内联 <script>，页面 CSP 是 script-src 'self'，内联会被拦掉
  //    （实测过：脚本没执行，类名始终不生效）。所以写成一个外部文件。
  const marker = '<script src="app.js"></script>';
  if (!html.includes(marker)) throw new Error('未找到 app.js 的 script 标签');
  html = html.replace(marker,
    '<script src="mobile-boot.js"></script>\n  ' + marker);

  // 3. 落到临时目录（与 renderer 同级的资源引用保持相对可用）
  const dir = path.join(TMP, 'renderer');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(RENDERER)) {
    const src = path.join(RENDERER, f);
    if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, f));
  }
  fs.writeFileSync(path.join(dir, 'mobile.css'), fs.readFileSync(MOBILE_CSS, 'utf8'));
  // 外部启动脚本：必须在 app.js 之前执行，且在 CSP 'self' 下可加载
  fs.writeFileSync(path.join(dir, 'mobile-boot.js'),
    'document.documentElement.classList.add("is-mobile");\n');
  // 共享目录（providers.js 位于 ../shared）
  const shared = path.join(TMP, 'shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.copyFileSync(
    path.join(RENDERER, '..', 'shared', 'providers.js'),
    path.join(shared, 'providers.js')
  );
  const out = path.join(dir, 'index.mobile.html');
  fs.writeFileSync(out, html, 'utf8');
  return out;
}

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1200));

  await main.webContents.executeJavaScript(`(async () => {
    await window.vault.create({ provider: 'custom', label: 'Claude', credential: 'SYNTH-SD-0001',
      note: '爱来自 https://api.lyouth.de/', tags: ['生产','备用'], baseUrl: 'https://api.lyouth.de', models: 'claude-sonnet-5' });
    await window.vault.create({ provider: 'deepseek', label: 'deepseek', credential: 'SYNTH-SD-0002',
      note: '', tags: ['生产'], baseUrl: 'https://api.deepseek.com', models: 'deepseek-flash' });
    await window.vault.saveSettings({ language: 'zh' });
    return true;
  })()`).catch(() => {});

  let mobileIndex;
  try {
    mobileIndex = buildMobileIndex();
    console.log('  已生成移动端等价页面:', path.basename(mobileIndex));
  } catch (e) {
    console.error('  生成页面失败: ' + e.message);
    clearTimeout(hardTimer);
    app.exit(1);
    return;
  }

  const mwin = new BrowserWindow({
    width: 407, height: 900, show: true,
    webPreferences: { preload: SHOT_PRELOAD, contextIsolation: true, nodeIntegration: false }
  });

  await mwin.loadFile(mobileIndex);
  await new Promise((r) => setTimeout(r, 1600));

  const wc = mwin.webContents;
  const run = (c) => wc.executeJavaScript(`(async () => { ${c} })()`);

  async function settle(ms = 500) {
    await run(`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;`).catch(() => {});
    await new Promise((r) => setTimeout(r, ms));
    await run(`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true;`).catch(() => {});
  }

  async function shot(file, mustMatch) {
    await settle();
    const buf = (await wc.capturePage()).toPNG();
    if (buf.length < 3000) throw new Error(`截图过小(${buf.length}B)，疑似空白帧`);
    const dom = await run(`return document.body.innerText.replace(/\\s+/g,' ').slice(0, 400);`);
    if (!mustMatch.test(dom)) {
      throw new Error(`DOM 与预期不符，拒绝保存。期望 /${mustMatch.source}/，实际: ${dom.slice(0, 150)}`);
    }
    fs.writeFileSync(path.join(IMG, file), buf);
    console.log(`  已保存 ${file} (${Math.round(buf.length / 1024)} KB)`);
    return dom;
  }

  try {
    const chk = await run(`
      const i = await window.vault.info();
      const l = await window.vault.list();
      return {
        electron: i.data.electron,
        listCount: l.data.length,
        labels: l.data.map(r => r.label),
        isMobile: document.documentElement.classList.contains('is-mobile'),
        searchHidden: getComputedStyle(document.querySelector('.search-wrap')).display === 'none',
        moreBtnVisible: (() => { const b = document.querySelector('.more-btn'); return b ? getComputedStyle(b).display !== 'none' : null; })()
      };
    `);
    console.log('  前置检查:', JSON.stringify(chk));
    if (chk.electron !== '') throw new Error('preload 未生效（electron 应为空）');
    if (chk.listCount === 0) throw new Error('未取到卡片数据');
    if (!chk.isMobile) throw new Error('is-mobile 类未生效');
    if (!chk.searchHidden) throw new Error('mobile.css 未生效（搜索框应隐藏）');
    if (!chk.moreBtnVisible) throw new Error('移动端 ⋯ 按钮应可见');

    const listDom = await shot('ui-mobile-fixed.png', /Claude/);
    console.log('  列表片段:', listDom.slice(0, 100));

    const st = await run(`
      document.querySelector('#settingsBtn').click();
      await new Promise(r => setTimeout(r, 400));
      const b = [...document.querySelectorAll('[data-tab]')].find(x => x.dataset.tab === 'about');
      if (!b) return { error: 'no tab' };
      b.click();
      await new Promise(r => setTimeout(r, 400));
      return { active: [...document.querySelectorAll('[data-tab]')].filter(x => x.classList.contains('on')).map(x => x.dataset.tab) };
    `);
    if (!st.active || st.active[0] !== 'about') throw new Error('未切到关于页: ' + JSON.stringify(st));
    const aboutDom = await shot('ui-mobile-about.png', /版本/);
    console.log('  关于片段:', aboutDom.slice(0, 130));
  } catch (e) {
    console.error('  失败: ' + e.message);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    clearTimeout(hardTimer);
    app.exit(1);
    return;
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  clearTimeout(hardTimer);
  app.exit(0);
});
