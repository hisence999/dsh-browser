# 插件开发参考：把工具装进「当前会话」——会话级工具作用域的实现原理

> 这份文档写给之后写插件的人（包括未来的我）。它讲的是 **dsh 宿主的工具作用域机制**，以及
> `dsh-browser` 的懒启动装载器（`browser_tools`）是怎么利用它做到「一个会话装载，其它会话
> 看不见」的。文中的结论都是实测出来的（真机探针 + 裸 cordis 台子 + 宿主 asar 对照），
> 不是从类型注释推的；报错文案是逐字抄的，可以拿去 grep。
>
> 依赖版本：`@deepseek-ai/dsh-tools` 0.2.0-rc.2、`@deepseek-ai/cordis` 4.0.4、
> `@deepseek-ai/dsh-scope` 同仓版本。宿主 asar 里的 cordis 与 `node_modules` 是同一份实现
> （asar 里能逐字找到 `if (ctx[symbols.shadow] && !tracker.noShadow) ctx = Object.getPrototypeOf(ctx);`），
> 所以下面的台子结论对真机同样成立。

---

## 0. 一句话结论

`ctx.tools.register(definition)` **落在哪一层，只由「调用时那个 `ctx` 身上的 `dsh.scope` 标签」决定**，
与「你从哪个 ctx 把 `tools` 服务取出来」无关。所以：

```ts
// 全局层：一个注册，所有会话都能看见，且装上去就卸不掉（除插件 fiber 销毁）
ctx.tools.register(definition)

// 会话层：只对这个 agent 生效，agent 结束自动消失
exec.agent.ctx.tools.register(definition)   // exec 是 execute(args, exec) 的第二个参数
```

这条差别就是「全局棘轮」与「按会话装载」的全部分界线。

---

## 1. 名词与层次

| 名词 | 含义 | 怎么拿到 |
|---|---|---|
| `Context` | cordis 的上下文对象，本质是代理（proxy）。`extend()` / `isolate()` / `intercept()` 会生成带标记的子上下文 | `ctx`、`agent.ctx` |
| scope | 一个作用域键，存在 `ctx[Symbol('dsh.scope')]` 上（内部叫 `kScope`） | `scopeOf(ctx)`（`dsh-scope/lib/index.js`） |
| layer | 一张「名字 → 定义」表。工具服务一共有一张**全局表** + 每个 scope 一张**会话表** | `tools.layers` |
| agent | 一次会话的运行时对象。类名形如 `ReactLoopAgent`，`agent.id` 就是 `session-<uuid>` | `exec.agent` |
| 视图 | 带 scope 参数读取时看到的是「全局表 + 该 scope 链上的表」合并结果 | `tools.get(name, scope)`、`tools.schemas(scope)` |

工具服务本身的实现只有一份（宿主 asar 里没有任何 `provide('tools')` / `provide("tools"`），
但它内部按 scope 分层：

- `register()` → `this.layers.effect(this.ctx, (layer) => layer.tools.insert(name, def), { label: 'tools.register()' })`；
- `ScopedLayers.effect()` 第一件事是 `const scope = scopeOf(ctx)`：`undefined` 就写进全局层，否则按 scope 取（没有就建）那张会话表；
- 读取走 `merge(scope, pick)` = 全局表 + `chainLayers(scope)`（沿 scope 父链），所以会话视图 = 全局 ∪ 本会话，全局视图 = 只有全局。

**推论（最容易踩的一条）**：`ctx.get('tools')` 可以绕过注入闸把服务取出来，但你在外面
`service.register(...)` 时，`this.ctx` 还是**你自己那个 ctx**，所以照样落全局层。实测：

| 姿势 | 落层 | 说明 |
|---|---|---|
| `ctx.tools.register(def)`（插件自己的 ctx） | 全局 | 对照组 |
| `scopeA.ctx.get('tools').register(def)`（在外面调） | **全局** | 取服务的位置不算数 |
| `scopeA.ctx.inject(['tools'], s => s.tools.register(def))` | 会话 A | `scopeOf(s)` 确实是 A |
| 在 A 的 scope 里 `plugin({ inject: ['tools'], apply(c) { c.tools.register(def) } })` | 会话 A | fiber 自己声明注入也认得 scope |
| `scopeTarget(service, key)` 返回的载体 | — | 那是**只路由事件**的载体，上面没有 `register`（`carrier.register is not a function`） |

判定的唯一可靠办法是**读回**：注册完立刻用全局视角 `ctx.tools.get(name)` 查一次——

- 查得到：它进了全局表（重名时会直接报 `tool "<name>" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`，这句报错本身就是"你在全局层"的铁证）；
- 查不到、但 `ctx.tools.get(name, agent)` 查得到：真进了会话层。

---

## 2. agent 从哪里来：`exec.agent`

