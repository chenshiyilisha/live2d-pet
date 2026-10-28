'use strict';

/* 悬浮气泡的源码级防回流断言（纯文本检查，不起 Electron）。
 *
 * 这套断言锁的是「聊天分片的双发路由」—— 它是这个功能最容易被改坏的地方：
 * 有人图省事直接 webContents.send('chat:chunk') 绕过 emitChatChunk，
 * 气泡窗就开始漏字；或者有人把 setQuiet 里的 bubble.setQuiet 删了，
 * 全屏游戏时气泡盖在游戏画面上。
 * 跑法：node debug/verify-bubble.js */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src');
let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};

/* 源码读入 + 归一 CRLF + 去注释（工作区是 CRLF，多个 debug 脚本踩过同一个坑） */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('[A] config.js —— 开关默认值');
{
  const c = stripComments(read('main/config.js'));
  /* ⚠️ [^}]* 只能匹配到 chat 段里"没有嵌套 {} "的部分 —— 这两个键是布尔字面量，够用。 */
  ok(/chat:\s*\{[^}]*floatBubble:\s*true/.test(c), 'chat.floatBubble 默认开');
  ok(/floatBubbleOutline:\s*false/.test(c), '描边默认关（用户两轮把描边减到 0，改观感的事交回给他）');
  ok(/floatBubbleJitter:\s*true/.test(c), '位置随机化默认开（纯去机械感，不打扰不占资源）');
}

