# Okey Dokey

> 大模型 API 密钥保险库 · LLM API key vault

把各家大模型的 API Key 加密存在本机，用服务商筛选、给每条密钥写备注；界面配色与背景可自定义，中英双语。

基于 Electron，数据以 **AES-256-GCM** 加密后落盘，明文密钥不写入磁盘。

![界面](docs/images/ui-light.png)

---

## 目录结构

```
okey-dokey/
├─ src/
│  ├─ main/                 主进程（Node 环境，唯一接触文件系统与明文密钥的地方）
│  │  ├─ index.js             窗口、IPC、剪贴板、导入导出
│  │  ├─ store.js             加密仓库：增删改查、掩码、导入导出
│  │  └─ crypto.js            AES-256-GCM 加解密、scrypt 派生、加密导出包
│  ├─ preload/
│  │  └─ index.js           上下文桥：向界面暴露白名单方法（contextIsolation）
│  ├─ renderer/             渲染进程（界面，不直接接触文件系统）
│  │  ├─ index.html           界面骨架
│  │  ├─ styles.css           样式表（主题全部变量化）
│  │  ├─ app.js               列表、筛选、编辑、设置、主题、双语
│  │  └─ i18n.js              中英词条
│  └─ shared/
│     └─ providers.js       24 家服务商目录（主进程与界面共用）
├─ scripts/                 开发与验证脚本（不进入发布包）
│  ├─ smoke.js                端到端界面冒烟测试（18 项）
│  ├─ screenshot.js           生成界面截图
│  ├─ bench-startup.ps1       启动耗时基准测试
│  ├─ test-doubleclick.ps1    目录版真实启动方式验证
│  ├─ verify-build.ps1        打包产物实机验证
│  ├─ build-variants.js       不同压缩率对照构建
│  └─ make_icon.py            生成应用图标
├─ build/                   electron-builder 图标资源（随仓库提交）
│  ├─ icon.ico
│  └─ icon.png
├─ mobile/                  安卓端（Capacitor 工程，界面与桌面端共用同一份代码）
│  ├─ src/
│  │  ├─ platform/            平台层：加密、存储、导入导出（与桌面端格式兼容）
│  │  ├─ boot.js              启动入口：注入 window.vault
│  │  └─ mobile.css           移动端适配样式（安全区、触控目标、软键盘）
│  ├─ scripts/                组装、图标生成、兼容性测试
│  ├─ android/                原生工程（由 Capacitor 生成并配置）
│  └─ capacitor.config.json
├─ docs/                    文档与截图
│  ├─ startup-performance.md  启动性能分析与实测数据
│  ├─ export-format.md        数据格式与跨设备迁移规范（两端共同契约）
│  └─ images/
└─ release/                 构建输出（不入库，见 .gitignore）
   ├─ win-unpacked/           目录版（免安装，启动最快）
   └─ Okey-Dokey-Setup-*.exe  安装版
```

## 下载

已发布到 Releases：

**https://github.com/Dogman963/Okey-Dokey/releases/latest**

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| **安卓** | `Okey-Dokey-1.1.0.apk` | 签名安装包，Android 7.0（API 24）及以上，直接安装 |
| **Windows** | `Okey-Dokey-Setup-1.1.0.exe` | 安装版，带开始菜单与桌面快捷方式 |

两个文件的 SHA256 校验值见对应的 Release 页面说明。

> 桌面端未做代码签名，首次运行可能提示「未知发布者」，点「更多信息 → 仍要运行」即可。
> 安卓端为自有密钥签名（非 Google Play 分发），安装时若提示「未知来源」，需在系统设置里
> 允许对应来源安装。

### 安卓端怎么用

安装后行为与桌面端一致：加密存储、服务商筛选、备注标签、主题自定义、中英双语。
数据存在应用私有目录，不申请存储、相机、定位等任何敏感权限，完全离线。

