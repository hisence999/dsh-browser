// 隔离实例（无痕罐，第 3 项）的**扩展侧**台账：在 node:vm 里跑**真实的**
// extension/background.js，配一台有状态的假浏览器（verify/ext_harness.mjs），把这条线
// 上每一条契约钉住：
//
//   1) 前提是**用户**在扩展管理页给的开关（`chrome.extension.isAllowedIncognitoAccess`）。
//      拿不到就不许开——不是「报个错继续往下走」，而是**零窗口被建**；
//   2) 有了权限之后开的必须是**无痕窗口**，而且 `focused:false`：AI 开自己的罐，但不许把
//      用户正在用的那个窗口顶下去（`focused:true` 会静默抢焦点，一个错都不报）；
//   3) 罐是**幂等**的：重复 launch 不重复建窗（否则每调一次就多一个无痕窗口，只有用户在
//      任务管理器里才看得见）；
//   4) 只有 `params.policy.jar === 'incognito'` 才进罐；缺省一字不改地留在用户那个罐里——
//      「隔离」是显式选择，不是把默认行为悄悄改掉；
//   5) `resolveTab(undefined)` 在罐里优先取无痕窗口的当前页：我们是用 `focused:false` 开的它，
//      跟着 `lastFocusedWindow` 走就会打到用户的页面上；但**粘性目标优先**——罐不许抢走
//      已经认领的页；
//   6) `profile.close` 关窗口要**连带**标签页，并把归属/让出/目标一起清掉（窗口一关还留着
//      就是幽灵状态，下一条命令会往一个死 id 上开页）；重复 close 幂等；
//   7) 用户自己关掉那个无痕窗口时要自愈：状态里那条记录必须被**真的**从 storage 清掉，
//      而不是每次都靠「读不到就当我没记过」把脏状态一直盖着；
//   8) 隔离罐不是法外之地：罐里的 `tabs.close` 仍然要先 owned，让出期间罐里的 `click` 一样被拦；
//   9) `tabs.list` / `browser.info` 报出罐的坐标（模型自己就能看见「我在哪个罐里」）。
//
// 后面 A/B/C/D 四块是**后续修复**的回归，钉的都是「只在很窄的时机才出现」的那类缺陷：
//   A) 权限新鲜度：缓存说「没权限」，但用户**刚刚**在扩展管理页把开关打开。闸门（含
//      `tabs.open{jar:'incognito'}` 这条入口）必须当场重读一次；`profile.status` 与
//      `browser.info` 也必须现读——否则用户打开了开关、模型换个入口还是撞墙，要等
//      worker 被回收才恢复，而排障的人看 status 会以为这台机器永远开不了罐；
//   B) 分罐计数：用户自己也开着无痕窗口时，`isolated.tabs` / `isolated.active` 只能数
//      **隔离窗口里**的页。数成全局就会把用户的窗口报成我们的，`active` 还指到他那页上；
//   C) 关窗清理的**两条路径分开钉**：C1 靠 `tabs.onRemoved` 广播（真 Chrome 会为每个标签页
//      发一次），C2 靠 `isolatedWindow()` 的兜底扫描（事件没到：浏览器重启、worker 被回收
//      期间用户关了窗）。两条都缺一不可——只靠事件会留脏记录，只靠扫描则让「事件已经到了」
//      和「还没到」变成同一件事，模型在那一刻看见的就是假的干净；
//   D) close 的**失败路径**：`chrome.windows.remove` 可能被拒（窗口正在收尾、被策略挡住）。
//      这时必须报 `closed:[]` + 原因、窗口与标签页都还在、`state.isolated` 与归属/让出/目标
//      **一个都不清**；注入用完重试才真的关掉。谎报「已关」的下场是最坏的一种——下一次
//      launch 会再开一个无痕窗口，用户屏幕上多一个来路不明的窗口，而状态面说还是同一个。
//
// 为什么这组断言必须存在：上面每一条**都不会报错**。没有权限却开了窗、每调一次 launch
// 多一个无痕窗口、`focused:true` 把用户顶下去、close 之后归属还挂着、用户手动关窗之后记录
// 永远是脏的——全都只看得到「命令返回了一个对象」。这个仓库的原则是：副作用要能被证伪，
// 所以断言钉在**假浏览器的真实状态**（windows / tabs / windowCreateCalls / removeCalls）、
// **假 storage 的落盘内容**、以及命令返回值上。
//
// 断言只落在函数返回值与假状态上：vm context 上只有顶层 `function` 声明可见，
// `DEFAULT_POLICY` / `INCOGNITO_UNAVAILABLE_MARKER` 这些 `const` 一个都拿不到。所以线协议
// 前缀写成字面量——它属于契约（`src/errors.ts` 按这个前缀判 `incognito_unavailable`），
// 悄悄改它等于改契约，台子红了才对。
import { bootBackground, makeModel } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/** 线协议前缀，与 src/errors.ts 的 INCOGNITO_UNAVAILABLE_MARKER 逐字一致。 */
const MARKER = "browser-incognito-unavailable:";
/** 让出的前缀（第 4 项），第 8 块用它证明罐里的守卫没被罐绕开。 */
const YIELDED = "browser-yielded-to-user:";
/** 越过 1200ms 命令窗 + 1500ms 自我激活回声窗，让一次切换真的算「用户做的」。 */
const PAST_SUPPRESSION_MS = 1600;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
/**
 * v1.1.5 起「用户接管」的信号是页面里的**真实输入**：切到那一页只是看，不算。
 * 所以制造一次让出要投递一次 `Runtime.bindingCalled`——那正是页面探针在真机上产生的
 * 东西，走 `chrome.debugger.onEvent` 的真路径（信号本身在 verify_yield.mjs 里测）。
 * 保留 `fireActivated` 是因为它同时改 `tab.active`，这里的罐路由会用到。
 */
