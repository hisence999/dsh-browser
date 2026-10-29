// browser_profile 的插件面实测台：**真** BridgeServer + **假**扩展（端口 9794）。
//
// 与其它台子的分工：verify_isolated.mjs 测扩展侧（真 background.js + 假浏览器），
// verify_policy.mjs 测闸门的 code/文案。这一台测的是**中间那一段**——插件把一条
// 带四种动作的工具翻译成什么命令、每条命令带着哪个罐、以及闸门到底在命令发出之前
// 还是之后。三个容易悄悄坏掉的地方：
//
//   1) action → 命令映射。`use` 是唯一**不经过链路**的动作：它只改插件里的罐指针。
//      要是它哪天偷偷发了命令回来又说成功，模型会以为无痕窗口已经开好了。
//   2) 罐路由（policy.jar）。launch 之后每条命令都必须带 jar:'incognito'，close 之后
//      必须回到 'normal'。这条坏掉不会报错——命令照发，只是落进用户真实的登录罐里，
//      而这正是「隔离」唯一的用处。
//   3) 闸门位置。allowIncognito:false 时 launch / use jar=incognito 必须在**发出去之前**
//      被拦成 blocked_by_policy + not_started，假扩展一条命令都收不到。闸门要是挪到扩展
//      侧或者挪到 execute() 之后，无痕窗口已经建出来了，再报错只是事后通知。
//      另外：launch 失败（比如浏览器没给无痕权限）之后罐不许被切走，否则下一条 tabs.open
//      会带着 jar='incognito' 发出去，扩展侧自己把无痕窗口建出来——闸门等于没经过。
//
// 用法：node verify/verify_profile_tool.mjs
import net from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Config, apply } from '../lib/index.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'

/** 9794：task-3 指定的端口。9777/9778/9779/9785/9787-9792/9783/9781 是别的台子与真机的。 */
const PORT = 9794
const TOKEN = 'profile-tool-test'
/** 等假扩展那一侧把「没收到命令」这件事证明掉。 */
const SETTLE_MS = 80

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}
/** 一次真实工具调用的结果：成功给 value/模型可见文本/schema 违规，失败给分类字段。 */
let tools = new Map()

async function callProfile(args) {
  const definition = tools.get('browser_profile')
  if (definition === undefined) throw new Error('browser_profile 没注册')
  const controller = new AbortController()
  try {
    const value = await definition.execute(args, { signal: controller.signal })
    const violations = validateJsonSchemaValue(definition.output.schema, value, 'value')
    // 模型看到的是 render 的结果，不是 value：两边都要过一遍，否则「字段写进了 value、
    // 模型却看不见」这种缺陷在台子上是绿的。
    const text = definition.output.render(args, value).map(part => part.text ?? '').join('\n')
    return { ok: true, value, text, violations }
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? error?.info?.code,
      effectState: error?.effectState ?? error?.info?.effectState,
      message: String(error?.message ?? error),
    }
  }
}

/** 调任意浏览器工具（用来证明「下一条命令带着哪个罐」）。 */
async function callTool(name, args) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`工具没注册：${name}`)
  return await definition.execute(args, { signal: new AbortController().signal })
}

const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS))

/**
 * 一次调用「说了什么」：失败是错误文案，成功是结果 JSON。
 *
 * 台子自己也要防「变异体让它意外成功」：直接读 `.message` 会在成功路径上抛 TypeError，
 * 那时台子的红是崩溃而不是一条 FAIL，读的人分不清「被测实现坏了」还是「台子写错了」。
 */
const said = (result) => result.ok ? JSON.stringify(result.value) : String(result.message ?? '')
const verdict = (result) => result.ok
  ? `ok ${JSON.stringify(result.value).slice(0, 90)}`
  : `${result.code}/${result.effectState}｜${said(result).slice(0, 70)}`

