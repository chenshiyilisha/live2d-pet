'use strict';

/* 抓「某个窗口的合成结果」（desktopCapturer，不是 capturePage）。
 *
 * 为什么需要它：透明窗 + preserveDrawingBuffer 的残留**只存在于窗口合成面**上，
 * capturePage 拿的是页面重绘的新内容，看不见残留。所以要判断「两个她」还在不在，
 * 只能抓 DWM 合成后的窗口画面。
 *
 * 用法：node_modules/electron/dist/electron.exe debug/cap-window.js <输出名> [标题正则]
 */
const { app, desktopCapturer, screen } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('no-sandbox');

const out = process.argv[2] || 'cap.png';
const want = process.argv[3] ? new RegExp(process.argv[3], 'i') : /ayan|pet|桌宠|live2d/i;

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const list = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size });
  const rows = list.map((s) => ({ id: s.id, name: s.name, w: s.thumbnail.getSize().width }));
  console.log('窗口清单', JSON.stringify(rows, null, 1));

  const hit = list.find((s) => want.test(s.name));
  if (!hit) { console.log('没找到匹配窗口，用第一个非空缩略图'); }
  const src = hit || list.find((s) => s.thumbnail.getSize().width > 50);
  if (!src) { console.log('没有可抓的窗口'); app.quit(1); return; }

  const p = path.join(__dirname, out);
  fs.writeFileSync(p, src.thumbnail.toPNG());
  console.log('saved', p, src.name, src.thumbnail.getSize());
  app.quit(0);
});
