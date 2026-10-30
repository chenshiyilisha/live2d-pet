# 记忆 Phase 2 改造清单（G19）

> **状态：2a 已落地；2b 遗忘开关+墓碑已落地（默认关，2026-10-30）**。依据 `docs/open-source-reference.md` 第 16 轮 §16.2 / §16.9，
> 只借**机制**（surfcore 为 `NOASSERTION`，一行代码不搬，命名与常量全部自己定）。
> 目标：让记忆**会淡**、**能复习**、**记得重要的**，且全程确定性、可单测、可关。

---

## 0. 范围与分期（先做哪一半）

Phase 2 拆两批做，**2a 可单独发版、可回滚**：

| 批 | 内容 | 可逆性 |
|---|---|---|
| **2a** | 重要度打分 · 四档清晰度 · 每天最多降一档 · 离线补跑 ≤30 天 · 复习回升 · 注入分档 | **只降档，不删正文** —— 纯可逆，最差是"记忆变模糊"，不会丢 |
| **2b** | 到期真遗忘（删正文、留墓碑）、容量压缩按档位淘汰、初次相遇独立轴 | 不可逆，等 2a 跑够一个版本再开 |

**2b 的开关默认关**（`memory.forget.enabled: false`），2a 的行为默认开。
理由：规矩 24 管的是"打扰类 / 占资源类"，衰减不属这两类；但"删正文"属于不可逆，必须显式开。

---

## 1. 现状盘点（改造前的事实，含行号）

`src/main/memory.js`（425 行，纯函数为主，`debug/verify-memory.js` 不启 Electron 就能测）：

| 位置 | 现状 | 问题 |
|---|---|---|
| `:91 emptyStore()` | `{ version: 1, facts: [] }` | 没有时间锚点，无法算"过了几天" |
| `:166 upsertFacts()` | 合并时 `hits++`、`updated=now` | `updated` 一个字段同时被当成"文案更新时间"和"最近活跃" |
| `:225 scoreFact()` | `kind + hits*0.8 + recency + overlap*3` | **只是排序分**，不落盘、不决定去留；超限淘汰才用它 |
| `:247 recall()` | 每次注入 `hits++`，然后 `saveStore` | **注入 ≠ 用户提到**，常驻的 name 事实会被自己的注入养到永远最优先 |
| `:289 formatMemoryLine()` | 只拼 `text`，budget 按 `text.length` 算 | 没有档位概念，加前缀会撑破预算 |
| `:203` 淘汰 | 超 `maxFacts` 按 `scoreFact` 升序丢 | 五五开地丢，不看"这条还有多清楚" |

调用点：`main.js:1632 memoryLine()`（召回 + 拼行）、`main.js:1647 rememberAfterTurn()`（写入）、
`main.js:1914 injectMemoryContext()`（插到 `messages[1]`，顺序 `[人设, 心境, 记忆, 媒体, 复读, ...历史]`）。

**当前用户数据**：本机 `%APPDATA%/live2d-pet/memory-facts.json` **不存在**（一条记忆都没写下来）。
但这不代表线上没有 —— v0.3.0 已发版，别人的档里可能有 v1 数据，**迁移必须做**。

---

## 2. 数据模型 v2

`version: 2`，facts 每条新增字段（旧字段全保留，语义收窄）：

```js
{
  // 原有
  id, text, kind, at, updated, hits, source,
  // 新增
  importance,      // 1..100，写入时算一次，之后只在合并时取 max
  clarity,         // 'vivid' | 'clear' | 'fuzzy' | 'trace'
  lastSeen,        // 用户**真实提到**它（复习）的时间；0 = 从没被提到
  recallCount,     // 复习次数（不是注入次数）
  pinned,          // name / boundary / importance>=65 → 清晰度有下限、不参与淘汰
  firstEncounter,  // 初次相遇轴（2b 才消费，2a 只写入不表现）
  migrated         // 迁移标记，见 §2.2
}
```

store 层新增：`decayDay`（上次结算的**本地日序号**，`Math.floor((now - tzOffset)/86400000)` 同口径）、
`firstAt`（最早一条 fact 的 `at`，初次相遇窗口的起点）、`stats: { forgotten: 0, dropped: 0 }`。

### 2.1 三个时间字段的语义必须分开（这是本轮最容易被写错的一处）

| 字段 | 谁写 | 语义 |
|---|---|---|
| `at` | 建条时 | 第一次被你记住 |
| `updated` | 合并/改写文案时 | **文案**最后一次变 |
| `lastSeen` | 用户提到它时 | **人**最后一次说到这件事 |

