/* 运行时切换测试的驱动脚本。
 *
 * ⚠️ 必须跑在**真正的桌宠页面**里（debug/pet-driver.html 由 index.html 现场生成）。
 * 之前用 iframe 装真页面、父页面拨开关，是**错的** ——
 * mainWindow.webContents.send 只投递给主 frame，iframe 收不到 appearance:changed，
 * 表现就是「配置改了、models.haru 也写进盘了，但画面还是 hiyori」，很能骗人。
 *
 * 这里走的完整链路：setConfig → config:set → syncAppearance →
 *   appearance:changed → onAppearance → mountModel。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const log = (...a) => console.log('[drv]', ...a);
  log('start');
  await sleep(9000);
  await window.pet.saveShot('d-hiyori');
  log('shot hiyori');

  /* 大小实时调节：改 appearance.scale 不该重载模型，只重算缩放。
   * 截 150% / 80% 两张，用像素包围盒量出来对比（见 png2.js）。 */
  for (const sc of [1.5, 0.8]) {
    await window.pet.setConfig({ appearance: { scale: sc } });
    log('set scale=' + sc);
    await sleep(3000);
    await window.pet.saveShot('d-scale-' + String(sc).replace('.', '_'));
    log('shot scale=' + sc);
  }
  await window.pet.setConfig({ appearance: { scale: 1 } });
  await sleep(2500);
  log('scale restored');

  await window.pet.setConfig({ appearance: { model: 'haru' } });
  log('set model=haru');
  await sleep(9500);
  await window.pet.saveShot('d-haru');
  log('shot haru');

  await window.pet.setConfig({ appearance: { model: 'hiyori' } });
  log('set model=hiyori');
  await sleep(9500);
  await window.pet.saveShot('d-back');
  log('shot back');
  log('done');
})().catch((e) => console.log('[drv] EXCEPTION ' + ((e && e.stack) || e)));
