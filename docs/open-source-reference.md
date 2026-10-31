# 开源参考调研（第 6–10 轮）· 逐项对照与可借鉴清单

> 第 6 轮（Nexus / Desktop-pet / chatgpt-desktopPet / Live2d-TTS-Audio-LipSync）见下；
>   
> 第 7 轮（AI 伴侣生态：Open-LLM-VTuber / astrbot 主动聊天插件 / awesome-ai-companion）见文末；
>   
> 第 8 轮（参数级情绪插值：Cubism SDK / VTube Studio / Picard 衰减）紧随其后；
>   
> 第 9 轮（Cyrene-Agent 主动搭话策略 / Live2DPet 窗口停留）在文档最后；
>   
> 第 10 轮（自家 3D 版 ayan-3d 的四块积木对照）收尾。

> 时间：2026-10-14 · 动机：本项目 VAD / 表情抖动 / 纹理 LOD / 真口型 / 媒体感知 / 主动搭话
>   
> 六项均为自研，**没有一行参考过现成实现**。这一轮专门去找同类开源工程，回答两个问题：
>   
> ① 我们的做法有没有别人独立走通（= 靠不靠谱）② 别人有什么我们没想到的（= 抄什么）。

## 0. 方法

- **只走 GitHub 官方 API**（`api.github.com/search/repositories`）。上一轮的教训：搜索引擎
    
  命中的 `ghub.com` / `github.me` / `reporank.net` 这类聚合站会**凭空生成仓库名**（8 个候选 6 个
    
  `git ls-remote` 不通）。官方 API 拿到的 `full_name` 才是真的。
- 源码用 `codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<branch>` 下载（`git clone` 被代理 502 挡）。
- 单个超大仓库（`Voine/ChatWaifu_Mobile`，624MB C++ 移动端）跳过；`git2968/Desktop-pet` 41MB 下载两次
    
  都超时，改用 `git/trees?recursive=1` 拿文件树 + `raw.githubusercontent.com` 定点抓需要的文件。

## 1. 找到的对口项目

| 项目                                         | ★   | 语言 | 更新      | 与本项目的重合面                                             |
| ------------------------------------------ | --- | -- | ------- | ---------------------------------------------------- |
| **FanyinLiu/Nexus**                        | 20  | TS | 2026-10 | **最重合**：Electron + Live2D 桌宠 + LLM + TTS/STT + 自主性引擎 |
| **git2968/Desktop-pet**                    | 18  | TS | 2026-08 | Live2D + AI 对话 + 人设 + 语音输入 + MCP                     |
| **zhao896632126/Live2d-TTS-Audio-LipSync** | 13  | JS | 2024-02 | **真口型**（讯飞 TTS + AnalyserNode）                       |
| **kirbystudy/chatgpt-desktopPet**          | 90  | JS | 2023-09 | Electron + Live2D 桌宠（实现较原始）                          |
| kdavis-mozilla/vad.js                      | 153 | JS | 老       | VAD（能量法 + 机器学习两路）                                    |
| cprosche/mulberry32                        | 55  | JS | —       | 我们的 seeded PRNG 就是它                                  |
| shaedy180/obs-overlay-nowplaying 等         | ≤3  | 多  | —       | 读 Windows GSMTC 做「正在播放」                              |
| travisvn/edge-tts-universal                | 81  | TS | —       | Edge 在线 TTS（音色升级路线）                                  |

**Nexus 是本轮的主要对照对象**——它是唯一一个有完整分层架构、328 个测试、架构边界自动审查、
  
设计文档（`ARCHITECTURE.md` / `BEHAVIOR_MAP.md`）的同类项目，且已迭代到 v0.4.7。

## 2. 交叉验证：我们的做法被别人独立印证

这一节回答「我的代码靠谱吗」。以下都是**独立实现、相同结论**，不是抄来的：

### 2.1 真口型（`tts.js` / `pet.js`）—— `Nexus/src/features/voice/lipSync.ts` 几乎逐行同构

| 参数                 | 我们                             | Nexus                                                       | 说明            |
| ------------------ | ------------------------------ | ----------------------------------------------------------- | ------------- |
| 取包络方式              | **时域** RMS                     | **时域** RMS（`getByteTimeDomainData` → `(v-128)/128` → 平方和开方） | 一致            |
| `analyser.fftSize` | **512**（32ms ≈ 一个音节）           | **512**                                                     | 独立取到同一个数      |
| 噪声底                | 常量 0.011 量级（VAD 的 `peakFloor`） | **0.011**                                                   | 一致            |
| 映射                 | 增益 + 快攻慢放（40/12）               | `clamp((rms - 0.011) * 7.5, 0, 1)`                          | 同思想（减底噪再线性放大） |
| 驱动                 | pixi ticker 每帧                 | `requestAnimationFrame`                                     | 等价            |
| 收尾                 | 闭嘴干净（实测 0 偏差）                  | `setMouthOpenY(0)`                                          | 一致            |

→ **两个独立实现落在同一组参数上，说明这组值是物理合理的**（不是我们碰巧调出来的）。

### 2.2 WAV 编码（`audio.js`）—— `Nexus: encodeVadAudioToWavBlob` 逐行相同

`RIFF`/`WAVE`/`fmt `/`data` 四段、`blockAlign=2`、`byteRate = sampleRate*blockSize`、
  
`clamped < 0 ? *0x8000 : *0x7fff`、16kHz —— 连写法都几乎一样。

### 2.3 参数注入时机

`Live2d-TTS-Audio-LipSync` 的口型写参数用的是**覆盖 `motionManager.update`，在原 update 之后
  
再写 `ParamMouthOpenY`**。我们是在自己的 ticker 里靠**调用顺序**保证（`updateGaze` → 表情 → 口型）。
  
两种做法解决的是同一个问题：**参数写入必须晚于动作/表情系统**。我们的做法更简单（不用打补丁到第三方对象上）。

### 2.4 阈值数量级

我们的 VAD `peakFloor = 0.010`（≈ −40dBFS）与 Nexus 口型的噪声底 `0.011` 几乎相同 ——
  
**两个不同用途的独立标定收敛到同一个数**。

### 2.5 我们的「参数级情绪」比同类的「表情名映射」稳

`Desktop-pet/app/shared/emotion-map.ts` 用**模型自带的 expression / motion 名字**做映射，
  
它自己的注释承认了这个路线的痛点：

> 不同 Live2D 模型的 designer 自定义参数 / 表情命名差异极大，全局关键词匹配很容易误中
>   
> （比如魔女的 "x" / "xx" 是道具开关而非情绪）

我们的做法（`PARAM` 参数 ID + `EMOTION` 16 字段数值 + `EMO_SPEED` 错峰插值）**不依赖命名**，
  
跨模型可移植。这是本项目明显更优的一处，**不要动摇**。

## 3. 可以借鉴的「思路」（按价值排序）

### ① 🔴 防复读护栏（`Nexus/v2/repetitionGuard.ts`）

**正对症我们记忆里那条「说话变短/复读 = 删 `chat-history.json`」。**

它是**纯后分析器**：扫最近几条回复的结构相似性，产出「避免 X」提示注入下一条 prompt。
  
不做 LLM 调用、不膨胀历史。四个检测维度：

| 维度                 | 判据                                         |
| ------------------ | ------------------------------------------ |
| `avoidOpenings`    | 出现 ≥2 次的**开头两个字**（最近 ≥3 条才判）               |
| `avoidEndings`     | 标点后重复的**末尾四字**                             |
| `lengthMonotone`   | 所有回复长度都在均值 **±20%** 内（说的话总一样长，很假）          |
| `avoidPunctuation` | `! ！ ? ？ … ~ ～` 里，带 ≥2 个该标点的回复占比 ≥ **50%** |

关键设计哲学（原文）：

> Layered on top of personaGuardrail (which checks fidelity to the character).
>   
> This module checks fidelity to *variety*.

**护栏分两层：人设护栏管「像不像她」，重复护栏管「像不像人」。**
  
我们的 `createOpenerStripper` 是**删除**填充词（清理），它是**提示避免重复**（引导）—— 两者互补。
  
落地位置：`llm.js`，纯函数，可单测，零依赖。

### ② 🔴 安静时段 + 三档专注状态（`Nexus/focusAwareness.ts`）

```ts
classifyFocusState(idleSeconds) → 'active' | 'idle'(≥300s) | 'away'(≥1800s)
                                  + 'locked'（由电源事件外部设置）
shouldSuppressAutonomy(focusState, hour, quietHours) → boolean
```

**我们目前完全不看时间** —— 凌晨三点她照样会开口搭话。这是真实的产品缺口。
  
而且我们**已经有** `powerMonitor.getSystemIdleTime()`（`motion.js`，硬规矩 25），
  
所以加「`away` 抑制 + 安静时段」是**零新依赖**的小改动。
  
注意它的 `quietHours` **正确处理了跨午夜**（`start > end` 时用 `hour >= start || hour < end`）——
  
我们要抄就抄这个分支，别写错。

### ③ 输出侧人设护栏（`Nexus/v2/personaGuardrail.ts`）

我们的「人设禁令」写在 **system prompt 里（输入侧）** —— 模型说了「作为一个 AI 助手」我们照发。
  
Nexus 多一层**输出侧**，三档（`loose` / `med` / `strict`）：

- `med`（纯确定性、零成本）：① `forbiddenPhrases` **硬失败**（例：「作为 AI」）② 长回复的
    
  **签名短语密度下限**（`SIGNATURE_DENSITY_MIN_LENGTH = 40` 字形素以上才检查，因为「嗯」「在」
    
  这种短回复本身就是那个风格）
- `strict`：再加一次 **LLM-as-judge**（拿人设 + 候选文本判 yes/no）

两条细节值得抄：

- **它是纯过滤器**，返回 `{pass, reason}`，**不修改文本**；重试还是沉默由调用方决定。
- 🔴 **`silent` 结果在所有档位直通** ——「我们绝不从沉默的决策里造出话来」。

它把失败模式命名得很准：**persona drift（人设漂移）是用户最优先的失败模式**。

### ④ 作息学习（`Nexus/rhythmLearner.ts`）

24 个小时槽记录交互次数 → **每周 ×0.85 衰减**（适应习惯变化）→ **主动搭话只在高活跃窗口**。
  
实现极简（24 个数字 + 一次衰减），效果是「她学会了你的作息」。

与 ② 的关系：**② 是用户显式配的安静时段，④ 是自动学出来的活跃窗口**，两者互补。

### ⑤ 上下文注入的「从属信号」哲学 + 防注入（`Nexus/activityTone.ts` / `desktopContext.ts`）

我们的媒体感知是「拿到歌名 → 描述一句 → 拼进 prompt」。Nexus 的做法多了三道保险：

**a. 刻意不做硬映射**（原文）：

> Deliberately NOT a scripted activity→tone map (gaming≠"relaxed"). We just make the already-classified
>   
> activity legible to the model and tell it the signal is subordinate: defer to how the conversation
>   
> actually feels, and **never mention or hint that you can tell what the user is doing**.

→ 同时给两个约束：① 这个信号是**从属的**，以对话实际感觉为准 ② **永远不要露出来你能看出他在干什么**。
  
我们的 `PROACTIVE_MOOD_HINT` 已经是「只给方向、不写死台词」，方向一致，但**缺「不许说破」这条**。

**b. 按活动调回复密度**（`ACTIVITY_DENSITY`）：
  
`coding` → 更短更直接（"they are in flow"）；`gaming` → 简短轻快；`documents` → 可以稍微详尽。
  
**我们完全没有这个维度。**

**c. 🔴 防 prompt injection**：观察到的文本**每行加 `> ` 前缀**再进 prompt —— 明确标记成「引用」，
  
防止模型把用户屏幕上的文字当成指令。我们目前把歌名**原样拼进 prompt**，理论上歌名里塞指令就能注入。
  
另外它有独立的**脱敏模块**（`sanitizeDesktopContextSnapshotForPrompt`）+ **每个字段独立的长度上限**
  
（180 / 80 / 220 / 1600 / 1800 / 800 / 900）+ 分项开关（前台窗口 / 剪贴板 / 截图，截图默认 false）。

### ⑥ 事件驱动的主动搭话（`Desktop-pet/electron/proactive-aware.ts`）

**触发源完全不同**：

|     | 我们                     | Desktop-pet           |
| --- | ---------------------- | --------------------- |
| 触发源 | **时间**（闲置 8 分钟 + 情绪安定） | **事件**（前台应用切换 / 长停留）  |
| 话头  | 泛泛的（"主动开个话头"）          | 自带上下文（"你在写代码写了 1 小时"） |
| 冷却  | 2s 重试（闸门）              | 切换冷却 **5 分钟**         |

它的细节做得很稳：每 8 秒轮询前台窗口；启动后 **8 秒宽限**（避开冷启动抖动）；
  
「长停留」**本次会话只触发一次**（切走再回来才重置）；**排除桌宠自己的窗口**（否则切回桌宠
  
会被当成"应用切换"）；有一张 `FRIENDLY_NAMES` 映射表（`code`→VS Code、`cloudmusic`→网易云音乐…）。

**可以叠加而不是替换**：我们的「闲置 + 安定」闸门（防打扰）保留，
  
**把触发源从「时间到」换成「事件发生 + 闸门放行」** —— 话头就从"随便说点什么"变成有由头的。
  
它区分了 `reason: 'switch' | 'long-stay'`，渲染端可以对不同原因给不同话头 ——
  
与我们的「话头按情绪分」是**两个正交维度**，可以叠。

### ⑦ 内在状态机多一个「困倦」相（`Nexus/tickLoop.ts`）

```
awake → drowsy（闲置 > 睡眠阈值/2）→ sleeping（闲置 > 睡眠阈值）→ dreaming（外部触发）
任何状态 → awake（用户交互）
```

- 安静时段 / 锁屏 → sleeping
- `consecutiveIdleTicks` / `lastWakeAt` / `lastSleepAt` / `dailyTickCount`

我们只有 `IDLE / SLEEP / SPEAKING`。**`drowsy` 是「快睡了」的过渡相** —— 可以驱动
  
打哈欠 / 揉眼睛这类微动作，成本极低但很讨喜。`dreaming` 是夜间记忆巩固的载体。

### ⑧ 情绪模型：4 维连续 vs 我们的 8 个离散标签（`Nexus/emotionModel.ts`）

|    | 我们                                                           | Nexus                                              |
| -- | ------------------------------------------------------------ | -------------------------------------------------- |
| 表示 | 8 个离散情绪（calm/happy/smile/think/shy/serious/surprised/sleepy） | 4 维连续 0–1（energy / warmth / curiosity / concern）   |
| 驱动 | 事件 → 设目标 → 逐帧插值                                              | 事件 → `SIGNAL_DELTAS` 表累加增量 → `driftToward()` 向基线漂移 |
| 用途 | **当下的表情**（16 参数）                                             | **跨会话的基调**（驱动 prompt 语气 + mood 映射）                 |

**不是二选一**：我们的 8 标签适合「此刻的脸」，4 维适合「她记得你这几天心情不太好」这种长期基调。
  
我们目前**没有「长时间没人理 → 慢慢回到 calm」的漂移机制**（Nexus 有 `driftToward`）——
  
这是个小而实用的补充。

🔴 它的信号表里有一条深刻的注释，**做「共情」时必读**：

> Companion-side empathy/awareness signals ... **must never be projected back into the user-affect
>   
> timeline**（that would be a feedback loop: the observation was derived from that very timeline）

→ 她的「共情信号」不能回流到自己情绪模型的输入里，否则是**自激反馈**。任何"她感知到用户情绪
  
→ 改变自己 → 再被当成用户情绪"的闭环都是这个坑。

### ⑨ 架构约束做成可执行的自动审查（`Nexus/scripts/architecture-boundary-audit.mjs` + `tests/`）

Nexus 的 `autonomy/README.md` 把分层规则写得很硬：

> `features/autonomy/` 是**纯的** —— 无 React、无 IPC、无 window。**任何 import 进来的东西应该能
>   
> 在普通 Node 测试里跑、不需要 mock**。
>   
> 违反这个分层通常就是自主性难以导航的原因。如果你发现自己在从 `features/autonomy/*`
>   
> import `useRef`，**停下来**。

而**这条规则由一个脚本扫 import 路径自动检查**（还有配套的 fixture 测试，328 个测试文件之一）。

→ 我们的硬规矩是**文字约定**（`main.js → 各模块`，模块间不互相 require）+ 若干 `verify-*.js` 里的
  
**源码级正则断言**。我们的断言是「某段代码长这样」，它的审查是「**依赖方向对不对**」——
  
后者更本质、更耐重构。值得单独做一个 `debug/verify-arch.js`：扫 `src/` 所有 `require/import`，
  
断言「模块间不互相 require」「渲染层不 require 主进程」「`features/` 不碰 Electron」。

### ⑩ 口型的降级路径：文字模拟 > 正弦波（`Nexus/lipSync.ts: simulateText`）

我们拿不到波形时（`system` 引擎 / 合成失败）退回**正弦波** —— 与文本完全无关的固定波形。
  
Nexus 的降级是**按文本驱动**：

```ts
// 每 88ms（再按语速缩放）推进一个字符
const isSoftPause = /[\s,，。.!！？、:：;；~]/u.test(char)
const targetLevel = isSoftPause ? 0.08 + Math.random() * 0.08    // 标点处闭嘴
                                : 0.32 + Math.random() * 0.46    // 字与字之间有起伏
```

**标点处降幅**是最关键的一点 —— 它让"念句子"有换气感。我们调 `speak(text)` 时**手里就有文本**，
  
改成按文本驱动是纯收益（观感明显更像在说话），而且不依赖任何新能力。

## 4. 可以借鉴的「代码」（可直接搬）

| 目标        | 来源                                              | 搬法                                        |
| --------- | ----------------------------------------------- | ----------------------------------------- |
| 防复读       | `Nexus/v2/repetitionGuard.ts`                   | 整份搬（纯函数，98 行，零依赖）                         |
| 安静时段/专注分档 | `Nexus/focusAwareness.ts`                       | 整份搬（61 行，纯函数）；接到已有的 `getSystemIdleTime()` |
| 口型文字模拟    | `Nexus/lipSync.ts: simulateText`                | 取那 15 行，替掉我们的正弦波降级                        |
| 引用前缀防注入   | `Nexus/desktopContext.ts: quoteObservedText`    | 三行（每行加 `> `），用到 `injectMediaContext`      |
| 作息学习      | `Nexus/rhythmLearner.ts`                        | 24 槽 + 周衰减，约 60 行                         |
| 架构边界审查    | `Nexus/scripts/architecture-boundary-audit.mjs` | 思路照搬，写成 `debug/verify-arch.js`            |

## 5. 明确**不该**抄的

| 候选                                                             | 为什么不抄                                                                                                                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Silero VAD**（Nexus 的 VAD 后端）                                 | 它是**语义级**语音检测（ONNX 模型 + WASM runtime + AudioWorklet→ScriptProcessor 两级回退，`browserVad.ts` 300 行里一多半在处理回退）。适合「常开免按键唤醒」；我们是**按住说话**（用户已明确表达"我要说"），能量判据足够。我们的 30 行纯函数是对的。 |
| **表情名映射**（Desktop-pet `emotion-map.ts`）                        | 依赖模型 designer 的命名，它自己都承认会误中。我们的参数级更稳。                                                                                                                                 |
| **Chromium TTS + 可见窗口**（chatgpt-desktopPet）                    | 它为一个合成开 1024×768 的窗口，还会闪。我们的常驻合成进程 + WebAudio 播放好得多。                                                                                                                  |
| **频域跳采口型**（Live2d-TTS-Audio-LipSync）                           | `getByteFrequencyData` + 每 80 格取 1 + `(avg-20)/60` 硬编码常数 —— 对音量不敏感（不同音源 20/60 会飘）。我们和 Nexus 的**时域 RMS** 更直接。                                                          |
| **`setTimeout` 驱动口型**（同上，30fps）                                | 我们有 pixi ticker，天然按帧。                                                                                                                                                 |
| **每帧重建闭包写参数**（同上，`setMouthOpenY` 每次都重赋 `motionManager.update`） | 每帧新建函数。                                                                                                                                                               |
| **Nexus 的整体架构规模**                                              | 328 测试 / 17 个功能域 / 多 provider / MCP / 插件 / 游戏集成 —— 那是产品化项目。我们照搬会失控。**只借具体思路，别借体量。**                                                                                   |


## 6. 本轮的空白（想找但没找到）

- **纹理 LOD**：Nexus 只有 `antialias: true` + 一个纯布局的 `layout.ts`（scale/anchor），
    
  **没有任何纹理降采样**；GitHub 搜「pixi texture lod / mipmap」返回 0 条。我们的
    
  `level = clamp(round(log2(1/effScale)), 0, maxLevel)` + 换 `TextureSource.resource` 是**独创**。
- **GSMTC 的 Node 实现**：Nexus **没有**媒体感知（它走的是前台窗口标题 + 剪贴板 + OCR + VLM）；
    
  找到的 GSMTC 工具都是 C#/Go/Rust 独立小工具，**没有可用的 Node 绑定**——
    
  印证了我们「常驻 PowerShell 读 WinRT」的路线是当前唯一可行解。

---

## 附：可查证的路径

本轮下载的源码在 `.research-tmp/refs/`（已 gitignore，清理前可随时复看）：

```
Nexus-main/src/features/voice/lipSync.ts            真口型（对照）
Nexus-main/src/features/hearing/browserVad.ts       VAD（Silero 路线）
Nexus-main/src/features/autonomy/README.md          自主性分层规则 ★
Nexus-main/src/features/autonomy/focusAwareness.ts  安静时段/专注分档 ★
Nexus-main/src/features/autonomy/rhythmLearner.ts   作息学习
Nexus-main/src/features/autonomy/tickLoop.ts        内在状态机
Nexus-main/src/features/autonomy/emotionModel.ts    4 维情绪 + SIGNAL_DELTAS
Nexus-main/src/features/autonomy/activityTone.ts    从属信号哲学 ★
Nexus-main/src/features/autonomy/v2/repetitionGuard.ts     防复读 ★
Nexus-main/src/features/autonomy/v2/personaGuardrail.ts    输出侧护栏 ★
Nexus-main/src/features/context/desktopContext.ts   引用前缀防注入
Desktop-pet(app/shared/emotion-map.ts)              表情名映射（反面教材）
Desktop-pet(app/electron/proactive-aware.ts)        事件驱动主动搭话 ★
Live2d-TTS-Audio-LipSync/src/views/ModelViewer.vue  频域口型（反面教材）
```

---

# 第 7 轮 · AI 伴侣生态（2026-10-14）

## 7.0 方法

- **走 GitHub 官方 API**（`search/repositories?sort=stars`，免 token），命中后 `git/trees?recursive=1`
    
  取文件树，再用 `raw.githubusercontent.com` / `git/blobs/<sha>`（base64）取单文件。
    
  **不用搜索引擎**——第 5 轮的教训是聚合/镜像站会把仓库名拼错。
- 额外拿 **`DasterProkio/awesome-ai-companion`**（971★，「人机恋开源项目大全」，作者声明逐项目读过代码）
    
  当索引入口，避免只看 star 榜漏掉垂直项目。
- 抓下的证据在 `.research-tmp/refs/{olv,astrbot}/`（已 gitignore）。

## 7.1 候选地图

| 项目                                                                        | ★              | 语言       | 对口的位置                              | 结论                           |
| ------------------------------------------------------------------------- | -------------- | -------- | ---------------------------------- | ---------------------------- |
| `Open-LLM-VTuber/Open-LLM-VTuber`                                         | 14095          | Python   | 全链路：ASR / TTS / 口型 / **打断** / 主动搭话 | ★ 本轮最大参照系，**只借单点代码**（整体架构不搬） |
| `Open-LLM-VTuber/Open-LLM-VTuber-Web`                                     | —              | TS       | 前端口型与打断                            | 借「打断必须复位口型」                  |
| `DBJD-CR/astrbot_plugin_proactive_chat`                                   | —              | Python   | **主动搭话的调度与准入**                     | ★ 判据分层 + 退避（本轮最实用）           |
| `DasterProkio/awesome-ai-companion`                                       | 971            | HTML     | 索引                                 | 拿到 200+ 项目地图                 |
| `kiyotakali/Miru`                                                         | 175            | Python   | 桌宠 + 记忆                            | macOS 优先，思路级                 |
| `x380kkm/Live2DPet`                                                       | 87             | JS       | Live2D + VOICEVOX TTS              | TTS 引擎选型参考                   |
| `gameswu/NyaDeskPet`                                                      | 18             | TS       | Live2D + Agent（同为 Electron 系）      | 小项目，看布局                      |
| `pixelomer/Shijima-Qt` · `gil/shimeji-ee` · `DalekCraft2/Shimeji-Desktop` | 200/60/52      | C++/Java | 桌宠行为物理（抛掷 / 重力 / 爬窗口）              | 行为库参照                        |
| `ChanceYu/CoPet` · `Shellishack/vibebud`                                  | 36/63          | Rust/TS  | 响应「AI 编程助手在跑任务」                    | 事件源思路                        |
| `DonkeyKing01/BriefyPet`                                                  | 46             | Rust     | RSS 摘要 + 提醒                        | 与我们的 `reminder.js` 同方向       |
| `KoljaB/RealtimeSTT` · `dscripka/openWakeWord` · `arcosoph/nanowakeword`  | 10188/2844/130 | Python   | 唤醒词 + 流式 VAD                       | 免手方案（偏重，列为备选）                |
| `myths-labs/prometheus-avatar`                                            | 17             | TS       | LLM 输出驱动 Live2D 的 SDK              | 对照我们的参数级方案                   |

## 7.2 代码级可借鉴（4 条，均有文件证据）

### ① 并行合成 + 序号重排投递 —— `olv/tts_manager.py:16-113` ★

问题：我们是「合成一句 → 播 → 再合下一句」，N 句回复的延迟是**串行叠加**的。

他们的做法：所有句子**并发**合成，每个 payload 带一个 `sequence_number`，由单独的
  
`_process_payload_queue()` 按序投递（`buffered_payloads` 字典 + `_next_sequence_to_send` 游标）：

```python
buffered_payloads[sequence_number] = payload
while self._next_sequence_to_send in buffered_payloads:
    next_payload = buffered_payloads.pop(self._next_sequence_to_send)
    await websocket_send(json.dumps(next_payload))
    self._next_sequence_to_send += 1
```

可搬处：`src/renderer/tts.js` 把「合成」与「播放」解耦——首句延迟不变，后续句子**零等待**。
  
注意两件事：常驻 PS 合成进程要限并发（我们目前是串行请求队列，建议上限 2）；
  
`clear()` 的语义是 `task_list.clear()` + 取消 sender + **重建 queue**，正好对应我们的 `interrupt()`。

### ② 🔴 被打断时「记忆里只记听到的部分」—— `olv/basic_memory_agent.py:195-220`

我们**真实存在**这个缺口：用户打断 TTS 后，`chat-history.json` 仍记着完整回复，
  
下一轮模型以为自己全说完了 → 出现「我刚说到哪了」的错位。

他们的 `handle_interrupt(heard_response)` 是三段式：

```python
if self._interrupt_handled:            # ① 幂等：打断只处理一次
    return
self._interrupt_handled = True
if self._memory and self._memory[-1]["role"] == "assistant":
    self._memory[-1]["content"] = heard_response + "..."   # ② 只记听到的 + 省略号
...
self._memory.append({"role": interrupt_role, "content": "[Interrupted by user]", ...})  # ③ 显式标注
```

③ 的 role 还是**可配的**（`interrupt_method`：`system` / `user`）——让模型明确知道自己被打断。
  
落地：渲染层 `interrupt()` 回传「已播出字数」，主进程落历史时截断 + 省略号 + 插一条标注。
  
我们的 `createStreamFilter` 本来就是分片吐字，回传成本很低。

