// 设置页宿主面的实测台（/browser-control/api）。
//
// 设置页是 Client 模块，它既不能调 Host Service，也不能直接访问桥的 9777 端口
// （不同源，且桥故意不发 CORS）。所以真正需要证明的是这条同源 JSON 端点：
//   1) 只放行本机同源请求（Host 回环 / Origin 同源 / 拒绝 cross-site）；
//   2) 状态里不泄露 Token 原文；
//   3) 写入走 configEditor（持久化路径），失败时给出可执行的错误；
//   4) 清理动作复用 browser_cleanup 的同一条策略闸门。
//
// 用法：node verify/verify_settings_routes.mjs
import http from 'node:http'
import { buildSettingsRoute, SETTINGS_API_PREFIX } from '../src/settings-routes.ts'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** 一份可用的默认依赖；测试可以逐项替换。 */
function makeDeps(overrides = {}) {
  const config = {
    enabled: true,
    port: 9777,
    token: 'dsh-local',
    readOnly: false,
    allowScript: true,
    lazyToolDocs: false,
    allowRawCdp: true,
    // 隔离实例的第三条授权：默认关（schema 默认值），设置页开关的初值就是它。
    allowIncognito: false,
    // 枚举字段与 schema 默认值一致（current / avoid / yield）：状态里少一个，
    // 页面的受控下拉就会显示空白档，所以它们也属于「必须报出来的配置」。
    tabWindow: 'current',
    focusPolicy: 'avoid',
    userTakeover: 'yield',
    ...overrides.config,
  }
  const edits = []
  const editor = {
    entries: () => [{ name: 'dsh-browser', options: { name: 'dsh-browser' } }],
    edit: async (_entry, change) => { edits.push(change({ ...config })) },
  }
  const deps = {
    packageName: 'dsh-browser',
    getConfig: () => config,
    status: () => ({
      configured: true,
      enabled: true,
      listening: true,
      port: 9777,
      pendingCommands: 0,
      insecureToken: true,
      extension: { connected: false, protocol: 0, compatible: true, note: null },
    }),
    cleanup: async () => ({ shotsRemoved: 2, scratchRemoved: ['__scratch.js'] }),
    getService: name => (name === 'configEditor' ? editor : undefined),
    ...overrides.deps,
  }
  return { deps, edits, config, editor }
}

