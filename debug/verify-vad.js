'use strict';
/* 静音检测（VAD）验收。
 *
 * audio.js 是浏览器 ESM（由 index.html 以 <script type="module"> 加载），
 * node 直接 require 不进来 —— 但它是**纯函数、零依赖**，所以这里把源码里的
 * `export ` 前缀剥掉、丢进 vm 跑（tray-dump.js / verify-rename.js 同款手法）。
 *
 * 两块内容：
 *   A. 合成信号单测 —— 静音 / 说话 / 先静后说 / 碰一下麦的爆音，测判据边界。
 *      全部手造波形、确定性 100%，不依赖麦克风也不依赖当前环境。
 *   B. 源码级断言 —— 接线点必须在：recorder 真的调了 detectVoice，且开关语义
 *      是 `!== false`（写成 `=== true` 会把"默认开"悄悄变成"默认关"）。
 *
 * ⚠️ 判定必须计数（这个项目踩过：只打印不累计 → 全红还是退出码 0）。
 *
 * 用法：node debug/verify-vad.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

/* ---- 把 audio.js 当 CJS 跑 ----
 * ⚠️ vm 里 `const` / `function` 是词法声明，**不会**挂到 sandbox 对象上，
 *    所以要在末尾显式导出一份。 */
const sandbox = { console };
vm.createContext(sandbox);
const audioSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/audio.js'), 'utf8')
  .replace(/^export\s+/gm, '');
vm.runInContext(
  audioSrc + '\n;globalThis.__api = { VAD, frameRms, detectVoice, resampleTo, encodeWav };',
  sandbox
);
const { VAD, frameRms, detectVoice } = sandbox.__api;

/* ============================================================
 *  合成信号：正弦「说话声」+ 空白「静音」
 * ========================================================== */
const RATE = 16000;

function silence(sec) {
  return new Float32Array(Math.round(RATE * sec));
}

/* 200Hz 正弦。它的 RMS = amp / √2 —— 所以 amp=0.1 → RMS≈0.071，
 * 稳稳高于 floor 0.010；amp=0.005 → RMS≈0.0035，稳稳低于。 */
function tone(sec, amp) {
  const n = Math.round(RATE * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * 200 * i / RATE);
  return out;
}

