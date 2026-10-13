/* 自制动作 + 溜达/回位 的**实跑**验证驱动。
 *
 * 回答三个问题（都是用户原话）：
 *   1.「拖拽动作没有」   → 合成真实鼠标序列拖她，看 Drag 动作有没有播；
 *   2.「溜达动作没有」   → 等主进程发 pet:wander-start，看 Walk 有没有播、
 *                          而且必须是**走走停停**（多趟，不是挪一下就完）；
 *   3.「操作了回到初始位置」→ 看主进程模拟"人回来了"之后，她有没有走回
 *                          启动时的坐标。
 *
 * 判据都是**像素 / 事件计数**，不靠肉眼：
 *   · saveShot() 会把窗口画面的 ink 包围盒回传（人在窗口里占的那块）——
 *     动作在动 → 逐帧变化；回家了 → 与启动时同量级；
 *   · pet:wander-start / pet:wander-end 的**配对**——每趟必须成对。
 *
 * ⚠️ 溜达那一段由主进程的 `PET_WANDER=1` 口子驱动（见 main.js 的注释：
 *    你在电脑前不可能是"闲置"状态，它自然触发不了）。
 * ⚠️ 必须由 debug/pet-driver.html 加载（gen-driver.sh 现场生成），
 *    这样页面就是真页面，preload / IPC 全是真货。
 * ⚠️ 跑的时候给一个独立的 --user-data-dir，别动用户真实的配置。
 *
 * 用法：
 *   ./debug/gen-driver.sh driver-motions.js
 *   unset ELECTRON_RUN_AS_NODE
 *   PET_ENTRY=debug/pet-driver.html PET_SNAPSHOT=motion PET_WANDER=1 \
 *     ./node_modules/electron/dist/electron.exe . \
 *     --user-data-dir=<绝对路径>/debug/.tmp-userdata > debug/run-motions.log 2>&1 &
 *   sleep 90 && taskkill //F //IM electron.exe
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[mo]', ...a);

/* 截图 + 把 ink 包围盒（角色实体在窗口里的范围）打出来。 */
async function shot(tag) {
  try {
    const r = await window.pet.saveShot(tag);
    if (!r || !r.ok) { log(`shot ${tag} FAIL ${r && r.error}`); return null; }
    const ink = r.ink;
    log(`shot ${tag} ink=[${ink[0]},${ink[1]},${ink[2]},${ink[3]}] ` +
        `w=${ink[2] - ink[0]} h=${ink[3] - ink[1]}`);
    return ink;
  } catch (e) {
    log(`shot ${tag} EXCEPTION ${(e && e.message) || e}`);
    return null;
  }
}

/* 两帧 ink 的四边最大位移：动作幅度够不够一眼看出来。
 * 同一个静止姿势连拍两张应该接近 0（只差呼吸那点量级）。 */
function delta(a, b) {
  if (!a || !b) return null;
  return Math.max(...[0, 1, 2, 3].map((i) => Math.abs(a[i] - b[i])));
}

function fire(type, target, opts) {
  target.dispatchEvent(new MouseEvent(type, Object.assign({
    bubbles: true, cancelable: true, view: window
  }, opts)));
}

async function waitCanvas() {
  for (let i = 0; i < 140; i++) {
    const c = document.querySelector('canvas');
    // 注意：这里只能按"存在"判断。真正的 Live2D canvas 尺寸由 layout 决定，
    // 拿默认的 300x150 当"还没准备好"会永远等不到。
    if (c) return c;
    await sleep(500);
  }
  return null;
}

