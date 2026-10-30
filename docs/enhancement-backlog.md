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
| P1 | ✅ 人设预设包（2026-10-30） | 托盘「角色设定」子菜单：默认/傲娇/元气/天然呆/三无/温柔/冷静 → `personaParts`；不碰 emotion/thought 协议槽 |
| P2 | ✅ 状态台词池（2026-10-30 雏形） | `line-pools.js`：工作态 success/error 轮换；久别 ≥4h 离线搭话走 FAREWELL_LINES；情绪分池仍在 pet.js |
| P3 | ✅ OCEAN 轻量滑条（2026-10-30） | 托盘「性格微调」E/N/A/T 四维三档；→ idle 间隔 / 正负衰减 / 气泡停留 / pride 软化（`ocean.js`）；W10 话痨叠 T |
| P4 | ✅ 招牌状态减法（2026-10-30） | `SIGNATURE_LINES/EMO`：6 套人格各强化 idle/working/success/error；`personaId` + work 短句/表情偏置 |

### B2 中期 □

| ID | 项 |
|---|---|
| P5 | ✅ Temperament 慢层（2026-10-30） | mood 日均 EMA → 漂移乘子 + 语气 hint；`temperament.js`，不改人设文 |
| P6 | ✅ 双模态：陪伴 / 专业（2026-10-30） | `chat.mode` companion/work；专业只追加语气约束 |
| P7 | ✅ 视角蒸馏模板（2026-10-30） | 托盘「视角蒸馏…」短答 → identity/style/method/extra；不碰协议槽 |
| P8 | ✅ Character Card V2/V3 导入（2026-10-30） | 托盘「导入角色卡…」→ identity/style/extra；不碰协议槽 |

### B3 明确不做

恋爱六维主线 · LLM 每轮重写人设 · 记忆写进 persona 正文 · 完整五维成长大系统

---

## C. 体验 / 交互

### C1 高性价比 □

| ID | 项 |
|---|---|
| X1 | ✅ 运行时切模型（2026-10-30） | 托盘「人物模型」hiyori/whale；`applyProfile` + `mountModel` 热换；whale 署名 toast；默认仍 hiyori |
| X2 | ✅ 专注/勿扰三档（2026-10-30） | 托盘「状态」陪伴/日常/勿扰；陪伴忽略 quietHours + idle×0.7；勿扰全天不主动（`presence.js`） |
| X3 | ✅ 拖文件「吃下」（2026-10-30） | 拖 txt/md/json… ≤32KB → `memory:eat-file` 落 other 事实 + toast |
| X4 | ✅ 甩抛补全（2026-10-30） | `interaction.swing/flip`（默认关）：拖拽单摆倾角 + 左飞水平翻转 |

### C2 中期 □

| ID | 项 |
|---|---|
| X5 | ✅ 前台/系统边缘搭话（2026-10-30 雏形） | `edgeCues` 默认关；低电量/高 CPU/切应用 → proactive hint，可 [silent] |
| X6 | ✅ 作息学习（2026-10-30） | 24h 直方图 + 周衰减；`gateProactive` 默认关 |
| X7 | ✅ 工作事件 ↔ mood（2026-10-30） | success→happy / error→serious 轻推轴 |
| X8 | ✅ 记忆召回解释（2026-10-30） | `PET_SNAPSHOT=memory` 打 recall 解释到日志 |

---

## D. 产品缺口（调研已标红、上表未吞并）

### D1 高性价比 □

| ID | 项 | 注 |
|---|---|---|
| G1 | ✅ 安静时段 + 跨午夜（2026-10-30 核对） | `quiet-hours.js` 跨零点已齐；排程上限 30m→12h（默认 23-8 不再整夜空转） |
| G2 | ✅ 屏幕上下文接线（2026-10-30 雏形） | fullscreen 缓存前台进程名 → 主动搭话 hint（不抄标题；监视关则空） |
| G3 | ✅ 打断后历史只记听到的（2026-10-30） | busy 可打断；流式半截落账；`chatAbort` 掐旧流；TTS 未开口 → `...` |
| G4 | ✅ `[emo:]` 衰减回中性（2026-10-30 核对） | 衰减到底同步把情绪标签回 `calm`（台词池不再挂旧情绪过夜） |
| G5 | ✅ model profile 自动扫描（2026-10-30） | `model-scan.js` + `tools/scan-model-profile.js`：cdi3/physics3 → 建议 param / 覆盖率 / 物理冲突 |
| G6 | ✅ 药盒式一次性指令（2026-10-30） | 托盘「下一句指令」：5 颗药 + 手写；`【仅本轮】` 注入后即焚 |

### D2 中期 □

