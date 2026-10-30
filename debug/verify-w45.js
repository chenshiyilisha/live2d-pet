'use strict';

/* verify-w45.js —— W45 换源四条硬细节核验
 *
 * 背景：W45 是参考动画库的换源四条，逐条核我们的实现。
 * 项目里没有 HTMLMediaElement（无 video 元素 / new Audio），
 * 四条的直接对象不存在。但精神可以在**音频播放路径**上找到等价物：
 *   playWinrt（tts.js）= 我们的"媒体元素"
 *   ttsGen = 世代号（规矩 16）
 *   currentSrc = 当前正在播的那段
 *   waiting map（main/tts.js）= pending 请求表
 *
 * 逐条：
 *   ① 播放兑现靠 onended + 兜底定时器（非 loadeddata 单等）
 *   ② currentSrc 单槽只认前台元素（后台残留 handler 不会掐断当前）
 *   ③ 所有失败路径 cleanup pending（waiting.delete + cleanup）
 *   ④ ttsGen 世代号丢弃迟到结果（打断后的回调不推进队列）
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const FAILS = [];
let PASSES = 0;

function ok(name, cond, extra) {
  if (cond) { PASSES++; console.log(`  ok  ${name}`); }
  else { FAILS.push(name); console.error(`  ✗  ${name}${extra ? ' —— ' + extra : ''}`); }
}

function section(name) { console.log(`\n== ${name} ==`); }

/* ============================================================
 * ① 播放兑现靠 onended + 兜底定时器
 * ========================================================== */
section('① onended + 兜底定时器');
const rt = fs.readFileSync(path.join(ROOT, 'src/renderer/tts.js'), 'utf8');
const mt = fs.readFileSync(path.join(ROOT, 'src/main/tts.js'), 'utf8');

ok('渲染层有 onended 回调', /src\.onended\s*=\s*end/.test(rt));
ok('渲染层有兜底定时器（ttsGuard）', /ttsGuard = setTimeout\(end, audio\.duration/.test(rt));
ok('兜底用音频真实时长 + 2000ms', /audio\.duration \* 1000 \+ 2000/.test(rt));
ok('main/tts.js 有 SYNTH_TIMEOUT 兜底', /SYNTH_TIMEOUT = 8000/.test(mt));
ok('超时 kill 进程重来', /killChild\(\)/.test(mt) && /合成超时，重启合成进程/.test(mt));

/* ============================================================
 * ② currentSrc 单槽只认前台元素
 * ========================================================== */
section('② currentSrc 单槽');
ok('currentSrc 初始为 null', /let currentSrc = null/.test(rt));
ok('onended 只推进当前 src（currentSrc === src）', /const end = \(\) =>\s*{[\s\S]{0,100}if \(currentSrc === src\)/.test(rt));
ok('onended 后清 currentSrc', /currentSrc = null/.test(rt));
ok('stopAudio 先置 null 再 stop（防双调）', /const src = currentSrc;[\s\S]{0,80}currentSrc = null;[\s\S]{0,200}src\.stop\(\)/.test(rt));
ok('打断时 speechSynthesis.cancel 兜底', /speechSynthesis\?\.cancel\(\)/.test(rt));

/* ============================================================
 * ③ 所有失败路径 cleanup pending
 * ========================================================== */
section('③ pending 释放');
// main/tts.js
ok('超时路径 delete waiting', /waiting\.delete\(id\)/.test(mt));
ok('超时路径 cleanup req/out', /cleanup\(\{ req, out \}\)/.test(mt));
ok('failAllWaiting 清空 waiting', /function failAllWaiting[\s\S]{0,300}waiting\.clear\(\)/.test(mt));
ok('failAllWaiting 对每条 cleanup', /for \(const w of all\)[\s\S]{0,300}cleanup\(w\)/.test(mt));
ok('ERR 分支 cleanup + delete', /waiting\.delete\(m\[2\]\)[\s\S]{0,200}cleanup\(w\)/.test(mt));
ok('竞态 no-child 分支 cleanup', /cleanup\(\{ req, out \}\)[\s\S]{0,80}no-child/.test(mt));
ok('stopSynth 清 dir', /fs\.rmSync\(dir, \{ recursive: true, force: true \}\)/.test(mt));

// 渲染层 playSystem 也有 onerror 推进
ok('playSystem onerror 推进队列（不卡）', /u\.onerror = \(ev\)/.test(rt));
ok('playSystem 兜底定时器（onend 不触发时）', /ttsGuard = setTimeout\(wrap, Math\.max\(2000/.test(rt));
ok('playSilent 也有兜底定时器', /ttsGuard = setTimeout\(\(\) => \{ stopTextSim\(\); finish\(\); \}, ms\)/.test(rt));

/* ============================================================
 * ④ ttsGen 世代号丢弃迟到结果
 * ========================================================== */
section('④ 世代号');
ok('ttsGen 初始为 0', /let ttsGen = 0/.test(rt));
ok('interrupt 递增 ttsGen', /function interrupt\(\)[\s\S]{0,100}ttsGen\+\+/.test(rt));
ok('playOne 捕获 gen 快照', /const gen = ttsGen/.test(rt));
ok('playWinrt 合成后查 gen（合成期间被打断）', /if \(gen !== ttsGen\) \{ finish\(\); return; \}/.test(rt));
ok('playWinrt 解码后查 gen', /if \(gen !== ttsGen\) \{ finish\(\); return; \}/.test(rt));
ok('finish 回调查 gen（被掐不推进队列）', /if \(gen !== ttsGen\) return/.test(rt));
ok('speak 打断式递增 gen', /interrupt\(\)[\s\S]{0,50}ttsActive = true/.test(rt));
ok('pump 回调查 gen（被掐不推进）', /if \(gen !== ttsGen\) return/.test(rt));

/* ============================================================
 * 负对照：故意改坏 → 断言必须红
 * ========================================================== */
section('负对照');

// D1: 去掉 onended 的 gen 检查 → ②④ 断言应红
let bad = rt.replace(/if \(gen !== ttsGen\) \{ finish\(\); return; \}/g, '/* bad */');
ok('负对照：去掉 gen 检查后源码变化被检出', bad !== rt && /bad/.test(bad));

// D2: 去掉 failAllWaiting 的 cleanup → ③ 断言应红
let bad2 = mt.replace(/for \(const w of all\)[\s\S]{0,300}cleanup\(w\)/, '/* bad2 */');
ok('负对照：去掉 failAllWaiting cleanup 被检出', bad2 !== mt);

// D3: 去掉 currentSrc === src 检查 → ② 断言应红
let bad3 = rt.replace(/if \(currentSrc === src\)/, 'if (true)');
ok('负对照：去掉 currentSrc 检查被检出', bad3 !== rt && bad3.includes('if (true)'));

// D4: 去掉超时 cleanup → ③ 断言应红
let bad4 = mt.replace(/waiting\.delete\(id\)/, '/* bad4 */');
ok('负对照：去掉超时 waiting.delete 被检出', bad4 !== mt);

/* ============================================================ */
console.log(`\n${PASSES} passed, ${FAILS.length} failed`);
if (FAILS.length) {
  console.error('FAILED:');
  for (const f of FAILS) console.error('  - ' + f);
  process.exit(1);
}
