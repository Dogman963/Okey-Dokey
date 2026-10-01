/**
 * 变量名别名表：把「记录」映射到「你希望注入的环境变量名」。
 *
 * 为什么必须有这个：provider 为 custom 的记录（自建/中转端点）无法从服务商
 * 推断出官方 SDK 期望的变量名。按标题猜是危险的——标题写 "Claude" 就派生出
 * CLAUDE_API_KEY，而 Anthropic SDK 只读 ANTHROPIC_API_KEY，注入等于没注入，
 * 而且不会报错，只是行为不对（最坏的一类故障）。
 *
 * 所以：猜不出来时要求用户显式指定一次，之后一直生效。
 *
 * 存放位置：与 vault.enc 同目录的 aliases.json。它**不含密钥**，只存名字映射，
 * 因此可以安全地纳入版本控制或随手复制——这一点是刻意的。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const FILENAME = 'aliases.json';

function aliasesPath(vaultDir) {
  return path.join(vaultDir, FILENAME);
}

function emptyAliases() {
  return { version: 1, map: {} };
}

function loadAliases(vaultDir) {
  const p = aliasesPath(vaultDir);
  if (!fs.existsSync(p)) return emptyAliases();
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!obj || typeof obj !== 'object') return emptyAliases();
    if (!obj.map || typeof obj.map !== 'object') obj.map = {};
    return obj;
  } catch (_) {
    // 别名表损坏不应阻断取用密钥——CLI 的核心职责是取出 key
    return emptyAliases();
  }
}

function saveAliases(vaultDir, aliases) {
  const p = aliasesPath(vaultDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 原子写：先写临时文件再改名，避免写一半损坏
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(aliases, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return p;
}

/**
 * 解析一条记录应使用的变量名（未命中返回 null）。
 *
 * 匹配优先级（越靠前越具体，避免宽泛规则覆盖精确规则）：
 *   1. 记录自带的 envName 字段（未来图形端可写入）
 *   2. 记录 id
 *   3. <服务商>:<标签>
 *   4. 标题
 *   5. 服务商 id
 */
function resolveAlias(rec, aliases) {
  if (!aliases) return null;
  if (rec.envName) return String(rec.envName);

  const map = aliases.map || {};
  if (rec.id && map[rec.id]) return String(map[rec.id]);

  for (const t of rec.tags || []) {
    const key = `${rec.provider}:${t}`;
    if (map[key]) return String(map[key]);
  }
  if (rec.label && map[rec.label]) return String(map[rec.label]);
  if (rec.provider && map[rec.provider]) return String(map[rec.provider]);
  return null;
}

module.exports = { FILENAME, aliasesPath, emptyAliases, loadAliases, saveAliases, resolveAlias };