### ③ 主动搭话的准入判据：把「重排」和「停」分开 —— `astrbot/gating_feature.py:24-92` ★

```python
if block_reason == "quiet_hours":      return StageResult.RESCHEDULE   # 重新调度
...
if unanswered_count >= max_unanswered: return StageResult.STOP         # 暂停，等用户开口
```

判据只有三类：**免打扰时段 / 会话禁用 / 未回复次数超限**，但返回值分两种语义
  
（`RESCHEDULE` = 换个时间再来，`STOP` = 闭嘴直到用户说话）。参数默认值可直接借
  
（`astrbot/_conf_schema.json`）：

- `quiet_hours` = `"1-7"` —— 字符串「开始-结束」（私聊默认 1:00–7:00；群聊 `"2-6"`），
    
  跨零点用一个串就能表达
- `min_interval_minutes` 30 / `max_interval_minutes` 600 —— **区间随机**（`random.randint`），不是固定值
- `max_unanswered_times` 4（私聊）/ 2（群聊），填 0 不限
- `group_idle_trigger_minutes` 30 —— 沉默多久才考虑触发
- 分条发送间隔：`interval_method` = `random`（`1.5, 3.5` 秒）或 **`log`（按字数 y=log_base(x)）**

我们的现状：`proactiveSpeak` 三闸门被拦是**固定 2s 重试**（只等于 `RESCHEDULE`，且间隔不随机）；
  
**没有**免打扰时段，也**没有**「用户一直不理就闭嘴」的退避。
  
改法很小：闸门返回改成枚举 `{OK, RETRY, STOP}`，`RETRY` 用随机退避，`STOP` 记 `unanswered` 计数、
  
用户说话清零。

### ④ 🔴 打断必须**显式复位口型** —— `olv/web-audio-manager.ts:20-58`

```ts
model._wavFileHandler.releasePcmData();
model._wavFileHandler._lastRms = 0.0;      // 兜底复位
model._wavFileHandler._sampleOffset = 0;
```

他们注释写得很直白：`Release PCM data to stop lip sync calculation in update()`，还要**再手动把
  
`_lastRms` 归零作为 fallback**；配合我们 `pet.js` 里 `lipEnv` 无波形时**回退正弦波**的语义——
  
如果打断后 `speaking` 没在同一次状态变更里清掉，嘴会继续动。
  
动作项：核对 `tts.js interrupt()` → `pet.js` 的 `speaking` / `lipEnv` 是否原子归零，
  
并在 `verify-lip.js` 加一条「打断后 1s 内 `ParamMouthOpenY` 全 0」的断言。

## 7.3 思路级（按性价比排序）

1. **免打扰时段** —— 零新依赖（本机时间即可），配置就一个 `"1-7"` 字符串。凌晨三点别搭话。
2. **未回复退避** —— 连续 N 次没人理自动静默，用户开口清零。（1、2 都是用户**真能感知**的）
3. **媒体播放中不插话** —— 我们已有 `media.js` 的 `Playing` 状态，判据只差一行。
4. **前台疑似专注时收敛** —— `fullscreen.js` 已经在看前台，可扩成「写代码 / 全屏」一类。
5. **分条回复的条间停顿按字数取对数** —— 借 `interval_method=log`；我们已有分句，只差间隔曲线。
6. **抛掷 / 重力 / 爬窗口** —— Shimeji 系；`motion.js` 已有拖拽与贴边，抛掷是自然的下一步。
7. **用户音量基线** —— `ears` 把音高 / 能量 / 停顿与用户自己的基线比，产出「今天比平时小声」这种
     
   相对线索；我们的 RMS / VAD 基建已经够用。
8. **唤醒词** —— `openWakeWord` / `nanowakeword` 作可选免手入口；现阶段按住说话更省事，备选。
9. **语音 3D 耳畔感** —— `binaural-voice`（KU100 HRIR），有趣但优先级低。
10. **反应「AI 编程助手在跑任务」** —— `CoPet` / `vibebud`：Claude Code / Codex 跑任务时桌宠有反应；
      
    与第 4 条同源，事件源要自己找。

## 7.4 明确**不抄**

- **Open-LLM-VTuber 整体**：Python 服务端 + WebSocket + 浏览器前端，我们是单进程 Electron，
    
  照搬等于换项目（单点代码照抄，架构不抄）。
- **Silero VAD / RealtimeSTT**：神经 VAD 与常驻 STT；我们是按住说话 + 双条件能量判据，够用且零依赖。
- **重型本地 TTS**（GPT-SoVITS / CosyVoice / fish-speech）：体积与显存都不合适，我们已有 WinRT + 系统音色。
- **porcupine**：唤醒词要 access key + 商业授权。
- **长期记忆 / 向量库**（Ombre-Brain、kiwi-mem、Serein…）：我们场景是桌宠闲聊，6 条历史够用；
    
  真要做也该是「Markdown + 遗忘曲线」的极简版，不是这些工程。
- **只抄 star 数的项目**：`NyaDeskPet`（18★）看布局即可，代码质量未验证。

## 7.5 本轮的空白（想找但没找到）

- **Electron / Node 侧读 Windows GSMTC 的现成实现**：仍然没有（第 6 轮结论不变；
    
  `awesome-ai-companion` 的 Perception 一节全是 Python / MCP 侧）。
- **桌面宠物的「参数级情绪插值」**：仍无同类。别人的路线是 expression 名映射、
    
  4 维连续模型（Nexus）或让 LLM 直接给表情标签（Desktop-pet）。
- **纹理 LOD**：本轮再搜仍无命中，依然是我们独创。

## 附：本轮抓下的证据

```
olv/tts_manager.py              并行合成 + 序号重排投递          ★
olv/single_conversation.py      对话回合编排（打断 / 历史写入）
olv/basic_memory_agent.py       记忆：被打断只记听到的部分        ★
olv/sentence_divider.py         pysbd + 缩写表 + 多语言分句（608 行）
olv/web-audio-manager.ts        打断时释放 WavFileHandler        ★
olv/proactive_speak_prompt.txt  主动搭话提示词（全文一句话）
astrbot/gating_feature.py       准入判据 + RESCHEDULE / STOP      ★
astrbot/scheduler_service.py    随机间隔调度 + 未回复上限（792 行）
astrbot/_conf_schema.json       免打扰 / 间隔 / 上限的默认参数     ★
```

# 第 8 轮 · 参数级情绪插值定向调研（2026-10-15）

背景：第 6/7 轮把这个主题列为空白（同类桌宠工程里没有参数级情绪插值的实现）。本轮按用户要求
  
扩大到搜索引擎（谷歌/必应通用检索）+ 官方 SDK 源码 + 学术文献，专门挖这一个主题。
  
**结论：找到了参照物——但不是"同类实现"（逐字段错峰插值依然是我们独创），而是三个层面的外围证据：
  
官方 SDK 的表情淡变体系、VTube Studio 的参数仲裁原则、学术上的情绪衰减模型。其中「情绪衰减回中性」
  
是我们真正缺的东西。**

⚠️ 本轮再次踩到伪造镜像站：搜索结果里出现 `github.es` / `github.org` / `forge.dotclear.watch`
  
（与 `github.com` 一字之差的假站，内容是抄的）。核实一律以 `api.github.com` / 官方域名为准。
  
另有两个中文站（live2d.net.cn、gitcode 博客）和 johal.in 是 **AI 内容农场**：文风整齐、
  
编造统计（"2025 itch.io analytics"）、假专家引言。它们描述的 `setFadeInTime` / 混合模式确实与
  
SDK 一致（抄官方文档），但**引用只引官方源码与文档本体，不引农场**。

## 8.1 官方 Cubism SDK 的表情体系（真实源码，已抓下）

证据：`Live2D/CubismWebFramework`（develop 分支）`src/motion/cubismexpressionmotion.ts`
  
（已存 `.research-tmp/refs/cubism-expression-motion.ts`，366 行）。

- 表情 = `exp3.json` 里的一组 `(参数ID, 值, 混合模式)`；三种混合模式 **Add / Multiply / Overwrite**，
    
  非法值回落 Add（官方注释原话："以加算模式复原"）。
- `FadeInTime` / `FadeOutTime` 默认 **1.0s**；🔴 **每个表情只有一个 fade 权重**——表情内所有参数
    
  **同速率**淡变。对照我们：16 字段**逐字段错峰速度**（眉9→眼7→呆毛5→嘴4.5→脸红2.8→头3.2→肩2.6→身2.2，
    
  见 params.js）官方没有这个粒度，"错峰"依然是我们独创。
- Cubism 5 起**多表情并发**（Cubism 5 R1 把权重从 Motion 挪进 `CubismExpressionMotionManager`）：
    
  逐参数维护 additive / multiply / overwrite 三个累积值，新表情加入时按 fadeWeight 线性插值
    
  （`source*(1-w) + dest*w`，`calculateValue()`，源码 316-322 行）。
- **官方的"回落"做在混合层**：当前表情没引用到的参数，也按 fadeWeight 渐变回默认值
    
  （Add 回 0、Multiply 回 1、Overwrite 回当前值；源码 153-179 行）。
- 与我们的关系：我们**没用** SDK 表情系统——`applyEmotion()` 每帧独占直写 16 字段（规矩 31），
    
  两层互不干扰。**混合模式（Add 相对中性值）不建议学**：规矩 31 决定了 motion 与情绪不同通道，
    
  绝对写法更简单、verify 更好断言。

## 8.2 VTube Studio 的参数仲裁（DenchiSoft 官方 wiki）

证据：`DenchiSoft/VTubeStudio` wiki「Interaction between Animations, Tracking, Physics, etc.」。

- 每个 Live2D 参数同一时刻只能归一个"值提供者"，六个优先级：
    
  **P0 默认值 → P1 待机动画 → P2 面捕 → P3 一次性动画 → P4 表情 → P5 物理**，高者赢；
    
  高优先级结束后控制权交还次高者。
- 🔴 原则性的一条（wiki 原话）："当参数的控制权在提供者之间交接时，**永远平滑淡变，绝不瞬间设置**，
    
  防止难看的跳变。"——与我们规矩 28③（`updateGaze` 在前 `applyEmotion` 在后）和规矩 31
    
  （applyEmotion 每帧独占，motion 不得同通道）是同款原则。工业级实现也是这么做的，交叉验证成立。
- 表情参数的 Add/Multiply 可叠加：两个 0.5 倍率 → 复合 0.25；**乘法先算、加法后算**。
- `vtube-studio-controller`（npm）有 `resetToNeutral(fadeTime)`——**带淡变时间的归零**，
    
  又一个"表情要回落、且回落要插值"的工程佐证。

## 8.3 学术侧：情绪衰减模型（本轮真正值钱的发现）

证据：Picard《Affective Computing》(1997)；TRIPLE ECA（ResearchGate）；EMIA（J. Intelligent Systems, 2015）；
  
SAGE 多智能体风险行为仿真；CSDN Fay × Live2D 集成实践。


- **Picard 衰减函数**：`Intensity(em, t) = Intensity(em, t₀) · e^(−b·t)`——情绪**不会**因为触发事件
    
  消失就消失，而是随时间**指数衰减**；b 为衰减率。TRIPLE、EMIA、多智能体论文全部引用它。
    
  EMIA 的离散形式：`EIₜ = EIₜ₋₁ · exp(−0.1 · d(e) · t)`。
- **正负情绪谁衰减快，学界有分歧**（EMIA 原文明说 unresolved）：多数观点 + Velasquez 调查
    
  = **正面情绪衰减快、负面情绪衰减慢**（忧伤挂脸比高兴挂脸更常见、也更容易读成"她在闹情绪"）。
    
  我们若做，取多数观点即可，但别当科学定论写死。
- 衰减率可挂人格（OCEAN 大五）：外向者正面情绪衰减更慢；神经质者负面情绪更缠——两篇论文方向
    
  还不一致，这一层只适合当**可调风味**。
- EMIA 还区分**情绪（秒~分钟级，指数衰减）与心境 mood（缓慢线性回归中性）**，情绪以约 10% 的
    
  势能喂给心境——两层结构，心境决定后续情绪的触发阈值（心情差时更容易不开心）。
- **我们现状的缺口**：`[emo:xxx]` 设定后目标**永远保持**，直到下一个标签进来——高兴会高兴一整晚。
    
  缺的正是衰减层。
- 工程侧同款佐证：Fay 集成文的「回落机制」——情绪表情保留 3~5s 后逐步回中性，**回中性同样要
    
  插值，不能硬切**（与我们插值层无缝衔接）。

## 8.4 落地建议

| 优先级  | 条目                   | 判断                                                                                                                                                                     |
| ---- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ⭐ 主推 | **情绪衰减回中性**          | 安定（`emoSteadyMs` 达标）后开始按 Picard 曲线向 calm 衰减，逐字段走既有插值；衰减率按情绪效价查表（正快负慢）。改动集中 params.js/pet.js，`emotion.decay` 开关 + verify 喂假时钟。同时让 proactive 的按情绪挑话术更可信（不会永远基于 8 小时前的情绪） |
| 备选 A | mood 心境层             | 情绪喂心境、心境影响触发阈值。等衰减层跑稳看效果，**先不做**                                                                                                                                       |
| 备选 B | 复合情绪混合（happy+sad 并存） | 官方 Cubism 5 / VTS 都支持，但我们 8 情绪是单选语义、LLM 打标签也只打一个，**不建议**                                                                                                               |

## 附：本轮证据路径

```
.research-tmp/refs/cubism-expression-motion.ts   官方表情运动源码（366 行，API 抓取）★
Live2D/CubismWebFramework@develop               src/motion/cubismexpressionmotion(.manager).ts
DenchiSoft/VTubeStudio wiki                      Interaction-between-Animations...（P0-P5 仲裁）
npm: vtube-studio-controller                     resetToNeutral(fadeTime) / smoothParameterTransitionBatch
Picard 1997 / TRIPLE ECA / EMIA 2015             情绪指数衰减 + 正负衰减率 + mood 两层
CSDN blog.csdn.net/weixin_29274969/164590413     Fay×Live2D：表情回落机制 + lerp 平滑（0.2-0.3 系数）
```

# 第 9 轮 · 主动搭话策略（2026-10-15）

背景：第 6/7 轮的防复读、免打扰时段、未回复退避、媒体播放中不插话，到 v0.2.0 都已落地。
  
本轮不再重复 Nexus / Desktop-pet / Open-LLM-VTuber，专门找**还没写进闸门的「什么时候值得开口」**。
  
**结论：值得搬的是 Cyrene-Agent 的主动搭话策略（纯函数闸门 + 四个由头 + 模型可以保持沉默）。
  
Live2DPet 的窗口停留记录可以看，先不搬；它的情绪槽和第二轮选表情与我们的参数级方案冲突。**

## 9.0 方法

- 仍走 **GitHub 官方 API**（`search/repositories` + `git/trees` + `contents` base64）。
    
  `raw.githubusercontent.com` 本机多次超时（情绪系统那份 300s 超时），改走 contents API 才拿到全文。
- ⚠️ `Playa-0v0/Cyrene-Agent` 已改名，API 回 **301**，真实仓库是 **`Playa-Cyrene/Cyrene-Agent`**
    
  （705★，2026-10-14 仍在推）。搜索引擎上的旧地址会指到改名前的链接。
- 证据在 `.research-tmp/refs/round9/`（已 gitignore）。

## 9.1 候选

| 项目                          | ★   | 推送         | 对口的位置                                                                                     | 结论                                                                  |
| --------------------------- | --- | ---------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Playa-Cyrene/Cyrene-Agent` | 705 | 2026-10-14 | `src/main/proactive/proactive-policy.ts` + `proactive-trigger.ts` + `proactive-prompt.ts` | ★ 本轮主参照。Electron + pixi-live2d-display，体量是整套 Agent，**只借主动搭话这三份纯函数** |
| `x380kkm/Live2DPet`         | 87  | 2026-06-22 | `emotion-system.js` / `audio-state-machine.js` / `enhance/memory-tracker.js`              | 窗口停留可参考；情绪槽与预制音频不搬                                                  |
| `Tacky7788/Project-elino`   | 8   | 2026-03    | `memory-vector.cjs` 等                                                                     | 向量记忆，第 7 轮已判定过重                                                     |
| `gameswu/NyaDeskPet`        | 18  | 2026-02    | Agent 插件                                                                                  | 第 7 轮已看过布局，本轮无新的可搬单点                                                |

同一次 `live2d desktop pet electron` 搜索（按更新排序，33 条）里其余仓库 star 为 0–9，未逐份读源码。

## 9.2 代码级可借鉴：Cyrene 主动搭话 ★

我们现在的搭话（`pet.js` `proactiveBlockedBy`）：闲置够久 + 情绪安定 + `quietHours` **23–8 整段闭嘴**

- 连续不理就停 + 媒体在播就延后。Cyrene 把「值不值得开口」拆成闸门和由头两层，都是纯函数。

### ① 闸门 `canStartProactiveGeneration`（`proactive-policy.ts`）

返回 `{ allowed, reason }`，调用方决定重试还是丢掉。我们缺、且**零新依赖**的几条：

| reason                                                                 | 判据                                                                    | 和我们的差别                                          |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `screen_locked`                                                        | 锁屏                                                                    | 我们没有。Electron `powerMonitor` 的 `lock-screen` 即可 |
| `normal_quiet_period`                                                  | 正常对话结束后 **30 分钟**内不再主动开口（`NORMAL_QUIET_MS`）                           | 我们聊完仍按闲置分钟计，可能刚说完又来一句                           |
| `global_cooldown`                                                      | 两次主动之间至少 **2 小时**                                                     | 我们被闸门拦住是 2 秒重试；开口成功后主要靠闲置周期和未回复上限               |
| `night_inactive`                                                       | 22 点–8 点 **且** 闲置 ≥ 60 秒才闭嘴                                           | 我们是整段硬闭嘴。人还在键盘前时，他们允许一句轻声关心                     |
| `unanswered_limit`                                                     | 连续未回复 ≥ 2 直接停                                                         | 我们已有同类上限                                        |
| `followup_cooldown` / `followup_same_scene` / `followup_score_too_low` | 第一次没人理：再等 **6 小时**、必须换由头、评分 ≥ 85，才允许最后一次                              | 我们是「到上限就停」，没有「换个由头再试一次」                         |
| `stale_epoch`                                                          | 生成途中用户开口 → `proactiveEpoch += 1`，晚到的那句丢掉（`canCommitProactiveMessage`） | 我们没有「在途主动句作废」                                   |

`markUserActivity` 会把 `unansweredCount` 清零并推进 epoch，对得上我们的 `noteUserResponse()`。

### ② 由头 `proactive-trigger.ts`（60 秒扫一次，启动后先等 90 秒）

四个场景，各有冷却，评分低于 60 直接扔掉：

| sceneId            | 窗口 / 事件                                   | 基础分 | 冷却    |
| ------------------ | ----------------------------------------- | --- | ----- |
| `morning_greeting` | 7:00–10:30，离窗心越近分越高（`timeWindowFit` 0–15） | 52  | 23 小时 |
| `evening_checkin`  | 18:00–22:00                               | 44  | 8 小时  |
| `back_from_away`   | 上一拍闲置 ≥ 30 分钟，这一拍闲置 < 60 秒（人回来了）          | 68  | 4 小时  |
| `work_break`       | 连续活跃 ≥ 90 分钟（闲置 ≥ 60 秒就清掉这段计时）            | 56  | 3 小时  |

评分：`基础分 + 时间窗贴合 + 事件紧迫 + 沉默奖励(0–12) + 未回复惩罚(0 / −18 / −100)`，夹到 0–100。
  
`back_from_away` 的紧迫度 = 离开分钟数（封顶 20）；`work_break` 从 90 分钟起每多 30 分钟 +4（封顶 20）。
  
同优先级时按定义顺序稳定排序，`back_from_away` 的 priority 最高。

天气三个 sceneId（`weather_rain` / `weather_temperature_drop` / `weather_sunny`）只是占位，`getWeatherContext` 为空就不生成。**先不要接天气。**

`work_break` 只看「连续活跃多久」，不读窗口标题。这比 Live2DPet 的标题累计更适合我们的打扰尺度，
  
也能接到已有的 `powerMonitor.getSystemIdleTime()`。

### ③ 模型可以闭嘴（`proactive-prompt.ts`）

系统提示写死：没有自然的话就返回 silent；不要声称看过屏幕、检测过键鼠、调用过工具。
  
深夜仍在使用时另加一段：可以轻轻关心休息，不要说教，不要每次都提睡觉。
  
第一次未回复的跟进另加一段：不要责怪、催促、卖惨，也不要重复「在吗」。

模型只能返回两种 JSON（无 markdown）：

```json
{"decision":"send","text":"一句自然的话"}
{"decision":"silent","text":""}
```

`parseProactiveDecision`：非法 JSON、形状不对、空文本、超过 500 字 → `{ kind: "invalid" }`，调用方丢掉。
  
主动话和普通聊天**分两段历史**写进提示（各最多 16 条，带时间戳），避免自说自话污染主会话。

落地时闸门仍放 `proactiveBlockedBy()`，由头与评分做成纯函数，verify 喂假时钟（同 `verify-quiet-hours` / `verify-emotion-decay`）。
  
提示词里的「不许说破」补到现有 `PROACTIVE_MOOD_HINT`。

## 9.3 Live2DPet：可看、先不搬

证据：`x380kkm/Live2DPet` `main` 分支，contents API 抓下。

- **`enhance/memory-tracker.js`**：前台窗口标题按秒累计，5 分钟刷一次；每个标题留 `totalSec / lastSeen / dayCount / recentDays`，`recentDays` 只留 7 天，30 天没见过的标题整份删掉。这是「你在某个窗口停了多久」的轻量记法。窗口标题经常带文档名和聊天对象，**默认不该进提示词**。要做「写代码写了很久」优先用上一节的 `work_break`（不看标题）。
- **`emotion-system.js`**：情绪值每秒往上涨，悬停再加一半速率，满 100 才播一次表情/动作，时长 3–5 秒后回落；回复文本会再打**一次**模型，从模型自带的表情名里挑。和我们的 `[emo:]`、16 字段错峰、Picard 衰减回 calm 是两条路，换过去会拆掉规矩 28/31。
- **`audio-state-machine.js`**：偏好模式 `tts → default-audio → silent`，合成不可用就播预制短音频。我们 WinRT 失败已经逐句退回系统语音（规矩 33），中间不必再加一套素材。
- **`prompt-builder.js`**：`{{petName}}` / `{{userIdentity}}` 模板替换。我们的名字和人设已经走 `resolveName` / `resolvePersona`。
- 同仓库还有定时截屏 + VLM 关键帧（`screen-capture.js` / `vlm-extractor.js`）。和「桌宠闲聊」的范围不合，**不搬**。

## 9.4 明确不搬

- **Cyrene 整体**（2765 个文件：DMAE 记忆、QQ/微信/飞书投递、工具沙箱、Obsidian 同步）。只借 `src/main/proactive/` 这三份。
- **向量记忆**（elino 的 `memory-vector.cjs`，Cyrene 的 memory 目录）。第 7 轮结论不变。
- **第二轮 LLM 选表情名**、**情绪槽涨满再播 5 秒**、**预制语音片段**、**截屏 / VLM**。
- **天气主动搭话**：Cyrene 自己也还是空函数。

## 9.5 本轮空白

- Electron / Node 侧读 Windows GSMTC 的现成实现：本轮没再找到，第 6/7 轮结论不变。
- 参数级错峰插值：本轮对照的两家仍是表情名 / 动作名，第 8 轮结论不变。

## 附：本轮证据路径

```
.research-tmp/refs/round9/cyrene-proactive-policy.ts    闸门 + epoch + 未回复跟进   ★
.research-tmp/refs/round9/cyrene-proactive-trigger.ts   四场景评分与冷却            ★
.research-tmp/refs/round9/cyrene-proactive-prompt.ts    send/silent JSON + 不许说破 ★
.research-tmp/refs/round9/live2d-emotion.js             情绪槽 + 第二轮选表情（反面）
.research-tmp/refs/round9/live2d-audio-sm.js            tts → 预制音频 → 静音
.research-tmp/refs/round9/live2d-memory.js              窗口标题停留秒数
.research-tmp/refs/round9/live2d-prompt-builder.js      模板变量人设
Playa-Cyrene/Cyrene-Agent@master  src/main/proactive/{proactive-policy,proactive-trigger,proactive-prompt}.ts
x380kkm/Live2DPet@main            src/core/{emotion-system,audio-state-machine,prompt-builder}.js
                                  src/core/enhance/memory-tracker.js