在手机上迁移数据的入口是 **设置 → 数据**：
- **导出加密备份**：生成 `.okeyvault` 文件并弹出系统分享面板，可直接发到微信 / 邮件 / 网盘 / 蓝牙。
- **导入备份**：从聊天工具或「文件」App 选择备份包，输入口令即可。
  也可以直接点开 `.okeyvault` 文件选「用 Okey Dokey 打开」。

## 快速开始

```powershell
npm install     # 首次运行，安装 Electron（约 1 分钟）
npm start       # 启动应用
```

### 安装命令行工具 okey

```powershell
npm link                       # 把 okey 链接到全局，之后任意目录可用
okey doctor                    # 自检
```

也可以直接用仓库内的包装器，无需 link：

```powershell
.\bin\okey.cmd doctor
```

CLI 是纯 Node 脚本、零依赖，所以**即使不装 Electron 也能用**——换台机器只拷仓库再装 Node 即可。

## 两个发布版本

打包产物都输出到 `release/`（已加入 `.gitignore`，不入库）。

| 版本 | 生成命令 | 产物 | 启动耗时 | 适用场景 |
| --- | --- | --- | --- | --- |
| **目录版** | `npm run dist` | `release/win-unpacked/` | ~0.35 s | 免安装，整个文件夹拷走即用，可放 U 盘 |
| **安装版** | `npm run dist:installer` | `release/Okey-Dokey-Setup-1.0.0.exe` | ~0.35 s | 装进系统，带开始菜单与桌面快捷方式 |

> 目录版请**整个文件夹一起移动**，只拷 `Okey Dokey.exe` 无法运行（缺运行时与 `resources/`）。

两个版本的实机启动截图：[目录版](docs/images/ui-directory-build.png) · [安装版](docs/images/ui-installed.png)

### 关于便携版（单文件 exe）

本项目**不提供**单文件便携版：它每次启动都要把 Electron 运行时（约 460 MB）解压到临时目录，实测启动需 **6.2 秒**，是目录版的 19 倍。实测数据见 [docs/startup-performance.md](docs/startup-performance.md)。

## 功能

| 需求 | 实现 |
| --- | --- |
| 加密保存密钥 | AES-256-GCM 整库加密；密钥由 scrypt 从本机设备密钥派生；明文不落盘 |
| 服务商筛选 | 内置 24 家服务商，下拉框 + 侧栏筛选，附条数统计 |
| Key 备注 | 多行备注 + 标签 + Base URL + 常用模型，备注可被搜索 |
| 简约风前端 | 单栏卡片、克制留白与圆角 |
| 自定义配色主题 | 6 套预设（含 2 套暗色）+ 主色/辅助色/背景/卡片/文字/圆角独立调节 |
| 背景图透明度 | 选图后可调透明度、模糊、压暗与填充方式 |
| 中英双语 | 一键切换，语言与主题持久化 |

其他：搜索覆盖名称/备注/标签/服务商/模型/密钥尾号；5 种排序与列表密度；收藏夹；显示密钥倒计时自动隐藏；复制后 30 秒清空剪贴板；掩码样式三选一；加密备份导出与导入。

## 命令行取用（okey CLI）

密钥存下来只是第一步，**能取出来用**才算有价值。`okey` 把「打开界面 → 显示 → 复制 → 切窗口 → 粘贴」变成一行命令。

```powershell
# 让代码直接读到 key —— 不需要改一行业务代码，也不需要 .env 文件
okey run -- python train.py

# 只注入某几个服务商
okey run openai deepseek -- npm test

# 生产/测试变量名分开，避免混用
okey run --tag 生产 --prefix PROD_ -- ./deploy.sh

# 在当前 shell 会话里设置（PowerShell）
okey env openai | Invoke-Expression

# 取出单个 key 交给别的工具
okey get openai:生产 | some-other-tool --stdin
```

