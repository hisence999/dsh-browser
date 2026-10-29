// 用户接管即让出（yield）：在 node:vm 里跑**真实的** extension/background.js，配一台有状态的
// 假浏览器 + 一个能真执行页面探针的假页面（verify/ext_harness.mjs 的 makeInputProbePage）。
//
// v1.1.5 换了信号源，所以这台子整体重写了一遍。旧信号是「用户切到 AI 的标签页」
// （`tabs.onActivated`）与「用户把窗口切回前台」（`windows.onFocusChanged`）——它把
// **只是看着 AI 干活**的人判成了接管：页面立刻变琥珀色、AI 下一条写命令被拒，而用户什么
// 都没做。新信号是**页面里的真实输入**（`isTrusted` 的 pointerdown/click/keydown/input/paste），
// 装在页面里的探针把它报回来（`Runtime.addBinding`）。
//
// 于是这台子两侧都要钉：
//   看 ≠ 动手 —— 切标签页、切窗口、开弹窗、**滚动**（含滚轮、键盘翻页键、拖滚动条、触屏滑动）
//              都不许让出；
//   动手 = 让出 —— 点击/打字/粘贴/拖放立刻让出，并且
//   拒绝侧不变 —— click/input/press/nav/scroll 与 `tabs.close*` 在 `runCommand` 里被拦下，
//              **一条 CDP 都不发**，错误以线协议前缀 `browser-yielded-to-user:` 开头
//              （插件侧 `src/errors.ts` 按它判 `yielded_to_user` + `not_started`，
//              那份对账在 verify_errors.mjs）；`force:true` 放行；读命令与 `tabs.open` 照常。
//
// 还有一条不比功能次要的：**我们自己的输入不许被当成用户的**。扩展用
// `Input.dispatch*` 派发的事件在页面里同样是 `isTrusted`，探针分不出，只能靠时间窗
// （`SELF_INPUT_MS`）压掉——漏了这条，AI 每点一下就会把自己锁死一次。
//
// 断言只落在**函数返回值**、**假浏览器的状态**与**假页面的上报次数**上：vm context 上
// 取不到 `const`（YIELDED_MARKER / USER_INPUT_KINDS / SELF_INPUT_MS 都拿不到），所以这些
// 线协议常量在下面写成字面量——改它们等于改契约，台子红了才对。
import { bootBackground, makeInputProbePage, makeModel } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const MARKER = "browser-yielded-to-user:";
/**
 * 扩展那边"我们派发的事件回报"的配对债过期时间（`SELF_INPUT_TTL_MS`）。写成字面量当契约：
 * 它决定一笔没等到回报的登记最多能吃掉多久之后的真实输入。
 */
const SELF_INPUT_TTL_MS = 1_500;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const none = (state) => Object.keys(state.yields).length === 0;
const yieldsOf = async (ctx) => (await ctx.syncAgentState()).yields;

const bootYield = async () => {
  const model = makeModel();
  const page = makeInputProbePage(model);
  // 页面里只认探针那一段注入：其余 evaluate（高亮/几何）一律回 null——这组断言不测画框，
  // 但必须让**真**探针代码跑起来，否则下面那些过滤规则全是自说自话。
  model.dbg.results["Runtime.evaluate"] = (params) => page.handle(params) ?? { result: { value: null } };
  const local = {};
  const session = {};
  const { ctx } = await bootBackground({ model, storage: local, sessionStorage: session });
  return { model, ctx, page, local, session };
};

/** 打开一个 AI 自己的标签页。 */
const openAgentTab = async (ctx, url = "https://agent.test/") =>
  (await ctx.cmdTabsOpen({ url, wait: false })).tabId;

/** 演「用户在那一页上真的动了手」：页面探针 → binding → 扩展的让出判定。 */
const userTouch = async (page, tabId, kind = "pointerdown", fields) => {
  const reported = page.fire(tabId, kind, fields);
  await tick();
  return reported;
};

const refusalOf = async (ctx, command, params) =>
  ctx.runCommand(command, params).then(() => null, (e) => String(e?.message ?? e));

