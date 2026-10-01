#!/usr/bin/env node
/**
 * 窄屏布局回归测试（.cjs —— mobile/ 是 ESM，此处必须用 CommonJS）。
 *
 * 覆盖用户上报的两个问题：
 *   1. 操作按钮不再换行（主按钮 + ⋯ 菜单）
 *   2. 筛选条单行、可横向滑动
 * 另验证 ⋯ 菜单可开合、隐藏项仍可达，以及桌面端未被影响。
 *
 * 重要（上一版两次超时的教训）：
 *   本脚本必须有**内部超时兜底**。否则一旦某步 await 挂住，外部只能强杀进程树，
 *   而强杀会牵连同一工作区里正在跑的 Gradle/Java，表现为「Java 报错」。
 *   因此：全程用 withTimeout 包裹，且任何失败路径都要 app.exit。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

/** 全局硬超时：无论卡在哪，到点就退出，绝不赖着不走 */
const HARD_TIMEOUT_MS = 90 * 1000;
const hardTimer = setTimeout(() => {
  console.error('\n[硬超时] 测试未在时限内完成，强制退出（避免拖住外部进程）');
  try { app.exit(2); } catch (_) { process.exit(2); }
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

/** 给任意 promise 加超时，避免单步挂死 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      const t = setTimeout(() => rej(new Error(`步骤超时(${ms}ms): ${label}`)), ms);
      t.unref?.();
    })
  ]);
}

const TMP = path.join(os.tmpdir(), 'okey-layout-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

require(path.join(__dirname, '..', '..', 'src', 'main', 'index.js'));

const WWW = path.join(__dirname, '..', 'www');
const DESKTOP_INDEX = path.join(__dirname, '..', '..', 'src', 'renderer', 'index.html');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(70)}`); }

async function main() {
  const main = BrowserWindow.getAllWindows()[0];
  await withTimeout(new Promise((r) => setTimeout(r, 1200)), 3000, '等待主窗口');

  // 造与用户截图相近的数据：英文环境、长服务商名、多标签
  await withTimeout(main.webContents.executeJavaScript(`(async () => {
    await window.vault.create({ provider: 'custom', label: 'Claude', credential: 'SYNTH-LAY-0001',
      note: '爱来自https://api.lyouth.de/', tags: ['生产','备用'], baseUrl: 'https://api.lyouth.de', models: 'claude-sonnet-5' });
    await window.vault.create({ provider: 'deepseek', label: 'deepseek', credential: 'SYNTH-LAY-0002',
      note: '', tags: ['生产'], baseUrl: 'https://api.deepseek.com', models: 'deepseek-flash' });
    await window.vault.create({ provider: 'custom', label: 'Gpt', credential: 'SYNTH-LAY-0003',
      note: '', tags: ['生产'], baseUrl: 'https://api.lyouth.de', models: 'gpt-5.6-sol' });
    await window.vault.saveSettings({ language: 'en' });
    return true;
  })()`), 8000, '写入测试数据');

  const mwin = new BrowserWindow({
    width: 407, height: 900, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'src', 'preload', 'index.js'),
      contextIsolation: true
    }
  });
  await withTimeout(mwin.loadFile(path.join(WWW, 'index.html')), 15000, '加载移动端产物');
  await withTimeout(new Promise((r) => setTimeout(r, 1500)), 3000, '等待移动端渲染');

  const wc = mwin.webContents;
  const run = (c) => withTimeout(wc.executeJavaScript(`(async () => { ${c} })()`), 8000, '页面脚本执行');

  console.log('\n移动端窄屏布局回归（真实产物 + 394px 视口）');
  console.log('='.repeat(70));

  const vw = await run(`return { w: innerWidth, isMobile: document.documentElement.classList.contains('is-mobile') };`);
  console.log(`  视口宽度 ${vw.w}px，is-mobile=${vw.isMobile}`);

  section('1. 工具栏：无关控件已隐藏');
  {
    const v = await run(`
      const pick = (sel) => { const el = document.querySelector(sel); if (!el) return { exists: false };
        const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
        return { exists: true, display: cs.display, visible: cs.display !== 'none' && r.width > 0 }; };
      return { sw: pick('.search-wrap'), ps: pick('#providerSelect'), ds: pick('#densitySeg'), ss: pick('#sortSelect') };
    `);
    check('搜索框已隐藏', !v.sw.visible);
    check('服务商下拉已隐藏', !v.ps.visible);
    check('密度切换已隐藏', !v.ds.visible);
    check('排序下拉保留', v.ss.visible);
  }

  section('2. 操作按钮：不换行');
  {
    const a = await run(`
      const card = document.querySelector('.card');
      if (!card) return { error: 'no card' };
      const acts = card.querySelector('.actions');
      const btns = [...acts.querySelectorAll('.btn')].filter(b => {
        const cs = getComputedStyle(b);
        return cs.display !== 'none' && !b.closest('[data-menu]');
      });
      const rects = btns.map(b => { const r = b.getBoundingClientRect();
        return { t: b.textContent.trim(), l: Math.round(r.left), r: Math.round(r.right), top: Math.round(r.top), w: Math.round(r.width) }; });
      const rows = [...new Set(rects.map(x => x.top))];
      const bodyW = document.documentElement.clientWidth;
      return {
        visibleBtnCount: btns.length,
        labels: rects.map(x => x.t),
        rowCount: rows.length,
        overflowRight: rects.filter(x => x.r > bodyW).map(x => x.t),
        menuHidden: card.querySelector('[data-menu]').hidden
      };
    `);
    check('卡片已渲染', !a.error, a.error || '');
    check('主按钮收敛为 4 个（测试/显示/复制/⋯）', a.visibleBtnCount === 4, `实际 ${a.visibleBtnCount}: ${a.labels.join(',')}`);
    check('所有主按钮在同一行', a.rowCount === 1, `实际 ${a.rowCount} 行`);
    check('无按钮溢出屏幕右边界', a.overflowRight.length === 0, a.overflowRight.join(','));
    check('⋯ 菜单默认收起', a.menuHidden === true);
  }

  section('3. ⋯ 菜单：可开合，隐藏项仍可达');
  {
    const m = await run(`
      const card = document.querySelector('.card');
      const btn = card.querySelector('[data-act="more"]');
      const menu = card.querySelector('[data-menu]');
      btn.click();
      await new Promise(r => setTimeout(r, 120));
      const openedHidden = menu.hidden;
      const menuBtns = [...menu.querySelectorAll('.btn')].map(b => b.textContent.trim());
      const menuRect = menu.getBoundingClientRect();
      const bodyW = document.documentElement.clientWidth;
      btn.click();
      await new Promise(r => setTimeout(r, 120));
      const closedHidden = menu.hidden;
      return {
        openedHidden, closedHidden, menuBtns,
        menuRight: Math.round(menuRect.right), bodyW,
        hasEdit: menuBtns.some(t => /Edit|编辑/.test(t)),
        hasFav: menuBtns.some(t => /★|☆|favorite|收藏/.test(t)),
        hasDel: menuBtns.some(t => /Delete|删除/.test(t))
      };
    `);
    check('点击 ⋯ 后菜单展开', m.openedHidden === false);
    check('菜单含编辑', m.hasEdit, m.menuBtns.join(' | '));
    check('菜单含收藏', m.hasFav, m.menuBtns.join(' | '));
    check('菜单含删除', m.hasDel, m.menuBtns.join(' | '));
    check('菜单未溢出屏幕右边界', m.menuRight <= m.bodyW + 1, `right=${m.menuRight} bodyW=${m.bodyW}`);
    check('再点 ⋯ 可收起', m.closedHidden === true);
  }

  section('4. 筛选条：单行 + 可横向滑动');
  {
    const f = await run(`
      const nav = document.querySelector('#sideNav');
      const items = [...nav.querySelectorAll('.side-item')];
      const rects = items.map(i => { const r = i.getBoundingClientRect();
        return { t: i.textContent.trim().replace(/\\s+/g,' '), top: Math.round(r.top), w: Math.round(r.width) }; });
      const rows = [...new Set(rects.map(x => x.top))];
      const navR = nav.getBoundingClientRect();
      const cs = getComputedStyle(nav);
      return {
        itemCount: items.length, rowCount: rows.length,
        labels: rects.map(x => x.t),
        navW: Math.round(navR.width),
        scrollW: nav.scrollWidth, clientW: nav.clientWidth,
        canScroll: nav.scrollWidth > nav.clientWidth + 1,
        overflowX: cs.overflowX, flexWrap: cs.flexWrap
      };
    `);
    check('筛选条只有一行', f.rowCount === 1, `实际 ${f.rowCount} 行: ${JSON.stringify(f.labels)}`);
    check('未使用换行布局', f.flexWrap === 'nowrap', f.flexWrap);
    check('启用了横向滚动', f.overflowX === 'auto' || f.overflowX === 'scroll', f.overflowX);
    check('长服务商名已使用短名',
      f.labels.some((t) => /Other|自建/.test(t)) && !f.labels.some((t) => /Self-hosted/.test(t)),
      f.labels.join(' | '));
    console.log(`      项数 ${f.itemCount}，可视宽 ${f.navW}px，内容宽 ${f.scrollW}px，可滑动=${f.canScroll}`);
  }

  section('5. 桌面端未被影响（按钮仍平铺）');
  {
    // 桌面端验证：直接用主窗口（1180px），它本就加载桌面 index.html
    const dwin = new BrowserWindow({
      width: 1180, height: 800, show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'src', 'preload', 'index.js'),
        contextIsolation: true
      }
    });
    await withTimeout(dwin.loadFile(DESKTOP_INDEX), 15000, '加载桌面端页面');
    await withTimeout(new Promise((r) => setTimeout(r, 1300)), 3000, '等待桌面端渲染');
    const d = await withTimeout(dwin.webContents.executeJavaScript(`(async () => {
      const card = document.querySelector('.card');
      if (!card) return { error: 'no card' };
      const moreBtn = card.querySelector('[data-act="more"]');
      const btns = [...card.querySelectorAll('.actions .btn')].filter(b => {
        const cs = getComputedStyle(b); return cs.display !== 'none';
      });
      return {
        moreBtnVisible: moreBtn ? getComputedStyle(moreBtn).display !== 'none' : null,
        visibleCount: btns.length,
        labels: btns.map(b => b.textContent.trim())
      };
    })()`), 8000, '桌面端断言');
    check('桌面端已渲染', !d.error, d.error || '');
    check('桌面端不显示 ⋯ 按钮', d.moreBtnVisible === false, String(d.moreBtnVisible));
    check('桌面端次要操作平铺（6 个按钮）', d.visibleCount === 6, `实际 ${d.visibleCount}: ${(d.labels || []).join(',')}`);
    dwin.destroy();
  }

  // 存复现后的截图
  try {
    await run(`document.querySelectorAll('[data-menu]').forEach(m => m.hidden = true); return true;`);
    const img = await withTimeout(wc.capturePage(), 8000, '截图');
    const shot = path.join(__dirname, '..', '..', 'docs', 'images', 'ui-mobile-fixed.png');
    fs.writeFileSync(shot, img.toPNG());
    console.log(`\n  截图: ${shot}`);
  } catch (e) {
    console.log('\n  截图失败（不影响结论）: ' + e.message);
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    fail++;
    failures.push('执行异常: ' + e.message);
    console.log('\n  ✗ 执行异常: ' + e.message);
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
    console.log('\n' + '='.repeat(70));
    console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
    if (fail) { console.log('\n失败项:'); failures.forEach((f) => console.log('  - ' + f)); }
    clearTimeout(hardTimer);
    app.exit(fail ? 1 : 0);
  }
});
