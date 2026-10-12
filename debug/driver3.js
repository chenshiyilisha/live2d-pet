/* 驱动脚本 #3：让主进程真的把「点角色」右键菜单弹出来，验证整理后的模板能构建。
 * 原生菜单抓不到像素（capturePage 拍不到），所以只验证「弹出来没报错」。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const log = (...a) => console.log('[drv3]', ...a);
  log('start');
  await sleep(9000);

  log('popup #1');
  window.pet?.contextMenu?.();
  await sleep(2500);

  log('popup #2');
  window.pet?.contextMenu?.();
  await sleep(2000);

  log('done');
})().catch((e) => console.log('[drv3] EXCEPTION ' + ((e && e.stack) || e)));