const USER_INPUT_BINDING = "__dshUserInput";
const userTouched = (model, tabId) => {
  model.fireActivated(Number(tabId));
  model.fireBinding(Number(tabId), USER_INPUT_BINDING, '"pointerdown"');
};

const bootIsolated = async ({ incognitoAllowed = false, reuse } = {}) => {
  const model = reuse?.model ?? makeModel();
  // 权限是**浏览器**那一层的开关；台子用 model.incognitoAllowed 演它（默认 false = 新装机）。
  if (incognitoAllowed) model.incognitoAllowed = true;
  const local = reuse?.local ?? {};
  const session = reuse?.session ?? {};
  const { ctx, sandbox } = await bootBackground({ model, storage: local, sessionStorage: session });
  return { model, ctx, sandbox, local, session };
};

/** 走真派发入口，只要错误文本（成功返回 null）。 */
const refusalOf = async (ctx, command, params) =>
  ctx.runCommand(command, params).then(() => null, (e) => String(e?.message ?? e));

/** 隔离罐里的标签页（无痕窗口里的那些）——与扩展自己那份查询口径一致。 */
const inJar = (model, windowId) => model.tabsInWindow(windowId).map((t) => t.id);

/* 1 —— 没有权限：launch 被拒、零窗口被建、连状态都不许脏 */
{
  const { model, ctx, session } = await bootIsolated();
  check("(1) 前提：假浏览器默认不给无痕访问（跟新装机的真 Chrome 一样）",
    model.incognitoAllowed === false);

  const refused = await refusalOf(ctx, "profile.launch", {});
  check("(1) 没权限时 profile.launch 被拒，错误以线协议前缀开头",
    String(refused).startsWith(MARKER), String(refused).slice(0, 74));

  // 这一条是整台的关键之一：拒绝必须发生在 `chrome.windows.create` **之前**。
  // 修之前（先去建窗再判权限）用户会看到一个来历不明的无痕窗口，而命令还报成功。
  check("(1) 拒绝 = 零副作用：一个窗口都没建、一个标签页都没开",
    model.calls.windowsCreate === 0 && model.calls.create === 0 && model.windows.size === 1,
    `windowsCreate=${model.calls.windowsCreate} create=${model.calls.create} windows=${model.windows.size}`);

  // `tabs.open` 的罐分支必须共用同一道闸：不然「换个入口」就能把无痕窗口开出来。
  const refusedOpen = await refusalOf(ctx, "tabs.open",
    { url: "https://x.test/", wait: false, group: false, policy: { jar: "incognito" } });
  check("(1) `jar:'incognito'` 的 tabs.open 也被同一道闸拦下，仍然零建窗",
    String(refusedOpen).startsWith(MARKER) && model.calls.windowsCreate === 0 && model.calls.create === 0,
    String(refusedOpen).slice(0, 60));

  check("(1) 失败不许写状态：session 里没有留下任何「隔离实例」记录",
    (session.agentState?.isolated ?? null) === null, JSON.stringify(session.agentState?.isolated ?? null));

  const status = await ctx.cmdProfileStatus();
  check("(1) profile.status 如实报「这台机器开不了罐」",
    status.incognitoAllowed === false && status.isolated === null,
    JSON.stringify({ allowed: status.incognitoAllowed, isolated: status.isolated }));
}

/* 2 —— 有权限之后：无痕窗口 + focused:false + 重复 launch 不重复建窗 + status 记账 */
{
  const { model, ctx } = await bootIsolated();
  // 先把「没有权限」这个答案缓存进 worker 生命周期：这就是用户刚去扩展管理页打开开关时的现场。
  const status0 = await ctx.cmdProfileStatus();
  check("(2) 前提：worker 里缓存的权限答案还是 false", status0.incognitoAllowed === false);

  model.incognitoAllowed = true; // 用户刚在扩展管理页把「在无痕/InPrivate 中允许」打开
  // cmdProfileLaunch 必须**强制重读**。删掉那次 refresh，它就会拿缓存里的 false 把用户拒掉：
  // 用户明明刚开了开关，模型却一直收到「请去打开无痕权限」。
  const first = await ctx.runCommand("profile.launch", { url: "https://probe.test/" });
  check("(2) 开关刚打开就 launch：真的建起来了（不许拿一小时前的缓存拒用户）",
    first?.created === true && Number.isInteger(first.windowId),
    JSON.stringify({ created: first?.created, windowId: first?.windowId }));

  check("(2) 建出来的必须是**无痕**窗口（隔离 = 另一个 cookie/存储罐）",
    first.jar === "incognito" && model.windows.get(first.windowId)?.incognito === true,
    JSON.stringify(model.windows.get(first.windowId)));

  // `focused:false` 是「开自己的罐但别抢用户焦点」唯一真实的落点：假浏览器的 windows.create
  // 默认 focused:true，而且真 Chrome 里 focused:true 会把用户的窗口顶下去。
  const call = model.windowCreateCalls[0];
  check("(2) 建窗带 focused:false（开罐，但不许把用户正在用的窗口顶下去）",
    call?.focused === false, JSON.stringify(call));
  check("(2) 用户那个窗口仍然是聚焦的（焦点没被悄悄搬走）",
    model.windows.get(1).focused === true && model.lastFocusedWindowId() === 1,
    JSON.stringify({ w1: model.windows.get(1).focused, focused: model.lastFocusedWindowId() }));

  check("(2) launch 结果自报罐的类型、权限与标签页数",
    first.incognitoAllowed === true && first.tabs === 1, JSON.stringify(first));

  // 幂等：删掉 ensureIsolatedWindow 里那句「已经有了就直接返回」，这里每次都会多一个无痕窗口。
  const again = await ctx.runCommand("profile.launch", {});
  check("(2) 重复 launch 不重复建窗（第二次 created:false，窗口还是那一个）",
    again.created === false && again.windowId === first.windowId && model.calls.windowsCreate === 1,
    JSON.stringify({ created: again.created, windowId: again.windowId, windowsCreate: model.calls.windowsCreate }));

  const status = await ctx.cmdProfileStatus();
  check("(2) profile.status 如实报罐计数（普通罐 / 无痕罐 / 隔离窗口各自多少）",
    status.isolated?.windowId === first.windowId && status.isolated.tabs === 1
      && status.normal.windows === 1 && status.normal.tabs === 0 && status.incognito.windows === 1,
    JSON.stringify({ isolated: status.isolated, normal: status.normal, incognito: status.incognito }));
  check("(2) status 报出罐里的当前页（模型据此知道不带 tabId 会打到哪一页）",
    Number.isInteger(status.isolated?.active)
      && inJar(model, first.windowId).includes(status.isolated.active),
    JSON.stringify({ active: status.isolated?.active, inJar: inJar(model, first.windowId) }));
}

