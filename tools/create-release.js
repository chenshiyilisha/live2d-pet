'use strict';
/*
 * 建 GitHub Release 并把自动更新三件套上传上去。
 *
 * 为什么不能用 git 干这件事：Release 不是 git 对象，资产也不走 git 协议。
 * 没有 API 授权，就只能去网页一张一张拖（114 MB 断了还得从头来）。
 *
 * 用法：
 *   GH_TOKEN=github_pat_xxx node tools/create-release.js --notes <发布说明.md>
 *
 * 令牌：Fine-grained PAT，Repository access 选 `chenshiyilisha/live2d-pet`，
 * Repository permissions 里只勾 **Contents: Read and write**
 * （建 release 和上传 asset 都算 contents 写）。用完请立刻撤销。
 *
 * 设计上的两个刻意选择：
 *
 * 1) **先建草稿，传完再发布。** 否则中途失败会留下一个"有 latest.yml 却没有 exe"
 *    的公开 Release —— 客户端在这个窗口期点更新会下载失败。
 *
 * 2) **可重跑。** 上传 114 MB 在慢网络上很容易断。脚本会先查同名 Release 并复用，
 *    再删掉同名的旧资产重新上传，所以中断后直接重跑就行，不会报"资产已存在"。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const OWNER = 'chenshiyilisha';
const REPO = 'live2d-pet';
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token) {
  console.error('缺少令牌。用法：');
  console.error('  GH_TOKEN=github_pat_xxx node tools/create-release.js --notes <发布说明.md>');
  console.error('');
  console.error('令牌建法：https://github.com/settings/personal-access-tokens/new');
  console.error('  Repository access  → Only select repositories → chenshiyilisha/live2d-pet');
  console.error('  Permissions        → Repository permissions → Contents: Read and write');
  console.error('  Expiration         → 7 days（用完立刻撤销）');
  process.exit(1);
}

const argv = process.argv.slice(2);
const notesIdx = argv.indexOf('--notes');
const notesFile = notesIdx >= 0 ? argv[notesIdx + 1] : '';

function request(method, host, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const h = {
      'User-Agent': 'ayan-release',
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      ...headers
    };
    if (payload !== undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ method, host, path: urlPath, headers: h }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json = null;
        try { json = d ? JSON.parse(d) : null; } catch { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: d, json });
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('请求超时（60s）')));
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/* 上传走 uploads.github.com（和 api.github.com 不是同一个域名，别搞混）。 */
function uploadAsset(releaseId, filePath, name) {
  return new Promise((resolve, reject) => {
    const size = fs.statSync(filePath).size;
    let sent = 0;
    let lastPct = -1;

    const req = https.request({
      method: 'POST',
      host: 'uploads.github.com',
      path: `/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      headers: {
        'User-Agent': 'ayan-release',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': size
      }
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { /* 非 JSON */ }
        process.stdout.write('\r      ');
        resolve({ status: res.statusCode, body: d, json });
      });
    });

    /* 不设总时长上限（慢网络传 114 MB 要几分钟），但"完全没动静"要能断开：
     * setTimeout 是空闲超时，每有数据流过就重置。 */
    req.setTimeout(120000, () => req.destroy(new Error('上传空闲超时（120s 无数据）')));
    req.on('error', reject);

    const rs = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    rs.on('data', (chunk) => {
      sent += chunk.length;
      const pct = Math.floor((sent / size) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct - (pct % 10);
        process.stdout.write(`\r      ${String(pct).padStart(3)}%`);
      }
    });
    rs.on('error', reject);
    rs.pipe(req);
  });
}

(async () => {
  const pkg = require(path.join(ROOT, 'package.json'));
  const tag = `v${pkg.version}`;
  const exeName = `Ayan-Setup-${pkg.version}.exe`;

  /* 顺序有讲究：latest.yml 排第一。它是客户端读的第一个文件，
   * 万一中途断了，至少清单是齐的。
   *
   * models.zip 排最后：它不参与自动更新（更新只看 latest.yml + exe + blockmap），
   * 只是给"从源码跑的人"提供模型 —— 仓库里不含模型素材（版权归 Live2D Inc.）。 */
  const assets = [
    { file: path.join(DIST, 'latest.yml'), name: 'latest.yml' },
    { file: path.join(DIST, `${exeName}.blockmap`), name: `${exeName}.blockmap` },
    { file: path.join(DIST, exeName), name: exeName },
    { file: path.join(DIST, 'models.zip'), name: 'models.zip' }
  ];

  console.log(`发布 ${OWNER}/${REPO}  tag=${tag}`);
  console.log('');
  console.log('本地待传文件：');
  let bad = 0;
  for (const a of assets) {
    const exists = fs.existsSync(a.file);
    if (!exists) bad++;
    const size = exists ? (fs.statSync(a.file).size / 1048576).toFixed(2) + ' MB' : '(缺失)';
    console.log(`  ${exists ? '✓' : '✗'} ${a.name.padEnd(38)} ${size}`);
  }
  if (bad) {
    console.error('\n先跑 pnpm run build（出三件套）和 pnpm run models（出 models.zip）把产物补齐。');
    process.exit(1);
  }

  let notes = '';
  if (notesFile && fs.existsSync(notesFile)) {
    notes = fs.readFileSync(notesFile, 'utf8');
    console.log(`\n发布说明：${notesFile}（${notes.length} 字符）`);
  } else {
    console.log('\n⚠️  没有发布说明（--notes 没给或文件不存在），Release 正文会是空的');
  }

  // ---- 查/建 Release ----
  console.log('\n1. 查这个 tag 有没有现成的 Release');
  const found = await request('GET', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/tags/${tag}`);
  let rel = found.status === 200 ? found.json : null;

  if (rel) {
    console.log(`   已存在：#${rel.id}  draft=${rel.draft}  资产 ${rel.assets.length} 个`);
    if (!rel.draft) {
      console.log('   这是已发布的 Release，本次只补传缺失的资产。');
    }
  } else {
    console.log('   没有，建一个草稿');
    const created = await request('POST', 'api.github.com', `/repos/${OWNER}/${REPO}/releases`, {
      body: { tag_name: tag, name: `阿岩 ${tag}`, body: notes, draft: true, prerelease: false }
    });
    if (created.status !== 201) {
      console.error(`   建 Release 失败 HTTP ${created.status}: ${created.body.slice(0, 300)}`);
      process.exit(1);
    }
    rel = created.json;
    console.log(`   已建草稿 #${rel.id}`);
  }

  // ---- 删同名旧资产（让脚本可重跑）----
  console.log('\n2. 清理同名旧资产');
  let removed = 0;
  for (const a of assets) {
    const old = (rel.assets || []).find((x) => x.name === a.name);
    if (!old) continue;
    const del = await request('DELETE', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/assets/${old.id}`);
    if (del.status === 204) { removed++; console.log(`   删掉旧的 ${a.name}`); }
    else console.log(`   ⚠️ 删 ${a.name} 返回 HTTP ${del.status}`);
  }
  if (!removed) console.log('   （没有需要清理的）');

  // ---- 上传 ----
  console.log('\n3. 上传');
  for (const a of assets) {
    const mb = (fs.statSync(a.file).size / 1048576).toFixed(2);
    process.stdout.write(`   传输 ${a.name}  (${mb} MB)\n`);
    const t0 = Date.now();
    const r = await uploadAsset(rel.id, a.file, a.name);
    if (r.status !== 201) {
      console.error(`\n   ❌ ${a.name} 上传失败 HTTP ${r.status}：${r.body.slice(0, 300)}`);
      console.error('   脚本可以重跑：重跑会复用这个草稿 Release 并覆盖同名资产。');
      process.exit(1);
    }
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`      ✓ 完成（${sec}s，服务端记到 ${(r.json.size / 1048576).toFixed(2)} MB）`);
  }

  // ---- 发布 ----
  if (rel.draft) {
    console.log('\n4. 取消草稿、正式发布');
    const pub = await request('PATCH', 'api.github.com', `/repos/${OWNER}/${REPO}/releases/${rel.id}`, {
      body: { draft: false }
    });
    if (pub.status !== 200) {
      console.error(`   发布失败 HTTP ${pub.status}：${pub.body.slice(0, 300)}`);
      console.error('   资产已经传完了，去网页点一下 Publish 也可以。');
      process.exit(1);
    }
    console.log('   已发布');
  } else {
    console.log('\n4. 本来就是发布状态，跳过');
  }

  console.log('');
  console.log('✅ 完成');
  console.log(`   Release：https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
  console.log('');
  console.log('下一步： node tools/verify-release.js  核对远端资产与 latest.yml 是否对得上');
})().catch((err) => {
  console.error('\n脚本异常：', err.message);
  console.error('（网络中断的话直接重跑即可，脚本会复用草稿并覆盖同名资产）');
  process.exit(1);
});
