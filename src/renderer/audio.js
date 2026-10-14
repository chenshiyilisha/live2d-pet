/* 音频采样处理：重采样 + WAV 编码 + 静音检测。
 *
 * 纯函数，不碰 DOM / AudioContext / IPC —— 可以直接拿一段 Float32Array
 * 做单测。录音链路（getUserMedia / ScriptProcessorNode / 状态机）留在
 * recorder.js，因为那一半全是副作用。
 *
 * 为什么需要这三个函数：
 *   1) SAPI 对 16kHz / 16bit / 单声道 PCM 最友好，而 AudioContext 的
 *      采样率通常是 48kHz → 录完先重采样再编码。
 *   2) Windows 自带识别引擎只吃 WAV 文件，不吃裸 PCM。
 *   3) 按住没说话时不该白走一次识别（要起子进程，几百毫秒）→ 先看音量。
 */

export function resampleTo(samples, from, to) {
  if (from === to) return samples;
  const ratio = from / to;
  const len = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = samples[i0] * (1 - t) + samples[i1] * t;
  }
  return out;
}

/* Float32 PCM → 16bit PCM WAV（单声道） */
export function encodeWav(samples, sampleRate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);                  // PCM
  v.setUint16(22, 1, true);                  // 单声道
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);     // byteRate
  v.setUint16(32, 2, true);                  // blockAlign
  v.setUint16(34, 16, true);                 // 位深
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/* ============================================================
 *  静音检测（VAD）
 * ==========================================================
 *
 * 「按住说话」最常见的空转是：按住了但**确实没开口**（在犹豫、在等对方
 * 说完、手滑按到）。老链路对这段录音的做法是——编码 WAV → 走一次 Windows
 * 离线识别（起 PowerShell 子进程 + 加载语法，几百毫秒）→ 识别返回空文本
 * → 才提示"没听清，再说一遍？"。**那次识别对用户是纯白费**。
 *
 * 判据放在这一层而不是 recorder.js：它不需要任何设备状态，给一段
 * Float32Array 和一个采样率就能算 —— 纯函数、可单测。
 *
 * ⚠️ 阈值**刻意保守**：宁可漏判（真静音也走一次识别，代价只是慢一点），
 *    也不能错杀（用户明明说了话却被告知"没听到"，那才是真的难用）。
 *    所以 floor 压到 −40 dBFS 量级，而正常对着麦说话随便就到 −20。
 */
export const VAD = {
  frameMs: 20,          // 分帧长度。短帧才看得到音量包络；太长会把词语之间的停顿抹平
  peakFloor: 0.010,     // 单帧 RMS 低于它 = 那 20ms 里没人出声（约 −40 dBFS）
  minVoicedRatio: 0.10  // 至少这么多比例的帧要"有声音"，否则整段判为没人说话
};

/* 逐帧 RMS（音量包络）。
 *
 * 末尾不足一帧的样本**并成最后一帧**而不是丢掉：0.26 秒这种刚好卡在
 * 边界上的录音，被丢掉的可能正是唯一那点有效声音。 */
export function frameRms(samples, sampleRate, frameMs = VAD.frameMs) {
  const n = samples ? samples.length : 0;
  const out = [];
  if (!n) return out;
  const per = Math.max(1, Math.round((Number(sampleRate) || 0) * frameMs / 1000));
  for (let off = 0; off < n; off += per) {
    const end = Math.min(n, off + per);
    let sum = 0;
    for (let i = off; i < end; i++) {
      const v = samples[i];
      sum += v * v;
    }
    out.push(Math.sqrt(sum / (end - off)));
  }
  return out;
}

/* 这段录音里到底有没有人说话。
 *
 * 返回 { voiced, peak, ratio, frames } —— ratio 是超过阈值的帧占比。
 * 两个条件都要满足才算出声：
 *   · 光有峰值不算 —— 碰一下麦克风、挪椅子、开关门都有瞬时峰值；
 *   · 光有占比也不算 —— 麦克风增益拉满时的持续底噪能让每一帧都过阈。
 * 但对**人说话**来说这两条都极宽松，误杀窗口很小。 */
export function detectVoice(samples, sampleRate, opt = {}) {
  const floor = opt.peakFloor ?? VAD.peakFloor;
  const minRatio = opt.minVoicedRatio ?? VAD.minVoicedRatio;
  const frames = frameRms(samples, sampleRate, opt.frameMs ?? VAD.frameMs);
  let peak = 0;
  let voicedFrames = 0;
  for (const r of frames) {
    if (r > peak) peak = r;
    if (r >= floor) voicedFrames++;
  }
  const ratio = frames.length ? voicedFrames / frames.length : 0;
  return {
    voiced: frames.length > 0 && peak >= floor && ratio >= minRatio,
    peak,
    ratio,
    frames: frames.length
  };
}