async function start(deps) {
  const route = buildSettingsRoute(deps)
  const server = http.createServer((req, res) => { void route.handler(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, port, base: `http://127.0.0.1:${port}${SETTINGS_API_PREFIX}` }
}

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** 原始请求：Node 的 fetch 不允许伪造 Host，而 Host 栅栏必须用原始请求来测。 */
function rawRequest(port, { path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// ---- 1) 状态：只报运行事实，Token 只给掩码 ----
{
  const { deps, config } = makeDeps()
  const { server, base } = await start(deps)
  const res = await fetch(`${base}/status`)
  const payload = await res.json()
  check('GET /status → 200 且 ok:true', res.status === 200 && payload.ok === true, JSON.stringify(payload).slice(0, 80))
  check('status：报出桥接监听与端口', payload.value.bridge.listening === true && payload.value.config.port === 9777)
  check('status：Token 只出现掩码', payload.value.config.tokenMasked !== config.token && /\*/.test(payload.value.config.tokenMasked),
    payload.value.config.tokenMasked)
  check('status：响应体里没有 Token 原文', !JSON.stringify(payload).includes(config.token))
  check('status：闸门当前值都在', payload.value.config.readOnly === false && payload.value.config.allowRawCdp === true)
  check('status：隔离实例默认关（allowIncognito=false）', payload.value.config.allowIncognito === false,
    String(payload.value.config.allowIncognito))
  check('status：三个枚举设置的当前值都在（默认 current / avoid / yield）',
    payload.value.config.tabWindow === 'current'
      && payload.value.config.focusPolicy === 'avoid'
      && payload.value.config.userTakeover === 'yield',
    JSON.stringify({ tabWindow: payload.value.config.tabWindow, focusPolicy: payload.value.config.focusPolicy, userTakeover: payload.value.config.userTakeover }))
  check('status：分组名默认 DSH、AI 高亮默认开（页面控件的初值）',
    payload.value.config.tabGroupTitle === 'DSH' && payload.value.config.agentHighlight === true,
    JSON.stringify({ tabGroupTitle: payload.value.config.tabGroupTitle, agentHighlight: payload.value.config.agentHighlight }))
  server.close()
}

// ---- 1a2) 分组名是自由文本：空串**必须**原样报成空，不能被兜底成 DSH ----
{
  const { deps } = makeDeps({ config: { tabGroupTitle: '' } })
  const { server, base } = await start(deps)
  const payload = await (await fetch(`${base}/status`)).json()
  check('status：分组名留空时如实报空串（页面输入框才不会假装还叫 DSH）',
    payload.value.config.tabGroupTitle === '', JSON.stringify(payload.value.config.tabGroupTitle))
  server.close()
}
{
  // 完全缺失（还没读过配置）才退回默认值；`null` 也算缺失。
  const { deps } = makeDeps({ config: { tabGroupTitle: undefined } })
  const { server, base } = await start(deps)
  const payload = await (await fetch(`${base}/status`)).json()
  check('status：分组名缺失时退回 DSH（不是 null、不是空串）',
    payload.value.config.tabGroupTitle === 'DSH', JSON.stringify(payload.value.config.tabGroupTitle))
  server.close()
}

// ---- 1b) 枚举设置：缺值/怪值时也要给出一个合法档位（受控下拉不能显示空白） ----
{
  const { deps } = makeDeps({ config: { tabWindow: undefined, focusPolicy: 'bogus', userTakeover: null } })
  const { server, base } = await start(deps)
  const payload = await (await fetch(`${base}/status`)).json()
  check('status：枚举缺值/非法值回落到 schema 默认，而不是 null',
    payload.value.config.tabWindow === 'current'
      && payload.value.config.focusPolicy === 'avoid'
      && payload.value.config.userTakeover === 'yield',
    JSON.stringify(payload.value.config))
  server.close()
}

// ---- 1c) 无痕权限（浏览器那层）必须原样透传给页面 ----
// 设置页那行「无痕权限」读的是 `bridge.extension.hello.incognitoAllowed`。这个字段由扩展
// 握手带上来（server.ts 透传），本端点**不许**清洗或改名——它和 config.allowIncognito 是
// 两道独立授权，页面要把「插件开了、浏览器没开」这种错配显示出来。
{
  const withHello = hello => makeDeps({
    deps: {
      status: () => ({
        configured: true, enabled: true, listening: true, port: 9777, pendingCommands: 0,
        insecureToken: false,
        extension: { connected: true, connectedAt: '2026-10-29T00:00:00.000Z', hello, protocol: 1, compatible: true, note: null },
      }),
    },
  })
  const cases = [
    ['扩展报 true', { client: 'dsh-browser-extension', version: '1.0.22', protocol: 1, browser: {}, incognitoAllowed: true }, true],
    ['扩展报 false', { client: 'dsh-browser-extension', version: '1.0.22', protocol: 1, browser: {}, incognitoAllowed: false }, false],
    // 老扩展根本不发这个字段：页面必须能看出「不知道」，不能当成「未允许」。
    ['老扩展没这个字段', { client: 'dsh-browser-extension', version: '1.0.10', protocol: 1, browser: {} }, undefined],
  ]
  for (const [label, hello, expected] of cases) {
    const { deps } = withHello(hello)
    const { server, base } = await start(deps)
    const payload = await (await fetch(`${base}/status`)).json()
    const actual = payload.value.bridge.extension.hello.incognitoAllowed
    check(`status：无痕权限原样透传（${label}）`, actual === expected, `${JSON.stringify(actual)} 期望 ${JSON.stringify(expected)}`)
    server.close()
  }
}

// ---- 2) 配置写入：走 configEditor，保留未提及字段 ----
{
  const { deps, edits } = makeDeps()
  const { server, base } = await start(deps)
  const res = await post(`${base}/config`, { patch: { readOnly: true, lazyToolDocs: true } })
  check('POST /config → 200 persisted', res.status === 200 && res.body.ok === true && res.body.value.persisted === true,
    JSON.stringify(res.body))
  check('configEditor.edit 收到合并后的完整配置',
    edits.length === 1 && edits[0].readOnly === true && edits[0].lazyToolDocs === true &&
      edits[0].allowScript === true && edits[0].port === 9777,
    JSON.stringify(edits[0]))
  server.close()
}

// ---- 2b) 枚举写入：落盘的是契约词汇，且与布尔字段可以同一次提交 ----
{
  const { deps, edits } = makeDeps()
  const { server, base } = await start(deps)
  const res = await post(`${base}/config`, {
    patch: { tabWindow: 'new', focusPolicy: 'auto', userTakeover: 'ignore', readOnly: true },
  })
  check('枚举 patch → 200 persisted', res.status === 200 && res.body.ok === true, JSON.stringify(res.body))
  check('枚举值原样写进配置（不是中文标签、不是 true/false）',
    edits.length === 1 && edits[0].tabWindow === 'new'
      && edits[0].focusPolicy === 'auto' && edits[0].userTakeover === 'ignore',
    JSON.stringify(edits[0]))
  check('同一次提交里的布尔字段也保留', edits[0]?.readOnly === true, JSON.stringify(edits[0]))
  check('没提到的字段保持不变（枚举默认值不被顺手改写）',
    edits[0]?.lazyToolDocs === false && edits[0]?.port === 9777, JSON.stringify(edits[0]))
  server.close()
}

// ---- 2c) 隔离实例开关：可写，但只收布尔（字符串 true 不许被当成打开）----
{
  const { deps, edits } = makeDeps()
  const { server, base } = await start(deps)
  const res = await post(`${base}/config`, { patch: { allowIncognito: true } })
  check('allowIncognito 可写：200 persisted', res.status === 200 && res.body.ok === true, JSON.stringify(res.body))
  check('allowIncognito 写进配置，且没顺带改别的闸门',
    edits.length === 1 && edits[0].allowIncognito === true
      && edits[0].readOnly === false && edits[0].allowScript === true,
    JSON.stringify(edits[0]))
  const back = await post(`${base}/config`, { patch: { allowIncognito: false } })
  check('allowIncognito 可以关回去', back.status === 200 && edits[1]?.allowIncognito === false, JSON.stringify(edits[1]))
  server.close()
}
{
  const { deps, edits } = makeDeps()
  const { server, base } = await start(deps)
  const bad = await post(`${base}/config`, { patch: { allowIncognito: 'yes' } })
  check('allowIncognito 非布尔 → 400 bad_field（不落盘）',
    bad.status === 400 && bad.body.error.code === 'bad_field' && edits.length === 0, JSON.stringify(bad.body))
  const numeric = await post(`${base}/config`, { patch: { allowIncognito: 1 } })
  check('allowIncognito 收数字 1 → 400 bad_field（不把 1 当 true）',
    numeric.status === 400 && numeric.body.error.code === 'bad_field')
  server.close()
}

// ---- 2d) 分组名（自由文本）与 AI 高亮：可写，但归一规则与上限由宿主说了算 ----
{
  const { deps, edits } = makeDeps()
  const { server, base } = await start(deps)
  const messy = await post(`${base}/config`, { patch: { tabGroupTitle: '  AI   任务  ' } })
  check('分组名可写：200 persisted', messy.status === 200 && messy.body.ok === true, JSON.stringify(messy.body))
  check('分组名落盘前被归一：压平空白 + 去首尾',
    edits[0]?.tabGroupTitle === 'AI 任务', JSON.stringify(edits[0]?.tabGroupTitle))

  const blank = await post(`${base}/config`, { patch: { tabGroupTitle: '' } })
  check('分组名允许空串（= 不分组）：200 且原样落成空串',
    blank.status === 200 && edits[1]?.tabGroupTitle === '', JSON.stringify({ status: blank.status, value: edits[1]?.tabGroupTitle }))
  const spaces = await post(`${base}/config`, { patch: { tabGroupTitle: '   ' } })
  check('只输入空白等于清空（不是悄悄恢复 DSH）',
    spaces.status === 200 && edits[2]?.tabGroupTitle === '', JSON.stringify(edits[2]?.tabGroupTitle))

  const tooLong = await post(`${base}/config`, { patch: { tabGroupTitle: 'x'.repeat(41) } })
  check('超过 40 字符 → 400 bad_field（不落盘）',
    tooLong.status === 400 && tooLong.body.error.code === 'bad_field' && edits.length === 3, JSON.stringify(tooLong.body))
  const exact = await post(`${base}/config`, { patch: { tabGroupTitle: 'x'.repeat(40) } })
  check('正好 40 字符可以写', exact.status === 200 && String(edits[3]?.tabGroupTitle ?? '').length === 40)
  const notString = await post(`${base}/config`, { patch: { tabGroupTitle: 5 } })
  check('分组名收数字 → 400 bad_field', notString.status === 400 && notString.body.error.code === 'bad_field')
  const control = await post(`${base}/config`, { patch: { tabGroupTitle: 'a\u0000b\u001fc' } })
  check('分组名里的控制字符被压成空格（不会塞进 Chrome 的组名里）',
    control.status === 200 && edits[4]?.tabGroupTitle === 'a b c', JSON.stringify(edits[4]?.tabGroupTitle))

  const highlight = await post(`${base}/config`, { patch: { agentHighlight: false } })
  check('agentHighlight 可写：200 且落成 false',
    highlight.status === 200 && edits[5]?.agentHighlight === false, JSON.stringify(edits[5]?.agentHighlight))
  const highlightBad = await post(`${base}/config`, { patch: { agentHighlight: 'no' } })
  check('agentHighlight 非布尔 → 400 bad_field（不落盘）',
    highlightBad.status === 400 && highlightBad.body.error.code === 'bad_field')
  server.close()
}

// ---- 3) 非法写入在落盘前被拒 ----
{
  const { deps, edits } = makeDeps()
  const { server, base } = await start(deps)
  const unknown = await post(`${base}/config`, { patch: { notAField: true } })
  check('未知字段 → 400 unknown_field', unknown.status === 400 && unknown.body.error.code === 'unknown_field',
    JSON.stringify(unknown.body))
  const badType = await post(`${base}/config`, { patch: { readOnly: 'yes' } })
  check('非布尔值 → 400 bad_field', badType.status === 400 && badType.body.error.code === 'bad_field')
  const badEnum = await post(`${base}/config`, { patch: { tabWindow: 'bogus' } })
  check('枚举非法值 → 400 bad_field', badEnum.status === 400 && badEnum.body.error.code === 'bad_field',
    JSON.stringify(badEnum.body))
  check('枚举错误文案列出允许值', /current \| new/.test(badEnum.body.error.message), badEnum.body.error.message)
  const wrongKind = await post(`${base}/config`, { patch: { focusPolicy: true } })
  check('枚举字段收到布尔 → 400 bad_field（不把 true 当 auto）',
    wrongKind.status === 400 && wrongKind.body.error.code === 'bad_field')
  const mixed = await post(`${base}/config`, { patch: { userTakeover: 'ignore', readOnly: 'yes' } })
  check('同一 patch 里混进非法值时整份拒绝（不落一半）',
    mixed.status === 400 && mixed.body.error.code === 'bad_field' && edits.length === 0,
    JSON.stringify({ status: mixed.status, code: mixed.body?.error?.code, edits: edits.length }))
  const empty = await post(`${base}/config`, { patch: {} })
  check('空 patch → 400 empty_patch', empty.status === 400 && empty.body.error.code === 'empty_patch')
  server.close()
}

// ---- 4) 动作：清理复用 browser_cleanup；策略拒绝原样报回 ----
{
  const { deps } = makeDeps()
  const { server, base } = await start(deps)
  const cleanup = await post(`${base}/action`, { action: 'cleanup' })
  check('action=cleanup → 统计结果', cleanup.status === 200 && cleanup.body.ok === true &&
    cleanup.body.value.shotsRemoved === 2 && cleanup.body.value.scratchRemoved.length === 1,
    JSON.stringify(cleanup.body))
  const open = await post(`${base}/action`, { action: 'openStatus' })
  check('action=openStatus → 状态页 URL', open.body.ok === true && open.body.value.url === 'http://127.0.0.1:9777/',
    JSON.stringify(open.body))
  const unknown = await post(`${base}/action`, { action: 'nope' })
  check('未知动作 → 400 unknown_action', unknown.status === 400 && unknown.body.error.code === 'unknown_action')
  server.close()
}

{
  const policyError = Object.assign(new Error('[blocked_by_policy] 只读模式已开启'), { code: 'blocked_by_policy' })
  const { deps } = makeDeps({ deps: { cleanup: async () => { throw policyError } } })
  const { server, base } = await start(deps)
  const res = await post(`${base}/action`, { action: 'cleanup' })
  check('清理被只读档拦下 → 200 + ok:false + blocked_by_policy',
    res.status === 200 && res.body.ok === false && res.body.error.code === 'blocked_by_policy',
    JSON.stringify(res.body))
  server.close()
}

// ---- 5) 方法 / 媒体类型 / 路径 ----
{
  const { deps } = makeDeps()
  const { server, base } = await start(deps)
  const getAction = await fetch(`${base}/action`)
  check('GET /action → 405', getAction.status === 405)
  const noType = await fetch(`${base}/config`, { method: 'POST', body: '{}' })
  check('POST 缺 content-type → 415', noType.status === 415)
  const badJson = await fetch(`${base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
  })
  check('坏 JSON → 400 bad_json', badJson.status === 400)
  const elsewhere = await fetch(`http://127.0.0.1:${server.address().port}/somewhere/else`)
  check('前缀之外 → 404', elsewhere.status === 404)
  server.close()
}

// ---- 6) 信任栅栏：Host 回环 / Origin 同源 / 拒绝跨站与伪造 Host ----
{
  const { deps } = makeDeps()
  const { server, port, base } = await start(deps)
  const okOrigin = await rawRequest(port, {
    path: `${SETTINGS_API_PREFIX}/status`,
    headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` },
  })
  check('同源 Origin + 回环 Host → 放行', okOrigin.status === 200, String(okOrigin.status))
  const forgedHost = await rawRequest(port, {
    path: `${SETTINGS_API_PREFIX}/status`,
    headers: { Host: 'evil.example', Origin: 'http://evil.example' },
  })
  check('伪造 Host → 403（DNS rebinding 防线）', forgedHost.status === 403, String(forgedHost.status))
  const crossSite = await rawRequest(port, {
    path: `${SETTINGS_API_PREFIX}/status`,
    headers: { Host: `127.0.0.1:${port}`, 'sec-fetch-site': 'cross-site' },
  })
  check('cross-site → 403', crossSite.status === 403, String(crossSite.status))
  const wrongOrigin = await rawRequest(port, {
    path: `${SETTINGS_API_PREFIX}/status`,
    headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' },
  })
  check('Origin 与 Host 不一致 → 403', wrongOrigin.status === 403, String(wrongOrigin.status))
  void base
  server.close()
}

// ---- 7) 宿主缺少 configEditor / 找不到配置行时，错误可执行 ----
{
  const noEditor = makeDeps({ deps: { getService: () => undefined } })
  const first = await start(noEditor.deps)
  const res = await post(`${first.base}/config`, { patch: { readOnly: true } })
  check('没有 configEditor → 501 config_editor_unavailable',
    res.status === 501 && res.body.error.code === 'config_editor_unavailable',
    JSON.stringify(res.body))
  check('没落盘时文案指向 cordis.patch.yml', /cordis\.patch\.yml/.test(res.body.error.message))
  first.server.close()
}
{
  const missing = makeDeps({
    deps: {
      getService: name => name === 'configEditor'
        ? { entries: () => [{ name: 'someone-else', id: 'other' }], edit: async () => {} }
        : undefined,
    },
  })
  const { server, base } = await start(missing.deps)
  const res = await post(`${base}/config`, { patch: { readOnly: true } })
  check('找不到本插件的配置行 → 409 entry_not_found',
    res.status === 409 && res.body.error.code === 'entry_not_found', JSON.stringify(res.body))
  server.close()
}

console.log(fails === 0 ? '\n设置页宿主面全部符合契约' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
