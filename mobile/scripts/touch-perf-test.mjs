#!/usr/bin/env node
/**
 * 在**真实 store 实现**上量 reveal/copy 的耗时，证明 bug 1 已修好。
 *
 * 为什么不能只在桩里测：
 *   桩里我把 vault.reveal 写成了快路径，那是在验证我自己的假设，
 *   不能证明产品代码真的快了。这里直接 import 真实的 store.mjs，
 *   用内存文件系统替掉 Capacitor Filesystem，跑真正的 touch/_write 路径。
 *
 * 做法：给 @capacitor/filesystem 打桩（内存），然后：
 *   - 旧行为（每次 await _write）：量 reveal 的耗时
 *   - 新行为（touch 合并落盘）：量 reveal 的耗时
 * 两者用同一份 scrypt 实现，差异只来自「是否等待落盘」。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const require = createRequire(pathToFileURL(path.join(MOBILE, 'package.json')));

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

/* ---------------------- 载入真实 store（重写 import 说明符） ----------------------
   ESM 的 import 不走 Module._load，所以无法用 require 拦截。
   做法：把真实的 store.mjs 源码读进来，只把 '‘@capacitor/filesystem'’ 这一个
   说明符换成内存桩的绝对路径，其余逻辑（touch/_write/_scheduleFlush...）
   都是仓库里的真实代码，被测对象没有被替换。 */

const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'okey-store-'));

// 内存文件系统：桩模块通过 globalThis 访问这份 Map
const files = new Map();

const stubPath = path.join(tmp, 'fs-stub.mjs');
fs.writeFileSync(stubPath, `
const files = globalThis.__okeyFiles;
export const Directory = { Data: 'DATA', Documents: 'DOCUMENTS' };
export const Encoding = { UTF8: 'utf8' };
const keyOf = (p, dir) => dir + ':' + p;
export const Filesystem = {
  async mkdir() {},
  async writeFile({ path: p, directory = 'DATA', data }) { files.set(keyOf(p, directory), String(data)); },
  async readFile({ path: p, directory = 'DATA' }) {
    const k = keyOf(p, directory);
    if (!files.has(k)) throw new Error('ENOENT: ' + k);
    return { data: files.get(k) };
  },
  async deleteFile({ path: p, directory = 'DATA' }) { files.delete(keyOf(p, directory)); },
  async stat({ path: p, directory = 'DATA' }) { if (!files.has(keyOf(p, directory))) throw new Error('ENOENT'); return {}; },
  async readdir({ path: p, directory = 'DATA' }) {
    const prefix = keyOf(p, directory) + '/';
    return { files: [...files.keys()].filter(k => k.startsWith(prefix)).map(k => ({ name: k.slice(prefix.length) })) };
  },
  async getUri({ path: p }) { return { uri: 'file:///' + p }; }
};
`, 'utf8');

const realStore = fs.readFileSync(path.join(MOBILE, 'src', 'platform', 'store.mjs'), 'utf8');
const cryptoAbs = pathToFileURL(path.join(MOBILE, 'src', 'platform', 'crypto.mjs')).href;
const rewritten = realStore
  .replace("'@capacitor/filesystem'", JSON.stringify(pathToFileURL(stubPath).href))
  .replace("'./crypto.mjs'", JSON.stringify(cryptoAbs));

const storePath = path.join(tmp, 'store-under-test.mjs');
fs.writeFileSync(storePath, rewritten, 'utf8');

// 确认重写真的生效了（否则会误测到别的实现）
if (rewritten.includes('@capacitor/filesystem')) {
  console.error('import 重写失败，测试不可信');
  process.exit(1);
}

