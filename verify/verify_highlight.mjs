// AI 高亮框（第 2 项）：AI 正在操作的那一页，页面上有一圈蓝色渐变描边 + 一个小徽标。
//
// 这一台钉的是「它是一层**视觉指示**，不是安全边界」这件事的六条：
//
//   1. 认领（tabs.open / group / activate）时就画上，画在页面的 `<html>` 下、Shadow DOM 里，
//      带 `data-dsh-hold` 标记（读取路径靠它把这层当页面内容摘掉），并**真的**被页面函数执行；
//   2. 目标换走 → 先擦旧的再画新的（同时只有一个）；关掉 `agentHighlight` → 收掉，不画；
//   3. 用户接管 → 徽标变「已让出」（琥珀），而且**只改当前画着的那一页**，不许把框挪到
//      用户刚点开的别的标签页上（那等于谎报 AI 的位置）；
//   4. 页面导航完成 → 补画一次（导航会打掉注入的宿主）；桥断开 / 标签页关闭 / 拆组 → 收掉；
//   5. 截图前隐藏、拍完还原 —— 否则每一张交给模型的截图都镶一圈蓝边；
//   6. 它永远不拦事件（CSS 里 `pointer-events: none`），失败也永远不让命令失败（受限页面、
//      注入抛错），徽标文案写死在扩展里（模型写不进一句系统口吻的话冒充提示）。
//
// 注意：策略（`policy.highlight`）与罐路由一样，是 `runCommand` 进门时记下的**当前策略**，
// 所以这里的每条命令都走 `runCommand`——直接用 `ctx.cmdTabsOpen` 会绕开它，测出来的
// 就不是生产路径。
//
// 用法：
//   node verify/verify_highlight.mjs
//   node verify/verify_highlight.mjs ../../old/background.js    # 对未实现版本判红
import { runInContext, createContext } from "node:vm";
import { bootBackground, makeModel } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
/**
 * 看门狗：这套台里有一块**故意**演「CDP 附着吊住不回来」的用例（预算 2s 那条）。要是
 * 哪天实现把那个预算去掉，阻塞会发生在扩展里，脚本自己不会报错——它会**挂住**，CI 上
 * 表现为「跑了一半没下文」。所以这里给整台一个上界，超了直接判红退出。
 * `unref()` 保证它不拖住正常退出的进程。
 */
const watchdog = setTimeout(() => {
  console.log("FAIL  整套超时（>90s）：某条用例把进程挂住了，先看「附着吊住」那条");
  process.exit(1);
}, 90_000);
watchdog.unref?.();
/**
 * 未捕获异常也要折成一条 FAIL：以前的版本里，某条命令抛错会把整个进程打死（只留 exit
 * code、0 条 FAIL、没有总结），CI 上看起来像「跑了 42 条就没下文」。变异测试就是这么
 * 发现这个风险的，所以这里显式兜住。
 */
process.on("uncaughtException", (error) => {
  console.log(`FAIL  未捕获异常：${String(error?.message ?? error)}`);
  process.exit(1);
});
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const HOST_ID = "__dsh_agent_highlight__";
/**
 * v1.1.5 起「用户接管」的信号是**页面里的真实输入**（切标签页/切窗口只是看，不算）。
 * 信号本身在 `verify_yield.mjs` 里由真探针测；这台子只关心"让出之后框长什么样"，
 * 所以直接投递一次 `Runtime.bindingCalled`——那正是页面探针在真机上产生的东西，
 * 走的是 `chrome.debugger.onEvent` 的真路径，不是替扩展编状态。
 */
const USER_INPUT_BINDING = "__dshUserInput";

/**
 * 一台假页面。那些「页面侧函数」是**真的被执行**的（`document` 是我们给的假件），
 * 所以「宿主长什么样、CSS 里写了什么、徽标文本走没走 textContent」都是测出来的。
 */
