# 行为契约（Behavior Contract）

Agent 和上层脚本可以依赖的确定性语义。违反这些契约视为 bug。

## 窗口几何不可侵犯

- 自动化**绝不**修改窗口尺寸、位置或状态（最大化/还原/最小化一律不动）。真实输入所需的窗口聚焦与标签页激活不改变任何几何属性——而且从 1.1.2 起默认**连聚焦也不做**，见下一节。
- 浏览器窗口处于**最小化**状态时，视口为 0×0，真实键鼠事件无法送达。此时 `type` 模式 / `press` / `click` 返回结构化错误 `window_minimized`，提示用户手动还原窗口——绝不自动还原（自动还原会把最大化窗口压成小窗）。
- `fill` 模式、`eval`、`content`、`wait` 不需要窗口前台，最小化下照常工作。

## 不抢焦点（`focusPolicy`）

- 默认 `focusPolicy: 'avoid'`：**绝不**调用 `windows.update({focused: true})`。抬窗口是把浏览器拍到用户脸上，也是「AI 抢桌面」这类冲突里最刺眼的一种。CDP 的 `Input.*` 事件派发在渲染进程上，跟 OS 焦点无关（Puppeteer 对后台标签页点击从不 `bringToFront`），所以不抬窗口一样点得动、打得进。
- `avoid` 下仍然会切标签页，但**只在目标标签页本来就在用户正看着的那个窗口里**时切：那等于用户自己点了一下标签栏，是他眼前发生的、可预期的事。跨窗口则什么都不动。
- 这件事必须对模型可见：`browser_click` / `browser_type`（`type` 模式）/ `browser_press` 的结果带 `focus: {policy, windowFocused, tabActivated}`；`fill` 模式带 `skipped: "fill-mode"`（直接写值，不需要焦点）。藏起来的话，「这次动没动用户的窗口」只能靠用户凭感觉发现，而模型的自我描述会一直是错的。
- `focusPolicy: 'auto'` 恢复 1.1.1 及以前的行为：先 `windows.update({focused: true})`，再 `tabs.update({active: true})`。
- **自适应升级**只发生在一处：`type` 模式下 `avoid` 没激活标签页、而逐字符按键**一个都没落地**（读回是空串）。这时允许抬窗口重打一遍，结果带 `focusedFallback: true`。没有读回就没有证伪信号，所以别的命令不猜（`click` 的 `hitVerified` 说的是「有没有被别的元素挡住」，不是焦点）。
- 两种策略在最小化窗口上都报同一个结构化错误 `window_minimized`（在 `activateTabWindow` 里统一判，不是两套代码）。
- 实测台：`verify/verify_focus_policy.mjs` —— 断言的是「**零次** `windows.update({focused:true})`」这种可证伪的事实，不是「看起来没动」。假 `chrome.windows` 是 1.1.2 才补上的：以前 `chrome.windows.get` 走打桩 Proxy 回 `{result:{value:null}}`，`win.id` 是 undefined，`windows.update(undefined, …)` 静默成功——「AI 有没有抬窗口」这件事从测试里整个漏掉了。

## 自动等待

- `browser_navigate` / `tabs.open` 等待新文档落地（上限 15s，`timeoutMs` 可调）后才返回；15s 内没等到时结果带 `loadPending: true` 与 `pendingUrl`，`browser_navigate` 的文案会说「仍在加载」而不是「已显示」，模型不该把没落地的导航当成功。
- **不保证** SPA 路由或懒渲染内容就绪——导航返回后再用 `browser_wait` 显式等目标元素。
- 「压根没发生」的导航也不算到位：如果整个等待期间从没观察到 `loading`，宽限期后会拿标签**真正落到的 URL** 与请求的目标比对（忽略 hash 片段与末尾斜杠），不等就报 `loadPending`。所以「点了变成下载」「目标被 Chrome 拒载」不会 0ms 伪装成成功；而**导航到已经开着的那个地址**仍然算成功（不误报）。实测台：`verify/verify_nav_landing.mjs`。

## 原生弹窗（alert / confirm / prompt）

- v1.0.2+ 默认策略 `accept`：弹窗打开即自动按 OK，prompt 以 `defaultPrompt` 作为输入。
- 每次点击/输入结果带 `dialogsAnswered`（近 5 秒内该标签页被应答的弹窗数），可据此断言弹窗出现过。
- 全局策略可通过 `dialog` 命令改为 `dismiss` 或 `manual`；`manual` 下弹窗会阻塞页面线程直到工具超时。
- 近 10 条弹窗记录（类型、文本、应答方式）通过 `dialog {action:'get'}` 读取。

## 输入模式

- `browser_type` 默认 `fill`：直接设值 + input/change 事件。快，但绕过按键级逻辑。
- `mode: "type"`：逐字符真实键盘事件（**keyDown 带 `text` + keyUp，不发独立 `char`**）。用于 React 受控组件、带联想状态的搜索框、反爬表单。速度约每字符一次 CDP 往返，长文本慎用。
- **一次按键只许插入一次。** CDP 里 `keyDown` 带 `text` 时 Chrome 就已经插字符了；再补一个 `char` 事件会变成 `xx`，而 `Enter` 会把表单**提交两次**。`cmdInput` 早就按这条写了注释，`cmdPress` 却漏了同一个 `char` 分支，从 v0.2.0 一路留到 v1.0.15（issue #14，wangyuncai2024 报的，附了三组裸 CDP 对照）。现在两处一致，并由 `verify/verify_press_events.mjs` 按**派发次数**钉住：单字符 press、`Enter`、数字键、`type` 模式逐字符，插入型事件必须恰好一个；对修复前的 `background.js` 跑同一批断言会红 12 项。
- `browser_press` 现在支持组合键：`key: "Ctrl+A"` / `"Shift+ArrowRight"`，或等价的 `modifiers: ["ctrl"]`。`shift` 单独存在时照常打字，`ctrl`/`meta`/`alt` 抑制插入。
- **认不出来的键名一律抛错**，不再带着 `undefined` 的 keyCode/code 静默派发（以前 `browser_press {key:"Shift+ArrowRight"}` 在修复前既不报错也不选中文本）。合法清单在报错里给出；组合串里的未知修饰键同样报错。
- 合成赋值对百度/B站搜索框无效是已知案例（DOM 值正确但组件状态未同步）——这类站点用 `type` 模式。