/* 1 —— 「只是看」不算接管（v1.1.5 的全部意义所在） */
{
  const { model, ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  check("tabs.open 之后探针就装好了（信号通道必须在用户动手之前存在）",
    page.isInstalled() && page.registeredKinds().length === 5, `injections=${page.injections()} kinds=${page.registeredKinds().join("/")}`);

  model.fireActivated(agent); // 用户切到 AI 的标签页
  await tick();
  check("用户切到 AI 的标签页、什么都没做 → 不让出（旧版这里立刻变琥珀色）",
    none(await ctx.syncAgentState()), JSON.stringify(await yieldsOf(ctx)));

  model.fireWindowFocus(1); // 离开浏览器又回来，看的还是这一页
  await tick();
  check("用户离开浏览器又回来、当前页正是 AI 那一页 → 也不让出",
    none(await ctx.syncAgentState()), JSON.stringify(await yieldsOf(ctx)));

  await model.sendRuntimeMessage({ type: "bridgeStatus" }); // 打开扩展弹窗
  await tick();
  check("打开弹窗看一眼状态 → 不让出", none(await ctx.syncAgentState()), JSON.stringify(await yieldsOf(ctx)));

  // 让出是「拒绝」的前置：没有让出就说明 AI 照常能干活。
  const logBefore = model.dbg.log.length;
  const msg = await refusalOf(ctx, "scroll", { y: 200 });
  check("所以 AI 照常可以继续操作（没有人被误判成接管）",
    !String(msg).startsWith(MARKER) && model.dbg.log.length > logBefore,
    `${String(msg).slice(0, 46)} · CDP ${model.dbg.log.length - logBefore} 条`);
}

/* 2 —— 动手就算：让出 + 拒绝侧五条写命令，一条 CDP 都不发 */
{
  const { model, ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  model.fireActivated(agent);
  await tick();
  check("前提：切换本身没有让出", none(await ctx.syncAgentState()));

  const reported = await userTouch(page, agent, "pointerdown");
  const state = await ctx.syncAgentState();
  check("用户在那一页上点了一下 → 让出，reason=user_input",
    state.yields[agent]?.reason === "user_input", JSON.stringify(state.yields));
  check("这条让出是页面里真的报了输入换来的（binding 真回到过扩展一次）",
    reported === 1 && model.dbg.bindings.length === 1, `reported=${reported} bindings=${model.dbg.bindings.length}`);

  const before = { attach: model.dbg.attachCount, log: model.dbg.log.length, remove: model.calls.remove };
  for (const [command, params] of [
    ["click", { selector: "#x" }],
    ["input", { selector: "#x", value: "v" }],
    ["press", { key: "Enter" }],
    ["nav", { url: "https://elsewhere.test/" }],
    ["scroll", { y: 200 }],
  ]) {
    const msg = await refusalOf(ctx, command, params);
    check(`让出期间 ${command} 被拦下，且前缀是线协议`,
      msg !== null && msg.startsWith(MARKER), (msg ?? "（没有被拦！真的发出去了）").slice(0, 74));
  }
  check("这五条命令零 CDP、连 debugger 都没附着（拦在派发之前，不是拦在结果之后）",
    model.dbg.log.length === before.log && model.dbg.attachCount === before.attach,
    `新 CDP=${model.dbg.log.length - before.log} 新附着=${model.dbg.attachCount - before.attach}`);
  check("导航也没真的发生（标签页地址没变）",
    model.tabs.get(agent).url === "https://agent.test/" && model.calls.remove === before.remove,
    `url=${model.tabs.get(agent).url}`);

  // 闸门必须是窄的：读命令照常回话，不然模型连「现在到底怎么了我该等还是该绕」都问不出来。
  const listed = await ctx.runCommand("tabs.list", {});
  check("让出只拦写操作：tabs.list 照常回话", listed?.count >= 1, JSON.stringify({ count: listed?.count }));
}

/* 3 —— 其它几种真实输入同样算（键盘 / 输入框 / 粘贴） */
for (const kind of ["keydown", "input", "paste"]) {
  const { ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  await userTouch(page, agent, kind, kind === "keydown" ? { key: "a", target: { tagName: "BODY" } } : {});
  check(`真实输入 ${kind} 同样让出`,
    (await yieldsOf(ctx))[agent]?.reason === "user_input", JSON.stringify(await yieldsOf(ctx)));
}

/* 4 —— 页面侧过滤：看着像"动过"，其实不是 */
{
  const { model, ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);

  check("探针注册的种类恰好是五种，wheel 根本不在里面（滚动不算接管）",
    page.registeredKinds().sort().join() === ["click", "input", "keydown", "paste", "pointerdown"].sort().join(),
    page.registeredKinds().join("/"));
  check("滚轮 / scroll 事件不上报", page.fire(agent, "wheel") === 0 && page.fire(agent, "scroll") === 0);

  check("脚本合成的假事件（isTrusted:false）不算——模型自己跑的 .click() 不许把它自己变成接管",
    page.fire(agent, "pointerdown", { isTrusted: false }) === 0);
  // 逐个处理器都要自己判 `isTrusted`：只留一条通用判断会漏掉 click / input / paste 那三条
  // （变异测试 m23/m24 正是这么活下来的，所以这里按种类一条条钉）。
  check("合成的触屏 click（isTrusted:false）也不算",
    page.fire(agent, "click", { isTrusted: false, pointerType: "touch" }) === 0);
  check("合成的 input / paste（isTrusted:false）也不算",
    page.fire(agent, "input", { isTrusted: false }) === 0 && page.fire(agent, "paste", { isTrusted: false }) === 0);

  const scroller = { tagName: "HTML", clientWidth: 800, clientHeight: 600, scrollHeight: 2400, scrollWidth: 800 };
  // 滚动条画在内容盒**外面**：真机上点在它上面时 offsetX ≈ clientWidth..clientWidth+17。
  check("落在滚动条上的按下不算（offsetX 超出内容宽 = 在拖滚动条）",
    page.fire(agent, "pointerdown", { target: scroller, offsetX: 805, offsetY: 40 }) === 0);
  check("正好压在边界（offsetX === clientWidth）也算滚动条",
    page.fire(agent, "pointerdown", { target: scroller, offsetX: 800, offsetY: 40 }) === 0);
  check("同一个容器、点在内容区里 → 算",
    page.fire(agent, "pointerdown", { target: scroller, offsetX: 300, offsetY: 40 }) === 1);
  const inline = { tagName: "A", clientWidth: 0, clientHeight: 0, scrollHeight: 0, scrollWidth: 0 };
  check("行内元素（clientWidth 为 0）上的点击不被滚动条规则吞掉",
    page.fire(agent, "pointerdown", { target: inline }) === 1);

  check("键盘翻页键（焦点不在可编辑元素）不算：用它读长页面不该让出",
    page.fire(agent, "keydown", { key: "PageDown", target: { tagName: "BODY" } }) === 0);
  check("方向键 / 空格 / Home / End 同理不算",
    ["ArrowDown", "ArrowUp", " ", "Home", "End"].every((key) =>
      page.fire(agent, "keydown", { key, target: { tagName: "BODY" } }) === 0));
  check("同样的键按在输入框里 → 算（那是在编辑，不是在翻页）",
    page.fire(agent, "keydown", { key: "PageDown", target: { tagName: "INPUT" } }) === 1);
  check("contenteditable 里也算",
    page.fire(agent, "keydown", { key: "ArrowLeft", target: { tagName: "DIV", isContentEditable: true } }) === 1);
  check("普通字符键不算翻页键 → 算",
    page.fire(agent, "keydown", { key: "a", target: { tagName: "BODY" } }) === 1);

  check("触屏的 pointerdown（可能是滑动）不算",
    page.fire(agent, "pointerdown", { pointerType: "touch" }) === 0);
  check("触屏真的点了一下（click）→ 算",
    page.fire(agent, "click", { pointerType: "touch" }) === 1);
  check("鼠标的 click 不重复上报（pointerdown 已经报过这一次点击）",
    page.fire(agent, "click", { pointerType: "mouse" }) === 0);

  // 过滤之后真实操作仍然要落到让出上：别把规则写成"什么都拦"。
  // 注意要先让出去那条异步链跑完（探针 → binding → noteUserInput → 落盘），
  // 否则读到的还是上一刻的空状态，这条会以"没让出"的样子假红。
  await tick(40);
  check("上面那次内容区点击确实让出了（过滤没有把真实操作一起吞掉）",
    (await yieldsOf(ctx))[agent]?.reason === "user_input", JSON.stringify(await yieldsOf(ctx)));
}

/* 5 —— 我们自己派发的输入不许被当成用户的：按「派发 → 回报」配对，不看时间 */
{
  // (0) 映射表本身：漏登记 = AI 自锁，多登记 = 吞掉用户输入，两种错都得当场红。
  {
    const { ctx } = await bootYield();
    const k = (method, params) => ctx.selfInputKindsOf(method, params).join("/");
    check("映射：mousePressed → pointerdown", k("Input.dispatchMouseEvent", { type: "mousePressed" }) === "pointerdown");
    check("映射：mouseReleased 不登记（探针只认触屏 click，登记了就是一笔会过期的债）",
      k("Input.dispatchMouseEvent", { type: "mouseReleased" }) === "");
    check("映射：touchEnd → click", k("Input.dispatchTouchEvent", { type: "touchEnd" }) === "click");
    check("映射：keyDown 带 text → keydown + input（`input` 的 type 模式就是这条路，只登记 keydown 会自锁）",
      k("Input.dispatchKeyEvent", { type: "keyDown", key: "a", text: "a" }) === "keydown/input");
    check("映射：rawKeyDown 带 text 同理（press Enter 走这条）",
      k("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", text: "\r" }) === "keydown/input");
    check("映射：keyUp 不登记", k("Input.dispatchKeyEvent", { type: "keyUp", key: "a" }) === "");
    check("映射：insertText → input", k("Input.insertText", { text: "han" }) === "input");
    check("映射：读命令的 evaluate 不登记（它不会打字；登记了等于用户看完页面第一下敲键盘白敲）",
      k("Runtime.evaluate", { userGesture: true }) === "");
  }

  // (a) press 派发 rawKeyDown(Enter) + keyUp → 同种类的第一条回报被消账。
  const a = await bootYield();
  const agentA = await openAgentTab(a.ctx);
  const pressed = await refusalOf(a.ctx, "press", { key: "Enter", tabId: agentA });
  check("前提：AI 的 press 真的发出去了（否则下面测的不是抑制窗）",
    !String(pressed).startsWith(MARKER), String(pressed).slice(0, 60));
  const echoed = a.page.fire(agentA, "keydown", { key: "Enter", target: { tagName: "BODY" } });
  await tick();
  check("我们自己派发的按键在页面里也是可信事件：同种类的报告被当回声丢掉",
    echoed === 1 && none(await a.ctx.syncAgentState()), JSON.stringify(await yieldsOf(a.ctx)));

  // (b) 但 press 造不出 pointerdown：紧接着的真实点击必须照样算（别把用户的点击连坐掉）。
  const b = await bootYield();
  const agentB = await openAgentTab(b.ctx);
  await refusalOf(b.ctx, "press", { key: "Enter", tabId: agentB });
  b.page.fire(agentB, "pointerdown");
  await tick(40);
  check("抑制按种类算：press 之后用户的真实**点击**照常算接管",
    (await yieldsOf(b.ctx))[agentB]?.reason === "user_input", JSON.stringify(await yieldsOf(b.ctx)));

  // (c) 模型自己用 browser_evaluate 打字：`execCommand('insertText')` 造出的是**可信** input，
  //     不压掉的话模型填完字就把自己判成"用户接管"，下一条写命令被拒在自己刚操作过的页上。
  const c = await bootYield();
  const agentC = await openAgentTab(c.ctx);
  await refusalOf(c.ctx, "eval", { expression: "document.execCommand('insertText', false, 'x')", tabId: agentC });
  const typed = c.page.fire(agentC, "input");
  await tick();
  check("browser_evaluate 里 execCommand 打出的可信 input 被当回声（否则模型自锁）",
    typed === 1 && none(await c.ctx.syncAgentState()), JSON.stringify(await yieldsOf(c.ctx)));

  // (d) 读命令不许连坐：它们也带 userGesture:true，但不会打字。
  const d = await bootYield();
  const agentD = await openAgentTab(d.ctx);
  await refusalOf(d.ctx, "content", { tabId: agentD });
  d.page.fire(agentD, "input");
  await tick(40);
  check("读命令（content）之后的真实 input 不被连坐",
    (await yieldsOf(d.ctx))[agentD]?.reason === "user_input", JSON.stringify(await yieldsOf(d.ctx)));

  // (e) ★ 重点：回报**迟到**也不算用户输入。旧实现是 400ms 时间窗，页面一慢就
  //     "自己点自己被判成用户接管"（AI 把自己锁死）——这条断言就是那个边界的定向证伪。
  const e = await bootYield();
  const agentE = await openAgentTab(e.ctx);
  await refusalOf(e.ctx, "press", { key: "Enter", tabId: agentE });
  await tick(800); // 远超旧的 400ms 窗
  const late = e.page.fire(agentE, "keydown", { key: "Enter", target: { tagName: "BODY" } });
  await tick(40);
  check("迟到的回报（800ms 后）仍然被消账：配对不看时间，慢页面不会自锁",
    late === 1 && none(await e.ctx.syncAgentState()), JSON.stringify(await yieldsOf(e.ctx)));

  // (f) 但债要会过期：登记了却没等到回报（点进没装探针的区域），TTL 之后不许再吞真实输入。
  const f = await bootYield();
  const agentF = await openAgentTab(f.ctx);
  await refusalOf(f.ctx, "press", { key: "Enter", tabId: agentF }); // 登记了 keydown/input，但没人回报
  await tick(SELF_INPUT_TTL_MS + 150); // > TTL：那笔没等到回报的登记必须作废
  f.page.fire(agentF, "keydown", { key: "Enter", target: { tagName: "BODY" } });
  await tick(40);
  check("TTL（1.5s）之后，那笔没等到回报的登记不再吞真实输入",
    (await yieldsOf(f.ctx))[agentF]?.reason === "user_input", JSON.stringify(await yieldsOf(f.ctx)));
}

/* 5b —— 让出状态的写入要串行：报告与清场交错时不许把让出"复活" */
{
  const { model, ctx } = await bootYield();
  const agent = await openAgentTab(ctx);
  // 生产形态：用户点一下 AI 那页（binding 报告在飞）→ 立刻切走（onActivated → 清场）。
  await Promise.all([ctx.noteUserInput(agent, "pointerdown"), ctx.clearAllYields()]);
  const after = await yieldsOf(ctx);
  check("报告与清场交错，最后状态是清场（让出不被复活）",
    Object.keys(after).length === 0, JSON.stringify(after));
  check("前提：这次交错里 agent 标签页确实是目标（否则清场分支走的是另一条路）",
    (await ctx.syncAgentState()).target === agent || !model.tabs.has(agent), `target=${(await ctx.syncAgentState()).target}`);
}

/* 6 —— 四条解除路径，缺一条就会把 AI 永久锁死 */
{
  // (a) 用户切到他自己的标签页：最常见的「看一眼就走」
  const a = await bootYield();
  const agentA = await openAgentTab(a.ctx);
  const userTab = a.model.addTab(1, "https://user.test/");
  await userTouch(a.page, agentA);
  check("前提：接管已被记下", (await yieldsOf(a.ctx))[agentA] !== undefined);
  a.model.fireActivated(userTab);
  await tick();
  check("(a) 用户切到自己的标签页 → 让出自动解除（看一眼就走不会被锁死）",
    none(await a.ctx.syncAgentState()));
  // 判据是「CDP 命令真的发出去过」而不是「附着数变多」：认领标签页时会附着（探针/高亮），
  // 拿附着数当判据会把「一切正常」判成红。
  const logA = a.model.dbg.log.length;
  const afterA = await refusalOf(a.ctx, "click", { selector: "#x" });
  check("(a) 解除之后写命令不再被让出拦下，真的走到了浏览器",
    !String(afterA).startsWith(MARKER) && a.model.dbg.log.length > logA,
    `${String(afterA).slice(0, 60)} · CDP ${a.model.dbg.log.length - logA} 条`);

  // (a2) 用户在**已经被放手的 AI 页**上动手：探针还在（`forgetOwned` 不撤 binding），
  //      所以这条报告会到达扩展，而那一页已经不属于 AI —— 说明他不在 AI 的页上了，清场。
  //
  //      这条分支在生产上**只有这个形态可达**（用户的页面上根本没有探针，见 §12d），
  //      所以早先那种"切到用户页再 fire"的写法是空跑：切页那一刻 onActivated 已经清完了，
  //      删掉 fire 断言照样绿（变异 m18 就是这么活下来的）。
  const a2 = await bootYield();
  const kept = await openAgentTab(a2.ctx);           // 先开一页并让出它
  await userTouch(a2.page, kept);
  // 第二页**不归组**：归组的页即使从归属表里删掉，也仍然算 AI 的（`ownedTabIds` 按组算），
  // 那就走不到"非 AI 页"那条分支了。
  const released = (await a2.ctx.cmdTabsOpen({ url: "https://next.test/", wait: false, group: false })).tabId;
  check("前提：kept 仍挂着让出、released 是当前目标",
    (await yieldsOf(a2.ctx))[kept] !== undefined && (await a2.ctx.syncAgentState()).target === released,
    JSON.stringify({ yields: await yieldsOf(a2.ctx), target: (await a2.ctx.syncAgentState()).target }));
  await a2.ctx.forgetOwned([released]); // 放手（`tabs.ungroup` / 关组走的就是这条）
  const afterRelease = await a2.ctx.syncAgentState();
  check("前提：released 不再是 AI 的页、探针还挂着，而 kept 的让出没被连带清掉",
    !Object.keys(afterRelease.tabs).includes(String(released))
    && a2.page.isInstalled()
    && afterRelease.yields[kept] !== undefined,
    JSON.stringify({ tabs: Object.keys(afterRelease.tabs), yields: afterRelease.yields }));
  const reportedA2 = a2.page.fire(released, "pointerdown");
  await tick(40);
  check("(a2) 已被放手的页面上报输入 → 清场（人显然不在 AI 那一页上了）",
    reportedA2 === 1 && Object.keys(await yieldsOf(a2.ctx)).length === 0,
    JSON.stringify({ reported: reportedA2, yields: await yieldsOf(a2.ctx) }));

  // (b) 所有窗口失焦 = 用户去别的应用了
  const b = await bootYield();
  const agentB = await openAgentTab(b.ctx);
  await userTouch(b.page, agentB);
  b.model.fireWindowFocus(-1); // chrome.windows.WINDOW_ID_NONE
  await tick();
  check("(b) 所有窗口都失焦 → 让出清空（用户去别的应用不算在跟 AI 抢页面）",
    none(await b.ctx.syncAgentState()), JSON.stringify(await yieldsOf(b.ctx)));

  // (c) tabs.activate：用户确认之后，模型自己能把标签页要回来
  const c = await bootYield();
  const agentC = await openAgentTab(c.ctx);
  await userTouch(c.page, agentC);
  const claimed = await c.ctx.runCommand("tabs.activate", { tabId: agentC });
  const stateC = await c.ctx.syncAgentState();
  check("(c) tabs.activate 是要回来的手势：让出解除、目标重新指到它",
    stateC.yields[agentC] === undefined && stateC.target === agentC && claimed.agentTargetTabId === agentC,
    JSON.stringify({ yields: stateC.yields, target: stateC.target }));
  const afterC = await refusalOf(c.ctx, "click", { selector: "#x" });
  check("(c) 要回来之后写命令重新可用", !String(afterC).startsWith(MARKER), String(afterC).slice(0, 60));
}

/* 7 —— policy.takeover:'ignore' 能关掉这条保护，而且只认这一位 */
{
  const { model, ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  await userTouch(page, agent);

  const wrongField = await refusalOf(ctx, "click", { selector: "#x", policy: { focus: "auto" } });
  check("policy 里别的位（focus）不能解除让出——只认 takeover 这一位",
    String(wrongField).startsWith(MARKER), String(wrongField).slice(0, 60));

  const logBefore = model.dbg.log.length;
  const ignored = await refusalOf(ctx, "click", { selector: "#x", policy: { takeover: "ignore" } });
  check("takeover:'ignore' 时不拦（配置可以关掉这条保护）",
    !String(ignored).startsWith(MARKER), String(ignored).slice(0, 60));
  check("ignore 是真的放过去了，不是换个地方失败：CDP 命令已经发出去并尝试过",
    model.dbg.log.length > logBefore, `CDP ${model.dbg.log.length - logBefore} 条`);
  check("'ignore' 也不写让出记录（关掉就是关掉，不留半截状态）",
    model.dbg.bindings.length === 1 && (await yieldsOf(ctx))[agent] !== undefined, // 记录是用户动手那次留下的
    JSON.stringify(await yieldsOf(ctx)));
}

/* 8 —— tabs.list 标出让出；标签页被关掉之后不许留下幽灵让出 */
{
  const { model, ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  const user = model.addTab(1, "https://user.test/");
  await userTouch(page, agent);

  const listed = await ctx.cmdTabsList();
  const agentRow = listed.tabs.find((t) => t.id === agent);
  const userRow = listed.tabs.find((t) => t.id === user);
  check("tabs.list 把让出标出来（模型自己就能看见该绕开哪一页）",
    agentRow?.yielded === true && userRow?.yielded === false,
    JSON.stringify({ agent: agentRow?.yielded, user: userRow?.yielded }));

  // 关闭也在让出名单里：关掉用户正看着的那一页**不可恢复**（页面状态、填了一半的表单全没），
  // 比「多点了一下」严重得多。唯一例外是 `force: true`——那本来就是「用户明确让我关」。
  const blockedClose = await refusalOf(ctx, "tabs.close", { tabId: agent });
  check("让出期间关这一页也被拦下（不可恢复，所以按最保守处理）",
    String(blockedClose).startsWith(MARKER), String(blockedClose).slice(0, 70));
  check("让出期间被拒的关闭零副作用（标签页还在，tabs.remove 一次都没发）",
    model.tabs.has(agent) && model.calls.remove === 0, `remove=${model.calls.remove}`);

  const closed = await ctx.runCommand("tabs.close", { tabId: agent, force: true });
  check("force:true（= 用户明确让我关）能穿过让出",
    closed.closed.join() === String(agent), JSON.stringify(closed));
  const state = await ctx.syncAgentState();
  check("关掉之后归属 / 让出 / 目标一起清空（不许留一条「已关闭的标签页还挂着让出」的幽灵状态）",
    Object.keys(state.tabs).length === 0 && Object.keys(state.yields).length === 0 && state.target === null,
    JSON.stringify(state));
}

/* 9 —— 让出是 per-tab 的：自己开新页继续，不需要任何人授权 */
{
  const { ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  await userTouch(page, agent);

  const fresh = await ctx.runCommand("tabs.open", { url: "https://next.test/", wait: false });
  check("让出期间 tabs.open 没被拦（AI 有一条不用问人的自保路径）",
    fresh?.owned === true && fresh.tabId !== agent, JSON.stringify({ tabId: fresh?.tabId, owned: fresh?.owned }));
  const state = await ctx.syncAgentState();
  check("默认目标跟着去了新页，旧那页仍挂着让出",
    state.target === fresh.tabId && state.yields[agent] !== undefined,
    JSON.stringify({ target: state.target, yields: state.yields }));
  const msg = await refusalOf(ctx, "click", { selector: "#x" });
  check("不带 tabId 的写命令落在新页上，不被旧页的让出连坐",
    !String(msg).startsWith(MARKER), String(msg).slice(0, 60));
}

/* 10 —— 导航：探针跟着旧文档一起没了，扩展必须自己补装 */
{
  const { model, ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  const injectionsBefore = page.injections();

  page.dropDocument(); // 新文档：文档级监听 + 安装标记都没了
  check("导航之后探针确实不在了（这正是最危险的空窗：用户动手但没人报）",
    page.fire(agent, "pointerdown") === 0);

  model.fireTabUpdated(agent, { status: "complete" });
  await tick(60);
  check("导航完成时扩展自动补装探针",
    page.injections() === injectionsBefore + 1 && page.isInstalled(), `injections=${page.injections()}`);
  page.fire(agent, "pointerdown"); // 补装之后同一次手势（同样要先等异步链跑完再读状态）
  await tick(40);
  check("补装之后同一个手势重新算接管",
    (await yieldsOf(ctx))[agent]?.reason === "user_input", JSON.stringify(await yieldsOf(ctx)));

  // 反方向：用户自己的页面不该被装上探针（不为"监听"去附着他的页面）。
  const theirs = model.addTab(1, "https://user.test/");
  const beforeUserNav = page.injections();
  model.fireTabUpdated(theirs, { status: "complete" });
  await tick(60);
  check("用户自己的标签页导航完成 → 不装探针", page.injections() === beforeUserNav, `injections=${page.injections()}`);
}

/* 11 —— 弹窗要看得见让出；service worker 被回收后让出还在 */
{
  const { model, ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  await userTouch(page, agent);
  const status = await model.sendRuntimeMessage({ type: "bridgeStatus" });
  check("弹窗看得见哪几页被让出（否则用户那一侧是隐形的）",
    Array.isArray(status?.agent?.yielded) && status.agent.yielded.includes(agent),
    JSON.stringify(status?.agent));
  check("弹窗那次回话照常给出目标页", status?.agent?.targetTabId === agent, JSON.stringify(status?.agent));
}

{
  const local = {};
  const session = {};
  const model = makeModel();
  const page = makeInputProbePage(model);
  model.dbg.results["Runtime.evaluate"] = (params) => page.handle(params) ?? { result: { value: null } };
  const first = await bootBackground({ model, storage: local, sessionStorage: session });
  const agent = (await first.ctx.cmdTabsOpen({ url: "https://agent.test/", wait: false })).tabId;
  await userTouch(page, agent);

  // 同一台假浏览器 + 同一份 storage，换一个全新的 vm context = MV3 的 worker 回收/唤醒
  const revived = await bootBackground({ model, storage: local, sessionStorage: session });
  const msg = await refusalOf(revived.ctx, "click", { selector: "#x" });
  check("回收再唤醒：让出还在，写命令照样被拦（内存标志会丢，session 不会）",
    String(msg).startsWith(MARKER), String(msg).slice(0, 60));
}

/* 12 —— 探针的安装路径不能只有一条（变异 m03/m22/m12/m13/m14 就是从这里活下来的） */
{
  // (a) 高亮关掉时 `syncHighlight` 什么都不做（不附着）——探针不能跟着一起没了，
  //     否则「关掉高亮」会连接管信号一起关掉，而且是静默的。
  const { ctx, page } = await bootYield();
  const agent = (await ctx.runCommand("tabs.open",
    { url: "https://agent.test/", wait: false, group: false, policy: { highlight: "off" } })).tabId;
  check("agentHighlight:off 时认领也照样装探针（否则关掉高亮 = 关掉接管信号）",
    page.isInstalled(), `injections=${page.injections()}`);
  await userTouch(page, agent);
  check("而且真的报得回来：关掉高亮之后用户动手仍然让出",
    (await yieldsOf(ctx))[agent]?.reason === "user_input", JSON.stringify(await yieldsOf(ctx)));
}

{
  // (b) 重复认领不重复注入（`probeArmed` 要记得住）。
  const { ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  const before = page.injections();
  await ctx.runCommand("tabs.activate", { tabId: agent });
  await ctx.runCommand("tabs.activate", { tabId: agent });
  check("重复认领不重复注入探针", page.injections() === before, `${before} → ${page.injections()}`);
}

{
  // (c) 已经让出之后再动手：不重写记录（每敲一个字符都落盘会拖慢，还会让框重播）。
  const { ctx, page } = await bootYield();
  const agent = await openAgentTab(ctx);
  await userTouch(page, agent);
  const first = (await yieldsOf(ctx))[agent]?.at;
  await tick(30);
  page.fire(agent, "pointerdown");
  page.fire(agent, "keydown", { key: "a", target: { tagName: "BODY" } });
  await tick(40);
  check("已经让出之后再动手，不重写那条记录",
    (await yieldsOf(ctx))[agent]?.at === first, `at ${first} → ${(await yieldsOf(ctx))[agent]?.at}`);
}

{
  // (d) 用户的页：就算附着过，也不许装探针（不为"监听"去挂 debugger、不去塞 binding）。
  const { model, ctx, page } = await bootYield();
  await openAgentTab(ctx);
  const theirs = model.addTab(1, "https://user.test/");
  await ctx.runCommand("content", { tabId: theirs }).catch(() => {});
  check("前提：这条读命令确实附着到了用户的页面上（否则下面测的是空集）",
    model.dbg.attached.has(theirs), `attached=${model.dbg.attached.has(theirs)}`);
  const injectionsBefore = page.injections();
  const bindingsToTheirs = model.dbg.log.filter((e) => e.method === "Runtime.addBinding" && e.tabId === theirs).length;
  model.fireTabUpdated(theirs, { status: "complete" });
  await tick(60);
  check("附着过用户页、它导航完成 → 仍然不装探针", page.injections() === injectionsBefore, `injections=${page.injections()}`);
  check("也从没给用户的页发过 Runtime.addBinding", bindingsToTheirs === 0, `bindings=${bindingsToTheirs}`);
}

{
  // (e) 装探针失败一次之后必须能自愈。这是最坏的失效方向（静默、外观毫无差别）：
  //     真机形态是导航完成那一瞬间 evaluate 拿到 `Cannot find default execution context`。
  const { model, ctx, page } = await bootYield();
  // 让探针在这段时间里**一次都装不上**（真机形态：evaluate 撞上
  // `Cannot find default execution context`），之后再放开。
  let probeBroken = true;
  model.dbg.results["Runtime.evaluate"] = (params) => {
    const expression = String(params?.expression ?? "");
    if (probeBroken && expression.includes("function pageInputProbe(")) {
      return { exceptionDetails: { text: "Cannot find default execution context" } };
    }
    return page.handle(params) ?? { result: { value: null } };
  };
  const agent = await openAgentTab(ctx);
  check("前提：这一轮探针一次都没装上（这就是那个静默空窗）", !page.isInstalled(), `installed=${page.isInstalled()}`);
  probeBroken = false; // 页面恢复（真机上就是那个执行上下文回来了）
  await ctx.runCommand("content", { tabId: agent }).catch(() => {});
  check("一条普通读命令就能自愈（不必等下一次认领或导航）", page.isInstalled(), `injections=${page.injections()}`);
  page.fire(agent, "pointerdown");
  await tick(40);
  check("自愈之后用户动手照样算接管",
    (await yieldsOf(ctx))[agent]?.reason === "user_input", JSON.stringify(await yieldsOf(ctx)));
}

{
  // (f) ★ 裸 payload：某些 Chromium 构建给单字符串参数的 binding payload **不带 JSON 引号**
  //     （实际 payload 就是 `pointerdown`）。不兜底的话 `JSON.parse` 必抛 → kind 变空串 →
  //     那笔派发账永远消不掉 → AI 自己的一次真实点击被当成"用户接管"，yield 档下当场自锁。
  //     探针自己会 `JSON.stringify`，所以裸形态只能直接走 `chrome.debugger.onEvent` 真路径。
  const BINDING = "__dshUserInput"; // 线协议契约：扩展侧 `USER_INPUT_BINDING`
  const bare = await bootYield();
  const bareTab = await openAgentTab(bare.ctx);
  await refusalOf(bare.ctx, "press", { key: "Enter", tabId: bareTab }); // 登记一笔 keydown 债
  bare.model.fireBinding(bareTab, BINDING, "keydown"); // 裸 payload，不带引号
  await tick(40);
  check("裸 payload 也认得出 kind：我们自己派发的按键不会被当成用户接管",
    none(await bare.ctx.syncAgentState()), JSON.stringify(await yieldsOf(bare.ctx)));

  // 反过来：没有那笔债时，同一条裸 payload 必须照常算真实输入（兜底不许写成一律吞掉）。
  const bareFree = await bootYield();
  const bareFreeTab = await openAgentTab(bareFree.ctx);
  bareFree.model.fireBinding(bareFreeTab, BINDING, "pointerdown");
  await tick(40);
  check("没有派发账时，同一条裸 payload 仍然算用户接管",
    (await yieldsOf(bareFree.ctx))[bareFreeTab]?.reason === "user_input",
    JSON.stringify(await yieldsOf(bareFree.ctx)));

  // 带引号的正常形态不许被兜底改坏：两种 payload 都要认。
  const quoted = await bootYield();
  const quotedTab = await openAgentTab(quoted.ctx);
  quoted.model.fireBinding(quotedTab, BINDING, JSON.stringify("pointerdown"));
  await tick(40);
  check("带引号的正常 payload 照旧认（两种形态并存）",
    (await yieldsOf(quoted.ctx))[quotedTab]?.reason === "user_input",
    JSON.stringify(await yieldsOf(quoted.ctx)));
}

{
  // (g) ★ `tabs.closeMany` 的让出判定必须**逐项**：旧实现拿"默认目标/活动标签"判整批，
  //     于是"被让出的那页根本不在 tabIds 里"也会把一整批关闭请求全拒，一个都没关。
  const { model, ctx, page } = await bootYield();
  const first = await openAgentTab(ctx, "https://a.test/");
  const second = await openAgentTab(ctx, "https://b.test/"); // 最后认领的 = 默认目标
  await userTouch(page, second);
  check("前提：默认目标已被让出",
    (await yieldsOf(ctx))[second]?.reason === "user_input", JSON.stringify(await yieldsOf(ctx)));
  const cleanBatch = await ctx.runCommand("tabs.closeMany", { tabIds: [first] })
    .then((r) => r, (e) => String(e?.message ?? e));
  check("批量里没有让出的页 → 照关（旧实现会因为默认目标被让出而整批拒绝）",
    typeof cleanBatch === "object" && Array.isArray(cleanBatch.closed) && cleanBatch.closed.includes(first),
    JSON.stringify(cleanBatch).slice(0, 140));

  // 批量里**混进**让出的页：整批拒绝、零副作用，且文案只点出真正被让出的那些。
  const third = await openAgentTab(ctx, "https://c.test/");
  const fourth = await openAgentTab(ctx, "https://d.test/");
  await userTouch(page, fourth);
  const mixed = await refusalOf(ctx, "tabs.closeMany", { tabIds: [third, fourth] });
  check("批量里混进被让出的页 → 整批拦下", String(mixed).startsWith(MARKER), String(mixed).slice(0, 80));
  check("文案只点出被让出的那个（不连坐同批的其它页）",
    String(mixed).includes(`#${fourth}`) && !String(mixed).includes(`#${third}`), String(mixed).slice(0, 140));
  check("零副作用：这一批两个页都还在",
    model.tabs.has(third) && model.tabs.has(fourth), JSON.stringify({ third: model.tabs.has(third), fourth: model.tabs.has(fourth) }));

  // 让出记录挂在一个**已经不存在**的标签页上（扩展还没收到 onRemoved）：它进了批次也不许挡路，
  // 而且要被顺手清掉——否则那条幽灵让出会永远留在存储里。
  const gone = await openAgentTab(ctx, "https://e.test/");
  await userTouch(page, gone);
  model.tabs.delete(gone);
  const later = await openAgentTab(ctx, "https://f.test/");
  const afterStale = await ctx.runCommand("tabs.closeMany", { tabIds: [gone, later] })
    .then((r) => r, (e) => String(e?.message ?? e));
  check("批次里那个页已经没了 → 不吃让出、批量照关",
    typeof afterStale === "object" && Array.isArray(afterStale.closed) && afterStale.closed.includes(later),
    JSON.stringify(afterStale).slice(0, 140));
  check("顺手把那条过期让出清掉", (await yieldsOf(ctx))[gone] === undefined,
    JSON.stringify(await yieldsOf(ctx)));
}

console.log(`\n结论：${fails === 0 ? "看≠动手、动手即让出，四条解除路径与拒绝侧全部符合契约" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
