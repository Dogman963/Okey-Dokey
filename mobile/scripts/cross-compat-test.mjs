#!/usr/bin/env node
/**
 * 交叉兼容测试 —— 证明「桌面端」与「安卓端」的加密格式真的互通。
 *
 * 为什么必须有这个测试：
 *   两端用同一套算法但**不同实现**（Node crypto vs WebCrypto + 纯 JS scrypt）。
 *   「算法相同」不等于「字节相同」——maxmem、tag 拼接顺序、base64 变体、
 *   hex 大小写、JSON 键序等任一处偏差都会让迁移在用户手里失败。
 *   所以在真机上试之前，先用可执行的方式把兼容性钉死。
 *
 * 被测两侧：
 *   A. 桌面端加密实现：repo/src/main/crypto.js          （直接用真代码，不复制）
 *   B. 移动端加密实现：mobile/src/platform/crypto.mjs   （直接用真代码，不复制）
 *
 * 覆盖用例：
 *   1. 桌面加密 → 移动解密
 *   2. 移动加密 → 桌面解密
 *   3. 双向导出包（口令）互解
 *   4. 移动端生成的随机 salt/IV 与桌面端产物结构一致
 *   5. 篡改检测（GCM 认证有效）
 *   6. 错误口令必须失败
 *   7. 本机库容器（N=16384）双向互解
 *   8. 元信息字段不影响旧版解析
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');
const require = createRequire(pathToFileURL(path.join(MOBILE, 'package.json')));

// WebCrypto 供移动端模块使用（浏览器里是原生 crypto，Node 里需显式注入）
if (!globalThis.crypto) globalThis.crypto = webcrypto;
else if (!globalThis.crypto.subtle) globalThis.crypto = webcrypto;
// 纯 JS scrypt 依赖 TextEncoder（Node 18+ 全局已有）

/* ------------------------------ 加载两侧实现 ------------------------------ */

const desktop = require(path.join(REPO, 'src', 'main', 'crypto.js'));
const mobile = await import(pathToFileURL(path.join(MOBILE, 'src', 'platform', 'crypto.mjs')).href);

/* ------------------------------ 断言工具 ------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(68));
}

/* ------------------------------ 测试数据 ------------------------------ */

const KEY_MATERIAL = 'a3f1c9d2e8b74a05f6c1d3e9b8a72f4c5d6e7a8b9c0d1e2f3a4b5c6d7e8f9a0b'; // 模拟 device.key
const PASSPHRASE = 'test-passphrase-2026';

const SAMPLE_VAULT = {
  version: 1,
  records: [
    {
      id: '11111111-2222-4333-8444-555555555555',
      provider: 'openai',
      label: '生产环境 OpenAI',
      credential: 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      note: '多行备注\n第二行带中文与 emoji 🔑',
      tags: ['prod', '主力'],
      baseUrl: 'https://api.openai.com/v1',
      models: 'gpt-4o, gpt-4o-mini',
      favorite: true,
      disabled: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-20T12:34:56.789Z',
      usageCount: 3,
      lastUsedAt: null
    },
    {
      id: '99999999-8888-4777-8666-555544443333',
      provider: 'zhipu',
      label: '智谱测试',
      credential: 'sk-test-0000111122223333',
      note: '',
      tags: [],
      baseUrl: '',
      models: '',
      favorite: false,
      disabled: true,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      usageCount: 0,
      lastUsedAt: null
    }
  ]
};

/* ------------------------------ 1. 本机容器双向 ------------------------------ */

