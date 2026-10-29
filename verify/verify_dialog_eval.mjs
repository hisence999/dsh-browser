// 两个真实踩过的缺陷，各测两侧：
//
//   1) `browser_dialog` —— **名字撞车**。宿主 `execute()` 会给每条命令盖顶层
//      `policy` 信封（对象），而这个工具的线协议参数历史上也叫 `policy`：
//      `{ ...params, policy: 信封 }` 把字符串盖掉，扩展 `String(信封)` 得到
//      `[object Object]`，于是**连"不带参只读"都抛错**（信封每次都盖，躲不开）。
//      修法：线协议键改成 `dialogPolicy`，扩展只在 `policy` 确实是字符串时才当老插件。
//
//   2) `browser_evaluate` —— **默认 100ms 的隐形超时**。扩展里原本写的是
//      `Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 0)) || null`：
//      不传 timeoutMs 时 `Number(undefined)` 是 NaN → `|| 0` → 0 → `Math.max(100, 0)`
//      恒等于 100，那个"没传就不限时"的 `|| null` 永远不可达。任何真实 await
//      （网络、动画、setTimeout）都会在 100ms 被杀，而工具的 schema 压根没有
//      timeoutMs —— 也就是说这条路径**从来没能跑过一个 await**。
//
// 所以这台子两件事都钉：**参数真的到了扩展**、**扩展对同样的参数给同样的答案**。
// 单侧断言挡不住这类 bug（这次就是两侧各自"看起来都对"）。
import { bootBackground, makeModel } from "./ext_harness.mjs";
import { Config, apply } from "../lib/index.js";

const { validateJsonSchemaValue } = await import("@deepseek-ai/dsh-tools");

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 一条命令要么给定结果、要么给出错误文本 —— 两句都要能在断言里用到。 */
const settle = async (p) => p.then((v) => ({ ok: true, value: v }), (e) => ({ ok: false, error: String(e?.message ?? e) }));

const bootExt = async () => {
  const model = makeModel();
  const { ctx } = await bootBackground({ model });
  const tabId = model.addTab(1, "https://eval.test/");
  return { model, ctx, tabId };
};

/* ============================ 一、native dialog ============================ */

/* 1a —— 信封撞车的正身：带信封对象来"只读"，必须不抛错 */
{
  const { ctx } = await bootExt();
  // 信封长这样（src/index.ts policyEnvelope），每次命令都会盖上来
  const envelope = { focus: "avoid", tabs: "current-window", takeover: "yield", jar: "normal", highlight: "on", groupTitle: "DSH" };
  const r = await settle(ctx.cmdDialogPolicy({ policy: envelope }));
  check("dialog：只带策略信封对象来读 → 不抛错（这就是原来崩的那条）", r.ok, r.error);
  check("dialog：读到的就是当前策略（默认 accept）", r.ok && r.value?.policy === "accept", JSON.stringify(r.value));
  check("dialog：读也带 recent 数组（调用方能据此确认弹窗真的出现过）", r.ok && Array.isArray(r.value?.recent), JSON.stringify(r.value));
}

/* 1b —— 设值走新键 `dialogPolicy`，并且真的落下 */
{
  const { ctx } = await bootExt();
  const set = await settle(ctx.cmdDialogPolicy({ dialogPolicy: "dismiss", policy: { focus: "avoid" } }));
  check("dialog：`dialogPolicy` 设值成功，信封还在同一个 params 里也不影响", set.ok && set.value?.policy === "dismiss", JSON.stringify(set.value));
  const again = await settle(ctx.cmdDialogPolicy({ policy: { focus: "avoid" } }));
  check("dialog：下一次只读读到的就是刚设的值（不是每次都被信封重置）", again.ok && again.value?.policy === "dismiss", JSON.stringify(again.value));
}

/* 1c —— 老插件（v1.1.3 及更早，没有信封）用 `policy` 传字符串，必须继续能用 */
{
  const { ctx } = await bootExt();
  const old = await settle(ctx.cmdDialogPolicy({ policy: "manual" }));
  check("dialog：老插件的 `policy: 'manual'` 仍然认（兼容面不塌）", old.ok && old.value?.policy === "manual", JSON.stringify(old.value));
}