| ID | 项 |
|---|---|
| G7 | ✅ 主动时机信息增益（2026-10-30） | `info-gain.js`：无线索/旧回复占场 → skip silent |
| G8 | ✅ 内心 OS 弱展示（2026-10-30） | `chat.showThink` 默认开；关则仍剥标签不画 |
| G9 | ✅ 输出侧人设护栏（2026-10-30） | `persona-guard` off/med/strict；禁客服腔；silent 直通；失败 toast |
| G10 | ✅ TTS 并发生成按序播（2026-10-30） | 主进程 `MAX_PARALLEL=3`；渲染层入队 prefetch + 队列按序播 |
| G11 | ✅ 口型文字模拟降级（2026-10-30） | system/回退：`textSim` 按字推进，标点降幅；优于正弦 |
| G12 | ✅ MCP 骨架（2026-10-30） | `mcp.js` 默认关；无 SDK；call 需授权且骨架返回 not-connected |
| G13 | ✅ 对话导出 MD/JSON（2026-10-30） | 设置「导出对话」→ MD / JSON；纯函数 `chat-export.js` |
| G14 | ✅ 截屏前先藏自己（2026-10-30） | `hideFromCapture` +「藏 3 秒」；主窗/气泡 `setContentProtection` |

### D3 零碎 / 工程 □

| ID | 项 |
|---|---|
| G15 | ✅ 透明区点击穿透（2026-10-30 气泡） | 气泡窗 `setIgnoreMouseEvents(true,{forward})`；主窗原有角色命中穿透 |
| G16 | ✅ drowsy → sleep（2026-10-30） | 精力低+闲置≥12m → `State.SLEEP`；点击/摸头/聊天叫醒 |
| G17 | ✅ 启动偶现双模型（2026-10-30） | `mountModel` 挂载前扫空 `stage` 孤儿 holder |
| G18 | ✅ 鲸鱼娘真脸情绪 + 表情槽（2026-10-30） | `whale.js` 连续脸重调（无弯眼补偿）；托盘「表情槽预览」 |
| G19 | ✅ 记忆 Phase2a+2b 开关（2026-10-30） | 2a 日结只降不删；2b `forget.enabled` 默认关 · 墓碑/复活 · migrated 不删 |
| G20 | ✅ verify-lip 打断嘴型归零（2026-10-30） | `stopSpeaking` 立刻 `mouthLevel=0` + 写回 MOUTH_OPEN |
| G21 | 语气基线 | ASR 旁路能量/语速 vs 本人基线；需录音通路再开 |
| G22 | ✅ 主动由头四类 + 可沉默（2026-10-30） | `info-gain` head=`cue/reply/idle/none`；`allowSilent` 已有 |
| G23 | ~~手动「看一眼」~~ **✅**：`interaction.glance`（默认关）· 藏窗 → `desktopCapturer` ≤768 JPEG · 需 `isLlmReady` · 托盘「看一眼屏幕」 |
| G24 | 说话人 familiar | matched/likely/unknown → social；需第二说话人场景 |
| G25 | ✅ 伪造用户句护栏（2026-10-30） | `persona-guard` med 起拦「你刚才说过：…」 |
| G26 | ✅ 全局热键骨架（2026-10-30） | `hotkeys.enabled` 默认关；显隐 / 停朗读 |
| G27 | ✅ 多屏 hop（2026-10-30） | `motion.multiScreenHop` 默认关；display-added → 新屏角 |
| G28 | FACS/AU 语义层 | 换模覆盖率自动降级；换模痛时再做 |
| G29 | 多帧立绘兜底 | 自制模型降级；见 `custom-model-plan` |
| G30 | ✅ `verify-arch`（2026-10-30） | 扫 require：main 不环、renderer 不碰 electron |

---

## E. 网上补记（2026-10-27 检索）□