## evaluate

- 返回值经 CDP `returnByValue` 序列化；不可序列化对象（DOM 节点、函数、代理）返回 `[type: not serializable — …]` 占位串而非空 `{}`。
- 页面在 Promise 挂起期间跳转 → 结构化错误 `context_destroyed: page navigated while evaluate was pending`，不会耗尽整个超时预算。
- `frameSelector` 参数支持同源 iframe（contentDocument 穿透）；跨源帧明确报错，不做静默降级。

## 截图与坐标

- 视口截图坐标为 CSS 像素；元素截图用 CDP `clip`，DPR 由 Chrome 内部处理，无需外部换算。
- 点击结果包含实际命中点 `clicked.x/y` 与 `hitVerified`（命中元素是否等于目标元素）。`hitVerified: false` 时附 `hitInstead` 字段指明实际命中的元素——典型场景是 sticky 头部/广告遮挡。

## 超时

- 所有涉及页面交互的命令接受 `timeoutMs`（毫秒）：navigate/tabs.open 默认 15000，wait 默认 15000 上限 120000，evaluate 默认 60000（桥接层上限 300000）。

## 后台标签页节流

Chrome 对非前台标签页的 `setTimeout` 强制钳制到 ≥1s。长任务注入在后台标签会显著变慢甚至超时——需要精确计时的注入先 `browser_tabs activate` 切到前台。

## 死站点检测

导航落到 `chrome-error://` 时，`browser_navigate` 结果携带 `siteUnreachable: {reason}`（dns/unreachable），且 `url` 回报为请求的目标 URL 而非内部协议地址。

## 快照的两种模式

- 默认 `mode:"dom"`：按固定选择器列表（`a[href]` / `button` / `input` / `[role=…]` / `[contenteditable]` / `[onclick]`）扫可交互元素。
- `mode:"ax"`：用 Chrome 的 `Accessibility.getFullAXTree`。`role` 和 `name` 是**浏览器自己算出来的可访问名**（aria-label、`<label>`、`alt`、可见文本的合成结果），比让 agent 猜 CSS 选择器抗改版。
- **两种模式的 ref 契约完全一样**：都往真实 DOM 元素上写 `data-dsh-ref`，所以 `browser_click` / `browser_type` 传 ref 的写法不变。
- 只收「可操作角色」白名单（button / link / textbox / searchbox / combobox / listbox / menuitem* / option / radio / checkbox / switch / slider / spinbutton / tab / treeitem / gridcell / columnheader / rowheader）。噪音角色 `GenericContainer` / `StaticText` / `InlineTextBox` 一律滤掉——否则文字多的页面会把 `limit` 全吃在文本节点上。
- 隐形元素（`getBoundingClientRect()` 宽高都是 0）**不占 ref 号也不写属性**；AX 树报了 `backendDOMNodeId` 但 DOM 里已经没有该节点时计入 `ax.unresolved` 并跳过。两种情况都在 `ax` 计数里分开回报。
- AX 快照**先清掉上一轮的 `data-dsh-ref` 再取树**：旧 ref 绝不能指向现在屏幕上的另一个元素。
- AX 域拿不到（老 Chrome、无障碍未就绪、页面拒绝）时自动降级回 DOM 模式，结果带 `mode:"dom"` 与 `axFallback:"<原因>"`，**不让整条命令失败**；agent 据此知道这次的名字来自 DOM 而不是 AX。
- **扩展比插件旧（扩展 < 1.0.11 根本没有 AX）也要说出来。** 本机真实实测：扩展 1.0.10 收到 `mode:"ax"` 时既不报错也不带 `mode`/`axFallback`，原样回一份 DOM 结果（两次请求的响应完全一样）。以前模型只看到 `(mode dom)`，读不出「我要的 ax 被旧扩展静默降级了」，会把标签名当成可访问名。现在插件自己比对**请求的模式 vs 回报的模式**（`mode==='ax'` 或带 `ax` 计数才算真走了 AX），不一致就补一句 `axFallback`，写明「下面的名字是标签名，不是可访问名；AX 需要扩展 v1.0.11+」。改在插件侧，**老扩展不用升级也能立刻受益**。
- 代价：AX 模式每条保留元素多两次 CDP 往返（`DOM.resolveNode` + `Runtime.callFunctionOn`），本地链路可接受，`limit`（默认 120，上限 200）是硬闸。

## agent 标签页归组与归属（第 4 项）