function installFakePage(model) {
  const page = {
    host: null,
    children: [],
    shadows: [],
    labels: [],
    payloads: [],
    hideCalls: 0,
    showCalls: 0,
    breakCreate: false,
  };

  const makeTextNode = () => ({
    _text: "",
    set textContent(v) { this._text = String(v); page.labels.push(this._text); },
    get textContent() { return this._text; },
  });

  const makeElement = () => {
    const el = {
      tagName: "DIV",
      id: "",
      attrs: {},
      style: {},
      parentNode: null,
      setAttribute(name, value) { el.attrs[name] = String(value); },
      attachShadow() {
        const root = { _html: "", textNode: null };
        Object.defineProperty(root, "innerHTML", {
          get() { return root._html; },
          set(v) { root._html = String(v); page.shadows.push(String(v)); },
        });
        root.querySelector = (sel) => {
          if (sel !== ".text") return null;
          root.textNode ??= makeTextNode();
          return root.textNode;
        };
        el.shadow = root;
        return root;
      },
      get isConnected() { return el.parentNode !== null; },
    };
    return el;
  };

  const docElement = {
    appendChild(node) {
      node.parentNode = docElement;
      page.children.push(node);
      page.host = node;
    },
    removeChild(node) {
      const at = page.children.indexOf(node);
      if (at >= 0) page.children.splice(at, 1);
      node.parentNode = null;
      if (page.host === node) page.host = page.children[page.children.length - 1] ?? null;
    },
  };

  const document = {
    documentElement: docElement,
    getElementById(id) {
      return page.children.find((node) => node.id === id) ?? null;
    },
    createElement() {
      if (page.breakCreate) throw new Error("boom: 这个页面不让注入");
      return makeElement();
    },
  };

  const ctx = createContext({
    document, window: {}, Date, JSON, Math, String, Number, Object, Boolean, Array,
  });

  // 扩展把自包含函数 toString 之后送进页面：`(function pageXxx(args) {...})(ARG)`。
  // 这里**真的执行**它——不替它编返回值。
  const run = (expr) => {
    const call = /^(\([\s\S]*\}\))\(([\s\S]*)\)$/.exec(expr);
    if (call === null) return undefined;
    const factory = runInContext(call[1], ctx);
    const argText = call[2].trim();
    const arg = argText.length === 0 ? undefined : JSON.parse(argText);
    if (expr.includes("function pageHighlightInject(")) page.payloads.push(arg);
    if (expr.includes("function pageHighlightHide(")) page.hideCalls += 1;
    if (expr.includes("function pageHighlightShow(")) page.showCalls += 1;
    return factory(arg);
  };

  model.dbg.results["Runtime.evaluate"] = (params) => {
    const expr = String(params?.expression ?? "");
    if (!expr.includes("pageHighlight")) return { result: { value: null } };
    try {
      return { result: { value: run(expr) ?? null } };
    } catch (error) {
      return { exceptionDetails: { text: String(error?.message ?? error) } };
    }
  };
  return page;
}

const boot = async () => {
  const model = makeModel();
  const page = installFakePage(model);
  const { ctx } = await bootBackground({ ...(CANDIDATE ? { backgroundPath: CANDIDATE } : {}), model });
  return { model, ctx, page };
};

/** 走生产路径（`runCommand`）开标签页：策略信封只有在那里才会变成「当前策略」。 */
const open = (ctx, params = {}) =>
  ctx.runCommand("tabs.open", { url: "https://agent.test/", wait: false, ...params });
const tabIdOf = async (ctx, params = {}) => (await open(ctx, params)).tabId;

/** 演「用户在那一页上真的动了手」（而不是只切过去看了一眼）。 */
const takeOver = async (model, tabId) => {
  model.fireBinding(Number(tabId), USER_INPUT_BINDING, '"pointerdown"');
  await tick();
};

