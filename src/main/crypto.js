/**
 * 加密模块：AES-256-GCM + 本机密钥（scrypt 派生）。
 * 明文密钥永不写入磁盘，仅存在于加密容器内部。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = 'OKEYDOKEY1'; // 容器标识 + 版本

/** 读取或创建本机密钥（32 字节随机数，权限 0600） */
function loadOrCreateDeviceKey(keyPath) {
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, 'utf8').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, key.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  return key;
}

function deriveKey(keyMaterial, salt) {
  return crypto.scryptSync(keyMaterial, salt, 32, { N: 16384, r: 8, p: 1 });
}

/** 加密任意 JSON 对象 → 容器字符串 */
function encryptJSON(obj, keyMaterial) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(keyMaterial, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MAGIC, salt.toString('base64'), iv.toString('base64'), tag.toString('base64'), body.toString('base64')].join(':');
}

/** 解密容器 → JSON 对象；失败抛错（代表密钥不符或文件损坏） */
function decryptJSON(container, keyMaterial) {
  const parts = String(container).trim().split(':');
  if (parts.length !== 5 || parts[0] !== MAGIC) throw new Error('BAD_CONTAINER');
  const salt = Buffer.from(parts[1], 'base64');
  const iv = Buffer.from(parts[2], 'base64');
  const tag = Buffer.from(parts[3], 'base64');
  const body = Buffer.from(parts[4], 'base64');
  const key = deriveKey(keyMaterial, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** 口令派生密钥（用于加密导出包），maxmem 需显式放宽：128*N*r ≈ 33MB */
function keyFromPassphrase(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
}

function encryptWithPassphrase(obj, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = keyFromPassphrase(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  return {
    format: 'okey-dokey-export',
    version: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: body.toString('base64')
  };
}

function decryptWithPassphrase(pkg, passphrase) {
  const salt = Buffer.from(pkg.salt, 'base64');
  const iv = Buffer.from(pkg.iv, 'base64');
  const key = keyFromPassphrase(passphrase, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(pkg.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(pkg.data, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

module.exports = {
  MAGIC,
  loadOrCreateDeviceKey,
  deriveKey,
  encryptJSON,
  decryptJSON,
  encryptWithPassphrase,
  decryptWithPassphrase
};