```

# 第 10 轮 · 自家 3D 版对照（2026-10-15）

背景：用户问 `E:/UnityProjects` 里有什么可借鉴的。那里是**同一产品的 3D 版**
  
（`ayan-3d`，Unity 2022.3 + VRM）及其 M1–M6 构建验证基建 —— 不是第三方项目，
  
是自家的另一半，而且它把 2D 版下一步要走的路提前趟了一截。

## 10.1 四块积木（`Assets/Scripts/Runtime/`，全部 2026-10-15 新写）

| 文件                   | 行数   | 内容                                                                                                                                        | 与 2D 版的关系                                                                                                                             |
| -------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `PetMood.cs`         | 890  | **四条漂移轴**（能量 / 社交渴望 / 效价 / 困倦），每分钟速率表，越阈值才触发表情；只调制呼吸/摇摆幅度，**绝不写姿势通道、永不碰 blink 键**                                                         | 就是 2D 第 8 轮「备选 A mood 心境层」的完整设计+实现。量纲坑已标：参考实现是 0–100 尺度，归一到 [0,1] 后常数**不能照抄**（差 100 倍）                                                |
| `PetRelationship.cs` | ~400 | 好感轴：边际递减 + 最小可见增量 + 日涨幅上限 + 慢衰减 + MaxTierReached 永不回退                                                                                     | 2D 完全没有。设计出处四份真实源码（VPet `Likability` / Nexus `relationshipTracker` / dg-man / Mochi），取舍逐条注明                                           |
| `PetRhythm.cs`       | ~300 | 24 小时活跃槽学习（学作息，接替静态 quietHours）                                                                                                           | 🔴 参考实现（Nexus `rhythmLearner.ts`）逮到**真 bug**：周衰减分支写在 `elapsed < 7 天` 早退之后几乎不可达，实际是"隔周整份重置"；照抄前必须修。陈旧重置还把 Total 一起清零（Nexus 保留 → 全天假活跃） |
| `PetFocusSensor.cs`  | ~300 | 全屏/游戏静默：**SHQueryUserNotificationState 先问系统**（QUNS_BUSY=2 / D3D=3 / PRESENTATION_MODE=4 / NOT_PRESENT=1）、矩形兜底、rcMonitor 口径、进入零延迟/退出 4s 迟滞 | 直接回答 2D 的「Win11 XAML 岛误判全屏」待观察项（见 10.3）                                                                                               |

共同戒律（对 2D 移植友好）：**纯逻辑、零时钟（时间由调用方注入）、自带持久化清洗** ——
  
意味着从 C# 移植到 2D 版的 JS 几乎是直译，不碰 Unity API。

## 10.2 状态与验证方法论

- **PetMood 已接入** 3D 主循环（AyanRuntime 调制点）；其余三块是"积木"，等 M6-C 验证落地再接线。
- M6-C 验证当前 **INCOMPLETE**（19 条声明全部"证据不足"，多臂探针未跑完）——3D 版自己也还没验收。
- 值得偷师：**验证侧独立写解析解**（`merge_m6c.py` 的 `offline_integrate` 与生产代码不是同一份实现），
    
  生产代码悄悄改了漂移常量而没人动设计文档时会立刻炸出来。
- 好感轴设计共识（四个参考同时指向）：**永不惩罚性状态**（Petz 1997 式"离家出走"被
    
  2026 年的三个项目同时否定）；解锁过的表现力不收回（Mochi）；衰减要慢（Nexus 形状 × 1/5）。

## 10.3 已落地到 2D 版：fullscreen.js 的 QUNS + explorer 排除

照 PetFocusSensor 的论证给 `live2d-pet/src/main/fullscreen.js` 补了两道矩形之外的证据：

- **采样**：常驻 PS 脚本加 `SHQueryUserNotificationState`（sample 新增 `q`）+ 前台进程名（`n`）。
- **判定**：`q∈{2,3,4}` → 直接全屏（矩形量不到的演示模式/DPI 错位也兜得住）；`q==1`（锁屏/屏保）
    
  → 明确不算（why 标 `quns:not-present`，将来锁屏闸门可吃）；其余态度矩形才有发言权
    
  （无边框窗口游戏和全屏 UWP 的 QUNS 不保证 BUSY，**矩形兜底不能撤**）。
- **explorer.exe 宿主一票否决**：Win11 的任务栏/小组件/开始菜单宿主都是 explorer 里的
    
  XAML 岛窗口，矩形能盖满整屏（实测误判过全屏）；但 explorer 进程永远不可能是全屏应用 ——
    
  按进程名排除比猜类名稳。类名排除表同时补了 `XamlExplorerHostIslandWindow`。
- 排除顺序锁死：self / shell 类 在 QUNS 与 explorer 判定**之前**（输入自相矛盾时宁可漏判，
    
  死锁豁口不许重开）。回归 `debug/verify-quiet.js` 新增 1b 节（18 项断言）。

## 10.4 对 2D 版的移植路线（未做，按优先级）

1. **mood 层落地时直接拿 PetMood 当蓝本**：速率表、阈值、三条边界（只调制不写姿势通道 /
     
   永不碰 blink / 开关语义不变）+ 量纲换算的教训。等 3D 的 M6-C 验证报告出来再动手。
2. **第 9 轮第一档的「锁屏闸门」**：`quns:not-present` 已在样本里，接 `proactiveBlockedBy` 即可。
3. **PetRhythm 学习作息**：先在 3D 版验证周衰减修复后的行为，2D 版照抄修过的版本。
4. **PetRelationship 好感轴**：2D 版要不要做是新决策；设计文档已现成（含四份出处的取舍理由）。

## 10.5 不搬的

- TransparentWindow / WindowHitTest / NativeContextMenu 等 Unity 侧窗口功夫 ——
    
  2D 版 Electron 自己的方案已验证过，且两边窗口体系不同（D3D vs Chromium 合成器）。
- 3D 版的验证基建（m6-tools 探针群）—— 思路可学（独立解析解），工具本身绑 Unity 工程。

## 附：本轮证据路径

```
E:/UnityProjects/ayan-3d/Assets/Scripts/Runtime/{PetMood,PetRelationship,PetRhythm,PetFocusSensor}.cs ★
E:/UnityProjects/m6-run/_dryrun/M6-C-验证汇总.md                      19 条声明全 INCOMPLETE 的现场
E:/UnityProjects/ayan-3d/README.md                                   Library 死锁坑（工程不能搬回工作区）
2D 版同日落地：src/main/fullscreen.js（QUNS + explorer 排除）+ debug/verify-quiet.js 1b 节
```


---

# 第 11 轮：sjmsltx/deepseek-desktop-pet + dsh-pet 族（2026-10-22）

四个候选来源逐一实测（GitHub 走官方 API 拉 README/文档原文，文章抓正文）：
  
sjmsltx/deepseek-desktop-pet（高价值）· CSDN dsh-whale-pet（一个点子）·
  
nanonocturne-altago/DeepSeek-Pet（低）· 知乎 dsh-pet 介绍文（低）。

## 11.1 sjmsltx/deepseek-desktop-pet（PySide6 + DeepSeek，MIT，活跃）

定位：Windows 桌面 AI 陪伴助手——双角色（Flash/Pro）、长期记忆、工具调用、
  
主动关心、好感度进度、15 个小游戏、86 设计令牌主题系统、双语 UI。
  
**与本项目的功能重叠度是历轮最高的**，值得逐块对照。

### A. `docs/live2d_pipeline.md` —— 直接命中自制模型计划（docs/custom-model-plan.md）

他们"画图 → Live2D"的完整流程，与我们方案交叉验证出四个判断：

1. **绑定无法全自动**：他们纯手工在 Cubism Editor 绑一个简单半身模型 1~2 小时；
     
   我们走 psd2live 自动绑定 + 人工精修，路线互补互证。
2. **Seedream 生图提示词模板可抄**：赛璐璐风格 / 纯白背景 / 边缘干净利落 /
     
   正脸微侧 / "close-up portrait, upper body" 兜底话术 —— 比我们委托书里的
     
   描述更具体，直接进自制模型的生图/委托环节。
3. 🔴 **反向警告：脸占比 ≥40% 才适合 Live2D** —— 他们明确写"全身 Q 版不适合，
     
   脸太小绑定后动画效果差"。与桌宠"全身+走路"需求天然冲突。
     
   解法 = hiyori/Miara 式**真人比例全身**（脸小但有腿）。
     
   → 委托书必须写"真人比例、不要二头身"，否则情绪系统的脸没得做。
4. **廉价兜底路线**：多帧表情立绘（闭眼/张嘴/侧脸各一张）+ 程序化局部替换轮播，
     
   零建模成本 —— 自制模型的降级方案，候选记录。

### B. 长期记忆架构（我们真实的功能缺口）

BM25 检索 + 自动事实抽取 + LLM 重排序三段式。现状：我们只有
  
chat-history.json 平铺，量大了迟早塞不下上下文。**列为 mood 层之后的排期候选**。

### C. 好感度系统 + 双角色不同人格

对应我们 Miara 第二角色 + 3D 版 PetRelationship 积木，实现细节可对照
  
（好感进度面板、随好感递减的重聚增幅——3D 版 M6-D 已有同款）。

### D. 工具调用（天气/待办/PowerShell/MCP/插件系统）

方向参考，**暂不跟进**——范围爆炸，且与本产品"陪伴优先"的定位有张力。

## 11.2 dsh-whale-pet（CSDN 文，DSH 插件）—— 一个点子

**事件驱动的工作状态感知**：监听宿主 turn/start / tool/call / todo/write /
  
approval/asked 事件，任务完成 → 跳跃+纸屑+琶音+语音庆祝；出错 → 安慰；
  
等审批 → 提示。我们有媒体感知（在放视频闭嘴）但**没有正向工作事件反应**。
  
"你跑测试全绿了她替你高兴"—— 与 mood 层很配的交互层，候选记录。
  
技术点：edge-tts 构建期预合成 49 条台词内嵌（离线播放、不怕沙箱 TTS 哑）。

## 11.3 dsh-pet 族（GitHub 两个 + 知乎文）—— 不采用

路线是**预渲染 webm 动画链**（AI 生成绿幕视频 → 抠像 → 透明 webm →
  
概率切换播放），不是程序化参数驱动。漫游/贴边/拖拽/打断保护我们全有且更细
  
（代际令牌/摸头 A-B-C/错峰插值）。余额记账/汉堡菜单/Safari HEVC 兼容是
  
DSH 宿主特有。97 套动画的 AI 提示词库开源是其真正亮点，但路线不同不搬。

## 11.4 结论与排期影响

- 追加到排期候选：**长期记忆三段式**（mood 层之后）、**工作事件正向反应**（配 mood 层）。
- 委托书补一条：**真人比例、不要二头身**（教训源见 11.1-A3）。
- 工具调用/小游戏/主题系统：不跟进。

## 11.5 worm128/AI-YinMei（1027★，Python，BSD-2）—— 低，一个设计点

定位是一站式 AI 直播平台（弹幕聚合/抽奖/积分/NSFW），桌宠只是九个输入渠道之一；
  
Live2D 走 VTube Studio 外部应用，非内嵌 runtime。**完整版闭源**（意图分析/声纹/
  
扩散思维都在 3.0-Pre 闭源版，开源版 1.8.1 无后台），私域运营型项目，代码不搬。

宣称卖点逐个验证：

- **AEC+VAD+声纹防自触发** → 查证：我们已覆盖（recorder.js:88 `echoCancellation:
  true, noiseSuppression: true`；VAD 只在松手判底噪、无连续监听，自触发面小）。无需动。
- 关键字触发表情 → 我们 [emo:] 标签直控 16 参数，更深，不搬。
- 意图+情感本地 10ms 分类（多头注意力自训）→ 对我们过度设计，不搬。
- LLM 工具控制人物移动/旋转 → 范围爆炸，不跟进。

**唯一记走的点**：长期记忆的「时间代词唤醒」——根据"上次/昨天/上周"等时间
  
代词选择唤醒哪个时间范围的记忆，且选择性唤醒（不每次全量召回、不拖慢主流程）。
  
并入 11.4 的长期记忆候选项（BM25 三段式 + 时间代词路由）。

## 11.6 PC2005-cloud/dsh-pet 原版（3339★，TypeScript，MIT，日更）—— 🟡 中高，一个功能候选 + 两个小点

之前 11.3 从知乎文判它"预渲染动画链、路线不同"，看了原版 README 全貌后**上调**：
  
它是三件套（提示词配方 → 素材生成链 → 插件），工程完成度和活跃度远超同族整合版。
  
动画链路线依然不搬（我们程序化参数驱动更深），但有几样真东西：

### A. 甩抛物理（throw physics）—— 我们的真实功能空白 🔴

拖拽过阻尼弹簧跟手 → 甩出即抛物线飞行 → 屏幕边缘反弹 → 落地摩擦停稳 + Q 弹。
  
**我们现状**：拖→松手→贴边（motion.js onUserDragEnd 只做状态收尾，无速度概念）。
  
已查证：代码里没有 throw/velocity/bounce/spring 任何一处。
  
他们的实现是**纯函数物理与挤压曲线**（`src/shared/physics.ts`，MIT），两端
  
（浏览器/桌面）共用——与我们"纯逻辑可单测"的戒律同款，**可移植**。
  
⚠️ 移植时要过的关：① 规矩 6（自动移动不许落盘窗口位置/须 cancelMoveAnim）；
  
② 与贴边 snapGuard 的先后关系；③ 全屏静默期间甩抛要不要拦。
  
列为功能候选（排在 mood 层之后的交互层）。

### B. 两个小点

- **点击 Q 弹挤压（squash & stretch）**：点击回应 + 落地 Q 弹共用一条挤压曲线。
    
  Live2D 侧可用模型 scale 变换做，是廉价的"juice"。候选记录。
- **`prefers-reduced-motion` 无障碍**：减少动效时跳过 Q 弹与淡入。一行开关的事，
    
  值得抄。候选记录。

### C. 看过但不搬的

- **对外 HTTP/Cordis API**（别的插件驱动桌宠/读状态）：扩展性模式好看，但我们
    
  是单机应用没有插件生态，无消费方。
- **多开同屏 + pet pack 换种类**：与"单角色陪伴"产品定位相反。
- **档位候选数组轮换避免连播同段**：聊天侧已有复读护栏（规矩 29），动画侧
    
  keepLoopGroups 已覆盖核心场景。
- **素材生成链**（豆包生成绿幕视频 → HSV/PR 抠像 → 透明 webm）：自制模型
    
  计划的"多帧立绘廉价兜底"对应物，已在 11.1-A4 记录，路线一致不重复记。

## 11.7 LYiHub/pub-local-jarvis（518★，Python+C+++Electron，MIT）—— 🟡 低-中，方向标记

定位：**本地多模态持续感知**桌宠——MiniCPM-o 4.5 GGUF（LLM+视觉+音频），
  
约每秒一帧画面 + 最近一秒系统音频，模型持续在 `LISTEN`（继续观察）与
  
`SPEAK`（输出一句**有画面/声音依据**的短评）之间做选择。Electron 前端 +
  
FastAPI 后端 + C++20 原生采集（DXGI/WASAPI）。

代码不搬（本地 VLM 持续推理与我们的轻量理念相反，栈差三个语言），但作为
  
**环境感知型主动搭话的方向标记**，四条纪律值得记：

1. **「有证据才开口」**：主动文本必须有当前画面或声音依据，不说没话找话的
     
   话——我们的 proactive 已注入媒体状态，可在人设里补这条纪律（不说
     
   "需要我帮你……"这类超出能力边界的话术，他们明文禁了）。
2. **时机由模型/证据决定，不是定时器**：我们现在是 idle 定时器 + 四闸门 +
     
   媒体感知；他们是无定时器、模型自己等"真正需要介入"的时刻。若未来加
     
   屏幕感知，这是成熟范式。
3. **去重 + 场景稳定判定**：不因短暂画面变化反复切换模式、频繁弹出——
     
   对照我们的复读护栏（规矩 29）：聊天侧已有，"环境状态抖动"维度暂无感知源。
4. **双上下文隔离**：结构化感知（场景/课程/记忆）与全双工对话各自独立上下文，
     
   主动气泡与用户对话框不混流——与我们 proactive hint 注入位置的设计可对照。

另：隐私模式（双击暂停感知）符合我们规矩 24 的精神，将来若加感知类功能照此办理。

## 11.8 SlimeBoyOwO/LingChat（2384★，Rust，日更）—— 🟡 中，点子多但 🔴 AGPL 不能碰代码

定位：AI-Galgame 沉浸式聊天软件（带桌宠/日程/剧情模块）。功能密度很高，
  
与我们愿景重叠面大：永久记忆独立存档、情绪识别、视觉感受主动关心、
  
服装切换、摸摸互动、表情随情绪、多角色羁绊、番茄钟提醒。

**🔴 License = AGPL-3.0（传染）**：一行代码都不能搬进我们项目（MIT 不兼容
  
AGPL），只能记设计点。他们自训的 18 种短句情绪模型（Emotion-Model-Trainer）
  
也是独立仓库，同样先查 license 再看。

值得记的四个点：

1. **「主动窥屏」走云 VLM 而非本地**：通义千问视觉 API（默认赠额对本项目
     
   够用），聊天里说"看桌面"触发；配了主动对话后 AI 有主动观察能力。
     
   与 11.7 jarvis（本地 MiniCPM 持续感知）构成同一方向的两条实现路径：
     
   **云 VLM 按需看（便宜、省资源）vs 本地 VLM 持续看（隐私、零成本）**。
     
   若我们做环境感知，按需云 VLM 与轻量理念更合。
2. **情绪识别用独立小模型**（18 类短句分类，自训）：对照我们的 [emo:] 标签
     
   方案——LLM 顺带出标签零成本，独立模型更快更稳但要维护。**不换**，
     
   但"LLM 标签失灵时的兜底分类器"是备选思路。
3. **每个存档独立永久记忆**：不同对话风格各自一套记忆——对应我们未来
     
   多角色（hiyori/Miara）各自的 chat-history，**存档按角色分文件**这点
     
   做多角色时要照办。
4. **服装切换**：对应 PartOpacity 换贴图/部件显隐，自制模型的增值功能点
     
   （咱们自有模型无授权限制，可以做换装 DLC —— Steam 付费点）。

## 11.9 Zao-chen/ZcChat（566★，C++/Qt，GPL-3.0）—— 🟡 低-中，多帧立绘路线的产品级实证

定位：**类 Galgame 立绘**AI 桌宠（多帧 PNG 立绘切换，非 Live2D），LLM + Letta 长期
  
记忆 + VITS 语音 + 能量阈值 VAD。GPL-3.0 传染，**代码不碰**，只记点子。

### A. 「多帧立绘」降级路线的完整产品实证（交叉验证 11.1-A4）

作者在 FAQ「为什么不使用 Live2d」里明说立绘路线的动机：**表情动作可以更多 +
  
角色制作成本更低**。配套有角色制作文档（wiki）+ 讨论区现成角色数据生态。
  
这正是 sjmsltx 11.1-A4「多帧表情立绘 + 程序化局部替换」和 dsh-pet 素材链的
  
同一方向——现在有了三份独立证据：**廉价角色路线是真实可行的产品形态**。
  
对咱们的意义不变：自制模型的降级兜底（真人比例 Live2D 为主、立绘轮播为备）。

### B. Letta（MemGPT）长期记忆 —— 第三条路径入池

长期记忆候选至此三条路径：

1. 自研三段式（BM25 检索 + 事实抽取 + LLM 重排，sjmsltx 11.1-B）
2. 时间代词路由（AI-YinMei 11.5）
3. **外挂 Letta/MemGPT**（ZcChat：开箱即用、支持纯本地部署，但引入常驻
     
   Python 服务，与轻量单机理念有张力——若选它需评估体积与延迟）

ZcChat 还宣称记忆能「发展拓展性格和个性」= 记忆回写人设，与 3D 版
  
PetRelationship 的思路同族。

### C. 其余看过不搬的

- **能量阈值 VAD + 语音唤醒/打断**：README 自述「VAD 算法较为简单、对环境
    
  要求较高」——咱们 audio.js 的 VAD + 打断链路（规矩 32）更深，不搬。
- **电脑操控接口**（提示词给 LLM 开系统权限）：范围爆炸，同 11.1-D 不跟进。
- **LLM 格式漂移 FAQ**（「对话不久后出现格式错误」）：他们靠提示词 + 命令语气
    
  硬扛；咱们 llm.js 三级清洗（规矩 29）是工程化解法，互证咱路线更稳。

## 11.10 THE-abeedoo/virtual_maid（31★，Python，2025-08 停更，自定义 license）—— ⚪ 低，无新点子

小体量个人项目：多帧图片动画（`pr/` 文件夹逐场景配置缩放/速度/循环）+ LLM 对话

- TTS + Flask Web 设置页（localhost:5000）。逐项对照后无值得记走的设计：
- 动画 = 多帧立绘路线的又一例（第四份证据，但 11.9 ZcChat 的产品级实证已足够，
    
  不重复展开）。
- **LLM 自动生成并执行 Python 代码**：范围爆炸，同 11.1-D 不跟进；且这是
    
  安全雷区（提示词注入 = 任意代码执行）。
- Flask 设置页 / Alt+D 全局快捷键 / 背景故事 JSON：咱们分别有托盘原生菜单、
    
  右键+直接输入、persona/personaParts（规矩 10），都更深。
- 停更一年多、非标准 license、无测试 —— 工程质量无可借鉴。

## 11.11 lokicorvus/crosspet（275★，C#，日更，代码 MIT/立绘 CC BY-NC-SA）—— 🟡 中-高，工作状态感知的产品级范本

定位：「跨 AI 桌宠」——跟着你正在用的 AI 换形象（Claude/GPT/DeepSeek/Gemini/GLM/Qwen
  
五角色），**AI 干什么活她就做什么动作**（多帧立绘路线）。产品完成度和细节密度
  
是本轮桌宠类里最高的，且**昨天还在提交**。

### A. 🔴 WorkBuddy 钩子情报（对本项目直接可用）

CrossPet 给 WorkBuddy 做了接入，我们拿到了**宿主自己的钩子事件全表**
  
（`integrations/workbuddy/hooks.json`，Claude Code 同款格式，写进
  
`~/.workbuddy` 的 settings.json，完全退出重启生效）：

```
UserPromptSubmit / PreToolUse / PostToolUse / PostToolUseFailure /
Notification(matcher: permission_prompt|elicitation_dialog|agent_needs_input) /
Stop / SubagentStart / SubagentStop / PreCompact
```

含义：11.2 记的「工作事件正向反应」候选**技术上零障碍**——Ayan 可以挂同款
  
钩子，把事件写本地文件/管道，主进程读到后触发表情+台词。事件表连
  
「等你回答」（Notification 三 matcher）都有，鲸鱼娘的点子在这有了完整落地路径。
  
⚠️ 注意与 CrossPet 共存问题：同一钩子事件可挂多个 hook，但装了它会多一份
  
python3 调用，文档明说钩子有 5s timeout。

### B. 状态→动作映射表（产品级完整分类学）

思考/读文件/写代码/跑命令/上网查资料/画图/派子任务/出错/完成/**等你回答**/
  
压缩上下文（往小箱子硬塞）/大活完成（一轮 ≥8 次工具 → 戴皇冠得意）。
  
外加**多对话并行**（每对话一张小卡片，干完打勾、出错变红、等回答会跳，三个
  
以上崩溃）。这张表就是工作事件反应功能的现成设计蓝图。

### C. 甩-红温状态机（与 11.6 甩抛物理互补）

按住快速左右甩 → 被甩晕 → 累进愤怒（不耐烦→鼓脸→红温冒蒸汽→背过身赌气）
  
→ 摸摸头才哄好；干活时被甩会晕着抱怨接着干，干完不庆祝直接算账。
  
dsh-pet 给的是**物理**（抛物线/反弹），这个给的是**情绪反馈**（甩的语义），
  
两者可叠加成一个完整交互。

### D. 其余记走的小件

- **六时段打招呼**（早/午/下午/晚/深夜/凌晨各一套动作台词）+ **节日换装**
    
  （8 个节日当天换装）——廉价 juice，配 mood 层。
- 全屏自动隐藏**分屏判定**（只看它所在那块屏）、**透明区域点击穿透**、
    
  显示层级「跟着 AI」（只在用 AI 时浮顶）、新版头顶「多了 N 个新功能」提示、
    
  反馈附运行状态+接入诊断（不含对话密钥）——产品细节都可对照学习。
- 双 AI 同框彩蛋（DeepSeek/GLM 互相上门捣乱）——多角色（hiyori/Miara）时代
    
  的交互灵感。
- 授权结构值得学：**代码 MIT / 立绘 CC BY-NC-SA 分离**，角色生态（讨论区
    
  现成角色数据）+ 换装皮肤做差异化。

### E. 不搬的

- 多帧立绘路线本身（38~45 张/皮肤的手绘成本，咱们 Live2D 程序化更深）。
- 「跟着 AI 换角色」产品定位（咱们是单角色陪伴，反向）。
- 额度/余额显示（碰凭据，明确不碰是对的）。

## 11.12 Zao-chen/ZcChat2（120★，C++，GPL-3.0，2026-08 更新）—— 🟡 低-中，11.9 的续作动态

ZcChat 重制版（早期开发阶段）。GPL-3.0 传染不碰代码，只记两条对候选池的更新：

### A. 长期记忆路线变化：Letta → 自研记忆压缩

1.8.1 用 Letta（11.9-B 路径③），2.0 改为**自研「记忆存储 + 压缩」**（开发进度
  
表里"长期记忆压缩机制"还是未勾选项）。作者用脚投票弃 Letta 是个信号——
  
外挂常驻服务的体积/复杂度成本在轻量桌宠场景不划算，**路径①自研轻量方案
  
的优先级可以上调**。压缩式记忆（旧对话摘要归档）与 sjmsltx 的 BM25 检索
  
可组合：近期原文 + 远期摘要双层。

### B. 轻量化成绩单：后台内存 40MB → 8MB

多帧立绘路线的内存下限证明（无 runtime、无 WebGL）。咱们 Live2D 常驻 ~657MB
  
（纹理 1024 后），是路线本质差异；对照价值：如果上 Steam，配置下限用户
  
（核显办公本）的内存占用是可以宣传的指标。

### C. 其余看过不记的

- **动画/粒子插件化 + 统一资产格式**（为手机端准备）：扩展性模式好看，
    
  但咱们模型=数据档案（profiles/）已覆盖，无插件生态需求。
- 系统级操作（给桌宠操作电脑）：同 11.1-D/11.10 安全雷区，不跟进。
- 多模态（开发中）：等它落地再说，方向与 11.7/11.8 环境感知候选重合。

## 11.13 JianguSheng/yuns-desktop-pet（141★，JS/Electron，MIT，2025-12 停更）—— 🟡 低-中，一个工程细节

同技术栈同 license（理论上能搬代码），但桌宠本体是**一张静态柴犬图片** +
  
独立对话窗——无动画、无 Live2D、无情绪系统，架构无可借鉴。多模型 10+
  
提供商接入与 MCP 工具调用是它的主体（后者同 11.1-D 不跟进）。

**记走一个工程细节**：视觉分析（一键截屏发给 VLM）功能里写了
  
「**自动隐藏窗口后截屏，确保截图干净**」——截屏前把桌宠自己的窗口藏掉，
  
否则截到的画面里带着自己的气泡/立绘。对咱们环境感知候选（11.7/11.8 记的
  
按需云 VLM 看桌面）是必做的坑位：截屏自隐藏 + 截完恢复，且期间要暂停
  
渲染层动画（或用 hide 而非 move，避免窗口位置状态被污染——规矩 6）。

## 11.14 bleeeet/TermiPet（85★，Swift/macOS，Apache-2.0，月更）—— 🟡 低-中，钩子传输架构的第三方案

macOS 终端桌宠（面向 Claude Code/终端用户）：状态卡片 + 快捷命令面板 + AI 用量
  
统计 + 宠物聊天。工作状态感知的**第三个产品级实现**（鲸鱼娘 11.2 → crosspet
  
11.11 → TermiPet），状态集与 crosspet 高度重合（思考/工具调用/等授权/压缩
  
上下文/完成）。

**记走一个架构决策**：它的 Claude Code Hook 传输走 **hook 脚本 POST 到
  
`127.0.0.1` 本地 HTTP 服务**（TermiPet 自己监听），「不需要外部服务器参与」。
  
对照 crosspet 的方案（每事件 spawn 一次 python3）。对 Ayan（Electron 主进程
  
天然能起 http.Server 或 net.Server）**回环 HTTP/管道是更合适的传输**：

- 比每事件冷启动 python 少一个进程开销与超时窗口；
- hook 侧脚本可以退化成一行 `curl -s 127.0.0.1:port -d @-`（Windows 有
    
  curl.exe，10/11 自带）——安装器只需往 settings.json 追加一条。


**安装纪律再证**：改 `~/.claude/settings.json` 前先备份 `.bak`、卸载恢复、
  
装完提示重启 claude 进程——与 crosspet「只添加不改原有配置」同款纪律，
  
咱们将来挂 WorkBuddy 钩子照此办理（11.11-A）。

其余不搬：终端识别/快捷命令面板/番茄钟（功能定位是「工作流入口」非陪伴）、
  
AI 用量统计（同 11.11-E 不碰凭据）、多语言皮肤。

## 11.15 WINDGAND/Bailin（61★，TypeScript/Electron，MIT，月更）—— 🟡 中，安全与造人两条记走

「60 秒造人，请上桌面」：完全本地开源 Windows AI 角色伴侣——**深度蒸馏造角色**
  
（6 Agent 调研 + 心智框架提炼 + 质量自检，5~8 分钟）+ 像素桌宠 + 视角型对话 +
  
本地 SQLite 记忆。产品定位「用 ta 的视角看你的问题」，非 cosplay。

### A. 🔴 DPAPI 加密 API Key —— 咱们的真实改进项（已查证）

Bailin：Key 用 **Windows DPAPI 加密、渲染进程不接触明文**。已查证咱们现状：
  
`apiKey` **明文存在 config.json**（`config.js:62`，IPC 出去才打码 `***`，
  
`main.js:2006`）——任何能读 `%APPDATA%/live2d-pet/` 的进程都能偷走。
  
修法现成：Electron `safeStorage` API（底层就是 DPAPI），落盘存
  
`encryptedString`，读时 `decryptString`，主进程解密后只在内存传给 llm.js。
  
兼容坑：换机器/重装后 DPAPI 解不开 → 需「解密失败回退明文并提示重填」路径。
  
**列入排期候选（低工作量、高价值）**。

### B. 「视角蒸馏」造人法 —— 人设工程的上层范式

不塞常用台词（「越聊越像劣质 cosplay」），蒸馏**思维骨架**：心智模型（看世界
  
的尺子）/ 决策启发式（岔路口习惯）/ 表达 DNA（节奏、标志性短语、回避话题）/
  
内在张力（矛盾与未解处）。对咱们的意义：persona/personaParts（规矩 10）之上
  
如果做「角色工坊」或 Miara 御姐人设调校，这是比台词堆砌高级的模板结构；
  
受 nuwa-skill「造人术」启发、已产品化，可对照其 starter 结构。

### C. 其余看过不记的

- 智能截图 whisper + 独立气泡窗（环境感知变体，候选池已够多：11.7/11.8/11.13）
- 本地 SQLite 记忆 + 用户画像自动学习（长期记忆候选池已三路径）
- 透明区点击穿透（11.11-D 已记）、更新引导手动下载（咱们有自动更新，更优）

## 11.16 X-T-E-R/OpenPet（57★，TypeScript/Tauri，GPL-3.0，2026-05 停更）—— 🟡 低-中，事件 API 设计第四案

定位反转的桌宠：不是「宠物+AI」，而是「**给 Agent 用的桌宠运行时**」——透明
  
置顶窗 + 可导入宠物包 + 本地控制 API，让 Codex/OpenClaw 等 agent 通过
  
CLI/MCP/HTTP 显示工作状态。GPL-3.0 不碰代码。

**记走两条**：

### A. 六事件模型 + TTL —— 工作事件反应的最精简设计

事件集：`thinking / tool-running / reviewing / success / failure / attention`
  
（attention = 等用户回应，reviewing 是四案里独有的）。**每事件带 `ttlMs`**
  
（默认 4s 自动过期）——比状态机更简单的健壮设计：agent 崩了没发"结束"事件，
  
状态也不会卡死，TTL 到了自己回 idle。对咱们将来挂钩子的事件层直接可抄
  
（hook 侧失败 = 状态卡死的兜底，对应规矩 16 的代际令牌思路的轻量版）。

### B. 传输路线三案对照完整（工作事件候选的技术选型定稿参考）

| 方案              | 实现                  | 代表             | 特点                                                      |
| --------------- | ------------------- | -------------- | ------------------------------------------------------- |
| 每事件 spawn 进程    | hook 配 python3 脚本   | crosspet 11.11 | 无常驻服务但有冷启动开销+超时窗口                                       |
| hook → 回环 HTTP  | hook POST 127.0.0.1 | TermiPet 11.14 | 零依赖 hook 侧，需桌宠常驻监听                                      |
| **直接 HTTP API** | agent/CLI 主动 POST   | **OpenPet**    | 端口 17321，`/api/event /api/say /api/action`；桌宠是被动 server |

对 Ayan：**B/C 合流**——Electron 主进程起 http.Server，hook（一行 curl）和
  
agent 直调共用同一 API；TTL 当事件语义的一部分。

其余不搬：宠物包生态（pet.json + spritesheet.webp 精灵图集 + Petdex 网站导入，
  
多帧立绘路线的标准化尝试，咱们 Live2D + profiles/ 已覆盖）、MCP bridge
  
（无插件生态需求）。

## 11.17 TopSea/Alive（94★，Tauri+Vue，已闭源，2026-04 停更）—— ⚪ 低，两条对照记录

跨平台 AI 桌宠（Tauri+Vue），**代码已闭源**（README 自述"项目代码不再开源，
  
已开源的代码不再维护"，仓库只剩 README/assets/models/docs）。无 license 声明，
  
无可搬内容。两条对照记录：

1. **「切换桌宠模型时有概率闪退」修复（v1.2.0）**——同类产品也踩过模型切换
     
   竞态（咱们的双模型 bug 嫌疑同族：底座/首启竞态）。可惜修复代码已闭源，
     
   无法对照修法；但证实**模型加载竞态是同类产品共通 bug**，不是咱们独有的
     
   实现缺陷。v1.2.0 还有"文本情绪反馈（表情动作更丰富）"，与咱们 [emo:]
     
   标签同思路。
2. **路线变化的反面印证**：v0.0.3（最后一个 Live2D 版）之后放弃 Live2D，转向
     
   原神模型（models/ 目录全是玩家提取的角色模型 zip，版权灰色），最后闭源。
     
   Live2D 生态的贫乏（商用全身模型难找）把小项目推向灰色素材 → 合规压力 →
     
   闭源，这条路径反面印证咱们**官方授权模型（hiyori/Miara）+ 合规发布**路线
     
   的稳健；也说明"自制模型计划"（custom-model-plan.md）瞄准的正是这个空档。

免责声明结构（模型不属于软件/展示效果用户自担）= 灰色路线的标准自我保护，
  
咱们不需要学。

## 11.18 MARK42IRPC/FlyingSnowVelvet-Aemeath（67★，Python/Qt，活跃，双许可）—— 🟡 低，分类存档

**离线优先**多功能 AI 桌宠（`LTS1.0.7pre7`，2026-10 活跃）：事件驱动对象系统
  
（音响/雪豹/沙发/摩托等可摆放对象）+ AI 伴聊 + 本地 ONNX TTS + Vosk 本地 STT +
  
QQ/网易云/酷狗多源音乐（Playwright 驱动系统 Edge 做登录授权）+ 单 EXE 离线安装器
  
（内置 Python/Node/CPU ONNX/DirectML overlay，无网络部署）。自定义双许可
  
（代码/素材分离），非标不碰。

**两条与本项目的呼应（不构成新候选）**：

- 「配置只存偏离默认值的键」+ config_tool check/compact/migrate/effective——
    
  与咱们「逐段逐键合并，默认值只影响没写过该键的配置」（规矩 1/24）同一设计，
    
  互证方向正确；他们的 CLI 工具化做得更彻底，可当参考形态。
- 离线安装器工程（4 路固态 LZMA2 分片 + 尾部 SHA-256 + 自适应并行解压）——
    
  咱们 NSIS + blockmap 已够用，无需跟进；但「密码学哈希必须校验后再落盘」
    
  与咱们 Cubism Core 的 MD5 兜底（规矩 11）精神一致。

其余（多源音乐/对象系统/Playwright 登录）都是它自己的产品面，与陪伴定位无关。
  
多源音乐+平台登录属版权灰区（作者也自认"仅学习研究"），不学。

## 11.19 Amo-Zeng/desk_cat（12★，语言未标，无 license 文件，2025-08 停更）—— ⚪ 低，一个点子

小体量猫咪桌宠（v1.0.0「即将发布」但从未发版）。功能清单全是咱们已有的基础项
  
（抚摸/喂食/玩耍/拖拽/点击穿透/置顶/托盘/性格系统）。

**记走一个点子**：**追逐鼠标**——小猫追着光标跑。对咱们是廉价 juice：motion.js
  
的漫步状态机上加一条「光标快速移动且停在窗外交互区附近 N 秒 → 走过去」的触发
  
即可，与自主漫步（规矩 25）同管线。配 mood 层的 Social 轴（渴望高时更容易来
  
找你）会是自然的组合。候选池排队，不单独做。

其余不记：双聊天界面/中英文切换/思考动画均已有对应物。

## 11.20 jnMetaCode/codepet（30★，Electron+PixiJS，Apache-2.0，活跃）—— 🟡 中，养成数值与隐私纪律

「码宠」：开发者养成桌宠——写代码/用 Claude Code 就涨经验、升级、换状态
  
（摸鱼😴→热身🌱→干劲十足💪→卷王🔥）。程序化生命感（呼吸/摇摆/眨眼/踩影子/
  
自蹦）+ 8 只宠物各有人设 + Claude Code hooks 实时联动。工作状态感知的**第五个
  
实现**（11.2→11.11→11.14→11.16→本例），且是唯一带**成长数值系统**的。

### A. 养成数值设计 —— mood 层的姊妹系统，公式可直接参考

```
经验 = 提交数×10 + 增删行数×0.1 + prompt数×4 + 完成任务数×8 + 工具调用×1
```

- 100 经验升 1 级；状态按**今日经验**分四档（不是累计值——防"躺功劳簿"）。
- **能量**随时间衰减（约 3 天满→空），靠当日活动补充——与 3D 版 PetMood 的
    
  Energy 轴同一设计，参数互相印证（他们 3 天、PetMood 清醒 3 小时耗尽——
    
  口径不同：他们按"天"给成长系统用，PetMood 按小时给行为偏置用）。
- 关键取舍：**经验来自有意义的事件，不用 token 数**（作者发现 `~/.claude`
    
  里 token 计数不可靠）——咱们若做工作事件反应，同样只认事件不认 token。

### B. 隐私纪律四条 —— 工作事件功能上线时的说明书模板

全本地不外传 / **只读聚合元数据（次数），从不读对话正文或代码内容** /
  
完全 opt-in 默认可关 / 开源可逐行验证。还主动对齐了 Anthropic 官方社区对
  
开发者宠物的隐私期待（claude-code #59081）。咱们将来挂 WorkBuddy 钩子
  
（11.11-A）时，这四条直接抄进设置页说明文案。

### C. v2 路线印证 Live2D 授权困境

他们 v1 用 AI 生成的 2D 立绘（gpt-image-1 透明背景原创小动物），v2 才上
  
Live2D 且**明确要求自备正版授权模型、项目不内置**——第五份独立证据表明
  
"内置 Live2D 模型分发"的授权门槛是行业共识（对照 11.17 Alive 的灰色路线
  
翻车、咱们的 hiyori 官方豁免 + 自制模型计划）。

## 11.21 KokoroMemo（CyrilPeng/KokoroMemo，73★，Python，MIT）—— 长期记忆专题最完整蓝图 ★

定位：**本地角色连续性引擎**——面向 AIRP / AI 游戏 / AI 桌宠 / OpenAI 兼容客户端的
  
长期记忆核心。架构是 OpenAI-compatible 代理：客户端照常请求聊天模型（只改 Base URL），
  
它在中间保存对话、维护会话状态、检索长期记忆、按需注入上下文。

产品目标的三句话框架很成熟，直接回答"记忆系统怕什么"：**不忘**（跨会话记住
  
称呼/偏好/边界/关系进展/约定/共同经历）、**不串**（角色/会话/世界观/记忆库之间
  
不互相污染）、**不乱记**（临时剧情、玩笑、误会、模型编造的内容不轻易变成长期记忆）。

### A. 对长期记忆候选池的五块设计蓝图（路径①自研方案直接可抄）

1. **记忆审核收件箱**——新提炼的记忆先进收件箱，可自动通过/人工审核/拒绝；
     
   候选按风险、类型、审核类别（边界规则/关系变化/角色连续性/剧情状态/可能误记）
     
   辅助筛选。这是"不乱记"的工程解——比 BM25 三段式（11.1-B）多了**写入侧闸门**。
2. **Retrieval Gate + 召回解释**——先判断本轮是否需要检索（不是每轮都召回），
     
   并记录：选中了哪些记忆、为什么选中、哪些因角色/会话/记忆库隔离被排除、
     
   注入了多少字符。**可解释的召回** = 漏召回/错召回/串库可排查。
3. **状态板与长期记忆分层**——表格化状态板记"当前正在发生什么"（场景/关系变化/
     
   扮演规则/承诺任务），长期记忆只存稳定事实；注入预览显示每张表是否进 prompt、
     
   字符预算截断情况。与咱们"近期原文+远期摘要"（11.12）同思路但结构化更彻底。
4. **按角色/会话/记忆库的隔离与挂载**——记忆卡片分全局/角色/会话三层作用域；
     
   与 LingChat 按角色分存档（11.8-③）互证：**做多角色前必须先定隔离边界**。
5. **记忆基准进 CI**——内置 AIRP benchmark（称呼/偏好/边界/多角色隔离/记忆库
     
   隔离/场景连续性），fake embedding 可重复跑，带阈值 smoke 门禁 + 发布前完整
     
   门禁 + quality_gate 报告。**记忆质量也有回归测试**——咱们的 verify 体系
     
   照此思路加记忆断言。

### B. 路线判定

- 它是常驻 Python 服务（与 Letta 同张力，11.12 已判自研轻量优先级上调），
    
  不整体引入；但 MIT 许可 + 设计完整度，是**自研路径①的头号参考实现**。
- 轻量细节同款：LanceDB 不可用回退 SQLite + numpy 向量检索（降级可用）；
    
  聊天/记忆判断/状态板填充/Embedding/Rerank 五种模型可分开配（低端配置
    
  用小模型跑记忆判断）。

### C. 长期记忆候选池现状小结（四路径）

① 自研轻量（BM25 三段式 + 时间代词路由 + 本节写入闸门/召回解释/分层/隔离）
  
② 外挂 Letta/MemGPT（ZcChat 弃用实证）③ 云记忆服务（未考察，不倾向）
  
④ 本地记忆代理 KokoroMemo（独立服务形态，用户自选接入——咱们的 llm.js
  
baseURL 可配，技术上零成本兼容，将来可作为高阶用户的可选外挂写进文档）。

## 附：本轮证据路径

```
https://github.com/sjmsltx/deepseek-desktop-pet                    README + docs/live2d_pipeline.md ★
https://blog.csdn.net/qq_45707187/article/details/163761507        鲸鱼娘功能与事件驱动架构
https://github.com/nanonocturne-altago/DeepSeek-Pet                README（dsh-pet 整合版）
https://zhuanlan.zhihu.com/p/2071656196034016066                   dsh-pet 介绍文
https://github.com/worm128/AI-YinMei                                README（11.5）
https://github.com/PC2005-cloud/dsh-pet                             README 全文（11.6）
https://github.com/LYiHub/pub-local-jarvis                          README + PROJECT_OVERVIEW（11.7）
https://github.com/SlimeBoyOwO/LingChat                             README（11.8，AGPL 不碰代码）
https://github.com/Zao-chen/ZcChat                                  README + FAQ（11.9，GPL 不碰代码）
https://github.com/THE-abeedoo/virtual_maid                         README（11.10，低）
https://github.com/lokicorvus/crosspet                              README + 接入教程 + workbuddy/hooks.json ★（11.11）
https://github.com/Zao-chen/ZcChat2                                 README + 开发进度（11.12，续作动态）
https://github.com/JianguSheng/yuns-desktop-pet                     README（11.13，截屏自隐藏细节）
https://github.com/bleeeet/TermiPet                                 README（11.14，回环 HTTP 传输）
https://github.com/WINDGAND/Bailin                                  README + 隐私设计（11.15，DPAPI/视角蒸馏）
https://github.com/X-T-E-R/OpenPet                                  README（11.16，六事件模型+TTL）
https://github.com/TopSea/Alive                                     README + ChangeLog（11.17，已闭源对照记录）
https://github.com/MARK42IRPC/FlyingSnowVelvet-Aemeath              README（11.18，离线工程对照）
https://github.com/Amo-Zeng/desk_cat                                README（11.19，追逐鼠标点子）
https://github.com/jnMetaCode/codepet                               README（11.20，养成数值+隐私纪律）
https://github.com/CyrilPeng/KokoroMemo                             README 全文（11.21，长期记忆蓝图 ★）
https://github.com/minghf85/AIFE                                        README（11.22，GPT-SoVITS 本地音色）
https://github.com/worm128/yinmei-desktop                               README + 源码（11.23，Spout2 外部渲染路线）
```

## 11.22 AIFE（minghf85/AIFE，17★，Python，GPL-3.0 不碰代码）—— 低

定位：全 Python 的 Live2D AI 桌宠（live2d-py + ollama/DeepSeek + GPT-SoVITS +
  
RealtimeSTT），2025-08 停更，功能（Live2D v3 / 流式语音 / 口型同步 / 打断播放）
  
咱们全有且更深（代际令牌打断、双引擎 TTS、VAD）。GPL-3.0 代码不碰。

**记走一条**：TTS 第三条路线入池——**GPT-SoVITS 本地自训音色**（api_v2 流式合成 +
  
替换 api_v2.py 加打断播放）。咱们 tts.js 现有 WinRT / 云端双引擎，声音都是"别人的"；
  
GPT-SoVITS 路线可让角色有**专属定制音色**，且完全本地零 API 费。代价：NVIDIA GPU
  
刚需、中文为主、部署门槛高（克隆权重管理）——列 Steam 商业化后再评估的远期候选，
  
不入近期排期。

**顺带的行业观察**：又一个直接拿官方 hiyori/Haru 做 AI 桌宠分发的小项目——
  
Live2D 样本数据对个人 AI 陪伴类用途的豁免在实践中被广泛默认使用，但**没有一个
  
项目像咱们这样先去信确认"可扩展性 APP"归类**。发确认邮件这件事的优先级可以
  
适当上调（免费、且决定上架路径）。

## 11.23 yinmei-desktop（worm128/yinmei-desktop，15★，C#/WPF，BSD-2）—— 低

11.5 AI-YinMei 的**桌宠皮肤组件**：WPF 透明窗 + LightjamsSpout（C++ spout2）
  
接收 `VTubeStudioSpout` 共享视频流 + DirectX9 绿幕 shader 抠像上桌。2024-12 停更。
  
（GitHub API 限流后走 codeload 直下源码验证：MainWindow.xaml.cs 确认 Spout
  
接收器 + GreenScreenShader 均在。）

**判定**：⚪ 低，技术路线反面参考——它是「**外部渲染**」路线（渲染在 VTube Studio
  
/主项目进程里，桌宠窗口只收 GPU 共享纹理再绿幕抠像）的完整实现。对照咱们内嵌
  
官方 runtime：零跨进程依赖（不用装 VTube Studio/Steam）、无绿幕抠像画质损失、
  
无双进程常驻内存。多模型改造时若有人建议"接 VTube Studio 省事"，这条路线的
  
三笔账（依赖/画质/内存）就是否决理由。绿幕抠像 HLSL 与预渲染视频链（11.3）
  
同款技术，不重复记。

---

# 第 12 轮：自主搜索（2026-10-22，GitHub 搜索 API + WebSearch + awesome 索引）

用户要求结合其链接自主找参考。三路搜索（GitHub API 关键词 / 网页 / awesome 索引）
  
命中一批量级远超第 11 轮的项目，其中两个直接命中咱们排期中的下两个功能。


## 12.1 awesome-ai-companion（DasterProkio，1041★）—— 同领域策展索引 ★

人机恋开源项目大全（中英双语），声称**每条都读过代码**、新条目自动扫恶意代码，
  
条目标注 ready/adapt/infra/verify 状态。分类即地图：客户端工作台 / 心跳与主动
  
搭话 / 记忆身份情绪状态 / 语音形象具身化 / 感知 / 现实集成 / 游戏世界 / 共享
  
活动 / 社区 / 数据所有权。**后续调研的入口**：先查它有没有收录，再决定深挖谁。

## 12.2 Project AIRI（moeru-ai/airi，46.8K★，MIT）—— 本赛道体量之王

复刻 Neuro-sama 的「AI 虚拟角色灵魂容器」。三形态一套代码：Stage Web（浏览器
  
PWA）/ **Stage Tamagotchi（桌面桌宠版，Electron）** / Stage Pocket（移动端）。
  
Web 技术优先（WebGPU/WASM/WebAudio/WebSocket），桌面版可选 CUDA/Metal 原生
  
加速（candle）。Live2D + VRM 双格式，动画自动眨眼/视线跟随/待机微动（咱们全
  
有）。30+ LLM 提供商（自家 xsAI 统一接口）。游戏代理（Minecraft 稳定/Factorio
  
WIP/KSP 演示）。记忆 Memory Alaya 开发中；浏览器内 DuckDB WASM/pglite 本地库。

**对我们的价值**：① 三端一体的产品架构（咱们单 Windows，暂不跟进，但上 Steam
  
前的多平台评估有现成参照）② 46.8K★ 验证「开源 AI 伴侣+桌宠形态」的市场体量
  
③ 它的 Similar Projects 清单 = 又一层索引（amica/Neuro/z-waif…）。MIT 可细读
  
它的 tamagotchi 桌宠端源码做对照（它也是 Electron）。

## 12.3 Open-LLM-VTuber（8.3K★，MIT，原 t41372）—— 功能重叠度最高的头部项目

跨平台语音交互 AI 伴侣：实时语音对话、**免耳机语音打断**（AI 听不到自己的声音）、
  
视觉感知（摄像头/录屏/截图）、Live2D 情绪映射（后端控表情）、**内心 OS 展示**
  
（不说的想法单独显示）、AI 主动说话、桌宠模式（透明+置顶+点击穿透）、聊天记录
  
持久化、TTS 翻译（中文聊日配音）。LLM/ASR/TTS 全模块可换配置。v2.0 重写讨论中。

**对我们的价值**：

1. 🔴 **Live2D 样本模型的授权处理与咱们完全同路**——随包带官方样本模型 + 单独
     
   许可声明 + 明确警告商用者自行获取授权。头部项目的行业实践印证咱们的 hiyori
     
   路线（README Third-Party Licenses 节可当咱们商店页声明的措辞参考）。
2. **内心 OS 展示**——咱们 llm.js drain 已剥 `[think:...]`，但只是丢弃；OLv 把
     
   它变成展示层（想但不说的念头单独显示）= 低成本高沉浸感的功能点，候选。
3. **免耳机语音打断**——与咱们的 AEC+VAD 路线对照参考（它宣称无耳机也不自听）。
4. 它的 proactive 与情绪映射实现细节值得后续深读源码（MIT）。

## 12.4 jiwen 积温（ClaraShafiq/jiwen，~500 行 JS，零依赖，MIT）—— mood 层 + 主动搭话的直接蓝图 ★★

「不靠概率骰子的 AI 角色主动意识引擎」——**正好同时命中咱们的 mood 层（下一个
  
功能）和主动搭话升级（proactive）两个排期项**。

- **五轴漂移**：连接需求 connection（想念累积）/ 骄傲 pride（端着还是放软）/
    
  愉悦度 valence + 唤醒度 arousal（Russell 1980 环状模型正交轴）/ 沉浸度
    
  immersion（正在做事的专注度，骄傲的缓冲垫）。
- **轴间制衡**（比 PetMood 四轴更丰富的一层）：想念到阈值但骄傲高 → 不开口、
    
  找事做；想念强烈 → 坏情绪回归减速（valence lock）；等待拉升 arousal；
    
  沉浸度线性衰减（借口会过期）；想念太重 → 骄傲被迫下降（pride erosion）。
- **阈值触发**（替代概率骰子）：connection≥0.20 → observation（内心念头不发
    
  出）；≥0.35 → 按骄傲分流 contact/find_activity；≥0.50 → 强制开口。
    
  **它对「概率骰子」的批评对咱们同样成立**——idle 定时器+概率跳过 = 她不是
    
  「想不想说话」而是「有没有被骰中」。
- **三层成本模型**：数学漂移（零模型，每 5 分钟）→ 对话分析（轻量模型只出
    
  delta 值）→ 行动生成（大模型，仅阈值触发时）。
- **getPromptContext() 把数值翻译成人话**——模型不需要知道 connection=0.47，
    
  只需要「你很别扭，想找她又拉不下脸」。
- 附 simulate.js（多参数 CSV 轨迹对比）+ 29 项测试。**与 PetMood 的关系**：
    
  PetMood 四轴+离线补漂+重聚；积温五轴+制衡+阈值触发+人话翻译。两者拼起来
    
  正好是咱们 mood 层的完整参考——PetMood 的工程纪律（纯逻辑零时钟）+ 积温的
    
  行为语义（轴怎么变成「她想你了」）。

## 12.5 revive-companion（pearthink123，MIT，Python）—— 主动搭话时机引擎

「让 AI 主动找你时像真人想你了，而不是该发消息了」。**三阶段决策**：
  
① 时机（泊松过程，像真人"突然想起你"的随机性）② 价值（信息增益：已知用户
  
状态就别打扰）③ 状态（贝叶斯推断用户在干嘛：聊天中 0.2 效用别打断 / 闲逛
  
0.7 好时机 / 忙碌 0.1 别打扰）。124 项测试，PyPI 可装。

**对我们的价值**：咱们的 proactive 四闸门（43eaa67）是**硬规则**（media/锁屏/
  
冷却/静默），revive 是**软推断**（用户状态概率 → 效用 → 决策）。两层可以叠加：
  
闸门拦硬性不该说话的场景，效用模型在闸门全过时决定"值不值得"。它的兄弟项目
  
affective-longing（ChromaDB + VAD 情绪）把情绪也接进了同一决策链。

## 12.6 Affect & Drives 生态（awesome 索引收录，逐个点名）

mood 层方向的先例生态，验证方向 + 提供参数化参考：

- **Eventide**（Python，非商用）：生理状态引擎——身体周期、7 内驱力、18 短期
    
  事件、梦境联动、交互结算 JSON 写回。**体量比 PetMood 更大的同方向实现**，
    
  NSFW-adjacent 只取工程结构不取内容。
- **Tidefall**：Eventide 的 Supabase 版（六阶段周期+七漂移值+18 短期事件）。
- **emotion-system**（JS）：情绪驻留自然衰减 + 触摸积累亲密 + 离开增长想念
    
  （与咱们 EMO_DECAY + 摸头 A-B-C + PetMood Social 轴三件事一一对应）。
- **Drivesoid**（JS）：HTTP sidecar 追踪疲劳/想念/焦虑/玩心/守护/亲密六驱力，
    
  从对话与作息事件更新。
- **Kin Mind**（Python）：记忆+情感+欲望三合一 OS，情绪自然衰减。
- **Xinchao·Nian 心潮念**：11 驱力 + 双层情绪 + 慢速气质 + 梦境（AGPL 非商用，
    
  记结构不碰代码）。

## 12.7 记忆生态（awesome 索引收录，补齐长期记忆路径①的参考面）

- **Paramecium**：**逐字聊天记录是唯一真相源，向量只做索引，检索返回原文而非
    
  摘要**——直接可抄的设计原则（防摘要幻觉污染记忆）。
- **kiwi-mem**：记忆热度排序 + 梦境/睡眠整理 + 日历分层摘要。
- **Memory Constellations 记忆星图**：事实 → 主题星座 → 叙事片段三层聚合检索。
- **Hindsight**：四路召回（向量/BM25/实体图/时间）+ 证据背书的观察值随时间精炼。
- **Serein**：聊天模型写场景、摘要模型写事件、都绑定逐字证据 + 重排门控召回。
- **DuduLove Memory**：拒绝过的记忆永远不再出现（recall ledger）。
    
  （至此长期记忆路径①的参考从 KokoroMemo 一家扩到 6+ 家；原则收敛：证据绑定 +
    
  分层 + 多路召回 + 写入闸门。）

## 12.8 本轮结论与排期影响

1. **mood 层蓝图升级**：PetMood（工程纪律）+ **积温**（五轴制衡+阈值触发+人话
     
   翻译）双蓝本；积温的「概率骰子批评」说明 mood 层做完后 proactive 的触发
     
   逻辑应该从「idle+概率」换成「轴漂移到阈值」。
2. **主动搭话两层架构候选**：硬闸门（已有）+ 软效用（revive 三阶段）。
3. **内心 OS 展示**：低成本候选（llm.js 已剥 [think:]，改为转发展示层即可）。
4. **Live2D 样本授权的行业实践**（OLv 同路）→ 商店页声明措辞参考。
5. **后续调研入口固定**：awesome-ai-companion 索引 → GitHub API 搜索 →
     
   raw.githubusercontent.com 拉 README（不占 API 配额；codeload 直下可拿源码）。

## 附：本轮证据路径

```
https://github.com/DasterProkio/awesome-ai-companion            索引全文（12.1）
https://github.com/moeru-ai/airi                                 README（12.2）
https://github.com/Open-LLM-VTuber/Open-LLM-VTuber              README（12.3）
https://github.com/ClaraShafiq/jiwen                             README（12.4 ★★）
https://github.com/pearthink123/revive-companion                 README（12.5）
GitHub 搜索 API：desktop pet LLM / live2d pet（各 12 条）
```

---

# 第 14 轮：「DeepSeek 鲸鱼娘」桌宠生态（2026-10-25）

> 起因：用户问「最近流行 DeepSeek 鲸鱼娘桌宠，能不能把 Ayan 也改造成鲸鱼娘桌宠」。
>   
> 本轮**只调研不执行**。结论前置：**技术上零障碍，素材法律上不可用**——
>   
> 现有开源鲸鱼娘素材对我们是三重障碍（NC 非商业 + SA 传染 + DeepSeek 商标）。

## 14.0 生态全貌：这不是「桌宠」，是 DSH 插件生态

市面上叫「DeepSeek 鲸鱼娘桌宠」的东西，绝大多数**不是独立桌宠软件**，
  
而是 **DSH（DeepSeek Harness）Web UI 的插件**——跑在浏览器/宿主界面右下角，
  
跟着 agent 状态（思考/调工具/报错/收工）换表情。我们 Ayan 是 Electron 独立桌面软件，
  
形态不同，但**状态驱动表情**这层逻辑可以直接搬（见 14.6）。

star 量级全部很小（1~56），是 DSH 插件小圈子，不是大众产品。

## 14.1 Andersen216/dsh-whale-girl-live2d —— 授权链最完整的一个 ★★★

56★ · 代码 MIT / 美术 CC BY-NC-SA 4.0 · 默认分支 main

**它做了什么**：DSH Web 界面里的 Live2D 鲸鱼娘，跟 agent 真实状态换表情动作，
  
点一下直接给 agent 发消息，右键是钱包，52 条动作逐条对照按键表。

**🔴 三重版权链（必须都署名）**：

| 版权人            | 贡献                         | 主页                |
| -------------- | -------------------------- | ----------------- |
| **上善无形**       | 鲸鱼娘角色形象原作，原创 OC「溟月」        | bilibili 4456176  |
| **ZipZipPipe** | 加入 DeepSeek 元素的「女仆鲸鱼娘」二次设计 | bilibili 4168597  |
| **氵六青**        | Live2D 化（绑定/动作/表情）         | bilibili 11272072 |

形象链：上善无形「溟月」→ ZipZipPipe 女仆鲸鱼娘 → 氵六青 Live2D 化。

**模型作者原《使用须知》**（氵六青，逐字照录）：

```
商用直播√   自印物料√
禁止任何形式的盗用以及出售，此模型为无偿分享
模型制作：B站@氵六青（11272072）
```

即：允许商用直播、自印物料、自定义桌宠改造；**禁止盗用与出售**。

**但**：氵六青同意转载/开源**不解除形象本身的许可条件**——形象由 上善无形 +
  
ZipZipPipe 以 **CC BY-NC-SA 4.0** 发布 → **NC（非商业）与 SA（相同方式共享）依然有效**。

**对我们的判定：不可用。** 三条独立理由，任一条单独成立即否决：

1. **NC**：Ayan 是要上架 Steam 的商业产品，与「非商业」直接冲突
2. **SA 传染**：用了它，我们的整个作品要按 NC-SA 开放
3. **商标**：女仆鲸鱼娘版带 DeepSeek 元素（鲸鱼标识 + 名称），项目自己声明
     
   「不授予任何商标或品牌使用许可」

**技术上可抄的部分**（与授权无关）：

- 模型是**标准 Cubism 4**（`c_0120.moc3` + 2048 贴图 + physics3 + cdi3 + 8 motion）
    
  → 我们 profiles 档案化架构可以直接吃
- 🔴 **`tools/build-model.mjs`：给 VTube Studio 模型包补 `model3.json`**。
    
  VTube Studio 模型包**按文件名加载动作，原包没有 model3.json**（标准 Cubism 运行时
    
  加载不了）。这个脚本把 8 个动作注册成标准 motion group + 抽表情参数清单。
    
  **将来我们要接任何 VTube Studio 来源的模型，这一步是必经的**，直接拿来改。

## 14.2 XT-nya/deepseek-dafeiyu-pet —— 独立桌宠 + 甩抛物理第二蓝本 ★★★

1★ · NOASSERTION（README 自称 MIT，作者在单文件里手写）· 默认分支 main

**它做了什么**：Windows 独立桌宠（不是插件），常驻右下角。形象是女仆鲸鱼娘，
  
18 张差分。功能核心是**读 DSH 会话日志 → 显示真实 token 花费**，并且告诉你现在是
  
「梁文峰」（高峰 ×2 价）还是「梁文谷」（空闲价）时段。

**技术（对我们有价值的）**：

- **`WS_EX_LAYERED` + `UpdateLayeredWindow`** 走 Win32 分层窗口，实现**真正的逐像素
    
  透明**+ 无边框置顶，避免颜色键抠图留下的彩色毛边。60fps 下单核占用约 **2%**，
    
  常驻内存 ~50MB。（我们是 Electron 透明窗口，已解决同问题，但**性能对照值**有意义：
    
  我们的 ~657MB 对它的 50MB）
- **`src/physics.py`（318 行）纯数值、不依赖任何界面库** → 可直接搬到我们 motion.js。
    
  详见 14.5 常量表。
- **112 项分层自检**（价格分档/日志解析/状态机/物理/素材比例/渲染冒烟/端到端）——
    
  和我们的 20 个 verify 是同一个思路，可对照补缺。
- 模块化信息条：右键逐项开关、自动重排。

**素材：不可用**（CC BY-NC-SA 4.0，来自 `Vast-Beyond-Space/pet-app`，同 14.1）。

## 14.3 Vast-Beyond-Space/pet-app —— 素材与物理的**共同源头** ★★

41★ · NOASSERTION · 默认分支 main · README 就一句「真正 README 在对应版本文件夹里」

两个身份：

1. **鲸鱼娘贴图整理发布者**（18 张差分女仆鲸鱼娘），是 14.1/14.2 两家素材的共同上游
2. **`float.js` 物理引擎作者** —— 14.2 的 `physics.py` 头注释明写
     
   「参考 Vast-Beyond-Space/pet-app 的 float.js」

→ 所以**甩抛物理这条线现在有三个互证来源**：`float.js`（源）→ `physics.py` →
  
以及我们 11.21 记过的 dsh-pet `physics.ts`。三个独立实现指向同一套参数量级。

## 14.4 luweiyabo/dsh-whale-pet —— 95 个 WebM 动画（序列帧路线）

22★ · MIT（代码）· 默认分支 main

**路线不同**：不是 Live2D，是 **95 个 640×360 透明 WebM** 序列动画，
  
按 agent 状态（思考/编码/工具调用/等待/错误）切换，支持点击移动、拖拽、屏幕漫游。

**对我们的判定**：**序列帧路线不接**。我们是 Cubism 2D 变形架构，
  
改成分帧视频播放器 = 换渲染层，且 95 个 WebM 体积巨大、无法做错峰插值
  
（规矩 28 的「活人感」主来源全部失效）。但**状态→动画的分类清单**有参考价值
  
（思考/编码/工具/等待/错误 + 空闲/饿/困/睡 + 早中晚问候），
  
将来做「工作事件正向反应」（钩子技术已就绪，见 11.11）时可照抄状态机分类。

## 14.5 甩抛物理：可直接照搬的常量表（physics.py）

单位：逻辑像素 / 秒。这是**三个独立来源互证**后的量级，比我们自己推靠谱。

```
G = 1700.0          重力加速度            MAX_THROW = 1900.0   抛出速度上限
EDGE_DAMP = 0.45    撞屏幕边缘能量保留     GROUND_DAMP = 0.42   落地弹跳能量保留
GROUND_FRICTION = 0.72  每次落地水平摩擦   ROLL_FRICTION = 0.985  贴地滚动每秒衰减
STOP_EPS = 26.0     速度低于此值就停住
ROAM_SPEED = 46.0   游荡速度              STROLL_SPEED = 34.0  底边散步速度
ROAM_WAIT = (2.0, 6.0)  到点后发呆时间
SWING_K = 90.0      单摆刚度              SWING_D = 7.0  阻尼   SWING_MAX = 13.0 度
```

四种活动模式：`still`（待着）/ `stroll`（沿底边散步，撞边反弹）/ `roam`（随机目标点，
  
到了等 2~6s）/ `gravity`（贴地走；被拎起松手 → 抛物线飞出 + 落地弹跳）。

**五个独立开关**（右键逐项开关）：`throw` 抛出 / `bounce` 落地弹跳 / `collide`
  
撞其它窗口反弹 / `swing` 拖拽时单摆摇晃 / `flip` 往左走时水平翻转。

⚠️ 对照我们的现状：motion.js 里**没有速度概念**（11.21 已查证），漫步是位置插值。
  
要接甩抛物理 = 给 motion.js 引入 (vx, vy) 状态 + dt 积分，**且必须过规矩 25/26**
  
（自动移动不落盘 window 位置、成对的开始/结束事件在同一 await 流程）。

## 14.6 kmjs1915/CeTaPet-AI-DeskTopPet-DeepSeek —— 交互形态参考

11★ · MIT · 默认分支 main · Python + PySide6

**值得抄的交互**：把文件**拖到角色图标上让它「吃下」**，不同文件类型有不同反应
  
（日记 / 复习资料），吃下去后可在对话框里基于内容互动（轻量 RAG）。
  
→ 这是我们「工作事件正向反应」「长期记忆」两条候选的**具体交互形态**。
  
素材在 `asset_library/` 可整体替换（他们自己就说「不喜欢鲸鱼娘形象可换」）。

## 14.7 lvyuchuiyi/dsh-funpack —— 无参考价值

5★ · MIT。单 index.js 零依赖，攒了 10 个功能（摸鱼/占卜/番茄钟/Live2D 桌宠…），
  
是功能堆叠不是设计。跳过。

## 14.8 🔴 结论：鲸鱼娘素材对我们不可用，三条独立理由

| 障碍              | 说明                                  | 能否绕开             |
| --------------- | ----------------------------------- | ---------------- |
| **NC 非商业**      | 形象以 CC BY-NC-SA 4.0 发布，我们是要上架的商业产品  | 否（除非拿到三位作者的书面授权） |
| **SA 传染**       | 用了它 → 整个作品要按同协议开放                   | 否                |
| **DeepSeek 商标** | 鲸鱼标识 + 名称属 DeepSeek，素材项目自己声明不授予商标许可 | 否                |

**「改个颜色/换个发型就说原创」是没用的** —— 版权看的是实质性相似，
  
且这个形象链有三位明确署名作者 + 公开主页，是社区里链最完整的那种，追溯成本极低。

## 14.9 能落地的三条路径（按推荐顺序）

### 路径 A：BOOTH 买 premade 海洋主题模型（最快，但有一个坑）

已核实存在的可商用海洋主题模型：

- **Marina**（人鱼，19 表情）¥5000 JPY ≈ ¥240 —— <https://booth.pm/en/items/6337204>
- **Oceana**（海女王，人鱼尾，9 表情）Cyblens 出品
- Cyblens 系列普遍 ¥3000~~6500 JPY（≈ ¥150~~320），含 7~30 个表情

**TOS 原文**（逐条看完了）：

> 2\. License: ... **personal and commercial purposes** ... in your own Vtuber persona,
>   
> including art, merch, streaming, videos and other online content.
>   
> 3\. Restrictions: You may not **resell or distribute** the Model.

🔴 **坑在这**：TOS 明确**禁止 resell or distribute**。我们 Ayan 现在是**把模型打进
  
安装包分发**（models.zip 随包走，规矩 13）—— 这极大概率踩到「distribute」。

- 对比：Live2D 官方样本（hiyori）的 Free Material License 明确**允许使用、修改、分发**
    
  （小规模企业/个人可商用）→ 我们现在的用法合规


- 对比：BOOTH premade 的授权意图是「买的人当自己的皮用」，不是「拿去做产品」
- → **买之前必须向作者发信问一句「能否随软件分发」**。不问就打包 = 埋雷。
- 另外：这些是**通用海洋角色（人鱼/海女王）不是鲸鱼娘**，角色形象得自己定


### 路径 B：VRoid 自制 → 进 **3D 版**（ayan-3d），可商用且最干净

VRoid Studio Guidelines（pixiv 官方）明确：

> 仅用 VRoid Studio 自带内容做出的模型，**个人或企业均可商用**——
>   
> 包括直播/收费演出/贩卖/model 数据本身/改成模型手办/用于**游戏、应用、软件**。
>   
> 你自建的贴图与发网格版权归你自己。

⚠️ 两个限制：

1. **VRoid 输出是 VRM（3D），不是 Live2D** → 接不进 2D 版（我们 Electron 是 Cubism
     
   2D 架构）→ 但**直接进 3D 版 ayan-3d**（Unity + VRM）完美对口
2. 用了第三方贴图/衣服/预设 → 按各自条款；有特殊条款的预设不算
3. 不能用 VRoid 输出去做「角色生成应用」（我们不是，不受影响）

→ **如果「鲸鱼娘」这个角色最终是要进 3D 版的，VRoid 自制是最干净可商用的路。**

### 路径 C：委托画师 + 我们自己绑定（最贵但完全自有）

走 `docs/custom-model-plan.md` 的半自动路线 B：设计+分层 PSD → psd2live → runtime 适配。
  
¥2000~~6000、2~~3 周。委托书里已有一条「真人比例、不要二头身 Q 版」。

## 14.10 交叉验证：我们对 Live2D 授权的判定站得住

第三方来源（theviewbot 2026）对 Live2D 官方样本的判定**与我们第 3 轮结论逐条一致**：

- hiyori / Miara：**禁改设计** ● Shizuku：必须保留名字与设定
- 小规模企业/个人（年销 <1000 万日元）可商用 ● 每个原创角色都要版权声明
- Jin Natori / Tsumiki Harugasa（联名角色）：**不可商用、不可修改、不可分发**

→ 说明我们之前给 hiyori「个人可商用、禁改设计、要版权声明」的判定是业界共识，
  
不是我们自己的乐观解读。**这条可以拿去支撑 14.9 路径 A 的「先发信问」判断。**

## 第 14 轮来源清单（全部经 api.github.com 核实存在）

```
https://github.com/Andersen216/dsh-whale-girl-live2d            56★ MIT/NC-SA（授权链最完整）
https://github.com/XT-nya/deepseek-dafeiyu-pet                  1★  （独立桌宠+物理引擎）
https://github.com/Vast-Beyond-Space/pet-app                    41★ （素材+float.js 共同源头）
https://github.com/luweiyabo/dsh-whale-pet                      22★ MIT（WebM 序列帧路线）
https://github.com/kmjs1915/CeTaPet-AI-DeskTopPet-DeepSeek      11★ MIT（拖文件喂食交互）
https://github.com/lvyuchuiyi/dsh-funpack                       5★  MIT（跳过）
```

---

# 第 15 轮：AI 伴侣 / 桌宠生态全面对标（2026-10-25）—— 集他人优点

**本轮目的变了**：前 14 轮找的是"素材和某个具体功能怎么做"，这一轮把整个 AI 伴侣生态的
  
能力维度摊开，逐项对照**我们缺什么**。

**方法边界**（照用户级记忆的硬规矩）：全部走 `api.github.com/search/repositories` +
  
`codeload` 拉一手源码，**不信搜索引擎聚合站**（它们会把仓库名拼错或凭空生成）。
  
每个引用的仓库都经 `api.github.com/repos/<o>/<r>` 核过存在，拉包前先查 `default_branch`。

## 15.0 生态地图：那份 awesome 的**目录本身**就是 checklist

`DasterProkio/awesome-ai-companion`（1063★）把 AI 伴侣拆成 10 个维度。
  
**它的价值不在收录了哪些项目，而在它的分类 —— 那是一份"伴侣该有什么"的 checklist。**

| 维度                  | 我们    | 说明                                        |
| ------------------- | ----- | ----------------------------------------- |
| 伴侣客户端与工作空间          | ✅     | Electron 桌宠 + 悬浮气泡                        |
| 后台心跳与主动消息           | 🟡 半个 | 有 proactive 搭话，但**没有"心跳"**（定时自检、时间线连续性）   |
| 记忆、身份与情绪状态          | 🟡 半个 | 有 mood 四轴（慢变底色）+ emotion（快变），**没有长期记忆**   |
| 语音与 TTS / 视觉载体      | ✅     | 双引擎 TTS + 口型；Live2D + 双档案                 |
| 感知：语音识别             | ✅     | `speech.js` ASR                           |
| 感知：**说话人身份与语气**     | ❌     | 完全空白                                      |
| 感知：**屏幕与环境上下文**     | 🟡 半个 | `fullscreen.js` 已能拿前台窗口，却**只用来决定"该不该闭嘴"** |
| 服务与现实世界接入           | 🟡    | 只有 reminder 提醒                            |
| 共同行动与媒体（共读/共听/关系仪式） | ❌     | 完全空白                                      |
| 关系延续与数据主权（导出/迁移）    | ❌     | 完全空白                                      |

🔴 **三个"半个"是最亏的** —— 传感器/能力已经在代码里了，只是没接成"她知道"：
  
① `fullscreen.js` 已在判前台应用 ② `sysinfo.js` 已有系统状态 ③ `[think:…]` 通道已通。

## 15.1 长期记忆：warashi 的三层架构（★★★ 最对口我们的待办）

`inni918/warashi`（120★，Live2D 桌宠 + 长期记忆 + 主动消息）—— 形态和我们最接近，
  
而且它有独立的 `MEMORY_SYSTEM_DESIGN.md`。核心一句话：


> **别把什么都塞进 context。全量历史留在磁盘，只把一份精选的 core memory 注入人设，
>   
> 每轮之后让 LLM 自己「整合」新事实进 core memory。**

| 层                     | 存什么                      | 怎么工作                                      |
| --------------------- | ------------------------ | ----------------------------------------- |
| **core memory（注入）**   | 少量精选事实：用户是谁、在做什么、偏好、关键节点 | `core_memory.md`，追加进 persona prompt       |
| **全历史（回退）**           | 每轮对话原文                   | 现有 chat_history；Phase 2 加 SQLite **FTS5** |
| **consolidation（整合）** | 决定什么值得记                  | 每轮后**后台非阻塞** LLM 调用，按 write-triggers 判断   |

**`CAP_CHARS = 1500` 硬上限**（`src/open_llm_vtuber/memory_core.py:20`）——
  
超了让 LLM 合并/提炼（保留关键、删过时）。因为全历史在磁盘，"删"不是真丢。

**四个能直接照搬的工程细节**（都在 `memory_core.py:138-199`）：

1. **prompt 里写死"什么不记"**：「绝不记这些：一次性闲聊、寒暄、问候、没有新资讯的对话、
     
   **AI 自己说的话**」。→ 我们有防复读护栏，但记忆层必须独立判一遍，否则助手腔会被记进来。
2. **让 LLM 输出"整份新记忆"而不是 diff**，并要求「没有任何值得记的新资讯，就原封不动输出，
     
   **一个字都不要改**」+「不要任何解释、前言或标题」。
3. 🔴 **1.5×cap 防呆守卫**（`:193`）：`if new_mem and new_mem != current and len(new_mem) < cap * 1.5`
     
   —— 三重条件（非空 / 有变化 / 不超 1.5 倍上限），防"LLM 一次吐超长内容把记忆撑爆"。
4. **cap 双重夹取 + fail-soft**：配置值传进来后函数内再 `_clamp_cap()` 夹一次
     
   （原文："确保坏设定值不会弄坏整理"），整个函数 try/except 包住，失败只 warning。
     
   → 和我们规矩 8（配置读失败分三种）、规矩 7（try 覆盖到资源建立完成）是同一套纪律。

**关于向量：它明确不用。** Phase 1 根本不需要检索（core memory 直接注入）；Phase 2 用
  
SQLite **FTS5**（本地、轻量、无 GPU）；"向量只在 FTS5 证明不够时才值得"。
  
→ 这条帮我们省掉一个大坑：**别一上来就上向量库**。

**同期其他记忆方案的一手差异**（同节收录，都值得扫一眼）：

- `OptMem`：笔记只追加不改，相邻两段压成摘要、**层层合并成二叉树**；每次读固定长度总览，
    
  要细节逐层展开到原文。单脚本无依赖。
- `DuduLove Memory`：🔴 **被否决的记忆不会再被写回来**；同一条记忆一段对话里**不反复冒出**。
- `Hindsight`：向量+关键词+实体关系+时间**四路检索**；后台合成带出处的「观察」，有新证据就修订。
- `moraine-home`：**身份与重大关系变动需双方确认，绝不擅自裁决**。
- `rolling-memory`：两层滚动（近期待办增量销项 + 远期骨架淘汰）。

## 15.2 情绪表现：soullink 的 FACS/AU + ModelProfile（★★★ 对口规矩 28 的档案化）

`nanlingyin/soullink-emotion-sdk`（168★，Apache-2.0，已发 npm）——
  
"为各类桌宠接入自然连贯的 Live2D 表情与动作"。它比我们多一层：

```
消息/事件/语音 → EmotionIntent → [VAD 情绪 | FACS/AU 表情 | Idle/Reaction 动作]
              → MotionMixer（各层独立混合）→ ModelProfile 参数映射 → 渲染器
