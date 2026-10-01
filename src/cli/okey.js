#!/usr/bin/env node
/**
 * okey —— Okey Dokey 命令行取用工具。
 *
 * 存在理由：密钥库里存着的 key，只有在能用进真正干活的地方（SDK、脚本、CI）
 * 才算有价值。手动「打开 App → 显示 → 复制 → 切窗口 → 粘贴」用两天就会退回
 * .env 文件。这个 CLI 就是把那一步变成一行命令。
 *
 * 设计取舍：
 *   - **只读**：不写 vault.enc。写入留给图形端，避免两进程互相覆盖。
 *   - **默认不打印明文**：只有 `get` / `env` / `run` 会把 key 交出去，
 *     `list` / `which` 只给掩码。
 *   - **run 优先于 env**：`okey run -- cmd` 让 key 只存在于子进程环境里，
 *     不落进任何文件、不进 shell 历史。
 *   - 零依赖：只用 Node 内置模块，任何装了 Node 的机器都能跑。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  EXIT, CliError,
  defaultVaultDir, loadVault, publicRecord,
  matchRecords, pickOne, describe,
  buildAssignments, envNameFor, sanitizeVarName
} = require('./resolve');
const { aliasesPath, saveAliases } = require('./aliases');

const VERSION = '1.2.3';
const PROG = 'okey';

/* ------------------------------ 输出工具 ------------------------------ */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (useColor ? `\x1b[31m${s}\x1b[0m` : s)
};

function out(s) { process.stdout.write(s + '\n'); }
function warn(s) { process.stderr.write(c.yellow('提示: ') + s + '\n'); }
function fail(msg, code) {
  process.stderr.write(c.red('错误: ') + msg + '\n');
  process.exit(code == null ? EXIT.ERROR : code);
}

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const opts = { _: [], tags: [], only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-d': case '--dir': opts.dir = argv[++i]; break;
      case '-t': case '--tag': opts.tags.push(argv[++i]); break;
      case '-p': case '--prefix': opts.prefix = argv[++i]; break;
      case '--only': opts.only.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)); break;
      case '--all': opts.all = true; break;
      case '--favorites': case '-f': opts.favorites = true; break;
      case '--json': opts.json = true; break;
      case '--no-base-url': opts.withBaseUrl = false; break;
      case '--copy': opts.copy = true; break;
      case '--unmask': case '--reveal': opts.unmask = true; break;
      case '--shell': opts.shell = argv[++i]; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--quiet': case '-q': opts.quiet = true; break;
      case '--verbose': opts.verbose = true; break;
      case '-h': case '--help': opts.help = true; break;
      case '-V': case '--version': opts.version = true; break;
      case '--': opts.rest = argv.slice(i + 1); i = argv.length; break;
      default:
        if (a.startsWith('-') && a !== '-') { opts.unknown = a; }
        else opts._.push(a);
    }
  }
  return opts;
}

const tagOpt = (opts) => (opts.tags.length ? opts.tags[0] : undefined);

/* ------------------------------ 剪贴板 ------------------------------ */

/**
 * 复制到剪贴板。Windows 用内置 clip.exe，避免引入依赖。
 * 不引入「自动清空」——CLI 是短命进程，清空定时器随进程一起消失，
 * 承诺了也做不到，不如不承诺（图形端才有条件做这件事）。
 */
