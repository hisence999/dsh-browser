// 聚焦策略（`params.policy.focus` = 'avoid' 默认 / 'auto'）：在 node:vm 里跑**真实的**
// extension/background.js，配一台**有窗口**的假浏览器（verify/ext_harness.mjs）。
//
// 为什么这组断言必须存在：`avoid` 的全部意义是「AI 不抢用户正在用的桌面」。它退化的方式
// 全都不会报错——一次 `windows.update({focused:true})` 就把用户的窗口顶下去，一次
// `tabs.update({active:true})` 就把用户正在看的标签页切走，而工具照样回 `ok:true`。
// 所以断言必须落在「到底调了没有」上：`model.windowUpdates` 是窗口动作的账本，
// 标签页的 `active` 标记是标签页动作的账本。
//
// 另一半是**不许因为 avoid 就静默失败**：
//   - 最小化窗口（0×0 视口）两种策略都直接报 `window_minimized`，不许猜；
//   - `input` 的 type 模式在 avoid 下如果读回是空串，允许升级一次（唯一允许抬窗口的时刻），
//     并且必须在结果里带 `focusedFallback:true` —— 动过用户的窗口却不说，比不动更糟。
//
// vm context 上只能拿到顶层 `function` 声明（DEFAULT_POLICY 之类的 `const` 取不到），
// 所以「默认是 avoid」用「不传 policy 时同一条断言照样绿」来证明。
import { bootBackground, makeModel } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/** `cmdClick` 的第一步是在页面里量命中点；给它一个命中结果，`focus` 才有机会回到调用方。 */
const HIT = { x: 12, y: 24, tag: "button", text: "Go", hitTag: "button", isTop: true, bypassedOwnOverlay: false };
const hitStub = () => ({ result: { value: { ...HIT } } });

/**
 * 页面侧 `Runtime.evaluate` 的路由：一次 `input` 会问三次页面——
 * locateAndClearField（含 `el.focus()`）、写值/逐字符打完的读回（含 `el.value ?? el.textContent`）。
 * 读回返回什么，决定了 avoid 下会不会「升级」。
 */
const fieldStub = ({ readback }) => (params) => {
  const ex = String(params?.expression ?? "");
  if (ex.includes("el.focus()")) return { result: { value: { tag: "input[text]" } } };
  if (ex.includes("el.value ?? el.textContent")) return { result: { value: { tag: "input", value: readback() } } };
  return { result: { value: null } };
};

const bootFocus = async (stub = hitStub) => {
  const model = makeModel();
  const { ctx } = await bootBackground({ model });
  model.dbg.results["Runtime.evaluate"] = stub;
  return { model, ctx };
};

/** 用户在窗口 1 里看着自己的标签页；AI 的标签页在别的窗口（这样 avoid 才「没激活」）。 */
const crossWindowTab = (model, url = "https://away.test/") => {
  const user = model.addTab(1, "https://user.test/");
  model.tabs.get(user).active = true;
  const win = model.addWindow({});
  return { user, win, tab: model.addTab(win, url) };
};

/* 1 —— avoid 同窗口：切标签页（用户眼前发生的事），但绝不抬窗口 */
{
  const { model, ctx } = await bootFocus();
  const user = model.addTab(1, "https://user.test/");
  model.tabs.get(user).active = true;
  const agent = model.addTab(1, "https://agent.test/"); // 同窗口，但不是当前页

  const r = await ctx.cmdClick({ selector: "#go", tabId: agent });
  check("avoid + 同窗口：切到目标标签页（等于用户自己点了一下标签栏，是可预期的事）",
    r.focus?.tabActivated === true && model.tabs.get(agent).active === true, JSON.stringify(r.focus));
  check("avoid + 同窗口：chrome.windows.update 一次都没调（不是「只调了不 focused」）",
    model.calls.windowsUpdate === 0 && model.windowUpdates.length === 0, JSON.stringify(model.windowUpdates));
  check("avoid：结果如实回报 policy='avoid' / windowFocused=false",
    r.focus?.policy === "avoid" && r.focus?.windowFocused === false, JSON.stringify(r.focus));
  check("click 仍然命中（切标签页不是点击成功的前提）", r.hitVerified === true && r.clicked?.tag === "button", JSON.stringify(r.clicked));
}