```

**四条我们缺的、且能直接借鉴的**：

1. **FACS/AU 语义层**：它不直接写 Cubism 参数，而是先用**模型无关的语义**（微笑、皱眉、
     
   注视、姿态）描述，再经 **ModelProfile 映射**成具体参数。
     
   → 我们的 `profiles/<m>.js` 是"情绪名 → 参数值"**直接映射**，缺中间语义层。这正是鲸鱼娘
     
   "没有微笑眼/肩/手臂"时要靠"param 置空 + put 跳过"硬扛的原因。
2. 🔴 **能力覆盖率 + 自动降级**：`profile-generator` **自动扫描模型参数**，生成
     
   `soullink.profile.json` 和**能力覆盖率**，按模型能力自动降级。
     
   → 我们 whale.js 的 247 个参数是我**手工**读 cdi3.json 一个个数出来的，换第三个模型还要
     
   再来一遍。**对我们的"运行时切换模型"待办是刚需。**
3. **分层 MotionMixer + ownership**：情绪层 / Idle 层 / Reaction 层 / Speech Performance 层
     
   各自独立混合；🔴 其中 Speech 层「为说话生成头部、身体、视线和表情重音，但**不抢占
     
   LipSync 的嘴部控制权**」—— 这个"通道所有权"我们靠规矩 28 的调用顺序**隐式**保证，
     
   它是**显式声明**的。
4. **seed 可复现调试**：固定随机序列，复现同一段动作表现 → 我们的 `PET_SNAPSHOT` 可用。

**VAD 三轴**（Valence / Arousal / Dominance）代替离散情绪名 —— 连续的"方向 + 强度"。
  
我们的 mood 四轴（valence/social/energy/pride）与它**正交**：VAD 是"当下这一刻的情绪"，
  
mood 是"她近期的底子"。两者可以并存，不冲突。

## 15.3 主动时机：泊松 + 贝叶斯 + 信息增益

我们现在的 proactive 是三条硬规则：安静时长 / `maxUnanswered` 上限 / 免打扰时段。
  
`revive-companion`（MIT）专做这一件事：

> 结合**泊松过程**、**贝叶斯用户状态推断**与**信息增益**，判断伴侣何时该打扰。
>   
> 只负责时机决策，不含记忆或情感系统。

→ 它把"该不该开口"拆成三件：① 距离上次互动的时间分布（泊松，天然产出"越久越想找你"的
  
曲线）② 对用户当前状态的概率推断 ③ **这句话能带来多少信息增益**（没话找话就别开口）。
  
第③条最能治"搭话像客服" —— 我们的防复读护栏只管"说法重复"，**不管"内容有没有价值"**。

## 15.4 感知：三处"有传感器但没接"的缺口

| 项目                      | 做什么                                                   | 我们能怎么接                                                               |
| ----------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `ears`（MIT）             | 音高/能量/停顿/语速/颤动 **与用户自身基线比较**，把"比平时更轻"等**相对线索**绑定到具体消息 | 我们**流式 ASR 只留文字**，副语言信息全丢。可在 `speech.js` 顺手算能量/语速，存每用户基线             |
| `SenseVoice` / `FunASR` | **ASR + 语种识别 + 语音情绪识别 + 音频事件检测**一体（50+ 语言）            | 比"先转文字再猜情绪"准 —— 语气不丢                                                 |
| `gaze`（MIT, Windows）    | **轻量连续屏幕感知**：前台窗口 → 低成本视觉旁白 + OCR → **滚动 JSON 上下文**   | 🔴 **`fullscreen.js` 已经在判前台应用了，却只拿来决定"该不该闭嘴"**。同一份信息可以直接变成"她知道你在忙什么" |
| `voice-familiarity`     | 说话人识别 → matched/likely/unknown/ambiguous 作**关系上下文**   | 有你 / 有别人 / 不确定，可直接喂 mood 的 social 轴                                  |

## 15.5 工具与行动：MCP（我们完全没有）

`JianguSheng/yuns-desktop-pet`（141★，MIT，Electron 桌宠）三件我们没有的：

- **MCP 工具调用**：文件系统 / 终端命令 / 网络请求三个预设，AI 可自主调用完成复杂任务，
    
  支持自定义 MCP 服务器（依赖 `@modelcontextprotocol/sdk`）。
- **视觉分析**：一键截屏发给 AI；🔴 有个细节值得抄 —— **自动隐藏窗口后截屏**，确保截图干净
    
  （我们有 `?snap=` 探针；而且记忆里"可见 dev 窗口 = 用户眼里凭空多一个人"正是同一个顾虑）。
- 对话导出 Markdown。

→ MCP 是"让她能做事"的标准答案，比自己造工具协议强（生态里有现成 server）。
  
对应我们的待办"工作事件钩子"：**钩子只能让她「感知」，MCP 才能让她「动手」**。

## 15.6 数据互通：Character Card 规范

`character-card-spec-v2` / `character-card-spec-v3`（社区通用 AI 角色卡规范）：

> "理解它意味着**伴侣人格可以跨前端携带**。"

→ 我们的 `resolvePersona()` 是自建三段式（整段 persona > personaParts > 全默认）。
  
支持导入角色卡 = 一键接入 SillyTavern / RisuAI 的海量现成人设，顺带解决"运行时切换角色"。

## 15.7 治理与工程细节（小而狠）

- 🔴 **`pilulier`（药盒，MIT）**：**用完即焚的一次性指令** —— 长按消息挑一颗"药丸"挂在前面，
    
  **只管下一次回复，不污染长期设定**，含 13 颗情绪行为药方。→ 治"越聊越像客服"的**手动**
    
  手段，比我们全自动的防复读 hint 更可控（用户自己决定什么时候下药）。
- `output-guard`：拦住 AI 自己伪造的"用户发言"，去会话文件核对那句到底在不在，不在才拦。
- `BongoCat`（24166★，Tauri 跨平台）：工程规范参考（AGENTS.md / CHANGELOG / justfile / deny.toml）。
- `OpenPetsHQ/openpets`（1330★）：插件 SDK + `.agents/` + `AGENTS.md` + `DESIGN.md` 分层仓库结构。

## 15.8 🔴 差距总表

| 能力        | 我们           | 生态里最好的做法                        | 差多少                         |
| --------- | ------------ | ------------------------------- | --------------------------- |
| 长期记忆      | ❌ 无          | warashi 三层 + 1500 字上限 + 1.5× 防呆 | **大，但有现成蓝图**                |
| 情绪语义层     | 🟡 直接映射参数    | FACS/AU 语义层 + 覆盖率自动降级           | 中（换模型时才痛）                   |
| 主动时机      | 🟡 三条硬规则     | 泊松 + 贝叶斯 + **信息增益**             | 中                           |
| 嘴部所有权     | 🟡 靠调用顺序隐式保证 | 显式 ownership 声明                 | 小                           |
| 语气/副语言感知  | ❌ 只留文字       | 与用户自身基线比较                       | 中                           |
| 屏幕上下文     | 🟡 有传感器没接    | gaze 滚动 JSON 上下文                | **小（纯接线）**                  |
| 说话人识别     | ❌            | matched/likely/unknown 关系上下文    | 小                           |
| 工具调用      | ❌            | MCP 标准                          | **大**                       |
| 人设互通      | ❌ 自建格式       | Character Card V2/V3            | 小（收益大）                      |
| 一次性纠偏     | 🟡 自动护栏      | 药盒：手动、用完即焚                      | 小                           |
| 导出/迁移     | ❌            | 导出 MD/JSON + 通用规范               | 小                           |
| **系统级集成** | ✅ **我们更强**   | —                               | GPU/内存/温度、全屏静默、媒体感知，多数项目没有  |
| **回归体系**  | ✅ **我们更强**   | —                               | 20 个 verify + 诊断环境变量，多数项目没有 |

## 15.9 可落地清单（按「性价比 = 收益 ÷ 改动量」排序）

1. **屏幕上下文接线**（🟢 小）：`fullscreen.js` 已拿到的前台应用名 → 变成 mood 输入 +
     
   搭话题材。"你又在改那个 bug 了？" 比"在忙吗"强一个量级。
2. **长期记忆 v1**（🟢 中）：照 warashi 三层，**先只做 core memory（1500 字）+ 后台整合**，
     
   Phase 2 再上 FTS5。**不要上向量库**。注入位置照规矩 29 的"最外层"，与 mood / 复读护栏并列。
3. **model profile 自动扫描**（🟢 小）：脚本从 cdi3.json + physics3.json 自动生成档案骨架 +
     
   **能力覆盖率**，替代手工数 247 个参数；顺带标出"哪些参数是物理输出"（规矩 35）。
4. **Character Card 导入**（🟢 小）：支持 V2/V3 → 解决运行时换角色 + 白拿生态人设。
5. **药盒式一次性指令**（🟢 小）：托盘加"对下一句下指令"，用完即焚。
6. **MCP 客户端**（🟡 大）：让她能动手。⚠️ 先想清权限边界（文件系统/终端是高风险），
     
   建议**默认关 + 逐 server 授权**，照规矩 24（打扰类/占资源类默认不勾选）。
7. **语气基线**（🟡 中）：`speech.js` 顺手存能量/语速，与用户自身基线比较。
8. **主动时机升级**（🟡 中）：引入信息增益判据（没话找话就别开口）。

## 第 15 轮来源清单（全部经 api.github.com 核实存在）

```
https://github.com/DasterProkio/awesome-ai-companion         1063★ （生态地图，目录=checklist）
https://github.com/inni918/warashi                            120★ （三层长期记忆，最对口）
https://github.com/nanlingyin/soullink-emotion-sdk            168★ Apache-2.0（FACS/AU+覆盖率）
https://github.com/JianguSheng/yuns-desktop-pet               141★ MIT（MCP + 视觉分析）
https://github.com/ayangweb/BongoCat                        24166★ （跨平台桌宠工程规范）
https://github.com/OpenPetsHQ/openpets                       1330★ （插件 SDK 分层仓库）
https://github.com/LorisYounger/VPet                         7030★ （已参考过 A-B-C 交互）
https://github.com/morettt/my-neuro                          1396★
https://github.com/SlimeBoyOwO/LingChat                      2395★
https://github.com/jofizcd/Soul-of-Waifu                     1421★
https://github.com/ChaozhongLiu/DyberPet                     1006★ （PySide6 桌宠框架）
https://github.com/ClaraShafiq/jiwen                                 （mood 蓝本之一，已落地）
```

（同节收录、值得单列：revive-companion 泊松时机 / ears 语气基线 / gaze 屏幕感知 /
  
voice-familiarity 说话人 / OptMem 二叉树 / DuduLove 防重复 / pilulier 药盒 /
  
character-card-spec-v3 角色卡 / Hindsight 四路检索 / moraine-home 双方确认）

---

# 第 16 轮：surfcore / dsh-pet-indesktop 定向复盘（2026-10-28）

> 起因：用户点名两个仓库「有值得借鉴的吗」。本轮**只调研不执行**。
>
> 方法：`api.github.com/repos/<o>/<r>` 核元数据与 `default_branch` → `git/trees/main?recursive=1`
> 列全量文件树 → `raw.githubusercontent.com` 拉 README 与指定 guide（**不 clone、不读第三方源码**，
> 只读文档与协议）。两个仓库均核过存在、非 fork、未归档。

## 16.1 先纠正两个预期

1. **surfcore 不是桌宠**。它是 QQ ↔ DeepSeek Harness 的桥（原 `Derpyu520/qq-bridge`，3104★，仍在更），
   另带 B站 与一个**桌宠子系统**——但那子系统是「给外部桌宠用的胶水」（`host.json` 发现 +
   `host-token` + 回环 pet-api + `since`/`bootId` 长轮询），不是形象与渲染。21★、38 commits、
   2026-10-26 见库。
2. **dsh-pet-indesktop 是 11.3「不采用」的修正认知**。11.3 判 dsh-pet 族不采用的理由（序列帧/WebM
   路线）依然成立；但 MerZlin 这个 fork 已长到 **2549★ / v4.3.1（2026-10-17）**，工程纪律与几个
   具体机制**值得单记**——「用不用它的技术路线」与「抄不抄它的机制」是两件事。

## 16.2 🔴 surfcore：记忆卡（对我们 G19 最有用的一节）

`docs/guides/MEMORY_CARD.md` + `lib/pet-purpose.js`。两张卡分工：**衰减卡**（`memory-card.*`，唯一
注入提示词）与**全量档**（`memory-card-full.*`，永久保真、永不注入，只供检索/回忆）。

**A. 重要度 = 纯函数打分，不调模型**

`scoreMemory()`：基础 +8；主人私聊 **+42**、主人在群里 **+32**；直接对她说 +8；情绪浓度 +0~24
（强词 8/个、普通情绪词 3/个、感叹号 1）；「第一次/最早」**+30**（且与主人相关直接 100 并置顶）；
约定/承诺 +16；矛盾/道歉/和好 +14；关于自己 +5；太短 −12；夹 1~100。
`minOwnerImportance`（默认 65）以上的主人记忆**永不忘**，最差保持「清楚」。

→ 价值不在权重数字，在于**确定性**：可单测、可解释、可回滚，跟我们 mood 的 `step()` 同一路数。

**B. 四档清晰度，每天最多降一档**

```
vivid 清晰 → clear 清楚 → fuzzy 模糊 → trace 只剩印象 → 遗忘（删正文，只留 stats.forgotten 计数）
```

`targetClarity()`：`retention = importance + min(12, recallCount×2) + 最近加成(7 天内 +18 / 2 天内
被提到 +8) − 时间惩罚(过 fuzzyAfterDays 后每天 −0.35；主人重要记忆每天只 −0.12)`。
`pinned` / 第一次永远「清晰」；主人重要记忆 retention 有 55 下限。被再次提到会更新 `lastSeenAt` /
`recallCount`，次日可能回升一档（复习效应）。

🔴 **`forgetAfterDays`（默认 60 天）到期也不直接删**：目标设为「遗忘」，但仍每天走一档，
走完才真删。**离线多天会补跑连降，上限 30 天**，不会因为停机就停止遗忘。

→ 与规矩 34「离线补漂与实时 tick 同一个 step()」是同一类坑的同一套解法（别人独立验证过）。

**C. 「最初 / 初次相遇」是独立于「重要」的第二条轴**

只算与主人的互动，窗口 = 首次主人互动起 30 天，概率 `0–9 天 0.90 / 10–19 天 0.55 / 20–29 天 0.30 /
≥30 天 0.03`，且用记录 id 做**稳定散列**（不是每次随机）；命中者最差保持「清楚」，不参与容量压缩
与淘汰；渲染时单独成区（`## 初次相遇` / `## 最初的日子`），不与「重要」混排。