/* 1 —— 认领时就画上，而且画的东西是我们要的那样 */
{
  const { ctx, page } = await boot();
  const res = await open(ctx);
  check("tabs.open 之后页面上出现了高亮宿主", page.host !== null && page.host.id === HOST_ID, String(page.host?.id));
  check("宿主带 data-dsh-hold 标记（读取路径靠它把这层摘掉）", page.host?.attrs["data-dsh-hold"] === "highlight", JSON.stringify(page.host?.attrs));
  check("宿主对辅助技术隐藏（aria-hidden）", page.host?.attrs["aria-hidden"] === "true");
  check("挂进了 <html> 下", page.children.length === 1 && page.host.parentNode !== null);

  const html = page.shadows.at(-1) ?? "";
  check("是一圈渐变描边（mask-composite: exclude 的经典写法）", html.includes("mask-composite: exclude"), html.slice(0, 40));
  check("蓝色渐变（#22d3ee / #3b82f6 / #6366f1 / #8b5cf6）",
    ["#22d3ee", "#3b82f6", "#6366f1", "#8b5cf6"].every((hex) => html.includes(hex)));
  check("永不拦事件：描边/光晕/徽标都声明了 pointer-events: none",
    (html.match(/pointer-events: none/g) ?? []).length >= 2, String((html.match(/pointer-events: none/g) ?? []).length));
  check("尊重 reduced-motion（动画可以关）", html.includes("prefers-reduced-motion"));
  check("徽标文案是写死的『AI 正在操作』（不是模型给的）", page.labels.at(-1) === "AI 正在操作", JSON.stringify(page.labels));
  check("注入 payload 只有 tone/label 两个字段，label 只能是两个常量之一",
    page.payloads.length === 1
    && Object.keys(page.payloads[0]).sort().join(",") === "label,tone"
    && ["AI 正在操作", "已让出 · 你可以操作"].includes(page.payloads[0].label),
    JSON.stringify(page.payloads.at(-1)));

  const state = await ctx.syncAgentState();
  check("归属表里记下了『哪一页画着框』（活过 service worker 回收）",
    state.highlight?.tabId === res.tabId && state.highlight?.tone === "agent", JSON.stringify(state.highlight));
}

/* 2 —— 换目标：先擦旧的，再画新的，同一时刻只有一个 */
{
  const { ctx, page } = await boot();
  const first = await tabIdOf(ctx);
  const second = await tabIdOf(ctx);
  check("换了目标之后页面上仍然只有一层", page.children.length === 1, String(page.children.length));
  check("旧标签页上的框被擦掉了（不是叠了两层）", page.children[0]?.attrs["data-dsh-hold"] === "highlight");
  const state = await ctx.syncAgentState();
  check("记录跟着换到新标签页", state.highlight?.tabId === second && first !== second, JSON.stringify(state.highlight));
}

/* 3 —— 关掉 agentHighlight：不画，而且把已经画着的收掉 */
{
  const { ctx, page } = await boot();
  await open(ctx);
  check("前提：开着的时候是画上的", page.host !== null);
  await open(ctx, { policy: { highlight: "off" } });
  check("policy.highlight=off 时不画", page.host === null, String(page.host?.id));
  const state = await ctx.syncAgentState();
  check("记录也清空了（不然下次会被当成『已经画着』）", state.highlight === null, JSON.stringify(state.highlight));
}

/* 3b —— 关掉高亮之后，**下一条命令**就把已经挂着的那圈收掉（设置页那句「改完就生效」） */
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  check("前提：开着的时候是画上的", page.host !== null);
  await ctx.runCommand("tabs.list", { policy: { highlight: "off" } }); // 一条纯读命令
  check("一条读命令就收掉了（不必等下一次认领动作）", page.host === null, String(page.host?.id));
  check("记录也清了", (await ctx.syncAgentState()).highlight === null);
  const injected = page.shadows.length;
  model.fireTabUpdated(tab, { status: "complete" });
  await tick();
  check("之后页面自己导航完成，也不会把框按旧策略画回来（读的是策略快照）",
    page.shadows.length === injected && page.host === null);
}

