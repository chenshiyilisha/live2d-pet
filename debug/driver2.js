/* 互动行为（边缘吸附 / 自主漫步）的驱动脚本 —— 这两个都在主进程里，
 * 只有把真实页面跑起来、从渲染层发 IPC 才能测。
 * 跑在 debug/pet-driver.html（gen-driver.sh 现场生成）里。
 *
 * 用完必须把配置还原：window 位置和 motion.wanderIdleMin 都会被改动影响。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pet = window.pet;
  const log = (...a) => console.log('[drv2]', ...a);
  const ev = [];
  for (const ch of ['pet:snapped', 'pet:noticed', 'pet:wander-start', 'pet:wander-end']) {
    pet.on(ch, (d) => { ev.push(ch); log('event ' + ch + ' ' + JSON.stringify(d ?? null)); });
  }
  // 关掉「光标在附近就不溜达」这条路：测的是调度有没有跑起来，两条路都算过
  const hit = (n) => ev.filter((e) => e === n).length;

  await sleep(7000);
  log('page up');

  /* ---- 1) 边缘吸附 ----
   * 默认落位就在右下角、距右/下边各 24px（< SNAP_DIST 56），
   * 所以一次 dragEnd 就应该贴到右边并回报 pet:snapped。 */
  pet.dragEnd();
  await sleep(1200);
  log('snap events=' + hit('pet:snapped'));

  /* ---- 2) 自主漫步 ----
   * wanderIdleMin 会被 clamp 到最小 0.2 分钟 = 12 秒。 */
  await pet.setConfig({ motion: { enabled: true, wander: true, wanderIdleMin: 0.2 } });
  log('wander timer armed (12s)');
  await sleep(15000);
  log('wander-start=' + hit('pet:wander-start') +
      ' wander-end=' + hit('pet:wander-end') +
      ' noticed=' + hit('pet:noticed'));

  /* ---- 3) 关掉开关就该彻底不动 ---- */
  const before = ev.length;
  await pet.setConfig({ motion: { enabled: true, wander: true, wanderIdleMin: 0.2, edgeSnap: false } });
  await pet.setConfig({ motion: { wander: false } });
  pet.setIgnoreMouse?.(false);
  await sleep(300);
  pet.dragEnd();                       // edgeSnap 已关 → 不该有 pet:snapped
  await sleep(14000);                  // 漫步已关 → 不该有 wander/noticed
  log('disabled-check new-events=' + (ev.length - before));

  // 还原
  await pet.setConfig({ motion: { enabled: true, edgeSnap: true, wander: true, wanderIdleMin: 3 } });
  log('config restored');
  log('done');
})().catch((e) => console.log('[drv2] EXCEPTION ' + ((e && e.stack) || e)));