| 命令 | 作用 |
| --- | --- |
| `okey run [选择器] -- <命令>` | 注入环境变量后运行命令（**推荐**） |
| `okey get <选择器>` | 输出密钥明文；`--copy` 复制到剪贴板 |
| `okey env [选择器]` | 输出环境变量赋值语句；`--json` / `--shell cmd` |
| `okey list [选择器]` | 列出记录（密钥恒为掩码） |
| `okey which <选择器>` | 查看某条记录详情与将派生的变量名 |
| `okey alias [选择器] [变量名]` | 查看/指定记录的变量名（自建端点必需） |
| `okey doctor` | 自检：数据目录、能否解密、变量名可派生性、冲突 |

### 选择器

```
openai              服务商 id
openai:生产          服务商 + 标签（最精确，推荐）
@3f2a               记录 id 前缀
"生产环境"           标题精确匹配
生产                 标题或标签的子串匹配（要求唯一）
```

**同一服务商有多条记录时，`okey` 会报错而不是随便挑一条**——选错密钥去跑生产任务，
比报错严重得多。用 `<服务商>:<标签>` 或 `--tag` 指明即可。

### 变量名怎么来的

内置表覆盖 22 家服务商，用的是**各 SDK 实际读取的名字**（OpenAI → `OPENAI_API_KEY`、
阿里百炼 → `DASHSCOPE_API_KEY`、火山方舟 → `ARK_API_KEY`），所以现有代码无需改动就能生效。
记录里填了 `baseUrl` 时还会额外注入 `*_BASE_URL`。

**自建/中转端点（provider = custom）不会被自动猜测。** 因为标题写「Claude」并不等于应该注入
`ANTHROPIC_API_KEY`——猜错不会报错，只会让 SDK 静默读不到 key，这是最难排查的一类故障。
指定一次即可长期生效：

```powershell
okey alias "Gpt"    OPENAI_API_KEY
okey alias "Claude" ANTHROPIC_API_KEY
```

映射写在数据目录的 `aliases.json`，**只含变量名、不含密钥**，可以安全备份或纳入版本控制。

### 退出码

脚本里可据此区分失败原因：`0` 成功 · `1` 一般错误 · `2` 未找到 · `3` 选择器有歧义 ·
`4` 密钥库问题 · `5` 用法错误。

### 安全边界（请务必读）

- `okey` 是**只读**的：它不修改密钥库，写入仍由桌面端/安卓端负责，避免多进程互相覆盖。
- `get` / `env` 会把密钥明文写到 stdout——**不要把输出重定向到会被提交或同步的文件**。
- 日常优先用 `run`：密钥只进入子进程环境，不落盘、不进 shell 历史。
- 一旦用了 CLI，**任何能在本机执行命令的进程都能拿到你的密钥**。这是环境变量方案的固有性质，
  它把安全性从「手动复制」降到「进程信任」。不要把这套用在不可信的共享机器上。
- CLI 本身不联网、无遥测。

## 跨设备迁移数据

**一句话**：本机数据目录（`vault.enc` + `device.key`）**设计上不可迁移**——密钥由本机设备密钥
派生，拷走等于把保险柜连钥匙一起送人。迁移一律走带口令的 `.okeyvault` 加密备份包。

| 方式 | 做法 | 适用 |
| --- | --- | --- |
| **加密备份包**（推荐） | 设置 → 数据 → 导出加密备份，设口令；把文件传到另一台设备；导入时输入同一口令 | 任何设备之间，最通用 |
| **安卓「用 Okey Dokey 打开」** | 从聊天工具/文件管理器点开 `.okeyvault`，选本应用打开 | 手机之间、电脑到手机 |
| **离线命令行工具** | `node scripts/vault-tool.js <命令>` | App 打不开时抢救数据 |

导入支持两种模式：`merge`（按记录 id 去重合并，适合多设备各自新增后汇合）与 `replace`
（整体替换，适合把新设备变成旧设备的副本）。

iOS、macOS、Linux 目前没有官方客户端，但 `.okeyvault` 是纯文本 JSON + 标准算法
（scrypt + AES-256-GCM），任何语言按 [格式规范](docs/export-format.md) 都能实现读写。

### App 打不开时怎么救数据

