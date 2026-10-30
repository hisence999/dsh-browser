// 工具懒启动（lazyToolDocs）的实测台。
//
// 这一层的风险不是「省不省 token」，而是三条容易悄悄坏掉的契约：
//   1) 懒启动只决定「暴不暴露」，**描述与参数一个字节都不许变** —— 装上的工具
//      必须和全开模式下的定义逐字节相同（不能有第二份、更不能有桩描述）；
//   2) 全开模式不该有装载器，懒启动模式不该有第二个入口 —— 只有一个 browser_tools；
//   3) 分组表是模型唯一的发现入口，必须恰好覆盖每个工具一次（新加工具忘了归组就红）；
//   4) 装载是**会话级**的：装进当前 agent 的作用域，别的会话看不见，会话结束自己收掉；
//      没有会话作用域时退回全局层，但要如实读回并报出来（不许拿意图当事实）。
//
// 用法：node verify/verify_tool_docs.mjs
import { readFileSync } from 'node:fs'
import { Config, apply } from '../lib/index.js'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { TOOL_GROUPS, groupOf } from '../src/tool-help.ts'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}
const stable = value => JSON.stringify(value)
/** 假件里注册着的东西去掉装载器本身 = 模型真正能调的工具。 */
const callable = (booted) => [...booted.tools.keys()].filter(name => name !== 'browser_tools').sort()

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
    tools: {
      register: (def) => { tools.set(def.name, def); return () => { tools.delete(def.name) } },
      get: (name) => tools.get(name),
    },
    systemPrompt: { section: (section) => sections.push(section) },
  }
  apply(ctx, Config({ enabled: false, port: 9793, token: 'tool-docs-test', ...extra }))
  return { tools, sections, disposers }
}

/** 模拟插件卸载：跑一遍 `ctx.effect` 的本体，拿到各自的摘除函数再执行。 */
const teardown = (booted) => {
  for (const body of booted.disposers) {
    const off = body()
    if (typeof off === 'function') off()
  }
}

const call = async (definition, args, exec) => {
  const value = await definition.execute(args, { signal: new AbortController().signal, ...(exec ?? {}) })
  const schemaViolations = validateJsonSchemaValue(definition.output.schema, value, 'value')
  const blocks = definition.output.render(args, value)
  const text = blocks.map(part => part.text ?? '').join('\n')
  return { value, text, violations: schemaViolations }
}

const eager = boot({ lazyToolDocs: false })
const eagerNames = [...eager.tools.keys()].sort()

// ---- 1) 全开模式：每个工具都在，描述就是它自己的完整描述 ----
check('全开模式默认注册 23 个工具（22 个工具 + browser_cdp）', eagerNames.length === 23, `${eagerNames.length}`)
check('全开模式没有装载器 browser_tools', !eager.tools.has('browser_tools'), eagerNames.join(','))
check('browser_help 已删除（描述完整就不需要第二个入口）', !eager.tools.has('browser_help'))
check('全开模式注册了 browser_cdp（allowRawCdp 默认开）', eager.tools.has('browser_cdp'))
{
  const short = eagerNames.filter(name => eager.tools.get(name).description.trim().length < 30)
  check('全开模式没有短桩描述：每个工具的描述都超过 30 字符', short.length === 0, short.join(','))
  const stub = eagerNames.filter(name => /loaded on demand|loaded on request/i.test(eager.tools.get(name).description))
  check('全开模式没有任何「描述按需加载」的桩话', stub.length === 0, stub.join(','))
}

// ---- 2) 懒启动模式：只暴露一个工具 ----
const lazy = boot({ lazyToolDocs: true })
const lazyNames = [...lazy.tools.keys()]
check('懒启动模式只注册一个工具', lazyNames.length === 1, lazyNames.join(','))
check('那一个工具就是 browser_tools', lazyNames[0] === 'browser_tools', lazyNames[0])
check('懒启动模式没有 browser_help', !lazy.tools.has('browser_help'))