/* 4a —— 只是切过去看一眼：不许变琥珀（v1.1.5 修的正是这件事） */
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  check("前提：认领之后是蓝色", (await ctx.syncAgentState()).highlight?.tone === "agent");

  // 切到 AI 这一页、离开浏览器又回来、打开弹窗——三件"我在看，但我没动"的事。
  model.fireActivated(tab);
  model.fireWindowFocus(1);
  await model.sendRuntimeMessage({ type: "bridgeStatus" });
  await tick();
  const watched = await ctx.syncAgentState();
  check("切过去看只改变不了颜色（仍是 agent，不是琥珀）", watched.highlight?.tone === "agent", JSON.stringify(watched.highlight));
  check("徽标也还是『AI 正在操作』", page.labels.at(-1) === "AI 正在操作", JSON.stringify(page.labels.at(-1)));
  check("也没有记一条让出（否则 AI 的下一步写操作会被误拒）", Object.keys(watched.yields).length === 0, JSON.stringify(watched.yields));

  // 真的动手才变。
  await takeOver(model, tab);
  check("真在页面上动手之后才变琥珀", (await ctx.syncAgentState()).highlight?.tone === "yielded");
  check("徽标这时才变成『已让出 · 你可以操作』", page.labels.at(-1) === "已让出 · 你可以操作", JSON.stringify(page.labels.at(-1)));
}

/* 4 —— 用户接管：徽标变「已让出」，颜色变成琥珀 */
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  await takeOver(model, tab);
  check("前提：让出被记下了", (await ctx.syncAgentState()).yields[tab] !== undefined);
  check("让出之后框还在（用户看得见 AI 停在哪一页）", page.host !== null);
  check("徽标变成『已让出 · 你可以操作』", page.labels.at(-1) === "已让出 · 你可以操作", JSON.stringify(page.labels.at(-1)));
  const html = page.shadows.at(-1) ?? "";
  check("换成了琥珀色渐变（不再是蓝色）", html.includes("#f59e0b") && !html.includes("#22d3ee"), html.slice(0, 40));
  const state = await ctx.syncAgentState();
  check("归属表里的 tone 也跟着变成 yielded", state.highlight?.tone === "yielded", JSON.stringify(state.highlight));
}

/* 4b —— 让出的是**别的**标签页时，框不许挪过去（那会谎报 AI 的位置） */
{
  const { model, ctx, page } = await boot();
  const a = await tabIdOf(ctx);
  const b = await tabIdOf(ctx);
  check("前提：框现在在 b 上", (await ctx.syncAgentState()).highlight?.tabId === b);
  await takeOver(model, a);
  const state = await ctx.syncAgentState();
  check("用户接管 a 之后，框仍然在 b 上（没有被挪到 a）", state.highlight?.tabId === b, JSON.stringify(state.highlight));
  check("b 的徽标也还是『AI 正在操作』", page.labels.at(-1) === "AI 正在操作", JSON.stringify(page.labels.at(-1)));
  check("a 确实被记成让出了", state.yields[a] !== undefined, JSON.stringify(state.yields));
}

/* 4c —— tabs.activate 把标签页要回来：徽标回到蓝色 */
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  await takeOver(model, tab);
  check("前提：已经变成已让出", page.labels.at(-1) === "已让出 · 你可以操作", JSON.stringify(page.labels.at(-1)));
  await ctx.runCommand("tabs.activate", { tabId: tab });
  check("要回来之后徽标回到『AI 正在操作』", page.labels.at(-1) === "AI 正在操作", JSON.stringify(page.labels.at(-1)));
  const state = await ctx.syncAgentState();
  check("记录的 tone 也回到 agent", state.highlight?.tone === "agent", JSON.stringify(state.highlight));
}

/* 5 —— 页面导航完成：宿主随旧文档消失，必须补画 */
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  // 演「导航把整个文档换掉了」：宿主没了，扩展这边的记录还在。
  page.children.length = 0;
  page.host = null;
  model.fireTabUpdated(tab, { status: "complete" });
  await tick();
  check("导航完成后自动补画（不然每次跳转后指示就没了）", page.host !== null, String(page.host?.id));

  const other = model.addTab(1, "https://user.test/");
  const before = page.shadows.length;
  model.fireTabUpdated(other, { status: "complete" });
  await tick();
  check("不是当前目标的那一页加载完成不会凭空长出一圈框", page.shadows.length === before, `${page.shadows.length - before} 次注入`);

  page.children.length = 0;
  page.host = null;
  const beforeLoading = page.shadows.length;
  model.fireTabUpdated(tab, { status: "loading" });
  await tick();
  check("status:loading 不重画（只在文档真的换完之后补）", page.shadows.length === beforeLoading && page.host === null);
}

