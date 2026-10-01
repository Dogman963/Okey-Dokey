/**
 * 数据仓库（安卓端）— 与桌面端 `src/main/store.js` 行为一致。
 *
 * 落盘位置：Capacitor Filesystem 的 Data 目录（应用私有空间）
 *   vault.enc     加密仓库容器
 *   device.key    本机设备密钥（32 字节随机数，hex 文本 64 字符）
 *   settings.json 设置（明文，不含密钥）
 *
 * 数据对象结构与桌面端逐字段一致，因此两端可互相导入导出。
 */
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { loadOrCreateDeviceKey, encryptJSON, decryptJSON } from './crypto.mjs';

export const EMPTY = { version: 1, records: [] };

const FILES = {
  key: 'device.key',
  vault: 'vault.enc',
  settings: 'settings.json'
};

function defaultSettings() {
  return {
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

export class Store {
  constructor() {
    this.dir = 'okey-dokey';
    this.settings = defaultSettings();
    this.data = structuredClone(EMPTY);
    this._flushTimer = null;
    this._dirty = false;
  }

  /* --------------------------- 底层读写 --------------------------- */

  async _ensureDir() {
    try {
      await Filesystem.mkdir({ path: this.dir, directory: Directory.Data, recursive: true });
    } catch (_) { /* 已存在 */ }
  }

  _p(name) {
    return `${this.dir}/${name}`;
  }

  async _readText(name) {
    try {
      const res = await Filesystem.readFile({ path: this._p(name), directory: Directory.Data, encoding: Encoding.UTF8 });
      return typeof res.data === 'string' ? res.data : null;
    } catch (_) {
      return null;
    }
  }

  async _writeText(name, text) {
    await this._ensureDir();
    await Filesystem.writeFile({ path: this._p(name), directory: Directory.Data, encoding: Encoding.UTF8, data: text });
  }

  async _delete(name) {
    try { await Filesystem.deleteFile({ path: this._p(name), directory: Directory.Data }); } catch (_) {}
  }

  async _exists(name) {
    try { await Filesystem.stat({ path: this._p(name), directory: Directory.Data }); return true; } catch (_) { return false; }
  }

  /** 取数据目录的真实路径（供「导出到文件」「分享」使用） */
  async dataDirUri() {
    try {
      const uri = await Filesystem.getUri({ path: this.dir, directory: Directory.Data });
      return uri.uri;
    } catch (_) {
      return '';
    }
  }

  /* --------------------------- 初始化 --------------------------- */

  async init() {
    await this._ensureDir();

    // 设备密钥：不存在则生成（与桌面端同为 32 字节随机数的 hex）
    let keyHex = (await this._readText(FILES.key) || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
      keyHex = await loadOrCreateDeviceKey();
      await this._writeText(FILES.key, keyHex);
    }
    this.keyMaterial = keyHex;

    this.settings = await this._readSettings();
    this.data = await this._readVault();
    return this;
  }

  async _readVault() {
    const raw = await this._readText(FILES.vault);
    if (!raw) return structuredClone(EMPTY);
    try {
      const obj = await decryptJSON(raw, this.keyMaterial);
      if (!Array.isArray(obj.records)) obj.records = [];
      return obj;
    } catch (err) {
      // 不静默丢数据：留一份损坏备份，再以空库启动（与桌面端策略一致）
      try {
        await this._writeText(`${FILES.vault}.corrupt-${Date.now()}`, raw);
      } catch (_) {}
      await this._delete(FILES.vault);
      return structuredClone(EMPTY);
    }
  }

  async _write() {
    await this._writeText(FILES.vault, await encryptJSON(this.data, this.keyMaterial));
  }

  async _readSettings() {
    const raw = await this._readText(FILES.settings);
    if (!raw) return defaultSettings();
    try {
      return deepMerge(defaultSettings(), JSON.parse(raw));
    } catch (_) {
      return defaultSettings();
    }
  }

  async saveSettings(patch) {
    this.settings = deepMerge(this.settings, patch || {});
    await this._writeText(FILES.settings, JSON.stringify(this.settings, null, 2));
    return this.settings;
  }

  /* --------------------------- 记录 --------------------------- */

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

  async create(payload) {
    const now = new Date().toISOString();
    const rec = {
      id: uuid(),
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
    await this._write();
    return this._public(rec);
  }

  async update(id, payload) {
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
    await this._write();
    return this._public(rec);
  }

  async remove(id) {
    const i = this.data.records.findIndex((x) => x.id === id);
    if (i === -1) throw new Error('NOT_FOUND');
    const [removed] = this.data.records.splice(i, 1);
    await this._write();
    return { id: removed.id, label: removed.label };
  }

  /**
   * 记录一次使用。
   *
   * 刻意**不等待落盘**：调用方的场景是「点显示 / 点复制」，用户等的是明文，
   * 不是这次计数写盘。而写盘要整库重新加密（含一次纯 JS scrypt，手机上数百毫秒），
   * 让点击去等它，就变成「点了几秒才出结果」——这正是之前上报的卡顿。
   *
   * 改为合并调度：连续多次点击只写一次盘。
   */
  touch(id) {
    const rec = this.data.records.find((x) => x.id === id);
    if (!rec) return null;
    rec.usageCount = (rec.usageCount || 0) + 1;
    rec.lastUsedAt = new Date().toISOString();
    this._scheduleFlush();
    return this._public(rec);
  }

  /**
   * 合并写盘：一小段窗口内的多次改动只落一次盘。
   * 写盘成本主要在 scrypt 派生（本机 ~90ms，手机 2~4 倍），必须少做。
   */
  _scheduleFlush() {
    this._dirty = true;
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(async () => {
      this._flushTimer = null;
      if (!this._dirty) return;
      this._dirty = false;
      try {
        await this._write();
      } catch (err) {
        // 计数落盘失败不应影响「取用密钥」这件正事
        console.warn('[okey] 用量计数落盘失败（不影响本次取用）', err);
      }
    }, 400);
  }

  /** 立即落盘。导出/导入前、或页面隐藏前调用，确保计数不丢。 */
  async flush() {
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (!this._dirty) return;
    this._dirty = false;
    await this._write();
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

  /* --------------------------- 导入导出 --------------------------- */

  dumpRaw() {
    return structuredClone(this.data);
  }

  async replaceAll(obj, mode = 'merge') {
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
    await this._write();
    return this.counts();
  }
}

export function maskCredential(value, style) {
  const s = String(value || '');
  if (!s) return '';
  const st = style || 'prefix';
  const tail = s.length >= 4 ? s.slice(-4) : s;
  const head = s.length > 12 ? s.slice(0, 4) : '';
  if (st === 'tail') return `••••••••${tail}`;
  if (st === 'full') return '•'.repeat(s.length > 12 ? 12 : 8);
  return head ? `${head}••••••••${tail}` : `••••••••${tail}`;
}

/** 与桌面端 crypto.randomUUID() 同样产出 RFC 4122 v4 */
export function uuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
