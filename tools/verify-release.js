'use strict';
/*
 * 发版后自检：确认 GitHub Release 上的资产与 latest.yml 完全对得上。
 *
 * 为什么必须**发完之后**再查一次：
 *   本地构建的自检只保证 dist/ 里三件套齐全。真正会出事的是「传漏了一个」
 *   或者「传上去的名字跟清单里记的不一样」——这两种错在本地完全看不出来，
 *   而后果是所有客户端静默收不到更新（electron-updater 只会在日志里
 *   丢一句 ERR_UPDATER_CHANNEL_FILE_NOT_FOUND，用户端什么都不会发生）。
 *
 * 用法：
 *   node tools/verify-release.js            # 查最新 release
 *   node tools/verify-release.js v0.1.0     # 查指定 tag
 *
 * 退出码：0 全绿 / 1 有问题（可以直接挂到 CI 上）
 *
 * ⚠️ 第 3 步要**下载** Release 上的 latest.yml 正文来比对，而资产下载域名
 * （release-assets.githubusercontent.com）在某些网络里根本连不上 —— 本机实测
 * 直连超时、本地代理也不放行，同一时刻 api.github.com 却是通的。所以下不到时
 * **自动降级**：改读本地 dist/latest.yml，再用 GitHub 返回的资产 sha256 摘要
 * 与本地文件对算，把"传上去的字节是不是本地构建的那份"补上（见 3b）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync } = require('child_process');

const OWNER = 'chenshiyilisha';
const REPO = 'live2d-pet';

let failures = 0;
const ok = (s) => console.log('  ✅ ' + s);
const no = (s) => { failures++; console.log('  ❌ ' + s); };

/* node 的 https 默认**不读** http_proxy，所以这里是直连，不用清代理变量。
 *
 * ⚠️ 必须带认证头（有令牌时）。未认证的 GitHub API 只有 **60 次/小时/IP**，
 * 用光之后所有请求都变 403，而响应体是一段**合法 JSON**（`{"message":"API rate
 * limit exceeded ..."}`）—— 本脚本早期版本没有这个头，于是把这段错误当成了
 * Release 对象，报出「tag 是 undefined / 一个资产都没有 / 缺少 latest.yml」，
 * **看起来像 Release 传坏了，其实 Release 好好的**（2026-10-12 实际踩过，
 * 差点让作者重传 114 MB）。带令牌后是 5000 次/小时。
 *
 * ⚠️ 令牌只发给 api.github.com。资产地址会 302 到
 * `release-assets.githubusercontent.com`（另一个主机），给那里带令牌属于
 * 白白泄露凭据 —— 所以按主机判断，不是无脑加。 */
function get(url, { raw = false } = {}) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const isApi = /^https:\/\/api\.github\.com\//.test(url);
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'ayan-release-check',
      Accept: raw ? '*/*' : 'application/vnd.github+json'
    };
    if (token && isApi) headers.Authorization = `Bearer ${token}`;
    const req = https.get(url, {
      headers
    }, (res) => {
      // GitHub 的 releases/download 会 302 到 objects.githubusercontent.com
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return get(res.headers.location, { raw }).then(resolve, reject);
      }
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(25000, () => { req.destroy(new Error('请求超时（25s）')); });
    req.on('error', reject);
  });
}

/* ⚠️ 两个域名要分清：`api.github.com` 与资产存储域名**不是同一个主机**。
 * API 直连能通，不代表资产文件能下 —— 资产实际存放在
 * `release-assets.githubusercontent.com`（browser_download_url 会 302 过去），
 * 在需要走代理的网络里，node 的 https **不读** http_proxy/HTTPS_PROXY，
 * 直连会在 25s 后超时（本机实测如此；同一时刻 curl 走代理 7.7s 就下完了）。
 *
 * 所以下文本一律：先原生 https（CI 上直连够快），失败退回 curl（读代理）。
 * 只在"取 latest.yml 正文"这一处用到，量很小。 */
function fetchText(url) {
  return get(url, { raw: true }).catch((err) => {
    try {
      const out = execFileSync('curl', ['-sL', '--max-time', '90', url], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
      });
      return { status: 200, body: out };
    } catch (e2) {
      throw new Error(`原生 https 失败（${err.message}），curl 回落也失败（${e2.message}）`);
    }
  });
}

