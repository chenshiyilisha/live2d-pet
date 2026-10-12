# 阿岩（Ayan）

一只常驻 Windows 桌面的 Live2D 桌宠。Electron + pixi.js + Live2D Cubism SDK for Web。

![license](https://img.shields.io/badge/license-MIT-blue) ![platform](https://img.shields.io/badge/platform-Windows-blue)

## 它能干什么

- **Live2D 角色**常驻桌面右下角，会溜达、贴边、被你拖来拖去；点她会有反应
- **流式对话**：接大模型 API 陪你聊天，断网时有一套离线话术兜底
- **自定义名称与人设**：性格、说话风格、回答方式等 6 个维度可分别编辑，留空即用默认
- **语音**：按住麦克风说话（Windows 自带 SAPI 离线识别）、点角色朗读回复（TTS）
- **提醒与番茄钟**、**系统状态底座**（窗口底部铭牌：CPU / 内存 / GPU / 温度）
- **全屏 / 游戏时自动静默**：检测到前台是全屏应用就自己"睡过去"（停溜达、停状态轮询、
  取消置顶、渲染降到 12fps），退出后再醒；打游戏时她不会来抢资源或突然出声
- **自动更新**：接 GitHub Releases，启动后静默查一次，也可从托盘菜单手动触发
- 所有功能都有**托盘菜单开关**，角色右键还有一份短菜单

## 环境要求

- Windows 10/11（开发与打包均在此验证）
- Node.js ≥ 20，包管理器 pnpm（`npm i -g pnpm`）
- 想跑起来就联网（首次会从 Live2D 官方 CDN 拉一次运行时，之后有本地缓存）

## 跑起来

```bash
pnpm install

# 模型（Hiyori / Haru，9 MB）不随仓库分发 —— 版权归 Live2D Inc.
# 从 Releases 下载 models.zip，解压到 src/assets/，得到 src/assets/models/{hiyori,haru}/
# 本地已有副本的话跳过这步。

pnpm start          # 开发模式，直接起 Electron
```

## 打安装包

```bash
pnpm run build      # 物化 build/stage → electron-builder 出 dist/*.exe
pnpm run accept     # 端到端验收：静默安装 → 文件核对 → 干净启动 → 卸载
```

产物在 `dist/`，NSIS 安装包，约 114 MB。

## 发布新版本（自动更新）

应用内置基于 **GitHub Releases** 的自动更新（electron-updater）。用户端零操作：启动后
约十秒静默查一次，有新版就弹窗询问；托盘「设置 → 更新 → 检查更新」可手动触发。
默认**不自动下载**（包有 114 MB），想全自动就打开同菜单里的「发现后自动下载」，
那样发现新版本会自动下载、并在此次退出应用时装上。

发版三步：

```bash
# 1. 改 package.json 的 version，重新构建
pnpm run build                  # 结束后会自检三件套是否齐全
pnpm run models                 # 生成 dist/models.zip（源码用户的模型来源）
# 2. 打 tag 并推送（必须是 v 开头）
git tag v0.1.1 && git push origin v0.1.1
# 3. 在 GitHub 建 Release，把下面四个文件**全部**作为资产传上去
```

| 必须上传的文件 | 少了会怎样 |
|---|---|
| `Ayan-Setup-<版本>.exe` | 更新失败，报找不到文件 |
| `Ayan-Setup-<版本>.exe.blockmap` | 退回全量下载（能更新，但每次 114 MB） |
| `latest.yml` | **所有客户端静默收不到更新**，本地还看不出任何异常 |
| `models.zip` | 不影响自动更新；但从源码跑的人拿不到模型 |

⚠️ **安装包文件名必须是纯 ASCII**（`Ayan-Setup-0.1.1.exe`），不要改成中文。
electron-builder 对含非 ASCII 的 artifactName 会在 `latest.yml` 里写一个 ASCII
安全名，却**不改磁盘上的文件名** —— 两者不一致时 electron-updater 按清单名下载会 404。
`pnpm run build` 结束时的自检有一条断言专门拦这个。

⚠️ **文件名必须和 `latest.yml` 里记的完全一致**，且 tag 必须是 `v<版本>` 形式
（`v0.1.1`，不能写成 `0.1.1`）—— electron-updater 是按
`releases/download/<tag>/<文件名>` 拼下载地址的。

⚠️ **不要往 `latest.yml` 里手工补 `publisherName`**。本项目没有代码签名证书，
而 electron-updater 只在清单里存在这个字段时才去验签（源码
`out/NsisUpdater.js` 里 `publisherName == null` 直接放行）。补上它会让每次更新
在**下载完 114 MB 之后**才抛 `ERR_UPDATER_INVALID_SIGNATURE`。细节见
`tools/build-installer.js` 里的注释。

## 目录速览

```
src/main/        主进程：窗口/托盘/IPC/配置/对话/提醒/语音识别
src/renderer/    渲染层：Live2D 舞台、气泡、录音状态机、TTS
src/assets/      图标；模型需自行从 Release 下载（不在仓库里）
tools/           打包脚本（物化 stage、出安装包）
debug/           验证工具（菜单树脱机校验、端到端验收、兜底自测等）
```

## 第三方素材与授权（必读）

本仓库**不含** Live2D Cubism Core，也**不含** Live2D 模型素材 —— 这两样版权都属
Live2D Inc.，各自有约束。用之前请把这段看完。

### Live2D Cubism Core（运行时）

`live2dcubismcore.min.js` 是 Live2D Inc. 的**专有软件**，其许可协议（Live2D Proprietary
Software License Agreement）不允许把它发布到 GitHub——官方文档原话：

> In accordance with the Live2D Proprietary Software License Agreement,
> Cubism Core is not published on GitHub.

所以本仓库**不收录**这个文件。运行时 `src/main/server.js` 会在页面请求它而本地没有时，
自动从官方 CDN 取回并缓存到用户数据目录：

```
https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js
```

想离线开发的话，从 [Live2D 官方下载页](https://www.live2d.com/en/download/cubism-sdk/download-web/)
下载 Cubism SDK for Web，把其中的 `live2dcubismcore.min.js` 放到 `src/assets/` 即可
（该路径已被 gitignore，不会误提交）。

### Live2D 示例模型（Hiyori / Haru）

**模型文件不在本仓库里。** 它们是 Live2D 官方示例数据集中的 **Hiyori Momose** 与
**Haru**，版权归 **Live2D Inc.** 所有，因此改为放在
[Releases](https://github.com/chenshiyilisha/live2d-pet/releases) 的 `models.zip` 中，
仓库只保留源码。

**从源码跑的话，需要两步**（本地已有副本就跳过）：

1. 从 Releases 下载 `models.zip`（约 7.5 MB）
2. 解压到 `src/assets/`，得到 `src/assets/models/hiyori/` 与 `src/assets/models/haru/`

该目录已在 `.gitignore` 里，不会被误提交。

**打包出的安装包不受影响**：`tools/prepare-stage.js` 整树复制 `src/`，本地有模型就会
一起带上，所以最终用户装完离线也能显示角色。需要多这一步的只有"从源码跑"的人。

使用须遵守：

- [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
- [Terms of Use for Live2D Cubism Sample Data](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)

要点：

- 一般用户与小规模企业（年营收 < 1000 万日元）可自由使用，含商用
- **Hiyori Momose 不允许对角色设计做任何改动**（官方条款原文："No changes of any kind
  to the design of this character are permitted"）
- 使用这些素材的作品需要附带官方要求的版权声明：

> This content uses sample data owned and copyrighted by Live2D Inc. The sample data
> are utilized in accordance with terms and conditions set by Live2D Inc. This content
> itself is created at the author's sole discretion.

如需再分发这些模型，请先读一遍原文。另外也可以直接去
[Live2D 官方示例数据页](https://www.live2d.com/zh-CHS/download/sample-data/) 自行下载
——那里还附 `.cmo3` 工程文件，可以进 Cubism 改贴图。

### 代码部分（本仓库的许可证）

**除下方列出的第三方内容外**，本项目自己写的代码采用 **MIT 许可证**，全文见
[`LICENSE`](LICENSE)。覆盖范围：`src/main/`、`src/renderer/`、`src/assets/tray-*.png`、
`tools/`、`debug/`、`package.json` 等构建与配置文件。

简言之：可以自由使用、修改、分发、商用，甚至闭源改造，只需保留版权声明与许可证全文。

**MIT 不覆盖的内容**（各自按上面两节的协议走）：

| 内容 | 版权 / 授权 |
|---|---|
| `src/assets/models/`（Hiyori / Haru，65 文件） | 版权归 **Live2D Inc.**，受 Free Material License 约束（见上一节）。**不在本仓库内**，从 Release 下载 |
| `live2dcubismcore.min.js` | Live2D Inc. 的**专有软件**，本仓库不收录，运行时从官方 CDN 取回 |
| `pixi.js`、`@naari3/pixi-live2d-display`、`electron-updater` | 各自作者的开源许可证（多为 MIT），**不在本仓库内**，随 `pnpm install` 获取 |

之所以单独说明，是因为仓库根目录放一个 `LICENSE` 的默认含义是"对整个仓库授权"——
而模型素材的版权不在本项目作者手里，无法由本项目授权。第三方素材如需再分发，
请自行对照其原始协议。

## 已知取舍

- **打包版会把 Cubism Core 一起带进安装包**（`tools/prepare-stage.js` 物化 stage 时
  若本地有就复制），这是协议里 "Redistributable Code" 允许的随应用分发场景，
  换来安装版离线可用。仓库里不带它，是另一回事。
- **开发版 / 安装版各自读不同的配置目录**（Electron 的 `app.getName()` 决定
  userData 位置），改配置相关代码时别混着测。
- 本机如果 GPU 驱动异常，主进程会自动以软件渲染重启一次，属正常现象。
- **悬浮小字里那个温度是 GPU 的，不是 CPU 温度。**
  Windows 没有跨厂商的温度接口，非管理员能拿到的三条路全是死的
  （`MSAcpi_ThermalZoneTemperature` 拒绝访问、ACPI 热区计数器在本机恒为死值、
  `Win32_TemperatureProbe` 为空）。想读 CPU 温度只能装 WinRing0 内核驱动并要求
  提权 —— 对一个桌宠不值得，也会被 Windows Defender 误报。所以温度只用
  `nvidia-smi`：**没有 NVIDIA 显卡就不显示这一项**，而不是显示一个来路不明的数。
  ⚠️ 底座上这一项的字面标签是**「温度」**（跟在前面的 GPU 占用后面，写「GPU」
  会变成"GPU 又 48"的重复），靠橙色 + 鼠标悬停提示说明是**独显核心温度**。
  ⚠️ **别看它"偏低"就以为坏了**：独显待机时处于 P8、功耗约 1.9 W（TGP 的 1.6%），
  核心温度就是 45~50℃；满载才会到 75~85℃（规格里的 Target Temperature 是 87℃）。
  这个数也不是越热越"对" —— 它和 CPU 温度是两回事。
- GPU 占用取的是 Windows 性能计数器里的 **3D 引擎**（和任务管理器同源，跨
  NVIDIA / AMD / Intel）。原始计数器是累计值，靠前后两枪求差得出占用率，
  **两次采样之间的间隔就是它描述的"那一小段时间"** —— 所以这个数有多新，
  完全取决于采样窗口有多短。早先窗口等于推送间隔（实测 **4050 ms**），
  结果就是这个数天生晚一整拍：刚打开一个吃显卡的程序要等下一拍才涨上去，
  关掉之后又要多显示一拍才落回来。
  ⚠️ 现在改成**常驻采样进程**：一个 powershell 每 1 秒读一枪，主进程维护
  "最近两次"求差 → 窗口固定 **~1.1 秒**，读到的是眼前这一秒。
  顺带把这条热路径的进程开销也去掉了（实测一次推送的采集耗时从 **1035 ms → 1 ms**），
  因为常驻进程里单次查询只要 71~133 ms（首次 222 ms，模块加载只付一次），
  而每 3 秒起一个新进程光固定启动开销就有 ~500 ms。
  ⚠️ 采样器**只在悬浮显示开着、且没进全屏静默时跑**，其余时候立刻停。
  ⚠️ 采样间隔必须**恒大于** `GPU_WIN_MIN`（800 ms）—— 每拍固定 sleep 1 秒，
  这条是构造保证的；`debug/verify-stats.js` 里有一条断言专门看着它，
  防止有人把间隔调到 800 ms 以下（那样每拍都判成"窗口不合适"，
  表现是 GPU 数字再也不更新）。
  ⚠️ 这台机器上**没有对应的数据源时**（没有 N 卡 → 没有温度；计数器类被禁用
  → 没有 GPU 占用），采样器跑够 8 拍还没有该字段就把它标成"永久取不到"，
  之后不再为它单起进程 —— 结果是这一项不画，但也不再为它花钱。
- **悬浮小字是窗口底部的一条「底座」，人物站在它上面、不会被它遮住。**
  四个指标（CPU / 内存 / GPU / 温度）排成固定的 **2 行 × 2 列**。
  半身取景下人物的下沿正好落在窗口底（不留白就是直接糊在裙子上），所以做法是
  让舞台让出一条：开启悬浮显示时，渲染层量出底座的**实际**高度写进
  CSS 变量 `--stats-h`，`#stage` 按它缩进，canvas 随之变矮、人物等比缩小一圈。
  ⚠️ 高度是**量出来的不是写死的**：窗口窄（小屏）时行高会变，写死一个数字要么
  留白过大要么还是叠上。底座每高 1px 都是拿人物尺寸换的，所以纵向 padding 压到
  最低、不加图标。
- **人物和底座一起往右靠，不居中。** 窗口宽度是由气泡和输入条决定的（两者
  `left/right:14` 铺满窗口），而人物只占窗口中间约 100px —— 窗口又是全透明的，
  "在窗口里居中"用户根本看不见，他只看得见"人离屏幕右边缘还有多远"。
  实测（窗口 308 宽、屏 1707）：人物右边缘离窗口右边 **106px**、底座 80px。
  现在改成按「**底座牌右边缘离窗口右边 24px**」来摆 —— 人物右边缘收到 49px、
  底座 25px，等于把她真正推到右下角。
  ⚠️ 用"离右边的距离"而不是"往右挪多少"：牌的宽度是固定 CSS 值、不跟屏幕缩放走，
  前者在任何窗口宽度下都成立，而且**窗口窄到放不下时右靠量自动压到 0**，
  不会把牌推出窗口右边被裁。
  ⚠️ 人物（`pet.js` 的 `layout()`）和底座牌（`style.css` 里 `#stats` 的
  `padding-left`）是**各自按同一个 `--content-shift` 摆的**，所以牌变宽变窄
  都不会让人物偏出牌心；气泡的小尖角也读同一个值，跟着指到她身上。
- **第一条数据到之前，底座位置上是一个转圈的小药丸**，拿到数值它才展开成整块牌。
  实测冷启动这段要等 **2.5~3.6 秒**（GPU 占用是两枪求差，第一枪没有基线），
  以前这段时间窗口底部是空的，看着像"今天没开悬浮显示"。
  ⚠️ 加载态和出数态的牌**必须一样高**（骨架用同构同数量的行撑着），
  否则 `--stats-h` 会在两者之间跳一次、人物跟着缩一下 —— 这正是要避免的"闪一下"。
  ⚠️ 转圈**延迟 300 ms 才出**（数据来得快就不闪这一下），
  10 秒还没数据就收掉（静默期间主进程不推数据，别让圈转到天荒地老）。
- **「全屏时自动静默」的判据是「前台窗口盖住了整块显示器的物理边界」。**
  这条把"真全屏"和"最大化窗口"分开了：最大化窗口停在任务栏上方（`GetMonitorInfo`
  返回的 `rcWork` 而不是 `rcMonitor`），所以**你最大化一个记事本她不会静默** ——
  这是刻意选的，宁可漏检也不能在你写文档时莫名其妙地不动了。
  ⚠️ **进入是全屏就立刻、退出要等 4 秒**（迟滞）。不等这 4 秒的话，
  打游戏时 Alt+Tab 出去看一眼攻略再切回来，她会"醒一轮又睡回去"，
  每次切换都白折腾一轮。
  ⚠️ 采样靠一个**常驻的 powershell.exe**（每 900 ms 读一次前台窗口），
  不是每秒起一个新进程 —— 后者的固定启动开销就有 ~500 ms。
  父进程被强杀（崩溃 / 任务管理器结束进程）时它会靠自查父进程退出，
  不会留野进程。
  ⚠️ 已知漏检：**UWP 全屏应用**（开始菜单、任务视图、应用商店里的游戏）用的
  窗口类是 `Windows.UI.Core.CoreWindow`，被刻意排除在判定之外 ——
  把它算成全屏的话，你点一下开始菜单再关掉，她也要卡 4 秒才恢复。
- **静默时降的是两个 ticker，不是一个。**Live2D 模型的动作与物理演算跑在
  pixi 的**全局共享 ticker**（`Live2DModel.registerTicker(PIXI.Ticker)` 在插件内部
  等价于 `Ticker.shared`）上，而 `app.ticker` 只负责把舞台画出来。
  只降 `app.ticker` 的话画面是 12fps 了，但 Cubism 依旧每帧算顶点和物理，CPU 一点没省。
