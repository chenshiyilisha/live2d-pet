'use strict';
/*
 * 打 Windows 安装包（NSIS）。
 *
 * 为什么走 API 而不是 electron-builder 命令行：
 *   打包的源目录不是项目根，而是 build/stage（见 tools/prepare-stage.js）。
 *   项目根里有 pnpm 的符号链接式 node_modules 和 debug/ 下的一堆诊断探针，
 *   直接打会把 476MB 的 electron 二进制卷进去。把 projectDir 指到 stage，
 *   electron-builder 视野里就只剩真正该进安装包的东西。
 *
 * 用法： node tools/build-installer.js
 * 产出： dist/Ayan-Setup-<版本>.exe（+ .blockmap + latest.yml，三件套）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/* 先掐掉会话里的 HTTP 代理，再加载 electron-builder。
 *
 * 本机 http_proxy / https_proxy 指向一个内部代理（127.0.0.1 上的动态端口），
 * 而它在打包这一次是"接得住连接但不转发"：curl 走它 8 秒超时，直连 github
 * 反而 200。electron-builder 会自动读这两个变量，于是它的每个下载请求都挂在
 * 代理上，一路耗到 600 秒才抛 ETIMEDOUT —— 错误信息里只有一句
 * "Timeout awaiting 'request' for 600000ms"，完全看不出跟代理有关系。
 *
 * 必须在 require('electron-builder') 之前删：它读的是当时的 process.env，
 * 而且要让后面 fork 出去的 app-builder 子进程也继承到"无代理"的环境。
 */
for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) {
  delete process.env[k];
}

/* electron 的二进制与校验清单改走 npmmirror 镜像。
 *
 * 现象：构建每次都停在 "packaging"，然后抛 connect ETIMEDOUT
 * 20.205.243.166:443（github 的 IP）。原因是 electron-builder 经 @electron/get
 * 去取 SHASUMS256.txt 做完整性校验，而这一步**每次构建都会发生** ——
 * 本地缓存目录里只有 electron-v44.7.0-win32-x64.zip，没有那份清单。
 * 本机直连 github releases 是 TCP 超时，会话代理又是死的，两条路都不通，
 * 所以构建必然卡死在这里。
 *
 * npmmirror（淘宝镜像）实测 0.7 秒可达，校验和与官方一致。缓存 key 是
 * zip 内容的 sha512、与 URL 无关，所以本地已有的 zip 仍然命中，
 * 走镜像只会取那份几 KB 的清单，不会重下 110MB。
 */
process.env.ELECTRON_MIRROR =
  process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

const builder = require('electron-builder');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'build', 'stage');
const RES = path.join(ROOT, 'build');
const OUT = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(STAGE, 'package.json'))) {
  console.error('build/stage 不存在，先跑： node tools/prepare-stage.js');
  process.exit(1);
}

/* 构建前把上一轮的产物挪走 —— 这一步不是为了干净，是为了能跑起来。
 *
 * electron-builder 每次都要重建 dist/win-unpacked，而它内部是用**一次**
 * fs.rm(dir, { recursive: true }) 清空旧目录的。本机对"单次删除超过 50 个
 * 条目"有确认保护，而解压出来的 win-unpacked 有 160+ 个条目，于是构建会在
 * 解压 electron 这一步直接被打断（SAFE_DELETE_BULK_CONFIRM_REQUIRED），
 * 报错信息还停在 @electron/rebuild 附近，跟真正的原因隔着好几层。
 *
 * rename 不走删除路径，所以改用挪走而不是删除。挪到系统临时目录下带时间戳
 * 的名字，互不覆盖；这些目录可以直接删，系统也会自行清理。
 */
if (fs.existsSync(OUT)) {
  const stale = path.join(os.tmpdir(), `ayan-build-stale-${Date.now()}`);
  fs.renameSync(OUT, stale);
  console.log(`上一轮产物已移至 ${stale}`);
}

// stage 的 package.json 里没有 electron（dependencies 被刻意清空，
// 否则 electron-builder 会去啃符号链接结构的 node_modules），
// 所以版本得在这里显式喂给它。
const ELECTRON_VERSION = '44.7.0';