const loader = lazy.tools.get('browser_tools')
{
  const text = loader.description
  check('装载器描述够细：长度超过 800 字符', text.length > 800, `${text.length}`)
  check('装载器描述点明「未装载就调不到」', /cannot be called/.test(text), text.slice(0, 90))
  check('装载器描述教无参调用会报目录', /no `names`/.test(text), text.slice(0, 90))
  check('装载器描述点名 "*" 与「一次装齐」', /\*/.test(text) && /ONE call/.test(text), text.slice(0, 90))
  const mentioned = Object.keys(TOOL_GROUPS).filter(group => text.includes(`"${group}"`))
  check('装载器描述列出了每一个分组名', mentioned.length === Object.keys(TOOL_GROUPS).length,
    `提到 ${mentioned.join(',')} / 共 ${Object.keys(TOOL_GROUPS).join(',')}`)
  const listed = Object.values(TOOL_GROUPS).flat()
  check('装载器描述把每个工具名都写了出来（模型不用猜名字）',
    listed.every(name => text.includes(name)), listed.filter(name => !text.includes(name)).join(','))
}

// ---- 3) 无参 = 目录：还没装载的全部工具，一条一行 ----
const catalog = await call(loader, {})
check('目录调用过输出 schema', catalog.violations.length === 0, catalog.violations.join(' | '))
check('目录里什么也还没装载', catalog.value.exposed.length === 0, catalog.value.exposed.join(','))
check('目录列出全部 23 个工具（懒启动下都一样能装）',
  stable(catalog.value.available.map(row => row.name).sort()) === stable(eagerNames),
  `${catalog.value.available.length} vs ${eagerNames.length}`)
check('目录里没有重复项', new Set(catalog.value.available.map(row => row.name)).size === catalog.value.available.length)
check('目录每一行都有合法分组', catalog.value.available.every(row => groupOf(row.name) === row.group),
  catalog.value.available.filter(row => groupOf(row.name) !== row.group).map(row => row.name).join(','))
