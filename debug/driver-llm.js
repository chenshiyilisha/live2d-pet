/* 端到端对话驱动：在**真实的桌宠页面**里，从输入框打进一条消息，
 * 走完「sendMessage → 主进程 → 对话后端 → 流式分片 → 气泡 + 表情」整条链路。
 *
 * ⚠️ 必须从 #input + #send 进，**不能**直接调 window.pet.chat()：
 *    直接调 chat() 会绕过 sendMessage() 里那一串 UI 副作用 —— 气泡的
 *    'hidden' 类没人摘（onChunk 只摘 'waiting'），结果截图里根本没有气泡，
 *    看起来像"功能坏了"，其实是测试脚手架自己绕掉了真实路径。
 *    （第一版就栽在这，pet-llm-1.png 三张全没气泡，表情倒是变了。）
 *
 * 和 debug/llm-probe.js 的分工：
 *   - llm-probe.js 只驱动 src/main/llm.js，验"网络 + 解析"这一层；
 *   - 这里验**胶水**：配置读的是不是那一份、chat:chunk 有没有正确投到
 *     主 frame、气泡/表情/历史这些渲染层不变量有没有被顶掉。
 *
 * 跑法（⚠️ 不要传 --user-data-dir，那样读的是临时配置，测不到真配置）：
 *   ./debug/gen-driver.sh driver-llm.js
 *   unset ELECTRON_RUN_AS_NODE
 *   PET_ENTRY=debug/pet-driver.html \
 *     ./node_modules/electron/dist/electron.exe . 2>&1 | tee debug/_drv-llm.log
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const log = (...a) => console.log('[drv-llm]', ...a);

  const emotions = [];
  window.pet.onEmotion((e) => emotions.push(e));

  /* 自己也订阅一份分片 —— 用来分层定位截断：
   *   我收到的 = 主进程发出来的（llm 层 + IPC）
   *   DOM 里的 = 渲染层真正落到气泡上的（pet.js 的 replyBuffer）
   * 两者一比就知道问题在哪一层。 */
  let myChunks = [];
  let myTtft = null;
  let myT0 = 0;
  window.pet.onChunk((t) => {
    if (myTtft === null && t) myTtft = Date.now() - myT0;
    myChunks.push(t);
  });

  const $ = (id) => document.getElementById(id);
  const bubble = $('bubble');
  const bubbleText = $('bubble-text');
  const input = $('input');

  await sleep(9000); // 等 Live2D 装载

  // 第一件事：确认应用读到的**确实是**刚配的那份配置。
  const cfg = await window.pet.getConfig();
  log('后端 baseUrl =', cfg?.llm?.baseUrl);
  log('后端 model   =', cfg?.llm?.model);
  log('后端 apiKey  =', cfg?.llm?.apiKey ? '已配置 ***' : '(空 → 会走离线话术)');
  log('extraBody    =', JSON.stringify(cfg?.llm?.extraBody || null));

  /* 往输入框塞字、点真按钮，然后等这轮说完。
   * ⚠️ "说完"的判定必须宽：'waiting' 类在**首个分片**就被摘掉了（onChunk 里），
   *    不能拿它当结束信号；情绪标签也在**流的末尾**才发过来，判定太急的话
   *    文本停在半句、情绪永远是空 —— 第一版就这两条一起误报过。
   *    所以这里要求文本连续 1.2s 不再变才算完。
   * ⚠️ 浮窗模式（chat.floatBubble，默认开）下主窗 #bubble 刻意不画
   *    （气泡在头顶上方的独立小窗，那个 DOM 这里够不着）——
   *    "说完"判定改用自己订阅的分片流，#bubble 的断言反过来：
   *    它应该一直藏着。2026-10-13 曾按旧判定连报 9 个 ❌，全是误报。 */
  const floatMode = cfg?.chat?.floatBubble !== false;
  if (floatMode) log('气泡模式 = 头顶悬浮小窗（主窗 #bubble 应保持隐藏）');
  const ask = async (q, tag) => {
    emotions.length = 0;
    myChunks = [];
    myTtft = null;
    myT0 = Date.now();
    input.value = q;
    const t0 = Date.now();
    let ttft = null;
    $('send').click();

    const STABLE_MS = 1200;
    let last = '';
    let lastChange = Date.now();
    for (let i = 0; i < 400; i++) {
      await sleep(50);
      const t = floatMode ? myChunks.join('') : bubbleText.textContent;
      if (t && ttft === null) ttft = Date.now() - t0;
      if (t !== last) { last = t; lastChange = Date.now(); }
      else if (Date.now() - lastChange >= STABLE_MS && (floatMode || !bubble.classList.contains('waiting'))) break;
      if (Date.now() - t0 > 60000) break;
    }
    // 再确认一次真的没在动了（防止刚好卡在两个分片之间）
    const before = floatMode ? myChunks.join('') : bubbleText.textContent;
    await sleep(600);
    const finalText = floatMode ? myChunks.join('') : bubbleText.textContent;
    if (finalText !== before) log('  ⚠️ 判定结束时其实还在出字（快照不准）');
    const total = Date.now() - t0;
    const visible = !bubble.classList.contains('hidden');

    log(`问「${q}」→ 首字 ${ttft === null ? '无输出' : ttft + 'ms'} | 共 ${total}ms | 主窗气泡可见=${visible}${floatMode ? '（预期 false）' : ''}`);
    log(`  我收到的(${myChunks.length}片, ${myTtft===null?'-':myTtft+'ms'}) = ${JSON.stringify(finalText)}`);
    if (!floatMode) log(`  DOM 气泡 = ${JSON.stringify(finalText)}`);
    if (!floatMode && myChunks.join('') !== finalText) log('  ❌ 主进程发的和气泡上的不一致 → 截断发生在渲染层');
    log(`  情绪序列 = ${JSON.stringify(emotions)}`);
    if (ttft === null) log('  ❌ 一个字都没吐出来');
    if (floatMode) {
      if (visible) log('  ❌ 浮窗模式下主窗 #bubble 却亮着（不该画）');
    } else if (!visible) {
      log('  ❌ 说完话气泡却是藏着的');
    }
    if (/\[emo:/i.test(last)) log('  ❌ 气泡里残留了未剥离的情绪标签');
    if (emotions.length === 0) log('  ⚠️ 没有收到任何情绪（表情不会变）');
    if (tag) {
      await window.pet.saveShot(tag);
      log('  截图 debug/pet-' + tag + '.png');
    }
    // 等气泡自动收起，别让两轮叠在一起
    await sleep(1500);
    return last;
  };

  await ask('在吗', 'llm-1');
  await ask('今天有点累', 'llm-2');
  await ask('那你陪我说两句', 'llm-3');

  log('done');
})().catch((e) => console.log('[drv-llm] EXCEPTION ' + ((e && e.stack) || e)));