| ID | 项 | 出处味道 |
|---|---|---|
| W1 | ~~限时看屏授权 + 倒计时收回~~ **✅**：`glance-grant` 会话内存 · 3m/10m 预设 · 到期 toast+收回 · 永久开关仍可用 · 托盘剩时 | Convai |
| ~~W2~~ | ~~记忆日记本 UI（浏览/删）+ 夜间矛盾降权~~ **✅（2026-10-30）**：`memory.deleteFact()` 墓碑删除 · 设置菜单「记忆日记本…」对话框（内联 HTML 浏览/删）· 夜间降权 `applyQuietPenalty`（安静时段写入的事实降一档清晰度，复用 `proactive.quietHours` 口径、开关 `memory.quietPenalty` 默认开、firstEncounter/pinned/name/boundary 不降、trace 地板）· 回归 `verify-w2.js`（负对照：去掉保护/开关关 → 必须不降）| Nexus / Convai |
| W3 | 导入模型预检（缺资源仍显示并说明） | Nexus 0.4.7 |
| W4 | 窗口当地形（走窗顶/爬边） | mochi / mushroom |
| W5 | ~~位置钉 + 闲置够久才稀有换位~~ **✅**：`motion.positionPin`（默认关）· 放下钉 14/34/44 分 · 到期+闲置≥60s 才 hop 一步再钉 | armada |
| W6 | ~~悬停渐隐穿透~~ **✅**：`appearance.hoverFade`（默认关）· 停身上 ≥700ms → 透明度 ≤0.32 + 整窗穿透 · 离身/出窗/关开关熄 · 托盘「悬停渐隐穿透」 | armada |
| W7 | ~~提醒倒计时跟锁屏清零重计~~ **✅**：锁屏清 timeout；解锁按 `durationMs` **完整间隔重排**；番茄钟当前相位同样重开。`onScreenLock/Unlock` | PawPal |
| W8 | ~~OS 级截屏排除~~ **✅（=G14）**：`appearance.hideFromCapture` → `setContentProtection`；托盘「截屏/录屏排除自己」 | PawPal |
| W9 | ~~时段 idle 动作池~~ **✅**：`appearance.timeOfDayIdle` · `idle-tod.js` 早/午/晚/夜池 · 闲置 2/4 分钟两档 | 月薪喵 |
| W10 | ~~忙碌度 / 话痨滑条~~ **✅**：`personality.T` 话痨三档（叠 P3）· idle×E×T（中性 ×1）；寡言≈少插嘴 | mushroom |
| W11 | ~~情绪分轨 TTS~~ **✅**：`tts.emotionVoice`（默认开）· `tts-emotion.js` 按 emotion 叠 rate/pitch · 托盘可关 | live2dpet |
| W12 | ~~统一 PetEvent 调度~~ **✅**：`pet-events.js` 薄总线 · `emitWorkState` 先 `petEvents.emit` 再 IPC | live2dpet |
| W13 | ~~连点/过摸生气档~~ **✅**：戳 4 惊讶→6 委屈→8 `serious`；摸头 `nagMs`→`angryMs`(5s)`serious`→`escapeMs` 挣脱 | Vibe |
| W14 | ~~TTS→默认音→静音降级机~~ **✅**：winrt 失败 → 本会话粘滞 system → speechSynthesis 挂则 `playSilent`（文字口型）；`ttsDegradeLevel()` | Live2DPet |
| W15 | ~~「看看」口令截屏~~ **✅**：短口令 `看看/看一眼/帮我看看…` → 同 G23；长句不误伤 | AI-Desktop-Pet |
| W16 | ~~连接真测一句才算就绪~~ **✅**：`isLlmReady=usable∧绿标`；`llm.requireTested`（默认关）卡对话；看屏始终要 ready | Nexus / Coopanion |
| W17 | 外挂多 Agent hooks（可选） | CoPet |
| W18 | 首次引导气泡向导 | Coopanion：称呼/人设/走动量/选模/下语音包 |
| W19 | ~~触摸响应档 Quiet/Eager/Custom~~ **✅**：`interaction.touchMode` quiet/normal/eager · 连戳门槛+摸头时序缩放 · normal=Custom 基线（单项仍可关） | Coopanion Habits |
| W20 | ~~活动态气泡可点穿~~ **✅（=G15）**：气泡窗 `setIgnoreMouseEvents(true,{forward})` | Coopanion Activity bubbles |
| W21 | OBS 透明叠加导出 | Coopanion Habits |
| W22 | 记忆 Markdown 工作区 + 版本 | Coopanion `PARTNER.md`+git；对照 G19，**勿整抄 AGPL 实现** |
| W23 | ~~记忆「重要度」纯函数打分~~ **✅（∈G19）**：`memory-score.scoreImportance` · 不调模型 | surfcore §4 |
| W24 | ~~记忆四档清晰度+日结/离线补跑~~ **✅（∈G19）**：vivid/clear/fuzzy/trace · 每天最多降一档 · `CATCHUP_MAX_DAYS=30` · forget 删正文留墓碑 | surfcore §5 |
| W25 | ~~「最初 / 初次相遇」独立轴~~ **✅**：`firstEncounter` · firstAt+30d 稳定 sha1 概率 · ≤3 条 · 清晰度地板 clear · 不遗忘/不淘汰 · 注入「最初的日子」 | surfcore §4.5 |
| W26 | ~~主动先记账后生成~~ **✅**：`proactive-ledger` JSONL · pending→delivered/interrupted/silent · `proactive.bookFirst` | surfcore §6.4 |
| W27 | ~~具名 reason + preview~~ **✅**：返回 `reason`/`head` · IPC `chat:proactive-preview` 零副作用 | surfcore §6.3/6.8 |
| W28 | 主动识屏：白名单应用切换 + 停留/闲置/冷却/日上限/dry-run；截图**内存不落盘**（768 / JPEG70）；结果回写会话 | dsh-pet README；→ **G2** |
| W29 | ~~Agent 事件只读 JSONL~~ **✅**：`agent-link.js` · 六态+hooks 映射 · 表外忽略 · byte-offset 尾读 · `agentLink.enabled` 默认关 · 驱动 `emitWorkState` | dsh-pet AGENT_LINK |
| W30 | ~~**置顶看门狗**~~ **✅**：30s 自检 `isAlwaysOnTop` 丢失则重申 + `setSkipTaskbar(true)`（explorer 重启已知会丢）；静默/用户关置顶时跳过 | dsh-pet「已知限制」 |
| W31 | ~~不可用入口置灰 + 原因~~ **✅**：`unavailable(label,reason)`；ASR/媒体非 Win、winrt 非 Win、测试连接没 key、导出无历史 | dsh-pet；规矩 24 |
| W32 | ~~**档案自证**~~ **✅**：`verify-expressive` 去掉 8/16 硬卡；键集一致 + emoSpeed + param ID + 协议标签经本体/`emotionAlias` 可解析 | 降档前置 |
| W33 | ~~**`emotionAlias`**~~ **✅**：档案字段 + `resolveEmotion` · `setEmotion` 入口解析；hiyori/whale 空表（齐全） | 防眉卡死 |
| W34 | ~~**`mouthOpenMax`**~~ **✅**：档案声明（默认 1）· `setMouthOpen` 写参前夹 · live binding 随 `applyProfile` | 降档口腔 |
| W35 | **半身模型档案 L0**（4 情绪 / 8~10 字段 / 无腿）+ 全 AI 链路 PoC（生图→See-Through→manifest→psd2live→Cubism 5） | `custom-model-plan.md` §11；**腿非刚需**（漫步=窗口位移，Walk 是自制的增强） |
| W36 | ~~气泡**避免窄高盒**：宽度多档自适应~~ **✅ 2026-10-28**：`WIDTH_STEPS=[272,320,368]`，`wantWidth(h,cur,avail)` 按 `h×1.2` 升档；🔴 **一次发言内单调不减**（加宽→变矮→不许收窄，否则流式打字时来回抖）；每句开头重置回 272；只卡**下限**不卡上限（短句横条是自然的）。真机：长回复 272→320（比例 1.33），落定后 700ms 不再变 | tiny-roommate「prefer landscape, avoid narrow tall boxes」；dsh-pet 把 1.65 调到 **1.20** |
| W37 | ~~气泡位置**轻微有界随机化**（稳定散列，同句同位）+ **间距随高度**（矮近高远）~~ **✅ 2026-10-28**：±8px 确定性散列（每句一次、`place()` 不重算）+ `tipGap` 8→14 随高度插值；尾巴恒回正指人（`bubble:tail`） | tiny-roommate「bounded and subtle」「short closer, taller more breathing room」 |
| W38 | ~~气泡**淡出动画** + 入场加 `scale` 展开~~ **✅ 2026-10-28**：出场 `bubble:fade`→`.fading` 160ms 后真 hide（与入场对称）；入场由主进程 `bubble:show` 驱动（常驻动画只有第一句有）+ `scale .96→1`；实测淡出中 alpha 132/255 | 现行为不对称；OpenAlice 留白正是为 scale 动画准备的 |
| W39 | ~~气泡描边**用 drop-shadow 不用 border** + 两层阴影~~ **✅ 2026-10-28**：两层阴影（1/2 + 3/8）+ 描边 `chat.floatBubbleOutline`（**默认关**，用户曾两轮减描边）；强度实测定 1px/0.65，尾巴根部无内部边线 | dsh-pet 气泡二次修复「根因一」；**直接加 border 会重现该 bug** |
| W40 | ~~气泡**上方弧线三候选** + 回退顺序 + 零相交优先 + 尾巴随位转向~~ **✅ 2026-10-28**：`pickAnchor()` 纯函数；**常规恒 top**（正上方最自然），只在 ① top 被屏幕边 clamp ② 头顶上方放不下退回窗内 时才用 left/right（inside 时偏一侧 = 盖肩膀不是盖脸）；可用判据 =「想要的 x 不被 clamp」（不需要人物宽度实量）；尾巴回正上限改随宽度算 `w/2−26` | tiny-roommate「allowed family = top-left/top/top-right，side 不参与」；dsh-pet 安全布局器「优先零相交」 |
| W41 | 多套**气泡皮肤**可切换（外观下拉） | dsh-pet 已有 5 套；Live2DPet `selectBubbleImage`。**最大项，最后做** |
| W42 | ~~气泡**情绪角标**（方案 A）~~ **✅ 2026-10-28**：8 情绪 → 小图形挂气泡右上角；信号走 `emitChatEmotion` 唯一出口双发（规矩 27）；**跟标签不跟衰减**（否则角标自己变淡像坏了）；calm 不挂牌、认不出的收牌；角标**绝对定位不占布局**（实测有/无牌 72px = 72px，否则打乱 A3 与高度上报）。图形取 **Lucide（ISC）**现成路径，**不用 emoji 字符**（字形随系统变 + llm.js 清洗器本来就在丢 emoji） | dsh-dfy 原话「爱心/怒气/问号…均为**视觉特效，不是文字占位**」；位置依 **Material Badge** 规范（默认右上角 + 允许压宿主边） |

