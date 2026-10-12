'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

/* ============================================================
 *  本地静态服务
 *
 *  为什么不用 file:// 或自定义协议：
 *   - file:// 下 ES module 会被 CORS 拦死（opaque origin）
 *   - 自定义协议在解析相对路径时会把首段路径当 host，
 *     导致 app://bundle/... 变成 app://src/...，进而触发跨域拒绝
 *  http:// 是标准协议，URL 解析、CORS、MIME 全都正常。
 * ========================================================== */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

/* ============================================================
 *  Cubism Core 的兜底获取
 *
 *  live2dcubismcore.min.js 是 Live2D 的**专有软件**（协议里属于
 *  "Redistributable Code"），官方文档写明 "Cubism Core is not published
 *  on GitHub"，社区里官方也点名过某 GitHub 项目违反了该协议。
 *  所以本仓库不收录它。
 *
 *  但页面仍然按老路径请求这个文件（同步 <script>，保证它早于渲染库就位，
 *  这个时序不能动）。于是分三种情况：
 *    - 本地开发：文件就在 src/assets 下，走 fs.readFile，离线可用
 *    - 安装包：prepare-stage 会把它一起物化进 stage，同样离线可用
 *    - clone 到的仓库：文件根本不存在 → 落到这里，按
 *        内存缓存 → 磁盘缓存 → 官方 CDN  的顺序取回
 *
 *  这样"仓库里不含专有文件"和"离线也能跑"两件事就不冲突了。
 *  CDN 上那份与官方发布的逐字节一致（MD5 实测相同），不存在版本漂移。
 * ========================================================== */
const CUBISM_CORE_REL = 'src/assets/live2dcubismcore.min.js';
const CUBISM_CORE_CDN =
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

// 真实文件约 202 KB。低于这个量级说明拿到的多半是错误页而不是脚本，
// 与其把一坨 HTML 当 JS 喂给页面（表现为"Core 未定义"的怪错），
// 不如在这里就判定失败。
const CORE_MIN_BYTES = 64 * 1024;

let coreMemCache = null;  // Buffer，进程内缓存
let coreInflight = null;  // 并发去重：多个请求同时打进来只触发一次下载

function downloadCubismCore() {
  if (coreMemCache) return Promise.resolve(coreMemCache);
  if (coreInflight) return coreInflight;

  coreInflight = new Promise((resolve, reject) => {
    const req = https.get(CUBISM_CORE_CDN, { timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('HTTP ' + res.statusCode));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < CORE_MIN_BYTES) {
          reject(new Error(`响应体异常小（${buf.length} 字节）`));
          return;
        }
        coreMemCache = buf;
        resolve(buf);
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  }).finally(() => { coreInflight = null; });

  return coreInflight;
}

/* 把 URL 路径收成「根目录之内的绝对路径」。出了根目录就返回 null。
 *
 * 不能用 target.startsWith(root)：Windows 上 `...\live2d-pet-其它` 也以
 * `...\live2d-pet` 开头，兄弟目录会被当成项目里的文件。
 * path.relative 把「逃出去」的结果收成以 .. 开头、或另一块盘上的绝对路径。 */
function resolveStatic(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(String(urlPath || '/')).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!rel) rel = 'src/renderer/index.html';
  if (rel.includes('\0')) return null;
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  const fromRoot = path.relative(base, target);
  if (!fromRoot || fromRoot.split(path.sep).includes('..') || path.isAbsolute(fromRoot)) {
    return null;
  }
  return target;
}

/* 起服务，resolve 出 server 实例（调用方自己取 address().port）。
 * 端口传 0 由系统分配空闲端口，避免和用户其它服务撞车。
 *
 * opts.coreCacheFile：Cubism Core 的磁盘缓存落点（见上方那段说明）。
 * 不传就只用内存缓存 —— 每次启动重新下载，能用但不划算，所以 main.js 会传
 * userData 下的路径。 */
function startLocalServer(root, opts = {}) {
  const corePath = path.resolve(root, CUBISM_CORE_REL);
  const coreCacheFile = opts.coreCacheFile || null;

  function readCoreFromDisk() {
    if (coreMemCache) return coreMemCache;
    if (!coreCacheFile) return null;
    try {
      const b = fs.readFileSync(coreCacheFile);
      if (b.length >= CORE_MIN_BYTES) {
        coreMemCache = b;
        return b;
      }
    } catch { /* 首次运行没有缓存文件，属正常情况 */ }
    return null;
  }

  function writeCoreToDisk(buf) {
    if (!coreCacheFile) return;
    try {
      fs.mkdirSync(path.dirname(coreCacheFile), { recursive: true });
      fs.writeFileSync(coreCacheFile, buf);
    } catch (e) {
      // 缓存写不进去不影响本次服务，只是下次启动要重新下载
      console.warn('[cubism] 磁盘缓存写入失败：' + e.message);
    }
  }

  function sendJs(res, buf) {
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  }

  // 本地没有 Core 时的取回：磁盘缓存 → 官方 CDN
  function serveCubismCore(res) {
    const fromDisk = readCoreFromDisk();
    if (fromDisk) {
      sendJs(res, fromDisk);
      return;
    }
    downloadCubismCore().then((buf) => {
      writeCoreToDisk(buf);
      console.log(`[cubism] 本地无 Core，已从官方 CDN 取回并缓存（${buf.length} 字节）`);
      sendJs(res, buf);
    }).catch((e) => {
      console.warn('[cubism] 本地无 Core，官方 CDN 取回失败：' + e.message);
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
         .end('cubism core unavailable: ' + e.message);
    });
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const target = resolveStatic(root, u.pathname);
        if (!target) {
          res.writeHead(403).end('forbidden');
          return;
        }

        fs.readFile(target, (err, data) => {
          if (err) {
            // Cubism Core 不在仓库里（见上方说明），本地没有就去别处取
            if (target === corePath) {
              serveCubismCore(res);
              return;
            }
            const shown = path.relative(path.resolve(root), target);
            res.writeHead(404).end('not found: ' + shown);
            return;
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(target).toLowerCase()] ||
                            'application/octet-stream',
            'Cache-Control': 'no-store'
          });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      console.log(`[server] http://127.0.0.1:${server.address().port}`);
      resolve(server);
    });
  });
}

module.exports = { startLocalServer, resolveStatic };
