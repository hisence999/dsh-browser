// 设置页 Client 半边的结构实测台。
//
// Client 模块是纯 JS 的 `window.__ModuleLoader__.load({ id, factory })` 包，
// 没有构建链、也没有类型检查。它最可能坏在三个地方，而且都能在没有浏览器的
// 情况下测出来：
//   1) id 与包名不一致 → 宿主把模块挂不上；
//   2) apply() 没在 settings.section 注册条目（或 id/label 不对）→ 设置里不出现；
//   3) 组件一渲染就抛错 → 槽位空白，控制台只有一句 crash。
//
// 用法：node verify/verify_client_module.mjs
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

// ---- 1) 模块声明：id = 包名 ----
let loaded
/** `/status` 的应答；第二个渲染段会把它换成「已连接」快照。 */
let fixture = { bridge: {}, config: null }
const sandbox = {
  console,
  setInterval: () => 1,
  clearInterval: () => {},
  fetch: async () => ({ status: 200, json: async () => ({ ok: true, value: fixture }) }),
  window: {
    __ModuleLoader__: {
      load(declaration) { loaded = declaration },
    },
  },
}
vm.runInNewContext(source, sandbox, { filename: 'client.js' })
check('client.js 调用了 __ModuleLoader__.load', loaded !== undefined)
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
check('模块 id 等于包名', loaded?.id === packageJson.name, `${loaded?.id} vs ${packageJson.name}`)
check('package.json 声明了 dsh.client.platform=web', packageJson.dsh?.client?.platform === 'web',
  JSON.stringify(packageJson.dsh?.client))
check('exports 暴露 ./client', packageJson.exports?.['./client'] === './client.js',
  String(packageJson.exports?.['./client']))

// ---- 2) 最小 React 替身：让组件真的渲染一遍（不装浏览器） ----
const tree = []
const React = {
  createElement(type, props, ...children) {
    const normalized = children.flat()
    // React 把 children 放进 props 传给组件；元素节点另外保留一份便于遍历。
    const withChildren = normalized.length === 0
      ? (props ?? {})
      : { ...(props ?? {}), children: normalized.length === 1 ? normalized[0] : normalized }
    return { type, props: withChildren, children: normalized }
  },
  useState(initial) { return [initial, () => {}] },
  useCallback(fn) { return fn },
  useEffect(effect) { const cleanup = effect(); if (typeof cleanup === 'function') cleanup() },
  Fragment: 'Fragment',
}
const factory = loaded?.factory
check('模块声明带 factory', typeof factory === 'function')
const module = factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
check('factory 返回 { inject, apply }', typeof module?.apply === 'function' && Array.isArray(module?.inject))

let registration
const ctx = {
  slots: {
    inject(ownerKey, callback) {
      check('apply() 通过 settings.section 注入', ownerKey === 'settings.section', String(ownerKey))
      callback()
    },
    register(options, component) {
      registration = { options, component }
      return () => {}
    },
  },
}
const applied = module.apply(ctx)
check('apply() 没有抛错', true)
void applied
check('注册到 settings.section', registration?.options?.name === 'settings.section', JSON.stringify(registration?.options))
check('注册 id = browser-control', registration?.options?.id === 'browser-control', String(registration?.options?.id))
check('注册 label 可调用且非空',
  typeof registration?.options?.label === 'function' && registration.options.label() === '浏览器控制',
  String(registration?.options?.label?.()))
check('组件是函数', typeof registration?.component === 'function')

