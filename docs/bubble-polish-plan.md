# 气泡美化 / 强化方案（2026-10-28 查资料后出，未开工）

> **进度（2026-10-28 下午）**：第一批 **C1 / C2 / A1 / A2 / B2 / B3 已实施**，见 §8。
> 第二批 **A3 + B1/B4/B5 已实施**（含真机验证 + 五条负对照），见 §9。
> 剩：第三批 C3/C4、D1/D2、A4（多套皮肤，最大项，最后做）。

> 范围：`src/main/bubble.js` + `bubble.html` + `bubble-preload.js` + `bubble-priority.js`
> 以及主窗回退的 `src/renderer/style.css` `#bubble`。
> §1–§7 是方案与取舍；**§8 起是实施记录**。

## 1. 资料来源（三份一手，均经原文核实）

| 来源 | 性质 | 取了什么 |
|---|---|---|
| `ryannli/tiny-roommate` `docs/interaction-spec.md` | 桌宠交互规范（**专讲气泡**） | 放置候选 / 随机化 / 间距 / 形状偏好 / 跨屏 / 拖拽锚定 / 回归策略 |
| `MerZlin/dsh-pet-indesktop` `docs/BUGFIX-AND-FEATURES-2026-08-24.md` | 已上线项目的**气泡二次视觉修复**记录 | 尾巴接缝根因、阴影被窗口裁切、多套气泡方案、安全布局器、宽高比实测 |
| OpenAlice 气泡素材生成 + 像素级验证（GitCode 博客） | 素材规格与验证方法 | 几何确定性、留白为 scale 动画、三档尺寸 × 镜像断言、浅色背景暴露问题 |

（附带参考：Live2DPet 的气泡是独立透明渲染进程 + `selectBubbleImage` 允许换背景图。）

## 2. 现状盘点：我们已经做对的（别重复发明）

读完 `bubble.js` / `bubble.html` / `style.css`，以下七条**与资料建议一致**，不要动：

1. 气泡在人物**上方**（tiny-roommate 的「upper arc」），锚实量头顶 `headTop` → 不挡脸 ✔
2. 拖拽跟随 `syncPosition()`（33ms 节流）→ tiny-roommate 的「dragged 时不累积偏移」 ✔
3. `screen.getDisplayMatching()` + clamp 到 workArea → 跨屏跟随并钳制 ✔
4. 尾巴塞进 `#wrap` 的 `padding-bottom:21` 容身处 → **避开了 dsh-pet 踩的坑**：
   它用 `QGraphicsDropShadowEffect`，阴影扩散被窗口矩形裁切成「气泡下方一整块灰色托盘」；
   我们用 CSS `drop-shadow` 挂在 `#wrap` 上（按合成后轮廓算），泡体与尾巴共用一条连续阴影 ✔
5. `hasShadow:false`（透明窗必须关系统阴影）✔
6. 优先级仲裁 `bubble-priority.js`（stream / alert / status）✔
7. 常量联动有 `verify-bubble` [H] 段守着（8 / 21 / MAX_H / TAIL_TIP_INSET）✔

## 3. 差距与可强化项

### A. 视觉质感

| # | 项 | 做法 | 依据 | 成本 |
|---|---|---|---|---|
| A1 | **两层阴影** | 现单层 `drop-shadow(0 3px 8px rgba(25,25,28,.15))` → 加一层近景 `0 1px 2px rgba(…,.10)`，形成「贴桌 + 轻浮起」双层 | dsh-pet 修复后即用「两层低透明度、最大 2px 偏移的环境阴影」 | 小 |
| A2 | **浅色壁纸可见性** | 见 §4，**有坑，别直接加 border** | OpenAlice 明写要出 `bubble-light.png` 专门验浅背景 | 中 |
| A3 | **宽高比控制（避免窄高盒）** | 宽度从固定 272 改为**多档自适应**，目标让最终宽高比落在 **1.2 ~ 2.2** | tiny-roommate「prefer a landscape shape, avoid narrow tall boxes」；dsh-pet 实测把主体比例从 1.65 调到 **1.20** 对齐参考图 | 中 |
| A4 | **气泡皮肤可切换** | 配置开关 + 备选样式（含「吐气水泡」类不规则轮廓思路，但需 SVG 单路径） | dsh-pet 已有 **5 套**方案 + 外观下拉；Live2DPet 有 `selectBubbleImage` | 大 |

### B. 布局与位置

