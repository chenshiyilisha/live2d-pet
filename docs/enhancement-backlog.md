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
| W16 | 连接真测一句才算就绪 | Nexus |
| W17 | 外挂多 Agent hooks（可选） | CoPet |

**网上已有、我们已有**：番茄 / 提醒 / 开机自启 / 锁屏静默 / 摸头 / 全屏闸门 / 低电降帧 / 工作状态。  
**不抄主线**：亲密度养成、多宠交友、径向技能轮当主 UI、内置捆小模型、会议 Join、打字蒸汽特效。

---

## F. 发行线 □

| ID | 项 |
|---|---|
| L1 | 自制 Live2D（`custom-model-plan.md` 路线 B） |
| L2 | 鲸鱼娘商用书面授权（未获前不上架默认） |
| L3 | Miara 等官方样本第二模型 |

---

## G. 建议开干顺序

1. **P1 + P2** → 2. **P3** → 3. **X1** → 4. **G1/G2/G3/G4**（少打扰+对话正确）→ 5. **X2/X3** → 6. **P5/P6** → 7. **L1**

---

## H. 模块挂点

| 能力 | 挂哪里 |
|---|---|
| 人设 | `config.js` `PERSONA_PARTS` / `resolvePersona` / 托盘 |
| 心境 | `mood.js` + `appearance.mood` |
| 主动搭话 | `proactive.*`；台词池可旁路 LLM |
| 工作状态 | `emitWorkState` / `motionSlots` |
| 长期记忆 | `memory.js`（勿并入 persona） |
| 表情 | 规矩 28；人格只调衰减/频率 |

---

## 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-27 | 初版 P/X/L + 已落地 |
| 2026-10-27 | 补 G1–G20、G21–G30、网上 W1–W17 |
| 2026-10-27 | **归类重排**为 A–H；对齐 v0.3 发版 |