- `browser_tabs open` 新建的标签会自动收进**当前窗口**的一个标签组（每窗口一组），给人一眼分辨机器开的和自己开的。组名是 **AI 新建组时用的名字**，来自配置 `tabGroupTitle`（默认 `DSH`），**空串 = 不分组**；`browser_tabs` 的 `groupTitle` 参数按次覆盖它（只对 `open` / `group` 有意义，空串 = 这一次不分组）。归一是「压平空白 + 限长 40 字符」，插件侧（`groupTitleOf()`）与设置页那条 `/browser-control/api`（`TAB_GROUP_TITLE_MAX`）用的是同一个上限；颜色固定 `blue`，不跟组名走。
- **组的身份 = Chrome 的 `groupId`，不是标题。** 扩展把「我们建过（或加入过）的组」按 `{groupId: {title, windowId, at}}` 记在 `chrome.storage.session`，归属只认这张表；已经死掉的 id（用户拆了组、关掉最后一页）在查表时剪掉。同一个窗口里、同一个名字 → 复用我们自己的那个组；不同名字 → 各一个组；**跨窗口不复用**（每个窗口一组）。**同名不合并**：用户已经有一个叫「工作」的组时，AI 用这个名字开标签页会另建一个同名组，**不塞进他那个**。
- **归属（`owned`）**：`tabs.open` 开的标签页同时记进 `chrome.storage.session` 的归属表；**用户把标签页拖进 AI 自己那个组也算认领**——分组是看得见的手势，用户拖进去就是在说「这一个给你用」，而拖进去的正是按 id 记着的那个组。所以不需要再发明一个 `tabs.claim` 命令：`tabs.group` 就是认领，`tabs.ungroup` 就是放手，两个命令早就在，也早就被只读档与错误契约登记过。
- **为什么按 id 而不按标题（v1.1.4 独立审查的结论）**：第一版按标题认（等于 `'DSH'` 或等于当前 `tabGroupTitle` 都算 AI 的），而 `tabGroupTitle` 很容易被用户设成他自己也在用的名字——「工作」「调研」「临时」都很自然。按标题认的话，**他那**个组里的标签页会突然 `owned:true`：`tabs.close` 不必 `force` 就能关（页面找不回来），`tabs.ungroup` 还会拆掉他自己整理的分组，两件事都不可逆，而规避方式只剩「用户猜到这个巧合、别用同名」。改成按 id 记之后同名不串；代价是「改名」的含义变成**之后新建的组用新名字**，已经建好的老组仍然是 AI 的。
- 归属表放 `chrome.storage.session` 而不是内存：service worker 30 秒就会被回收，内存里的归属一没，AI 自己开的标签页立刻「变成用户的」，`tabs.close` 会开始拒绝关它自己的标签页。也不放 `local`：浏览器一关就该忘掉（那是上一轮的事）。
- **默认目标（`agentTargetTabId`）**：认领过一个标签页之后，**不带 `tabId` 的命令钉在它上面**，不再跟着用户切页面跑——这是「AI 控制不与用户冲突」的实现方式：AI 不再被动跟随用户的视线，用户点开别的页面也不会把 AI 的工作流程带偏。全新会话（还没认领过任何标签页）行为与历史版本完全一致：跟着用户正在看的那一页。`tabs.list` 每行带 `owned` / `yielded`，顶层带 `agentTargetTabId`。
- `tabWindow`（默认 `current`）决定新标签页开在哪儿：`current` = 用户当前窗口（Chrome `tabs.create` 不传 `windowId` 的原生语义）；`new` = `windows.create({focused: false})` 新开一个自己的窗口，**新窗口不许抢焦点**，新窗口里的标签页照样归组。
- 归组结论只是附在结果里（`grouped` / `groupId` / `created` / `reason`），**归组失败绝不会让「打开标签页」失败**；`group: false` 可显式跳过，`browser_tabs group` 能把早就存在的散标签拉进来。
- 刚 `tabs.create` 就 `tabs.group` 会跟 Chrome 自己的标签簿记打架，所以最多打 4 枪（1 次 + 退避 50/150/400ms 三次），有上限、不无限重试。
- 「我们的组」那张表（`groupId → {title, windowId, at}`）放在 `chrome.storage.session`：service worker 回收之后仍然记得哪些组是自己的，否则回收一次就会「把 AI 认领过的组当成用户的组」，`tabs.ungroup` 开始拆不动、`close` 开始要 `force`。**不再需要按标题反查重建**——标题只是表里的一条描述信息，判据是 id；表里失效的 id 在每次查表时剪掉，**绝不往已经失效的 groupId 上塞标签**（真 Chrome 对这种情况直接报错）。
- `browser_tabs ungroup`（可选 `windowId`）只拆**我们自己的**组（只解除归属，不关任何标签页）：用户自己的同名组一个都不动，无关的组当然也不动。解除之后那几个标签页不再是 AI 的（`close` 从此需要 `force`）。单次用 `groupTitle` 建的组同样拆得掉——认的是 id，不是当前配置名。
- 拿不到 `tabGroups` 权限（Chrome < 89）时整条路径降级为 `{grouped:false, reason}`，归属仍由 session 里的表兜住（自己开的还是自己的），其它功能不受影响；manifest 里漏声明该权限也会静默走这条降级，所以 `verify/verify_tab_groups.mjs` 直接断言 manifest 内容。
- 归组不算「写操作」：重复归组是空操作，错误契约（`src/errors.ts`）把它当重试安全，超时/掉线时报 `not_started` 而不是 `unknown`。
- 实测台：`verify/verify_ownership.mjs`（归属/默认目标/认领手势/close 守卫）、`verify_group_title.mjs`（组名可配 + 按 groupId 认组：同名用户组不合并不算、单次命名的组建了也拆得掉、归一与 40 字上限、归组失败不连坐）。

## 用户接管即让出（`userTakeover`）

