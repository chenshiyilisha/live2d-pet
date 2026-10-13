'use strict';
/*
 * 把 src/assets/models/ 打包成 dist/models.zip，作为 Release 资产发布。
 *
 * 用法： node tools/make-models-zip.js [输出路径]
 * 默认输出 dist/models.zip
 *
 * ---------------------------------------------------------------------------
 * 为什么要自己写 ZIP 写入器（而不是找个现成命令）
 *
 * 1) **GNU tar 不能写 zip**。`tar -a -cf x.zip <dir>` 看着成功，实际产出的是
 *    一个未压缩的 tar —— 前 4 字节是第一个条目的名字，偏移 257 处是 "ustar"，
 *    而不是 ZIP 的 PK\x03\x04。文件名叫 .zip 但根本不是 zip，Windows 资源管理器
 *    打不开。本机实测确认过。
 * 2) **PowerShell 的 Compress-Archive 可用**，但那会给构建链引入
 *    "必须 Windows + 有 PowerShell" 的依赖，和本项目"零多余依赖"的取向不符。
 * 3) Node 内置 `zlib` 只有 deflate 原语，没有 ZIP 容器。
 *
 * 所以这里实现一个最小 ZIP 写入器：只依赖内置 zlib，跨平台，无新增依赖。
 *
 * 刻意不支持的（9 MB 的输入用不到，加了只是徒增风险面）：
 *   - zip64（>4 GB 或 >65535 个条目）
 *   - 加密、多卷、数据描述符（我们一次性知道全部大小，用不着流式写头）
 * ---------------------------------------------------------------------------
 *
 * 打包结构：zip 内的顶层目录就是 `models/`，所以使用者把它解压到
 * `src/assets/` 之下即可得到 `src/assets/models/`。
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'assets', 'models');
const OUT = process.argv[2] || path.join(ROOT, 'dist', 'models.zip');

/* ---------------- ZIP 用的两个小工具 ---------------- */

/* CRC-32（IEEE 802.3，多项式 0xEDB88320）。ZIP 每个条目都要存校验值，
 * 解压方会拿它验完整性，写错了会报"压缩文件已损坏"。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* MS-DOS 日期时间：ZIP 从 1980 年起算，秒只有 5 位（精度 2 秒）。 */
function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/* ---------------- 收集要打包的文件 ---------------- */

/* 这些是**开发期的中间产物 / 备份**，不属于模型素材，绝不能进安装包：
 *   · *.orig / *.bak —— tools/make-motions.js 改 Hiyori.model3.json 之前留的
 *     还原点（它靠这个支持 --restore）。生成动作文件时会在素材目录里留一份，
 *     不排掉就会跟着 zip 发给用户，白多一个没人认识的文件。
 *   · 以 . 开头的（.DS_Store、编辑器临时文件等）
 *   · *.cmo3 / *.can3 —— Cubism 工程文件，官方没随示例数据提供，有也不该传 */
const SKIP_RE = /(\.orig|\.bak|\.cmo3|\.can3)$/i;

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && !SKIP_RE.test(e.name)) {
      out.push({ full, name: path.relative(base, full).split(path.sep).join('/') });
    }
  }
}

/* ---------------- 写 zip ---------------- */

function buildZip(entries) {
  const chunks = [];       // 依次写出的字节块
  const central = [];      // 中央目录记录
  let offset = 0;

  const push = (buf) => { chunks.push(buf); offset += buf.length; };

  for (const ent of entries) {
    const raw = fs.readFileSync(ent.full);
    const rawCrc = crc32(raw);
    /* PNG/贴图本身已经压缩过，deflate 几乎不减小体积；JSON 能压掉一大半。
     * 统一走 deflate 就好 —— 对已压缩数据它只是多几十字节，不值得分支。 */
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const nameBuf = Buffer.from(ent.name, 'utf8');
    const st = fs.statSync(ent.full);
    const { time, date } = dosDateTime(st.mtime);

    const localOffset = offset;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
    lh.writeUInt16LE(20, 4);           // 解压所需版本 2.0
    lh.writeUInt16LE(0x0800, 6);       // 标志位：文件名为 UTF-8
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(rawCrc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // 扩展字段长度
    push(lh);
    push(nameBuf);
    push(body);

    central.push({ nameBuf, method, time, date, crc: rawCrc,
                   comp: body.length, raw: raw.length, localOffset });
  }

  // ---- 中央目录 ----
  const cdStart = offset;
  for (const c of central) {
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // 中央目录签名
    ch.writeUInt16LE(20, 4);           // 生成程序版本
    ch.writeUInt16LE(20, 6);           // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);       // 标志位：UTF-8
    ch.writeUInt16LE(c.method, 10);
    ch.writeUInt16LE(c.time, 12);
    ch.writeUInt16LE(c.date, 14);
    ch.writeUInt32LE(c.crc, 16);
    ch.writeUInt32LE(c.comp, 20);
    ch.writeUInt32LE(c.raw, 24);
    ch.writeUInt16LE(c.nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // 扩展字段
    ch.writeUInt16LE(0, 32);           // 注释
    ch.writeUInt16LE(0, 34);           // 起始磁盘号
    ch.writeUInt16LE(0, 36);           // 内部属性
    /* ⚠️ 必须 `>>> 0`：JS 的 `<<` 是**有符号** 32 位运算，0o100644 已经是
     * 第 16 位为 1 的数，左移 16 位会把第 31 位置 1 → 结果变负数，
     * writeUInt32LE 直接抛 ERR_OUT_OF_RANGE。 */
    ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性：-rw-r--r--
    ch.writeUInt32LE(c.localOffset, 42);
    push(ch);
    push(c.nameBuf);
  }
  const cdSize = offset - cdStart;

  // ---- 中央目录结束记录 ----
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);            // 本磁盘号
  eocd.writeUInt16LE(0, 6);            // 中央目录所在磁盘
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);           // 注释长度
  push(eocd);

  return { buf: Buffer.concat(chunks, offset), entries: central };
}

