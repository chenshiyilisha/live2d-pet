# 阿岩可做增强 backlog

> 2026-10-27 起。**抄机制不抄宿主**；打扰类默认关；记忆 ≠ 人设正文；合规红线不动摇。  
> 出处详 `open-source-reference.md`；自制模型见 `custom-model-plan.md`。

状态：`□ 未做` · `◐ 半截/已有雏形` · `✓ 已落地`

---

## A. 本轮已落地（v0.3 · 勿重复开工）

| 项 | 落点 |
|---|---|
| ✓ 工作状态镜像 | `interaction.workState` + `pet:work-state` + profiles `motionSlots` |
| ✓ 甩抛物理 | `throw-physics.js` + `interaction.throw/bounce`（throw 默认关） |
| ✓ 点击/落地 Q 弹 | `interaction.squash` + `pet:squash` |
| ✓ 气泡优先级 | `bubble-priority.js`（status < stream < alert） |
| ✓ 低配降帧 | `quiet.lowPower` / `lowFps` |
| ✓ 轻量长期记忆 | `memory.js` + 托盘开关/清空 |
| ✓ 鲸鱼娘档案（本地） | `profiles/whale.js`；素材不进仓、不上架默认 |

---

## B. 性格 / 人格

### B1 高性价比 □

| ID | 项 | 草案 |
|---|---|---|
| P1 | 人设预设包 | 托盘：傲娇/元气/天然呆/三无/温柔/冷静 → `personaParts` |
| P2 | 状态台词池 | 搭话/工作态/久别；JSONC；可旁路 LLM |
| P3 | OCEAN 轻量滑条 | 2～3 维 → proactive 间隔、衰减、气泡字数、pride |
| P4 | 招牌状态减法 | 每套人格只强化 idle/working/error/success |

### B2 中期 □

| ID | 项 |
|---|---|
| P5 | Temperament 慢层（mood 日均 → 气质偏置，不改人设文） |
| P6 | 双模态：陪伴 / 专业 |
| P7 | 视角蒸馏模板 → `personaParts` 草稿 |
| P8 | Character Card V2/V3 导入 |

### B3 明确不做

恋爱六维主线 · LLM 每轮重写人设 · 记忆写进 persona 正文 · 完整五维成长大系统

---

## C. 体验 / 交互

### C1 高性价比 □

| ID | 项 |
|---|---|
| X1 | 运行时切模型（hiyori / whale）+ whale 署名 |
| X2 | 专注/勿扰三档（盖过单一 quietHours） |
| X3 | 拖文件「吃下」→ 可进 memory |
| X4 | 甩抛补全（单摆 / flip / 动画轮换） |

### C2 中期 □

| ID | 项 |
|---|---|
| X5 | 前台/系统边缘搭话（CPU/电池/切应用，可沉默） |
| X6 | 作息学习（活跃直方图） |
| X7 | 工作事件 ↔ mood |
| X8 | 记忆召回解释（`PET_SNAPSHOT=memory`） |

---

## D. 产品缺口（调研已标红、上表未吞并）

### D1 高性价比 □

| ID | 项 | 注 |
|---|---|---|
| G1 | 安静时段 + 跨午夜 | ◐ `proactive.quietHours` 已有雏形，核对半截再补 |
| G2 | 屏幕上下文接线 | fullscreen 已有前台名 → mood/搭话 |
| G3 | 打断后历史只记听到的 | TTS 打断错位 |
| G4 | `[emo:]` 指数衰减回中性 | ◐ 衰减层曾落地；对照是否仍「挂一整晚」 |
| G5 | model profile 自动扫描 | cdi3/physics3 → 骨架 |
| G6 | 药盒式一次性指令 | 只改下一句 |

### D2 中期 □

| ID | 项 |
|---|---|
| G7 | 主动时机信息增益（没话别找话） |
| G8 | 内心 OS 弱展示（`[think:]`） |
| G9 | 输出侧人设护栏 |
| G10 | TTS 并发生成按序播 |
| G11 | 口型文字模拟降级 |
| G12 | MCP（默认关 + 逐授权） |
| G13 | 对话导出 MD/JSON |
| G14 | 截屏前先藏自己 |

### D3 零碎 / 工程 □

| ID | 项 |
|---|---|
| G15 | 透明区点击穿透 |
| G16 | drowsy → sleep 状态机 |
| G17 | 启动偶现双模型（bug） |
| G18 | 鲸鱼娘真脸情绪 + 表情槽 |
| G19 | 记忆 Phase2 / 可选 FTS5（不上向量） |
| G20 | verify-lip：打断后嘴型归零 |
| G21–G30 | 语气基线、主动可沉默、手动看一眼、说话人、热键、多屏 hop、FACS、立绘兜底、verify-arch …（细项见变更记录前版；实现时按 ID 开） |