**D. 容量告警 80/90/100% + 一键压缩**，只作用于衰减卡；全量档软上限、永不自动删。

## 16.3 🔴 surfcore：主动搭话的两个工程细节

**A. 先记账，后生成**（`lib/pet-purpose.js:491-493`）

```
选完目的 → markPurposeDelivered 写「已投递计划」→ saveState
        → 调模型（几秒）→ 成功 applyPurposeOutcome('sent') / 失败 'failed' / 空 'silent' → 落盘
```

顺序是**刻意反直觉**的：先登记再花 token。进程在生成中途被杀，状态文件留下
`lastOutcome='pending'`，下次 `loadState()` 把它改判 `interrupted` 并把 `nextFireAt` 归零 ——
**不会出现「以为发了其实没发」**。我们现在是「成功才记账」，kill/断电会丢一次统计口径。

**B. 零副作用 preview**：`preview()` 真读素材、真算驱动、真选目的、真拼提示词，但**不投递、不写
状态、不调模型**。调闸门顺序时最省事。

**C. 载体（carrier）在包装层、引擎纯逻辑**：`purpose-engine.js` 全文不含 `carrier`/`modality`/`pet`
字样，QQ 与桌宠两侧各自 `return`；切换载体靠配置 + 各自 tick，不用重启进程。
→ 与我们的「依赖单向、注入 getter」同源，已符合。

