// `browser_launch` 的**工具层行为**：闸门、already-connected、spawn 参数、等连上、
// 以及三种失败各自说了什么。
//
// 这台**绝不真的启动浏览器**：`src/launch.ts` 的 `spawnBrowser` 被换成一个记账的假件
// （见下面的 `installFakeSpawn`）。真启动一个浏览器会弹窗、会抢焦点、会在 CI 上留下
// 一个孤儿进程——那是验台最不该有的副作用。
//
// 为什么要单独一台（而不是塞进 verify_launch_resolve）：那台只问「挑哪个可执行文件」，
// 这台问「挑到之后我们到底做了/说了什么」。两件事的失效方式完全不同：前者错是找不到
// 浏览器，后者错是**在用户屏上多开一个窗口**或者**误导模型去重试**。
//
// 用法：node verify/verify_launch_tool.mjs
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Config, apply } from '../lib/index.js'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/**
 * 把 `spawnBrowser` 换成一个记账的假件。
 *
 * 做法是**在真实工具路径上打桩**，而不是绕过它：`browser_launch` 里 spawn 之后要做
 * 三件事（等连接、组装结果、写日志），跳过 spawn 就只测到了前后两半。所以这里用
 * `child_process.spawn` 的替身，让真实代码原样跑完。
 */
const spawnLog = []
let spawnBehavior = 'ok'
const realSpawnPromise = import('node:child_process')

/**
 * `src/launch.ts` import 的是 `node:child_process` 的 `spawn`，ESM 绑定不可改。
 * 所以改成在**解析器层**把候选指向一个真实的、无害的可执行文件（本脚本自己造的
 * 一个空 shell 脚本），让真实 spawn 跑起来——它立刻退出，不弹窗、不抢焦点。
 * 这样测到的是完整真实路径，而不是一个被打桩的假象。
 */
async function makeFakeBrowser() {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-launch-tool-'))
  if (process.platform === 'win32') {
    // Windows 上造一个立刻退出的 .exe 不现实，用 cmd 的 exit 内建：
    // spawn(process.env.COMSPEC, ['/c', 'exit']) 是真实进程且什么都不做。
    return { root, target: process.env.COMSPEC ?? 'C:\\Windows\\System32\\cmd.exe', args: ['/c', 'exit'], dispose: () => rm(root, { recursive: true, force: true }) }
  }
  const exe = path.join(root, 'fake-browser')
  await writeFile(exe, '#!/bin/sh\nexit 0\n')
  await chmod(exe, 0o755)
  return { root, target: exe, args: [], dispose: () => rm(root, { recursive: true, force: true }) }
}

/** 起一个插件实例；`enabled:false` 保证不占端口，`browserPath` 指向假浏览器。 */
function boot(extra, fake) {
  const tools = new Map()
  const disposers = []
  const logs = []
  const ctx = {
    logger: { info: (line) => logs.push(String(line)), warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => { disposers.push(fn) },
    inject: (deps, cb) => {
      if (!deps.includes('settings')) return
      cb({ settings: { configure: () => () => {}, describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} }, logger: ctx.logger })
    },
    tools: { register: (def) => tools.set(def.name, def) },
    systemPrompt: { section: () => {} },
  }
  apply(ctx, Config({ enabled: false, port: 9799, token: 'launch-test', browserPath: fake.target, ...extra }))
  const dispose = async () => {
    for (const fn of disposers.reverse()) {
      try { await (typeof fn === 'function' ? fn() : undefined)?.() } catch { /* teardown 不该影响断言 */ }
    }
  }
  return { tools, dispose, logs }
}

async function call(tools, name, args) {
  const def = tools.get(name)
  if (!def) throw new Error(`工具没注册：${name}`)
  const controller = new AbortController()
  try {
    const value = await def.execute(args, { signal: controller.signal })
    return { ok: true, value }
  } catch (error) {
    return { ok: false, code: error?.code ?? error?.info?.code, effectState: error?.effectState ?? error?.info?.effectState, message: String(error?.message ?? error) }
  }
}

