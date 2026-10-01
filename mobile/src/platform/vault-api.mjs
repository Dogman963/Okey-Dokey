/**
 * 移动端「平台实现」：向界面暴露与桌面端 preload **同名同形**的 window.vault。
 *
 * 桌面端由 Electron preload 通过 IPC 转发；安卓端在 WebView 内直接调用本地实现
 * （Capacitor Filesystem / Clipboard / Share）——界面代码完全不用改。
 *
 * 返回约定与桌面端一致：{ ok: true, data } / { ok: false, error }
 */
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Clipboard } from '@capacitor/clipboard';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';
import { CapacitorHttp } from '@capacitor/core';
import { Store } from './store.mjs';
import { encryptWithPassphrase, decryptWithPassphrase, isExportPackage, b64decode, b64encode } from './crypto.mjs';
import { buildProbe, interpret, DEFAULT_TIMEOUT_MS } from '../../../src/shared/connectivity.js';

const APP_VERSION = '1.2.3';
const BG_DIR = 'background';

let store = null;
let clipboardTimer = null;

const ok = (data) => ({ ok: true, data });
const fail = (err) => ({ ok: false, error: String((err && err.message) || err) });

/** 把可能抛错的操作包成桌面端同形的返回值 */
async function guard(fn) {
  try { return ok(await fn()); } catch (err) { return fail(err); }
}

/** 已登记的导入处理器：由「用 Okey Dokey 打开」文件触发 */
let pendingImport = null;

export function setPendingImport(payload) {
  pendingImport = payload;
}

export function takePendingImport() {
  const p = pendingImport;
  pendingImport = null;
  return p;
}

/* ---------------------------- 背景图 ---------------------------- */

async function ensureBgDir() {
  try { await Filesystem.mkdir({ path: BG_DIR, directory: Directory.Data, recursive: true }); } catch (_) {}
}

async function clearBgFiles() {
  try {
    const res = await Filesystem.readdir({ path: BG_DIR, directory: Directory.Data });
    for (const f of res.files) {
      try { await Filesystem.deleteFile({ path: `${BG_DIR}/${f.name}`, directory: Directory.Data }); } catch (_) {}
    }
  } catch (_) {}
}

