// 设置页路由在「冷启动」时的挂载路径：webServer 服务晚于本插件出现，路由必须等它出现再挂。
//
// 事故（用户 2026-10-29 实测，逐字）：重启 dsh 后设置页显示「桥接 未监听 / 扩展 未连接」，
// 错误条是 `Failed to execute 'json' on 'Response': Unexpected end of JSON input`；可扩展
// 弹窗明明写着已连接、桥也确实在 9777 上监听着；到插件详情页把 dsh-browser 关掉再打开就恢复。
//
// 根因：路由在**激活那一刻**用一次 `ctx.get('webServer')` 探测，冷启动时服务还没出现，那一次
// 错过就是永久的——宿主编排里从此没有这个前缀路由，客户端每 3 秒拿到宿主的 404 空体，
// `res.json()` 于是抛出那句只有开发者看得懂的话，而页面把「拿不到状态」渲染成了
// 「未监听 / 未连接」这两个**恰好全错**的判断。
//
// 这台验台把「服务晚到」写成假 ctx 上的事件，逐条钉住：
//   §1 服务没来：apply 不炸、一条路由都不注册，而且**确实在等**（向 inject 报了这条依赖）
//   §2 服务来了：挂起的那次挂载执行，挂的是真路由——HTTP 真打进去拿到 JSON、且不含 Token
//   §3 依赖被换掉：旧路由的摘除器真的被调用（不留指向旧 controller 的僵尸端点）
//   §4 挂载失败：应用不炸、工具照常在（设置页坏了不许把桥接一起带走）
//   §5 热启动（插件被重启那一次）：只挂一次，不重复注册
// 用法：node verify/verify_settings_mount.mjs
import http from 'node:http'
import { Config, apply } from '../lib/index.js'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** 与 src/settings-routes.ts 的 SETTINGS_API_PREFIX 同一个字面量（那是宿主面的契约）。 */
const API_PREFIX = '/browser-control/api'
const ORIGIN = 'http://127.0.0.1:60001'

/**
 * 一个最小假 cordis 上下文，带两个可观测的开关：
 *   - `webServerReady`: 首次 `inject(['webServer'])` 时服务是否已经存在；
 *   - `registerThrows`: `webServer.register` 是否抛错（宿主路由表冻结之类）。
 * `appear()` 模拟「服务终于出现了」——把挂起的那次挂载放出来，这正是真机上插件的依赖
 * 到位那一刻要做的事。
 */
function makeCtx({ webServerReady = false, registerThrows = false } = {}) {
  const logs = []
  const warnings = []
  const tools = []
  const registrations = []
  const unregistered = []
  const pending = []
  const pluginDisposers = []
  const injectedDisposers = []

  const webServer = {
    getOrigin: () => ORIGIN,
    register(route) {
      if (registerThrows) throw new Error('route table is frozen')
      registrations.push(route)
      return () => {
        const at = registrations.indexOf(route)
        if (at >= 0) registrations.splice(at, 1)
        unregistered.push(route)
      }
    },
  }

  // dsh-settings 0.1.7+ / 0.2.x 的导出面：没有 register，只有 configure/describe/…
  // 走的是「没有命名空间」那条兜底路径，与真机同一个分叉。
  const settingsService = {
    configure: () => () => {},
    describe: () => [],
    update: async () => {},
    replace: async () => {},
    mutate: async () => {},
  }

  /** 注入回调收到的子 ctx：服务既在属性上，也在 `get()` 后面。 */
  const childCtx = () => ({
    logger: ctx.logger,
    webServer,
    get(name) {
      if (name === 'webServer') return webServer
      throw new Error(`service not found: ${name}`)
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') injectedDisposers.push(dispose)
      return dispose
    },
  })

  const ctx = {
    logger: {
      info: line => logs.push(String(line)),
      warn: line => warnings.push(String(line)),
      error: () => {},
      debug: () => {},
    },
    fiber: { state: 2, uid: 1 },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') pluginDisposers.push(dispose)
      return dispose
    },
    inject(deps, callback) {
      if (deps.includes('settings')) { callback({ settings: settingsService, logger: ctx.logger }); return }
      if (deps.includes('webServer')) {
        if (webServerReady) callback(childCtx())
        else pending.push(() => callback(childCtx()))
        return
      }
    },
    tools: { register: definition => { tools.push(definition?.name); return () => {} } },
    systemPrompt: { section: () => () => {} },
  }

  return {
    ctx, logs, warnings, tools, registrations, unregistered, pending, injectedDisposers,
    /** 「webServer 服务出现了」：把挂起的挂载放出来，返回放出了几个。 */
    appear() {
      const queued = pending.splice(0)
      for (const run of queued) run()
      return queued.length
    },
  }
}

/** 一份最小可用配置：关掉监听，免得验台去抢真机占着的 9777。 */
const config = () => Config({ enabled: false, port: 9778, token: 'dsh-local', lazyToolDocs: false })