// ---- 2b) bundle 必须在同一 realm 里可重复执行 ----
// HMR / 「重试本页面同步」会在**同一个页面 realm** 里重新执行同一个 bundle。
// 顶层 `const` 只声明一次，第二次执行直接 SyntaxError，脚本走不到
// `__ModuleLoader__.load`，页面报的就是「loaded without registering」。
{
  const repeatSandbox = {
    console,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async () => ({ status: 200, json: async () => ({ ok: true, value: fixture }) }),
    window: { __ModuleLoader__: { load() {} } },
  }
  vm.runInNewContext(source, repeatSandbox, { filename: 'client.js' })
  let secondError = null
  try {
    vm.runInNewContext(source, repeatSandbox, { filename: 'client.js' })
  } catch (error) {
    secondError = String(error?.message ?? error)
  }
  check('同一 realm 重复执行 bundle 不抛错（HMR/重试的前提）', secondError === null, secondError ?? '')
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '')
  check('顶层没有 const/let/var 声明（所有声明都在 factory 内）',
    !/^(?:const|let|var)\s/m.test(withoutComments),
    (withoutComments.match(/^(?:const|let|var)\s.*/m) ?? [''])[0])
}

// ---- 3) 组件能在「空状态」下渲染，并把页面骨架交给 React ----
/** 展平一棵（假的）元素树里的可见文字；函数组件真的被调用，style 跳过。 */
function visibleText(element) {
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { texts.push(node); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node === 'object') {
      if (typeof node.type === 'function') { walk(node.type(node.props)); return }
      if (node.type === 'style') return
      ;(node.children ?? []).forEach(walk)
    }
  }
  walk(element)
  return texts.join('\n')
}

/**
 * 收集一棵（假的）元素树里满足条件的宿主标签节点。
 * 函数组件会被真的调用——枚举下拉是 SelectRow 组件的结果，不展开就找不到 `<select>`。
 */
function collectElements(element, predicate) {
  const found = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node !== 'object') return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node.type === 'function') { walk(node.type(node.props)); return }
    if (predicate(node)) found.push(node)
    ;(node.children ?? []).forEach(walk)
  }
  walk(element)
  return found
}

const optionValues = select => (select.children ?? []).map(option => option.props.value)

/** 一行状态行的可见文字（StatusRow 渲染成 label span + value span）。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  if (node.type === 'style') return ''
  return (node.children ?? []).map(textOf).join('')
}

/** 链路状态卡片里的每一行：label、value 文字与 value 的 className（tone 只该是颜色）。 */
function statusRows(element) {
  return collectElements(element, node => node.type === 'div' && String(node.props?.className ?? '').startsWith('bc-status-row'))
    .map(row => {
      const cells = row.children ?? []
      return { label: textOf(cells[0]), value: textOf(cells[1]), className: String(cells[1]?.props?.className ?? '') }
    })
}

/**
 * 每一行设置：左边「中文标题 + 字段名」，右边控件。
 *
 * 行元素带 `data-key=配置字段名`，断言按字段找行，不按下标——加一个控件不会把老断言全带崩。
 * 解释性文字在行的 `title` 属性上（hover 才出现），所以这里同时把 `title` 收出来给 hint 用。
 */
function rowEntries(element) {
  return collectElements(element, node => node.type === 'div' && String(node.props?.className ?? '') === 'bc-row')
    .map(row => {
      const cells = row.children ?? []
      return {
        key: String(row.props?.['data-key'] ?? ''),
        title: textOf(cells[0]?.children?.[0]),
        hint: String(row.props?.title ?? ''),
        switchNode: collectElements(cells[1], node => node.type === 'button' && node.props?.role === 'switch')[0],
        inputNode: collectElements(cells[1], node => node.type === 'input')[0],
      }
    })
}

/** 用一份 /status 快照渲染整页（第一个 useState 是 useStatus 的 state）。 */
function renderWith(snapshot) {
  const originalUseState = React.useState
  let hook = 0
  React.useState = (initial) => {
    hook += 1
    return hook === 1 ? [{ loading: false, value: snapshot, error: null }, () => {}] : [initial, () => {}]
  }
  try {
    return registration.component()
  } finally {
    React.useState = originalUseState
  }
}

