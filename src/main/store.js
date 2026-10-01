/**
 * 数据仓库：所有记录以加密容器形式落盘，明文只在内存中。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadOrCreateDeviceKey, encryptJSON, decryptJSON } = require('./crypto');

const EMPTY = { version: 1, records: [] };

class Store {
  constructor(dir) {
    this.dir = dir;
    this.keyPath = path.join(dir, 'device.key');
    this.vaultPath = path.join(dir, 'vault.enc');
    this.settingsPath = path.join(dir, 'settings.json');
    fs.mkdirSync(dir, { recursive: true });
    this.keyMaterial = loadOrCreateDeviceKey(this.keyPath).toString('hex');
    this.data = this._read();
    this.settings = this._readSettings();
  }

  _read() {
    if (!fs.existsSync(this.vaultPath)) return structuredClone(EMPTY);
    try {
      const raw = fs.readFileSync(this.vaultPath, 'utf8');
      const obj = decryptJSON(raw, this.keyMaterial);
      if (!Array.isArray(obj.records)) obj.records = [];
      return obj;
    } catch (err) {
      // 不覆盖原文件，转存备份后以空库启动，避免数据静默丢失
      try {
        fs.copyFileSync(this.vaultPath, this.vaultPath + '.corrupt-' + Date.now());
        fs.unlinkSync(this.vaultPath);
      } catch (_) { /* ignore */ }
      return structuredClone(EMPTY);
    }
  }

  _write() {
    const tmp = this.vaultPath + '.tmp';
    fs.writeFileSync(tmp, encryptJSON(this.data, this.keyMaterial), 'utf8');
    fs.renameSync(tmp, this.vaultPath);
  }

  _readSettings() {
    const defaults = {
      language: 'zh',
      theme: {
        accent: '#5B8DEF',
        accent2: '#7C6CF0',
        bg: '#F6F7FB',
        surface: '#FFFFFF',
        text: '#1B1F2A',
        muted: '#6B7280',
        radius: 14,
        mode: 'light'
      },
      background: { image: '', opacity: 0.18, blur: 0, size: 'cover', dim: 0 },
      list: { density: 'comfortable', sort: 'updated', showProvider: true },
      privacy: { autoHideSeconds: 30, maskStyle: 'prefix' }
    };
    if (!fs.existsSync(this.settingsPath)) return defaults;
    try {
      const saved = JSON.parse(fs.readFileSync(this.settingsPath, 'utf8'));
      return deepMerge(defaults, saved);
    } catch (_) {
      return defaults;
    }
  }

  saveSettings(patch) {
    this.settings = deepMerge(this.settings, patch || {});
    fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
    return this.settings;
  }

  /* ---------------- 记录 ---------------- */

  list() {
    return this.data.records.map((r) => this._public(r));
  }

  get(id) {
    const r = this.data.records.find((x) => x.id === id);
    return r ? this._public(r) : null;
  }

  getCredential(id) {
    const r = this.data.records.find((x) => x.id === id);
    return r ? r.credential : null;
  }

  create(payload) {
    const now = new Date().toISOString();
    const rec = {
      id: crypto.randomUUID(),
      provider: String(payload.provider || 'custom'),
      label: String(payload.label || '').trim() || 'Untitled key',
      credential: String(payload.credential || ''),
      note: String(payload.note || ''),
      tags: Array.isArray(payload.tags) ? payload.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      baseUrl: String(payload.baseUrl || ''),
      models: String(payload.models || ''),
      favorite: !!payload.favorite,
      disabled: false,
      createdAt: now,
      updatedAt: now,
      usageCount: 0,
      lastUsedAt: null
    };
    this.data.records.unshift(rec);
    this._write();
    return this._public(rec);
  }

  update(id, payload) {
    const rec = this.data.records.find((x) => x.id === id);
    if (!rec) throw new Error('NOT_FOUND');
    const fields = ['provider', 'label', 'note', 'baseUrl', 'models', 'favorite', 'disabled'];
    for (const f of fields) {
      if (payload[f] !== undefined) rec[f] = f === 'favorite' || f === 'disabled' ? !!payload[f] : payload[f];
    }
    if (payload.tags !== undefined && Array.isArray(payload.tags)) {
      rec.tags = payload.tags.map((t) => String(t).trim()).filter(Boolean);
    }
    // 空字符串视为「不修改密钥」，避免误清空
    if (typeof payload.credential === 'string' && payload.credential.length > 0) rec.credential = payload.credential;
    rec.updatedAt = new Date().toISOString();
    this._write();
    return this._public(rec);
  }

  remove(id) {
    const i = this.data.records.findIndex((x) => x.id === id);
    if (i === -1) throw new Error('NOT_FOUND');
    const [removed] = this.data.records.splice(i, 1);
    this._write();
    return { id: removed.id, label: removed.label };
  }

  touch(id) {
    const rec = this.data.records.find((x) => x.id === id);
    if (!rec) return null;
    rec.usageCount = (rec.usageCount || 0) + 1;
    rec.lastUsedAt = new Date().toISOString();
    this._write();
    return this._public(rec);
  }

  counts() {
    const byProvider = {};
    for (const r of this.data.records) byProvider[r.provider] = (byProvider[r.provider] || 0) + 1;
    return { total: this.data.records.length, byProvider };
  }

  /** 对外快照：绝不含密钥明文 */
  _public(rec) {
    return {
      id: rec.id,
      provider: rec.provider,
      label: rec.label,
      note: rec.note,
      tags: rec.tags,
      baseUrl: rec.baseUrl,
      models: rec.models,
      favorite: !!rec.favorite,
      disabled: !!rec.disabled,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      usageCount: rec.usageCount || 0,
      lastUsedAt: rec.lastUsedAt,
      mask: maskCredential(rec.credential, this.settings.privacy.maskStyle),
      length: (rec.credential || '').length
    };
  }

  /* ---------------- 导入导出 ---------------- */

  dumpRaw() {
    return structuredClone(this.data);
  }

  replaceAll(obj, mode = 'merge') {
    const incoming = Array.isArray(obj && obj.records) ? obj.records : [];
    if (mode === 'replace') {
      this.data.records = incoming;
    } else {
      const byId = new Map(this.data.records.map((r) => [r.id, r]));
      for (const r of incoming) {
        if (byId.has(r.id)) {
          byId.get(r.id).updatedAt = r.updatedAt;
          Object.assign(byId.get(r.id), r);
        } else {
          this.data.records.unshift(r);
        }
      }
    }
    this._write();
    return this.counts();
  }
}

function maskCredential(value, style) {
  const s = String(value || '');
  if (!s) return '';
  const st = style || 'prefix';
  const tail = s.length >= 4 ? s.slice(-4) : s;
  const head = s.length > 12 ? s.slice(0, 4) : '';
  if (st === 'tail') return `••••••••${tail}`;
  if (st === 'full') return '•'.repeat(s.length > 12 ? 12 : 8);
  return head ? `${head}••••••••${tail}` : `••••••••${tail}`;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { Store, maskCredential };
