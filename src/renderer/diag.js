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

  /* 诊断：模型在**画布内**的真实落点（?snap=fit）
   *
   * 解决的问题：换模型后"什么都看不见"，而 `model.getBounds()` 只报画布尺寸
   * （恒为 [0,0,CANVAS×s]），窗口截图又会把窗口外的部分裁掉 —— 两头都看不出
   * 模型到底画在画布的哪个角落。
   *
   * 做法：直接把**整个 canvas 的像素读回来**（renderer.extract.pixels），扫
   * alpha>0 的包围盒。canvas 是窗口的 ZOOM 倍，所以模型画在窗口外也能量到。
   *
   * 输出（canvas 逻辑像素）：inkBox=[l,t,r,b] + 换算出的 canvas 单位
   * （÷s，拿去和 profiles/<m>.js 的 inkTopK/inkH/inkW/inkCxK 对照）。
   */
  if (new URLSearchParams(location.search).get('snap') === 'fit') {
    const scan = () => {
      const app = live.app();
      const gl = app.renderer.gl;
      /* 🔴 readPixels 的网格是**设备像素**（drawingBufferWidth），不是
       * renderer.width（逻辑宽）。按逻辑宽解析会整体错位（踩过：DPR=1.5 时
       * 报出来的框偏到画布右边，看起来像"模型画到了画布外"）。 */
      const dw = gl.drawingBufferWidth;
      const dh = gl.drawingBufferHeight;
      const res = app.renderer.resolution || 1;
      let px;
      try {
        /* ⚠️ 别用 renderer.extract.pixels()：这个构建里它的 filter 状态是空的，
         * 直接抛 "reading 'effects'"。走原生 readPixels —— 渲染器的
         * preserveDrawingBuffer 是开的（命中测试/量头顶要读回像素），所以有效。 */
        px = new Uint8Array(dw * dh * 4);
        gl.readPixels(0, 0, dw, dh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      } catch (e) {
        console.log('[pet] fit extract-fail', e && e.message);
        return;
      }
      /* GL 原点在左下：读到的是"自下而上"的行序，输出时换算回 canvas 坐标
       * （左上原点，与 INK_* 同口径），并除以 resolution 回到逻辑像素。 */
      let l = 1e9, t = 1e9, r = -1, b = -1;
      for (let row = 0; row < dh; row++) {
        const y = dh - 1 - row;              // GL 行 → canvas 行（设备像素）
        for (let x = 0; x < dw; x++) {
          if (px[(row * dw + x) * 4 + 3] > 8) {
            if (x < l) l = x;
            if (x > r) r = x;
            if (y < t) t = y;
            if (y > b) b = y;
          }
        }
      }
      l = l / res; t = t / res; r = r / res; b = b / res;
      const s = live.holder()?.scale?.x || 0;
      const box = r < 0 ? null : [l, t, r, b];
      console.log('[pet] fit', JSON.stringify({
        canvas: [Number((dw / res).toFixed(1)), Number((dh / res).toFixed(1))],
        s: Number(s.toFixed(5)),
        box,
        /* canvas 单位（与档案里的 inkTopK/inkH/inkW 同量纲） */
        units: box && s ? {
          left: Math.round(l / s), top: Math.round(t / s),
          w: Math.round((r - l + 1) / s), h: Math.round((b - t + 1) / s)
        } : null
      }));
    };
    const T = (ms, fn) => setTimeout(fn, ms);
    T(2500, scan);
    T(9000, scan);
    T(16000, scan);
  }

  /* 诊断：模型「皮肤体检」（?snap=skin）
   *
   * 用途：**换模型后人物不显示**时，先分清是哪一类原因 —— 是
   *   ① drawable 本来就被参数/部件关掉了（opacity≈0，素材问题）；
   *   ② 还是画了但被遮罩裁没了（Cubism 单 render texture 只支持 36 个遮罩，
   *      超出时 setupLayoutBounds 会把**所有**遮罩压到同一块整幅缓冲上）；
   *   ③ 还是贴图没绑上。
   *
   * 只读 core 的**现成数组**（`core._model.drawables.opacities` 等），
   * 不遍历顶点 —— 遍历顶点会破坏 WASM 内部缓冲（pet.js 头注释坑 4）。
   *
   * 配 `?snap=ink` 一起看：ink 给你"画面上到底有多少墨"，
   * skin 告诉你"模型里有多少东西本该被画"。两者差得远 = 遮罩/贴图问题。 */
  if (new URLSearchParams(location.search).get('snap') === 'skin') {
    const dump = () => {
      const im = live.model()?.internalModel;
      const m = im?.coreModel?._model;
      if (!m) return { err: 'no core._model' };
      const d = m.drawables;
      const n = d.count;
      /* 每个贴图槽上有多少 drawable、其中多少是"开着的" */
      const byTex = {};
      let vis = 0;
      let visMasked = 0;
      const clipSet = new Set();
      for (let i = 0; i < n; i++) {
        const t = d.textureIndices[i];
        const row = byTex[t] || (byTex[t] = { n: 0, visible: 0 });
        row.n++;
        if (d.opacities[i] > 0.01) { row.visible++; vis++; }
        if (d.opacities[i] > 0.01 && d.maskCounts[i] > 0) visMasked++;
        /* 遮罩"编号"：Cubism 内部按 (drawable, maskIndex) 去重成 clip context，
         * 这里用 masks 数组的引用条数近似"总遮罩引用数"。 */
        for (let k = 0; k < d.maskCounts[i]; k++) clipSet.add(i + ':' + k);
      }
      const parts = Array.from(m.parts.opacities || []);
      const r = im?.renderer;
      return {
        drawables: n,
        visible: vis,
        visibleMasked: visMasked,
        maskRefs: clipSet.size,
        byTex,
        partsOn: parts.filter((v) => v > 0.01).length,
        partsTotal: parts.length,
        renderer: r
          ? {
              renderTextures: r.getRenderTextureCount?.(),
              maskBufferSize: r.getClippingMaskBufferSize?.(),
              usingMasking: r.isUsingMasking?.()
            }
          : null,
        canvas: [im?.originalWidth, im?.originalHeight],
        /* 底座（含加载转圈）的 DOM 矩形 —— 截图量 ink 时它是**恒在窗口底部**的
         * 一块墨，若量到的 ink 恰好等于它，那"人物不显示"就与底座无关，
         * 是模型真的没画出来（别把转圈当成人物，踩过一次）。 */
        stats: (() => {
          const el = document.getElementById('stats');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return {
            rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
            display: cs.display,
            opacity: cs.opacity,
            visibility: cs.visibility
          };
        })()
      };
    };
    const T = (ms, fn) => setTimeout(fn, ms);
    /* 三个时点各打一次：刚挂上 / 动作跑起来 / 20s 后（物理+表情都稳了） */
    T(1500, () => console.log('[pet] skin@1.5s', JSON.stringify(dump())));
    T(9000, () => console.log('[pet] skin@9s', JSON.stringify(dump())));
    T(20000, () => console.log('[pet] skin@20s', JSON.stringify(dump())));
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
  /* ⚠️ 排除列表里**不要**加 'mood' —— ?snap=mood 的探针就写在下面这个
   *    setTimeout 回调内部，排除掉它是"把自己的探针一起跳过"（踩过一次：
   *    表现是日志里一条 mood 都没有，看起来像探针没生效）。
   *    代价只是多落一张默认截图（pet-shot.png），无害。 */
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

        /* ?snap=mood：8 档情绪全量截图 + 错峰到位的时间序列
         *
         *  1) 依次切 8 个情绪，每个停 1.6s 落一张图。**parameter 表里的正负号
         *     只能靠这一步校准** —— "眉高低 +0.45 到底是上扬还是下压"
         *     "BODY_Y +2.5 是前倾还是后仰" 推不出来，只能看图。
         *  2) 在切 think 的那一拍起每 50ms 采一次 browLY / mouthForm / bodyZ。
         *     这三个字段的速度是 9 / 4.5 / 2.2，故意拉开 —— 若错峰表生效，
         *     到达目标 63% 的时刻应该依次是 ~111ms / ~222ms / ~455ms。
         *     如果三个字段同拍到位，说明 EMO_SPEED 没被用上（退回单一速度）。
         *     采的是**参数本身**（readParam），不是 emoCur —— 绕过插值层看真实结果。 */
        if (new URLSearchParams(location.search).get('snap') === 'mood') {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const rd = (id) => Number((live.readParam(id) ?? 0).toFixed(4));
          await wait(1200);

          /* --- ⓪ 心境层快照：主进程 mood.js 的四轴真的推过来了吗 ---
           * 点击事件会触发即时推送，先点一下再等快照到达（10s tick 太慢，
           * 探针等不起）。没收到 = null，探针会明确说出来而不是含糊带过。 */
          window.pet?.moodEvent?.('click');
          await wait(600);
          const ms = live.mood();
          console.log('[pet] mood-axes', JSON.stringify({
            received: !!ms,
            axes: ms ? {
              valence: Number(ms.valence.toFixed(3)),
              social: Number(ms.social.toFixed(3)),
              energy: Number(ms.energy.toFixed(3)),
              pride: Number(ms.pride.toFixed(3))
            } : null,
            bias: ms ? ms.bias : null,
            line: ms ? ms.line : '(no snapshot)'
          }));

          // --- ① 错峰时间序列（必须从 calm 起跳，所以放在截图循环之前）---
          const trace = [];
          const t0 = performance.now();
          live.setEmotion('think');
          for (let i = 0; i < 46; i++) {
            trace.push([
              Math.round(performance.now() - t0),
              rd(live.P().BROW_L_Y), rd(live.P().MOUTH_FORM), rd(live.P().BODY_Z)
            ]);
            await wait(50);
          }
          console.log('[pet] mood-trace', JSON.stringify({
            fields: ['t_ms', 'browLY', 'mouthForm', 'bodyZ'],
            speed: { browLY: 9, mouthForm: 4.5, bodyZ: 2.2 },
            rows: trace
          }));

          // --- ② 8 档情绪各落一张 ---
          for (const name of ['calm', 'happy', 'smile', 'think', 'shy', 'serious', 'surprised', 'sleepy']) {
            live.setEmotion(name);
            await wait(1600);            // 等最慢的字段（bodyY/Z，2.2/s）到位
            const snap = await window.pet?.saveShot?.('mood-' + name);
            console.log('[pet] mood', JSON.stringify({
              emo: name,
              cur: live.emotion(),
              decay: live.decay(),       // 8 档都在安定保持期内，应恒为 1
              browLY: rd(live.P().BROW_L_Y), browRY: rd(live.P().BROW_R_Y),
              browLX: rd(live.P().BROW_L_X), browRX: rd(live.P().BROW_R_X),
              ahoge: rd(live.P().AHOGE),
              bodyY: rd(live.P().BODY_Y), bodyZ: rd(live.P().BODY_Z),
              headZ: rd(live.P().ANGLE_Z), headY: rd(live.P().ANGLE_Y),
              ink: snap?.ink
            }));
          }

          /* --- ③ 情绪衰减曲线（emotion.decay，Picard 指数回 calm）---
           * 切 happy 后：插值到位约 2s，安定保持 5s，第 7s 起开始衰减
           * （τ=30s）。前 7s 采样应恒为 1，之后逐秒按 e^(-t/30) 落：
           * 8s≈0.97 → 15s≈0.79 → 37s（5s 保持 + 32s）≈0.34。
           * 采 BROW_L_Y / BODY_Y 是为了顺带看错峰回落：眉快（速度 9）
           * 先回，身体慢（2.2）后回，两条曲线不该齐头。 */
          live.setEmotion('happy');
          const dec = [];
          const t1 = performance.now();
          for (let i = 0; i <= 32; i++) {
            await wait(i === 0 ? 7000 : 1000);
            dec.push([
              Math.round(performance.now() - t1),
              Number(live.decay().toFixed(3)),
              rd(live.P().BROW_L_Y), rd(live.P().BODY_Y)
            ]);
          }
          console.log('[pet] decay-trace', JSON.stringify({
            fields: ['t_ms', 'decay', 'browLY', 'bodyY'],
            tau_s: 30, holdMs: 5000,
            rows: dec
          }));
          console.log('[pet] mood done');
        }

        /* ?snap=expr：表情层（事件 / 道具）逐个落图（2026-10-29 二阶）
         *
         * 为什么要逐个落图：**参数写进去 ≠ 画出来** —— 幻影参数那一轮已经
         * 证明过"读回来完全自洽、画面纹丝不动、零报错"，所以判据只能是图。
         * 情绪 8 档由 ?snap=mood 覆盖（顺手也就验了新加的整脸表情），
         * 这里只跑 15 个事件表情 + 18 件道具。
         *
         * 每个之间留 900ms 让上一个淡干净 —— 否则两张图叠在一起，
         * 分不清是"这个没生效"还是"上一个还没退"。 */
        if (new URLSearchParams(location.search).get('snap') === 'expr') {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          await wait(1500);
          live.setEmotion('calm');
          await wait(1200);
          /* 🔴 文件标签必须是**纯 ASCII**：主进程 pet:save-shot 的白名单是
           *    /^[A-Za-z0-9_-]{1,40}$/，中文名会被判 null → 全部退回
           *    pet-window.png 互相覆盖。踩过：33 张只剩 1 张，日志里却有 33 行。
           *    真实名字放进日志的 label 字段，图名用序号。 */
          const shot = async (tag, label) => {
            const s = await window.pet?.saveShot?.('expr-' + tag);
            const st = live.exprState();
            console.log('[pet] expr-shot', JSON.stringify({
              tag, label,
              ev: st.ev,
              prop: st.prop?.file ?? null,
              amt: Object.fromEntries(Object.entries(st.amt)
                .filter(([, v]) => v > 0).map(([k, v]) => [k, Number(v.toFixed(2))])),
              ink: s?.ink
            }));
          };
          await shot('base', '(calm)');
          let i = 0;
          for (const name of live.exprNames()) {
            const tag = 'ev' + String(++i).padStart(2, '0');
            live.emote(name, 3000);
            await wait(900);
            await shot(tag, name);
            /* 截完就让它立刻退，并等强度退干净 —— 否则下一张图里叠着上一个
             * 表情（第一版就是 3s 保持 + 900ms 间隔，后 18 张道具图全被
             * 「撤回」污染了）。 */
            live.emoteOff?.();
            await wait(1200);
          }
          i = 0;
          for (const file of live.propNames()) {
            const tag = 'pr' + String(++i).padStart(2, '0');
            live.forceProp(file, 6000);
            await wait(900);
            await shot(tag, file);
            live.forceProp(null);
            await wait(1200);
          }
          console.log('[pet] expr done');
        }

        /* ?snap=whaleexp：鲸鱼娘自带的 exp3 表情到底能不能亮出来（2026-10-29）
         *
         * 素材包 `expressions/` 有 44 个 `.exp3.json`，但 `c_0120.model3.json` 的
         * `FileReferences` 里**根本没有 Expressions 段**（VTube Studio 模型包通病：
         * VTS 自己另有一份配置）→ 引擎不知道它们存在，库的 `model.expression()`
         * 一个都用不了。
         *
         * 所以这里**绕过 expressionManager**，直接照 exp3 的 `Parameters` 写参数
         * （44 个文件的 Blend 全是 Add，写起来最省事），每张落一张图。
         * 判据只有一条：**图上真出现了星星眼 / 问号**，才说明"参数能驱动那些贴图"。
         * 只按源码推断不行 —— 那些 ParamCheekNN 也可能只是没人用的空参数。
         *
         * 落盘名必须是纯 ASCII（主进程 `pet:save-shot` 的白名单是
         * `/^[A-Za-z0-9_-]{1,40}$/`，中文名会被拒 → 回退写 pet-window.png 互相覆盖）。 */
        if (new URLSearchParams(location.search).get('snap') === 'whaleexp') {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const core = () => live.model()?.internalModel?.coreModel;
          const rdRaw = (id) => Number((live.readParam(id) ?? 0));
          const setRaw = (id, v) => { try { core()?.setParameterValueById(id, v); } catch { /* 参数不存在：静默 */ } };

          /* 每组 = 「ASCII 标签 + exp3 里的 Parameters（值照抄文件）」。
           * 第一组是**对照**：BrowLY 我们情绪引擎每帧也在写（calm=0），如果连它
           * 都没效果，说明问题在"写入通道"，不在表情参数本身。 */
          const CASES = [
            { tag: 'ctrl-brow', zh: '对照·皱眉', p: [['ParamBrowLY', -1], ['ParamBrowRY', -1]] },
            { tag: 'star',   zh: '星星眼',   p: [['ParamCheek16', 1]] },
            { tag: 'ques',   zh: '问号',     p: [['ParamCheek74', 1]] },
            { tag: 'excl',   zh: '感叹号',   p: [['ParamCheek75', 1]] },
            { tag: 'happy',  zh: '开心兴奋', p: [['ParamCheek76', 1], ['ParamEyeLOpen', 0], ['ParamEyeROpen', 0],
              ['ParamBrowLX', -1], ['ParamBrowLY', -0.8], ['ParamBrowLAngle', -1], ['ParamBrowLForm', -0.6],
              ['ParamBrowRX', -1], ['ParamBrowRY', -0.8], ['ParamBrowRAngle', -1], ['ParamBrowRForm', -0.6],
              ['ParamMouthForm', 1.5]] },
            { tag: 'angry',  zh: '生气',     p: [['ParamCheek80', 1], ['ParamCheek23', 1],
              ['ParamBrowLX', -1], ['ParamBrowLY', -0.5], ['ParamBrowLAngle', -1], ['ParamBrowLForm', -0.59],
              ['ParamBrowRX', -1], ['ParamBrowRY', -0.45], ['ParamBrowRAngle', -1], ['ParamBrowRForm', -0.7]] },
            { tag: 'cry',    zh: '哭',       p: [['ParamCheek20', 1], ['ParamCheek27', 1], ['ParamCheek23', 1],
              ['ParamBrowLX', 0], ['ParamBrowLY', -0.3], ['ParamBrowLAngle', 0.25], ['ParamBrowLForm', -1],
              ['ParamBrowRX', 0], ['ParamBrowRY', -0.3], ['ParamBrowRAngle', 0.25], ['ParamBrowRForm', -1]] }
          ];

          await wait(1500);
          const base = await window.pet?.saveShot?.('whaleexp-00-base');
          console.log('[pet] whaleexp', JSON.stringify({ tag: 'base', ink: base?.ink }));

          /* 🔴 第一轮教训（2026-10-29）：**写一次 = 白写**（当时怀疑动作快照回滚）。
           * 🔴 第二轮教训（同日）：改成每帧重写后 **透明度差分仍是 0、脸上仍然没变化**，
           *    连我们情绪引擎也在用的 BrowLY=-1 对照组都没生效 —— 所以嫌疑升级为
           *    「写入的时机根本没赶上出画」。本轮加三样证据：
           *      ① 拍照瞬间**回读参数值**（区分"没写进去"和"写进去了但没用"）；
           *      ② drawable 全量差分：透明度 + **顶点包围盒** + 绘制顺序（贴图换装
           *         可能不走透明度，走形变或移出画面）；
           *      ③ 对照组 BrowLY —— 它如果也没效果，问题在写入通道，不在表情参数。 */
          /* 🔴 差分两次都是假的（2026-10-29），两个坑记在这里：
           *   ① `coreModel.getDrawableIds` 在这个构建里**不存在** → ids=[] →
           *      循环体一次都不跑，`changed:0` 是"什么都没量"而不是"什么都没变"。
           *   ② 顶点数组必须 slice 拷贝，否则两次采样比的是同一块内存。
           * 现在直接读 **Core 原始数组**（`core._model.drawables.opacities` /
           * `parts.opacities`）—— 这是第三方引擎笔记
           * （A8Chann/dsh-pet-live2d `.dsh/skills/cubism-engine/SKILL.md`）明确推荐的口径：
           * 「把表达式参数写进模型、core.update() 后比 drawables.opacities 的差值」。 */
          const raw = () => core()?._model;
          const opac = () => {
            const m = raw();
            if (!m) return null;
            return {
              n: m.drawables.count,
              d: Array.from(m.drawables.opacities),
              p: Array.from(m.parts.opacities),
              ver: m.drawables.vertexPositions?.[0] ?? null   // 顺带证明采样之间确实重算过
            };
          };
          let active = null;   // { p: [[id, v], ...] } —— null = 全部复位
          /* 🔴 第三轮教训（2026-10-29）：挂在 app.ticker 上写参数**不生效**
           * （对照组 BrowLY=-1 脸上纹丝不动），哪怕 readback 证明值写进去了。
           * 帧流程（cubism5.es.js InternalModel.update）：motion → expression →
           * eyeBlink → saveParameters → breath → physics → pose → focus →
           * **emit('beforeModelUpdate') → model.update()**。
           * 只有赶在 model.update() 之前的写入才会被这一帧采用 ——
           * 库专门留了这个事件，就是给"每帧改参数"用的正解入口。 */
          const im = () => live.model()?.internalModel;
          /* 🔴 第五轮之后的关键实验（2026-10-29）：不走 `setParameterValueById`，
           * 直接写 **Core 原始数组** `core._model.parameters.values`（按
           * `core._model.parameters.ids` 查索引 —— 这是 A8Chann 那份引擎笔记
           * 点名要求的查名方式）。原因见本轮结论：框架的
           * `getParameterIndex` 拿字符串与 CubismId **对象**做 `!=` 比较，
           * 字符串永远 miss → 落进「不存在参数」幻影表 → 渲染永远读不到。 */
          const hook = () => {
            if (!active) return;
            const m = im()?.coreModel?._model;
            if (!m) return;
            for (const [id, v] of active.p) {
              const idx = m.parameters.ids.indexOf(id);
              if (idx >= 0) m.parameters.values[idx] = v;
            }
          };
          im()?.on('beforeModelUpdate', hook);

          for (const c of CASES) {
            const s0 = opac();
            if (!s0) { console.log('[pet] whaleexp 拿不到 core._model'); break; }
            active = c;
            await wait(700);   // ≥40 帧：让动作/物理周期跑稳
            const s1 = opac();
            const changed = [];
            for (let i = 0; i < s0.n; i++) {
              if (Math.abs(s1.d[i] - s0.d[i]) > 0.01) {
                changed.push('d' + i + ':' + s0.d[i].toFixed(2) + '->' + s1.d[i].toFixed(2));
              }
            }
            const pchanged = [];
            for (let i = 0; i < s0.p.length; i++) {
              if (Math.abs(s1.p[i] - s0.p[i]) > 0.01) pchanged.push('p' + i + ':' + s0.p[i].toFixed(2) + '->' + s1.p[i].toFixed(2));
            }
            const s = await window.pet?.saveShot?.('whaleexp-' + c.tag);
            console.log('[pet] whaleexp', JSON.stringify({
              tag: c.tag, zh: c.zh, ink: s?.ink, drawables: s0.n,
              vtxMoved: Math.abs((s1.ver ?? 0) - (s0.ver ?? 0)) > 1e-6,
              readback: c.p.map(([id]) => id.split('Param').pop() + '=' + (live.readParam(id) ?? '?')).join(' '),
              dChanged: changed.length, dList: changed.slice(0, 8),
              pChanged: pchanged.length, pList: pchanged.slice(0, 6)
            }));
            active = null;
            await wait(400);
          }
          im()?.off('beforeModelUpdate', hook);
          console.log('[pet] whaleexp done');
        }

        /* ?snap=pat：摸头 A-B-C 全流程（真实鼠标序列 + 分阶段采样）
         *
         *  为什么必须走**真实鼠标事件**而不是直接调 patStart()：这段功能的
         *  返回值就是"手感"，而 patStart 挂在 isHeadPatTarget() 后面（要过
         *  像素命中判定）。绕开事件就等于把最容易坏的那一环跳过去了。
         *
         *  判据全不靠肉眼：
         *    ① live.pat() 的状态机真的走 rising → holding → falling
         *    ② B 段期间 headZ / bodyZ 在**摆动**（同一通道不同时刻值不同）
         *    ③ 按住到 shyMs 转 shy、到 nagMs 喊一句
         *    ④ 每阶段落一张图 —— 幅度和正负号只能看图校准
         *
         *  跑法：PET_ENTRY=debug/pet-driver.html PET_SNAPSHOT=pat <electron> .
         */
        if (new URLSearchParams(location.search).get('snap') === 'pat') {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const rd = (id) => Number((live.readParam(id) ?? 0).toFixed(3));
          const st = () => live.pat();
          const fire = (type, target, x, y) => target.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            button: 0, buttons: type === 'mouseup' ? 0 : 1,
            clientX: x, clientY: y, screenX: x + 600, screenY: y + 400
          }));

          await wait(1200);
          /* 头顶实量可能还没跑到（冷启动模型加载慢）—— 最多等 3 秒 */
          for (let i = 0; i < 20 && !(live.headTop?.() > 0); i++) await wait(150);
          const pr = live.petRect();
          const top = live.headTop?.() ?? 0;
          const span = Math.max(1, live.stageEl.clientHeight - top);
          /* 候选点：**实量头顶**之下的那条带（isHeadPatTarget 的口径）。
           * 由浅到深试 —— 最浅处只有呆毛那几根细线，像素命中可能过不去。
           * 这个自寻址是有必要的：头顶位置依赖布局，写死坐标换个窗口尺寸就失效。 */
          const cands = [0.08, 0.16, 0.24, 0.32].map((f) => [
            Math.round(pr.x + pr.w * 0.5), Math.round(top + span * f)
          ]);
          let hit = null;
          for (const [x, y] of cands) {
            fire('mousedown', live.canvas, x, y);
            if (st().state !== 'idle') { hit = { x, y }; break; }
            fire('mouseup', window, x, y);
            await wait(120);
          }
          console.log('[pet] pat probe', JSON.stringify({
            headTop: Math.round(top),
            petRect: [Math.round(pr.x), Math.round(pr.y), Math.round(pr.w), Math.round(pr.h)],
            cands, hit
          }));

          if (!(top > 0)) {
            console.log('[pet] pat FAIL 头顶还没量到 —— measureHeadTop 没跑成');
          } else if (!hit) {
            console.log('[pet] pat FAIL 四个候选点都起不了手 —— 命中判定或 isHeadPatTarget 有问题');
          } else {
            /* ---- A 段：amt 爬升 + 何时进 holding（rise=6/s → 应 ~167ms）---- */
            const trace = [];
            for (let i = 0; i < 10; i++) {
              await wait(60);
              const s = st();
              trace.push([Math.round((i + 1) * 60), s.state, Number(s.amt.toFixed(3))]);
            }
            const A = await window.pet?.saveShot?.('pat-a');

            /* ---- B 段：摆动 + 害羞 + 抗议（对齐到 3.3s，越过 shyMs/nagMs）---- */
            const sway = [];
            for (let i = 0; i < 11; i++) {
              await wait(300);
              const s = st();
              sway.push([Math.round((i + 1) * 300), s.state, Number(s.amt.toFixed(3)),
                         rd(live.P().ANGLE_Z), rd(live.P().BODY_Z), rd(live.P().CHEEK),
                         s.shy, s.nagged]);
            }
            const B = await window.pet?.saveShot?.('pat-b');

            /* ---- C 段：松手 → amt 回落（fall=1.4/s → 应 ~0.7s 归零）---- */
            fire('mouseup', window, hit.x, hit.y);
            const atUp = st();
            await wait(250);
            const C1 = await window.pet?.saveShot?.('pat-c-250');
            await wait(900);
            const after = st();
            const C2 = await window.pet?.saveShot?.('pat-c-1150');

            console.log('[pet] pat result', JSON.stringify({
              at: [hit.x, hit.y],
              trace: { fields: ['t_ms', 'state', 'amt'], rows: trace },
              sway: {
                fields: ['t_ms', 'state', 'amt', 'headZ', 'bodyZ', 'cheek', 'shy', 'nagged'],
                rows: sway
              },
              release: {
                atUpState: atUp.state, amtAtUp: Number(atUp.amt.toFixed(3)),
                afterState: after.state, amtAfter: Number(after.amt.toFixed(3))
              },
              ink: { a: A?.ink, b: B?.ink, c250: C1?.ink, c1150: C2?.ink }
            }));
          }
          console.log('[pet] pat done');
        }

        /* ?snap=tts：边收边念的端到端（真引擎）
         *
         * 有两件事在 mock 里测不到，只能在真渲染层里跑：
         *   ① 系统 TTS 引擎的 onend 到底会不会按时来（兜底定时器就是为它写的）；
         *   ② 队列在真引擎下是否真的**一条条**推进（写错了就是"只听见最后一句"，
         *      短回复听不出问题，长回复才露馅）。
         *
         * 喂法模拟真实流式：把一段回复按标点切成 7 片、每片间隔 120ms 喂进
         * feedSpeech。判据是**第一句在全部喂完之前就已经开口** —— 那就是
         * "边收边念"真的成立了（整段念的话要等所有片到齐才开始）。
         * ⚠️ 这一项**会真的出声**（用的是系统音色），不是哑测试。 */
        if (new URLSearchParams(location.search).get('snap') === 'tts') {
          const t0 = Date.now();
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          live.forceTTS();                    // 默认 tts 是关的，只改本进程内存里的 cfg
          /* ⚠️ 这个探针**强制用系统音色**跑。它验的是队列语义（边收边念 +
           *    串行推进），而 winrt 引擎在这一条上会给出**假失败**：
           *    常驻合成进程首次起来要 ~700ms，首句的"开口时间"会被这段
           *    进程启动开销推到"喂完"之后 —— 看起来像边收边念坏了，其实没有。
           *    引擎本身由 ?snap=lip 验（那里会等预热）。
           *    ⚠️ 只改这份内存里的 cfg；真实开关仍然只走主进程 patchConfig。 */
          {
            const c = live.cfg() || {};
            live.setCfg(Object.assign({}, c, {
              tts: Object.assign({}, c.tts, { enabled: true, engine: 'system' })
            }));
          }
          const spoken = [];
          live.setSpeechObserver((text, t) => spoken.push([Math.round(t - t0), text]));

          const parts = ['你好呀。', '我是阿岩，', '就住在这个角落。', '……', '你要是有', '想说的', '就敲我一下。'];
          const fedAt = [];
          for (const p of parts) {
            live.feedSpeech(p);
            fedAt.push([Math.round(Date.now() - t0), live.ttsState().queued, live.ttsState().active]);
            await wait(120);
          }
          const feedDoneAt = Math.round(Date.now() - t0);

          /* 等队列念完（真引擎读三句短话 ≈ 6~8s；不靠猜，轮询到空为止） */
          let waited = 0;
          while (waited < 20000 && live.ttsState().active) { await wait(200); waited += 200; }
          await wait(400);

          const tts = live.ttsState();
          const firstSpokenAt = spoken.length ? spoken[0][0] : null;
          const okOne = firstSpokenAt !== null && firstSpokenAt < feedDoneAt;
          const okTwo = spoken.length >= 3 && !tts.active && tts.queued === 0;
          console.log('[pet] tts result', JSON.stringify({
            voice: live.ttsVoice(),
            feed: { fields: ['t_ms', 'queued', 'active'], rows: fedAt, doneAt: feedDoneAt },
            spoken: { fields: ['t_ms', 'text'], rows: spoken },
            waitedMs: waited + 400,
            checks: {
              earlyStart: okOne,          // 首句早于"喂完"= 边收边念成立
              drained: okTwo              // 念完且队列归零 = 队列真在推进
            }
          }));
          console.log('[pet] tts', okOne && okTwo ? 'PASS' : 'FAIL');
          live.setSpeechObserver(null);
          live.stopSpeak();
          await sweep('shot-tts');
        }

        /* ?snap=lip：真口型（说话时嘴跟着真实音量动）
         *
         *  mock 验不了这一段 —— 它跨了三层：主进程 WinRT 合成 → IPC 送 wav
         *  → 渲染层 WebAudio 解码播放 → AnalyserNode 取包络 → 参数写进模型。
         *  所以这里读的是**模型参数本身**（ParamMouthOpenY），不是内部变量：
         *  参数动了才叫口型真的接上了。
         *
         *  判据（全数值，不靠看图）：
         *    ① engine 报 winrt —— 说明走的确实是新链路
         *    ② 采样期间 mouth 有**明显的起伏**（方差/峰谷差），不是恒值
         *    ③ 同一时刻 mouth ≈ ttsState().lipLevel —— 证明参数确实由包络驱动
         *    ④ 队列念完之后 mouth 收回到 0（闭嘴，不留僵嘴）
         *
         *  ⚠️ 这一项**会真的出声**。
         *  跑法：PET_ENTRY=debug/pet-driver.html PET_SNAPSHOT=lip <electron> .
         */
        if (new URLSearchParams(location.search).get('snap') === 'lip') {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const rdMouth = () => Number(live.readParam(live.P().MOUTH_OPEN) ?? 0);

          live.forceTTS();
          await wait(1500);                 // 让主进程把合成进程起好（起进程 ~700ms）

          const samples = [];
          const t0 = Date.now();
          const timer = setInterval(() => {
            const st = live.ttsState();
            samples.push({
              t: Date.now() - t0,
              mouth: Number(rdMouth().toFixed(4)),
              lip: Number((st.lipLevel ?? 0).toFixed(4)),
              active: st.active, q: st.queued
            });
          }, 50);

          for (const s of ['你好呀，', '我现在能对上口型了。', '你看，嘴巴是跟着声音动的。']) {
            live.enqueueSpeech(s);
          }

          let waited = 0;
          while (waited < 20000 && live.ttsState().active) { await wait(200); waited += 200; }
          /* 队列空之后再采 1.2 秒：看它有没有把嘴收干净（这一段最容易留僵嘴） */
          await wait(1200);
          clearInterval(timer);

          const tts = live.ttsState();
          const mouth = samples.map((s) => s.mouth);
          const maxM = Math.max(...mouth, 0);
          const minAfter = Math.min(...mouth, 0);
          const moving = mouth.filter((v) => v > 0.05).length;
          const diff = samples.map((s) => Math.abs(s.mouth - s.lip));
          const maxDiff = Math.max(...diff, 0);
          /* 峰谷差：真口型一定在"张开/闭合"之间大幅摆动；恒值（正弦波也一样）
           * 会给出一个很小的数 —— 所以它比"最大值"更能说明问题。 */
          const swing = maxM - minAfter;
          const tail = mouth.slice(-6);
          const closed = tail.every((v) => v <= 0.02);

          const checks = {
            engineWinrt: tts.engine === 'winrt',
            mouthMoving: moving >= 8,
            followsEnv: maxDiff <= 0.03,
            bigSwing: swing >= 0.15,
            closedAtEnd: closed
          };
          console.log('[pet] lip result', JSON.stringify({
            voice: live.ttsVoice(),
            engine: tts.engine,
            frames: samples.length,
            movingFrames: moving,
            max: Number(maxM.toFixed(3)),
            maxDiff: Number(maxDiff.toFixed(3)),
            swing: Number(swing.toFixed(3)),
            tail: tail.map((v) => Number(v.toFixed(3))),
            checks,
            /* 采样压成 [t, mouth*100] 方便直接看波形（整数好看） */
            wave: samples.map((s) => [s.t, Math.round(s.mouth * 100)])
          }));
          const pass = Object.values(checks).every(Boolean);
          console.log('[pet] lip', pass ? 'PASS' : 'FAIL');
          live.stopSpeak();
        }

        /* ?snap=media：看媒体感知此刻读到什么。
         *
         * 这个探针的意义只有一个 —— 回答「**真实播放器到底会不会上报歌名**」。
         * 自造的媒体会话不上报（未打包进程没有应用标识，属性写进
         * DisplayUpdater 也不进 GSMTC 视图，实测过），所以只能拿真的播放器验。
         *  ① 托盘勾上「媒体感知」，② 放一首歌，③ PET_SNAPSHOT=media 跑起来，
         *  ④ 看这里 title/artist 有没有值。
         * 采样是每 2 秒一拍，探针连采 5 拍（10 秒）足够等到一次采样。 */
        if (new URLSearchParams(location.search).get('snap') === 'media') {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const seen = [];
          for (let i = 0; i < 5; i++) {
            let m = null;
            try { m = await window.pet?.media?.(); } catch { m = null; }
            seen.push(m);
            await wait(2200);
          }
          const last = seen[seen.length - 1] || null;
          console.log('[pet] media result', JSON.stringify({
            /* 开关关着时恒 null —— 所以"全 null"要么是没开开关，要么是没在放 */
            samples: seen.length,
            nonNull: seen.filter(Boolean).length,
            last,
            hasTitle: !!(last && last.title),
            desc: (last && last.active && last.title)
              ? `${last.title}${last.artist ? ' - ' + last.artist : ''} [${last.status}]`
              : '(无歌名)'
          }));
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
