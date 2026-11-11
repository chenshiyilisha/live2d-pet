'use strict';

/* W60 遮罩溢出静态分析（deepfish）
 *
 * 背景：deepfish（大肥鱼 / DeepSeek 鲸鱼娘皮）的 cdi3.json 是 VTS 包格式，
 * 遮罩信息不在 cdi3 的 Parts 里（Parts 是模型部件，不是遮罩），遮罩数由
 * moc3 二进制 + 渲染时 Cubism SDK 的 _clippingManager 在运行时读出。
 * SDK 的单 render texture 上限是 36，deepfish 实测 49 个遮罩 → 触发
 * `not supported mask count : 13`（13 = 49 - 36），SDK 进入
 * setupLayoutBounds 的错误分支把所有遮罩塌成一块整幅缓冲。
 *
 * 本脚本做的是**静态分析**（不需要 deepfish 上线）：
 *   1. 检查 cdi3.json 结构，确认遮罩不在 cdi3 里（VTS 包特征）
 *   2. 统计 Parts 数量（不是遮罩数，但可作参考）
 *   3. 确认素材在场（缺素材则 SKIP 而非 FAIL）
 *   4. 检查 expressions/ 目录，统计表情数量（观测任务需要切的表情数）
 *   5. 断言 deepfish 档案 retired 状态（记录当前是否可观测）
 *
 * 真机观测（切 20+ 表情逐个看有没有破面）需要 deepfish 上线，
 * 用 observe-masks.js 跑。
 *
 * 跑法：node debug/verify-w60.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const MODEL_DIR = path.join(SRC, 'assets', 'models', 'deepfish');

let fails = 0;
let passes = 0;
const ok = (cond, msg) => {
  if (cond) { console.log('  PASS', msg); passes++; return; }
  console.log('  FAIL', msg);
  fails++;
};
const skip = (msg) => console.log('  SKIP', msg);

console.log('\n[W60] 遮罩溢出静态分析（deepfish）');

const hasAssets = fs.existsSync(path.join(MODEL_DIR, '大肥鱼.cdi3.json'));

if (!hasAssets) {
  skip('缺 deepfish 素材（src/assets/models/deepfish/），本节全 SKIP');
} else {
  /* ---- [A] cdi3 结构：遮罩不在 cdi3 里 ---- */
  console.log('\n[A] cdi3.json 结构（VTS 包特征：无 Drawables 段）');

  const cdi = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, '大肥鱼.cdi3.json'), 'utf8'));
  const topKeys = Object.keys(cdi);
  ok(!topKeys.includes('Drawables'),
    `cdi3 顶层无 Drawables 段（遮罩不在这里；实测 keys: ${topKeys.join(',')})`);
  ok(topKeys.includes('Parts'), 'cdi3 有 Parts 段（VTS 包特征）');

  /* ---- [B] Parts 数量（参考用，不是遮罩数）---- */
  console.log('\n[B] Parts 数量（参考用，非遮罩数）');

  const partCount = (cdi.Parts || []).length;
  console.log(`       Parts: ${partCount} 个`);
  ok(partCount > 0, `Parts 非空（${partCount} 个）`);

  /* ---- [C] 遮罩数由 moc3 + SDK 运行时决定，静态查不出 ---- */
  console.log('\n[C] 遮罩数由 moc3 二进制 + SDK 运行时决定');

  const mocPath = path.join(MODEL_DIR, '大肥鱼.moc3');
  ok(fs.existsSync(mocPath), '大肥鱼.moc3 在场');
  /* moc3 是二进制，遮罩数由 Cubism SDK 的 _clippingManager 在渲染时读出。
   * SDK 单 render texture 上限 36，deepfish 实测 49 → 触发
   * `not supported mask count : 13`（49 - 36 = 13）。
   * 这个 13 来自真机 SDK 日志，不是静态算出来的。 */
  skip('遮罩数需真机 SDK 日志确认（静态分析查不到 moc3 内部结构）');

  /* ---- [D] expressions/ 目录（观测任务需要切的表情）---- */
  console.log('\n[D] expressions/ 目录（观测任务的表情集）');

  const expDir = path.join(MODEL_DIR, 'expressions');
  if (!fs.existsSync(expDir)) {
    skip('缺 expressions/ 目录');
  } else {
    const expFiles = fs.readdirSync(expDir).filter((f) => f.endsWith('.exp3.json'));
    console.log(`       expressions: ${expFiles.length} 个 exp3 文件`);
    ok(expFiles.length >= 20, `expressions ≥ 20 个（观测任务需要切的表情数：${expFiles.length}）`);
  }

  /* ---- [E] deepfish 档案 retired 状态 ---- */
  console.log('\n[E] deepfish 档案 retired 状态（决定能否观测）');

  const profileSrc = fs.readFileSync(path.join(SRC, 'renderer', 'profiles', 'deepfish.js'), 'utf8')
    .replace(/\r\n/g, '\n');
  const retiredMatch = profileSrc.match(/retired:\s*(true|false)/);
  if (retiredMatch) {
    const retired = retiredMatch[1] === 'true';
    console.log(`       retired: ${retiredMatch[1]}`);
    if (retired) {
      ok(true, 'deepfish 当前 retired: true（不在菜单上，真机观测无法进行）');
      console.log('       ⚠️ W60 真机观测（observe-masks.js）需等 deepfish 上线后跑');
    } else {
      ok(true, 'deepfish 当前 retired: false（在菜单上，可跑 observe-masks.js 观测）');
    }
  } else {
    ok(false, 'deepfish 档案里找不到 retired 字段');
  }
}

/* ---- [F] 素材合规 ---- */
console.log('\n[F] 素材合规');

const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
ok(/src\/assets\/models\//.test(gi), '.gitignore 排除 src/assets/models/（deepfish 素材不进仓库）');

console.log(fails === 0 ? `\n${passes} 项通过` : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
