// 标签页归属（ownership）与默认目标：在 node:vm 里跑**真实的** extension/background.js，
// 配一台有状态的假浏览器（verify/ext_harness.mjs），断言四件事：
//   1) 从未认领过标签页时，默认目标仍是「用户正看着的那一页」——历史行为一字不改；
//   2) `tabs.open` 之后，不带 tabId 的命令钉在 AI 自己的标签页上（不再跟着用户视线跑）；
//   3) `tabs.group` = 认领、`tabs.ungroup` = 放手，`tabs.close/closeMany` 只关自己的；
//   4) 归属与目标活在 `chrome.storage.session` 里，能过 service worker 回收，但不过浏览器重启。
//
// 为什么这组断言必须存在：这两件事**都不会报错**，只会安静地做错。用户点开一封邮件，AI 的
// 下一次点击就打进邮件页面（还把用户正在填的输入框清掉）；模型一句「清理一下」就能用
// `tabs.close` 关掉用户自己的标签页——关掉的标签页找不回来。所以断言要钉在「谁的东西」和
// 「拒绝之后到底有没有动手」上，而不是「命令有没有返回一个对象」。
//
// 断言只落在**函数返回值**与**假浏览器的状态**上：vm context 上取不到 `const`
//（AGENT_STATE_KEY / AGENT_GROUP_TITLE / DEFAULT_POLICY 全拿不到），所以下面的存储键写成
// 字面量 `agentState`。这是刻意的：那个键属于「活过 service worker 回收」的状态契约，
// 悄悄改字面量等于让老记录读不出来、归属集体消失——那正是台子该红的时候。
import { bootBackground, makeModel } from "./ext_harness.mjs";

let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

/**
 * 一台独立的假浏览器 + 一份独立的 `chrome.storage`。
 * local 与 session 分开给，才能断言「归属只落 session」。
 */
const bootOwnership = async (reuse) => {
  const model = reuse?.model ?? makeModel();
  const local = reuse?.local ?? {};
  const session = reuse?.session ?? {};
  const { ctx } = await bootBackground({ model, storage: local, sessionStorage: session });
  return { model, ctx, local, session };
};

/** 打开一个「AI 自己的」标签页：`active:false` 很关键——用户还留在自己那页上。 */
const openQuiet = (ctx, url = "https://agent.test/") =>
  ctx.cmdTabsOpen({ url, wait: false, active: false, group: false });

/* 1 —— 默认目标：没认领过跟着用户；认领过就钉住 */
{
  const { model, ctx } = await bootOwnership();
  const user = model.addTab(1, "https://user.test/");
  model.tabs.get(user).active = true;

  const before = await ctx.resolveTab();
  check("从未认领过：默认目标 = 用户正在看的标签页（第 4 项不许改坏老行为）",
    before.id === user, `resolved=${before.id} user=${user}`);

  const opened = await openQuiet(ctx);
  check("tabs.open 的结果自带 owned 与默认目标指针",
    opened.owned === true && opened.agentTargetTabId === opened.tabId,
    JSON.stringify({ tabId: opened.tabId, owned: opened.owned, target: opened.agentTargetTabId }));
  check("归组失败也不丢归属（自己开的标签页就是自己的）",
    opened.grouped === false && opened.owned === true, JSON.stringify(opened).slice(0, 120));

  // 关键：AI 的标签页**不是** active 的那个，用户还看着自己那页。
  // 修之前 resolveTab 只有 active-tab 一条兜底，这里会解析成 user；
  // 现在必须有 agent-target 分支，否则这条断言红。
  const pinned = await ctx.resolveTab();
  check("认领之后：不带 tabId 的命令钉在 AI 自己的标签页上，不再跟着用户视线跑",
    pinned.id === opened.tabId && model.tabs.get(user).active === true,
    `resolved=${pinned.id} agent=${opened.tabId} userStillActive=${model.tabs.get(user).active}`);
}

