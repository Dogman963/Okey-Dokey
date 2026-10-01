#!/usr/bin/env node
/**
 * 连通性测试功能的测试套件。
 *
 * 覆盖：
 *   1. 22 家服务商都能构造出合法探测请求（协议分族正确）
 *   2. 模型名解析（"常用模型"是多值的，取第一个）
 *   3. 明文策略：私有网段放行、公网 http 拒绝（边界值）
 *   4. HTTP 响应解读成正确的失败分类（这是「能据以行动」的关键）
 *   5. 结果里不含密钥明文（安全）
 *   6. 真实发一次请求（本地起一个 HTTP 服务做端到端验证）
 */
'use strict';

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const require = createRequire(pathToFileURL(path.join(REPO, 'package.json')));

const C = require(path.join(REPO, 'src', 'shared', 'connectivity.js'));
const PROVIDERS = require(path.join(REPO, 'src', 'shared', 'providers.js'));

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t) { console.log(`\n${t}\n${'─'.repeat(70)}`); }

const SYNTH = (t) => ['SYNTH', t, 'NOTAREALKEY'].join('-');

console.log('\n连通性测试功能');
console.log('='.repeat(70));

/* ------------------------------ 1. 22 家构造请求 ------------------------------ */

section('1. 各服务商探测请求构造');
{
  let built = 0;
  const errors = [];
  for (const p of PROVIDERS) {
    const rec = {
      provider: p.id,
      credential: SYNTH('key'),
      baseUrl: p.baseUrl || 'https://example.com/v1',
      models: 'model-a, model-b'
    };
    const r = C.buildProbe(rec);
    if (r.error) errors.push(`${p.id}:${r.error}`);
    else built++;
  }
  check(`全部 ${PROVIDERS.length} 家都能构造请求`, errors.length === 0, errors.join(', '));
  console.log(`      实际构造成功 ${built} 家`);

  // 协议分族抽查
  const openaiRec = { provider: 'openai', credential: SYNTH('k'), baseUrl: 'https://api.openai.com/v1', models: 'gpt-4o' };
  const oa = C.buildProbe(openaiRec);
  check('OpenAI 走 /chat/completions', oa.url.endsWith('/chat/completions') && oa.method === 'POST');
  check('OpenAI 用 Authorization 头', 'Authorization' in oa.headers);
  check('OpenAI 请求体含所选模型', oa.body.model === 'gpt-4o');
  check('OpenAI max_tokens=1（成本最小）', oa.body.max_tokens === 1);

  const anthropic = C.buildProbe({ provider: 'anthropic', credential: SYNTH('k'), baseUrl: 'https://api.anthropic.com', models: 'claude-3-5-sonnet-latest' });
  check('Anthropic 走 /v1/messages', anthropic.url.endsWith('/v1/messages'));
  check('Anthropic 用 x-api-key', C.AUTH_HEADER.anthropic in anthropic.headers);
  check('Anthropic 带 anthropic-version', 'anthropic-version' in anthropic.headers);

  const google = C.buildProbe({ provider: 'google', credential: SYNTH('k'), baseUrl: 'https://generativelanguage.googleapis.com', models: 'gemini-1.5-flash' });
  check('Google 走 generateContent', google.url.includes(':generateContent'));
  check('Google 用查询参数传 key（非头）', google.url.includes('key=') && !('Authorization' in google.headers));

  const azure = C.buildProbe({ provider: 'azure', credential: SYNTH('k'), baseUrl: 'https://myres.openai.azure.com', models: 'my-deploy' });
  check('Azure 走 deployments 路径', azure.url.includes('/openai/deployments/my-deploy/'));
  check('Azure 带 api-version', azure.url.includes('api-version='));

  // Azure 未填模型应明确报错，而不是发出一个必然失败的请求
  const azureNoModel = C.buildProbe({ provider: 'azure', credential: SYNTH('k'), baseUrl: 'https://x.openai.azure.com', models: '' });
  check('Azure 缺模型名时报 MODEL_REQUIRED', azureNoModel.error === 'MODEL_REQUIRED');
}

/* ------------------------------ 2. 模型名解析 ------------------------------ */