- **算「接管」的是用户真的在那一页上动手，不是他切过去看了一眼**（v1.1.5 收窄）。信号来自注入页面的自包含探针，只认 `isTrusted` 的 `pointerdown`（鼠标/笔）、`click`（触屏）、`keydown`、`input`、`paste`：切换标签页、切窗口、打开扩展弹窗**都不再算**，**滚动也不算**——滚轮压根没注册；键盘翻页键在焦点不在可编辑元素时忽略（在输入框里按空格/方向键是编辑，照算）；落在滚动条上的 `pointerdown` 是拖动滚动条；触屏改用 `click`，所以滑动不算、点击才算。
- 一旦算成接管，AI 在那一个标签页上的写操作开始被拒（`click` / `input` / `press` / `nav` / `scroll` / `tabs.close*`），错误文本以 `browser-yielded-to-user:` 开头，宿主归成 `yielded_to_user` + `effectState=not_started`（命令一条都没发出），并且**零 CDP**——不是「发了但没效果」。
- 通道是 `Runtime.addBinding` + 一段自包含的页面侧探针（`toString()` 后整段注入，不引用扩展作用域），**没有新增权限、没有 content script**。只认 `isTrusted` 是为了**模型自己**：`browser_evaluate` 里 `.click()` 之类的合成事件不算接管，否则模型写的脚本能把它自己锁死。
- 我们自己 `Input.dispatch*` 派发的事件在页面里**也是** `isTrusted`，探针分不出它们和真人操作，所以扩展在每次派发后开一段 **400ms 抑制窗**（`SELF_INPUT_MS`），窗内收到的输入报告一律当自己的回声丢掉——否则 AI 每点一下就把自己锁死一次。窗不能更长：真机上「派发 → 页面监听 → binding 回到扩展」是几十毫秒，窗口比需要的宽就等于**漏掉**用户在点击之后立刻动手（漏报 = AI 继续动他眼前的页）。
- 四条解除路径，缺一不可（少一条就等于「点一下就把 AI 永久锁死」）：① 用户在**别的**标签页上动手（他走了，让出全清）；② 用户切到**他自己**那个标签页（`tabs.onActivated` 只剩这条清场职责，不再拿它判定接管）；③ 所有窗口都失焦（他去了别的应用）；④ 用户确认后模型调 `browser_tabs action=activate` 把这个标签页要回来（显式解除）。另外 AI 永远可以**自己在新的标签页里继续**（`browser_tabs action=open`），不需要任何人授权。
- 探针的生命周期：**只装在 AI 自己的标签页上**（认领时），不往用户的页面上挂 binding——那既是多余的指纹，也意味着为了「监听」去附着他的页面，而附着的副作用是他那页的弹窗会被自动应答；**导航完成时重装**（监听是文档级的，会跟着旧文档一起没）；附着断掉时清掉记录，下次认领再装。
- 为什么连关闭也算：关掉用户正看着的那一页**不可恢复**（页面状态、填了一半的表单全没了），比「多点了一下」严重得多，所以按最保守处理。唯一例外是 `force: true`——那一位本来就是「用户明确让我关这个标签页」，是他能给的最高授权；闭着眼拒它反而变成拿安全当借口不听人话。
- 为什么让出而不是抢回来：用户在那一页上动手，说明两边马上要抢同一个页面；AI 在同一个页面上继续点击、打字，两边会互相破坏（`browser_type` 会先把输入框清空）。拒绝一条命令 + 说清怎么继续，比第二条命令清掉用户正在填的框好得多。
- **它不是安全边界**：让出是「别跟用户抢同一页」的协作礼仪 + 防互相破坏，拦的是模型那条工具面（HTTP 面照旧按 token 走）。用户看得见、按得下的停止手段仍然是扩展弹窗里的本地硬锁。
- 让出状态同样放 `chrome.storage.session`，按 `tabId` 记（`reason: 'user_input'`）；`userTakeover: 'ignore'` 可整条关掉。
- 实测台：`verify/verify_yield.mjs`。

## 隔离实例（无痕罐，`browser_profile`）

- **隔离实例 = 一个无痕窗口。** 它有自己的 cookie/存储罐，退出即清，跟用户带着登录态的那个罐完全隔开。用途只有一个：让模型在**干净**环境里登录、试流程、点乱东西，而不碰用户的真实会话、也不留下痕迹。
- 为什么不做 `incognito: "split"` + 双扩展进程：那需要两套 service worker、两条 WebSocket、桥侧多客户端路由与逐命令的实例寻址，而隔离要的是**罐**不是进程。`spanning`（扩展的默认模式，本版显式写在 manifest 里）下一个实例就看得到两个罐，`tab.incognito` 足以分辨。真需要「另一份持久登录」时（独立 Chrome profile）才轮到多实例桥——那是第二阶段。
- 三个命令：`profile.status`（读：两个罐各有几个窗口/标签、隔离窗口在哪、浏览器给没给无痕权限）、`profile.launch`（可选 `url`；开一个无痕窗口，`focused: false` 不抢焦点）、`profile.close`（关窗口，连带清掉归属/让出/目标）。
- **两道人工授权，缺一不可**：插件配置 `allowIncognito: true`（默认 false）与浏览器扩展管理页的「在无痕/InPrivate 中允许」。后者是浏览器权限，插件翻不动它；缺失时 `profile.launch` 抛 `browser-incognito-unavailable:` → `incognito_unavailable` + `not_started`（一个窗口都没建），文案写清去哪儿点。
- **`use jar=incognito` 与 `launch` 共用同一道闸门**：`use` 看着只是切指针，但切过去之后下一条 `tabs.open` 就会由 `ensureIsolatedWindow()` 真的把无痕窗口建出来——闸门只长在 `launch` 上等于没有闸门。进隔离罐要过闸，退出（`jar=normal`）永远放行；`close` 与 `status` 也不受 `allowIncognito` 约束（关掉/看一眼隔离实例都是安全方向）。
- `policy.jar` 随每条命令下发：`jar='incognito'` 时 `tabs.open` 落在隔离窗口里（结果带 `isolated: true` 与 `incognito: true`），`resolveTab` 在**没有粘性目标**时优先取隔离窗口的当前页（`lastTargetSource='isolated-window'`）——不能跟着 `lastFocusedWindow` 走，隔离窗口是 `focused:false` 开的，那样会打到用户的页面上。
- 隔离罐里第 4 项那套照样成立：归属/分组/关闭守卫/让出都在 `agentState` 里按 tabId 记，与罐无关。`tabs.list` 每行多一个 `incognito` 布尔、顶层多一个 `isolatedWindowId`。
- 用户随时可以自己关掉那个无痕窗口：`isolatedWindow()` 每次都会校验一次并把失效记录清掉（自愈），所以状态面不会长期挂着一个已经不存在的窗口。
- 实测台：`verify/verify_isolated.mjs`（扩展侧）、`verify_profile_tool.mjs`（插件侧）。