**D. 具名 reason 表**：`busy / chat-disabled / carrier-qq / disabled / focus / llm / pet-offline /
no-material / no-purpose / llm-failed / silent / deliver-failed / error` —— 每个早退都有稳定名字。
我们 proactive 早退目前只写日志字符串，**具名 reason** 便于 verify 断言与用户可见解释。

## 16.4 dsh-pet-indesktop：主动识屏的完整参数（→ G2）

README「主动识屏陪伴」（Windows + Chat 版，**默认关闭**）＋「看看屏幕」：

- 触发：**白名单应用切换**（不是轮询屏幕内容）；闸门 = 停留时长门限 / 闲置判定 / 冷却间隔 /
  每日上限 / 免费模型优先 / **dry-run 验证模式**。
- 截图：**只在内存中压缩处理、直接发给视觉模型、不写本地文件、不保留副本**；最长边 **768px**、
  JPEG **70**；4 秒冷却防连点。
- 上下文：前台窗口「程序名 | 标题」一并送；结果用桌宠口吻一句话冒泡，**并回写一条
  `[看看屏幕] 前台窗口：…` 进当前会话**（可继续追问；聊天窗未开则只冒泡不写）。
- 计费口径：界面明写「每次都会按一次视觉模型请求计费，像素折算 + 输出 token」。
- Privacy 承诺可借的措辞：OCR **在本机子进程离线跑、用完即退，图片与识别结果不出本机**。

⚠️ 与 15.4 的 `gaze`（滚动 JSON 上下文）不是一个路子：它只做「切应用」这一个事件源，更省，
也更贴我们（`fullscreen.js` 已经在前台窗口上了，缺的正是这套闸门）。

## 16.5 dsh-pet-indesktop：只读 JSONL 的 agent 事件协议（→ 工作状态外扩）

`docs/AGENT_LINK_PROTOCOL.md`。纯本地文件追加写 + 增量读，**全程不访问外网**：

```
<config.dir>/agent-events/<agent>.jsonl
{"ts": 1750000000.0, "agent": "myagent", "event": "PreToolUse", "tool": "bash"}
{"ts": 1750000000.0, "agent": "myagent", "state": "working"}     // state 优先于 event
```

六态统一词汇：`thinking / working / attention / error / idle / sleeping`。
事件名映射兼容 Claude Code hooks：`SessionStart|SessionEnd→idle`、`UserPromptSubmit→thinking`、
`PreToolUse|PostToolUse→working`、`PostToolUseFailure|StopFailure→error`、`Stop|SubagentStop→attention`。

四条读方保证（review 时该问的就是这些）：
1. **byte-offset tail，不回放历史事件**；文件不存在时静默空转；半行缓冲不丢事件；单次读取有界 64KB。
2. **表外事件名一律忽略**（绝不默认当 working，防 transcript 类密集写入过度触发）。
3. 写方纪律：连续相同状态**不重复落盘**（重复行会占住换帧节流位）；>1MB **轮转只留一代**；
   写失败**静默放弃**（联动不能影响 Agent 本体）。
4. 隐私红线：只写状态/事件名/工具名，**不写代码内容、命令全文、文件内容、屏幕信息**。

→ 我们的「工作状态」已有同一层意思，但事件源是自己家的；补这条 = **任何能往文件追加一行的
Agent 都能驱动她**（零代码接入、默认关、天然 fail-open），正好接上 11.11 的 WorkBuddy 钩子情报。

## 16.6 dsh-pet-indesktop：三个小件

- 🔴 **置顶看门狗**：Windows 上 explorer 重启、分辨率/DPI 变更、休眠唤醒**会偶发丢置顶**，它每
  **30 秒**自检、丢了就重置。我们的开发窗口没出过，但用户机器上「她突然被别的窗口盖住」很可能
  就是这个 —— **成本半天，先量再决定**。
- **入口不可用就置灰 + 行内写明原因**：找不到的播放器条目置灰并写「未找到，可在此手填路径」；
  「自动检测」每点一次都重搜、本次没扫完的行显示「未完成」而不是「没找到」；手填路径**以它为准**，
  文件不存在就如实报错、**不偷偷回退自动搜索**。→ 规矩 24「开关关掉不许点了没反应」的实现细则。
- **隐藏时 CPU≈0**：隐藏即暂停动画解码与活动定时器。我们全屏静默已降到 1fps，思路一致。

## 16.7 明确不搬（定位冲突，不是质量问题）

可编排右键菜单 + 实时预览、多宠孵化（单进程多窗 + 共享解码链）、四个音乐播放器入口、DeepSeek
余额、每日一签、歌词对齐、节日提醒、抓帧率（presentmon）。它在一只桌宠上堆了 7 个以上功能域，
与「安静陪伴 + 两个菜单都要短」（规矩 5）正面冲突。

工程纪律层面可对照补的只有一条：它把**行数预算做成 `tests/test_architecture.py` 机器守卫**
（`window.py` 处于「只许瘦不许胖」公约下）。我们的 `verify-*.js` 已是同类，可考虑补一条
**main.js 体量断言**。

## 16.8 许可与可信度备注

| 仓库 | 许可 | 备注 |
|---|---|---|
| Mieksido/surfcore | **`NOASSERTION`**（非标准开源协议；另有 RULES.md 谈第三方 EULA） | **只看文档、不搬代码**，引用思路也要注明来源 |
| MerZlin/dsh-pet-indesktop | **MIT**（代码）＋ `THIRD_PARTY_NOTICES.md`（素材/二进制） | 代码可参考，**素材不可搬**（WebM 来自上游项目） |

两个都**不影响主线**：不改 Electron → Tauri 迁壳优先级，也不改「单模型 + 安静陪伴」定位。

## 16.9 本轮结论（按性价比）

1. **G19 记忆 Phase2**：抄「四档清晰度 + 每天一档 + 离线补跑 + 重要度纯函数 + 初遇独立轴」这一整套
   —— 本轮最大收获，且与我们既有的 mood/衰减层同构，不引入新范式。
2. **proactive「先记账后生成」+ 具名 reason + 零副作用 preview**（半天到一天，改动在搭话路径，
   不动渲染层）。
3. **G2 屏幕上下文**：拿它的闸门与隐私口径（768 / JPEG70 / 内存不落盘 / 4s 冷却 / 每日上限 / dry-run）。
4. **工作状态外扩**：只读 JSONL（六态 + 表外忽略 + 静默失败 + 轮转）。
5. **置顶看门狗**：先量有没有丢置顶，再决定要不要那 30 秒自检。

## 第 16 轮来源清单（全部经 api.github.com 核实存在）

```
https://github.com/Mieksido/surfcore                            21★  NOASSERTION（QQ↔DSH 桥 + 桌宠胶水）
  docs/guides/MEMORY_CARD.md           记忆卡：评分 / 四档清晰度 / 遗忘 / 容量
  docs/guides/SUBSYSTEM-PET.md         桌宠子系统：闸门顺序 / 先记账后生成 / preview
  docs/guides/BOUNDARIES.md            能力边界与不承诺清单
https://github.com/MerZlin/dsh-pet-indesktop                  2549★ MIT（PySide6 + WebM，v4.3.1）
  README.md                            主动识屏参数 / 看看屏幕 / 已知限制 / 性能与内存
  docs/AGENT_LINK_PROTOCOL.md          只读 JSONL 六态事件协议
上游（仅核对存在）：
https://github.com/Derpyu520/qq-bridge                        3104★（surfcore 的桥代码来源）
https://github.com/PC2005-cloud/dsh-pet                       4523★（dsh-pet-indesktop 的上游）
```

---

# 第 17 轮：挂件↔大脑桥接、说话闸门、上下文游标（2026-10-29）

> 起因：用户甩来五个 GitHub 链接问"有什么值得借鉴的"。**本轮只调研，未写任何产品代码**。
> 全部经 `api.github.com` 核了仓库存在、默认分支、文件树、README 与 **LICENSE 原文**（不是 spdx 标签，见 §17.8）。

| 仓库 | ★ | 许可（**读 LICENSE 原文**） | 是什么 |
|---|---|---|---|
| `Atoll92/agent-standup` | 332 | MIT | 只读 Claude Code / Codex / Vibe **已经写好的本地会话文件**，零 token 渲染成"团队电话会议"动画 |
| `MerZlin/dsh-pet-indesktop` | 2679 | **MIT**（第 16 轮已知） | Python/PySide6 桌宠巨兽；本轮看的是**新出来的**发行/接入结构 |
| `TCX123-a/MiAiCoding` | 105 | **MIT**（GitHub 标 `NOASSERTION`，误判） | Electron+Vue 编程学习桌面端，内嵌一只桌宠 |
| `Yuuyuko-uu/dsh-fish-buddy` | 4 | MIT | 小鲸鱼挂件 + DSH 插件：听/看/说 + 陪看字幕 + 弹幕 + 截图 → 桥进 LLM 会话 |
| `vvolhejn/samuel` | 120 | **GPL-3.0** | Pink Trombone 声道模型 + 从语音学嘴型 |

## 17.1 dsh-pet：原有结论之外的**新**结构

第 16 轮已借走"识屏闸门 / 只读 JSONL 六态 / 置顶看门狗"。本轮补的是它**后来新长出**的三样：

**① `packs-index.json` —— 角色包分发清单（→ 对照我们的 `models.zip`）**
`schema` 版本 + 每 part 的 `bytes` / `unpacked_bytes` / **`sha256`** + **三个 URL**（官方 Release / `mirror.ghproxy.com` / `gh-proxy.com`）+ **`app_min`（最低宿主版本）** + `pipeline` / `format` 字段。
→ 我们 Release 里挂的那个 `models.zip` 现在**既没校验也没镜像**。这套字段可以直接照搬，`sha256` + 多镜像对国内下载体感差别很大。

**② `integrations/{dsh-pet-bridge, hermes-pet-bridge}` + `docs/AGENT_LINK_*`**
桥有两套（自家 / hermes）。协议细节见 §16.5，本轮新增的事实是它在 **2026-10 做过一次减法**：删掉了 mux 订阅与 `/api/respond` 等交互回写，**审批/提问不再由桌宠受理**，回到宿主 UI 完成 → **纯单向**。

**③ `android/` + `docs/ANDROID.md`** —— 它已经有一份安卓端口。暂与我们无关，记一笔：Electron 壳的迁移论证（`docs/tauri-migration.md`）将来可以对照它多端化的成本。

## 17.2 🔴 fish-buddy：字幕白板「游标式投递」（→ backlog ① 屏幕上下文 / ② 长期记忆）

最高价值的一条。它的注释里连改版动机都写了，等于把决策过程摊开给你看。

**0.0.9（2026-10-26）的关键反转：从"按时间窗截一段"改成队列 + 游标。**
- 每条字幕进队时取一个递增**序号**；白板只拼 `序号 > 已发到` 的那些；**只有 `turn/end` 真正到来，才把游标推到本轮拼到的位置**。
- 原话列的三条好处：中间隔一小时没说话也不丢句；同一句不会被塞两遍；全程本地数字运算**零 token**。外加 README 那句：**不写进对话历史，所以上下文不会越看越厚**。
- 常量：`队列上限 = 400`（再多从最旧的丢，并记「丢了 N 句」）、`单轮最多 = 80`。
- 1.1.1：陪看停了 → 清空积压，但**只清内容不重置序号**（游标跟着 `下一条` 走，否则下一轮会把旧的当成新的再发一遍）。

⚠️ **它踩过的坑，我们照抄时能免**：白板**必须用 `context()`，不能用 `section()`** —— `section` 会进系统提示词并被宿主做 `{{…}}` 变量替换，而台词和代码片段里出现 `{{` 就炸。
⚠️ **它自己的文档漂移**：README 写"最近 90 秒、最多 40 句"，代码里是 `400 / 80`。**以代码为准** —— 这是规矩 22 的反面教材。

→ 落点：backlog ① 接通"她在看什么"时，别用"塞最近 N 条进 system prompt"，用**队列 + 游标 + turn/end 推进**。

## 17.3 🔴 fish-buddy：`要搭话()` —— backlog ⑧ 缺的那条判据

它改了三版，每版都注明了为什么：

1. 固定间隔 → **1.0.3**："固定 30 秒会显得很规律" → ±35% 抖动
2. → **0.2.4（2026-10-27）**：还是太规律 → **区间真随机**：下限 = 设定值（最少 5s），上限 = `max(下限×4, 120s)`
3. **1.0.3**：`turn/end` 一到就**重置计时器** —— 否则"她刚回完一句、紧接着又到点自己说一句"，听起来像在自言自语

四条硬条件（缺一不可）：开关开着 · **`有字幕在流`（注释原话："不对着黑屏说话"）** · 距上次够久 · 骰子掷中。
另有 `冷却最短秒 60 / 最长秒 150`（两条自发消息之间，每次在区间内重掷）、`安静秒 8`（算她没在说话 → 截图直接发）。
`要搭话(o)` 是**纯函数**，靠传 `浮` 参数让测试拿到确定值 —— 跟我们 `verify-*` 的写法同一套路。

→ 🔑 **"有字幕在流才开口"就是 backlog ⑧「主动时机加信息增益」的那条判据**，人家已经落地验证了三版。

**顺带记下它的协议与 self-report 边界**（好事，省我们自己编）：
`POST 127.0.0.1:8777/hands/say {"text"}` → 送进绑定会话；回话 `POST <回调>` 但**只递「挂件叫起来的那一轮」**（你在宿主里自己聊的不回推）；已知边界三条：端口启动时定死要重启、**会话得在宿主里打开过一次**否则找不到、每送一句 = 一轮模型请求 = 花额度所以**别做成一句一塞的刷屏**。

## 17.4 🔴 MiAiCoding `src/main/dshpet/say-gate.ts` —— 给「搭话三道闸」补两条

这个文件是我们现有做法的**第三方独立印证**，另外多出两条我们没做：

- **闸门必须收敛到所有写方的唯一实现**（它的修正案 C2：只包 `sayText` 会漏掉 `whisper/plead` 那条路，于是把两个写方收敛进 `writeSayLeaf()`）——对应我们的规矩 27。
- **判定逻辑单独成文件、不 import electron**，理由是"host.ts 顶层 import electron，vitest 进不来 → 判据只有真机探针没有机器证据"。**这正是 `wheel-geom.js` / `bubble-menu-geom.js` 的同一动机，这次在别人仓库里撞见了同一答案。**
- 🟢 **fail-open + 记账：读不到读数（`vitals` 叶子还没写过）⇒ 放行 + 留一行日志。** 原话："桌宠突然变哑巴比多说一句糟得多"，而那行日志要抓的是**「以为闸门在保护、其实从没生效」这种假绿** —— 就是我们反复讲的负对照。
- **白名单逐格给来源**（不许"顺手加几个"），四类：契约点名 / 被既有测试钉死的语义 / 已付钱的回应（**正在路上的回复被静默 = 白烧用户的 token**）/ 对用户动作的**即时应答**（应答 ≠ 主动出声）。并且把**反例也写清**：`spin`（连学彩蛋，庆祝性质）与 `nag/nuzzle`（主动催饭）**不在**名单里。

→ 我们的三道闸（`quietHours` / `maxUnanswered` / `media`）建议加一条：**读数取不到 → 放行 + 记账**。

## 17.5 MiAiCoding：需求数值经济（**可选项，有气质风险**）

`src/main/pet/store.ts` + `src/main/rewards/` 撑起喂食 / 饱腹度 / 好感度 / 跑腿 / 大白饭经济。这是"桌宠为什么值得天天打开"的那一层，我们目前**完全没有**。
⚠️ 但它的母体是学习 App（"你刚干了活，这是回执"），搬到我们这儿就变成"她记账" —— 跟"安静陪伴 + 她不作弊"的气质有张力。真要加，得把数值**接到 `mood` 的 valence/energy 上**，不能让她开始要饭。

## 17.6 agent-standup：只借两点，别看它的 UI

它 ~335 个文件里大半是视频/品牌/商业售卖，**跟桌宠无关**。有价值的两条：

1. **`attention` 这一档的最强信号是"向你提问 / 等待审批"** —— 它据此做出 "who needs you"。我们的 `workState` 现在只有对话生命周期那几档，**没有这一档，而它最值钱**。这也是 `agent-standup-band`（只读 `~/.claude/sessions`、**零 Node 依赖、不发包**）唯一做的事 —— 轻量版可以先做。
2. **闪避而非拦截**：背景音乐在角色说话时淡出、说完淡回。我们的 `media` 现在是"Playing → 主动搭话延后 30s"。淡出更好听，也更符合"她在同一间屋子里"的设定。

## 17.7 samuel：GAP 思路存档，现在不做

`video → 声道参数` 的学习式口型。我们只有一个 `P.MOUTH_OPEN`、多跑一个 Python 服务、还是 **GPL-3.0** → 现在算不过来。等哪天真要做口型，先读他两篇博客（2026-08-17 怎么做模型、2026-10-22 怎么做 TTS），**代码别碰**。

## 17.8 许可核对：本轮最重要的方法教训

| 仓库 | GitHub `spdx_id` | **LICENSE 原文第一行** | 结论 |
|---|---|---|---|
| MiAiCoding | `NOASSERTION` | `MIT License / Copyright (c) 2026 miai` | **可搬**（注意 `LICENSES/` 里有第三方 MPL-2.0） |
| dsh-pet-indesktop | MIT | MIT | 代码可搬、素材另论（第 16 轮已记） |
| fish-buddy | MIT | MIT | 可搬，**但 `app/assets/` 角色图/气泡框/弹幕框作者明说"不单独授权二次使用"**（内含 PP-OCRv6 = Apache-2.0、站酷快乐体免费商用）→ **借机制，别碰图** |
| agent-standup | MIT | MIT | 可搬，但没什么可搬 |
| samuel | GPL-3.0 | GNU GPL v3 | **只读不搬** |

🔑 **GitHub 的 `license.spdx_id` 会误判为 `NOASSERTION`。以后涉及"能不能搬代码"，一律 `GET /repos/{o}/{r}/contents/LICENSE` 读全文第一行**，不以 API 摘要字段为准。（这正是用户那条"两个来源互相矛盾"的抓法：_FILE 说 MIT，API 字段说没有 —— 矛盾本身就是信号。）

## 17.9 本轮结论（按性价比）

1. **① 给 ayan-3d 大脑定传输层** —— 照 dsh-pet 的 JSONL 单向总线（第 16 轮 §16.5）+ 本轮新知的"2026-10 减法后纯单向"。**先把 `attention` 这一档补进 `workState`**。
2. **② `要搭话()` 落到 `proactive`** —— 区间真随机 + **"有内容才说"** + `turn/end` 重置计时；同时按 §17.4 给三道闸加 **fail-open 记账**。
3. **③ 白板游标** —— 排在①通了之后才有意义。
4. **`packs-index` 的字段抄进我们的 `models.zip`** —— 半天，独立可做。
5. §17.5 需求经济**先不做**（气质风险）；§17.7 samuel **不做**。

> ⚠️ 与第 16 轮 §16.7 的关系：那一节把 dsh-pet 的**产品功能**"可编排右键菜单 + 实时预览"列进"明确不搬"（与规矩 5「两个菜单都要短」正面冲突）。本轮发现的 `docs/CONTEXT-MENU-RESEARCH-AND-REFACTOR-2026-08-25.md` 是它的**调研/工程记录**，不是那个功能本身 —— 其中引了 Apple HIG 与 Windows 菜单指南两条转述值得我们看："只为高频、标准或能清楚表达的命令用图标；含义模糊的图标增加视觉噪声，宁可不显示""相似命令组用一个引导图标，不要给每个相似条目重复相同图标"。**参考价值≠搬功能，这条边界别混。**

