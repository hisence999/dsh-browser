/**
 * 工具懒启动（`lazyToolDocs: true`）时，模型唯一看得见的工具是 `browser_tools`。
 *
 * 全开模式下这个模块只提供 `summarize`（目录里的一行简介）；懒启动模式下
 * {@link TOOL_GROUPS} 是模型**唯一的发现入口**：它必须能从 `browser_tools` 的描述里
 * 读出「有哪些工具、怎么一次装齐」。所以这张分组表不许和工具清单漂移 ——
 * `verify/verify_tool_docs.mjs` 断言它恰好覆盖每一个注册工具一次，「新加了工具忘了
 * 归组」会当场把验台判红。
 *
 * 这里**没有**「描述桩」：懒启动改变的是「暴不暴露」，不是「描述多长」。装上的工具
 * 拿到的就是它自己的完整描述，一个字都不换。
 */
/** 分组 → 工具全名。**每个工具恰好属于一个分组**（验台钉着「恰好一次」）。 */
export const TOOL_GROUPS = {
    // 只观察、不动页面。
    read: [
        'browser_read',
        'browser_snapshot',
        'browser_find',
        'browser_info',
        'browser_wait',
        'browser_console_log',
        'browser_network_log',
    ],
    // 会改页面（或页面里看见的东西）：等于扩展侧让出判定里的「写命令」+ 逃生口。
    write: [
        'browser_navigate',
        'browser_click',
        'browser_type',
        'browser_press',
        'browser_scroll',
        'browser_evaluate',
        'browser_hold',
        'browser_dialog',
    ],
    // 标签页、罐（jar）、临时文件与日志账本。
    tabs: [
        'browser_tabs',
        'browser_profile',
        'browser_cleanup',
        'browser_network_clear',
    ],
    // 落盘的东西与设备仿真。
    capture: [
        'browser_screenshot',
        'browser_pdf',
        'browser_emulate',
    ],
    // 原始 CDP 逃生口：单独一组，因为它能做的事就是「其余全部」。
    raw: [
        'browser_cdp',
    ],
};
/** 反查：工具属于哪个分组；不在表里返回 `undefined`（验台保证不会发生）。 */
export function groupOf(name) {
    for (const [group, names] of Object.entries(TOOL_GROUPS)) {
        if (names.includes(name))
            return group;
    }
    return undefined;
}
/** First sentence (or a bounded prefix) of a description, for the catalog. */
export function summarize(description) {
    const line = description.replace(/\s+/g, ' ').trim();
    if (line.length === 0)
        return '(no description)';
    const stop = line.search(/[。！？]|\.\s/);
    const head = stop > 0 ? line.slice(0, stop + 1) : line;
    return head.length <= 120 ? head : `${head.slice(0, 117)}…`;
}
