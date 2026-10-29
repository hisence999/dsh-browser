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
export declare const TOOL_GROUPS: Readonly<Record<string, readonly string[]>>;
/** 反查：工具属于哪个分组；不在表里返回 `undefined`（验台保证不会发生）。 */
export declare function groupOf(name: string): string | undefined;
/** First sentence (or a bounded prefix) of a description, for the catalog. */
export declare function summarize(description: string): string;