/* 2 —— 归属落在哪：session（活过 worker 回收）而不是 local（活过浏览器重启） */
{
  const { model, ctx, local, session } = await bootOwnership();
  const opened = await openQuiet(ctx);
  const record = session.agentState;

  check("归属 + 默认目标落 chrome.storage.session",
    record !== undefined && record.target === opened.tabId && record.tabs[opened.tabId] !== undefined,
    JSON.stringify(record));
  check("记录里带着 windowId（跨窗口判定与聚焦策略以后要读它）",
    record?.tabs?.[opened.tabId]?.windowId === 1, JSON.stringify(record?.tabs?.[opened.tabId]));
  check("这份状态**不**落 chrome.storage.local（否则下一轮浏览器还记着上一轮的归属）",
    local.agentState === undefined, JSON.stringify(Object.keys(local)));
}

/* 3 —— close 守卫：用户自己的标签页默认拒绝，拒绝 = 没发生 */
{
  const { model, ctx } = await bootOwnership();
  const userTab = model.addTab(1, "https://user.test/");

  const refused = await ctx.cmdTabsClose({ tabId: userTab });
  check("关用户自己的标签页：默认拒绝，并且点了名",
    refused.closed.length === 0 && JSON.stringify(refused.refused) === JSON.stringify([{ tabId: userTab, reason: "not_owned_by_agent" }]),
    JSON.stringify(refused));
  check("拒绝是「没有发生」而不是「失败」：failed 空、标签页还在、chrome.tabs.remove 一次都没发",
    refused.failed.length === 0 && model.tabs.has(userTab) && model.removeCalls.length === 0,
    `stillOpen=${model.tabs.has(userTab)} removeCalls=${JSON.stringify(model.removeCalls)}`);

  // 认领手势：把标签页拖进 DSH 分组 = 「这一个给你用」，不需要新命令
  const claimed = await ctx.cmdTabGroup({ tabId: userTab });
  check("tabs.group 不只是归组，还是认领（owned + 成为默认目标）",
    claimed.owned === true && claimed.agentTargetTabId === userTab,
    JSON.stringify({ owned: claimed.owned, target: claimed.agentTargetTabId }));
  const closed = await ctx.cmdTabsClose({ tabId: userTab });
  check("认领之后同一条 close 就肯关了",
    closed.closed.join() === String(userTab) && !model.tabs.has(userTab), JSON.stringify(closed));

  // 放手：拆组之后归属必须被忘掉，而不是只把它从组里移出来
  const other = model.addTab(1, "https://other.test/");
  await ctx.cmdTabGroup({ tabId: other });
  const released = await ctx.cmdTabUngroup({});
  check("tabs.ungroup 真的拆了组", released.ungrouped >= 1, JSON.stringify(released));
  const afterRelease = await ctx.cmdTabsClose({ tabId: other });
  check("放手之后 close 又开始拒绝（归属被忘掉了，不是只从组里移出来）",
    afterRelease.refused?.[0]?.tabId === other && model.tabs.has(other), JSON.stringify(afterRelease));
}

/* 4 —— 混合批：自己的关掉、别人的拒绝、早没了的算幂等成功；老语义不许被守卫改坏 */
{
  const { model, ctx } = await bootOwnership();
  const own = (await openQuiet(ctx)).tabId;
  const users = model.addTab(1, "https://user.test/");
  const ghost = 999_999;

  const r = await ctx.cmdTabsCloseMany({ tabIds: [own, users, ghost] });
  check("混合批：自己的关掉、别人的拒绝、早没了的算幂等成功",
    r.closed.join() === String(own) && r.alreadyGone.join() === String(ghost)
      && r.refused?.[0]?.tabId === users && r.failed.length === 0,
    JSON.stringify(r));
  check("被拒绝的 id 压根没进 chrome.tabs.remove（拒绝 = 拒绝，不是失败重试）",
    model.removeCalls.length === 1 && model.removeCalls[0].join() === String(own),
    JSON.stringify(model.removeCalls));
  check("用户那一页真的还在", model.tabs.has(users), `remaining=${[...model.tabs.keys()].join(",")}`);

  const forced = await ctx.cmdTabsCloseMany({ tabIds: [users], force: true });
  check("force:true 才动用户自己的标签页（关掉就找不回来，必须显式）",
    forced.closed.join() === String(users) && !model.tabs.has(users), JSON.stringify(forced));

  const again = await ctx.cmdTabsCloseMany({ tabIds: [own] });
  check("守卫没改坏幂等的老语义：自己的标签页重关仍是 alreadyGone 而不是错误",
    again.alreadyGone.join() === String(own) && again.closed.length === 0 && again.failed.length === 0,
    JSON.stringify(again));
}

