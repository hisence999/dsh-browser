// 出图（截图 / PDF）在「不产帧」窗口下的行为，以及 emulate 说真话与触摸仿真真的落地。
//
// 用户 2026-10-29 实测三条：
//   ① 窗口最小化时 `browser_screenshot` 吃满 60 秒仍不返回（可见窗口时 449KB JPEG 正常）；
//   ② `device:"reset"` 三处 `.catch(() => {})`，清理失败也回 `{reset:true}` + "reset to default"；
//   ③ 工具说 touch 已启用，页面里 `'ontouchstart' in window` 却是 false。
//
// 真机核对（Edge 156，本会话实测）与调研结论：
//   - 最小化时 `Page.captureScreenshot` 等的是一个"被 present 的合成器帧"，没有内建超时，
//     所以**不报错、只挂住**（Chromium issue 577169255）；没有任何纯 CDP 参数能救，
//     唯一有实践证据的手段是临时还原窗口（可见副作用，本版不做）。
//   - `Emulation.setTouchEmulationEnabled` 只对**之后加载的文档**生效：`navigator.maxTouchPoints`
//     立刻变，`'ontouchstart' in window` 要等一次导航；补 `mobile:true` 也没用（我逐个试过）。
//   - 整页截图（`captureBeyondViewport`）会重置触摸仿真（Chromium 558509412），
//     CDP 会话重建会把仿真整体复位（`EmulationHandler::Disable()`）——两处都要补回来。
//
// 这台验台钉住这四件事：
//   §1 最小化：立刻失败、理由可执行、**一次 CDP 出图调用都不发**
//   §2 挂着不返回：自带预算（验台压到 60ms 级），绝不跟着挂到桥的 60s 天花板
//   §3 reset：任何一步失败 → `reset:false` + 失败步骤；全成功才是 `reset:true`
//   §4 触摸：请求值与页面现场分开报；一次文档加载后才可见；会话重建 / 整页截图之后补回来
//
// 用法：node verify/verify_capture_touch.mjs
import { runInContext } from "node:vm";
import { bootBackground, makeModel } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const errOf = (p) => p.then(() => null, (e) => String(e?.message ?? e));
const short = (value) => JSON.stringify(value)?.slice(0, 160);

/** 「永远不回话」的哨兵值：让"命令挂住"变成一条**失败断言**，而不是让整个验台静默消失。 */
const HUNG = "__hung__";
const orHung = (promise, ms) => Promise.race([
  promise,
  new Promise((resolve) => { setTimeout(() => resolve(HUNG), ms); }),
]);

/**
 * 看门狗：这台验台要测的正是"命令永远不返回"。所以整跑必须有个上限——否则某个
 * 缺陷会让进程在没有待处理句柄时直接退 0，看起来像"通过"（这条教训见 #0023）。
 */
const watchdog = setTimeout(() => {
  console.log("FAIL  看门狗：验台 20 秒内没有跑完（有命令永远没回话——预算没起作用）");
  process.exit(1);
}, 20000);

/** 一台假浏览器 + 一个标签页 + 真扩展代码。 */
async function stage({ minimized = false, tabUrl = "https://fake.test/" } = {}) {
  const model = makeModel();
  const tabId = model.addTab(1, tabUrl);
  if (minimized) model.windows.get(1).state = "minimized";
  const { ctx } = await bootBackground({ model, storage: {}, sessionStorage: {} });
  return { model, ctx, tabId };
}

const sends = (model, method) => model.dbg.sends[method] ?? 0;
/** 最后一次 `Emulation.setTouchEmulationEnabled` 的参数（看我们到底发了什么）。 */
const lastTouchParams = (model) => {
  const hits = model.dbg.log.filter((row) => row.method === "Emulation.setTouchEmulationEnabled");
  return hits.length === 0 ? null : hits[hits.length - 1].params;
};

// ---- §1) 最小化窗口：立刻失败，且一次出图调用都不发 ----
{
  const { model, ctx, tabId } = await stage({ minimized: true });
  const before = sends(model, "Page.captureScreenshot");
  const err = await errOf(ctx.runCommand("screenshot", { tabId }));
  check("§1 最小化时截图立刻失败（不是挂住）", err !== null, String(err)?.slice(0, 80));
  check("§1 文案点明「最小化」并给出下一步（恢复窗口）",
    err !== null && err.includes("最小化") && err.includes("恢复"), String(err)?.slice(0, 120));
  check("§1 一次 Page.captureScreenshot 都没有发出去", sends(model, "Page.captureScreenshot") === before,
    `${sends(model, "Page.captureScreenshot") - before} 次`);

  const pdfErr = await errOf(ctx.runCommand("pdf", { tabId }));
  check("§1 导出 PDF 同样先判窗口状态", pdfErr !== null && pdfErr.includes("最小化"), String(pdfErr)?.slice(0, 80));
  check("§1 一次 Page.printToPDF 都没有发出去", sends(model, "Page.printToPDF") === 0,
    `${sends(model, "Page.printToPDF")} 次`);
}

