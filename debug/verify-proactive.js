'use strict';
/* 主动搭话判据的验收。
 *
 * 这次改的东西分散在三个文件里（params.js / pet.js / main.js），
 * 三块内容各自独立：
 *   A. 情绪安定判据本身（纯函数 emotionDeviation + 阈值口径）
 *   B. 渲染层的接线（重试而不是重排整周期、闸门的三个条件、带情绪和历史）
 *   C. 主进程侧（按情绪挑话头、收历史、键集与 EMOTION 对齐）
 *
 * ⚠️ 判定必须计数（这个项目踩过：只打印不累计 → 全红还是退出码 0）。
 *
 * 用法：node debug/verify-proactive.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* params.js 是浏览器 ESM —— 剥掉 export 丢进 vm（与 verify-jitter.js 同款手法）。
 * 它还 import 了 profiles/hiyori.js 的档案数据 —— 档案剥 export 后拼在前面
 * （import 行剥掉，标识符由前置的档案定义）。 */
const stripEsm = (s) => s.replace(/^import[^\n]*$/gm, '').replace(/^export\s+/gm, '');
const pSandbox = { console, Math };
vm.createContext(pSandbox);
/* profiles/ 整个目录拼进来（stripEsm 会剥掉 import/export 前缀）——
 * params.js 引哪个档案都得在，加新模型不用改这里。 */
const profilesSrc = fs.readdirSync(path.join(ROOT, 'src', 'renderer', 'profiles'))
  .filter((f) => f.endsWith('.js'))
  .map((f) => stripEsm(read(path.join('src', 'renderer', 'profiles', f))))
  .join('\n');
vm.runInContext(
  profilesSrc + '\n' +
  stripEsm(read('src/renderer/params.js')) +
  '\n;globalThis.__api = { EMOTION, EMO_SETTLE_EPS, EMO_SETTLE_HOLD_MS, emotionDeviation };',
  pSandbox
);
const { EMOTION, EMO_SETTLE_EPS, EMO_SETTLE_HOLD_MS, emotionDeviation } = pSandbox.__api;

const EMO_KEYS = Object.keys(EMOTION);
const PET = read('src/renderer/pet.js');
const MAIN = read('src/main/main.js');

console.log('══════ A. 情绪安定判据（纯函数） ══════\n');

/* 1) 口径：取最大偏差，不是平均 */
{
  const cur = { a: 0.5, b: 0.5, c: 0.5 };
  const eff = { a: 0.5, b: 0.5, c: 0.55 };
  check(Math.abs(emotionDeviation(cur, eff) - 0.05) < 1e-12, '取的是**最大**偏差（0.05）');

  // 平均会被十几个已到位的字段稀释：这里 15 个字段零偏差 + 1 个大偏差，
  // 平均值只有 0.5/16 ≈ 0.031（在阈值内，会被误判成安定），最大值才是真相。
  const near = {}; const far = {};
  for (let i = 0; i < 15; i++) { near['k' + i] = 0; far['k' + i] = 0; }
  near.browLY = 0.5; far.browLY = 0;
  check(emotionDeviation(far, near) === 0.5,
    '单个字段没到位就**不算**安定（平均值会被稀释掉，这条拦住那种写法）');
  check(emotionDeviation(far, far) === 0, '完全一致 → 偏差 0');
}

/* 2) 边界：阈值两侧语义 */
{
  const eff = { x: 1 };
  check(emotionDeviation({ x: 1 - EMO_SETTLE_EPS / 2 }, eff) < EMO_SETTLE_EPS,
    '偏差 < 阈值 → 算收敛');
  check(!(emotionDeviation({ x: 1 - EMO_SETTLE_EPS * 2 }, eff) < EMO_SETTLE_EPS),
    '偏差 > 阈值 → 不算收敛');
  check(EMO_SETTLE_EPS > 0 && EMO_SETTLE_EPS < 0.2,
    '阈值落在"看不出还在动"的量级（0.06）');
  check(EMO_SETTLE_HOLD_MS === 5000, '保持 5 秒（与调研里 soullink 的 settledHoldSeconds 同值）');
}