⚠️ 现在 `updated` 兼着"最近活跃"，被 `scoreFact` 的 recency 用；改造后 recency 一律改读
`lastSeen || updated || at`，**否则「文案更新」会冒充「被提到」**，衰减层的输入直接脏掉。

### 2.2 迁移（v1 → v2）三条硬规则

1. **不追溯降档**：所有旧 fact 起手 `clarity='clear'`，`migrated=true`，`decayDay=今天`。
   → 升级当天不会出现"一片记忆突然变模糊"。
2. **重要度背填用同一个纯函数**，但取 `max(scoreImportance(text,kind), KIND_BASE[kind] + hits*4)`。
   原因：旧 `text` 已被 `trimFact` 截到 40 字，情绪词/感叹号多已丢失，纯函数会系统性打低分。
   ⚠️ 这是**已知偏差**，不是 bug —— 所以旧条目的分数只能用来"排序"，不能用来触发 2b 的删除；
   2b 的删除判据只认 `migrated=false` 的条目。
3. **幂等**：迁移函数跑两次，结果逐字节相同（`verify-memory` 要断言）。

---

## 3. 重要度 = 纯函数（不调模型）

落 `src/main/memory-score.js`，输入只有 `(text, kind, source)`，**同输入必同输出**。

| 项 | 取值 |
|---|---|
| 基础 | +10 |
| 种类 | `name +45` / `boundary +40` / `relation +18` / `pref +15` / `other +5` |
| 情绪浓度 | 强情绪词 +8/个、普通情绪词 +3/个，合计封顶 +24 |
| 强调 | 感叹/重复标点 +2（只算一次） |
| 太短 | 有效字数 < 6 → −10 |
| 「第一次/最早/以前从来没」 | +25 |
| 承诺/约定（`答应|以后|每天|一直|永远|不许|必须`） | +15 |
| 矛盾/道歉/和好（`对不起|抱歉|其实我|之前是我`） | +12 |
| 来源 | `source='llm'` → −5（启发式是用户原话直抽，更硬） |

`clamp(1, 100)`。**唯一一处定义**（规矩 9），`config.js` 不留副本。

**为什么在写入时算、不在召回时算**：召回时算 = 分数随文本外的上下文漂移，同一句话今天 vivid
明天 fuzzy，用户会觉得"她怎么突然忘事"。写入时算一次并落盘，才可解释、可回滚。

---

## 4. 清晰度：阈值与 retention

```
retention = importance
          + min(12, recallCount * 2)                 // 复习
          + 新鲜加成(ageDays<=2 ? 8 : ageDays<=7 ? 4 : 0)
          + (lastSeen 在 2 天内 ? 8 : 0)
          - 时间惩罚                                          // ageDays > 14 起算
时间惩罚速率 = pinned ? 0.12/天 : 0.35/天
```

| 档 | retention | 注入行为 |
|---|---|---|
| `vivid` | ≥ 70 | 原样进 prompt（今天的表现） |
| `clear` | ≥ 50 | 原样进 prompt |
| `fuzzy` | ≥ 30 | 进 prompt，但**降级措辞**："记得不太准" |
| `trace` | ≥ 10 | **不进常规注入**；只有召回闸门命中（`RECALL_CUE`）时才以"好像有过这么回事"出现，最多 1 条 |
| 遗忘 | < 10 | 2a：压在 `trace` 不删；2b：删正文留墓碑 |

**下限（floor）**：`pinned === true`（name / boundary / importance ≥ 65）→ 永不低于 `clear`。
这条是"她不会忘了你叫什么"的全部实现，必须单独断言。

常量 `FUZZY_AFTER_DAYS=14`、`RATE_NORMAL=0.35`、`RATE_PINNED=0.12`、四个阈值、
`CATCHUP_MAX_DAYS=30` 全部只写在 `memory-score.js` 顶部一块 `CLARITY` / `RETENTION` 常量区。

### 4.1 初次相遇（2b 才表现，2a 只打标）

窗口 = `store.firstAt` 起 30 天；窗口内创建、且 `sha1(id+'first')` 落在该窗口概率内的条目，
**按散列排序取前 3 条**打 `firstEncounter=true`（不是每次随机，同一份档永远同一批）。
`floor = clear`，不参与容量淘汰，注入时单独成段「最初的日子」。

---

## 5. 结算 settle：每天最多降一档 + 离线补跑

纯函数 `settle(store, now, opts)` → `{ store, dropped, risen, forgotten, awayDays }`。