async function testContainerBidirectional() {
  section('1. 本机库容器（vault.enc 格式，scrypt N=16384）');

  const fromDesktop = desktop.encryptJSON(SAMPLE_VAULT, KEY_MATERIAL);
  const byMob = await mobile.decryptJSON(fromDesktop, KEY_MATERIAL);
  check('桌面加密 → 移动解密', JSON.stringify(byMob) === JSON.stringify(SAMPLE_VAULT));

  const fromMobile = await mobile.encryptJSON(SAMPLE_VAULT, KEY_MATERIAL);
  const byDesk = desktop.decryptJSON(fromMobile, KEY_MATERIAL);
  check('移动加密 → 桌面解密', JSON.stringify(byDesk) === JSON.stringify(SAMPLE_VAULT));

  // 容器结构
  const parts = fromMobile.split(':');
  check('容器为 5 段冒号分隔', parts.length === 5);
  check('标识为 OKEYDOKEY1', parts[0] === desktop.MAGIC);
  check('salt 为 16 字节', Buffer.from(parts[1], 'base64').length === 16);
  check('iv 为 12 字节', Buffer.from(parts[2], 'base64').length === 12);
  check('tag 为 16 字节', Buffer.from(parts[3], 'base64').length === 16);
  check('body 非空', Buffer.from(parts[4], 'base64').length > 0);

  // 桌面端容器同样结构
  const dParts = fromDesktop.split(':');
  check('桌面容器 salt 16 字节', Buffer.from(dParts[1], 'base64').length === 16);
  check('桌面容器 iv 12 字节', Buffer.from(dParts[2], 'base64').length === 12);
  check('桌面容器 tag 16 字节', Buffer.from(dParts[3], 'base64').length === 16);
}

/* ------------------------------ 2. 派生密钥一致性 ------------------------------ */

async function testDerivedKey() {
  section('2. 派生密钥一致性（同输入必须同输出）');

  const salt = Buffer.from('0123456789abcdef'); // 固定 salt

  const dk = desktop.deriveKey(KEY_MATERIAL, salt);
  const mk = await mobile.deriveKey(KEY_MATERIAL, salt);
  check('deriveKey 输出一致（N=16384）',
    Buffer.from(mk).toString('hex') === dk.toString('hex'),
    `desktop=${dk.toString('hex').slice(0, 16)}… mobile=${Buffer.from(mk).toString('hex').slice(0, 16)}…`);

  const dp = desktop.encryptWithPassphrase({ a: 1 }, PASSPHRASE).salt; // 只是取用，不算
  const pk = desktop.decryptWithPassphrase; // 引用以确保存在
  check('桌面端导出包接口存在', typeof pk === 'function' && typeof dp === 'string');

  // 导出包口令派生（N=32768）
  const exportSalt = Buffer.from('fedcba9876543210');
  const dek = desktop.decryptWithPassphrase; // 占位，实际比较走密文互解
  const testObj = { hello: '世界', n: 42 };
  const pkgD = desktop.encryptWithPassphrase(testObj, PASSPHRASE);
  const pkgM = await mobile.encryptWithPassphrase(testObj, PASSPHRASE);
  check('两端导出包字段集合一致',
    JSON.stringify(Object.keys(pkgD).filter((k) => !['createdAt', 'producer', 'producerVersion', 'recordCount'].includes(k)).sort()) ===
    JSON.stringify(Object.keys(pkgM).filter((k) => !['createdAt', 'producer', 'producerVersion', 'recordCount'].includes(k)).sort()));
  check('两端 kdf 声明一致', pkgD.kdf === pkgM.kdf && pkgD.version === pkgM.version);
}

/* ------------------------------ 3. 导出包双向 ------------------------------ */

async function testExportPackage() {
  section('3. 加密导出包（.okeyvault，scrypt N=32768）');

  // 桌面导出 → 移动导入
  const pkgFromDesktop = desktop.encryptWithPassphrase(SAMPLE_VAULT, PASSPHRASE);
  const byMobile = await mobile.decryptWithPassphrase(pkgFromDesktop, PASSPHRASE);
  check('桌面导出 → 移动导入', JSON.stringify(byMobile) === JSON.stringify(SAMPLE_VAULT));

  // 移动导出 → 桌面导入
  const pkgFromMobile = await mobile.encryptWithPassphrase(SAMPLE_VAULT, PASSPHRASE, {
    producer: 'okey-dokey-android',
    producerVersion: '1.1.0',
    recordCount: SAMPLE_VAULT.records.length
  });
  const byDesktop = desktop.decryptWithPassphrase(pkgFromMobile, PASSPHRASE);
  check('移动导出 → 桌面导入', JSON.stringify(byDesktop) === JSON.stringify(SAMPLE_VAULT));

  // 元信息不破坏兼容
  check('移动导出包携带元信息', !!pkgFromMobile.createdAt && pkgFromMobile.producer === 'okey-dokey-android');
  check('元信息不影响桌面解析', JSON.stringify(byDesktop) === JSON.stringify(SAMPLE_VAULT));

  // 结构校验
  const fields = ['format', 'version', 'kdf', 'salt', 'iv', 'tag', 'data'];
  check('导出包含全部必要字段', fields.every((f) => pkgFromMobile[f] !== undefined));
  check('format 标识正确', pkgFromMobile.format === 'okey-dokey-export');
  check('识别函数可用', mobile.isExportPackage(pkgFromMobile) === true);
  check('非导出包不被误判', mobile.isExportPackage({ a: 1 }) === false);
}

