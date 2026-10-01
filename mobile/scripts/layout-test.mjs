#!/usr/bin/env node
/**
 * 移动端布局与行为断言测试。
 *
 * 为什么需要它：
 *   本机没有安卓设备，我无法用肉眼确认「搜索框没了」「筛选条整行放下」
 *   「提示条不再超屏」。但这些问题本质上都是可断言的：
 *     - IS_MOBILE 判定是否在 app.js 求值前就绪（顺序错就会静默退回桌面版布局）
 *     - 移动端渲染的 HTML 里是否还有 Usage
 *     - 移动端排序选项是否还含 usage
 *     - 提示条容器的定位是否清掉了桌面端的 translateX(-50%)
 *     - 触摸路径（reveal/copy）是否真的不再等待落盘
 *
 * 做法：把真实的 app.js、mobile.css 与平台层读进来，在 DOM 桩上跑。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(70)}`); }

/* ------------------------------ 纯文本/CSS 断言 ------------------------------ */

const mobileCss = fs.readFileSync(path.join(MOBILE, 'src', 'mobile.css'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'app.js'), 'utf8');
const bootSrc = fs.readFileSync(path.join(MOBILE, 'src', 'boot.js'), 'utf8');

/** 取某个选择器规则块的内容 */
function cssBlock(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) return null;
  const j = css.indexOf('}', i);
  return css.slice(i, j + 1);
}

console.log('\n移动端布局与行为断言');
console.log('='.repeat(70));

section('1. bug 2：提示条不再超出屏幕边界');
{
  const toasts = cssBlock(mobileCss, '.is-mobile #toasts');
  check('存在 .is-mobile #toasts 规则', !!toasts, '规则缺失');
  check('显式复位 transform（清掉桌面端 translateX(-50%)）',
    !!toasts && /transform:\s*none/.test(toasts),
    toasts ? toasts.replace(/\s+/g, ' ') : '');
  check('同时设置了 left 与 right 边距',
    !!toasts && /left:/.test(toasts) && /right:/.test(toasts));
  check('避让底部安全区',
    !!toasts && /safe-bottom/.test(toasts));

  const toast = cssBlock(mobileCss, '.is-mobile .toast');
  check('长文本允许折行（不横向溢出）',
    !!toast && /white-space:\s*normal/.test(toast) && /overflow-wrap|word-break/.test(toast));

  // 桌面端的 translateX 必须仍然存在（不能顺手改坏桌面）
  const deskCss = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'styles.css'), 'utf8');
  const deskToasts = cssBlock(deskCss, '#toasts');
  check('桌面端仍保持 translateX(-50%) 居中', !!deskToasts && /translateX\(-50%\)/.test(deskToasts));
}