| W43 | ~~动作池 pick 纯函数~~ **✅**：`pickers.js`（`pick`/`pickWeighted`/`rollKind`/`pickWeightedCategory`；排除后空退回原池；权重 0 不归一化）。`animations{}` 配置化仍待素材/视频线 | dsh-pet pickers；§18.2 |
| W44 | ~~事件档位数组 + decideEndedCue~~ **✅**：`work-cues.js` · `WORK_STATUS` 含 attention（只可追加）· `decideEndedCue` · emit/渲染接 attention | dsh-pet cues.ts |
| W45 | ✅ 已核验通过（2026-10-30）—— 项目无 HTMLMediaElement，四条在**音频播放路径**上逐条核到等价实现且安全：`onended` + 兜底定时器（非 loadeddata）· `currentSrc===src` 单槽防残留 handler · `waiting.delete` + `cleanup` 全路径释放 pending · `ttsGen` 世代号丢弃迟到结果；verify-w45.js 32 条断言固化 | 同上 `animation.ts` / `asset-loader.ts`；③ 与规矩 24「关掉的入口不许点了没反应」同族 |
| W46 | **素材链存档为「第二交付路线」**（不换产品线）：20 段核心动作（idle / turn / drag / click×5 / 工作状态×6）≈10MB 就能撑起一个可用形象；管线 = AI 绿幕视频 → 抠像（**手工**，自动 HSV 残边）→ 归一化 → 640×360 webm(VP9-alpha) → Safari 另出 HEVC-alpha `.mov` | `custom-model-plan.md` §11 降档路线；🔴 **许可**：代码 MIT、**素材「禁止商用」**、形象 CC BY-NC-SA 4.0 → **只借结构，一行素材不能进包**（规矩 29） |
| W47 | ✅ 已完成（2026-10-30）—— `src/main/tts-providers.js` 预设（gsv 网关默认 + 常见端点）、`ttsProviderById` / `ttsIsUsable` / `ttsToPatch` / `ttsTest`；`synthWav` 第三参分流：openai → `POST {baseUrl}/audio/speech`（`response_format:'wav'`），失败/超时/无 key **静默回落 WinRT** 并记一行日志（绝不弹窗变哑巴）；`gsv` provider 的 model 为空时自动 `GET /v1/models` 拉取；文本超 1500 字截断；渲染层 `engineOf()` 不用改（波形路径同 winrt）；托盘「功能开关→语音朗读→语音接入」面板（预设 + 一键测试，照 llm-providers 结构）；`verify-w47.js` 39 条断言（含负对照：分流判断改坏 → C1+C2 真红） | 同上 `InariNGT-Ofiicial/gsv-rvc-voice-bridge` MIT；网关无认证、只听 127.0.0.1、串行合成（防并发抢 GPU）；`maxChars` 是**文本**限制不是音频时长限制 |
| W48 | **proactive 加「决策 AI」**（借 group_chat_plus 的**决策 AI / 回复 AI 分离**，
  ⚠️ 该仓 **AGPL-3.0 → 只借思想自己写，不复制代码**）：判断"要不要插嘴"走
  **独立的轻量 LLM 调用**，不拼完整人格 + 全部记忆 + 全部历史 —— 把最贵的资源
  花在会被丢弃的判断上是浪费。现在是三道规则闸（quietHours / maxUnanswered /
  media），决策 AI 作为**可选增强**叠在闸门之后 |
  `Him666233/astrbot_plugin_group_chat_plus` 191★ AGPL-3.0；另两个可借机制：
  GWW（按**用户粒度**隔离等待窗口，不劫持他人消息）· 频率调整 AI（按活跃度自适应概率）|