/* ------------------------------ 4. 安全性质 ------------------------------ */

async function testSecurity() {
  section('4. 安全性质（篡改检测与口令校验）');

  const pkg = await mobile.encryptWithPassphrase(SAMPLE_VAULT, PASSPHRASE);

  // 错误口令
  let wrongOk = false;
  try {
    await mobile.decryptWithPassphrase(pkg, 'wrong-passphrase');
    wrongOk = true;
  } catch (_) {}
  check('错误口令在移动端被拒绝', !wrongOk);

  let wrongOkD = false;
  try {
    desktop.decryptWithPassphrase(pkg, 'wrong-passphrase');
    wrongOkD = true;
  } catch (_) {}
  check('错误口令在桌面端被拒绝', !wrongOkD);

  // 篡改密文
  const tampered = { ...pkg };
  const buf = Buffer.from(tampered.data, 'base64');
  buf[0] ^= 0xff;
  tampered.data = buf.toString('base64');
  let tamperOk = false;
  try {
    await mobile.decryptWithPassphrase(tampered, PASSPHRASE);
    tamperOk = true;
  } catch (_) {}
  check('密文被篡改时移动端报错', !tamperOk);

  let tamperOkD = false;
  try {
    desktop.decryptWithPassphrase(tampered, PASSPHRASE);
    tamperOkD = true;
  } catch (_) {}
  check('密文被篡改时桌面端报错', !tamperOkD);

  // 容器魔数校验
  let badMagic = false;
  try {
    await mobile.decryptJSON('WRONGMAGIC:aaaa:bbbb:cccc:dddd', KEY_MATERIAL);
    badMagic = true;
  } catch (_) {}
  check('未知魔数被拒绝', !badMagic);
}

/* ------------------------------ 5. 边界数据 ------------------------------ */

async function testEdgeCases() {
  section('5. 边界数据（中文/emoji/长密钥/空库）');

  const big = 'x'.repeat(50000);
  const edge = {
    version: 1,
    records: [{
      id: 'edge-1',
      provider: 'custom',
      label: '中文标签 🎉 with ASCII and "quotes" \\ backslash',
      credential: big,
      note: '换行\n\ttab\r\nCRLF · 全角字符测试',
      tags: ['中文', 'emoji😀'],
      baseUrl: '',
      models: '',
      favorite: false,
      disabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      usageCount: 0,
      lastUsedAt: null
    }]
  };

  const c = await mobile.encryptJSON(edge, KEY_MATERIAL);
  check('长内容(50KB) 移动加密 → 桌面解密',
    JSON.stringify(desktop.decryptJSON(c, KEY_MATERIAL)) === JSON.stringify(edge));

  const empty = { version: 1, records: [] };
  const c2 = desktop.encryptJSON(empty, KEY_MATERIAL);
  check('空库 桌面加密 → 移动解密',
    JSON.stringify(await mobile.decryptJSON(c2, KEY_MATERIAL)) === JSON.stringify(empty));

  // 不同设备密钥必须互相解不开（隔离性）
  const otherKey = 'b'.repeat(64);
  let leaked = false;
  try {
    await mobile.decryptJSON(c, otherKey);
    leaked = true;
  } catch (_) {}
  check('换设备密钥无法解密（设备隔离成立）', !leaked);
}

/* ------------------------------ 主流程 ------------------------------ */

console.log('\n交叉兼容测试：桌面端(Node crypto) ⇄ 安卓端(WebCrypto + JS scrypt)');
console.log('='.repeat(68));

try {
  await testContainerBidirectional();
  await testDerivedKey();
  await testExportPackage();
  await testSecurity();
  await testEdgeCases();
} catch (err) {
  console.error('\n测试执行异常:', err);
  process.exit(1);
}

console.log('\n' + '='.repeat(68));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('两端加密格式互通 ✓');