---

## E. 网上补记（2026-10-27 检索）□

| ID | 项 | 出处味道 |
|---|---|---|
| W1 | 限时看屏授权 + 倒计时收回 | Convai |
| W2 | 记忆日记本 UI（浏览/删）+ 夜间矛盾降权 | Nexus / Convai |
| W3 | 导入模型预检（缺资源仍显示并说明） | Nexus 0.4.7 |
| W4 | 窗口当地形（走窗顶/爬边） | mochi / mushroom |
| W5 | 位置钉 + 闲置够久才稀有换位 | armada |
| W6 | 悬停渐隐穿透 | armada |
| W7 | 提醒倒计时跟锁屏清零重计 | PawPal |
| W8 | OS 级截屏排除（`setContentProtection` 类） | PawPal |
| W9 | 时段 idle 动作池 | 月薪喵 |
| W10 | 忙碌度 / 话痨滑条（可并 P3） | mushroom |
| W11 | 情绪分轨 TTS | live2dpet |
| W12 | 统一 PetEvent 调度 | live2dpet |
| W13 | 连点/过摸生气档 | Vibe |
| W14 | TTS→默认音→静音降级机 | Live2DPet |
| W15 | 「看看」口令截屏 | AI-Desktop-Pet |
| W16 | 连接真测一句才算就绪 | Nexus；**Coopanion Start 页同款** |
| W17 | 外挂多 Agent hooks（可选） | CoPet |
| W18 | 首次引导气泡向导 | Coopanion：称呼/人设/走动量/选模/下语音包 |
| W19 | 触摸响应档 Quiet/Eager/Custom | Coopanion Habits；可并 X2 |
| W20 | 活动态气泡（思考/读/写…）可点穿 | Coopanion Activity bubbles |
| W21 | OBS 透明叠加导出 | Coopanion Habits |
| W22 | 记忆 Markdown 工作区 + 版本 | Coopanion `PARTNER.md`+git；对照 G19，**勿整抄 AGPL 实现** |

**网上已有、我们已有**：番茄 / 提醒 / 开机自启 / 锁屏静默 / 摸头 / 全屏闸门 / 低电降帧 / 工作状态；甩抛/摸头交互形态与 Coopanion 同类。  
**不抄主线**：亲密度养成、多宠交友、径向技能轮当主 UI、内置捆小模型、会议 Join、打字蒸汽特效；**Computer use 控键鼠当产品主线**（与安静搭子冲突）。

### E.1 竞品备忘 · Coopanion（2026-10-27）

> https://github.com/Pal-AI-Lab/Coopanion · 站点 https://coo.palailab.org  
> Electron + **Cortico**（Core + Persona + desktop-pet World）。  
> **形象澄清**：鲸鱼娘**看起来像 Live2D**，实为自研 **WebGL sprite rig**（`kit/rig.js` 网格蒙皮 + 形变器 + 弹簧），官方称「Live2D **风格**实现、**不含 Cubism SDK**」；形象以 **figure pack**（`figure.json` + 代码/贴图）导入。内置 Coo 甚至是 SVG path。真·Cubism 鲸鱼是生态里另一插件（如 `dsh-whale-live2d`），不是 Coopanion 本体。  
> 许可：**AGPL-3.0-or-later**（≤0.1.10 曾 MIT）；**只抄机制/产品点子，不搬代码**。鲸鱼素材另见其 THIRD_PARTY。

| 维度 | Coopanion | 阿岩 |
|---|---|---|
| 壳 | Electron 三端 | Electron；远期 Tauri 2 |
| 角色 | 自研 rig / figure pack（类 Live2D 观感，非 Cubism） | **Cubism Web** + profiles |
| 模型 UX | 十多家预设 + ChatGPT 登录 + **Test** | 兼容协议已有 → **对齐 M2/M4/M5** |
| 记忆 | `PARTNER.md` + git | `memory.js` 事实 |
| 重心 | Agent / computer use / Worlds / 本地 ASR | 安静陪伴、系统静默、程序化表情物理 |

**对本仓的结论**：对齐 **接模型体验（M 线）** 与 W18–W21 可选体验；**不**改定位成可操控电脑的代理桌宠；**不**因它改迁壳优先级。

---

## F. 发行线 □

| ID | 项 |
|---|---|
| L1 | 自制 Live2D（`custom-model-plan.md` 路线 B） |
| L2 | 鲸鱼娘商用书面授权（未获前不上架默认） |
| L3 | Miara 等官方样本第二模型 |

---

## G. 大模型对接（本地 / 在线）· 下一批优先考虑 □

