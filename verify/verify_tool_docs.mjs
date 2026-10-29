// 工具描述懒加载（lazyToolDocs）与 browser_help 的实测台。
//
// 这一层的风险不是「省不省 token」，而是两条容易悄悄坏掉的契约：
//   1) 懒加载只许换描述，**参数 schema 一个字段都不许变** —— 变了模型就调不对；
//   2) browser_help 必须覆盖每一个注册的工具，且返回的是注册时那份完整描述，
//      不能是另一张手写表（那正是这个仓库已经栽过的 drift）。
//
// 用法：node verify/verify_tool_docs.mjs
import { Config, apply } from '../lib/index.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { LAZY_DESCRIPTION } from '../src/tool-help.ts'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** 用最小假 cordis 上下文跑真实 apply()；enabled:false 保证不占端口。 */
function boot(extra) {
  const tools = new Map()
  const sections = []
  const disposers = []
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { state: 2, uid: 1 },
    effect: (fn) => { disposers.push(fn); return () => {} },
    inject: (deps, cb) => {
      if (!deps.includes('settings')) return
      cb({
        settings: {
          configure: () => () => {},
          describe: () => [],
          update: async () => {},
          replace: async () => {},
          mutate: async () => {},
        },
        logger: ctx.logger,
      })
    },
    tools: { register: (def) => tools.set(def.name, def) },
    systemPrompt: { section: (section) => sections.push(section) },
  }
  apply(ctx, Config({ enabled: false, port: 9793, token: 'tool-docs-test', ...extra }))
  return { tools, sections, disposers }
}

const call = async (definition, args) => {
  const violations = []
  const value = await definition.execute(args, { signal: new AbortController().signal })
  const schemaViolations = validateJsonSchemaValue(definition.output.schema, value, 'value')
  const blocks = definition.output.render(args, value)
  const text = blocks.map(part => part.text ?? '').join('\n')
  return { value, text, violations: [...violations, ...schemaViolations] }
}

// ---- 1) 两种模式注册出来的工具集合 / 参数 schema 必须完全一致 ----
const eager = boot({ lazyToolDocs: false })
const lazy = boot({ lazyToolDocs: true })
const eagerNames = [...eager.tools.keys()].sort()
const lazyNames = [...lazy.tools.keys()].sort()
check('两种模式注册的工具集合一致', JSON.stringify(eagerNames) === JSON.stringify(lazyNames),
  `eager=${eagerNames.length} lazy=${lazyNames.length}`)
check('工具集合包含 browser_help 与 browser_cdp', eager.tools.has('browser_help') && eager.tools.has('browser_cdp'),
  eagerNames.join(','))
check('默认注册 24 个工具（21 个原有 + browser_profile + browser_help + browser_cdp）', eagerNames.length === 24, `${eagerNames.length}`)

for (const name of eagerNames) {
  const a = JSON.stringify(eager.tools.get(name).parameters)
  const b = JSON.stringify(lazy.tools.get(name).parameters)
  check(`${name}：懒加载没有改动参数 schema`, a === b, a === b ? '' : `eager=${a} lazy=${b}`)
}

// ---- 2) 懒加载只换描述；browser_help 自己必须保留真实描述 ----
for (const name of eagerNames) {
  const definition = lazy.tools.get(name)
  if (name === 'browser_help') {
    check('browser_help 在懒加载下保留完整描述（否则模型不知道要查）',
      definition.description !== LAZY_DESCRIPTION && definition.description.includes('Omit `tool`'),
      definition.description.slice(0, 80))
  } else {
    check(`${name}：懒加载下只剩一行短桩`, definition.description === LAZY_DESCRIPTION,
      definition.description.slice(0, 80))
  }
}

// ---- 3) browser_help：目录覆盖全部工具，单查返回注册时的完整描述 ----
const help = lazy.tools.get('browser_help')
const catalog = await call(help, {})
check('browser_help 目录过输出 schema', catalog.violations.length === 0, catalog.violations.join(' | '))
check('browser_help 目录 count 与注册数量一致', catalog.value.count === lazyNames.length,
  `${catalog.value.count} vs ${lazyNames.length}`)
check('browser_help 目录列出每个工具一次',
  JSON.stringify(catalog.value.tools.map(row => row.name).sort()) === JSON.stringify(lazyNames))
check('browser_help 目录：每条 summary 非空且不是短桩',
  catalog.value.tools.every(row => row.summary.length > 0 && row.summary !== LAZY_DESCRIPTION))
check('browser_help 目录文本里读得到工具名', catalog.text.includes('browser_click') && catalog.text.includes('browser_cdp'))