/* 2 —— avoid 跨窗口：什么都不动（靠 CDP 把事件打进渲染进程）；auto 是历史行为，两样都做 */
{
  const { model, ctx } = await bootFocus();
  const { user, win, tab } = crossWindowTab(model);

  const avoid = await ctx.cmdClick({ selector: "#go", tabId: tab });
  check("avoid + 跨窗口：不抬窗口", model.calls.windowsUpdate === 0 && avoid.focus?.windowFocused === false,
    JSON.stringify(model.windowUpdates));
  check("avoid + 跨窗口：也不发 tabs.update({active:true})（那个窗口里的标签页 active 仍是 false）",
    avoid.focus?.tabActivated === false && model.tabs.get(tab).active === false,
    JSON.stringify({ focus: avoid.focus, active: model.tabs.get(tab).active }));
  check("avoid + 跨窗口：用户那个窗口还是聚焦的，没被顶下去",
    model.windows.get(1).focused === true && model.windows.get(win).focused === false,
    JSON.stringify([...model.windows.values()].map((w) => [w.id, w.focused])));
  check("avoid + 跨窗口：照样点得进去（CDP 事件打到渲染进程，不需要标签页在前台）",
    avoid.hitVerified === true, JSON.stringify(avoid.clicked));

  // 不传 policy = 默认 avoid：默认值写在扩展里，不能指望调用方每次都盖章
  const implicit = await ctx.cmdClick({ selector: "#go", tabId: tab });
  check("不传 policy 时走的就是 avoid（默认值在扩展这一侧）",
    implicit.focus?.policy === "avoid" && model.calls.windowsUpdate === 0, JSON.stringify(implicit.focus));

  const auto = await ctx.cmdClick({ selector: "#go", tabId: tab, policy: { focus: "auto" } });
  check("auto + 跨窗口：抬窗口（windows.update({focused:true}) 落在正确的窗口上）",
    auto.focus?.windowFocused === true
      && model.windowUpdates.some(([id, props]) => id === win && props.focused === true),
    JSON.stringify(model.windowUpdates));
  check("auto + 跨窗口：也切标签页", auto.focus?.tabActivated === true && model.tabs.get(tab).active === true,
    JSON.stringify(auto.focus));
  // 这一条的用处是把「为什么默认是 avoid」变成账本上的事实：auto 抬窗口的代价就是
  // 用户原来那个窗口失去聚焦（真 Chrome 只有一个前台窗口），avoid 从不付这笔价。
  check("auto 会把用户原来的窗口顶下去（照实记下来——这就是 avoid 当默认的理由）",
    model.windows.get(win).focused === true && model.windows.get(1).focused === false
      && model.tabs.get(user).active === true,
    JSON.stringify([...model.windows.values()].map((w) => [w.id, w.focused])));
  check("代价是清单上的：被顶下去的是用户正在看标签页的那个窗口（用户自己那页没被改，只是不在前台）",
    model.tabs.get(user).url === "https://user.test/", model.tabs.get(user).url);
}

/* 3 —— 最小化窗口：两种策略都直接报错，且什么也不动 */
{
  for (const [label, extra] of [["avoid（缺省）", {}], ["auto", { policy: { focus: "auto" } }]]) {
    const { model, ctx } = await bootFocus();
    const win = model.addWindow({ state: "minimized" });
    const tab = model.addTab(win, "https://min.test/");
    const err = await ctx.cmdClick({ selector: "#go", tabId: tab, ...extra }).then(() => null, (e) => e);

    check(`${label} + 最小化窗口：报 window_minimized（0×0 视口下 elementFromPoint 与滚动都不可信）`,
      err?.code === "window_minimized" && /minimized/.test(String(err?.message)),
      `${err?.code} / ${String(err?.message ?? err).slice(0, 70)}`);
    check(`${label} + 最小化窗口：零 CDP、零窗口动作（猜视口比报错更糟，改窗口尺寸更不行）`,
      model.dbg.attachCount === 0 && model.dbg.log.length === 0 && model.calls.windowsUpdate === 0,
      `attach=${model.dbg.attachCount} cdp=${model.dbg.log.length} winUpdate=${model.calls.windowsUpdate}`);
  }
}

/* 4 —— input 的 fill 模式：直接写值，不需要焦点，也不许顺手动窗口 */
{
  const { model, ctx } = await bootFocus(fieldStub({ readback: () => "填好了" }));
  const { win, tab } = crossWindowTab(model, "https://fill.test/");
  const r = await ctx.cmdInput({ selector: "#q", value: "填好了", tabId: tab });

  check("fill 模式：值真的写进去并读回", r.mode === "fill" && r.filled?.value === "填好了", JSON.stringify(r.filled));
  check("fill 模式：如实说「没碰焦点」（skipped=fill-mode，不是假装 avoid 做了什么）",
    r.focus?.skipped === "fill-mode" && r.focus?.tabActivated === false, JSON.stringify(r.focus));
  check("fill 模式：不抬窗口、不切标签页（写值是 DOM 操作，跟焦点无关）",
    model.calls.windowsUpdate === 0 && model.tabs.get(tab).active === false,
    `winUpdate=${model.calls.windowsUpdate} active=${model.tabs.get(tab).active}`);
  check("fill 模式：没有 focusedFallback（那是 type 模式升级才有的标记）", r.focusedFallback === undefined);
  check("前提确认：这个块确实是非聚焦窗口（否则上面几条等于没测）", model.windows.get(win).focused === false);
}

