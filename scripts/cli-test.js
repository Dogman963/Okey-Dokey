#!/usr/bin/env node
/**
 * CLI 测试 —— 覆盖「命令行取用密钥」的全部关键路径。
 *
 * 为什么值得单独写测试：
 *   1. 这是唯一会把密钥明文打到 stdout 的组件，输出格式错一点就会污染脚本；
 *   2. 退出码要能被脚本区分（未找到 / 有歧义 / 库损坏），不能一律非零；
 *   3. 歧义保护是安全属性：选错 key 去跑生产任务比报错严重得多；
 *   4. 环境注入必须真的证明「子进程拿到了值」，而不是只看命令行回显。
 *
 * 全部用例使用**临时数据目录**，不触碰用户真实密钥库。
 *
 * 关于测试数据：被测对象是密钥库，所以库里必须有「密钥形状」的值。这些值全部
 * 在运行时拼接生成、带 SYNTH 标记；期望的变量名一律从被测模块自己的映射表读取，
 * 不在测试里硬编码，避免测试与实现各写一份而悄悄分叉。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'src', 'cli', 'okey.js');
const { encryptJSON } = require(path.join(REPO, 'src', 'main', 'crypto.js'));
const { PROVIDER_ENV } = require(path.join(REPO, 'src', 'cli', 'resolve.js'));

let pass = 0, fail = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(70)}`); }

/* ------------------------------ 合成测试数据 ------------------------------ */

// 运行时拼接出「密钥形状」的假值，带 SYNTH 标记以表明非真实凭据。
const SYNTH = (tag) => ['SYNTH', tag, 'NOTAREALKEY', '0000'].join('-');
const VAL = {
  openaiProd: SYNTH('openai-prod'),
  openaiTest: SYNTH('openai-test'),
  deepseek: SYNTH('deepseek'),
  relay: SYNTH('relay'),
  tricky: ['SYNTH', 'quote"and$dollar`tick', 'END'].join('-')  // 验证 shell 转义
};

// 期望的变量名统一取自被测模块的映射表（单一事实来源），
// BASE_URL 名按实现规则（_API_KEY → _BASE_URL）推导。
const baseUrlName = (n) => PROVIDER_ENV[n].replace(/_API_KEY$/, '_BASE_URL');
const NAME = {
  deepseek: PROVIDER_ENV.deepseek,
  openai: PROVIDER_ENV.openai,
  mistral: PROVIDER_ENV.mistral,
  deepseekUrl: baseUrlName('deepseek'),
  openaiUrl: baseUrlName('openai')
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'okey-cli-'));
const VAULT_DIR = path.join(TMP, 'vault');
fs.mkdirSync(VAULT_DIR, { recursive: true });

const DEVICE_KEY = 'a1'.repeat(32); // 64 位 hex
fs.writeFileSync(path.join(VAULT_DIR, 'device.key'), DEVICE_KEY, 'utf8');
fs.writeFileSync(path.join(VAULT_DIR, 'settings.json'),
  JSON.stringify({ privacy: { maskStyle: 'prefix' } }), 'utf8');

