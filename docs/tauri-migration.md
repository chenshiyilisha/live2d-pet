# 下一步技术路线：Tauri 2 + TypeScript + Cubism Web

> 状态：**已定方向、未开工**（2026-10-27）。  
> Electron 仓继续发功能；迁壳是独立大项，不与 M1–M5 / 人格小步混做。

## 1. 目标栈

| 层 | 选型 | 职责 |
|---|---|---|
| 壳 | **Tauri 2**（Rust） | 透明置顶窗、托盘、权限、系统钩子、打包体积 |
| UI / 舞台 | **TypeScript** + Vite | 气泡、设置、流式对话、业务逻辑（从现 `src/renderer` + 可迁的 `src/main` 纯逻辑抽出） |
| Live2D | **Cubism Web** + PIXI（或 `live2d-web` 同类） | 与现栈同族，避免 Cubism Native 重写 |
| LLM | 继续 **OpenAI 兼容 HTTP** | 不绑宿主；本地 Ollama / 云端同一套 |

**明确不选**：Unity 常驻、纯 C++ Cubism Native 当主路径、为迁壳捆 GGUF、整仓改成 DSH Cordis 插件本体。

## 2. 为何现在定、却不立刻干

- **收益**：安装包与常驻内存明显小于 Electron；WebView2 在 Win10/11 已普及。  
- **风险**：叠层/拖出/更新链路要重接；现仓产品逻辑已深。  
- **透明点击穿透（澄清）**：  
  - **整窗穿透**官方已有：`Window.setIgnoreCursorEvents(true)`（Win 上 `WS_EX_TRANSPARENT`）。  
  - **按透明像素穿透**官方**明确不做**（issue #13070 / #2090；跟踪 #6164）。成熟做法是社区标准配方，不是从零发明：  
    **全局鼠标坐标**（如 `tauri-plugin-rdev`）→ **命中判定**（矩形 hitbox，或 Live2D 用 `gl.readPixels` 读 alpha）→ **按需切换** `setIgnoreCursorEvents`。  
  - 桌宠实战：AIRI（Live2D/VRM）已合并同款；与 Electron 的 `setIgnoreMouseEvents(true, { forward: true })` 比，少「forward 悬停」一档，多一层自管切换。  
  - 迁壳时列为 **T3 工程项**，不列为「Tauri 不能做」的否决项。  
- **顺序**：先把 **M1–M5（模型对接体验）** 与核心交互在 Electron 上稳住 → 再迁，避免双栈同时改行为。

## 3. 迁移动作拆分（建议里程碑）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **T0 抽核** | 把无 Electron 依赖的纯逻辑（`llm` / `memory` / `mood` / `throw-physics` / `bubble-priority` / `quiet-hours` / profiles）收成可共享的 `packages/core`（或至少边界清晰的纯 JS 模块） | Node 下现有 `verify-*` 仍绿 |
| **T1 空壳** | `create-tauri-app`：透明无边框、置顶、托盘、单页 Vite；先显示色块/静态图 | 包体数量级小于当前 Setup |
| **T2 舞台** | 迁 Cubism Web 舞台 + hiyori 档案几何；眼神/表情/口型最小集 | 与 Electron 同模观感可对照 |
| **T3 系统面** | Rust 侧：锁屏/闲置、前台应用、点击穿透（alpha）、多屏 | 对标现 fullscreen / motion 闸门 |
| **T4 产品面** | 对话流式、TTS 策略、记忆、工作状态、自动更新（Tauri updater） | 功能清单对齐 v0.3+ |
| **T5 切主** | 发 Tauri 版 Release；Electron 进维护/停止功能增量 | README 主路径改 Tauri |

## 4. 与现仓的边界

- **并行期**：Electron = 用户主线；Tauri = `apps/ayan-tauri` 或同级新目录，**禁止**半截替换 `src/main`。  
- **可先搬**：纯函数与配置契约（persona / memory facts / motionSlots）。  
- **须重写**：`BrowserWindow` / `Tray` / `powerMonitor` / `electron-updater` / preload IPC → Tauri commands + events。  
- **DSH**：仍优先「薄桥 HTTP」；不因迁 Tauri 改成 Cordis 内嵌宠物。

## 5. 开干触发条件（满足再排期）

任选其一即可立项 T0：

1. 用户明确说「开始 Tauri 迁壳」；或  
2. M1–M5 落地且包体/内存成为明确产品痛点；或  
3. 准备大版本（如 v1.0）且愿意接受双轨发版一段时间。

## 6. 参考

- 同类：Tauri 2 + PIXI Live2D 桌宠（如 desktop-companion 一类）  
- 穿透：WebView alpha + Rust 侧忽略鼠标（AIRI / animo 思路）  
- 本仓调研：`open-source-reference.md`；增强表：`enhancement-backlog.md` §J  
