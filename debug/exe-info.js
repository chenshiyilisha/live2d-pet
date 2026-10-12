'use strict';
/*
 * 读 exe 的 PE 版本资源，对比 Ayan.exe 与原始 electron.exe。
 *
 * 背景：打包后的 Ayan.exe 与 node_modules 里的 electron.exe 字节数**完全相同**
 * （都是 246302208），而同一份 resources/app 用 electron.exe 能跑、用 Ayan.exe
 * 不能。所以要确认 electron-builder 到底有没有改写出正确的主程序 ——
 * 如果版本资源里的 OriginalFilename 仍是 electron.exe，说明它只是改了
 * 图标/描述这类字段，宿主的启动逻辑没变。
 *
 * 用法： node debug/exe-info.js <exe路径> [...更多]
 */
const fs = require('fs');

/* 只取 PE 里 VS_VERSIONINFO 的用户可见字段：在 UTF-16LE 里扫描
 * "Key\0Value\0" 这种连续结构。比完整实现一个 PE 解析器划算得多。 */
function utf16Strings(buf) {
  const out = [];
  let cur = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf.readUInt16LE(i);
    if (c === 0) {
      if (cur.length) {
        out.push(Buffer.from(cur).toString('utf16le'));
        cur = [];
      }
    } else if (c >= 0x20 && c < 0xff80) {
      cur.push(buf[i], buf[i + 1]);
    } else {
      cur = [];
    }
  }
  if (cur.length) out.push(Buffer.from(cur).toString('utf16le'));
  return out.filter((s) => s.length > 1 && s.length < 200);
}

for (const f of process.argv.slice(2)) {
  console.log(`\n========= ${f}`);
  let buf;
  try {
    buf = fs.readFileSync(f);
  } catch (err) {
    console.log(`  读不到：${err.message}`);
    continue;
  }
  console.log(`  大小 = ${buf.length} 字节`);

  // PE 头：e_lfanew 在 0x3C
  const peOff = buf.readUInt32LE(0x3c);
  const sig = buf.toString('ascii', peOff, peOff + 4);
  const machine = buf.readUInt16LE(peOff + 4);
  const subsystem = buf.readUInt16LE(peOff + 4 + 20 + 68);
  console.log(`  签名 = ${JSON.stringify(sig)}  machine = 0x${machine.toString(16)}  subsystem = ${subsystem}`);
  console.log(`  subsystem: 2=GUI(无控制台) 3=CONSOLE`);

  const strs = utf16Strings(buf);
  // 挑出跟身份有关的字段
  const keys = ['ProductName', 'FileDescription', 'OriginalFilename', 'InternalName', 'CompanyName', 'FileVersion', 'ProductVersion'];
  const found = {};
  for (let i = 0; i < strs.length - 1; i++) {
    if (keys.includes(strs[i])) found[strs[i]] = strs[i + 1];
  }
  for (const k of keys) {
    if (found[k] !== undefined) console.log(`  ${k} = ${JSON.stringify(found[k])}`);
  }
}
