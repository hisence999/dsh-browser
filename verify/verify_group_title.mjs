// 标签页分组名（第 1 项）：组名不再写死成 `DSH`。
//
// 这一台钉的是「组名可配置」之后**语义不许变形**的那几条：
//
//   1. 默认仍是 `DSH`（老行为不变），颜色仍是 blue；
//   2. 配置（policy 信封里的 `groupTitle`）与单次调用（`params.groupTitle`）都能改名字，
//      单次覆盖配置，且**两条路都真的把 Chrome 里的组名改了**（不是只改了返回值）；
//   3. 空串是**有含义的**（这次不分组），不能被 `|| 'DSH'` 吞成默认值；
//   4. 「归组 = 认领」这条老契约不因为改名而失效：`DSH` 组永远算 AI 的，配置里那个名字
//      的组也算，别的组不算；`ungroup` 只拆自己的组，不动用户的组；
//   5. 分组被关掉时 `tabs.group` 退化成「只认领、不建组」，不许报错把认领也一起废掉。
//
// 用法：
//   node verify/verify_group_title.mjs
//   node verify/verify_group_title.mjs ../../old/background.js    # 对未实现版本判红
import { bootBackground, makeModel } from "./ext_harness.mjs";

const CANDIDATE = process.argv[2];
let fails = 0;
const check = (name, ok, detail = "") => {
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};
/** 看门狗：挂住的验台在 CI 上等于「跑了一半没下文」，所以给整台一个上界。 */
const watchdog = setTimeout(() => {
  console.log("FAIL  整套超时（>90s）：某条用例把进程挂住了");
  process.exit(1);
}, 90_000);
watchdog.unref?.();
/** 未捕获异常折成一条 FAIL（否则命令一抛错就是把进程打死，只剩 exit code）。 */
process.on("uncaughtException", (error) => {
  console.log(`FAIL  未捕获异常：${String(error?.message ?? error)}`);
  process.exit(1);
});

const boot = async () => {
  const model = makeModel();
  const { ctx } = await bootBackground({ ...(CANDIDATE ? { backgroundPath: CANDIDATE } : {}), model });
  return { model, ctx };
};

/** 打开一个 AI 的标签页（`wait:false`：不陪导航等待，命令本身已经够慢了）。 */
const open = (ctx, params = {}) => ctx.cmdTabsOpen({ url: "https://agent.test/", wait: false, ...params });

/** 用户自己建了一个组并放了一个标签页进去（不是我们建的）。 */
const userGroup = (model, title, windowId = 1) => {
  const gid = 900 + model.groups.size;
  model.groups.set(gid, { id: gid, windowId, title, color: "grey" });
  const tabId = model.addTab(windowId, `https://user-${gid}.test/`);
  model.tabs.get(tabId).groupId = gid;
  return { gid, tabId };
};

/* 1 —— 默认：还是 DSH，颜色还是 blue */
{
  const { model, ctx } = await boot();
  const res = await open(ctx);
  const gid = res.grouped === true ? res.groupId : null;
  check("默认建组成功，结果里带 groupTitle", res.grouped === true && res.groupTitle === "DSH", JSON.stringify(res));
  check("Chrome 里那个组的标题真的是 DSH", gid !== null && model.groups.get(gid)?.title === "DSH", JSON.stringify([...model.groups.values()]));
  check("颜色仍是 blue（这一版没有开放颜色）", gid !== null && model.groups.get(gid)?.color === "blue");
  check("标签页真的在那个组里", model.tabs.get(res.tabId)?.groupId === gid);
}

/* 2 —— 配置里的名字：信封里的 groupTitle 决定组名 */
{
  const { model, ctx } = await boot();
  const res = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  check("信封里的 groupTitle 建出了那个名字的组", res.grouped === true && res.groupTitle === "AI-任务", JSON.stringify(res));
  check("Chrome 里那组的标题是 AI-任务", model.groups.get(res.groupId)?.title === "AI-任务", JSON.stringify([...model.groups.values()]));
  check("不再顺手造一个 DSH 组", [...model.groups.values()].every((g) => g.title !== "DSH"), JSON.stringify([...model.groups.values()].map((g) => g.title)));
}

