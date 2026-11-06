/**
 * Host-side HTTP surface for the "浏览器控制" Settings page.
 *
 * The page is a Client module (`client.js`) rendered in the `settings.section`
 * slot. A Client module cannot call Host Services directly, and the bridge's own
 * port (`127.0.0.1:9777`) is a different origin from the Web GUI, so the page
 * cannot fetch it either (the bridge deliberately sends no CORS headers). This
 * module mounts a same-origin JSON endpoint on the Web server instead, behind the
 * same browser-trust fence the shipped `/api` gateway uses:
 *
 *   1. Host header must name the loopback interface or this listener's own
 *      origin (DNS-rebinding defense — the one header a rebound page cannot forge).
 *   2. `sec-fetch-site: cross-site` is refused.
 *   3. An attached `Origin` must be exactly the request's own authority.
 *
 * Every operation here is also reachable from an agent tool path (`cleanup` is
 * `browser_cleanup`, config edits persist through the Loader). The page is a
 * second caller of the same operations, not a separate implementation.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Absolute prefix the route owns on the Web server. */
export declare const SETTINGS_API_PREFIX = "/browser-control/api";
/**
 * 分组名上限。插件侧（`src/index.ts`）往信封里盖章时切一次，扩展建组时再切一次，
 * 这里是设置页那一层——三处必须同一个数，所以它从这里导出，index.ts 直接引用它。
 */
export declare const TAB_GROUP_TITLE_MAX = 40;
/**
 * 浏览器可执行文件路径的长度上限。
 *
 * 比分组名宽得多：Windows 的完整路径本来就长（`C:\Program Files (x86)\…`），而且
 * 便携版/自定义安装可能更深。这里只挡住明显是垃圾的超长输入，不做任何路径归一——
 * 路径该长什么样由文件系统说了算。
 */
export declare const BROWSER_PATH_MAX = 512;
/**
 * `@` 引用菜单一次最多列多少行。
 *
 * 超出的行不返回，但仍计入 `total`：菜单可以据此说「还有更多」，而用户不会以为
 * 自己只开了 50 个页（一个开满标签页的浏览器很容易超过这个数）。
 */
export declare const TAB_REFERENCE_LIMIT = 50;
/**
 * 标签页列表的缓存窗口。
 *
 * `candidates` 是**每敲一个字符**调一次的回调，而一次 `tabs.list` 要跨 WebSocket 往返
 * 到浏览器扩展。两秒内复用上一份结果：键盘连击不会变成命令风暴，代价只是「刚开的页
 * 最迟两秒后才出现在菜单里」，这个延迟用户察觉不到。
 */
export declare const TAB_REFERENCE_TTL_MS = 2000;
/** The subset of the resolved plugin config this surface reports. */
export interface SettingsConfigView {
    enabled?: boolean;
    port?: number;
    token?: string;
    readOnly?: boolean;
    allowScript?: boolean;
    lazyToolDocs?: boolean;
    allowRawCdp?: boolean;
    /** Isolated instance (incognito jar) authorisation; separate from the two read gates. */
    allowIncognito?: boolean;
    /** Enum settings: the page renders one `<select>` per field, so it needs the current word. */
    tabWindow?: 'current' | 'new';
    focusPolicy?: 'avoid' | 'auto';
    userTakeover?: 'yield' | 'ignore';
    /** Chrome tab group name for AI-opened tabs; `''` means "do not group". */
    tabGroupTitle?: string;
    /** Blue gradient frame around the tab the agent is driving. */
    agentHighlight?: boolean;
    /**
     * 显式指定的浏览器可执行文件路径（`browser_launch` 用）。
     * 空串 = 按已知位置 → PATH → 目录搜索自动找；非空 = **只用它**。
     */
    browserPath?: string;
}
/**
 * `@` 菜单一行（宿主面的形状；客户端再把它包成 `inputTriggers` 的候选）。
 *
 * 字段刻意少：这是要进**用户输入框菜单**的东西，多一个字段就多一个以后不敢改的契约。
 */
export interface ReferenceTab {
    /** 扩展的标签页 id。它会进 ref 载荷，重启浏览器后失效——客户端点空时静默失败。 */
    id: number;
    /** 页面标题；空标题已在这边兜成 `host + pathname`，所以永远是可读的非空串。 */
    title: string;
    url: string;
    windowId: number;
    /** 该窗口当前的活跃页。排序用：活跃页排最前。 */
    active: boolean;
}
/** `GET /tabs` 返回的 `value`。 */
export interface ReferenceTabsSnapshot {
    tabs: readonly ReferenceTab[];
    /** 取到这份清单的**服务端**时刻；命中缓存或失败回落时不刷新它。 */
    fetchedAt: number;
    /** true 表示这不是本次新取的（TTL 内复用，或新取失败后回落旧快照）。 */
    stale: boolean;
    /** 过滤之后、截断之前的总行数：菜单可以据此说明「还有更多」。 */
    total: number;
}
/**
 * 标签页列表的读取与缓存。
 *
 * 单独抽出来是因为它有两条**互相独立**的正确性要求，混在 HTTP handler 里就测不动：
 * 过滤（哪些页能出现在菜单里）与缓存（每敲一个键调用一次时不许把扩展敲穿）。
 */