{
  const element = registration.component()
  const flat = visibleText(element)
  check('渲染结果是一棵元素树（不是 undefined）', typeof element === 'object' && element !== null)
  check('页面骨架里有「浏览器控制」标题', flat.includes('浏览器控制'))
  check('空状态下也给出「尚未加载配置 / 未监听」这类可读状态',
    /尚未加载配置|未监听|已停用/.test(flat), flat.slice(0, 120))
  // 重排之后标题与字段名是分开的两段（中文标签 + 小号字段名），所以分开断言：
  // 中文标签是给人读的，字段名是给人拿去改 cordis.patch.yml 的，两个都不能丢。
  check('五个闸门开关的标签与字段名都在',
    ['只读档', '脚本执行', '工具懒加载', '原生 CDP', '隔离实例'].every(label => flat.includes(label))
      && ['readOnly', 'allowScript', 'lazyToolDocs', 'allowRawCdp', 'allowIncognito'].every(key => flat.includes(key)))
  check('三个枚举设置的标签与字段名都在',
    ['标签页打开位置', '聚焦策略', '用户接管'].every(label => flat.includes(label))
      && ['tabWindow', 'focusPolicy', 'userTakeover'].every(key => flat.includes(key)))
  check('动作按钮都在', ['打开状态页', '清理截图与临时文件', '刷新状态'].every(label => flat.includes(label)))
  check('组件包含了样式（style 元素）', JSON.stringify(element).includes('bc-page'))
  // 回归：tone 曾作为 children 传进 StatusRow，页面上就出现了「1.0.20ok」「ds****alwarn」。
  check('空状态下没有把 tone 词渲染成正文',
    !/(^|\s)(ok|err|warn|idle)(\s|$)/.test(flat), flat.slice(0, 160))

  // 枚举控件：三个受控 <select>，值必须落在 schema 默认值上，可选值必须与契约逐字一致。
  const selects = collectElements(element, node => node.type === 'select')
  check('三个枚举设置都是下拉控件（<select>）', selects.length === 3, `${selects.length}`)
  check('未加载配置时下拉落在 schema 默认值（current / avoid / yield）',
    JSON.stringify(selects.map(select => select.props.value)) === JSON.stringify(['current', 'avoid', 'yield']),
    JSON.stringify(selects.map(select => select.props.value)))
  check('下拉可选值就是契约词汇（current|new、avoid|auto、yield|ignore）',
    JSON.stringify(selects.map(optionValues))
      === JSON.stringify([['current', 'new'], ['avoid', 'auto'], ['yield', 'ignore']]),
    JSON.stringify(selects.map(optionValues)))
  check('下拉选项文案是中文（人读的文案与落盘的值分开）',
    selects.every(select => (select.children ?? []).every(option => /[\u4e00-\u9fa5]/.test(String(option.props.children)))))
  check('下拉带可访问名（aria-label 取标题）',
    selects.every(select => typeof select.props['aria-label'] === 'string' && select.props['aria-label'].length > 0))
}

// ---- 4) 已连接状态：值只显示值，tone 只做颜色 ----
{
  fixture = {
    bridge: {
      configured: true, enabled: true, listening: true, port: 9777, pendingCommands: 0,
      insecureToken: true,
      extension: {
        connected: true, protocol: 1, compatible: true,
        hello: { name: '浏览器', version: '1.0.20' },
      },
    },
    config: {
      enabled: true, port: 9777, tokenMasked: 'ds****al',
      readOnly: false, allowScript: true, lazyToolDocs: false, allowRawCdp: true,
      tabWindow: 'new', focusPolicy: 'auto', userTakeover: 'ignore',
    },
  }
  // 组件里的 setState 是空实现，刷新不会回流到本次渲染；直接把首个 useState
  // 的初值换成「已连上」的快照，渲染路径才是真的。
  const originalUseState = React.useState
  let hook = 0
  React.useState = (initial) => {
    hook += 1
    return hook === 1
      ? [{ loading: false, value: fixture, error: null }, () => {}]
      : [initial, () => {}]
  }
  const connectedElement = registration.component()
  const flat = visibleText(connectedElement)
  React.useState = originalUseState
  check('已连接：扩展版本显示为 1.0.20（没有 trailing ok）',
    flat.includes('1.0.20') && !flat.includes('1.0.20ok'), flat.slice(0, 200))
  check('已连接：Token 掩码后面没有 trailing warn',
    flat.includes('ds****al') && !flat.includes('ds****alwarn'), flat.slice(0, 200))
  check('已连接：桥接显示监听地址', flat.includes('监听中 127.0.0.1:9777'))
  check('已连接：正文里不出现 tone 词',
    !/(^|\s)(ok|err|warn|idle)(\s|$)/.test(flat), flat.slice(0, 200))
  // 受控下拉：显示的是服务端当前值，不是写死的默认值（否则页面上永远显示「已生效」的假象）。
  const connectedSelects = collectElements(connectedElement, node => node.type === 'select')
  check('已连接：下拉显示配置里的当前值（new / auto / ignore）',
    JSON.stringify(connectedSelects.map(select => select.props.value)) === JSON.stringify(['new', 'auto', 'ignore']),
    JSON.stringify(connectedSelects.map(select => select.props.value)))
}

