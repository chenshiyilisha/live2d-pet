/* 音频采样处理：重采样 + WAV 编码。
 *
 * 纯函数，不碰 DOM / AudioContext / IPC —— 可以直接拿一段 Float32Array
 * 做单测。录音链路（getUserMedia / ScriptProcessorNode / 状态机）留在 pet.js，
 * 因为那一半全是副作用。
 *
 * 为什么需要这两个函数：
 *   1) SAPI 对 16kHz / 16bit / 单声道 PCM 最友好，而 AudioContext 的
 *      采样率通常是 48kHz → 录完先重采样再编码。
 *   2) Windows 自带识别引擎只吃 WAV 文件，不吃裸 PCM。
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
