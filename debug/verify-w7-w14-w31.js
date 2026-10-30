'use strict';

/* W7 锁屏重计 · W14 TTS 降级 · W31 不可用置灰 —— 源码/行为防回流。
 * 跑法：node debug/verify-w7-w14-w31.js
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

(async () => {
  console.log('[A] W7 reminder 锁屏清零 / 解锁重计');
  {
    const R = require(path.join(SRC, 'main', 'reminder.js'));
    ok(typeof R.onScreenLock === 'function' && typeof R.onScreenUnlock === 'function',
      'onScreenLock / onScreenUnlock 已导出');
    R.onScreenLock();
    ok(R.isReminderScreenLocked() === true, '锁屏后 isReminderScreenLocked=true');
    R.onScreenUnlock();
    ok(R.isReminderScreenLocked() === false, '解锁后 isReminderScreenLocked=false');

    const src = read('main/reminder.js');
    ok(/durationMs/.test(src), '提醒条目带 durationMs（重计用完整间隔）');
    ok(/screenLocked/.test(src) && /清零|重计|W7/.test(src), 'W7 注释与 screenLocked 状态存在');
    const main = read('main/main.js');
    ok(/onReminderScreenLock/.test(main) && /onReminderScreenUnlock/.test(main),
      'main 锁屏事件接到 reminder');
    R.disposeReminders();
  }

  console.log('[B] W8 = G14 setContentProtection');
  {
    const main = read('main/main.js');
    ok(/setContentProtection/.test(main), 'setContentProtection 接线存在');
    ok(/hideFromCapture/.test(main), 'hideFromCapture 配置开关存在');
    ok(/截屏\/录屏排除自己/.test(main), '托盘文案标明 OS 排除');
  }

  console.log('[C] W14 TTS 降级机');
  {
    const tts = read('renderer/tts.js');
    ok(/markDegrade/.test(tts) && /degradeSticky/.test(tts), '粘滞降级状态存在');
    ok(/playSilent/.test(tts), 'silent 末档存在');
    ok(/ttsDegradeLevel/.test(tts), 'ttsDegradeLevel 已导出');
    ok(/degrade → silent|degrade winrt/.test(tts), '降级日志文案存在');
  }

  console.log('[D] W14 行为：winrt 失败 → system 粘滞');
  {
    const spoken = [];
    globalThis.speechSynthesis = {
      speak(u) { spoken.push(u.text); },
      cancel() {},
      getVoices() { return [{ name: 'Huihui', lang: 'zh-CN' }]; }
    };
    globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-deg-'));
    fs.mkdirSync(path.join(dir, 'profiles'), { recursive: true });
    for (const f of fs.readdirSync(path.join(SRC, 'renderer', 'profiles'))) {
      if (f.endsWith('.js')) {
        fs.copyFileSync(
          path.join(SRC, 'renderer', 'profiles', f),
          path.join(dir, 'profiles', f.replace(/\.js$/, '.mjs')));
      }
    }
    fs.writeFileSync(path.join(dir, 'params.mjs'),
      fs.readFileSync(path.join(SRC, 'renderer', 'params.js'), 'utf8')
        .replace(/'\.\/profiles\/([A-Za-z0-9_-]+)\.js'/g, "'./profiles/$1.mjs'"));
    /* tts.js 的同级依赖 tts-emotion.js 也要搬（无二级 import），漏了就是 import 阶段直接死。 */
    fs.copyFileSync(path.join(SRC, 'renderer', 'tts-emotion.js'), path.join(dir, 'tts-emotion.mjs'));
    fs.writeFileSync(path.join(dir, 'tts.mjs'),
      read('renderer/tts.js')
        .replace(/from '\.\/params\.js'/, "from './params.mjs'")
        .replace(/from '\.\/tts-emotion\.js'/, "from './tts-emotion.mjs'"));
    const T = await import(pathToFileURL(path.join(dir, 'tts.mjs')).href);
    let state = 'idle';
    T.configureTTS({
      getCfg: () => ({ tts: { enabled: true, engine: 'winrt', rate: 1, pitch: 1 } }),
      getState: () => state,
      setState: (s) => { state = s; },
      isBusy: () => false,
      isQuiet: () => false,
      synth: async () => { throw new Error('boom'); }
    });
    T.initTTS();
    ok(T.ttsDegradeLevel() === 'winrt' || T.ttsDegradeLevel() === 'system',
      `初始 degrade=${T.ttsDegradeLevel()}`);
    T.speak('你好呀');
    await new Promise((r) => setTimeout(r, 120));
    ok(T.ttsDegradeLevel() === 'system', `合成失败后粘滞 system（${T.ttsDegradeLevel()}）`);
    ok(spoken.length >= 1, `已回退系统音色念出（${spoken.length}）`);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('[E] W31 不可用置灰');
  {
    const main = read('main/main.js');
    ok(/const unavailable = \(label, reason\)/.test(main), 'unavailable() 助手存在');
    ok(/仅 Windows/.test(main), '平台限制写明原因');
    ok(/没 key \/ 未配端点/.test(main), '测试连接无 key 置灰');
    ok(/暂无记录/.test(main), '导出对话无历史置灰');
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
