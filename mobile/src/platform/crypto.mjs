/**
 * 加密模块（安卓端）— 与桌面端 `src/main/crypto.js` **字节级兼容**。
 *
 * 兼容性契约（改动前务必先读 docs/export-format.md）：
 *   容器字符串 : "OKEYDOKEY1:<salt b64>:<iv b64>:<tag b64>:<body b64>"
 *   设备密钥   : scrypt(hex(32B device key), salt, 32, N=16384, r=8, p=1)
 *   导出包密钥 : scrypt(passphrase,        salt, 32, N=32768, r=8, p=1)
 *   AEAD       : AES-256-GCM / 12 字节 IV / 16 字节 tag
 *   明文编码   : UTF-8 JSON
 *
 * 实现差异：AES-GCM 走 WebCrypto（原生，快）；scrypt 走纯 JS（scrypt-js），
 * 因为 WebCrypto 不提供 scrypt，而安卓 WebView 没有 node:crypto。
 * 两者输出必须完全相同，由 scripts/cross-compat-test.mjs 交叉验证。
 *
 * 注意：scrypt-js 是 CommonJS 包，在 Node 的 ESM 下命名导入会报错，
 * 因此先默认导入再解构；esbuild 打包成 IIFE 时两种写法等价。
 */
import scryptJs from 'scrypt-js';

const scrypt = scryptJs.scrypt || scryptJs;

export const MAGIC = 'OKEYDOKEY1';

const N_DEVICE = 16384;
const N_EXPORT = 1 << 15; // 32768
const R = 8;
const P = 1;
const DKLEN = 32;

/* ------------------------------ 编码工具 ------------------------------ */

export function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex) {
  const s = String(hex);
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

export function b64encode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000; // 分块避免超长 apply 参数导致栈溢出
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64decode(str) {
  const bin = atob(String(str));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8Bytes(str) {
  return encoder.encode(String(str));
}

/* ------------------------------ 原语 ------------------------------ */

/** 与桌面端 deriveKey 等价：scrypt(keyMaterial, salt, 32, N=16384) */
export async function deriveKey(keyMaterial, salt) {
  const pw = utf8Bytes(keyMaterial);
  const out = await scrypt(pw, salt, N_DEVICE, R, P, DKLEN);
  return new Uint8Array(out);
}

/** 与桌面端 keyFromPassphrase 等价：scrypt(passphrase, salt, 32, N=32768) */
export async function keyFromPassphrase(passphrase, salt) {
  const pw = utf8Bytes(passphrase);
  const out = await scrypt(pw, salt, N_EXPORT, R, P, DKLEN);
  return new Uint8Array(out);
}

export function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** 生成新的设备密钥材料（hex 文本，与桌面端写入 device.key 的格式一致） */
export async function loadOrCreateDeviceKey() {
  return bytesToHex(randomBytes(32));
}

/**
 * AES-256-GCM 加密。
 * WebCrypto 返回 ciphertext||tag，Node 的 getAuthTag() 单独返回 tag —— 这里拆开，
 * 以保证容器里的 body / tag 两字段与桌面端含义一致。
 */
async function aesGcmEncrypt(keyBytes, iv, plainBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, plainBytes);
  const all = new Uint8Array(buf);
  return { body: all.slice(0, all.length - 16), tag: all.slice(all.length - 16) };
}

async function aesGcmDecrypt(keyBytes, iv, body, tag) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const joined = new Uint8Array(body.length + tag.length);
  joined.set(body, 0);
  joined.set(tag, body.length);
  const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, joined);
  return new Uint8Array(buf);
}

/* ------------------------------ 容器 ------------------------------ */

/** 加密任意 JSON 对象 → 容器字符串（格式与桌面端一致） */
export async function encryptJSON(obj, keyMaterial) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(keyMaterial, salt);
  const { body, tag } = await aesGcmEncrypt(key, iv, utf8Bytes(JSON.stringify(obj)));
  return [MAGIC, b64encode(salt), b64encode(iv), b64encode(tag), b64encode(body)].join(':');
}

/** 解密容器 → JSON 对象；失败抛错（密钥不符或文件损坏） */
export async function decryptJSON(container, keyMaterial) {
  const parts = String(container).trim().split(':');
  if (parts.length !== 5 || parts[0] !== MAGIC) throw new Error('BAD_CONTAINER');
  const salt = b64decode(parts[1]);
  const iv = b64decode(parts[2]);
  const tag = b64decode(parts[3]);
  const body = b64decode(parts[4]);
  const key = await deriveKey(keyMaterial, salt);
  const plain = await aesGcmDecrypt(key, iv, body, tag);
  return JSON.parse(decoder.decode(plain));
}

/* --------------------------- 口令导出包 --------------------------- */

/**
 * 加密导出包。字段与桌面端 encryptWithPassphrase 完全一致，
 * 并额外写入 createdAt / appVersion 作为「可被旧版忽略」的元信息。
 */
export async function encryptWithPassphrase(obj, passphrase, meta = {}) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await keyFromPassphrase(passphrase, salt);
  const { body, tag } = await aesGcmEncrypt(key, iv, utf8Bytes(JSON.stringify(obj)));
  return {
    format: 'okey-dokey-export',
    version: 1,
    kdf: 'scrypt',
    salt: b64encode(salt),
    iv: b64encode(iv),
    tag: b64encode(tag),
    data: b64encode(body),
    // 以下为附加元信息：旧版解析器只读取上面 7 个字段，多余字段会被忽略
    createdAt: meta.createdAt || new Date().toISOString(),
    producer: meta.producer || 'okey-dokey',
    producerVersion: meta.producerVersion || '',
    recordCount: meta.recordCount != null ? meta.recordCount : undefined
  };
}

export async function decryptWithPassphrase(pkg, passphrase) {
  const salt = b64decode(pkg.salt);
  const iv = b64decode(pkg.iv);
  const key = await keyFromPassphrase(passphrase, salt);
  const plain = await aesGcmDecrypt(key, iv, b64decode(pkg.data), b64decode(pkg.tag));
  return JSON.parse(decoder.decode(plain));
}

/** 判断一段文本是否为本项目的加密导出包 */
export function isExportPackage(obj) {
  return !!(obj && typeof obj === 'object' && obj.format === 'okey-dokey-export');
}