// ---- 4b) 隔离实例：allowIncognito 开关 + 「无痕权限」那一行 ----
// 两道授权是分开的两件事：本页的 allowIncognito 决定「插件让不让模型开无痕罐」，
// 浏览器扩展页的「在无痕中允许」决定「浏览器给不给扩展这个能力」。页面必须能分别显示，
// 否则用户永远不知道第二步该去哪儿开。字段缺失（老扩展 / 没握手）时只能显示「—」。
{
  const snapshot = (hello, config) => ({
    bridge: {
      configured: true, enabled: true, listening: true, port: 9777, pendingCommands: 0, insecureToken: false,
      extension: { connected: true, protocol: 1, compatible: true, hello },
    },
    config: {
      enabled: true, port: 9777, tokenMasked: 'ds****al',
      readOnly: false, allowScript: true, lazyToolDocs: false, allowRawCdp: true, allowIncognito: false,
      tabWindow: 'current', focusPolicy: 'avoid', userTakeover: 'yield',
      ...config,
    },
  })

  // (a) 开关本身：五个闸门按原顺序都在，隔离实例仍是最后一个闸门；AI 高亮排在它后面。
  const onElement = renderWith(snapshot({ name: '浏览器', version: '1.0.22', incognitoAllowed: true }, { allowIncognito: true }))
  const toggles = rowEntries(onElement).filter(entry => entry.switchNode !== undefined)
  check('五个闸门开关按原顺序都在，隔离实例是最后一个闸门',
    JSON.stringify(toggles.slice(0, 5).map(entry => entry.key))
      === JSON.stringify(['readOnly', 'allowScript', 'lazyToolDocs', 'allowRawCdp', 'allowIncognito']),
    toggles.map(entry => `${entry.key}:${entry.title}`).join(','))
  check('开关共六个（五个闸门 + 末尾的 AI 高亮）',
    toggles.length === 6 && toggles[5].key === 'agentHighlight',
    `${toggles.length}｜${toggles.map(entry => entry.key).join(',')}`)
  const incognitoRow = toggles.find(entry => entry.key === 'allowIncognito')
  check('allowIncognito 打开时开关就是开（aria-checked=true）',
    incognitoRow?.switchNode?.props?.['aria-checked'] === 'true', String(incognitoRow?.switchNode?.props?.['aria-checked']))
  // 这一版把解释性文字从正文挪到了行的 title 上，所以断言改看 title：内容还是那段内容。
  check('allowIncognito 的 hint 说清默认关 + 还要去浏览器扩展页打开无痕权限',
    /默认关/.test(incognitoRow?.hint ?? '') && /InPrivate/.test(incognitoRow?.hint ?? ''),
    String(incognitoRow?.hint ?? '').slice(0, 80))
  check('解释性文字不在正文里（收进 title，hover 才出现）',
    !/默认关/.test(textOf(onElement)) && !/拒绝一切会改变页面/.test(textOf(onElement)))

  // (b) 浏览器允许无痕 → 「已允许」，用 ok 色调（tone 只进 className，不进正文）。
  {
    const row = statusRows(onElement).find(entry => entry.label === '无痕权限')
    check('链路状态卡片有无痕权限这一行',
      row !== undefined, statusRows(onElement).map(entry => entry.label).join(','))
    check('无痕权限=已允许', row?.value === '已允许', String(row?.value))
    check('无痕权限=已允许 走 ok 色调（只染颜色）', /\bok\b/.test(row?.className ?? ''), String(row?.className))
  }

  // (c) 浏览器没给权限 → 说清后果（模型开不了隔离实例），并标 warn。
  {
    const denied = renderWith(snapshot({ name: '浏览器', version: '1.0.22', incognitoAllowed: false }, { allowIncognito: false }))
    const row = statusRows(denied).find(entry => entry.label === '无痕权限')
    check('无痕权限=未允许 时文案说明「模型开不了隔离实例」',
      row?.value === '未允许（模型开不了隔离实例）', String(row?.value))
    check('无痕权限=未允许 走 warn 色调', /\bwarn\b/.test(row?.className ?? ''), String(row?.className))
    const closed = rowEntries(denied).find(entry => entry.key === 'allowIncognito')
    check('allowIncognito 关着时对应开关显示为关（默认档）',
      closed?.switchNode?.props?.['aria-checked'] === 'false',
      String(closed?.switchNode?.props?.['aria-checked']))
  }

  // (d) 老扩展不发这个字段 → 「—」，不许猜成「未允许」（那会让人去翻一个本来就开着的开关）。
  {
    const unknown = renderWith(snapshot({ name: '浏览器', version: '1.0.10' }, { allowIncognito: true }))
    const row = statusRows(unknown).find(entry => entry.label === '无痕权限')
    check('无痕权限字段缺失时显示「—」（不猜成未允许）', row?.value === '—', String(row?.value))
  }

  // (e) 压根没连上扩展 → 同样「—」。
  {
    const row = statusRows(registration.component()).find(entry => entry.label === '无痕权限')
    check('未连接扩展时无痕权限显示「—」', row?.value === '—', String(row?.value))
  }
}

