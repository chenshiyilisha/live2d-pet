'use strict';

/* ============================================================
 *  模型目录（连接预设）
 * ==========================================================
 *
 *  这一层**只有数据与纯函数**：预设表、端点判定、WorkBuddy 的
 *  models.json 解析。不 require electron、不碰窗口、不落盘 ——
 *  于是 `debug/verify-llm-providers.js` 能直接 node 跑它做断言。
 *
 *  为什么需要这一层（原先只有 baseUrl/apiKey/model 三个手填字段）：
 *  「换一家的模型」在旧版要用户自己去文档里抄一遍地址、再猜模型名，
 *  填错的表现是**没反应**（stall 20s 后超时才报），排查成本极高。
 *  预设表把「地址 + 常见模型名」固定下来，选中即落盘。
 *
 *  ⚠️ 预设里的 baseUrl 一律是**到 /v1 这一级**（不带 /chat/completions）——
 *     llm.js 里是 `${baseUrl}/chat/completions` 拼的。WorkBuddy 的
 *     models.json 存的恰恰是**完整路径**，所以 fromWorkBuddyModels() 要反过来剥。
 *
 *  ⚠️ 这份表**不是**能力声明。哪一家能用、模型名写没写对，只有真发一句
 *     才知道（见 main.js 的 testLlm）—— 别在 UI 上给未验证的条目打勾。
 * ========================================================== */

/* 场景默认超时（M9）。云端首字快、本地冷启动慢 —— 切预设时带上，
 * 用户仍可在「模型设置」里改。数值与 llm.js 的 LLM_TIMEOUT 对齐。 */
const TIMEOUT_CLOUD = { stallMs: 20000, totalMs: 120000 };
const TIMEOUT_LOCAL = { stallMs: 45000, totalMs: 180000 };

/* 预设目录。顺序 = 菜单顺序，把最常用的放前面。
 *
 * 选谁进这张表的标准：① 国内可直接访问 ② 有 OpenAI 兼容端点
 * ③ 名字稳定（不随版本改名）。故意**不**放需要额外协议适配的家
 * （Gemini 原生 / Anthropic 原生）—— 那要另写一套客户端，违反
 * 「非 OpenAI 协议不各写一套」的既定取舍。
 *
 * M8：featured = 托盘顶层直接露出；其余收进「更多…」。
 *     默认露出 DeepSeek / 通义兼容 / 两家本地 / 自定义。 */
const PROVIDERS = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    featured: true
  },
  {
    id: 'qwen',
    label: '通义千问（兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
    featured: true
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys'
  },
  {
    id: 'kimi',
    label: 'Kimi（Moonshot）',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys'
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak'
  },
  {
    /* 讯飞星辰 MaaS（2026-10-30 用户接入 Spark-X2.6 时实测）：
     * OpenAI 兼容端点 `…/v2/chat/completions`，baseUrl 到 /v2 这一级。
     * 默认带思维链：请求体顶层 `enable_thinking:false` 可关（extraBody
     * 正是顶层平铺，现有配置里的 `{enable_thinking:false}` 直接生效；
     * ⚠️ 流式下 `extra_body` 里的同名键被忽略，只能走顶层）。 */
    id: 'xfyun',
    label: '讯飞星辰 MaaS',
    baseUrl: 'https://maas-api.cn-huabei-1.xf-yun.com/v2',
    model: 'spark-x2.6',
    keyUrl: 'https://maas.xfyun.cn/modelService'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-chat',
    keyUrl: 'https://openrouter.ai/keys'
  },
  /* 本地端的价值不只是"不花钱"：**断网也能聊**，而且 apiKey 为空是合法的
   * （llm.js 的离线话术判定按 isLocalUrl 放行，见 isUsable）。 */
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    local: true,
    featured: true
  },
  {
    id: 'lmstudio',
    label: 'LM Studio（本地）',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    local: true,
    featured: true
  },
  /* 兜底：地址与模型名都自己填。切到它只改 provider 标签，
   * 不覆盖用户已经手填好的 baseUrl / model —— 否则一次误点就把配置清了。 */
  { id: 'custom', label: '自定义（手填地址）', baseUrl: '', model: '', custom: true, featured: true }
];

function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

/* 这个地址是不是本机。
 *
 * 🔴 判定要覆盖写法差异：`127.0.0.1` / `localhost` / `[::1]` 都是本机，
 *    而 `0.0.0.0` 在有些客户端里也被当成本机在听。**只认 hostname**，
 *    不要拿整串 url 做 includes —— `https://api.example.com/localhost-proxy`
 *    这种路径里带 localhost 的会误判，后果是「没有 key 也去发请求」。 */
function isLocalUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) return false;
  let u;
  try {
    u = new URL(baseUrl.trim());
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
}

/* 当前配置「能不能真的发请求」。
 *
 * 唯一的真相点 —— llm.js 的离线话术判定、main.js 的记忆抽取、
 * 渲染层的"能不能聊"提示，全走这里。分散判会出现「本地端点那边能聊、
 * 记忆抽取却静默不跑」这种半通状态。 */
function isUsable(llm) {
  const baseUrl = llm?.baseUrl ?? '';
  if (typeof llm?.apiKey === 'string' && llm.apiKey.trim()) return true;
  return isLocalUrl(baseUrl);
}

/* W16：就绪 = 可用 + 真测绿标（Coopanion / Nexus「测一句才算连上」）。
 * 看屏（G23）始终要 ready；普通对话仅当 llm.requireTested 时才卡。 */
