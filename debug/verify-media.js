'use strict';
/* 媒体感知（gsmtc）的验收。
 *
 * 四块内容：
 *   A. 采样脚本本身 —— **全 ASCII**（走 -EncodedCommand，有个中文就整条坏）、
 *      父进程自查、UTF-8 字节输出、WinRT 装不上时的报信。
 *   B. 解析 / 描述（纯函数）—— 半行不能当"没在放"、去重键、状态口径。
 *   C. 主进程接线 —— 按开关起停、注入位置、同一首歌只提一次。
 *   D. **真起一次采样进程**（只有 Windows 上跑）：能不能真拿到一行有效样本。
 *
 * ⚠️ 判定必须计数（这个项目踩过：只打印不累计 → 全红还是退出码 0）。
 *
 * 用法：node debug/verify-media.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
const ok = (m) => console.log('  ✅ ' + m);
const no = (m) => { failures++; console.log('  ❌ ' + m); };
const check = (cond, m) => (cond ? ok(m) : no(m));

const media = require('../src/main/media.js');
const { psScript, parseMediaLine, mediaKey, describeMedia } = media;

const MAIN = read('src/main/main.js');
const CFG = read('src/main/config.js');

console.log('══════ A. 采样脚本 ══════\n');

{
  const script = psScript(2000, 12345);

  /* 最重要的一条：脚本正文里出现任何非 ASCII 字符，-EncodedCommand 那条路
   * 就会在控制台代码页里坏掉（而报错往往指向别处）。 */
  const bad = [...script].filter((c) => c.charCodeAt(0) > 127);
  check(bad.length === 0,
    `脚本正文全 ASCII（发现 ${bad.length} 个非 ASCII 字符${bad.length ? '：' + bad.slice(0, 5).join('') : ''}）`);

  check(/Get-Process -Id \$parent/.test(script), '每 10 拍自查父进程还在不在（强杀时不留孤儿进程）');
  check(new RegExp('OpenStandardOutput', 'i').test(script) && /Encoding\]::UTF8\.GetBytes/.test(script),
    '靠 stdout 裸字节 + UTF-8 出去（中文歌名/歌手不经过控制台代码页）');
  check(/winrt-unavailable/.test(script), 'WinRT 装不上会**报信并退出**，不闷着循环白占内存');
  check(/Add-Type -AssemblyName System\.Runtime\.WindowsRuntime/.test(script), '加载了 WinRT 的运行时程序集');
  check(/IAsyncOperation/.test(script) && /MakeGenericMethod/.test(script),
    'IAsyncOperation → AsTask 的泛型反射转换（PS 5.1 唯一可行的绕法）');
  check(/GlobalSystemMediaTransportControlsSessionManager/.test(script), '用的是 GSMTC（系统级媒体会话）');
  check(/RequestAsync/.test(script), '管理器真的去请求了');
  check(script.includes('12345'), '父进程 pid 被写进脚本（不是写死的）');
  check(!/ConvertTo-Json[^\n]*-Depth/.test(script), '没有多余的 -Depth（对象是一层，不需要）');
}

console.log('\n══════ B. 解析与描述（纯函数） ══════\n');

{
  check(parseMediaLine('not json') === null, '非 JSON → null');
  check(parseMediaLine('{"partial') === null, '半行（进程刚被杀的截断）→ null');
  check(parseMediaLine('') === null, '空行 → null');
  check(parseMediaLine('  \n ') === null, '只有空白 → null');

  // null 与 {active:false} 必须分得开：前者是"这行没用，丢掉、别动现状"，
  // 后者是"确实没在放"。混成一个就会在切歌那一瞬间把已知信息清掉。
  const none = parseMediaLine('{"s":null}');
  check(none && none.active === false, '"没有会话" → {active:false}（与解析失败分得开）');

  const err = parseMediaLine('{"err":"winrt-unavailable"}');
  check(err && err.error === 'winrt-unavailable', '采样进程自报的错误是单独一档（不是"没在放"）');

  const playing = parseMediaLine('{"app":"cloudmusic.exe","title":"晴天","artist":"周杰伦","album":"叶惠美","status":"Playing"}');
  check(playing.active === true && playing.title === '晴天' && playing.artist === '周杰伦',
    '完整一行 → 字段齐（含中文）');
  check(parseMediaLine('{"app":"x","status":"Playing"}').title === '',
    '缺字段补空串（不 undefined，模板串里不会拼出 "undefined"）');
}

