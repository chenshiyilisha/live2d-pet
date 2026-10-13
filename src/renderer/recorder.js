import { State } from './params.js';
import { resampleTo, encodeWav } from './audio.js';

/* ============================================================
 *  语音输入（按住说话）
 * ==========================================================
 *
 * 两个容易踩的点：
 *   1) ScriptProcessorNode 必须接到 destination 才会被驱动，但直连会把
 *      麦克风的声音外放出来（啸叫）。中间串一个 gain=0 的节点消掉。
 *   2) SAPI 对 16kHz / 16bit / 单声道 PCM 最友好，而 AudioContext 的
 *      采样率通常是 48kHz，所以录完要先重采样再编码（见 audio.js）。
 *
 * 这一层只管「按住 → 录 → 松开 → 交给主进程识别 → 把文本交回去」，
 * 气泡怎么写、要不要自动发出去由 pet.js 决定（onRecognized 回调）。
 * ========================================================== */

const micBtn = document.getElementById('mic');

let deps = {
  getCfg: () => null,
  showStatus: () => {},
  setEmotion: () => {},
  setIgnoreMouse: () => {},
  setState: () => {},
  onRecognized: () => {}
};
export function configureRecorder(d) { Object.assign(deps, d); }

let recCtx = null;
let recStream = null;
let recNode = null;
let recSource = null;
let recChunks = [];

/* 录音状态机。
 *
 * ⚠️ 这里**不能只用一个 bool**。startRecording 里 getUserMedia 是异步的，
 *    从 mousedown 到「真的在录」中间隔着若干 await。若状态位在 await **之后**
 *    才置真，那「快速点一下就松手」时 mouseup 读到的还是 false →
 *    直接跳过 stopRecording → 异步链随后把状态置真 → 录音就这么永久挂着：
 *    麦克风指示灯常亮、AudioContext / MediaStream 全泄漏，除非再点一次才能停。
 *
 *    idle → starting → recording 三态把这段空窗标出来；
 *    空窗里松手就记一笔 recStopRequested，等启动收尾时把它关掉。 */
const RecState = { IDLE: 'idle', STARTING: 'starting', RECORDING: 'recording' };
let recState = RecState.IDLE;
let recStopRequested = false;

/* 释放录音相关的一切资源。幂等，可以随便调。
 * stopRecording（正常结束）和 abortRecording（意外中断）都走它 ——
 * 麦克风只有一处关闭点，不会漏。 */
function releaseRecording() {
  try { if (recNode) recNode.onaudioprocess = null; } catch { /* ignore */ }
  try { recNode?.disconnect(); } catch { /* ignore */ }
  try { recSource?.disconnect(); } catch { /* ignore */ }
  try { recStream?.getTracks?.().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { recCtx?.close(); } catch { /* ignore */ }   // 返回 Promise，不必等
  recCtx = null;
  recStream = null;
  recNode = null;
  recSource = null;
}

async function startRecording() {
  if (recState !== RecState.IDLE) return;      // 已经在启动 / 已经在录了
  if (deps.getCfg()?.asr?.enabled !== true) {
    deps.showStatus('语音输入没开：托盘 →「语音输入（离线识别）」');
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    deps.showStatus('这个环境拿不到麦克风');
    return;
  }

  recState = RecState.STARTING;
  recStopRequested = false;

  /* 拿到流之后的**每一步都可能抛**：createMediaStreamSource 会因为
   * 「流里没有音轨」直接抛 InvalidStateError（实测过：麦克风被别的程序独占、
   * 设备热插拔、权限被中途撤销都会这样）。所以整段必须包在 try 里 ——
   * 一旦漏出去，recState 会永远卡在 STARTING，之后每次 startRecording 都被
   * 开头的守卫挡回去，**麦克风功能就此永久失效直到重启应用**。 */
  try {
    recStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });

    /* 拿流的这段时间里用户已经松手了 → 不进录音态，直接把流关掉。
     * 这就是「快速点一下」的路径，不处理的话会留下一个没人管的开启麦克风。 */
    if (recStopRequested || recState !== RecState.STARTING) {
      recStopRequested = false;
      recState = RecState.IDLE;
      releaseRecording();
      return;
    }

    recCtx = new (window.AudioContext || window.webkitAudioContext)();
    recSource = recCtx.createMediaStreamSource(recStream);
    recNode = recCtx.createScriptProcessor(4096, 1, 1);
    recChunks = [];
    recNode.onaudioprocess = (e) => {
      recChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    const mute = recCtx.createGain();
    mute.gain.value = 0;                     // 别把麦克风的声音外放出来
    recSource.connect(recNode);
    recNode.connect(mute);
    mute.connect(recCtx.destination);
  } catch (err) {
    recState = RecState.IDLE;
    recStopRequested = false;
    releaseRecording();                      // 半途建立的资源也要收干净
    deps.showStatus('麦克风用不了：' + (err?.message || err));
    return;
  }

  recState = RecState.RECORDING;
  micBtn.classList.add('recording');
  deps.setEmotion('surprised');
  deps.setIgnoreMouse(false);                // 录音期间别让窗口穿透，免得松手丢了事件
  deps.showStatus('在听……松开就识别');
}

