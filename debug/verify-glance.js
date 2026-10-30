'use strict';

/* G23 / W15 / W16 —— 看屏口令、截屏拼装、就绪判定。
 * 跑法：node debug/verify-glance.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const glance = require(path.join(SRC, 'main', 'glance.js'));
const { isUsable, isLlmReady, isTestGreen } = require(path.join(SRC, 'main', 'llm-providers.js'));

let fails = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); return; }
  console.log('  FAIL', msg);
  fails++;
};
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8').replace(/\r\n/g, '\n');

(async () => {
  console.log('[A] W15 口令 isGlancePhrase');
  {
    const yes = ['看看', '看一眼', '帮我看看', '看看屏幕', '看一下桌面', '看看！'];
    const no = ['帮我看看这段代码对不对', '你看看天气', '看', '看看这个文件里写了什么啊'];
    for (const t of yes) ok(glance.isGlancePhrase(t), `命中「${t}」`);
    for (const t of no) ok(!glance.isGlancePhrase(t), `不误伤「${t.slice(0, 18)}」`);
  }

  console.log('[B] 缩略尺寸 / dataURL / 消息体');
  {
    const sz = glance.glanceThumbSize({ size: { width: 1920, height: 1080 }, scaleFactor: 1 }, 768);
    ok(sz.width === 768 && sz.height === 432, `768×432（得 ${sz.width}×${sz.height}）`);
    const hi = glance.glanceThumbSize({ size: { width: 800, height: 600 }, scaleFactor: 2 }, 768);
    ok(hi.width === 768 && hi.height === 576, `HiDPI 缩到 maxW（${hi.width}×${hi.height}）`);

    const fake = {
      toJPEG(q) { return Buffer.from([0xff, 0xd8, 0xff, q & 0xff]); }
    };
    const url = glance.toGlanceDataUrl(fake, 70);
    ok(/^data:image\/jpeg;base64,/.test(url), 'JPEG data URL');
    const msg = glance.buildGlanceUserMessage(url);
    ok(msg.role === 'user' && Array.isArray(msg.content) && msg.content.length === 2, '多模态 content 两段');
    ok(msg.content[0].type === 'text' && msg.content[1].type === 'image_url', 'text + image_url');
    ok(msg.content[1].image_url.url === url, 'image_url 原样带上');
  }

  console.log('[C] captureGlanceScreen 藏→截→恢复');
  {
    let hidden = 0;
    let shown = 0;
    const r = await glance.captureGlanceScreen({
      hideWaitMs: 5,
      hidePet: () => { hidden++; },
      showPet: () => { shown++; },
      getDisplay: () => ({ size: { width: 640, height: 360 }, scaleFactor: 1 }),
      getSources: async () => [{
        thumbnail: {
          isEmpty: () => false,
          toJPEG: () => Buffer.from('jpeg-bytes')
        }
      }]
    });
    ok(r.ok && r.dataUrl.includes('base64'), '截屏 ok');
    ok(hidden === 1 && shown === 1, `藏/恢复各一次（h=${hidden} s=${shown}）`);

    const fail = await glance.captureGlanceScreen({
      hideWaitMs: 1,
      hidePet: () => {},
      showPet: () => { shown++; },
      getDisplay: () => ({ size: { width: 100, height: 100 }, scaleFactor: 1 }),
      getSources: async () => []
    });
    ok(!fail.ok, '无 source → fail');
  }

  console.log('[D] W16 isLlmReady');
  {
    ok(!isLlmReady({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' }), '有 key 未测 → 不可 ready');
    ok(isUsable({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' }), '有 key → usable');
    const ready = {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: 'k',
      tested: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
    };
    ok(isTestGreen(ready) && isLlmReady(ready), '绿标 + usable → ready');
  }

  console.log('[E] main / config 接线');
  {
    const main = read('main/main.js');
    const cfg = read('main/config.js');
    ok(/runGlance|isGlancePhrase|captureGlanceScreen/.test(main), 'main 接 glance');
    ok(/glance:\s*false/.test(cfg), 'interaction.glance 默认关');
    ok(/requireTested:\s*false/.test(cfg), 'llm.requireTested 默认关');
    ok(/真测一句才算就绪/.test(main), '托盘 W16 开关');
    ok(/看一眼屏幕/.test(main), '托盘 G23 入口');
  }

  console.log(fails === 0 ? '\n全部通过' : `\n${fails} 项失败`);
  process.exit(fails === 0 ? 0 : 1);
})();
