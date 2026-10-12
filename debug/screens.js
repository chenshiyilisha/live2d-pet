/* 一次性诊断：打印本机显示器数量与工作区。
 * 用途：判断「多显示器」相关 bug（edgeSnap / wander 只用主屏）当前是否会真的触发。
 * 跑法： ./node_modules/electron/dist/electron.exe debug/screens.js
 *   （记得先 unset ELECTRON_RUN_AS_NODE，否则 electron.exe 退化成 node） */
const { app, screen } = require('electron');

app.whenReady().then(() => {
  const all = screen.getAllDisplays();
  console.log('SCREEN_COUNT=' + all.length);
  const p = screen.getPrimaryDisplay();
  console.log('PRIMARY bounds=' + JSON.stringify(p.bounds) + ' workArea=' + JSON.stringify(p.workArea) + ' scale=' + p.scaleFactor);
  for (const d of all) {
    console.log('DISPLAY id=' + d.id + ' primary=' + (d.id === p.id) +
      ' bounds=' + JSON.stringify(d.bounds) +
      ' workArea=' + JSON.stringify(d.workArea) +
      ' scale=' + d.scaleFactor + ' rotation=' + d.rotation);
  }
  app.quit();
});