section('2. bug 1：reveal / copy 不等落盘');{
  const storeSrc = fs.readFileSync(path.join(MOBILE, 'src', 'platform', 'store.mjs'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(MOBILE, 'src', 'platform', 'vault-api.mjs'), 'utf8');

  check('store.touch 不再是 async 落盘版本',
    /^\s*touch\(id\)\s*\{/m.test(storeSrc), 'touch 仍为 async?');
  check('touch 内部不直接 await _write()',
    !/touch\(id\)\s*\{[\s\S]{0,400}?await this\._write\(\)/.test(storeSrc));
  check('改为合并调度（_scheduleFlush）', /_scheduleFlush\(\)/.test(storeSrc));
  check('有 flush() 供导出/切后台时落盘', /async flush\(\)/.test(storeSrc));
  check('reveal 不 await touch', !/reveal:[\s\S]{0,300}?await store\.touch/.test(apiSrc));
  check('copy 不 await touch', !/copy:[\s\S]{0,500}?await store\.touch/.test(apiSrc));
  check('导出前会 flush，避免计数丢失', /await store\.flush\(\)/.test(apiSrc));
  check('暴露 flushPending 供切后台调用', /flushPending:/.test(apiSrc));

  // 采集顺序：明文必须在写盘之前交出
  const revealBody = apiSrc.slice(apiSrc.indexOf('reveal: (id)'), apiSrc.indexOf('copy: (id)'));
  const touchPos = revealBody.indexOf('store.touch(id)');
  const returnPos = revealBody.indexOf('return { value }');
  check('reveal 先记数、再返回明文（同步，无 await 阻塞）',
    touchPos >= 0 && returnPos > touchPos && !/await/.test(revealBody));
}

section('3. 界面精简：搜索框与冗余工具栏');
{
  check('移动端隐藏搜索框', /\.is-mobile \.search-wrap\s*\{[^}]*display:\s*none/.test(mobileCss));
  check('移动端隐藏服务商下拉', /\.is-mobile #providerSelect[^{]*\{[^}]*display:\s*none/.test(mobileCss)
    || /#providerSelect,\s*\n\.is-mobile #densitySeg\s*\{[^}]*display:\s*none/.test(mobileCss));
  check('移动端隐藏密度切换', /\.is-mobile #densitySeg\s*\{[^}]*display:\s*none/.test(mobileCss)
    || /#providerSelect,\s*\n\.is-mobile #densitySeg\s*\{[^}]*display:\s*none/.test(mobileCss));
  check('排序下拉仍然保留（未被误删）',
    /\.is-mobile #sortSelect/.test(mobileCss) && !/\.is-mobile #sortSelect\s*\{[^}]*display:\s*none/.test(mobileCss));
}

section('4. 筛选条：单行横向滑动（v1.2.4 起）');
{
  const sideNav = cssBlock(mobileCss, '.is-mobile #sideNav');
  check('存在筛选条规则', !!sideNav);
  // 设计变更：原先用换行展示全部，但实测 3 项换行后第二行只剩 1 项，
  // 视觉重心明显偏左（用户上报）。现改为横向滑动 + 两端渐隐。
  check('单行不换行（flex-wrap: nowrap）',
    !!sideNav && /flex-wrap:\s*nowrap/.test(sideNav),
    sideNav ? sideNav.replace(/\s+/g, ' ').slice(0, 120) : '');
  check('启用了横向滑动',
    !!sideNav && /overflow-x:\s*auto/.test(sideNav));
  check('滑动区域可触摸滚动',
    !!sideNav && /-webkit-overflow-scrolling:\s*touch/.test(sideNav));
  // 实质检查：滑块不能把内容裁掉（overflow hidden 会让内容不可达）
  check('内容未被裁掉（不是 overflow: hidden）',
    !!sideNav && !/overflow(-x)?:\s*hidden/.test(sideNav));
  check('aside 在移动端可见（未被窄屏断点隐藏）',
    /\.is-mobile aside\s*\{[^}]*display:\s*block/.test(mobileCss));
  check('筛选条避开左右安全区',
    /\.is-mobile aside\s*\{[^}]*safe-left/.test(mobileCss) && /\.is-mobile aside\s*\{[^}]*safe-right/.test(mobileCss));
  // 两端渐隐：提示可滑动，否则用户不知道右边还有项
  check('有渐隐提示（mask-image）',
    /\.is-mobile aside\s*\{[^}]*mask-image/.test(mobileCss));
  // 长名已改用短名
  check('长服务商名使用短名', /providerShortName/.test(appSrc) && /PROVIDER_SHORT/.test(appSrc));
}

section('5. 删去 Usage（仅移动端）');
{
  check('app.js 声明了 IS_MOBILE', /const IS_MOBILE\s*=/.test(appSrc));
  check('Usage 渲染被 IS_MOBILE 条件包裹', /IS_MOBILE \? '' : .*usageCount/.test(appSrc));
  check('移动端排序选项不含 usage', /IS_MOBILE \? \['updated', 'created', 'label', 'provider'\]/.test(appSrc));
  check('桌面端排序仍保留 usage', /\['updated', 'created', 'label', 'provider', 'usage'\]/.test(appSrc));
  check('按使用次数排序的实现在桌面端仍可用', /usage: \(a, b\) => \(b\.usageCount/.test(appSrc));
}

section('6. IS_MOBILE 就绪顺序（顺序错会静默退回桌面布局）');
{
  const platformPos = bootSrc.indexOf("classList.add('is-mobile')");
  check('boot.js 在同步段添加 is-mobile 类', platformPos >= 0);

  // boot.js 里 classList.add 之前不能有 await（否则 app.js 可能先执行）
  const beforeAdd = bootSrc.slice(0, platformPos);
  const topLevelAwait = /^\s*(await |.*await CapApp)/m.test(beforeAdd.split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
  check('添加 is-mobile 之前无顶层 await 阻塞', !topLevelAwait);

  // 打包后的 index.html 里 platform.js 必须先于 app.js
  const html = fs.readFileSync(path.join(MOBILE, 'www', 'index.html'), 'utf8');
  const pj = html.indexOf('platform.js');
  const aj = html.indexOf('app.js');
  check('platform.js 先于 app.js 加载', pj >= 0 && aj > pj, `platform=${pj} app=${aj}`);
}

section('7. 桌面端未被改动（回归保护）');
{
  check('桌面端仍渲染 Usage', /\$\{esc\(window\.t\('usage'\)\)\}:/.test(appSrc));
  check('桌面端排序含 usage', /'provider', 'usage'\]/.test(appSrc));
  // mobile.css 的每条规则都必须挂在 .is-mobile 下，避免误伤桌面
  const bare = mobileCss
    .split('\n')
    .filter((l) => /^\s*\.[a-zA-Z#][^{]*\{\s*$/.test(l))
    .filter((l) => !/\.is-mobile/.test(l) && !/^\s*@/.test(l))
    .filter((l) => !/\.attention/.test(l));  // .attention 是移动端专属辅助类
  check('mobile.css 规则均限定在 .is-mobile 下', bare.length === 0,
    bare.slice(0, 3).map(s => s.trim()).join(' | '));
}

console.log('\n' + '='.repeat(70));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('移动端布局与行为断言通过 ✓');