const RECORDS = [
  {
    id: 'aaaa-1111-2222-3333-444444444444',
    provider: 'openai', label: '生产 GPT', credential: VAL.openaiProd,
    note: '线上主 key', tags: ['生产'], baseUrl: 'https://api.openai.com/v1',
    models: 'gpt-4o', favorite: true, disabled: false,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z',
    usageCount: 5, lastUsedAt: null
  },
  {
    id: 'bbbb-1111-2222-3333-444444444444',
    provider: 'openai', label: '测试 GPT', credential: VAL.openaiTest,
    note: '', tags: ['测试'], baseUrl: 'https://api.openai.com/v1',
    models: '', favorite: false, disabled: false,
    createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
    usageCount: 0, lastUsedAt: null
  },
  {
    id: 'cccc-1111-2222-3333-444444444444',
    provider: 'deepseek', label: '主力', credential: VAL.deepseek,
    note: '', tags: [], baseUrl: 'https://api.deepseek.com/v1',
    models: 'deepseek-chat', favorite: false, disabled: false,
    createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-12T00:00:00.000Z',
    usageCount: 2, lastUsedAt: null
  },
  {
    id: 'dddd-1111-2222-3333-444444444444',
    provider: 'custom', label: '中转站', credential: VAL.relay,
    note: '第三方中转', tags: ['生产'], baseUrl: 'https://relay.example.com/v1',
    models: '', favorite: false, disabled: false,
    createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
    usageCount: 0, lastUsedAt: null
  },
  {
    id: 'ffff-1111-2222-3333-444444444444',
    provider: 'mistral', label: '特殊字符', credential: VAL.tricky,
    note: '', tags: [], baseUrl: '', models: '', favorite: false, disabled: false,
    createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    usageCount: 0, lastUsedAt: null
  }
];

function writeVault(records) {
  fs.writeFileSync(path.join(VAULT_DIR, 'vault.enc'),
    encryptJSON({ version: 1, records }, DEVICE_KEY), 'utf8');
}
writeVault(RECORDS);

/* ------------------------------ 调用助手 ------------------------------ */

function okey(args) {
  const res = spawnSync(process.execPath, [CLI, '--dir', VAULT_DIR, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 60000
  });
  return { code: res.status, out: res.stdout || '', err: res.stderr || '' };
}

/** 从 --json 输出里按名字取值（名字由 NAME 提供，避免硬编码） */
function field(text, name) {
  try { return JSON.parse(text)[name]; } catch (_) { return undefined; }
}

const isWin = process.platform === 'win32';
/** 构造「在子进程里回显某个变量」的命令 */
const echoVar = (name) => isWin
  ? ['--', 'powershell', '-NoProfile', '-Command', `Write-Output $env:${name}`]
  : ['--', 'sh', '-c', `echo $${name}`];

console.log('\nCLI 测试：命令行取用密钥');
console.log('='.repeat(70));
console.log('临时密钥库:', VAULT_DIR);

/* ------------------------------ 用例 ------------------------------ */

section('1. list —— 密钥必须恒为掩码');
{
  const r = okey(['list']);
  check('退出码 0', r.code === 0, `code=${r.code}`);
  check('列出全部记录', r.out.includes(`${RECORDS.length} 条记录`), `out head=${r.out.slice(0, 120)}`);
  check('显示服务商统计', r.out.includes('openai×2') && r.out.includes('deepseek×1'));
  check('显示标签', r.out.includes('[生产]'));
  check('不含任何密钥明文', !RECORDS.some((rec) => r.out.includes(rec.credential)));
  check('输出掩码形式', r.out.includes('••••'));

  const arr = JSON.parse(okey(['list', '--json']).out);
  check('--json 输出合法数组', Array.isArray(arr) && arr.length === RECORDS.length);
  check('--json 同样不含明文', !arr.some((x) => x.credential));
}

section('2. get —— 唯一输出明文的命令');
{
  const r = okey(['get', 'deepseek']);
  check('退出码 0', r.code === 0);
  check('stdout 恰好是明文 + 换行，可直进管道', r.out === VAL.deepseek + '\n', JSON.stringify(r.out));

  const j = okey(['get', 'deepseek', '--json']);
  check('--json 含密钥', field(j.out, 'credential') === VAL.deepseek);
  check('--json 含元数据', field(j.out, 'provider') === 'deepseek');

  const miss = okey(['get', '不存在的服务商']);
  check('未找到返回退出码 2', miss.code === 2, `code=${miss.code}`);
  check('未找到有可读提示', miss.err.includes('没有找到匹配'));
}