| # | 项 | 做法 | 依据 | 成本 |
|---|---|---|---|---|
| B1 | **上方弧线三候选** | 现只有正上方；加 top-left / top-right，按可用空间选 | tiny-roommate「allowed family is top-left, top and top-right，side 不参与」 | 中 |
| B2 | **位置轻微随机化** | 在候选位内 **±N px 有界、轻微**偏移，用**稳定散列**（同一句同一位置，不抖） | tiny-roommate「slightly randomized… stay bounded and subtle」 | 小 |
| B3 | **间距随高度** | 现固定 `TIP_GAP=10` → 矮气泡更近、高气泡多留呼吸 | tiny-roommate「short bubbles closer, taller bubbles more breathing room」 | 小 |
| B4 | **回退顺序** | 现 `insideMode` 一步退回主窗内顶部（**会盖脸**）→ 改为先试其他上方位置/侧上，最后才 inside | dsh-pet 安全布局器「依次尝试其他上方位置、左右侧和下方，优先选择与角色零相交的位置」 | 中 |
| B5 | **零相交优先** | 候选位打分时把「与人物矩形相交」作为扣分项 | 同上 | 中（依赖 B1） |

### C. 动效

| # | 项 | 做法 | 依据 | 成本 |
|---|---|---|---|---|
| C1 | **淡出动画** | 现直接 `win.hide()`（`bubble.html` 注释明写「来不及做动画」）。改：先发 `bubble:fade` 让渲染层挂 class，**160ms 后**再 hide | 入场已有 `pop .16s`，出场没有 → 不对称 | 小，**性价比最高** |
| C2 | **入场 scale 展开** | 现只有 opacity+translateY；加 `scale(.96→1)` | OpenAlice 明确「留白是为 CSS scale 展开动画不被裁剪」——我们 `#wrap` 的 `margin:8 10 0` 正好是这份留白 | 小 |
| C3 | **流式打字光标** | 正文末尾闪烁光标（`#text::after`），等待态保留现有「…」 | 常见做法，非资料强制 | 小 |
| C4 | **高度变化的平滑** | 现 `onContentHeight` 有 4px 抖动过滤，但仍是「换行即跳」的台阶。可在窗内用 transform 反向补偿 | 属打磨，非资料来源 | 中，风险中等 |

### D. 行为

| # | 项 | 做法 | 依据 | 成本 |
|---|---|---|---|---|
| D1 | **自动隐藏时长随字数** | 现固定 9000ms → 按字数在 [6s, 14s] 内插值 | 合理推断，**无资料支撑**，标为可选 | 小 |
| D2 | **鼠标穿透** | 气泡窗 `focusable:false` 但未 `setIgnoreMouseEvents` → 仍挡住下方点击 | backlog W20「可点穿」 | 小，⚠️ 会失去气泡内滚动/选中 |

## 4. 🔴 必须先看：A2 的坑（描边 + 尾巴接缝）

**想给白气泡加描边解决浅色壁纸可见性 → 会踩 dsh-pet 记录过的同一个坑**，原文两个根因：

> 根因一：旧实现**先绘制圆角矩形，再单独绘制三角尾巴**，矩形底边仍从尾巴根部穿过，
> 造成尾巴像后贴上去的错误层级。
> 修法：将圆角主体路径与尾巴路径**几何合并，形成单一矢量轮廓**，再统一填充和描边，
> 根部不再存在内部边线。

我们是 CSS 实现：`#shell`（圆角矩形）+ `#tail`（旋转 45° 的方块）。**当前两者都是纯白 `#ffffff`，
所以接缝看不见**；一旦给 `#shell` 加 `border`，矩形底边那条线就会横穿尾巴根部，露馅。

**正解（本轮最省的一条）**：`drop-shadow` 是按**合成后轮廓**算的，天然跨泡体+尾巴连续。
所以描边不要用 `border`，用第二层零偏移 drop-shadow 模拟：

```css
#wrap {
  filter:
    drop-shadow(0 0 0.75px rgba(20, 22, 28, 0.55))   /* 「描边」：沿合并轮廓，接缝无内部边线 */
    drop-shadow(0 1px 2px rgba(25, 25, 28, 0.10))    /* 近景 */
    drop-shadow(0 3px 8px rgba(25, 25, 28, 0.15));   /* 远景（现有） */
}
```

⚠️ 三个副作用要先量：① 三层 filter 的合成开销（本机是核显渲染，规矩 17/19 的降帧红线）；
② 「描边」层会让 `report()` 报的高度**不变**（filter 不占布局），但视觉外扩 0.75px →
`#wrap` 的 `margin:8 10 0` 够不够要实测；③ `verify-bubble` [H] 的常量联动断言要同步。