function concat(...arrs) {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

console.log('══════ A. 判据边界（合成波形） ══════\n');

/* 1) 全程静音 —— 「按住了没开口」的典型场景 */
{
  const v = detectVoice(silence(1.0), RATE);
  check(v.voiced === false, `纯静音 1.0s → 判静音（peak=${v.peak.toFixed(4)}, ratio=${v.ratio.toFixed(2)}）`);
}

/* 2) 全程底噪 —— 增益拉满的麦克风，能量有但不该算说话 */
{
  const v = detectVoice(tone(1.0, 0.003), RATE);
  check(v.voiced === false, `持续底噪（RMS≈0.0021）→ 判静音（peak=${v.peak.toFixed(4)}）`);
}

/* 3) 正常说话 0.5s */
{
  const v = detectVoice(tone(0.5, 0.1), RATE);
  check(v.voiced === true, `说话 0.5s（RMS≈0.071）→ 判有声（ratio=${v.ratio.toFixed(2)}）`);
}

/* 4) 轻声说话 —— 阈值的下沿，必须仍然算有声（错杀比漏判严重得多） */
{
  const v = detectVoice(tone(0.5, 0.02), RATE);
  check(v.voiced === true, `轻声说话（RMS≈0.014）→ 判有声（peak=${v.peak.toFixed(4)}）`);
}

/* 5) 先静 0.9s 后说 0.1s —— 占比刚好压在 minVoicedRatio 上，仍应算有声 */
{
  const v = detectVoice(concat(silence(0.9), tone(0.1, 0.1)), RATE);
  const expect = VAD.minVoicedRatio;
  check(v.voiced === true && v.ratio >= expect - 1e-6 && v.ratio <= expect + 1e-2,
    `末尾 10% 才说话 → 判有声（ratio=${v.ratio.toFixed(3)}，阈值 ${expect}）`);
}

/* 6) 碰一下麦克风：一帧爆音 + 长静音 —— 有峰值但没人说话，必须判静音 */
{
  const v = detectVoice(concat(tone(0.02, 0.5), silence(1.0)), RATE);
  check(v.voiced === false,
    `一瞬爆音（peak=${v.peak.toFixed(3)}）+ 静音 → 判静音（ratio=${v.ratio.toFixed(3)}）`);
}

/* 7) 边界：0.03s 的极短录音（不足两帧）—— 末尾余数必须并成一帧而不是丢掉 */
{
  const v = detectVoice(tone(0.03, 0.1), RATE);
  check(v.frames === 2, `0.03s 录音 → ${v.frames} 帧（320+160 样本，余数不丢）`);
  check(v.voiced === true, `0.03s 短促出声 → 判有声（ratio=${v.ratio.toFixed(2)}）`);
}

/* 8) 空输入不许抛 */
{
  let threw = null;
  let v = null;
  try { v = detectVoice(new Float32Array(0), RATE); } catch (e) { threw = e; }
  check(!threw && v && v.voiced === false && v.frames === 0, '空输入 → 不抛，voiced=false / frames=0');
}

/* 9) 采样率非 16k 也要成立（真实链路是 AudioContext 的 48k） */
{
  const n = 48000 * 0.5;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.1 * Math.sin(2 * Math.PI * 200 * i / 48000);
  const v = detectVoice(s, 48000);
  check(v.voiced === true && v.frames === 25,
    `48kHz / 0.5s → 25 帧（20ms 一帧）、判有声（frames=${v.frames}）`);
}

/* 10) frameRms 本身：静音帧的 RMS 必须是 0，正弦帧的 RMS ≈ amp/√2 */
{
  const r0 = frameRms(silence(0.1), RATE);
  const r1 = frameRms(tone(0.1, 0.2), RATE);
  check(r0.length === 5 && r0.every((x) => x === 0), `静音 0.1s → 5 帧且全 0（${r0.length}）`);
  check(Math.abs(r1[0] - 0.2 / Math.SQRT2) < 0.01,
    `正弦 amp=0.2 的帧 RMS ≈ 0.1414（实测 ${r1[0].toFixed(4)}）`);
}

console.log('\n══════ B. 常量与接线（源码级） ══════\n');

check(VAD && typeof VAD.frameMs === 'number' && VAD.frameMs > 0, `VAD.frameMs = ${VAD?.frameMs}（正数）`);
check(VAD.peakFloor > 0 && VAD.peakFloor < 1, `VAD.peakFloor = ${VAD?.peakFloor}（落在 (0,1)）`);
check(VAD.minVoicedRatio > 0 && VAD.minVoicedRatio < 1, `VAD.minVoicedRatio = ${VAD?.minVoicedRatio}（落在 (0,1)）`);
/* 保守性断言：阈值必须明显低于"轻声说话"的电平，否则会错杀 */
check(VAD.peakFloor <= 0.02 / Math.SQRT2, 'peakFloor 低于"轻声说话"（amp 0.02）的 RMS —— 不会错杀');

const rec = fs.readFileSync(path.join(ROOT, 'src/renderer/recorder.js'), 'utf8');
check(/import\s*\{[^}]*\bdetectVoice\b[^}]*\}\s*from\s*'\.\/audio\.js'/.test(rec),
  "recorder.js 从 './audio.js' 引进了 detectVoice");
check(/detectVoice\(all,\s*rate\)/.test(rec), 'recorder.js 用**原始采样率**判定（all, rate）');
check(/asr\?\.silenceSkip\s*!==\s*false/.test(rec),
  '开关语义是 `!== false` —— 默认开（写成 === true 会变成默认关，静默失效）');
{
  const iVad = rec.indexOf('detectVoice(all, rate)');
  const iWav = rec.indexOf('encodeWav(');
  check(iVad > -1 && iWav > -1 && iVad < iWav,
    '判定在 encodeWav **之前** —— 省掉的是编码 + 子进程识别两笔开销');
}
check(/没听到声音/.test(rec), '有面向用户的提示文案（不是静默 return）');

const cfg = fs.readFileSync(path.join(ROOT, 'src/main/config.js'), 'utf8');
check(/asr:\s*\{[\s\S]*?silenceSkip:\s*true/.test(cfg), 'config.js 的 asr 段默认 silenceSkip: true');

console.log('\n──────────────────────────────');
if (failures) {
  console.log(`❌ 失败 ${failures} 项`);
  process.exit(1);
}
console.log('✅ 全部通过（VAD 静音检测）');
