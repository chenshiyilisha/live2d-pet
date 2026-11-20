/* W22：记忆 Markdown 工作区 —— 纯函数导出 / 解析（零 IO、零 fs、零 store）。
 *
 * 借鉴 Coopanion（AGPL-3.0）的**组织形态**，不搬一行实现：
 *   · 按主题分文件（PARTNER.md = 常驻画像，partner/<kind>.md = 按需读）
 *   · 归档不删（archive.md 收墓碑 / 被取代 / trace 淡忘）
 *   · 重复合并（同 id 只导一行、解析只收一次）
 *   · 日期写具体日历日，**不写「今天」**（明天看还知道是哪天）
 * 与 memory.js 的分工：这里只做「store ⇄ Markdown 文本」的纯投影，
 * 落盘 / 合并 / 墓碑 / 重要度仍走 memory.js 的 upsertFacts / deleteFact。
 * 所以导入不会新建存储格式，也不会绕过规矩 8 的原子写。
 * 🔴 id 是**给用户看的锚点**（改哪行、定位哪条），不是导入时的写入键：
 *    upsertFacts 用 makeId(text+kind) 自算 id、按 similarFact 合并，
 *    所以导入改正文 = 走正常「换值留档」流程（W49），不是覆盖原 id。
 *    别在这里假承诺「按 id 原地改写」——那要改 store 写入路径，风险不对等。
 *
 * 🔴 纯函数纪律：所有时间从参数进（now），不读 Date.now()，便于断言
 *   「不写今天」「幂等」。fs / dialog 在 main.js 的 IPC 层，不在这里。
 */

const KINDS = Object.freeze(['name', 'pref', 'boundary', 'relation', 'other']);

/* 主题文件映射（Coopanion 的 PARTNER.md 常驻画像 → 我们 name/boundary）。
 * 其它四类各一文件；archive.md 收所有不注入的条目。 */
const FILES = Object.freeze({
  name: 'PARTNER.md',
  boundary: 'PARTNER.md',
  pref: 'partner/pref.md',
  relation: 'partner/relation.md',
  other: 'partner/other.md'
});

const KIND_LABEL = Object.freeze({
  name: '称呼', pref: '偏好', boundary: '边界', relation: '约定', other: '其它'
});
const CLARITY_LABEL = Object.freeze({
  vivid: '清楚', clear: '清楚', fuzzy: '记得不太清', trace: '好像有过'
});

/* 日期：YYYY-MM-DD，本地时区（不写「今天」，明天看仍成立）。 */
function dayText(ts, now = Date.now()) {
  const t = Number(ts);
  if (!t || !Number.isFinite(t)) return '日期未知';
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function isTombstone(f) {
  return !!(f && f.forgotten === true && typeof f.id === 'string');
}

/* 被 W49 标记取代的旧事实（正文留档但不注入）。只认字段，不 require memory.js。 */
function isSuperseded(f) {
  return !!(f && (f.superseded === true || f.supersededBy));
}

/* 导出一行。格式固定，parse 靠它反向解析 —— 改格式必须同改 parse（有往返测试守着）。
 * 行首 ` - [id] ` 里的 id 用于「事实变了原地改写」；正文可能含 [ ]，所以 id 取**第一个** ]。 */
function factLine(f, now = Date.now()) {
  const id = String(f.id || '').replace(/[\]\r\n]/g, '');
  const text = String(f.text || '').replace(/\r?\n/g, ' ').trim();
  const kind = KINDS.includes(f.kind) ? f.kind : 'other';
  const clarity = CLARITY_LABEL[f.clarity] || '清楚';
  const date = dayText(f.updated || f.at, now);
  return `- [${id}] ${text}（${date} · ${KIND_LABEL[kind]} · ${clarity}）`;
}

/* 归档一行：墓碑没有正文，只能留 key + 删除日期；被取代条留正文。 */
function archiveLine(f, now = Date.now()) {
  if (isTombstone(f)) {
    const id = String(f.id || '').replace(/[\]\r\n]/g, '');
    const key = String(f.key || '').replace(/\r?\n/g, ' ').trim();
    return `- [${id}] （已删除 ${dayText(f.forgottenAt || f.at, now)}）${key ? ` ${key}` : ''}`;
  }
  return factLine(f, now);
}

/**
 * 把 store 投影成 { 文件名: Markdown 文本 }。
 * 不写 fs、不动 store、不排序依赖（按传入顺序稳定输出）。
 * @param {object} store memory.js 的 store（含 facts[]）
 * @param {number} now  注入的「今天」，仅用于日期未知条目的兜底
 */