`scripts/vault-tool.js` 只依赖 Node 内置模块，不依赖 Electron、不依赖安卓：

```powershell
node scripts/vault-tool.js inspect   backup.okeyvault           # 看包信息（不需口令）
node scripts/vault-tool.js verify    backup.okeyvault -p 口令     # 校验口令
node scripts/vault-tool.js list      backup.okeyvault -p 口令     # 列出记录（密钥仅掩码）
node scripts/vault-tool.js decrypt   backup.okeyvault -p 口令 -o out.json
node scripts/vault-tool.js reencrypt in.okeyvault -p 旧 -n 新 -o out.okeyvault
node scripts/vault-tool.js convert   plain.json -n 口令 -o out.okeyvault
node scripts/vault-tool.js plaintext-check some-file
```

`plaintext-check` 用来确认某个文件里是否残留明文密钥，适合清理备份时自查。

## 安全设计

- **算法**：AES-256-GCM（带认证标签，防篡改）。
- **密钥派生**：scrypt（N=16384, r=8, p=1），密钥保存在用户数据目录，打开即用，无需主密码。
- **明文不经过界面**：渲染进程默认只拿到掩码（如 `sk-a••••••••7890`），点击「显示」才由主进程返回明文。
- **导入导出**：加密包用口令保护（scrypt N=32768），跨设备恢复需同一口令。

> ⚠️ **取舍**：本机密钥自动解锁意味着「拿到本机 `device.key` 的人可直接解密密钥库」。请勿把数据目录同步到公共云盘。
> 如需升级为主密码解锁，请提 issue。

数据文件位于 `%APPDATA%\Okey Dokey\vault\`：`vault.enc`（密文库）、`device.key`（设备密钥）、`settings.json`（设置，不含密钥）。

## 开发与验证

```powershell
npm run check                                  # 语法检查
npm run test:cli
npm run test:smoke                             # 端到端界面测试（18 项）
npm run test:startup                           # 启动耗时基准
npm run test:doubleclick                       # 目录版真实启动方式验证
npm run shots                                  # 重新生成界面截图
npm run icon                                   # 重新生成图标
powershell -File scripts/verify-build.ps1 -Target unpacked   # 打包产物实机验证

# 安卓端
cd mobile
npm install                                    # 安装 Capacitor 与依赖
npm run build:www                              # 组装 www/（复用桌面端界面代码）
npm run sync                                   # 同步到原生工程
cd android && gradlew.bat assembleRelease      # 构建签名 APK

# 兼容性测试（改加密或数据格式后必须跑）
cd mobile
node scripts/cross-compat-test.mjs             # 两端加密格式互通（31 项）
node scripts/e2e-migration-test.mjs            # 端到端迁移链路（24 项）
```

## 已知限制

- **无便携版**：见上文性能说明。
- **构建需磁盘空间**：每次打包会在 `release/` 写出约 460 MB 解包目录，空间不足会报 `ENOSPC`。
- **未做代码签名**：安装版首次运行可能触发 Windows SmartScreen「未知发布者」提示。
- **Windows 优先**：桌面端配置仅提供 Windows 目标；macOS/Linux 目标未验证。
- **安卓端未做真机回归**：加密格式与数据格式已用自动化测试证明与桌面端互通
  （见 `cross-compat-test.mjs`、`e2e-migration-test.mjs`），但界面在真机上的表现
  （不同厂商 ROM 的 WebView、软键盘、深色模式）尚未逐机型验证。
- **迁移动辄需要口令**：这是安全设计而非缺陷；但确实意味着忘了口令就无法恢复。
- **CLI 只能为它启动的子进程注入环境变量**：对已经打开的编辑器或 IDE 无效，需重启它们才会读到。
- **CLI 不写入密钥库**：写入仍由图形端负责；在图形端新增密钥后，CLI 读到的是最新落盘内容。
- **未做分页**：密钥数量上万时列表未优化。
- **字体**：使用系统字体，未内嵌。

## 许可证

MIT