## 5. 优先级建议

**第一批（半天～一天，收益/成本比最高，且互不依赖）**
1. **C1 淡出动画** —— 现在入场有、出场没有，是最明显的不对称。
2. **A1 两层阴影 + A2 的 drop-shadow 描边**（先只做浅色壁纸那一项，实测截图后再定描边强度）。
3. **B2 位置轻微随机化 + B3 间距随高度** —— 都是改两个数，去机械感立竿见影。

**第二批（需动布局，要配回归）**
4. **A3 宽度多档自适应**（治「窄高盒」，改动最大但视觉收益也最大）→ 落 `verify-bubble` 宽高比断言。
5. **B1/B4/B5 上方弧线三候选 + 回退顺序 + 零相交打分**。

**第三批（可选）**
6. C2/C3 动效打磨；D1 时长随字数；D2 点穿（⚠️ 会牺牲气泡内滚动）。
7. A4 多套气泡皮肤（最大，等前面稳定再说）。

## 6. 回归要求（照 tiny-roommate 的「保护规则而非像素」）

> 原文：`bubble placement logic should live in pure layout helpers when possible`
> `tests should assert the intended placement/state constraints directly`

- 布局逻辑抽**纯函数**（候选位生成 / 打分 / clamp），与规矩 9（同一数值只有一处定义）一致；
- `verify-bubble.js` 增加断言（不是截图比对）：
  - 宽高比落在 1.2 ~ 2.2 区间（对应 A3）；
  - 气泡矩形 **完全在 workArea 内**（含跨屏）；
  - 与人物矩形**不相交**（B5，inside 兜底时豁免并显式记录）；
  - 尾巴朝向与所选候选位一致（B1 的连带约束，漏了就是 dsh-pet 那个「尾巴方向错」的翻版）；
  - 照 dsh-pet 的教训断言：**不存在任何窗口级阴影特效**（`hasShadow:false` 不许回退）。
- 新增能力一律**配置开关**（规矩 4）：`bubble.widen`（A3）、`bubble.jitter`（B2）、
  `chat.floatBubbleOutline`（A2 描边）；默认值按规矩 24——**打扰/占资源类默认关**，
  但这些都属「美化」，可默认开，**A4 皮肤默认走现款**。
- 两档以上窗口尺寸 + 深浅两色壁纸各验一次（规矩 2「不写死取景常数」的同款要求）。

## 7. 一句话结论

**能优化，而且最值钱的不是「画得更花」，是三条我们还没有的规则**：
**避免窄高盒（A3）** · **位置去机械感（B2/B3）** · **出场动画（C1）**。
其中 A3 与 B 组都属于 tiny-roommate 用整份规范去约束的东西、dsh-pet 用 5 套方案 + 安全布局器
去实现的东西 —— 也就是说，**别人已经替我们验证过这些规则值得立**。

## 8. 第一批实施记录（2026-10-28）

**改动**：`bubble.js` / `bubble.html` / `bubble-preload.js` / `config.js` /
`debug/verify-bubble.js`（新增 [A]/[G]/[H]/[I] 断言）/ `debug/shot-bubble.js`（新，
观感截图）。**主窗回退布局（`#bubble`）没动** —— 它挂在主窗 DOM 里，淡出由
渲染层自己的 say() 生命周期管，与浮窗是两套。

### 8.1 实际做了什么

