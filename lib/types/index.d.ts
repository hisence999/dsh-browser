/**
 * Browser-bridge plugin: one local WebSocket endpoint the DSH Browser
 * extension connects to, plus the model-facing `browser_*` tools that drive
 * it. The Settings-managed `enabled` flag starts and stops the listener live
 * through dsh-settings' change hook — no reload needed.
 *
 * Settings integration is feature-detected, never assumed. The plugin bypasses the
 * higher-level `installSettingsSection` helper (importing it on a build that does not
 * export it crashes the plugin at module load) and calls the lower-level
 * `sctx.settings.register` only when the host actually has it — dsh-settings up to
 * 0.1.2-rc.1. 0.1.7-rc.2 and 0.2.x export `SettingsForms` with no `register`, so there
 * the bridge converges from the profile config alone and the host projects this
 * plugin's own `Config` schema into the settings page.
 *
 * Tools stay mounted whenever the plugin does; calling one while the bridge
 * is disabled or the extension is offline fails with a message naming the
 * fix, so the model can tell the user what to do instead of hanging.
 * @module @deepseek-ai/dsh-browser-bridge
 */
import { type Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
export { LOCAL_DESTRUCTIVE_COMMANDS, PAGE_MUTATING_COMMANDS, READ_ONLY_ALLOWED, SCRIPT_COMMANDS, policyRefusal } from './policy.ts';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "browser-bridge";
/** npm package name whose profile row the Settings page edits. */
export declare const PACKAGE_NAME = "dsh-browser";
/** The tool registry this plugin contributes `browser_*` tools to. */
export declare const inject: string[];
/** Settings namespace carrying the bridge switch and endpoint options. */
export declare const BROWSER_BRIDGE_SETTINGS_NAMESPACE = "browser-bridge";
export interface Config {
    /**
     * Whether the local bridge listens. Defaults to true so the plugin is
     * usable immediately after install; set false to keep the tools mounted but
     * every call reports how to enable the bridge, so the opt-out stays explicit.
     */
    enabled?: boolean;
    /** Loopback port the extension dials; the HTTP face shares it. */
    port?: number;
    /** Shared secret the extension presents on the WebSocket upgrade query. */
    token?: string;
    /**
     * Directory screenshots are written to and `cleanup` clears. Relative paths
     * resolve against the process working directory at resolve time.
     */ shotsDir?: string;
    /**
     * Read-only mode: refuse every command that would change the page or the
     * browser (click / input / press / nav / scroll / tabs.* / emulate / dialog /
     * network.clear …) while reads keep working. Off by default. Takes effect
     * live — the gate reads the current settings on every call.
     */
    readOnly?: boolean;
    /**
     * Allow running arbitrary page scripts (`browser_evaluate`). On by default,
     * because that tool is the escape hatch when no dedicated command fits. Set
     * false to keep clicks and reads while forbidding arbitrary JS in the page:
     * `browser_evaluate` can do everything the other tools can, so "read-only"
     * alone does not take arbitrary code off the table.
     */
    allowScript?: boolean;
    /**
     * 工具懒启动：只在模型面前暴露一个 `browser_tools`，其余工具由它按需装载。
     *
     * 打开后每次请求的工具块从「全部工具的完整描述」缩成「一个工具 + 它的完整描述」；
     * 装载过的工具**拿到的仍是完整描述**，没有任何降级——这个开关改变的是「暴不暴露」，
     * 不是「描述多长」。装载是**会话级**的：注册落进发起装载那个 agent 的 scope，别的会话
     * 仍只有装载器，会话结束自动回收（拿不到 agent 的调用退回全局层并如实报 `scope`）。
     * 键名沿用历史的 `lazyToolDocs`，因为它已经写进了用户的 profile
     * 覆盖层，改名会让老配置被 zod 静默丢掉、开关自己回到默认值。
     */
    lazyToolDocs?: boolean;
    /**
     * Allow `browser_cdp`, the raw CDP escape hatch. On by default; it is still
     * refused by `readOnly` and by `allowScript: false`, because every CDP
     * domain — `Runtime.evaluate` included — is reachable through it.
     */
    allowRawCdp?: boolean;
    /**
     * Allow the isolated instance — `browser_profile` launching/closing an
     * incognito window (its own cookie jar, wiped when it closes), and pointing
     * later commands at that jar.
     *
     * Off by default: the isolated instance needs **two** human authorisations —
     * this switch, and the browser's own "Allow in incognito/InPrivate" toggle on
     * the extension's management page. We deliberately do not add a third
     * automatic channel: both of those are the user's decisions, and a model that
     * could open an incognito window on its own would also gain a way to reach a
     * signed-in site the user never pointed it at.
     */
    allowIncognito?: boolean;
    /**
     * Where `browser_tabs action=open` puts a new tab: `current` opens it in the
     * window the user is looking at and collects it into the DSH group, `new`
     * opens a separate window that is deliberately not focused. Exists because
     * the agent's tabs are the user's visual mess: one default cannot fit both
     * "work visibly next to me" and "get out of my window".
     */
    tabWindow?: 'current' | 'new';
    /**
     * `avoid` never raises a window to the foreground. Real input events go
     * through CDP, which never needed OS focus, so the old
     * `windows.update({focused: true})` was only ever cosmetic — and it is the
     * most visible way an agent hijacks the user's desktop. `auto` restores it.
     */
    focusPolicy?: 'avoid' | 'auto';
    /**
     * What the extension does when the user visits a tab the agent is driving:
     * `yield` refuses the next page-mutating command there and says how to
     * continue, `ignore` keeps going. Defaults to `yield` because typing and
     * clicking on the same page at the same time destroys both sides' work.
     */
    userTakeover?: 'yield' | 'ignore';
    /**
     * Name of the Chrome tab group AI-opened tabs collect into.
     *
     * The tab strip is the user's own space, so the label has to be theirs to
     * choose — `DSH` is only the default. An **empty string means "do not group
     * at all"**, which is why it cannot be `|| 'DSH'`-defaulted away: "I do not
     * want a group" is a real preference, not a missing value.
     */
    tabGroupTitle?: string;
    /**
     * Draw the blue gradient frame around the tab the agent is driving.
     *
     * Purely visual: a `pointer-events: none` overlay injected into the page, so
     * it never intercepts a click, and it is hidden again while a screenshot is
     * taken. On by default, because "which page is the machine touching right
     * now" is exactly the question a user watching their own browser asks.
     */
    agentHighlight?: boolean;
}
export declare const Config: z<Config>;
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export declare function apply(ctx: Context, config: Config): void;
