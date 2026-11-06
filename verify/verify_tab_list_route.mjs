// 「输入框 @ 菜单引用浏览器标签页」——**两半都在这一台里钉**：
//
//   A. 扩展侧（`extension/background.js`）：`tabs.list` 每行新增 `openedByAgent`，语义是
//      「这一页是 AI 亲手建的」，只有 `tabs.open` 会写它。这里用 `ext_harness.mjs` **真跑**
//      扩展代码（照 `verify_ownership.mjs` 的 bootBackground 用法），不是文本断言。
//
//   B. 宿主侧（`src/settings-routes.ts`）：`GET /browser-control/api/tabs` 的过滤、排序、
//      上限、缓存与降级，以及 `POST …/tabs/activate` 的转发与校验。照
//      `verify_settings_routes.mjs` 起真 http server + 真 `buildSettingsRoute(deps)`。
//
// 为什么 A 和 B 必须分开钉：这两件事拼起来才成立，各自单独都是「不会报错、只会安静做错」。
//   - 扩展报错一个 `openedByAgent` → AI 自己开的页出现在用户的 @ 菜单里；
//   - 扩展把 `owned` 当 `openedByAgent` 用 → 用户自己拖进 AI 组的那类页（最该被引用的页）
//     被误滤掉；
//   - 宿主忘了过滤无痕 → 无痕罐里的页进了模型上下文（用户拍板过：不列无痕）；
//   - 宿主没有缓存 → @ 菜单每敲一个键就打一次扩展。
//
// 用法：node verify/verify_tab_list_route.mjs
import http from 'node:http'
import { bootBackground, makeModel } from './ext_harness.mjs'
import {
  buildSettingsRoute, createReferenceTabsCache, selectReferenceTabs, SETTINGS_API_PREFIX, TAB_REFERENCE_TTL_MS,
} from '../src/settings-routes.ts'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** 整台上界：B 段有几处「等缓存过期」的 sleep，卡住就会变成 CI 上的「跑到一半没下文」。 */
const watchdog = setTimeout(() => {
  console.log('FAIL  整套超时（>90s）：某条用例把进程挂住了（先看缓存过期那几条）')
  process.exit(1)
}, 90_000)
watchdog.unref?.()
process.on('uncaughtException', (error) => {
  console.log(`FAIL  未捕获异常：${String(error?.message ?? error)}`)
  process.exit(1)
})

/* ======================================================================
 * A. 扩展侧：openedByAgent 的语义
 * ==================================================================== */

/** 一台独立的假浏览器 + 一份独立的 `chrome.storage`（local 与 session 分开给）。 */
const bootExt = async (reuse) => {
  const model = reuse?.model ?? makeModel()
  const local = reuse?.local ?? {}
  const session = reuse?.session ?? {}
  const { ctx } = await bootBackground({ model, storage: local, sessionStorage: session })
  return { model, ctx, local, session }
}

/** 开一个「AI 自己的」标签页：`active:false` 很关键——用户还留在自己那页上。 */
const openQuiet = (ctx, url = 'https://agent.test/') =>
  ctx.cmdTabsOpen({ url, wait: false, active: false, group: false })

const rowOf = (listed, id) => (listed.tabs ?? []).find((row) => Number(row.id) === Number(id))

/* A1 —— 每一行都带 openedByAgent，且用户自己开的页是 false */
{
  const { model, ctx } = await bootExt()
  const user = model.addTab(1, 'https://user.test/a')
  const listed = await ctx.cmdTabsList()
  check('A1 tabs.list 的每一行都带 openedByAgent，且是布尔（不是 undefined、不是 0/1）',
    listed.tabs.length > 0 && listed.tabs.every((row) => typeof row.openedByAgent === 'boolean'),
    JSON.stringify(listed.tabs.map((row) => [row.id, row.openedByAgent])))
  check('A1 用户自己开的标签页 openedByAgent=false（老页一个都不许被算成 AI 的）',
    rowOf(listed, user)?.openedByAgent === false, JSON.stringify(rowOf(listed, user)))
  check('A1 老字段 owned/yielded 没被这次改动挤掉',
    typeof rowOf(listed, user)?.owned === 'boolean' && typeof rowOf(listed, user)?.yielded === 'boolean',
    JSON.stringify(rowOf(listed, user)))
}

/* A2 —— 只有 tabs.open 真的新建的页才是 true，且记录落 chrome.storage.session */
{
  const { ctx, session, local } = await bootExt()
  const opened = await openQuiet(ctx)
  const listed = await ctx.cmdTabsList()
  const agentRow = rowOf(listed, opened.tabId)
  check('A2 tabs.open 建出来的页 openedByAgent=true', agentRow?.openedByAgent === true,
    JSON.stringify(agentRow))
  check('A2 同一行的 owned 也是 true（两张表是两件事，但自己开的页两边都该成立）',
    agentRow?.owned === true, JSON.stringify({ owned: agentRow?.owned, openedByAgent: agentRow?.openedByAgent }))

  const record = session.agentState
  const entry = record?.openedByAgent?.[opened.tabId]
  check('A2 记录落在 chrome.storage.session 的 agentState.openedByAgent',
    entry !== undefined, JSON.stringify(Object.keys(record ?? {})))
  check('A2 记录形状是 { at: 时间戳 }，只有这一个字段',
    entry !== undefined && JSON.stringify(Object.keys(entry)) === JSON.stringify(['at']) && Number.isFinite(entry.at),
    JSON.stringify(entry))
  check('A2 这份记录**不**落 chrome.storage.local（否则下一轮浏览器还记着上一轮的 tabId）',
    local.agentState === undefined, JSON.stringify(Object.keys(local)))
}