| W49 | **Mnemosyne「已被取代的证据」检索维度**（2026-10-31 归档 §21.3）：记忆事实加 `supersededBy` 状态（被新事实推翻时标记、不再优先召回），与 G19 日结（只降不删）天然兼容；AGPL 只借思想 | dsh-mnemosyne |
| W50 | **心境 → 采样温度**（2026-10-31 归档 §21.4）：LLM 调用按 mood/情绪档调 temperature（stress 高→冷淡、兴奋→发散），开关默认关 + 气质 A/B；小改动、接 `llm.js` 参数 | dsh-mood（MIT） |
| W51 | **互动收益递减**（2026-10-31 归档 §21.4）：摸头/戳/投喂收益 100%→70%→40%→20%→5% 递减（同日内），替代 W13 的硬次数上限，体验更软 | dsh-mood（MIT） |
| W52 | **动作编排层**（2026-10-31 归档 §21.7）：自然语言 → Live2D 动作时间线（计划→校验→播放）；表外大项，非优先（当前即时态表情够用）· 无 LICENSE 仓库 → 只借思路 | jingyu-live2d-agent |

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
| M1 | ✅ **本地允许空 Key**（2026-10-29 完成） | 判定收到 `llm-providers.isUsable`：**有 key 或端点在本机**才可用。`streamLLM` / `memory.extractViaLlm` / 主进程记忆闸门 / 渲染层（改读 `llm.usable` 派生字段）四处一起改 |
| M2 | ✅ **连接预设一键填 + WorkBuddy 导入**（2026-10-29 完成） | 托盘「设置 → 模型接入」：9 条预设（DeepSeek / 通义 / 智谱 / Kimi / 硅基流动 / OpenRouter / Ollama / LM Studio / 自定义）+ 从 `~/.workbuddy/models.json` 导入自定义模型 + 填写 Key 小窗（不扩 IPC 面，同改名对话框套路）+ **真测一句**（M4 提前做掉：按 401/404/429/超时分别给可动手的结论）。⚠️ 切预设**不动** apiKey；旧配置按 baseUrl 反查打勾项 |
| M3 | ✅ **拉模型列表**（2026-10-30） | 设置页「拉取列表」→ `GET …/models` 填 datalist；失败可手填；Ollama `models[]` / OpenAI `data[]` 都认 |
| M4 | ✅ **真测一句**（2026-10-29，随 M2 一起） | `testLlm(override?)` 发极短 chat；页内可先测再存；失败按状态码翻译 |
| M5 | ✅ **设置页露出来**（2026-10-30） | 「模型设置…」：Base URL / Model / Key / 卡住超时 / 整轮上限 / extraBody 高级折叠 + 页内测试与拉列表 |