```
if (今天 == store.decayDay) return 无变化          // ← 幂等的唯一来源
step   = min(今天 - store.decayDay, 30)            // ← 离线补跑上限 30 天
每条的档位序 iNext：
  iNext = clamp( iTarget , iCur - step , iCur + 1 )  // 降：一天最多一档；升：一次结算最多一档
  iNext = max(iNext, iFloor)                         // pinned / 初次相遇 的下限
store.decayDay = 今天
```

- **降多快**由 `step` 限速，**降到哪**由 `retention` 决定 —— 两者分开，才不会出现"停了 3 个月回来全没了"。
- **坏钟**：`decayDay` 非数字 / 在未来 → **不补跑**，直接把 `decayDay` 归到今天（规矩 34
  的"坏档不按坏钟补漂"，mood 里是同一个坑）。
- **不落盘就不算结算过**：`saveStore` 失败时 `decayDay` 不许推进（否则这段时间永远不结算了）。

调用点：
1. 启动时 `loadStore()` 之后跑一次（离线补跑），打一行 `[memory] settle away=…d dropped=…`；
2. 自调度 timer **6 小时**一跳（规矩 16：`setTimeout` 链 + 代际令牌 `gen`，
   await 前后各查 `gen`；**绝不用 `setInterval`**）；
3. 退出前 `saveStore`（现有退出路径补一行）。
⚠️ 不和 mood 的 10s 心跳共用（粒度差 2000 倍），各自自调度。

---

## 6. 召回/注入要改的两处（都是行为可见的）

### 6.1 复习判定：注入 ≠ 提到

```
if (query 的 token 与 fact 的 token 有重叠 ≥1) { recallCount++; lastSeen = now; }
hits++   // 仅"被注入次数"，只参与排序，不喂 clarity
```
否则 name 事实天天被注入 → 永远 vivid → 整个衰减层是装饰品（**这一类就是"看起来在动、其实没变"的静默 bug**）。

### 6.2 分档文案与预算

`formatMemoryLine(facts, budget)` 里，前缀计入 `used`：

```
vivid/clear  → 原句
fuzzy        → 「记得不太清：」+ 原句
trace        → 「好像有过这么回事：」+ 原句（只在扩召时出现）
```
段首说明补一句：**"标了『记不清』的不要当事实硬说，也别否认。"**
⚠️ 现在 budget 用 `bit.length` 算，加前缀后必须改成算前缀 + 原句，否则整行超 `injectChars`
（规矩 21 同款"少算一段"的坑）。

---

## 7. 配置与菜单

`config.js` 的 `memory` 段（`:146`）加：

```js
decay: true,                 // 四档清晰度 + 每天降一档
catchUpDays: 30,             // 离线补跑上限
forget: { enabled: false }   // 2b 才用：到期删正文
```
`LIMITS` 不加（这些不是用户可拖的滑杆）。**逐段逐键合并**由现有 `patchConfig` 保证（规矩 1）。

菜单：**不新增顶层项**（规矩 5），挂到已有的「长期记忆」项的**子菜单**里：
`记忆会慢慢变淡` / `清空全部记忆`。改完跑 `tray-dump` 数行数。
关掉 `decay` 时：`settle` 不跑、`clarity` 不参与注入分档 —— 与改造前逐位一致（零侵入）。

---

## 8. 文件清单

| 文件 | 动作 | 规模 |
|---|---|---|
| `src/main/memory-score.js` | **新增**（纯函数：重要度 / retention / target / settle / 常量） | ~200 行 |
| `src/main/memory.js` | 改 6 处：`emptyStore`、`loadStore`(迁移+settle)、`upsertFacts`(打分/复活墓碑)、`recall`(复习判定)、`formatMemoryLine`(分档)、`saveStore`(失败不推进 `decayDay`) | +120 / −20 |
| `src/main/main.js` | 3 处：`memoryLine` 传 cfg、启动 settle 日志、`memoryTick()` 自调度 | +40 |
| `src/main/config.js` | `memory` 段 +3 键 + 注释 | +8 |
| `debug/verify-memory.js` | **+10 节**（见 §10） | +180 |
| `docs/enhancement-backlog.md` | G19 行标进度 | 1 行 |

`memory.js` 会到 ~520 行，仍在"纯函数搬出去"的规矩里（新逻辑全在 `memory-score.js`）。

---

## 9. 实施顺序（每步可独立停下、可单独验证）