/* 5 —— tabs.list：每行两个布尔 + 顶层是「不带 tabId 会打哪儿」 */
{
  const { model, ctx } = await bootOwnership();
  const user = model.addTab(1, "https://user.test/");
  const opened = await openQuiet(ctx);
  const listed = await ctx.cmdTabsList();
  const agentRow = listed.tabs.find((t) => t.id === opened.tabId);
  const userRow = listed.tabs.find((t) => t.id === user);

  check("tabs.list 顶层报出默认目标", listed.agentTargetTabId === opened.tabId, String(listed.agentTargetTabId));
  check("每行带 owned：自己开的 true，用户开的 false",
    agentRow?.owned === true && userRow?.owned === false,
    JSON.stringify({ agent: agentRow?.owned, user: userRow?.owned }));
  check("每行带 yielded，且默认全是 false（让出是例外状态，不是常态）",
    listed.tabs.every((t) => t.yielded === false), JSON.stringify(listed.tabs.map((t) => t.yielded)));
}

/* 6 —— 目标标签页被用户关掉：必须自愈，而且要把指针清掉写回存储 */
{
  const { model, ctx, session } = await bootOwnership();
  const user = model.addTab(1, "https://user.test/");
  model.tabs.get(user).active = true;
  const opened = await openQuiet(ctx);

  model.tabs.delete(opened.tabId); // 用户把 AI 那页关了
  const next = await ctx.resolveTab();
  check("目标标签页没了：退回用户那一页，而不是抛错或继续指着死 id",
    next.id === user, `resolved=${next.id} user=${user}`);
  const state = await ctx.syncAgentState();
  check("并且把指针清掉写回 session（下一条命令不许再试一次死 id）",
    state.target === null && session.agentState?.target === null, JSON.stringify(session.agentState?.target));

  const reopened = await openQuiet(ctx, "https://next.test/");
  const repinned = await ctx.resolveTab();
  check("清掉之后下一次 tabs.open 能把默认目标重新立起来",
    repinned.id === reopened.tabId, `resolved=${repinned.id} new=${reopened.tabId}`);
}

/* 7 —— service worker 被回收：内存标志全丢，归属与目标必须还在 */
{
  const first = await bootOwnership();
  const user = first.model.addTab(1, "https://user.test/");
  first.model.tabs.get(user).active = true;
  const opened = await openQuiet(first.ctx);

  // 同一台假浏览器 + 同一份 storage，换一个全新的 vm context = MV3 的 worker 回收/唤醒
  const revived = await bootOwnership({ model: first.model, local: first.local, session: first.session });

  const pinned = await revived.ctx.resolveTab();
  check("回收再唤醒：默认目标还在（内存标志会丢，session 不会）",
    pinned.id === opened.tabId, `resolved=${pinned.id} agent=${opened.tabId}`);
  const closed = await revived.ctx.cmdTabsClose({ tabId: opened.tabId });
  check("回收再唤醒：仍认得它是自己的，close 不带 force 也肯关",
    closed.closed.join() === String(opened.tabId), JSON.stringify(closed));
}

console.log(`\n结论：${fails === 0 ? "归属与默认目标全部符合契约" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
