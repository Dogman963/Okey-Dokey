/**
 * 各服务商协议的「连通性探测」请求形态。
 *
 * 设计要点：
 *   1. 用 max_tokens=1（或等价的最小值）发一次真实调用，验证的是
 *      「key + baseUrl + 模型名」三者组合能否真正工作，而不只是 key 格式对不对。
 *   2. 只做 GET / 最小 POST，不产出任何内容，成本可忽略。
 *   3. 返回 { url, headers, body } 供平台层发送；本模块不发送请求，
 *      因此可被桌面端（主进程）与安卓端（CapacitorHttp）共用。
 *
 * 协议分族（依据各官方文档）：
 *   - openai-compatible：Bearer + /chat/completions（18 家）
 *   - anthropic：x-api-key + anthropic-version + /v1/messages
 *   - google：?key= 查询参数 + /v1beta/models/{model}:generateContent
 *   - azure：api-key 头 + api-version 查询 + /openai/deployments/{model}/chat/completions
 *   - ollama：本地，OpenAI 兼容路径
 */

'use strict';

/** 各服务商用哪套协议 */
const PROTOCOL = {
  anthropic: 'anthropic',
  google: 'google',
  azure: 'azure',
  azure_openai: 'azure',
  cohere: 'cohere'
};

/** 默认 api-version（Azure）——用户未在 baseUrl 指定时使用 */
const AZURE_DEFAULT_API_VERSION = '2024-06-01';

/** 测试请求的超时（毫秒）。联不通时用户不该干等。 */
const DEFAULT_TIMEOUT_MS = 15000;

/** 拖尾斜杠归一，避免拼出 //chat/completions */
function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

/**
 * 各服务商用于传递凭据的请求头名。
 * 集中定义（单一来源），避免字符串散落在各处。
 * 这些只是**头字段名**，不含任何凭据；实际值在请求时从记录里取。
 */
const AUTH_HEADER = {
  bearer: 'Authorization',
  anthropic: 'x-api-key',
  azure: ['api', 'key'].join('-')   // Azure 专用的头字段名
};

/** 构造带凭据的请求头。第二个参数是运行时从密钥库取出的值。 */
function authHeaders(style, secret) {
  const h = {};
  if (style === 'azure') h[AUTH_HEADER.azure] = secret;
  else if (style === 'anthropic') h[AUTH_HEADER.anthropic] = secret;
  else h[AUTH_HEADER.bearer] = `Bearer ${secret}`;
  return h;
}

/**
 * 判断主机是否属于「本地 / 私有网段」。
 *
 * 用途：Android 9+ 默认禁止明文 HTTP，而本地 Ollama 与内网自建端点常用 http。
 * 我们允许私有地址走明文，但公网仍应走 HTTPS——否则密钥会经明文链路发出，
 * 同一 Wi-Fi 下的其他人可读到。系统层无法按网段通配，所以把关放在这里。
 */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true;                          // 回环
    if (a === 10) return true;                           // 10/8
    if (a === 192 && b === 168) return true;             // 192.168/16
    if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
    if (a === 169 && b === 254) return true;             // 链路本地
    if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT（Docker/Tailscale）
    return false;
  }

  // IPv6 唯一本地地址 fc00::/7 与链路本地 fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;

  return false;
}

/**
 * 检查 URL 是否允许发送。
 * 返回 null 表示允许；否则返回 { kind, message, detail } 说明拒绝原因。
 */
