/**
 * 截图专用 preload（独立实现，不包装真实 preload）。
 *
 * 为什么不包装：真实 preload 用 contextBridge 暴露 window.vault，该属性不可写；
 * 在同一 preload 里二次 expose 也会报错。所以这里直接实现等价的桥接。
 *
 * 关键限制（已实测）：preload 运行在 sandbox 下，**只有 electron 模块可用**，
 * require('fs') / require('path') 会报 "module not found"。
 * 因此版本号直接写常量，不从 package.json 读。
 *
 * 仅用于生成文档截图，不参与产品运行。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

const MOBILE_DIR = 'file:///data/user/0/local.okeydokey.vault/files/okey-dokey/';
const APP_VERSION = '1.2.4';   // 沙箱内无法读 package.json；截图用，发版时同步

contextBridge.exposeInMainWorld('vault', {
  status: async () => ({
    ok: true,
    data: {
      total: 0,
      dataDir: MOBILE_DIR,
      keyPath: MOBILE_DIR + 'device.key',
      vaultPath: MOBILE_DIR + 'vault.enc',
      keyExists: true,
      platform: 'android'
    }
  }),

  info: async () => ({
    ok: true,
    data: {
      version: APP_VERSION,
      electron: '',
      node: '',
      chrome: '',
      platform: 'android',
      dataDir: MOBILE_DIR,
      packaged: true,
      exePath: ''
    }
  }),

  // 其余照常走主进程（有真实数据）
  list: () => call('vault:list'),
  get: (id) => call('vault:get', id),
  create: (payload) => call('vault:create', payload),
  update: (id, payload) => call('vault:update', id, payload),
  remove: (id) => call('vault:remove', id),
  copy: (id) => call('vault:copy', id),
  reveal: (id) => call('vault:reveal', id),
  test: (id) => call('vault:test', id),
  settings: () => call('settings:get'),
  saveSettings: (patch) => call('settings:save', patch),
  exportVault: (opts) => call('vault:export', opts),
  importVault: (opts) => call('vault:import', opts),
  pickBackground: () => call('bg:pick'),
  loadBackground: () => call('bg:load'),
  clearBackground: () => call('bg:clear'),
  createShortcut: () => call('app:createShortcut'),
  openExternal: (url) => call('app:openExternal', url),
  revealExternal: (p) => call('app:showItem', p)
});