工具处理函数的签名是 `execute(args, exec)`，`exec: ToolExecutionInput`，其中 `agent?: Agent`
（`dsh-tools/lib/types/index.d.ts`，注释原文 "set by the agent loop"）。真机读回：

```
exec_agent            = ReactLoopAgent#session-2a87bea5-224c-4551-a699-9083429c60e8
agent_id              = string:session-2a87bea5-224c-4551-a699-9083429c60e8
agent.ctx 的 dsh.scope = ReactLoopAgent#session-2a87bea5-…（depth 0，就是 agent 自己）
agent.ctx 自有 symbol  = ["dsh.scope"]；插件 ctx 自有 symbol = ["cordis.intercept"]（没有 scope 标签）
```

也就是说：**`agent.ctx` 天然带着「我自己这个 scope」的标签**，所以通过它注册就会被
`scopeOf()` 认出来。这是整件事能成立的根。

两条实测性质（都别猜）：

1. **同一个会话跨轮次是同一个 agent 对象**（探针两次调用回答 `"same object"`）。所以可以用
   `WeakMap<agent, …>` 记账，不会每轮换键；
2. **`agent` 不是必有**：复合派发、`run_code`/code-mode 里的嵌套调用，`exec.agent` 可能是
   `undefined`。这种调用没有任何会话作用域可用，只能退回全局层——**但要如实报出来**，不能
   假装还是会话级。

---

## 3. 装配时机：装载出来的工具什么时候才算「能调」

宿主的事件契约（`dsh-tools/lib/types/index.d.ts`）原文：

> `tools/change`：A tool was registered or unregistered, or a scoped restriction changed
> (the available tool set changed — possibly for one scope only) … a global change concerns
> every agent's **next assembly**.

即：工具块是**每次请求重新装配**的。实测确认：装载调用返回后的**下一步**，`browser_info`
就真的能调了（不是"下一步之后"，也不是要等新会话）。反过来也意味着：当前这一步之内装载
的工具，当前这一步的模型上下文里没有它。

---

## 4. 我们怎么落地（`src/index.ts` 的 `applyBrowserTools`）

极简骨架：

```ts
type ToolDefinition = Parameters<typeof ctx.tools.register>[0]
const known = new Map<string, ToolDefinition>()          // 全量定义（含未暴露）
const loadedByAgent = new WeakMap<object, Set<string>>()  // 会话 → 已装载的名字
const loadedGlobally = new Set<string>()                  // 拿不到 agent 时的兜底账本
const ownedDisposers = new Set<() => void>()              // 我们注册出去、需要自己收回的

ctx.effect(() => () => {                                  // 插件卸载时收干净
  for (const dispose of ownedDisposers) dispose()
  ownedDisposers.clear()
})

interface Exposure { agent?: object; loaded: Set<string> }

const scopedToolsOf = (agent?: object) => {
  if (agent === undefined) return undefined
  try { return (agent as { ctx?: { tools?: typeof ctx.tools } }).ctx?.tools ?? undefined }
  catch { return undefined }        // ctx 上的属性读取要过注入闸，读不到就当没有 scope
}

const exposureOf = (exec: unknown): Exposure => {
  const agent = (exec as { agent?: unknown })?.agent
  if (agent === undefined || agent === null || typeof agent !== 'object') return { loaded: loadedGlobally }
  const existing = loadedByAgent.get(agent)
  if (existing !== undefined) return { agent, loaded: existing }
  const fresh = new Set<string>()
  loadedByAgent.set(agent, fresh)
  return { agent, loaded: fresh }
}

const expose = (name: string, exposure: Exposure): boolean => {
  if (exposure.loaded.has(name)) return false             // 幂等：不注册第二遍
  const definition = known.get(name)
  if (definition === undefined) return false
  const target = scopedToolsOf(exposure.agent) ?? ctx.tools
  const dispose = target.register(definition)             // ← 分界线就在这一行
  if (typeof dispose === 'function') ownedDisposers.add(dispose)
  exposure.loaded.add(name)
  return true
}
```

四条硬约束，少一条就会坏：

1. **幂等**：同一落点重复装载只返回 `false`，不注册第二遍——同名重复注册在**同一层**内
   是硬错误；
2. **disposer 必须自己收**：宿主文档原文是「A registration on another context, such as
   `agent.ctx`, has two owners: keep its disposer in your plugin's own effect too, so either
   teardown removes it.」——注册在别人的 ctx 上，插件重载/卸载时不会自动掉，所以要把
   disposer 收进自己的 `ctx.effect`；
3. **失败不许吞**：单件注册被拒（重名、被闸门拒）要进返回值里的 `errors` 并点名，不算作
   已装载，也不阻塞同批其余项；
4. **落点要读回**：返回值里的 `scope` 不写"意图"，写"读回结果"（见下节）。

