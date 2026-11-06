// 输入框 `@` 菜单的**浏览器标签页引用源**（`client.js` 里那一段）的实测台。
//
// 这一条源是纯 Client 模块的一部分：没有构建链、没有类型检查，出错的方式都很安静——
//   - 用 `node:vm` 在沙箱里执行 `client.js`，抓 `window.__ModuleLoader__.load` 的声明；
//   - 用假 `ctx`（`slots` + `inject`）真的调一次 `apply`，看 `inputTriggers.registerSource`
//     被调了几次、注册的是什么；
//   - 把假 `fetch` 接到那个源的 `candidates` / `openReference` / `codec` 上，断言**行为**：
//     过滤掉了谁、模型看到的文本长什么样、链路断了菜单里剩下什么。
//
// 几条不能松的底线（每一条都配了变异体，见 backups/2026-11-02-browser-tab-reference/mutate.mjs）：
//   1. 设置页不许被这个功能带坏：模块仍然只 `load` 一次、`inject` 里仍有 `'slots'`、
//      `inputTriggers` 不在硬依赖里（服务缺失时整个模块会不激活，设置页一起消失）；
//   2. 源的 `name` 不能撞宿主内置的两条（`reference` / `skill`），撞名 `registerSource` 会抛，
//      那会连带把整个 `@` 菜单弄坏；
//   3. `onPick` 的 `insert` 里**不许**有 `appearance`：它只接受 session/file/folder，写 `file`
//      会把一个浏览器标签页画成「本地文件」，那是视觉谎报；
//   4. 模型看到的是 `codec.serialize` 的返回值：必须带**完整 URL 与标题**，且**不许以 `@` 开头**
//      （宿主的 FILE_REFERENCE_PROMPT 把 `@` 前缀定义为「用户显式引用的文件路径」，`@` 开头
//      的 token 会让模型拿着它去 read 一个不存在的文件）；
//   5. 链路断掉时返回**恰好一条**提示候选（`JSON.parse(value).unavailable === true`），
//      而不是抛错或空列表——空列表和「你确实没开标签页」在用户眼里一模一样。
//
// 用法：node verify/verify_tab_reference_source.mjs
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const watchdog = setTimeout(() => {
  console.log('FAIL  整套超时（>60s）：某条用例把进程挂住了')
  process.exit(1)
}, 60_000)
watchdog.unref?.()
process.on('uncaughtException', (error) => {
  console.log(`FAIL  未捕获异常：${String(error?.message ?? error)}`)
  process.exit(1)
})

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/* ------------------------------------------------------------------ *
 * 最小的 React 替身：只要能建元素即可（本台不渲染设置页组件）
 * ------------------------------------------------------------------ */
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) { return [initial, () => {}] },
  useCallback(fn) { return fn },
  useEffect() {},
  Fragment: 'Fragment',
}

/**
 * 装一个 vm sandbox 并执行 `client.js`。
 *
 * `fetch` 是这一台唯一的 IO 出入口：`/tabs` 走 GET（`res.text()`），`/tabs/activate`
 * 走 POST（`res.json()`）——两条路径都按 `client.js` 真实读法建模，别替它简化。
 */