section('2. 常用模型解析（字段是多值的）');
{
  check('英文逗号', C.firstModel('gpt-4o, o3-mini') === 'gpt-4o');
  check('中文逗号', C.firstModel('gpt-4o，o3-mini') === 'gpt-4o');
  check('分号', C.firstModel('a; b') === 'a');
  check('顿号', C.firstModel('a、b') === 'a');
  check('换行', C.firstModel('a\nb') === 'a');
  check('多余空格被裁掉', C.firstModel('  spaced-model  , other') === 'spaced-model');
  check('空字符串返回空', C.firstModel('') === '');
  check('纯空白返回空', C.firstModel('   ') === '');
  check('未填模型时退化为列模型接口',
    C.buildProbe({ provider: 'openai', credential: SYNTH('k'), baseUrl: 'https://api.openai.com/v1', models: '' }).method === 'GET');
}

/* ------------------------------ 3. 明文策略 ------------------------------ */

section('3. 明文 HTTP 策略（私有放行 / 公网拒绝）');
{
  const allow = [
    'http://localhost:11434/v1', 'http://127.0.0.1:8080/v1',
    'http://10.0.0.5:8000/v1', 'http://192.168.1.100:8080/v1',
    'http://172.16.5.5:8000/v1', 'http://172.31.255.1/v1',
    'http://100.64.0.1/v1', 'https://api.openai.com/v1'
  ];
  const deny = [
    'http://api.openai.com/v1', 'http://8.8.8.8/v1',
    'http://172.15.0.1/v1', 'http://172.32.0.1/v1',
    'http://203.0.113.5/v1'
  ];
  for (const u of allow) check(`放行 ${u}`, C.checkCleartext(u) === null);
  for (const u of deny) {
    const r = C.checkCleartext(u);
    check(`拒绝 ${u}`, r !== null && r.kind === 'CLEARTEXT_BLOCKED');
  }
  check('拒绝时会解释原因', (C.checkCleartext('http://example.com/v1') || {}).message?.includes('http'));
  check('拒绝时给出私有网段提示', (C.checkCleartext('http://example.com/v1') || {}).detail?.includes('192.168'));

  // 集成：私网 → 可构造；公网明文 → 被 buildProbe 拦下
  const priv = C.buildProbe({ provider: 'ollama', credential: SYNTH('k'), baseUrl: 'http://localhost:11434/v1', models: 'llama3' });
  check('本地 Ollama 可正常构造', !priv.error);
  const pub = C.buildProbe({ provider: 'custom', credential: SYNTH('k'), baseUrl: 'http://relay.example.com/v1', models: 'gpt-4o' });
  check('公网明文被拦下', pub.error === 'CLEARTEXT_BLOCKED' && !!pub.message);
}

/* ------------------------------ 4. 响应解读 ------------------------------ */

section('4. 失败分类（决定用户下一步做什么）');
{
  const probe = { modelTested: 'gpt-4o' };
  const cases = [
    [200, '{"ok":true}', 'OK', true],
    [201, '{}', 'OK', true],
    [401, '{"error":{"message":"Incorrect API key"}}', 'AUTH', false],
    [403, '{"error":"forbidden"}', 'AUTH', false],
    [404, '{"error":{"message":"The model does not exist"}}', 'NO_MODEL', false],
    [404, '{"error":"not found"}', 'BAD_URL', false],
    [429, '{"error":{"message":"rate limit"}}', 'RATE_LIMIT', false],
    [400, '{"error":{"message":"model not found"}}', 'NO_MODEL', false],
    [400, '{"error":{"message":"bad param"}}', 'BAD_REQUEST', false],
    [500, 'oops', 'SERVER', false],
    [502, 'bad gateway', 'SERVER', false]
  ];
  for (const [status, body, wantKind, wantOk] of cases) {
    const r = C.interpret(status, body, probe);
    check(`${status} → ${wantKind}`, r.kind === wantKind && r.ok === wantOk, `得到 ${r.kind}`);
  }

  // 服务端原话要能带出来，用户才能自己判断
  const auth = C.interpret(401, '{"error":{"message":"Incorrect API key provided"}}', probe);
  check('失败时带出服务端原话', auth.detail.includes('Incorrect API key'));

  // 成功时若验证了模型，消息里要提到它
  const ok = C.interpret(200, '{}', probe);
  check('成功时说明已验证的模型', ok.message.includes('gpt-4o'));

  // 未填模型时不应谎称验证了模型
  const okNoModel = C.interpret(200, '{}', { modelTested: null });
  check('未验证模型时不谎称已验证', okNoModel.message.includes('未验证'));

  // 非 JSON 响应也不能崩
  let crashed = false;
  try { C.interpret(500, '<html>Internal Server Error</html>', probe); } catch (_) { crashed = true; }
  check('非 JSON 响应不崩', !crashed);
}