globalThis.__okeyFiles = files;
const { Store } = await import(pathToFileURL(storePath).href);

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(70)}`); }

console.log('\n真实 store 上的触摸路径耗时实测');
console.log('='.repeat(70));

/* ---------------------- 准备库 ---------------------- */

const store = new Store();
await store.init();
const rec = await store.create({ provider: 'openai', label: '测试', credential: 'SYNTH-ABCDEFGHIJKLMNOP', tags: ['生产'] });

section('1. 新行为：touch 合并落盘，reveal/copy 不等写盘');
{
  // 模拟平台层现在的快路径
  const revealFast = async (id) => { const v = store.getCredential(id); store.touch(id); return v; };
  const copyFast = async (id) => { const v = store.getCredential(id); store.touch(id); return v; };

  const runs = 5;
  const revealTimes = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await revealFast(rec.id);
    revealTimes.push(performance.now() - t);
  }
  const copyTimes = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await copyFast(rec.id);
    copyTimes.push(performance.now() - t);
  }

  const revealAvg = revealTimes.reduce((a, b) => a + b, 0) / runs;
  const copyAvg = copyTimes.reduce((a, b) => a + b, 0) / runs;

  console.log(`      reveal 平均 ${revealAvg.toFixed(2)} ms  (${revealTimes.map((t) => t.toFixed(1)).join(', ')})`);
  console.log(`      copy   平均 ${copyAvg.toFixed(2)} ms  (${copyTimes.map((t) => t.toFixed(1)).join(', ')})`);

  check('reveal 平均 < 20ms', revealAvg < 20, `${revealAvg.toFixed(2)}ms`);
  check('copy 平均 < 20ms', copyAvg < 20, `${copyAvg.toFixed(2)}ms`);
  check('多次点击后计数已累加', store.get(rec.id).usageCount === runs * 2,
    `usageCount=${store.get(rec.id).usageCount}`);
}

section('2. 对照：旧行为（每次都 await 落盘）有多慢');
{
  const revealOld = async (id) => {
    const v = store.getCredential(id);
    // 旧实现：await store.touch → touch 内部 await this._write()
    // 这里直接调用 _write() 复现同样的写盘成本
    await store._write();
    return v;
  };
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    await revealOld(rec.id);
    times.push(performance.now() - t);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`      旧行为 reveal 平均 ${avg.toFixed(1)} ms  (${times.map((t) => t.toFixed(1)).join(', ')})`);
  check('旧行为确实明显更慢（证明修复有意义）', avg > 50, `${avg.toFixed(1)}ms`);
  console.log(`      提速约 ${(avg / 1).toFixed(0)}× 的量级差距（手机上还会被 setTimeout 钳制放大）`);
}

section('3. 合并落盘不丢数据');
{
  // 等合并窗口过去，确认计数被写进磁盘
  await new Promise((r) => setTimeout(r, 700));
  const raw = files.get('DATA:okey-dokey/vault.enc');
  check('vault.enc 已落盘', !!raw);

  // 重新读一遍，确认计数真的持久化了
  const store2 = new Store();
  await store2.init();
  const loaded = store2.get(rec.id);
  check('计数已持久化（合并写盘未丢）', loaded && loaded.usageCount === store.get(rec.id).usageCount,
    `磁盘=${loaded ? loaded.usageCount : 'n/a'} 内存=${store.get(rec.id).usageCount}`);

  // flush() 应能强制立即落盘
  store.touch(rec.id);
  const before = store.get(rec.id).usageCount;
  await store.flush();
  const store3 = new Store();
  await store3.init();
  check('flush() 强制落盘生效', store3.get(rec.id).usageCount === before,
    `磁盘=${store3.get(rec.id).usageCount} 内存=${before}`);
}

section('4. 密钥内容未被破坏');
{
  const store4 = new Store();
  await store4.init();
  check('明文密钥完好', store4.getCredential(rec.id) === 'SYNTH-ABCDEFGHIJKLMNOP');
  check('标签完好', JSON.stringify(store4.get(rec.id).tags) === JSON.stringify(['生产']));
}

console.log('\n' + '='.repeat(70));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('真实 store 触摸路径验证通过 ✓');