// ---- 对照：窗口正常时照常出图（别把闸门做成「永远失败」） ----
{
  const { model, ctx, tabId } = await stage();
  const ok = await errOf(ctx.runCommand("screenshot", { tabId }));
  check("§1 对照：窗口正常时截图照常跑", ok === null, String(ok));
  check("§1 对照：真的发了 Page.captureScreenshot", sends(model, "Page.captureScreenshot") === 1,
    `${sends(model, "Page.captureScreenshot")} 次`);
}

// ---- §2) 挂着不返回：按自己的预算放弃，不跟着挂 60s ----
{
  const { model, ctx, tabId } = await stage();
  // 真机形态：调用发出去之后浏览器永远不回话（不是报错）。
  model.dbg.results["Page.captureScreenshot"] = () => new Promise(() => {});
  runInContext("CAPTURE_BUDGET_MS = 60", ctx);
  const started = Date.now();
  // 3 秒护栏：预算要是没生效，这条命令会永远不回话——那本身就是要判红的事实。
  const err = await orHung(errOf(ctx.runCommand("screenshot", { tabId })), 3000);
  const took = Date.now() - started;
  check("§2 挂住时按预算放弃（不是无限等）",
    err !== HUNG && typeof err === "string" && /\d+ 毫秒内没有返回/.test(err),
    err === HUNG ? `命令 ${took}ms 内没有回话（预算没生效）` : String(err)?.slice(0, 100));
  check("§2 放弃得很快（< 2s，绝不等于桥的 60s 天花板）", err !== HUNG && took < 2000, `${took}ms`);
  check("§2 文案说清原因方向（最小化 / 遮挡）并声明零副作用",
    err !== HUNG && /最小化|遮挡/.test(err) && err.includes("副作用"), String(err)?.slice(0, 140));
  // 预算超时不许被当成「断线」再去重放一次：那样会多打一次图。
  check("§2 超时没有触发重放（Page.captureScreenshot 只发了一次）",
    sends(model, "Page.captureScreenshot") === 1, `${sends(model, "Page.captureScreenshot")} 次`);
}

// ---- §3) emulate reset：失败必须可被感知 ----
{
  const { model, ctx, tabId } = await stage();
  model.dbg.failPlan = (method) => (method === "Emulation.clearDeviceMetricsOverride"
    ? "Emulation.clearDeviceMetricsOverride failed: protocol error"
    : null);
  const res = await ctx.runCommand("emulate", { device: "reset", tabId });
  check("§3 有一步失败 → reset:false（不再谎报成功）", res?.reset === false, short(res));
  check("§3 失败的是哪一步原样报出来",
    Array.isArray(res?.resetFailures) && res.resetFailures.length === 1
      && res.resetFailures[0].includes("clearDeviceMetricsOverride"), short(res?.resetFailures));
  check("§3 其它步骤照常执行（一条失败不连坐）",
    model.dbg.sends["Emulation.setUserAgentOverride"] >= 1 && model.dbg.sends["Emulation.setTouchEmulationEnabled"] >= 1,
    `ua=${model.dbg.sends["Emulation.setUserAgentOverride"]} touch=${model.dbg.sends["Emulation.setTouchEmulationEnabled"]}`);

  model.dbg.failPlan = null;
  const ok = await ctx.runCommand("emulate", { device: "reset", tabId });
  check("§3 全部成功时才是 reset:true", ok?.reset === true, short(ok));
  check("§3 成功时不带 resetFailures 这个字段", ok?.resetFailures === undefined, short(ok));
}