export interface ReferenceTabsCache {
    /** 一份清单；并发调用共享同一次上行，失败时回落旧快照。 */
    read: (signal?: AbortSignal) => Promise<ReferenceTabsSnapshot>;
    /**
     * 结束可能还在途的共享取数（路由摘掉时调用）。
     *
     * 有它是因为共享取数刻意**不**挂在任何调用者的信号上（见 `createReferenceTabsCache`
     * 的注释）：既然没有别人能取消它，就必须有一个明确的归还路径，否则插件卸载后
     * 那次 `tabs.list` 还得等桥接自己的超时。
     */
    dispose: () => void;
}
/** What the route needs from the plugin; keeps this module free of a circular import. */
export interface SettingsRouteDeps {
    /** npm package name whose profile row is edited. */
    packageName: string;
    /** Live resolved config, or undefined before the first settings snapshot. */
    getConfig: () => SettingsConfigView | undefined;
    /** The live bridge status (extension link, protocol, pending commands, …). */
    status: () => unknown;
    /** Same operation `browser_cleanup` performs (policy gate included). */
    cleanup: () => Promise<{
        shotsRemoved: number;
        scratchRemoved: readonly string[];
    }>;
    /**
     * 列「用户自己开的、正常罐里的」标签页，给输入框的 `@` 菜单用。
     *
     * 只暴露这一个回调而不是整个 controller：过滤与缓存都在本模块（纯函数、可单测），
     * 这里只负责把扩展的原始结果拿回来。返回值得是 `tabs.list` 的原始形状——
     * 老扩展没有 `openedByAgent` 字段是常态，别在这一层补。
     */
    listTabs?: (signal?: AbortSignal) => Promise<unknown>;
    /** 点 chip 时把那个标签页叫到前台；走 `tabs.activate`，因而受只读档限制。 */
    activateTab?: (tabId: number, signal?: AbortSignal) => Promise<unknown>;
    /** Resolve an optional Host service by name; undefined when absent. */
    getService: (name: string) => unknown;
    /** `http://host:port` this Web server is served from, when known. */
    origin?: string;
}
/** One Web route as the Host `webServer` service accepts it. */
export interface SettingsWebRoute {
    kind: 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    /**
     * 路由被摘掉时释放它自己的资源（当前是 `@` 菜单那份标签页缓存在途的取数）。
     *
     * 必须由挂载方在摘除时调用：共享取数刻意不挂在任何调用者的信号上（见
     * `createReferenceTabsCache` 的注释），所以除了这里没有第二条路能结束它。
     * 宿主不认识这个字段也不会出错——它是**可选**的，`webServer.register` 只吃
     * `kind` / `path` / `handler`。
     */
    dispose?: () => void;
}
/**
 * 从扩展 `tabs.list` 的原始结果里挑出可以进 `@` 菜单的行。
 *
 * 这是本需求的全部判据，用户的原话是「标签页无需包含无痕，Ai自己开的不算」：
 *
 *   - `incognito === true` 丢掉：无痕罐里的页是用户用来临时登录/试流程的，把它列进
 *     菜单等于把隔离实例的意义抹掉；
 *   - **`openedByAgent === true` 丢掉，但必须按这个字段、不能按 `owned`。** `owned`
 *     的语义是「被 AI 拥有」，用户自己的页只要被 `tabs.group` 拉进过 AI 分组也会变
 *     `owned === true`；按 `owned` 过滤会把用户本来要找的页静默吞掉。`openedByAgent`
 *     只记「`tabs.open` 真的新建的」，正是本需求要的那件事；
 *   - 缺失字段一律按 `false`：老扩展根本不发 `openedByAgent`，那时宁可多列（fail-open），
 *     也不要让菜单里空得像是坏了。
 * @param raw - 扩展的 `tabs.list` 结果，形状见 `SettingsRouteDeps.listTabs`。
 * @param limit - 最多返回多少行；`total` 仍报过滤后的总数。
 * @returns 截断后的行，以及截断前的总数。
 */
export declare function selectReferenceTabs(raw: unknown, limit?: number): {
    tabs: ReferenceTab[];
    total: number;
};
/**
 * 造一个带 TTL 与 in-flight 合并的标签页缓存。
 *
 * 两条约束都来自同一个事实：`candidates` 每敲一个键调用一次，而每次真要取数都得跨
 * WebSocket 问一次浏览器扩展。
 *
 *   - TTL 内直接复用，不再上行；
 *   - 并发的读共享**同一个** in-flight promise：连打三个字母不该变成三条上行命令；
 *   - 取失败时如果手上有旧快照就回落旧快照，只有一次都没成功过才把错误抛给调用方——
 *     浏览器关着呢，菜单不该整个空掉。
 *
 * `stale` 只有**一条**规则，在读取时按年龄现算：
 *
 *     stale === (now() - fetchedAt) > ttlMs
 *
 * 不按分支写死。理由是「TTL 内命中」与「取失败回落」看着是两件事，其实是同一件事的
 * 两个读数：前者年龄必然 < ttlMs，后者年龄按构造必然 > ttlMs（否则早被 TTL 分支吃掉）。
 * 收口成年龄判据之后，TTL 命中报 false、失败回落报 true，两条性质在同一条规则下同时
 * 成立，不再存在两套口径；将来把 ttlMs 改成 0 或很大，行为依然自洽。
 * @param fetchTabs - 真正取一次原始清单的回调（`controller.execute('tabs.list')`）。
 * @param options - `ttlMs` / `limit` / `now`（注入时钟，便于验台不睡真实时间）。
 */
export declare function createReferenceTabsCache(fetchTabs: (signal?: AbortSignal) => Promise<unknown>, options?: {
    ttlMs?: number;
    limit?: number;
    now?: () => number;
}): ReferenceTabsCache;
/** Build the one prefix route the Settings page talks to. */
export declare function buildSettingsRoute(deps: SettingsRouteDeps): SettingsWebRoute;
