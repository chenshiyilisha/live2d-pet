'use strict';

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

/* ============================================================
 *  W54：配置改动来路记录（2026-11-11）
 * ==========================================================
 *
 *  config.json 每次落盘，往 userData/config-changes.jsonl 追加一行：
 *  时间戳 / 谁改的（reason）/ 改了哪些键 / 改之前是什么 / 改之后是什么。
 *
 *  用途：调"设置改了没生效 / 自己变回去了"这类问题时，能回答
 *  "是谁、在什么时候、为什么、把什么改成了什么"—— 不用翻日志猜。
 *  台账是 append-only 的：恢复关系就是历史本身（旧值永远在里面）。
 *
 *  设计约束：
 *   · **零打扰零资源**：只在 saveConfig 成功之后追加一行 JSONL，
 *     不读配置、不起进程、不调模型（对比 surfcore-life 的"自主调参"：
 *     他们记的是模型改了什么，这里记的是**人改了什么**，
 *     绝不反过来让模型编一条"心理活动"充数）。
 *   · **fail-open**：台账写失败（磁盘满 / 文件锁）绝不影响配置落盘，
 *     只在终端留一行日志 —— saveConfig 的返回值是契约，不能被它改掉。
 *   · **上限裁剪**：只保留最近 MAX_ENTRIES 行，防常年运行把盘写满。
 *   · 开关 `ledgerEnabled`（在 config 顶层，默认开；只进配置文件，
 *     不进托盘 —— 纯技术开关，用户没有"每天都要看一眼"的场景）。
 *
 *  挂法：config.js 的 saveConfig(cfg, reason) 成功写盘后调
 *  recordChange(cfg, reason)；reason 由调用方传（patchConfig 传
 *  'patch:<段>'，窗口坐标落盘传 'window:save' 等），不传记 'unknown'。 */

const LEDGER_NAME = 'config-changes.jsonl';
const MAX_ENTRIES = 300;

/* 本次运行的 id：同一轮里的改动归成一组，排查时好对齐时间线。 */
const sessionId = 'sess-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);

/* 测试钩子：verify 脚本可把台账路径指到别处（制造写入失败）。
 * 用模块级变量而不是直接覆盖导出函数 —— 导出属性改了，
 * 模块内部调用仍走局部绑定，覆盖不生效（2026-11-11 verify-w54 G 段实测）。 */
let testPathOverride = null;
function ledgerPath() {
  return testPathOverride || path.join(app.getPath('userData'), LEDGER_NAME);
}

/* 上次落盘的序列化快照。同一串 JSON = 什么都没改 → 不记。 */
let lastSnap = null;

/* 深比较，返回变化键路径数组（['appearance.scale', ...]）。
 * 只做配置这种两层结构（段 → 键），值本身是标量或小对象，
 * 不做通用 JSON Patch —— 够用且不会因为对象顺序差异报"假变化"。
 * ⚠️ 数组走 JSON 深比较（两个内容相同的空数组是**相等**的，
 *    引用比较会把每次 spread 都判成"变了"——配置里 mcp.servers
 *    这种空数组很常见）。 */
function deepEq(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEq(v, b[i]));
  }
  return false;
}

function diffKeys(prev, next, prefix, out) {
  if (deepEq(prev, next)) return out;
  const pv = (prev === undefined) ? undefined : prev;
  const nv = next;
  if (pv !== null && typeof pv === 'object' && !Array.isArray(pv)
      && nv !== null && typeof nv === 'object' && !Array.isArray(nv)) {
    const keys = new Set([...Object.keys(pv), ...Object.keys(nv)]);
    for (const k of keys) {
      const sub = prefix ? prefix + '.' + k : k;
      if (deepEq(pv[k], nv[k])) continue;
      if (pv[k] !== undefined && nv[k] !== undefined
          && pv[k] !== null && typeof pv[k] === 'object' && !Array.isArray(pv[k])
          && nv[k] !== null && typeof nv[k] === 'object' && !Array.isArray(nv[k])) {
        diffKeys(pv[k], nv[k], sub, out);
      } else {
        out.push({ path: sub, from: pv[k], to: nv[k] });
      }
    }
  } else {
    out.push({ path: prefix || '<root>', from: pv, to: nv });
  }
  return out;
}

/* 追加一行 + 裁剪。所有 fs 错误都吃掉（fail-open，见文件头）。 */
function appendEntry(entry) {
  try {
    const dir = app.getPath('userData');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify(entry) + '\n';
    /* 'a' 模式 + 每次重读裁剪：条目很小（几百字节），300 行裁剪
     * 的成本远低于维护一个常驻句柄。 */
    fs.appendFileSync(ledgerPath(), line, 'utf8');
    const all = fs.readFileSync(ledgerPath(), 'utf8').split('\n').filter(Boolean);
    if (all.length > MAX_ENTRIES) {
      const keep = all.slice(all.length - MAX_ENTRIES);
      fs.writeFileSync(ledgerPath(), keep.join('\n') + '\n', 'utf8');
    }
    return true;
  } catch (err) {
    console.error('[config-ledger] 台账写入失败（不影响配置落盘）：', err && err.message);
    return false;
  }
}

/* 落盘成功后调用。返回是否记了一行（值没变 = false）。
 * 🔴 调用方必须在 saveConfig **成功之后**调，且拿不到 cfg 里
 *    ledgerEnabled=false 时要跳过 —— 跳过逻辑在这里，
 *    调用方只管传整个 cfg。 */
function recordChange(cfg, reason) {
  /* 开关读**落盘的那份 cfg**（不是内存里的 loadConfig 结果）：
   * 用户刚把它关了，这次落盘就不该记。 */
  if (cfg && cfg.ledgerEnabled === false) {
    lastSnap = JSON.stringify(cfg);
    return false;
  }
  const snap = JSON.stringify(cfg);
  if (lastSnap !== null && snap === lastSnap) {
    /* 什么都没变（比如 patchConfig 传了个已经存在的值）：
     * 只更新快照，不记行 —— 台账里没有"空气改动"。 */
    return false;
  }
  const changed = diffKeys(lastSnap === null ? {} : safeParse(lastSnap), cfg, '', []);
  lastSnap = snap;
  if (!changed.length) return false;
  return appendEntry({
    ts: new Date().toISOString(),
    session: sessionId,
    reason: String(reason || 'unknown'),
    changed
  });
}

/* 上次快照存的是字符串；解析失败（理论上不会，因为就是我们自己写的
 * JSON）就当成空对象 —— 那样会把所有键记成"新增"，比丢记录安全。 */
function safeParse(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/* 测试与启动时重置用：清内存快照 + 清掉台账文件本身，
 * 之后 readLedger 只剩本次写入。 */
function resetLedger() {
  lastSnap = null;
  try { fs.unlinkSync(ledgerPath()); } catch { /* 不在 = 本来就是空的 */ }
}

function readLedger() {
  try {
    return fs.readFileSync(ledgerPath(), 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

module.exports = {
  ledgerPath,
  setLedgerPathForTest: (p) => { testPathOverride = p; },
  recordChange,
  resetLedger,
  readLedger,
  diffKeys,
  MAX_ENTRIES,
  LEDGER_NAME
};