/* 5b —— 让出状态下的重画，画的还是琥珀色 */
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  await takeOver(model, tab);
  page.children.length = 0;
  page.host = null;
  model.fireTabUpdated(tab, { status: "complete" });
  await tick();
  check("让出状态下导航重画的是琥珀色（状态没被导航洗回蓝色）",
    page.labels.at(-1) === "已让出 · 你可以操作", JSON.stringify(page.labels.at(-1)));
}

/* 5c —— 同一页连发两次「加载完成」：第二次注入必须先把旧宿主删掉，不许叠层 */
// 假页面里「导航」是靠手动清 children 演的，于是「同一页二次注入」这个场景原本从没发生过
// ——`pageHighlightInject` 里那段「先删旧宿主」于是没有任何用例守着（变异测试报的 m28）。
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  const before = page.payloads.length;
  model.fireTabUpdated(tab, { status: "complete" });
  await tick();
  model.fireTabUpdated(tab, { status: "complete" });
  await tick();
  check("两次补画之后页面上仍然只有一层宿主", page.children.length === 1, String(page.children.length));
  check("确实注入了两次（不是压根没画）", page.payloads.length === before + 2, `${page.payloads.length - before} 次`);
}

/* 6 —— 断开 / 关闭 / 拆组：框都要收掉，不留幽灵 */
{
  const { ctx, page } = await boot();
  await open(ctx);
  check("前提：画着", page.host !== null);
  ctx.disconnectNow();
  await tick(60);
  check("桥断开之后框立刻收掉（没人在操作了）", page.host === null, String(page.host?.id));
  check("记录也清空了", (await ctx.syncAgentState()).highlight === null);
}

{
  const { ctx } = await boot();
  const tab = await tabIdOf(ctx);
  const res = await ctx.runCommand("tabs.close", { tabId: tab });
  await tick();
  check("标签页关掉之后记录清空", (await ctx.syncAgentState()).highlight === null, JSON.stringify(res));
}

{
  const { ctx, page } = await boot();
  await open(ctx);
  check("前提：画着", page.host !== null);
  await ctx.runCommand("tabs.ungroup", {});
  await tick();
  check("拆组 = 放手：框跟着撤掉（页面还在，但 AI 已经放手）", page.host === null, String(page.host?.id));
}

/* 7 —— 截图：拍之前藏起来，拍完还原（顺序要对） */
{
  const { model, ctx, page } = await boot();
  await open(ctx);
  const from = model.dbg.log.length;
  await ctx.runCommand("screenshot", {});
  const tail = model.dbg.log.slice(from);
  const atHide = tail.findIndex((e) => e.method === "Runtime.evaluate" && String(e.params?.expression ?? "").includes("pageHighlightHide"));
  const atShot = tail.findIndex((e) => e.method === "Page.captureScreenshot");
  const atShow = tail.findIndex((e) => e.method === "Runtime.evaluate" && String(e.params?.expression ?? "").includes("pageHighlightShow"));
  check("截图前先藏高亮框", atHide >= 0 && atShot > atHide, JSON.stringify({ atHide, atShot }));
  check("拍完之后还原", atShow > atShot, JSON.stringify({ atShot, atShow }));
  check("藏/还原都真的送到了页面", page.hideCalls === 1 && page.showCalls === 1, JSON.stringify({ hide: page.hideCalls, show: page.showCalls }));
  check("拍完之后浏览器标签页里的框恢复正常显示", page.host?.style.display === "", JSON.stringify(page.host?.style.display));
}