{
  const p = { active: true, title: '晴天', artist: '周杰伦', status: 'Playing' };
  check(describeMedia(p) === '正在听《晴天》 —— 周杰伦', 'Playing 的描述');
  check(describeMedia({ ...p, status: 'Paused' }).includes('暂停中'), 'Paused 也出话，但标明暂停');
  check(describeMedia({ ...p, status: 'Stopped' }) === '', 'Stopped → 空串（切歌瞬间的噪音，不提）');
  check(describeMedia({ ...p, status: 'Closed' }) === '', 'Closed → 空串');
  check(describeMedia({ active: false }) === '', '没在放 → 空串');
  check(describeMedia({ active: true, title: '', status: 'Playing' }) === '', '没歌名 → 空串');
  check(describeMedia({ active: true, title: '纯音乐', status: 'Playing' }) === '正在听《纯音乐》',
    '没有歌手时不拼出多余的空破折号');
  check(describeMedia(null) === '' && describeMedia(undefined) === '', 'null/undefined 都不抛');
}

{
  const a = { active: true, title: '晴天', artist: '周杰伦', status: 'Playing' };
  check(mediaKey(a) === mediaKey({ ...a, status: 'Paused' }),
    '同一首歌（暂停/继续）算同一个键 —— 不会被当成"换歌了"重复提');
  check(mediaKey(a) !== mediaKey({ ...a, title: '稻香' }), '换歌换键');
  check(mediaKey(a) !== mediaKey({ ...a, artist: '别的人' }), '换歌手换键');
  check(mediaKey({ active: false }) === '', '没在放时键为空串');
}

console.log('\n══════ C. 主进程接线 ══════\n');

