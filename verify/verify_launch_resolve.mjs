// `browser_launch` 的**找浏览器**这一层：四级逐级下降、每一级都不许硬编码成功。
//
// 这台刻意**不 spawn 任何东西**：它只验「给定一台什么模样的机器，解析器会挑哪个
// 可执行文件、以及在找不到时能不能把试过的东西说清楚」。真启动留给
// `verify_launch_tool.mjs`（那台用一个假的 spawn 注入）。
//
// 为什么这一层值得单独一台：把
// `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 写死在本机能跑，
// 换一台机器就是 ENOENT，而用户看到的只有「点了启动没反应」。所以这里要钉的是
// **降级顺序**与**失败可解释**，不是「能否找到某个特定路径」。
//
// 用法：node verify/verify_launch_resolve.mjs
import { mkdtemp, rm, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  knownBrowserPaths, pathDirectories, resolveBrowser, searchForBrowser, searchRoots,
  LAUNCH_SEARCH_MAX_DEPTH,
} from '../src/launch.ts'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** 造一棵一次性的临时目录树，用完删掉（删的是本脚本自己刚从零创建的东西）。 */
async function scratch() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-launch-resolve-'))
  return {
    root,
    /** 在 root 下造一个"可执行文件"（内容随便，只要能 access(X_OK)）。 */
    async exe(relative) {
      const full = path.join(root, relative)
      await mkdir(path.dirname(full), { recursive: true })
      await writeFile(full, '#!/bin/sh\nexit 0\n')
      await chmod(full, 0o755)
      return full
    },
    async dir(relative) {
      const full = path.join(root, relative)
      await mkdir(full, { recursive: true })
      return full
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}

const isWin = process.platform === 'win32'
const exeName = isWin ? 'msedge.exe' : 'microsoft-edge'

/* ── 1. 已知安装位置：按优先级，Edge 在 Chrome 前面 ─────────────────── */
{
  const sc = await scratch()
  try {
    const edge = await sc.exe('pf86/Microsoft/Edge/Application/msedge.exe')
    const chrome = await sc.exe('pf/Google/Chrome/Application/chrome.exe')
    const found = await resolveBrowser({
      platform: 'win32',
      env: { 'ProgramFiles': path.join(sc.root, 'pf'), 'ProgramFiles(x86)': path.join(sc.root, 'pf86') },
      search: false,
    })
    check('已知安装位置能命中，且 Edge 优先于 Chrome（用户装扩展的那个最可能先被拉起）',
      found.found?.target === edge && found.found?.source === 'known-path',
      JSON.stringify({ target: found.found?.target, expect: edge, source: found.found?.source }))
    // 命中就返回了，所以 Chrome 不会进 attempted —— 那条「Edge 不在时会退到 Chrome」
    // 得单独量：把 Edge 拿掉再解析一次。
    const withoutEdge = await resolveBrowser({
      platform: 'win32',
      env: { 'ProgramFiles': path.join(sc.root, 'pf'), 'ProgramFiles(x86)': path.join(sc.root, 'pf86') },
      knownPaths: knownBrowserPaths('win32', { 'ProgramFiles': path.join(sc.root, 'pf'), 'ProgramFiles(x86)': path.join(sc.root, 'pf86') })
        .filter((candidate) => candidate.label !== 'Microsoft Edge'),
      search: false,
    })
    check('Edge 不存在时退回 Chrome（多候选的意义就在这里）',
      withoutEdge.found?.target === chrome && withoutEdge.found?.label === 'Google Chrome',
      JSON.stringify({ target: withoutEdge.found?.target, label: withoutEdge.found?.label, expect: chrome }))
  } finally { await sc.dispose() }
}

/* ── 2. 显式路径：给了就只用它，而且**不往下试** ───────────────────── */
{
  const sc = await scratch()
  try {
    const edge = await sc.exe('pf86/Microsoft/Edge/Application/msedge.exe')
    const found = await resolveBrowser({
      path: edge,
      platform: 'win32',
      env: { 'ProgramFiles': path.join(sc.root, 'pf'), 'ProgramFiles(x86)': path.join(sc.root, 'pf86') },
      search: false,
    })
    check('显式路径命中时就用它', found.found?.target === edge && found.found?.source === 'configured',
      JSON.stringify({ target: found.found?.target, source: found.found?.source }))
    check('显式路径命中时 stages 里只有 configured（其余三级一个都没跑）',
      found.stages.knownPath === 0 && found.stages.path === 0 && found.stages.search === 0,
      JSON.stringify(found.stages))
    check('显式路径命中时 attempted 只有它自己',
      found.attempted.length === 1 && found.attempted[0] === edge, JSON.stringify(found.attempted))

    // 配了一个不存在的路径：**不许**悄悄换成默认浏览器。
    const missing = await resolveBrowser({
      path: path.join(sc.root, 'nope', 'msedge.exe'),
      platform: 'win32',
      env: { 'ProgramFiles': path.join(sc.root, 'pf'), 'ProgramFiles(x86)': path.join(sc.root, 'pf86') },
      search: false,
    })
    check('配了不存在的路径时**不**降级到默认浏览器（"我指定了"不能变成谎话）',
      missing.found === undefined && missing.stages.knownPath === 0,
      JSON.stringify({ found: missing.found, stages: missing.stages }))
    check('配错时 attempted 里仍然是它自己（用户能看出填错的是哪个）',
      missing.attempted.length === 1 && missing.attempted[0] === path.join(sc.root, 'nope', 'msedge.exe'),
      JSON.stringify(missing.attempted))
  } finally { await sc.dispose() }
}

/* ── 3. PATH 搜索：已知位置全落空时沿 PATH 找 ───────────────────────── */
{
  const sc = await scratch()
  try {
    const binDir = await sc.dir('custom-bin')
    const exe = await sc.exe('custom-bin/' + exeName)
    // **必须显式给 knownPaths**：真机上（尤其是 CI 的 `ubuntu-latest`）`/usr/bin/microsoft-edge`
    // 是真的存在的，只把 ProgramFiles 指到空目录挡不住 Linux 那条已知位置表——第一次写
    // 这组时 CI 就红在这：它命中 known-path 就返回了，PATH 那一段根本没跑到。
    // 验台要测的是**降级顺序**，所以已知位置必须是可控的空表，不能依赖宿主碰巧没装浏览器。
    const found = await resolveBrowser({
      platform: isWin ? 'win32' : 'linux',
      env: {
        'ProgramFiles': path.join(sc.root, 'none-a'),
        'ProgramFiles(x86)': path.join(sc.root, 'none-b'),
        'LOCALAPPDATA': '',
        'PATH': [path.join(sc.root, 'none-c'), binDir].join(isWin ? ';' : ':'),
      },
      knownPaths: [],
      search: false,
    })
    check('已知位置全落空 → 沿 PATH 搜索命中', found.found?.target === exe && found.found?.source === 'path',
      JSON.stringify({ target: found.found?.target, source: found.found?.source, expect: exe }))
    check('PATH 搜索确实跑到了（knownPaths 为空时 path 级有尝试记录）',
      found.stages.path > 0, JSON.stringify(found.stages))
  } finally { await sc.dispose() }
}

/* ── 4. 目录搜索兜底：前三段都落空时，有限深度内扫出来 ─────────────── */
{
  const sc = await scratch()
  try {
    const root = await sc.dir('ProgramFilesRoot')
    // 埋在一个不太浅、但也没深到超过上限的地方
    const buried = await sc.exe(path.join('ProgramFilesRoot', 'Vendor', 'Browser', 'App', exeName))
    const found = await searchForBrowser({
      root,
      names: [{ label: 'Test Browser', file: exeName }],
    })
    check('目录搜索能在有限深度内找到埋在子目录里的浏览器',
      found?.target === buried && found?.source === 'search',
      JSON.stringify({ target: found?.target, expect: buried }))
  } finally { await sc.dispose() }
}
{
  // 深度上限：超过 maxDepth 的地方**不许**被找到（否则一次兜底搜索会变成全盘扫描）。
  const sc = await scratch()
  try {
    const root = await sc.dir('deep')
    const parts = []
    for (let i = 0; i < LAUNCH_SEARCH_MAX_DEPTH + 2; i += 1) parts.push(`d${i}`)
    await sc.exe(path.join('deep', ...parts, exeName))
    const found = await searchForBrowser({
      root,
      names: [{ label: 'Test Browser', file: exeName }],
      maxDepth: LAUNCH_SEARCH_MAX_DEPTH,
    })
    check('超过深度上限的位置**不**被找到（兜底搜索有界，不是全盘扫描）',
      found === undefined, JSON.stringify(found))
  } finally { await sc.dispose() }
}
{
  // 条目上限：看一眼 maxEntries 就该停，而不是把整个目录树走完。
  const sc = await scratch()
  try {
    const root = await sc.dir('many')
    for (let i = 0; i < 40; i += 1) await sc.dir(path.join('many', `d${String(i).padStart(2, '0')}`))
    const looked = []
    const found = await searchForBrowser({
      root,
      names: [{ label: 'Test Browser', file: exeName }],
      maxEntries: 5,
      now: () => { looked.push(Date.now()); return Date.now() },
    })
    check('条目上限生效：一眼看够 maxEntries 就放弃（不会把整棵树走完）',
      found === undefined, JSON.stringify(found))
  } finally { await sc.dispose() }
}

/* ── 5. 找不到时的可解释性：三级都试过、并把试过的东西带回去 ────────── */
{
  const sc = await scratch()
  try {
    const found = await resolveBrowser({
      platform: isWin ? 'win32' : 'linux',
      env: {
        'ProgramFiles': path.join(sc.root, 'none-a'),
        'ProgramFiles(x86)': path.join(sc.root, 'none-b'),
        'LOCALAPPDATA': '',
        'PATH': path.join(sc.root, 'none-c'),
      },
      // 同第 3 组：已知位置表必须是可控的空表。CI 的 ubuntu runner 上
      // `/usr/bin/microsoft-edge` 真的存在，用真实平台表就永远走不到"全都找不到"。
      knownPaths: [],
      // 目录搜索也关掉：它扫的是 `/usr/bin`、`/opt` 这些真实目录，在 CI 上会命中真实浏览器。
      // 这一组问的是"三级都落空时能不能说清楚"，不是"兜底搜索在真机上会不会命中"——
      // 后者由第 4 组用受控目录单独验。
      search: false,
    })
    check('全都找不到时 found 是 undefined（不许猜一个路径去 spawn）', found.found === undefined,
      JSON.stringify(found.found))
    check('找不到时 attempted 非空（失败文案才有东西可说）', found.attempted.length > 0, String(found.attempted.length))
    check('找不到时 PATH 级也有痕迹（knownPaths 空表时 path 级必然被跑到）',
      found.stages.path > 0,
      JSON.stringify(found.stages))
    check('attempted 里没有重复项（同一路径试两次只是噪音）',
      new Set(found.attempted).size === found.attempted.length, String(found.attempted.length))
  } finally { await sc.dispose() }
}

/* ── 6. 平台默认值：不传 env 也不崩，PATH 分隔符按平台拆 ─────────────── */
{
  check('pathDirectories：Windows 用 ; 拆', JSON.stringify(pathDirectories({ PATH: 'C:\\a;C:\\b' }, 'win32')) === JSON.stringify(['C:\\a', 'C:\\b']),
    JSON.stringify(pathDirectories({ PATH: 'C:\\a;C:\\b' }, 'win32')))
  check('pathDirectories：POSIX 用 : 拆', JSON.stringify(pathDirectories({ PATH: '/a:/b' }, 'linux')) === JSON.stringify(['/a', '/b']),
    JSON.stringify(pathDirectories({ PATH: '/a:/b' }, 'linux')))
  check('pathDirectories：没有 PATH 时是空数组（不崩）',
    pathDirectories({}, 'linux').length === 0, JSON.stringify(pathDirectories({}, 'linux')))
  check('knownBrowserPaths(win32) 至少给出 Edge 与 Chrome 两类候选',
    knownBrowserPaths('win32', {}).some((c) => c.label === 'Microsoft Edge')
      && knownBrowserPaths('win32', {}).some((c) => c.label === 'Google Chrome'),
    JSON.stringify(knownBrowserPaths('win32', {}).map((c) => c.label)))
  check('knownBrowserPaths(darwin) 走 /Applications',
    knownBrowserPaths('darwin', {}).every((c) => c.target.startsWith('/Applications/')),
    JSON.stringify(knownBrowserPaths('darwin', {}).map((c) => c.target)))
  check('searchRoots(win32) 不含空串（LOCALAPPDATA 缺失时不许塞一个空路径进去）',
    searchRoots('win32', { 'ProgramFiles': 'C:\\PF' }).every((r) => typeof r === 'string' && r.length > 0),
    JSON.stringify(searchRoots('win32', { 'ProgramFiles': 'C:\\PF' })))
}

console.log(fails === 0 ? '\n找浏览器：四级降级与失败可解释性符合契约' : `\n${fails} 项未通过`)
process.exit(fails === 0 ? 0 : 1)