async function toDataUrl(path) {
  try {
    const res = await Filesystem.readFile({ path, directory: Directory.Data });
    const b64 = typeof res.data === 'string' ? res.data : '';
    if (!b64) return '';
    const ext = (path.split('.').pop() || 'png').toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${b64}`;
  } catch (_) {
    return '';
  }
}

/* ---------------------------- 导出文件 ---------------------------- */

/** 导出目录：应用 Documents（用户可见，便于「文件」App 取走） */
const EXPORT_DIR = 'OkeyDokey';

async function writeExportFile(name, text) {
  try { await Filesystem.mkdir({ path: EXPORT_DIR, directory: Directory.Documents, recursive: true }); } catch (_) {}
  const res = await Filesystem.writeFile({
    path: `${EXPORT_DIR}/${name}`,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
    data: text,
    recursive: true
  });
  return res.uri || `${EXPORT_DIR}/${name}`;
}

/* ---------------------------- 核心实现 ---------------------------- */

export async function createVaultApi() {
  store = new Store();
  await store.init();
  await ensureBgDir();

  const api = {
    /* --- 状态与信息 --- */
    status: () => guard(async () => ({
      total: store.counts().total,
      dataDir: await store.dataDirUri(),
      keyPath: `${await store.dataDirUri()}/device.key`,
      vaultPath: `${await store.dataDirUri()}/vault.enc`,
      keyExists: true,
      platform: 'android'
    })),

    info: () => guard(async () => ({
      version: APP_VERSION,
      electron: '',
      node: '',
      chrome: navigator.userAgent,
      platform: 'android',
      dataDir: await store.dataDirUri(),
      packaged: true,
      exePath: ''
    })),

    /* --- 记录 --- */
    list: () => guard(() => store.list()),
    get: (id) => guard(() => store.get(id)),
    create: (payload) => guard(() => store.create(payload || {})),
    update: (id, payload) => guard(() => store.update(id, payload || {})),
    remove: (id) => guard(() => store.remove(id)),

    /* --- 密钥操作（快路径：不等落盘，见 store.touch 注释） --- */
    reveal: (id) => guard(async () => {
      const value = store.getCredential(id);
      if (value === null) throw new Error('NOT_FOUND');
      store.touch(id);
      return { value };
    }),

    copy: (id) => guard(async () => {
      const value = store.getCredential(id);
      if (!value) throw new Error('NOT_FOUND');
      await Clipboard.write({ string: value });
      store.touch(id);
      // 与桌面端一致：30 秒后清空剪贴板（若内容仍是该密钥）。
      //
      // 已知局限：App 切到后台时 WebView 会冻结定时器，这条清除可能不执行。
      // 真正可靠需要原生 ClipboardManager 的 onPrimaryClipChanged 监听；
      // 本项目当前刻意保持最小权限面（无额外原生依赖），故如实记录而非假称已解决。
      if (clipboardTimer) clearTimeout(clipboardTimer);
      clipboardTimer = setTimeout(async () => {
        try {
          const cur = await Clipboard.read();
          if (cur && cur.value === value) await Clipboard.write({ string: '' });
        } catch (_) {}
      }, 30000);
      return { copied: true, autoClearSeconds: 30 };
    }),

    /* --- 设置 --- */
    settings: () => guard(() => store.settings),
    saveSettings: (patch) => guard(() => store.saveSettings(patch || {})),

    /* --- 背景图 --- */
    pickBackground: () => guard(async () => {
      const src = await pickImageFile();
      if (!src) return { canceled: true };
      await clearBgFiles();
      await ensureBgDir();
      const ext = (src.name.split('.').pop() || 'png').toLowerCase();
      const dest = `${BG_DIR}/background.${ext}`;
      await Filesystem.writeFile({ path: dest, directory: Directory.Data, data: src.base64 });
      await store.saveSettings({ background: { image: dest } });
      return { path: dest, dataUrl: await toDataUrl(dest) };
    }),

    loadBackground: () => guard(async () => {
      const p = (store.settings.background && store.settings.background.image) || '';
      if (!p) return { dataUrl: '' };
      return { dataUrl: await toDataUrl(p) };
    }),

    clearBackground: () => guard(async () => {
      await store.saveSettings({ background: { image: '' } });
      await clearBgFiles();
      return true;
    }),

    /* --- 导入导出（跨设备迁移的核心通道） --- */
    exportVault: (opts) => guard(async () => {
      const o = opts || {};
      // 导出前把合并中的用量计数落盘，避免导出内容与最新状态不一致
      await store.flush();
      const payload = store.dumpRaw();
      const stamp = new Date().toISOString().slice(0, 10);
      const encrypted = o.mode !== 'plain';
      const ext = encrypted ? 'okeyvault' : 'json';
      const name = `okey-dokey-backup-${stamp}.${ext}`;
      let text;
      if (encrypted) {
        if (!o.passphrase || String(o.passphrase).length < 6) throw new Error('WEAK_PASSPHRASE');
        const pkg = await encryptWithPassphrase(payload, String(o.passphrase), {
          producer: 'okey-dokey-android',
          producerVersion: APP_VERSION,
          recordCount: payload.records.length
        });
        text = JSON.stringify(pkg, null, 2);
      } else {
        text = JSON.stringify(payload, null, 2);
      }
      const path = await writeExportFile(name, text);
      // 触发系统分享面板：可发到微信 / 邮件 / 网盘 / 蓝牙，实现跨设备迁移
      if (o.share !== false) {
        try {
          await Share.share({ title: 'Okey Dokey 备份', text: name, url: path, dialogTitle: '导出密钥库' });
        } catch (_) { /* 用户取消分享不算失败 */ }
      }
      return { path: name, count: payload.records.length, encrypted };
    }),

    importVault: (opts) => guard(async () => {
      const o = opts || {};
      let raw = o.text;

      if (!raw) {
        // 优先用「用 Okey Dokey 打开」进来的内容，否则让用户选文件
        const pending = takePendingImport();
        if (pending) {
          raw = pending.text;
        } else {
          const picked = await pickAnyFile();
          if (!picked) return { canceled: true };
          raw = picked.text;
        }
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        throw new Error('BAD_FILE');
      }

      let payload = parsed;
      if (isExportPackage(parsed)) {
        if (!o.passphrase) throw new Error('PASSPHRASE_REQUIRED');
        payload = await decryptWithPassphrase(parsed, String(o.passphrase));
      }
      const counts = await store.replaceAll(payload, o.mode === 'replace' ? 'replace' : 'merge');
      return { counts, mode: o.mode === 'replace' ? 'replace' : 'merge' };
    }),

    /* --- 连通性测试：走原生网络栈（CapacitorHttp），绕开 WebView 的 CORS ----
       若用 WebView 的 fetch，几乎所有的 API 都会因缺 Access-Control-Allow-Origin 失败，
       那会把「服务商不允许浏览器直连」误报成「你的密钥有问题」。 */
    test: (id) => guard(async () => {
      const rec = store.get(id);
      if (!rec) throw new Error('NOT_FOUND');

      const probe = buildProbe({ ...rec, credential: store.getCredential(id) });
      if (probe.error) {
        const fallback = {
          NO_BASE_URL: '未填写接口地址，无法测试',
          NO_KEY: '该记录没有密钥内容',
          MODEL_REQUIRED: '该服务商需要填写模型名（Azure 用部署名当作模型名）',
          CLEARTEXT_BLOCKED: '该地址是公网却使用 http（明文），已阻止以保护密钥',
          BAD_URL: '接口地址格式不正确'
        };
        return {
          ok: false,
          kind: probe.error,
          message: probe.message || fallback[probe.error] || '无法测试',
          detail: probe.detail || ''
        };
      }

      const started = Date.now();
      const timeoutMs = probe.timeoutMs || DEFAULT_TIMEOUT_MS;
      try {
        const res = await CapacitorHttp.request({
          url: probe.url,
          method: probe.method,
          headers: probe.headers,
          data: probe.body || undefined,
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs
        });
        const bodyText = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const verdict = interpret(res.status, bodyText, probe);
        return {
          ...verdict,
          status: res.status,
          elapsedMs: Date.now() - started,
          modelTested: probe.modelTested || null
        };
      } catch (err) {
        const msg = String((err && err.message) || err);
        const timedOut = /timeout|timed out/i.test(msg);
        return {
          ok: false,
          kind: timedOut ? 'TIMEOUT' : 'NETWORK',
          message: timedOut
            ? `请求超时（${Math.round(timeoutMs / 1000)} 秒）`
            : `网络不通或无法连接：${msg}`,
          detail: '',
          elapsedMs: Date.now() - started
        };
      }
    }),

    /* --- 桌面端专属方法：移动端给出无害等价实现，保证界面不报错 --- */
    createShortcut: () => guard(async () => ({ created: [], exe: '' })),
    openExternal: (url) => guard(async () => {
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('BAD_URL');
      window.open(url, '_blank', 'noopener');
      return true;
    }),
    revealExternal: () => guard(async () => true),

    /* --- 安卓专属：主动分享当前导出包 --- */
    shareExport: (opts) => guard(async () => {
      const p = (opts && opts.path) || '';
      if (!p) throw new Error('NO_PATH');
      await Share.share({ title: 'Okey Dokey 备份', url: await store.dataDirUri(), dialogTitle: '分享备份' });
      return true;
    }),

    /* --- 供 boot 在切后台时调用：把合并中的计数落盘 --- */
    flushPending: () => guard(() => store.flush())
  };

  return api;
}

/* ---------------------------- 文件选择 ---------------------------- */

/** 用隐藏的 <input type=file> 选图片，返回 base64（不依赖额外插件权限） */
function pickImageFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return finish(null);
      const text = await readAsDataURL(f);
      finish({ name: f.name, base64: String(text).split(',')[1] || '' });
    };
    // 用户取消时 change 不触发；由 window 的 focus 兜底
    window.addEventListener('focus', () => setTimeout(() => finish(null), 800), { once: true });
    input.click();
  });
}

/** 选任意备份/文本文件，返回文本内容 */
function pickAnyFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.okeyvault,.json,application/json,text/plain';
    input.style.display = 'none';
    document.body.appendChild(input);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.onchange = async () => {
      const f = input.files && input.files[0];
      if (!f) return finish(null);
      const text = await f.text();
      finish({ name: f.name, text });
    };
    window.addEventListener('focus', () => setTimeout(() => finish(null), 800), { once: true });
    input.click();
  });
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}
