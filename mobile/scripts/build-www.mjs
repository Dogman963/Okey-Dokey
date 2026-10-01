/**
 * 组装 www/ —— 桌面端界面代码 + 移动端平台层。
 *
 * 设计原则：**界面只有一份**。src/renderer 与 src/shared 直接从仓库根目录取，
 * 移动端不复制、不改写界面文件，避免两端分叉。
 *
 * 产物结构：
 *   www/index.html      由 renderer/index.html 生成（注入移动端样式与 boot 脚本）
 *   www/styles.css      renderer 样式 + 移动端适配层
 *   www/app.js          界面逻辑（原样）
 *   www/i18n.js         词条（原样）
 *   www/providers.js    shared/providers.js（原样）
 *   www/platform.js     boot.js + 平台层（esbuild 打包）
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');   // mobile/ 位于仓库内，上一级即仓库根
const SRC = path.join(REPO, 'src');
const OUT = path.join(MOBILE, 'www');

const pkg = JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8'));
const VERSION = pkg.version;

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function ensure(p) {
  fs.mkdirSync(p, { recursive: true });
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function write(p, s) {
  ensure(path.dirname(p));
  fs.writeFileSync(p, s, 'utf8');
}

/** 断言上游文件存在，缺了就明确报错而不是静默产出残缺包 */
function requireFile(p, label) {
  if (!fs.existsSync(p)) throw new Error(`缺少上游文件 ${label}: ${p}`);
  return p;
}

console.log('[build-www] 源仓库:', REPO);
console.log('[build-www] 版本:', VERSION);

rmrf(OUT);
ensure(OUT);

/* ---------- 1. 界面代码：原样搬运 ---------- */

const rendererDir = path.join(SRC, 'renderer');
const files = {
  'app.js': requireFile(path.join(rendererDir, 'app.js'), 'renderer/app.js'),
  'i18n.js': requireFile(path.join(rendererDir, 'i18n.js'), 'renderer/i18n.js'),
  'styles.css': requireFile(path.join(rendererDir, 'styles.css'), 'renderer/styles.css'),
  'providers.js': requireFile(path.join(SRC, 'shared', 'providers.js'), 'shared/providers.js')
};

for (const [out, src] of Object.entries(files)) {
  write(path.join(OUT, out), read(src));
}

/* ---------- 2. 移动端适配样式 ---------- */

const mobileCss = read(path.join(MOBILE, 'src', 'mobile.css'));
write(path.join(OUT, 'mobile.css'), mobileCss);

/* ---------- 3. index.html：注入移动端样式与启动脚本 ---------- */

let html = read(path.join(rendererDir, 'index.html'));

// 移动端 viewport：禁用缩放抖动，启用安全区
html = html.replace(
  /<meta charset="utf-8" \/>/,
  `<meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, user-scalable=no" />
  <meta name="color-scheme" content="light dark" />`
);

// 移动端样式接在桌面样式之后，便于覆盖
html = html.replace(
  '<link rel="stylesheet" href="styles.css" />',
  '<link rel="stylesheet" href="styles.css" />\n  <link rel="stylesheet" href="mobile.css" />'
);

// 给所有本地静态资源加版本参数，防止 WebView 缓存旧版样式/脚本。
//
// 为什么必须做：Capacitor 用 https://localhost 加载本地资源，会走 HTTP 缓存。
// 之前出现过「装了新版 APK 却仍看到旧界面」的困惑（用户报的搜索框/密度切换
// 实际已被隐藏，但缓存里的旧 CSS 仍生效）。加版本号后，每次发版必定重新拉取。
//
// 注意：这段必须在所有「路径替换」之后执行 —— 否则 providers.js 那时
// 还是 '../shared/providers.js' 形式，正则匹配不到，它就不会带版本号。
const V = encodeURIComponent(
  JSON.parse(fs.readFileSync(path.join(MOBILE, 'package.json'), 'utf8')).version
);

// 启动脚本必须早于 app.js：app.js 在文件末尾立即调用 init()
html = html.replace(
  '<script src="../shared/providers.js"></script>',
  '<script src="providers.js"></script>'
);
html = html.replace(
  '<script src="i18n.js"></script>',
  '<script src="platform.js"></script>\n  <script src="i18n.js"></script>'
);

// 现在所有资源路径都已就位，统一加版本参数
html = html.replace(
  /(<link[^>]+href=")([\w.-]+\.css)(")/g,
  (m, a, f, b) => `${a}${f}?v=${V}${b}`
);
html = html.replace(
  /(<script[^>]+src=")([\w.-]+\.js)(")/g,
  (m, a, f, b) => `${a}${f}?v=${V}${b}`
);

// CSP：允许 Capacitor 的 https 本地源与 data 图
html = html.replace(
  /<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/,
  `<meta http-equiv="Content-Security-Policy"
        content="default-src 'self' https://localhost capacitor://localhost; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self';" />`
);

write(path.join(OUT, 'index.html'), html);

/* ---------- 4. 平台层：esbuild 打包成单文件 ---------- */

await build({
  entryPoints: [path.join(MOBILE, 'src', 'boot.js')],
  outfile: path.join(OUT, 'platform.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning'
});

/* ---------- 5. 自检 ---------- */

const must = ['index.html', 'styles.css', 'mobile.css', 'app.js', 'i18n.js', 'providers.js', 'platform.js'];
const missing = must.filter((f) => !fs.existsSync(path.join(OUT, f)));
if (missing.length) throw new Error('产物缺失: ' + missing.join(', '));

const platformSize = fs.statSync(path.join(OUT, 'platform.js')).size;
console.log('[build-www] ok —', must.length, '个文件, platform.js', Math.round(platformSize / 1024), 'KB');