/* A3 —— 关键反例：tabs.group 把**用户的**页认领之后，owned 变 true，openedByAgent 必须仍是 false */
{
  const { model, ctx } = await bootExt()
  const user = model.addTab(1, 'https://user.test/mine')
  const grouped = await ctx.cmdTabGroup({ tabId: user })
  check('A3 tabs.group 确实把用户的页认领成 owned（老语义不变）', grouped.owned === true, JSON.stringify(grouped))
  const listed = await ctx.cmdTabsList()
  const row = rowOf(listed, user)
  check('A3 但 openedByAgent 必须仍是 false —— 否则 @ 菜单会把用户最该被引用的页滤掉',
    row?.owned === true && row?.openedByAgent === false,
    JSON.stringify({ owned: row?.owned, openedByAgent: row?.openedByAgent }))
  check('A3 认领的那一页也没被写进 openedByAgent 的记录表',
    (await ctx.syncAgentState()).openedByAgent[user] === undefined, String(user))
}

/* A4 —— 另外两条「认领/跟随」路径（tabs.activate、followWriteTo）都不许写 openedByAgent */
{
  const { model, ctx } = await bootExt()
  const claimed = model.addTab(1, 'https://user.test/claimed')
  const followed = model.addTab(1, 'https://user.test/followed')
  // 先让这两页都是 owned（否则 followWriteTo 本来就会早退，测不到「写了没写」）
  await ctx.cmdTabGroup({ tabId: claimed })
  await ctx.cmdTabGroup({ tabId: followed })

  await ctx.cmdTabsActivate({ tabId: claimed })
  const afterActivate = await ctx.syncAgentState()
  check('A4 tabs.activate 把默认目标挪过去，但不写 openedByAgent',
    afterActivate.target === claimed && afterActivate.openedByAgent[claimed] === undefined,
    JSON.stringify({ target: afterActivate.target, marked: afterActivate.openedByAgent[claimed] }))

  await ctx.followWriteTo(followed)
  const afterFollow = await ctx.syncAgentState()
  check('A4 followWriteTo 挪默认目标（证明它真的动了）',
    afterFollow.target === followed, JSON.stringify({ target: afterFollow.target, want: followed }))
  check('A4 followWriteTo 不写 openedByAgent（写命令跟随 ≠ AI 建过这一页）',
    afterFollow.openedByAgent[followed] === undefined, JSON.stringify(afterFollow.openedByAgent))

  const listed = await ctx.cmdTabsList()
  check('A4 两页在 tabs.list 里都还是 openedByAgent=false',
    rowOf(listed, claimed)?.openedByAgent === false && rowOf(listed, followed)?.openedByAgent === false,
    JSON.stringify([rowOf(listed, claimed)?.openedByAgent, rowOf(listed, followed)?.openedByAgent]))
}

/* A5 —— service worker 被回收：内存全丢，openedByAgent 必须还在 */
{
  const first = await bootExt()
  const opened = await openQuiet(first.ctx)
  // 同一台假浏览器 + 同一份 storage，换一个全新的 vm context = MV3 的 worker 回收/唤醒
  const revived = await bootExt({ model: first.model, local: first.local, session: first.session })
  const listed = await revived.ctx.cmdTabsList()
  check('A5 worker 回收再唤醒：AI 开的那页仍然 openedByAgent=true（不能一秒后出现在 @ 菜单里）',
    rowOf(listed, opened.tabId)?.openedByAgent === true, JSON.stringify(rowOf(listed, opened.tabId)))
  check('A5 回收唤醒后 close 仍认得它是自己的（归属与这张表都没丢）',
    (await revived.ctx.cmdTabsClose({ tabId: opened.tabId })).closed.join() === String(opened.tabId))
}

/* A6 —— forgetOwned：关标签页必须把记录删掉（tabId 会被 Chrome 复用，幽灵记录会永久误滤） */
{
  const { ctx, session } = await bootExt()
  const opened = await openQuiet(ctx)
  await ctx.cmdTabsClose({ tabId: opened.tabId })
  check('A6 关掉之后 openedByAgent 记录从 session 里删干净（不留幽灵）',
    session.agentState?.openedByAgent?.[opened.tabId] === undefined,
    JSON.stringify(session.agentState?.openedByAgent))
}

/* A7 —— forgetOwned：拆组（= 放手）也要删，而且删的时候那一页还活着 */
{
  const { model, ctx, session } = await bootExt()
  // group 默认开：这一页既 owned 又被记成 openedByAgent
  const opened = await ctx.cmdTabsOpen({ url: 'https://agent.test/grouped', wait: false, active: false })
  check('A7 前提：tabs.open 默认归组成功且被记成 AI 的',
    opened.grouped === true && session.agentState?.openedByAgent?.[opened.tabId] !== undefined,
    JSON.stringify({ grouped: opened.grouped, marked: session.agentState?.openedByAgent?.[opened.tabId] }))
  const released = await ctx.cmdTabUngroup({})
  check('A7 tabs.ungroup 真的拆了组', released.ungrouped >= 1, JSON.stringify(released))
  check('A7 那一页仍然开着（所以记录消失只能来自 forgetOwned，不是关页带走的）',
    model.tabs.has(opened.tabId), [...model.tabs.keys()].join(','))
  const listed = await ctx.cmdTabsList()
  check('A7 放手之后 openedByAgent 也归零（两条记录同生共死）',
    rowOf(listed, opened.tabId)?.openedByAgent === false && rowOf(listed, opened.tabId)?.owned === false,
    JSON.stringify(rowOf(listed, opened.tabId)))
}

/* ======================================================================
 * B. 宿主路由：GET /browser-control/api/tabs 与 POST …/tabs/activate
 * ==================================================================== */

/**
 * 一份可用的默认依赖。
 *
 * 契约里新增的两个可选回调集中在这里（`listTabs` / `activateTab`）：实现方最终取什么名字
 * 以 `src/settings-routes.ts` 为准，对齐时只改这一处，下面的断言一个字都不用动。
 */