/* 5 —— input 的 type 模式 + avoid + 读回空串：升级一次，并且如实标注 */
{
  const { model, ctx } = await bootFocus(fieldStub({ readback: (() => {
    let n = 0;
    // 第一次读回是空串（后台标签页没收到键盘），升级重打之后才落地
    return () => (++n === 1 ? "" : "hello");
  })() }));
  const { win, tab } = crossWindowTab(model, "https://type.test/");
  const r = await ctx.cmdInput({ selector: "#q", value: "hello", mode: "type", tabId: tab });

  check("type + avoid + 读回空串：升级一次（读回是唯一能证伪「后台标签页也收键盘」的信号）",
    r.focusedFallback === true && r.focus?.escalated === true, JSON.stringify(r.focus));
  check("升级只发一次 windows.update({focused:true})，落在目标标签页的窗口上",
    model.calls.windowsUpdate === 1 && model.windowUpdates[0][0] === win && model.windowUpdates[0][1].focused === true,
    JSON.stringify(model.windowUpdates));
  check("升级后清空重打，读回到真值（不许把空串当成功）", r.filled?.value === "hello", JSON.stringify(r.filled));
  check("升级仍然报 policy='avoid'（策略没变，变的是这一次为了落地而破的例）",
    r.focus?.policy === "avoid", JSON.stringify(r.focus));
}

/* 6 —— type 模式读回到内容：不许升级（抬窗口是例外，不是默认动作） */
{
  const { model, ctx } = await bootFocus(fieldStub({ readback: () => "hello" }));
  const { tab } = crossWindowTab(model, "https://type-ok.test/");
  const r = await ctx.cmdInput({ selector: "#q", value: "hello", mode: "type", tabId: tab });

  check("type + avoid + 读回有内容：不升级，一个窗口动作都不发",
    r.focusedFallback === undefined && model.calls.windowsUpdate === 0,
    `fallback=${r.focusedFallback} winUpdate=${model.calls.windowsUpdate}`);
  check("type + avoid + 跨窗口：也没顺手切标签页（键盘走 CDP，不需要前台）",
    r.focus?.tabActivated === false && model.tabs.get(tab).active === false, JSON.stringify(r.focus));
}

/* 7 —— 升级的前提是「没激活」：已经激活却读回空，是另一类故障，顺手抬窗口解决不了它 */
{
  const { model, ctx } = await bootFocus(fieldStub({ readback: () => "" }));
  const agent = model.addTab(1, "https://same-window.test/"); // 同窗口、非当前页 → avoid 会切过去
  const r = await ctx.cmdInput({ selector: "#q", value: "hello", mode: "type", tabId: agent });

  check("type + avoid + 同窗口：先把标签页切过去（tabActivated:true）",
    r.focus?.tabActivated === true, JSON.stringify(r.focus));
  check("已经激活却读回空：不升级（抬窗口解决不了这个问题，只会多动一次用户的桌面）",
    r.focusedFallback === undefined && model.calls.windowsUpdate === 0,
    `fallback=${r.focusedFallback} winUpdate=${model.calls.windowsUpdate}`);
  check("读回空就如实报空——不许把空串说成写成功", r.filled?.value === "", JSON.stringify(r.filled));
}

/* 8 —— press 走同一套聚焦策略（它是另一个调用点，容易漏掉 policyOf） */
{
  const { model, ctx } = await bootFocus();
  const { win, tab } = crossWindowTab(model, "https://press.test/");

  const avoid = await ctx.cmdPress({ key: "Enter", tabId: tab });
  check("press + avoid + 跨窗口：不抬窗口也不切标签页",
    model.calls.windowsUpdate === 0 && avoid.focus?.tabActivated === false && avoid.focus?.windowFocused === false,
    JSON.stringify(avoid.focus));
  check("press 照样派发了一次 keyDown + 一次 keyUp（不激活不等于不工作）",
    model.dbg.sends["Input.dispatchKeyEvent"] === 2, String(model.dbg.sends["Input.dispatchKeyEvent"]));

  const auto = await ctx.cmdPress({ key: "Enter", tabId: tab, policy: { focus: "auto" } });
  check("press + auto：抬窗口 + 切标签页",
    auto.focus?.windowFocused === true && auto.focus?.tabActivated === true
      && model.windowUpdates.some(([id, props]) => id === win && props.focused === true),
    JSON.stringify(model.windowUpdates));
}

console.log(`\n结论：${fails === 0 ? "聚焦策略（avoid 不抢焦点 / auto 照旧 / 最小化报错 / type 升级标注）全部符合契约" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
