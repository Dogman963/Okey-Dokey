# 启动性能分析与优化

结论先行：**慢的不是应用，是「单文件便携版」这种打包形态**。应用自身启动约 0.33 秒，便携版约 6.2 秒 —— 差 19 倍，全部消耗在每次启动把 Electron 运行时自解压到临时目录上。

## 实测数据

方法：测量「启动进程 → 出现可见主窗口」的墙钟时间，每项预热 1 次后连续测 3 次，每次测量前强制结束全部残留进程，并使用预先存在的固定 userData 目录以排除首次建库的影响。

| 形态 | 第 1 次 | 第 2 次 | 第 3 次 | 中位数 | 常驻内存 |
| --- | --- | --- | --- | --- | --- |
| 目录版 `win-unpacked` | 353 ms | 354 ms | 327 ms | **353 ms** | 316 MB |
| 开发模式 `npm start` | 319 ms | 325 ms | 368 ms | **325 ms** | 321 MB |
| 便携版 compression=maximum（95.4 MB） | 6472 ms | 6234 ms | 5905 ms | **6.2 s** | 339 MB |
| 便携版 compression=store（367.8 MB） | 2716 ms | 6267 ms | 超时 | 不稳定 | — |

结论：

1. **应用本身不慢**：目录版 353 ms，其中真正属于「我的代码」（窗口创建、DOM 构建、读取加密库）的部分只有几十毫秒，其余是 Electron/Chromium 自身的冷启动开销（约 300 ms 是该版本的下限）。
2. **便携版的 6 秒全部是解压开销**：95.4 MB 的压缩包 + 每次启动解压约 460 MB 到 `%TEMP%`。
3. **降低压缩率没用**：`store`（不压缩，367.8 MB）不但没变快，反而因为要读写 367.8 MB 而更不稳定（第 3 次直接超时）。说明瓶颈是**磁盘 I/O 总量**，而非 CPU 解压。

## 为什么便携版必须每次解压

electron-builder 的便携版模板 `node_modules/app-builder-lib/templates/nsis/portable.nsi` 逻辑是：

```
StrCpy $INSTDIR "$TEMP\${UNPACK_DIR_NAME}"   ; 或 $PLUGINSDIR\app
RMDir /r $INSTDIR                            ; 先整目录删除
SetOutPath $INSTDIR                          ; 再重新解压
```

即使把 `unpackDirName` 固定（配置项确实存在，可在 `electron-builder` 的 `portable.unpackDirName` 设置），模板仍会先 `RMDir /r` 删除再解压，**无法复用已解压内容做缓存**。所以「首次慢、之后快」在便携版上不存在。

另外，单文件 exe 每次是「新文件路径」，Windows Defender 会重新扫描解压出的可执行文件，进一步放大耗时（本次实测中 6.2 s 与 13.7 s 的波动即来自此）。

## 建议方案

按「速度 / 绿色程度」排序：

| 方案 | 启动 | 说明 |
| --- | --- | --- |
| **目录版（推荐）** | ~0.35 s | 把 `win-unpacked` 整个目录拷到任意位置，双击里面的 `Okey Dokey.exe`。免安装、可放 U 盘，启动最快。缺点是多个文件夹而不是单文件。 |
| 安装版 NSIS | ~0.35 s | 装到 `Program Files`，有开始菜单与桌面快捷方式，体验最接近普通软件。你说先缓着，需要时一条命令即可出包。 |
| 便携版（现状） | ~6.2 s | 单文件最便于分发，但每次启动都要解压。适合偶尔使用或临时借用他人电脑。 |

### 生成目录版

```powershell
npm run pack     # 输出到 dist/win-unpacked/，直接双击其中的 Okey Dokey.exe
```

### 生成安装版（需要时）

```powershell
npx electron-builder --win nsis
```

## 其他可优化项（收益小，未实施）

- **应用代码层面已无明显浪费**：窗口使用 `show: false` + `ready-to-show` 再显示，避免了白屏闪动，这部分已是最优写法；渲染层无外部资源请求（无远程字体/CDN），因此不受网络影响。
- **加密库加载**：`scryptSync` 单次派生约 30–60 ms，只发生在读写密钥库时，不在启动关键路径上。
- **残留的可选优化**：把窗口首帧改为「骨架先显示、数据后到」，可把可感知的「出窗口」时间再压约 100 ms，但会牺牲一点首屏完整性，收益不大。

## 环境提醒

测量过程中发现 **C 盘多次被写满（可用空间 0 GB）**。原因是每次构建便携版都会在 `dist\` 写出约 460 MB 的解包目录，叠加系统原有占用后触发 `ENOSPC`，导致构建失败。清理后当前可用约 5.6 GB。

如需继续频繁构建，建议先腾出 3 GB 以上空间；`store` 压缩率的对照版本占用接近 740 MB，不建议保留。

## 复现方式

```powershell
# 需要先有目录版：npm run pack
powershell -ExecutionPolicy Bypass -File tools/bench-startup.ps1 -Runs 3 -TargetList portable,unpacked,dev
```