> 现状：`llm.js` 已是 **OpenAI 兼容** `/chat/completions` 流式；换家只改 `baseUrl` / `apiKey` / `model` / `extraBody`。  
> 默认 DeepSeek，**空 apiKey = 离线话术**（故意不外呼）。  
> 缺口不在协议，在**本地友好 + 可见设置 + 真连接测试**（对齐 backlog W16 / Nexus）。

### G-LLM 高性价比

| ID | 项 | 做法草案 |
|---|---|---|
| M1 | **本地允许空 Key** | `localhost` / `127.0.0.1` 时：无 key 也走网络；可选占位 `ollama` / `lm-studio`。修 `streamLLM` + `memory.extractViaLlm` + 渲染层 `hasApiKey` 判定 |
| M2 | **连接预设一键填** | 托盘/小面板：DeepSeek · 魔搭 · Ollama(`:11434/v1`) · LM Studio(`:1234/v1`) · 自定义；产品形态对照 **Coopanion Start 页厂商表**（机制参考，AGPL 不抄码） |
| M3 | **拉模型列表** | `GET …/v1/models` → 下拉选；失败可手填（Ollama/LM Studio 官方兼容端均有） |
| M4 | **真测一句** | 不只通 `/models`：发极短 chat，成功才标「已就绪」（W16 / Coopanion Test）；区分：连不上 / 无模型 / 401 / 超时 |
| M5 | **设置页露出来** | 勿再只靠「打开 JSON」：Base URL、Key（可空提示）、Model、超时、extraBody 高级折叠；引导可叠 W18 |

### G-LLM 中期

| ID | 项 | 注 |
|---|---|---|
| M6 | 多配置档切换 | 「家里 Ollama / 公司 DeepSeek」一键切，不重装 |
| M7 | 本地首包引导 | 检测 11434/1234 是否在听；给 `ollama pull` 文案，不内置权重 |
| M8 | 云端目录精简 | DeepSeek / 通义兼容 / OpenAI 兼容 默认条目 + 自测通过才绿 |
| M9 | 超时按场景 | 本地首字慢：`stallMs` 可单独抬；与云端默认分开 |

**明确不做**：内置捆 GGUF、自研推理引擎、非 OpenAI 协议各写一套客户端。

---

## H. 建议开干顺序

1. **M1 → M2 → M4 → M5**（本地能连 + 预设 + 真测 + 设置可见）— 对接体验一天可感  
2. **M3 / M6** — 选模与多档  
3. **P1 + P2**（人设）— 连上之后才更有味道  
4. **P3 / X1 / G1–G4** → 其余  
5. **Tauri 迁壳（§J）** — 与上并行不抢；满足触发条件再开 T0（详见 `tauri-migration.md`）

---

## I. 模块挂点

| 能力 | 挂哪里 |
|---|---|
| 人设 | `config.js` `PERSONA_PARTS` / `resolvePersona` / 托盘 |
| 心境 | `mood.js` + `appearance.mood` |
| 主动搭话 | `proactive.*`；台词池可旁路 LLM |
| 工作状态 | `emitWorkState` / `motionSlots` |
| 长期记忆 | `memory.js`（勿并入 persona） |
| 表情 | 规矩 28；人格只调衰减/频率 |

---

## J. 技术路线 · Tauri 2 迁壳（下一步方向，未开工）□

> **已定**：下一世代壳 = **Tauri 2 + TypeScript + Cubism Web**。  
> 专文：[`tauri-migration.md`](./tauri-migration.md)。Electron 继续承载当前发版。

| ID | 阶段 | 摘要 |
|---|---|---|
| T0 | 抽核 | 无 Electron 依赖的纯逻辑可单测、可共享 |
| T1 | 空壳 | 透明置顶 + 托盘 Vite 页 |
| T2 | 舞台 | Cubism Web + profiles 几何最小集 |
| T3 | 系统面 | 穿透 / 闲置 / 前台 / 多屏（Rust） |
| T4 | 产品面 | 对话·TTS·记忆·更新对齐现版 |
| T5 | 切主 | Tauri 为发行主路径 |

**不做**：迁壳同时大改产品行为；把阿岩改成 DSH 内嵌 Cordis 宠物当迁壳目标。

---

## 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-27 | 初版 P/X/L + 已落地 |
| 2026-10-27 | 补 G1–G20、G21–G30、网上 W1–W17 |
| 2026-10-27 | **归类重排**为 A–H；对齐 v0.3 发版 |
| 2026-10-27 | 增 **G 大模型对接 M1–M9**；开干顺序改为先 M 再人格 |
| 2026-10-27 | **定路线** Tauri 2+TS+Cubism Web：§J + `tauri-migration.md` |
| 2026-10-27 | 记 **Coopanion**（§E.1 + W18–W22）；M 线对齐其接模型 UX；AGPL 不抄码、不跟 computer use |