### `scope` 的读回判定

```ts
const inGlobalView = (name: string): boolean | undefined => {
  try { return ctx.tools.get(name) !== undefined } catch { return undefined }
}

const scopeOfExposure = (exposure: Exposure): 'session' | 'global' | 'unknown' => {
  const sample = [...exposure.loaded][0]
  if (sample === undefined) return exposure.agent === undefined ? 'global' : 'session'
  const seen = inGlobalView(sample)
  if (seen === undefined) return 'unknown'
  return seen ? 'global' : 'session'
}
```

判定逻辑只有一句：**能从全局视角查到，就说明它没进会话层**。`unknown` 是"服务拒绝让我
读"（读不出来 ≠ 不存在）。模型看到 `global` 会在 render 里收到一句提示，看到 `unknown`
会收到另一句；`session` 不额外提示（正常路径不啰嗦）。

---

## 5. 退化路径（没有会话作用域时）

| 场景 | `exec.agent` | 落层 | 我们报什么 |
|---|---|---|---|
| 正常工具调用 | `agent` | 会话层 | `scope: "session"` |
| 复合派发 / 嵌套子派发 / code-mode 内调用 | `undefined` | 全局层 | `scope: "global"` + render 提示 |
| `agent` 存在但 `agent.ctx.tools` 读不出来（注入闸） | 有 | 全局层 | `scope: "global"`（读回判定自然落到这一支） |
| `tools.get` 本身抛错 | 有 | 未知 | `scope: "unknown"` + render 提示 |

设计取向：**宁可报成全局层，也不假装会话级**。会话级是"更好"，但谎报会让使用者（模型/人）
对隔离做出错误推断，代价更大。

---

## 6. 坑清单（都是踩过的）

1. **`ctx.get('tools')` 不能当作用域入口**。它能绕过注入闸取到服务，但注册落层仍看调用时
   的 ctx。
2. **`agent.ctx` 上任何属性读取都要包 try**。没声明注入时是**直接抛**
   `Error: cannot get property "id" without inject`——不是返回 `undefined`。我第一版探针
   就崩在这一行，看起来像"这个能力不存在"。
3. **`agent` 不判类型会让 `WeakMap` 炸**：`loadedByAgent.set('nope', …)` 抛
   `Invalid value used as weak map key`。守卫要写 `typeof agent !== 'object'`。
4. **`scopeTarget()` 不是注册路径**：它返回的载体只有事件路由，没有 `register`。
5. **`restrict()` / `presentAs()` 需要 scoped ctx**，否则报
   `tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead`
   （`presentAs()` 同款文案）。想"对某个会话收紧工具集"就用 `agent.ctx`。
6. **`service.ctx` 读属性认 scope，方法调用不认**：在 `inject` 回调里 `scopeOf(s.tools.ctx)`
   确实是 agent，但 `s.tools.restrict(...)` 里看到的 `this.ctx` 是无 scope 的那个——所以
   `layers.effect(this.ctx, …)` 会选全局层。别用"读 ctx 属性"来推断"注册会落在哪"。
7. **同名两层可以共存**：全局层放一个 `browser_read`、会话层再放一个同名定义，是允许的
   （会话层会遮蔽全局层）；同层重名才是错。
8. **注册是"活到 scope 结束"**，不是"活到这次请求"。会话结束宿主回收 agent scope，注册随之
   消失；`WeakMap` 键也跟着被回收，不会攒住死会话。

---

## 7. 怎么验证（照抄这套就行）

### 7.1 假件验台（快、能进 CI）

最小假 ctx 只需要这几个面：

```js
const ctx = {
  logger: { info(){}, warn(){}, error(){}, debug(){} },
  fiber: { state: 2, uid: 1 },
  effect: (fn) => { disposers.push(fn); return () => {} },   // 存本体，卸载时跑
  inject: (deps, cb) => { /* 只回调需要的服务 */ },
  tools: { register: (def) => { map.set(def.name, def); return () => map.delete(def.name) },
           get: (name) => map.get(name) },                    // 必须有 get：scope 读回靠它
  systemPrompt: { section: (s) => sections.push(s) },
}
```

假 agent 就是「自己的 tools 服务 + 一个 `ctx` 包着它」：

```js
const fakeAgent = (id) => {
  const scoped = new Map()
  return { id, tools: scoped, ctx: { tools: {
    register: (def) => { scoped.set(def.name, def); return () => scoped.delete(def.name) },
    get: (name) => scoped.get(name),
  } } }
}
```

要钉住的断言（`verify/verify_tool_docs.mjs` §11，共 19 条）：