function isLlmReady(llm) {
  return isUsable(llm) && isTestGreen(llm);
}

/* 当前生效的是哪条预设。
 *
 * 优先信 `llm.provider`；**旧配置没有这个键**（这个字段是 2026-10-29 才加的），
 * 那就按 baseUrl 反查 —— 否则老用户菜单里会一条都不打勾、标题显示成裸 host，
 * 看起来像"配置丢了"。两边都对不上才是自定义。 */
function currentProviderId(llm) {
  const id = llm?.provider;
  if (typeof id === 'string' && providerById(id)) return id;
  if (id === 'workbuddy') return 'workbuddy';
  const base = typeof llm?.baseUrl === 'string' ? llm.baseUrl.trim().replace(/\/+$/, '') : '';
  if (base) {
    const hit = PROVIDERS.find((p) => !p.custom && p.baseUrl === base);
    if (hit) return hit.id;
  }
  return 'custom';
}

/* 场景超时建议（M9）：本机抬 stall/total，云端用短默认。 */
function suggestTimeouts(baseUrlOrLocal) {
  const local = typeof baseUrlOrLocal === 'boolean'
    ? baseUrlOrLocal
    : isLocalUrl(baseUrlOrLocal);
  return local ? { ...TIMEOUT_LOCAL } : { ...TIMEOUT_CLOUD };
}

/* 把一条预设转成要写进 config.llm 的那几个键。
 * custom 不覆盖地址/模型（见表里的注释）。
 * 非 custom 顺带写场景超时（M9）—— 用户仍可在设置页改。 */
function toPatch(provider) {
  if (!provider || typeof provider !== 'object') return null;
  if (provider.custom) return { provider: provider.id };
  return {
    provider: provider.id,
    baseUrl: provider.baseUrl,
    model: provider.model,
    ...suggestTimeouts(!!provider.local)
  };
}

/* M8：自测绿标指纹。只认 baseUrl+model（key 轮换不该掉绿）。 */
function testFingerprint(llm) {
  const base = typeof llm?.baseUrl === 'string' ? llm.baseUrl.trim().replace(/\/+$/, '') : '';
  const model = typeof llm?.model === 'string' ? llm.model.trim() : '';
  return `${base}\u0000${model}`;
}

function isTestGreen(llm) {
  const t = llm?.tested;
  if (!t || typeof t !== 'object') return false;
  const fp = testFingerprint(llm);
  return !!fp && fp !== '\u0000' && testFingerprint(t) === fp;
}

function featuredProviders() {
  return PROVIDERS.filter((p) => p.featured);
}

function moreProviders() {
  return PROVIDERS.filter((p) => !p.featured);
}

/* WorkBuddy（与 CodeBuddy）的自定义模型文件 → 我们的条目。
 *
 * 官方 schema（workbuddy.cn/docs/cli/models）：{ models: [{ id, name, vendor,
 * apiKey, url, ... }] }，其中 **url 是完整接口路径**，一般以
 * `/chat/completions` 结尾（例：https://api.openai.com/v1/chat/completions）。
 * 我们这边要的是 baseUrl，所以反过来剥掉那段；剥不掉就原样保留
 * （有些网关的 baseUrl 本身就带前缀，硬剥会把地址改坏）。
 *
 * apiKey 允许写 `${ENV_NAME}` 引用环境变量。**我们不解析它** ——
 * 解析就得在进程里持有密钥，而这份文件的语义是"由 WorkBuddy 自己解析"；
 * 原样搬过来，真发请求时失败会明确报 401，不会静默。
 *
 * 返回 [] 表示"文件里没有可用条目"（文件不存在 / 空数组 / 全都不合法），
 * 调用方据此提示，不要抛异常 —— 读别人的配置文件失败不是本程序的错。 */
const CHAT_SUFFIX = '/chat/completions';

function fromWorkBuddyModels(raw) {
  let doc = raw;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(doc) ? doc : Array.isArray(doc?.models) ? doc.models : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!id || !url) continue;
    /* 先吃尾斜杠再判后缀 —— 顺序反了就会漏掉 `…/chat/completions/` 这种写法
     * （实测见 verify-llm-providers 的第一版：它被原样搬过去，结果拼成
     *  `…/chat/completions/chat/completions`，服务端 404，而 UI 看不出异常）。 */
    const trimmed = url.replace(/\/+$/, '');
    const baseUrl = trimmed.toLowerCase().endsWith(CHAT_SUFFIX)
      ? trimmed.slice(0, -CHAT_SUFFIX.length).replace(/\/+$/, '')
      : trimmed;
    const key = `${baseUrl}\u0000${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const vendor = typeof item.vendor === 'string' ? item.vendor.trim() : '';
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
    out.push({
      id,
      label: vendor ? `${name}（${vendor}）` : name,
      baseUrl,
      model: id,
      apiKey: typeof item.apiKey === 'string' ? item.apiKey : '',
      /* 给 UI 用：这条 key 是个环境变量占位符，不是真 key。 */
      keyIsRef: /^\$\{[^}]+\}$/.test(String(item.apiKey ?? '').trim())
    });
  }
  return out;
}

module.exports = {
  PROVIDERS,
  TIMEOUT_CLOUD,
  TIMEOUT_LOCAL,
  providerById,
  currentProviderId,
  isLocalUrl,
  isUsable,
  isLlmReady,
  toPatch,
  suggestTimeouts,
  testFingerprint,
  isTestGreen,
  featuredProviders,
  moreProviders,
  fromWorkBuddyModels
};