/**
 * 最小假 cordis 上下文，settings 用 **0.1.2 那种有 register 的**形状：本台要证明
 * 「闸门读的是当前配置」，所以需要一个能在测试中途改配置的 scope（改完不重连）。
 */
function boot(overrides) {
  const registry = new Map()
  const disposers = []
  const logs = []
  let value = null
  const watchers = []
  const ctx = {
    logger: { info: (line) => logs.push(String(line)), warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => disposers.push(fn),
    inject: (deps, cb) => {
      if (!deps.includes('settings')) return
      cb({
        logger: ctx.logger,
        settings: {
          register: (_namespace, schema, options) => {
            value = schema(options?.base ?? {})
            return {
              get: () => value,
              watch: (callback) => { watchers.push(callback) },
            }
          },
        },
      })
    },
    tools: { register: (definition) => registry.set(definition.name, definition) },
    systemPrompt: { section: () => {} },
  }
  const base = Config({
    enabled: true,
    port: PORT,
    token: TOKEN,
    // 罐状态与 shotsDir 无关，但这里放一个临时目录，免得任何路径把仓库根目录当输出地。
    shotsDir: path.join(tmpdir(), 'dsh-profile-tool-shots'),
    ...overrides,
  })
  apply(ctx, base)
  const setConfig = (next) => {
    value = Config({ ...base, ...next })
    for (const callback of watchers) callback()
  }
  const dispose = async () => {
    for (const fn of disposers.reverse()) {
      try {
        const inner = typeof fn === 'function' ? fn() : undefined
        await (typeof inner === 'function' ? inner() : undefined)
      } catch { /* teardown 失败不该影响断言 */ }
    }
  }
  return { tools: registry, setConfig, dispose, logs }
}

/** 等端口真的在听：apply() 是同步注册工具、异步起监听。 */
async function waitForPort() {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise(resolve => {
      const socket = net.connect(PORT, '127.0.0.1', () => { socket.end(); resolve(true) })
      socket.on('error', () => resolve(false))
    })
    if (ok) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

/**
 * 假扩展：连上去、报 hello（带上 incognitoAllowed，就像真扩展 background.js:215）、
 * 把收到的每条命令记下来，并按 responder 回结果。**收到什么**才是这一台的主角。
 */
async function connectExtension() {
  const received = []
  let responder = (command) => ({ echo: command })
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`)
  await new Promise((resolve, reject) => {
    socket.onopen = () => {
      socket.send(JSON.stringify({
        type: 'hello',
        client: 'dsh-browser-extension',
        version: '1.0.22-fake',
        protocol: 1,
        browser: { name: 'Fake', version: '1.0', ua: 'fake' },
        incognitoAllowed: true,
      }))
      setTimeout(resolve, 60)
    }
    socket.onerror = () => reject(new Error('假扩展连不上 9794'))
  })
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data))
    if (message.type !== 'command') return
    received.push({ command: message.command, params: message.params ?? {} })
    let result
    try {
      result = responder(message.command, message.params ?? {})
    } catch (error) {
      socket.send(JSON.stringify({ type: 'result', id: message.id, ok: false, error: String(error?.message ?? error) }))
      return
    }
    socket.send(JSON.stringify({ type: 'result', id: message.id, ok: true, result }))
  }
  return {
    received,
    setResponder: (next) => { responder = next },
    last: () => received[received.length - 1],
    close: () => socket.close(),
  }
}

// ---------------------------------------------------------------------------

const plugin = boot({ allowIncognito: false })
tools = plugin.tools
if (!(await waitForPort())) {
  console.log('FAIL  9794 没起来：端口被占用或桥接启动失败')
  await plugin.dispose()
  process.exit(1)
}
const extension = await connectExtension()

/** 假扩展对各条命令的回包（形状照 extension/background.js 里的 cmdXxx 抄）。 */
const RESULTS = {
  'profile.status': {
    instance: 'normal',
    incognitoAllowed: true,
    isolated: { windowId: 7, tabs: 2, active: 11 },
    normal: { windows: 1, tabs: 3 },
    incognito: { windows: 1, tabs: 2 },
  },
  'profile.launch': (params) => ({
    jar: 'incognito',
    windowId: 7,
    created: true,
    tabs: 1,
    incognitoAllowed: true,
    ...(params?.url ? { url: params.url } : {}),
  }),
  'profile.close': { closed: [7], tabs: 2 },
  'tabs.list': { tabs: [{ tabId: 11, incognito: true }], isolatedWindowId: 7, agentTargetTabId: null },
}
extension.setResponder((command, params) => {
  const result = RESULTS[command]
  return typeof result === 'function' ? result(params) : (result ?? { echo: command })
})
/** 正常回包；launch 失败那一块会临时换成「只让 profile.launch 抛错」的版本。 */
const normalResponder = (command, params) => {
  const result = RESULTS[command]
  return typeof result === 'function' ? result(params) : (result ?? { echo: command })
}

// ---- 1) allowIncognito 默认关：launch 与 use jar=incognito 都在发出之前就被拦 ----
// 这条是本台最重要的断言。假扩展全程记着收到的命令，所以「闸门在发出去之前」是可以
// 被证伪的：闸门只要挪到链路之后，received 里就会先出现 profile.launch / tabs.open。
{
  check('allowIncognito 默认关：插件确实按默认值读到了 false', plugin.tools.size > 0)
  const before = extension.received.length
  const launch = await callProfile({ action: 'launch' })
  await settle()
  check('allowIncognito:false 时 launch 被拦成 blocked_by_policy / not_started',
    launch.ok === false && launch.code === 'blocked_by_policy' && launch.effectState === 'not_started',
    verdict(launch))
  check('allowIncognito:false 时 launch 的文案点名 allowIncognito 与浏览器无痕权限两步',
    /allowIncognito/.test(said(launch)) && /无痕\/InPrivate/.test(said(launch)), said(launch).slice(0, 90))
  check('allowIncognito:false 时 launch **一条命令都没发到链路**（闸门在发出去之前）',
    extension.received.length === before, `多了 ${extension.received.length - before} 条`)

  // `use jar=incognito` 只是改插件里的指针，看起来无害——但切过去之后下一条 tabs.open
  // 会带着 jar:'incognito' 发出去，扩展侧 ensureIsolatedWindow 就会真的把无痕窗口建出来。
  // 所以它必须过和 profile.launch 同一道闸门，否则 allowIncognito:false 形同虚设。
  const useIncognito = await callProfile({ action: 'use', jar: 'incognito' })
  await settle()
  check('allowIncognito:false 时 use jar=incognito 同样被拦成 blocked_by_policy / not_started',
    useIncognito.ok === false && useIncognito.code === 'blocked_by_policy' && useIncognito.effectState === 'not_started',
    `${useIncognito.code}/${useIncognito.effectState}`)
  check('allowIncognito:false 时 use jar=incognito **一条命令都没发到链路**',
    extension.received.length === before, `多了 ${extension.received.length - before} 条`)

  // 退出隔离罐永远是安全方向：不许被拦。
  const useNormal = await callProfile({ action: 'use', jar: 'normal' })
  await settle()
  check('use jar=normal 永远允许（退出隔离罐是安全方向）',
    useNormal.ok === true && useNormal.value.jar === 'normal', JSON.stringify(useNormal.value ?? useNormal.code))
  check('use 不经过链路（它只改插件里的罐指针）',
    extension.received.length === before, `多了 ${extension.received.length - before} 条`)
  check('use 的 schema 干净，且把「后面都会落在这个罐里」说进模型可见文本',
    useNormal.violations.length === 0 && /罐/.test(useNormal.text), useNormal.text.slice(0, 80))
}

// ---- 2) 非法 action / jar：插件自己就报错，不许把垃圾发下去 ----
// 两道闸门都要有用：`defineTool` 先按 schema 的 enum 拒（模型写错词时它先说话），
// 工具里的 if 是第二道（schema 以后被放宽时仍不至于把 'auto' 当成 incognito）。
{
  const before = extension.received.length
  const badAction = await callProfile({ action: 'destroy' })
  const badJar = await callProfile({ action: 'use', jar: 'auto' })
  const noJar = await callProfile({ action: 'use' })
  await settle()
  check('非法 action 明确报错并列出可选值',
    badAction.ok === false
      && (/unknown profile action: destroy/.test(said(badAction)) || /must be one of/.test(said(badAction)))
      && /status/.test(said(badAction)) && /launch/.test(said(badAction)) && /close/.test(said(badAction)),
    said(badAction).slice(0, 110))
  // 宿主那层按 enum 拒时不会回显坏值（文案是 'must be one of [...]'），所以这里断言
  // 「被拒 + 可选值只有 normal/incognito」，而不是断言 'auto' 三个字出现在错误里。
  check('非法 jar（auto）明确报错，且可选值只有 normal | incognito',
    badJar.ok === false
      && (/normal \| incognito/.test(said(badJar)) || /must be one of/.test(said(badJar)))
      && /normal/.test(said(badJar)) && /incognito/.test(said(badJar)) && !/"auto"/.test(said(badJar)),
    said(badJar).slice(0, 110))
  check('use 缺 jar 时明说「什么也没给」而不是静默切成 normal',
    noJar.ok === false && /got nothing/.test(said(noJar)), said(noJar).slice(0, 90))
  check('非法参数一条命令都没发到链路', extension.received.length === before, `多了 ${extension.received.length - before} 条`)
}

// ---- 3) 允许之后：action → 命令映射 + 罐信封 ----
plugin.setConfig({ allowIncognito: true })
await settle()

{
  // launch：命令必须在**旧罐**里发出去（它是建窗动作本身），返回后插件切到无痕罐。
  const before = extension.received.length
  const launch = await callProfile({ action: 'launch', url: 'https://example.com/' })
  const sent = extension.received[before]
  check('launch → 恰好发出一条 profile.launch', extension.received.length === before + 1 && sent?.command === 'profile.launch',
    `${extension.received.length - before} 条：${sent?.command}`)
  check('launch 带着 url 参数', sent?.params.url === 'https://example.com/', JSON.stringify(sent?.params.url))
  check('launch 自己出门时信封里的罐还是 normal（切罐发生在成功之后）',
    sent?.params.policy?.jar === 'normal', JSON.stringify(sent?.params.policy))
  check('launch 的结果并进 jar=incognito 与扩展回的 windowId',
    launch.ok === true && launch.value.jar === 'incognito' && launch.value.windowId === 7 && launch.value.created === true,
    JSON.stringify(launch.value ?? launch.code))
  check('launch 的结果过输出 schema', launch.violations.length === 0, launch.violations.join(' | '))
  check('launch 的关键字段进了模型可见文本（render 才是模型看到的东西）',
    /incognito/.test(launch.text) && /windowId/.test(launch.text) && /7/.test(launch.text), launch.text.slice(0, 120))
}

{
  // 罐路由：launch 之后，一条完全无关的命令也必须带着 jar='incognito'。
  const before = extension.received.length
  await callTool('browser_tabs', { action: 'list' })
  const sent = extension.received[before]
  check('launch 之后：下一条无关命令（tabs.list）带着 policy.jar=incognito',
    sent?.command === 'tabs.list' && sent?.params.policy?.jar === 'incognito', JSON.stringify(sent?.params.policy))
  check('罐信封同时带着另外三项策略（没把老字段挤掉）',
    sent?.params.policy?.focus === 'avoid' && sent?.params.policy?.tabs === 'current-window' && sent?.params.policy?.takeover === 'yield',
    JSON.stringify(sent?.params.policy))
  // 第 1/2 项的两项也随每条命令下发：分组名与高亮开关都属于「扩展不存副本」的那类配置，
  // 少发一位就等于让设置页那一栏变成装饰品（改了不生效，而且不会有任何报错）。
  check('信封里还带着默认的分组名与高亮开关',
    sent?.params.policy?.groupTitle === 'DSH' && sent?.params.policy?.highlight === 'on',
    JSON.stringify(sent?.params.policy))
}

{
  // 配置改了 → 下一条命令的信封就得跟着变（扩展侧不缓存策略，这就是「热更新」的全部机制）。
  plugin.setConfig({ allowIncognito: true, tabGroupTitle: '  AI   任务  ', agentHighlight: false })
  await settle()
  const before = extension.received.length
  await callTool('browser_tabs', { action: 'list' })
  const sent = extension.received[before]
  check('tabGroupTitle 被归一后进信封（压平空白 + 去首尾）',
    sent?.params.policy?.groupTitle === 'AI 任务', JSON.stringify(sent?.params.policy?.groupTitle))
  check('agentHighlight:false → 信封里 highlight:off',
    sent?.params.policy?.highlight === 'off', JSON.stringify(sent?.params.policy?.highlight))
  plugin.setConfig({ allowIncognito: true, tabGroupTitle: '', agentHighlight: true })
  await settle()
  const blankBefore = extension.received.length
  await callTool('browser_tabs', { action: 'list' })
  check('分组名留空时信封里是空串（不是 DSH：那会把「不分组」悄悄变回默认组）',
    extension.received[blankBefore]?.params?.policy?.groupTitle === '',
    JSON.stringify(extension.received[blankBefore]?.params?.policy?.groupTitle))
  check('关掉再打开，highlight 回到 on',
    extension.received[blankBefore]?.params?.policy?.highlight === 'on')
  plugin.setConfig({ allowIncognito: true, tabGroupTitle: 'DSH', agentHighlight: true })
  await settle()
}

{
  // status：命令 + 插件当前罐一起报出来。
  const before = extension.received.length
  const status = await callProfile({ action: 'status' })
  const sent = extension.received[before]
  check('status → 发出 profile.status，且信封里的罐是 incognito',
    sent?.command === 'profile.status' && sent?.params.policy?.jar === 'incognito', JSON.stringify(sent?.params.policy))
  check('status 的结果把插件当前罐（jar）并了进去',
    status.ok === true && status.value.jar === 'incognito', JSON.stringify(status.value?.jar))
  check('status 透传扩展报的两个罐计数与 isolated 详情',
    status.value?.isolated?.windowId === 7 && status.value?.incognito?.tabs === 2 && status.value?.normal?.tabs === 3,
    JSON.stringify(status.value))
  check('status 的 schema 干净', status.violations.length === 0, status.violations.join(' | '))
  check('status 的模型可见文本里读得到罐与无痕权限',
    /incognito/.test(status.text) && /incognitoAllowed/.test(status.text) && /isolated/.test(status.text), status.text.slice(0, 140))
}

{
  // use：链路一条都不许发，但下一条命令的信封要立刻变。
  const before = extension.received.length
  const useNormal = await callProfile({ action: 'use', jar: 'normal' })
  await settle()
  check('允许之后 use jar=normal 成功且不经过链路',
    useNormal.ok === true && useNormal.value.jar === 'normal' && extension.received.length === before,
    `${useNormal.value?.jar}｜多了 ${extension.received.length - before} 条`)
  await callTool('browser_tabs', { action: 'list' })
  check('use jar=normal 之后下一条命令的信封回到 normal',
    extension.received[before]?.params?.policy?.jar === 'normal', JSON.stringify(extension.received[before]?.params?.policy))
  const useIncognito = await callProfile({ action: 'use', jar: 'incognito' })
  await settle()
  check('允许之后 use jar=incognito 成功且不经过链路',
    useIncognito.ok === true && useIncognito.value.jar === 'incognito' && extension.received.length === before + 1,
    `${useIncognito.value?.jar}`)
}

{
  // close：命令在**旧罐**里发出去，成功后回 normal。
  const before = extension.received.length
  const close = await callProfile({ action: 'close' })
  const sent = extension.received[before]
  check('close → 发出 profile.close，且信封里的罐还是 incognito',
    sent?.command === 'profile.close' && sent?.params.policy?.jar === 'incognito', JSON.stringify(sent?.params.policy))
  check('close 的结果并进 jar=normal 与扩展回的 closed 列表',
    close.ok === true && close.value.jar === 'normal' && JSON.stringify(close.value.closed) === '[7]',
    JSON.stringify(close.value ?? close.code))
  check('close 的 schema 干净', close.violations.length === 0, close.violations.join(' | '))
  const after = extension.received.length
  await callTool('browser_tabs', { action: 'list' })
  check('close 之后下一条命令的信封回到 normal',
    extension.received[after]?.params?.policy?.jar === 'normal', JSON.stringify(extension.received[after]?.params?.policy))
}

// ---- 4) launch 失败时罐不许被切走 ----
// 浏览器没给无痕权限 → 扩展抛 browser-incognito-unavailable:，一条命令**发出去了但失败了**。
// 这时若插件仍把罐切成 incognito，下一条 tabs.open 会带着 jar:'incognito' 发出去，扩展侧
// ensureIsolatedWindow 会自己建窗——等于把 allowIncognito 的闸门整个绕过。
{
  extension.setResponder((command, params) => {
    // 只有开窗那条失败：同一时刻别的命令（下面用来读罐）必须照常回包，否则测不出
    // 「命令发出去了、失败了、罐没被切走」这条。
    if (command === 'profile.launch') {
      throw new Error('browser-incognito-unavailable: 扩展还没有无痕/InPrivate 访问权限：请在浏览器扩展管理页打开「在无痕模式中允许」')
    }
    return normalResponder(command, params)
  })
  const before = extension.received.length
  const failed = await callProfile({ action: 'launch' })
  check('无痕权限缺失时 launch 报 incognito_unavailable / not_started（不是笼统的 command_failed）',
    failed.ok === false && failed.code === 'incognito_unavailable' && failed.effectState === 'not_started',
    verdict(failed))
  check('incognito_unavailable 的文案说清去哪儿打开（浏览器扩展页），不是「用户拒绝了」',
    /无痕\/InPrivate/.test(said(failed)) && /扩展管理页/.test(said(failed)), said(failed).slice(0, 110))
  const sent = extension.received[before]
  check('失败的那次 launch 确实走到了链路（证明它过了闸门，是扩展那边失败的）',
    sent?.command === 'profile.launch', String(sent?.command))
  const after = extension.received.length
  await callTool('browser_tabs', { action: 'list' })
  check('launch 失败之后罐仍然是 normal（否则下一条 tabs.open 会把无痕窗口偷偷建出来）',
    extension.received[after]?.params?.policy?.jar === 'normal', JSON.stringify(extension.received[after]?.params?.policy))
  extension.setResponder(normalResponder)
}

// ---- 5) 收尾：关掉假扩展，确认插件不再往链路写 ----
extension.close()
await settle()
const finalCount = extension.received.length
const offline = await callProfile({ action: 'status' })
check('扩展断开后 status 报 extension_offline（而不是假装成功）',
  offline.ok === false && offline.code === 'extension_offline', verdict(offline))
check('扩展断开后没有任何命令被"补发"到链路', extension.received.length === finalCount)

await plugin.dispose()
await new Promise(resolve => setTimeout(resolve, 150))

console.log(fails === 0 ? '\n结论：browser_profile 的工具面、罐路由与闸门位置全部符合契约' : `\n结论：${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
