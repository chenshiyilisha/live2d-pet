import { ttsVoiceInfo } from './tts.js';

/* ?snap= 诊断探针。
 *
 * 只在启动 URL 带 snap 查询参数时由 pet.js 动态加载。正式启动不进这个文件，
 * 这样改探针不会碰到挂模型 / 主循环，改主循环也不会把某一路探针带崩。
 *
 * live 里凡是会变的状态都是 getter（app / model / petRect / cfg …），
 * 不能在挂上的那一刻抄一份快照。
 */

export function attachSnapProbes(live) {
  if (!new URLSearchParams(location.search).has('snap')) return;

  // 诊断：观察动作调度状态 + 帧率，验证插件自带的 idle 自动播放是否接管，
  // 以及动作文件是否真的全部预加载了。
  if (new URLSearchParams(location.search).has('snap')) {
    let frames = 0, worst = 0, jank = 0, acc = 0, t0 = performance.now();
    live.app().ticker.add((tk) => {
      const dt = tk.deltaMS;
      frames++; acc += dt;
      if (dt > worst) worst = dt;
      if (dt > 34) jank++;
    });
    setInterval(() => {
      const now = performance.now();
      const sec = (now - t0) / 1000;
      const mgr = live.model()?.internalModel?.motionManager;
      const groups = {};
      for (const [k, v] of Object.entries(mgr?.motionGroups || {})) {
        groups[k] = `${v.filter(Boolean).length}/${(mgr.definitions[k] || []).length}`;
      }
      console.log('[pet] motion-stat', JSON.stringify({
        sec: Math.round(sec * 10) / 10,
        fps: Math.round(frames / Math.max(sec, 0.001)),
        avgMs: Math.round((acc / Math.max(frames, 1)) * 10) / 10,
        worstMs: Math.round(worst * 10) / 10,
        jank,
        group: mgr?.state?.currentGroup ?? null,
        playing: !!mgr?.playing,
        loaded: groups
      }));
      frames = 0; acc = 0; worst = 0; jank = 0; t0 = now;
    }, 3000);
  }

  /* 诊断：动作跳变检测（?snap=motion）
   *
   * 用来客观判断「动作卡一下」有没有真的修好：每帧采一批关键参数，
   * 算一帧内的最大变化量。平滑的动作每帧变化通常 < 0.5 度，而
   * 循环回绕 / 硬切会产生几度到几十度的单帧跳变。
   * 同时把动作切换（currentGroup/currentIndex 变化）也打出来，
   * 这样能分清「跳变」和「正常换动作」。
   */
  if (new URLSearchParams(location.search).get('snap') === 'motion') {
    const WATCH = [
      'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
      'ParamBodyAngleX', 'ParamBodyAngleZ',
      'ParamArmLA', 'ParamArmRA', 'ParamHairAhoge'
    ];
    let prev = null, lastKey = null, t0 = performance.now();
    const stamp = () => Math.round((performance.now() - t0) / 100) / 10;
    live.app().ticker.add(() => {
      const cur = {};
      for (const id of WATCH) cur[id] = live.readParam(id) ?? 0;

      if (prev) {
        let worstId = null, worst = 0;
        for (const id of WATCH) {
          const d = Math.abs(cur[id] - prev[id]);
          if (d > worst) { worst = d; worstId = id; }
        }
        if (worst > 1.5) {
          const mgr = live.model()?.internalModel?.motionManager;
          console.log('[pet] motion-jump', JSON.stringify({
            t: stamp(), id: worstId,
            from: Math.round(prev[worstId] * 100) / 100,
            to: Math.round(cur[worstId] * 100) / 100,
            delta: Math.round(worst * 100) / 100,
            group: mgr?.state?.currentGroup ?? null,
            index: mgr?.state?.currentIndex ?? null
          }));
        }
      }
      prev = cur;

      const st = live.model()?.internalModel?.motionManager?.state;
      const key = `${st?.currentGroup ?? '-'}#${st?.currentIndex ?? '-'}`;
      if (key !== lastKey) {
        console.log('[pet] motion-switch', JSON.stringify({
          t: stamp(), from: lastKey, to: key
        }));
        lastKey = key;
      }
    });
  }

  /* 诊断：动作接缝（?snap=seam）
   *
   * 每 0.5s 输出一个窗口的统计，跑 40 秒。一次回答两个问题：
   *
   *  1) 「动作之前卡一下」—— 每帧对**全部动作驱动的参数**算单帧最大变化量 dmax。
   *     正常播放时总有参数在动（dmax > 0.05）；sti 是 dmax < 0.01 的帧数，
   *     一个窗口里 sti 接近 win 就说明整段冻住了。
   *     更硬的指标是 tAdv：当前 motion 的播放时间戳（_stateTimeSeconds）在
   *     这个窗口里推进了多少秒。正常就等于窗口长度（0.5）；等于 0 就是动作停了。
   *     emp 是队列长度为 0 的帧数（那一刻没有任何 motion 在写参数）。
   *
   *  2) 「举手放下之间的残影」—— PartArmA / PartArmB 是两套手臂绘制的部件
   *     不透明度。ovl 统计两者同时 > 0.05 的帧数，也就是屏幕上两条手臂
   *     叠在一起的帧数。修好之后这个数应该只剩个位数（切换那一瞬间）。
   *
   * ⚠️ 两个坑（第一版诊断全踩了）：
   *   - 部件不透明度必须用 getPartOpacityByIndex()，那是**另一个数组**；
   *     用 getParameterValueByIndex(partIndex) 读到的是参数，数据毫无意义。
   *   - 观察参数不能挑「本来就常数的」那几个（ParamArmLA 之类在多数动作里
   *     是平的），否则 sti 恒满窗，看起来像卡顿其实只是曲线平台期。
   *     所以要遍历全部参数，并且把不是动作驱动的（呼吸 / 视线聚焦覆盖的
   *     头部角度）剔掉，否则 ParamBreath 每帧的小幅摆动会把 dmax 垫高。
   */
  if (new URLSearchParams(location.search).get('snap') === 'seam') {
    const core = live.model().internalModel.coreModel;
    const mm = live.model().internalModel.motionManager;

    // 不是动作驱动的参数：呼吸自己会动，聚焦每帧覆盖头/身角度
    const SKIP = new Set([
      'ParamBreath', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
      'ParamBodyAngleX', 'ParamEyeballX', 'ParamEyeballY'
    ]);
    const N = core.getParameterCount();
    const NAME = [];
    const IDX = [];
    for (let i = 0; i < N; i++) {
      const s = core.getParameterId(i)?.getString?.()?.s ?? '';
      NAME[i] = s;
      if (s && !SKIP.has(s)) IDX.push(i);
    }

    /* ⚠️ 绝对不要用 core.getPartIndex('PartArmA') 这种写法：
     *   CubismModel 内部的 _partIds 存的是 **CubismId 对象**（构造时
     *   getIdManager().getId(...) 包了一层），而 getPartIndex 是拿传进来的值
     *   直接做 `==` 比较。传字符串永远不等于对象；更坑的是**匹配失败时它不
     *   返回 -1，而是凭空造一个「不存在的部件」索引返回（= partCount + n）**,
     *   用它去读 opacity 恒为 0，还会越过 CSM_ASSERT 的边界。
     *   第一版诊断就是这么被它骗了整整一轮。老老实实自己按名字遍历。
     *
     *   （同理 getParameterIndex 也是这套逻辑。pose 内部能用，是因为它传的
     *    本身就是 CubismId 对象 —— getIdManager 是字符串驻留的，同串同对象。） */
    const idxOfPart = (name) => {
      try {
        for (let i = 0; i < core.getPartCount(); i++) {
          const s = core.getPartId(i)?.getString?.()?.s ?? '';
          if (s === name) return i;
        }
      } catch { /* ignore */ }
      return -1;
    };
    const idxOfParam = (name) => {
      try {
        for (let i = 0; i < core.getParameterCount(); i++) {
          const s = core.getParameterId(i)?.getString?.()?.s ?? '';
          if (s === name) return i;
        }
      } catch { /* ignore */ }
      return -1;
    };
    const PA = idxOfPart('PartArmA');
    const PB = idxOfPart('PartArmB');
    const QA = idxOfParam('PartArmA');   // 同名「参数」—— pose 就是靠它判断谁可见
    const QB = idxOfParam('PartArmB');

    const rdP = (i) => {
      try { const v = core.getParameterValueByIndex(i); return Number.isFinite(v) ? v : 0; } catch { return 0; }
    };
    const rdO = (i) => {
      try { const v = core.getPartOpacityByIndex(i); return Number.isFinite(v) ? v : 0; } catch { return 0; }
    };

    console.log('[pet] seam-probe', JSON.stringify({
      params: N, parts: core.getPartCount(), watched: IDX.length,
      PA, PB, QA, QB,                    // PA/PB 部件索引；QA/QB 同名参数索引
      poseFade: live.model().internalModel.pose?._fadeTimeSeconds ?? null
    }));

    let prev = null;
    let win = 0, sti = 0, ovl = 0, emp = 0, sw = 0, dmaxWin = 0, bothP = 0;
    let dmaxWho = '', paSeen = new Set(), pbSeen = new Set();
    let winStart = performance.now(), lastKey = null;
    const t0 = performance.now();

    live.app().ticker.add(() => {
      const vals = IDX.map(rdP);
      let dmax = 0, who = '';
      if (prev) {
        for (let k = 0; k < vals.length; k++) {
          const d = Math.abs(vals[k] - prev[k]);
          if (d > dmax) { dmax = d; who = NAME[IDX[k]] || String(IDX[k]); }
        }
      }
      prev = vals;

      const q = mm?.queueManager?._motions;
      const n = q?.getSize?.() ?? 0;
      const a = PA >= 0 ? rdO(PA) : 0;
      const b = PB >= 0 ? rdO(PB) : 0;
      const pa = QA >= 0 ? rdP(QA) : -1;   // 同名参数（pose 用它判断谁可见）
      const pb = QB >= 0 ? rdP(QB) : -1;

      win++;
      if (dmax < 0.01) sti++;
      if (dmax > dmaxWin) { dmaxWin = dmax; dmaxWho = who; }
      if (a > 0.05 && b > 0.05) ovl++;          // 两套手臂同时可见 = 残影
      if (n === 0) emp++;
      if (pa > 0.05 && pb > 0.05) bothP++;      // 参数层同时 > 0（硬切不该出现）
      if (pa >= 0) paSeen.add(Math.round(pa));
      if (pb >= 0) pbSeen.add(Math.round(pb));

      const key = `${mm?.state?.currentGroup ?? '-'}#${mm?.state?.currentIndex ?? '-'}`;
      if (key !== lastKey) { sw++; lastKey = key; }

      const now = performance.now();
      if (now - winStart >= 500) {
        console.log('[pet] seam', JSON.stringify({
          t: Math.round(winStart - t0) / 1000,
          win, n, act: key, sw, sti, ovl, emp,
          dmax: Math.round(dmaxWin * 100) / 100,
          who: dmaxWho,
          a: Math.round(a * 1000) / 1000,
          b: Math.round(b * 1000) / 1000,
          pa, pb, bothP,
          paSeen: [...paSeen], pbSeen: [...pbSeen]
        }));
        win = 0; sti = 0; ovl = 0; emp = 0; sw = 0; dmaxWin = 0; bothP = 0;
        dmaxWho = ''; paSeen = new Set(); pbSeen = new Set();
        winStart = now;
      }
    });
  }

  /* 诊断：头顶余量（?snap=ink）—— 跑 32 秒，每 250ms 量一次模型实体的像素包围盒。
   *
   * 用途：校准取景公式里那组实测几何（INK_TOP_* / INK_H / INK_W / INK_CX_K）。
   * 做法是用 ?pet=..&pad=.. 把模型压到完整可见，再量墨水的四边。
   *
   * 主进程 pet:save-shot 返回的 ink 是「明显偏离窗口角落基准色」的像素范围
   * （软件合成下透明会失效、背景不是纯白，所以判据是基准色差，见 main.js 实现）。
   * ⚠️ capturePage 在 HiDPI 上返回的是**设备像素**（实测 460×522 = stage 368×418 × 1.25），
   *    跟 CSS px 差一个 devicePixelRatio，换算时别忘（日志里两个都打）。
   * 全程只读，不改任何参数，纯粹量数。 */
  if (new URLSearchParams(location.search).get('snap') === 'ink') {
    let topMin = Infinity;
    let topMax = -Infinity;
    let botMax = -Infinity;
    let leftMin = Infinity;
    let rightMax = -Infinity;
    let samples = 0;
    let fail = 0;
    let worstAt = 0;
    const t0 = performance.now();
    const tick = async () => {
      const sw = await window.pet?.saveShot?.();
      if (sw?.ok && Array.isArray(sw.ink) && sw.ink[1] < 1e9) {
        const [l, top, r, bot] = sw.ink;     // 设备像素
        samples++;
        if (top < topMin) { topMin = top; worstAt = (performance.now() - t0) / 1000; }
        if (top > topMax) topMax = top;
        if (bot > botMax) botMax = bot;
        if (l < leftMin) leftMin = l;
        if (r > rightMax) rightMax = r;
        if (samples % 8 === 0) {
          console.log('[pet] ink', JSON.stringify({
            t: Math.round(performance.now() - t0),
            ink: [l, top, r, bot],            // 设备像素，顺序 [左, 上, 右, 下]
            stage: [live.stageEl.clientWidth, live.stageEl.clientHeight],
            dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
            petRect: [Math.round(live.petRect().x), Math.round(live.petRect().y),
                      Math.round(live.petRect().w), Math.round(live.petRect().h)]
          }));
        }
      } else {
        fail++;
      }
      if (performance.now() - t0 < 32000) setTimeout(tick, 250);
      else {
        console.log('[pet] ink done', JSON.stringify({
          samples, fail,
          topMin, topMax, botMax, leftMin, rightMax,
          nominalTop: Math.round(live.petRect().y),
          stage: [live.stageEl.clientWidth, live.stageEl.clientHeight],
          petRect: [Math.round(live.petRect().x), Math.round(live.petRect().y),
                    Math.round(live.petRect().w), Math.round(live.petRect().h)],
          worstAt: Math.round(worstAt * 10) / 10
        }));
      }
    };
    tick();
  }

  /* 诊断：全局视线跟随（?snap=look）
   *
   * 验证「鼠标移出窗口后目光还跟不跟」。每 250ms 打一条当前 pointer：
   *   - outside 为 true 表示光标在窗口外（mousemove 拿不到，只能靠轮询）
   *   - src=move 是窗口内 mousemove 给的，src=poll 是主进程轮询给的
   * 配合外部移动真实光标，就能看出窗口外的坐标有没有在更新。
   * 纯观测，不截图（截图会占住主进程、干扰轮询节奏）。
   */
  if (new URLSearchParams(location.search).get('snap') === 'look') {
    let n = 0;
    let lastPoll = 0;
    let lastMove = 0;
    let polls = 0;
    let outsideCount = 0;
    const t0 = performance.now();
    window.pet?.onCursor?.(() => {
      polls++;
      lastPoll = Math.round(performance.now() - t0);
    });
    setInterval(() => {
      n++;
      const w = live.stageEl.clientWidth;
      const h = live.stageEl.clientHeight;
      const outside = !!live.pointer() && (live.pointer().x < 0 || live.pointer().y < 0 || live.pointer().x > w || live.pointer().y > h);
      if (outside) outsideCount++;
      // 光标在窗口外时，pointer 只可能来自轮询（mousemove 不触发）
      console.log('[pet] look', JSON.stringify({
        t: Math.round(performance.now() - t0),
        pointer: live.pointer() ? [Math.round(live.pointer().x), Math.round(live.pointer().y)] : null,
        stage: [w, h],
        outside,
        polls,
        lastPoll
      }));
      if (n >= 160) {
        console.log('[pet] look done', JSON.stringify({
          samples: n, polls, outsideCount,
          windowOutFrames: outsideCount
        }));
      }
    }, 250);
  }

  /* 诊断：命中掩码可视化（?snap=hit）
   *
   * 在窗口上打一张 10px 间隔的采样网格，逐行把判定结果打成 ASCII 图，
   * 肉眼就能看出"判定出来的形状"和"她本人"对不对得上。
   *   # 判为命中（alpha >= 阈值）    + 有极淡像素（羽化边缘）    . 完全透明
   * 同时统计「矩形内但判为透明」的比例 —— 那正是以前会被误触发的面积。
   */
  if (new URLSearchParams(location.search).get('snap') === 'hit') {
    setTimeout(() => {
      const W0 = live.stageEl.clientWidth;
      const H0 = live.stageEl.clientHeight;
      const step = 10;
      const cols = Math.floor(W0 / step);
      const rows = Math.floor(H0 / step);
      let inRect = 0;
      let inRectHit = 0;
      let hitTotal = 0;
      let probeFail = 0;
      // 先打标尺，方便对着 ASCII 图定位
      let ruler = '';
      for (let c = 0; c < cols; c++) ruler += (c % 10 === 0) ? String((c / 10) % 10) : ' ';
      console.log(`[pet] hitmap xx ${ruler}`);
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          const x = c * step + step / 2;
          const y = r * step + step / 2;
          const a = live.maxAlphaNear(x, y);
          if (a < 0) probeFail++;
          const hit = a >= live.HIT_ALPHA_MIN;
          const inBox = x >= live.petRect().x && x <= live.petRect().x + live.petRect().w &&
                        y >= live.petRect().y && y <= live.petRect().y + live.petRect().h;
          if (inBox) { inRect++; if (hit) inRectHit++; }
          if (hit) hitTotal++;
          line += hit ? '#' : (a > 0 ? '+' : '.');
        }
        console.log(`[pet] hitmap ${String(r * step).padStart(3, '0')} ${line}`);
      }
      console.log('[pet] hitmap done', JSON.stringify({
        stage: [W0, H0], step, cols, rows, inRect, inRectHit, hitTotal, probeFail,
        rectAccuracy: inRect ? Math.round((inRectHit / inRect) * 1000) / 10 : null,
        petRect: [Math.round(live.petRect().x), Math.round(live.petRect().y),
                  Math.round(live.petRect().w), Math.round(live.petRect().h)]
      }));
    }, 4000);
  }

  /* 诊断：底座（#stats）布局自检（?snap=bar）
   *
   * 为什么要单独验：底座要等第一条 monitor:stats 推送才出现，而那条推送要等
   * 常驻采样器把 powershell 拉起来、跑一次 nvidia-smi（≈1.5s，早年还要等 GPU
   * 两枪求差 ≈9s）。默认的 ?snap=1 截图在 2.6s 就拍了，那时底座可能还没出来，
   * 拍到的是一张"没有底座"的图 —— 看图会误判成"底座没生效"。
   * 这里等到 14s（底座必然已出）再打 DOM 几何 + 拍图。
   *
   * 打的是**实测框**（getBoundingClientRect）与**舞台高**的对照：
   * 舞台高 + --stats-h 应恰好等于窗口内容高，否则预留算错了。 */
  if (new URLSearchParams(location.search).get('snap') === 'bar') {
    setTimeout(async () => {
      const el = document.getElementById('stats');
      const plate = el?.querySelector('.plate');
      const stage = live.stageEl;
      const cs = plate ? getComputedStyle(plate) : null;
      const reserve = getComputedStyle(document.body).getPropertyValue('--stats-h').trim();
      const boxOf = (node) => { const b = node.getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      console.log('[pet] bar', JSON.stringify({
        exists: !!el,
        hidden: el?.classList.contains('hidden'),
        items: [...(el?.querySelectorAll('.item') || [])].map((it) => ({
          cls: it.className,
          level: it.dataset.level || null,
          text: it.textContent,
          box: boxOf(it),
          svg: !!it.querySelector('svg')
        })),
        /* 外层是撑满的定位容器，内层 .plate 才是看得见的牌 —— 两个都打，
         * 才能看出"牌"有没有真的比容器窄。 */
        outerBox: el ? boxOf(el) : null,
        plateBox: plate ? boxOf(plate) : null,
        platePadOnFull: plate && el
          ? Math.round((el.getBoundingClientRect().width - plate.getBoundingClientRect().width) * 10) / 10
          : null,
        barBg: cs?.backgroundImage?.slice(0, 40) || cs?.backgroundColor,
        barRadius: cs?.borderRadius,
        reserve,
        bodyH: document.body.clientHeight,
        stageH: stage.clientHeight,
        /* 恒等式是 **stageH = bodyH − reserve**（#stage 的 bottom 就是 --stats-h）。
         * ⚠️ STATS_GAP 不在这里 —— 它是 layout() 内部从 stageH 再扣的取景留白，
         *    不进 CSS 布局。早期版本把它也算进来，恒等式永远不成立（假报警）。 */
        sumOk: Math.abs(stage.clientHeight - (document.body.clientHeight - parseFloat(reserve || 0))) < 2
      }));
      const sw = await window.pet?.saveShot?.('bar');
      console.log('[pet] bar shot', JSON.stringify({ ink: sw?.ink, size: sw?.size }));
    }, 14000);
  }

  /* 诊断：底座加载态（?snap=load）
   *
   * 验两件事：
   * 1) **尺寸** —— 加载态唯一会出错的地方。牌的高度全靠骨架那几行的行盒撑着，
   *    少一行、或者骨架被换成空 span，牌就矮一截 → 出数时 --stats-h 一跳、
   *    人物跟着缩一下。这事**在截图上看不出来**（30px 和 17px 都"有个底座"），
   *    必须量。
   * 2) **时序** —— 转圈得真的出现在数据之前。转圈只闪 30ms 就等于没有，
   *    而"到底闪了多久"只有记时间戳才知道（看日志顺序看不出来）。
   *
   * 做法：挂上就开始每 50ms 采一次（记下加载态、出数态各自的**首次**出现时刻），
   * 到 14s（真牌已经在了）强制摆一次加载态 → 量 → 截图 → 4s 后
   * （期间每 3s 一推，真牌必然已经画回来）再量一次 → 比高度和 --stats-h。 */
  if (new URLSearchParams(location.search).get('snap') === 'load') {
    const T0 = performance.now();
    const since = (t) => (t === null ? null : Math.round(t - T0));
    let tLoading = null, tLoaded = null;
    const poll = setInterval(() => {
      const plate = document.getElementById('stats')?.querySelector('.plate');
      if (!plate) return;
      if (plate.classList.contains('loading')) {
        if (tLoading === null) tLoading = performance.now();
      } else if (tLoaded === null) {
        tLoaded = performance.now();
        clearInterval(poll);
      }
    }, 50);

    setTimeout(async () => {
      clearInterval(poll);
      const el = document.getElementById('stats');
      const boxOf = (n) => { const b = n.getBoundingClientRect();
        return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      const read = (tag) => {
        const plate = el?.querySelector('.plate');
        const sp = el?.querySelector('.spinner');
        return {
          tag,
          loading: !!plate?.classList.contains('loading'),
          spinnerBox: sp ? boxOf(sp) : null,
          plateBox: plate ? boxOf(plate) : null,
          reserve: getComputedStyle(document.body).getPropertyValue('--stats-h').trim(),
          text: (plate?.textContent || '').trim()
        };
      };

      live.renderStatsLoading?.();          // 真·builder，不是复制一份 DOM
      const loading = read('loading');
      /* ⚠️ 截图前必须让出一帧再拍：capturePage 拿的是**上一帧合成结果**，
       *    刚 replaceChildren 完立刻拍，拍到的还是替换前那张（实测就是这样 ——
       *    量出来是加载态，图里却是数字）。350ms 足够过一次合成，
       *    又远小于推送间隔（3s），不会拍到下一帧真数据。 */
      await new Promise((r) => setTimeout(r, 350));
      const shot = await window.pet?.saveShot?.('load');
      setTimeout(() => {
        const loaded = read('loaded');
        const h = (r) => r.plateBox?.[3];
        console.log('[pet] load', JSON.stringify({
          /* 相对本探针挂上的时刻（≈ boot 末尾，加载态就是在那之后摆出来的） */
          tLoadingMs: since(tLoading),
          tLoadedMs: since(tLoaded),
          loading,
          loaded,
          /* 断言就这两条：牌一样高、让出的 --stats-h 也一样 */
          heightSame: h(loading) === h(loaded),
          reserveSame: loading.reserve === loaded.reserve,
          shot: shot?.ink
        }));
      }, 4000);
    }, 14000);
  }

  /* 诊断：窗口宽度随对话 UI 伸缩（?snap=talk）
   *
   * 验那条链路：常驻窗口只包住人物和底座，气泡 / 输入条一露出来就撑宽。
   * 时间线：6s 开输入条（→ 撑宽）→ 9s 收起（→ 缩回）→ 11s 弹一条长气泡
   * （→ 撑宽）→ 24s 全收（→ 缩回）。
   * 配主进程的 [bounds]（PET_SNAPSHOT 打开时每 500ms 一条）一起看，要的是：
   * 宽度在变，而 **bounds.x + bounds.width（右边缘）一直不变** —— 也就是她没挪窝。
   * 再配上 [pet] layout 里的 bodyCx，还能核到人物屏幕横坐标 = 右边缘 − 96。 */
  if (new URLSearchParams(location.search).get('snap') === 'talk') {
    const T = (ms, fn) => setTimeout(fn, ms);
    T(6000, () => live.showComposer?.());          // 输入条 → 撑宽
    T(9000, () => live.hideUI?.());                // 收起 → 缩回
    T(11000, () => live.say?.('这一条是用来量「说完之后窗口会不会缩回去」的，所以故意写得长一点，把整行占满。', 12000));
    T(24000, () => live.hideUI?.());               // 全收 → 缩回
  }

  // 自检通道：带 ?snap=1 启动时触发一次窗口截图落盘（PET_SNAPSHOT=1）。
  // 走主进程 capturePage 而不是 pixi 的 extract —— Cubism 渲染时会改动
  // UNPACK_FLIP_Y_WEBGL 等全局 GL 状态，用 RenderTexture 导出会上下颠倒。
  // seam 是长时间纯观测通道，不做截图：capturePage 本身会引入卡顿，污染数据。
  // ink 自己也截图，这里要排除掉，否则会互相覆盖同一个 PNG。
  if (new URLSearchParams(location.search).has('snap') &&
      !['seam', 'ink', 'look', 'hit', 'bar', 'load'].includes(new URLSearchParams(location.search).get('snap'))) {
    const sweep = async (name) => {
      await new Promise((r) => setTimeout(r, 380));
      const sw = await window.pet?.saveShot?.(name);
      console.log('[pet] sweep', name, JSON.stringify({ ink: sw?.ink }));
    };
    setTimeout(async () => {
      try {
        const fmt = (m) => (m ? [Math.round(m.tx), Math.round(m.ty), Number(m.a.toFixed(4)), Number(m.d.toFixed(4))] : null);
        console.log('[pet] matrices', JSON.stringify({
          modelWorld: fmt(live.model().worldTransform),
          holderWorld: fmt(live.holder().worldTransform),
          modelGroup: fmt(live.model().groupTransform),
          modelLocal: fmt(live.model().localTransform),
          holderLocal: fmt(live.holder().localTransform),
          hasRenderGroup: !!live.model().renderGroup,
          hasParentGroup: !!live.model().parentRenderGroup
        }));
        const shot = await window.pet?.saveShot?.();

        // 透明背景的排查已经结束（根因见 boot() 里 clearPatched 那段注释），
        // 这里只留最终结果。

        // 把插件内部的绘制矩阵直接打出来。半身取景全靠这套坐标换算，
        // 靠推公式推歪过一次（横纵缩放对不上），还是看真值可靠。
        const im = live.model().internalModel;
        const dm = im.drawingMatrix;
        const vp = im.viewport;
        const res = live.app().renderer.resolution;
        // drawingMatrix 的输入是「模型顶点」（原点在画布中心、y 向上）
        const toCss = (cx, cy) => {
          const u = (cx - im.originalWidth / 2) / im.pixelsPerUnit;
          const v = (im.originalHeight / 2 - cy) / im.pixelsPerUnit;
          const nx = dm.a * u + dm.c * v + dm.tx;
          const ny = dm.b * u + dm.d * v + dm.ty;
          return [
            (((nx + 1) / 2) * vp[2] + vp[0]) / res,
            (((1 - ny) / 2) * vp[3] + vp[1]) / res
          ];
        };
        const rect = live.canvas.getBoundingClientRect();
        console.log('[pet] probe', JSON.stringify({
          ppu: im.pixelsPerUnit,
          local: [im.localTransform.a, im.localTransform.d, im.localTransform.tx, im.localTransform.ty],
          draw: [dm.a, dm.b, dm.c, dm.d, dm.tx, dm.ty],
          vp, res,
          screen: [live.app().renderer.screen.width, live.app().renderer.screen.height],
          rect: [rect.x, rect.y, rect.width, rect.height].map((n) => Math.round(n * 10) / 10),
          petRect: [live.petRect().x, live.petRect().y, live.petRect().w, live.petRect().h].map((n) => Math.round(n * 10) / 10),
          fps: Math.round(live.app().ticker.FPS)
        }));
        // 截图是设备像素，换算成窗口逻辑像素才好和 layout() 的推算对照
        const dpr = window.devicePixelRatio || 1;
        const L = (b) => (b && b[2] >= b[0] ? b.map((n) => Math.round((n / dpr) * 10) / 10) : null);
        console.log('[pet] snapshot', JSON.stringify({
          dpr,
          sizeLogical: shot?.size ? [Math.round(shot.size[0] / dpr), Math.round(shot.size[1] / dpr)] : null,
          ink: L(shot?.ink),
          opaque: L(shot?.opaque)
        }));

        // 语音朗读能不能用 —— Electron 里 speechSynthesis 不一定被编进去，
        // 拿不到音色列表就等于没有，必须实测。
        console.log('[pet] tts', JSON.stringify({
          builtin: typeof speechSynthesis !== 'undefined',
          voices: typeof speechSynthesis !== 'undefined' ? (speechSynthesis.getVoices() || []).length : 0,
          picked: ttsVoiceInfo()
        }));

        await sweep('shot');

        // ?snap=ui：顺带把气泡 + 输入条也露出来落一张图，检查 UI 层没被画布盖住。
        // 顺便切一个情绪，验证表情参数确实生效（脸红最好认）。
        if (new URLSearchParams(location.search).get('snap') === 'ui') {
          live.setEmotion('shy');
          await new Promise((r) => setTimeout(r, 1600));   // 等情绪插值到位
          console.log('[pet] emotion', JSON.stringify({
            target: live.emotion(),
            cheek: Number((live.readParam(live.P().CHEEK) ?? -1).toFixed(3)),
            mouthForm: Number((live.readParam(live.P().MOUTH_FORM) ?? -9).toFixed(3)),
            browY: Number((live.readParam(live.P().BROW_L_Y) ?? -9).toFixed(3))
          }));
          live.bubbleText.textContent = '取景调好了。想让人物大一点小一点，就动 layout() 上面的 PET_SCALE。';
          live.bubble.classList.remove('hidden');
          live.showComposer();
          await sweep('shot-ui');
        }

        // ?snap=chat：走一遍完整对话链路（流式 + 情绪标签剥离 + 气泡 + 朗读）
        if (new URLSearchParams(location.search).get('snap') === 'chat') {
          live.input.value = '在吗';
          await live.sendMessage();
          await new Promise((r) => setTimeout(r, 900));
          console.log('[pet] chat result', JSON.stringify({
            emotion: live.emotion(), gotChunk: live.gotFirstChunk(),
            hasTag: /\[emo:/i.test(live.replyBuffer()),      // 必须为 false：标签该被剥掉
            text: live.replyBuffer().slice(0, 40)
          }));
          await sweep('shot-chat');
        }

        // ?snap=idle：把闲置阈值压到 3 秒，验证主动搭话会自己冒出来
        if (new URLSearchParams(location.search).get('snap') === 'idle') {
          live.setCfg({ ...(live.cfg() || {}), proactive: { enabled: true, idleMinutes: 0.05 } });
          live.setState(live.State.IDLE);
          live.pokeIdleTimer();
          await new Promise((r) => setTimeout(r, 6500));
          console.log('[pet] proactive result', JSON.stringify({
            emotion: live.emotion(), text: live.replyBuffer().slice(0, 40)
          }));
          await sweep('shot-idle');
        }

        /* ?snap=xfade：抓「手臂垂下 ↔ 手臂抬起」的交叉淡化过程
         *
         * Hiyori 的 10 个待机动作分成**两族**，参数完全不重叠：
         *   A 族（m01~m05 / m07 / m09 / m10）：只写 ParamArmLA / ParamArmRA（手臂垂下）
         *   B 族（m06 / m08）：只写 ParamArmLB / ParamArmRB + ParamHandLB / ParamHandRB（手臂抬起）
         * 所以 A↔B 切换时，**两个手臂旋转轴同时在插值**，中间姿态可能不自然。
         * 连拍 + 逐帧打印参数，用来分辨是「姿态插值中间态」还是「参数残留」。 */
        /* ?snap=armfree：完全不干预，让待机动作自己轮转，采样全部 8 个手臂参数
         * + 当前动作组/序号。用来回答「换动作时到底哪个参数留了残值」——
         * 前面一直是靠看图猜，猜不动了。跑 30s。 */
        if (new URLSearchParams(location.search).get('snap') === 'armfree') {
          const c0 = live.model().internalModel.coreModel;
          const mm0 = live.model().internalModel.motionManager;
          const findIdx0 = (name) => {
            try {
              for (let i = 0; i < c0.getParameterCount(); i++) {
                const s = c0.getParameterId(i)?.getString?.()?.s ?? '';
                if (s === name) return i;
              }
            } catch { /* ignore */ }
            return -1;
          };
          const WATCH = [
            'ParamArmLA', 'ParamArmRA', 'ParamArmLB', 'ParamArmRB',
            'ParamHandLB', 'ParamHandRB', 'ParamHandL', 'ParamHandR'
          ];
          const ix0 = WATCH.map(findIdx0);
          const rd0 = (i) => {
            if (i < 0) return null;
            try {
              const v = c0.getParameterValueByIndex(i);
              return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
            } catch { return null; }
          };
          for (let k = 1; k <= 200; k++) {
            await new Promise((r) => setTimeout(r, 150));
            const st = mm0.state || {};
            console.log('[pet] armfree', JSON.stringify({
              k, g: st.currentGroup, i: st.currentIndex, v: ix0.map(rd0)
            }));
          }
        }

        if (new URLSearchParams(location.search).get('snap') === 'xfade') {
          const c0 = live.model().internalModel.coreModel;
          // 注意：用 getParameterValueById(字符串) 在这套封装里读不出来（返回 undefined），
          // 得走「索引 → Id」的路径。
          const findIdx = (name) => {
            try {
              for (let i = 0; i < c0.getParameterCount(); i++) {
                const pid = c0.getParameterId(i);
                // getString() 返回的是 csmString 对象 {s:"ParamAngleX"}，必须再取一层 .s
                // —— 上一轮这里直接拿对象跟字符串比，所以 findIdx 全返回 -1、参数读不出来。
                const s = pid?.getString?.()?.s ?? String(pid);
                if (s === name) return i;
              }
            } catch { /* 拿不到索引就当没有 */ }
            return -1;
          };
          const IX = {
            armLA: findIdx('ParamArmLA'), armRA: findIdx('ParamArmRA'),
            armLB: findIdx('ParamArmLB'), armRB: findIdx('ParamArmRB'),
            handLB: findIdx('ParamHandLB')
          };
          const rdIx = (i) => {
            if (i < 0) return 'NA';
            try {
              const v = c0.getParameterValueByIndex(i);
              return Number.isFinite(v) ? Math.round(v * 100) / 100 : 'NaN';
            } catch { return 'EX'; }
          };
          const dumpP = (tag) => console.log('[pet] xfade-param', tag, JSON.stringify({
            armLA: rdIx(IX.armLA), armRA: rdIx(IX.armRA),
            armLB: rdIx(IX.armLB), armRB: rdIx(IX.armRB),
            handLB: rdIx(IX.handLB)
          }));

          try {
            // 诊断专用：把淡化临时拉长到 1.5s，让交叉淡化的中间态变慢、方便连拍。
            // 只影响本次诊断（进程跑完就没了），生产的 0.8s 不受影响。
            {
              const mmx = live.model().internalModel.motionManager;
              for (const arr of Object.values(mmx.motionGroups || {})) {
                for (const m of arr) {
                  try { m.setFadeIn(1.5); m.setFadeOut(1.5); } catch { /* ignore */ }
                }
              }
            }

            // 用户报的正是这个方向：待机里「举手（B 族 m08）」→「放下（A 族 m01）」。
            // 修复前 ArmLB/RB 会卡在 m08 的抬起残值上没人接管，叠加出错乱姿态 = 残影。
            // 这里就把这个方向跑一遍，直接看 ArmLB/RB 有没有被放回 0。

            // 1) B 族动作（手臂抬起）：Idle#6 = m08
            //    （Idle 组里 m04 被挪去做 TapBody，所以 index 排法是 0,1,2,3,5,6,7,8,10，
            //     index 6 才对应 m08）
            live.model().motion('Idle', 6, 2);
            await new Promise((r) => setTimeout(r, 2600));
            dumpP('B-settled');
            await sweep('xfade-a');

            // 2) 切回 A 族动作（手臂垂下）：Idle#0 = m01
            live.model().motion('Idle', 0, 2);
            // 采样拉到 5s：m08 只有 2.1s，必须看到它「播完、被移出队列之后」
            // handLB 有没有被释放下来。只连拍 6 帧（~2s）会正好卡在它还在播的时候。
            for (let i = 1; i <= 20; i++) {
              await new Promise((r) => setTimeout(r, 250));
              if (i <= 6) await window.pet?.saveShot?.(`xfade-${i}`);
              dumpP(`t${i}`);
            }

            // 3) 等 m01 播完稳定 —— 关键看 ArmLB/RB 有没有被放回 0
            await new Promise((r) => setTimeout(r, 2600));
            dumpP('A-settled');
            await sweep('xfade-b');
            console.log('[pet] xfade done', JSON.stringify({ fps: Math.round(live.app().ticker.FPS) }));
          } catch (err) {
            console.error('[pet] xfade failed:', err?.message || String(err));
          }
        }

        /* ?snap=movesize：盯着三层尺寸（视口 / 文档 / 舞台）看谁在长
         *
         * 现象：跑一会儿人物自己变大。layout() 里 canvas = stage × ZOOM，
         * 而 canvas 尺寸又会回写 DOM，一旦 stage 依赖 canvas 就会发散。
         * 这里**刻意不调用 layout / 不截图**，纯观测，排除干扰。 */
        if (new URLSearchParams(location.search).get('snap') === 'movesize') {
          const dump = (tag) => console.log('[pet] movesize', tag, JSON.stringify({
            inner: [window.innerWidth, window.innerHeight],
            docEl: [document.documentElement.clientWidth, document.documentElement.clientHeight],
            stage: [live.stageEl.clientWidth, live.stageEl.clientHeight],
            canvasCss: [live.canvas.clientWidth, live.canvas.clientHeight],
            dpr: window.devicePixelRatio
          }));
          // 阶段1：静置，确认「什么都不做」时稳定
          for (let i = 0; i <= 3; i++) {
            dump(`quiet${i}`);
            await new Promise((r) => setTimeout(r, 800));
          }
          // 阶段2：模拟拖动 —— 走的就是用户「移动」时那条路
          //（pointermove → pet:drag-move → mainWindow.setPosition）
          for (let i = 0; i <= 11; i++) {
            window.pet?.dragMove?.(6, 6);
            await new Promise((r) => setTimeout(r, 320));
            dump(`drag${i}`);
          }
          console.log('[pet] movesize done');
        }
      } catch (err) {
        console.error('[pet] snapshot failed:', err?.message || String(err));
      }
    }, 2600);
  }
}
