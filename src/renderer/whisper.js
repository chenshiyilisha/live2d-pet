/**
 * 碎碎念（inner whispers）—— W61
 *
 * 会话流式期间偶尔说内心独白，**由结构化结果触发**（success / error /
 * completion），**不引用模型原文**（无工具名/路径/模型文本）。
 *
 * 出处：zhu1090093659/dsh-pet（Apache-2.0）的碎碎念机制。
 * 借鉴要点：
 *   - 由结构化结果触发，不是自由生成 → 不会引用模型原文
 *   - 分类行 9s CD、结果行 5s CD（防刷屏）
 *   - 展示 TTL 8s（短展示，不长期占位）
 *   - 比 proactive 更轻更贴陪伴感
 *
 * 设计决策：
 *   - 模板池由我们手写（中文，陪伴感），不调 LLM
 *   - 每类独立 CD 计数器（success 说了，error 还能说）
 *   - 触发概率：不是每次结果都出，避免太吵
 *   - 展示在角色脚下小字（不抢气泡）
 */

/* 模板池：按触发类别分组。每组多条，随机抽。
 * 全部手写中文，陪伴感，不引用模型文本。 */
const TEMPLATES = {
  success: [
    '嘿嘿，又搞定一件～',
    '今天的我也很厉害呢',
    '主人看到结果了吗？',
    '悄悄说：这次很顺利哦',
    '圆满完成！给自己鼓个掌',
  ],
  error: [
    '哎呀，这次有点小状况…',
    '别灰心，下次一定行',
    '我陪着你，慢慢来',
    '偷偷看一眼，还在跑吗？',
    '出错了也别急，我在这儿',
  ],
  thinking: [
    '嗯…让我想想',
    '这个问题有点意思',
    '别急，我在看呢',
    '主人在忙，我就静静看着',
  ],
  idle: [
    '主人在忙呢…',
    '我就在这里陪着',
    '偷偷看着主人工作',
    '闲着也是闲着，发会儿呆',
  ],
};

/* CD 配置（毫秒）：分类行 9s，结果行 5s。 */
const CD_MS = {
  success: 9000,
  error: 9000,
  thinking: 9000,
  idle: 9000,
  completion: 5000,
};

/* 展示 TTL（毫秒） */
const TTL_MS = 8000;

/* 触发概率：不是每次结果都出。 */
const TRIGGER_PROB = {
  success: 0.6,
  error: 0.8,
  thinking: 0.3,
  idle: 0.2,
  completion: 0.5,
};

/* 每类独立 CD 计数器（timestamp）。 */
const lastShown = {};

/**
 * 判断是否该出碎碎念（CD 检查 + 概率检查）。
 * @param {string} category - 触发类别
 * @param {number} now - 当前时间戳
 * @param {Function} rand - 随机函数（默认 Math.random）
 * @returns {boolean}
 */
export function shouldShow(category, now, rand = Math.random) {
  const cd = CD_MS[category];
  if (!cd) return false;
  if (lastShown[category] && now - lastShown[category] < cd) return false;
  const prob = TRIGGER_PROB[category];
  if (prob !== undefined && rand() > prob) return false;
  return true;
}

/**
 * 抽一条碎碎念文本。
 * @param {string} category - 触发类别
 * @param {Function} rand - 随机函数
 * @returns {string|null}
 */
export function pickWhisper(category, rand = Math.random) {
  const pool = TEMPLATES[category];
  if (!pool || pool.length === 0) return null;
  return pool[Math.floor(rand() * pool.length)];
}

/**
 * 标记某类已展示（更新 CD 计数器）。
 * @param {string} category - 触发类别
 * @param {number} now - 当前时间戳
 */
export function markShown(category, now) {
  lastShown[category] = now;
}

/**
 * 重置所有 CD（测试用）。
 */
export function resetWhisper() {
  for (const k of Object.keys(lastShown)) delete lastShown[k];
}

/**
 * 渲染碎碎念到 DOM 元素。
 * @param {HTMLElement} el - 目标元素
 * @param {string} text - 碎碎念文本
 */
export function renderWhisper(el, text) {
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
}

/**
 * 隐藏碎碎念。
 * @param {HTMLElement} el - 目标元素
 */
export function hideWhisper(el) {
  if (!el) return;
  el.classList.remove('show');
}

export { TTL_MS, CD_MS };
