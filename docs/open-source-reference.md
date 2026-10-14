# 开源参考调研（第 6 轮）· 逐项对照与可借鉴清单

> 时间：2026-10-14 · 动机：本项目 VAD / 表情抖动 / 纹理 LOD / 真口型 / 媒体感知 / 主动搭话
> 六项均为自研，**没有一行参考过现成实现**。这一轮专门去找同类开源工程，回答两个问题：
> ① 我们的做法有没有别人独立走通（= 靠不靠谱）② 别人有什么我们没想到的（= 抄什么）。

## 0. 方法

- **只走 GitHub 官方 API**（`api.github.com/search/repositories`）。上一轮的教训：搜索引擎
  命中的 `ghub.com` / `github.me` / `reporank.net` 这类聚合站会**凭空生成仓库名**（8 个候选 6 个
  `git ls-remote` 不通）。官方 API 拿到的 `full_name` 才是真的。
- 源码用 `codeload.github.com/<owner>/<repo>/tar.gz/refs/heads/<branch>` 下载（`git clone` 被代理 502 挡）。
- 单个超大仓库（`Voine/ChatWaifu_Mobile`，624MB C++ 移动端）跳过；`git2968/Desktop-pet` 41MB 下载两次
  都超时，改用 `git/trees?recursive=1` 拿文件树 + `raw.githubusercontent.com` 定点抓需要的文件。

## 1. 找到的对口项目

| 项目 | ★ | 语言 | 更新 | 与本项目的重合面 |
|---|---|---|---|---|
| **FanyinLiu/Nexus** | 20 | TS | 2026-10 | **最重合**：Electron + Live2D 桌宠 + LLM + TTS/STT + 自主性引擎 |
| **git2968/Desktop-pet** | 18 | TS | 2026-08 | Live2D + AI 对话 + 人设 + 语音输入 + MCP |
| **zhao896632126/Live2d-TTS-Audio-LipSync** | 13 | JS | 2024-02 | **真口型**（讯飞 TTS + AnalyserNode） |
| **kirbystudy/chatgpt-desktopPet** | 90 | JS | 2023-09 | Electron + Live2D 桌宠（实现较原始） |
| kdavis-mozilla/vad.js | 153 | JS | 老 | VAD（能量法 + 机器学习两路） |
| cprosche/mulberry32 | 55 | JS | — | 我们的 seeded PRNG 就是它 |
| shaedy180/obs-overlay-nowplaying 等 | ≤3 | 多 | — | 读 Windows GSMTC 做「正在播放」 |
| travisvn/edge-tts-universal | 81 | TS | — | Edge 在线 TTS（音色升级路线） |

**Nexus 是本轮的主要对照对象**——它是唯一一个有完整分层架构、328 个测试、架构边界自动审查、
设计文档（`ARCHITECTURE.md` / `BEHAVIOR_MAP.md`）的同类项目，且已迭代到 v0.4.7。

## 2. 交叉验证：我们的做法被别人独立印证

这一节回答「我的代码靠谱吗」。以下都是**独立实现、相同结论**，不是抄来的：

### 2.1 真口型（`tts.js` / `pet.js`）—— `Nexus/src/features/voice/lipSync.ts` 几乎逐行同构

| 参数 | 我们 | Nexus | 说明 |
|---|---|---|---|
| 取包络方式 | **时域** RMS | **时域** RMS（`getByteTimeDomainData` → `(v-128)/128` → 平方和开方） | 一致 |
| `analyser.fftSize` | **512**（32ms ≈ 一个音节） | **512** | 独立取到同一个数 |
| 噪声底 | 常量 0.011 量级（VAD 的 `peakFloor`） | **0.011** | 一致 |
| 映射 | 增益 + 快攻慢放（40/12） | `clamp((rms - 0.011) * 7.5, 0, 1)` | 同思想（减底噪再线性放大） |
| 驱动 | pixi ticker 每帧 | `requestAnimationFrame` | 等价 |
| 收尾 | 闭嘴干净（实测 0 偏差） | `setMouthOpenY(0)` | 一致 |

→ **两个独立实现落在同一组参数上，说明这组值是物理合理的**（不是我们碰巧调出来的）。