console.log('[B] main.js —— 分片路由收拢 + 生命周期接线');
{
  const m = stripComments(read('main/main.js'));
  ok(/require\('\.\/bubble'\)/.test(m), '引入了 bubble 模块');

  ok(/function emitChatChunk\(t\)\s*\{/.test(m), 'emitChatChunk 收拢函数存在');
  const direct = (m.match(/send\('chat:chunk'/g) || []).length;
  ok(direct === 1, `chat:chunk 直发只许出现 1 次（emitChatChunk 内），实际 ${direct}`);
  ok(/createStreamFilter\(emitChatChunk,\s*emitChatEmotion,\s*emitChatThink\)/.test(m),
    'emitLocal 走收拢出口（正文 / 情绪 / 想法三路都走）');
  /* ⚠️ send 是包了一层的箭头函数：它要顺带把念出去的字累加进 spoken（TTS 被打断时
   * 按"实际念出的部分"截历史用）。断言得认这个包裹，但**里面必须还是 emitChatChunk**
   * —— 换成裸 webContents.send 浮窗就会漏字。 */
  ok(/send:\s*\(t\)\s*=>\s*\{[^}]*emitChatChunk\(t\)/.test(m), 'chatStream 走收拢出口');

  /* 想法通道（2026-10-14 加的 [think:…]）—— 和 chat:chunk 完全同款的收拢要求：
   * 有人图省事直接 webContents.send('chat:think') 绕过去，浮窗那一行就永远不亮；
   * 或者只接了浮窗、忘了回退布局（#bubble-think），关掉悬浮气泡功能就整个消失。 */
  const directThink = (m.match(/send\('chat:think'/g) || []).length;
  ok(directThink === 1, `chat:think 直发只许出现 1 次（emitChatThink 内），实际 ${directThink}`);
  ok(/sendThink:\s*emitChatThink/.test(m), 'chatStream 把想法接到收拢出口');
  ok(/chat:think/.test(read('main/preload.js')), '主窗 preload 暴露 chat:think');
  ok(/bubble:think/.test(read('main/bubble-preload.js')), '气泡窗 preload 暴露 bubble:think');

  const bjs = read('main/bubble.js');
  ok(/function appendThink\(text\)/.test(bjs), 'bubble.js 有 appendThink');
  ok(/\n\s*appendThink,/.test(bjs), 'appendThink 在导出面上');

  /* 想法显示在两个布局里各有一份，两边都得在 —— 否则换了布局它静默消失。 */
  ok(/id="think"/.test(read('main/bubble.html')), '浮窗气泡有 #think 那一行');
  ok(/id="bubble-think"/.test(read('renderer/index.html')), '回退布局有 #bubble-think');
  ok(/onThink/.test(read('renderer/pet.js')), '渲染层订阅了 onThink');
  /* ⚠️ 想法那一行必须在 #shell **内部**：它一跑到 shell 外面，窗口高度算式
   *    就少算它一段，长内容会裁尾巴 —— 而 [H] 那组数字还会全部对得上。 */
  ok(/<div id="shell"[^>]*><span id="think">/.test(read('main/bubble.html')),
    '想法那一行在 #shell 内部（在壳外就得重算 MAX_H）');

  const begin = (m.match(/bubble\.beginStream\(\)/g) || []).length;
  const end = (m.match(/bubble\.endStream\(\)/g) || []).length;
  const abort = (m.match(/bubble\.abortStream\(\)/g) || []).length;
  ok(begin >= 2, `beginStream 挂在 chat:send 与 chat:proactive 两处（${begin}）`);
  ok(end >= 2 && abort >= 2, `endStream(${end}) / abortStream(${abort}) 成对接线`);

  ok(/bubble\.setQuiet\(quiet\)/.test(m), '全屏静默会收掉气泡');
  ok(/bubble\.refreshConfig\(\)/.test(m), 'patchConfig 后刷新气泡开关');
  ok(/mainWindow\.on\('move',\s*\(\) => bubble\.syncPosition\(\)\)/.test(m), '主窗移动时气泡跟随');
  ok(/bubble\.configureBubble\(\{ getWindow: \(\) => mainWindow \}\)/.test(m), '主窗引用以 getter 注入');
  ok(/bubble\.registerBubbleIpc\(\)/.test(m), '气泡 IPC 已注册');
  ok(/bubble\.dispose\(\)/.test(m), '主窗 closed 时销毁气泡');
  ok(/'pet:float-say'/.test(m) && /'pet:float-hide'/.test(m), 'floatSay / floatHide 通道存在');
}

console.log('[C] preload.js —— 渲染层桥');
{
  const p = stripComments(read('main/preload.js'));
  ok(/floatSay:\s*\(text,\s*autoHideMs\)/.test(p), 'floatSay 带 autoHide 参数');
  ok(/floatHide:\s*\(\)/.test(p), 'floatHide 已暴露');
}

console.log('[D] pet.js —— 浮窗模式下主窗 #bubble 不再画');
{
  const r = stripComments(read('renderer/pet.js'));
  ok(/const floatBubble = \(\) => cfg\?\.chat\?\.floatBubble !== false;/.test(r), 'floatBubble 判定存在');
  const guards = (r.match(/!floatBubble\(\)/g) || []).length;
  ok(guards >= 6, `#bubble 写操作都有守卫（守卫出现 ${guards} 处）`);
  ok(/window\.pet\?\.floatSay\?\.\(line\)/.test(r), '离线主动搭话进浮窗');
  ok(/floatSay\?\.\(text,\s*autoHideMs\)/.test(r), 'say() 整段播报进浮窗');
  ok(/floatHide\?\.\(\)/.test(r), 'hideUI 会收浮窗');
}

console.log('[E] bubble.js —— 窗口本身的硬约束');
{
  const b = stripComments(read('main/bubble.js'));
  ok(/getContentBounds\(\)/.test(b) && !/main\.getBounds\(\)/.test(b), '定位锚 contentBounds（规矩 20）');
  ok(/focusable:\s*false/.test(b), '不抢聊天输入框焦点');
  ok(/hasShadow:\s*false/.test(b), '透明窗必须关系统阴影');
  ok(/screen-saver/.test(b), '置顶层盖过主窗');
  ok(/loadConfig\(\)\.chat\?\.floatBubble !== false/.test(b), '开关每次动作现读（改完立即生效）');
  ok(!/require\('\.\.\//.test(b), '不向上层目录 require（保持自包含）');
}

console.log('[F] 头顶锚点 —— 气泡锚人物头顶而非窗顶（2026-10-13 用户反馈"太远"）');
{
  const b = stripComments(read('main/bubble.js'));
  ok(/let headTop = null;/.test(b), 'headTop 状态存在（null = 还没量到）');
  ok(/const anchorY = b\.y \+ \(headTop \?\? 0\);/.test(b), 'place() 锚头顶（没量到退回窗顶）');
  ok(/const bottomY = anchorY - tipGap\(curH\) - TAIL_TIP_INSET;/.test(b),
    '底边 = 头顶 − tipGap(curH) − TAIL_TIP_INSET（决定"离人远近"的是尾巴尖不是窗底）');
  ok(/function tipGap\(h\)/.test(b) && /const TIP_GAP_MIN = 8;/.test(b) && /const TIP_GAP_MAX = 14;/.test(b),
    '间隙随气泡高度插值：矮的贴更近、高的多留呼吸（B3）');
  ok(/insideMode = bottomY - curH < wa\.y \+ 4;/.test(b), '贴顶兜底判据跟着 bottomY 走');
  ok(/async function measureHead\(\)/.test(b), 'measureHead 实量存在');
  ok(/getBitmap\(\)/.test(b), '用 nativeImage.getBitmap 逐行扫 alpha');
  ok(/function requestMeasure\(\)/.test(b) && /MEASURE_MIN_GAP_MS/.test(b), '实量有节流');
  ok(/module\.exports = \{[\s\S]*?requestMeasure,/.test(b), 'requestMeasure 在导出面上');

  const m = stripComments(read('main/main.js'));
  ok(/'pet:head-measure'/.test(m), 'main.js 注册 head-measure 通道');

  const p = stripComments(read('main/preload.js'));
  ok(/requestHeadMeasure:\s*\(\) => ipcRenderer\.send\('pet:head-measure'\)/.test(p), 'preload 暴露 requestHeadMeasure');

  const r = stripComments(read('renderer/pet.js'));
  const calls = (r.match(/requestHeadMeasure\?\.\(\)/g) || []).length;
  ok(calls >= 2, `layout 尾部 + 模型挂载后都触发实量（${calls} 处）`);
}

console.log('[G] 造型 —— 无描边 + 单层柔影挂在 #wrap（2026-10-13 用户："不要大黑边"→"只留很柔的投影"）');
{
  const h = read('main/bubble.html');
  /* ⚠️ 断言必须看**剥掉注释**的 CSS：bubble.html 的注释里正大光明写着
   *    "box-shadow 是各画各的…" 当反面教材，不剥就会假红（踩过一次）。 */
  const css = ((h.match(/<style>([\s\S]*?)<\/style>/) || ['', ''])[1]).replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => (css.match(new RegExp(`\\n  ${sel} \\{[\\s\\S]*?\\n  \\}`)) || [''])[0];
  const shell = block('#shell');
  const wrap = block('#wrap');
  const tail = block('#tail');

  ok(shell !== '' && wrap !== '' && tail !== '', '三个样式块都能切出来（选择器没被改名）');
  ok(!/border(?!-radius)/.test(shell), '#shell 无描边（只剩圆角）');
  ok(!/border(?!-radius)/.test(tail), '#tail 无描边（轮廓交给投影）');
  ok(!/box-shadow/.test(css), '不用 box-shadow（各画各的，尾巴接缝会留脏边）');
  ok(/filter:\s*drop-shadow\(/.test(wrap), 'drop-shadow 挂在 #wrap 上（按合成轮廓算 → 泡体和尾巴共用一条影）');
  ok(/position:\s*absolute/.test(tail), '尾巴 absolute 挂 #wrap（#wrap 有 filter → 是它的 containing block）');
  ok(/position:\s*relative/.test(wrap), '#wrap 是定位父级');

  /* 两层投影（A1）：近景"贴桌面" + 远景"轻浮起"，出处 dsh-pet 修完的形态。 */
  const layers = (wrap.match(/drop-shadow\(/g) || []).length;
  ok(layers >= 2, `投影至少两层（近景 + 远景），实际 ${layers} 层`);

  /* 描边（A2）：🔴 必须是"零偏移 drop-shadow"，用 border 就踩 dsh-pet 的"根因一"
   * —— border 画在矩形上，那条底边会横穿尾巴根部，尾巴立刻露出错层级。 */
  const outline = (css.match(/\n  body\.outline #wrap \{[\s\S]*?\n  \}/) || [''])[0];
  ok(outline !== '', '描边是独立的一条 body.outline #wrap 规则（可开关）');
  ok(/drop-shadow\(0 0 /.test(outline), '描边用零偏移 drop-shadow 模拟（不是 border）');
  ok(!/border(?!-radius)/.test(outline), '描边规则里没有 border');
  ok(css.indexOf('body.outline #wrap') > css.indexOf('#wrap {'),
    '描边写在 filter 链最前（先描边再投影，投影才不会被压住）');
}

console.log('[H] 几何联动 —— 三个文件里的数字必须对得上（规矩 9 / 22）');
{
  const b = stripComments(read('main/bubble.js'));
  const h = read('main/bubble.html');
  const grab = (re, i = 1) => {
    const m = h.match(re);
    return m ? Number(m[i]) : NaN;
  };
  const num = (re, i = 1) => {
    const m = b.match(re);
    return m ? Number(m[i]) : NaN;
  };

  const topPad = grab(/reportHeight\((\d+) \+ shell\.offsetHeight/);
  const botPad = grab(/reportHeight\(\d+ \+ shell\.offsetHeight \+ (\d+)\)/);
  const wrapBlock = (h.match(/\n  #wrap \{[\s\S]*?\n  \}/) || [''])[0];
  const tailBlock = (h.match(/\n  #tail \{[\s\S]*?\n  \}/) || [''])[0];
  const grabIn = (src, re, i = 1) => {
    const m = src.match(re);
    return m ? Number(m[i]) : NaN;
  };
  const wrapTop = grabIn(wrapBlock, /margin:\s*(\d+)px/);
  const wrapPadBot = grabIn(wrapBlock, /padding-bottom:\s*(\d+)px/);
  const tailBottom = grabIn(tailBlock, /bottom:\s*(\d+)px/);
  const shellMax = grab(/max-height:\s*(\d+)px/);
  const padV = grab(/padding:\s*(\d+)px\s+\d+px\s+(\d+)px/);
  const padV2 = grab(/padding:\s*\d+px\s+\d+px\s+(\d+)px/);
  const maxH = num(/const MAX_H = (\d+);/);
  const tipInset = num(/const TAIL_TIP_INSET = (\d+);/);

  ok(topPad === wrapTop, `report() 顶部留白(${topPad}) = #wrap margin-top(${wrapTop})`);
  ok(botPad === wrapPadBot, `report() 底部(${botPad}) = #wrap padding-bottom(${wrapPadBot})（尾巴的容身处，两处必须同一个数）`);
  ok(wrapPadBot - tailBottom >= 3, `尾巴确实伸到外壳外（padding-bottom ${wrapPadBot} − tail bottom ${tailBottom} = ${wrapPadBot - tailBottom}px）`);
  ok(botPad - 9 === tipInset, `TAIL_TIP_INSET(${tipInset}) = 底部(${botPad}) − 尾巴最低点 9px`);
  const shellOuter = shellMax + padV + padV2;
  ok(maxH >= topPad + shellOuter + botPad,
    `MAX_H(${maxH}) ≥ 顶部${topPad} + 泡体上限${shellOuter} + 底部${botPad} = ${topPad + shellOuter + botPad}（否则长回复裁尾巴和末行）`);

  /* 动画时长联动：主进程等 FADE_MS 才真 hide，所以 CSS 里 pop / fade 两个动画
   * 也必须播满这么久 —— 短了被截断、长了气泡已经透明还占着窗口。
   * ⚠️ 必须剥注释：注释里会提到 FADE_MS 和 0.16s 这些词，不剥会假绿/假红。 */
  const css2 = h.replace(/\/\*[\s\S]*?\*\//g, '');
  const popMs = Number((css2.match(/animation:\s*pop\s*([\d.]+)s/) || [])[1]);
  const fadeMs = Number((css2.match(/animation:\s*fade\s*([\d.]+)s/) || [])[1]);
  const fadeConst = num(/const FADE_MS = (\d+);/);
  ok(popMs * 1000 === fadeConst, `入场 pop(${popMs}s) = FADE_MS(${fadeConst}ms)`);
  ok(fadeMs * 1000 === fadeConst, `出场 fade(${fadeMs}s) = FADE_MS(${fadeConst}ms)`);
}

console.log('[I] 动效 + 尾巴回正 + 位置去机械感（2026-10-28，方案第一批）');
{
  const b = stripComments(read('main/bubble.js'));
  const h = read('main/bubble.html');
  const p = stripComments(read('main/bubble-preload.js'));

  /* ---- C1 出场淡出：入场有、出场没有是最容易被感知的不对称 ---- */
  ok(/send\('bubble:fade'\)/.test(b), '主进程 hide 前先发 bubble:fade');
  ok(/onFade/.test(p), 'preload 暴露 onFade');
  ok(/body\.fading \{ animation: fade/.test(h), '页面有 .fading 淡出动画');
  ok(/}, FADE_MS\);/.test(b), '等 FADE_MS 播完才真 hide（不是立刻 hide）');
  ok(/function clearFadeTimer\(\)/.test(b) && /clearFadeTimer\(\);/.test(b),
    '淡出计时可取消（淡出中途又开口 → reveal 取消那次 hide）');
  ok(/if \(on\) hideNow\(true\);/.test(b), '全屏静默立刻收，不等淡出的 160ms');
  ok(/dispose\(\)[\s\S]*?clearFadeTimer\(\)/.test(b), 'dispose 清掉淡出计时');

  /* ---- 入场必须由主进程驱动：窗口是复用的，body 上挂死动画只有第一句话有 ---- */
  const css3 = h.replace(/\/\*[\s\S]*?\*\//g, '');
  const bodyBlock = (css3.match(/\n  body \{[\s\S]*?\n  \}/) || [''])[0];
  ok(!/animation/.test(bodyBlock), 'body 上不挂常驻动画（窗口复用，那样第二句起就没有入场）');
  ok(/body\.pop \{ animation: pop/.test(h), '入场挂在 body.pop 上（由 onShow 驱动）');
  const reveal = (b.match(/function reveal\(w\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(reveal !== '', 'reveal() 存在（show + 起动画是一件事）');
  ok(reveal.indexOf('showInactive') >= 0 &&
     reveal.indexOf('showInactive') < reveal.indexOf("send('bubble:show'"),
    'showInactive 先于 bubble:show（反了的话动画有一截在窗口还藏着时就耗掉）');
  ok(/document\.body\.classList\.remove\('pop', 'fading'\);[\s\S]{0,80}void document\.body\.offsetWidth/.test(h),
    '重播动画前强制重排（不重排同名动画不会重播 → "代码有动画、屏幕没有"）');

  /* ---- 尾巴回正：位置一变尾巴必须跟着变（否则就是 dsh-pet 那个"尾巴方向错"）---- */
  ok(/send\('bubble:tail'/.test(b), '主进程下发尾巴回正量');
  ok(/onTail/.test(p), 'preload 暴露 onTail');
  ok(/translateX\(\$\{v\}px\) rotate\(45deg\)/.test(h),
    '尾巴按回正量平移（translateX 在 rotate 之前 → 父坐标系里是纯水平）');
  ok(/const want = Math\.round\(cx - \(pick\.x \+ curW \/ 2\)\);/.test(b),
    '回正量 = 人物中线 − 泡体中线（被屏幕边 clamp / 挪到侧候选之后也算得对）');
  ok(/const maxOff = tailOffsetMax\(curW\);/.test(b) &&
     /applyTailOffset\([\s\S]{0,80}maxOff/.test(b),
    '回正量有上限且**随宽度算**（固定 40 装不下侧候选的偏移）');

  /* ---- B2 位置随机化：有界、且同一句里恒定 ---- */
  ok(/const JITTER_X = 8;/.test(b), '随机幅度有界（±8px，"看得出不一样、看不出是随机"）');
  ok(/function hashJitter\(/.test(b) && !/Math\.random/.test(b),
    '用确定性散列而非 Math.random（可复现，回归才断言得了）');
  ok(/function newUtterance\(\)/.test(b), '每句话开头算一次');
  const placeFn = (b.match(/function place\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(placeFn !== '', 'place() 能切出来');
  ok(!/hashJitter|Math\.random/.test(placeFn),
    'place() 里**不**重算偏移（它被高度变化/拖拽高频调用，重算就会左右抖）');

  /* ---- 规矩 4：两个外观开关都要现读配置 ---- */
  ok(/chatOpt\('floatBubbleOutline'/.test(b) && /chatOpt\('floatBubbleJitter'/.test(b),
    '描边 / 随机化都走配置现读（规矩 4，改完下一句就生效）');
}

console.log('[J] 宽高比多档 + 上方三候选（2026-10-28，方案第二批：A3 / B1 / B4 / B5）');
{
  /* 这一段**直接调用** bubble.js 导出的纯函数（不是正则查源码）：
   * 摆位规则是"规则"不是"文本"，照 tiny-roommate 的「bubble placement logic
   * should live in pure layout helpers」「assert the intended constraints directly」。
   * ⚠️ require('electron') 在 node 下只返回路径字符串、不解构出真对象，
   *    但 bubble.js 顶层只解构不调用，所以能安全 require（不起 Electron）。 */
  const B = require(path.join(__dirname, '..', 'src', 'main', 'bubble.js'));
  const C = B._const;
  const WA = { x: 0, y: 0, width: 1920, height: 1040 };
  const base = { cx: 960, w: C.WIDTH_MIN, jitter: 0, wa: WA, inside: false, aside: true };

  /* ---- A3 宽度多档 ---- */
  ok(Array.isArray(C.WIDTH_STEPS) && C.WIDTH_STEPS.length >= 3, `宽度是**多档**不是单个常量（${C.WIDTH_STEPS.length} 档）`);
  ok(C.WIDTH_MIN === C.WIDTH_STEPS[0] && C.WIDTH_MAX === C.WIDTH_STEPS[C.WIDTH_STEPS.length - 1],
    'WIDTH_MIN / MAX 从档位数组派生（规矩 9：同一个数只在一处定义）');

  /* 收敛：模拟流式打字把气泡从 MIN_H 一路撑到 MAX_H，宽度逐档上浮后必须**停下**。 */
  let bad = [];
  for (let h = C.MIN_H; h <= C.MAX_H; h += 4) {
    let w = C.WIDTH_MIN;
    for (let i = 0; i < 8; i++) { const n = B._wantWidth(h, w, WA.width - 8); if (n === w) break; w = n; }
    if (w / h < C.ASPECT_MIN - 1e-9 && w < C.WIDTH_MAX) bad.push(`${h}→${w}`);
  }
  ok(bad.length === 0, `每个高度最终宽高比都 ≥ ${C.ASPECT_MIN}（治"窄高盒"，反例 ${bad.slice(0, 3).join(',') || '无'}）`);

  let mono = true;
  for (const cur of C.WIDTH_STEPS) {
    for (let h = C.MIN_H; h <= C.MAX_H; h += 4) if (B._wantWidth(h, cur, WA.width - 8) < cur) mono = false;
  }
  ok(mono, '宽度单调不减（A3 防回路的兜底：need 至少不小于当前宽）');

  /* 🔴 最重要的一条：加宽 → 文本行数变少 → 高度回落 → **不许把宽度收回去**。
   * 漏了它就是"加宽→变矮→收窄→变高→再加宽"的无限抖动，且只在流式打字时发作。 */
  const wTall = B._wantWidth(C.MAX_H, C.WIDTH_MIN, WA.width - 8);
  const wAfter = B._wantWidth(200, wTall, WA.width - 8);
  ok(wTall > C.WIDTH_MIN && wAfter === wTall,
    `加宽后内容变矮不再收窄（h ${C.MAX_H}→200：${C.WIDTH_MIN}→${wTall} 后仍 ${wAfter}）`);

  /* 死档检查：档位表里不能有一个永远够不到的档（"看着像多档、其实只有一档"）。 */
  const reached = new Set();
  for (let h = C.MIN_H; h <= C.MAX_H; h += 2) {
    let w = C.WIDTH_MIN;
    for (let i = 0; i < 8; i++) { const n = B._wantWidth(h, w, WA.width - 8); if (n === w) break; w = n; }
    reached.add(w);
  }
  const dead = C.WIDTH_STEPS.filter((w) => !reached.has(w));
  ok(dead.length === 0, `每一档在 h∈[${C.MIN_H},${C.MAX_H}] 都够得到（死档 ${dead.join(',') || '无'}）`);

  /* 有界：再窄的屏幕也不能算出比 WIDTH_MIN 还小、比可用宽度还大的值。 */
  const narrow = B._wantWidth(C.MAX_H, C.WIDTH_MIN, 300);
  ok(narrow >= C.WIDTH_MIN && narrow <= 300, `窄屏(300)下宽度夹在 [${C.WIDTH_MIN}, 300]（实际 ${narrow}）`);
  ok(B._wantWidth(C.MAX_H, C.WIDTH_MAX, WA.width - 8) <= C.WIDTH_MAX, '宽度不超过最大档');

  /* ---- B1 / B4 / B5 候选位 ---- */
  const mid = B._pickAnchor(base);
  ok(mid.name === 'top' && mid.x === Math.round(base.cx - C.WIDTH_MIN / 2),
    '空间充足时恒 **top**（正上方指着她最自然，左右候选不是常规随机）');

  const edgeL = B._pickAnchor({ ...base, cx: 60 });
  ok(edgeL.name !== 'top', `她贴屏幕左边缘、top 被夹时改用侧候选（实际 ${edgeL.name}）`);
  ok(edgeL.x >= WA.x + 4 && edgeL.x + C.WIDTH_MIN <= WA.x + WA.width - 4,
    '侧候选的 x 仍在 workArea 内（贴边正是要治的）');
  /* 负对照：关掉左右候选开关 → 必须退回 top，哪怕被夹。 */
  const offAside = B._pickAnchor({ ...base, cx: 60, aside: false });
  ok(offAside.name === 'top' && offAside.x === WA.x + 4, '关掉 floatBubbleAside → 恒 top（被夹到 wa.x+4 也认）');

  const inside = B._pickAnchor({ ...base, inside: true });
  ok(inside.name !== 'top', `退回主窗内（头顶上方放不下）时优先偏一侧少挡脸（实际 ${inside.name}）`);
  ok(['top', 'top-left', 'top-right'].includes(inside.name) &&
     ['top', 'top-left', 'top-right'].includes(edgeL.name),
    '候选**只在上方弧线里**（tiny-roommate：allowed family = top-left / top / top-right，side 不参与）');

  /* 尾巴回正的容量必须装得下最大的候选偏移 —— 装不下尾巴就挪出泡体、像后贴的方块。 */
  const maxOffRatio = Math.max(...Object.values(C.CAND_OFF).map((v) => Math.abs(v)));
  const fits = C.WIDTH_STEPS.every((w) => maxOffRatio * w + 8 <= B._tailOffsetMax(w));
  ok(fits, `每一档下「最大候选偏移 + jitter8」都 ≤ 尾巴回正上限（最窄档 ${(maxOffRatio * C.WIDTH_MIN).toFixed(1)}+8 ≤ ${B._tailOffsetMax(C.WIDTH_MIN)}）`);

  /* ---- B2 的范围：确定性散列必须真的落在 ±JITTER_X 里 ----
   * 🔴 这条是**真机抓出来的**（2026-10-28 第二批）：hashJitter 最后一步 `x ^= x >>> 13`
   *    在 JS 里会转回有符号 int32，取模跟着变负 → 实测吐出过 −18 / −21 / −23，
   *    而 JITTER_X 写的是 8。光断言"用了散列、常量是 8"根本拦不住它 ——
   *    "输出看起来就是个合理偏移"，只是比承诺的大三倍。所以这里**直接调它**。 */
  let jmin = 0, jmax = 0;
  for (let n = 1; n <= 300; n++) {
    const v = B._hashJitter(n, 8);
    if (v < jmin) jmin = v;
    if (v > jmax) jmax = v;
  }
  ok(jmin >= -8 && jmax <= 8, `散列输出真的落在 ±8 里（实测 ${jmin} … ${jmax}）`);
  ok(jmin < 0 && jmax > 0, '左右两个方向都会出现（不是恒 0、也不是单向）');

  /* ---- 源码接线：新能力必须有开关（规矩 4）、且不再有写死的宽度 ---- */
  const s = stripComments(read('main/bubble.js'));
  ok(/chatOpt\('floatBubbleWiden'/.test(s) && /chatOpt\('floatBubbleAside'/.test(s),
    '两个新开关都走配置现读（规矩 4，改完下一句就生效）');
  ok(/curW = widenOn\(\) \? wantWidth\(curH, curW, wa\.width - 8\) : WIDTH_MIN;/.test(s),
    'place() 按**当前可用宽度**决定档位（开关关掉 → 恒最窄档）');
  ok(/width: curW, height: curH/.test(s), 'setBounds 用当前档宽（不是写死的 272）');
  ok(!/\bWIDTH\b(?!_)/.test(s), '源码里不再有裸的 WIDTH 常量（全走 curW / WIDTH_MIN）');
  const nu = (s.match(/function newUtterance\(\) \{[\s\S]*?\n\}/) || [''])[0];
  ok(nu !== '' && /curW = WIDTH_MIN;/.test(nu),
    '每句话开头把宽度重置回最窄档（上一句的长回复不能把宽气泡留给下一句短话）');
}

console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