## 关闭标签页：每个 id 都要有去向

- `browser_tabs close` 收 `tabId`（一个）或 `tabIds`（一批）。一批在链路上是**一条命令**（扩展侧 `tabs.closeMany` → 一次 `chrome.tabs.remove([ids])`），不是 N 次往返中间掉线。
- 结果一律是 `{ requested, closed: [...], alreadyGone: [...], failed: [{tabId, error}] }`（有被拒的还会多一个 `refused: [{tabId, reason}]`），**单数与批量同一个形状**，模型只需要学一种结果。以前的 `for (id of ids) await tabs.close(id)` 在第一个失败就抛出，会把已经真的关掉的标签藏起来 —— 模型于是以为什么都没发生，重放整批。
- **默认只关 AI 自己开过的标签页。** 不是 AI 的（既不是 `tabs.open` 开的、也不在**我们按 groupId 记着的**那个标签组里）进 `refused`，`chrome.tabs.remove` 压根不会收到它——拒绝 = **零副作用**，不是「失败了」。用户自己建的组、哪怕是同名的组，里面的标签页都算「不是 AI 的」。要关用户自己的标签页必须显式 `force: true`，而那是模型应该先在对话里跟用户确认过的事。这条判据是「`tabs.remove` 收到了什么」，不是「返回了什么」：返回里写着 `closed:[…]` 而实际关掉了用户的页面，是最坏的一种实现，`verify_tabs_close_many` 的 §1b 就是为它写的。
- **`alreadyGone` 是幂等成功，不是错误**：关一个已经不在的标签 = 目标已达成，直接重试是安全的。这条和 `src/errors.ts` 的 `effectState` 是同一件事的两半（那里管「失败该怎么报」，这里管「部分成功该怎么报」）。
- **不猜**：`chrome.tabs.remove` 之后逐个复查，「还在」的才进 `failed`；调用被拒但其中一个其实已经关掉，也会如实进 `closed`。
- 交给 Chrome 的只有「确认存在」的 id：真 Chrome 遇到无效 id 会拒绝**整批**，所以先自查存在性 —— 一个早已消失的标签不会连坐同批里还能关的标签。
- `verify/verify_tabs_close_many.mjs`：扩展侧 8 组场景（一次调用/数组形态、早已不存在、幂等重试、入参清洗、单数同形状、整批被拒、拒了但已关掉一个、**归属守卫**），宿主侧 8 条（分发到 `tabs.close` 还是 `tabs.closeMany`、重复 id 去重、结果过 schema、文本里读得到去向、`force` 原样透传、缺参明确报错）。

## 模型可见内容契约

- 成功结果里，**模型看到的就是 `output.render(args, value)` 的返回值**（宿主实测：`@deepseek-ai/dsh-tools` `lib/index.js:3548-3551`，`content = snapshotProjection(render(...))`）。`value` 是 execution-local 的，"deliberately omitted from durable events"（`lib/types/index.d.ts:415`），`presentationMeta` 只喂 UI。**render 少写一个字段，模型就永远看不到那个字段。**
- 因此：`browser_read` 把页面正文放进 render（不再只报「N chars」），`browser_snapshot` 把 `[e13] button "Save"` 逐条列出来（不再只报「N interactive elements」），两条日志工具把条目本身列出来（不再只报计数）。
- 每类内容有自己的预算：页面正文每次 20 000 字符、快照列表 8 000、日志列表 6 000、其它 JSON 结果 4 000。
- 超预算时追加一行**机器可读**标记：`… [renderedTruncated omittedChars=N limitChars=L] narrow the query and call again to see the rest`。标记是在切片之后拼上去的，所以它一定活着。看到它的正确反应是缩小查询（`limit` / `pattern` / `urlPattern` / `offset`），不是假设页面就这么长。
- `browser_read` 用窗口读取：头部写 `chars 0-20000 of 43210; call again with offset=20000`，`value` 里带 `offset` / `totalChars`。**一次调用不会把整站灌进上下文**，长页面靠 `offset` 走。
- 日志列表的时间统一 UTC 秒（`HH:MM:SS`），`count < total` 时明说「只给了最新的 N 条」。`headers` / `responseHeaders` / `postData` 不进结果：它们到不了模型，只会把载荷变大。
- 封闭 `output.schema` 必须逐字段声明扩展真实回传的东西。宿主 `checkValue`（`lib/index.js:468-470`）对 `additionalProperties:false` 是**逐键判违规**，少声明一个字段等于这条工具每次调用都失败（`properties:{}` + `additionalProperties:false` = 任何键都违规——`browser_console_log` / `browser_network_log` 从 v1.0.7 到 v1.0.11 就一直栽在这)。
- **失败路径同理**：宿主把异常渲染成 `content` 时只取一句 `Error: ${message}`（`lib/index.js:3616-3623`），`code` / `effectState` / `hint` 只进 `error.info` 和 HTTP 面，**模型看不到**。所以 `BridgeError` 把这三件事写进 message 本身：`[command_timeout] browser command timed out after 800ms: click — effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态…不要直接重试。下一步：扩展超时未回应…`。写操作超时/在途掉线报 `unknown`，只读报 `not_started（重试安全）`——决定下一步的信息必须在模型读得到的那一行里。
- HTTP 面形状不跟着变长：`toJSON().error` 走新的 `detail` 字段（原始失败描述），`code` / `effectState` / `hint` 照旧各归其位，`hint` 不会在 `error` 里重复出现。`verify/verify_errors.mjs` 断言这两条。
- 宿主只对 `undefined` 放行，**对 `null` 会下钻判类型**（`checkValue` 的物体分支里是 `!hasOwn(value,key) || value[key] === void 0` 才跳过）。因此扩展回 `字段: null` 时，封闭 schema 这一侧必须把 null 剥掉或如实声明可用类型——`browser_emulate` 就是因为原样透传 `userAgent: null`（`background.js:719`，`desktop` 预设的 UA 是空串）从 v1.0.7 一路坏到 v1.0.13。审计台对 11 条封闭 schema 工具断言 `value` 里不得出现任何 null。
- 以上都由 `verify/verify_render_contract.mjs` 实测：真实 `BridgeServer` + 假扩展 + 宿主自己的 `validateJsonSchemaValue` 与 `valueSchemaSpecToJsonSchema`，逐条问「schema 过不过」「模型看到的文本里有没有这次调用真正要的数据」。**全部 24 条工具都在表里，不抽查**——因为抽查正是这两个缺陷活了 12 个 / 5 个版本的原因。