| 项 | 实现 | 关键决定 |
|---|---|---|
| **C1 淡出** | `hideNow()` 先发 `bubble:fade` → 页面挂 `body.fading`（160ms ease-in forwards）→ 主进程等 `FADE_MS` 才真 hide；`setQuiet`/`dispose` 走 `hideNow(true)` **立即**收 | 淡出期间又开口：`reveal()` 里 `clearFadeTimer()` 取消那次 hide |
| **C2 入场** | `body.pop`（pop .16s + `scale(.96→1)`），由主进程 `bubble:show` 驱动 | 🔴 动画必须**主进程每次下发**：窗口是复用的，body 上挂死动画只有第一句话有；且必须 `showInactive()` **之后**发（先发会被耗在窗口还藏着的那一截）。重播前先摘 class + 强制重排（`void offsetWidth`），否则同名动画不重播 |
| **A1 两层阴影** | `#wrap` 上 `drop-shadow(0 1px 2px .10)` + 原来的 `(0 3px 8px .15)` | dsh-pet 修复后的形态（低透明、最大 2px 偏移的近景 + 柔和远景） |
| **A2 描边** | `body.outline #wrap` 再叠**零偏移** `drop-shadow(0 0 1px rgba(20,22,28,.65))`；配置 `chat.floatBubbleOutline` **默认关** | 🔴 绝不用 border（矩形底边横穿尾巴根部）；**默认关**是尊重用户 2026-10-13 两轮把描边减到 0 的决定。强度实测：0.75px/0.55 在浅底上只有 214→180（太弱），加到 **1px/0.65** 后轮廓清晰且仍柔和 |
| **B2 随机化** | ±8px 水平，`hashJitter`（确定性散列，不用 `Math.random` —— 可复现可断言）；**每句话开头算一次**（`newUtterance`），`place()` 只读不重算（它被高度/拖拽高频调用） | 🔴 尾巴必须跟着回正：`want = 人物中线 − 泡体中线`（clamp 后也算得对），`bubble:tail` 下发、渲染层 `translateX(v) rotate(45deg)`（translate 在 rotate 之前 → 父坐标系纯水平）。夹 ±40 |
| **B3 间距** | `tipGap(h)`：8→14 随高度在 `[MIN_H, MAX_H]` 线性插值（纯函数） | 替换原固定 `TIP_GAP=10`；verify [F] 断言同步改 |

### 8.2 实测证据（debug/shot-bubble.js，浅底 #f2f2f0 = 浅色壁纸最坏情况）

- `pet-bubble-plain.png` / `-outline.png`：描边沿**合并轮廓**连续（泡体→尾巴），
  放大 5 倍确认尾巴根部**无内部边线**（dsh-pet「根因一」没有复现）。
- `-fade.png`：淡出中 80ms 处泡体区平均 **alpha 132/255**（对照组 250）→ 动画真在跑。
- `-tail.png`：`bubble:tail -24` 后尾巴尖中心偏移 **−36.0 像素 = −24 × DPR 1.5**，精确跟随。
- ⚠️ 截图脚本的浅底是 `insertCSS` 注入的（`SHOT_TRANSPARENT=1` 可关，量 alpha 用），
  **产品里 body 恒为 transparent**。

### 8.3 回归

`verify-bubble.js` 新增：[A] 两个新键默认值 / [G] 两层投影 + 描边必须是 drop-shadow
且无 border / [H] `FADE_MS` ↔ pop/fade 时长联动 / [I] 淡出接线、入场由 show 驱动且
先 showInactive 后发、重排后再挂 class、尾巴回正链路、`place()` 不重算偏移。
顺手修了一个**存量假红**：[B] `send: emitChatChunk` 断言没跟上 main.js 里为 TTS
截历史包的 `(t) => { spoken += t; emitChatChunk(t); }` 包装（与本次改动无关，一直在红）。

### 8.4 遗留

- A3（宽高比多档）是第二批里最值钱的：要防「加宽→变矮→又触发改宽」的回路，
  打算用**一次发言内只加宽不减**的单调策略，落 `verify-bubble` 宽高比断言。
- B1/B4/B5 做了之后，`bubble:tail` 的回正逻辑**直接复用**（本次已经把「位置一变
  尾巴跟着变」做成了独立通道）。

## 9. 第二批实施记录（2026-10-28，A3 + B1/B4/B5）

**改动**：`bubble.js`（宽度档 + 两个纯函数 + `place()` 重写）/ `config.js`（两个新键）/
`debug/verify-bubble.js`（新增 [J] 段）/ `debug/verify-config-defaults.js`/
`debug/shot-bubble-width.js`（**新**，真机验证 + 出图）。

### 9.1 实际做了什么

