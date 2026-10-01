/**
 * CLI 支撑层：读取密钥库、把「选择器」解析成具体记录、派生环境变量名。
 *
 * 只读设计：本模块**不写入**任何数据文件。CLI 存在的意义是「把 key 取出来用」，
 * 不承担修改密钥库的职责——写入留给桌面端/安卓端，避免两个进程同时改同一个
 * vault.enc 造成覆盖丢数据。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { decryptJSON } = require('../main/crypto');
const { maskCredential } = require('../main/store');
const { loadAliases, resolveAlias } = require('./aliases');

/** 退出码约定：便于脚本判断失败原因，而不是只看「非零」 */
const EXIT = {
  OK: 0,
  ERROR: 1,
  NOT_FOUND: 2,
  AMBIGUOUS: 3,
  VAULT: 4,
  USAGE: 5
};

class CliError extends Error {
  constructor(message, code = EXIT.ERROR, extra) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.extra = extra || null;
  }
}

/**
 * 服务商 → 环境变量名。
 *
 * 采用各家 SDK 真正会读的名字（而不是机械的 `{PROVIDER}_KEY`），
 * 这样 `okey run -- python app.py` 无需改一行业务代码就能生效——
 * 这才是 CLI 注入的价值所在。
 */
const PROVIDER_ENV = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',        // 阿里云百炼/通义官方使用 DASHSCOPE_API_KEY
  moonshot: 'MOONSHOT_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  baichuan: 'BAICHUAN_API_KEY',
  stepfun: 'STEPFUN_API_KEY',
  spark: 'SPARK_API_KEY',
  hunyuan: 'HUNYUAN_API_KEY',
  doubao: 'ARK_API_KEY',            // 火山方舟官方变量名
  siliconflow: 'SILICONFLOW_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  cohere: 'COHERE_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  together: 'TOGETHER_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_API_KEY'
  // 注意：'custom' 刻意不在此表中。
  // 自建/中转端点的记录无法推断官方变量名——若给一个通用的 CUSTOM_API_KEY，
  // 多条自建记录会撞到同一个名字，且 SDK 也不认它。因此 custom 必须由用户
  // 用 `okey alias` 显式指定（见 envNameFor 的注释）。
};

/** 各平台 Electron 的 userData 默认位置 */
function defaultVaultDir() {
  if (process.env.OKEY_DOKEY_HOME) return process.env.OKEY_DOKEY_HOME;

  const appName = 'Okey Dokey';
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, appName, 'vault');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName, 'vault');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, appName, 'vault');
}

/**
 * 读取并解密密钥库。
 * 每种失败给出可操作的提示，而不是把底层异常直接抛给用户。
 */
function loadVault(dir) {
  const vaultDir = dir || defaultVaultDir();
  const vaultPath = path.join(vaultDir, 'vault.enc');
  const keyPath = path.join(vaultDir, 'device.key');
  const settingsPath = path.join(vaultDir, 'settings.json');

  if (!fs.existsSync(vaultDir)) {
    throw new CliError(
      `数据目录不存在：${vaultDir}\n` +
      '  请先运行一次 Okey Dokey 桌面端以创建密钥库，或用 --dir / OKEY_DOKEY_HOME 指定其他目录。',
      EXIT.VAULT
    );
  }
  if (!fs.existsSync(vaultPath)) {
    throw new CliError(`找不到 vault.enc：${vaultPath}`, EXIT.VAULT);
  }
  if (!fs.existsSync(keyPath)) {
    throw new CliError(
      `找不到 device.key：${keyPath}\n` +
      '  本机密钥库必须与它配套的 device.key 一起使用，二者不可分开拷贝。',
      EXIT.VAULT
    );
  }

  const keyMaterial = fs.readFileSync(keyPath, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(keyMaterial)) {
    throw new CliError(`device.key 格式不正确（应为 64 位十六进制）：${keyPath}`, EXIT.VAULT);
  }

  let data;
  try {
    data = decryptJSON(fs.readFileSync(vaultPath, 'utf8'), keyMaterial);
  } catch (_) {
    throw new CliError(
      '无法解密密钥库。可能原因：device.key 与 vault.enc 不配套，或文件已损坏。\n' +
      '  提示：跨设备的正确做法是导入 .okeyvault 备份包，而不是拷贝数据目录。',
      EXIT.VAULT
    );
  }
  if (!Array.isArray(data.records)) data.records = [];

  let settings = { privacy: { maskStyle: 'prefix' } };
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (_) { /* 设置不存在时用默认掩码样式 */ }

  const aliases = loadAliases(vaultDir);

  return { data, settings, aliases, dir: vaultDir, vaultPath };
}

