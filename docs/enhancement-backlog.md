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
| G19 | 记忆 Phase2 / 可选 FTS5（不上向量）—— **改造清单已出、未开工**：`docs/memory-phase2-plan.md`（2a 只降档不删 / 2b 遗忘默认关） |
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
| W23 | 记忆「重要度」**纯函数打分**（不调模型，可单测） | surfcore `MEMORY_CARD.md` §4 |
| W24 | 记忆**四档清晰度、每天最多降一档**，遗忘＝删正文只留计数；**离线补跑连降（≤30 天）** | surfcore §5；与规矩 34 同构 |
| W25 | 「最初 / 初次相遇」**独立于重要度的第二条轴**（稳定散列定概率，永不淘汰、单独成区） | surfcore §4.5 |
| W26 | 主动搭话**先记账后生成**（先写「已投递」再调模型，中途被杀判 `interrupted`） | surfcore `SUBSYSTEM-PET.md` §6.4 |
| W27 | 主动搭话**具名 reason** + **零副作用 preview** | surfcore §6.3 / §6.8 |
| W28 | 主动识屏：白名单应用切换 + 停留/闲置/冷却/日上限/dry-run；截图**内存不落盘**（768 / JPEG70）；结果回写会话 | dsh-pet README；→ **G2** |
| W29 | Agent 事件**只读 JSONL**（六态、兼容 Claude hooks 事件名、表外忽略、失败静默、>1MB 轮转） | dsh-pet `AGENT_LINK_PROTOCOL.md`；→ 工作状态外扩 |
| W30 | **置顶看门狗**（explorer 重启/休眠/改 DPI 会丢置顶 → 30s 自检重置） | dsh-pet「已知限制」；先量再决定 |
| W31 | 不可用入口**置灰 + 行内写明原因**；手填值以它为准、**不偷偷回退** | dsh-pet 菜单/播放器；规矩 24 的实现细则 |
| W32 | **档案自证**：`verify-expressive` 的「情绪数=8 / 字段数=16」硬断言改为**由档案自证**（键集一致 / emoSpeed 键集 / param 有 ID 三条规则一条不减） | 降档前置；引擎本就按字段集遍历，8·16 是断言不是限制；规矩 9 同路数 |
| W33 | **`emotionAlias` 未知情绪回退**：8 个 `[emo:xxx]` 协议标签**一个不删**、llm prompt 不动，档案缺失的情绪映射到近似档 | 防「切 A→B 眉毛卡住」静默故障（缺字段=停旧值） |
| W34 | **`mouthOpenMax`** 口型幅度夹取（档案声明、写参前夹、默认 1.0） | 降档后口腔只需一张张嘴图；psd2live 规范 `either as one image` |
| W35 | **半身模型档案 L0**（4 情绪 / 8~10 字段 / 无腿）+ 全 AI 链路 PoC（生图→See-Through→manifest→psd2live→Cubism 5） | `custom-model-plan.md` §11；**腿非刚需**（漫步=窗口位移，Walk 是自制的增强） |

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

### E.2 参考仓速判 · surfcore / dsh-pet-indesktop（2026-10-28 查）

> **逐项细节（含权重表、闸门顺序、协议字段、证据文件路径）已归档到
> [`open-source-reference.md`](open-source-reference.md) 的「第 16 轮」**，本节只留判决与落点。
> 查源方式：GitHub REST API 取元数据 + 文件树（搜索引擎给的仓库名不可信），只读 doc/README，不读第三方代码。

**① Mieksido/surfcore**（21★，2026-10-26 见仓库，38 commits，JavaScript，default `main`）
实为 QQ ↔ DeepSeek Harness 桥（原 Derpyu520/qq-bridge，3104★ 仍活着）+ B站 + **桌宠子系统**（`plugins/surfcore`，
`host.json` 发现 + `host-token` + 回环 pet-api + 事件长轮询 `since`/`bootId`）。
🔴 许可证 **`NOASSERTION`**（非标准开源协议）→ **只借机制，一行代码都不搬**。

