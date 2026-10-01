/**
 * 对照构建：用不同压缩率打包便携版，用于定位启动耗时来源。
 * 运行：node tools/build-variants.js store,normal
 *
 * 说明：用 Node 读写 package.json（UTF-8 安全），构建结束后无论如何都会还原原文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const original = fs.readFileSync(PKG, 'utf8');

const levels = (process.argv[2] || 'store,normal').split(',').map((s) => s.trim()).filter(Boolean);
const allowed = ['store', 'normal', 'maximum'];

function run(cmd, args) {
  return spawnSync(cmd, args, { cwd: ROOT, shell: true, encoding: 'utf8' });
}

const report = [];

try {
  for (const level of levels) {
    if (!allowed.includes(level)) {
      console.log(`SKIP unknown compression level: ${level}`);
      continue;
    }
    const cfg = JSON.parse(original);
    cfg.build.compression = level;
    cfg.build.directories.output = `dist-${level}`;
    fs.writeFileSync(PKG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    console.log(`=== building compression=${level} -> dist-${level} ===`);
    const res = run('npx', ['electron-builder', '--win', 'portable']);
    const tail = (res.stdout || '').split(/\r?\n/).filter((l) => /building|error/i.test(l)).slice(-3);
    tail.forEach((l) => console.log('   ' + l.trim()));

    const artifact = path.join(ROOT, `dist-${level}`, 'Okey-Dokey-1.0.0-portable.exe');
    if (fs.existsSync(artifact)) {
      const mb = fs.statSync(artifact).size / 1024 / 1024;
      report.push({ level, mb: Number(mb.toFixed(1)), ok: true });
      console.log(`   SIZE ${level}: ${mb.toFixed(1)} MB`);
    } else {
      report.push({ level, ok: false, err: res.error ? String(res.error) : 'no artifact' });
      console.log(`   FAILED ${level}`);
    }
  }
} finally {
  fs.writeFileSync(PKG, original, 'utf8');
  const restored = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  console.log(JSON.stringify({
    packageJsonRestored: true,
    compression: restored.build.compression,
    output: restored.build.directories.output,
    descriptionIntact: restored.description.startsWith('大模型'),
    variants: report
  }, null, 2));
}