### 2.2 WAV 编码（`audio.js`）—— `Nexus: encodeVadAudioToWavBlob` 逐行相同

`RIFF`/`WAVE`/`fmt `/`data` 四段、`blockAlign=2`、`byteRate = sampleRate*blockSize`、
`clamped < 0 ? *0x8000 : *0x7fff`、16kHz —— 连写法都几乎一样。

### 2.3 参数注入时机

`Live2d-TTS-Audio-LipSync` 的口型写参数用的是**覆盖 `motionManager.update`，在原 update **之后**
再写 `ParamMouthOpenY`**。我们是在自己的 ticker 里靠**调用顺序**保证（`updateGaze` → 表情 → 口型）。
两种做法解决的是同一个问题：**参数写入必须晚于动作/表情系统**。我们的做法更简单（不用打补丁到第三方对象上）。

### 2.4 阈值数量级

我们的 VAD `peakFloor = 0.010`（≈ −40dBFS）与 Nexus 口型的噪声底 `0.011` 几乎相同 ——
**两个不同用途的独立标定收敛到同一个数**。

### 2.5 我们的「参数级情绪」比同类的「表情名映射」稳

`Desktop-pet/app/shared/emotion-map.ts` 用**模型自带的 expression / motion 名字**做映射，
它自己的注释承认了这个路线的痛点：

> 不同 Live2D 模型的 designer 自定义参数 / 表情命名差异极大，全局关键词匹配很容易误中
> （比如魔女的 "x" / "xx" 是道具开关而非情绪）

我们的做法（`PARAM` 参数 ID + `EMOTION` 16 字段数值 + `EMO_SPEED` 错峰插值）**不依赖命名**，
跨模型可移植。这是本项目明显更优的一处，**不要动摇**。

## 3. 可以借鉴的「思路」（按价值排序）

### ① 🔴 防复读护栏（`Nexus/v2/repetitionGuard.ts`）

**正对症我们记忆里那条「说话变短/复读 = 删 `chat-history.json`」。**

它是**纯后分析器**：扫最近几条回复的结构相似性，产出「避免 X」提示注入下一条 prompt。
不做 LLM 调用、不膨胀历史。四个检测维度：

| 维度 | 判据 |
|---|---|
| `avoidOpenings` | 出现 ≥2 次的**开头两个字**（最近 ≥3 条才判） |
| `avoidEndings` | 标点后重复的**末尾四字** |
| `lengthMonotone` | 所有回复长度都在均值 **±20%** 内（说的话总一样长，很假） |
| `avoidPunctuation` | `! ！ ? ？ … ~ ～` 里，带 ≥2 个该标点的回复占比 ≥ **50%** |

关键设计哲学（原文）：

> Layered on top of personaGuardrail (which checks fidelity to the character).
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
> activity legible to the model and tell it the signal is subordinate: defer to how the conversation
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

| | 我们 | Desktop-pet |
|---|---|---|
| 触发源 | **时间**（闲置 8 分钟 + 情绪安定） | **事件**（前台应用切换 / 长停留） |
| 话头 | 泛泛的（"主动开个话头"） | 自带上下文（"你在写代码写了 1 小时"） |
| 冷却 | 2s 重试（闸门） | 切换冷却 **5 分钟** |

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
+ 安静时段 / 锁屏 → sleeping
+ `consecutiveIdleTicks` / `lastWakeAt` / `lastSleepAt` / `dailyTickCount`

我们只有 `IDLE / SLEEP / SPEAKING`。**`drowsy` 是「快睡了」的过渡相** —— 可以驱动
打哈欠 / 揉眼睛这类微动作，成本极低但很讨喜。`dreaming` 是夜间记忆巩固的载体。

### ⑧ 情绪模型：4 维连续 vs 我们的 8 个离散标签（`Nexus/emotionModel.ts`）