- A 装载后注册落进 A 自己的作用域，**全局服务面上看不到**（隔离）；
- B 的目录里仍列着那件工具（只是 B 没装），B 装载同一件**不冲突**（全局层会因重名直接炸）；
- A 重复装载报 `already`（记账按会话），B 的装载不污染 A；
- 没有 agent → 全局层，且 `scope` 读回 `global`；
- `exec.agent` 是字符串 → 按没有会话处理，不抛；
- 注册抛错 → 进 `errors` 并点名，不算作已装载，render 要念出来；
- 跑一遍 `ctx.effect` 的本体 → 会话级注册被摘除（证明 disposer 确实收在自己手里）。

### 7.2 变异验证（证明断言真的会红）

`backups/20261029-session-scope/mutate.mjs` 会逐个改坏实现、重跑验台、再还原源码。7 个
变异体全部被杀死（括号里是红掉的条数）：

| 变异 | 说明 | 红 |
|---|---|---|
| 落点忽略会话 | `target = ctx.tools`（永远全局） | 7 |
| 账本退回全局 | 所有 agent 共用一张 `Set` | 7 |
| disposer 不回收 | 不把 dispose 收进来 | 1 |
| scope 读回说谎 | 永远返回 `'session'` | 2 |
| 失败当成装上了 | `errors.push` 改成 `activated.push` | 3 |
| 描述不提会话 | 删掉那半句 | 1 |
| agent 不判类型 | 删掉 `typeof` 守卫 | 崩 |

**注意**：变异驱动不能只数 `FAIL` 行——最后一条是抛异常终止验台（0 条 FAIL、退出码非 0），
只数 FAIL 会把它误判成"存活"。判死条件应是「有 FAIL 行 **或** 退出码非 0 且没有 FAIL 行」。

### 7.3 真机探针（只在必须确认真实运行时行为时用）

真机结论没法从类型定义推出来，做法是临时往 `src/index.ts` 里插一个工具：

1. 用 `mount(defineTool({ name: 'browser_scope_probe', output: { schema: { type: 'object', additionalProperties: true } , … } }))` 插进去（`mount` 会在全开模式暴露它；懒启动模式要先装载）；
2. 处理函数里对每条路径做「注册 → `ctx.tools.get(name)` → `ctx.tools.get(name, agent)` → `schemas()` / `schemas(agent)` → dispose」，**所有读取都包 try**，把结果拼成 JSON 返回；
3. `pnpm run build`，然后让用户到「插件」页把插件关掉再打开一次（插件目录是符号链接指向仓库，重建 `lib/` 即生效，但 `apply()` 必须重跑）；
4. 调用探针、读完结果，**把探针连同定义一起删掉**（`backups/20261029-lazy-tools/unsplice-probe.mjs` 就是干这个的）。

这轮真机读回（留档）：四条注册路径 `register: ok` / `global_view: undefined` /
`agent_view: Object` / `in_agent_schema: true` / `in_global_schema: false`；
`schema_counts = { global: 30, agent: 71 }`（agent 视角多出来的是宿主 preset 铺在 agent
平面上的工具）；对照组插件 ctx 落全局层。

---

## 8. 成本与边界

- **每会话各装一次**：装载是会话级，所以新会话不会继承别人的装载，模型得自己再装一次
  （一个来回）。换来的是"一个会话的装载不再污染其它活跃会话的前缀缓存"。
- **前缀缓存**：工具块是系统前缀的一部分，每次装载都会让该会话的前缀变一次；一次装齐
  （`"*"` 或按分组）比逐个装省得多。
- **不能跨会话共享装载**：想"全进程只装一次"的那种省法只有全局层能给，也就是本机制的反面。
- **未验证**：code-mode / PTC 生成的那段 SDK 描述是否随 `tools/change` 重算，没测。真要在
  那条路径上依赖装载，先补测。
- **同款机制在命令上也有**：`command "<name>" is already registered (for a per-agent variant,
  mount a command-injected plugin under that agent's \`agent.ctx\`)`——分层是宿主通用设计，
  不只是工具。

---

## 9. 相关文件

| 路径 | 作用 |
|---|---|
| `src/index.ts`（`applyBrowserTools`） | 装载器与账本的全部实现 |
| `src/tool-help.ts`（`TOOL_GROUPS`） | 分组表，装载器描述与目录都由它现算，不存在第二张手写表 |
| `verify/verify_tool_docs.mjs` | 81 条断言，含 §11 会话级装载 |
| `backups/20261029-lazy-tools/probe-scoped*.mjs` | 裸 cordis 台子上的 8 个探针（结论的原始出处） |
| `backups/20261029-lazy-tools/probe-block.ts` / `splice-probe.mjs` / `unsplice-probe.mjs` | 真机探针的插入与摘除 |
| `backups/20261029-session-scope/mutate.mjs` | 7 个变异体的驱动 |
| `docs/BEHAVIOR.md`「工具懒启动」 | 面向使用者的行为说明（表格） |