for (const name of lazyNames) {
  const doc = await call(help, { tool: name })
  check(`${name}：browser_help 单查过输出 schema`, doc.violations.length === 0, doc.violations.join(' | '))
  check(`${name}：browser_help 返回的是注册时的完整描述`,
    doc.value.tool.description === eager.tools.get(name).description,
    doc.value.tool.description.slice(0, 70))
  check(`${name}：完整描述进了模型可见文本`, doc.text.includes(doc.value.tool.description.slice(0, 40)))
  const eagerParams = JSON.parse(JSON.stringify(eager.tools.get(name).parameters))
  const expected = eagerParams.type === 'object' && eagerParams.properties
    ? Object.keys(eagerParams.properties)
    : Object.keys(eagerParams)
  check(`${name}：参数表覆盖全部参数`, JSON.stringify(doc.value.tool.parameters.map(p => p.name)) === JSON.stringify(expected),
    `help=${doc.value.tool.parameters.map(p => p.name).join(',')} schema=${expected.join(',')}`)
  if (expected.length === 0) {
    check(`${name}：无参数时明说 none`, doc.text.includes('Parameters: none'))
  } else {
    check(`${name}：参数名进了模型可见文本`, expected.every(key => doc.text.includes(key)))
  }
}

// ---- 3b) 第 24 个工具 browser_profile：目录里有、参数表三个、契约词在描述里 ----
// 名字/参数是对外契约（verify_profile_tool.mjs 按同一份契约断言 action→命令映射），
// 所以这里钉住的是「模型能不能从文档里知道怎么用它、以及它为什么默认关」。
{
  check('browser_profile 出现在目录里', catalog.value.tools.some(row => row.name === 'browser_profile'))
  const doc = await call(help, { tool: 'browser_profile' })
  check('browser_profile：browser_help 单查过输出 schema', doc.violations.length === 0, doc.violations.join(' | '))
  check('browser_profile 参数表就是 action / jar / url 三个',
    JSON.stringify(doc.value.tool.parameters.map(parameter => parameter.name)) === JSON.stringify(['action', 'jar', 'url']),
    doc.value.tool.parameters.map(parameter => parameter.name).join(','))
  const actionParameter = doc.value.tool.parameters.find(parameter => parameter.name === 'action')
  check('browser_profile action 必填且取值是 status | launch | use | close',
    actionParameter.required === true
      && JSON.stringify(actionParameter.enumValues) === JSON.stringify(['status', 'launch', 'use', 'close']),
    `${actionParameter.required}/${JSON.stringify(actionParameter.enumValues)}`)
  const jarParameter = doc.value.tool.parameters.find(parameter => parameter.name === 'jar')
  // 只收两个词：「auto」那种第三档会让「到底切没切进无痕罐」变成一件要猜的事。
  check('browser_profile jar 只收 normal | incognito',
    JSON.stringify(jarParameter.enumValues) === JSON.stringify(['normal', 'incognito']),
    JSON.stringify(jarParameter.enumValues))
  check('browser_profile 说明写清隔离实例 = 无痕窗口（独立 cookie 罐、不碰真实登录态）',
    /incognito window/i.test(doc.text) && /cookie jar/i.test(doc.text) && /signed-in session/i.test(doc.text),
    doc.text.slice(0, 120))
  check('browser_profile 说明写清两条授权前提（allowIncognito + 扩展页无痕权限）',
    /allowIncognito/.test(doc.text) && /incognito\/InPrivate/.test(doc.text), doc.text.slice(0, 160))
  check('browser_profile 说明点明 status 只读',
    /`status` \(read-only\)/.test(doc.text), doc.text.slice(0, 160))
}

// ---- 4) 未知工具要给出可用清单，而不是空结果 ----
{
  let message = ''
  try { await call(help, { tool: 'browser_nope' }) } catch (error) { message = String(error.message ?? error) }
  check('未知工具：抛错文案带 unknown browser tool 与可用清单',
    /unknown browser tool/.test(message) && /browser_click/.test(message), message.slice(0, 120))
}

// ---- 5) 系统提示词：懒加载时告诉模型先查 help；关闭时不该出现这句 ----
const eagerPrompt = eager.sections.find(section => section.name === 'tool:browser')?.text ?? ''
const lazyPrompt = lazy.sections.find(section => section.name === 'tool:browser')?.text ?? ''
check('懒加载：系统提示词指向 browser_help', /browser_help/.test(lazyPrompt))
check('非懒加载：系统提示词不宣传「描述延迟加载」', !/descriptions are deferred/.test(eagerPrompt))

// 6) allowRawCdp:false 时 browser_cdp 不注册（模型面 = 实际能力）
{
  const noCdp = boot({ allowRawCdp: false })
  check('allowRawCdp:false：browser_cdp 不出现', !noCdp.tools.has('browser_cdp'))
  check('allowRawCdp:false：其它工具照常注册', noCdp.tools.has('browser_click') && noCdp.tools.has('browser_help'))
}

console.log(fails === 0 ? '\n懒加载工具面全部符合契约' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
