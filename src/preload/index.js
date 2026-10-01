/**
 * 预加载脚本：渲染进程只能通过这里暴露的白名单方法访问主进程。
 * 明文密钥默认不出主进程，界面拿到的是掩码。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('vault', {
  status: () => call('vault:status'),

  // 列表与增删改
  list: () => call('vault:list'),
  get: (id) => call('vault:get', id),
  create: (payload) => call('vault:create', payload),
  update: (id, payload) => call('vault:update', id, payload),
  remove: (id) => call('vault:remove', id),

  // 密钥操作（在主进程内完成）
  copy: (id) => call('vault:copy', id),
  reveal: (id) => call('vault:reveal', id),

  // 设置
  settings: () => call('settings:get'),
  saveSettings: (patch) => call('settings:save', patch),

  // 导入导出
  exportVault: (opts) => call('vault:export', opts),
  importVault: (opts) => call('vault:import', opts),

  // 背景图
  pickBackground: () => call('bg:pick'),
  loadBackground: () => call('bg:load'),
  clearBackground: () => call('bg:clear'),

  // 杂项
  createShortcut: () => call('app:createShortcut'),
  openExternal: (url) => call('app:openExternal', url),
  info: () => call('app:info'),
  revealExternal: (p) => call('app:showItem', p)
});