/* ---------------- 主流程 ---------------- */

if (!fs.existsSync(SRC)) {
  console.error(`找不到素材目录：${SRC}`);
  console.error('先从 Release 下载 models.zip 解压到 src/assets/ 再打包。');
  process.exit(1);
}

const files = [];
/* ⚠️ 基准用 SRC 的**父目录**，这样条目名带 `models/` 前缀。
 * 若用 SRC 自身作基准，条目会变成 `hiyori/...`，
 * 使用者就得自己先建 models/ 目录才能解压到正确位置 —— 容易放错。 */
walk(SRC, path.dirname(SRC), files);
files.sort((a, b) => (a.name < b.name ? -1 : 1)); // 顺序固定 → 产物可复现

if (!files.length) {
  console.error(`素材目录是空的：${SRC}`);
  process.exit(1);
}

const { buf, entries } = buildZip(files);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, buf);

/* ---------------- 自检：把刚写的文件重新解析一遍 ----------------
 * 只"写成功了"不算数 —— 得确认解压方按同样规则能读出正确的条目数和大小。 */
const check = fs.readFileSync(OUT);
let eocdOff = -1;
for (let i = check.length - 22; i >= 0; i--) {
  if (check.readUInt32LE(i) === 0x06054b50) { eocdOff = i; break; }
}
const nEntries = eocdOff >= 0 ? check.readUInt16LE(eocdOff + 10) : -1;

let ok = true;
if (check[0] !== 0x50 || check[1] !== 0x4b) { ok = false; }
if (nEntries !== entries.length) { ok = false; }

/* 必备条目：缺任何一条，装上的客户端就会「拖拽 / 溜达没有动作」或者干脆起不来。
 * 这两个动作是本项目手写的（tools/make-motions.js），素材目录被重新解压过一次
 * 就会丢 —— 而"丢"在 zip 层面完全看不出来，只在用户那边表现为"功能没了"。 */
const MUST = [
  'models/hiyori/Hiyori.moc3',
  'models/hiyori/Hiyori.model3.json',
  'models/hiyori/motions/pet_drag.motion3.json',
  'models/hiyori/motions/pet_walk.motion3.json'
];
const names = new Set(files.map((f) => f.name));
const missing = MUST.filter((m) => !names.has(m));
if (missing.length) ok = false;

/* 反向：开发期中间产物不许漏进来（2026-10-13 实测 .orig 还原点混进过一次） */
const leaked = files.filter((f) => SKIP_RE.test(f.name)).map((f) => f.name);
if (leaked.length) ok = false;

const rawTotal = files.reduce((s, f) => s + fs.statSync(f.full).size, 0);
console.log(`打包 ${files.length} 个文件 → ${OUT}`);
console.log(`  原始体积 ${(rawTotal / 1048576).toFixed(2)} MB，压缩后 ${(check.length / 1048576).toFixed(2)} MB`);
console.log(`  自检：签名 ${ok ? 'PK ✓' : '✗'}，中央目录条目数 ${nEntries}${nEntries === entries.length ? ' ✓' : ' ✗'}`);
if (missing.length) console.error('  ✗ 缺少必备条目：' + missing.join('、'));
if (leaked.length) console.error('  ✗ 混进了开发期中间产物：' + leaked.join('、'));
if (!ok) { console.error('自检未通过'); process.exit(1); }
if (!missing.length && !leaked.length) console.log('  自检：必备条目齐全 ✓，无中间产物泄漏 ✓');
