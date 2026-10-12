// 验证 server.js 的 Cubism Core 兜底：本地文件缺失时能否从官方 CDN 取回。
//
// 做法是把本地文件临时 rename 走（模拟「clone 下来的仓库」），跑完在 finally
// 里改回来。用 rename 而不是删除，是因为中途任何一步崩了文件都还在原处旁边，
// 不会真的丢。
//
// 只用内置模块，可以直接 `node debug/verify-cubism-fallback.js` 跑，不需要 Electron。

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { startLocalServer } = require('../src/main/server');

const ROOT = path.join(__dirname, '..');
const CORE_REL = 'src/assets/live2dcubismcore.min.js';
const CORE_ABS = path.join(ROOT, CORE_REL);
const HIDDEN = CORE_ABS + '.hidden-for-test';
const OFFICIAL_MD5 = 'd96ca1fe247a5fd0bd5cbf5711466c42';

let failures = 0;
const ok = (s) => console.log('  ✅ ' + s);
const no = (s) => { failures++; console.log('  ❌ ' + s); };

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('== Cubism Core 兜底验证 ==\n');

  if (!fs.existsSync(CORE_ABS)) {
    console.log('本地本来就没有 ' + CORE_REL + '，跳过"藏起来"这一步直接测。');
  } else {
    fs.renameSync(CORE_ABS, HIDDEN);
    console.log('已临时移走 ' + CORE_REL + '\n');
  }

  const cacheFile = path.join(os.tmpdir(), `cubism-cache-${Date.now()}.js`);
  let srv = null;

  try {
    srv = await startLocalServer(ROOT, { coreCacheFile: cacheFile });
    const port = srv.address().port;
    console.log(`本地服务已起：127.0.0.1:${port}\n`);

    // --- 1. 本地文件不存在，应回源 CDN ---
    const t1 = Date.now();
    const r1 = await get(port, '/' + CORE_REL);
    const cost1 = Date.now() - t1;
    console.log('1. 本地缺失时请求 Core');
    if (r1.status === 200) ok(`HTTP 200（耗时 ${cost1} ms）`);
    else no(`期望 200，实际 ${r1.status}`);
    if (md5(r1.body) === OFFICIAL_MD5) ok('内容 MD5 与官方一致（逐字节相同）');
    else no(`MD5 不符：${md5(r1.body)}`);
    if ((r1.body.length || 0) >= 64 * 1024) ok(`体积 ${r1.body.length} 字节`);
    else no(`体积异常：${r1.body.length}`);

    // --- 2. 磁盘缓存应已落盘 ---
    console.log('\n2. 磁盘缓存');
    if (fs.existsSync(cacheFile)) {
      const c = fs.readFileSync(cacheFile);
      if (md5(c) === OFFICIAL_MD5) ok(`缓存已写入且内容正确（${c.length} 字节）`);
      else no('缓存内容不对');
    } else {
      no('缓存文件没写出来');
    }

    // --- 3. 第二次请求应走缓存，明显更快 ---
    await sleep(50);
    const t2 = Date.now();
    const r2 = await get(port, '/' + CORE_REL);
    const cost2 = Date.now() - t2;
    console.log('\n3. 二次请求（应命中缓存）');
    if (r2.status === 200 && md5(r2.body) === OFFICIAL_MD5) {
      ok(`HTTP 200 且内容正确，耗时 ${cost2} ms`);
      if (cost2 < cost1) ok(`比首次快（${cost1} → ${cost2} ms）`);
      else console.log(`  · 本次 ${cost2} ms 不比首次 ${cost1} ms 快（网络抖动，不判失败）`);
    } else {
      no(`状态 ${r2.status}，MD5 ${md5(r2.body || Buffer.alloc(0))}`);
    }

    // --- 4. 其它不存在的路径仍应 404，别被误伤 ---
    console.log('\n4. 兜底不应误伤其它路径');
    const r3 = await get(port, '/src/assets/not-exist-xyz.js');
    if (r3.status === 404) ok('无关路径仍然 404');
    else no(`无关路径返回了 ${r3.status}，兜底范围过宽`);

    // --- 5. 本地文件存在时，应优先走本地（不走 CDN） ---
    console.log('\n5. 本地文件存在时应优先本地');
    fs.renameSync(HIDDEN, CORE_ABS);          // 先放回去
    const srv2 = await startLocalServer(ROOT, { coreCacheFile: cacheFile });
    const r4 = await get(srv2.address().port, '/' + CORE_REL);
    if (r4.status === 200 && md5(r4.body) === OFFICIAL_MD5) ok('本地路径正常返回且内容正确');
    else no(`本地路径异常：${r4.status}`);
    srv2.close();
  } catch (e) {
    no('抛出异常：' + (e && e.stack || e));
  } finally {
    if (fs.existsSync(HIDDEN)) {
      fs.renameSync(HIDDEN, CORE_ABS);
      console.log('\n已恢复 ' + CORE_REL);
    }
    try { fs.unlinkSync(cacheFile); } catch {}
    if (srv) srv.close();
  }

  console.log('\n失败计数：' + failures);
  process.exit(failures ? 1 : 0);
})();