/* 3 —— 单次调用覆盖配置 */
{
  const { model, ctx } = await boot();
  const res = await open(ctx, { policy: { groupTitle: "配置名" }, groupTitle: "本次名" });
  check("params.groupTitle 覆盖信封里的配置名", res.groupTitle === "本次名", JSON.stringify(res));
  check("Chrome 里也只出现本次名", model.groups.get(res.groupId)?.title === "本次名", JSON.stringify([...model.groups.values()].map((g) => g.title)));
}

/* 4 —— 空串 = 这次不分组（不能被 || 兜底成 DSH） */
{
  const { model, ctx } = await boot();
  const res = await open(ctx, { policy: { groupTitle: "" } });
  check("分组名留空 → 不建组，且如实报原因", res.grouped === false && res.reason === "grouping-disabled", JSON.stringify(res));
  check("确实一个组都没建", model.groups.size === 0, JSON.stringify([...model.groups.values()].map((g) => g.title)));
  check("标签页仍然被认领（不分组不等于不认领）", res.owned === true && res.agentTargetTabId === res.tabId);

  const override = await open(ctx, { policy: { groupTitle: "" }, groupTitle: "临时组" });
  check("配置留空时，单次给名字仍能建组", override.grouped === true && override.groupTitle === "临时组", JSON.stringify(override));
}

/* 4b —— 单次传空串同样是不分组（覆盖配置里那个非空名字） */
{
  const { model, ctx } = await boot();
  const res = await open(ctx, { policy: { groupTitle: "配置名" }, groupTitle: "" });
  check("params.groupTitle 传空串 → 这一次不分组", res.grouped === false && res.reason === "grouping-disabled", JSON.stringify(res));
  check("一个组都没建", model.groups.size === 0);
}

/* 5 —— group:false 仍然是不分组（老开关不许被新参数旁路） */
{
  const { model, ctx } = await boot();
  const res = await open(ctx, { policy: { groupTitle: "配置名" }, group: false });
  check("group:false 优先于配置里的名字", res.grouped === false && res.reason === "group:false", JSON.stringify(res));
  check("没有建组", model.groups.size === 0);
}

/* 6 —— 同名合流 / 异名分开 / 跨窗口各一个 */
{
  const { model, ctx } = await boot();
  const first = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  const second = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  check("同窗口同名 → 塞进同一个组（created:false、groupId 相同）",
    second.grouped === true && second.created === false && second.groupId === first.groupId,
    JSON.stringify({ first: first.groupId, second: second.groupId }));
  check("两个标签页都在同一组里", model.tabs.get(first.tabId)?.groupId === model.tabs.get(second.tabId)?.groupId);

  const other = await open(ctx, { policy: { groupTitle: "另一批" } });
  check("同窗口异名 → 另开一个组", other.groupId !== first.groupId, JSON.stringify({ a: first.groupId, b: other.groupId }));
  check("窗口里现在有两个组", [...model.groups.values()].filter((g) => g.windowId === 1).length === 2,
    JSON.stringify([...model.groups.values()].map((g) => `${g.windowId}:${g.title}`)));

  const inNewWindow = await open(ctx, { policy: { groupTitle: "AI-任务", tabs: "new-window" } });
  check("跨窗口不能复用别的窗口里的组", inNewWindow.groupId !== first.groupId,
    JSON.stringify({ w1: first.groupId, w2: inNewWindow.groupId }));
  check("新窗口里也有一个同名组（每个窗口一个）",
    [...model.groups.values()].filter((g) => g.title === "AI-任务").length === 2,
    JSON.stringify([...model.groups.values()].map((g) => `${g.windowId}:${g.title}`)));
}

/* 6b —— 用户自己也建了一个**同名**的组：不合并、不认领（这是第一版按标题认组时的洞） */
// 按标题认的话，用户把 `tabGroupTitle` 设成他也在用的名字（「工作」「调研」都极自然），
// 他那个组里的标签页会突然 `owned:true` —— `tabs.close` 不必 `force` 就能关，而关掉的页面
// 找不回来。所以「我们的组」按 id 认：同名不合并。
{
  const { model, ctx } = await boot();
  const userOwned = userGroup(model, "AI-任务");
  const res = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  check("同名但属于用户的组：另建一个新组，不塞进他那个组",
    res.grouped === true && res.created === true && res.groupId !== userOwned.gid,
    JSON.stringify({ got: res.groupId, userGroup: userOwned.gid }));
  const listed = await ctx.runCommand("tabs.list", { policy: { groupTitle: "AI-任务" } });
  const row = listed.tabs.find((t) => t.id === userOwned.tabId);
  check("他那个组里的标签页仍然不是 AI 的（close 必须 force）", row?.owned === false, JSON.stringify(row));
  const closed = await ctx.runCommand("tabs.close", { tabId: userOwned.tabId, policy: { groupTitle: "AI-任务" } });
  check("真的去关它 → refused not_owned_by_agent，且那个 id 没进 tabs.remove",
    closed.requested === 1 && closed.closed.length === 0 && closed.refused?.[0]?.tabId === userOwned.tabId,
    JSON.stringify(closed));
  check("用户的标签页还在", model.tabs.has(userOwned.tabId));
}

