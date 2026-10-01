# Okey Dokey 数据格式与跨设备迁移规范

本文是两端（桌面端 Electron、安卓端 Capacitor）**共同的格式契约**。
改任何一项都等于改协议，必须两端同步，并跑交叉兼容测试。

---

## 一、为什么本机数据目录不能直接搬

桌面端数据文件（`%APPDATA%\Okey Dokey\vault\`）：

| 文件 | 作用 | 能否跨设备 |
| --- | --- | --- |
| `vault.enc` | 整库密文 | ❌ 密钥由本机 `device.key` 派生 |
| `device.key` | 本机设备密钥（32 字节随机数） | ❌ 一旦跟着走，等于把保险柜连钥匙一起送人 |
| `settings.json` | 设置（明文，不含密钥） | ⚠️ 可以，但含本机绝对路径，通常不值得搬 |

安卓端同构，位于应用私有目录 `Data/okey-dokey/` 下，文件名一致。

**结论**：`vault.enc` 与 `device.key` 是**设计上不可迁移**的一对。跨设备一律走下面的
`.okeyvault` 加密导出包。这不是妥协，而是把「迁移凭据」和「本机凭据」分开——迁移需要
用户主动持有的口令，而不是随手拷贝的文件。

---

## 二、加密导出包 `.okeyvault`（迁移的唯一载体）

JSON 文本文件。字段如下：

```jsonc
{
  "format": "okey-dokey-export",   // 固定标识，用于识别
  "version": 1,                    // 格式版本
  "kdf": "scrypt",                 // 密钥派生算法
  "salt": "<base64, 16字节>",
  "iv":   "<base64, 12字节>",
  "tag":  "<base64, 16字节>",       // GCM 认证标签
  "data": "<base64>",              // AES-256-GCM 密文

  // ↓ 以下为 v1.1.0 起新增的附加元信息。
  //   旧版解析器只读上面 7 个字段，多余字段会被安全忽略。
  "createdAt": "2026-10-01T10:00:00.000Z",
  "producer": "okey-dokey-android",  // 或 okey-dokey / vault-tool
  "producerVersion": "1.1.0",
  "recordCount": 12
}
```

### 派生与加密参数（两端必须逐位一致）

| 项 | 值 |
| --- | --- |
| KDF | scrypt |
| scrypt N | 32768（`1 << 15`） |
| scrypt r | 8 |
| scrypt p | 1 |
| 派生密钥长度 | 32 字节 |
| 加密 | AES-256-GCM |
| IV 长度 | 12 字节 |
| Tag 长度 | 16 字节（128 bit） |
| 明文字节 | UTF-8 编码的 JSON |
| 口令最小长度 | 6 字符 |

> **实现提示**：Node 的 `crypto.scryptSync` 默认 `maxmem` 为 32 MB，而 `128 * N * r ≈ 33.5 MB`
> 会超限，因此两端都必须显式放宽 `maxmem`（本仓库统一用 128 MB）。
> 这类细节是「同一算法、不同实现」最容易踩的地方，交叉测试专门覆盖它。

### 明文载荷结构

解密后的内容与桌面端内存中的库对象完全一致：

```jsonc
{
  "version": 1,
  "records": [
    {
      "id": "<uuid v4>",
      "provider": "openai",
      "label": "生产环境",
      "credential": "sk-...",       // 唯一含明文密钥的字段
      "note": "多行备注",
      "tags": ["prod"],
      "baseUrl": "https://api.openai.com/v1",
      "models": "gpt-4o",
      "favorite": false,
      "disabled": false,
      "createdAt": "2026-09-01T00:00:00.000Z",
      "updatedAt": "2026-09-20T00:00:00.000Z",
      "usageCount": 3,
      "lastUsedAt": null
    }
  ]
}
```

---

## 三、本机库容器 `vault.enc`

同一套 AES-256-GCM，但密钥不是口令，而是本机设备密钥材料。格式是一个冒号分隔的字符串：

```
OKEYDOKEY1:<salt b64>:<iv b64>:<tag b64>:<body b64>
```

| 项 | 值 |
| --- | --- |
| 标识 | `OKEYDOKEY1`（同时充当版本号） |
| 设备密钥 | 32 字节随机数的 **hex 文本（64 字符）**，存于 `device.key` |
| 派生 | scrypt(hex 文本作为口令, salt, 32, **N=16384**, r=8, p=1) |
| 加密 | AES-256-GCM，IV 12 字节，tag 16 字节 |

注意 N 是 **16384**（本机库）而非 32768（导出包）——两者不同，别混。

---

## 四、跨设备迁移怎么走

### 方式 A：加密备份包（推荐，最通用）

1. 设备甲：设置 → 数据 → 导出加密备份，设一个口令（≥6 位）。
2. 通过任意渠道把 `.okeyvault` 文件传到设备乙：微信 / 邮件 / 网盘 / 蓝牙 / U 盘 / 数据线。
   - 安卓端导出后会自动弹出系统分享面板，直接选目标 App 即可。
3. 设备乙：设置 → 数据 → 导入备份，输入同一口令。

导入模式：
- **merge（默认）**：以记录 `id` 去重合并；`id` 已存在则覆盖，否则插入。适合多设备各自新增后合并。
- **replace**：清空现有记录后整体替换。适合「把新设备变成旧设备的副本」。

### 方式 B：安卓端「用 Okey Dokey 打开」

安卓端在清单里注册了对 `application/json` 的 `VIEW` / `SEND` intent。
从「文件」App 或聊天工具里点开 `.okeyvault`，选择「用 Okey Dokey 打开」，应用会被唤起并在
设置入口给出「有待导入文件」的提示，输入口令即可完成导入。

### 方式 C：明文 JSON（仅限受控环境）

导出明文 JSON 便于人工核对。**它会暴露全部密钥**，只在完全可控的机器上使用，
用完立即删除。仓库里的 `vault-tool plaintext-check` 可用来确认某文件是否含明文密钥。

---

## 五、离线恢复工具

App 打不开（设备坏了、系统不兼容、换机中途）时，用只依赖 Node 的命令行工具：

```powershell
node scripts/vault-tool.js inspect       backup.okeyvault            # 看包信息
node scripts/vault-tool.js verify        backup.okeyvault -p 口令      # 校验口令
node scripts/vault-tool.js list          backup.okeyvault -p 口令      # 列记录（掩码）
node scripts/vault-tool.js decrypt       backup.okeyvault -p 口令 -o out.json
node scripts/vault-tool.js reencrypt     in.okeyvault -p 旧 -n 新 -o out.okeyvault
node scripts/vault-tool.js convert       plain.json -n 口令 -o out.okeyvault
node scripts/vault-tool.js plaintext-check  some-file
```

这条通道独立于两个 App，是迁移方案的最后一道保险。

---

## 六、格式版本策略

- 解析时**只看已知字段，忽略未知字段**——这是让 v1.1.0 的附加元信息不破坏 v1.0.0 兼容的前提。
- `version` 保持 `1`，直到发生**不兼容**变更才递增，届时需提供双向转换。
- 新增字段一律可选，且要有合理缺省值。

---

## 七、安全边界（必须一并告知用户）

- 加密包的安全性**完全取决于口令强度**。口令弱，包被拿到就等于明文泄露。
- scrypt N=32768 是刻意选的低参数（移动端单线程 JS 实现，实测约 1–2 秒）。
  它抬高的是暴力破解成本，不改变「弱口令即失守」这一事实。
- 安卓端已在 `backup_rules.xml` / `data_extraction_rules.xml` 中**显式排除**
  `device.key` 与 `vault.enc`，防止密钥材料进入系统云备份。
- 明文密钥永不离开加密容器：界面默认拿到的是掩码，只有显式「显示」才取明文；
  复制到剪贴板后 30 秒自动清空。