section('3. 选择器精度与歧义保护（安全属性）');
{
  const amb = okey(['get', 'openai']);
  check('同服务商多条时拒绝猜（退出码 3）', amb.code === 3, `code=${amb.code}`);
  check('歧义错误列出全部候选', amb.err.includes('生产 GPT') && amb.err.includes('测试 GPT'));
  check('歧义错误不含明文', !amb.err.includes(VAL.openaiProd));

  check('provider:tag 可精确定位', okey(['get', 'openai:测试']).out === VAL.openaiTest + '\n');
  check('--tag 可精确定位', okey(['get', 'openai', '--tag', '生产']).out === VAL.openaiProd + '\n');
  check('标题精确匹配', okey(['get', '主力']).out === VAL.deepseek + '\n');
  check('id 前缀匹配', okey(['get', '@cccc']).out === VAL.deepseek + '\n');
  check('子串匹配仅在唯一时接受', okey(['get', '测试 GPT']).out === VAL.openaiTest + '\n');
}

section('4. 环境变量名派生');
{
  const r = okey(['env', 'deepseek', '--json']);
  check('内置表命中官方变量名', field(r.out, NAME.deepseek) === VAL.deepseek,
    `keys=${Object.keys(JSON.parse(r.out)).join(',')}`);
  check('同时派生 BASE_URL', field(r.out, NAME.deepseekUrl) === 'https://api.deepseek.com/v1');

  const o2 = okey(['env', 'deepseek', '--json', '--no-base-url']);
  check('--no-base-url 时不输出 URL', field(o2.out, NAME.deepseekUrl) === undefined);

  const o3 = okey(['env', 'deepseek', '--json', '--prefix', 'PROD']);
  check('--prefix 生效', field(o3.out, 'PROD_' + NAME.deepseek) === VAL.deepseek);

  // custom 记录不猜变量名：猜错不会报错、只会让 SDK 静默读不到
  const noAlias = okey(['env', '中转站', '--json']);
  check('custom 记录拒绝自动猜测变量名（退出码 2）', noAlias.code === 2, `code=${noAlias.code}`);
  check('提示用户显式指定一次', noAlias.err.includes('okey alias'));

  const setAlias = okey(['alias', '中转站', NAME.openai]);
  check('alias 设置成功', setAlias.code === 0 && setAlias.out.includes('已设置'));

  const withAlias = okey(['env', '中转站', '--json']);
  check('别名生效于 env', field(withAlias.out, NAME.openai) === VAL.relay);
  check('别名同样派生 BASE_URL',
    field(withAlias.out, NAME.openaiUrl) === 'https://relay.example.com/v1');

  check('alias 列表可查', okey(['alias']).out.includes(NAME.openai));

  // 变量名冲突必须报错，不能静默覆盖（两条 openai 争同一个名字）
  const clash = okey(['env', '--json']);
  check('变量名冲突报错（退出码 3）', clash.code === 3, `code=${clash.code}`);
  check('冲突错误说明原因', clash.err.includes('变量名冲突'));
  check('冲突错误不含明文', !clash.err.includes(VAL.openaiProd));

  check('缩小范围后可正常输出', okey(['env', 'openai:生产', '--json']).code === 0);

  const removed = okey(['alias', '中转站', 'UNALIAS']);
  check('alias 可删除', removed.code === 0 && removed.out.includes('已删除'));
}