/* 3) 真实情绪表：从 calm 切到别的情绪，初始偏差远大于阈值（否则判据形同虚设） */
{
  const calm = EMOTION.calm;
  // ⚠️ 排除 calm 对自己（偏差当然是 0）—— 这条量的是"切换"的落差
  const devs = EMO_KEYS.filter((k) => k !== 'calm')
    .map((k) => ({ k, d: emotionDeviation(calm, EMOTION[k]) }));
  const min = Math.min(...devs.map((d) => d.d));
  const max = Math.max(...devs.map((d) => d.d));
  const argmin = devs.find((d) => d.d === min).k;
  check(devs.every((d) => d.d > EMO_SETTLE_EPS * 2),
    `最"接近 calm"的 ${argmin} 初始偏差也有 ${min}（> 2×阈值，判据真的会拦）`);
  console.log(`     （初始偏差范围 ${min} ~ ${max}，阈值 ${EMO_SETTLE_EPS}）`);
}

/* 4) 指数逼近下"多久能安定"—— 口径自洽性检查（写进注释的数要能对上） */
{
  // 从偏差 0.5 收敛到 eps：0.5·e^(−s·t) = eps → t = ln(0.5/eps)/s
  const slowest = 2.2;   // EMO_SPEED 里最小的那个（bodyY/bodyZ）
  const t = Math.log(0.5 / EMO_SETTLE_EPS) / slowest;
  check(t > 0.5 && t < 3, `最慢的字段（速度 ${slowest}）从满幅情绪收敛到阈值约 ${t.toFixed(2)}s`);
}

console.log('\n══════ B. 渲染层接线 ══════\n');

/* 5) 安定计时由主循环推进（不是另起一个时钟 —— 规矩 16） */
{
  check(/emoSteadyMs\s*=\s*emotionDeviation\(emoCur,\s*emoEff\)\s*<\s*EMO_SETTLE_EPS/.test(PET),
    '安定计时量的是 emoCur 对 emoEff 的偏差（摸头调制也算在内）');
  check(/\?\s*emoSteadyMs\s*\+\s*dt\s*\*\s*1000\s*:\s*0/.test(PET),
    '偏差落回阈值内才累加，一超就归零');
  check((PET.match(/setInterval/g) || []).length === 0, '全程没有 setInterval（规矩 16）');
}

/* 6) 🔴 闸门与"短周期重试"—— 这次真正修掉的东西 */
{
  check(/reason|function proactiveBlockedBy/.test(PET) && /function proactiveBlockedBy\(\)/.test(PET),
    '有一个集中的"此刻能不能开口"判定');
  const gate = PET.slice(PET.indexOf('function proactiveBlockedBy()'), PET.indexOf('async function proactiveSpeak()'));
  check(/busy/.test(gate) && /state !== State\.IDLE/.test(gate) && /emoSteadyMs < EMO_SETTLE_HOLD_MS/.test(gate),
    '闸门三个条件：正忙 / 不在空闲态 / 情绪没安定');
  check(/retryIdleTimer\(\);/.test(PET) && /PROACTIVE_RETRY_MS\s*=\s*2000/.test(PET),
    '被闸门拦下 → 2 秒后再看一眼');
  // 关键：延后路径**不能**再调 pokeIdleTimer()（那会重排一整个闲置周期 = 这次不出声了）
  /* ⚠️ 切片两端都要**先断言存在**再切。踩过：2026-10-29 把 hasApiKey 改名成
   *    llmUsable 之后 indexOf 返回 -1，slice(start, -1) 悄悄切出一段错的源码，
   *    断言报的是"延后路径里有 pokeIdleTimer()"，看着像业务代码写错了。 */
  const deferStart = PET.indexOf('const why = proactiveBlockedBy();');
  const deferEnd = PET.indexOf('if (!llmUsable)');
  check(deferStart >= 0 && deferEnd > deferStart,
    '延后路径切片的两端都能在源码里找到（符号被改名时这条先红）');
  const defer = deferStart >= 0 && deferEnd > deferStart ? PET.slice(deferStart, deferEnd) : '';
  check(!/pokeIdleTimer\(\)/.test(defer),
    '🔴 延后路径里没有 pokeIdleTimer()（老代码在这里重排整个 8 分钟周期）');
}