## 第 17 轮来源清单（全部经 api.github.com 核实存在，含 default_branch / 文件树 / LICENSE 原文）

```
https://github.com/Atoll92/agent-standup                       332★  MIT   v1.42.0
  README.md                      零 token / 只读 ~/.claude/sessions、~/.codex/sessions、~/.vibe/logs/session
  plugin-band/                   只读 sessions 的轻量版，无 Node、不发包
https://github.com/MerZlin/dsh-pet-indesktop                  2679★  MIT
  packs-index.json               角色包分发清单（sha256 + 三镜像 + app_min）
  integrations/dsh-pet-bridge/   自家桥插件
  integrations/hermes-pet-bridge/ hermes 桥插件
  android/ + docs/ANDROID.md     安卓端口
  docs/CONTEXT-MENU-RESEARCH-AND-REFACTOR-2026-08-25.md  菜单图标/分组调研 + 双模板→单模板退役记录
https://github.com/TCX123-a/MiAiCoding                        105★  MIT（API 标 NOASSERTION）
  src/main/dshpet/say-gate.ts    归零静默闸门 + 白名单四类来源 + fail-open
  src/main/pet/store.ts          需求数值（喂食/饱腹度/好感度）
  src/main/rewards/              奖励回执
  build/dshpet-patch.mjs         vendor 第三方桌宠引擎的方式（带测试）
https://github.com/Yuuyuko-uu/dsh-fish-buddy                    4★  MIT
  lib/host.js                    字幕白板（游标式）/ 要搭话() / 配置默认值
  lib/client.js                  挂件侧对接
  app/{ear,ocr,watch_ui,danmaku,ball,bubble}.py  语音 / OCR / 陪看 / 弹幕 / 球 / 气泡
  tests/宿主半边.mjs             18 项，真起 http 口子发请求，不碰真实宿主
https://github.com/vvolhejn/samuel                            120★  GPL-3.0
  README.md + Pink-Trombone/     声道模型；pocket-tts/ = Kyutai Pocket TTS（MIT）
  博客 2026-08-17（怎么做模型）/ 2026-10-22（怎么做 TTS）
```

---

# 第 18 轮：`PC2005-cloud/dsh-pet` —— 106 段视频动画是怎么「组合」的（2026-10-29）

> 起因：用户「感觉这个宠物方案也不错，**每个动作表情都是一个动画，还能组合起来**」。
> **只调研，未改产品代码。** 全部经 `api.github.com` + raw 核实：`default_branch=main`、4733★ / 361 fork、
> 794 个 blob、`package.json` v0.3.8、**106 个 `.webm` 合计 51.8MB（均 501KB，194KB–1.3MB）**、整仓 136MB。
> ⚠️ **别和 `MerZlin/dsh-pet-indesktop`（2679★，Python/PySide6）混**：同名不同源，第 16/17 轮引的是后者。

## 18.1 先纠正一个直觉：它的「组合」在时间轴上，不在画面上

- 每段动画 = **一整只角色的 10 秒视频**（640×360 VP9-alpha webm）。片段之间只有「换源」，**没有图层叠加**。
- `src/client/pet/animation/animation.ts`：A/B **双缓冲**，两个 `<video>` 轮流当前台，`loadeddata` 后 swap，
  旧元素摘 `is-front` + 清 `onended` + `pause()`。
- 所以做不到「边走路边挥手」：`moves` 池里的「螃蟹走路」**本身就是一段带腿的完整动作**；
  「走路 + 挥手」只能再生成一段。**动作数 O(N)，不是 O(N×M)**。
- 真正的「叠加」只有**程序化变换**：Q 弹 `src/client/pet/motion/squash.ts`、抛掷 `motion/flight.ts`、
  走位 `motion/walk.ts`、`scaleX(-1)` 镜像 —— 套在视频元素上的 transform，不改片段内容。
- 🔴 **代价：表情不是独立维度。** 它没有「微笑 / 生气」参数，表情烘在片段里 →
  「生气 + 挥手」也得单出一段。我们「16 字段 × 8 情绪 + `EMO_SPEED` 错峰插值」那套连续表情，这条路给不了。

> 一句话：**它用「表情不可组合」换来「素材线性增长」**。这正是「状态爆炸」没发生的原因，
> 也是我们不能直接照搬的原因（→ §18.6）。

## 18.2 最值得抄的一层：配置即调度（`dsh-pet/assets/config.jsonc` 241–361 行）

| 池 | 约定（原文要点） |
|---|---|
| `idle` | 待机池，等概率抽 |
| `turn` | **每一项都必须是「播完会翻转朝向」的动画** → 转向靠 `facing` 镜像，没有真转身 |
| `drag` | 每项必须是「被无形抓起悬空」的姿势 |
| `clicks` | 点击回应，5 段随机 |
| `moves` | `default{minDist,maxDist,margin,leadSec,tailSec}` + 每动作 `params` 覆盖；距离以「基准宠物宽 462px」等比缩放 |
| `categories` | 5 类：小动作 20 / 玩耍 20 / 吃什么 16 / 时节 14 / 文字 10；`noMirror` 标「带文字、镜像会颠倒」 |
| `events.balance` | 6 档，`index = p===100 ? 5 : ⌊p/20⌋` |
| `events.workStatus` | 6 档 = thinking / working / result / waiting / success / error，🔴 **「只可追加到末尾」**（中间插档会让已生效配置档位错位） |
| `events.whisper` | 3 段，按 `eventsRefreshSec.whisper` 周期抽 |

**权重**：`animationWeights{idle:10, turn:5, move:5}` + 分类 weight 合计 = 100；
`fixedEnabled`（宠物固定）时 turn/move 权重按 0 算、份额**自然**落到小动作 —— **不做归一化**，idle 绝对概率原样不动。

**播完决策是纯函数**，两端共用同一份（浏览器半侧 + Electron helper 不会分叉）：
- `src/shared/pickers.ts`：`pick` / `pickSlot` / `poolIncludes` / `rollKind` / `pickWeightedCategory`。
  细节值得学：排除当前避免连抽，**排除后池空则退回原池**（宁可重复也不返回 undefined）。
- `animation/cues.ts`：`decideEndedCue` → `work-rotate`（档内换下一个候选）/ `work-replay` / `event-done` /
  `turn` / `interaction-done` / `random`。
- `animation/next-animation.ts`：掷骰结果 + 走位尝试 → 「切哪个动画、日志算什么类别」，**不碰 ref、不 setState**。

## 18.3 素材规约比代码更硬（`prompts/桌面宠物 10 秒动作提示词.md`）

- 全库统一构图常数：头顶 **20%** / 脚底 **85%** / 左右 **25%–75%** / 任意一边安全距 **10%**。
- **首帧与第 10 秒必须回到同一张标准正面站立**，道具「无→有→无」闭环 → 循环衔接才不闪。
- ⚠️ 这是**提示词工程锁死的，不是代码保证的**；10 秒是硬规约，片段长度不一致就没法对称。
- 管线（`MAKE-YOUR-OWN-PET.md`）：绿幕 mp4 → 水印遮罩 → HSV 抠像（**作者全部改走 PR 手工遮罩**）→
  归一化 2160×1215 → 640×360 → webm。106 段手工。
- Safari/WKWebView **不认 webm alpha → 黑底**，得单独发布 HEVC-with-Alpha `.mov`（`scripts/encode_hevc_alpha.sh`）+ 另一个 Release tag。

## 18.4 工程细节（小而硬，都能对上我们的实现）

1. **`loadeddata` ≠ 开始出画**，要等 `play()` 兑现才回 `playing`。
2. **`ended` 只认 `is-front` 元素** —— 后台元素残留的 `onended` 会掐断当前动画，换源时先清 handler。
3. 加载失败 / 超时（10s）**必须释放 pending**，否则防重分支（同目标直接 return）把它永久吞掉 = **「点了没反应」**。
4. 换源走 `fetch → blob`（`asset-loader.ts`），绕开 `<video>` 流式加载在自家 WebServer 上的 stalled；
   blob 按槽位释放，**迟到的加载结果按世代号丢弃**（与我们规矩 16 的代际令牌同构）。

## 18.5 代价 / 不适合我们的地方

- 素材 51.8MB（我们模型几 MB）；加一段动作 = 一次 AI 生成 + 一次人工抠像，不是改参数。
- 无独立表情、无视线跟随、无真转身（只正面 + 镜像）、无口型（我们 TTS 有 `verify-lip`）。
- 与「对话时按情绪插值」正面冲突：它换表情 = 换整段视频。
- 🔴 **许可**：代码 MIT；**素材（动画 / 提示词 / 源视频）「允许开源使用、禁止商用」；形象 CC BY-NC-SA 4.0**
  （README「许可」段原文）。→ **一行素材都不能进我们的包，只有 MIT 的工程结构可借**（规矩 29）。

## 18.6 🔴 订正 `docs/custom-model-plan.md` §10.2 的 D 行

上一轮把「D. 序列帧 / WebM」判成「已批判（状态爆炸）」。**这个判据不完整**：
它没有在状态上爆炸，是因为**放弃了表情维度**（§18.1）。D 路线真正的判据是：

> **「是否需要一个足够大的状态空间（表情 × 动作 × 朝向 × 口型）」**
> - 需要 → 视频方案 O(N×M) 必爆，维持排除；
> - 只要动作（表情烘死）→ 视频方案完全成立，作者已用它做到 106 段。

我们属于前者（16×8 情绪 + 视线 + 口型 + 摸头 A-B-C 全是参数级）→ **结论不变，但理由要换掉**。

## 18.7 本轮结论（按性价比）

1. **抄调度层（立刻可做）**：动作池 + 权重掷骰 + 事件档位数组 + `decideEndedCue` 式纯函数。
   落地形态：`profiles/<m>.js` 旁加一段 `animations`，`motion.js` 的随机动作从 if/else 改成读池；
   `workState` 六态**索引即档位、新档只追加到末尾**（正好接 backlog 里待补的 `attention` 档）。
2. **素材链存档为「第二交付路线」**：`custom-model-plan` §11 的降档路线里，这条比「AI 生成 PSD 再 rig」成熟 ——
   20 段核心动作（idle / turn / drag / click×5 / 工作状态×6）≈10MB 就能撑起一个可用形象。**但产品线不换**。
3. **§18.4 的四条**对着我们的实现核一遍，至少 2、3 两条（「点了没反应」同族）。
4. **不搬**：Q 弹 / 抛掷（我们已有）、右键菜单点播（规矩 5/20 已定稿卡片菜单）、多开宠物互撞（无需求）。

## 第 18 轮来源清单（全部经 api.github.com 核实）

```
https://github.com/PC2005-cloud/dsh-pet                4733★  代码 MIT / 素材禁商用 / 形象 CC BY-NC-SA 4.0
  dsh-pet/assets/config.jsonc            动画池 + 权重 + 事件档位（241-361 行）
  dsh-pet/src/shared/pickers.ts          池抽取 / 权重掷骰 / 档内轮换（双端共用）
  dsh-pet/src/client/pet/animation/animation.ts   A/B 双缓冲换源 + 世代号 + 点播回执
  dsh-pet/src/client/pet/animation/cues.ts       decideEndedCue（播完分支纯函数）
  dsh-pet/src/client/pet/animation/next-animation.ts  掷骰 → 下一个动画
  dsh-pet/src/client/pet/card/motion.ts   Q 弹 / 抛掷 / 走位 装配（= 唯一的「叠加」层）
  dsh-pet/assets/webm/*.webm             106 段 10s 透明动画，51.8MB
  prompts/桌面宠物 10 秒动作提示词.md      构图常数 + 首尾同帧 + 按秒分解
  MAKE-YOUR-OWN-PET.md                   绿幕→抠像→归一化→webm 全流程
```

---

# 19. WorkBuddy 模型接入（2026-10-29，第 19 轮）

> 触发：用户给出三个 DSH 插件（`dsh-workbuddy` / `dsh-workbuddy-bridge` /
> `dsh-llm-workbuddy`）与一个 Cursor 插件组，问「能不能把 WorkBuddy 的模型也接到项目里」。
> ⚠️ 用户给的共享目录（`\\huai_xin\dsh-workbuddy`、`\\xytoki\dsh-cursor-agent`）本机**不可达**
> （`net view` 系统错误 53，主机 ping 不通）→ 结论全部来自**公开仓库源码**。

## 19.1 三条路线，机制各不相同

| 路线 | 怎么拿到"能用的凭据" | 对我们可行吗 |
|---|---|---|
| 插件内**重新登录** WorkBuddy 账号（消耗账号积分） | 插件自己跑 OAuth，token 存它自己的 vault | 可行但要内嵌登录流程（窗口 + 令牌存储），且属"用账号额度"的产品决策 |
| **复用桌面 App 登录态**（桥接） | 读 WorkBuddy 桌面 App 已登录的 token（vault / 凭据库） | 最贴合我们（本地 Electron 桌宠），但**令牌存放位置要读源码确认** |
| 依赖第三方代理 `workbuddy2api` 转协议 | 代理把账号变 OpenAI 兼容端点 | 可行，但多一个常驻进程 + 配置复杂度 |

公开仓库给出的硬事实（`Axiaohungry/dsh-llm-workbuddy`，MIT）：
- 网关：`BASE_URL = https://copilot.tencent.com/v2/plugin`
- 请求头伪装成 CodeBuddy CLI：`user-agent: CLI/<ver> CodeBuddy/<ver>`、`x-product: SaaS`、
  `x-ide-type: CLI`、`x-ide-name: CodeBuddy`、`x-ide-version`；企业账号另加 `X-Enterprise-Id` / `X-Tenant-Id`
- 大陆站与国际站**不通用**（`www.workbuddy.ai` 的 token 打 `copilot.tencent.com` 会 401）
- `dingminhua/dsh-connect-workbuddy`（802★，MIT）走的是"区域优先、新鲜度其次"的凭据挑选，
  并且明确写了 `expiresAt` **不可信**（上游撤销 token 时不会改这个字段）→ 不能按过期时间排序选账号

## 19.2 我们能直接用的那一半（已实现）

WorkBuddy 的**自定义模型**文件是官方文档写明的明文位置：

```
~/.workbuddy/models.json
{ "models": [ { "id": "<模型id>", "name": "...", "vendor": "...",
                "apiKey": "sk-... 或 ${ENV}", "url": "https://host/v1/chat/completions" } ] }
```

- `url` 是**完整接口路径**（不是 baseUrl）→ 导入时必须反剥 `/chat/completions`，
  且**先吃尾斜杠再判后缀**（否则 `…/chat/completions/` 会拼出 `…/chat/completions/chat/completions`）。
- `apiKey` 支持 `${ENV}` 引用 → 我们**不解析**，原样搬（解析就要在进程里持有密钥）。
- 本机这份现在是 `[]`（用户没配自定义模型）→ 菜单里那一条显示为"没有模型"。

配套做了两件**静默失败**型的事（都是踩出来的）：

1. **本地端点免 key**（backlog M1）：旧判定看 `apiKey` 是否为空，选 Ollama/LM Studio 后
   聊天还能通（本地不用 key），但 `proactive` 会一直走预置台词、`memory.extractViaLlm` 永远跳过。
   现在统一走 `isUsable({baseUrl, apiKey})`：**有 key 或端点在本机**才算可用；
   判定只此一处（`llm-providers.js`），主进程与渲染层共用（渲染层拿 `config:get` 的派生字段 `llm.usable`）。
2. **预设一键填**（M2）：9 条 OpenAI 兼容预设（DeepSeek / 通义 / 智谱 / Kimi / 硅基流动 /
   OpenRouter / Ollama / LM Studio / 自定义）。切预设只写 `provider + baseUrl + model`，
   **绝不动已填的 apiKey**；旧配置没有 `provider` 字段 → 按 baseUrl 反查该打勾的那条。

## 19.3 没做的那一半（要单独拍板）

- **账号直连（消耗 WorkBuddy 积分）**：需要①内嵌登录或读桌面 App 的令牌库
  ②伪装 CodeBuddy CLI 的请求头 ③区分大陆/国际区。这属于"借用户账号额度"，
  且请求头伪装是**对着别人的非公开接口**做的，有失效与条款风险 —— 与 Cursor 那条
  「社区逆向协议」的自述同类。**未实现，等用户显式拍板**。
- 真要做的第一步：把用户那两个共享目录复制进工作区（`debug/ref/`），
  按源码确认「桌面 App 的登录态存在哪个文件、怎么解、token 怎么刷新」，再决定要不要碰。

## 19.4 来源

```
https://github.com/dingminhua/dsh-connect-workbuddy      802★ MIT（凭据挑选 / 区域优先 / 额度只读）
https://github.com/Axiaohungry/dsh-llm-workbuddy          88★ MIT（网关地址 + CLI 请求头 + models.json 用法）
https://www.workbuddy.cn/docs/cli/models                 models.json 官方 schema（url 是完整路径）
https://github.com/linguo2625469/workbuddy2api-panel    4609★（账号池转 OpenAI 兼容网关，第三方代理路线）
```

---

# 20. AstrBot / NapCat / 语音网关调研（2026-10-30，第 20 轮）

> 触发：用户甩了四条链接问「有没有值得参考的」。
> 🔴 本轮最重要的收获是**许可核查**，不是技术：两个高星项目**不能碰**。

## 20.1 许可核查（规矩 29 的直接命中）

| 仓库 | star | GitHub API 标注 | LICENSE 第一行/实质 | 结论 |
|---|---|---|---|---|
| `AstrBotDevs/AstrBot` | 44767 | AGPL-3.0 | AGPL-3.0 | ⚠️ **强传染**，抄码要求整个项目 AGPL |
| `AstrBotDevs/astrbot-launcher` | 2425 | MIT | MIT | ✅ 可用（但无参考价值） |
| `NapNeko/NapCatQQ` | **11969** | `NOASSERTION` | **Limited Redistribution License** | 🚫 **禁止** |
| `InariNGT-Ofiicial/gsv-rvc-voice-bridge` | 1 | MIT | MIT | ✅ 可用 |
| `InariNGT-Ofiicial/astrbot_plugin_gsv_rvc_voice` | 1 | MIT | MIT | ✅ 可用 |
| `Him666233/astrbot_plugin_group_chat_plus` | 191 | AGPL-3.0 | AGPL-3.0 | ⚠️ 只借设计，不搬码 |

### NapCat 的许可原文（11969★ 但**不是开源**）

```
Limited Redistribution License for NapCat
Copyright © 2024 Mlikiowa

1. Usage and Reproduction:
   - Unauthorized use, reproduction, modification, or distribution of this code
     is prohibited without explicit permission from the main author.
2. Redistribution:
   - Redistribution of this code is permitted, provided that the full text of
     this license is included, and the source and copyright information is
   clearly stated.
   - Minor modifications and extensions are allowed for redistribution purposes,
     but the modified code must not be publicly released.
3. Non-Commercial Use: ...
```

🔴 **条款 2 明确「修改后的代码不得公开发布」**。我们仓库是 public 的 →
一旦带上它的代码或改过的副本就是违规。再加上它是**逆向 NTQQ 协议**的
协议端，本身踩在平台条款灰色地带。

> 这条再次坐实规矩 29 的价值：GitHub REST 给的 `spdx_id` **只给 `NOASSERTION`**，
> 而实际是一份限制再分发的自定义许可。**11969★ 不等于可以自由使用**。

## 20.2 唯一值得落地的：gsv-rvc-voice-bridge 的「本地网关 + OpenAI 兼容端点」

**它做了什么**：把两个 Python 推理服务串成一条链，对外伪装成 OpenAI 语音接口。

```
GPT-SoVITS (127.0.0.1:9881)  生成源语音
        ↓
RVC (127.0.0.1:8789, 模型常驻)  转换音色
        ↓
网关 (127.0.0.1:8790)
  POST /say              → JSON：音频绝对路径 / 格式 / 时长 / 分段耗时
  POST /v1/audio/speech  → WAV 字节      ← OpenAI TTS 兼容
  GET  /v1/models        → 当前模型 ID
  GET  /health           → 网关与上游存活
```

**对我们的价值**：桌宠现在的 TTS 是 **WinRT 系统语音**（`src/renderer/tts.js`
双引擎）。这套网关模式意味着——

> 只要给 TTS 加一个 **OpenAI 兼容 provider**（`tts.provider='openai'`，
> baseUrl 指向网关 `/v1`），她就能用**自己的角色音色**说话，
> 且**不需要在 Electron 里跑任何 Python 环境**。

这跟第 19 轮刚做完的 `llm-providers.js` 是**同一套模式**（预设 + baseUrl +
apiKey + 一键测试），照抄结构即可，成本很低。

**它自曝的边界也值得抄（都是工程教训不是缺陷）**：
- 网关**没有内建认证**，默认只监听 `127.0.0.1` → 不能暴露公网
- **串行合成**：避免多个请求同时占 GPU（我们桌宠只有一个声音，天然串行）
- `maxChars` 是**文本**限制不是音频时长限制；发送能力由平台适配器决定
- 健康检查（`/health`）**不等于**完整推理成功 —— 我们「真测一句」（M4）
  正是为了避免这个陷阱，两者是同一个教训的两个面

## 20.3 值得记进 backlog 的：group_chat_plus 的「决策 AI / 回复 AI 分离」

⚠️ 它整个项目是 **AGPL-3.0**，抄一行代码都会要求我们整个项目转 AGPL，
我们是 MIT，两者不兼容 → **只能借设计思想，自己实现，不复制粘贴**。

它跑**两次独立的 LLM 调用**，走完全不同的路径：

| | 决策 AI（"读空气"） | 回复 AI（"生成回复"） |
|---|---|---|
| 调用 | `provider.text_chat()` 直连 | `event.request_llm()` 走平台 |
| Hook | **不经过任何 Hook**，不受其他插件影响 | 经过 Hook 链 |
| 系统提示 | 人格（可选）+ 决策指令 | 人格 + 其他插件注入 + 工具提醒 |
| 上下文 | **近期消息摘要（较短）** | **完整格式化历史 + 记忆 + 工具** |
| 输出 | YES / NO | 回复文本 |

**可借的点**：判断"要不要说话"不该拼装完整人格 + 全部记忆 + 全部历史，
那会把最贵的资源浪费在最多数会被丢弃的判断上。

映射到我们：proactive 现在是三道**规则闸**（`quietHours` / `maxUnanswered` /
`media`），可以加一条**可选的决策 AI**——用便宜模型判断"这句话值不值得插嘴"。
正是 backlog ⑧「主动时机加信息增益」。

另两个机制也可借：**群聊等待窗口 GWW**（按**用户粒度**隔离等待窗口，不会
劫持他人消息）→ 对应我们的并发聚合；**频率调整 AI**（按活跃度自适应概率）
→ 比固定 `maxUnanswered` 更贴人。

## 20.4 明确不碰的

- **NapCatQQ**：见 20.1，许可禁止 + 逆向协议双重风险。桌宠是单机桌面应用，
  为接 QQ 引入这个风险，性价比不成立。
- **astrbot-launcher**：MIT 没问题，但它解决的是"用户装不上 Python/AstrBot"
  的问题（引导式安装 + 多实例管理）。我们有 electron-builder + 自动更新，
  没有这个问题 → 参考价值 ≈ 0。
- **AstrBot 主仓 / group_chat_plus 的代码**：AGPL-3.0，只借设计不搬码。
  （这与第 19 轮对 Cursor 逆向协议那条的处理是同一条判据。）

## 20.5 来源

```
https://github.com/AstrBotDevs/AstrBot                           44767★ AGPL-3.0（主仓：插件机制 / 多平台适配）
https://github.com/AstrBotDevs/astrbot-launcher                   2425★ MIT（Rust 启动器 / 多实例管理）
https://github.com/NapNeko/NapCatQQ                              11969★ NOASSERTION → **Limited Redistribution License**（禁止未经授权使用/修改/分发）
https://github.com/InariNGT-Ofiicial/gsv-rvc-voice-bridge             1★ MIT（GSV→RVC 本地网关 + DSH 插件）
https://github.com/InariNGT-Ofiicial/astrbot_plugin_gsv_rvc_voice      1★ MIT（AstrBot 适配：/voice /语音 /voice_health）
https://github.com/Him666233/astrbot_plugin_group_chat_plus         191★ AGPL-3.0（「AI 读空气」：决策 AI / 回复 AI 分离 + GWW）
```

---

# 21. 第三批外部源归档：DSH 系记忆/心情、鲸语、SnowLuma（2026-10-31，第 21 轮）

> 用户给的 7 个地址逐条核实（`api.github.com` 元数据 + README + **LICENSE 原文第一行**，
> 规矩 29）。与第 16–20 轮不同的是：这批里有三个「同生态位直接对照」——
> **Mnemosyne（记忆）↔ 我们的 memory.js**、**dsh-mood（心情）↔ 我们的 mood.js**、
> **鲸语（动作编排）↔ 我们的表情/动作体系**，另有三个一眼可判（SnowLuma 协议框架、
> dsh-pet npm 发行线、DSH 组织全貌）。

## 21.1 总览：七个源一句话判决

| 源 | 星 / 许可（读原文） | 本质 | 判决 |
|---|---|---|---|
| `Pal-AI-Lab/Coopanion` | 2757★ · LICENSE 第一行 **AGPL-3.0-or-later**（REST 标 NOASSERTION 是附加权限条款所致） | Electron 三端 + Cortico 桌宠 | ✅ 已归档 §E.1，本轮补许可实证；不搬码 |
| `DSH-Raising-Plan/dsh-mnemosyne` | 9★ · LICENSE 第一行 **AGPL-3.0**（2026-10-30 仍在更新） | 「证据/时间/情境/状态演化/情绪/纠错」记忆系统 | 🟡 只借设计思想（下 §21.3），不搬码 |
| `lulu23316/dsh-mood` | 3★ · LICENSE 第一行 **MIT** | 心情引擎 + 赛博日记插件 | 🟢 可细读对照（下 §21.4），落点记录 |
| npm `dsh-pet` | 0.3.8 · 33 版 · MIT | 「吃白饭的蓝色大肥鱼」官方发行 | 🟢 发行线信息（下 §21.5），无机制可借 |
| `SnowLuma/SnowLuma` | 3260★ · **NOASSERTION**（未读全文，协议框架非桌宠） | QQ / OneBot v11 / WebUI 协议框架 | ⛔ 非桌宠、非目标赛道（下 §21.6），不碰 |
| `InariNGT-Ofiicial/jingyu-live2d-agent` | 5★ · **根目录无 LICENSE**（只有 `licenses/` 第三方清单） | 「鲸语」：自然语言 → Live2D 动作时间线 | 🟡 无许可=默认保留权利；但**它是大肥鱼模型的官方编排工具**，与本轮 deepfish 接入交叉印证（下 §21.7） |
| `DSH-Raising-Plan` 组织 | 8 个仓库 | dsh-mnemosyne(9★) + 7 个 0★ 插件（context-budget / window-locator / chat-memory-ingest…） | 🟢 组织小、插件零散；`context-budget` 名与 G7 信息增益同族，未展开 |

## 21.2 Coopanion 许可实证（订正上轮 REST 字段）

- REST `license.spdx_id = NOASSERTION` 是**错的读法**：`contents/` 根目录确有 `LICENSE`
  文件，第一行原文：

  > Coopanion is licensed under the GNU Affero General Public License, version 3 or
  > (at your option) any later version, whose text follows, with the **additional
  > permission below**.

  即 **AGPL-3.0-or-later + 附加权限条款**。§E.1 的「AGPL-3.0」判断不变，
  但「NOASSERTION → 读原文」的教训这次又命中一次（第 17.8 节同款）。