/* 7 —— 归属：只认**我们建过的**组；用户自己建的组（哪怕标题一样）不算 */
{
  const { model, ctx } = await boot();
  const legacy = userGroup(model, "DSH"); // 用户自己建了个叫 DSH 的组
  const stranger = userGroup(model, "用户自己的工作");
  const ours = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  // 用户把一个标签页拖进**我们的**组：这是文档里写的「看得见的认领手势」。
  const dragged = model.addTab(1, "https://dragged.test/");
  model.tabs.get(dragged).groupId = ours.groupId;

  const listed = await ctx.runCommand("tabs.list", { policy: { groupTitle: "AI-任务" } });
  const row = (id) => listed.tabs.find((t) => t.id === id);
  check("用户自己建的 DSH 组不算 AI 的（按 id 认，不按标题猜）", row(legacy.tabId)?.owned === false, JSON.stringify(row(legacy.tabId)));
  check("无关标题的组不算 AI 的", row(stranger.tabId)?.owned === false, JSON.stringify(row(stranger.tabId)));
  check("拖进 AI 那个组的标签页算 AI 的（认领手势仍然成立）", row(dragged)?.owned === true, JSON.stringify(row(dragged)));
  check("AI 自己开的也在", row(ours.tabId)?.owned === true);

  const closed = await ctx.runCommand("tabs.close", { tabId: dragged, policy: { groupTitle: "AI-任务" } });
  check("归属落到行为上：拖进来的标签页不必 force 就能关", closed.closed?.[0] === dragged, JSON.stringify(closed));
}

/* 7b —— 改了配置名，之前建的组仍然是我们的（按 id 记） */
{
  const { model, ctx } = await boot();
  const res = await open(ctx, { policy: { groupTitle: "老名字" } });
  const relisted = await ctx.runCommand("tabs.list", { policy: { groupTitle: "新名字" } });
  check("换了组名之后，老组里的标签页仍算 AI 的", relisted.tabs.find((t) => t.id === res.tabId)?.owned === true,
    JSON.stringify(relisted.tabs.find((t) => t.id === res.tabId)));
}

/* 8 —— ungroup：只拆我们建过的组，用户的同名组一个都不动 */
{
  const { model, ctx } = await boot();
  const userSameName = userGroup(model, "AI-任务"); // 用户自己的同名组
  const stranger = userGroup(model, "用户自己的工作");
  const mine = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  const res = await ctx.runCommand("tabs.ungroup", { policy: { groupTitle: "AI-任务" } });
  check("ungroup 只拆我们建的那个组", res.groups === 1 && res.ungrouped === 1, JSON.stringify(res));
  check("用户的同名组原样留着（组还在、标签页还在组里）",
    model.tabs.get(userSameName.tabId)?.groupId === userSameName.gid && model.groups.has(userSameName.gid),
    JSON.stringify({ groupId: model.tabs.get(userSameName.tabId)?.groupId, want: userSameName.gid }));
  check("无关的组当然也没动", model.tabs.get(stranger.tabId)?.groupId === stranger.gid);
  check("被拆的标签页不再是 AI 的（拆组 = 放手）", model.tabs.get(mine.tabId)?.groupId === -1,
    String(model.tabs.get(mine.tabId)?.groupId));
}

/* 8b —— 单次 `groupTitle` 建的组，也必须能被 ungroup 放手（按 id 记才不会漏） */
{
  const { model, ctx } = await boot();
  const one = await open(ctx, { groupTitle: "临时任务" });
  const res = await ctx.runCommand("tabs.ungroup", {}); // 配置名还是默认 DSH
  check("单次命名的组也拆得掉", res.groups === 1 && res.ungrouped === 1, JSON.stringify(res));
  check("标签页真的回到未分组", model.tabs.get(one.tabId)?.groupId === -1);
}