/* ------------------------------ 5. 安全：不含明文 ------------------------------ */

section('5. 安全：结果与错误里不含密钥');
{
  const secret = SYNTH('SECRETVALUE');
  const rec = { provider: 'openai', credential: secret, baseUrl: 'https://api.openai.com/v1', models: 'gpt-4o' };
  const probe = C.buildProbe(rec);

  // probe.headers 里必然含密钥（要发请求），但它不该出现在 message/detail 里
  const r = C.interpret(401, '{"error":{"message":"invalid key"}}', probe);
  check('interpret 的 message 不含密钥', !r.message.includes(secret));
  check('interpret 的 detail 不含密钥', !r.detail.includes(secret));

  // NO_BASE_URL / CLEARTEXT_BLOCKED 这类提前返回也不该回显密钥
  const noUrl = C.buildProbe({ ...rec, baseUrl: '' });
  check('缺地址时错误信息不含密钥', !JSON.stringify(noUrl).includes(secret));
  const blocked = C.buildProbe({ ...rec, baseUrl: 'http://evil.example.com/v1' });
  check('被拦时错误信息不含密钥', !JSON.stringify(blocked).includes(secret));
}

/* ------------------------------ 6. 端到端真实请求 ------------------------------ */

section('6. 端到端：对着本地 HTTP 服务真发一次');
{
  const secret = SYNTH('E2E');
  let seenAuth = null;
  let seenBody = null;

  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => {
      seenAuth = req.headers.authorization || null;
      seenBody = data ? JSON.parse(data) : null;
      // 只对 /v1/chat/completions 这个确切路径返回成功；
      // 其他路径（例如 baseUrl 写错的 /wrong/...）返回通用 404，
      // 这样才能验证「地址不对」被正确识别。
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'hi' } }] }));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body>404 Not Found</body></html>');
      }
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const rec = { provider: 'custom', credential: secret, baseUrl, models: 'e2e-model' };
    const probe = C.buildProbe(rec);
    check('本地地址构造成功（未被明文策略拦下）', !probe.error, probe.error || '');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let res, text;
    try {
      res = await fetch(probe.url, {
        method: probe.method,
        headers: probe.headers,
        body: probe.body ? JSON.stringify(probe.body) : undefined,
        signal: ctrl.signal
      });
      text = await res.text();
    } finally { clearTimeout(timer); }

    const verdict = C.interpret(res.status, text, probe);
    check('真实请求返回 200', res.status === 200, `status=${res.status}`);
    check('判定为连通正常', verdict.ok === true, verdict.message);
    check('服务端收到了 Bearer 凭据', seenAuth === `Bearer ${secret}`);
    check('服务端收到的模型名正确', seenBody && seenBody.model === 'e2e-model');
    check('请求确实是 max_tokens=1 的最小请求', seenBody && seenBody.max_tokens === 1);

    // 404 路径：模拟 baseUrl 写错
    const wrong = C.buildProbe({ ...rec, baseUrl: `http://127.0.0.1:${port}/wrong` });
    const res2 = await fetch(wrong.url, {
      method: wrong.method,
      headers: wrong.headers,
      body: wrong.body ? JSON.stringify(wrong.body) : undefined
    });
    const text2 = await res2.text();
    const v2 = C.interpret(res2.status, text2, wrong);
    check('baseUrl 写错时给出 404 且判定为 BAD_URL', v2.kind === 'BAD_URL', v2.kind);
    check('通用 404（非模型相关）不误判为模型问题', v2.kind !== 'NO_MODEL', v2.kind);

    // 反向：明确提到模型的 404 应归为模型问题
    const v3 = C.interpret(404, '{"error":{"message":"The model gpt-9 does not exist"}}', { modelTested: 'gpt-9' });
    check('提到模型的 404 归为 NO_MODEL', v3.kind === 'NO_MODEL', v3.kind);
  } finally {
    server.close();
  }
}

/* ------------------------------ 汇总 ------------------------------ */

console.log('\n' + '='.repeat(70));
console.log(`结果: ${pass} 项通过, ${fail} 项失败`);
if (fail) {
  console.log('\n失败项:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('连通性测试功能验证通过 ✓');