const fake = await makeFakeBrowser()
try {
  /* ── 1. 注册与形状 ─────────────────────────────────────────────── */
  {
    const { tools, dispose } = boot({ readOnly: false }, fake)
    const def = tools.get('browser_launch')
    check('browser_launch 被注册', def !== undefined)
    check('描述写清了「什么时候用」与「浏览器开着但扩展坏了不该用它」',
      /extension offline/i.test(def.description) && /not when the browser is open/i.test(def.description),
      def.description.slice(0, 80))
    check('描述写清了四级查找顺序（配置 → 已知位置 → PATH → 目录搜索）',
      /browserPath/i.test(def.description) && /PATH/i.test(def.description) && /directory search/i.test(def.description),
      def.description.slice(0, 120))
    check('参数只有三个（force / args / handshakeMs），没有多余旋钮',
      JSON.stringify(Object.keys(def.parameters.properties ?? {}).sort()) === JSON.stringify(['args', 'force', 'handshakeMs']),
      JSON.stringify(Object.keys(def.parameters.properties ?? {})))
    // 必填是 schema 顶层的 `required` 数组（`defineTool` 把 `required: true` 归到那里），
    // 不是每个属性自己的字段——这一条第一次写成后者时红了，是断言写错、不是实现错。
    check('输出 schema 是封闭的，且三个必填字段与实现一致',
      def.output.schema.additionalProperties === false
        && JSON.stringify([...(def.output.schema.required ?? [])].sort()) === JSON.stringify(['connected', 'launched', 'waitedMs']),
      JSON.stringify({ closed: def.output.schema.additionalProperties, required: def.output.schema.required }))
    await dispose()
  }

  /* ── 2. 只读档：拦在 spawn 之前 ─────────────────────────────────── */
  {
    const { tools, dispose } = boot({ readOnly: true }, fake)
    const r = await call(tools, 'browser_launch', {})
    check('readOnly：browser_launch 被拦下（blocked_by_policy / not_started）',
      r.ok === false && r.code === 'blocked_by_policy' && r.effectState === 'not_started',
      `${r.code} / ${r.effectState}`)
    check('readOnly：拒因说的是「在桌面上启动一个程序」，不是「改页面」或「删文件」',
      /启动一个浏览器程序/.test(r.message) && !/删除/.test(r.message),
      (r.message ?? '').slice(0, 90))
    check('readOnly：拒因里给了下一步（关掉 readOnly / 让用户自己开浏览器），并说别重试',
      /不要原地重试/.test(r.message ?? '') && /扩展图标/.test(r.message ?? ''),
      (r.message ?? '').slice(-90))
    await dispose()
  }

  /* ── 3. 没有扩展连着 + 能 spawn：报告 connected=false 而不是假装成功 ── */
  {
    const { tools, dispose, logs } = boot({ readOnly: false }, fake)
    const r = await call(tools, 'browser_launch', { handshakeMs: 1200 })
    check('扩展没连上时：launched=true 但 connected=false（不把"起来了"说成"能用了"）',
      r.ok === true && r.value.launched === true && r.value.connected === false,
      JSON.stringify(r.value ?? r.code))
    check('返回了等满的时长（waitedMs 是数字且非负）',
      typeof r.value?.waitedMs === 'number' && r.value.waitedMs >= 0, String(r.value?.waitedMs))
    check('返回了用的是哪个浏览器与它的路径（用户能核对是不是他装扩展的那个）',
      typeof r.value?.target === 'string' && r.value.target === fake.target && typeof r.value?.browser === 'string',
      JSON.stringify({ target: r.value?.target, browser: r.value?.browser }))
    check('说清了"浏览器已启动但扩展没握手"该去找谁（扩展侧，不是重试）',
      /did NOT connect/i.test(def_of(tools).output.render({}, r.value)[0].text)
        && /extension/i.test(def_of(tools).output.render({}, r.value)[0].text),
      def_of(tools).output.render({}, r.value)[0].text.slice(0, 120))
    check('启动写进了日志（排障时能查到拉起过什么）',
      logs.some((line) => /launched/i.test(line)), logs.join(' | ').slice(0, 120))
    await dispose()
  }

  /* ── 4. handshakeMs 被夹进合法区间 ──────────────────────────────── */
  {
    const { tools, dispose } = boot({ readOnly: false }, fake)
    const tooSmall = await call(tools, 'browser_launch', { handshakeMs: 1 })
    check('handshakeMs 太小被夹到 1000（不会因为 1ms 就误报"没连上"）',
      tooSmall.ok === true && tooSmall.value.waitedMs >= 1000, String(tooSmall.value?.waitedMs))
    const huge = await call(tools, 'browser_launch', { handshakeMs: 10_000_000 })
    check('handshakeMs 太大被夹到 60000（不会把一次工具调用挂几分钟）',
      huge.ok === true && huge.value.waitedMs <= 61_000, String(huge.value?.waitedMs))
    await dispose()
  }

  /* ── 5. 浏览器路径配错：找不到就如实报，且不许降级到别的浏览器 ────── */
  {
    const { tools, dispose } = boot({ readOnly: false, browserPath: path.join(fake.root, 'nope', 'browser.exe') }, fake)
    const r = await call(tools, 'browser_launch', { handshakeMs: 1000 })
    check('配了不存在的浏览器路径：报 launch_not_found 而不是硬 spawn',
      r.ok === false && r.code === 'launch_not_found', String(r.code))
    check('失败是 not_started（什么都没启动，重试不会多开窗口）',
      r.effectState === 'not_started', String(r.effectState))
    check('失败文案里带上了试过的路径（排障唯一能用的信息）',
      r.message.includes('nope'), (r.message ?? '').slice(0, 120))
    check('失败文案给了三条出路（设置页填路径 / 改配置 / 让用户自己开）且说别重试',
      /设置页/.test(r.message ?? '') && /browserPath/.test(r.message ?? '') && /不要重复调用/.test(r.message ?? ''),
      (r.message ?? '').slice(-120))
    await dispose()
  }

  /* ── 6. 已经连着时不重复开窗口 ──────────────────────────────────── */
  {
    // 这一组用一个**没有被前面任何一组碰过**的端口：插件实例自己会监听它，
    // 所以不能再另外起一个 BridgeServer 抢同一个口（第一次写这组时就撞了 EADDRINUSE）。
    const PORT = 9798
    const TOKEN = 'launch-connected'
    const { BridgeServer } = await import('../src/server.ts')
    const tools = new Map()
    const disposers = []
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      fiber: { state: 2, uid: 1 },
      effect: (fn) => { disposers.push(fn) },
      inject: (deps, cb) => {
        if (!deps.includes('settings')) return
        cb({ settings: { configure: () => () => {}, describe: () => [], update: async () => {}, replace: async () => {}, mutate: async () => {} }, logger: ctx.logger })
      },
      tools: { register: (def) => tools.set(def.name, def) },
      systemPrompt: { section: () => {} },
    }
    // 让**插件自己**监听 9798：`isExtensionConnected` 读的就是这个实例的状态。
    apply(ctx, Config({ enabled: true, port: PORT, token: TOKEN, browserPath: fake.target }))
    let ws
    try {
      // 等桥真的在听，再接上去。
      const probe = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: path.join(fake.root, 'shots') })
      void probe
      for (let i = 0; i < 120; i += 1) {
        try {
          ws = new (globalThis.WebSocket)(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`, { headers: { host: `127.0.0.1:${PORT}` } })
          await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true })
            ws.addEventListener('error', reject, { once: true })
          })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
      }
      check('前提：插件自己的监听起来了（不然第 6 组什么都没测到）', ws !== undefined, String(ws !== undefined))
      ws.send(JSON.stringify({ type: 'hello', client: 'dsh-browser-extension', version: 'test', protocol: 1 }))
      const launchDef = def_of(tools)
      // 用工具自己的返回值判定「已连着」是否被认出来；不直接读内部状态，避免依赖实现细节。
      let connected = false
      for (let i = 0; i < 80; i += 1) {
        const r = await call(tools, 'browser_launch', { handshakeMs: 1000 })
        if (r.ok === true && r.value.launched === false && r.value.connected === true) { connected = true; break }
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      void launchDef
      const r = await call(tools, 'browser_launch', {})
      check('已经连着时不重复开窗口：launched=false 且 connected=true，waitedMs=0',
        connected && r.ok === true && r.value.launched === false && r.value.connected === true && r.value.waitedMs === 0,
        JSON.stringify(r.value ?? r.code))
      check('这条分支的模型可见文案说的是"已经连上了，什么都没启动"',
        /already connected/i.test(def_of(tools).output.render({}, r.value)[0].text)
          && /nothing launched/i.test(def_of(tools).output.render({}, r.value)[0].text),
        def_of(tools).output.render({}, r.value)[0].text.slice(0, 100))
      const forced = await call(tools, 'browser_launch', { force: true, handshakeMs: 1000 })
      check('force:true 时即便已连着也会真的启动一个（这是显式要求）',
        forced.ok === true && forced.value.launched === true, JSON.stringify(forced.value ?? forced.code))
    } finally {
      try { ws?.close() } catch { /* ignore */ }
      for (const fn of disposers.reverse()) {
        try { await (typeof fn === 'function' ? fn() : undefined)?.() } catch { /* ignore */ }
      }
      // 等端口真的释放，免得下一次跑撞 EADDRINUSE。
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
} finally {
  await fake.dispose()
}

/** 取一个工具的注册定义（上面几处要用它的 render）。 */
function def_of(tools) {
  return tools.get('browser_launch')
}

console.log(fails === 0 ? '\nbrowser_launch 的工具层行为符合契约' : `\n${fails} 项未通过`)
process.exit(fails === 0 ? 0 : 1)
