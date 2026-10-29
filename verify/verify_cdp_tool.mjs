// browser_cdp（原生 CDP 透传）的实测台。
//
// 三条契约：
//   1) 命令真的走到 CDP，方法名与参数原样透传（不偷偷改写、不白名单裁剪）；
//   2) 结果是 JSON 字符串 + 真实字节数；超大结果必须截断并如实标记，不许把
//      几十万字符灌进模型上下文；
//   3) 策略上它不是「读工具」：只读档拒绝、allowScript:false 也拒绝（否则
//      browser_evaluate 的闸门可以靠一条 Runtime.evaluate 旁路掉）。
//
// 用法：node verify/verify_cdp_tool.mjs
import vm from 'node:vm'
import { bootBackground, makeModel } from './ext_harness.mjs'
import { policyRefusal, SCRIPT_COMMANDS } from '../lib/index.js'
import { classify, isWriteCommand } from '../src/errors.ts'

let fails = 0
const check = (name, ok, detail = '') => {
  if (!ok) fails++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const model = makeModel()
const tabId = model.addTab(1, 'https://cdp.test/')
const { ctx } = await bootBackground({ model, storage: { port: 9777, token: 'x', autoConnect: false } })
const runCommand = ctx.runCommand ?? vm.runInContext('runCommand', ctx)

const call = (params) => runCommand('cdp.call', params)
const rejection = async (promise) => {
  try { await promise; return '' } catch (error) { return String(error?.message ?? error) }
}

// ---- 1) 透传：方法名 / 参数 / tabId 原样到达，结果按 JSON 字符串回来 ----
{
  model.dbg.results['Page.captureSnapshot'] = { data: 'MHTML-BODY' }
  const result = await call({ method: 'Page.captureSnapshot', tabId, params: { format: 'mhtml' } })
  check('cdp.call：结果带 tabId / method', result.tabId === tabId && result.method === 'Page.captureSnapshot',
    JSON.stringify({ tabId: result.tabId, method: result.method }))
  check('cdp.call：CDP 结果被序列化成 json 字符串', result.json === JSON.stringify({ data: 'MHTML-BODY' }), result.json)
  check('cdp.call：bytes 是 JSON 的真实长度', result.bytes === JSON.stringify({ data: 'MHTML-BODY' }).length, `${result.bytes}`)
  check('cdp.call：没有超限时不标记截断', result.truncated === false)
  check('cdp.call：真的附着了 debugger', model.dbg.attached.has(tabId), [...model.dbg.attached].join(','))
  check('cdp.call：方法真的派发到了 CDP', model.dbg.log.some(entry => entry.method === 'Page.captureSnapshot'),
    model.dbg.log.slice(-3).map(entry => entry.method).join(','))
}

// ---- 2) 参数透传：函数形态的假 CDP 能看到我们传的 params ----
{
  model.dbg.results['Network.getAllCookies'] = (params) => ({ params })
  const result = await call({ method: 'Network.getAllCookies', tabId, params: { urls: ['https://a.test/'] } })
  check('cdp.call：params 原样透传（不吞字段）',
    result.json === JSON.stringify({ params: { urls: ['https://a.test/'] } }), result.json)
}

// ---- 3) 超大结果：截断 + 标记 + 真实大小 ----
{
  model.dbg.results['Page.captureSnapshot'] = { data: 'x'.repeat(50_000) }
  const result = await call({ method: 'Page.captureSnapshot', tabId })
  check('cdp.call：超大结果被标记 truncated', result.truncated === true)
  check('cdp.call：json 最多 20000 字符 + 截断标记', result.json.length <= 20_000 + 32, `len=${result.json.length}`)
  check('cdp.call：bytes 报的是截断前的真实长度', result.bytes > 20_000, `${result.bytes}`)
}

// ---- 4) 不可序列化的结果要变成可读报告，而不是让帧编码器炸掉 ----
{
  model.dbg.results['Runtime.getProperties'] = { big: 1n }
  const result = await call({ method: 'Runtime.getProperties', tabId })
  check('cdp.call：BigInt 等不可序列化值降级成报告', /unserializable/.test(result.json), result.json.slice(0, 80))
}

// ---- 5) 非法方法名 / 非法参数在扩展侧就被拒绝，且零 CDP 派发 ----
{
  const before = model.dbg.log.length
  const message = await rejection(call({ method: 'not a method', tabId }))
  check('cdp.call：非法方法名报错并给出格式示例',
    /CDP method/.test(message) && /Page\.captureSnapshot/.test(message), message.slice(0, 100))
  check('cdp.call：非法方法名零派发', model.dbg.log.length === before, `新增 ${model.dbg.log.length - before}`)
  const badParams = await rejection(call({ method: 'Page.captureSnapshot', tabId, params: ['not', 'an', 'object'] }))
  check('cdp.call：非对象 params 报错', /params must be a JSON object/.test(badParams), badParams.slice(0, 100))
  const nullParams = await rejection(call({ method: 'Page.captureSnapshot', tabId, params: null }))
  check('cdp.call：null params 报错', /params must be a JSON object/.test(nullParams), nullParams.slice(0, 100))
  model.dbg.results['Page.captureSnapshot'] = { ok: true }
  const omitted = await call({ method: 'Page.captureSnapshot', tabId })
  check('cdp.call：省略 params 时按 {} 发送', omitted.json === JSON.stringify({ ok: true }), omitted.json)
}

// ---- 6) 会话丢失：不自动重放（写操作重放可能做两遍），交给插件按写操作报 unknown ----
{
  model.dbg.failPlan = (method) => (method === 'Page.captureSnapshot'
    ? `Debugger is not attached to the tab with id: ${tabId}.`
    : null)
  const before = model.dbg.log.filter(entry => entry.method === 'Page.captureSnapshot').length
  const message = await rejection(call({ method: 'Page.captureSnapshot', tabId }))
  const after = model.dbg.log.filter(entry => entry.method === 'Page.captureSnapshot').length
  check('cdp.call：会话丢失时报错而不是静默成功', /not attached/i.test(message), message.slice(0, 90))
  check('cdp.call：会话丢失后只派发一次（不自动重放副作用）', after - before === 1, `新增 ${after - before}`)
  model.dbg.failPlan = null
}

// ---- 7) 策略闸门：只读档 / 脚本开关都要拦住它 ----
{
  const readOnly = policyRefusal('cdp.call', { readOnly: true, allowScript: true })
  check('cdp.call：只读档拒绝', typeof readOnly === 'string' && /只读模式已开启/.test(readOnly), String(readOnly).slice(0, 80))
  const noScript = policyRefusal('cdp.call', { readOnly: false, allowScript: false })
  check('cdp.call：allowScript:false 拒绝（否则 eval 的闸门可被旁路）',
    typeof noScript === 'string' && /allowScript: false/.test(noScript), String(noScript).slice(0, 80))
  check('cdp.call：两个闸门都放开时放行', policyRefusal('cdp.call', { readOnly: false, allowScript: true }) === undefined)
  check('cdp.call 在 SCRIPT_COMMANDS 里', SCRIPT_COMMANDS.has('cdp.call'))
  check('cdp.call 按写操作分类（超时/掉线后重试可能多做一次）', isWriteCommand('cdp.call') === true)
  // 旧扩展（< 1.0.20）不认识 cdp.call：扩展自己抛「unknown command」，发生在
  // handler 之前。写操作默认报 unknown「可能已经落到页面上」，这个分支恰好是假的。
  const oldExtension = classify('cdp.call', new Error('unknown command: cdp.call'))
  check('旧扩展不认识 cdp.call → command_failed / not_started（不是 unknown）',
    oldExtension.code === 'command_failed' && oldExtension.effectState === 'not_started',
    `${oldExtension.code}/${oldExtension.effectState}`)
}

ctx.disconnectNow?.()
setTimeout(() => process.exit(fails ? 1 : 0), 50)
console.log(fails === 0 ? '\nCDP 透传全部符合契约' : `\n${fails} 项失败`)