function loadBundle({ tabsResponse, postResponse, failGet = false } = {}) {
  const loads = []
  const requests = []
  const sandbox = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    URL,
    JSON,
    Promise,
    String,
    Number,
    Array,
    Object,
    Error,
    fetch: async (path, init = {}) => {
      const method = String(init.method ?? 'GET').toUpperCase()
      requests.push({ path: String(path), method, body: init.body, signal: init.signal })
      if (method === 'POST') {
        const payload = postResponse ?? { ok: true, value: { activated: 1 } }
        return { status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
      }
      if (failGet) throw new Error('bridge offline')
      const payload = tabsResponse ?? { ok: true, value: { tabs: [], fetchedAt: Date.now(), stale: false, total: 0 } }
      return { status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
    },
    window: { __ModuleLoader__: { load(declaration) { loads.push(declaration) } } },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  return { loads, requests, sandbox }
}

/** 从 bundle 里取出模块声明，并要求它带 factory。 */
function declarationOf(loads) {
  const loaded = loads[0]
  check('client.js 调用了 __ModuleLoader__.load，且只调了一次', loads.length === 1, String(loads.length))
  check('模块声明带 factory', typeof loaded?.factory === 'function')
  return loaded
}

/** 把一个假 `inputTriggers` 服务装进假 ctx，跑一次 `apply`。 */
function applyWith(module, { withService = true } = {}) {
  const sources = []
  const teardowns = []
  const seen = { slotsInject: [], injectDeps: [], effects: 0 }
  let service = null
  if (withService) {
    service = {
      registerSource(source) {
        sources.push(source)
        return () => {}
      },
    }
  }
  const scope = {
    get(name) {
      if (name === 'inputTriggers') return service
      return undefined
    },
    effect(execute, _label) {
      seen.effects++
      const teardown = execute()
      if (typeof teardown === 'function') teardowns.push(teardown)
      return teardown
    },
  }
  const ctx = {
    slots: {
      inject(ownerKey, callback) {
        seen.slotsInject.push(ownerKey)
        callback()
      },
      register(options, component) {
        seen.registration = { options, component }
        return () => {}
      },
    },
    inject(deps, callback) {
      seen.injectDeps.push(deps)
      // 服务不在时宿主根本不会回调；这里照真语义：只有拿到服务才进 callback。
      if (withService) callback(scope)
    },
  }
  module.apply(ctx)
  return { sources, teardowns, seen, ctx }
}

const looksLikeUrl = (value) => typeof value === 'string' && /^https?:\/\//.test(value)

/** 一份扩展/宿主真的会回的标签页清单（只有用户自己的正常罐页面）。 */
const TAB_FIXTURE = [
  { id: 11, title: 'DeepSeek 文档', url: 'https://api-docs.deepseek.com/guides/x', windowId: 1, active: false },
  { id: 12, title: 'GitHub Pull Requests', url: 'https://github.com/hisence999/dsh-browser/pulls', windowId: 1, active: true },
  { id: 13, title: '本地示例', url: 'http://localhost:51874/#/settings', windowId: 2, active: false },
]

/* ================================================================== *
 * 1. 模块声明与 apply()：设置页不许被这个功能带坏
 * ================================================================== */
const { loads, requests } = loadBundle({
  tabsResponse: { ok: true, value: { tabs: TAB_FIXTURE, fetchedAt: Date.now(), stale: false, total: TAB_FIXTURE.length } },
})
const declaration = declarationOf(loads)
const module = declaration.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('factory 返回 { inject, apply }', typeof module?.apply === 'function' && Array.isArray(module?.inject))
check("inject 里仍然有 'slots'（设置页的注册路径不许被去掉）",
  (module?.inject ?? []).includes('slots'), JSON.stringify(module?.inject))
check("inputTriggers 不在硬依赖里（否则服务缺失时整个模块不激活、设置页跟着消失）",
  !(module?.inject ?? []).includes('inputTriggers'), JSON.stringify(module?.inject))

{
  const { sources, seen } = applyWith(module)
  check('apply() 仍然注册了 settings.section（设置页没被 @ 源顶掉）',
    seen.registration?.options?.name === 'settings.section'
      && seen.registration?.options?.id === 'browser-control',
    JSON.stringify(seen.registration?.options))
  check('apply() 通过 inject([...]) 声明式等待 inputTriggers（不是顶层硬依赖）',
    seen.injectDeps.length === 1 && JSON.stringify(seen.injectDeps[0]) === JSON.stringify(['inputTriggers']),
    JSON.stringify(seen.injectDeps))
  check('registerSource 被调到**恰好一次**（重复注册会抛「已注册」）',
    sources.length === 1, String(sources.length))

  const source_ = sources[0] ?? {}
  check("源的 trigger 是 '@'", source_.trigger === '@', String(source_.trigger))
  check("源的 name 是 'browser-tabs'（不是内置的 reference / skill，撞名会抛）",
    source_.name === 'browser-tabs' && !['reference', 'skill'].includes(source_.name),
    String(source_.name))
  check('源带 candidates / onPick / openReference / codec 四件（宿主按这四件调用）',
    typeof source_.candidates === 'function' && typeof source_.onPick === 'function'
      && typeof source_.openReference === 'function' && source_.codec !== undefined,
    JSON.stringify(Object.keys(source_)))
  check('codec.serialize 与 codec.clipboardText 都是函数',
    typeof source_.codec?.serialize === 'function' && typeof source_.codec?.clipboardText === 'function',
    JSON.stringify(Object.keys(source_.codec ?? {})))

  /* -------- 2. candidates：过滤、形状、降级 -------- */
  check('candidates 是 async 函数（宿主直接链 .then()）',
    source_.candidates?.constructor?.name === 'AsyncFunction', String(source_.candidates?.constructor?.name))

  const signal = { aborted: false }
  const all = await source_.candidates({ sessionId: 's1' }, { query: '', quoted: false, drilled: false, signal })
  check('空 query 返回全部标签页（不过滤）', Array.isArray(all) && all.length === TAB_FIXTURE.length,
    `${Array.isArray(all) ? all.length : typeof all}`)
  check('每条候选都带 name / value（字符串）/ section',
    all.every((row) => typeof row.name === 'string' && row.name.length > 0
      && typeof row.value === 'string' && typeof row.section === 'string' && row.section.length > 0),
    JSON.stringify(all[0]))
  check('候选的 value 是 JSON 串（宿主不解释它，只有 codec 与 openReference 读）',
    all.every((row) => {
      try { JSON.parse(row.value); return true } catch { return false }
    }), all[0]?.value)
  check('候选 name 用的是页面标题（不是 URL）',
    all.some((row) => row.name.includes('DeepSeek 文档')), all.map((row) => row.name).join(' | '))

  // 有 query：按 title 或 url 大小写不敏感匹配
  const byTitle = await source_.candidates({ sessionId: 's1' }, { query: 'deepseek', signal: { aborted: false } })
  check('query 按标题大小写不敏感匹配（小写关键词能命中中文标题里的英文词）',
    byTitle.length === 1 && byTitle[0].name.includes('DeepSeek'), JSON.stringify(byTitle.map((row) => row.name)))
  const byUrlUpper = await source_.candidates({ sessionId: 's1' }, { query: 'GITHUB.COM', signal: { aborted: false } })
  check('query 也按 URL 匹配，且大小写不敏感（大写关键词命中）',
    byUrlUpper.length === 1 && byUrlUpper[0].value.includes('github.com'),
    JSON.stringify(byUrlUpper.map((row) => row.name)))
  const byWindow = await source_.candidates({ sessionId: 's1' }, { query: 'localhost', signal: { aborted: false } })
  check('query 命中 URL 的 host 部分时也能返回', byWindow.length === 1, String(byWindow.length))

  // 过滤后为空：返回 []，不许编一条提示候选
  const none = await source_.candidates({ sessionId: 's1' }, { query: 'zzz-not-here', signal: { aborted: false } })
  check('fetch 成功但过滤后一页都没有 → 空数组（不编提示候选）',
    Array.isArray(none) && none.length === 0, JSON.stringify(none))

  // signal 已取消：返回 []，且不该再打网络
  const beforeAbortCount = requests.length
  const abortedNow = await source_.candidates({ sessionId: 's1' }, { query: '', signal: { aborted: true } })
  check('signal.aborted 时返回 []（用户已经换词了，这条结果没用了）',
    Array.isArray(abortedNow) && abortedNow.length === 0, JSON.stringify(abortedNow))
  check('signal.aborted 时一条请求都不发', requests.length === beforeAbortCount,
    `${beforeAbortCount} -> ${requests.length}`)

  /* -------- 3. onPick：插入形状与「不冒充文件」 -------- */
  const normalPick = source_.onPick({ candidate: all[0], action: 'pick' })
  check('onPick 对正常候选返回 { insert: {...} }', normalPick !== null && typeof normalPick === 'object'
    && normalPick.insert !== undefined, JSON.stringify(normalPick)?.slice(0, 120))
  const insert = normalPick?.insert ?? {}
  check("insert.source 是 'browser-tabs'（chip 回点时要能找回这条源）",
    insert.source === 'browser-tabs', String(insert.source))
  check('insert.ref 是可解析的字符串（openReference 靠它把页叫到前台）',
    typeof insert.ref === 'string' && (() => { try { JSON.parse(insert.ref); return true } catch { return false } })(),
    String(insert.ref).slice(0, 80))
  check('insert.label 是可读的非空文本', typeof insert.label === 'string' && insert.label.length > 0,
    String(insert.label))
  check('insert.clipboardText 是字符串', typeof insert.clipboardText === 'string', typeof insert.clipboardText)
  check("insert 里**没有** appearance（写 'file' 会把标签页画成本地文件，视觉谎报）",
    !('appearance' in insert), JSON.stringify(insert))

  // 提示候选（链路断了给的那一条）：插进消息没有意义，返回 'handled'
  const hint = source_.onPick({ candidate: { name: '提示', value: JSON.stringify({ unavailable: true }), section: 's' }, action: 'pick' })
  check("onPick 对提示候选返回 'handled'（不往消息里插一段说明文字）", hint === 'handled', String(hint))
  const malformedPick = source_.onPick({ candidate: { name: '坏的', value: 'not-json', section: 's' }, action: 'pick' })
  check('onPick 对畸形候选不抛，返回 handled（菜单不许被一条脏数据弄坏）',
    malformedPick === 'handled', String(malformedPick))

  /* -------- 4. codec：模型看到什么、剪贴板拿到什么 -------- */
  const parsedRef = JSON.parse(insert.ref)
  const serialized = source_.codec.serialize(insert.ref)
  check('codec.serialize 返回 Promise', typeof serialized?.then === 'function', typeof serialized)
  const text = await serialized
  // **不许以 `@` 开头**——这是宿主给模型的系统提示决定的，不是风格偏好。
  // `@deepseek-ai/dsh-file-reference/lib/index.js` 里的 FILE_REFERENCE_PROMPT 原文：
  //   "Tokens prefixed with `@` are paths the user explicitly referenced. … Anything else
  //    is a file: use the read tool when its contents are needed, and do not claim to have
  //    inspected it before reading."
  // 它由 dsh-file-reference-local 用 `scope.systemPrompt.section(...)` 注册进系统提示。
  // 所以任何一个 `@` 开头的 token 都会被模型当成**文件路径**去 read，而我们要交给它的是
  // 一个浏览器标签页。serialize 的返回值会被逐字拼进用户消息正文，这里一旦写错，模型
  // 就会拿着 `browser-tab` 这个不存在的路径去调读文件工具。
  check('serialize 的返回值**不以 @ 开头**（否则会被模型当成文件路径去 read）',
    typeof text === 'string' && !text.startsWith('@'), String(text).slice(0, 60))
  check('serialize 的文本包含**完整 URL**（不能退化成裸 ref 或只有标题）',
    typeof text === 'string' && text.includes(parsedRef.url) && looksLikeUrl(parsedRef.url),
    `${String(text).slice(0, 100)}｜url=${parsedRef.url}`)
  check('serialize 的文本同时带标题（模型知道这是哪个页面，而不只是一串 URL）',
    typeof text === 'string' && text.includes(parsedRef.title),
    `${String(text).slice(0, 100)}｜title=${parsedRef.title}`)
  const malformedSerialized = await Promise.resolve(source_.codec.serialize('not-json-at-all'))
  check('serialize 对畸形 ref 也不抛，把原串交回去（模型至少还能看到那串东西，不是一片空白）',
    typeof malformedSerialized === 'string' && malformedSerialized.includes('not-json-at-all'),
    String(malformedSerialized).slice(0, 60))

  check('codec.clipboardText 对畸形 ref（不是 JSON）不抛，返回字符串',
    (() => {
      try { return typeof source_.codec.clipboardText('definitely-not-json') === 'string' } catch { return false }
    })())
  const clipboard = source_.codec.clipboardText(insert.ref)
  check('clipboardText 对正常 ref 返回一个能直接粘出去、且含 URL 的文本',
    typeof clipboard === 'string' && clipboard.includes(parsedRef.url), String(clipboard).slice(0, 80))
  check('clipboardText 同样**不以 @ 开头**（粘进输入框后不该被当成文件引用）',
    typeof clipboard === 'string' && !clipboard.startsWith('@'), String(clipboard).slice(0, 60))
  // 剪贴板与正文必须是**同一串**：两套口径迟早会漂（一处改了另一处忘了），
  // 而用户复制出去的正是他在正文里看到的那句——不一致就是一种谎报。
  check('clipboardText 与 serialize 是同一串（正文与剪贴板不许两套口径）',
    clipboard === text, `clipboard=${String(clipboard).slice(0, 60)}｜serialize=${String(text).slice(0, 60)}`)
  check('onPick 的 insert.clipboardText 也是同一串（三个出口一个口径）',
    insert.clipboardText === clipboard && insert.clipboardText === text,
    String(insert.clipboardText).slice(0, 60))

  /* -------- 5. openReference：点 chip 把页叫到前台 -------- */
  const beforeActivate = requests.length
  const opened = source_.openReference({ sessionId: 's1' }, { ref: insert.ref })
  check('openReference 对正常 ref 返回 true', opened === true, String(opened))
  const activateCalls = requests.slice(beforeActivate).filter((row) => row.method === 'POST')
  check('openReference 发了一个 POST tabs/activate',
    activateCalls.length === 1 && /tabs\/activate$/.test(activateCalls[0].path),
    JSON.stringify(activateCalls.map((row) => row.path)))
  check('POST 体里是数字 tabId（与候选里那一页对得上）',
    JSON.parse(activateCalls[0].body).tabId === parsedRef.tabId,
    String(activateCalls[0].body))

  const beforeBad = requests.length
  const badOpen = source_.openReference({ sessionId: 's1' }, { ref: 'not-json' })
  check('openReference 对畸形 ref 返回 false', badOpen === false, String(badOpen))
  check('openReference 对畸形 ref 一个请求都不发（不许瞎打到别的页）',
    requests.length === beforeBad, `${beforeBad} -> ${requests.length}`)
  const badId = source_.openReference({ sessionId: 's1' }, { ref: JSON.stringify({ tabId: 'abc' }) })
  check('openReference 对非数字 tabId 返回 false 且不发请求',
    badId === false && requests.length === beforeBad, String(badId))
}

/* ================================================================== *
 * 6. 链路断了：恰好一条提示候选，且点它没有副作用
 * ================================================================== */
{
  const offline = loadBundle({ failGet: true })
  const offlineDeclaration = declarationOf(offline.loads)
  const offlineModule = offlineDeclaration.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  const { sources } = applyWith(offlineModule)
  const offlineSource = sources[0] ?? {}
  const rows = await offlineSource.candidates({ sessionId: 's1' }, { query: '', signal: { aborted: false } })
  check('fetch 抛错时返回**恰好一条**提示候选（不是空列表、不是一串报错）',
    Array.isArray(rows) && rows.length === 1, Array.isArray(rows) ? String(rows.length) : typeof rows)
  let baked = null
  try { baked = JSON.parse(rows[0]?.value) } catch { baked = null }
  check('提示候选的 value 是 { unavailable: true }（宿主与 onPick 靠这个标记认它）',
    baked?.unavailable === true, JSON.stringify(baked))
  check('提示候选也有 name 与 section（否则菜单里是一行空白）',
    typeof rows[0]?.name === 'string' && rows[0].name.length > 0 && typeof rows[0]?.section === 'string',
    JSON.stringify({ name: rows[0]?.name, section: rows[0]?.section }))
  check('点提示候选返回 handled（点它没有副作用，文案里也说清了）',
    offlineSource.onPick({ candidate: rows[0], action: 'pick' }) === 'handled',
    String(offlineSource.onPick({ candidate: rows[0], action: 'pick' })))
  check('链路断了之后 openReference 仍不会因为提示候选而发请求',
    (() => {
      const before = offline.requests.length
      offlineSource.openReference({ sessionId: 's1' }, { ref: rows[0]?.value })
      return offline.requests.length === before
    })(), 'sent?')
}

/* ================================================================== *
 * 7. 服务缺失 / 无 inject：静默跳过，设置页照常
 * ================================================================== */
{
  const bare = loadBundle()
  const bareModule = declarationOf(bare.loads).factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  // 没有任何 inputTriggers 服务
  const none = applyWith(bareModule, { withService: false })
  check('没有 inputTriggers 服务时 apply() 不抛，且不注册任何源',
    none.sources.length === 0, String(none.sources.length))
  check('没有 inputTriggers 服务时设置页仍然注册（@ 是锦上添花，不许连坐）',
    none.seen.registration?.options?.name === 'settings.section',
    JSON.stringify(none.seen.registration?.options))

  // 手工拼的 ctx：连 inject 都没有
  let threw = null
  const handMade = {
    slots: {
      inject(_key, callback) { callback() },
      register() { return () => {} },
    },
  }
  try { bareModule.apply(handMade) } catch (error) { threw = String(error?.message ?? error) }
  check('ctx 上没有 inject 时 apply() 不抛（老宿主 / 手工拼的 ctx 也要活）',
    threw === null, threw ?? '')
}

/* ================================================================== *
 * 8. HMR：同一个 realm 里重复执行 bundle 不抛错
 * ================================================================== */
{
  const repeat = loadBundle()
  let secondError = null
  try {
    vm.runInNewContext(source, repeat.sandbox, { filename: 'client.js' })
  } catch (error) {
    secondError = String(error?.message ?? error)
  }
  check('同一 realm 重复执行 bundle 不抛错（HMR/重试的前提）', secondError === null, secondError ?? '')
  check('两次执行各自调用了一次 load（第二次也注册得上去）', repeat.loads.length === 2, String(repeat.loads.length))
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  check('顶层没有 const/let/var 声明（所有声明都在 factory 内，否则第二次执行 SyntaxError）',
    !/^(?:const|let|var)\s/m.test(withoutComments),
    (withoutComments.match(/^(?:const|let|var)\s.*/m) ?? [''])[0])

  // 第二次执行出来的模块也要能真的装上一条源（不是只「没抛」）
  const secondModule = repeat.loads[1].factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  const again = applyWith(secondModule)
  check('第二次执行得到的模块同样能注册 browser-tabs 源（幂等不是靠「什么都不做」换来的）',
    again.sources.length === 1 && again.sources[0].name === 'browser-tabs',
    JSON.stringify(again.sources.map((row) => row.name)))
}

console.log(fails === 0
  ? '\n@ 标签页引用源：Client 半边符合契约'
  : `\n${fails} 项未通过`)
process.exit(fails === 0 ? 0 : 1)
