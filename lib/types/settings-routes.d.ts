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
}
/** Build the one prefix route the Settings page talks to. */
export declare function buildSettingsRoute(deps: SettingsRouteDeps): SettingsWebRoute;
