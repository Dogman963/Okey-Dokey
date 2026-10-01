/**
 * 服务商目录 / Provider catalogue.
 * 主进程与渲染进程共用（UMD 形式），仅存放展示信息，不含任何密钥。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PROVIDERS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // zh: 中文名, en: 英文名
  return [
    { id: 'openai',      zh: 'OpenAI',            en: 'OpenAI',            baseUrl: 'https://api.openai.com/v1',                  docs: 'https://platform.openai.com/api-keys' },
    { id: 'anthropic',   zh: 'Anthropic Claude',  en: 'Anthropic Claude',  baseUrl: 'https://api.anthropic.com',                  docs: 'https://console.anthropic.com/settings/keys' },
    { id: 'google',      zh: 'Google Gemini',     en: 'Google Gemini',     baseUrl: 'https://generativelanguage.googleapis.com',   docs: 'https://aistudio.google.com/app/apikey' },
    { id: 'azure',       zh: 'Azure OpenAI',      en: 'Azure OpenAI',      baseUrl: 'https://<resource>.openai.azure.com',         docs: 'https://portal.azure.com' },
    { id: 'deepseek',    zh: '深度求索 DeepSeek',  en: 'DeepSeek',          baseUrl: 'https://api.deepseek.com/v1',                 docs: 'https://platform.deepseek.com/api_keys' },
    { id: 'zhipu',       zh: '智谱 GLM',           en: 'Zhipu GLM',         baseUrl: 'https://open.bigmodel.cn/api/paas/v4',        docs: 'https://open.bigmodel.cn/usercenter/apikeys' },
    { id: 'qwen',        zh: '阿里通义千问',        en: 'Alibaba Qwen',      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', docs: 'https://bailian.console.aliyun.com' },
    { id: 'moonshot',    zh: '月之暗面 Kimi',      en: 'Moonshot Kimi',     baseUrl: 'https://api.moonshot.cn/v1',                  docs: 'https://platform.moonshot.cn/console/api-keys' },
    { id: 'minimax',     zh: 'MiniMax',           en: 'MiniMax',           baseUrl: 'https://api.minimax.chat/v1',                 docs: 'https://platform.minimaxi.com' },
    { id: 'baichuan',    zh: '百川智能',           en: 'Baichuan',          baseUrl: 'https://api.baichuan-ai.com/v1',              docs: 'https://platform.baichuan-ai.com' },
    { id: 'stepfun',     zh: '阶跃星辰 StepFun',   en: 'StepFun',           baseUrl: 'https://api.stepfun.com/v1',                  docs: 'https://platform.stepfun.com' },
    { id: 'spark',       zh: '讯飞星火',           en: 'iFlytek Spark',     baseUrl: 'https://spark-api-open.xf-yun.com/v1',        docs: 'https://console.xfyun.cn' },
    { id: 'hunyuan',     zh: '腾讯混元',           en: 'Tencent Hunyuan',   baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',    docs: 'https://console.cloud.tencent.com/hunyuan' },
    { id: 'doubao',      zh: '字节豆包（火山方舟）', en: 'ByteDance Doubao',  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',    docs: 'https://console.volcengine.com/ark' },
    { id: 'siliconflow', zh: '硅基流动 SiliconFlow', en: 'SiliconFlow',      baseUrl: 'https://api.siliconflow.cn/v1',               docs: 'https://cloud.siliconflow.cn/account/ak' },
    { id: 'mistral',     zh: 'Mistral AI',        en: 'Mistral AI',        baseUrl: 'https://api.mistral.ai/v1',                   docs: 'https://console.mistral.ai/api-keys' },
    { id: 'cohere',      zh: 'Cohere',            en: 'Cohere',            baseUrl: 'https://api.cohere.com',                      docs: 'https://dashboard.cohere.com/api-keys' },
    { id: 'xai',         zh: 'xAI Grok',          en: 'xAI Grok',          baseUrl: 'https://api.x.ai/v1',                         docs: 'https://console.x.ai' },
    { id: 'groq',        zh: 'Groq',              en: 'Groq',              baseUrl: 'https://api.groq.com/openai/v1',              docs: 'https://console.groq.com/keys' },
    { id: 'together',    zh: 'Together AI',       en: 'Together AI',       baseUrl: 'https://api.together.xyz/v1',                 docs: 'https://api.together.ai/settings/api-keys' },
    { id: 'openrouter',  zh: 'OpenRouter',        en: 'OpenRouter',        baseUrl: 'https://openrouter.ai/api/v1',                docs: 'https://openrouter.ai/keys' },
    { id: 'ollama',      zh: 'Ollama 本地',        en: 'Ollama (local)',    baseUrl: 'http://localhost:11434/v1',                   docs: 'https://ollama.com' },
    { id: 'custom',      zh: '自建 / 其他',        en: 'Self-hosted / Other', baseUrl: '',                                          docs: '' }
  ];
});