/* 7b —— 打印 PDF 也得躲开：`position: fixed` 的描边会在每一页重复 */
{
  const { model, ctx, page } = await boot();
  await open(ctx);
  model.dbg.results["Page.printToPDF"] = { data: "JVBERi0xLjQK" };
  const from = model.dbg.log.length;
  await ctx.runCommand("pdf", {});
  const tail = model.dbg.log.slice(from);
  const atHide = tail.findIndex((e) => e.method === "Runtime.evaluate" && String(e.params?.expression ?? "").includes("pageHighlightHide"));
  const atPrint = tail.findIndex((e) => e.method === "Page.printToPDF");
  const atShow = tail.findIndex((e) => e.method === "Runtime.evaluate" && String(e.params?.expression ?? "").includes("pageHighlightShow"));
  check("打印前也先藏高亮框", atHide >= 0 && atPrint > atHide, JSON.stringify({ atHide, atPrint }));
  check("打印完也还原", atShow > atPrint, JSON.stringify({ atPrint, atShow }));
  check("打印后页面上的框恢复显示", page.host?.style.display === "");
}

/* 8 —— 页面上没有我们的框时，截图不该多发 evaluate（也不该白跑一次藏/还原） */
{
  const { model, ctx } = await boot();
  model.addTab(1, "https://plain.test/");
  const from = model.dbg.log.length;
  await ctx.runCommand("screenshot", {});
  const tail = model.dbg.log.slice(from);
  const touched = tail.filter((e) => e.method === "Runtime.evaluate"
    && /pageHighlight(Hide|Show)/.test(String(e.params?.expression ?? "")));
  check("没框的页面上，截图不藏也不还原（一次 evaluate 都不发）", touched.length === 0, String(touched.length));
  check("截图本身照常发出去", tail.some((e) => e.method === "Page.captureScreenshot"));
}

/* 9 —— 受限页面（chrome://）：不画、不记，但命令不许失败 */
{
  const { model, ctx, page } = await boot();
  const chromeTab = model.addTab(1, "chrome://settings/");
  const res = await ctx.runCommand("tabs.activate", { tabId: chromeTab });
  check("chrome:// 页面上画不了，但不报错也不假装画了", page.host === null && res?.activated === chromeTab, JSON.stringify(res));
  check("也不留幽灵记录（记录只在框真的画上之后才写）",
    (await ctx.syncAgentState()).highlight === null, JSON.stringify((await ctx.syncAgentState()).highlight));
}

/* 9b —— tabs.activate 到**用户的**标签页：不画框，也不为画框挂 debugger */
// 这条不是吹毛求疵：画框要挂 debugger，而挂上去之后那一页的弹窗会按 `dialogPolicy`
// 自动应答（缺省 accept），用户关页面时不再被问「有未保存的内容」。一次 `tabs.activate`
// 不该换来一次潜在的数据丢失。
{
  const { model, ctx, page } = await boot();
  const userTab = model.addTab(1, "https://user.test/");
  const before = model.dbg.attachCount;
  const res = await ctx.runCommand("tabs.activate", { tabId: userTab });
  check("用户自己的页上不画框（那页还不是 AI 的）", page.host === null, String(page.host?.id));
  check("也没有为了画框去挂 debugger", model.dbg.attachCount === before, `attach ${before} -> ${model.dbg.attachCount}`);
  check("该页确实成了默认目标（认领之外的部分照做）",
    res?.agentTargetTabId === userTab && (await ctx.syncAgentState()).target === userTab, JSON.stringify(res));
}

/* 9c —— 把它收进 AI 的组（= 认领）之后，就有框了 */
{
  const { model, ctx, page } = await boot();
  const userTab = model.addTab(1, "https://user.test/");
  const res = await ctx.runCommand("tabs.group", { tabId: userTab });
  check("收进 AI 的组之后就有了高亮框", page.host !== null && res?.owned === true, JSON.stringify(res));
}

/* 9d —— AI **自己**拿到的是受限页（chrome://）：`paintHighlight` 的受限页守卫必须挡住 */
// 9 那条走的是 `tabs.activate`（own:false）→ 压根不尝试画，所以 paintHighlight 的
// 「受限页」分支一直没被测到（变异测试报的 m21）。这一条让 AI 自己开一个 chrome:// 页。
{
  const { ctx, page } = await boot();
  const res = await open(ctx, { url: "chrome://settings/" });
  check("AI 自己开的 chrome:// 页上不画框", page.host === null, String(page.host?.id));
  check("命令照常成功（视觉层不许连坐）", typeof res.tabId === "number" && res.owned === true, JSON.stringify(res));
  check("也不记账（没画上就不写记录）", (await ctx.syncAgentState()).highlight === null);
}