/** 用真 HTTP 打一次已挂上的路由（Node 的 fetch 不允许伪造 Host，只能走原生请求）。 */
function request(port, { path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function serve(route) {
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

// ---- §1) 冷启动：服务还没出现 ----
const cold = makeCtx({ webServerReady: false })
try {
  apply(cold.ctx, config())
  check('§1 冷启动时 apply 不抛', true)
} catch (error) {
  check('§1 冷启动时 apply 不抛', false, String((error && error.message) || error))
}
check('§1 服务没来：一条路由都不许注册', cold.registrations.length === 0, `registrations=${cold.registrations.length}`)
check('§1 但它确实在等这条依赖（而不是探一次就走）', cold.pending.length === 1, `pending=${cold.pending.length}`)
check('§1 也不该谎报「这个组合里没有 webServer」', !cold.logs.some(line => line.includes('no webServer')),
  cold.logs.filter(line => line.includes('webServer')).join(' | '))
// 工具与桥接是另一条路，冷启动就该已经就位——设置页晚挂不该影响它们。
check('§1 冷启动时工具已经注册好', cold.tools.includes('browser_navigate') && cold.tools.length >= 20,
  `tools=${cold.tools.length}`)

// ---- §2) 服务出现：挂起的那次挂载被执行，挂的是真路由 ----
const appeared = cold.appear()
check('§2 服务出现后挂起的挂载被执行', appeared === 1, `ran=${appeared}`)
check('§2 正好挂了一条路由', cold.registrations.length === 1, `registrations=${cold.registrations.length}`)
const route = cold.registrations[0]
check('§2 挂的是本插件的同源前缀路由', route?.kind === 'prefix' && route?.path === API_PREFIX,
  JSON.stringify({ kind: route?.kind, path: route?.path }))

if (route) {
  const { server, port } = await serve(route)
  const ok = await request(port, { path: `${API_PREFIX}/status`, headers: { host: `127.0.0.1:${port}` } })
  let payload = null
  try { payload = JSON.parse(ok.text) } catch { payload = null }
  check('§2 这条路由真的能答 /status（200 + JSON）', ok.status === 200 && payload?.ok === true,
    `status=${ok.status} body=${ok.text.slice(0, 80)}`)
  check('§2 状态体里带着 bridge 与 config 两段', payload?.value?.bridge !== undefined && payload?.value?.config !== undefined,
    Object.keys(payload?.value ?? {}).join(','))
  check('§2 状态体里没有 Token 原文', !ok.text.includes('dsh-local'), ok.text.slice(0, 120))
  // 挂载方式变了，但这条路由自己的浏览器信任栅栏必须还在。
  const crossSite = await request(port, {
    path: `${API_PREFIX}/status`,
    headers: { host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' },
  })
  check('§2 跨站请求仍被拒（403）', crossSite.status === 403, `status=${crossSite.status} body=${crossSite.text}`)
  await new Promise(resolve => server.close(resolve))
}

// ---- §3) 依赖被换掉：旧路由必须跟着摘掉 ----
check('§3 注入范围内确实记下了摘除器', cold.injectedDisposers.length === 1, `disposers=${cold.injectedDisposers.length}`)
for (const dispose of cold.injectedDisposers.splice(0)) {
  try { dispose() } catch { /* 摘除失败不该让验台炸 */ }
}
check('§3 摘除后一条路由都不剩', cold.registrations.length === 0, `registrations=${cold.registrations.length}`)
check('§3 register 给的摘除函数真的被调用了', cold.unregistered.length === 1, `unregistered=${cold.unregistered.length}`)

// ---- §4) 挂载失败：不许把桥接一起带走 ----
const thrower = makeCtx({ webServerReady: true, registerThrows: true })
try {
  apply(thrower.ctx, config())
  check('§4 register 抛错时 apply 不抛', true)
} catch (error) {
  check('§4 register 抛错时 apply 不抛', false, String((error && error.message) || error))
}
check('§4 失败被记进日志（warn）', thrower.warnings.some(line => line.includes('settings route not mounted')),
  thrower.warnings.join(' | '))
check('§4 工具照常注册（AI 还能用浏览器）', thrower.tools.includes('browser_click') && thrower.tools.length >= 20,
  `tools=${thrower.tools.length}`)
check('§4 也没有偷偷挂上一条半成品路由', thrower.registrations.length === 0, `registrations=${thrower.registrations.length}`)

// ---- §5) 热启动：服务已在（插件被关掉再打开那一次） ----
const warm = makeCtx({ webServerReady: true })
apply(warm.ctx, config())
check('§5 服务已在时立刻挂上', warm.registrations.length === 1, `registrations=${warm.registrations.length}`)
check('§5 没有多余的挂起等待', warm.pending.length === 0, `pending=${warm.pending.length}`)
warm.appear()
check('§5 之后再触发一次也不会重复注册', warm.registrations.length === 1, `registrations=${warm.registrations.length}`)

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