/** 记录对外快照（永远不含密钥明文） */
function publicRecord(rec, settings) {
  const style = (settings && settings.privacy && settings.privacy.maskStyle) || 'prefix';
  return {
    id: rec.id,
    provider: rec.provider,
    label: rec.label,
    tags: rec.tags || [],
    note: rec.note || '',
    baseUrl: rec.baseUrl || '',
    models: rec.models || '',
    favorite: !!rec.favorite,
    disabled: !!rec.disabled,
    updatedAt: rec.updatedAt,
    usageCount: rec.usageCount || 0,
    mask: maskCredential(rec.credential, style),
    length: (rec.credential || '').length
  };
}

/**
 * 把选择器解析成候选记录。
 *
 * 支持的形式（按优先级）：
 *   @<id前缀>            按记录 id 前缀
 *   <provider>:<tag>     指定服务商下的某个标签
 *   <label>              标题精确匹配
 *   <provider>           服务商 id
 *   <片段>               标题/标签的子串匹配（仅在唯一时才接受）
 *
 * tagOpt 为 --tag 指定的标签，作为额外过滤条件叠加。
 */
function matchRecords(records, selector, tagOpt) {
  const sel = String(selector == null ? '' : selector).trim();
  let candidates = records.slice();

  if (tagOpt) {
    const want = String(tagOpt).trim().toLowerCase();
    candidates = candidates.filter((r) => (r.tags || []).some((t) => String(t).toLowerCase() === want));
  }

  if (!sel) return candidates;

  // @id 前缀
  if (sel.startsWith('@')) {
    const prefix = sel.slice(1).toLowerCase();
    return candidates.filter((r) => String(r.id || '').toLowerCase().startsWith(prefix));
  }

  // provider:tag
  if (sel.includes(':')) {
    const idx = sel.indexOf(':');
    const prov = sel.slice(0, idx).trim().toLowerCase();
    const tg = sel.slice(idx + 1).trim().toLowerCase();
    return candidates.filter((r) =>
      String(r.provider || '').toLowerCase() === prov &&
      (r.tags || []).some((t) => String(t).toLowerCase() === tg)
    );
  }

  // 标题精确匹配
  const exact = candidates.filter((r) => String(r.label || '') === sel);
  if (exact.length) return exact;

  // 服务商 id
  const byProvider = candidates.filter((r) => String(r.provider || '').toLowerCase() === sel.toLowerCase());
  if (byProvider.length) return byProvider;

  // 子串匹配（标题或标签）
  const lower = sel.toLowerCase();
  const fuzzy = candidates.filter((r) =>
    String(r.label || '').toLowerCase().includes(lower) ||
    (r.tags || []).some((t) => String(t).toLowerCase().includes(lower))
  );
  return fuzzy;
}

/** 选中恰好一条；0 条或 ≥2 条都抛出带候选列表的错误 */
function pickOne(vault, selector, tagOpt) {
  const all = vault.data.records;
  const hits = matchRecords(all, selector, tagOpt);

  if (hits.length === 0) {
    throw new CliError(
      `没有找到匹配「${selector}」的密钥（共 ${all.length} 条记录）。\n` +
      '  用 `okey list` 查看可用记录。',
      EXIT.NOT_FOUND
    );
  }
  if (hits.length > 1) {
    // 多条时绝不「随便挑一个」——选错密钥去跑生产任务，比报错严重得多
    const lines = hits.map((r) => `    - ${describe(r, vault.settings)}`);
    throw new CliError(
      `「${selector}」匹配到 ${hits.length} 条记录，需要更精确的指定：\n` +
      lines.join('\n') + '\n' +
      '  可用方式：`<服务商>:<标签>`（如 openai:生产）、`--tag <标签>`、或者标题精确匹配。',
      EXIT.AMBIGUOUS
    );
  }
  return hits[0];
}

/** 单行描述（供候选列表与 which 使用，不含明文） */
function describe(rec, settings) {
  const pub = publicRecord(rec, settings);
  const tags = pub.tags.length ? ` [${pub.tags.join(', ')}]` : '';
  return `${pub.provider} · ${pub.label}${tags} · ${pub.mask}`;
}