/* 3 —— jar:'incognito' 的 tabs.open 落在罐里；jar 缺省时默认行为一字不改 */
{
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  const opened = await ctx.runCommand("tabs.open",
    { url: "https://iso.test/", wait: false, group: false, policy: { jar: "incognito" } });
  const row = model.tabs.get(opened.tabId);

  // `chrome.tabs.create` 的 `incognito` 是只读属性：能不能进罐**只看 windowId**。
  // 删掉 cmdTabsOpen 里那条 jar 分支，标签页会落回用户的窗口，而命令照样返回一个 tabId。
  check("(3) jar:'incognito' 的 tabs.open 真的落在无痕罐里（tab.incognito 是真的）",
    row?.incognito === true, JSON.stringify({ tabId: opened.tabId, incognito: row?.incognito }));
  check("(3) 结果自报 isolated:true 与 incognito:true（模型不必自己去猜罐）",
    opened.isolated === true && opened.incognito === true,
    JSON.stringify({ isolated: opened.isolated, incognito: opened.incognito }));
  check("(3) 落点就是那个隔离窗口（不是另起一个无痕窗口）",
    row?.windowId === opened.windowId && model.windows.get(opened.windowId)?.incognito === true
      && model.calls.windowsCreate === 1,
    JSON.stringify({ windowId: row?.windowId, iso: opened.windowId, windowsCreate: model.calls.windowsCreate }));

  const plain = await ctx.runCommand("tabs.open",
    { url: "https://user-jar.test/", wait: false, group: false });
  const plainRow = model.tabs.get(plain.tabId);
  check("(3) jar 缺省：仍落在普通罐、仍落在用户那个窗口（默认行为不许被隔离改坏）",
    plainRow?.incognito === false && plain.isolated === undefined && plainRow?.windowId === 1,
    JSON.stringify({ incognito: plainRow?.incognito, isolated: plain.isolated, windowId: plainRow?.windowId }));
}

/* 4 —— resolveTab(undefined) 的罐路由：罐优先于焦点窗口，但粘性目标优先于罐 */
{
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  const isoActive = model.tabsInWindow(iso).find((t) => t.active)?.id;
  const user = model.addTab(1, "https://user.test/");
  model.tabs.get(user).active = true; // 用户正看着的那一页（窗口 1 仍然是聚焦窗口）

  // 用一条会回显 tabId 的命令来看「这一条命令到底解析到哪一页」：`emulate` 先 resolveTab
  // 再干活，device:'reset' 是它最便宜、最没有副作用的那条路。
  const routedInJar = await ctx.runCommand("emulate", { device: "reset", policy: { jar: "incognito" } });
  // 修之前 resolveTab 只有「用户正在看的窗口」一条兜底：罐里的命令会打进用户那一页，
  // 而两次调用都是 200，模型看不出来自己动错了页面。
  check("(4) 罐里没有粘性目标时：默认目标优先取隔离窗口的当前页，而不是用户正看着的那一页",
    routedInJar?.tabId === isoActive && routedInJar.tabId !== user,
    JSON.stringify({ resolved: routedInJar?.tabId, isoActive, user }));

  const routedNormal = await ctx.runCommand("emulate", { device: "reset" });
  check("(4) 不带 jar：默认目标仍然跟着用户正在看的页（第 4 项的老行为不许改坏）",
    routedNormal?.tabId === user, JSON.stringify({ resolved: routedNormal?.tabId, user }));

  // 反过来：已经认领过一页之后，罐不许把它抢走——否则模型在罐里干活会突然打到别处去。
  await ctx.runCommand("tabs.activate", { tabId: user });
  const routedSticky = await ctx.runCommand("emulate", { device: "reset", policy: { jar: "incognito" } });
  check("(4) 有粘性目标时仍取目标：罐不抢已经认领的页",
    routedSticky?.tabId === user, JSON.stringify({ resolved: routedSticky?.tabId, user, target: (await ctx.syncAgentState()).target }));

  const routedExplicit = await ctx.runCommand("emulate",
    { device: "reset", tabId: isoActive, policy: { jar: "incognito" } });
  check("(4) 显式 tabId 永远优先（罐路由只是缺省值）",
    routedExplicit?.tabId === isoActive, JSON.stringify({ resolved: routedExplicit?.tabId, isoActive }));
}

