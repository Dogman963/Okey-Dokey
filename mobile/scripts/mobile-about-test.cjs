#!/usr/bin/env node
/**
 * 用「移动端真实返回值」验证 设置 → 关于 / 安全 页的呈现。
 *
 * 为什么需要单独做：上一轮诊断在桌面端加载 www/，window.vault 来自 preload，
 * 于是 info() 返回真实 Electron 版本，测不出移动端行为。
 * 这里在页面加载前**覆盖 window.vault 的 info/status**，
 * 返回与安卓平台层一致的值（electron 为空串、dataDir 是 file:// URI），
 * 再断言界面不得出现桌面端专属内容。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-about-verify-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'));

const WWW = path.join(__dirname, '..', 'www');

const HARD_TIMEOUT_MS = 90 * 1000;
const hardTimer = setTimeout(() => {
  console.error('\n[硬超时] 强制退出');
  try { app.exit(2); } catch (_) { process.exit(2); }
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(70)}`); }

app.whenReady().then(async () => {
  const main = BrowserWindow.getAllWindows()[0];
  await new Promise((r) => setTimeout(r, 1200));
  await main.webContents.executeJavaScript(`(async () => {
    await window.vault.create({ provider: 'deepseek', label: 'deepseek', credential: 'SYNTH-AB-0001',
      note: '', tags: ['生产'], baseUrl: 'https://api.deepseek.com', models: 'deepseek-chat' });
    await window.vault.saveSettings({ language: 'en' });
    return true;
  })()`).catch(() => {});

  const mwin = new BrowserWindow({
    width: 407, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'preload', 'index.js'),
      contextIsolation: false,
      nodeIntegration: false
    }
  });

  // 在页面脚本执行前注入「移动端平台层」的假实现。
  // 必须在 did-start-loading 时插入，保证 app.js 读到的就是移动端数据。
  mwin.webContents.on('did-start-loading', () => {
    mwin.webContents.executeJavaScript(`
      // 模拟安卓平台层的返回值（与 vault-api.mjs 一致）
      (function () {
        const realVault = window.vault || {};
        const mobileInfo = {
          version: '1.2.4',
          electron: '',                     // 移动端没有 Electron
          node: '',
          chrome: navigator.userAgent,
          platform: 'android',
          dataDir: 'file:///data/user/0/local.okeydokey.vault/files/okey-dokey/',
          packaged: true,
          exePath: ''
        };
        const mobileStatus = {
          total: 1,
          dataDir: 'file:///data/user/0/local.okeydokey.vault/files/okey-dokey/',
          keyPath: 'file:///data/user/0/local.okeydokey.vault/files/okey-dokey/device.key',
          vaultPath: 'file:///data/user/0/local.okeydokey.vault/files/okey-dokey/vault.enc',
          keyExists: true,
          platform: 'android'
        };
        window.vault = Object.assign({}, realVault, {
          info: async () => ({ ok: true, data: mobileInfo }),
          status: async () => ({ ok: true, data: mobileStatus })
        });
        // 让界面以为自己在移动端（真实环境由 boot.js 打上）
        document.documentElement.classList.add('is-mobile');
      })();
    `).catch(() => {});
  });

  await mwin.loadFile(path.join(WWW, 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));

  const wc = mwin.webContents;
  const run = (c) => wc.executeJavaScript(`(async () => { ${c} })()`);

  try {
    console.log('\n移动端 设置 → 关于 / 安全 页验证（注入移动端真实返回值）');
    console.log('='.repeat(70));

    // 确认注入生效：界面拿到的 info 应是移动端版本
    const got = await run(`
      const i = await window.vault.info();
      return { version: i.data.version, electron: i.data.electron, dataDir: i.data.dataDir, isMobile: document.documentElement.classList.contains('is-mobile') };
    `);
    section('0. 前置：注入是否生效');
    check('注入生效（interface 认为自己在移动端）', got.isMobile === true);
    check('info().electron 为空（移动端）', got.electron === '');
    check('info().dataDir 是 file:// 形式', String(got.dataDir).startsWith('file://'));

    // 打开设置，逐个标签页收集
    const tabs = await run(`
      const btn = document.querySelector('#settingsBtn');
      btn.click();
      await new Promise(r => setTimeout(r, 300));
      const res = {};
      for (const t of [...document.querySelectorAll('[data-tab]')]) {
        t.click();
        await new Promise(r => setTimeout(r, 200));
        const body = document.querySelector('#setBody');
        res[t.dataset.tab] = body ? body.innerText.replace(/\\n{2,}/g, '\\n').trim() : '';
      }
      return res;
    `);

    section('1. 关于页：不应出现桌面端专属内容');
    {
      const a = tabs.about || '';
      check('不出现孤立的 "Electron" 字样', !/Electron/.test(a), a.split('\n').slice(0, 8).join(' / '));
      check('不出现 "Executable" 行', !/Executable|程序位置/.test(a));
      check('不出现便携版说明', !/portable|便携/i.test(a));
      check('不出现「创建桌面快捷方式」', !/shortcut|快捷方式/i.test(a));
      check('不出现 Ctrl/Cmd 快捷键提示', !/Ctrl\+|Cmd\+/.test(a));
      check('不暴露 file:// URI', !/file:\/\//.test(a));
      check('保留版本号', /1\.2\.4/.test(a));
      check('显示运行平台为「安卓 App」', /Android app|安卓 App/i.test(a), a);
      check('数据位置显示为友好说明', /private folder|私有目录/i.test(a));
    }

    section('2. 安全页：不应出现裸路径与无效按钮');
    {
      const sec = tabs.security || '';
      check('不暴露 file:// URI', !/file:\/\//.test(sec));
      check('不显示 Key file 原始路径行', !/Key file|密钥文件/i.test(sec));
      check('不显示 Vault file 原始路径行', !/Vault file|加密库文件/i.test(sec));
      check('不显示「在文件夹中显示」按钮', !/Show in folder|打开所在文件夹/i.test(sec));
      check('保留加密方式说明', /AES-256-GCM/.test(sec));
      check('数据位置改为友好说明', /private folder|私有目录/i.test(sec));
    }

    section('3. 数据页与外观页未受影响');
    {
      check('数据页仍可导出加密备份', /Export encrypted|导出加密备份/i.test(tabs.data || ''));
      check('数据页仍可导入备份', /Import backup|导入备份/i.test(tabs.data || ''));
      check('外观页仍可换主题', /Theme|主题/i.test(tabs.appearance || ''));
      check('外观页仍可选背景图', /Background image|背景图/i.test(tabs.appearance || ''));
    }

    // 存一张「修复后」的关于页截图
    await run(`
      const t = [...document.querySelectorAll('[data-tab]')].find(x => x.dataset.tab === 'about');
      if (t) t.click();
      return true;
    `);
    await new Promise((r) => setTimeout(r, 300));
    const img = await wc.capturePage();
    const shot = path.join(__dirname, '..', '..', 'docs', 'images', 'ui-mobile-about.png');
    fs.writeFileSync(shot, img.toPNG());
    console.log(`\n  截图: ${shot}`);
  } catch (e) {
    fail++;
    failures.push('执行异常: ' + e.message);
    console.log('  ✗ 执行异常: ' + e.message);
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('\n' + '='.repeat(70));
  console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
  if (fail) { console.log('\n失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
  clearTimeout(hardTimer);
  app.exit(fail ? 1 : 0);
});