| 步 | 做什么 | 停在这里也安全吗 |
|---|---|---|
| **P0** | 写只读脚本 `debug/sample-memory-score.js`：喂一批真实口吻的句子 + 现有档（若有），打印 importance 的 `min/p50/max`，以及 7/30/90/180 天后各档人数 | ✔ 不改运行时代码 |
| **P1** | `memory-score.js` 纯函数 + `verify-memory` 第 1–4 节；**先只用 P0 的分布调阈值** | ✔ 死代码 |
| **P2** | store v2 + 迁移 + `settle`（**还不接 tick、不接注入**），`verify-memory` 第 5–8 节 | ✔ 只有落盘多几个字段 |
| **P3** | 接 tick（启动 + 6h 自调度）+ 日志 | 可回滚：删掉 timer 即回 P2 |
| **P4** | 注入分档 + 复习判定 + budget 修正 | ⚠️ 这一步才行为可见 |
| **P5** | 托盘子菜单 + `verify-config-defaults` + `tray-dump` | ✔ |

**P0 不是可选的。** 上一轮的教训写在 MEMORY.md：每引入一个派生量，先单独测它的分布
（`min/p50/max`、量级是否符合预期、随状态有没有变化），**再往主路径上接**；
不能等跑完再看总效果 —— `retention` 和 `importance` 都属于"落在合理区间就看不出来"的量。

---

## 10. 验收：`verify-memory.js` 新增 10 节

| # | 断言 | 类型 |
|---|---|---|
| 1 | `scoreImportance` 同输入两次调用 deepEqual；clamp 到 1..100；`name > pref > other` | 纯函数 |
| 2 | 情绪词/感叹号逐个加，分数**单调不减** | 纯函数 |
| 3 | `settle` 同一天连调 3 次，store 逐字节相同 | 幂等 |
| 4 | 跨 1 天：任一 fact **最多降一档** | 限速 |
| 5 | 离线 90 天：`awayDays` 截到 30，降档数 ≤ 30，**且不越界到删除** | 补跑 |
| 6 | `pinned` 的 name/boundary 在 365 天后仍是 `clear` | 下限 |
| 7 | `fuzzy` 的 fact 被 `recall` 提到一次 → 次日结算升一档 | 复习 |
| 8 | 同一批 facts，`clarity` 改成 fuzzy/trace 后 `formatMemoryLine` **输出确实变了**（含前缀、trace 不进常规注入） | 消费端 |
| 9 | v1 档 → 迁移后 `facts.length` / `id` / `text` / `kind` 不变，`clarity` 全 `clear`，`decayDay=今天`；跑两次结果相同 | 迁移 |
| 10 | **负对照**：把 `RATE_NORMAL` 通过 `opts` 临时置 0 → 第 4/7 节必须变红；把 `decay=false` → store 逐字节不变 | 负对照 |

第 10 节是硬要求：只见过绿色的断言不算证据。

---

## 11. 风险与回滚

| 风险 | 处置 |
|---|---|
| 老用户记忆集体变模糊 | 迁移不追溯（§2.2-1）+ `FUZZY_AFTER_DAYS=14` + pinned 有下限 |
| "记忆消失"不可逆 | 2a **只降档不删**；2b 独立开关、默认关 |
| 注入自增强让衰减失效 | 拆 `hits` / `recallCount`（§6.1）+ 第 7 节断言 |
| 结算重复扣 | `decayDay` 日粒度幂等 + 落盘失败不推进 |
| prompt 超预算 | 前缀计入 `used`（§6.2）+ 第 8 节断言 |
| 与 mood 抢心跳 | 6h vs 10s，各自自调度，不共用 |
| 常量两处定义 | `memory-score.js` 一处；`config.js` 只留开关（规矩 9） |

**回滚**：`memory.decay=false` 即回到改造前行为（第 10 节第 10 条保证逐位一致），
不需要回退代码；store 里多出的字段对旧读取路径无影响（`isFact()` 只校验必填项）。

---

## 12. 本轮明确不做

- 不搬 surfcore 代码（`NOASSERTION`），不引入它的文件格式与 key 名。
- 不做向量/embedding 召回（现有 token 重叠够用，加进来是另一个量级的事）。
- 不做"容量告警 80/90/100% + 一键压缩"（我们 `maxFacts=60` 的规模不需要）。
- 不改 `maxFacts` / `injectMax` / `injectChars` 的默认值 —— 分档会自然减少注入量，
  要调等 2a 跑过一个版本看真实分布再说。
- 不做 `proactive` 的"先记账后生成"（W26）：那是另一条路径，单独出清单。