## AI 操作高亮层（`agentHighlight`，v1.1.4）

AI 作为**目标**的那一页里会画一圈描边 + 一个「AI 正在操作」徽标，用来回答「机器现在在动哪一页」。它和接管浮层（下一节）走同一个注入通道，但**定位完全不同**，所以按维度分开写。

| 维度 | 行为 |
|---|---|
| 配置 | `agentHighlight`（布尔，默认 `true`）整体关掉；关掉之后工具面、闸门、结果字段一条都不变，只是不画。策略随 `policy.highlight` 下发，一条读命令就能让已经画着的那层收掉（不必等下一次认领），记录一并清空 |
| 形态 | `position: fixed` + `pointer-events: none` 的渐变描边 + 一个「AI 正在操作」小徽标（文案由扩展写死，调用方只能给 `tone` / `label`，`label` 只有两个常量）；宿主是 Shadow DOM（`id="__dsh_agent_highlight__"`，带 `data-dsh-hold="highlight"` 与 `aria-hidden`），页面的 CSS 碰不到它，它也不碰页面 |
| 出现 | `tabs.open` / `tabs.group` / `tabs.activate` 认领、或切到某一页时画上——跟着「认领」这个动作走，不是「AI 碰过这个标签页」；换目标时**先把旧的擦掉再画新的**（页面上永远只有一层） |
| 让出 | 用户真的在那个标签页上动手（点击/输入/按键/粘贴，v1.1.5 的判据）时变成琥珀色的「已让出 · 你可以操作」；**只改当前画着的那一页**（用户动手的是另一页时，框不会被挪过去谎报位置）。`tabs.activate` 要回来之后恢复蓝色 |
| 消失 | 标签页关闭、AI 的目标换走（认领了别的页）、`ungroup` 拆组（拆组 = 放手）、桥断开 |
| 导航 | 页面导航完成后**自动重画**：注入物跟着旧文档一起没了，不重画就等于「一次跳转把指示丢干净」。`status:'loading'` 不算完成、不是当前目标的那一页加载完成也不会凭空长出一圈框；让出状态下补画的仍是琥珀色 |
| 截图与打印 | `browser_screenshot` / `browser_pdf` 期间临时隐藏，拍完与印完各自还原，所以截图和 PDF 里都没有这一层；**页面上本来没有框时不发这次藏/还原的 evaluate** |
| 观察面 | 与接管浮层共用 `data-dsh-hold` 标记，所以 `content`（含 html 模式）/ `find` / `snapshot`（DOM 与 **AX** 两种模式）都排除它——不占 ref、不计入 `total`。模型不会读到自己正在操作的提示语 |
| 只画自己那一页 | 用户自己的页面上不画；`tabs.activate` 打到用户的页时也**不会为了画框去挂 debugger**（认领相关的部分照做）。`chrome://` 这类注入不了的页面上不画、但命令不失败，也不留幽灵记录（记录只在框真的画上之后才写） |
| 失败不连坐 | 注入抛错时 `tabs.open` 照样成功、标签页照样被认领：视觉层失败绝不影响归属与默认目标。断桥与补画交错之后页面上不留残留，记录也清干净（不会留给下一次连接去猜）；记录落在 `chrome.storage.session`，新 worker 读回来能接着补画 |
| 与浮层的区别 | 浮层是给**用户**看的模态提示 + 防误触：它会拦 `click` / `input` / `press` / `nav`（`held_by_user`），用户双击可关。高亮**不拦任何命令、不改变任何策略判定**，是一条非交互的状态指示，属于软层里的装饰层，**不构成任何安全边界**——真正能冻住浏览器的仍是弹窗里的本地硬锁 |

为什么不把它做成浮层的一部分：浮层要用户从页面上抹掉（双击 / Esc），高亮的生命周期却由**认领与目标**决定（标签页关了、目标走了、导航了都该跟着变），两者混在一起，用户双击关掉浮层就会顺手把「机器正在这一页」这个信息也关掉。分开之后各自只有一条规则。