function copyToClipboard(text) {
  if (process.platform === 'win32') {
    const p = spawn('clip', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(text);
    return new Promise((resolve) => p.on('close', (code) => resolve(code === 0)));
  }
  if (process.platform === 'darwin') {
    const p = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.stdin.end(text);
    return new Promise((resolve) => p.on('close', (code) => resolve(code === 0)));
  }
  // Linux：尝试常见实现
  for (const cmd of ['xclip', 'xsel', 'wl-copy']) {
    try {
      const args = cmd === 'xclip' ? ['-selection', 'clipboard'] : cmd === 'xsel' ? ['--clipboard', '--input'] : [];
      const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      p.stdin.end(text);
      return new Promise((resolve) => p.on('close', (code) => resolve(code === 0)));
    } catch (_) { /* 试下一个 */ }
  }
  return Promise.resolve(false);
}

/* ------------------------------ 子命令 ------------------------------ */

function cmdList(vault, opts) {
  let records = vault.data.records;

  if (opts.favorites) records = records.filter((r) => r.favorite);

  // --only 支持服务商列表或选择器列表
  if (opts.only.length) {
    const picked = [];
    for (const sel of opts.only) {
      const hits = matchRecords(records, sel, tagOpt(opts));
      for (const h of hits) if (!picked.includes(h)) picked.push(h);
    }
    records = picked;
  } else if (opts._.length) {
    records = matchRecords(records, opts._[0], tagOpt(opts));
  }

  const sorted = records.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  if (opts.json) {
    out(JSON.stringify(sorted.map((r) => {
      const p = publicRecord(r, vault.settings);
      return opts.unmask ? p : { ...p, mask: p.mask };
    }), null, 2));
    return EXIT.OK;
  }

  if (!sorted.length) {
    out(c.dim(`没有匹配的记录（库中共 ${vault.data.records.length} 条）`));
    return EXIT.OK;
  }

  const byProvider = sorted.reduce((m, r) => (m[r.provider] = (m[r.provider] || 0) + 1, m), {});

  out('');
  out(c.bold(`  ${sorted.length} 条记录`) + c.dim(`  ·  ${Object.entries(byProvider).map(([k, v]) => `${k}×${v}`).join('  ')}`));
  out(c.dim('  ' + '─'.repeat(66)));

  for (const r of sorted) {
    const p = publicRecord(r, vault.settings);
    const star = p.favorite ? c.yellow('★ ') : '  ';
    const tags = p.tags.length ? c.dim(` [${p.tags.join(', ')}]`) : '';
    const fav = p.favorite ? c.yellow('★') : ' ';
    // 密钥恒为掩码：list 永远不输出明文
    out(`  ${star}${p.provider}${c.dim(' · ')}${p.label}${tags}`);
    out(`      ${c.dim(p.mask)}${c.dim(`  ${p.length} 字符`)}${p.models ? c.dim(`  ·  ${p.models}`) : ''}`);
  }
  out('');
  out(c.dim('  用 `okey get <选择器>` 取明文，`okey run -- <命令>` 注入环境变量运行。'));
  out('');
  return EXIT.OK;
}

function cmdGet(vault, opts) {
  const selector = opts._[0];
  if (!selector) throw new CliError('用法: okey get <选择器> [--copy] [--json]', EXIT.USAGE);

  const rec = pickOne(vault, selector, tagOpt(opts));
  const value = rec.credential;
  if (!value) throw new CliError(`记录「${rec.label}」没有密钥内容`, EXIT.NOT_FOUND);

  if (opts.copy) {
    return copyToClipboard(value).then((okCopy) => {
      if (!okCopy) {
        // 复制失败时退回收据模式：提示用户用管道
        warn('复制到剪贴板失败（缺 clip/pbcopy/xclip 等工具）');
        out(value);
        return EXIT.OK;
      }
      if (opts.json) out(JSON.stringify({ id: rec.id, provider: rec.provider, label: rec.label, copied: true }, null, 2));
      else warn(`已复制「${rec.label}」的密钥到剪贴板`);
      return EXIT.OK;
    });
  }

  if (opts.json) {
    out(JSON.stringify({
      id: rec.id, provider: rec.provider, label: rec.label,
      credential: value, baseUrl: rec.baseUrl || '', models: rec.models || ''
    }, null, 2));
    return EXIT.OK;
  }

  // 明文走 stdout，不加任何装饰——方便 $(...) 与管道直接使用
  out(value);
  return EXIT.OK;
}

/**
 * 转义 PowerShell 双引号字符串内部的反字符。
 *
 * 必须处理三个字符，顺序要紧：
 *   1. 反引号本身（转义字符）
 *   2. `$`—— 若不转义，PowerShell 会把它当变量展开，密钥会被静默改掉
 *   3. 双引号
 * 先把反引号换掉，否则后两步插入的反引号会被重复转义。
 */
function psQuote(s) {
  return String(s)
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(/"/g, '`"');
}

/** CMD 的 set 赋值不需要转义，但值里的换行会截断命令，需要拒绝 */
function cmdSafeValue(s) {
  return String(s).replace(/[\r\n]/g, '');
}

function cmdEnv(vault, opts) {
  const records = selectRecords(vault, opts);
  const { assignments, skipped } = buildAssignments(records, {
    prefix: opts.prefix,
    withBaseUrl: opts.withBaseUrl,
    aliases: vault.aliases
  });

  if (!assignments.size) {
    const hints = skipped.map((s) => `    ${s.record.provider} · ${s.record.label}  →  ${s.hint}`).join('\n');
    throw new CliError(
      '没有可输出的变量。' +
      (skipped.length ? `\n以下 ${skipped.length} 条需先指定变量名：\n${hints}` : ''),
      EXIT.NOT_FOUND
    );
  }

  if (opts.json) {
    const obj = {};
    for (const [k, v] of assignments) obj[k] = v.value;
    out(JSON.stringify(obj, null, 2));
    return EXIT.OK;
  }

  for (const [k, v] of assignments) {
    if (opts.shell === 'cmd') out(`set ${k}=${cmdSafeValue(v.value)}`);
    else out(`$env:${k}="${psQuote(v.value)}"`);
  }

  if (!opts.quiet) {
    const names = [...assignments.keys()];
    process.stderr.write(c.dim(
      `\n已输出 ${names.length} 个变量（密钥明文经 stdout，请勿重定向到公共文件）\n` +
      `  用法示例: okey env${opts.prefix ? ` --prefix ${opts.prefix}` : ''} | Invoke-Expression\n` +
      `  更安全:   okey run -- <命令>   （key 只进子进程环境，不落盘）\n`
    ));
  }
  if (skipped.length) {
    warn(`跳过 ${skipped.length} 条无法确定变量名的记录（以下记录未输出，用 okey alias 指定一次即可）：`);
    for (const s of skipped) {
      process.stderr.write(c.dim(`    ${s.record.provider} · ${s.record.label}  →  ${s.hint}\n`));
    }
  }
  return EXIT.OK;
}

/**
 * 决定 env / run 要用哪些记录。
 * 默认「全部」是有意的：CI 里通常就是想把整库注入。
 */
function selectRecords(vault, opts) {
  let records = vault.data.records;

  if (opts.favorites) records = records.filter((r) => r.favorite);

  const selectors = [...opts._.filter((s) => s && !s.startsWith('-')), ...opts.only];
  if (selectors.length) {
    const picked = [];
    for (const sel of selectors) {
      const hits = matchRecords(records, sel, tagOpt(opts));
      if (!hits.length) {
        throw new CliError(`没有找到匹配「${sel}」的密钥（用 \`okey list\` 查看）`, EXIT.NOT_FOUND);
      }
      for (const h of hits) if (!picked.includes(h)) picked.push(h);
    }
    records = picked;
  } else if (opts.tags.length) {
    records = matchRecords(records, '', tagOpt(opts));
  }

  if (!records.length) {
    throw new CliError('没有选中任何记录。', EXIT.NOT_FOUND);
  }
  return records;
}

function cmdRun(vault, opts) {
  const cmd = opts.rest || [];
  if (!cmd.length) {
    throw new CliError(
      '用法: okey run [选择器...] -- <命令> [参数...]\n' +
      '  例: okey run -- python train.py\n' +
      '      okey run openai -- npm test',
      EXIT.USAGE
    );
  }

  const records = selectRecords(vault, opts);
  const { assignments, skipped } = buildAssignments(records, {
    prefix: opts.prefix,
    withBaseUrl: opts.withBaseUrl,
    aliases: vault.aliases
  });

  if (!assignments.size) {
    const hints = skipped.map((s) => `  ${s.record.provider} · ${s.record.label} → ${s.hint}`).join('\n');
    throw new CliError(
      '没有可注入的变量，命令未运行。' +
      (skipped.length ? `\n以下 ${skipped.length} 条需先指定变量名：\n${hints}` : ''),
      EXIT.NOT_FOUND
    );
  }

  // 只把变量交给子进程，不写文件、不进父进程环境
  const env = { ...process.env };
  for (const [k, v] of assignments) env[k] = v.value;

  const names = [...assignments.keys()];

  if (opts.dryRun) {
    out(c.bold('将要运行: ') + cmd.join(' '));
    out(c.bold('注入变量: ') + names.join(', '));
    for (const [k, v] of assignments) {
      // dry-run 只显示长度，不显示明文
      out(`  ${k}=${c.dim(`<${v.kind === 'baseUrl' ? 'url' : 'key'} · ${v.value.length} 字符>`)}`);
    }
    if (skipped.length) out(c.dim(`跳过 ${skipped.length} 条无法派生变量名的记录`));
    return EXIT.OK;
  }

  if (opts.verbose) {
    process.stderr.write(c.dim(`注入 ${names.length} 个变量: ${names.join(', ')}\n`));
  }
  if (skipped.length) {
    warn(`跳过 ${skipped.length} 条无法确定变量名的记录（以下记录未注入，用 okey alias 指定一次即可）：`);
    for (const s of skipped) {
      process.stderr.write(c.dim(`    ${s.record.provider} · ${s.record.label}  →  ${s.hint}\n`));
    }
  }

  const isWin = process.platform === 'win32';
  const useShell = opts.shell ? true : (cmd.length === 1);

  return new Promise((resolve) => {
    const child = useShell
      ? spawn(cmd.join(' '), { env, stdio: 'inherit', shell: isWin ? true : (opts.shell || '/bin/sh') })
      : spawn(cmd[0], cmd.slice(1), { env, stdio: 'inherit', shell: false });

    child.on('error', (err) => {
      process.stderr.write(c.red('错误: ') + `无法启动命令: ${err.message}\n`);
      resolve(EXIT.ERROR);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        process.stderr.write(c.dim(`子进程被信号 ${signal} 终止\n`));
        resolve(EXIT.ERROR);
      } else {
        resolve(code == null ? EXIT.ERROR : code);
      }
    });
  });
}

function cmdWhich(vault, opts) {
  const selector = opts._[0];
  if (!selector) throw new CliError('用法: okey which <选择器>', EXIT.USAGE);

  const hits = matchRecords(vault.data.records, selector, tagOpt(opts));
  if (!hits.length) {
    out(c.red('未找到'));
    return EXIT.NOT_FOUND;
  }

  for (const r of hits) {
    const p = publicRecord(r, vault.settings);
    out('');
    out(`  ${c.bold(p.label)}  ${c.dim('(' + p.provider + ')')}`);
    out(`    密钥    ${p.mask} ${c.dim(`(${p.length} 字符)`)}`);
    if (p.tags.length) out(`    标签    ${p.tags.join(', ')}`);
    if (p.baseUrl) out(`    端点    ${p.baseUrl}`);
    if (p.models) out(`    模型    ${p.models}`);
    if (p.note) out(`    备注    ${p.note.split('\n')[0]}`);
    out(`    环境变量 ${c.green(envNameFor(r, { prefix: opts.prefix, aliases: vault.aliases }) || '(未指定，用 okey alias 设置)')}`);
    out(`    最近更新 ${p.updatedAt}`);
  }
  out('');
  return EXIT.OK;
}

function cmdAlias(vault, opts) {
  const target = opts._[0];
  const varName = opts._[1];

  if (!target && !varName) {
    const map = vault.aliases.map || {};
    const entries = Object.entries(map);
    out('');
    out(c.bold('  变量名映射') + c.dim(`  (${aliasesPath(vault.dir)})`));
    out(c.dim('  ' + '─'.repeat(60)));
    if (!entries.length) {
      out(c.dim('  （空）'));
      out('');
      out(c.dim('  自建/中转端点的记录无法自动推出变量名。指定一次，变量名填对应 SDK 实际读取的名字：'));
      out(c.dim('    okey alias "Claude" ANTHROPIC_API_KEY'));
      out(c.dim('    okey alias "Gpt"    OPENAI_API_KEY'));
    } else {
      for (const [k, v] of entries) out(`  ${c.green(v)}  ${c.dim('←')}  ${k}`);
    }
    out('');
    return EXIT.OK;
  }

  if (!target || !varName) {
    throw new CliError('用法: okey alias <选择器> <变量名>  或  okey alias（查看现有映射）', EXIT.USAGE);
  }

  const name = sanitizeVarName(varName);
  if (!name) throw new CliError(`变量名无效：「${varName}」`, EXIT.USAGE);

  // 允许写 UNALIAS / - 来删除映射
  const remove = /^(UNALIAS|-|NONE)$/i.test(varName);

  const rec = pickOne(vault, target, tagOpt(opts));
  const map = vault.aliases.map || (vault.aliases.map = {});

  if (remove) {
    let removedAny = false;
    for (const key of [rec.id, rec.label, rec.provider]) {
      if (key && map[key]) { delete map[key]; removedAny = true; }
    }
    for (const t of rec.tags || []) {
      const key = `${rec.provider}:${t}`;
      if (map[key]) { delete map[key]; removedAny = true; }
    }
    saveAliases(vault.dir, vault.aliases);
    out(removedAny
      ? c.green('已删除') + `「${rec.label}」的变量名映射`
      : c.dim(`「${rec.label}」本来就没有映射`));
    return EXIT.OK;
  }

  // 以记录 id 为键：id 稳定，标题改名后映射仍有效
  map[rec.id] = name;
  const p = saveAliases(vault.dir, vault.aliases);
  out(c.green('已设置') + `  ${name}  ${c.dim('←')}  ${rec.provider} · ${rec.label}`);
  out(c.dim(`  写入 ${p}`));
  out(c.dim('  该文件只存名字映射，不含任何密钥，可安全备份。'));
  return EXIT.OK;
}

function cmdDoctor(vault, opts) {
  out('');
  out(c.bold('  Okey Dokey 自检'));
  out(c.dim('  ' + '─'.repeat(50)));
  out(`  数据目录    ${vault.dir}`);
  out(`  密钥库      ${vault.vaultPath}`);
  out(`  记录数      ${vault.data.records.length}  ${c.green('✓ 解密成功')}`);

  const byProvider = vault.data.records.reduce((m, r) => (m[r.provider] = (m[r.provider] || 0) + 1, m), {});
  out(`  服务商      ${Object.entries(byProvider).map(([k, v]) => `${k}×${v}`).join(', ') || '(无)'}`);

  const empty = vault.data.records.filter((r) => !r.credential);
  if (empty.length) out(`  ${c.yellow('注意')}        ${empty.length} 条记录没有密钥内容`);

  // 变量名可派生性：这是 run/env 能否覆盖全部记录的关键。
  // 用 collectConflicts：诊断工具要一次性报出全部问题（含冲突），
  // 而不是遇到第一个异常就中断——否则用户要反复修、反复查。
  const { assignments, skipped, conflicts } = buildAssignments(vault.data.records, {
    prefix: opts.prefix,
    withBaseUrl: opts.withBaseUrl,
    aliases: vault.aliases,
    collectConflicts: true
  });

  out(`  可注入变量  ${assignments.size} 个`);

  if (conflicts.length) {
    out(`  ${c.red('变量名冲突')}  ${c.red('✗')}  ${conflicts.length} 处`);
    for (const cf of conflicts) {
      out(c.dim(`                ${cf.name}：已被「${cf.first.label}」占用，又被「${cf.second.label}」使用`));
    }
    out(c.dim('              冲突会让 okey env / run 拒绝执行（防止选错密钥去跑任务）。'));
    out(c.dim('              修复：okey alias 指定不同变量名，或用 <服务商>:<标签> / --prefix 区分。'));
  }

  if (skipped.length) {
    out(`  ${c.yellow('无法派生')}    ${skipped.length} 条（${skipped.map((s) => s.record.label).join('、')}）`);
    out(c.dim('              这些记录无法自动推出变量名（不猜是因为猜错不报错、只会静默失效）。'));
    const usable = skipped.filter((s) => s.hint);
    if (usable.length) {
      out(c.dim('              用 okey alias 指定一次，变量名填对应 SDK 官方使用的名字，例如：'));
      out(c.dim(`                ${usable[0].hint}`));
    }
    const noKey = skipped.filter((s) => !s.hint);
    if (noKey.length) {
      out(c.dim(`              其中 ${noKey.length} 条本身没有密钥内容，需先在图形端补上。`));
    }
  }

  if (!conflicts.length && !skipped.length) {
    out(c.green('  全部记录均可正常注入，无冲突。'));
  }

  const dupes = {};
  for (const [k, v] of assignments) (dupes[k] ||= []).push(v.record);
  const remains = Object.entries(dupes).filter(([, v]) => v.length > 1);
  if (remains.length && !conflicts.length) {
    out(`  ${c.red('变量名冲突')}  ${remains.map(([k]) => k).join(', ')}`);
  }

  out('');
  out(c.dim('  CLI 为只读：它不会修改密钥库。写入请用桌面端或安卓端。'));
  out('');
  return EXIT.OK;
}

/* ------------------------------ 帮助 ------------------------------ */

function usage() {
  out(`
${c.bold('okey')} — Okey Dokey 命令行取用工具 v${VERSION}

${c.bold('用法')}
  okey <命令> [选择器] [选项]

${c.bold('命令')}
  ${c.bold('get')} <选择器>            输出密钥明文（唯一会打印明文的命令）
      --copy                    复制到剪贴板而不是打印
  ${c.bold('run')} [选择器] -- <命令>  注入环境变量后运行命令（推荐）
      --dry-run                 只显示将注入哪些变量，不运行
      --only a,b                只注入指定服务商/选择器
  ${c.bold('env')} [选择器]           输出环境变量赋值语句
      --prefix PREFIX           变量名加前缀（用于区分生产/测试）
      --json                    输出 JSON 对象
      --shell cmd               输出 CMD 的 set 语法
  ${c.bold('list')} [选择器]          列出记录（密钥恒为掩码）
  ${c.bold('which')} <选择器>         查看某条记录详情与将派生的变量名
  ${c.bold('alias')} [选择器] [变量名]  查看/指定记录的变量名（自建端点必需）
  ${c.bold('doctor')}                 自检：数据目录、能否解密、变量名可派生性

${c.bold('选择器')}
  openai                服务商 id
  openai:生产           服务商 + 标签（推荐，最精确）
  @3f2a                 记录 id 前缀
  "生产环境"            标题精确匹配
  生产                  标题或标签的子串匹配（要求唯一）

${c.bold('全局选项')}
  -t, --tag <标签>      用标签过滤
  -d, --dir <路径>      指定数据目录（或用环境变量 OKEY_DOKEY_HOME）
  -p, --prefix <前缀>   变量名前缀，如 OKD_
  --favorites           只用收藏的记录
  --json                机器可读输出
  --no-base-url         不注入 *_BASE_URL 变量
  -q, --quiet           抑制提示信息
  -h, --help            显示帮助
  -V, --version         显示版本

${c.bold('退出码')}
  0 成功   1 一般错误   2 未找到   3 选择器有歧义   4 密钥库问题   5 用法错误

${c.bold('自建/中转端点的记录')}
  provider 为 custom 的记录无法自动推出变量名（猜错不会报错，只会让 SDK
  读不到 key，所以本工具选择不猜）。指定一次即可长期生效：
    okey alias "Claude" ANTHROPIC_API_KEY
    okey alias "Gpt"    OPENAI_API_KEY
  映射写在 <数据目录>/aliases.json，只含名字、不含密钥。

${c.bold('示例')}
  ${c.dim('# 让 SDK 直接读到 key，无需改代码')}
  okey run -- python train.py

  ${c.dim('# 只注入某几个服务商')}
  okey run openai deepseek -- npm test

  ${c.dim('# 生产/测试变量名区分，避免混用')}
  okey run --tag 生产 --prefix PROD_ -- ./deploy.sh

  ${c.dim('# 在当前 shell 会话里设置（PowerShell）')}
  okey env openai | Invoke-Expression

  ${c.dim('# 取出单个 key 给别的工具用')}
  okey get openai:生产 | some-other-tool --stdin

${c.bold('安全提示')}
  env / get 会把密钥明文写到 stdout；不要把输出重定向到会被提交或同步的文件。
  日常优先用 run：密钥只进入子进程环境，不落盘、不进 shell 历史。
`);
}

/* ------------------------------ 入口 ------------------------------ */

async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);

  if (opts.version) { out(VERSION); return EXIT.OK; }
  if (opts.help || argv.length === 0) { usage(); return EXIT.OK; }

  const command = opts._.shift();
  const known = ['get', 'run', 'env', 'list', 'which', 'doctor', 'alias', 'help'];
  if (!known.includes(command)) {
    throw new CliError(`未知命令「${command}」。用 \`okey --help\` 查看用法。`, EXIT.USAGE);
  }
  if (command === 'help') { usage(); return EXIT.OK; }
  if (opts.unknown) {
    throw new CliError(`未知选项「${opts.unknown}」。用 \`okey --help\` 查看用法。`, EXIT.USAGE);
  }

  const vault = loadVault(opts.dir);

  switch (command) {
    case 'get': return await cmdGet(vault, opts);
    case 'env': return cmdEnv(vault, opts);
    case 'run': return await cmdRun(vault, opts);
    case 'list': return cmdList(vault, opts);
    case 'which': return cmdWhich(vault, opts);
    case 'doctor': return cmdDoctor(vault, opts);
    case 'alias': return cmdAlias(vault, opts);
    default: usage(); return EXIT.USAGE;
  }
}

main()
  .then((code) => { process.exitCode = code == null ? 0 : code; })
  .catch((err) => {
    if (err instanceof CliError) {
      process.stderr.write(c.red('错误: ') + err.message + '\n');
      process.exitCode = err.code;
    } else {
      process.stderr.write(c.red('意外错误: ') + (err && err.stack ? err.stack : String(err)) + '\n');
      process.exitCode = EXIT.ERROR;
    }
  });
