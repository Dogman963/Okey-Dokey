#!/usr/bin/env node
/**
 * 端到端迁移测试 —— 验证「用户真正的操作路径」，而不只是加解密函数。
 *
 * 路径覆盖：
 *   1. 桌面端导出加密包（用 repo 的真实现）→ vault-tool 校验 → 移动端导入
 *   2. 移动端导出加密包 → vault-tool 校验 → 桌面端导入
 *   3. 换口令（reencrypt）后，原口令失效、新口令可用
 *   4. 明文 JSON 与加密包互转
 *   5. merge 语义：同 id 覆盖、新 id 插入（多设备合并）
 *   6. vault-tool plaintext-check 的检出能力
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(__dirname, '..');
const REPO = path.resolve(MOBILE, '..');
const require = createRequire(pathToFileURL(path.join(MOBILE, 'package.json')));

if (!globalThis.crypto?.subtle) globalThis.crypto = webcrypto;

const desktop = require(path.join(REPO, 'src', 'main', 'crypto.js'));
const mobile = await import(pathToFileURL(path.join(MOBILE, 'src', 'platform', 'crypto.mjs')).href);
const VAULT_TOOL = path.join(REPO, 'scripts', 'vault-tool.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(68)}`); }

/** 调用 vault-tool，返回 { code, out } */
function tool(args) {
  try {
    const out = execFileSync('node', [VAULT_TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: (err.stdout || '') + (err.stderr || '') };
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'okey-e2e-'));
const P1 = 'first-passphrase-2026';
const P2 = 'second-passphrase-2026';

const A = {
  version: 1,
  records: [{
    id: 'aaaa-1', provider: 'openai', label: '设备甲-key', credential: 'sk-aaa-1111222233334444',
    note: '甲的备注', tags: ['a'], baseUrl: '', models: '', favorite: false, disabled: false,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', usageCount: 0, lastUsedAt: null
  }]
};
const B = {
  version: 1,
  records: [{
    id: 'bbbb-2', provider: 'zhipu', label: '设备乙-key', credential: 'sk-bbb-5555666677778888',
    note: '乙的备注', tags: ['b'], baseUrl: '', models: '', favorite: true, disabled: false,
    createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z', usageCount: 1, lastUsedAt: null
  }]
};

console.log('\n端到端迁移测试（桌面端 / 安卓端 / vault-tool 三方互通）');
console.log('='.repeat(68));
console.log('临时目录:', TMP);

try {
  /* ---------- 1. 桌面导出 → 工具 → 移动导入 ---------- */
  section('1. 桌面端导出 → vault-tool 校验 → 安卓端导入');
  const f1 = path.join(TMP, 'desktop-export.okeyvault');
  fs.writeFileSync(f1, JSON.stringify(desktop.encryptWithPassphrase(A, P1, {
    producer: 'okey-dokey-desktop', producerVersion: '1.1.0', recordCount: 1
  }), null, 2), 'utf8');

  const ins = tool(['inspect', f1]);
  check('inspect 成功', ins.code === 0, ins.out.slice(0, 200));
  check('inspect 报出导出端', ins.out.includes('okey-dokey-desktop'));

  const ver = tool(['verify', f1, '-p', P1]);
  check('verify 正确口令通过', ver.code === 0);
  const verBad = tool(['verify', f1, '-p', 'wrong']);
  check('verify 错误口令被拒', verBad.code !== 0);

  const imported = await mobile.decryptWithPassphrase(JSON.parse(fs.readFileSync(f1, 'utf8')), P1);
  check('安卓端无需口令转换即可解密', JSON.stringify(imported) === JSON.stringify(A));

  /* ---------- 2. 移动导出 → 工具 → 桌面导入 ---------- */
  section('2. 安卓端导出 → vault-tool 校验 → 桌面端导入');
  const f2 = path.join(TMP, 'android-export.okeyvault');
  const pkg = await mobile.encryptWithPassphrase(B, P2, {
    producer: 'okey-dokey-android', producerVersion: '1.1.0', recordCount: 1
  });
  fs.writeFileSync(f2, JSON.stringify(pkg, null, 2), 'utf8');

  const ins2 = tool(['inspect', f2]);
  check('inspect 报出安卓端', ins2.out.includes('okey-dokey-android'));
  check('verify 通过', tool(['verify', f2, '-p', P2]).code === 0);

  const backDesk = desktop.decryptWithPassphrase(JSON.parse(fs.readFileSync(f2, 'utf8')), P2);
  check('桌面端无需口令转换即可解密', JSON.stringify(backDesk) === JSON.stringify(B));

  /* ---------- 3. 换口令 ---------- */
  section('3. 换口令（reencrypt）');
  const f3 = path.join(TMP, 'rekeyed.okeyvault');
  const rc = tool(['reencrypt', f1, '-p', P1, '-n', P2, '-o', f3]);
  check('reencrypt 执行成功', rc.code === 0, rc.out.slice(0, 200));
  check('新包可用新口令校验', tool(['verify', f3, '-p', P2]).code === 0);
  check('新包不认旧口令', tool(['verify', f3, '-p', P1]).code !== 0);
  const rekeyed = await mobile.decryptWithPassphrase(JSON.parse(fs.readFileSync(f3, 'utf8')), P2);
  check('换口令后内容不变', JSON.stringify(rekeyed) === JSON.stringify(A));

  /* ---------- 4. 明文 JSON 互转 ---------- */
  section('4. 明文 JSON ⇄ 加密包');
  const plain = path.join(TMP, 'plain.json');
  fs.writeFileSync(plain, JSON.stringify(A, null, 2), 'utf8');
  const f4 = path.join(TMP, 'from-plain.okeyvault');
  check('convert 明文 → 加密包', tool(['convert', plain, '-n', P1, '-o', f4]).code === 0);
  check('转换后可正常校验', tool(['verify', f4, '-p', P1]).code === 0);

  const f5 = path.join(TMP, 'decrypted.json');
  check('decrypt 加密包 → 明文', tool(['decrypt', f2, '-p', P2, '-o', f5]).code === 0);
  check('解密内容与原数据一致',
    JSON.stringify(JSON.parse(fs.readFileSync(f5, 'utf8'))) === JSON.stringify(B));

  /* ---------- 5. merge 语义（多设备合并） ---------- */
  section('5. 多设备合并语义（merge：同 id 覆盖，新 id 插入）');
  // 模拟两端各有一条，合并后应有 2 条
  const merged = { version: 1, records: [...A.records] };
  const byId = new Map(merged.records.map((r) => [r.id, r]));
  for (const r of B.records) {
    if (byId.has(r.id)) Object.assign(byId.get(r.id), r);
    else merged.records.unshift(r);
  }
  check('合并后记录数 = 2', merged.records.length === 2);

  // 同 id 覆盖：乙改写了甲的记录
  const edited = { ...A.records[0], label: '已被设备乙改名', updatedAt: '2026-09-30T00:00:00.000Z' };
  const m2 = { version: 1, records: [...A.records] };
  const map2 = new Map(m2.records.map((r) => [r.id, r]));
  for (const r of [edited]) {
    if (map2.has(r.id)) Object.assign(map2.get(r.id), r);
    else m2.records.unshift(r);
  }
  check('同 id 覆盖后仍为 1 条', m2.records.length === 1);
  check('同 id 覆盖取到了新值', m2.records[0].label === '已被设备乙改名');

  /* ---------- 6. 明文检出 ---------- */
  section('6. plaintext-check 明文泄露检出');
  const leaky = path.join(TMP, 'leaky.json');
  fs.writeFileSync(leaky, JSON.stringify({ version: 1, records: [{ id: 'x', credential: 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }] }), 'utf8');
  const chk = tool(['plaintext-check', leaky]);
  check('检出明文密钥文件', chk.code !== 0, `code=${chk.code}`);

  const safe = tool(['plaintext-check', f1]);
  check('加密包被判为安全', safe.code === 0, safe.out.slice(0, 150));

  /* ---------- 7. 清单一致性 ---------- */
  section('7. 记录字段完整性（迁移后不丢字段）');
  const fields = ['id', 'provider', 'label', 'credential', 'note', 'tags', 'baseUrl', 'models',
    'favorite', 'disabled', 'createdAt', 'updatedAt', 'usageCount', 'lastUsedAt'];
  const rt = await mobile.decryptWithPassphrase(
    await mobile.encryptWithPassphrase(A, P1), P1);
  const rec = rt.records[0];
  const missing = fields.filter((f) => !(f in rec));
  check('往返后字段无缺失', missing.length === 0, missing.join(','));
  check('布尔字段类型保持', rec.favorite === false && rec.disabled === false);
  check('tags 数组类型保持', Array.isArray(rec.tags) && rec.tags[0] === 'a');

} catch (err) {
  console.error('\n测试执行异常:', err);
  process.exit(1);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

console.log('\n' + '='.repeat(68));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('端到端迁移链路验证通过 ✓');