/* 10 —— 注入本身炸了：命令照常成功（视觉层不许连坐命令） */
{
  const { ctx, page } = await boot();
  page.breakCreate = true;
  const res = await open(ctx);
  check("注入抛错时 tabs.open 仍然成功", typeof res.tabId === "number" && res.grouped === true, JSON.stringify(res));
  check("页面上确实没有框", page.host === null);
  check("记录也不留（没画上就不记账）", (await ctx.syncAgentState()).highlight === null);
}

/* 11 —— 画框不等于认领之外的动作：它不改 URL、不激活、不碰归属表里的别的字段 */
{
  const { model, ctx } = await boot();
  const res = await open(ctx);
  const tab = model.tabs.get(res.tabId);
  check("画框没有改标签页地址", tab.url === "https://agent.test/", String(tab.url));
  const state = await ctx.syncAgentState();
  check("画框没有顺手让出/认领别的标签页",
    Object.keys(state.tabs).length === 1 && Object.keys(state.yields).length === 0,
    JSON.stringify({ tabs: Object.keys(state.tabs), yields: state.yields }));
}

/* 12 —— 画框不许拖住命令：CDP 附着吊住不回来时，tabs.open 必须按自己的预算返回 */
{
  const { model, ctx } = await boot();
  model.dbg.attachHang = true; // 「页面卡住」：attach 回调永远不来
  const started = Date.now();
  const res = await open(ctx);
  const elapsed = Date.now() - started;
  check("附着吊住时 tabs.open 仍然返回（预算 2s，不再无限等 CDP）",
    typeof res.tabId === "number" && elapsed < 4000, `${elapsed}ms`);
  check("标签页与认领照做（视觉层失败不影响归属与默认目标）",
    res.owned === true && res.agentTargetTabId === res.tabId && model.tabs.has(res.tabId));
}

/* 13 —— 断桥与「导航完成补画」交错：不许留下擦不掉的残留 */
{
  const { model, ctx, page } = await boot();
  const tab = await tabIdOf(ctx);
  page.children.length = 0;
  page.host = null;
  model.fireTabUpdated(tab, { status: "complete" }); // 补画刚刚开始
  ctx.disconnectNow(); // 同一刻断桥
  await tick(200);
  check("断桥与补画交错之后，页面上没有残留的框", page.host === null, String(page.host?.id));
  check("记录也清干净了（不会留给下一次连接去猜）",
    (await ctx.syncAgentState()).highlight === null, JSON.stringify((await ctx.syncAgentState()).highlight));
}

/* 14 —— service worker 被回收：记录与策略快照都要活下来 */
{
  const model = makeModel();
  const page = installFakePage(model);
  const session = {};
  const first = await bootBackground({ model, sessionStorage: session });
  const opened = await first.ctx.runCommand("tabs.open", { url: "https://agent.test/", wait: false });
  check("前提：第一个 worker 画上了框", page.host !== null);

  // 演 worker 被回收：同一个假浏览器 + 同一份 session，换一个新的扩展上下文。
  const second = await bootBackground({ model, sessionStorage: session });
  const state = await second.ctx.syncAgentState();
  check("新 worker 从 session 里读回『哪一页画着框』",
    state.highlight?.tabId === opened.tabId, JSON.stringify(state.highlight));
  check("策略快照也一起读回来（事件路径不靠模块级 currentPolicy）",
    state.policy?.highlight === "on", JSON.stringify(state.policy));
  page.children.length = 0;
  page.host = null; // 导航把宿主打掉
  model.fireTabUpdated(opened.tabId, { status: "complete" });
  await tick();
  check("新 worker 也能补画（记录活过回收）", page.host !== null);
}

console.log(fails === 0
  ? "\nAI 高亮框：契约成立"
  : `\n${fails} 条不成立`);
process.exit(fails === 0 ? 0 : 1);