实测台：`verify/verify_highlight.mjs` —— 页面侧函数**真的被执行**（假 `document` + `node:vm`），所以「宿主长什么样、CSS 里写了什么、徽标文案走没走 textContent」都是测出来的，不是断言编好的返回值；覆盖换目标先擦再画、让出只改当前那一页、导航补画与 `loading` 的区分、断桥与补画交错、截图与打印的藏/还原顺序、以及「视觉层失败不连坐命令」。

## 接管浮层（`browser_hold`）

在某个标签页上加一层可撤销的浮层：页面变暗、中间一张卡片写明模型在做什么，用户双击页面任意处
（或连按两下 Esc、或按住 Esc 约 0.6 秒）就能关掉。**它是软层，不是安全边界** —— 桥的 token 模型
读得到也改得动，所以任何长在插件侧/扩展侧的开关都只是策略；真正能冻住浏览器的只有弹窗里的本地锁。

| 维度 | 行为 |
|---|---|
| 命令 | 扩展 `COMMANDS` 里只有一条 `hold`，参数 `action: 'on' \| 'off' \| 'status'`；工具面是 `browser_hold`，参数 `action` / `note` / `tabId` |
| 标题 | **由扩展写死**（`DSH Browser Control`）。调用方只能提供 `note`（正文），且正文压平换行、截到 400 字符 —— 否则模型能写一句系统口吻的话冒充提示 |
| 状态 | 放 `chrome.storage.session`、按 `tabId` 记。活过 service worker 回收（MV3 会回收 worker，内存标志 30 秒就丢——那正是浮层「以为挡着、其实没挡」的失败方式），不落盘，浏览器关掉即清。页面里另留一份只读的 `window.__dshHold`（谁撤的、什么时候撤的），**不参与决策** |
| 关掉浮层 | 双击任意处 / 连按两下 Esc / 按住 Esc ≈0.6 秒。这是**接管**，不是中止：模型照常可以继续操作这一页 |
| 中止 | 卡片上的「中止模型操作」要两次点击确认（点一次变「再点一次确认」，3 秒不点还原）。中止之后 `click` / `input` / `press` / `nav` 被扩展在 `runCommand` 入口拒绝，**零 CDP 调用**；模型要恢复得先与用户确认，再调 `browser_hold action=off`（这一步等于确认继续）。**中止期间 `hold on` 也会被拒**——否则模型有一条不询问用户就能继续的旁路：被拦一次 → 再挂一层（旧实现会顺手把中止清掉）→ 照常点 |
| 模型自己的点击 | 浮层是全屏的，坐标派发本来会先命中它：模型一挂浮层，自己的 `click` 就全部落在浮层上（页面什么都没发生，结果还只轻描淡写一句 `hitVerified:false`），而且同一坐标连点两下会被浮层当成「双击」、以用户的名义关掉。所以 `click` 命中到的是**自己这层浮层**时，扩展临时把宿主设成 `pointer-events:none`、重测命中点、派发完再恢复；结果里带 `bypassedOwnOverlay:true`。它挡的是人，不是模型 |
| 模型看到的错误 | 结果帧只有一个 `error` 字符串，所以扩展在文本最前面写 `browser-hold-aborted:`，`classify()` 认前缀 ⇒ `code=held_by_user`、`effectState=not_started`（拦截在 handler 之前，这是可以确定的真相），标记从给模型的那句话里剥掉。两边字面量由 `verify_errors` 对账 |
| 页面换了就没了 | 导航/刷新会把浮层带走。此时命令直接放行，并把存储里那条顺手清掉，`status` 如实报 `active:false` —— 不许假装还挡着 |
| 覆盖范围 | **可观测的失败**：盖不住时 `browser_hold` 回 `covered:false` 且带 `reason`（`error-page` / `browser-page` / `devtools` / `inject-failed`）。已知盖不住的有：严格 CSP、全屏、跨源 iframe、PDF 阅读器、原生弹窗挡在上面 —— 这些时候状态里能看出来，而不是只在文档里认怂 |
| 只读档 | `readOnly: true` 时 `hold` 的 `on` / `off` 被拒（往页面里插/删宿主元素 = 改页面 DOM），拒因专门写清这一点；**`action=status` 放行**——它只读状态（session 条目 + 探一下页面上那层还在不在），只读档不该连看一眼都不让。闸门因此按**动作**判，不只按命令名 |
| 观察面 | 浮层是**注入物**，所以 `content`（含 html 模式）/ `find` / `snapshot`（DOM 与 **AX** 两种模式）都排除带 `data-dsh-hold` 的子树；AX 模式下它不占 ref、也不计入 `total`。`verify_hold` / `verify_snapshot_ax` 两向断言（浮层文字与「中止模型操作」按钮不出现在模型可见文本里 + 页面上同名 class 的正常元素不被误伤） |
| 失败分类 | `hold` 算写操作：超时/在途掉线报 `unknown`（重试可能多留一层），不许报「没动到页面，重试安全」 |

## 本地硬锁（扩展弹窗的「锁定」）

用户在扩展弹窗里单击「锁定」后，本机进入冻结状态，契约如下：

