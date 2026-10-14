'use strict';

/* 真口型 + WinRT TTS 的防回流断言。
 *
 * 这一版的坏法全是**静默**的，所以每条断言都对着一种具体的坏：
 *   1) engineOf 少判一个条件 → 旧 preload 下每句话都要等一次必然失败的
 *      合成（观感是"朗读慢半拍"，不报错）；
 *   2) 合成失败没回退 → 朗读**哑掉**，用户只看到气泡不出声；
 *   3) 打断时没停自己播的那一段 → 按了停止她还在念（speechSynthesis.cancel
 *      拦不住 WebAudio 播的东西）；
 *   4) lipEnv 被写成"只在 SPEAKING 分支里调" → 队列念完后嘴回不去（僵嘴）；
 *   5) 请求文件先删后读 → 每一句都报"找不到文件"（实测踩过）；
 *   6) 合成进程没在 will-quit 里杀掉 → 留下一个永远在跑的 powershell.exe。
 *
 * ⚠️ [F] 段是**真跑** tts.js（复制成 .mjs + 装假 speechSynthesis），
 *    验的是"回退这条路真的走得通"，不是正则看长相。
 *
 * 跑法：node debug/verify-lip.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
/* 取两个标记之间的片段（找不到就给空串，断言自然会失败并指出问题） */
const between = (src, a, b) => {
  const i = src.indexOf(a);
  if (i < 0) return '';
  const j = b ? src.indexOf(b, i + a.length) : -1;
  return j < 0 ? src.slice(i) : src.slice(i, j);
};

/* ---- 假引擎（同 verify-tts）：记录被念的文本，手动推进 onend ---- */
const spoken = [];
const pending = [];
globalThis.speechSynthesis = {
  speak(u) { spoken.push(u.text); pending.push(u); },
  cancel() { pending.length = 0; },
  getVoices() { return [{ name: 'Microsoft Huihui', lang: 'zh-CN' }]; }
};
globalThis.SpeechSynthesisUtterance = class {
  constructor(text) { this.text = text; }
};