/* 7) 带情绪和历史过去 */
{
  check(/window\.pet\.proactive\(\{\s*emotion,\s*history:\s*history\.slice\(-6\)\s*\}\)/.test(PET),
    '主动搭话把当前情绪 + 最近 6 条历史一起发给主进程');
  check(!/window\.pet\.proactive\(\)/.test(PET), '旧的"空手调用"已经不存在');
}

/* 8) 本地短句池按情绪分（8 个情绪都要有） */
{
  const m = PET.match(/const PROACTIVE_LINES = \{([\s\S]*?)\n\};/);
  check(!!m, 'PROACTIVE_LINES 是一张按情绪分的表');
  if (m) {
    const keys = [...m[1].matchAll(/^\s*([A-Za-z]+)\s*:/gm)].map((x) => x[1]);
    const missing = EMO_KEYS.filter((k) => !keys.includes(k));
    check(missing.length === 0, `8 个情绪一个不缺（缺：${missing.join(',') || '无'}）`);
    check(!/PROACTIVE_LINES\[Math\.floor/.test(PET),
      '取话一律走 proactiveLine()（它有兜底，定时器回调里不许抛）');
    check(/function proactiveLine\(/.test(PET), 'proactiveLine() 存在');
  }

  /* 本地路径说完要把她放回中性，否则表情停在 smile → 下一轮只会从 smile 池挑，
   * "按情绪分池"就退化成了单池（实跑日志里连着几条都是 smile 池）。 */
  const local = PET.slice(PET.indexOf('const line = proactiveLine(emotion);'), PET.indexOf('busy = true;'));
  check(/setTimeout\(/.test(local) && /setEmotion\('calm'\)/.test(local), '本地话术说完把情绪放回中性');
  check(/emotion === 'smile'/.test(local) && /patState === 'idle'/.test(local) && /!busy/.test(local),
    '放回中性有守卫（这 2.6 秒里用户摸了她 / 聊了一轮就不许按回去）');
}

console.log('\n══════ C. 主进程侧 ══════\n');

/* 9) 话头按情绪给方向，且键集与 EMOTION 一致 */
{
  const m = MAIN.match(/const PROACTIVE_MOOD_HINT = \{([\s\S]*?)\n\};/);
  check(!!m, '主进程有一张按情绪的话头表');
  if (m) {
    const keys = [...m[1].matchAll(/^\s*([A-Za-z]+)\s*:/gm)].map((x) => x[1]);
    const missing = EMO_KEYS.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !EMO_KEYS.includes(k));
    check(missing.length === 0 && extra.length === 0,
      `键集与 params.js 的 EMOTION 完全一致（缺：${missing.join(',') || '无'}；多：${extra.join(',') || '无'}）`);
    check(/\|\|\s*PROACTIVE_MOOD_HINT\.calm/.test(MAIN), '查不到情绪时退回 calm，不会给出 undefined');
  }
  check(/proactiveMoodHint\(c\.emotion\)/.test(MAIN), 'prompt 里真的拼上了情绪提示');
}

/* 10) 历史被收进来 + 校验 */
{
  check(/\.\.\.past,/.test(MAIN), '历史真的传给了对话后端');
  check(/m\.role === 'user' \|\| m\.role === 'assistant'/.test(MAIN),
    '历史条目按形状过滤（渲染层传来的东西不能直接信）');
  check(/const c = \(ctx && typeof ctx === 'object'\) \? ctx : \{\}/.test(MAIN),
    '主进程对 ctx 做了缺省兜底（老版本渲染层传 undefined 也不炸）');
}

console.log('\n══════ D. 免打扰时段与「未回复退避」（2026-10-15 加） ══════\n');

/* 11) 退避计数：开口 +1、用户搭理归零 */
{
  const hits = (PET.match(/proactiveUnanswered\+\+/g) || []).length;
  check(hits === 2, `两条出声路径都记了一笔（本地话术 / API 各一处，找到 ${hits} 处）`);

  const n = PET.slice(PET.indexOf('function noteUserResponse()'), PET.indexOf('function scheduleAfterQuietHours()'));
  check(/proactiveUnanswered = 0/.test(n) && /pokeIdleTimer\(\)/.test(n),
    'noteUserResponse = 退避归零 + 把闲置计时重新武装');
  check(/if \(proactiveUnanswered === 0\) return;/.test(n),
    '本来就没欠账时不白排定时器（直接返回）');

  /* ⚠️ 每个"明确回应"的入口都要调它 —— 漏一个的表现是"用户点了她也没用"，
   *    而且只在"她已经被冷落到上限"这个状态下才看得出来，非常隐蔽。
   *    （sendMessage 里 noteUserResponse 之后紧跟着 chatEpoch++ ——
   *    在途作废和退避归零必须是同一动作的两半。） */
  check(/noteUserResponse\(\);\s*\n\s*\/\* 开口 = 在途的主动话全部作废[\s\S]{0,200}?chatEpoch\+\+;/.test(PET),
    '发消息那一路清零');
  check(/noteUserResponse\(\);.*\/\/ 点她/.test(PET), '点她那一路清零');
  check(/noteUserResponse\(\);.*\/\/ 摸完/.test(PET), '摸完松手那一路清零');
  /* 反向：mousemove 那条（5 秒一次）**不许**清零，否则退避形同虚设 */
  const move = PET.slice(PET.indexOf("window.addEventListener('mousemove'"), PET.indexOf('scheduleHitTest(e.clientX'));
  check(!/noteUserResponse/.test(move), '🔴 鼠标划过**不算**搭理（那个 5 秒就能触发一次）');
}

/* 12) 上限的钳法 + "到上限就彻底停手" */
{
  const cap = PET.slice(PET.indexOf('function maxUnanswered()'), PET.indexOf('function refreshProactiveConfig()'));
  check(/Number\.isFinite\(n\) && n >= 0 \? Math\.floor\(n\) : 2/.test(cap),
    '上限有钳法：配置写成乱码 / 负数 → 2（不许静默变成"永不开口"）');
  check(/if \(cap > 0 && proactiveUnanswered >= cap\) return 'unanswered';/.test(PET),
    '闸门里有这一条（返回的字符串给日志辨认）');
  check(/if \(why === 'unanswered'\) \{ clearTimeout\(idleTimer\); return; \}/.test(PET),
    '🔴 到上限 = 彻底停手：**不排新定时器**（排了就是每 8 分钟空转一次、永远不出声）');
  check(/const cap = maxUnanswered\(\);\s*\n\s*if \(cap > 0 && proactiveUnanswered >= cap\) return;/.test(PET),
    'pokeIdleTimer 里也拦住（那里是所有"人还在"入口的收口处）');
}

/* 13) 配置与接线 */
{
  const CFG = read('src/main/config.js');
  const seg = CFG.slice(CFG.indexOf('proactive: {'), CFG.indexOf('media: {'));
  check(/quietHours:\s*'23-8'/.test(seg), "默认免打扰时段 '23-8'（跨零点）");
  check(/maxUnanswered:\s*2/.test(seg), '默认未回复上限 2');
  check(/refreshProactiveConfig\(\);/.test(PET), '配置变更后重算区间（免得改完还要重启）');
  check(/refreshProactiveConfig\(\);\s*\n\s*pokeIdleTimer\(\);/.test(PET),
    '重算在排计时器**之前**（顺序反了会拿旧区间判一次）');
}

console.log('\n══════ E. 媒体播放中不插话（2026-10-15 加） ══════\n');

/* 这一段要 await（refreshMediaPlaying 是 async），所以整段包在 IIFE 里，
 * 末尾的汇总也挪进来 —— 否则汇总会抢在真跑之前打印。 */
(async () => {
  /* 14) 取数与缓存：**真跑**（把那段源码切出来丢进 vm，喂一个假 window） */
  {
    const MEDIA = PET.slice(PET.indexOf('const MEDIA_RETRY_MS'), PET.indexOf('function pokeIdleTimer()'));
    check(MEDIA.length > 200, '切到了 media 闸门那段（常量 + 缓存 + refreshMediaPlaying）');
    check(/const MEDIA_RETRY_MS = 30 \* 1000;/.test(MEDIA), '重试周期 30 秒（不是 2 秒空转）');

    const sandbox = { console, window: {} };
    vm.createContext(sandbox);
    vm.runInContext(MEDIA + '\n;globalThis.__api = { refreshMediaPlaying, playing: () => mediaPlaying };',
      sandbox);
    const { refreshMediaPlaying, playing } = sandbox.__api;

    const feed = (v) => { sandbox.window = { pet: { media: async () => v } }; };

    feed({ active: true, status: 'Playing' });
    await refreshMediaPlaying();
    check(playing() === true, 'Playing → 拦住（这才是"别插话"的那一档）');

    feed({ active: true, status: 'Paused' });
    await refreshMediaPlaying();
    check(playing() === false, 'Paused 不算 —— 暂停着往往就是在等她说话');

    feed(null);
    await refreshMediaPlaying();
    check(playing() === false, 'media.enabled 关着（主进程恒返回 null）→ 等于这功能不存在');

    feed({ active: false });
    await refreshMediaPlaying();
    check(playing() === false, '没在放东西 → 放行');

    sandbox.window = {};
    await refreshMediaPlaying();
    check(playing() === false, '🔴 桥不存在（旧 preload）→ 放行，不抛');

    sandbox.window = { pet: { media: async () => { throw new Error('boom'); } } };
    await refreshMediaPlaying();
    check(playing() === false, '🔴 取数抛异常 → 放行（fail-open：绝不能让读不到状态把她哑掉）');

    check(/window\.pet\?\.media\?\.\(\)/.test(MEDIA), '按规矩 31 用 `window.pet?.xxx?.(`（护到方法一层）');
  }

  /* 15) 闸门与分派 */
  {
    const gate = PET.slice(PET.indexOf('function proactiveBlockedBy()'), PET.indexOf('async function proactiveSpeak()'));
    check(/if \(mediaPlaying\) return 'media';/.test(gate), "闸门里有这一条（返回 'media' 供日志辨认）");
    check(gate.indexOf('mediaPlaying') < gate.indexOf('inQuietHours'),
      '排在免打扰之前（都是"延后"，先报更近的那个原因）');

    const sp = PET.slice(PET.indexOf('async function proactiveSpeak()'), PET.indexOf('async function sendMessage()'));
    check(/await refreshMediaPlaying\(\);\s*\n\s*const why = proactiveBlockedBy\(\);/.test(sp),
      '🔴 每轮闸门判断**之前**刷一次缓存（顺序反了就是拿上一轮的状态判）');
    check(/if \(why === 'media'\) \{ retryIdleTimer\(MEDIA_RETRY_MS\); return; \}/.test(sp),
      '分派：媒体走 30 秒长周期，不是 2 秒（整部片子期间别每 2 秒敲一次主进程）');
    check(/function retryIdleTimer\(ms = PROACTIVE_RETRY_MS\)/.test(PET),
      'retryIdleTimer 收可选周期，默认仍是 2 秒（其余三条延后原因照旧）');
    check(!/proactiveUnanswered\+\+[\s\S]{0,240}mediaPlaying/.test(PET), '被媒体拦下**不**计入退避');
  }

  /* 16) 只拦主动搭话，不拦用户自己找她 */
  {
    const send = PET.slice(PET.indexOf('async function sendMessage()'), PET.indexOf('sendBtn.addEventListener'));
    check(!/mediaPlaying|refreshMediaPlaying/.test(send),
      '🔴 用户自己发消息不看媒体状态 —— 插不插话由主人决定，不由我们');
    check(read('src/main/preload.js').includes("media: () => ipcRenderer.invoke('media:get')"),
      'preload 暴露了 media()（闸门唯一的取数口）');
  }

  console.log('\n══════ F. 四闸门：锁屏 / 聊完安静 / 在途作废 / send-silent（2026-10-15 加） ══════\n');

  /* CRLF 工作区：切函数体前先归一化（verify-jitter 踩过的坑，这里统一用帮手） */
  const petLF = (s) => s.replace(/\r\n/g, '\n');
  const PET_LF = petLF(PET);
  const MAIN_LF = petLF(MAIN);

  /* 17) cooldownMs 的钳法 —— 切函数体配假配置真跑 */
  {
    const h = PET_LF.indexOf('function cooldownMs()');
    const t = PET_LF.indexOf('\n}', h);
    const sb = { Number };
    vm.createContext(sb);
    vm.runInContext(PET_LF.slice(h, t + 2) + ';globalThis.__cd = cooldownMs;', sb);
    const cd = (o) => { sb.cfg = { proactive: o }; return sb.__cd(); };

    check(cd(undefined) === 10 * 60 * 1000, '缺省回落默认 10 分钟（乱码/没写都不至于关掉闸门）');
    check(cd({}) === 10 * 60 * 1000, '空对象同上');
    check(cd({ cooldownMinutes: 0 }) === 0, '写 0 = 关');
    check(cd({ cooldownMinutes: -5 }) === 0, '负数同"关"');
    check(cd({ cooldownMinutes: 25 }) === 25 * 60 * 1000, '正常值直通');
    check(cd({ cooldownMinutes: 99999 }) === 720 * 60 * 1000, '上限钳到 720 分钟（手滑不冻到明天）');
    check(cd({ cooldownMinutes: 'abc' }) === 10 * 60 * 1000, '乱码回落默认（NaN 分支）');
  }

  /* 18) 闸门与分派（proactiveBlockedBy / proactiveSpeak 的源码形状） */
  {
    check(/muteOnLock !== false && screenLocked\)\s*return 'locked';/.test(PET_LF),
      "锁屏闸门在 blockedBy 里，且带 muteOnLock !== false（默认开语义）");
    check(/screenLocked\)\s*return 'locked';[\s\S]{0,400}?mediaPlaying\)\s*return 'media';/.test(PET_LF),
      '顺序：locked 在 media 之前（锁屏比放媒体更"绝对"）');
    check(/cd > 0 && Date\.now\(\) - lastChatAt < cd\)\s*return 'chat_cooldown';/.test(PET_LF),
      '聊完安静期的判据（最后一次对话交互时间戳）');
    check(/why === 'locked'\) \{ retryIdleTimer\(60 \* 1000\); return; \}/.test(PET_LF),
      '锁屏分派：60 秒兜底（unlock 事件会主动重排）');
    check(/why === 'chat_cooldown'\) \{\s*\n\s*retryIdleTimer\(Math\.max\(3000, lastChatAt \+ cooldownMs\(\) - Date\.now\(\)\)\);/.test(PET_LF),
      '冷却分派：排到冷却结束，下限 3 秒防时钟回拨空转');
  }

  /* 19) 锁屏事件的两端（主进程推送 + 渲染层收口） */
  {
    check(/powerMonitor\.on\('lock-screen'/.test(MAIN_LF) && /powerMonitor\.on\('unlock-screen'/.test(MAIN_LF),
      '主进程挂了 lock-screen / unlock-screen 两个监听');
    check(/'pet:screen-locked', \{ locked: true \}/.test(MAIN_LF) && /'pet:screen-locked', \{ locked: false \}/.test(MAIN_LF),
      '两个方向都推 pet:screen-locked');
    check(read('src/main/preload.js').includes("'pet:screen-locked'"),
      'preload 白名单放行 pet:screen-locked');
    const sub = PET_LF.slice(
      PET_LF.indexOf("on?.('pet:screen-locked'"),
      PET_LF.indexOf('// 系统状态悬浮显示')
    );
    check(/if \(locked\) clearTimeout\(idleTimer\);/.test(sub), '进锁屏：撤掉排好的主动搭话');
    check(/else pokeIdleTimer\(\);/.test(sub), '解锁：闲置周期从现在重新计');
  }

  /* 20) 在途作废的双保险（主进程断流 + 渲染层 epoch） */
  {
    check(/if \(proactiveAbort\) \{\s*\n\s*proactiveAbort\.abort\(\);/.test(MAIN_LF),
      'chat:send 开头就 abort 在途的主动搭话（源头断流）');
    check(/\{ signal: ac\.signal \}/.test(MAIN_LF), 'chat:proactive 把 AbortController 传进了 chatStream');
    check(/proactiveAbort === ac\) proactiveAbort = null;/.test(MAIN_LF),
      'finally 里只清自己那把锁（别把别人的账抹了）');
    check(/const epoch = chatEpoch;/.test(PET_LF) && /await window\.pet\.proactive/.test(PET_LF),
      '渲染层在 await 之前记下对话代次');
    check(/if \(epoch !== chatEpoch\) \{/.test(PET_LF), 'await 之后对不上就整条作废');
    const discard = PET_LF.slice(
      PET_LF.indexOf('if (epoch !== chatEpoch)'),
      PET_LF.indexOf('pokeIdleTimer();', PET_LF.indexOf('if (epoch !== chatEpoch)')) + 40
    );
    check(!/history\.push/.test(discard), '🔴 作废的话不进历史');
    check(/floatHide/.test(discard), '作废时把浮窗也收掉（万一断流前已经说了半句）');
  }

  /* 21) send-silent（她可以选择不说） */
  {
    check(/proactive\?\.allowSilent !== false/.test(MAIN_LF), 'allowSilent 默认开语义（写 false 才关）');
    check(/只回一个 \[silent\]/.test(MAIN_LF), '主动搭话的 prompt 给了"不说"的出口');
    /* W26 先记账后生成：沉默也要 settleDelivery 收账，两行之间因此多了记账调用；
     * return 也带上了 reason / head（给账本与人设复盘用）。按前缀匹配，不钉闭括号。 */
    check(/res\?\.ok && res\.silent\)[\s\S]{0,800}?return \{ ok: true, silent: true/.test(MAIN_LF),
      '主进程识别沉默并原样转告（正文早已被清洗层剥掉）');
    const silentBranch = PET_LF.slice(
      PET_LF.indexOf('if (res?.ok && res.silent)'),
      PET_LF.indexOf('pokeIdleTimer();', PET_LF.indexOf('if (res?.ok && res.silent)')) + 40
    );
    check(!/proactiveUnanswered\+\+/.test(silentBranch),
      '🔴 沉默不占"没被搭理"的配额（她根本没开口）');
    check(!/history\.push/.test(silentBranch), '沉默不进历史');
    check(/pokeIdleTimer\(\)/.test(silentBranch), '沉默照常排下一轮');
  }

  /* 22) 冷却时间戳的三个刷新点 */
  {
    const send = PET_LF.slice(PET_LF.indexOf('async function sendMessage()'), PET_LF.indexOf('sendBtn.addEventListener'));
    check((send.match(/lastChatAt = Date\.now\(\)/g) || []).length >= 2,
      'sendMessage 里两个刷新点（开口时 + 回复完成时）');
    const speak = PET_LF.slice(PET_LF.indexOf('async function proactiveSpeak()'), PET_LF.indexOf('async function sendMessage()'));
    check(/lastChatAt = Date\.now\(\);/.test(speak), '她主动说完也刷（冷却期从说完起算）');
  }

  /* 23) llm.js 的 [silent] 剥离（清洗层的标签分支） */
  {
    const LLM = read('src/main/llm.js');
    check(LLM.includes('silentSeen = true;'), 'drain 认得 [silent] 标签（正文里剥掉不留字符）');
    check(LLM.includes('silent() { return silentSeen && !emitted; }'),
      "silent() 只认'整条都是沉默'（混在正文里的标签不算）");
    check(LLM.includes('silent: filter.silent()'), 'streamLLM 返回值带 silent');
    check(LLM.includes("signal.addEventListener('abort'") && LLM.includes("abortWhy = 'external'"),
      '外部中止信号接进了 llm.js（在途作废的源头断流）');
  }

  console.log('\n──────────────────────────────');
  if (failures) {
    console.log(`❌ 失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('✅ 全部通过（主动搭话判据）');
})();
