'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

/* ============================================================
 *  语音输入（离线识别）
 * ==========================================================
 *
 * 用的是 Windows 自带的 SAPI 中文识别引擎 —— 本机实测有
 * 「Microsoft Speech Recognizer 8.0 for Windows (Chinese Simplified - PRC)」，
 * **零依赖、零下载、完全离线**。
 *
 * ⚠️ 为什么不用 npm 上的 sherpa-onnx / vosk：
 *   都要额外下载几十上百 MB 的模型，而且这台机器在代理环境下
 *   pip / npm 经常拿不到包。系统自带引擎识别率不如神经模型，
 *   但"按住说一句话问点事"完全够用，而且不挑网络。
 *
 * ⚠️ 为什么绕一层 PowerShell 子进程：
 *   Add-Type 在受限执行策略下会被拦，但 execFile 起的是普通子进程，
 *   走系统自己的策略 —— 实测可用（debug/asr-probe.js 就是干这个的）。
 *
 * 输入要求：16kHz / 16bit / 单声道 PCM 的 WAV（渲染层负责录制与重采样）。
 * ========================================================== */

async function recognizeWav(buf) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wav = path.join(os.tmpdir(), `pet-asr-${stamp}.wav`);
  const outTxt = path.join(os.tmpdir(), `pet-asr-${stamp}.txt`);

  /* 结果写文件再读，不走 stdout —— 中文经管道会踩编码坑。 */
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -AssemblyName System.Speech',
    '$rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
    '$rec.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
    `$rec.SetInputToWaveFile("${wav}")`,
    '$r = $rec.Recognize()',
    `if ($r) { [System.IO.File]::WriteAllText("${outTxt}", $r.Text, [System.Text.Encoding]::UTF8) }` +
      ` else { [System.IO.File]::WriteAllText("${outTxt}", "", [System.Text.Encoding]::UTF8) }`
  ].join('; ');

  try {
    fs.writeFileSync(wav, buf);
    await new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 15000, maxBuffer: 1 << 20 },
        (err, stdout, stderr) => {
          if (err) console.warn('[asr] 识别进程异常:', String(stderr || err.message).slice(0, 200));
          resolve();
        });
    });
    const text = fs.existsSync(outTxt) ? fs.readFileSync(outTxt, 'utf8').trim() : '';
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  } finally {
    try { fs.rmSync(wav, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(outTxt, { force: true }); } catch { /* ignore */ }
  }
}

module.exports = { recognizeWav };
