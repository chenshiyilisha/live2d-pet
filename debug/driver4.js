/* 本轮审计修复的针对性验证。覆盖三条**用户能感知到**的路径：
 *
 *   1) 悬停命中测试的 rAF 节流 —— 高频 mousemove 不该每次都同步读像素
 *   2) 录音状态机 —— 快速点一下麦克风，不能留下一个开着不放的录音
 *   3) 拖拽取消平滑移动 —— 溜达途中抓她，窗口不能在松手后还自己往前跑
 *
 * 跑法：bash debug/gen-driver.sh driver4.js
 *       PET_ENTRY=debug/pet-driver.html electron .
 *
 * ⚠️ 会临时改配置（asr.enabled=true、wanderIdleMin=0.2）并移动窗口；
 *    脚本末尾自动还原这两项。window 键的残留要另外清（见项目记忆）。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pet = window.pet;
  const log = (...a) => console.log('[drv4]', ...a);
  const ok = (name, pass, extra = '') =>
    log((pass ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));

  await sleep(9000);                      // 等模型挂载 + 首次 layout
  log('page up');

  /* ================= 1) 命中测试 rAF 节流 ================= */
  let reads = 0;
  const patched = [];
  for (const P of [window.WebGL2RenderingContext?.prototype,
                   window.WebGLRenderingContext?.prototype]) {
    if (!P || !P.readPixels) continue;
    const orig = P.readPixels;
    P.readPixels = function (...a) { reads += 1; return orig.apply(this, a); };
    patched.push([P, orig]);
  }

  // 分 30 帧派发 300 次移动：每次坐标都跨 >2px（绕开 hitCache 的 2px 窗口），
  // 且落在角色矩形内（否则矩形快检就先返回了，根本不会读像素）。
  // 节流生效 → 每帧最多 1 次 readPixels ≈ 30；未节流 → ≈ 300。
  const N = 300;
  for (let f = 0; f < 30; f++) {
    for (let k = 0; k < 10; k++) {
      const i = f * 10 + k;
      window.dispatchEvent(new MouseEvent('mousemove', {
        clientX: 130 + (i * 7) % 110,
        clientY: 120 + (i * 13) % 180,
        bubbles: true
      }));
    }
    await sleep(16);
  }
  await sleep(500);
  for (const [P, orig] of patched) P.readPixels = orig;

  ok('mousemove 命中测试被节流', reads > 0 && reads < N / 4,
     `${N} 次移动 → ${reads} 次 readPixels`);

  /* ================= 2) 录音状态机 ================= */
  await pet.setConfig({ asr: { enabled: true } });
  await sleep(400);

  const mic = document.getElementById('mic');
  const down = () => mic.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  const up = () => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  // (a) 快速点按：流还在路上就松手了 —— 正是原来「麦克风停不下来」的场景。
  //     用假的流对象，让它止步于 releaseRecording()，不会走到 AudioContext。
  let stopped = 0;
  let gotStream = 0;
  navigator.mediaDevices.getUserMedia = async () => {
    await sleep(400);
    gotStream += 1;
    return { getTracks: () => [{ stop: () => { stopped += 1; } }] };
  };
  down();
  await sleep(40);
  up();
  await sleep(900);
  ok('快速点按不留残留录音',
     gotStream === 1 && stopped === 1 && !mic.classList.contains('recording'),
     `拿到流=${gotStream} 已关闭=${stopped} 仍标录音=${mic.classList.contains('recording')}`);

  // (b) 正常按住：流建立 → 进入录音态 → 松手能停。
  //     必须给一个**真的有音轨**的流：createMediaStreamSource 对空 MediaStream
  //     会直接抛 InvalidStateError（上一轮就是这么把这个用例测挂的）。
  navigator.mediaDevices.getUserMedia = async () => {
    await sleep(50);
    gotStream += 1;
    const ac = new AudioContext();
    const dst = ac.createMediaStreamDestination();
    const osc = ac.createOscillator();
    osc.connect(dst);
    osc.start();
    return dst.stream;
  };
  down();
  await sleep(220);                       // 停在「太短了」的短路分支，不触发真识别
  const during = mic.classList.contains('recording');
  up();
  await sleep(1200);
  ok('正常按住能正常停下', during && !mic.classList.contains('recording'),
     `录音中=${during} 松手后=${mic.classList.contains('recording')}`);

  navigator.mediaDevices.getUserMedia = realGUM;
  await pet.setConfig({ asr: { enabled: false } });

  /* ================= 3) 溜达途中拖拽 ================= */
  let wanderStart = 0;
  pet.on('pet:wander-start', () => { if (!wanderStart) wanderStart = Date.now(); });
  await pet.setConfig({ motion: { enabled: true, wander: true, edgeSnap: true, wanderIdleMin: 0.2 } });

  const t0 = Date.now();
  while (!wanderStart && Date.now() - t0 < 26000) await sleep(250);
  ok('溜达被触发（拖拽测试的前提）', !!wanderStart,
     wanderStart ? `${((wanderStart - t0) / 1000).toFixed(1)}s 后开始` : '26s 超时（可能光标恰好在窗口附近）');

  if (wanderStart) {
    log('screen', `${window.screen.width}x${window.screen.height} avail=${window.screen.availWidth}x${window.screen.availHeight} win=${window.innerWidth}x${window.innerHeight}`);

    await sleep(150);                     // 动作刚起步，此刻 animateTo 正在跑
    pet.dragMove(-40, 0);                 // 朝内侧拖，别把窗口推出屏幕
    await sleep(30);
    pet.dragMove(-40, 0);
    await sleep(30);

    /* 关键采样：拖动之后 400ms 内窗口应当**一动都不动**。
     * animateTo 是 24ms 的 setInterval，没被掐掉的话 400ms 里会写十几次位置，
     * 坐标必然变化。采样窗故意压在 wander-start+210ms ~ +610ms，
     * 避开 doWander 里那个 1250ms 才触发的 edgeSnap（它会正当地再动一次）。 */
    const a = { x: window.screenX, y: window.screenY };
    await sleep(400);
    const b = { x: window.screenX, y: window.screenY };
    ok('拖拽后窗口停住（移动动画已取消）', a.x === b.x && a.y === b.y,
       `(${a.x},${a.y}) → (${b.x},${b.y})`);
  }

  /* ---- 还原配置 ---- */
  await pet.setConfig({ motion: { enabled: true, wander: true, edgeSnap: true, wanderIdleMin: 3 } });
  log('config restored');
  log('done');
})().catch((e) => console.log('[drv4] EXCEPTION ' + ((e && e.stack) || e)));