/* 8c —— 拆完之后再开：不许塞回刚拆掉的那个组 id（拆组要连「那是我们的组」一起忘掉） */
{
  const { model, ctx } = await boot();
  const first = await open(ctx);
  await ctx.runCommand("tabs.ungroup", {});
  const again = await open(ctx);
  check("拆完之后再 open 会建新组，不会塞回刚拆掉的 id",
    again.grouped === true && again.created === true && again.groupId !== first.groupId,
    JSON.stringify({ once: first.groupId, again: again.groupId }));
}

/* 9 —— tabs.group：把用户的标签页收进指定名字的组，并认领它 */
{
  const { model, ctx } = await boot();
  const userTab = model.addTab(1, "https://user.test/");
  const res = await ctx.runCommand("tabs.group", { tabId: userTab, groupTitle: "收进来的" });
  check("tabs.group 用指定名字建组", res.grouped === true && res.groupTitle === "收进来的", JSON.stringify(res));
  check("标签页进了那个组", model.groups.get(res.groupId)?.title === "收进来的" && model.tabs.get(userTab)?.groupId === res.groupId);
  check("归组同时是认领：owned 且成为默认目标", res.owned === true && res.agentTargetTabId === userTab);
}

/* 9b —— 分组被关掉时，tabs.group 退化成「只认领、不建组」，不许连认领一起废掉 */
{
  const { model, ctx } = await boot();
  const userTab = model.addTab(1, "https://user.test/");
  // 这一条也是「不许抛错」的守卫：命令抛错会让整台变成「跑到一半没下文」。
  const res = await ctx.runCommand("tabs.group", { tabId: userTab, policy: { groupTitle: "" } })
    .catch(error => ({ threw: String(error?.message ?? error) }));
  check("关掉分组时 tabs.group 不报错，如实报原因", res.grouped === false && res.reason === "grouping-disabled", JSON.stringify(res));
  check("认领照做（默认目标指过去）", res.owned === true && res.agentTargetTabId === userTab);
  check("没有偷偷建组", model.groups.size === 0 && model.tabs.get(userTab)?.groupId === -1);
}

/* 10 —— 名字归一：压平空白、去首尾、限长 40 */
{
  const { model, ctx } = await boot();
  const messy = await open(ctx, { groupTitle: "  AI   任务  " });
  check("组名压平空白并去首尾", messy.groupTitle === "AI 任务", JSON.stringify(messy.groupTitle));
  check("Chrome 里的标题也是归一后的", model.groups.get(messy.groupId)?.title === "AI 任务");

  const long = await open(ctx, { groupTitle: "x".repeat(60) });
  check("超长组名被切到 40 字（标签条放得下）", long.groupTitle.length === 40, String(long.groupTitle.length));
  check("Chrome 里同样是 40 字", String(model.groups.get(long.groupId)?.title ?? "").length === 40);
}

/* 11 —— 归组失败不连坐「打开标签页」这件事本身 */
{
  const { model, ctx } = await boot();
  model.failGroupTimes = 99;
  const res = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  check("归组失败时 tabs.open 仍然成功，并如实报 grouped:false",
    typeof res.tabId === "number" && res.grouped === false && typeof res.reason === "string", JSON.stringify(res));
  check("标签页真的存在且被认领", model.tabs.has(res.tabId) && res.owned === true);
}

/* 12 —— tabs.list 的 owned 覆盖老路径与自定义名字两条路 */
{
  const { model, ctx } = await boot();
  const mine = await open(ctx, { policy: { groupTitle: "AI-任务" } });
  const listed = await ctx.runCommand("tabs.list", { policy: { groupTitle: "AI-任务" } });
  const row = listed.tabs.find((t) => t.id === mine.tabId);
  check("自己开的标签页 owned:true", row?.owned === true, JSON.stringify(row));
  check("agentTargetTabId 指向它", listed.agentTargetTabId === mine.tabId, String(listed.agentTargetTabId));
}

console.log(fails === 0
  ? "\n分组名可指定：契约成立"
  : `\n${fails} 条不成立`);
process.exit(fails === 0 ? 0 : 1);