| 维度 | 行为 |
|---|---|
| 连接 | **保持**。WebSocket 不断、心跳照发，`hello` 照常上报；调用方看到的是「连得上但被冻结」 |
| 命令 | **全部拒绝**，包括只读命令（`content` / `snapshot` / `screenshot` / `tabs.list`……）。拒绝发生在 `runCommand` 的入口，任何 handler 都不会被调用，也就是**零 CDP 调用、零标签页改动** |
| 错误文案 | 点名被拦的命令，并写明「解锁只能由用户在浏览器工具栏的扩展弹窗里点『已锁定』完成」与「不要重试」 |
| 解锁通道 | 只有扩展弹窗的 `chrome.runtime` 消息（`lockSet`）。桥接侧没有解锁命令；`lockSet` 不在扩展的 `COMMANDS` 表里，所以模型塞一条同名命令帧只会被当作普通命令拦下 |
| 持久化 | 状态落在 `chrome.storage.local.hardLock`。MV3 回收 service worker 后重新读盘，**不会**因为内存标志丢失而解冻 |
| 读盘失败 | **按锁定处理**（fail-closed）。panic switch 唯一不能有的失败方式是「以为锁着其实没锁」，所以读不出状态时宁可拒绝；此时拒绝文案与 `bridgeStatus.lockReason` 都写「读不出锁状态」而不是「已被用户锁定」，不冤枉用户，也不误导模型。下一次调用会重读，存储恢复后自动放行。用户仍能从弹窗解锁——那条通道走内存里的 `setHardLock`，不依赖这次失败的读 |
| 徽标 | 冻结期间显示红色 `LOCK`；恢复后按连接状态显示 `ON` / `…` / `OFF`。`init()` 会**先读锁再连接**，所以 service worker 刚唤醒、一条命令都还没跑的时候图标就是 `LOCK`，而不是让人误判健康的绿色 `ON` |
| 模型看到的错误 | 结果帧只有一个 `error` 字符串可以带信息，所以扩展把 `browser-locked-by-user:` / `browser-lock-unreadable:` 写在文本最前面，`classify()` 认前缀：`code=locked_by_user` 或 `lock_unreadable`，`effectState=not_started`（**写操作也是**，因为拦截发生在 handler 之前，这是可以确定的真相），标记本身从给模型的那句话里剥掉。认不出前缀就退成 `command_failed` + 写操作 `unknown` + 「通常是选择器没命中」那种误导 hint，所以 `verify_errors` 对账两侧字面量逐字一致 |
| 协议 | 不动 `PROTOCOL_VERSION`：冻结是本机开关，不是帧契约的一部分。老扩展不会发这两个前缀，因此不存在「静默降级读不到」的版本错位——它压根没有锁 |

之所以放在客户端而不是桥接侧：桥的唯一实际边界是回环地址 + token，而 token 明写在 profile 的
`cordis.patch.yml` 里——模型读得到、也改得动，还能重启桥。把「冻结」放进浏览器、只留一个人工通道，
才是模型够不到的那一层。

## 工具描述懒加载（`lazyToolDocs`）

profile 里给 `browser-bridge` 打开 `lazyToolDocs: true`（或设置页开关）后：

| 维度 | 行为 |
|---|---|
| 改变的只有描述 | 每个 `browser_*` 的 `description` 换成固定短桩（`src/tool-help.ts` 的 `LAZY_DESCRIPTION`）；**参数 schema 一个字段都不变**，工具照常可直接调用 |
| `browser_help` 例外 | 它自己保留完整描述（否则模型不知道要查），并且不经过扩展：桥未启用、扩展离线时照常可用 |
| 文档来源 | 注册时那份定义本身（`applyBrowserTools()` 里的 `definitions` Map），不是第二张手写表；因此不会出现「文档写了不存在的工具」 |
| 目录模式 | 省略 `tool`：返回工具数 + 每条一行 `name — 首句摘要`，模型可见文本 4 000 字符预算 |
| 单查模式 | 给准确名字：完整描述 + 参数表（名称/类型/必填/枚举/默认值）；未知名字抛错并列出可用清单 |
| 系统提示词 | 懒加载时追加一句「工具描述按需加载，先 `browser_help`」；非懒加载不出现这句 |
| 开关生效方式 | 配置改动由宿主重新加载插件；0.1.2 及更早的宿主（走 `settings.register` 那条）不会重启插件，需重启 dsh |
| 验收 | `verify_tool_docs.mjs` 断言两种模式工具集合一致、参数 schema 逐字节一致、每个工具都被 `browser_help` 覆盖且返回注册时的完整描述 |

## 原生 CDP（`browser_cdp`）

| 维度 | 行为 |
|---|---|
| 输入 | `method` 必须形如 `Domain.method`（如 `Page.captureSnapshot`）；`params` 必须是 JSON 对象（省略 = `{}`，`null` / 数组直接报错，不静默改写）；`tabId` 省略时按现有规则取当前标签 |
| 扩展侧 | 新命令 `cdp.call`，复用持久 debugger 附着；任意方法名原样派发，不做白名单裁剪 |
| 结果 | 返回 `{tabId, method, json, bytes, truncated}`：`json` 是 CDP 结果的 JSON 字符串，`bytes` 是**截断前**的长度；超过 20 000 字符截断并置 `truncated:true`；不可 JSON 序列化的值降级为 `{unserializable:"…"}` |
| 失败分类 | 按写操作处理（`WRITE_COMMANDS` 含 `cdp.call`）：超时/在途掉线报 `unknown`。扩展不认识这条命令（旧扩展）报 `command_failed` + `not_started`——它在 handler 之前就拒绝了，命令一条都没发出去 |
| 会话丢失 | **不自动重放**（不走 `withCDP` 的「首个 CDP 调用失败就重连重放」）：这条命令可能是一次不可撤销的写（`Page.navigate` / `Network.setCookie`），副作用是否已发生无法确定时按 `unknown` 报告，而不是再发一次做两遍 |
| 只读档 | 拒绝（默认白名单不含它） |
| 脚本开关 | `allowScript: false` 也拒绝：CDP 能走到 `Runtime.evaluate`，只关 `browser_evaluate` 等于没关 |
| 注册开关 | `allowRawCdp`（默认 true）决定这个工具是否注册；关闭后模型面看不到它，不是「调用时才拒绝」 |
| 版本 | 需要扩展 **v1.0.20+**；旧扩展会报 `unknown command: cdp.call` |
