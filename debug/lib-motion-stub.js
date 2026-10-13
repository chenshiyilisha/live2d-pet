'use strict';
/* motion.js 的单测夹具：把 electron 换成桩、给一个假窗口，然后把 motion.js
 * require 进来，让"走走停停 / 回位 / 用户打断"这些**时序逻辑**能在毫秒级
 * 的地盘上被确定性地跑一遍（不用起 Electron、不用等真屏幕）。
 *
 * 为什么抽成单独一个文件：verify-guards.js 和 verify-wander.js 都要用它，
 * 而这里每一行都对应一个踩过的坑，复制两份迟早漂。
 *
 * 用法：
 *   const { makeMotionEnv } = require('./lib-motion-stub');
 *   const env = makeMotionEnv({ cfg: {...}, workArea: {...} });
 *   env.motion.startWander();
 *   env.state.sent            // 渲染层收到的事件名数组
 *   env.state.bounds          // 窗口当前坐标
 *   env.writeConfig({...})    // 中途改配置（loadConfig 每次都读盘，所以立刻生效）
 *
 * ⚠️ Module.prototype.require 的补丁是**全局**的，而且必须在
 *    require('src/main/motion.js') 之前打上；所以一个进程只能建一个 env。
 *    两个测试脚本各自是独立进程，正好。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const MOTION = path.join(ROOT, 'src/main/motion.js');

const DEFAULT_CFG = {
  motion: {
    enabled: true,
    edgeSnap: true,
    wander: true,
    wanderIdleMin: 0.2,      // 12 秒就能触发，测试不用等 3 分钟
    returnOnActivity: true
  }
};

function makeMotionEnv(opts = {}) {
  const workArea = opts.workArea || { x: 0, y: 0, width: 1600, height: 1000 };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-motion-'));
  const cfgPath = path.join(tmp, 'config.json');

  const state = {
    bounds: { x: 100, y: 100, width: 320, height: 360 },
    setBoundsCalls: 0,
    sent: [],                 // 渲染层收到的通道名，按顺序
    visible: true,
    idleSec: 9999,            // 系统闲置秒数：默认"早就没人动了"
    cursor: { x: -9999, y: -9999 }   // 光标离得远远的
  };

  const writeConfig = (cfg) => fs.writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');
  writeConfig(opts.cfg || DEFAULT_CFG);

  const fakeWin = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    getBounds: () => ({ ...state.bounds }),
    setBounds: (b) => { state.bounds = { ...b }; state.setBoundsCalls++; },
    webContents: { send: (ch) => state.sent.push(ch) }
  };

  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'electron') {
      return {
        app: { getPath: () => tmp, getVersion: () => '0.0.0-test' },
        screen: {
          getCursorScreenPoint: () => ({ ...state.cursor }),
          getDisplayMatching: () => ({ workArea }),
          getPrimaryDisplay: () => ({ workArea }),
          getAllDisplays: () => [{ workArea }],
          on: () => {}
        },
        powerMonitor: { getSystemIdleTime: () => state.idleSec }
      };
    }
    return origRequire.apply(this, arguments);
  };

  delete require.cache[MOTION];
  const motion = require(MOTION);
  Module.prototype.require = origRequire;
  motion.configureMotion(() => fakeWin);

  return {
    motion,
    state,
    cfgPath,
    writeConfig,
    /** 渲染层收到的某类事件出现过几次 */
    countOf: (ch) => state.sent.filter((c) => c === ch).length,
    /** 清空事件记录 */
    clear: () => { state.sent.length = 0; },
    /** 从当前时刻开始统计 setBounds 次数 */
    resetBoundsCount: () => { state.setBoundsCalls = 0; }
  };
}

module.exports = { makeMotionEnv, ROOT, DEFAULT_CFG };
