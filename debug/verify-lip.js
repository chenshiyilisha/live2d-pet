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
const vm = require('vm');
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
    ok(/lipActive = false/.test(ps), '回退时关掉真实波形（lipActive=false）');
    ok(/startTextSim/.test(ps), 'G11：system/回退走文字模拟口型');

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
    ok(/if \(textSim\) return stepTextSim/.test(lip) || /textSim\) return stepTextSim/.test(lip),
      'G11：无波形时优先文字模拟；都无才 null 回正弦');
    ok(/return null/.test(lip), 'lipEnv 无波形且无 textSim 时仍返回 null');
    ok(/getFloatTimeDomainData/.test(lip), '包络来自 AnalyserNode 的时域数据');
    ok(/LIP_ATTACK/.test(lip) && /LIP_RELEASE/.test(lip), '快攻慢放（不是单速平滑，否则嘴巴像节拍器）');
    ok(/FFT_SIZE\s*=\s*512/.test(tts), 'fftSize=512（32ms @16k，约一个音节的粒度）');

    /* 测试环境防御 */
    const ac = between(ttsNoC, 'function getAC()', '\n}');
    ok(/typeof window !== 'undefined'/.test(ac),
      "getAC 有 typeof window 防御（Node 里 import 这个文件不该抛）");

    /* 诊断快照要能看出引擎与包络 */
    /* 按字段断，不钉整串 —— 这对象后来加了 degrade（引擎降级档），
     * 钉整串的话每次加字段都会假红，反而促使别人去改断言而不是看代码。 */
    const qs = between(tts, 'export function ttsQueueState()', '\n}');
    ok(/engine: engineOf\(\)/.test(qs) && /lip: lipActive/.test(qs) && /lipLevel/.test(qs),
      'ttsQueueState 带 engine / lip 字段（探针读它）');
  }

  /* ============================================================
   *  [C] pet.js 接线 —— 口型真的接到参数上
   * ========================================================== */
  console.log('[C] pet.js —— 口型接线');
  {
    const tick = between(petNoC, 'const env = lipEnv(dt)', 'PIXI.UPDATE_PRIORITY.LOW');
    ok(/const env = lipEnv\(dt\)/.test(petNoC), 'ticker 里调 lipEnv');
    ok(/if \(env !== null\)/.test(tick), 'env 非 null 时直接采用真实包络');
    /* 写入已收口到 setMouthOpen()（内部按 mouthOpenMax 夹幅，自制降档模型要用）。
     * 两段都断：分支把包络交给它 + 它内部真的落到 P.MOUTH_OPEN —— 只断函数名
     * 等于没断，改名/空壳都能骗过。 */
    const setMo = between(petNoC, 'function setMouthOpen(v)', '\n}');
    ok(/mouthLevel = env/.test(tick) && /setMouthOpen\(mouthLevel\)/.test(tick)
      && /setParam\(P\.MOUTH_OPEN/.test(setMo),
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
   *  [C2] 打断 —— 口型复位 + "她说到哪了"（2026-10-15）
   *
   *  出处是竞品调研第 7 轮的两条（docs/open-source-reference.md）：
   *    · Open-LLM-VTuber 的 web-audio-manager：打断要 releasePcmData +
   *      把 _lastRms 归零兜底 → 我们对应"停朗读时必须显式清口型/状态"；
   *    · 它的 basic_memory_agent.handle_interrupt：只把**听到的部分**写进记忆
   *      → 我们对应 truncateHistoryOnInterrupt。
   * ========================================================== */
  console.log('[C2] 打断 —— 口型复位与打断记忆');
  {
    /* 🔴 正弦波那条分支必须**同时**看 isSpeaking()。
     *    只看 state 会踩到：打断时被作废那条不推状态（finish 里 gen 不符就
     *    return），state 卡在 SPEAKING → 嘴闭着还在那儿一张一合。 */
    const tick = between(petNoC, 'const env = lipEnv(dt)', 'PIXI.UPDATE_PRIORITY.LOW');
    ok(/state === State\.SPEAKING && isSpeaking\(\)/.test(tick),
      '🔴 正弦波分支要求 state===SPEAKING **且** isSpeaking()（少判后半个 = 静默时嘴一直动）');
    ok(/export function isSpeaking\(\) \{ return ttsActive; \}/.test(tts),
      'isSpeaking 就是队列的"在念"标志（ttsActive），不是状态机的副本');
    ok(/\} else if \(mouthLevel > 0\) \{/.test(tick),
      '两条路都不成立时走衰减分支 —— 嘴会自己闭上，不会僵住');

    /* 停朗读必须连状态一起收（pet.js 的 stopSpeaking） */
    const stopS = between(petNoC, 'function stopSpeaking()', '\n}\n');
    ok(/stopSpeak\(\)/.test(stopS) && /resetSpoken\(\)/.test(stopS) && /setState\(State\.IDLE\)/.test(stopS),
      'stopSpeaking = 停朗读 + 清账 + 把 state 收回 IDLE（裸的 stopSpeak 不做后两件）');
    ok(/mouthLevel\s*=\s*0/.test(stopS) && /MOUTH_OPEN/.test(stopS),
      'G20：打断后嘴型立刻归零（mouthLevel + ParamMouthOpenY）');
    ok(/if \(changed && quiet\) \{\s*stopSpeaking\(\);/.test(petNoC),
      '全屏静默那一路用的是 stopSpeaking()（静默解除后 proactive 才不会被永久拦死）');

    /* ---- 打断记忆 ---- */
    ok(/const INTERRUPT_MARK = '\[Interrupted by user\]'/.test(pet),
      '标记文本只有一处定义（写进去和判幂等共用同一个常量）');

    const tr = between(petNoC, 'function truncateHistoryOnInterrupt()', '\n}\n');
    ok(/spokenText\(\)/.test(tr) && /resetSpoken\(\)/.test(tr),
      '读的是 tts 那笔"已念出的账"，读完立刻清（下一轮从零起算）');
    ok(/last\.content\.startsWith\(heard\)/.test(tr),
      '🔴 念出去的部分必须是那条回复的**前缀**，对不上就不动历史（宁保留完整回复，不写驴唇不对马嘴的）');
    ok(/length === heard\.length\) return false/.test(tr), '念完了就不算打断（不写标记）');
    ok(/INTERRUPT_MARK\) return false/.test(tr), '幂等：上一条已经是标记就不再写第二条');
    ok(/\+ '\.\.\.'/.test(tr), '截断后补省略号（"她说到一半"）');
    ok(/role: 'user', content: INTERRUPT_MARK/.test(tr), '标记以 user 身份插进去（对齐参考实现）');

    ok(/if \(cfg\?\.chat\?\.interruptMark !== false\) truncateHistoryOnInterrupt\(\);/.test(petNoC),
      '受 chat.interruptMark 开关控制（参数型开关，不进托盘）');

    const cleared = between(petNoC, 'onHistoryCleared', '});');
    ok(/resetSpoken\(\)/.test(cleared), '清空历史那一路也把账清掉（否则下一轮会拿旧账去比）');

    ok(/export function spokenText\(\)/.test(tts) && /export function resetSpoken\(\)/.test(tts),
      'tts.js 暴露 spokenText / resetSpoken');
    const po = between(ttsNoC, 'function playOne(', 'if (engineOf() === ENGINE_WINRT)');
    ok(/spokenBuf \+= text;/.test(po),
      '只在 playOne 里记账（= 队列真的泵出它、马上要念；被作废那条轮不到这里）');
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
    fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    for (const f of fs.readdirSync(path.join(SRC, 'renderer', 'profiles'))) {
      if (f.endsWith('.js')) fs.copyFileSync(
        path.join(SRC, 'renderer', 'profiles', f),
        path.join(dir, 'profiles', f.replace(/\.js$/, '.mjs')));
    }
    fs.writeFileSync(
      path.join(dir, 'params.mjs'),
      fs.readFileSync(path.join(SRC, 'renderer', 'params.js'), 'utf8')
        .replace(/'\.\/profiles\/([A-Za-z0-9_-]+)\.js'/g, "'./profiles/$1.mjs'"));
    /* tts.js 的同级依赖 tts-emotion.js 也得搬过去（无二级 import，纯映射表）。 */
    fs.copyFileSync(path.join(SRC, 'renderer', 'tts-emotion.js'), path.join(dir, 'tts-emotion.mjs'));
    fs.writeFileSync(
      path.join(dir, 'tts.mjs'),
      tts.replace(/from '\.\/params\.js'/, "from './params.mjs'")
        .replace(/from '\.\/tts-emotion\.js'/, "from './tts-emotion.mjs'")
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
    const reset = () => { T.stopSpeak(); T.resetSpoken(); spoken.length = 0; pending.length = 0; state = 'idle'; };

    /* ① 引擎判定：注入了 synth 且 engine=winrt → 应该是 winrt */
    ok(T.ttsQueueState().engine === 'winrt', '注入合成通道后 engine 报 winrt');

    /* ② lipEnv：没走 WebAudio 播放时必须返回 null（否则 pet.js 会拿到 0 而僵住） */
    ok(T.lipEnv(0.016) === null, '没在播真实音频时 lipEnv 返回 null');

    /* ③ 合成返回 null（失败）→ 这一句仍然要用系统音色念出来 */
    reset();
    T.enqueueSpeech('合成失败也要念');
    await flush();
    ok(spoken.includes('合成失败也要念'), '合成返回 null → 回退系统音色，这句话照样念出来');
    const envAfter = T.lipEnv(0.016);
    ok(typeof envAfter === 'number' && envAfter >= 0,
      'G11：回退后文字模拟口型（lipEnv 为数字，不再 null→正弦）');

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

    /* ⑥ 「已念出的账」+「在念」标志（打断记忆 / 口型复位都靠这两个出口） */
    synthImpl = async () => null;
    T.configureTTS({
      getCfg: () => ({ tts: { enabled: true, engine: 'winrt' } }),
      getState: () => state,
      isBusy: () => false,
      setState: (s) => { state = s; },
      isQuiet: () => false,
      synth: (t, o) => synthImpl(t, o)
    });
    reset();
    T.enqueueSpeech('第一句。');
    T.enqueueSpeech('第二句。');
    await flush();
    ok(T.spokenText() === '第一句。',
      '入队两条，但**只有真的开始念**的那条进账（第二条还在排队）');
    ok(T.isSpeaking() === true, '队列里有一条在念 → isSpeaking() 为真（口型分支靠它，不是 state）');
    /* 手动结束"当前这条"（fake 引擎不会自己 onend）→ 队列推进 */
    const endLast = () => { const u = pending[pending.length - 1]; if (u?.onend) u.onend(); };
    endLast();
    await flush();
    ok(T.spokenText() === '第一句。第二句。',
      '第一条念完接第二条，账里按顺序拼出前缀 —— 这正是"截历史"要的形态');
    ok(T.isSpeaking() === true, '第二条刚接上，仍在念 → 还是真');
    endLast();
    await flush();
    ok(T.isSpeaking() === false, '队列空了也念完了 → isSpeaking() 为假（嘴该停了）');
    T.resetSpoken();
    ok(T.spokenText() === '', 'resetSpoken 清账（下一轮从零起算）');

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* ============================================================
   *  [G] 行为 —— 打断记忆真的截得出"听到的部分"
   *
   *  把 pet.js 里那段纯逻辑切出来（它不碰 DOM / PIXI，只碰 history 与
   *  两个 tts 出口），注入一个假 history 直接跑。
   * ========================================================== */
  console.log('[G] 行为 —— 打断记忆的三条判断');
  {
    /* ⚠️ between 是 [起点, 终点) —— 不含终点，所以要自己把函数的收尾大括号补回来 */
    const snippet = between(petNoC, 'const INTERRUPT_MARK', '\n}\n') + '\n}';
    ok(snippet.length > 200, '切到了 truncateHistoryOnInterrupt 的实现');

    const mk = (spoken) => {
      /* 沙箱：两个 tts 出口换成假的，history 由用例给。
       * ⚠️ 每次新建一个 —— 前一个用例跑完的 history 不能串味。 */
      const box = {
        console, __heard: spoken, __reset: 0, history: [],
        /* G3 后 truncate 会读 isSpeaking / state / busy / replyBuffer —— 沙箱补齐。
         * 默认 idle：空 heard 时不应因 state===SPEAKING 误判为「开了口没念到」。 */
        state: 'idle', busy: false, replyBuffer: ''
      };
      vm.createContext(box);
      vm.runInContext(
        'function spokenText() { return __heard; }\n' +
        'function resetSpoken() { __reset++; }\n' +
        'function isSpeaking() { return !!__heard; }\n' +
        'const State = { SPEAKING: "speaking", IDLE: "idle" };\n' +
        snippet +
        '\n;globalThis.__t = { truncateHistoryOnInterrupt };',
        box
      );
      return box;
    };

    /* ① 念了一半被打断 → 截成前缀 + 补一条标记 */
    {
      const FULL = '今天挺晴的，出门记得戴帽子。风也有点大。';
      const box = mk('今天挺晴的，出门记得戴帽子。');
      box.history = [{ role: 'user', content: '天气怎么样' }, { role: 'assistant', content: FULL }];
      const cut = box.__t.truncateHistoryOnInterrupt();
      ok(cut === true, '念了一半 → 判定为被打断');
      ok(box.history[1].content === '今天挺晴的，出门记得戴帽子。...', '最后那条 assistant 截成"听到的部分+省略号"');
      ok(box.history.length === 3 && box.history[2].role === 'user' &&
         box.history[2].content === '[Interrupted by user]', '补了一条 user 身份的打断标记');
      ok(box.__reset === 1, '账已清（下一轮从零起算）');
    }

    /* ② 幂等：同一个回合里再调一次不写第二条 */
    {
      const box = mk('半句话');
      box.history = [{ role: 'assistant', content: '半句话后面还有很多字' }];
      box.__t.truncateHistoryOnInterrupt();
      const n = box.history.length;
      const again = box.__t.truncateHistoryOnInterrupt();
      ok(again === false && box.history.length === n, '🔴 幂等：上一条已是标记就不再写（不会堆一串标记）');
    }

    /* ③ 念完了 → 不算打断，历史一个字不动 */
    {
      const FULL = '好。';
      const box = mk(FULL);
      box.history = [{ role: 'assistant', content: FULL }];
      ok(box.__t.truncateHistoryOnInterrupt() === false, '念完了不写标记');
      ok(box.history.length === 1 && box.history[0].content === FULL, '历史保持原样（完整回复）');
    }

    /* ④ 对不上（不是前缀）→ 宁可保留完整回复 */
    {
      const box = mk('这句跟历史对不上');
      box.history = [{ role: 'assistant', content: '完全不同的另一句话' }];
      ok(box.__t.truncateHistoryOnInterrupt() === false, '🔴 不是前缀就不动历史（不写驴唇不对马嘴的东西）');
      ok(box.history.length === 1, '历史原样');
    }

    /* ⑤ 没念任何东西 / 末条不是 assistant → 什么都不做 */
    {
      const box1 = mk('');
      box1.history = [{ role: 'assistant', content: '没念过' }];
      ok(box1.__t.truncateHistoryOnInterrupt() === false, '这一轮压根没朗读 → 不算打断');

      const box2 = mk('用户说的话');
      box2.history = [{ role: 'assistant', content: '上一轮' }, { role: 'user', content: '用户说的话' }];
      ok(box2.__t.truncateHistoryOnInterrupt() === false, '末条是 user（用户刚发的新消息）→ 不截');
    }
  }

  console.log(fails === 0 ? '\n全部通过（0 项失败）' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