{
  check(/require\('\.\/media'\)/.test(MAIN), 'main.js 引了 media 模块');
  check(/function refreshMediaWatcher\(\)/.test(MAIN), '有按配置起停的 refreshMediaWatcher()');
  const ref = MAIN.slice(MAIN.indexOf('function refreshMediaWatcher()'), MAIN.indexOf('function refreshMediaWatcher()') + 300);
  check(/isOn\('media', 'enabled'\)/.test(ref) && /startMediaWatch\(/.test(ref) && /stopMediaWatch\(\)/.test(ref),
    '开则起、关则停（幂等，config:set 反复走这条路不会反复重启）');
  check(/process\.env\.PET_MEDIA/.test(ref), 'PET_MEDIA=1 时把采样打进日志（唯一能验"真实播放器上不上报歌名"的口子）');
  check(/if \(section === 'media'\) refreshMediaWatcher\(\);/.test(MAIN),
    '托盘勾选立刻生效（不用重启）');
  check(/refreshMediaWatcher\(\);\s*\n\s*warnIfModelsMissing\(\)/.test(MAIN), '启动时按配置起进程');
  check(/stopMediaWatch\(\)/.test(MAIN.replace(/function stopMediaWatch[\s\S]*?\n}/, '')),
    '🔴 退出时显式杀进程（Windows 上父进程退出不带走子进程）');
  check(/ipcMain\.handle\('media:get'/.test(MAIN) && /isOn\('media', 'enabled'\) \? getMedia\(\) : null/.test(MAIN),
    'media:get 自己按开关兜底（渲染层不用判开关）');
}

{
  const m = CFG.match(/media:\s*\{[\s\S]*?\}/);
  check(!!m, 'config.js 有 media 段');
  check(/media:\s*\{\s*enabled:\s*false/.test(CFG), '默认**关**（要常驻一个采样进程，规矩 24）');
  check(/flag\('media',\s*'enabled',\s*'[^']+',\s*false\)/.test(MAIN), '托盘勾选项默认不勾（传了 false）');
  check(read('src/main/preload.js').includes('media: () => ipcRenderer.invoke(\'media:get\')'),
    'preload 暴露了 media()');
}

{
  /* 注入位置：必须紧跟人设那条 system，**不能**追加到末尾
   * （末尾是用户刚说的话，后面再插 system 有的后端会 400）。 */
  const fn = MAIN.slice(MAIN.indexOf('function injectMediaContext('), MAIN.indexOf('function chatStream('));
  check(/arr\.splice\(Math\.min\(1, arr\.length\), 0, \{ role: 'system', content: line \}\)/.test(fn),
    '媒体背景插在**第二位**（紧跟人设）');
  check(/Array\.isArray\(messages\) \? messages\.slice\(\) : \[\]/.test(fn),
    '不原地改传入的数组（纯函数，好测）');
  check(/if \(!line\) return arr;/.test(fn), '没有背景信息时原样返回（不多塞一条空 system）');
  check(/streamLLM\(withContext,/.test(MAIN) &&
    /injectMediaContext\(\s*injectVarietyHint\(messages, varietyHint\(messages, cfg\.chat\?\.varietyGuard !== false\)\),\s*mediaContextLine\(\)\s*\)/.test(MAIN),
    'chatStream 是唯一注入点 —— 对话和主动搭话两条路都吃到（媒体在外层 = 仍紧跟人设）');
  check((MAIN.match(/injectMediaContext\(/g) || []).length === 2,
    '媒体注入只有一处调用（另一处是定义）');
  check(/MEDIA_REPEAT_MS\s*=\s*30 \* 60 \* 1000/.test(MAIN) && /mediaSaid/.test(MAIN),
    '同一首歌 30 分钟内只提一次（否则每轮都来一句"你也在听这首啊"）');
  check(/别推荐别的歌、别说教/.test(MAIN), 'prompt 里明确禁止变成音乐推荐机器人');
}

console.log('\n══════ D. 真起一次采样进程 ══════\n');

function integration() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      console.log('  ⏭  非 Windows，跳过实跑\n');
      resolve();
      return;
    }
    const t0 = Date.now();
    let sample = null;
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; finish(); } }, 12000);

    function finish() {
      clearTimeout(timer);
      media.stopMediaWatch();
      const ms = Date.now() - t0;
      if (!sample) {
        no(`12 秒内没收到任何有效样本（采样进程没起来 / 脚本报错）`);
      } else if (sample.error) {
        no(`采样进程报错：${sample.error}（这台机器上媒体感知不可能生效）`);
      } else {
        ok(`收到有效样本（${ms}ms）：active=${sample.active}` +
           (sample.active ? ` title="${sample.title || ''}" status="${sample.status}"` : '（当前没在放东西）'));
        check(typeof sample.at === 'number', '样本带时间戳（诊断用）');
      }
      check(media.getMedia() === null, 'stopMediaWatch() 之后 getMedia() 归 null');
      resolve();
    }

    const started = media.startMediaWatch({
      sampleMs: 500,
      onSample: (m) => { if (!settled) { settled = true; sample = m; finish(); } }
    });
    check(started === true, 'startMediaWatch() 返回 true（Win32 上真的起了）');
    /* ⚠️ 这一条是回归断言：不带 onSample 的重复调用**不许**把钩子清掉。
     *    踩过 —— 表现是探针再也收不到样本，看着像"采样进程死了"。 */
    check(media.startMediaWatch() === true, '重复调用幂等（已在跑就直接返回，不启第二个进程）');
    check(media.startMediaWatch({}) === true, '带空选项重复调用也不换钩子（钩子只在显式给 onSample 时才动）');
  });
}

console.log('\n──────────────────────────────');
integration().then(() => {
  if (failures) {
    console.log(`❌ 失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('✅ 全部通过（媒体感知）');
});