function exportWorkspace(store, now = Date.now()) {
  const facts = Array.isArray(store && store.facts) ? store.facts : [];
  const active = facts.filter((f) => !isTombstone(f) && !isSuperseded(f) && f.clarity !== 'trace');
  const archived = facts.filter((f) => isTombstone(f) || isSuperseded(f) || f.clarity === 'trace');

  const out = {};
  /* 空文件也产出（告诉用户「这类还没有」，而不是文件不存在）。 */
  for (const file of new Set(Object.values(FILES))) {
    out[file] = '';
  }
  for (const f of active) {
    const file = FILES[KINDS.includes(f.kind) ? f.kind : 'other'] || 'partner/other.md';
    if (!out[file]) out[file] = `# ${displayTitle(file)}\n\n`;
    out[file] += factLine(f, now) + '\n';
  }
  /* 补标题（有内容但此前只有空串时）。 */
  for (const file of Object.keys(out)) {
    if (out[file] && !out[file].startsWith('#')) {
      out[file] = `# ${displayTitle(file)}\n\n` + out[file];
    }
  }
  out['archive.md'] = '# 历史归档\n\n' + archived.map((f) => archiveLine(f, now) + '\n').join('');
  return out;
}

function displayTitle(file) {
  if (file === 'PARTNER.md') return '关于你（常驻）';
  if (file === 'archive.md') return '历史归档';
  const kind = Object.keys(FILES).find((k) => FILES[k] === file);
  return `${KIND_LABEL[kind] || '其它'} · 按需读取`;
}

/* 解析一行 → 草稿。只认 `- [id] ` 开头；日期/清晰度括号剥掉不进正文，
 * 🔴 类别从元数据读：PARTNER.md 同时含 name/boundary，光靠文件名会串类。
 * 元数据是导出时机器生成的，用户编辑时改类别 = 有意为之（比如把「偏好」
 * 改成「边界」），尊重它；只有元数据缺失时才退回文件归属。 */
const LINE_RE = /^\s*-\s*\[([^\]]+)\]\s*(.+?)\s*$/;
const META_RE = /（(?:日期未知|\d{4}-\d{2}-\d{2})\s*·\s*([^（）·]+?)\s*·\s*([^（）]+?)）$/;
const LABEL_TO_KIND = Object.fromEntries(
  Object.entries(KIND_LABEL).map(([k, v]) => [v, k]));
function parseLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const id = m[1].trim();
  if (!id) return null;
  let text = m[2].trim();
  let kind = null;
  const meta = META_RE.exec(text);
  if (meta) {
    kind = LABEL_TO_KIND[meta[1].trim()] || null;
    text = text.slice(0, meta.index).trim();
  }
  if (text.startsWith('（已删除')) return null;   // 归档删除行不复活
  if (text.length < 2) return null;
  return { id, text, kind };
}

/**
 * 解析工作区文本 → 草稿列表（可直接喂 memory.js 的 upsertFacts）。
 * @param {object|string} texts { 文件名: 文本 }，或单份文本（当作 other）
 * @returns {Array<{id,text,kind,source}>}
 */
function parseWorkspace(texts, now = Date.now()) {
  const map = typeof texts === 'string' ? { 'partner/other.md': texts } : (texts || {});
  const drafts = [];
  const seen = new Set();
  for (const [file, text] of Object.entries(map)) {
    /* 归档只读，不复活。两个判据都要：文件名（正常按工作区导入）＋
     * 文本内的 `# 历史归档` 标题（用户单独把 archive.md 当文本粘进来时，
     * 上面单串兜底会把它标成 other，漏判就会把被取代/trace 正文收回来）。 */
    if (/archive\.md$/.test(file) || /^\s*#\s*历史归档/m.test(String(text || ''))) continue;
    const kind = Object.keys(FILES).find((k) => FILES[k] === file) || 'other';
    for (const line of String(text || '').split(/\r?\n/)) {
      const d = parseLine(line);
      if (!d) continue;
      const finalKind = d.kind || kind;              // 元数据类别优先，文件归属兜底
      const key = `${finalKind}:${d.id}`;
      if (seen.has(key)) continue;                   // 同 id 重复合并（幂等）
      seen.add(key);
      drafts.push({ id: d.id, text: d.text, kind: finalKind, source: 'user' });
    }
  }
  return drafts;
}

module.exports = {
  KINDS, FILES, KIND_LABEL, CLARITY_LABEL,
  dayText, factLine, archiveLine, isTombstone, isSuperseded,
  exportWorkspace, displayTitle, parseLine, parseWorkspace
};