| | 我们 | Nexus |
|---|---|---|
| 表示 | 8 个离散情绪（calm/happy/smile/think/shy/serious/surprised/sleepy） | 4 维连续 0–1（energy / warmth / curiosity / concern） |
| 驱动 | 事件 → 设目标 → 逐帧插值 | 事件 → `SIGNAL_DELTAS` 表累加增量 → `driftToward()` 向基线漂移 |
| 用途 | **当下的表情**（16 参数） | **跨会话的基调**（驱动 prompt 语气 + mood 映射） |

**不是二选一**：我们的 8 标签适合「此刻的脸」，4 维适合「她记得你这几天心情不太好」这种长期基调。
我们目前**没有「长时间没人理 → 慢慢回到 calm」的漂移机制**（Nexus 有 `driftToward`）——
这是个小而实用的补充。

🔴 它的信号表里有一条深刻的注释，**做「共情」时必读**：

> Companion-side empathy/awareness signals ... **must never be projected back into the user-affect
> timeline**（that would be a feedback loop: the observation was derived from that very timeline）

→ 她的「共情信号」不能回流到自己情绪模型的输入里，否则是**自激反馈**。任何"她感知到用户情绪
→ 改变自己 → 再被当成用户情绪"的闭环都是这个坑。

### ⑨ 架构约束做成可执行的自动审查（`Nexus/scripts/architecture-boundary-audit.mjs` + `tests/`）

Nexus 的 `autonomy/README.md` 把分层规则写得很硬：

> `features/autonomy/` 是**纯的** —— 无 React、无 IPC、无 window。**任何 import 进来的东西应该能
> 在普通 Node 测试里跑、不需要 mock**。
> 违反这个分层通常就是自主性难以导航的原因。如果你发现自己在从 `features/autonomy/*`
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

| 目标 | 来源 | 搬法 |
|---|---|---|
| 防复读 | `Nexus/v2/repetitionGuard.ts` | 整份搬（纯函数，98 行，零依赖） |
| 安静时段/专注分档 | `Nexus/focusAwareness.ts` | 整份搬（61 行，纯函数）；接到已有的 `getSystemIdleTime()` |
| 口型文字模拟 | `Nexus/lipSync.ts: simulateText` | 取那 15 行，替掉我们的正弦波降级 |
| 引用前缀防注入 | `Nexus/desktopContext.ts: quoteObservedText` | 三行（每行加 `> `），用到 `injectMediaContext` |
| 作息学习 | `Nexus/rhythmLearner.ts` | 24 槽 + 周衰减，约 60 行 |
| 架构边界审查 | `Nexus/scripts/architecture-boundary-audit.mjs` | 思路照搬，写成 `debug/verify-arch.js` |

## 5. 明确**不该**抄的

| 候选 | 为什么不抄 |
|---|---|
| **Silero VAD**（Nexus 的 VAD 后端） | 它是**语义级**语音检测（ONNX 模型 + WASM runtime + AudioWorklet→ScriptProcessor 两级回退，`browserVad.ts` 300 行里一多半在处理回退）。适合「常开免按键唤醒」；我们是**按住说话**（用户已明确表达"我要说"），能量判据足够。我们的 30 行纯函数是对的。 |
| **表情名映射**（Desktop-pet `emotion-map.ts`） | 依赖模型 designer 的命名，它自己都承认会误中。我们的参数级更稳。 |
| **Chromium TTS + 可见窗口**（chatgpt-desktopPet） | 它为一个合成开 1024×768 的窗口，还会闪。我们的常驻合成进程 + WebAudio 播放好得多。 |
| **频域跳采口型**（Live2d-TTS-Audio-LipSync） | `getByteFrequencyData` + 每 80 格取 1 + `(avg-20)/60` 硬编码常数 —— 对音量不敏感（不同音源 20/60 会飘）。我们和 Nexus 的**时域 RMS** 更直接。 |
| **`setTimeout` 驱动口型**（同上，30fps） | 我们有 pixi ticker，天然按帧。 |
| **每帧重建闭包写参数**（同上，`setMouthOpenY` 每次都重赋 `motionManager.update`） | 每帧新建函数。 |
| **Nexus 的整体架构规模** | 328 测试 / 17 个功能域 / 多 provider / MCP / 插件 / 游戏集成 —— 那是产品化项目。我们照搬会失控。**只借具体思路，别借体量。** |

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
