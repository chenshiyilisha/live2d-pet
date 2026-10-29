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
| W36 | ~~气泡**避免窄高盒**：宽度多档自适应~~ **✅ 2026-10-28**：`WIDTH_STEPS=[272,320,368]`，`wantWidth(h,cur,avail)` 按 `h×1.2` 升档；🔴 **一次发言内单调不减**（加宽→变矮→不许收窄，否则流式打字时来回抖）；每句开头重置回 272；只卡**下限**不卡上限（短句横条是自然的）。真机：长回复 272→320（比例 1.33），落定后 700ms 不再变 | tiny-roommate「prefer landscape, avoid narrow tall boxes」；dsh-pet 把 1.65 调到 **1.20** |
| W37 | ~~气泡位置**轻微有界随机化**（稳定散列，同句同位）+ **间距随高度**（矮近高远）~~ **✅ 2026-10-28**：±8px 确定性散列（每句一次、`place()` 不重算）+ `tipGap` 8→14 随高度插值；尾巴恒回正指人（`bubble:tail`） | tiny-roommate「bounded and subtle」「short closer, taller more breathing room」 |
| W38 | ~~气泡**淡出动画** + 入场加 `scale` 展开~~ **✅ 2026-10-28**：出场 `bubble:fade`→`.fading` 160ms 后真 hide（与入场对称）；入场由主进程 `bubble:show` 驱动（常驻动画只有第一句有）+ `scale .96→1`；实测淡出中 alpha 132/255 | 现行为不对称；OpenAlice 留白正是为 scale 动画准备的 |
| W39 | ~~气泡描边**用 drop-shadow 不用 border** + 两层阴影~~ **✅ 2026-10-28**：两层阴影（1/2 + 3/8）+ 描边 `chat.floatBubbleOutline`（**默认关**，用户曾两轮减描边）；强度实测定 1px/0.65，尾巴根部无内部边线 | dsh-pet 气泡二次修复「根因一」；**直接加 border 会重现该 bug** |
| W40 | ~~气泡**上方弧线三候选** + 回退顺序 + 零相交优先 + 尾巴随位转向~~ **✅ 2026-10-28**：`pickAnchor()` 纯函数；**常规恒 top**（正上方最自然），只在 ① top 被屏幕边 clamp ② 头顶上方放不下退回窗内 时才用 left/right（inside 时偏一侧 = 盖肩膀不是盖脸）；可用判据 =「想要的 x 不被 clamp」（不需要人物宽度实量）；尾巴回正上限改随宽度算 `w/2−26` | tiny-roommate「allowed family = top-left/top/top-right，side 不参与」；dsh-pet 安全布局器「优先零相交」 |
| W41 | 多套**气泡皮肤**可切换（外观下拉） | dsh-pet 已有 5 套；Live2DPet `selectBubbleImage`。**最大项，最后做** |
| W42 | ~~气泡**情绪角标**（方案 A）~~ **✅ 2026-10-28**：8 情绪 → 小图形挂气泡右上角；信号走 `emitChatEmotion` 唯一出口双发（规矩 27）；**跟标签不跟衰减**（否则角标自己变淡像坏了）；calm 不挂牌、认不出的收牌；角标**绝对定位不占布局**（实测有/无牌 72px = 72px，否则打乱 A3 与高度上报）。图形取 **Lucide（ISC）**现成路径，**不用 emoji 字符**（字形随系统变 + llm.js 清洗器本来就在丢 emoji） | dsh-dfy 原话「爱心/怒气/问号…均为**视觉特效，不是文字占位**」；位置依 **Material Badge** 规范（默认右上角 + 允许压宿主边） |

| W43 | **动作池配置化**：把 `motion.js` 里硬编码的随机动作改成数据段 `animations{idle, turn, move, categories[{id,weight,actions,noMirror}]}` + `animationWeights{idle,turn,move}`（turn/move 权重按 0 算时**不归一化**，份额自然落到分类）；抽 `pick` / `pickSlot` / `rollKind` / `pickWeightedCategory` 成纯函数（排除当前避免连抽，**排除后池空退回原池**） | `PC2005-cloud/dsh-pet` `assets/config.jsonc:241-361` + `shared/pickers.ts`；见 `open-source-reference.md` 第 18 轮 §18.2 |
| W44 | **事件档位数组**：`events.workStatus[6]`（thinking/working/result/waiting/success/error）**索引即档位、新档只可追加到末尾**；播完分支抽 `decideEndedCue` 式纯函数（档内轮换 / 续播 / 事件结束 / 回归随机）。正好接第 17 轮待补的 `attention` 档 | 同上 `cues.ts`；⚠️ 与我们「配置逐段逐键合并」（规矩 1）天然契合，但**中间插档 = 静默错位**，写进注释 |
| W45 | **换源四条硬细节**（对照我们的实现逐条核）：① `loadeddata` ≠ 开始出画，要等 `play()` 兑现才回执；② `ended` 只认前台元素（后台残留 handler 会掐断当前动画）；③ 加载失败/超时**必须释放 pending**，否则防重分支把它永久吞掉 = **「点了没反应」**；④ blob + **世代号**丢弃迟到结果（= 规矩 16） | 同上 `animation.ts` / `asset-loader.ts`；③ 与规矩 24「关掉的入口不许点了没反应」同族 |
| W46 | **素材链存档为「第二交付路线」**（不换产品线）：20 段核心动作（idle / turn / drag / click×5 / 工作状态×6）≈10MB 就能撑起一个可用形象；管线 = AI 绿幕视频 → 抠像（**手工**，自动 HSV 残边）→ 归一化 → 640×360 webm(VP9-alpha) → Safari 另出 HEVC-alpha `.mov` | `custom-model-plan.md` §11 降档路线；🔴 **许可**：代码 MIT、**素材「禁止商用」**、形象 CC BY-NC-SA 4.0 → **只借结构，一行素材不能进包**（规矩 29） |

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
| M3 | **拉模型列表** | `GET …/v1/models` → 下拉选；失败可手填（Ollama/LM Studio 官方兼容端均有） |
| M4 | ✅ **真测一句**（2026-10-29，随 M2 一起） | `testLlm()` 发极短 chat（max_tokens 32、15s 超时）；失败按状态码翻译：401/403 key 无效 · 404 地址或模型名不对 · 429 限流/额度 · AbortError 超时。→ 只剩 M5（设置页）|
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