/* 1d —— 非法取值要明确报错，而不是静默当"没传" */
{
  const { ctx } = await bootExt();
  const bad = await settle(ctx.cmdDialogPolicy({ dialogPolicy: "ignore" }));
  check("dialog：非法取值明确报错并点名取值", !bad.ok && /invalid dialog policy: ignore/.test(bad.error), bad.error);
  const badOld = await settle(ctx.cmdDialogPolicy({ policy: "nope" }));
  check("dialog：老键的非法取值同样报错（不因为是老键就放过）", !badOld.ok && /invalid dialog policy: nope/.test(badOld.error), badOld.error);
  const still = await settle(ctx.cmdDialogPolicy({}));
  check("dialog：报错不改状态（拒绝 = 零副作用）", still.ok && still.value?.policy === "accept", JSON.stringify(still.value));
}

/* ===================== 二、eval 的限时预算（纯函数） ===================== */

/* 2a —— 判据是"传没传"，不是数值真假 */
{
  const { ctx } = await bootExt();
  const budget = (p) => ctx.evalBudgetOf(p);
  check("eval：不传 timeoutMs → null（不额外限时，交给桥的 60s）", budget({}) === null, String(budget({})));
  check("eval：显式 undefined → null", budget({ timeoutMs: undefined }) === null, String(budget({ timeoutMs: undefined })));
  check("eval：null → null", budget({ timeoutMs: null }) === null, String(budget({ timeoutMs: null })));
  check("eval：非数字字符串 → null（不猜）", budget({ timeoutMs: "abc" }) === null, String(budget({ timeoutMs: "abc" })));
  check("eval：300 → 300（原样）", budget({ timeoutMs: 300 }) === 300, String(budget({ timeoutMs: 300 })));
  check("eval：低于下限 1 → 夹到 100", budget({ timeoutMs: 1 }) === 100, String(budget({ timeoutMs: 1 })));
  check("eval：0 也算传了 → 夹到 100（0 不等于'不限时'）", budget({ timeoutMs: 0 }) === 100, String(budget({ timeoutMs: 0 })));
  check("eval：超过天花板 999999 → 夹到 120000", budget({ timeoutMs: 999_999 }) === 120_000, String(budget({ timeoutMs: 999_999 })));
}

/* ================== 三、eval 的行为：挂住的 await 怎么算 ================== */

/* 3a —— 不传 timeoutMs 时，挂住的 await **不该**在 100ms 被杀 */
{
  const { model, ctx, tabId } = await bootExt();
  model.dbg.results["Runtime.evaluate"] = () => new Promise(() => {}); // 永不 settle
  const outcome = await Promise.race([
    settle(ctx.cmdEval({ expression: "await new Promise(() => {})", tabId })),
    sleep(260).then(() => "still-pending"),
  ]);
  check("eval：不传 timeoutMs 时挂住的 await 260ms 后仍在等（100ms 隐形上限已去掉）",
    outcome === "still-pending", JSON.stringify(outcome));
}

/* 3b —— 传了就按传的预算杀，文案要能看出是谁的预算 */
{
  const { model, ctx, tabId } = await bootExt();
  model.dbg.results["Runtime.evaluate"] = () => new Promise(() => {});
  const started = Date.now();
  const r = await settle(ctx.cmdEval({ expression: "await new Promise(() => {})", tabId, timeoutMs: 300 }));
  const ms = Date.now() - started;
  check("eval：timeoutMs:300 → 按 300ms 超时（不是 100，也不是 60s）",
    !r.ok && /eval timeout after 300ms/.test(r.error), `${r.error} after ${ms}ms`);
  check("eval：预算真的等满了才杀（≥250ms，不是提前返回）", ms >= 250 && ms < 1_500, `${ms}ms`);
}

/* 3c —— 低于下限的请求按夹子后的 100ms 报，报的必须是夹子值 */
{
  const { model, ctx, tabId } = await bootExt();
  model.dbg.results["Runtime.evaluate"] = () => new Promise(() => {});
  const r = await settle(ctx.cmdEval({ expression: "await 1", tabId, timeoutMs: 5 }));
  check("eval：timeoutMs:5 → 文案报的是夹子后的 100ms（说的和做的一致）",
    !r.ok && /eval timeout after 100ms/.test(r.error), r.error);
}

