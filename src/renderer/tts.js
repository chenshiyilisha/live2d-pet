import { State } from './params.js';

/* ============================================================
 *  语音朗读
 * ==========================================================
 *
 * 用 Chromium 内置的 speechSynthesis —— Windows 上就是系统 SAPI，
 * 零依赖、纯离线，不用装任何东西。音色取决于系统装了哪些语音包，
 * 中文 Windows 一般有 Microsoft Huihui / Yaoyao。
 * 想要更好听的音色（晓晓这类神经语音）再换 edge-tts，接口是同一个。
 * ========================================================== */

/* 外部依赖注入：配置、当前状态、是否忙碌、以及状态机的入口。
 * 这几个都在 pet.js 手里，用 getter 注入 —— 注意不能传值快照，
 * state / busy 每帧都在变。 */
let deps = {
  getCfg: () => null,
  getState: () => '',
  isBusy: () => false,
  setState: () => {},
  /* 全屏静默中（主进程判定你在打游戏 / 全屏看片）。
   * ⚠️ 拦在 speak() 这个**唯一出口**上，而不是在调用处逐个判断：
   *    念白有好几个来源（对话回复、主动搭话、定时提醒、摸头吐槽…），
   *    靠每一处自己记得判断，早晚会漏一个 —— 而"漏一个"的表现就是
   *    打游戏时角色突然开口说话，正是这个功能要消灭的东西。 */
  isQuiet: () => false
};
export function configureTTS(d) { Object.assign(deps, d); }

let ttsVoice = null;
let ttsReady = false;
// 兜底定时器：onend 偶尔不触发（合成被中断等），会让状态永远卡在 SPEAKING
let ttsGuard = null;

export function initTTS() {
  if (typeof speechSynthesis === 'undefined') {
    console.warn('[pet] speechSynthesis 不可用，语音朗读关闭');
    return;
  }
  const pick = () => {
    const all = speechSynthesis.getVoices() || [];
    const zh = all.filter((v) => /^zh|Chinese|中文|Huihui|Yaoyao|Xiaoxiao/i.test(`${v.lang} ${v.name}`));
    ttsVoice = zh.find((v) => /Xiaoxiao|Natural|Yunxi/i.test(v.name)) || zh[0] || all[0] || null;
    ttsReady = all.length > 0;
    console.log('[pet] tts 可用音色', JSON.stringify({
      total: all.length,
      picked: ttsVoice ? `${ttsVoice.name} (${ttsVoice.lang})` : null
    }));
  };
  pick();
  // voices 是异步填充的，第一次拿往往为空
  speechSynthesis.onvoiceschanged = pick;
}

export function speak(text) {
  const cfg = deps.getCfg();
  if (!cfg?.tts?.enabled || !text) return;
  // 全屏静默：只留气泡不发声（正在念的那句由 pet.js 收到 pet:quiet 时停掉）
  if (deps.isQuiet()) return;
  if (typeof speechSynthesis === 'undefined' || !ttsReady) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (ttsVoice) u.voice = ttsVoice;
    u.lang = ttsVoice?.lang || 'zh-CN';
    u.rate = cfg.tts.rate ?? 1.05;
    u.pitch = cfg.tts.pitch ?? 1.0;
    u.onstart = () => deps.setState(State.SPEAKING);
    u.onend = () => {
      clearTimeout(ttsGuard);
      if (deps.getState() === State.SPEAKING && !deps.isBusy()) deps.setState(State.IDLE);
    };
    speechSynthesis.speak(u);

    // 兜底：按字数粗估一个最长朗读时长，到点还没结束就强制回空闲
    clearTimeout(ttsGuard);
    ttsGuard = setTimeout(() => {
      if (deps.getState() === State.SPEAKING && !deps.isBusy()) deps.setState(State.IDLE);
    }, Math.max(2000, text.length * 260) + 2500);
  } catch (err) {
    console.warn('[pet] 朗读失败:', err?.message || err);
  }
}

export function stopSpeak() {
  try { speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/* 诊断用：当前选中的音色名（"Microsoft Huihui / zh-CN" 这样）。 */
export function ttsVoiceInfo() {
  return ttsVoice ? `${ttsVoice.name} / ${ttsVoice.lang}` : null;
}