// ---- §4) 触摸：请求 vs 页面现场 ----
{
  const { model, ctx, tabId } = await stage();
  const applied = await ctx.runCommand("emulate", { device: "mobile-pixel-7", tabId });
  check("§4 触摸不再只发 enabled（带 maxTouchPoints）", lastTouchParams(model)?.maxTouchPoints === 5,
    short(lastTouchParams(model)));
  check("§4 同时把视口一起下发（Puppeteer 的事实标准是成对发）",
    sends(model, "Emulation.setDeviceMetricsOverride") === 1 && model.dbg.log.some((row) => row.method === "Emulation.setDeviceMetricsOverride" && row.params?.mobile === true),
    short(model.dbg.log.filter((row) => row.method === "Emulation.setDeviceMetricsOverride").map((row) => row.params)));
  check("§4 请求了 touch，但**页面现场**还看不到（已加载的文档不生效）",
    applied?.hasTouch === true && applied?.touchVisible === false, short(applied));
  check("§4 页面现场的 maxTouchPoints 也照实报（此刻还是 0）",
    applied?.pageMaxTouchPoints === 0, String(applied?.pageMaxTouchPoints));

  // 一次文档加载之后，页面才看得见触摸（真机语义）
  await ctx.runCommand("nav", { url: "https://fake.test/next", tabId });
  const after = await ctx.runCommand("emulate", { device: "mobile-pixel-7", tabId });
  check("§4 导航一次之后 ontouchstart 可见", after?.touchVisible === true, short(after));
  check("§4 页面现场报出 5 个触点", after?.pageMaxTouchPoints === 5, String(after?.pageMaxTouchPoints));

  // 复位清的是仿真开关，但当前文档仍然带着触摸能力——要如实报，而不是跟着开关一起变 false
  const reset = await ctx.runCommand("emulate", { device: "reset", tabId });
  check("§4 复位后当前文档仍看得到 touch（如实报，不跟着开关撒谎）",
    reset?.reset === true && reset?.touchVisible === true, short(reset));
  check("§4 复位把页面现场的触点报成 0 之外的值也不改写（只报实况）",
    typeof reset?.pageMaxTouchPoints === "number", String(reset?.pageMaxTouchPoints));
  const closed = lastTouchParams(model);
  check("§4 关闭触摸**不带** maxTouchPoints（Chrome 只接受 1-16，0 会被拒）",
    closed?.enabled === false && closed?.maxTouchPoints === undefined, short(closed));

  // 再导航一次：新文档才真的回到"没有触摸"
  await ctx.runCommand("nav", { url: "https://fake.test/again", tabId });
  const off = await ctx.runCommand("emulate", { device: "reset", tabId });
  check("§4 复位 + 一次导航之后页面确实没有 touch 了", off?.touchVisible === false, short(off));
}

// ---- §4b) 整页截图会重置触摸仿真：扩展要自己补回来 ----
{
  const { model, ctx, tabId } = await stage();
  await ctx.runCommand("emulate", { device: "mobile-pixel-7", tabId });
  check("§4b 前提：触摸已经在请求态", model.page.touchRequested === true, short(model.page));
  // Chromium 的真实行为：captureBeyondViewport 之后触摸仿真被悄悄撤掉
  model.dbg.results["Page.captureScreenshot"] = () => {
    model.page.touchRequested = false;
    return { data: "AAAA" };
  };
  await ctx.runCommand("screenshot", { tabId, fullPage: true });
  check("§4b 整页截图之后触摸仿真被补回来了", model.page.touchRequested === true, short(model.page));
  const replay = lastTouchParams(model);
  check("§4b 补发时带的是同样的 maxTouchPoints", replay?.enabled === true && replay?.maxTouchPoints === 5, short(replay));
}

// ---- §4c) CDP 会话重建会把仿真整体复位：重新附着时补回来 ----
{
  const { model, ctx, tabId } = await stage();
  await ctx.runCommand("emulate", { device: "mobile-pixel-7", tabId });
  model.page.touchRequested = false;
  model.dbg.attached.delete(Number(tabId));
  model.dbg.failPlan = (method, nth) => (nth === 1 && method === "Runtime.evaluate"
    ? `Debugger is not attached to the tab with id: ${tabId}.`
    : null);
  await errOf(ctx.runCommand("content", { tabId }));
  check("§4c 会话重建后重新附着时把触摸仿真补回来", model.page.touchRequested === true, short(model.page));
}

// ---- §4d) 复位之后不该再被"补回来"（意图已经清掉） ----
{
  const { model, ctx, tabId } = await stage();
  await ctx.runCommand("emulate", { device: "mobile-pixel-7", tabId });
  await ctx.runCommand("emulate", { device: "reset", tabId });
  model.page.touchRequested = false;
  model.dbg.attached.delete(Number(tabId));
  model.dbg.failPlan = (method, nth) => (nth === 1 && method === "Runtime.evaluate"
    ? `Debugger is not attached to the tab with id: ${tabId}.`
    : null);
  await errOf(ctx.runCommand("content", { tabId }));
  check("§4d 复位过之后附着时不再把触摸塞回去", model.page.touchRequested === false, short(model.page));
}

console.log(fails === 0 ? "\nALL PASS" : `\n${fails} FAILED`);
clearTimeout(watchdog);
process.exit(fails === 0 ? 0 : 1);