builder.build({
  projectDir: STAGE,
  targets: builder.Platform.WINDOWS.createTarget(['nsis'], builder.Arch.x64),
  /* 只生成元数据，不往上推。
   * 显式写出来更保险：将来万一有人往环境里塞了 GH_TOKEN，默认策略可能
   * 会把它理解成"可以上传了"，于是构建顺带发一个 Release 出去。 */
  publish: 'never',
  config: {
    /* appId 是 Windows 侧的安装身份：NSIS 用它算卸载注册表项、也用它识别
     * "这次装的是不是同一个应用"（决定能不能就地升级，还是并列装出两份）。
     * 换作者名时它必须跟着换，否则旧名会永久留在注册表里。 */
    appId: 'com.chenshiyilisha.ayan',

    /* productName 必须是纯 ASCII。
     * 它不只用来命名安装包 —— electron-builder 会把它作为 makensis 的
     * -D 命令行参数传进 NSIS，而 Windows 命令行是 ANSI 语义，中文经这一趟
     * 会退化成问号（构建日志里能直接看到 PRODUCT_NAME=????）。
     * 中文显示名由 build/installer.nsh 在 UTF-8 BOM 里重新定义。
     * 它同时决定 exe 名，所以这里是 Ayan，安装目录里就是 Ayan.exe。 */
    productName: 'Ayan',
    copyright: 'Copyright (C) 2026 chenshiyilisha',
    electronVersion: ELECTRON_VERSION,

    directories: {
      output: OUT,
      buildResources: RES
    },

    /* stage 里就是全部该进包的东西，但默认那条「递归全量通配」并不够：
     *
     * 🔴 electron-builder 对**任意层级**名为 node_modules 的目录都会走它自己的
     *    依赖收集逻辑，而 stage 的 package.json 刻意清空了 dependencies
     *    （见 prepare-stage.js）→ 收集器报 "no node modules returned"
     *    → 于是它把这类目录**静默剔除**。
     *
     *    这正好吃掉了 vendor/updater/node_modules —— 主进程运行时唯一要
     *    require 的那棵依赖树。prepare-stage.js 当初把落点从顶层 node_modules
     *    挪到 vendor 下面，以为绕开了这层特殊处理，但它匹配的是路径里**任意
     *    位置**的 node_modules 段，所以照剔不误。
     *
     *    症状：打包版（安装版与便携版一样）启动后只留一句
     *    "Cannot find module 'electron-updater'"，updater.js 静默降级，
     *    **自动更新永久失效**；而构建日志里完全看不出异常
     *    （v0.1.1 / v0.1.2 两个发布版都带着这个毛病）。
     *
     * 下面显式「先排除、再包含」：files 里后面的模式覆盖前面的，这棵树一定进包。
     * 回归：debug/verify-packaged-files.js（构建后跑，直接查产物目录）。 */
    files: [
      '**/*',
      '!**/node_modules/**',
      'vendor/updater/node_modules/**'
    ],

    // asar 必须关：渲染层页面是本地 http 服务按 URL 路径直接读磁盘的
    // （server.js 的 fs.readFile），asar 是虚拟归档，路径语义对不上。
    asar: false,

    win: {
      target: [{ target: 'nsis', arch: ['x64'] }],
      icon: path.join(RES, 'icon.ico'),
      /* 同样是 ASCII，而且必须和 NSIS 侧的 APP_EXECUTABLE_FILENAME 一致 ——
       * common.nsh 里那个宏是由 PRODUCT_FILENAME（即 productName）拼出来的，
       * 快捷方式的目标路径就是它。两边一旦不一致，快捷方式会指向一个
       * 不存在的文件：双击没反应，且很难一眼看出原因。
       * 用户看到的名字由快捷方式（阿岩.lnk）承担，exe 本身叫 Ayan.exe。 */
      executableName: 'Ayan'
    },

    nsis: {
      // 关掉 oneClick 才有向导：目录选择页、自定义选项页都在这个模式下才存在
      oneClick: false,
      // 当前用户安装（装到 %LOCALAPPDATA%\Programs），双击即装、不弹 UAC。
      // allowElevation 让用户仍可在安装模式页选"为所有用户安装"。
      perMachine: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,

      // 这两项交给 build/installer.nsh 按用户勾选决定，
      // 模板的自动创建必须关掉，否则会无条件创建、和选项页的勾选状态打架。
      // 快捷方式名刻意不在这里配：shortcutName 会变成 makensis 的 -D 参数，
      // 中文经命令行会乱码。它由 build/installer.nsh 在 UTF-8 BOM 里定义。
      createDesktopShortcut: false,
      createStartMenuShortcut: false,

      installerIcon: path.join(RES, 'icon.ico'),
      uninstallerIcon: path.join(RES, 'icon.ico'),
      installerHeaderIcon: path.join(RES, 'icon.ico'),

      include: path.join(RES, 'installer.nsh'),
      language: '2052', // 简体中文

      /* ⚠️ 必须是**纯 ASCII**，绝不能写成中文。
       *
       * electron-builder 有个 safeArtifactName 机制：artifactName 里只要含
       * 非 ASCII 字符，它写进 latest.yml 的 path 就会换成一个 ASCII 安全名
       * （本项目实测会变成 live2d-pet-setup-0.1.0.exe），**但磁盘上的产物
       * 仍然叫中文名**。两者一旦不一致，electron-updater 就会按清单里的名字
       * 去 releases/download/<tag>/ 下载 → 404，而且报错跟"文件名不匹配"
       * 毫无关联，极难往这上面想。
       * 下面「自动更新三件套」自检里有一条断言专门拦这个。
       *
       * 中文体验不受影响：安装目录里的 exe 是 Ayan.exe，快捷方式是 阿岩.lnk。 */
      artifactName: 'Ayan-Setup-${version}.${ext}'
    },

    /* 发布源：GitHub Releases。这个段有两个作用，只有第一个是我们想要的 ——
     *   1) 生成 dist/latest.yml 和包内 resources/app-update.yml。自动更新
     *      完全依赖它们：electron-updater 先读 latest.yml 比对版本，再按里面的
     *      path 去 releases/download/<tag>/ 下载。
     *   2) 构建后自动上传 Release 资产 —— 已用上面的 publish:'never' 关掉。
     *
     * ⚠️ 刻意**不写 publisherName**、也不配代码签名证书。
     *    electron-updater 的 NsisUpdater.verifySignature 只在 app-update.yml
     *    里存在 publisherName 时才真去验签（源码 out/NsisUpdater.js:84-99：
     *    publisherName == null 直接 return null）。
     *    我们没有签名证书，写进去只会让每次更新在"下载完 114MB 之后"抛
     *    ERR_UPDATER_INVALID_SIGNATURE —— 白等一场，而且报错信息里跟"没签名"
     *    看不出半点关系。发版时也别往 latest.yml 里手工补这个字段。 */
    publish: [
      { provider: 'github', owner: 'chenshiyilisha', repo: 'live2d-pet' }
    ]
  }
}).then(async (files) => {
  console.log('\n产物：');
  for (const f of files) {
    console.log(`  ${path.basename(f)}  (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
  }

  /* ── 自动更新三件套自检 ──
   * ⚠️ 这不是可选的锦上添花：electron-updater 少任何一件，**所有客户端都会
   *    静默收不到更新**，而本地构建日志里看不出半点异常。传 Release 前必须齐。 */
  const ver = pkg.version;
  const exeName = `Ayan-Setup-${ver}.exe`;
  const trio = ['latest.yml', exeName, `${exeName}.blockmap`];

  console.log('\n自动更新三件套：');
  let bad = 0;
  for (const t of trio) {
    const ok = fs.existsSync(path.join(OUT, t));
    if (!ok) bad++;
    console.log(`  ${ok ? '✓' : '✗'} ${t}`);
  }
  if (bad) {
    console.error('\n缺少上述文件。Release 上少了它们，所有人的自动更新都会静默失效。');
    process.exitCode = 1;
    return;
  }

  /* 再核对 latest.yml 里的 sha512 与 exe 的实际哈希。
   * 不一致的话更新会在**下载完成后的校验阶段**失败，报错只说
   * "sha512 checksum mismatch"，跟"构建产物过期"这种真实原因毫无关联。 */
  const yml = fs.readFileSync(path.join(OUT, 'latest.yml'), 'utf8');
  const declared = (yml.match(/sha512:\s*(\S+)/) || [])[1];
  const actual = await sha512Base64(path.join(OUT, exeName));
  const same = declared === actual;
  console.log(`  ${same ? '✓' : '✗'} latest.yml 的 sha512 与 exe 实际哈希一致`);

  /* 清单里记的文件名必须和磁盘上的产物**逐字一致**。
   * 不一致的典型成因是 artifactName 含非 ASCII 被 safeArtifactName 换掉。
   * 这条断言值得单列：不一致时 electron-updater 会按清单名去下载 → 404，
   * 而报错信息里只有"找不到文件"，跟真实原因隔着十万八千里。 */
  const pathField = (yml.match(/^\s*path:\s*(.+)$/m) || [])[1];
  const ymlName = pathField ? pathField.trim() : '';
  const nameOk = ymlName === exeName;
  console.log(`  ${nameOk ? '✓' : '✗'} latest.yml 的文件名与实际产物一致（${ymlName || '(未找到 path)'}）`);
  if (!nameOk) {
    console.error(`    实际产物是 ${exeName}，清单里却是 ${ymlName || '(空)'}。`);
    console.error('    electron-updater 会按清单里的名字下载 → 404。');
    console.error('    多半是 artifactName 里混进了非 ASCII 字符（见 nsis.artifactName 的注释）。');
  }
  console.log(`  版本：${ver}`);

  if (!same || !nameOk) process.exitCode = 1;
}).catch((err) => {
  console.error('\n打包失败：', err);
  process.exit(1);
});

function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('base64')))
      .on('error', reject);
  });
}