| 项 | 实现 | 关键决定 |
|---|---|---|
| **A3 宽度多档** | `WIDTH_STEPS=[272,320,368]`，`wantWidth(h,cur,avail)` 取「最小的 ≥ h×1.2 且 ≥ 当前宽」的档 | 🔴 **一次发言内单调不减**：加宽 → 行数变少 → 高度回落 → 若照"变矮就该变窄"收回去就会来回抖。用 `cur` 兜底一刀切断回路；每句话开头（`newUtterance`）重置回 272 |
| | 档位按**实际可达高度**定，不是拍脑袋 | 页高硬上限 = 8+236+21 = 265 → `need` 上限 318 → 真正会用到的是前两档；第三档是给 `MAX_H` 附近留的。`verify-bubble [J]` 有「**每一档都可达**」这条断言守着 —— 拍脑袋加一个够不到的档会直接变红 |
| | 只卡下限 1.2，**不卡上限 2.2** | 方案里 2.2 是 dsh-pet 对**自己那张参考图**量出来的（它整段渲染、没有流式）。我们一句短话 h≈78 时 w=272 已是 3.5，硬收到 2.2 要把气泡缩到 174 宽、比主窗窄一半，看着像贴纸。**横条是自然的，被禁的只有"窄高"** |
| **B1 三候选** | `CAND_OFF={top:0,'top-right':0.30,'top-left':−0.30}`，`pickAnchor()` 纯函数 | **常规恒 top**（正上方指着她最自然，左右候选**不参与常规随机** —— 每句换位会变成"气泡乱跳"）。只在两种场合启用：① top 想要的 x 被屏幕边 clamp（她被拖到屏幕边上）② inside |
| **B4 回退顺序** | 非 inside：`top → top-right → top-left`；inside：`top-right → top-left → top` | inside 时气泡必然盖脸 → 优先偏一侧，变成"盖肩膀"。可用判据 =「它想要的 x 不需要被 clamp」——**不需要知道人物有多宽**（规矩 2：不写死取景常数），跨屏天然成立 |
| **B5 零相交** | 同上判据 + inside 优先侧候选 | 没做"与人物矩形求交"的打分版：人物宽度没有实量，硬要写就得引入取景常数（规矩 22）。现有判据已经能覆盖要治的两件事（贴边、盖脸） |
| **尾巴上限** | `TAIL_OFFSET_MAX(40)` → `tailOffsetMax(w)=w/2−26` | 侧候选偏移 0.30×w 超过原固定值 40，尾巴会挪不动 → 指不到她。上限随宽度算，且保证尾巴留在泡体底边的直线段内（不出圆角） |

### 9.2 真机证据（debug/shot-bubble-width.js，**直接用真的 bubble.js**）

纯函数断言只能证明"规则写对了"，证不了"真跑起来落在该落的档位、而且**停下来**"。
这个脚本真起 Electron、真 `place()`、真渲染层报高度，逐个场景读 `_state()`：

| 场景 | 结果 |
|---|---|
| 长回复（屏幕中间） | 272 → **320**，比例 **1.33**；落定后 700ms 宽高**都不再变**（无回路） |
| 主窗贴左边缘 | top 被夹 → **top-right**，尾巴回正 **−97px**（位置一变尾巴跟着变） |
| 主窗贴顶 | **inside** + `top-right`（少挡脸） |
| 下一句短话 | 宽度**重置回 272**（长回复的宽气泡不留级） |

### 9.3 负对照（五条，全生效）

绿断言不算证据 —— 故意改坏看它红不红：

| 改坏 | 红的断言 |
|---|---|
| 去掉单调兜底 | 防回路 |
| `ASPECT_MIN` 放到 1.0 | 宽高比 |
| inside 不优先侧候选 | inside 回退 |
| 侧候选偏移放到 0.6 | 尾巴容量 |
| 忽略 `aside` 开关 | 边缘候选 |

### 9.4 🔴 顺手抓到一个静默 bug：`hashJitter` 越界

真机日志里 `jitter:-18` —— 约定是 ±8。根因在我自己那一行：

```js
x ^= x >>> 13;                 // ← `^` 的结果在 JS 里是**有符号** int32
return (x % (2 * span + 1)) - span;   // 负数取模 → 再减 span → 能到 −25
```

前面两个 `>>> 0` 白写了，最后那个 `^` 又把 x 变回负数。实测 1…12 号句子吐过
`−18 / −21 / −23`。**它是静默的**：输出看起来就是个合理偏移，只是比承诺的大三倍
（气泡肉眼可见地晃得更多，谁也不会怀疑是随机函数越界）。

- 修：`return` 前补 `x = x >>> 0;`（已修，实测 min/max = −8/8）。
- 防：`verify-bubble [J]` 新增**运行时范围断言**（直接调 `_hashJitter(n,8)` 跑 300 次看区间）——
  原先只断言"用了散列、常量是 8"，那种写法永远拦不住这类越界。

### 9.5 遗留

- **W41 多套皮肤**是剩下的最大项（A4），等前面稳定再做。
- C3/C4（打字光标 / 高度平滑）与 D1/D2（时长随字数 / 点穿）都还没动；点穿（D2）
  ⚠️ 会牺牲气泡内滚动，做之前要先定取舍。
- 主窗回退布局（`#bubble`）**仍未同步**这批改动：它没有独立的宽度/候选逻辑，
  要不要跟进取决于"回退布局"到底还留不留（目前是 `floatBubble:false` 时的备胎）。