// ---- 4c) 分组名与 AI 高亮：两个新控件的契约 ----
// 分组名是**自由文本**，而且空串有含义（= 不分组）：绝不能兜底成默认值 DSH，也绝不能每敲
// 一个字就发一次 POST——一次 profile 写入就会重载插件、重连扩展。AI 高亮默认开。
{
  const withNew = {
    bridge: {
      configured: true, enabled: true, listening: true, port: 9777, pendingCommands: 0, insecureToken: false,
      extension: { connected: true, protocol: 1, compatible: true, hello: { name: '浏览器', version: '1.0.22', incognitoAllowed: true } },
    },
    config: {
      enabled: true, port: 9777, tokenMasked: 'ds****al',
      readOnly: false, allowScript: true, lazyToolDocs: false, allowRawCdp: true, allowIncognito: false,
      tabWindow: 'current', focusPolicy: 'avoid', userTakeover: 'yield',
      tabGroupTitle: '抓取-2026', agentHighlight: false,
    },
  }
  const page = renderWith(withNew)

  const titleRow = rowEntries(page).find(entry => entry.key === 'tabGroupTitle')
  const titleInput = titleRow?.inputNode
  check('分组名是一行文本输入框（<input type="text">）',
    titleInput !== undefined && titleInput.props.type === 'text', JSON.stringify(titleInput?.props?.type))
  check('分组名显示 status 里的 config.tabGroupTitle',
    titleInput?.props.value === '抓取-2026', String(titleInput?.props.value))
  check('分组名带可访问名，且长度上限取宿主的 40',
    titleInput?.props['aria-label'] === '分组名' && titleInput?.props.maxLength === 40,
    `${titleInput?.props['aria-label']}｜${titleInput?.props.maxLength}`)
  check('分组名在失焦或回车时提交（不是每敲一个字发请求）',
    typeof titleInput?.props.onBlur === 'function' && typeof titleInput?.props.onKeyDown === 'function'
      && typeof titleInput?.props.onChange === 'function')
  check('分组名有一行极短说明：留空 = 不分组', textOf(page).includes('留空 = 不分组'))
  check('分组名的 hint 说明留空与分组标题的关系',
    /留空/.test(titleRow?.hint ?? '') || /空/.test(titleRow?.hint ?? ''), String(titleRow?.hint ?? '').slice(0, 60))

  // 没配过 → 契约默认值 DSH；配成空串 → 就是空串，不许被兜底回 DSH。
  const emptyConfig = rowEntries(renderWith({ bridge: {}, config: null })).find(entry => entry.key === 'tabGroupTitle')
  check('没配过分组名时输入框显示契约默认值 DSH',
    emptyConfig?.inputNode?.props?.value === 'DSH', String(emptyConfig?.inputNode?.props?.value))
  const clearedConfig = rowEntries(renderWith({ bridge: {}, config: { tabGroupTitle: '' } }))
    .find(entry => entry.key === 'tabGroupTitle')
  check('分组名配成空串时显示为空（空串 = 不分组，不能兜底成 DSH）',
    clearedConfig?.inputNode?.props?.value === '', JSON.stringify(clearedConfig?.inputNode?.props?.value))

  const highlightRow = rowEntries(page).find(entry => entry.key === 'agentHighlight')
  check('AI 高亮是开关控件，且跟随 config.agentHighlight（这里是关）',
    highlightRow?.switchNode?.props?.['aria-checked'] === 'false',
    String(highlightRow?.switchNode?.props?.['aria-checked']))
  const highlightDefault = rowEntries(renderWith({ bridge: {}, config: { enabled: true } }))
    .find(entry => entry.key === 'agentHighlight')
  check('agentHighlight 字段缺失时按契约默认值显示为开',
    highlightDefault?.switchNode?.props?.['aria-checked'] === 'true',
    String(highlightDefault?.switchNode?.props?.['aria-checked']))

  // 落库路径：两个新字段都必须走 `{ patch: { 字段: 值 } }` 打同一个 /config 端点。
  check('分组名通过 patch(tabGroupTitle) 落库', /patch\('tabGroupTitle'/.test(source))
  check('AI 高亮通过 patch(agentHighlight) 落库', /patch\('agentHighlight'/.test(source))
  check('配置写入的请求体形状是 { patch: { [字段]: 值 } }',
    /post\(`\$\{API\}\/config`, \{ patch: \{ \[key\]: next \} \}\)/.test(source))
  check('分组名提交前压平空白并 trim（与宿主同一套归一）',
    /function normalizeTitle[\s\S]*?\.trim\(\)/.test(source))
}

// ---- 5) 主按钮在深色主题下必须可读 ----
check('主按钮不再硬编码 #fff 文字（brand 在深色主题是浅色）', !/color:\s*#fff/i.test(source))
check('主按钮用 bg-base 作为文字色（跟随主题反转）',
  /\.bc-button\.primary[^}]*color:\s*var\(--dsw-alias-bg-base\)/.test(source))

// ---- 6) 新控件同样必须留在 factory 内、用主题 token ----
// 这一条针对的是刚加的下拉：把它的样式挪到顶层（或另起一个顶层 const OPTIONS）
// 就是同一个「HMR 二次执行炸掉」的坑，只是换了个名字。
{
  const factoryStart = source.indexOf('factory(require)')
  check('factory 声明在看得到的地方（定位得到 factory 边界）', factoryStart > 0)
  check('下拉样式写在 factory 之内（不在顶层）',
    factoryStart > 0 && source.indexOf('.bc-select') > factoryStart)
  check('下拉颜色走 --dsw-alias-* 主题 token（不硬编码颜色）',
    /\.bc-select[^}]*var\(--dsw-alias-/.test(source))
  check('下拉选项的取值来自组件内常量，不是内联魔法字符串',
    /const TAB_WINDOW_OPTIONS =/.test(source) && /const FOCUS_POLICY_OPTIONS =/.test(source)
      && /const USER_TAKEOVER_OPTIONS =/.test(source))
}

console.log(fails === 0 ? '\n设置页 Client 模块结构符合契约' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
