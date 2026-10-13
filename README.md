# 阿岩（Ayan）

一只常驻 Windows 桌面的 Live2D 桌宠。Electron + pixi.js + Live2D Cubism SDK for Web。

![license](https://img.shields.io/badge/license-MIT-blue) ![platform](https://img.shields.io/badge/platform-Windows-blue)

## 它能干什么

- **Live2D 角色**常驻桌面右下角，能贴边、被你拖来拖去；点她会有反应
- **8 档情绪 + 错峰表情**：回复末尾带 `[emo:xxx]` 就会切表情（平静 / 开心 / 微笑 /
  思考 / 害羞 / 严肃 / 惊讶 / 困倦）。眉毛左右**分开驱动**（困惑时一边挑一边压），
  呆毛会翘会耷，身体前倾后仰还会顺带甩动头发裙摆（身体参数是物理输入）；
  切换时**不是整张脸同时变形** —— 眉毛 ~0.1s 先到、眼睛嘴跟上、头和身体最慢
  （动画里的 overlapping action），说话时视线还会小幅游移
- **久没人理就自己走走，你一回来她就回原位**：长时间没人操作（鼠标动一下或敲键盘
  都算"有人"，系统级判定）她就自己来回溜达，走走停停；一旦检测到你在用电脑，
  她会停下并**走回启动时的位置**（详见下节）
- **流式对话**：接大模型 API 陪你聊天，断网时有一套离线话术兜底
- **气泡悬浮在头顶**：她说话时对话泡挂在她**头顶上、紧贴头发**（无边框的白色
  圆角泡 + 一层很柔的模糊投影，微信/QQ 那种质感，尾巴尖指向发顶；样式走过
  三轮 —— 漫画粗黑边 → 细边 → 现在"只留一层很柔的投影"），人物本体一丝不挡
  —— 半身取景下她头顶离窗口顶还有一大截，气泡放窗口里必然压在身上，所以
  对话语泡住在一个独立透明小窗里，底边锚在**实量出来的人物头顶 y**（截图
  逐行扫 alpha，模型挂载和布局变化时自动重量），跟着窗口走、说完自动消失。
  托盘「互动与行为 → 对话语泡悬浮在头顶」可关，关掉回退老布局（气泡压输入条
  上方，会挡到胸口）
- **自定义名称与人设**：性格、说话风格、回答方式等 6 个维度可分别编辑，留空即用默认
- **语音**：按住麦克风说话（Windows 自带 SAPI 离线识别）、点角色朗读回复（TTS）
- **提醒与番茄钟**、**系统状态底座**（窗口底部铭牌：CPU / 内存 / GPU / 温度）
- **全屏 / 游戏时自动静默**：检测到前台是全屏应用就自己"睡过去"（停溜达、停状态轮询、
  取消置顶、渲染降到 12fps），退出后再醒；打游戏时她不会来抢资源或突然出声
- **自动更新**：接 GitHub Releases，启动后静默查一次，也可从托盘菜单手动触发
- 所有功能都有**托盘菜单开关**，角色右键还有一份短菜单

### 默认开关的取舍

新装只默认开启**不勾就不好用**的基础行为：窗口置顶、互动、拖后贴边、摸头反应、
右键菜单、全屏静默、自动更新。会**主动打扰你**（出声 / 自己说话 / 弹提醒 /
不打招呼就挪窗口）或**要常驻占资源**（多一个采样进程）的一律**默认不勾选**，
需要时自己去托盘里打开：

| 默认关闭 | 为什么 |
|---|---|
| 语音朗读 | 一说话就出声 |
| 主动搭话 | 闲置了自己来一句，会打断思路 |
| 闲置时自己溜达 | 不打招呼就挪窗口 |
| 定时提醒 | 到点弹气泡（番茄钟不受影响，它要你点「开始」才计时） |
| 系统状态悬浮显示 | 常驻一条底座，还多一个常驻采样进程 |
| 语音输入 | 要按住麦克风说话 |
| 发现新版直接下载 | 包有 114 MB，不打招呼就下占带宽 |

### 溜达 / 回位是怎么判的

「闲置时自己溜达」打开之后（默认关），行为如下：

- **"有没有人"按系统级判定**，用的是 Windows 的"距上次输入过了多久"
  （`powerMonitor.getSystemIdleTime()`）——鼠标动一下、键盘敲一下都会归零，
  **不限于光标落在她身上**。零额外进程，也不需要在系统里挂钩子。
- 闲置超过 `motion.wanderIdleMin` 分钟（默认 3）→ 她开始溜达，
  **走走停停**：走一小段（约 1~3 秒）→ 站一会儿（0.7~2.2 秒）→ 再走一段，
  一直重复到你回来。
- 你一动，她就停下并**走回"家"**。「家」= **本次启动时她在的位置**
  （也就是你上次手动把她放在的地方）。
- **只有"她自己跑远了"才回位**：你亲手拖她到某处放下，她不会把你刚放好的人
  拽回启动位置 —— 手动摆放是你对位置的明确指定，优先级高于自动行为。
  她之后再溜达跑远，下一次你操作照样会把她收回来。
- 托盘「互动行为 → 有人操作时回到原位」可以单独关掉这条（关掉后就只溜达、不回位）。

回归：`node debug/verify-wander.js`（逻辑单测）+ `debug/driver-motions.js`（实跑）。
实跑时溜达那一段由 `PET_WANDER=1` 驱动 —— 你在电脑前不可能是闲置状态，
这个功能在"正在测它的人"眼皮底下自然触发不了（同 `PET_QUIET` 的道理）。

⚠️ 改默认值**只影响没写过这个键的配置**：老配置文件里你已经点开的开关不会被顶掉
（逐段合并是「默认 ← 你存的」，见 `config.js` 顶部那段注释）。
`debug/verify-config-defaults.js` 把这两件事都锁住了。

### 怎么让对话接上大模型

没填 key 时她走一套离线话术（随机短句，不是报错）。想让她真的会聊，改
`%APPDATA%/live2d-pet/config.json` 的 `llm` 段（托盘右键 →「打开配置文件」），
**任何 OpenAI 兼容服务都能接**，换服务只动这几个字段：

```jsonc
"llm": {
  "baseUrl": "https://api-inference.modelscope.cn/v1",  // 服务地址
  "apiKey":  "ms-xxxxxxxx",                             // 令牌
  "model":   "Qwen/Qwen3.8-Flash-Next",                 // 模型 Id
  "extraBody": { "enable_thinking": false }             // 可选：透传给服务方的开关
}
```

**改完不用重启** —— 每次对话都会重新读配置。

以魔搭（ModelScope）的免费推理 API 为例：

1. 登录 [modelscope.cn](https://modelscope.cn) → 绑定阿里云账号并完成实名认证；
2. 在 [访问令牌页](https://modelscope.cn/my/myaccesstoken) 新建令牌（`ms-` 开头，
   **只显示一次**），填进 `apiKey`；
3. 额度走「魔粒」积分制：每日登录送 200，每次调用按模型档位扣 0.5 / 1 / 2，
   闲聊足够用；额度与限制看官方的「用量限制」页，会调整。

三个坑，都实测过：

- **`/v1/models` 列出来的模型不一定调得通**（有的直接回
  `has no provider supported`，有的高峰期 429）。换模型后务必真打一次。
- **混合思考模型默认开着思考**：正文之前会先流一段 `reasoning_content`，
  气泡半天不吐字。用 `extraBody` 关掉（Qwen 系是 `{"enable_thinking":false}`，
  实测首字 1087ms → 523ms）。各家键名不一样，`llm.js` 只透传、不做语义解释。
- **对话历史会跨重启保留**（`chat-history.json`，最多 16 轮）。她说话越来越短、
  开始复读半句话时，多半是历史被污染了，删掉那个文件就好。

验证工具（都走真实代码路径，不是 curl 近似）：

```bash
node debug/llm-probe.js                 # 按当前配置探一次：首字延迟 / 推理阶段 / 情绪标签
node debug/llm-probe.js --model A,B,C   # 一次比多个模型
node debug/llm-probe.js --list          # 列服务端当前提供的模型
node debug/verify-llm.js                # 标签剥离 + extraBody 合并边界的单测
./debug/gen-driver.sh driver-llm.js     # 实跑：从输入框打进消息，验完整链路
```

## 环境要求

- Windows 10/11（开发与打包均在此验证）
- Node.js ≥ 20，包管理器 pnpm（`npm i -g pnpm`）
- 想跑起来就联网（首次会从 Live2D 官方 CDN 拉一次运行时，之后有本地缓存）

## 跑起来

```bash
pnpm install

# 模型（Hiyori，版权归 Live2D Inc.）不随仓库分发
# 从 Releases 下载 models.zip，解压到 src/assets/，得到 src/assets/models/hiyori/
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
src/main/        主进程：窗口/托盘/IPC/配置/对话/提醒/语音识别/悬浮气泡窗
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

### Live2D 示例模型（Hiyori）

**模型文件不在本仓库里。** 它是 Live2D 官方示例数据集中的 **Hiyori Momose**，
版权归 **Live2D Inc.** 所有，因此改为放在
[Releases](https://github.com/chenshiyilisha/live2d-pet/releases) 的 `models.zip` 中，
仓库只保留源码。

> 2026-10-13：原先还带一个 **Haru**，已按要求移除 —— 应用现在固定使用日和。

**从源码跑的话，需要两步**（本地已有副本就跳过）：

1. 从 Releases 下载 `models.zip`
2. 解压到 `src/assets/`，得到 `src/assets/models/hiyori/`

该目录已在 `.gitignore` 里，不会被误提交。

**打包出的安装包不受影响**：`tools/prepare-stage.js` 整树复制 `src/`，本地有模型就会
一起带上，所以最终用户装完离线也能显示角色。需要多这一步的只有"从源码跑"的人。

使用须遵守：

- [Free Material License Agreement](https://www.live2d.com/eula/live2d-free-material-license-agreement_en.html)
- [Terms of Use for Live2D Cubism Sample Data](https://www.live2d.com/eula/live2d-sample-model-terms_en.html)

要点：

- 一般用户与小规模企业（年营收 < 1000 万日元）可自由使用，含商用
- **Hiyori Momose 不允许对角色设计做任何改动**（官方条款原文："No changes of any kind
  to the design of this character are permitted"）。本项目遵守这一条：新增的
  `Drag` / `Walk` 动作文件只**驱动已有参数**，不触碰任何一张贴图、也不改角色造型
  （生成方式与边界见 `tools/make-motions.js`）
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
| `src/assets/models/`（Hiyori） | 角色版权归 **Live2D Inc.**，受 Free Material License 约束（见上一节）。**不在本仓库内**，从 Release 下载 |
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
- **GPU 占用取的是独立显卡（NVIDIA）的利用率**，由 `nvidia-smi` 直接读，和温度取自
  同一次调用（实测 ~180 ms）。**没有 N 卡就整项不画** —— 和温度同一个规矩，不拿核显的数冒充。
  ⚠️ 早先走的是 Windows 性能计数器（`GPUEngine` 里的 `engtype_3D`，跨实例求和），
  这在**双显卡机器上口径就是错的**：那些实例按 `luid` 分、核显与独显各一串，求和等于
  把两块卡加在一起。而桌宠实际渲染在核显上（实测 `?snap=1` 打出的 WebGL 后端是
  `ANGLE (Intel … Direct3D11, D3D11)`），于是屏幕上显示的全是核显的负载（30~67%），
  独显明明在待机 —— 2026-10-13 用户报"取的好像是核显的"，属实，那条路已整体删除。
  ⚠️ 采样靠一个**常驻的 powershell**（每 1 秒一枪），不是每次推送都起个新进程 ——
  后者光固定启动开销就有 ~500 ms。采样器**只在悬浮显示开着、且没进全屏静默时跑**，
  其余时候立刻停。
  ⚠️ 机器上**没有对应的数据源时**，采样器跑够 8 拍还没有该字段就把它标成"永久取不到"，
  之后不再为它单起进程 —— 这一项不画，但也不再为它花钱。
- **窗口宽度固定成"对话框那一档"，人物恒居中。**
  宽度 = `max(人物墨水宽, 底座牌 148) + 2×24`，再对齐到 ≥ **308**（气泡 / 输入条需要
  的最小宽度）—— 平时恒为 308，只有换模型 / 把缩放调大（墨水宽 ≥ 260）才会变宽。
  宽度算式**不依赖对话态**：点开或收起输入条，窗口一个像素都不动
  （2026-10-12 用户："按对话框固定大小，不需要点击后再调整"）。
  ⚠️ 早先试过"常驻窄、说话时撑开"并让内容整体右靠（`--content-shift`），代价是点一下
  窗口就动一次、人物跟着挪 —— 已整体移除，别加回来（`debug/verify-win-size.js`
  有禁回流断言）。
  ⚠️ 主进程落 `setBounds` 时**钉死内容区右边缘**（不是外框），并用"实测右边缘 − 目标"
  回补误差：150% 缩放下外框比内容区宽 1px，用 `getBounds()` 反推会每切一次漂 1px，
  `getContentBounds()` 才是锚。
- **对话时底座整块让位**：输入条和底座都贴窗口底，必然重叠，所以输入条一打开底座就淡出
  （只藏牌、不动舞台让出的高度，人物不因此缩放）。
- **悬浮小字是窗口底部的一条「底座」，人物站在它上面、不会被它遮住。**
  四个指标（CPU / 内存 / GPU / 温度）排成固定的 **2 行 × 2 列**。
  半身取景下人物的下沿正好落在窗口底（不留白就是直接糊在裙子上），所以做法是
  让舞台让出一条：开启悬浮显示时，渲染层量出底座的**实际**高度写进
  CSS 变量 `--stats-h`，`#stage` 按它缩进，canvas 随之变矮、人物等比缩小一圈。
  ⚠️ 高度是**量出来的不是写死的**：窗口窄（小屏）时行高会变，写死一个数字要么
  留白过大要么还是叠上。底座每高 1px 都是拿人物尺寸换的，所以纵向 padding 压到
  最低、不加图标。
- **第一条数据到之前，底座位置上是一个转圈的小药丸**，拿到数值它才展开成整块牌。
  实测冷启动这段约 **0.9 秒**（主进程首次推送前会等采样器给出第一个独显读数，
  免得先出半张牌、GPU 那一格下一拍才补进来），以前这段时间窗口底部是空的，
  看着像"今天没开悬浮显示"。
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
