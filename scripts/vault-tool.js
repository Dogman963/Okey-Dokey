#!/usr/bin/env node
/**
 * vault-tool —— .okeyvault 加密备份包的离线命令行工具。
 *
 * 为什么需要它：迁移方案建立在「一个带口令的加密包」上。如果 App 无法运行
 * （设备故障、换机中途、系统不兼容），用户仍应能把密钥救出来。这个工具只依赖
 * Node 内置模块，任何装了 Node 的电脑都能跑——不依赖 Electron、不依赖安卓。
 *
 * 用法：
 *   node scripts/vault-tool.js inspect <file.okeyvault>
 *        查看备份包元信息（不收口令，不解密）
 *
 *   node scripts/vault-tool.js verify <file.okeyvault> -p <passphrase>
 *        校验口令是否正确（只验证，不输出任何密钥）
 *
 *   node scripts/vault-tool.js decrypt <file.okeyvault> -p <passphrase> -o out.json
 *        解密为明文 JSON（供人工抢救；请妥善保管输出文件）
 *
 *   node scripts/vault-tool.js list <file.okeyvault> -p <passphrase>
 *        列出记录概要（掩码，不显示明文密钥）
 *
 *   node scripts/vault-tool.js reencrypt <in.okeyvault> -p <old> -n <new> -o out.okeyvault
 *        换口令（重新加密）
 *
 *   node scripts/vault-tool.js convert <plain.json> -n <passphrase> -o out.okeyvault
 *        把明文 JSON 装回加密包
 *
 *   node scripts/vault-tool.js plaintext-check <file>
 *        检查一个文件里是否含明文密钥（安全自检）
 *
 * 安全说明：本工具在内存中处理明文，不写日志、不联网。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FORMAT = 'okey-dokey-export';
const N_EXPORT = 1 << 15;
const R = 8;
const P = 1;

/* ------------------------------ 加解密（与两端同算法） ------------------------------ */

function keyFromPassphrase(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: N_EXPORT, r: R, p: P, maxmem: 128 * 1024 * 1024 });
}

function encryptWithPassphrase(obj, passphrase, meta = {}) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = keyFromPassphrase(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  return {
    format: FORMAT,
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64'),
    createdAt: meta.createdAt || new Date().toISOString(),
    producer: meta.producer || 'vault-tool',
    producerVersion: meta.producerVersion || '1.1.0',
    recordCount: meta.recordCount != null ? meta.recordCount : undefined
  };
}