function makeDeps({ rows = [], listError = null, activateError = null, withTabs = true, delayMs = 0, overrides = {} } = {}) {
  const calls = { listTabs: 0, activateTab: 0, activateArgs: [] }
  const deps = {
    packageName: 'dsh-browser',
    getConfig: () => ({
      enabled: true, port: 9777, token: 'dsh-local', readOnly: false, allowScript: true,
      lazyToolDocs: false, allowRawCdp: true, allowIncognito: false,
      tabWindow: 'current', focusPolicy: 'avoid', userTakeover: 'yield',
    }),
    status: () => ({
      configured: true, enabled: true, listening: true, port: 9777, pendingCommands: 0,
      insecureToken: false, extension: { connected: true, protocol: 1, compatible: true, note: null },
    }),
    cleanup: async () => ({ shotsRemoved: 0, scratchRemoved: [] }),
    getService: () => undefined,
    ...(withTabs ? {
      // 返回的形状照**扩展**的 `tabs.list` 原样（count/activeTabId/tabs…）：
      // 宿主那一层写的是 `result.tabs`，喂一个裸数组等于把这一层实现细节藏起来。
      listTabs: async () => {
        calls.listTabs++
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        calls.listError = listError
        if (listError !== null) throw listError
        const current = typeof rows === 'function' ? rows() : rows
        return { count: current.length, activeTabId: current.find((t) => t.active)?.id, tabs: current }
      },
      activateTab: async (tabId) => {
        calls.activateTab++
        calls.activateArgs.push(tabId)
        if (activateError !== null) throw activateError
        return { activated: tabId, agentTargetTabId: tabId }
      },
    } : {}),
    ...overrides,
  }
  return { deps, calls }
}

async function start(deps) {
  const route = buildSettingsRoute(deps)
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, port, base: `http://127.0.0.1:${port}${SETTINGS_API_PREFIX}` }
}