(async () => {
  const wanted = process.argv[2] || '';
  const apiUrl = wanted
    ? `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${wanted}`
    : `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

  console.log(`检查 ${OWNER}/${REPO} ${wanted || '(latest)'}`);
  console.log('');

  let rel;
  try {
    const r = await get(apiUrl);
    if (r.status === 404) {
      console.log(wanted ? `  ❌ 找不到 tag ${wanted}` : '  ❌ 这个仓库还没有发布过任何 Release');
      console.log('');
      console.log('自动更新完全依赖 Release —— 没有 Release，客户端点「检查更新」只会得到');
      console.log('「还没有发布过任何版本」。先建一个再回来跑这个脚本。');
      process.exit(1);
    }
    rel = JSON.parse(r.body);

    /* 拦一段"能解析、但根本不是 Release"的 JSON —— 最常见的是限流
     * （403 + {"message":"API rate limit exceeded ..."}）和 401（令牌无效）。
     * 不拦这一下，下面所有检查都会拿 undefined 去判，报出
     * 「tag 是 undefined / 一个资产都没有 / 缺少 latest.yml」这类**假故障**，
     * 让人以为 114 MB 白传了、要重传。 */
    if (!rel || !rel.tag_name) {
      const msg = (rel && rel.message) || r.body.slice(0, 200);
      no(`拉不到 Release 对象（HTTP ${r.status}）：${msg}`);
      console.log('');
      if (/rate limit/i.test(r.body)) {
        console.log('  → 未认证请求上限 60 次/小时/IP，已用尽。带上令牌重跑：');
        console.log(`     GH_TOKEN=<PAT> node tools/verify-release.js ${wanted}`.trimEnd());
      } else if (r.status === 401) {
        console.log('  → 令牌无效或已过期。');
      } else if (r.status === 403) {
        console.log('  → 权限不足（Fine-grained PAT 需要该仓库的 Contents: Read）。');
      }
      process.exit(1);
    }
  } catch (err) {
    no('拉取 Release 失败：' + err.message);
    console.log('（网络不通的话换一下网络环境再试）');
    process.exit(1);
  }

  console.log(`Release: ${rel.tag_name}  «${rel.name || '(无标题)'}»`);
  console.log(`发布: ${rel.published_at}   草稿: ${rel.draft}   预发布: ${rel.prerelease}`);
  console.log('');

  console.log('1. tag 形式');
  if (/^v\d+\.\d+\.\d+$/.test(rel.tag_name)) ok(`tag 是 v<版本> 形式：${rel.tag_name}`);
  else no(`tag 应该是 v<版本> 形式（如 v0.1.0），现在是 ${rel.tag_name}。electron-updater 按 releases/download/<tag>/ 拼地址，tag 不对什么都下不到`);

  if (rel.draft) no('这个是草稿（draft），草稿对客户端不可见，更新会失败');
  if (rel.prerelease) console.log('  ⚠️  这是预发布版本，只有开了 allowPrerelease 的客户端才会收到');

  console.log('');
  console.log('2. 资产清单');
  const assets = rel.assets || [];
  if (!assets.length) no('Release 上一个资产都没有');
  for (const a of assets) console.log(`   - ${a.name}  ${(a.size / 1048576).toFixed(2)} MB`);

  console.log('');
  console.log('3. latest.yml');
  const ymlAsset = assets.find((a) => a.name === 'latest.yml');
  if (!ymlAsset) {
    no('Release 上缺少 latest.yml —— 这是最致命的一种：所有客户端静默收不到更新');
    process.exit(1);
  }
  ok('latest.yml 在 Release 上');

  /* 优先拿 Release 上的正文比。下不到就降级 —— 这一步失败**不代表**发版有问题，
   * 只说明当前网络到资产存储域名不通，别因此去重传 114 MB。（详见文件头注释） */
  let ymlText = '';
  let ymlFromLocal = false;
  try {
    ymlText = (await fetchText(ymlAsset.browser_download_url)).body;
  } catch (err) {
    const localYml = path.join(__dirname, '..', 'dist', 'latest.yml');
    if (!fs.existsSync(localYml)) {
      no(`下不到 Release 上的 latest.yml（${err.message}），本地也没有 dist/latest.yml 可比`);
      process.exit(1);
    }
    console.log('  ⚠️  下不到 Release 上的 latest.yml，改用本地 dist/latest.yml 比对');
    console.log(`     （${err.message}）`);
    console.log('     这多半是当前网络到资产存储域名不通，不是发版出错；下面 3b 会补内容级校验。');
    ymlText = fs.readFileSync(localYml, 'utf8');
    ymlFromLocal = true;
  }
  const ymlVersion = (ymlText.match(/^version:\s*(.+)$/m) || [])[1]?.trim();
  const ymlPath = (ymlText.match(/^path:\s*(.+)$/m) || [])[1]?.trim();
  const ymlSha = (ymlText.match(/^sha512:\s*(.+)$/m) || [])[1]?.trim();
  const fileUrls = [...ymlText.matchAll(/^\s*-\s*url:\s*(.+)$/gm)].map((m) => m[1].trim());

  console.log(`   清单里：version=${ymlVersion}  path=${ymlPath}`);

  /* 3b：只在降级路径上跑。GitHub 从 2025 起给每个资产带 sha256 摘要
   * （assets[].digest），拿它与本地 dist/ 里的同名文件对算，等价于确认
   * 「远端存的就是本地构建的那一份字节」—— 比只比文件名和大小强得多，
   * 能拦住"把上一次的旧 exe 传上去"这种最阴的错。 */
  if (ymlFromLocal) {
    console.log('');
    console.log('3b. 远端资产与本地构建产物逐字节比对');
    const hashFile = (f) => new Promise((res, rej) => {
      const h = crypto.createHash('sha256');
      const rs = fs.createReadStream(f, { highWaterMark: 4 * 1024 * 1024 });
      rs.on('data', (c) => h.update(c));
      rs.on('end', () => res(h.digest('hex')));
      rs.on('error', rej);
    });
    for (const a of assets) {
      const localFile = path.join(__dirname, '..', 'dist', a.name);
      if (!fs.existsSync(localFile)) {
        console.log(`   ℹ️  ${a.name}：本地 dist/ 里没有同名文件，跳过内容比对`);
        continue;
      }
      const localSize = fs.statSync(localFile).size;
      if (localSize !== a.size) { no(`${a.name} 大小不一致：远端 ${a.size} / 本地 ${localSize}`); continue; }
      if (a.digest && /^sha256:/.test(a.digest)) {
        const localDigest = 'sha256:' + (await hashFile(localFile));
        if (localDigest === a.digest) ok(`${a.name}：字节级一致（${(a.size / 1048576).toFixed(2)} MB，sha256 对得上）`);
        else no(`${a.name} sha256 不一致：远端 ${a.digest} / 本地 ${localDigest}`);
      } else {
        ok(`${a.name}：大小一致（${(a.size / 1048576).toFixed(2)} MB，服务端未给摘要）`);
      }
    }
  }

  console.log('');
  console.log('4. 清单里提到的文件都在 Release 上');
  if (!fileUrls.length) no('latest.yml 里没有 files[].url');
  for (const u of fileUrls) {
    const has = assets.some((a) => a.name === u);
    if (has) ok(`资产存在：${u}`);
    else no(`清单引用了 ${u}，但 Release 上没有这个资产（下载时会 404）`);
  }
  if (ymlPath && !fileUrls.includes(ymlPath)) {
    const has = assets.some((a) => a.name === ymlPath);
    if (has) ok(`path 字段对应的资产存在：${ymlPath}`);
    else no(`path 字段指向 ${ymlPath}，但 Release 上没有这个资产`);
  }

  console.log('');
  console.log('5. 差量更新用的 blockmap');
  const bm = assets.find((a) => a.name.endsWith('.blockmap'));
  if (bm) ok(`blockmap 在：${bm.name}`);
  else console.log('  ⚠️  没有 .blockmap —— 不是致命错，但每次更新都会退回全量下载（114 MB）');

  console.log('');
  console.log('6. 给源码用户的模型包');
  const mz = assets.find((a) => a.name === 'models.zip');
  if (mz) ok(`models.zip 在：${(mz.size / 1048576).toFixed(2)} MB`);
  else console.log('  ⚠️  没有 models.zip —— 不影响自动更新，但从源码跑的人拿不到 Live2D 模型');

  console.log('');
  console.log('7. 版本一致性');
  const tagVer = rel.tag_name.replace(/^v/, '');
  if (ymlVersion && ymlVersion !== tagVer) no(`latest.yml 的 version (${ymlVersion}) 与 tag (${tagVer}) 不一致`);
  else if (ymlVersion) ok(`latest.yml 的 version 与 tag 一致：${ymlVersion}`);
  const pkgVer = require('../package.json').version;
  if (ymlVersion && ymlVersion !== pkgVer) {
    console.log(`  ℹ️  本地 package.json 是 ${pkgVer}，Release 上是 ${ymlVersion}（发新版之后就正常了）`);
  }

  console.log('');
  if (failures) {
    console.log(`❌ ${failures} 项有问题，客户端可能收不到更新`);
    process.exit(1);
  }
  console.log('✅ Release 自检通过，自动更新链路应该能跑通');
})().catch((err) => {
  console.error('\n脚本异常：', err.message);
  process.exit(1);
});