function decryptWithPassphrase(pkg, passphrase) {
  const salt = Buffer.from(pkg.salt, 'base64');
  const iv = Buffer.from(pkg.iv, 'base64');
  const key = keyFromPassphrase(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(pkg.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(pkg.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/* ------------------------------ 工具函数 ------------------------------ */

function mask(value, style = 'prefix') {
  const s = String(value || '');
  if (!s) return '';
  const tail = s.length >= 4 ? s.slice(-4) : s;
  const head = s.length > 12 ? s.slice(0, 4) : '';
  if (style === 'tail') return `••••••••${tail}`;
  if (style === 'full') return '•'.repeat(s.length > 12 ? 12 : 8);
  return head ? `${head}••••••••${tail}` : `••••••••${tail}`;
}

function readPackage(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('不是合法 JSON —— 可能文件损坏或不是本项目的备份包');
  }
  return parsed;
}

function asPackage(parsed, file) {
  if (!parsed || parsed.format !== FORMAT) {
    throw new Error(`不是本项目的加密备份包（缺少 format="${FORMAT}"）: ${file}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p') out.p = argv[++i];
    else if (a === '-n') out.n = argv[++i];
    else if (a === '-o') out.o = argv[++i];
    else out._.push(a);
  }
  return out;
}

function die(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/* ------------------------------ 子命令 ------------------------------ */

function cmdInspect(args) {
  const file = args._[0];
  if (!file) die('用法: vault-tool inspect <file.okeyvault>');
  const pkg = asPackage(readPackage(file), file);
  const stat = fs.statSync(file);

  console.log('备份包信息 / package info');
  console.log('─'.repeat(50));
  console.log(`文件        ${file}`);
  console.log(`大小        ${humanSize(stat.size)}`);
  console.log(`格式        ${pkg.format} v${pkg.version}`);
  console.log(`KDF         ${pkg.kdf} (N=${N_EXPORT}, r=${R}, p=${P})`);
  console.log(`加密        AES-256-GCM (128-bit tag)`);
  if (pkg.createdAt) console.log(`导出时间    ${pkg.createdAt}`);
  if (pkg.producer) console.log(`导出端      ${pkg.producer}${pkg.producerVersion ? ' ' + pkg.producerVersion : ''}`);
  if (pkg.recordCount != null) console.log(`记录数      ${pkg.recordCount}`);
  console.log('');
  console.log('提示：内容已加密，需口令才能读取。用 `verify` 校验口令。');
}

function cmdVerify(args) {
  const file = args._[0];
  if (!file) die('用法: vault-tool verify <file.okeyvault> -p <口令>');
  if (!args.p) die('缺少口令 -p');
  const pkg = asPackage(readPackage(file), file);
  try {
    const payload = decryptWithPassphrase(pkg, args.p);
    const n = Array.isArray(payload.records) ? payload.records.length : 0;
    console.log(`✓ 口令正确，可解密。包含 ${n} 条记录。`);
  } catch (_) {
    console.log('✗ 口令错误，或文件已损坏（GCM 认证失败）。');
    process.exit(2);
  }
}

function cmdList(args) {
  const file = args._[0];
  if (!file) die('用法: vault-tool list <file.okeyvault> -p <口令>');
  if (!args.p) die('缺少口令 -p');
  const pkg = asPackage(readPackage(file), file);
  let payload;
  try {
    payload = decryptWithPassphrase(pkg, args.p);
  } catch (_) {
    die('口令错误，或文件已损坏');
  }
  const records = Array.isArray(payload.records) ? payload.records : [];
  console.log(`共 ${records.length} 条记录（密钥仅显示掩码）`);
  console.log('─'.repeat(70));
  records.forEach((r, i) => {
    const tags = (r.tags || []).join(', ');
    console.log(`${String(i + 1).padStart(3)}. [${r.provider || '?'}] ${r.label || '(无名称)'}`);
    console.log(`     密钥 ${mask(r.credential)}   长度 ${(r.credential || '').length}`);
    if (tags) console.log(`     标签 ${tags}`);
    if (r.note) console.log(`     备注 ${String(r.note).split('\n')[0].slice(0, 60)}`);
  });
}

function cmdDecrypt(args) {
  const file = args._[0];
  if (!file) die('用法: vault-tool decrypt <file.okeyvault> -p <口令> [-o out.json]');
  if (!args.p) die('缺少口令 -p');
  const pkg = asPackage(readPackage(file), file);
  let payload;
  try {
    payload = decryptWithPassphrase(pkg, args.p);
  } catch (_) {
    die('口令错误，或文件已损坏');
  }
  const out = args.o || file.replace(/\.(okeyvault|json)$/i, '') + '.plain.json';
  fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
  const n = Array.isArray(payload.records) ? payload.records.length : 0;
  console.log(`✓ 已解密 ${n} 条记录 → ${out}`);
  console.log('⚠ 该文件含明文密钥。用完请立即删除，勿留在云盘或共享目录。');
}

function cmdReencrypt(args) {
  const file = args._[0];
  if (!file) die('用法: vault-tool reencrypt <in.okeyvault> -p <旧口令> -n <新口令> [-o out.okeyvault]');
  if (!args.p) die('缺少旧口令 -p');
  if (!args.n) die('缺少新口令 -n');
  if (String(args.n).length < 6) die('新口令至少 6 位');
  const pkg = asPackage(readPackage(file), file);
  let payload;
  try {
    payload = decryptWithPassphrase(pkg, args.p);
  } catch (_) {
    die('旧口令错误，或文件已损坏');
  }
  const out = args.o || file.replace(/\.okeyvault$/i, '') + '.rekeyed.okeyvault';
  const next = encryptWithPassphrase(payload, args.n, {
    producer: 'vault-tool',
    recordCount: Array.isArray(payload.records) ? payload.records.length : 0
  });
  fs.writeFileSync(out, JSON.stringify(next, null, 2), 'utf8');
  console.log(`✓ 已用新口令重新加密 → ${out}`);
}

function cmdConvert(args) {
  const file = args._[0];
  if (!file) die('用法: vault-tool convert <plain.json> -n <口令> [-o out.okeyvault]');
  if (!args.n) die('缺少口令 -n');
  if (String(args.n).length < 6) die('口令至少 6 位');
  const payload = readPackage(file);
  if (!Array.isArray(payload.records)) die('输入 JSON 缺少 records 数组');
  const out = args.o || file.replace(/\.json$/i, '') + '.okeyvault';
  const pkg = encryptWithPassphrase(payload, args.n, {
    producer: 'vault-tool',
    recordCount: payload.records.length
  });
  fs.writeFileSync(out, JSON.stringify(pkg, null, 2), 'utf8');
  console.log(`✓ 已加密 ${payload.records.length} 条记录 → ${out}`);
}

function cmdPlaintextCheck(args) {
  const file = args._[0];
  if (!file) die('用法: vault-tool plaintext-check <file>');
  if (!fs.existsSync(file)) die(`文件不存在: ${file}`);
  const raw = fs.readFileSync(file);
  const text = raw.toString('utf8');

  const findings = [];

  // 1. 是否是可被直接读到的 JSON 且含 credential 字段
  try {
    const obj = JSON.parse(text);
    if (obj && Array.isArray(obj.records)) {
      const withCred = obj.records.filter((r) => r && typeof r.credential === 'string' && r.credential.length > 0);
      if (withCred.length) findings.push(`明文 JSON 中含 ${withCred.length} 条 credential`);
    }
  } catch (_) { /* 非 JSON，继续做特征扫描 */ }

  // 2. 常见密钥前缀特征
  const patterns = [
    [/\bsk-[A-Za-z0-9_\-]{16,}/g, 'OpenAI 风格 sk- 密钥'],
    [/\bsk-ant-[A-Za-z0-9_\-]{16,}/g, 'Anthropic 风格 sk-ant- 密钥'],
    [/\bAIza[0-9A-Za-z_\-]{30,}/g, 'Google API Key'],
    [/\bghp_[A-Za-z0-9]{30,}/g, 'GitHub Token'],
    [/\bBearer\s+[A-Za-z0-9._\-]{20,}/g, 'Bearer Token']
  ];
  for (const [re, label] of patterns) {
    const m = text.match(re);
    if (m && m.length) findings.push(`命中 ${label} × ${m.length}`);
  }

  // 3. 是否是本项目的加密包（那就是安全的）
  try {
    const obj = JSON.parse(text);
    if (obj && obj.format === FORMAT && obj.data) {
      console.log('✓ 这是加密备份包（.okeyvault），内容为密文。');
      if (!findings.length) { console.log('  未发现明文密钥特征。'); return; }
    }
  } catch (_) {}

  if (findings.length) {
    console.log('⚠ 发现可能的明文密钥:');
    for (const f of findings) console.log(`  - ${f}`);
    console.log('\n建议：删除该文件，或改用 `convert` 加密后再保管。');
    process.exit(3);
  }
  console.log('✓ 未发现明文密钥特征。');
}

function usage() {
  console.log(`vault-tool —— Okey Dokey 加密备份包离线工具

用法: node scripts/vault-tool.js <命令> [参数]

命令:
  inspect <file.okeyvault>                       查看包信息（不需口令）
  verify  <file.okeyvault> -p <口令>              校验证口令
  list    <file.okeyvault> -p <口令>              列出记录（掩码）
  decrypt <file.okeyvault> -p <口令> [-o out]     解密为明文 JSON
  reencrypt <in.okeyvault> -p <旧> -n <新> [-o out]  更换口令
  convert <plain.json> -n <口令> [-o out]         明文 JSON 装回加密包
  plaintext-check <file>                          检查是否含明文密钥

说明: 迁移数据的正确载体是 .okeyvault（带口令的加密包）。
     本机数据目录里的 vault.enc + device.key 不可跨设备使用。`);
}

/* ------------------------------ 入口 ------------------------------ */

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case 'inspect': return cmdInspect(args);
    case 'verify': return cmdVerify(args);
    case 'list': return cmdList(args);
    case 'decrypt': return cmdDecrypt(args);
    case 'reencrypt': return cmdReencrypt(args);
    case 'convert': return cmdConvert(args);
    case 'plaintext-check': return cmdPlaintextCheck(args);
    case undefined:
    case '-h':
    case '--help':
    case 'help': return usage();
    default:
      console.error(`未知命令: ${cmd}\n`);
      usage();
      process.exit(1);
  }
}

main();
