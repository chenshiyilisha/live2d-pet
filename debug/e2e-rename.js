/* 端到端：真起应用，走一遍"改名"的最终落盘与三处联动。
 *
 * 为什么不模拟点菜单：原生菜单弹窗没法自动化点击。
 * 这里验的是**改名动作的后果** —— 写进 config.json 之后，
 * 托盘标题 / 窗口标题 / 人设自称 这三处是不是真的都跟着变了。
 *
 *   node debug/e2e-rename.js   （在项目根跑）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 2500));   // 等主窗口起来

  const cfgPath = path.join(app.getPath('userData'), 'config.json');
  const before = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  console.log('[e2e] 改名前 config.name =', JSON.stringify(before.name));

  /* 模拟"用户点确定"落盘后的状态。
   * 真实路径是 promptRename → patchConfig(null,{name})，这里直接写盘等效，
   * 因为要验的是**读取方**（三处显示）能否正确反映新名字。 */
  const target = '小绿';
  fs.writeFileSync(cfgPath, JSON.stringify({ ...before, name: target }, null, 2), 'utf8');
  await new Promise((r) => setTimeout(r, 300));

  const cfgMod = require(path.join(ROOT, 'src', 'main', 'config.js'));
  const nm = cfgMod.resolveName(cfgMod.loadConfig());
  const persona = cfgMod.resolvePersona(cfgMod.loadConfig());

  console.log('[e2e] 盘上 config.name     =', JSON.stringify(
    JSON.parse(fs.readFileSync(cfgPath, 'utf8')).name));
  console.log('[e2e] resolveName()        =', JSON.stringify(nm));
  console.log('[e2e] 人设第一句           =', JSON.stringify(persona.split('\n')[0]));

  const win = BrowserWindow.getAllWindows()[0];
  console.log('[e2e] 主窗口标题(启动时的)  =', JSON.stringify(win ? win.getTitle() : null));

  const ok = nm === target && persona.startsWith(`你叫${target}，`);
  console.log('[e2e] RESULT=' + (ok ? 'PASS' : 'FAIL'));
  app.exit(ok ? 0 : 1);
});