(async () => {
  const tts = read(path.join('renderer', 'tts.js'));
  const ttsNoC = strip(tts);
  const pet = read(path.join('renderer', 'pet.js'));
  const petNoC = strip(pet);
  const mainSrc = read(path.join('main', 'main.js'));
  const mainNoC = strip(mainSrc);
  const cfgSrc = read(path.join('main', 'config.js'));
  const preload = read(path.join('main', 'preload.js'));
  const mtts = read(path.join('main', 'tts.js'));

  /* ============================================================
   *  [A] 配置默认值 —— 引擎选谁、朗读仍然默认关
   * ========================================================== */
  console.log('[A] 配置 —— 引擎默认值与"默认关"的规矩');
  {
    const seg = between(cfgSrc, 'tts: {', '\n  },');
    ok(/enabled:\s*false/.test(seg), 'tts.enabled 仍然默认 false（出声类功能默认关，规矩 24）');
    ok(/engine:\s*'winrt'/.test(seg), "tts.engine 默认 'winrt'（要的就是真口型）");
    ok(/voice:\s*''/.test(seg), 'tts.voice 默认空（主进程自动挑中文语音）');
    ok(/rate:/.test(seg) && /pitch:/.test(seg), 'rate / pitch 还在（两个引擎语义一致，直传）');
  }

  /* ============================================================
   *  [B] 渲染层 tts.js —— 引擎判定、回退、打断、预合成
   * ========================================================== */
  console.log('[B] tts.js —— 引擎判定与三条兜底路径');
  {
    const engineFn = between(ttsNoC, 'function engineOf()', '\n}');
    ok(/deps\.synth/.test(engineFn) && /typeof deps\.synth === 'function'/.test(engineFn),
      'engineOf 同时要求"配置选了 winrt"和"合成通道真的在"（少判后半个 = 每句先等一次失败）');
    ok(/ENGINE_SYSTEM/.test(engineFn), '拿不到合成通道时明确落到 ENGINE_SYSTEM');

    /* 回退：合成不行就交给 playSystem，且口型交回正弦 */
    const pw = between(ttsNoC, 'async function playWinrt', 'function playOne');
    ok(/playSystem\(text, finish\)/.test(pw), '播放链路失败会回退 playSystem（不哑）');
    ok(/if \(!buf \|\| !ctx\)/.test(pw), '合成没结果 / 没有 AudioContext 都走回退');
    const ps = between(ttsNoC, 'function playSystem', 'async function playWinrt');
    ok(/lipActive = false/.test(ps), '回退时把口型交回正弦波（lipActive=false）');

    /* 打断：必须停自己播的那一段 */
    const stop = between(ttsNoC, 'function stopAudio', 'function interrupt');
    ok(/currentSrc/.test(stop) && /\.stop\(\)/.test(stop),
      'stopAudio 停掉正在播的 AudioBufferSourceNode（cancel 拦不住 WebAudio）');
    const intr = between(ttsNoC, 'function interrupt()', 'export function speak(');
    ok(/stopAudio\(\)/.test(intr), 'interrupt 调 stopAudio —— 打断/停止语都要用');

    /* 预合成（流水线） */
    const enq = between(ttsNoC, 'export function enqueueSpeech', '\n}');
    ok(/pcm:\s*prefetch\(/.test(enq), 'enqueueSpeech 入队即发起合成（播上一句时下一句已备好）');
    const pf = between(ttsNoC, 'function prefetch', '\n}');
    ok(/then\(\(b\) => b \|\| null, \(\) => null\)/.test(pf) || /, \(\) => null\)/.test(pf),
      'prefetch 的失败收敛成 null（挂在队列项上，不能被 unhandled rejection 咬到）');
    ok(/engineOf\(\) !== ENGINE_WINRT\) return null/.test(pf), '非 winrt 引擎不白白发起合成');

    /* 每帧包络 */
    ok(/export function lipEnv\(dt\)/.test(tts), 'lipEnv 按帧输入 dt（平滑与帧率无关）');
    const lip = between(ttsNoC, 'export function lipEnv', '\n}');
    ok(/if \(!lipActive\) return null/.test(lip), 'lipEnv 在没有真实波形时返回 null（调用方据此回正弦波）');
    ok(/getFloatTimeDomainData/.test(lip), '包络来自 AnalyserNode 的时域数据');
    ok(/LIP_ATTACK/.test(lip) && /LIP_RELEASE/.test(lip), '快攻慢放（不是单速平滑，否则嘴巴像节拍器）');
    ok(/FFT_SIZE\s*=\s*512/.test(tts), 'fftSize=512（32ms @16k，约一个音节的粒度）');

    /* 测试环境防御 */
    const ac = between(ttsNoC, 'function getAC()', '\n}');
    ok(/typeof window !== 'undefined'/.test(ac),
      "getAC 有 typeof window 防御（Node 里 import 这个文件不该抛）");

    /* 诊断快照要能看出引擎与包络 */
    ok(/engine: engineOf\(\), lip: lipActive, lipLevel/.test(tts), 'ttsQueueState 带 engine / lip 字段（探针读它）');
  }

  /* ============================================================
   *  [C] pet.js 接线 —— 口型真的接到参数上
   * ========================================================== */
  console.log('[C] pet.js —— 口型接线');
  {
    const tick = between(petNoC, 'const env = lipEnv(dt)', 'PIXI.UPDATE_PRIORITY.LOW');
    ok(/const env = lipEnv\(dt\)/.test(petNoC), 'ticker 里调 lipEnv');
    ok(/if \(env !== null\)/.test(tick), 'env 非 null 时直接采用真实包络');
    ok(/mouthLevel = env/.test(tick) && /setParam\(P\.MOUTH_OPEN, mouthLevel\)/.test(tick),
      '真实包络写进 ParamMouthOpenY');
    /* 🔴 顺序：lipEnv 必须在 SPEAKING 判断**之前**（否则队列念完嘴回不去） */
    const iEnv = petNoC.indexOf('const env = lipEnv(dt)');
    const iSpeak = petNoC.indexOf('state === State.SPEAKING', iEnv);
    ok(iEnv > 0 && iSpeak > iEnv,
      'lipEnv 先调、SPEAKING 分支在后（队列空了也要靠它把嘴收回去）');

    const cfgTTS = between(petNoC, 'configureTTS({', '});');
    ok(/synth:\s*\(text, opts\) => window\.pet\?\.synthSpeech\?\.\(text, opts\)/.test(cfgTTS),
      '注入合成通道，且按规矩 31 用 `window.pet?.xxx?.(`（护到方法一层）');
  }

  /* ============================================================
   *  [D] 主进程接线 —— IPC / 起停 / 退出清理
   * ========================================================== */
  console.log('[D] 主进程 —— IPC 与生命周期');
  {
    /* ⚠️ 终点不能拿 `});` 去 indexOf —— handler 里 `p.opts || {});` 就含这个
     *    子串，切片会被从中间截断（第一版就这么误报了两条）。 */
    const iH = mainNoC.indexOf("ipcMain.handle('tts:synth'");
    const jH = mainNoC.indexOf('\n  });', iH);
    const h = iH >= 0 && jH > iH ? mainNoC.slice(iH, jH) : '';
    ok(h.length > 0, '有 tts:synth 通道');
    ok(/isOn\('tts', 'enabled', false\)/.test(h), '通道里再查一次开关（配置刚关掉的竞态）');
    ok(/wav\.buffer\.slice\(/.test(h),
      '返回 ArrayBuffer 而不是 Buffer（Buffer 过去是带 offset 的视图，decodeAudioData 会抛）');
    ok(/r\.ok\) return null/.test(h) || /if \(!r\.ok\) return null/.test(h),
      '合成失败 resolve null，不是 rejected 的 invoke（那会把朗读队列卡住）');

    ok(/synthSpeech: \(text, opts\) => ipcRenderer\.invoke\('tts:synth'/.test(preload),
      'preload 暴露 synthSpeech');

    const ref = between(mainNoC, 'function refreshTTS()', '\n}');
    ok(/t\.enabled === true/.test(ref) && /t\.engine/.test(ref),
      'refreshTTS 同时看 enabled 和 engine（engine=system 时不该起常驻进程）');
    const refCalls = (mainNoC.match(/refreshTTS\(\)/g) || []).length;
    ok(refCalls >= 4, `refreshTTS 在 定义/flag/config:set/启动 四处接线（找到 ${refCalls} 处）`);
    ok(/section === 'tts'\) refreshTTS\(\)/.test(mainNoC), '托盘切开关立刻生效');
    const quit = between(mainNoC, "app.on('will-quit'", '});');
    ok(/stopSynth\(\)/.test(quit), 'will-quit 里杀掉合成进程（否则留下野 powershell.exe）');
    ok(/autoplay-policy/.test(mainNoC), '显式放行自动播放（她主动搭话时没人碰过窗口）');

    const tray = between(mainNoC, 'const ttsItem = {', 'const featureMenu');
    ok(/type: 'radio'/.test(tray) && /engine: 'winrt'/.test(tray) && /engine: 'system'/.test(tray),
      '托盘能切引擎（radio 两项），不是"点了没反应"');
    ok(!/flag\('tts', 'enabled', '语音朗读'\)/.test(mainNoC), '旧的平铺项已收进子菜单');
  }

  /* ============================================================
   *  [E] 主进程合成进程 —— 协议与生命周期
   * ========================================================== */
  console.log('[E] 主进程 tts.js —— 常驻合成进程');
  {
    ok(/SCAN_MS\s*=\s*\d+/.test(mtts) && /SYNTH_TIMEOUT\s*=\s*\d+/.test(mtts) &&
      /MAX_RESTARTS\s*=\s*\d+/.test(mtts), '三个超时/上限常量都在（扫描粒度、单句超时、重启上限）');
    /* 🔴 先读后删 —— 反过来每句都报"找不到文件"（实测踩过） */
    const iRead = mtts.indexOf("ReadAllText($reqPath");
    const iDel = mtts.indexOf("Delete($reqPath)");
    ok(iRead > 0 && iDel > iRead, 'PS 侧先读请求内容再删文件（顺序反了每句都失败）');
    ok(/Get-Process -Id \$parent/.test(mtts), '子进程自查父进程（父被强杀时不留野进程）');
    ok(/OutputEncoding = \[System\.Text\.Encoding\]::UTF8/.test(mtts),
      'PS 输出编码设成 UTF-8（否则中文错误信息经管道变乱码）');
    ok(/toString\('ascii', 0, 4\) !== 'RIFF'/.test(mtts), '只认头部是 RIFF 的 wav（坏数据不如回退）');
    ok(/failAllWaiting/.test(mtts), '进程退出时把所有在等的请求一起失败（不能让它们永远挂着）');
    ok(/killChild\(\)/.test(between(mtts, 'setTimeout(() => {', 'SYNTH_TIMEOUT')),
      '合成超时杀掉进程重来（卡住的是一整条队列，不只是这一句）');
    ok(/sweepOldDirs/.test(mtts) && /pidAlive/.test(mtts),
      '启动时清扫以前被强杀留下的 pet-tts-<pid> 目录（且不碰活着的实例）');
  }

  /* ============================================================
   *  [F] 行为级 —— 回退这条路真的走得通
   * ========================================================== */
  console.log('[F] 行为 —— 合成失败必须回退，不能哑');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lip-'));
    fs.copyFileSync(path.join(SRC, 'renderer', 'params.js'), path.join(dir, 'params.mjs'));
    fs.writeFileSync(
      path.join(dir, 'tts.mjs'),
      tts.replace(/from '\.\/params\.js'/, "from './params.mjs'")
    );
    const T = await import(pathToFileURL(path.join(dir, 'tts.mjs')).href);

    let state = 'idle';
    let synthImpl = async () => null;
    T.configureTTS({
      getCfg: () => ({ tts: { enabled: true, engine: 'winrt' } }),
      getState: () => state,
      isBusy: () => false,
      setState: (s) => { state = s; },
      isQuiet: () => false,
      synth: (t, o) => synthImpl(t, o)
    });
    T.initTTS();

    const flush = () => new Promise((r) => setTimeout(r, 60));
    const reset = () => { T.stopSpeak(); spoken.length = 0; pending.length = 0; state = 'idle'; };

    /* ① 引擎判定：注入了 synth 且 engine=winrt → 应该是 winrt */
    ok(T.ttsQueueState().engine === 'winrt', '注入合成通道后 engine 报 winrt');

    /* ② lipEnv：没走 WebAudio 播放时必须返回 null（否则 pet.js 会拿到 0 而僵住） */
    ok(T.lipEnv(0.016) === null, '没在播真实音频时 lipEnv 返回 null');

    /* ③ 合成返回 null（失败）→ 这一句仍然要用系统音色念出来 */
    reset();
    T.enqueueSpeech('合成失败也要念');
    await flush();
    ok(spoken.includes('合成失败也要念'), '合成返回 null → 回退系统音色，这句话照样念出来');
    ok(T.lipEnv(0.016) === null, '回退后口型交回正弦（lipEnv 仍返回 null）');

    /* ④ 合成直接抛错 → 同样回退（prefetch 收敛异常） */
    reset();
    synthImpl = () => { throw new Error('boom'); };
    T.enqueueSpeech('抛错也要念');
    await flush();
    ok(spoken.includes('抛错也要念'), '合成抛异常 → 一样回退，不哑');

    /* ⑤ 没有注入 synth（旧 preload）→ 判定为 system，走老路 */
    reset();
    T.configureTTS({ synth: null });
    ok(T.ttsQueueState().engine === 'system', '没有合成通道 → 回落 system（不发起必然失败的合成）');
    T.enqueueSpeech('老路径');
    await flush();
    ok(spoken.includes('老路径'), '老路径照常出声');

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(fails === 0 ? '\n全部通过（0 项失败）' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