async function getJson(url) {
  const res = await fetch(url)
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** 原始请求：Node 的 fetch 不许伪造 Host，而 Host 栅栏必须用原始请求来测。 */
function rawRequest(port, { path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 一行扩展形态的标签页；只写测试关心到的字段，其余保持「扩展真的会这么报」。 */
const tabRow = (over = {}) => ({
  id: 1, url: 'https://user.test/', title: '用户页', active: false, windowId: 1,
  owned: false, yielded: false, incognito: false, openedByAgent: false, ...over,
})

const idsOf = (payload) => (payload?.value?.tabs ?? []).map((row) => row.id)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* B1 —— 形状 + 过滤 + 标题兜底 + 去重 */
{
  const rows = [
    tabRow({ id: 1, url: 'https://a.test/x', title: 'A 页' }),
    tabRow({ id: 2, active: true, url: 'https://b.test/y?q=1', title: '' }),
    tabRow({ id: 3, incognito: true, url: 'https://secret.test/', title: '无痕' }),
    tabRow({ id: 4, openedByAgent: true, url: 'https://agent.test/', title: 'AI 自己的' }),
    tabRow({ id: 5, url: 'chrome://settings/', title: '设置' }),
    tabRow({ id: 6, url: 'about:blank', title: '' }),
    // 同一个 id 出现两次：按 id 去重（扩展在某些时刻会重复报同一页）
    tabRow({ id: 2, active: true, url: 'https://b.test/y?q=1', title: '' }),
  ]
  const { deps, calls } = makeDeps({ rows })
  const { server, base } = await start(deps)
  const res = await getJson(`${base}/tabs`)

  check('B1 GET /tabs → 200 且 ok:true', res.status === 200 && res.body?.ok === true, JSON.stringify(res.body).slice(0, 120))
  const value = res.body?.value ?? {}
  check('B1 信封是 { ok, value: { tabs, fetchedAt, stale, total } }',
    Array.isArray(value.tabs) && Number.isFinite(value.fetchedAt)
      && typeof value.stale === 'boolean' && typeof value.total === 'number',
    JSON.stringify({ keys: Object.keys(value), fetchedAt: value.fetchedAt, stale: value.stale, total: value.total }))
  check('B1 过滤掉了无痕页（用户拍板：@ 菜单不列无痕）', !idsOf(res.body).includes(3), JSON.stringify(idsOf(res.body)))
  check('B1 过滤掉了 AI 自己开的页', !idsOf(res.body).includes(4), JSON.stringify(idsOf(res.body)))
  check('B1 过滤掉了非 http(s) 的 url（chrome:// 与 about:）',
    !idsOf(res.body).includes(5) && !idsOf(res.body).includes(6), JSON.stringify(idsOf(res.body)))
  check('B1 按 id 去重（同一页被报两次只出现一次）',
    idsOf(res.body).filter((id) => id === 2).length === 1, JSON.stringify(idsOf(res.body)))
  check('B1 排序：active 优先，再 windowId 升序，再 id 升序',
    JSON.stringify(idsOf(res.body)) === JSON.stringify([2, 1]), JSON.stringify(idsOf(res.body)))
  check('B1 total 是**过滤后**的总数（不是扩展报的原始条数）', value.total === 2, String(value.total))
  check('B1 新鲜取回时 stale=false', value.stale === false, String(value.stale))
  check('B1 每行是 { id, title, url, windowId, active } 的紧凑形状',
    (value.tabs ?? []).every((row) => ['id', 'title', 'url', 'windowId', 'active'].every((k) => k in row)),
    JSON.stringify(value.tabs?.[0]))
  // 字段白名单：这是**隐私边界**，比缓存还重要。扩展那一行里同时带着 `incognito` /
  // `owned` / `openedByAgent` / `yielded`，宿主只要把整行透传出去，这些内部判定就会跟着
  // 进用户输入框的菜单、进客户端、进以后任何加在这条链路上的东西。所以逐行比对**完整的键集**，
  // 多一个都不行——不是「包含这五个键」，是「只含这五个键」。
  const allowedKeys = ['id', 'title', 'url', 'windowId', 'active']
  const leaked = (value.tabs ?? []).flatMap((row) => Object.keys(row).filter((key) => !allowedKeys.includes(key)))
  check('B1 每行的键**恰好**是白名单这五个（incognito/owned/openedByAgent/yielded 一个都不许漏出去）',
    (value.tabs ?? []).length > 0 && leaked.length === 0,
    leaked.length === 0 ? `keys=${JSON.stringify(Object.keys(value.tabs?.[0] ?? {}))}` : `多出来的键：${JSON.stringify([...new Set(leaked)])}`)
  check('B1 白名单之外的值在响应体里一个字都搜不到（不只是键名，连值也不许带上）',
    !JSON.stringify(value).includes('openedByAgent') && !JSON.stringify(value).includes('yielded')
      && !JSON.stringify(value).includes('owned'),
    JSON.stringify(value).slice(0, 160))
  const blankTitle = (value.tabs ?? []).find((row) => row.id === 2)
  check('B1 title 为空时用 URL 的 host+pathname 兜底（不留空标题）',
    blankTitle?.title === 'b.test/y', JSON.stringify(blankTitle?.title))
  check('B1 兜底标题只做一次，不是把整个 query 塞进去',
    !String(blankTitle?.title ?? '').includes('q=1'), String(blankTitle?.title))
  check('B1 只打了扩展一次', calls.listTabs === 1, String(calls.listTabs))
  server.close()
}

/* B2 —— 排序细节：active 那一行永远在最前，同窗口按 id 升序、跨窗口按 windowId 升序 */
{
  const rows = [
    tabRow({ id: 20, windowId: 2, url: 'https://w2.test/a' }),
    tabRow({ id: 11, windowId: 1, url: 'https://w1.test/b' }),
    tabRow({ id: 21, windowId: 2, active: true, url: 'https://w2.test/active' }),
    tabRow({ id: 10, windowId: 1, url: 'https://w1.test/a' }),
    tabRow({ id: 3, windowId: 1, url: 'https://w1.test/c' }),
  ]
  const { deps } = makeDeps({ rows })
  const { server, base } = await start(deps)
  const res = await getJson(`${base}/tabs`)
  check('B2 active 优先，其次 windowId 升序，其次 id 升序（稳定）',
    JSON.stringify(idsOf(res.body)) === JSON.stringify([21, 3, 10, 11, 20]), JSON.stringify(idsOf(res.body)))
  server.close()
}

/* B3 —— 上限 50 行，但 total 报真实总数 */
{
  const rows = Array.from({ length: 55 }, (_, index) =>
    tabRow({ id: 1000 + index, windowId: 1, url: `https://many.test/${index}` }))
  const { deps } = makeDeps({ rows })
  const { server, base } = await start(deps)
  const res = await getJson(`${base}/tabs`)
  const value = res.body?.value ?? {}
  check('B3 最多回 50 行（菜单不需要第 51 行）', (value.tabs ?? []).length === 50, String((value.tabs ?? []).length))
  check('B3 total 仍是过滤后的真实总数 55（模型由此知道被截断）', value.total === 55, String(value.total))
  server.close()
}

/* B4 —— 缓存：TTL 2000ms 内不再打扩展；过期之后才重新取 */
{
  const rows = [tabRow({ id: 1, url: 'https://cached.test/' })]
  const { deps, calls } = makeDeps({ rows })
  const { server, base } = await start(deps)
  const first = await getJson(`${base}/tabs`)
  const second = await getJson(`${base}/tabs`)
  check('B4 TTL 内连发两次只打扩展一次（@ 菜单每个按键都会调，不能每次穿到底）',
    calls.listTabs === 1, String(calls.listTabs))
  check('B4 缓存命中的 fetchedAt 与首次一致（回的是同一份快照，不是重新读了一遍就改时间）',
    second.body?.value?.fetchedAt === first.body?.value?.fetchedAt,
    `${first.body?.value?.fetchedAt} vs ${second.body?.value?.fetchedAt}`)
  // `stale` 是**一条年龄判据**：stale === (now - fetchedAt) > ttlMs。
  // 所以刚取到、TTL 内复用的快照都是 false——「复用」本身不算旧，只有「超龄」才算。
  check('B4 刚取到的快照 stale=false（年龄未超 TTL，所以不 stale）',
    first.body?.value?.stale === false, String(first.body?.value?.stale))
  check('B4 TTL 内复用同一份快照也 stale=false（判断依据是年龄，不是「这次有没有新取」）',
    second.body?.value?.stale === false, String(second.body?.value?.stale))
  check('B4 缓存命中回的还是同一批行（不是空列表）',
    JSON.stringify(idsOf(second.body)) === JSON.stringify(idsOf(first.body)), JSON.stringify(idsOf(second.body)))
  await sleep(2100)
  await getJson(`${base}/tabs`)
  check('B4 过了 2000ms 才重新打扩展（缓存是 TTL，不是永久）', calls.listTabs === 2, String(calls.listTabs))
  server.close()
}

/* B4b —— stale 必须是**年龄判据**（stale === now - fetchedAt > ttlMs），不是某个分支上写死的常量
 *
 * 只靠 B4（TTL 内必须 false）+ B6（退回落必须 true）也能杀掉「恒 false」与「恒 true」两种
 * 退化实现，但那是从两个不同场景各取一个证据推出来的。这一条把时钟**注进**缓存里，
 * 让**同一份实现、同一份快照**跨过 TTL 边界：stale 必须翻转，而 fetchedAt 一动不动。
 * 这样它测的是判据本身，而不是「哪个分支返回什么常量」。
 *
 * 注意它**不**钉「正好等于 TTL 那一刻要不要重新取数」——契约只说 stale 的取值，
 * 没说刷新闸门的开闭点。所以两种实现（等于 TTL 时复用 / 重新取）都必须能过，
 * 但返回的 stale 都得是 false。
 */
{
  let clock = 1_000_000
  let fetches = 0
  let fail = false
  const cache = createReferenceTabsCache(
    async () => {
      fetches++
      if (fail) throw new Error('extension offline')
      return { tabs: [tabRow({ id: 1, url: 'https://age.test/', title: '' })] }
    },
    { now: () => clock },
  )
  const fresh = await cache.read()
  check('B4b 刚取到：stale=false，fetchedAt 就是当时的钟点',
    fresh.stale === false && fresh.fetchedAt === clock,
    JSON.stringify({ stale: fresh.stale, fetchedAt: fresh.fetchedAt, clock }))
  check('B4b 取到的行是过滤后的紧凑形状（title 已按 host+pathname 兜底）',
    fresh.tabs.length === 1 && fresh.tabs[0].title === 'age.test/', JSON.stringify(fresh.tabs[0]))

  // TTL 之内：**不 stale**。这一条正是「复用 ≠ 旧」——判断依据是年龄，不是这次有没有新取。
  clock += TAB_REFERENCE_TTL_MS - 1
  const reused = await cache.read()
  check('B4b 年龄未超 TTL：stale=false（复用同一份快照不算旧）',
    reused.stale === false, JSON.stringify({ stale: reused.stale, clock }))
  check('B4b 年龄未超 TTL：fetchedAt 不动、也没再打一次扩展',
    reused.fetchedAt === fresh.fetchedAt && fetches === 1,
    JSON.stringify({ fetchedAt: reused.fetchedAt, 首次: fresh.fetchedAt, fetches }))

  // 边界：正好等于 TTL。取不取数由实现定，但按判据 stale 必须是 false。
  clock = fresh.fetchedAt + TAB_REFERENCE_TTL_MS
  const atTtl = await cache.read()
  check('B4b 年龄**正好等于** TTL 时 stale=false（判据是 > 而不是 >=）',
    atTtl.stale === false, JSON.stringify({ stale: atTtl.stale, age: clock - fresh.fetchedAt }))

  // 边界 + 取数失败：这一条把「判据是严格大于」钉在**唯一能观测到它的那个点**上。
  //
  // 光靠上面那条钉不住边界：把 `>` 改成 `>=` 之后，正好等于 TTL 那一刻会被判成超龄，
  // 于是走重新取数；取数成功的话新快照年龄是 0，算出来照样是 stale=false —— 断言通过，
  // 变异体活下来。所以这里让**取数失败**：失败分支的 stale 是按**旧快照的年龄**现算的，
  // 此刻年龄正好等于 TTL，`>` 说不超龄、`>=` 说超龄，两种实现在这里必然分道扬镳。
  //
  // 这条**不**规定「等于 TTL 时要重取还是复用」：重取也照样落进失败分支，只要判据是
  // 严格大于，返回的 stale 就还是 false。换言之一条断言同时钉住判据、放过刷新闸门的自由度。
  {
    let edgeClock = 7_000_000
    let edgeFetches = 0
    let edgeFail = false
    const edge = createReferenceTabsCache(
      async () => {
        edgeFetches++
        if (edgeFail) throw new Error('extension offline')
        return { tabs: [tabRow({ id: 9, url: 'https://edge.test/', title: '' })] }
      },
      { now: () => edgeClock },
    )
    const edgeFresh = await edge.read()
    edgeClock = edgeFresh.fetchedAt + TAB_REFERENCE_TTL_MS
    edgeFail = true
    const edgeRead = await edge.read()
    check('B4b 年龄**正好等于** TTL 且取数失败：stale 仍是 false（判据严格大于，边界上不算超龄）',
      edgeRead.stale === false,
      JSON.stringify({ stale: edgeRead.stale, age: edgeClock - edgeFresh.fetchedAt, fetches: edgeFetches }))
    check('B4b 边界上这一次无论重取与否，行都还在（降级不是清空）', edgeRead.tabs.length === 1, String(edgeRead.tabs.length))
  }

  // 越过 TTL 且取数失败：这一刻的 stale 必须翻成 true，而 fetchedAt 停在**上次真取到**的时刻。
  clock = fresh.fetchedAt + TAB_REFERENCE_TTL_MS + 1
  fail = true
  const expired = await cache.read()
  check('B4b 年龄越过 TTL：stale 翻成 true（同一份实现、同一份快照，只有年龄变了）',
    expired.stale === true, JSON.stringify({ stale: expired.stale, age: clock - fresh.fetchedAt }))
  check('B4b 翻转时 fetchedAt 不跟着变（它记的是上次真取到的时刻，不是「这次看了多久」）',
    expired.fetchedAt === fresh.fetchedAt, JSON.stringify({ fetchedAt: expired.fetchedAt, 首次: fresh.fetchedAt }))
  check('B4b 翻转时行还在（降级不是清空）', expired.tabs.length === 1, String(expired.tabs.length))

  // 再翻回来：取数恢复 → 新的 fresh 快照，stale=false 且 fetchedAt 换成新的钟点。
  fail = false
  const recovered = await cache.read()
  check('B4b 取数恢复后又回到 stale=false（翻转是双向的，不是一次性的）',
    recovered.stale === false, String(recovered.stale))
  check('B4b 恢复之后 fetchedAt 换成了这次真取到的时刻',
    recovered.fetchedAt === clock && recovered.fetchedAt > fresh.fetchedAt,
    JSON.stringify({ fetchedAt: recovered.fetchedAt, clock, 首次: fresh.fetchedAt }))
}

/* B4c —— 快照还新鲜时取数失败：**不能**因为「这次没取成」就把它标成 stale */
{
  let clock = 5_000_000
  let fail = false
  const cache = createReferenceTabsCache(
    async () => {
      if (fail) throw new Error('extension offline')
      return { tabs: [tabRow({ id: 2, url: 'https://fallback.test/' })] }
    },
    { now: () => clock },
  )
  const first = await cache.read()
  check('B4c 前提：先有一份新鲜快照', first.stale === false && first.tabs.length === 1, String(first.stale))
  // 快照还很新、但这次真去取数（把缓存时钟推过 TTL 是不行的，那样它就超龄了）——
  // 所以这里只能验「超龄 + 失败 → stale」与「未超龄 → 不 stale」两条，二者都要成立。
  fail = true
  clock += TAB_REFERENCE_TTL_MS + 5
  const fellBack = await cache.read()
  check('B4c 已超龄 + 取失败 → 回落旧快照且 stale=true（这是 stale 的本义：数据超龄了）',
    fellBack.stale === true && fellBack.tabs.length === 1 && fellBack.fetchedAt === first.fetchedAt,
    JSON.stringify({ stale: fellBack.stale, fetchedAt: fellBack.fetchedAt, 首次: first.fetchedAt }))
}

/* B5 —— 并发请求共享同一个 in-flight promise：同时两个请求，只许打一次扩展 */
{
  const rows = [tabRow({ id: 1, url: 'https://concurrent.test/' })]
  const { deps, calls } = makeDeps({ rows, delayMs: 80 })
  const { server, base } = await start(deps)
  const [a, b] = await Promise.all([getJson(`${base}/tabs`), getJson(`${base}/tabs`)])
  check('B5 并发两次只打一次扩展（共享 in-flight，不是两次独立请求）',
    calls.listTabs === 1, String(calls.listTabs))
  check('B5 两个并发请求都拿到同样的结果',
    JSON.stringify(idsOf(a.body)) === JSON.stringify(idsOf(b.body)) && a.body?.ok === true,
    JSON.stringify([a.body?.ok, b.body?.ok]))
  server.close()
}

/* B5b —— 并发共享同一次 in-flight 时，**一个调用者的取消不许带坏别人的结果**
 *
 * 这是一个真实缺陷的时序（`createReferenceTabsCache` 早先的写法把共享取数挂在**第一个
 * 调用者**的 signal 上）：
 *
 *     t=0  A 发起取数，挂在跨 WebSocket 的那次上行上（上百毫秒）
 *     t=1  B（用户又敲了一个键）到达，共享同一次上行
 *     t=2  A 的请求被宿主取消（用户关掉菜单 / 又敲了别的键）
 *     t=3  B 的 await 跟着 reject → 菜单闪出「浏览器未连接」而链路明明是好的
 *
 * 断言不许依赖真实计时：取数用一个**手动 resolve** 的 promise（它同时按真实桥接的行为
 * ——signal 被 abort 就 reject——响应取消），时序全靠显式 `abort()` 与 `release()` 钉死。
 */
{
  let release = null
  let upstreamSignal = null
  let fetches = 0
  const cache = createReferenceTabsCache(
    (signal) => {
      fetches++
      upstreamSignal = signal
      const payload = { tabs: [tabRow({ id: 5, url: 'https://shared.test/page', title: '共享页' })] }
      return new Promise((resolve, reject) => {
        // 真桥接的行为：signal 一被 abort 这次上行就失败。变异体正是靠这条把 B 拖下水。
        signal?.addEventListener?.('abort', () => reject(new Error('AbortError: the operation was aborted')), { once: true })
        release = () => resolve(payload)
      })
    },
    { now: () => 4_242_000 },
  )

  /** 把一个 read 的两种结局都收成值，避免未处理的 rejection 把进程打成 uncaught。 */
  const settle = (promise) => promise.then(
    (value) => ({ outcome: 'resolved', value }),
    (error) => ({ outcome: 'rejected', message: String(error?.message ?? error) }),
  )

  const signalA = new AbortController()
  const signalB = new AbortController()
  const callA = settle(cache.read(signalA.signal))
  const callB = settle(cache.read(signalB.signal))

  check('B5b 前提：两次并发读只上行走一次（共享同一个 in-flight）', fetches === 1, String(fetches))
  check('B5b 前提：还没人取消时传下去的 signal 是活的', upstreamSignal?.aborted === false,
    String(upstreamSignal?.aborted))

  // 只取消 A。不用任何计时：abort 同步派发，await 一下 microtask 就够了。
  signalA.abort()
  const resultA = await callA
  check('B5b 取消 A 之后 A 自己立刻以「取消」结束（它不该继续陪着等那次上行）',
    resultA.outcome === 'rejected' && /cancel/.test(resultA.message), JSON.stringify(resultA))
  check('B5b 共享的那次上行**没有**被 A 的取消带着 abort（它不归任何一个调用者所有）',
    upstreamSignal?.aborted === false, String(upstreamSignal?.aborted))

  // 现在把这次共享上行正常收尾：B 必须拿到完整快照。
  release()
  const resultB = await callB
  check('B5b A 取消、上行随后成功：B 拿到**完整快照**（不 reject、不是 tabs_failed）',
    resultB.outcome === 'resolved', JSON.stringify(resultB).slice(0, 160))
  check('B5b B 的快照里有内容且是紧凑形状（不是空列表、不是错误信封）',
    resultB.value?.tabs?.length === 1 && resultB.value.tabs[0].id === 5
      && resultB.value.tabs[0].url === 'https://shared.test/page',
    JSON.stringify(resultB.value?.tabs))
  check('B5b B 的快照是新鲜的（没有因为别人取消就被标成超龄）',
    resultB.value?.stale === false, String(resultB.value?.stale))
  check('B5b 整段只有那一次上行（A 的取消没有引发重试或第二次取数）', fetches === 1, String(fetches))
}

/* B6 —— 取失败但有旧快照：回旧快照 + stale:true（菜单还能用）
 *
 * 这里的 stale 与 B4 是**同一条判据**的两种结果：先睡过 TTL，快照年龄必然超龄，
 * 再加上这次取失败，回落出来的那一份就是「旧的」。
 */
{
  let fail = false
  const rows = [tabRow({ id: 1, url: 'https://stale.test/' })]
  const { deps, calls } = makeDeps({ rows: () => rows, listError: null })
  // 用一个能中途翻脸的实现替换 listTabs
  deps.listTabs = async () => {
    calls.listTabs++
    if (fail) throw new Error('extension offline')
    return { count: rows.length, tabs: rows }
  }
  const { server, base } = await start(deps)
  const fresh = await getJson(`${base}/tabs`)
  check('B6 前提：先成功取到一份快照，且它此刻不 stale',
    fresh.body?.ok === true && idsOf(fresh.body).length === 1 && fresh.body?.value?.stale === false,
    JSON.stringify({ ok: fresh.body?.ok, stale: fresh.body?.value?.stale }))
  await sleep(2100)
  fail = true
  const stale = await getJson(`${base}/tabs`)
  check('B6 退回落时年龄必然已超 TTL，所以 stale=true（菜单降级而不是崩掉）',
    stale.body?.ok === true && stale.body?.value?.stale === true,
    JSON.stringify({ ok: stale.body?.ok, stale: stale.body?.value?.stale }))
  check('B6 回的还是那份旧快照的内容（不是空列表）',
    JSON.stringify(idsOf(stale.body)) === JSON.stringify(idsOf(fresh.body)), JSON.stringify(idsOf(stale.body)))
  check('B6 旧快照的 fetchedAt 保持不变（用户/模型能看出它有多旧）',
    stale.body?.value?.fetchedAt === fresh.body?.value?.fetchedAt,
    `${fresh.body?.value?.fetchedAt} vs ${stale.body?.value?.fetchedAt}`)
  server.close()
}

/* B7 —— 取失败且没有任何旧快照：ok:false（不许假装「一个标签页都没有」） */
{
  const { deps } = makeDeps({ listError: new Error('extension offline') })
  const { server, base } = await start(deps)
  const res = await getJson(`${base}/tabs`)
  check('B7 无旧快照且取失败 → ok:false（空列表会被理解成「用户一页都没开」）',
    res.body?.ok === false, JSON.stringify(res.body).slice(0, 160))
  server.close()
}

/* B8 —— 激活：POST /tabs/activate 转发到扩展的 tabs.activate */
{
  const { deps, calls } = makeDeps({ rows: [tabRow({ id: 7, url: 'https://activate.test/' })] })
  const { server, base } = await start(deps)
  const res = await postJson(`${base}/tabs/activate`, { tabId: 7 })
  check('B8 POST /tabs/activate → 200 且 ok:true', res.status === 200 && res.body?.ok === true, JSON.stringify(res.body))
  check('B8 扩展收到 tabs.activate 且 tabId 原样（不是字符串 "7"）',
    calls.activateTab === 1 && calls.activateArgs[0] === 7,
    JSON.stringify(calls.activateArgs))
  server.close()
}

/* B9 —— 非法 tabId 在**发出去之前**就被拒（400 bad_field），扩展一次都不许被调 */
{
  const { deps, calls } = makeDeps({ rows: [tabRow({ id: 7 })] })
  const { server, base } = await start(deps)
  for (const [label, body] of [
    ['缺 tabId', {}],
    ['字符串', { tabId: 'abc' }],
    ['负数', { tabId: -1 }],
    ['小数', { tabId: 1.5 }],
    ['null', { tabId: null }],
  ]) {
    const res = await postJson(`${base}/tabs/activate`, body)
    check(`B9 非法 tabId（${label}）→ 400 bad_field`,
      res.status === 400 && res.body?.error?.code === 'bad_field', JSON.stringify(res.body))
  }
  check('B9 五次非法请求，扩展的 tabs.activate 一次都没被调到',
    calls.activateTab === 0, JSON.stringify(calls.activateArgs))
  server.close()
}

/* B10 —— 没接回调：两个端点都回 501 tabs_unavailable（不是 404、不是 500） */
{
  const { deps } = makeDeps({ withTabs: false })
  const { server, base } = await start(deps)
  const list = await getJson(`${base}/tabs`)
  check('B10 宿主没接 listTabs → 501 tabs_unavailable',
    list.status === 501 && list.body?.error?.code === 'tabs_unavailable', JSON.stringify(list.body))
  const activate = await postJson(`${base}/tabs/activate`, { tabId: 1 })
  check('B10 宿主没接 activateTab → 501 tabs_unavailable',
    activate.status === 501 && activate.body?.error?.code === 'tabs_unavailable', JSON.stringify(activate.body))
  server.close()
}

/* B11 —— 信任栅栏：两个端点都必须过 isTrusted（伪造 Host / 跨站 403，且零扩展调用） */
{
  const { deps, calls } = makeDeps({ rows: [tabRow({ id: 1 })] })
  const { server, port, base } = await start(deps)
  const forgedHost = await rawRequest(port, {
    path: `${SETTINGS_API_PREFIX}/tabs`,
    headers: { Host: 'evil.example', Origin: 'http://evil.example' },
  })
  check('B11 GET /tabs 伪造 Host → 403（DNS rebinding 防线）', forgedHost.status === 403, String(forgedHost.status))
  const crossSite = await rawRequest(port, {
    path: `${SETTINGS_API_PREFIX}/tabs/activate`,
    method: 'POST',
    headers: {
      Host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tabId: 1 }),
  })
  check('B11 POST /tabs/activate 跨站 → 403', crossSite.status === 403, String(crossSite.status))
  check('B11 被栅栏拦下的请求一条都没打到扩展',
    calls.listTabs === 0 && calls.activateTab === 0, JSON.stringify(calls))
  void base
  server.close()
}

/* B12 —— 方法 / 媒体类型 / 前缀外：新端点没把路由的方法闸门撑开 */
{
  const { deps, calls } = makeDeps({ rows: [tabRow({ id: 1 })] })
  const { server, base, port } = await start(deps)
  const postTabs = await fetch(`${base}/tabs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  check('B12 POST /tabs → 405（列标签页是读端点，不许被当写端点用）', postTabs.status === 405, String(postTabs.status))
  const getActivate = await fetch(`${base}/tabs/activate`)
  check('B12 GET /tabs/activate → 405（激活是写端点）', getActivate.status === 405, String(getActivate.status))
  const noType = await fetch(`${base}/tabs/activate`, { method: 'POST', body: '{"tabId":1}' })
  check('B12 POST /tabs/activate 缺 content-type → 415（与 /config 同一道闸）',
    noType.status === 415, String(noType.status))
  const elsewhere = await fetch(`http://127.0.0.1:${port}/somewhere/else`)
  check('B12 前缀之外 → 404（路由没有把整台 web server 接管）', elsewhere.status === 404, String(elsewhere.status))
  check('B12 被方法闸门拒掉的那些请求一条都没打到扩展',
    calls.listTabs === 0 && calls.activateTab === 0, JSON.stringify(calls))
  server.close()
}

/* B13 —— 老端点没被这次改动弄坏（设置页不自伤） */
{
  const { deps } = makeDeps({ rows: [] })
  const { server, base } = await start(deps)
  const status = await getJson(`${base}/status`)
  check('B13 /status 仍然 200 且报出桥接与配置（设置页不许因为新端点坏掉）',
    status.status === 200 && status.body?.ok === true && status.body?.value?.bridge?.listening === true,
    JSON.stringify(status.body).slice(0, 120))
  server.close()
}

/* B6c —— 一次失败之后**必须还能重试**：in-flight 的清理不许依赖 async 函数体的控制流
 *
 * 这一条单独成块，因为它钉的不是 HTTP 行为，而是 `createReferenceTabsCache` 的一个
 * 内部不变量，而这个不变量最容易在「整理代码」时被破坏两次：
 *
 *   1. 把清理从结算回调搬回 `finally { inflight = undefined }`（最像正解的写法）；
 *   2. 干脆不清理（以为 promise 结算了就会自己消失）。
 *
 * 两种写法的共同后果：`fetchTabs` **同步抛错**时，`(async () => { ... })()` 会同步跑到
 * catch/finally，`inflight = undefined` 在 `inflight = run` **之前**就执行完了，紧接着
 * 赋值又把那个已 rejected 的 promise 装回去 —— 从此每次 read 都直接拿到同一个 rejection，
 * 链路恢复了也永远不重试，菜单永久报断线。
 *
 * 为什么必须用「同步抛错」来暴露：异步 reject 时 finally 跑在微任务里，晚于赋值，顺序
 * 恰好是对的 —— 也就是说这个缺陷在真实链路的常规失败上**看不出来**，只有同步抛错才现形。
 * 所以这里两种失败形态都钉一遍，并且用 `attempts` 证明「真的又打了一次」，而不是
 * 巧合地回了缓存。
 */
{
  /* B6c-1 —— 同步抛错：如实拒绝，并且**下一次 read 真的重试** */
  {
    let attempts = 0
    const cache = createReferenceTabsCache(() => {
      attempts++
      if (attempts === 1) throw new Error('boom (synchronous)')
      return Promise.resolve({ tabs: [{ id: 1, url: 'https://ok.test/', title: 'ok', windowId: 1, active: false }] })
    })
    let firstError = null
    try { await cache.read() } catch (error) { firstError = String(error?.message ?? error) }
    check('B6c 同步抛错：第一次 read 如实拒绝（不吞成空列表）',
      firstError !== null && firstError.includes('boom'), firstError ?? '(没有拒绝)')

    let second = null
    let secondError = null
    try { second = await cache.read() } catch (error) { secondError = String(error?.message ?? error) }
    check('B6c 同步抛错之后，第二次 read 会真的重试（不是永久 await 那个已失败的 in-flight）',
      secondError === null && second?.tabs?.length === 1,
      secondError ?? JSON.stringify(second))
    check('B6c 重试确实打到了 fetchTabs（attempts=2，不是巧合回了缓存）',
      attempts === 2, String(attempts))
    cache.dispose?.()
  }

  /* B6c-2 —— 异步 reject（真实链路的常规失败形态）同样要能重试 */
  {
    let attempts = 0
    const cache = createReferenceTabsCache(() => {
      attempts++
      if (attempts === 1) return Promise.reject(new Error('boom (async)'))
      return Promise.resolve({ tabs: [{ id: 2, url: 'https://ok.test/', title: 'ok', windowId: 1, active: false }] })
    })
    let firstError = null
    try { await cache.read() } catch (error) { firstError = String(error?.message ?? error) }
    check('B6c 异步 reject：第一次 read 如实拒绝', firstError !== null, firstError ?? '(没有拒绝)')
    let second = null
    let secondError = null
    try { second = await cache.read() } catch (error) { secondError = String(error?.message ?? error) }
    check('B6c 异步 reject 之后也能重试成功（这条走的是 finally 也会偶然对的路径）',
      secondError === null && second?.tabs?.length === 1, secondError ?? JSON.stringify(second))
    check('B6c 异步路径也真的又打了一次（attempts=2）', attempts === 2, String(attempts))
    cache.dispose?.()
  }

  /* B6c-3 —— 重试成功之后，TTL 内仍走缓存（证明「能重试」没有退化成「永远重取」） */
  {
    let attempts = 0
    const cache = createReferenceTabsCache(() => {
      attempts++
      return Promise.resolve({ tabs: [{ id: 3, url: 'https://ok.test/', title: 'ok', windowId: 1, active: false }] })
    })
    await cache.read()
    await cache.read()
    await cache.read()
    check('B6c 失败可重试，但成功之后 TTL 内不再重取（attempts 停在 1）', attempts === 1, String(attempts))
    cache.dispose?.()
  }
}

console.log(fails === 0
  ? '\n@ 标签页：扩展侧 openedByAgent 与宿主 tabs 路由全部符合契约'
  : `\n${fails} 项未通过`)
process.exit(fails === 0 ? 0 : 1)