### G-LLM 中期

| ID | 项 | 注 |
|---|---|---|
| M6 | ✅ 多配置档切换（2026-10-30） | `llm.profiles` + `activeProfile`；托盘「配置档」存/切/覆盖/删；切后顶层字段同步 |
| M7 | ✅ 本地首包引导（2026-10-30） | 「检测本机端点…」探 Ollama/LM Studio；命中则填 baseUrl；文案指路 pull，不内置权重 |
| M8 | ✅ 云端目录精简（2026-10-30） | 托盘顶层 DeepSeek/通义/本地/自定义；其余「更多…」；`tested` 指纹自测才 ✓ |
| M9 | ✅ 超时按场景（2026-10-30） | 切本地预设 stall 45s / total 180s；云端 20s / 120s（`TIMEOUT_LOCAL/CLOUD`） |

**明确不做**：内置捆 GGUF、自研推理引擎、非 OpenAI 协议各写一套客户端。

---

## H. 建议开干顺序

1. ~~**M1 → M2 → M4 → M5**~~ ✅（含 M3 拉列表）  
2. ~~**M6**~~ ✅ 多配置档  
3. ~~**P1 + P2 + P3**~~ ✅；~~**X1**~~ ✅ 运行时切模型  
4. ~~**G1–G4 / X2**~~ ✅  
5. ~~**P4 / X3 / X4 / M7**~~ ✅  
6. ~~**M8 / M9 / G5 / G6**~~ ✅  
7. ~~**X5 / G13**~~ ✅  
8. ~~**P5 / P6 / P8 / G7 / G8 / G14 / G15**~~ ✅  
9. ~~**G19 2a / G9 / P7 / X6–X8 / G16 / G20**~~ ✅  
10. ~~**G10–G12 / G17 / G19 2b**~~ ✅  
11. ~~**G18 / G22 / G25–G27 / G30**~~ ✅ → 续 G21/G23/G24/G28/G29 / W  
10. **Tauri 迁壳（§J）** — 暂缓（用户指定先不做 T0）

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
| 2026-10-28 | 记 **气泡美化 W36–W41**（tiny-roommate 交互规范 / dsh-pet 气泡二次修复 / OpenAlice 素材验证）；专文 `docs/bubble-polish-plan.md` |
| 2026-10-28 | 气泡第一批 **C1/C2/A1/A2/B2/B3 已实施**；第二批 **W36 宽高比多档 + W40 三候选**已实施（含真机验证 + 五条负对照）；🔴 顺手抓出 `hashJitter` 越界 bug（`^` 转回有符号 int32，实测吐 −18/−21/−23 而约定是 ±8） |
| 2026-10-28 | 气泡第三批 **C3 打字光标 + D1 停留时长随字数**已实施（六条负对照）；**W42 情绪角标**已实施（六条负对照 + 真机）；🔴 抓到并修掉"改注释留下裸文本 → CSS 整块规则被吃掉"（角标一度掉到泡体下方） |
| 2026-10-28 | 🔴 **「屏幕上一大一小两个她」定位并修复**（此前判为"与底座无关"是**错的**）：底座出现 → `--stats-h` 变化 → `layout()` → canvas resize → 缩放 0.1169↔0.1047 差 11%；`preserveDrawingBuffer:true` 让旧帧被保留拉伸 → 一大一小，**只有一个底座**，且**截图抓不到**。修：resize 后 `clear()` + 立刻补画一帧。回归 `verify-resize-clear.js` |
| 2026-10-29 | 右键菜单**定稿 = 光标处卡片菜单**（轮盘 / 头顶泡泡归档为技术储备，`interaction.petMenu` 三档可切）。依据：MIT 6.831 的原话是"pie 快 15–20%，但效率优势不足以抵消线性菜单的外部一致性与布局简单性"；Electron 原生菜单不可样式化（issue #4990）。回归 `verify-card-menu.js` |
| 2026-10-29 | 🔴 **「两个她」的最终修法（用户拍板："始终是加了底座时的大小，这样就不用担心加载底座后大小切换的问题了"）**：`--stats-h` 在 boot 里、**第一次 `layout()` 之前**冻结成"牌摆满"那一档（含没开悬浮显示时），转圈 / 出数 / 开关开关都不再改它 → 底座不再触发 canvas resize，链路从源头断掉；清屏 + 整窗 invalidate 降级为真 resize（窗口 / 换模型 / 改缩放）的保险。回归：`verify-resize-clear.js`（[B] 段 + 3 条负对照全红）+ 真机探针 `probe-stats-freeze.js`（`--stats-h` 恒 34px、canvas 1391×1356 全程不变、首帧后 0 次 resize；含 1 条负对照） |
| 2026-10-29 | 记 **`PC2005-cloud/dsh-pet`（4733★，视频片段宠物）**：W43–W46。核心判据 = **它的"组合"在时间轴上（换源串行），不在画面上（无图层叠加）**，靠"表情不可组合"换"素材 O(N)"；我们属大状态空间（情绪×动作×朝向×口型）→ **只借调度层**。🔴 同名不同仓：与 `MerZlin/dsh-pet-indesktop` 无关。🔴 许可：代码 MIT / 素材禁商用 / 形象 CC BY-NC-SA。专文 `open-source-reference.md` 第 18 轮；并**订正** `custom-model-plan.md` §10.2 D 行「已批判（状态爆炸）」的判据 |
| 2026-10-29 | 🔴 **「两个她」第四次 = 真凶（用户第三次报「还是出现了两个模型」）**：底座无辜 —— 真因是**启动期窗口连缩**（宽 324→312→310、高 344→342），每次缩小都 resize 画布，而「缩小」正是合成层残留的唯一来路（旧帧比新视口大）。修法：`syncStageWidth` **只增不减**（`want <= innerWidth+2` 只记账不上报；窗口透明 + 命中测试穿透让多出的空白无害）+ `applyStageWidth` **不调 `refreshWinSize`**（高度只在屏幕真变时变）。实测 `canvasResize` 3 次 → **1 次**；负对照短路该判断立刻回到 3 次。回归 `verify-resize-clear.js` [C] 段 |
| 2026-10-29 | 🔴 **「幻影参数」大 bug**：框架 `getParameterIndex` 拿字符串和 `CubismId` 对象做 `!=` 比较 → 永远 miss → 写进 `_notExistParameterValues`；`getParameterValueById` 读的是同一张表，所以**读回来自洽、画面不动、零报错**。⇒ whale 的 16 字段情绪、口型、摸头 delta **从未真正画出来过**。修法：`paramIndexOf` 建「名→索引」表（按 model 实例缓存）+ 全走 `set/getParameterValueByIndex`。回归 `verify-param-channel.js`（12 条） |
| 2026-10-29 | **情绪贴纸（whale）**：44 个 exp3 里挑 7 个「贴纸类专属参数」映射到情绪档（星星眼/吐舌/问号/流汗/阴暗/感叹号/闭眼口水），随 `decayAmt` 淡入淡出；共享参数自动过滤、绝对写 `def+value×强度`、归零写回默认值；开关 `appearance.stickers`。真机五档全亮（happy 星星瞳 / think 红问号 / shy 汗滴 / serious 灰脸 / sleepy 口水）。回归 `verify-stickers.js`（46 条） |
| 2026-10-30 | **按开干顺序落地**：M5 模型设置页（超时 + extraBody + 页内测试）· M3 拉 `/models` 列表 · P1 六套人设预设（托盘子菜单）· P2 工作态/久别台词池（`line-pools.js`）。回归 `verify-llm-providers.js` + `verify-line-pools.js` |
| 2026-10-30 | **M6 + P3 + X1**：多配置档（`llm-profiles.js`）· OCEAN 三档性格微调（`ocean.js` → idle/衰减/气泡/pride）· 运行时切 hiyori/whale（`applyProfile` + 署名）。回归 `verify-llm-profiles.js` / `verify-ocean.js` / `verify-model-switch.js` |
| 2026-10-30 | **G1–G4 / X2**：安静排程 12h 上限 · 前台进程 hint · 打断可掐流并截历史 · 衰减到底回 calm 标签 · 状态三档陪伴/日常/勿扰。回归 `verify-quiet-hours.js` / `verify-presence.js` |
| 2026-10-30 | **P4 / X3 / X4 / M7**：人格招牌四态 · 拖文件进记忆 · 单摆/翻转 · 本机端点检测。回归 `verify-p4-x3-x4.js` / `verify-local-guide.js` / `verify-line-pools.js` |
| 2026-10-30 | **M8 / M9 / G5 / G6**：目录精简+绿标 · 本地/云端超时 · cdi3 扫描骨架 · 药盒下一句。回归 `verify-llm-providers.js` / `verify-model-scan.js` / `verify-oneshot.js` |
| 2026-10-30 | **X5 / G13**：边缘线索（电量/CPU/切应用，默认关）· 对话导出 MD/JSON。回归 `verify-edge-cues.js` / `verify-chat-export.js` |
| 2026-10-30 | **P5/P6/P8/G7/G8/G14/G15**：气质慢层 · 陪伴/专业 · 角色卡导入 · 信息增益 · think 开关 · 截屏隐藏 · 气泡穿透。回归 `verify-temperament.js` / `verify-info-gain.js` / `verify-character-card.js` / `verify-g8-g14-g15.js` |
| 2026-10-30 | **G19 Phase2a**：重要度纯函数 · 清晰度四档 · 迁移/日结只降不删 · 模糊注入前缀。回归 `verify-memory-phase2a.js` + `verify-memory.js` |
| 2026-10-30 | **G9/P7/X6–X8/G16/G20**：人设护栏 · 视角蒸馏 · 作息直方图 · 工作↔mood · memory 快照 · drowsy→sleep · 打断嘴归零。回归 `verify-persona-guard.js` / `verify-rhythm-distill-sleep.js` / `verify-lip.js` |
| 2026-10-30 | **G10/G11/G12/G17/G19 2b**：TTS 有限并发 · 文字口型 · MCP 骨架 · mount 清 stage · forget 默认关+墓碑。回归 `verify-g10-g12.js` + `verify-config-defaults.js` |
| 2026-10-30 | **G18/G22/G25–G27/G30**：whale 真脸情绪+表情槽预览 · 主动由头四类 · 伪造用户句 · 热键/多屏 hop 默认关 · verify-arch。回归 `verify-g18-g30.js` / `verify-arch.js` |
| 2026-10-30 | **W6/W13/W30/W32–W34**：悬停渐隐穿透 · 连点/过摸生气档 · 置顶看门狗 · 档案自证+emotionAlias+mouthOpenMax。回归 `verify-expressive.js` |
| 2026-10-30 | **W7/W8/W14/W31**：锁屏清零重计 · OS 截屏排除(=G14) · TTS 三级降级 · 不可用置灰。回归 `verify-w7-w14-w31.js` |
| 2026-10-30 | **G23/W15/W16**：看一眼屏幕（藏窗截屏→多模态）·「看看」口令 · 真测就绪门闩。回归 `verify-glance.js` |
| 2026-10-30 | **W5/W9/W26/W27**：位置钉稀有换位 · 时段 idle 池 · 主动先记账 · reason/preview。回归 `verify-w5-w9-w26.js` |
| 2026-10-30 | **W10/W19/W20/W23/W24**：话痨维 T · 触摸 quiet/normal/eager · 气泡穿透(=G15) · 记忆重要度/清晰度(=G19)。回归 `verify-w10-w19-w20.js` + `verify-ocean.js` |
| 2026-10-30 | **W11/W25/W43**：情绪分轨 TTS · 初次相遇独立轴 · pickers 纯函数。回归 `verify-w11-w25-w43.js` |
| 2026-10-30 | **W1/W12/W29/W44**：限时看屏授权 · PetEvent 总线 · Agent JSONL · workStatus+attention。回归 `verify-w1-w12-w29-w44.js` |
| 2026-10-31 | **第 21 轮调研归档**（`open-source-reference.md` §21）：7 个外部源逐条核实（Coopanion 许可实证=AGPL-3.0-or-later、Mnemosyne 记忆三层、dsh-mood 心情对照、dsh-pet npm 发行线、SnowLuma=协议框架不碰、鲸语=大肥鱼官方编排工具交叉印证 deepfish 接入、DSH 组织全貌）。新增 W49–W52（已被取代证据维度 / 心境→temperature / 互动收益递减 / 动作编排层） | 用户给的 7 个地址 |
| 2026-10-30 | **第三方模型「大肥鱼」(deepfish) 接入**（VTS 包改来，Cubism 5）：`profiles/deepfish.js` 档案（8 情绪 × 16 字段 · 10 个安全参数 · 三张表情表 key 参数互不重叠）· `params.js` 四注册表 + `main.js` 菜单（署名 toast）· **头物理链输入是 AngleX/Y/Z**（非 ParamAngle*，与 hiyori 相反）· ParamBrowL/RAngle 是物理输出（与 whale 不同）· 无眉 X/Form、无微笑眼、无连续脸红、无呆毛 → 全部置 null · 素材禁二次分发 → 不进安装包、不进 models.zip · 回归 `verify-deepfish.js`（六段断言 + 两负对照） | 素材自带使用须知（神宫凉子 / 霓虹猫） |
