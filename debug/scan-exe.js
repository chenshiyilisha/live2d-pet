'use strict';
/*
 * 在 Ayan.exe 里搜关键字符串，确认它到底是不是一个正常的 Electron 主程序。
 *
 * 背景：Ayan.exe 与 node_modules 里的 electron.exe 字节数完全相同（246302208），
 * 但哈希不同（资源被改写过）。而它运行时 main.js 一行都不执行、退出码 9。
 * 正常的 Electron exe 内部必然带 "resources\app"、"app.asar" 这类常量，
 * 如果搜不到，说明它被替换成了别的东西。
 *
 * 用法： node debug/scan-exe.js <exe路径> [关键字...]
 */
const fs = require('fs');

const f = process.argv[2];
const keys = process.argv.slice(3);
if (!keys.length) keys.push('resources\\app', 'resources/app', 'app.asar', 'default_app', 'Electron', 'live2d-pet', 'Ayan');

const fd = fs.openSync(f, 'r');
const size = fs.fstatSync(fd).size;
const CHUNK = 1 << 22; // 4MB
const buf = Buffer.allocUnsafe(CHUNK + 512);

const hits = {};
for (const k of keys) hits[k] = 0;

let carry = Buffer.alloc(0);
let off = 0;
while (off < size) {
  const n = fs.readSync(fd, buf, 0, CHUNK, off);
  if (n <= 0) break;
  const slice = Buffer.concat([carry, buf.subarray(0, n)]);
  for (const k of keys) {
    const needle = Buffer.from(k, 'utf8');
    let idx = 0;
    while ((idx = slice.indexOf(needle, idx)) !== -1) {
      hits[k]++;
      idx += needle.length;
    }
    // 也试 UTF-16LE（PE 资源里字符串是宽字符）
    if (/^[\x20-\x7e]*$/.test(k)) {
      const w = Buffer.from(k.split('').join('\0') + '\0\0', 'utf8');
      let j = 0;
      while ((j = slice.indexOf(w, j)) !== -1) {
        hits[k + ' (UTF-16)'] = (hits[k + ' (UTF-16)'] || 0) + 1;
        j += w.length;
      }
    }
  }
  carry = slice.subarray(slice.length - 512);
  off += n;
}
fs.closeSync(fd);

console.log(`文件 ${f}  大小 ${(size / 1048576).toFixed(1)} MB\n`);
console.log('关键字命中次数：');
for (const [k, v] of Object.entries(hits)) {
  console.log(`  ${String(v).padStart(6)}  ${k}`);
}
