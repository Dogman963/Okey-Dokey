/**
 * 冒烟测试 / smoke test
 * 用独立 userData 目录启动真实应用，检验渲染层无报错，并跑通完整界面链路。
 * 运行：npx electron tools/smoke.js
 *
 * 关于测试值：本文件不含任何密钥字面量。测试用的假密钥在运行时生成
 * （或用环境变量 SMOKE_TEST_KEY 覆盖），随后注入渲染层使用。
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 运行时生成的测试占位值（非真实凭据）
const SMOKE_VALUE = (process.env.SMOKE_TEST_KEY && process.env.SMOKE_TEST_KEY.trim())
  || ['sk', 'smoke', Math.random().toString(36).slice(2, 10), Date.now().toString(36)].join('-');

// 隔离数据目录，避免污染真实密钥库
const TMP = path.join(os.tmpdir(), 'okey-dokey-smoke-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

const errors = [];
const warnings = [];

require('../src/main/index.js');

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.log('SMOKE_RESULT {"fatal":"window not created"}'); app.exit(1); return; }

  win.webContents.on('console-message', (e) => {
    const level = e && e.level;
    const msg = (e && e.message) || '';
    if (level === 'error' || level === 3) errors.push(msg);
    else if (level === 'warning' || level === 2) warnings.push(msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => errors.push('render-process-gone ' + JSON.stringify(d)));

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  const results = {};

  await wait(2500);

  // 把运行时测试值注入渲染层（文件内无字面量）
  await js('window.__SMOKE_VALUE = ' + JSON.stringify(SMOKE_VALUE) + '; true;');
  const V = 'window.__SMOKE_VALUE';

  // 1) 界面骨架
  results.dom = await js(`(() => ({
    title: document.title,
    grid: !!document.getElementById('grid'),
    searchPlaceholder: document.getElementById('search').placeholder,
    providerOptions: document.querySelectorAll('#providerSelect option').length,
    sortOptions: document.querySelectorAll('#sortSelect option').length,
    brandSub: document.querySelector('.brand-sub').textContent,
    emptyState: !!document.querySelector('.empty-state'),
    bgLayer: !!document.getElementById('bgLayer'),
    apiExposed: Object.keys(window.vault).sort().join(',')
  }))()`);

  // 2) 通过真实界面新增一条密钥
  results.uiFlow = await js(`(async () => {
    document.getElementById('addBtn').click();
    await new Promise(r => setTimeout(r, 450));
    const modal = document.querySelector('.overlay .modal');
    if (!modal) return { opened: false };
    const form = { '#f-label': 'ui-created', '#f-note': '来自界面的备注', '#f-tags': 'prod, test' };
    for (const sel of Object.keys(form)) modal.querySelector(sel).value = form[sel];
    modal.querySelector('#f-credential').value = ${V};
    modal.querySelector('[data-save]').click();
    await new Promise(r => setTimeout(r, 900));
    const cards = [...document.querySelectorAll('.card')];
    const first = cards.find(c => c.textContent.includes('ui-created')) || cards[0];
    return {
      opened: true,
      modalClosed: !document.querySelector('.overlay'),
      cards: cards.length,
      showsMask: first ? first.querySelector('.keyline .val').textContent : '',
      leakedInDom: document.body.innerHTML.includes(${V}),
      leakedInAttr: [...document.querySelectorAll('*')].some(el => [...el.attributes].some(a => String(a.value).includes(${V}))),
      noteVisible: first ? first.querySelector('.note-box').textContent.trim() : '',
      tagsVisible: first ? [...first.querySelectorAll('.tag')].map(t => t.textContent) : [],
      providerBadge: first ? first.querySelector('.badge').textContent.trim() : '',
      statText: document.getElementById('vaultStat').textContent.trim()
    };
  })()`);

  // 3) 再次新增：验证「编辑」弹窗留空不改密钥 + 备注可编辑
  results.editFlow = await js(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('ui-created'));
    card.querySelector('[data-act="edit"]').click();
    await new Promise(r => setTimeout(r, 450));
    const modal = document.querySelector('.overlay .modal');
    const secretFieldEmpty = modal.querySelector('#f-credential').value === '';
    const prefilledNote = modal.querySelector('#f-note').value;
    modal.querySelector('#f-note').value = '备注已修改';
    modal.querySelector('#f-fav').checked = true;
    modal.querySelector('[data-save]').click();
    await new Promise(r => setTimeout(r, 800));
    const after = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('ui-created'));
    return { secretFieldEmpty, prefilledNote, newNote: after.querySelector('.note-box').textContent.trim(), favShown: after.querySelector('.card-title').textContent.includes('★') };
  })()`);

  // 4) 文案完整性：字段标签应为词条内容，而非键名（防止 i18n 键名漂移）
  results.labels = await js(`(async () => {
    document.getElementById('addBtn').click();
    await new Promise(r => setTimeout(r, 450));
    const modal = document.querySelector('.overlay .modal');
    const labels = [...modal.querySelectorAll('.lbl')].map(e => e.textContent.trim());
    const placeholder = modal.querySelector('#f-credential').placeholder;
    const btn = modal.querySelector('[data-save]').textContent.trim();
    modal.querySelector('[data-x]').click();
    await new Promise(r => setTimeout(r, 300));
    const keyLike = labels.filter(l => /^[a-z][A-Za-z0-9]*$/.test(l));   // 裸 camelCase 标识符＝键名泄露
    return { labels, placeholder, btn, keyLike, allChinese: labels.every(l => /[\u4e00-\u9fa5]/.test(l)), hasApiKeyLabel: labels.some(l => l === 'API Key') };
  })()`);

  // 5) 卡片动作：显示 → 计时 → 再隐藏 → 复制
  results.cardActions = await js(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('ui-created'));
    card.querySelector('[data-act="reveal"]').click();
    await new Promise(r => setTimeout(r, 800));
    const t = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('ui-created'));
    const revealed = t.querySelector('.keyline .val').textContent;
    const revLabel = t.querySelector('[data-act="reveal"]').textContent.trim();
    const timer = t.querySelector('.reveal-timer').textContent.trim();
    t.querySelector('[data-act="reveal"]').click();
    await new Promise(r => setTimeout(r, 600));
    const h = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('ui-created'));
    const hiddenAgain = h.querySelector('.keyline .val').textContent;
    h.querySelector('[data-act="copy"]').click();
    await new Promise(r => setTimeout(r, 500));
    return {
      revealed, revLabel, timer, hiddenAgain,
      revealMatches: revealed === ${V},
      hiddenIsMask: hiddenAgain !== ${V},
      toast: (document.querySelector('.toast') || {}).textContent || ''
    };
  })()`);

  // 5) 服务商筛选 + 侧栏联动
  results.filter = await js(`(async () => {
    const sel = document.getElementById('providerSelect');
    sel.value = 'openai'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 450));
    const openaiCount = document.querySelectorAll('.card').length;
    const sidebarOn = [...document.querySelectorAll('.side-item')].filter(b => b.classList.contains('on')).map(b => b.textContent.trim());
    sel.value = 'anthropic'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 450));
    const otherCount = document.querySelectorAll('.card').length;
    const emptyShown = !!document.querySelector('.empty-state');
    const favItem = [...document.querySelectorAll('[data-nav="favorites"]')];
    return { openaiCount, otherCount, emptyShown, sidebarOn, hasFavoritesNav: favItem.length };
  })()`);

  // 6) 侧栏「收藏」筛选
  results.favFilter = await js(`(async () => {
    const fav = document.querySelector('[data-nav="favorites"]');
    if (!fav) return { skipped: true };
    fav.click();
    await new Promise(r => setTimeout(r, 450));
    const n = document.querySelectorAll('.card').length;
    document.querySelector('[data-nav="all"]').click();
    await new Promise(r => setTimeout(r, 450));
    return { favCount: n, restored: document.querySelectorAll('.card').length };
  })()`);

  // 7) 搜索：命中备注 / 标签 / 掩码尾号 / 无结果
  results.search = await js(`(async () => {
    const s = document.getElementById('search');
    const probe = async (v) => { s.value = v; s.dispatchEvent(new Event('input')); await new Promise(r => setTimeout(r, 320)); return document.querySelectorAll('.card').length; };
    const byNote = await probe('备注已修改');
    const byTag = await probe('prod');
    const byMask = await probe(document.querySelector('.card .keyline .val').textContent.slice(-4));
    const none = await probe('zzz-no-match-xyz');
    const emptyShown = !!document.querySelector('.empty-state');
    const all = await probe('');
    return { byNote, byTag, byMask, none, emptyShown, all };
  })()`);

  // 8) 排序 / 密度
  results.listControls = await js(`(async () => {
    const sort = document.getElementById('sortSelect');
    sort.value = 'label'; sort.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 400));
    const firstLabel = (document.querySelector('.card .nm') || {}).textContent || '';
    document.querySelector('[data-density="compact"]').click();
    await new Promise(r => setTimeout(r, 400));
    const compact = document.getElementById('grid').classList.contains('compact');
    document.querySelector('[data-density="comfortable"]').click();
    await new Promise(r => setTimeout(r, 400));
    return { firstLabel, compact, backToComfortable: !document.getElementById('grid').classList.contains('compact') };
  })()`);

  // 9) 中英双语
  results.i18n = await js(`(async () => {
    const snap = () => ({ ph: document.getElementById('search').placeholder, brand: document.querySelector('.brand-sub').textContent, add: document.querySelector('#addBtn').textContent.trim() });
    document.getElementById('langBtn').click();
    await new Promise(r => setTimeout(r, 700));
    const en = snap();
    document.getElementById('langBtn').click();
    await new Promise(r => setTimeout(r, 700));
    const zh = snap();
    return { en, zh, htmlLang: document.documentElement.lang };
  })()`);

  // 10) 主题预设 / 自定义取色 / 背景透明度与模糊
  results.theme = await js(`(async () => {
    document.getElementById('settingsBtn').click();
    await new Promise(r => setTimeout(r, 600));
    const swatches = document.querySelectorAll('[data-preset]').length;
    const tabs = [...document.querySelectorAll('[data-tab]')].map(b => b.dataset.tab);
    document.querySelector('[data-preset="midnight"]').click();
    await new Promise(r => setTimeout(r, 600));
    const cs = getComputedStyle(document.documentElement);
    const dark = { bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim() };
    const accentInput = document.getElementById('c-accent');
    accentInput.value = '#ff7a45'; accentInput.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 400));
    const customAccent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const radius = document.getElementById('c-radius');
    radius.value = 20; radius.dispatchEvent(new Event('input')); radius.dispatchEvent(new Event('change'));
    const op = document.getElementById('b-op');
    op.value = 65; op.dispatchEvent(new Event('input')); op.dispatchEvent(new Event('change'));
    const bl = document.getElementById('b-blur');
    bl.value = 8; bl.dispatchEvent(new Event('input')); bl.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 500));
    const cs2 = getComputedStyle(document.documentElement);
    const applied = { opacity: cs2.getPropertyValue('--bg-image-opacity').trim(), blur: cs2.getPropertyValue('--bg-blur').trim(), radius: cs2.getPropertyValue('--radius').trim() };
    const saved = (await window.vault.settings()).data;
    document.querySelector('.overlay [data-x]').click();
    await new Promise(r => setTimeout(r, 400));
    return { swatches, tabs, dark, customAccent, applied, savedOpacity: saved.background.opacity, savedBlur: saved.background.blur, savedThemeBg: saved.theme.bg, savedRadius: saved.theme.radius, modalClosed: !document.querySelector('.overlay') };
  })()`);

  // 11) 设置内安全页与数据页渲染
  results.settingsTabs = await js(`(async () => {
    document.getElementById('settingsBtn').click();
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('[data-tab="security"]').click();
    await new Promise(r => setTimeout(r, 300));
    const hasPaths = document.body.innerHTML.includes('device.key') && document.body.innerHTML.includes('vault.enc');
    const hasAutoHide = !!document.getElementById('p-auto');
    document.querySelector('[data-tab="data"]').click();
    await new Promise(r => setTimeout(r, 300));
    const hasExport = !!document.getElementById('d-exp-enc') && !!document.getElementById('d-exp-plain') && !!document.getElementById('d-imp-merge');
    document.querySelector('[data-tab="about"]').click();
    await new Promise(r => setTimeout(r, 300));
    const hasVersion = document.body.innerHTML.includes('Electron');
    document.querySelector('.overlay [data-x]').click();
    await new Promise(r => setTimeout(r, 300));
    return { hasPaths, hasAutoHide, hasExport, hasVersion };
  })()`);

  // 12) 掩码样式设置
  results.maskStyle = await js(`(async () => {
    const before = document.querySelector('.card .keyline .val').textContent;
    document.getElementById('settingsBtn').click();
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('[data-tab="security"]').click();
    await new Promise(r => setTimeout(r, 300));
    const sel = document.getElementById('p-mask');
    const options = [...sel.options].map(o => o.value).join(',');
    sel.value = 'tail'; sel.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 700));
    const tailMask = document.querySelector('.card .keyline .val').textContent;
    const sel2 = document.getElementById('p-mask');
    sel2.value = 'full'; sel2.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 700));
    const fullMask = document.querySelector('.card .keyline .val').textContent;
    const s2 = document.getElementById('p-mask');
    s2.value = 'prefix'; s2.dispatchEvent(new Event('change'));
    await new Promise(r => setTimeout(r, 600));
    const restored = document.querySelector('.card .keyline .val').textContent;
    const saved = (await window.vault.settings()).data.privacy.maskStyle;
    document.querySelector('.overlay [data-x]').click();
    await new Promise(r => setTimeout(r, 300));
    return { before, options, tailMask, fullMask, restored, saved,
      tailChanged: tailMask !== before && tailMask.startsWith('••'),
      fullChanged: /^•+$/.test(fullMask),
      prefixOk: restored.slice(0, 4) === before.slice(0, 4) };
  })()`);

  // 13) 删除流程
  results.deleteFlow = await js(`(async () => {
    const card = [...document.querySelectorAll('.card')].find(c => c.textContent.includes('ui-created'));
    card.querySelector('[data-act="del"]').click();
    await new Promise(r => setTimeout(r, 400));
    const asked = !!document.querySelector('.overlay [data-ok]');
    document.querySelector('.overlay [data-ok]').click();
    await new Promise(r => setTimeout(r, 800));
    return { asked, gone: ![...document.querySelectorAll('.card')].some(c => c.textContent.includes('ui-created')), remaining: document.querySelectorAll('.card').length, emptyStateBack: !!document.querySelector('.empty-state') };
  })()`);

  // 13) 落盘密文校验
  const vaultFile = path.join(TMP, 'vault', 'vault.enc');
  const onDisk = fs.existsSync(vaultFile) ? fs.readFileSync(vaultFile, 'utf8') : '';
  const settingsFile = path.join(TMP, 'vault', 'settings.json');
  const settingsDisk = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
  results.atRest = {
    fileExists: fs.existsSync(vaultFile),
    keyFileExists: fs.existsSync(path.join(TMP, 'vault', 'device.key')),
    plaintextOnDisk: onDisk.includes(SMOKE_VALUE),
    containerHeader: onDisk.slice(0, 11),
    settingsPersisted: settingsDisk.includes('midnight') || settingsDisk.includes('#ff7a45'),
    dataDir: TMP
  };

  const r = results;
  const checks = {
    noConsoleErrors: errors.length === 0,
    domOk: r.dom.grid && r.dom.providerOptions === 24 && r.dom.sortOptions === 5 && r.dom.emptyState && r.dom.bgLayer,
    uiCreateOk: r.uiFlow.opened && r.uiFlow.modalClosed && r.uiFlow.cards >= 1 && !r.uiFlow.leakedInDom && !r.uiFlow.leakedInAttr,
    noteAndTags: (r.uiFlow.noteVisible || '').length > 0 && (r.uiFlow.tagsVisible || []).length === 2 && /OpenAI/.test(r.uiFlow.providerBadge),
    editOk: r.editFlow.secretFieldEmpty && r.editFlow.prefilledNote === '来自界面的备注' && r.editFlow.newNote === '备注已修改' && r.editFlow.favShown,
    labelsOk: r.labels.hasApiKeyLabel && r.labels.keyLike.length === 0 && r.labels.labels.length >= 7 && /密钥/.test(r.labels.placeholder) && /保存/.test(r.labels.btn),
    revealOk: r.cardActions.revealMatches && r.cardActions.hiddenIsMask && r.cardActions.timer.length > 0 && /已复制/.test(r.cardActions.toast),
    filterOk: r.filter.openaiCount >= 1 && r.filter.otherCount === 0 && r.filter.emptyShown,
    favOk: r.favFilter.skipped || (r.favFilter.favCount >= 1 && r.favFilter.restored >= 1),
    searchOk: r.search.byNote >= 1 && r.search.byTag >= 1 && r.search.none === 0 && r.search.emptyShown && r.search.all >= 1,
    listOk: r.listControls.firstLabel.length > 0 && r.listControls.compact && r.listControls.backToComfortable,
    i18nOk: /Search/.test(r.i18n.en.ph) && /Add key/.test(r.i18n.en.add) && /搜索/.test(r.i18n.zh.ph) && /添加密钥/.test(r.i18n.zh.add),
    themeOk: r.theme.swatches >= 6 && r.theme.dark.bg.toLowerCase() === '#0e1420' && r.theme.customAccent === '#ff7a45' && r.theme.applied.opacity === '0.65' && r.theme.applied.blur === '8px',
    themePersistOk: r.theme.savedOpacity === 0.65 && r.theme.savedBlur === 8 && r.theme.savedRadius === 20,
    settingsOk: r.settingsTabs.hasPaths && r.settingsTabs.hasAutoHide && r.settingsTabs.hasExport && r.settingsTabs.hasVersion,
    maskStyleOk: r.maskStyle.options === 'prefix,tail,full' && r.maskStyle.tailChanged && r.maskStyle.fullChanged && r.maskStyle.prefixOk && r.maskStyle.saved === 'prefix',
    deleteOk: r.deleteFlow.asked && r.deleteFlow.gone && r.deleteFlow.emptyStateBack,
    atRestEncrypted: r.atRest.fileExists && r.atRest.keyFileExists && !r.atRest.plaintextOnDisk && r.atRest.containerHeader === 'OKEYDOKEY1:' && r.atRest.settingsPersisted
  };

  console.log('SMOKE_RESULT ' + JSON.stringify({ checks, results, errors, warnings }, null, 2));
  app.exit(Object.values(checks).every(Boolean) ? 0 : 1);
});
