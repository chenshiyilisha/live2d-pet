// 临时探针：打印 Electron 视角下的显示器配置（DIP 单位，即窗口坐标真正用的那套）
const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const primary = screen.getPrimaryDisplay();
  const out = {
    cursorScreenPoint: screen.getCursorScreenPoint(),
    primaryId: primary.id,
    displays: screen.getAllDisplays().map((d) => ({
      id: d.id,
      primary: d.id === primary.id,
      scaleFactor: d.scaleFactor,
      bounds: d.bounds,        // DIP
      workArea: d.workArea,    // DIP
      size: d.size,
      rotation: d.rotation,
      internal: !!d.internal,
      label: d.label
    }))
  };
  const p = path.join(__dirname, 'disp-probe.json');
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  console.log('PROBE WRITTEN ' + p);
  app.quit();
});