/* 5 —— profile.close：窗口 + 标签页一起消失、归属/让出/目标全清、重复 close 幂等 */
{
  const { model, ctx, session } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  const a = (await ctx.runCommand("tabs.open",
    { url: "https://a.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  const b = (await ctx.runCommand("tabs.open",
    { url: "https://b.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;

  // 在罐里制造一份真实的让出（用户切到了 AI 在罐里开的那一页）。
  await tick(PAST_SUPPRESSION_MS);
  userTouched(model, a);
  await tick();

  const before = await ctx.syncAgentState();
  check("(5) 前提：罐里确实挂着归属 / 让出 / 粘性目标（否则下面「清没清」无从判起）",
    before.tabs?.[a] !== undefined && before.tabs?.[b] !== undefined
      && before.yields?.[a] !== undefined && before.target === b,
    JSON.stringify({ tabs: Object.keys(before.tabs ?? {}), yields: Object.keys(before.yields ?? {}), target: before.target }));

  // 假浏览器对一次**成功**的 `windows.remove` 会把 `calls.windowsRemove` 加两次（一次是
  // 「尝试」、一次是「落地」），所以绝对次数不能当成「调用了几次」的口径——这里只断言
  // 「确实调用过」，而「窗口真的没了」由 windows/tabs 两份状态各自证。
  const removesBefore = model.calls.windowsRemove ?? 0;
  const closed = await ctx.cmdProfileClose();
  check("(5) profile.close 关掉那个无痕窗口，并报出它（连带几个标签页）",
    JSON.stringify(closed.closed) === JSON.stringify([iso]) && closed.tabs === 3,
    JSON.stringify(closed));
  // 只把记录删掉、不去关窗口，是最容易写出来的那版「看起来对」的实现：status 会说没有罐，
  // 而用户的窗口还开着、里面还留着 AI 的登录态。
  check("(5) 窗口与里面的标签页一起消失（真的调用过 chrome.windows.remove）",
    !model.windows.has(iso) && model.tabsInWindow(iso).length === 0
      && (model.calls.windowsRemove ?? 0) > removesBefore,
    `windows=${model.windows.size} leftTabs=${model.tabsInWindow(iso).length} remove ${removesBefore}->${model.calls.windowsRemove ?? 0}`);

  const after = await ctx.syncAgentState();
  check("(5) 归属 / 让出 / 目标全清（关掉的标签页不许留成幽灵状态）",
    Object.keys(after.tabs ?? {}).length === 0 && Object.keys(after.yields ?? {}).length === 0
      && after.target === null,
    JSON.stringify(after));
  check("(5) state.isolated 归 null，并且**落了盘**（不止是内存里那一份）",
    after.isolated === null && (session.agentState?.isolated ?? null) === null,
    JSON.stringify({ mem: after.isolated, disk: session.agentState?.isolated ?? null }));

  const removesAfterClose = model.calls.windowsRemove ?? 0;
  const again = await ctx.runCommand("profile.close", {});
  check("(5) 重复 close 幂等：返回空 closed、不抛、也不再碰窗口（重试是安全的）",
    Array.isArray(again.closed) && again.closed.length === 0 && again.tabs === 0
      && (model.calls.windowsRemove ?? 0) === removesAfterClose,
    JSON.stringify({ again, remove: `${removesAfterClose}->${model.calls.windowsRemove ?? 0}` }));
}

/* 6 —— 自愈：用户自己在浏览器里关掉那个无痕窗口 */
{
  const { model, ctx, sandbox, session } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  await ctx.runCommand("tabs.open",
    { url: "https://a.test/", wait: false, group: false, policy: { jar: "incognito" } });

  // 用户自己在浏览器里把那个无痕窗口关了（Chrome 侧的事实）。
  const removesAfterUserClose = await (async () => {
    await sandbox.chrome.windows.remove(iso);
    return model.calls.windowsRemove ?? 0;
  })();
  check("(6) 前提：窗口没了，但 session 里那条记录还在——这就是需要自愈的脏状态",
    !model.windows.has(iso) && Number.isInteger(session.agentState?.isolated?.windowId),
    JSON.stringify(session.agentState?.isolated ?? null));

  const status = await ctx.cmdProfileStatus();
  check("(6) 自愈：status 报 isolated:null，而不是一个已经不存在的窗口",
    status.isolated === null, JSON.stringify(status.isolated));
  // 这条比上面那条更硬：每次「读不到就当没有」也能让 status 看起来对，但脏记录会一直留着，
  // 下一次 launch 会以为罐还在、下一条命令会往死 id 上开页。
  check("(6) 而且那条记录被**真的**从 storage 清掉（不是靠「读不到」把脏状态盖着）",
    (session.agentState?.isolated ?? null) === null,
    JSON.stringify(session.agentState?.isolated ?? null));
  check("(6) 罐计数也不再含那个已经关掉的窗口",
    status.incognito.windows === 0 && status.incognito.tabs === 0,
    JSON.stringify(status.incognito));

  const again = await ctx.runCommand("profile.close", {});
  check("(6) 自愈之后 close 也幂等：不往一个死 windowId 上发 windows.remove",
    again.closed.length === 0 && (model.calls.windowsRemove ?? 0) === removesAfterUserClose,
    JSON.stringify({ again, remove: model.calls.windowsRemove ?? 0 }));
}

/* 7 —— 隔离罐不是法外之地：罐里一样要 owned、让出期间一样被拦 */
{
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  // 无痕窗口里那个「不是 AI 开的」标签页：windows.create 带进来的那一页，没人认领过它。
  const orphan = inJar(model, iso)[0];

  const refused = await ctx.runCommand("tabs.close", { tabId: orphan });
  check("(7) 罐里 tabs.close 仍然要先 owned：不是 AI 开的就拒绝（罐不是放宽守卫的借口）",
    refused.refused?.[0]?.tabId === orphan && refused.refused[0].reason === "not_owned_by_agent"
      && model.tabs.has(orphan),
    JSON.stringify(refused));
  check("(7) 拒绝 = 没有发生：那个 id 压根没进 chrome.tabs.remove",
    model.removeCalls.length === 0, JSON.stringify(model.removeCalls));

  const owned = (await ctx.runCommand("tabs.open",
    { url: "https://mine.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  await tick(PAST_SUPPRESSION_MS);
  userTouched(model, owned);
  await tick();
  check("(7) 前提：罐里的接管被记下", (await ctx.syncAgentState()).yields?.[owned] !== undefined);

  const attachBefore = model.dbg.attachCount;
  const clicked = await refusalOf(ctx, "click", { selector: "#x", tabId: owned });
  check("(7) 让出期间罐里的 click 一样被拦（前缀是线协议），并且零 CDP",
    String(clicked).startsWith(YIELDED) && model.dbg.attachCount === attachBefore,
    `${String(clicked).slice(0, 50)} attach ${attachBefore}->${model.dbg.attachCount}`);
}

/* 8 —— tabs.list / browser.info 的罐坐标 */
{
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  const isoTab = (await ctx.runCommand("tabs.open",
    { url: "https://mine.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  const user = model.addTab(1, "https://user.test/");

  const listed = await ctx.cmdTabsList();
  const isoRow = listed.tabs.find((t) => t.id === isoTab);
  const userRow = listed.tabs.find((t) => t.id === user);
  check("(8) tabs.list 顶层报出隔离窗口 id（模型不用再翻 status 才知道自己在哪个罐）",
    listed.isolatedWindowId === iso, JSON.stringify({ isolatedWindowId: listed.isolatedWindowId, iso }));
  check("(8) 每行带 incognito：罐里的 true、用户罐里的 false",
    isoRow?.incognito === true && userRow?.incognito === false,
    JSON.stringify({ iso: isoRow?.incognito, user: userRow?.incognito }));

  const info = await ctx.cmdBrowserInfo();
  check("(8) browser.info 带 incognitoAllowed / isolatedWindowId",
    info.incognitoAllowed === true && info.isolatedWindowId === iso,
    JSON.stringify({ allowed: info.incognitoAllowed, isolatedWindowId: info.isolatedWindowId }));

  await ctx.runCommand("profile.close", {});
  const afterList = await ctx.cmdTabsList();
  const afterInfo = await ctx.cmdBrowserInfo();
  check("(8) 关掉之后两处都回到 null（不许拿一个废 id 糊模型）",
    afterList.isolatedWindowId === null && afterInfo.isolatedWindowId === null,
    JSON.stringify({ list: afterList.isolatedWindowId, info: afterInfo.isolatedWindowId }));
}

/* A —— 权限新鲜度：缓存说「没权限」，但用户刚在扩展管理页把开关打开 */
{
  // A1：**闸门自己**的新鲜度（不指望 launch 那条入口替它刷新）。
  // 修之前：`ensureIsolatedWindow` 只读缓存，false 一旦攒进 worker 就一直拒到 worker 被回收。
  // 用户的动作是「刚打开开关」，模型的入口却可能是 `tabs.open{jar:'incognito'}`——同一个
  // 权限，从哪儿进来都得立刻算数，否则失败文案会把人指去做一件他已经做完的事。
  const a1 = await bootIsolated();
  const cached = await a1.ctx.cmdProfileStatus(); // 把 false 写进 worker 生命周期
  check("(A1) 前提：这一刻 status 读到 false，缓存里也是 false", cached.incognitoAllowed === false);

  a1.model.incognitoAllowed = true; // 用户刚在扩展管理页打开「在无痕/InPrivate 中允许」
  // 这里必须把错误捕住：这条断言不成立时台子要报一条干净的 FAIL，而不是整台崩在 A1
  //（崩掉会让 A2/A3/B/C 全都不再执行，剩下的缺陷在统计里就整片消失）。
  const attempt = await a1.ctx.runCommand("tabs.open",
    { url: "https://fresh.test/", wait: false, group: false, policy: { jar: "incognito" } })
    .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error: String(error?.message ?? error) }));
  const opened = attempt.ok ? attempt.value : null;
  check("(A1) 不走 launch：tabs.open{jar:incognito} 也必须当场建罐建页（失败路径要重读一次权限）",
    attempt.ok && opened?.isolated === true && opened?.incognito === true
      && a1.model.tabs.get(opened.tabId)?.incognito === true,
    attempt.ok
      ? JSON.stringify({ tabId: opened?.tabId, isolated: opened?.isolated, incognito: a1.model.tabs.get(opened?.tabId)?.incognito })
      : `没建成，被拒：${attempt.error.slice(0, 46)}`);
  check("(A1) 建出来的是真的无痕窗口（不是把页塞进用户窗口再自称 isolated）",
    a1.model.calls.windowsCreate === 1 && a1.model.windows.get(opened?.windowId)?.incognito === true,
    JSON.stringify({ windowsCreate: a1.model.calls.windowsCreate, window: a1.model.windows.get(opened?.windowId) }));

  // A2：读命令报的是**此刻**的真实值。修之前它读缓存：用户刚打开的开关在这里仍然是 false，
  // 而 `profile.status` 恰恰是排障的人（和模型）第一个会去看的那条命令。
  const a2 = await bootIsolated();
  check("(A2) 前提：先让 worker 缓存住 false", (await a2.ctx.cmdProfileStatus()).incognitoAllowed === false);
  a2.model.incognitoAllowed = true;
  const fresh = await a2.ctx.cmdProfileStatus();
  check("(A2) 用户刚打开开关：status 当场报 true（不许报缓存里的旧答案）",
    fresh.incognitoAllowed === true, String(fresh.incognitoAllowed));

  // A3：`browser.info` 同样现读（它本来就是回答「现在到底行不行」的那条）。
  const a3 = await bootIsolated();
  await a3.ctx.cmdProfileStatus(); // 缓存 false ...
  a3.model.incognitoAllowed = true; // ... 然后用户打开了开关
  const info = await a3.ctx.cmdBrowserInfo();
  check("(A3) browser.info 也现读：开关刚打开就报 true",
    info.incognitoAllowed === true, String(info.incognitoAllowed));
}

/* B —— 分罐计数：用户自己也开着无痕窗口时，不许把别人的罐算成「隔离实例」 */
{
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  // 用户自己先开着一个无痕窗口，里面两页（他自己那页是那个窗口的当前页）。
  // 它排在查询顺序的**前面**，所以「取第一个 active 的无痕页」这种写法一定会挑到它。
  const userIso = model.addWindow({ incognito: true });
  const u1 = model.addTab(userIso, "https://users-own-incognito.test/1");
  model.addTab(userIso, "https://users-own-incognito.test/2");
  model.tabs.get(u1).active = true;

  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  const isoTab = model.tabsInWindow(iso)[0].id;
  check("(B) 前提：两个无痕窗口并存，隔离窗口里只有 1 页",
    model.windows.get(iso)?.incognito === true && model.windows.get(userIso)?.incognito === true
      && model.tabsInWindow(iso).length === 1,
    JSON.stringify({ iso, userIso, inIso: model.tabsInWindow(iso).length }));

  const status = await ctx.cmdProfileStatus();
  // 修之前：`isolated.tabs` / `isolated.active` 用的是**全局**无痕标签页，于是用户自己的
  // 无痕窗口被算进「隔离实例」，`active` 还会指到用户那一页上——模型据此会以为
  // 「不带 tabId 的命令会打到我这页」，而实际罐路由和这一页毫无关系。
  check("(B) isolated.tabs 只数隔离窗口里的页（用户自己的无痕页不算）",
    status.isolated?.tabs === 1,
    JSON.stringify({ isolated: status.isolated, inIso: model.tabsInWindow(iso).length }));
  check("(B) isolated.active 只能是隔离窗口里的 id（不许指到用户自己那一页）",
    status.isolated?.active === isoTab, JSON.stringify({ active: status.isolated?.active, isoTab, usersOwn: u1 }));
  // 全局口径仍然照旧：`incognito` 两项数的是**所有**无痕窗口，别在修 A 的时候把它一起改坏。
  check("(B) 全局无痕口径照旧（incognito.windows/tabs 仍是全局，normal 两项照旧）",
    status.incognito.windows === 2 && status.incognito.tabs === 3
      && status.normal.windows === 1 && status.normal.tabs === 0,
    JSON.stringify({ incognito: status.incognito, normal: status.normal }));

  // `tabs.list` 的 incognito 是**逐页**的事实：用户自己无痕窗口里的页也是 true，
  // 但「隔离实例」只有我们那一个 windowId——两个概念不许混成一个。
  const listed = await ctx.cmdTabsList();
  const ownRow = listed.tabs.find((t) => t.id === u1);
  check("(B) 用户自己的无痕页也标 incognito:true，但 isolatedWindowId 仍只指我们的罐",
    ownRow?.incognito === true && ownRow?.windowId === userIso && listed.isolatedWindowId === iso,
    JSON.stringify({ ownIncognito: ownRow?.incognito, ownWindow: ownRow?.windowId, isolatedWindowId: listed.isolatedWindowId }));
}

/* C1 —— 关窗清理的第一条路径：事件（真 Chrome 会为每个标签页广播 tabs.onRemoved） */
{
  const { model, ctx, sandbox, session } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  const a = (await ctx.runCommand("tabs.open",
    { url: "https://a.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  const b = (await ctx.runCommand("tabs.open",
    { url: "https://b.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  await tick(PAST_SUPPRESSION_MS);
  userTouched(model, a);
  await tick();
  check("(C1) 前提：罐里挂着归属 / 让出 / 粘性目标",
    Object.keys((await ctx.syncAgentState()).tabs).length === 2
      && (await ctx.syncAgentState()).yields?.[a] !== undefined
      && (await ctx.syncAgentState()).target === b,
    JSON.stringify(await ctx.syncAgentState()));

  // 用户自己在浏览器里关掉那个无痕窗口。假浏览器的 `windows.remove` 会为窗口里**每个**
  // 标签页广播一次 `tabs.onRemoved(tabId, {isWindowClosing:true})`——真 Chrome 就是这样。
  // 修之前这里是空转的假 listener，于是扩展挂在 onRemoved 上的 `forgetOwned` 从来没被执行过：
  // 关窗之后归属/让出/目标全挂着，直到下一次命令来收尸（甚至烂到浏览器重启）。
  await sandbox.chrome.windows.remove(iso);
  await tick(40); // onRemoved 里那次 forgetOwned 是 void 掉的异步，给它几拍落盘
  const afterEvent = await ctx.syncAgentState();
  check("(C1) 事件一到，归属/让出/目标就已经清干净（不用等下一次命令）",
    Object.keys(afterEvent.tabs).length === 0 && Object.keys(afterEvent.yields).length === 0
      && afterEvent.target === null,
    JSON.stringify(afterEvent));
  check("(C1) 落盘也清了（重启后不许把死 id 读回来）",
    Object.keys(session.agentState?.tabs ?? {}).length === 0
      && Object.keys(session.agentState?.yields ?? {}).length === 0
      && session.agentState?.target === null,
    JSON.stringify({ tabs: Object.keys(session.agentState?.tabs ?? {}), yields: Object.keys(session.agentState?.yields ?? {}), target: session.agentState?.target }));
}

/* C2 —— 关窗清理的第二条路径：兜底扫描（事件没到） */
{
  const { model, ctx, session } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  const a = (await ctx.runCommand("tabs.open",
    { url: "https://a.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  const b = (await ctx.runCommand("tabs.open",
    { url: "https://b.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  await tick(PAST_SUPPRESSION_MS);
  userTouched(model, a);
  await tick();

  // 模拟「事件没到」：浏览器重启过、或者 worker 被回收期间用户把窗口关了——Chrome 侧窗口
  // 和标签页都没了，但扩展**一条 onRemoved 都没收到**。直接在假浏览器里抹掉，不广播。
  for (const tab of model.tabsInWindow(iso)) model.tabs.delete(tab.id);
  model.windows.delete(iso);
  const stale = session.agentState;
  check("(C2) 前提：事件没到，存储里那批已经关掉的 id 还挂着（这就是要兜的脏状态）",
    stale?.tabs?.[a] !== undefined && stale?.yields?.[a] !== undefined && stale?.target === b,
    JSON.stringify({ tabs: Object.keys(stale?.tabs ?? {}), yields: Object.keys(stale?.yields ?? {}), target: stale?.target }));

  // 一次读命令就该把它们扫掉：`isolatedWindow()` 发现窗口没了，顺手把已不存在的 tabId
  // 从归属/让出里清掉。修之前（只清 state.isolated）这批死 id 会一直挂到浏览器重启。
  const status = await ctx.cmdProfileStatus();
  const swept = session.agentState;
  check("(C2) 兜底扫描：下一次读命令就把死 id 全部清掉（tabs / yields / target 一起）",
    Object.keys(swept?.tabs ?? {}).length === 0 && Object.keys(swept?.yields ?? {}).length === 0
      && swept?.target === null,
    JSON.stringify({ tabs: Object.keys(swept?.tabs ?? {}), yields: Object.keys(swept?.yields ?? {}), target: swept?.target }));
  check("(C2) 并且 state.isolated 归 null（窗口没了，记录也不许再挂着）",
    status.isolated === null && (swept?.isolated ?? null) === null,
    JSON.stringify({ status: status.isolated, disk: swept?.isolated ?? null }));
  const afterSweep = await ctx.syncAgentState();
  check("(C2) 内存里那份也同步干净了（下一条命令不会拿旧的归属去判 owned）",
    Object.keys(afterSweep.tabs).length === 0 && Object.keys(afterSweep.yields).length === 0
      && afterSweep.target === null && afterSweep.isolated === null,
    JSON.stringify(afterSweep));
}

/* D —— `profile.close` 的失败路径：`windows.remove` 被拒时**不许假装关掉了** */
{
  const { model, ctx, session } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.runCommand("profile.launch", { url: "https://iso.test/" });
  const iso = launched.windowId;
  const a = (await ctx.runCommand("tabs.open",
    { url: "https://a.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  const b = (await ctx.runCommand("tabs.open",
    { url: "https://b.test/", wait: false, group: false, policy: { jar: "incognito" } })).tabId;
  await tick(PAST_SUPPRESSION_MS);
  userTouched(model, a);
  await tick();
  const before = await ctx.syncAgentState();
  check("(D) 前提：罐里挂着两个归属 / 一条让出 / 粘性目标（否则下面「丢没丢」无从判起）",
    before.tabs?.[a] !== undefined && before.tabs?.[b] !== undefined
      && before.yields?.[a] !== undefined && before.target === b,
    JSON.stringify({ tabs: Object.keys(before.tabs ?? {}), yields: Object.keys(before.yields ?? {}), target: before.target }));

  // 真 Chrome 会拒绝关某些窗口（正在收尾、被策略/别的扩展挡住）。假浏览器的失败注入
  // 会把这次 remove 顶回去，并且**不删窗口、不广播 onRemoved**——于是「实现到底有没有
  // 复查」变成可观测的：这就是上一轮那个「等价变异体」变成不等价的地方。
  model.failWindowsRemoveTimes = 1;
  model.windowsRemoveError = `Cannot remove window with id: ${iso}`;
  const removesBefore = model.calls.windowsRemove ?? 0;
  const failed = await ctx.cmdProfileClose();

  // 修之前：`remove` 之后无条件 `closed:[id]`。假装关掉的下场是最坏的一种——下一次
  // launch 会再开一个无痕窗口，用户屏幕上多一个来路不明的窗口，而状态面说还是同一个。
  check("(D1) remove 被拒时 profile.close 报 closed:[] 并说清原因（不许报「已关」）",
    Array.isArray(failed.closed) && failed.closed.length === 0
      && typeof failed.reason === "string" && failed.reason.length > 0,
    JSON.stringify(failed));
  check("(D1) 而且窗口与标签页都还在（撒谎的反面：它们本该还在），假浏览器记账也证明尝试过且被拒",
    model.windows.has(iso) && model.tabsInWindow(iso).length > 0
      && model.windowsRemoveRejections === 1 && (model.calls.windowsRemove ?? 0) > removesBefore,
    JSON.stringify({ windows: model.windows.size, tabsInWindow: model.tabsInWindow(iso).length, rejections: model.windowsRemoveRejections }));

  const afterFail = await ctx.syncAgentState();
  // 修之前：失败也照清 `state.isolated`。清掉等于「窗口没了」——而窗口明明还在，
  // 下一次 launch 就会再开一个；这里必须内存与**落盘**都还指着那个窗口。
  check("(D2) state.isolated 不许被清（内存 + 落盘）：清了就等于假装窗口没了",
    afterFail.isolated?.windowId === iso && session.agentState?.isolated?.windowId === iso,
    JSON.stringify({ mem: afterFail.isolated, disk: session.agentState?.isolated }));

  // 窗口还在 = 那批标签页还在 = 仍然属于 AI。`forgetOwned` 必须挪到复查**之后**：
  // 修之前它在关窗之前就清，一次失败的 close 会把「还开着的页」的归属/让出/目标一起抹掉，
  // 之后 AI 连自己那些页都关不掉（要先 force），用户看到的是「关一下反而什么都没了」。
  check("(D3) 归属 / 让出 / 目标一个都没丢（forgetOwned 必须在复查之后才许跑）",
    afterFail.tabs?.[a] !== undefined && afterFail.tabs?.[b] !== undefined
      && afterFail.yields?.[a] !== undefined && afterFail.target === b
      && Object.keys(session.agentState?.tabs ?? {}).length === 2
      && Object.keys(session.agentState?.yields ?? {}).length === 1,
    JSON.stringify({ tabs: Object.keys(afterFail.tabs ?? {}), yields: Object.keys(afterFail.yields ?? {}), target: afterFail.target }));

  // 注入次数用完：再调一次必须真的关掉（失败是可重试的，不是把罐永久锁死）。
  const retried = await ctx.cmdProfileClose();
  const afterRetry = await ctx.syncAgentState();
  check("(D4) 重试这次真的关掉了：closed:[iso]、窗口没了、state.isolated 归 null（内存 + 落盘）",
    JSON.stringify(retried.closed) === JSON.stringify([iso]) && !model.windows.has(iso)
      && afterRetry.isolated === null && (session.agentState?.isolated ?? null) === null,
    JSON.stringify({ closed: retried.closed, windows: model.windows.size, mem: afterRetry.isolated, disk: session.agentState?.isolated ?? null }));
  check("(D4) 这一轮才轮到清归属（失败那次一条都没清，成功这次才清干净）",
    Object.keys(afterRetry.tabs ?? {}).length === 0 && Object.keys(afterRetry.yields ?? {}).length === 0
      && afterRetry.target === null
      && Object.keys(session.agentState?.tabs ?? {}).length === 0,
    JSON.stringify(afterRetry));
}

/* 8 —— 罐路由不许串到另一个罐；关窗的复查不许把「已经关了」报成失败（两条都是实测踩到的） */
{
  // (E1) 建完无痕窗口之后，jar=normal 的 tabs.open 必须落在 normal 窗口里。
  //      真 Chrome 的「当前窗口」是**最后被激活过的那个 window**——我们刚建的无痕窗口
  //      即使 focused:false 也会成为它，于是不显式挑窗口就把标签页生进了无痕罐（实测）。
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.cmdProfileLaunch({});
  const iso = launched.windowId;
  check("(E1) 前提：隔离窗口建好了，而且它现在是假浏览器的「当前窗口」",
    Number.isInteger(iso) && model.currentWindowId === iso, `iso=${iso} current=${model.currentWindowId}`);

  const opened = await ctx.cmdTabsOpen({ url: "https://normal.test/", wait: false, policy: { jar: "normal" } });
  const tab = model.tabs.get(opened.tabId);
  check("(E1) jar=normal 的 tabs.open 不许生在无痕窗口里（串罐 = 登录态静默错罐）",
    tab?.incognito !== true && tab?.windowId !== iso,
    JSON.stringify({ windowId: tab?.windowId, incognito: tab?.incognito, iso }));
  check("(E1) 结果里也不许标 incognito", opened.incognito !== true, JSON.stringify(opened.incognito));

  // (E2)/(E3) 显式点了名却和罐矛盾：明确报错，绝不猜着换罐。
  const mismatch = await refusalOf(ctx, "tabs.open",
    { url: "https://x.test/", wait: false, windowId: iso, policy: { jar: "normal" } });
  check("(E2) jar=normal + 显式无痕 windowId → 明确报错",
    mismatch !== null && /无痕窗口/.test(mismatch), String(mismatch).slice(0, 90));
  const normalWin = [...model.windows.values()].find((win) => win.incognito !== true)?.id;
  const mismatch2 = await refusalOf(ctx, "tabs.open",
    { url: "https://x.test/", wait: false, windowId: normalWin, policy: { jar: "incognito" } });
  check("(E3) jar=incognito + 显式普通 windowId → 明确报错",
    mismatch2 !== null && /不是无痕窗口/.test(mismatch2), String(mismatch2).slice(0, 90));
  check("(E2/E3) 两次被拒都是零副作用（没有多出标签页）",
    ![...model.tabs.values()].some((t) => t.url === "https://x.test/"),
    JSON.stringify([...model.tabs.values()].map((t) => t.url)));
}
{
  // (E4) 连一个 normal 窗口都没有时（用户把普通窗口全关了，只剩我们那扇无痕窗）：
  //      也不许把 jar=normal 的标签页塞进无痕窗口——显式开一个 normal 窗口。
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.cmdProfileLaunch({});
  for (const win of [...model.windows.values()]) if (win.incognito !== true) model.windows.delete(win.id);
  for (const [id, tab] of [...model.tabs]) {
    if (model.windows.get(tab.windowId)?.incognito !== true) model.tabs.delete(id);
  }
  model.currentWindowId = launched.windowId;
  const opened = await ctx.cmdTabsOpen({ url: "https://solo.test/", wait: false, policy: { jar: "normal" } });
  const tab = model.tabs.get(opened.tabId);
  check("(E4) 没有任何 normal 窗口时也不许串进无痕窗口（显式开一个 normal 窗口）",
    tab?.incognito !== true && tab?.windowId !== launched.windowId,
    JSON.stringify({ windowId: tab?.windowId, incognito: tab?.incognito, iso: launched.windowId }));
}
{
  // (E5) 关窗的复查要等窗口**真的**从列表里消失。真机时序：`windows.remove` 立刻回来，
  //      窗口还在列表里——只复查一次就会误报「windows.remove 没有生效」。
  const { model, ctx } = await bootIsolated({ incognitoAllowed: true });
  const launched = await ctx.cmdProfileLaunch({ url: "https://iso.test/" });
  const iso = launched.windowId;
  const tabIds = inJar(model, iso);
  model.windowRemoveDelayMs = 160; // 演那个时序
  const closed = await ctx.cmdProfileClose();
  const after = await ctx.syncAgentState();
  check("(E5) 窗口真关了就必须报 closed:[id]，不能报「没生效」",
    JSON.stringify(closed.closed) === JSON.stringify([iso]) && closed.reason === undefined,
    JSON.stringify(closed));
  check("(E5) 关掉之后状态干净（isolated=null、归属清空、目标归位）",
    after.isolated === null && Object.keys(after.tabs ?? {}).length === 0 && after.target === null,
    JSON.stringify({ isolated: after.isolated, tabs: Object.keys(after.tabs ?? {}), target: after.target }));
  check("(E5) 里面那几个标签页确实没了", tabIds.every((id) => !model.tabs.has(id)), JSON.stringify(tabIds));
  check("(E5) 前提：这次确实演了「延迟消失」（否则上面两条测的是同步路径）",
    model.windowRemoveDelayMs > 0 && !model.windows.has(iso));
}

console.log(`\n结论：${fails === 0 ? "隔离实例（无痕罐）的扩展侧台账全部符合契约" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
