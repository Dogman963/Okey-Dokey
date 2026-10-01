/**
 * 预览截图 / preview screenshots
 * 用隔离的数据目录灌入示例数据，产出亮色与暗色两张界面截图。
 * 运行：npx electron tools/shot.js
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const TMP = path.join(os.tmpdir(), 'okey-dokey-shot-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
app.setPath('userData', TMP);

const OUT = path.join(__dirname, '..', 'docs', 'images');
fs.mkdirSync(OUT, { recursive: true });

require('../src/main/index.js');

const SAMPLE = [
  { provider: 'openai',       label: 'OpenAI 生产主密钥',   note: '线上服务主用，额度 5000 美元/月，2026-12-31 到期。负责人：张工', tags: ['生产', 'chat'], models: 'gpt-4o, o3-mini', favorite: true },
  { provider: 'anthropic',    label: 'Claude 长文分析',     note: '用于长文档摘要与合同审阅，注意 rate limit 较紧。', tags: ['分析'], models: 'claude-sonnet-4' },
  { provider: 'deepseek',     label: 'DeepSeek 备用',       note: '成本低，跑批处理任务用。', tags: ['批量', '备用'], models: 'deepseek-chat' },
  { provider: 'zhipu',        label: '智谱 GLM 测试',       note: '内部测试环境，额度有限，勿用于生产。', tags: ['测试'] },
  { provider: 'moonshot',     label: 'Kimi 中文摘要',       note: '中文语料摘要与抽取任务。', tags: ['中文'], models: 'moonshot-v1-128k' },
  { provider: 'siliconflow',  label: 'SiliconFlow 多模型',  note: '聚合平台，按量计费，用于对比评测。', tags: ['评测'] }
];

app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2200);

  await js('window.__SAMPLES = ' + JSON.stringify(SAMPLE) + '; true;');
  await js(`(async () => {
    for (const s of window.__SAMPLES) {
      const idx = window.__SAMPLES.indexOf(s);
      await window.vault.create({
        provider: s.provider, label: s.label, note: s.note, tags: s.tags, models: s.models || '',
        favorite: !!s.favorite,
        credential: 'sk-' + s.provider + '-demo-' + String(1000000 + idx * 137).repeat(3)
      });
    }
    return true;
  })()`);

  await js('location.reload(); true;');
  await wait(2500);

  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, name), img.toPNG());
    return name;
  };

  await shot('ui-light.png');

  // 暗色主题
  await js(`(async () => {
    document.getElementById('settingsBtn').click();
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('[data-preset="midnight"]').click();
    await new Promise(r => setTimeout(r, 600));
    document.querySelector('.overlay [data-x]').click();
    return true;
  })()`);
  await wait(900);
  await shot('ui-dark.png');

  // 英文界面 + 亮色
  await js(`(async () => {
    document.getElementById('langBtn').click();
    await new Promise(r => setTimeout(r, 700));
    document.getElementById('settingsBtn').click();
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('[data-preset="indigo"]').click();
    await new Promise(r => setTimeout(r, 500));
    document.querySelector('.overlay [data-x]').click();
    return true;
  })()`);
  await wait(900);
  await shot('ui-en.png');

  console.log('SHOTS_OK ' + JSON.stringify(fs.readdirSync(OUT)));
  app.exit(0);
});