section('4b. doctor 在异常情况下仍应给诊断结论而非崩溃');
{
  // 冲突状态下 doctor 必须报告冲突并正常退出（诊断工具不该自己报错中断）
  const clashVault = path.join(TMP, 'clash');
  fs.mkdirSync(clashVault, { recursive: true });
  fs.writeFileSync(path.join(clashVault, 'device.key'), DEVICE_KEY, 'utf8');
  fs.writeFileSync(path.join(clashVault, 'vault.enc'), encryptJSON({
    version: 1,
    records: [
      { id: 'x1', provider: 'openai', label: '甲', credential: VAL.openaiProd, tags: ['生产'], baseUrl: '', favorite: false, disabled: false, createdAt: 'x', updatedAt: 'y' },
      { id: 'x2', provider: 'openai', label: '乙', credential: VAL.openaiTest, tags: ['测试'], baseUrl: '', favorite: false, disabled: false, createdAt: 'x', updatedAt: 'y' }
    ]
  }, DEVICE_KEY), 'utf8');

  const d = spawnSync(process.execPath, [CLI, '--dir', clashVault, 'doctor'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  check('存在变量名冲突时 doctor 仍退出码 0', d.status === 0, `code=${d.status}`);
  check('doctor 报告冲突本身', (d.stdout || '').includes('变量名冲突'));
  check('doctor 冲突报告不含明文', !(d.stdout || '').includes(VAL.openaiProd));
}

section('5. env —— shell 语法与转义');
{
  const ps = okey(['env', 'deepseek']);
  check('PowerShell 语法', ps.out.includes(`$env:${NAME.deepseek}=`));
  const lines = ps.out.split('\n').filter((l) => l.trim());
  check('stdout 只有赋值语句，提示走 stderr',
    lines.every((l) => l.startsWith('$env:')), `stdout=${JSON.stringify(ps.out)}`);
  check('注释提示确实在 stderr', ps.err.includes('已输出'));

  // 含引号/美元符/反引号的密钥必须转义正确，且能被 shell 解回原值
  const tricky = okey(['env', 'mistral']);
  check('特殊字符输出成功', tricky.code === 0, `code=${tricky.code}`);
  if (isWin) {
    const round = spawnSync('powershell', ['-NoProfile', '-Command',
      `${tricky.out.trim()}; Write-Output $env:${NAME.mistral}`], { encoding: 'utf8' });
    check('特殊字符经 PowerShell 往返后与原值一致',
      (round.stdout || '').trim() === VAL.tricky,
      `got=${JSON.stringify((round.stdout || '').trim())}`);
  }

  check('CMD 语法', okey(['env', 'deepseek', '--shell', 'cmd']).out.includes(`set ${NAME.deepseek}=`));
  check('-q 抑制提示', !okey(['env', 'deepseek', '-q']).err.includes('已输出'));
}

section('6. run —— 子进程环境注入（真实执行验证）');
{
  const dry = okey(['run', 'deepseek', '--dry-run', '--', 'echo', 'hi']);
  check('--dry-run 显示将运行的命令', dry.out.includes('echo hi'));
  check('--dry-run 显示变量名', dry.out.includes(NAME.deepseek));
  check('--dry-run 不泄漏明文', !dry.out.includes(VAL.deepseek));
  check('--dry-run 只给长度', dry.out.includes('字符'));

  const r = okey(['run', 'deepseek', ...echoVar(NAME.deepseek)]);
  check('子进程真的拿到了注入的密钥', r.out.includes(VAL.deepseek), `out=${r.out.trim()}`);
  check('run 退出码 0', r.code === 0, `code=${r.code}`);

  const rf = okey(['run', 'deepseek', '--', ...(isWin ? ['powershell', '-NoProfile', '-Command', 'exit 7'] : ['sh', '-c', 'exit 7'])]);
  check('子进程非零退出码被透传', rf.code === 7, `code=${rf.code}`);

  // 只注入选中的服务商：未选中的必须不在环境里
  const onlyCheck = isWin
    ? `if ($env:${NAME.openai}) { "LEAK" } else { "CLEAN" }`
    : `echo \${${NAME.openai}:-CLEAN}`;
  const r1 = okey(['run', 'deepseek', '--', ...(isWin ? ['powershell', '-NoProfile', '-Command', onlyCheck] : ['sh', '-c', onlyCheck])]);
  check('未选中的服务商变量不被注入',
    r1.out.includes('CLEAN') && !r1.out.includes('LEAK'), `out=${r1.out.trim()}`);

  check('缺少命令时给用法错误（退出码 5）', okey(['run']).code === 5);
}

section('7. which / doctor');
{
  const w = okey(['which', 'deepseek']);
  check('which 显示记录详情', w.out.includes('主力') && w.out.includes('deepseek'));
  check('which 显示将派生的变量名', w.out.includes(NAME.deepseek));
  check('which 不含明文', !w.out.includes(VAL.deepseek));
  check('which 未找到退出码 2', okey(['which', '不存在']).code === 2);

  const d = okey(['doctor']);
  check('doctor 退出码 0', d.code === 0);
  check('doctor 报告记录数', d.out.includes(String(RECORDS.length)));
  check('doctor 不含明文', !RECORDS.some((rec) => d.out.includes(rec.credential)));
  check('doctor 报告无法派生的条目（custom）', d.out.includes('中转站'));
}

section('8. 损坏与错误处理');
{
  const bad = spawnSync(process.execPath, [CLI, '--dir', path.join(TMP, 'nope'), 'list'], { encoding: 'utf8' });
  check('数据目录不存在 → 退出码 4', bad.status === 4, `code=${bad.status}`);
  check('提示如何修复', bad.stderr.includes('桌面端'));

  const wrongDir = path.join(TMP, 'wrong');
  fs.mkdirSync(wrongDir, { recursive: true });
  fs.writeFileSync(path.join(wrongDir, 'device.key'), 'ff'.repeat(32), 'utf8');
  fs.writeFileSync(path.join(wrongDir, 'vault.enc'), fs.readFileSync(path.join(VAULT_DIR, 'vault.enc')), 'utf8');
  const wrong = spawnSync(process.execPath, [CLI, '--dir', wrongDir, 'list'], { encoding: 'utf8' });
  check('device.key 不配套 → 退出码 4', wrong.status === 4, `code=${wrong.status}`);
  check('提示指向 .okeyvault 迁移方式', wrong.stderr.includes('.okeyvault'));

  check('未知命令 → 退出码 5', okey(['nosuchcmd']).code === 5);
  check('未知选项 → 退出码 5', okey(['list', '--nope']).code === 5);

  const emptyDir = path.join(TMP, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  fs.writeFileSync(path.join(emptyDir, 'device.key'), DEVICE_KEY, 'utf8');
  fs.writeFileSync(path.join(emptyDir, 'vault.enc'), encryptJSON({ version: 1, records: [] }, DEVICE_KEY), 'utf8');
  const empty = spawnSync(process.execPath, [CLI, '--dir', emptyDir, 'list'], { encoding: 'utf8' });
  check('空库不报错', empty.status === 0);
  check('空库给友好提示', empty.stdout.includes('没有匹配的记录'));

  // 别名表损坏不应阻断取用密钥（取密钥才是 CLI 的核心职责）
  fs.writeFileSync(path.join(VAULT_DIR, 'aliases.json'), '{ this is not json', 'utf8');
  const survived = okey(['get', 'deepseek']);
  check('别名表损坏仍能取密钥', survived.code === 0 && survived.out === VAL.deepseek + '\n');
  fs.rmSync(path.join(VAULT_DIR, 'aliases.json'));
}

section('9. 只读保证（不修改密钥库）');
{
  const vaultFile = path.join(VAULT_DIR, 'vault.enc');
  const keyFile = path.join(VAULT_DIR, 'device.key');
  const before = fs.readFileSync(vaultFile, 'utf8');
  const beforeStat = fs.statSync(vaultFile).mtimeMs;

  okey(['list']);
  okey(['get', 'deepseek']);
  okey(['env', 'deepseek']);
  okey(['which', 'deepseek']);
  okey(['doctor']);
  okey(['run', 'deepseek', '--dry-run', '--', 'echo', 'hi']);

  check('vault.enc 内容未变', fs.readFileSync(vaultFile, 'utf8') === before);
  check('vault.enc 未被重写（mtime 不变）', fs.statSync(vaultFile).mtimeMs === beforeStat);
  check('device.key 未被改动', fs.readFileSync(keyFile, 'utf8') === DEVICE_KEY);
}

/* ------------------------------ 汇总 ------------------------------ */

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

console.log('\n' + '='.repeat(70));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('CLI 全部用例通过 ✓');