/** 把非字母数字转成下划线并大写，用于从标题派生变量名 */
function sanitizeVarName(s) {
  return String(s || '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * 为一条记录派生环境变量名。
 *
 * 优先级：显式别名 > 内置服务商表 > 标题派生。
 *
 * 故意**不**为 custom 服务商按标题猜官方变量名（例如标题 "Claude" 猜
 * ANTHROPIC_API_KEY）：猜错不会报错，只会让 SDK 读不到 key——这是最坏的一类
 * 故障。因此猜不出时返回 null，由调用方提示用户用 `okey alias` 显式指定。
 */
function envNameFor(rec, opts = {}) {
  const prefix = opts.prefix ? sanitizeVarName(opts.prefix) + '_' : '';
  const provider = String(rec.provider || '').toLowerCase();

  // 1. 显式别名优先
  const alias = resolveAlias(rec, opts.aliases);
  if (alias) return prefix + sanitizeVarName(alias);

  // 2. 内置服务商表
  if (PROVIDER_ENV[provider]) return prefix + PROVIDER_ENV[provider];

  // 3. custom / 未知服务商：只有标题本身就是标准变量名时才接受
  const fromLabel = sanitizeVarName(rec.label);
  if (fromLabel.endsWith('_API_KEY') || fromLabel.endsWith('_KEY') || fromLabel.endsWith('_TOKEN')) {
    return prefix + fromLabel;
  }

  return null;
}

/** 为一条记录派生 base URL 变量名；无法确定时返回 null */
function baseUrlNameFor(rec, opts = {}) {
  if (!rec.baseUrl) return null;
  const prefix = opts.prefix ? sanitizeVarName(opts.prefix) + '_' : '';
  const provider = String(rec.provider || '').toLowerCase();

  const alias = resolveAlias(rec, opts.aliases);
  if (alias) {
    const a = sanitizeVarName(alias);
    return prefix + (a.endsWith('_API_KEY') ? a.replace(/_API_KEY$/, '_BASE_URL') : a + '_BASE_URL');
  }

  if (PROVIDER_ENV[provider]) {
    return prefix + PROVIDER_ENV[provider].replace(/_API_KEY$/, '_BASE_URL');
  }

  const fromLabel = sanitizeVarName(rec.label);
  if (fromLabel.endsWith('_API_KEY') || fromLabel.endsWith('_KEY') || fromLabel.endsWith('_TOKEN')) {
    return prefix + fromLabel.replace(/_(API_KEY|KEY|TOKEN)$/, '_BASE_URL');
  }

  return null;
}

/**
 * 把若干记录展开成「变量名 → 值」。
 *
 * 返回 { assignments, skipped, conflicts }：
 *   skipped   记录无法派生变量名的条目——默认跳过并提示，
 *             而不是让一个纯中文标题的自建记录把整条 env 输出打断。
 *   conflicts 变量名冲突列表。默认**直接抛错**：两个不同的 key 抢同一个
 *             变量名，静默覆盖是危险的（选错密钥去跑生产任务比报错严重）。
 *             opts.collectConflicts = true 时不抛错、改为收集——供 doctor
 *             这类诊断场景一次性报出全部问题。
 */
function buildAssignments(records, opts = {}) {
  const assignments = new Map();
  const skipped = [];
  const conflicts = [];
  const withBaseUrl = opts.withBaseUrl !== false;

  for (const rec of records) {
    const name = envNameFor(rec, opts);
    if (!name) {
      skipped.push({
        record: rec,
        reason: '无法确定环境变量名（自建/中转端点需显式指定）',
        hint: `okey alias "${rec.label}" <你的变量名>`
      });
      continue;
    }
    if (assignments.has(name)) {
      const prev = assignments.get(name);
      if (prev.record.id !== rec.id) {
        const c = { name, first: prev.record, second: rec };
        if (opts.collectConflicts) { conflicts.push(c); continue; }
        throw new CliError(
          `变量名冲突：${name}\n` +
          `    已被「${prev.record.label}」占用，却被「${rec.label}」再次使用。\n` +
          '  请用 `--tag` 或 `<服务商>:<标签>` 缩小范围，或 `--prefix` 加前缀区分。',
          EXIT.AMBIGUOUS
        );
      }
      continue;
    }
    if (!rec.credential) {
      skipped.push({ record: rec, reason: '该记录没有密钥内容', hint: null });
      continue;
    }
    assignments.set(name, { value: rec.credential, record: rec, kind: 'key' });

    if (withBaseUrl) {
      const bname = baseUrlNameFor(rec, opts);
      if (bname && !assignments.has(bname)) {
        assignments.set(bname, { value: rec.baseUrl, record: rec, kind: 'baseUrl' });
      }
    }
  }

  return { assignments, skipped, conflicts };
}

module.exports = {
  EXIT,
  CliError,
  PROVIDER_ENV,
  defaultVaultDir,
  loadVault,
  publicRecord,
  matchRecords,
  pickOne,
  describe,
  sanitizeVarName,
  envNameFor,
  baseUrlNameFor,
  buildAssignments
};