/* 3d —— 预算存在不等于天天超时：能立刻回来的表达式必须正常回来 */
{
  const { model, ctx, tabId } = await bootExt();
  model.dbg.results["Runtime.evaluate"] = () => ({ result: { type: "number", value: 7 } });
  const r = await settle(ctx.cmdEval({ expression: "7", tabId, timeoutMs: 5_000 }));
  check("eval：给了预算但表达式立刻返回 → 正常拿到值，不误杀", r.ok && r.value?.value === 7, JSON.stringify(r.value));
}

/* 3e —— 预算不许把 debugger 附着算进去（报告里"10ms 的 promise 也挂"的另一半） */
{
  const { model, ctx, tabId } = await bootExt();
  model.dbg.attachDelayMs = 200; // 假附着要 200ms（真机冷附着就是这个量级）
  model.dbg.results["Runtime.evaluate"] = () => ({ result: { type: "number", value: 1 } });
  const started = Date.now();
  const r = await settle(ctx.cmdEval({ expression: "1", tabId, timeoutMs: 100 }));
  const ms = Date.now() - started;
  check("eval：附着耗 200ms、表达式立刻返回 → timeoutMs:100 不误杀（预算只量页面那一段）", r.ok, r.error);
  check("eval：这条命令确实在等附着（≥180ms），证明附着真的慢、不是没测到", ms >= 180, `${ms}ms`);
}

/* ============ 四、宿主侧：参数真的带着新键送到扩展（真桥 + 假扩展） ============ */

const PORT = 9787; // 9777 装机默认 / 9779 端到端 / 9781 导航 / 9783 渲染契约 / 9785 批量关闭
const TOKEN = "dialog-eval-test";
const tools = [];
const disposers = [];
const config = Config({ enabled: true, port: PORT, token: TOKEN });
const settingsService = {
  register(_ns, schema, options) {
    let value = schema(options?.base ?? config);
    const watchers = [];
    return {
      get: () => value,
      watch: (cb) => void watchers.push(cb),
      set: (next) => { value = next; watchers.forEach((w) => w()); },
    };
  },
};
const pluginCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  fiber: { state: 2, uid: 1 },
  effect: (fn, msg) => disposers.push([fn, msg]),
  inject: (deps, cb) => { if (deps.includes("settings")) cb({ settings: settingsService, logger: pluginCtx.logger }); },
  tools: { register: (def) => tools.push(def) },
  systemPrompt: { section: () => {} },
};
apply(pluginCtx, config);
await sleep(400);

/** 假扩展：记下每条命令的 params，回一个够过 schema 的壳。 */
let seen = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
await new Promise((r) => {
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "hello", client: "fake-extension", version: "1.0.25", protocol: 1,
      browser: { name: "fake", version: "1", ua: "" },
    }));
    r();
  };
  ws.onerror = r;
});
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type !== "command") return;
  seen.push({ command: msg.command, params: msg.params });
  const result = msg.command === "dialog"
    ? { policy: "accept", recent: [] }
    : { tabId: Number(msg.params?.tabId) || 1, value: 1 };
  ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result }));
};
await sleep(250);

const tool = (name) => {
  const def = tools.find((t) => t.name === name);
  if (!def) throw new Error(`tool not registered: ${name}`);
  return def;
};
const runTool = async (name, args) => {
  seen = [];
  const def = tool(name);
  const value = await def.execute(args, { signal: new AbortController().signal });
  return {
    value,
    violations: validateJsonSchemaValue(def.output.schema, value, "value"),
    commands: seen.map((s) => s.command),
    params: seen.map((s) => s.params),
  };
};

/* 4a —— 信封仍然在（别用"把信封从 dialog 拿掉"来修，那是把闸门拆了） */
{
  const read = await runTool("browser_dialog", {});
  const p = read.params[0] ?? {};
  check("宿主：dialog 只读仍然是一条 `dialog` 命令", read.commands.join() === "dialog", JSON.stringify(read.commands));
  check("宿主：dialog 的 params 里**带着**策略信封（闸门没有被拆掉）",
    typeof p.policy === "object" && p.policy !== null && p.policy.focus === "avoid", JSON.stringify(p.policy));
  check("宿主：只读时不发 `dialogPolicy`（省略 = 只读，不许发个 undefined 假装设值）",
    p.dialogPolicy === undefined && !("dialogPolicy" in p), JSON.stringify(Object.keys(p)));
  check("宿主：只读结果过输出 schema", read.violations.length === 0, read.violations.join(" | "));
}