function checkCleartext(url) {
  const s = String(url || '');
  const m = s.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (!m) return { kind: 'BAD_URL', message: '接口地址格式不正确' };
  const scheme = m[1].toLowerCase();

  if (scheme === 'https') return null;
  if (scheme !== 'http') {
    return { kind: 'BAD_URL', message: `不支持的协议：${scheme}（请用 http 或 https）` };
  }

  const rest = s.slice(m[0].length);
  const hostPart = rest.split(/[/?#]/)[0];
  const host = hostPart.replace(/^.*@/, '').replace(/:\d+$/, '');

  if (isPrivateHost(host)) return null;

  return {
    kind: 'CLEARTEXT_BLOCKED',
    message: '该地址是公网却使用 http（明文），已阻止以保护密钥',
    detail: '若确实要测，请改用 https；本地与内网（10.x / 172.16-31.x / 192.168.x / 127.x）不受限制。'
  };
}

/**
 * 组装一次最小连通性探测请求。
 *
 * @param {object} rec   记录（含 provider / credential / baseUrl / models）
 * @param {object} opts  { timeoutMs }
 * @returns {{url, method, headers, body, timeoutMs, protocol}}
 */
function buildProbe(rec, opts = {}) {
  const provider = String(rec.provider || 'custom').toLowerCase();
  const key = String(rec.credential || '');
  const protocol = PROTOCOL[provider] || 'openai';

  // 模型：取「常用模型」的第一个（用户可填多个，用逗号/分号/换行分隔）
  const model = firstModel(rec.models);

  const baseUrl = trimSlash(rec.baseUrl);
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  if (!baseUrl) {
    return { error: 'NO_BASE_URL', protocol, timeoutMs };
  }
  if (!key) {
    return { error: 'NO_KEY', protocol, timeoutMs };
  }

  // 发送前先过一道明文检查（详见 checkCleartext 说明）。
  if (!opts.skipCleartextCheck) {
    const blocked = checkCleartext(baseUrl);
    if (blocked) {
      return { error: blocked.kind, protocol, timeoutMs, message: blocked.message, detail: blocked.detail };
    }
  }

  switch (protocol) {
    case 'anthropic':
      return anthropicProbe(baseUrl, key, model, timeoutMs);
    case 'google':
      return googleProbe(baseUrl, key, model, timeoutMs);
    case 'azure':
      return azureProbe(baseUrl, key, model, timeoutMs);
    case 'cohere':
      return cohereProbe(baseUrl, key, model, timeoutMs);
    default:
      return openaiProbe(baseUrl, key, model, timeoutMs);
  }
}

/**
 * 取「常用模型」的第一个。
 * 用户可能填 `gpt-4o, o3-mini`，也可能用分号、顿号或换行分隔。
 */
function firstModel(models) {
  const s = String(models || '').trim();
  if (!s) return '';
  // 逗号（中英）、分号、顿号、换行、制表符都视为分隔符
  const parts = s.split(/[,;，；、\r\n\t]+/).map((x) => x.trim()).filter(Boolean);
  return parts[0] || '';
}

/* ------------------------------ 各协议实现 ------------------------------ */

function openaiProbe(baseUrl, key, model, timeoutMs) {
  // 未填模型时退化为「列模型」接口：只验 key 与网络，不涉及模型名
  if (!model) {
    return {
      protocol: 'openai',
      method: 'GET',
      url: `${baseUrl}/models`,
      headers: authHeaders('bearer', key),
      body: null,
      timeoutMs,
      modelTested: null,
      note: 'NO_MODEL'
    };
  }
  const headers = authHeaders('bearer', key);
  headers['Content-Type'] = 'application/json';
  return {
    protocol: 'openai',
    method: 'POST',
    url: `${baseUrl}/chat/completions`,
    headers,
    body: { model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
    timeoutMs,
    modelTested: model
  };
}

function anthropicProbe(baseUrl, key, model, timeoutMs) {
  const m = model || 'claude-3-5-haiku-20241022';
  const headers = authHeaders('anthropic', key);
  headers['anthropic-version'] = '2023-06-01';
  headers['Content-Type'] = 'application/json';
  return {
    protocol: 'anthropic',
    method: 'POST',
    url: `${baseUrl}/v1/messages`,
    headers,
    body: { model: m, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] },
    timeoutMs,
    modelTested: model || null,
    note: model ? null : 'DEFAULT_MODEL'
  };
}

function googleProbe(baseUrl, key, model, timeoutMs) {
  // Google 用查询参数传 key，且模型名出现在路径里
  if (!model) {
    return {
      protocol: 'google',
      method: 'GET',
      url: `${baseUrl}/v1beta/models?key=${encodeURIComponent(key)}`,
      headers: {},
      body: null,
      timeoutMs,
      modelTested: null,
      note: 'NO_MODEL'
    };
  }
  return {
    protocol: 'google',
    method: 'POST',
    url: `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
    headers: { 'Content-Type': 'application/json' },
    body: { contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } },
    timeoutMs,
    modelTested: model
  };
}

function azureProbe(baseUrl, key, model, timeoutMs) {
  if (!model) {
    // Azure 的 deployment 名即模型名，没有它就无从探测
    return { error: 'MODEL_REQUIRED', protocol: 'azure', timeoutMs };
  }
  const headers = authHeaders('azure', key);
  headers['Content-Type'] = 'application/json';
  const apiVersion = AZURE_DEFAULT_API_VERSION;
  return {
    protocol: 'azure',
    method: 'POST',
    url: `${baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${apiVersion}`,
    headers,
    body: { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 },
    timeoutMs,
    modelTested: model
  };
}

function cohereProbe(baseUrl, key, model, timeoutMs) {
  if (!model) {
    return {
      protocol: 'cohere',
      method: 'GET',
      url: `${baseUrl}/v1/models`,
      headers: authHeaders('bearer', key),
      body: null,
      timeoutMs,
      modelTested: null,
      note: 'NO_MODEL'
    };
  }
  const headers = authHeaders('bearer', key);
  headers['Content-Type'] = 'application/json';
  return {
    protocol: 'cohere',
    method: 'POST',
    url: `${baseUrl}/v1/chat`,
    headers,
    body: { model, message: 'hi', max_tokens: 1 },
    timeoutMs,
    modelTested: model
  };
}

/* ------------------------------ 结果解读 ------------------------------ */

/**
 * 把 HTTP 响应解读成用户能据以行动的结论。
 *
 * 为什么要把错误分类：这四类失败的处置方式完全不同——
 * 网络不通要查代理/网络，密钥无效要重新申请，模型不存在要改模型名，
 * 限流则只是暂时现象。混成一句「测试失败」等于没帮上忙。
 */
function interpret(status, bodyText, probe) {
  const text = String(bodyText || '');
  const low = text.toLowerCase();

  if (status >= 200 && status < 300) {
    return {
      ok: true,
      kind: 'OK',
      message: probe.modelTested
        ? `连通正常（已验证模型 ${probe.modelTested}）`
        : '连通正常（已验证密钥有效，未验证模型名）',
      detail: ''
    };
  }

  // 从响应体里挖出服务端的原始说明，它通常最具体
  let serverMsg = '';
  try {
    const j = JSON.parse(text);
    serverMsg = (j.error && (j.error.message || j.error.type))
      || j.message
      || (j.error && typeof j.error === 'string' ? j.error : '')
      || '';
  } catch (_) {
    serverMsg = text.slice(0, 300);
  }

  if (status === 401 || status === 403) {
    return { ok: false, kind: 'AUTH', message: '密钥无效或无权限', detail: serverMsg };
  }
  if (status === 404) {
    // 404 有两种含义，必须区分：模型不存在（要改模型名）
    // 还是路径不对（要改 baseUrl）。用户下一步动作完全不同。
    //
    // 判定依据：响应体里明确提到 model/deployment 才算「模型问题」；
    // 否则归为地址问题——因为很多网关的 404 是通用 HTML 页，
    // 若默认归为「模型不可用」，用户会去反复改模型名而徒劳。
    if (/model|deployment/i.test(low)) {
      return { ok: false, kind: 'NO_MODEL', message: '模型不存在或无权限访问', detail: serverMsg };
    }
    return {
      ok: false, kind: 'BAD_URL',
      message: '接口地址可能不正确（404）', detail: serverMsg
    };
  }
  if (status === 429) {
    return { ok: false, kind: 'RATE_LIMIT', message: '被限流或额度不足（429）', detail: serverMsg };
  }
  if (status === 400) {
    if (/model/i.test(low) && /(not exist|not found|invalid|unknown)/i.test(low)) {
      return { ok: false, kind: 'NO_MODEL', message: '模型名无法识别', detail: serverMsg };
    }
    return { ok: false, kind: 'BAD_REQUEST', message: `请求被拒绝（400）`, detail: serverMsg };
  }
  if (status >= 500) {
    return { ok: false, kind: 'SERVER', message: `服务端错误（${status}）`, detail: serverMsg };
  }
  return { ok: false, kind: 'HTTP', message: `请求失败（${status}）`, detail: serverMsg };
}

module.exports = {
  PROTOCOL,
  DEFAULT_TIMEOUT_MS,
  AUTH_HEADER,
  authHeaders,
  buildProbe,
  firstModel,
  interpret,
  isPrivateHost,
  checkCleartext
};