check('目录每一行 summary 非空', catalog.value.available.every(row => row.summary.trim().length > 0))
check('目录文本里读得到工具名与装载指纹', catalog.text.includes('browser_click') && /browser_tools \{names/.test(catalog.text),
  catalog.text.split('\n')[0])

// ---- 4) 按分组装载：装上的定义与全开模式逐字节一致 ----
const readGroup = await call(loader, { names: ['read'] })
check('按分组装载过输出 schema', readGroup.violations.length === 0, readGroup.violations.join(' | '))
check('"read" 分组装上了 7 个工具', readGroup.value.activated.length === 7, readGroup.value.activated.join(','))
check('"read" 装的就是分组表里那几个',
  stable(readGroup.value.activated) === stable([...TOOL_GROUPS.read].sort()), readGroup.value.activated.join(','))
{
  const wrong = lazyNames.filter(name => name !== 'browser_tools' && !TOOL_GROUPS.read.includes(name))
  check('装载后暴露的工具 = 装载器 + read 分组，别的一个都没多',
    lazy.tools.size === 1 + TOOL_GROUPS.read.length && wrong.length === 0, `size=${lazy.tools.size} 多余=${wrong.join(',')}`)
  let identical = true
  const diffs = []
  for (const name of TOOL_GROUPS.read) {
    const activated = lazy.tools.get(name)
    const reference = eager.tools.get(name)
    if (activated === undefined || stable(activated) !== stable(reference)) {
      identical = false
      diffs.push(name)
    }
  }
  check('装载上的工具定义与全开模式逐字节相同（描述 + 参数 schema，没有第二份）', identical, diffs.join(','))
  check('装载上的工具不是桩描述', TOOL_GROUPS.read.every(name => !/loaded on demand/i.test(lazy.tools.get(name).description)))
}
{
  const again = await call(loader, { names: ['browser_read'] })
  check('重复装载同一个工具：报 already 而不是装第二遍',
    again.value.already.includes('browser_read') && again.value.activated.length === 0, stable(again.value))
  check('重复装载不改暴露集合', lazy.tools.size === 1 + TOOL_GROUPS.read.length, `${lazy.tools.size}`)
}
{
  const rest = await call(loader, {})
  check('目录只剩没装载的 16 个', rest.value.available.length === 23 - TOOL_GROUPS.read.length, `${rest.value.available.length}`)
  check('已装载的不再出现在目录里', rest.value.available.every(row => !TOOL_GROUPS.read.includes(row.name)))
  check('目录回显已装载清单', stable(rest.value.exposed) === stable([...TOOL_GROUPS.read].sort()), rest.value.exposed.join(','))
}

// ---- 5) 混装：分组 + 精确名字 + 不认识的词，一趟装完 ----
const mixed = await call(loader, { names: ['tabs', 'browser_press', 'WRITE', 'browser_nope'] })
check('混装调用过输出 schema', mixed.violations.length === 0, mixed.violations.join(' | '))
check('混装：分组名大小写不敏感（WRITE 就是 write）',
  mixed.value.activated.filter(name => TOOL_GROUPS.write.includes(name)).length === TOOL_GROUPS.write.length,
  mixed.value.activated.join(','))
check('混装：精确工具名单独生效', mixed.value.activated.includes('browser_press'))
check('混装：tabs 分组也装上', TOOL_GROUPS.tabs.every(name => mixed.value.activated.includes(name)))
check('混装：不认识的词单独列进 unknown，不阻塞其余',
  stable(mixed.value.unknown) === stable(['browser_nope']), stable(mixed.value.unknown))
check('混装之后暴露集合 = 装载器 + read + tabs + write',
  lazy.tools.size === 1 + new Set([...TOOL_GROUPS.read, ...TOOL_GROUPS.tabs, ...TOOL_GROUPS.write]).size,
  `${lazy.tools.size}`)

// ---- 6) "*" 一次装齐：剩下的全部，定义逐字节等于全开模式 ----
const all = await call(loader, { names: ['*'] })
check('"*" 调用过输出 schema', all.violations.length === 0, all.violations.join(' | '))
check('"*" 之后暴露集合与全开模式完全一致', stable(callable(lazy)) === stable(eagerNames),
  `${callable(lazy).length} vs ${eagerNames.length}`)
check('"*" 之后 exposed 报的清单不含装载器自己（它不是可调用能力）',
  !all.value.exposed.includes('browser_tools') && all.value.exposed.length === eagerNames.length,
  `${all.value.exposed.length}`)
{
  const diffs = eagerNames.filter(name => stable(lazy.tools.get(name)) !== stable(eager.tools.get(name)))
  check('每一个被装载的定义都与全开模式逐字节相同', diffs.length === 0, diffs.join(','))
}
{
  const nothing = await call(loader, { names: [] })
  check('空数组等同无参：回目录而不是报错', Array.isArray(nothing.value.available) && nothing.value.available.length === 0,
    stable(nothing.value.available))
}

// ---- 7) 分组表：模型唯一的发现入口，必须恰好覆盖每个工具一次 ----
{
  const listed = Object.values(TOOL_GROUPS).flat()
  const duplicates = listed.filter((name, index) => listed.indexOf(name) !== index)
  check('分组表里没有重复的工具名', duplicates.length === 0, duplicates.join(','))
  check('分组表覆盖全开模式的每一个工具（多一个少一个都红）',
    stable([...listed].sort()) === stable(eagerNames),
    `表里多 ${listed.filter(name => !eagerNames.includes(name)).join(',')} / 缺 ${eagerNames.filter(name => !listed.includes(name)).join(',')}`)
  check('分组表里没有不存在的工具', listed.every(name => eagerNames.includes(name)))
  check('分组名都是非空小写串', Object.keys(TOOL_GROUPS).every(group => group.length > 0 && group === group.toLowerCase()),
    Object.keys(TOOL_GROUPS).join(','))
  check('每个分组至少两个工具（除 raw 这种逃生口）',
    Object.entries(TOOL_GROUPS).every(([group, names]) => names.length >= 2 || group === 'raw'),
    Object.entries(TOOL_GROUPS).map(([group, names]) => `${group}:${names.length}`).join(','))
}

// ---- 8) 系统提示词：两种模式一字不差（不再有懒加载专属那一段） ----
{
  const eagerPrompt = eager.sections.find(section => section.name === 'tool:browser')?.text ?? ''
  const lazyPrompt = lazy.sections.find(section => section.name === 'tool:browser')?.text ?? ''
  check('系统提示词在两种模式下完全相同', eagerPrompt === lazyPrompt && eagerPrompt.length > 500, `${eagerPrompt.length}/${lazyPrompt.length}`)
  check('系统提示词不再宣传「描述延迟加载」', !/deferred|load on demand|browser_help/.test(eagerPrompt))
  check('系统提示词仍写着 browser_snapshot 优先（工具装载后才用得上，但不矛盾）', /browser_snapshot/.test(eagerPrompt))
}

// ---- 9) allowRawCdp:false：能力面收紧，两种模式都不能出现 browser_cdp ----
{
  const eagerNoCdp = boot({ lazyToolDocs: false, allowRawCdp: false })
  check('全开 + allowRawCdp:false：browser_cdp 不注册', !eagerNoCdp.tools.has('browser_cdp'))
  check('全开 + allowRawCdp:false：其余 22 个照常', eagerNoCdp.tools.size === 22, `${eagerNoCdp.tools.size}`)

  const lazyNoCdp = boot({ lazyToolDocs: true, allowRawCdp: false })
  const loaderNoCdp = lazyNoCdp.tools.get('browser_tools')
  const catalogNoCdp = await call(loaderNoCdp, {})
  check('懒启动 + allowRawCdp:false：目录里没有 browser_cdp',
    !catalogNoCdp.value.available.some(row => row.name === 'browser_cdp'), `${catalogNoCdp.value.available.length}`)
  const starNoCdp = await call(loaderNoCdp, { names: ['*'] })
  check('懒启动 + allowRawCdp:false：* 也装不出 browser_cdp', !lazyNoCdp.tools.has('browser_cdp'), starNoCdp.value.activated.join(','))
  check('懒启动 + allowRawCdp:false：暴露集合 = 装载器 + 22 个工具', lazyNoCdp.tools.size === 23, `${lazyNoCdp.tools.size}`)
  const askCdp = await call(loaderNoCdp, { names: ['browser_cdp'] })
  check('懒启动 + allowRawCdp:false：点名要 browser_cdp 报 unknown 而不是假装装上',
    stable(askCdp.value.unknown) === stable(['browser_cdp']) && !lazyNoCdp.tools.has('browser_cdp'), stable(askCdp.value))
}

// ---- 10) 源码里不许再留「桩描述」这套东西 ----
{
  const toolHelp = readFileSync(new URL('../src/tool-help.ts', import.meta.url), 'utf8')
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  check('src/tool-help.ts 里不再有 LAZY_DESCRIPTION 桩', !/LAZY_DESCRIPTION/.test(toolHelp))
  check('源码里没有任何「描述按需加载」的英文桩话', !/loaded on demand/i.test(toolHelp) && !/loaded on demand/i.test(index))
  check('源码里已经没有 browser_help', !/browser_help/.test(index))
  check('src/index.ts 的懒分支只注册一个工具（browser_tools）', /name: 'browser_tools'/.test(index))
}

// ---- 11) 会话级装载：按 agent 隔离，别的会话看不见，插件卸载时自己收干净 ----
{
  const fakeAgent = (id) => {
    const scoped = new Map()
    return {
      id,
      tools: scoped,
      ctx: {
        tools: {
          register: (def) => { scoped.set(def.name, def); return () => { scoped.delete(def.name) } },
          get: (name) => scoped.get(name),
        },
      },
    }
  }
  const box = boot({ lazyToolDocs: true })
  const loaderHere = box.tools.get('browser_tools')
  const agentA = fakeAgent('session-A')
  const agentB = fakeAgent('session-B')

  check('装载器描述点明「装载只对本会话生效」', /THIS session only/.test(loaderHere.description),
    loaderHere.description.slice(0, 80))

  const loadA = await call(loaderHere, { names: ['browser_read'] }, { agent: agentA })
  check('会话装载：A 装载后 activated 里就是它', stable(loadA.value.activated) === stable(['browser_read']), stable(loadA.value))
  check('会话装载：注册落进 A 自己的作用域', agentA.tools.has('browser_read'), [...agentA.tools.keys()].join(','))
  check('会话装载：全局服务面上看不到它（隔离成立）', !box.tools.has('browser_read'),
    [...box.tools.keys()].join(','))
  check('会话装载：scope 读回 session（不是靠猜）', loadA.value.scope === 'session', loadA.value.scope)
  check('会话装载：别的会话 B 的服务面上没有它', !agentB.tools.has('browser_read'))

  const catalogB = await call(loaderHere, {}, { agent: agentB })
  check('会话装载：B 报目录时仍列着 browser_read（只是 B 没装）',
    catalogB.value.available.some(row => row.name === 'browser_read') && catalogB.value.exposed.length === 0,
    `${catalogB.value.available.length}/${catalogB.value.exposed.length}`)

  const loadB = await call(loaderHere, { names: ['browser_read'] }, { agent: agentB })
  check('会话装载：A 与 B 各装同一件工具互不冲突（全局层会因重名直接炸）',
    stable(loadB.value.activated) === stable(['browser_read']) && loadB.value.errors === undefined && agentB.tools.has('browser_read'),
    stable(loadB.value))

  const againA = await call(loaderHere, { names: ['browser_read'] }, { agent: agentA })
  check('会话装载：A 重复装载报 already（记账按会话，不是按进程）',
    stable(againA.value.already) === stable(['browser_read']) && againA.value.activated.length === 0, stable(againA.value))

  const catalogA = await call(loaderHere, {}, { agent: agentA })
  check('会话装载：A 的目录里不再列 browser_read，B 的装载也没污染 A',
    !catalogA.value.available.some(row => row.name === 'browser_read')
    && stable(catalogA.value.exposed) === stable(['browser_read']), stable(catalogA.value.exposed))

  const globalLoad = await call(loaderHere, { names: ['browser_press'] }, {})
  check('没有 agent 时退回全局层：注册进插件自己的服务面', box.tools.has('browser_press'))
  check('没有 agent 时 scope 读回 global（不假装会话级）', globalLoad.value.scope === 'global', globalLoad.value.scope)
  check('全局层装载后全局视角立刻读得到（scope 判定有据可依）', box.tools.get('browser_press') !== undefined)

  const notAnAgent = await call(loaderHere, { names: ['browser_click'] }, { agent: 'nope' })
  check('exec.agent 不是对象时按「没有会话」处理，不抛',
    box.tools.has('browser_click') && notAnAgent.value.scope === 'global', stable(notAnAgent.value))

  const hostile = {
    id: 'session-H',
    tools: new Map(),
    ctx: {
      tools: {
        register: (def) => {
          if (def.name === 'browser_press') throw new Error('gate closed')
          hostile.tools.set(def.name, def)
          return () => {}
        },
        get: () => undefined,
      },
    },
  }
  const refused = await call(loaderHere, { names: ['browser_press', 'browser_read'] }, { agent: hostile })
  check('会话装载：注册抛错进 errors，并点名是哪一件',
    Array.isArray(refused.value.errors) && refused.value.errors.length === 1
    && refused.value.errors[0] === 'browser_press: gate closed', stable(refused.value.errors))
  check('会话装载：一条失败不阻塞同批其余', stable(refused.value.activated) === stable(['browser_read']),
    stable(refused.value.activated))
  check('会话装载：render 把失败念出来，不报成装上了', /Failed to load: browser_press/.test(refused.text), refused.text)
  check('会话装载：失败的没被算进装载集合', !hostile.tools.has('browser_press'), [...hostile.tools.keys()].join(','))

  teardown(box)
  check('插件卸载时把会话级注册一并摘掉（disposer 留在自己的 effect 里）',
    !agentA.tools.has('browser_read') && !agentB.tools.has('browser_read') && !box.tools.has('browser_press'),
    `${[...agentA.tools.keys()].join(',')} | ${[...box.tools.keys()].join(',')}`)
}

console.log(fails === 0 ? '\n工具懒启动全部符合契约' : `\n${fails} 项失败`)
process.exit(fails === 0 ? 0 : 1)