async function stopRecording() {
  if (recState === RecState.IDLE) return;

  // 还在拿流（starting）→ 只记一笔，交给 startRecording 自己收尾，
  // 这里不能动资源：流还没建立，也还没被赋给 recStream
  if (recState === RecState.STARTING) { recStopRequested = true; return; }

  recState = RecState.IDLE;
  micBtn.classList.remove('recording');

  const rate = recCtx?.sampleRate || 48000;   // 必须在释放之前读
  releaseRecording();
  const total = recChunks.reduce((n, c) => n + c.length, 0);
  if (total < rate * 0.25) {                 // 不到 0.25 秒，基本是误触
    recChunks = [];
    deps.setEmotion('calm');
    deps.showStatus('太短了，没听清');
    return;
  }

  const all = new Float32Array(total);
  let off = 0;
  for (const c of recChunks) { all.set(c, off); off += c.length; }
  recChunks = [];

  const wav = encodeWav(resampleTo(all, rate, 16000), 16000);

  deps.showStatus('识别中…');
  deps.setState(State.THINKING);

  let res;
  try {
    res = await window.pet?.recognize?.(wav);
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }

  deps.setState(State.IDLE);

  if (!res?.ok) {
    deps.setEmotion('calm');
    deps.showStatus(res?.error === 'disabled'
      ? '语音输入没开：托盘 →「语音输入（离线识别）」'
      : '识别失败：' + (res?.error || '未知'));
    return;
  }

  const text = String(res.text || '').trim();
  if (!text) {
    deps.setEmotion('think');
    deps.showStatus('没听清，再说一遍？');
    return;
  }

  console.log('[pet] asr', JSON.stringify({ text }));
  deps.setEmotion('happy');
  deps.onRecognized(text);                   // 说完就发，不用再点一次
}

/* 意外中断（窗口被藏起来 / 切模型）：录音直接作废，不做识别。
 * 不兜这一手的话，窗口一藏起来 mouseup 就再也不触发了，麦克风会一直开着，
 * 用户只能看着系统那盏麦克风指示灯干瞪眼。 */
export function abortRecording() {
  if (recState === RecState.IDLE) return;
  if (recState === RecState.STARTING) { recStopRequested = true; return; }
  recState = RecState.IDLE;
  recStopRequested = false;
  micBtn.classList.remove('recording');
  releaseRecording();
  recChunks = [];
  deps.setEmotion('calm');
}

micBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  startRecording();
});

// 松手在哪都算——鼠标划出按钮也要能停下来，否则录音会一直挂着
window.addEventListener('mouseup', () => {
  if (recState !== RecState.IDLE) stopRecording();
});

/* 窗口一被藏起来（托盘「隐藏」），mouseup 就送不到了，
 * 录音会永远挂着。这里主动收尾。
 *
 * 只监听 visibilitychange、不监听 blur：桌宠是无边框 alwaysOnTop 悬浮窗，
 * blur 的触发时机不稳定（弹原生菜单、点别的窗口都会触发），
 * 拿它当中断条件会误伤「对着她说话时顺手点了别处」这种正常用法。 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) abortRecording();
});