| 可借点 | 说明 | 落到本仓 |
|---|---|---|
| 记忆「重要度」**纯函数评分**（不调模型，可单测） | 基础/主人/情绪词/首次/承诺/矛盾加权，夹 1–100；要点是**确定性、可解释、可回滚** | G19 记忆 Phase2；与 mood 确定性 step 同路数 |
| 四档清晰度 **每天最多降一档**（vivid→clear→fuzzy→trace→删），主人重要记忆有下限、**永不忘** | 遗忘是删正文只留计数；离线多天**补跑连降**（上限 30 天） | G19；直接对照规矩 34「离线补漂」——别人用同一套解法验证过 |
| **先记账，后生成**：选完目的先写「已投递」再调模型 | 中途被杀留 `pending`，下次定为 `interrupted` 并把 `nextFireAt` 归零 | proactive 闸门（规矩 32）：避免「以为发了其实没发」 |
| **零副作用 preview**（读素材/算目的/拼词，不投递不写状态不调模型） | 调闸门最好用 | X5/G7 开发期诊断，可并 `PET_SNAPSHOT` 体系 |
| 引擎**不认识载体**（carrier/modality 在外层，引擎纯逻辑） | 与规矩「依赖单向、注入 getter」同源 | 已符合，不必改 |

**② MerZlin/dsh-pet-indesktop**（2549★，MIT，Python/PySide6 + **透明 WebM** 逐段动画，源于 PC2005-cloud/dsh-pet 4523★）
功能面比我们宽得多，但**定位不合**：(a) 它是 WebM sprite，没有真·Cubism 表情/物理（这块是我们强项）；
(b) 它在同一只桌宠上堆了联动/对话/待办/歌词/抽签/余额/节日——**与我们「安静陪伴 + 短菜单」相反**。只挑下面几项进主线：

| 可借点（含它给的具体参数） | 落到本仓 |
|---|---|
| **主动识屏**：白名单应用切换触发 + 停留门限/闲置/冷却/每日上限/free-model-first/**dry-run**；截图**只在内存**处理不落盘、**最长边 768 / JPEG70**、「程序名\|标题」上下文、4s 冷却 | **G2 屏幕上下文**（我们已经有前台名，缺的是闸门与 swap 预算）；私密口径那句话可直接借用 |
| **Agent 联动 = 只读 tail 本地 JSONL**（六态 thinking/working/attention/error/idle/sleeping，事件名兼容 Claude hooks；`<配置目录>/agent-events/<agent>.jsonl`，byte-offset 增量、**不在表内的事件名一律忽略**、写失败静默放弃、>1MB 轮转） | v0.3.0「工作状态」已有一条线 → 加一个**只读 JSONL 监听**即可让外部 Agent（含 WorkBuddy 自己）不改本仓代码也驱动她；天然 fail-open、默认关（规矩 4/24） |
| **隐藏时 CPU≈0**（暂停解码与活动定时器）/ 共享解码链 | 与全屏静默三档帧率（规矩 19）同理念，已覆盖 |
| **置顶看门狗 30s 自检**（explorer 重启/休眠/改分辨率会丢置顶） | D3 零碎：成本低、收益稳；先确认我们现在是否会丢 |
| 入口做不到时**置灰并写明原因** + 手填路径以它为准不偷偷回退 | 与规矩 24「开关关掉不许点了没反应」完全同款 ✔ |
| 「看看屏幕」结果**回写当前会话一条 `[看看屏幕]` 记录**可继续追问 | G2 + 对话历史手法 |
| 全局三档作用域（每宠 / 整窗 / 全局）在设置页**行内标注** | 咱们单宠，暂不需要 |
| 发版/PR 纪律：`test_architecture.py` 机器守行数预算 + Context pointers「改哪块先读哪份」+ 文档索引登记 | 我们的 verify-*.js 已是同类；可补一条 **main.js 体量断言** |
| **不借**：菜单可编排、多宠孵化、音乐播放器路径、余额/抽签/歌词/节日、抓帧率 | 与「两个菜单都要短」「安静陪伴」冲突（规矩 5） |

**结论**：**surfcore 借两处**（记忆每天降一档 + 主动搭话先记账后生成），**dsh-pet 借三处**（主动识屏的闸门与隐私口径、只读 JSONL 联动、置顶看门狗），均为**照着机制自己写**，不搬代码。两者都不改变主线，也不影响 Tauri 迁壳优先级。

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
| 2026-10-28 | 记 **surfcore / dsh-pet**（§E.2 + W23–W31）：surfcore 为 NOASSERTION，**只借机制不搬代码** |
| 2026-10-28 | **Live2D 降档**（用户拍板）：记 W32–W35。腿/口腔两条硬伤降级、全 AI 链路可作交付路线；见 `custom-model-plan.md` §11 |