- 组织面板：`console/` + `core/` + `app/` + `packages/` + `telemetry-server/`
  —— 发行壳与我们同构（Electron + electron-builder），**不因此改迁壳优先级**。

## 21.3 Mnemosyne：记忆系统的三层模型（AGPL → 只借思想）

> README 全本 33KB，只读文档。核心是**三层记忆 + 三维（时间/空间/情绪）+
> 可解释更新**。与我们 G19/W24/W25 的对照：

| 它的机制 | 原文要点 | 我们的落点 |
|---|---|---|
| 三层：事实与证据 → 状态与关系 → 演化与应用 | 「记住证据、时间与变化，不是记住结论」；「只有在证据足够时才深入推断，否则保留事实和未知状态本身就是正确结果」 | ✅ 已符合：memory.js 存事实 + 时间 + 清晰度；G19 的「模糊注入前缀」就是"证据不足的形态" |
| 时间感知检索 | 检索要判断「查询针对过去还是现在」「记忆在目标时间是否有效」「有无更新/取代它的证据」「有无未解决冲突」 | 🟡 **可借**：`recallFacts` 目前是"按清晰度/最近度挑"，没有"已被取代"标记 → backlog 新增候选 |
| 可解释的记忆更新 | 重要变更**先生成可审查的变更计划再写入**（新增/更新/合并/取代了什么、依据、影响面、反证、写入后如何验证、失败如何回滚） | 🟡 与 W24 日结（只降不删）同向；"变更计划"比我们的直接改 JSON 重，可作 W3 后置项 |
| 情绪是记忆维度不是标签 | 「允许多种情绪同时存在」「记录强度/置信度/不确定性」「在新证据出现后重新评估过去的判断」；示例：争执后修复关系，不应简化为"这个人容易愤怒" | ✅ 已符合（规矩 22：标签随对话态、decay 回中性，不写死） |

**结论**：AGPL 只借思想；**真正值得抄的一条**是「**已被取代的证据**」这个检索维度
（我们现在没有"这条被新事实推翻了"的状态，只有清晰度降档）。

## 21.4 dsh-mood：心情引擎对照（MIT，可细读）

> 给 DeepSeek Harness 加「情绪 + 日记」。README 关键点逐条对照：

| 它的机制 | 原文要点 | 我们的落点 |
|---|---|---|
| 六维状态机 | valence / arousal / dominance / engagement / stress / affinity；事件驱动 + 惯性 + **按时间戳指数衰减**，基线 55 | 🟡 我们的 mood 是 EMA 日均慢层（temperament.js）+ 情绪即时态；六维 vs 我们单轴，**维度多≠好**，不扩维 |
| 22 情绪词矩阵 | 对话触发优先（说「乖」撒娇、说「别的鱼」吃醋），数值只做底色 | ✅ 我们情绪=8 档状态机，台词池已有 personaId 偏置（P4） |
| 语气注入 | 每轮开始生成 ≤4 行语气提示，挂在人格段之后 | ✅ 已有（`temperament` 语气 hint + P6 专业模式语气约束） |
| **情绪硬干预采样温度** | stress 高 → temperature 0.2 冷淡；兴奋 → 0.9 发散；低落 → 「≤15 字 + 工具轮豁免」 | 🔴 **可借真点**：我们 LLM 调用没有按心境调 temperature 的通路 → 记 backlog 候选 |
| 每日日记 | 到点自动写、错过补写、一天一篇、没人陪时写得落寞 | ✅ W2 记忆日记本已有"浏览/删"；"自动写"= proactive 范畴，已有闸门 |
| 互动收益递减 | 摸摸/投喂/逗各 5 次/天，100%→70%→40%→20%→5% | 🟡 我们的摸头/戳有生气档（W13），无次数账；「收益递减」比「次数上限」更贴真实互动 |
| `simulated: true` 免责声明 | 「模拟情绪，不是模型的真实感受；只影响说话语气，不影响事实、安全判断与权限」 | ✅ 我们人设正文也声明非真人；**「不影响事实/安全判断」这句值得抄进我们的语气注入文档**（现在只约束在 persona 段） |

**结论**：MIT 可细读。**两条记 backlog**：① 心境→temperature 映射；
② 互动收益递减（替代 W13 的硬次数上限）。不搬六维——我们单轴够用。

## 21.5 dsh-pet npm：发行线信息

- `dsh-pet@0.3.8`（33 个版本）· MIT · 描述原文：「吃白饭的蓝色大肥鱼，赖在
  DeepSeek Harness 里不走了」· 依赖只有 **5 个**。
- 它是 `PC2005-cloud/dsh-pet`（第 18 轮已归档：106 段视频动画、组合在时间轴上）
  的**官方发行渠道**，不是新机制来源。
- 对我们的价值只有一条：**同生态位产品怎么发版**（33 版 MIT 小依赖）——
  与我们「发版四件套 + 版本号纪律」对齐即可，无机制可借。

## 21.6 SnowLuma：协议框架，非桌宠（不碰）

- 3260★ · TypeScript · **NOASSERTION**（协议框架常用自定义许可）。
- v2.2.1（2026-10-27）：Windows x64 / Linux x64 / Linux arm64，含 **QQ 接入 /
  OneBot v11 / WebUI 管理**，分 lite（Node 24+）与完整版（内置 Node）。
- 定位是「Next Remote Protocol Framework」——把即时通讯协议接到 AI 后端，
  **不是桌面宠物**。与我们的赛道（安静陪伴桌宠）无交集，
  与 §20.1 NapCatQQ 那条同族（QQ 协议生态），**明确不碰**。

## 21.7 jingyu「鲸语」：与 deepfish 接入的交叉印证（无 LICENSE → 只借思路）

> 「1.4.0-beta.2 · Windows 本地动作工作台」：把自然语言编排为可检查的
> Live2D 动作时间线，网页或 VTube Studio 播放。

**交叉印证（本轮最有价值的一条）**：

1. 它用的模型就是 **DeepSeek「大肥鱼」**——README 明写
   `model/DeepSeek/`、作者渠道取得、原画「神宫凉子」、建模「霓虹猫_NeonNeko」、
   禁止擅自再分发完整模型。与我们的 **deepfish 接入同源**（我们素材同款、
   同样不进包、不进 models.zip）→ 第 27 条规矩的素材红线被第三方工具
   **独立背书**，不是我们自己多疑。
2. 它要求模型目录含 `大肥鱼.model3.json` + `Exp3/` + `Animation/` + VTS 配置，
   与我们接入时的 VTS 包特征（无 Motions/Expressions 段、自带 exp3）
   **完全吻合** → 印证我们「model3.json 无段 → 自己 fetch 解析」的修法
   正是该素材的通病，不是我们引入的。
3. 它的工程约束：**参数/时间/通道冲突校验，失败最多修正一次**；
   `model-profile.json` 启动时重建不进 Git —— 与我们的
   `model-scan.js` + verify-packaged-files 的纪律同构。

**可借点（只借思想）**：

- **自然语言 → 动作时间线**：用户说"摸摸头再眨眼"→ 生成可检查的时间线。
  我们的表情/动作是即时态（情绪驱动），**没有"序列编排"层**——
  若要让 LLM 编排多动作，需要类似「计划→校验→播放」的通道。
  记 backlog 候选（表外，属 W4 类增强，非优先）。
- **VTS 原生动作编译 + 热部署、保留作者物理**：与我们 deepfish 的
  AngleX/Y/Z 物理链判断同域（他们用 VTS 原生通道绕过了我们踩过的坑）。
- **`agent-tools.json` / HTTP / CLI 协议 + 逐任务完成回执**：与
  W29（只读 JSONL 联动）互补——它是**外部 Agent 驱动桌宠动作**的正向协议。

**许可**：根目录只有 `licenses/`（第三方清单）与 `THIRD-PARTY.txt`，
**没有自己的 LICENSE** → 默认保留所有权利。README 里"作者说明禁止擅自
重新分发完整模型"再次印证素材红线。**只借思路，一行代码不搬。**

## 21.8 本轮结论（按性价比）

1. **Mnemosyne「已被取代的证据」检索维度**（§21.3）——记忆系统补一维，
   与 G19 日结天然兼容，中低成本。
2. **dsh-mood 心境→temperature**（§21.4）——LLM 调用参数接线，小改动、
   气质风险需 A/B 验证（与 W11 情绪分轨 TTS 同族）。
3. **dsh-mood 互动收益递减**（§21.4）——替代 W13 硬次数上限，
   摸头/戳的体验更软。
4. **鲸语动作编排层**（§21.7）——自然语言→动作时间线，表外大项，
   非优先（现在表情即时态够用）。
5. 其余（Coopanion 组织 / SnowLuma / dsh-pet npm / DSH 组织）——
   无新增动作，归档即止。

## 21.9 来源清单（全部经 api.github.com 核实存在，LICENSE 读原文第一行）

```
https://github.com/Pal-AI-Lab/Coopanion                    2757★ LICENSE 第一行=AGPL-3.0-or-later（+附加权限条款；REST 标 NOASSERTION 不可信）
https://github.com/DSH-Raising-Plan/dsh-mnemosyne            9★ AGPL-3.0（LICENSE 第一行=GNU AGPL v3）· 记忆三层/三维/可解释更新
https://github.com/lulu23316/dsh-mood                         3★ MIT（LICENSE 第一行=MIT License, 2026 dsh-mood contributors）· 心情六维/日记/temperature 干预
https://www.npmjs.com/package/dsh-pet                   0.3.8 · 33 版 · MIT · 5 deps（PC2005-cloud/dsh-pet 官方发行）
https://github.com/SnowLuma/SnowLuma                        3260★ NOASSERTION · 协议框架（QQ/OneBot v11）· 非桌宠
https://github.com/InariNGT-Ofiicial/jingyu-live2d-agent      5★ 无 LICENSE（根目录仅 licenses/ 第三方清单）· 鲸语动作编排 · 用大肥鱼模型
https://github.com/DSH-Raising-Plan                          组织 · 8 仓（mnemosyne 9★ + 7 个 0★ 插件）
```

---

# 22. 第四批外部源归档：记忆赛道集中对照（2026-10-31，第 22 轮）

> 用户给的 7 个地址全部是**记忆 / Agent 记忆系统**赛道（与 W49 同期），
> 其中 3 个是「同生态位直接对照」：**ReMe ↔ 我们的 G19 日结 / memory.js**、
> **surfcore-life ↔ 我们的「角色自主调参」愿景（W50/W51 同源）**、
> **memsearch ↔ 我们的 summary.md 分层**。逐一核实（api.github.com + README +
> **LICENSE 原文第一行**，规矩 29）。

## 22.1 总览：七个源一句话判决

| 源 | 星 / 许可（读原文第一行） | 本质 | 判决 |
|---|---|---|---|
| `volcengine/OpenViking` | **41206★** · AGPL-3.0 | 上下文数据库：`viking://` 虚拟文件系统，L0/L1/L2 分层摘要 | 🟡 AGPL 只借思想；分层摘要（下 §22.4）值得抄 |
| `agentscope-ai/ReMe` | 3724★ · Apache-2.0 | 记忆生命周期 capture→index→consolidate→recall | 🟢 Apache 可细读；digest 分层 + proactive_read（下 §22.2）最贴 |
| `zilliztech/memsearch` | 2811★ · MIT | Markdown 真源 + Milvus 影子索引，3 层召回 | 🟢 MIT 可细读；SHA-256 跳过未变内容（下 §22.5） |
| `vshulcz/deja-vu` | 1343★ · MIT | 磁盘会话历史 → 本地倒排索引，跨 43 agent | 🟢 MIT 可细读；accepted/rejected 状态标记（下 §22.3） |
| `FuRongJun-1999/dsh-memory`（灵枢 0.9.12） | 545★ · MIT | 平台型记忆：md 认知图 + 确定性规则裁决 + Rust 内核 | 🟡 MIT 可读但量重；只借「确定性裁决」（下 §22.6） |
| `nefelibata5136-code/surfcore-life` | 5★ · MIT | **大肥鱼自主调整生活参数**，9 工具闭环 | 🟢 **本轮最贴**：预览→执行→验证→回滚（下 §22.7） |
| `NoMindSama/qq-dsh-bridge` | 8★ · MIT | DSH agent 接进 QQ，四层记忆 + 闲置边界压缩 | 🟢 MIT 可细读；「闲置边界压缩」与我们全屏静默同域（下 §22.8） |

## 22.2 ReMe：记忆生命周期（Apache-2.0，可细读）

> 「Memory as File, File as Memory」—— 记忆即普通 Markdown（frontmatter + wikilink），
> 用户可审阅/编辑/移动/备份；索引与元数据全部可重建。**capture → index →
> consolidate → recall** 四段式：

| 能力 | 入口 | 做什么 | 输出 |
|---|---|---|---|
| `auto_memory` | Agent hook / CLI | 对话中蒸馏有用事实，保留过滤后的对话源记录 | `session/dialog/*.jsonl` + `daily/<date>/<name>.md` |
| `auto_resource` | resource watcher | 外部文件 → 源链接的 daily 卡片 | `daily/<date>/<resource-card>.md` |
| `auto_index` | 后台 watcher | 摄入 daily+digest，建 BM25/wikilink/向量 | 可搜 chunk |
| `auto_dream` | cron | 从最近两天变更文件提取 ≤5 个可复用单元，**创建/佐证/精炼/修正** digest 节点 | `digest/**` |
| `proactive_read` | agent 决定行动前 | 读独立主动刷新流生成的**兴趣主题**，宿主决定是否提及 | `daily/<date>/interests.yaml` |

**与我们 G19 日结的对照**：
- ✅ `auto_memory` ↔ 我们的对话事实提取（memory.js upsertFacts）同向；
- ✅ `auto_dream`「创建/佐证/精炼/修正」四动作 ↔ 我们 G19 的「只降不删」+ W49 的 expand/replace —— **ReMe 的 auto_dream 是 W49 的超集**（它还会在 digest 层创建新节点，不只是修改旧事实）；
- 🟡 **可借真点**：`proactive_read` 与我们的 proactive 闸门同域，但 ReMe 的区分是
  **「主动刷新流独立生成主题，宿主只读不决定」**——我们 proactive 现在是「宿主自己冒泡」，
  没有「独立生成 + 宿主挑选」的分层。记 backlog 候选。
- 🟡 **可借真点**：`interests.yaml`（每日兴趣主题清单）——我们没有这个中间产物，
  记忆直接以事实形式注入。作为「记忆 → 主题」的可读中间层，记候选。

**许可**：Apache-2.0（LICENSE 第一行原文确认）→ 可细读、可借机制，不搬码。

## 22.3 deja-vu：accepted/rejected 状态标记（MIT，可细读）

> 从磁盘上各 agent 的会话历史建**本地倒排索引**（Go 单二进制），跨 43 个 agent 共享。
> 核心机制（与我们的 W49 对照）：

| 它的机制 | 原文要点 | 我们的落点 |
|---|---|---|
| `deja promote <id> --state rejected` | 标记**回滚过的决策**，之后每次命中都提示「试过了、为什么被放弃」 | 🟢 **与 W49 superseded 同构但更通用**：W49 只标记「被取代的事实」，deja 标记「被回滚的决策」 |
| `--state accepted` | 取回标记 | 🟢 对应 W49 的「改回旧值复活」 |
| 索引工作而非只索引对话 | 每轮打开的文件、命令及退出码、编辑替换的精确跨度 | 🟡 我们是桌宠不是 coding agent，不适用 |
| 跨会话恢复 | 43 个 agent 读同一索引；compaction 后保留 77% 决策、0.2% 命令 | 🟡 我们无 compaction 问题（桌宠单 agent） |
| 密钥剥离 | 建索引时按已知形状（AWS key/token/JWT/PEM）剥离，不留在摘要/分享/同步里 | 🟡 我们是本地桌宠，但我们的 memory 注入会进 LLM prompt → **值得自查：我们的记忆文件里有没有密钥形状的字段** |

**可借真点**：**「知道什么是对的」状态标记**——deja 的 accepted/rejected 是**通用决策状态**，
W49 的 superseded 只覆盖「事实被换值」。如果我们要让角色记住「上次这个方案被回滚了，
别再推荐」，需要的是**决策级**状态标记。记 backlog 候选（与 W49 互补，非替代）。

**许可**：MIT（LICENSE 第一行原文确认）。

## 22.4 OpenViking：L0/L1/L2 分层摘要（AGPL-3.0，只借思想）

> 41206★ · **上下文数据库**—— 把知识/记忆/技能组织成 `viking://` 虚拟文件系统，
> agent 用 `ls/tree/read/grep` 导航，每个目录带生成摘要：

| 层级 | 内容 | 用途 |
|---|---|---|
| **L0 (Abstract)** | 一句话摘要 | 快速相关性判断 |
| **L1 (Overview)** | 核心信息 + 使用场景 | 规划 |
| **L2 (Details)** | 完整原文 | 按需加载 |

- 目录级 `.abstract.md` + `.overview.md` 让 agent **先看摘要再决定读不读全文**。
- 评测（LoCoMo）：原生 24–57% → 接 OpenViking 后 80–83%，token 降 34–91%，延迟降 58–66%。
- `viking://` 组织：`resources/`（文档/代码）、`user/{uid}/memories/preferences/`（偏好）、
  `skills/`（怎么干活）、`peers/`（其他用户）。

**与我们 G19 summary.md 的对照**：
- ✅ 我们的 summary.md 是「记忆 → 可注入摘要」的**单层**产物；
- 🟡 **可借真点**：**分层摘要（L0 一句话 / L1 概览 / L2 详情）**——现在 recall 直接挑事实注入，
  没有「先看一句话摘要、再决定读哪条」的中间层。G19 若要支持「快速扫一遍再深挖」，
  这个分层是必要结构。记 backlog 候选（G19 增强）。
- 🔴 AGPL → **只借思想，一行代码不搬**。

## 22.5 memsearch：Markdown 真源 + 内容哈希（MIT，可细读）

> 2811★ · Milvus 是「**影子索引**」——可重建的缓存，**Markdown 才是真源**。
> 3 层召回（search → expand → transcript），稠密向量 + BM25 稀疏 + RRF 融合，
> 文件 watcher 实时索引。

| 它的机制 | 原文要点 | 我们的落点 |
|---|---|---|
| Markdown 真源 | 记忆就是 .md 文件，人可读/可编辑/可版本控制；Milvus 是派生缓存 | ✅ 我们 memory-facts.json 同向（JSON 真源，无派生索引） |
| **SHA-256 内容哈希跳过未变** | 「SHA-256 content hashing skips unchanged content」 | 🟡 **可借真点**：我们 memory.js 每次 upsert 都全量重写 store；若加 content hash 层，未变事实不重算 scoreImportance/不重排 → 省算力 |
| 高层维护（PROJECT.md/USER.md） | 后台维护两个高阶笔记（项目状态/用户偏好），session 后仅 journal 变更 + 最小间隔才刷新，默认关 | 🟡 对应我们的 summary.md；「仅变更才刷新 + 最小间隔」比我们每次日结全量重算更省 |
| 程序性记忆（Skills from Memory） | 把重复工作流蒸馏成可安装 skill，候选存 git 可 diff/回滚，「inert until installed」 | 🟡 我们是桌宠不是 coding agent，程序性记忆对我们意义小，跳过 |

**可借真点**：**content hash 跳过未变**——我们 memory.js 的 `scoreImportance`/`similarFact`
是纯函数但每次都跑全量。加 SHA-256（或更轻的字符串 hash）做「事实未变就不重算」的
短路层，是**小改动、低风险**。记 backlog 候选。

**许可**：MIT（LICENSE 第一行原文确认）。

## 22.6 dsh-memory（灵枢 0.9.12）：确定性裁决（MIT，平台型量重）

> 545★ · **平台而非单组件**：md 认知图（纯 md 文档真源）+ Rust 检索内核 + 蜂群运行时 +
> 中文编译器 + 蜂巢并发，五件套。**核心理念**：

| 它的机制 | 原文要点 | 我们的落点 |
|---|---|---|
| **确定性规则裁决** | 「记什么、取什么、能不能写入全部由确定性规则裁决，不依赖 LLM 黑箱」 | ✅ 我们 memory.js 的 clarity/scoreImportance/similarFact 全是确定性纯函数，同向 |
| 写没写成功只看 `committed` | 「绝不假装通过」 | ✅ 我们的 saveConfig/saveStore 有写失败回退（cfgUnreadable 拒绝落盘） |
| 遗忘只能显式发起 | 「落盘即长期留存，遗忘只能显式发起、不做静默淘汰」 | ✅ 我们 W2 deleteFact 是显式墓碑；settle 淘汰（forgetEnabled 开时）是显式开关 |
| 原文即真源 | 检索索引只是派生物 | ✅ 我们 memory-facts.json 是唯一真源 |
| 零 LLM 写入 | 「写入 0.013–0.020 秒（零 LLM）」vs 同表其余 75.7–658.5 秒 | ✅ 我们 upsertFacts 也是零 LLM 纯函数 |
| 工具面 30+（cg/stg 基元） | write/link/relation/recall/route/timeline/verify/forget/metacognition/identity/evolution/session/scrub/consolidate/maintain/sustain | 🟡 **远超我们所需**——我们是桌宠单用户，不需要 identity/evolution/swarm。**只借「确定性裁决」理念，不搬工具面** |

**判决**：理念高度一致（确定性纯函数 + 原文即真源 + 显式遗忘），但**平台体量远超桌宠所需**。
**不展开，只记一条理念印证**：我们 memory.js 的确定性纯函数路线被 545★ 平台独立背书。

**许可**：MIT（LICENSE 第一行原文确认）→ 可读。

## 22.7 surfcore-life：大肥鱼自主调参闭环（MIT，本轮最贴）

> 5★ · 「让大肥鱼自己决定怎样成长」—— Agent 通过 9 个 MCP 工具**自主调整自己的生活参数**
> （30 项参数，29 可自主、1 需审批）。**与我们 W50/W51 同源**（都是角色自主调参），
> 但 surfcore-life 把「调参」做成了完整闭环：

| 它的机制 | 原文要点 | 我们的落点 |
|---|---|---|
| **先看清，再决定** | 每项参数有说明/范围/影响/成本/权限/生效方式；预览关联修改与限制 | 🟡 我们 W50/W51 是「固定映射」——**没有「预览→执行→验证→回滚」的可调闭环** |
| **保存与生效分别作证** | 配置落盘后**继续等实际消费者回报采用值**；证据过期/版本不符/未被读取时如实显示 | 🔴 **可借真点**：我们 config 改了直接生效，没有「验证真实采用」的回读 |
| **关联修改一起提交** | 改一个参数可能碰时间窗口/机会数/次数/间隔/预算；提前检查关系，预览展示关联修改 | 🟡 我们 proactive.quietHours 等是单参数，但 W51 dedentEnabled 这类「连带影响」没有关联预览 |
| **保留选择的来路** | 修改者/原因/前后值/观察/恢复关系都有记录，「不额外调用模型编造心理」 | 🟡 我们 config.json 只存当前值，没有「谁改的/为什么/之前是什么」的来路 |
| **给改变主意留出口** | 回滚先预览再执行，**保护后来作出的同字段选择**，保留当天已发生的活动 | 🟡 我们没有回滚机制；「保护后来的选择」语义与我们 W49 复活（改回旧值）同向 |
| 凭据/预算/隐私不开放 | 自主调整有明确范围，凭据/账号授权/预算硬上限不向此接口开放 | ✅ 我们也是（用户手动改 config，无 Agent 自调通道） |

**9 个工具闭环**（发现→理解→预览→执行→验证→观察→回滚）：
`life_state`（看状态）· `life_catalog/life_explain`（发现/理解）· `life_preview/life_apply`（预览/执行）·
`life_verify`（验证真实采用）· `life_history/life_observe`（回看/观察）· `life_rollback`（预览回滚）。

**判决**：**本轮最贴我们项目**——同为大肥鱼生态、同为「角色自主调生活节奏」愿景。
我们 W50（心境→temperature）、W51（收益递减）是**固定规则**，surfcore-life 是**Agent 自主调参闭环**。
**不搬工具面**（我们是桌面宠物不是 MCP server），但**记两条 backlog 候选**：
① **参数调优闭环**（预览→执行→验证采用→观察→回滚）——这是 W4 类增强，表外大项；
② **来路记录**（改了谁/为什么/之前值）——小改动，可独立做。

**许可**：MIT（LICENSE 第一行原文确认）→ 可细读。

## 22.8 qq-dsh-bridge：闲置边界压缩（MIT，可细读）

> 8★ · 把 DSH agent 接进 QQ，**四层记忆 + 一层关于自己**，上下文只在**闲置边界压缩**。

| 它的机制 | 原文要点 | 我们的落点 |
|---|---|---|
| 闲置边界压缩 | 上下文只在闲置边界压缩（非实时逐轮压缩） | 🟡 与我们全屏静默（规矩 17）同域：我们是在**全屏时**降帧率/静音，没有「闲置边界压缩上下文」 |
| 四层记忆 + 一层关于自己 | 四层记忆 + 一层「关于自己」的元记忆 | 🟡 我们是单层 memory-facts.json；「一层关于自己」≈ 我们的人设/temperament，但没作为独立记忆层 |
| 人格三层且会成长 | 人格三层结构，随经历成长 | ✅ 我们 temperament.js（EMA 日均慢层）同向 |

**判决**：体量小（8★），机制与我们部分重叠。**只借「闲置边界压缩」思路**——
我们 proactive 主动冒泡现在是「定时轮询」，若改成「闲置边界触发」，更贴真实陪伴节奏。
记 backlog 候选（proactive 增强，表外）。

**许可**：MIT（LICENSE 第一行原文确认）。

## 22.9 本轮结论（按性价比，适配桌宠场景）

1. **memsearch content hash 跳过未变**（§22.5）—— memory.js 加 SHA-256 短路层，
   **小改动、低风险、立省算力**。中低成本。
2. **surfcore-life 来路记录**（§22.7）—— config 改动记「谁改/为什么/之前值」，
   小改动，独立可做。
3. **ReMe proactive_read 独立主题流**（§22.2）—— 主动刷新与宿主挑选分层，
   中成本（proactive 改造）。
4. **OpenViking L0/L1/L2 分层摘要**（§22.4）—— G19 日结增强，中成本。
5. **deja-vu accepted/rejected 决策状态**（§22.3）—— 决策级回滚标记，与 W49 互补，中成本。
6. **surfcore-life 参数调优闭环**（§22.7）—— 预览→执行→验证→回滚，表外大项，非优先。
7. 其余（dsh-memory 平台体量 / qq-dsh-bridge 体量小）—— 归档即止。

## 22.10 来源清单（全部经 api.github.com 核实，LICENSE 读原文第一行）

```
https://github.com/volcengine/OpenViking                     41206★ AGPL-3.0（LICENSE 第一行=GNU AFFERO GENERAL PUBLIC LICENSE v3）· 上下文数据库 L0/L1/L2
https://github.com/agentscope-ai/ReMe                        3724★ Apache-2.0（LICENSE 第一行=Apache License v2.0）· 记忆生命周期 capture→index→consolidate→recall
https://github.com/zilliztech/memsearch                      2811★ MIT · Markdown 真源 + Milvus 影子索引 + content hash
https://github.com/vshulcz/deja-vu                           1343★ MIT · 会话历史倒排索引 + accepted/rejected 状态标记
https://github.com/FuRongJun-1999/dsh-memory                 545★ MIT · 灵枢 0.9.12 · md 认知图 + 确定性裁决 + Rust 内核（平台型）
https://github.com/nefelibata5136-code/surfcore-life            5★ MIT · 大肥鱼自主调参 9 工具闭环（预览→执行→验证→回滚）
https://github.com/NoMindSama/qq-dsh-bridge                    8★ MIT · DSH 接 QQ · 四层记忆 + 闲置边界压缩
```