/* 4b —— 设值：字符串必须走新键，且不能被信封闭吃掉 */
{
  const set = await runTool("browser_dialog", { policy: "dismiss" });
  const p = set.params[0] ?? {};
  check("宿主：设值走 `dialogPolicy`", p.dialogPolicy === "dismiss", JSON.stringify(p.dialogPolicy));
  check("宿主：设值时信徒仍在 `policy` 里（两个同名字段不再互相踩）",
    typeof p.policy === "object" && p.policy !== null, JSON.stringify(p.policy));
  check("宿主：设值结果过输出 schema", set.violations.length === 0, set.violations.join(" | "));

  // ★ 这条才是真正抓 bug 的：把宿主发出去的 params **原样**喂回真扩展，
  //   两侧各自"看起来对"也可能对不上（这次就是）。
  const { ctx } = await bootExt();
  const echoed = await settle(ctx.cmdDialogPolicy(set.params[0]));
  check("端到端：宿主发出的 params 喂给真扩展 → 策略真的被设成 dismiss",
    echoed.ok && echoed.value?.policy === "dismiss", JSON.stringify(echoed));
}

/* 4c —— 端到端只读：同一份 params（只带信封）喂回去必须是"读"，不是"设" */
{
  const read = await runTool("browser_dialog", {});
  const { ctx } = await bootExt();
  const echoed = await settle(ctx.cmdDialogPolicy(read.params[0]));
  check("端到端：只读的 params（信封对象）喂给真扩展 → 不抛错、读出 accept",
    echoed.ok && echoed.value?.policy === "accept", JSON.stringify(echoed));
}

/* 4d —— evaluate：传了就透传，没传就不出现这个键（"不限时"必须能表达） */
{
  const given = await runTool("browser_evaluate", { expression: "1", tabId: 3, timeoutMs: 300 });
  check("宿主：evaluate 的 timeoutMs 原样透传到扩展", given.params[0]?.timeoutMs === 300, JSON.stringify(given.params[0]));
  check("宿主：evaluate 给了预算时结果仍过输出 schema", given.violations.length === 0, given.violations.join(" | "));

  const none = await runTool("browser_evaluate", { expression: "1", tabId: 3 });
  check("宿主：evaluate 不传 timeoutMs 时 params 里没有这个键（否则扩展会以为是 0 → 100ms）",
    none.params[0] !== undefined && !("timeoutMs" in none.params[0]), JSON.stringify(Object.keys(none.params[0] ?? {})));

  const big = await runTool("browser_evaluate", { expression: "1", tabId: 3, timeoutMs: 999_999 });
  check("宿主：evaluate 的超大预算在宿主侧就夹到 120000（两端夹子同一区间）",
    big.params[0]?.timeoutMs === 120_000, JSON.stringify(big.params[0]));

  const zero = await runTool("browser_evaluate", { expression: "1", tabId: 3, timeoutMs: 0 });
  check("宿主：evaluate 的 0 夹到 100（0 = 传了，不是不限时）",
    zero.params[0]?.timeoutMs === 100, JSON.stringify(zero.params[0]));
}

/* 4e —— 跨版本面：扩展必须仍然认老插件那版（`policy` 是字符串） */
{
  const { ctx } = await bootExt();
  const legacy = await settle(ctx.cmdDialogPolicy({ policy: "accept" }));
  check("跨版本：老插件 params 形状 {policy:'accept'} 仍然可用", legacy.ok && legacy.value?.policy === "accept", JSON.stringify(legacy));
}

try { ws.close(); } catch { /* already closed */ }
for (const disposer of disposers) {
  try { await disposer[0](); } catch { /* teardown 不参与断言 */ }
}

console.log(fails === 0 ? "\ndialog 与 evaluate 的线协议/预算全部通过" : `\n${fails} 项失败`);
process.exit(fails === 0 ? 0 : 1);