(async () => {
  log('start');

  /* 打扰项先全关：
   *   edgeSnap=false  拖完贴边会再挪一次窗口，混淆"回位到哪儿"的判断
   *   wander=true     溜达要开（PET_WANDER 只是**强制触发**，不代替开关）
   *   monitor.floating=false 状态底座占 147px 宽，会主导 ink 包围盒（规矩 23） */
  await window.pet.setConfig({
    motion: { wander: true, edgeSnap: false, returnOnActivity: true },
    monitor: { floating: false }
  });

  const c = await waitCanvas();
  if (!c) { log('FATAL 没有 canvas，模型没挂上'); return; }
  log('canvas found');
  await sleep(5000);                      // 让模型挂上、idle 跑起来、姿态稳定

  const base = await shot('mo-idle');
  const base2 = await shot('mo-idle2');
  log(`基准抖动 delta(idle,idle2)=${delta(base, base2)}（越小越好，说明测量本身稳）`);

  /* 先挂上溜达事件的监听 —— 必须在 PET_WANDER 的 t=12s 之前注册好。 */
  const seen = { start: 0, end: 0, noticed: 0 };
  window.pet.on('pet:wander-start', () => {
    seen.start++;
    log(`wander-start #${seen.start}`);
    if (seen.start <= 3) {
      (async () => {
        for (let i = 1; i <= 3; i++) { await sleep(220); await shot(`mo-walk${seen.start}-${i}`); }
      })();
    }
  });
  window.pet.on('pet:wander-end', () => { seen.end++; log(`wander-end #${seen.end}`); });
  window.pet.on('pet:noticed', () => { seen.noticed++; log('noticed（她发现你回来了，要回家了）'); });

  /* ════════ 1. 拖拽 → Drag 动作 ════════ */
  const r = c.getBoundingClientRect();
  const x0 = Math.round(Math.max(40, r.width) / 2);
  const y0 = Math.round(Math.max(40, r.height) * 0.45);
  let sx = 700, sy = 420;                 // 合成屏幕坐标，只用来算 dragMove 增量

  fire('mousemove', window, { clientX: x0, clientY: y0, screenX: sx, screenY: sy });
  fire('mousedown', c, { button: 0, clientX: x0, clientY: y0, screenX: sx, screenY: sy });
  log('mousedown（合成）');

  // 走 8 步共 72px 横向（阈值 24px，第 3~4 步就该触发 Drag）
  for (let i = 1; i <= 8; i++) {
    await sleep(70);
    fire('mousemove', window, {
      clientX: x0 + i * 9, clientY: y0 + i * 2,
      screenX: sx + i * 9, screenY: sy + i * 2
    });
  }
  log('拖了 72px，开始连拍');
  const d1 = await shot('mo-drag-1');
  await sleep(280);
  const d2 = await shot('mo-drag-2');
  await sleep(280);
  const d3 = await shot('mo-drag-3');
  log(`拖拽期间位移 delta(d1,d2)=${delta(d1, d2)} delta(d2,d3)=${delta(d2, d3)}`);

  fire('mouseup', window, {
    clientX: x0 + 72, clientY: y0 + 16, screenX: sx + 72, screenY: sy + 16
  });
  log('mouseup（合成）');
  await sleep(250);
  await shot('mo-relax-1');
  await sleep(1400);
  const relax = await shot('mo-relax-2');
  log(`松手后 delta(relax2,idle)=${delta(relax, base)}（该回到基准量级）`);

  /* ════════ 2 + 3. 等主进程的 PET_WANDER 口子推完整轮 ════════
   * t=15s 强制开始溜达，t=40s 模拟"人回来了"。
   * 判据按**事件**等，不按绝对时间 —— 开机快慢、拍图耗时都不影响结论。 */
  const cap = Date.now() + 60000;
  while (Date.now() < cap) {
    if (seen.noticed >= 1 && seen.end >= 2) break;
    await sleep(500);
  }
  await sleep(5000);                      // 给回位那一段动画留时间

  const fin = await shot('mo-final');
  log(`最终 delta(final,idle)=${delta(fin, base)}`);
  log(`RESULT wander-start=${seen.start} wander-end=${seen.end} noticed=${seen.noticed}`);
  log('done');
})().catch((e) => log('EXCEPTION ' + ((e && e.stack) || e)));
