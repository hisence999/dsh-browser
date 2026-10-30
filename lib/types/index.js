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
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { BridgeServer, cleanupArtifacts } from "./server.js";
import { BridgeError, classify } from "./errors.js";
import { policyRefusal } from "./policy.js";
import { buildSettingsRoute, TAB_GROUP_TITLE_MAX } from "./settings-routes.js";
import { TOOL_GROUPS, groupOf, summarize } from "./tool-help.js";
// Re-exported so the policy tables stay testable from the published bundle
// (verify/verify_policy.mjs reconciles them against the extension's COMMANDS).
export { LOCAL_DESTRUCTIVE_COMMANDS, PAGE_MUTATING_COMMANDS, READ_ONLY_ALLOWED, SCRIPT_COMMANDS, policyRefusal } from "./policy.js";
/** Cordis plugin name used by loader diagnostics. */
export const name = 'browser-bridge';
/** npm package name whose profile row the Settings page edits. */
export const PACKAGE_NAME = 'dsh-browser';
/** The tool registry this plugin contributes `browser_*` tools to. */
export const inject = ['tools', 'systemPrompt'];
/** Settings namespace carrying the bridge switch and endpoint options. */
export const BROWSER_BRIDGE_SETTINGS_NAMESPACE = 'browser-bridge';
export const Config = z.object({
    enabled: z.boolean().default(true),
    port: z.number().step(1).min(1024).max(65_535).default(9777),
    token: z.string().default('dsh-local'),
    shotsDir: z.string().default('dsh-browser-shots'),
    readOnly: z.boolean().default(false),
    allowScript: z.boolean().default(true),
    lazyToolDocs: z.boolean().default(false),
    allowRawCdp: z.boolean().default(true),
    allowIncognito: z.boolean().default(false),
    tabWindow: z.union(['current', 'new']).default('current'),
    focusPolicy: z.union(['avoid', 'auto']).default('avoid'),
    userTakeover: z.union(['yield', 'ignore']).default('yield'),
    tabGroupTitle: z.string().default('DSH'),
    agentHighlight: z.boolean().default(true),
});
const SNAPSHOT_REF_SELECTOR_PATTERN = /^e\d+$/;
/**
 * 归一配置里的分组名：压平空白、限长（上限与设置页那一层共用 `TAB_GROUP_TITLE_MAX`）。
 *
 * 空串**是有含义的**（这一次不分组），所以这里不能用 `|| 'DSH'` 兜底——那会让「我不
 * 想要分组」这个选择悄悄变回默认分组，而用户只会看到 AI 又分了个组。只有非字符串
 * （配置还没加载）才退回默认值。
 * @param raw - 配置里的 `tabGroupTitle`。
 * @returns 归一后的分组名；`''` 表示不分组。
 */
function groupTitleOf(raw) {
    if (typeof raw !== 'string')
        return 'DSH';
    return raw.replace(/\s+/g, ' ').trim().slice(0, TAB_GROUP_TITLE_MAX);
}
/** One `browser_read` window, in characters of page text. Longer pages are paged
 *  with `offset`, so no single call can put a whole site into the transcript. */
const READ_WINDOW_MAX_CHARS = 20_000;
/**
 * Owns zero or one live {@link BridgeServer} and restarts it whenever the
 * resolved settings change. Reconciles serialize through a promise chain so a
 * burst of settings commits cannot interleave stop/start pairs.
 */
class BridgeController {
    log;
    server;
    serverKey = '';
    lastError;
    chain = Promise.resolve();
    current;
    constructor(log) {
        this.log = log;
    }
    /** Resolved directory screenshots land in; defined once any config arrived. */
    get shotsDir() {
        return this.current === undefined ? undefined : path.resolve(this.current.shotsDir);
    }
    /**
     * Live link state for the Settings page (and nothing else — the model-facing
     * `browser_info` still asks the extension for the truth it reports there).
     * @returns a JSON-safe snapshot; `configured: false` before the first config.
     */
    status() {
        const config = this.current;
        if (config === undefined)
            return { configured: false };
        const server = this.server;
        if (server === undefined) {
            return {
                configured: true,
                enabled: false,
                lastError: this.lastError ?? null,
            };
        }
        const live = server.status;
        return {
            configured: true,
            enabled: true,
            listening: live.listening,
            port: live.port ?? null,
            pendingCommands: live.pendingCommands,
            lastError: live.lastError ?? this.lastError ?? null,
            insecureToken: live.insecureToken,
            extension: {
                connected: live.extensionConnected,
                connectedAt: live.connectedAt ?? null,
                hello: live.hello ?? null,
                protocol: live.extensionProtocol,
                compatible: live.protocolCompatible,
                note: live.protocolNote ?? null,
            },
        };
    }
    /**
     * Converge the live server onto `config`. With `throwOnError`, an initial
     * start failure rejects (fail-loud activation); later changes record the
     * failure instead, so a bad port cannot tear down an otherwise running session.
     * @param config - the freshly resolved settings snapshot.
     * @param options - set `throwOnError` only for the activation-time call.
     * @returns a promise settling once the convergence attempt finished.
     */
    reconcile(config, options = {}) {
        this.current = config;
        const run = this.chain.then(() => this.reconcileNow(config));
        this.chain = run.catch(() => { });
        if (options.throwOnError === true) {
            return run.catch((error) => {
                throw error instanceof Error ? error : new Error(String(error));
            });
        }
        return Promise.resolve();
    }
    async reconcileNow(config) {
        const shotsDir = path.resolve(config.shotsDir);
        const key = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : '';
        if (key === this.serverKey)
            return;
        const previous = this.server;
        this.server = undefined;
        this.serverKey = '';
        await previous?.stop();
        if (!config.enabled) {
            this.lastError = undefined;
            return;
        }
        const server = new BridgeServer({ port: config.port, token: config.token, shotsDir, log: this.log });
        try {
            await server.start();
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`;
            this.log(this.lastError);
            throw error instanceof Error ? error : new Error(message);
        }
        this.server = server;
        this.serverKey = key;
        this.lastError = undefined;
    }
    /**
     * Run one extension command over the live link.
     * @param command - extension command name (`nav`, `click`, …).
     * @param params - wire params passed through to the extension.
     * @param signal - tool-execution cancellation propagated to the pending command.
     * @param timeoutMs - per-command bridge ceiling; omit for the default. Commands
     *   that wait inside the page (browser_wait) must pass a value larger than their
     *   own page-level timeout, otherwise the bridge aborts first and the caller
     *   cannot tell a slow page from a dead link.
     * @returns the extension's result payload verbatim.
     */
    async execute(command, params, signal, timeoutMs) {
        this.policyGate(command, params);
        const server = this.server;
        if (server === undefined) {
            throw classify(command, new Error(this.lastError ?? '浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true（dsh 0.1.7+ 的宿主也会在设置 → 插件 自动列出本插件开关；0.1.2 及更早的宿主没有这张卡片，只能改配置文件）'));
        }
        // 策略信封在**这里**盖一次，而不是每个工具的 execute 里各写一遍：工具会一直
        // 增加，漏掉一个就静默退回旧行为（抢用户焦点、把标签页开进用户的窗口），而
        // 那种坏法不会报错。扩展侧刻意不持有策略状态，所以「每条命令都带」是这条
        // 契约唯一能在一处验证的形态。
        return server.execute(command, { ...params, policy: this.policyEnvelope() }, timeoutMs === undefined ? { signal } : { signal, timeoutMs });
    }
    /**
     * Which cookie jar the next commands land in. Host-side state only: the
     * extension keeps no copy, it reads `policy.jar` off every command (the same
     * "no policy state on the far side" rule the other three envelope fields
     * follow), so a stale replica cannot silently route a command to the wrong jar.
     */
    jar = 'normal';
    /** The jar stamped onto outgoing commands; `browser_profile action=use` sets it. */
    get currentJar() {
        return this.jar;
    }
    /** Point later commands at a jar without consulting the gate. */
    setJar(jar) {
        this.jar = jar;
    }
    /**
     * Switch the jar subsequent commands land in, going through the same gate as
     * `profile.launch` when the target is the isolated one.
     *
     * `use jar=incognito` looks like "just flip a pointer", but the very next
     * `tabs.open` carries `policy.jar: 'incognito'` and the extension then creates
     * the incognito window on its own (`ensureIsolatedWindow`) — the `profile.launch`
     * gate would never run, so `allowIncognito: false` would be a decoration. Leaving
     * the isolated jar (`normal`) is always safe and is never gated.
     * @param target - jar later commands should land in.
     */
    switchJar(target) {
        if (target === 'incognito')
            this.policyGate('profile.launch');
        this.setJar(target);
    }
    /**
     * The wire form of the three settings, stamped onto every command.
     *
     * The two vocabularies differ on purpose: the config (and the Settings page)
     * speak `current` / `avoid` / `yield`, the wire speaks `current-window` /
     * `new-window`. Keeping them apart leaves room for a third window mode later
     * without silently reusing `new` to mean something else.
     *
     * Before the first config snapshot there is nothing to read here, so this falls
     * back to the extension's own defaults — exactly what a command without an
     * envelope already gets on the other side.
     * @returns the `policy` object every extension command carries.
     */
    policyEnvelope() {
        const config = this.current;
        return {
            focus: config?.focusPolicy === 'auto' ? 'auto' : 'avoid',
            tabs: config?.tabWindow === 'new' ? 'new-window' : 'current-window',
            takeover: config?.userTakeover === 'ignore' ? 'ignore' : 'yield',
            // 罐路由同样随每条命令下发：扩展侧 `resolveTab` / `tabs.open` 只读这一份，
            // 不保存副本，所以「切了罐却没生效」不可能悄悄发生。
            jar: this.jar,
            // 高亮框和分组名同理：扩展不持有策略副本，配置改了下一条命令立刻生效。
            highlight: config?.agentHighlight === false ? 'off' : 'on',
            groupTitle: groupTitleOf(config?.tabGroupTitle),
        };
    }
    /**
     * Refuse a command the local policy forbids, before anything is sent or deleted.
     *
     * The gate sits above the link and above the filesystem, not inside either: a
     * refused command must not leave a side effect behind. Reading `current` on every
     * call is what makes a settings edit take effect live.
     * @param command - extension command name, or a `LOCAL_DESTRUCTIVE_COMMANDS` name.
     * @param params - the command's params: action-bearing commands (`hold`) need them so a
     *   read-only action (`status`) is not judged by the command name alone.
     */
    policyGate(command, params) {
        const refusal = policyRefusal(command, {
            readOnly: this.current?.readOnly === true,
            allowScript: this.current?.allowScript !== false,
            // 隔离实例是第三条独立授权（见 Config.allowIncognito）：它不改页面，但它会
            // 在用户屏幕上开一个新窗口，并且能绕开用户的真实登录态。
            allowIncognito: this.current?.allowIncognito === true,
        }, params);
        if (refusal !== undefined)
            throw new BridgeError(command, 'blocked_by_policy', 'not_started', refusal);
    }
    /**
     * Delete generated artifacts using the currently resolved directories;
     * works while the bridge is stopped because it never touches the socket.
     * @returns counts and names of what was removed.
     */
    async cleanup() {
        // cleanup() 不经过 execute()，所以它必须自己站一次闸门：否则只读档下
        // 模型仍能用 browser_cleanup 删掉用户的整个截图目录。
        this.policyGate('cleanup');
        const dir = this.shotsDir;
        if (dir === undefined)
            throw classify('cleanup', new Error('browser-bridge is not configured yet —— 浏览器控制尚未加载配置，无法确定清理目录'));
        try {
            return await cleanupArtifacts({ shotsDir: dir });
        }
        catch (error) {
            // 删除是逐条进行的，中途失败时前面的文件已经没了；不包一层分类，
            // 模型拿到的就是一句没有 code / effectState 的裸 fs 错误。
            throw classify('cleanup', error);
        }
    }
    /** Stop the listener; safe to call repeatedly and during teardown. */
    stop() {
        const previous = this.server;
        this.server = undefined;
        this.serverKey = '';
        return previous?.stop() ?? Promise.resolve();
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Cap one rendered payload and *say* it was cut. The previous fixed slices
 * (200 / 300 / 400 / 600 / 1200 chars) cut JSON mid-token, so the model received
 * malformed JSON with no sign that anything was missing. Click/type/press/scroll
 * results are well under this cap, so they now arrive complete; bigger payloads
 * are cut at a character boundary and marked twice: once for a human reading the
 * card, once as a stable `[renderedTruncated …]` token an agent can parse to
 * decide whether to re-issue a narrower query.
 */
const MAX_RENDERED_CHARS = 4_000;
function clampRendered(text, maxChars = MAX_RENDERED_CHARS) {
    if (text.length <= maxChars)
        return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n… [renderedTruncated omittedChars=${omitted} limitChars=${maxChars}] narrow the query and call again to see the rest`;
}
/** Model-facing budget for one snapshot listing; `limit` narrows the listing. */
const SNAPSHOT_RENDER_MAX_CHARS = 8_000;
/** Model-facing budget for one console/network log listing. */
const LOG_RENDER_MAX_CHARS = 6_000;
/** Collapse one page-supplied field to a single line inside a rendered listing. */
function flattenOneLine(value, maxChars) {
    const flat = value.replace(/\s+/g, ' ').trim();
    return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}
/** `HH:MM:SS` in UTC from an epoch-milliseconds stamp. */
function formatClock(epochMs) {
    return new Date(epochMs).toISOString().slice(11, 19);
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Reduce one captured network row to the fields this tool declares. The buffer
 * also carries request/response header maps and POST bodies; those stay out of
 * the value, because the value never reaches the model and the header dump is
 * what would blow the transcript.
 */
function networkRow(row) {
    const out = {
        method: typeof row.method === 'string' ? row.method : 'GET',
        url: flattenOneLine(typeof row.url === 'string' ? row.url : '', 200),
    };
    if (typeof row.resourceType === 'string')
        out.resourceType = row.resourceType;
    if (typeof row.status === 'number')
        out.status = row.status;
    if (typeof row.statusText === 'string' && row.statusText.length > 0)
        out.statusText = flattenOneLine(row.statusText, 60);
    if (typeof row.mimeType === 'string')
        out.mimeType = row.mimeType;
    if (typeof row.encodedDataLength === 'number')
        out.bytes = row.encodedDataLength;
    // CDP `wallTime` is a Timestamp in seconds, not milliseconds.
    if (typeof row.wallTime === 'number')
        out.time = formatClock(row.wallTime * 1000);
    if (row.finished === true)
        out.finished = true;
    if (row.failed === true)
        out.failed = true;
    if (row.canceled === true)
        out.canceled = true;
    if (typeof row.errorText === 'string' && row.errorText.length > 0)
        out.errorText = flattenOneLine(row.errorText, 120);
    return out;
}
/**
 * Resolve the element target a click/type tool received.
 * @param args - validated tool arguments carrying at most one targeting field.
 * @returns the CSS selector to send on the wire, refs translated to their attribute form.
 */
function targetSelector(args) {
    const hasSelector = typeof args.selector === 'string' && args.selector.length > 0;
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    if (hasSelector === hasRef) {
        throw new Error('provide exactly one of selector or ref (ref comes from browser_snapshot)');
    }
    if (hasRef) {
        const ref = args.ref;
        if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref))
            throw new Error(`invalid ref: ${ref}`);
        return `[data-dsh-ref="${ref}"]`;
    }
    return args.selector;
}
function requireTabId(args, action) {
    if (typeof args.tabId !== 'number')
        throw new Error(`${action} requires tabId`);
    return args.tabId;
}
/**
 * Every tab the caller asked to close. `tabId` and `tabIds` are both accepted
 * (a batch call that repeats one id, or passes both, must not close it twice),
 * and the ids are deduplicated and normalised before they leave the host.
 */
function closeTabIds(args) {
    const asked = [
        ...(Array.isArray(args.tabIds) ? args.tabIds : []),
        ...(typeof args.tabId === 'number' ? [args.tabId] : []),
    ];
    const ids = [...new Set(asked.map(Number).filter(id => Number.isInteger(id) && id > 0))];
    if (ids.length === 0)
        throw new Error('close requires tabId or tabIds');
    return ids;
}
/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller, payload) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const random = Math.random().toString(36).slice(2, 6);
    const file = path.join(dir, `${stamp}-${random}.${payload.format === 'jpeg' ? 'jpg' : 'png'}`);
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        title: payload.tabTitle,
        url: payload.tabUrl,
    };
}
/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
 *  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(controller, payload, requestedPath) {
    const dir = controller.shotsDir;
    if (dir === undefined)
        throw new Error('browser-bridge is not configured yet');
    let file;
    if (requestedPath && path.isAbsolute(requestedPath)) {
        file = requestedPath;
        await mkdir(path.dirname(file), { recursive: true });
    }
    else {
        await mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const random = Math.random().toString(36).slice(2, 6);
        const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`;
        file = path.join(dir, name);
    }
    const buffer = Buffer.from(payload.base64, 'base64');
    await writeFile(file, buffer);
    return {
        file,
        bytes: buffer.length,
        tabId: payload.tabId,
        ...(payload.tabTitle === undefined ? {} : { title: payload.tabTitle }),
        ...(payload.tabUrl === undefined ? {} : { url: payload.tabUrl }),
    };
}
/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx, controller, options) {
    /** 全量定义，**包括还没暴露出去的** —— 懒启动时就是从这里取，描述一个字不改。 */
    const known = new Map();
    /**
     * 懒启动把工具装进**发起装载的那个会话**，所以账也按会话记。
     *
     * 键是宿主的 agent 对象：一个会话一个，且跨轮次稳定（实测同一个对象，`agent.id` 就是
     * 会话 id）。会话结束时宿主会回收它的 scope，WeakMap 跟着放掉，不会攒住死会话。
     */
    const loadedByAgent = new WeakMap();
    /** 拿不到 agent 的调用（复合派发、嵌套子派发）退回全局层，用这张表记账。 */
    const loadedGlobally = new Set();
    /** 我们自己注册出去的 disposer：插件被卸载/重载时要把它们收回来。 */
    const ownedDisposers = new Set();
    // 注册可能挂在别的 context 上（`agent.ctx`），宿主文档的原话是「这样的注册有两个 owner，
    // 要把 disposer 也收进你自己的 effect 里，哪一边拆都得掉」。
    ctx.effect(() => () => {
        for (const dispose of ownedDisposers)
            dispose();
        ownedDisposers.clear();
    });
    /**
     * 会话作用域的 tools 服务。
     *
     * `agent.ctx` 上带着 `dsh.scope` 标签（值就是 agent 自己），服务方法里的 `this.ctx`
     * 因此认得这个 scope —— 注册才会落进那个会话的层，而不是全局那张表。拿不到就返回
     * undefined，调用方退回全局注册。
     */
    const scopedToolsOf = (agent) => {
        if (agent === undefined)
            return undefined;
        try {
            return agent.ctx?.tools ?? undefined;
        }
        catch {
            // ctx 上的属性读取要过注入闸；读不到就当没有会话作用域，走全局。
            return undefined;
        }
    };
    const exposureOf = (exec) => {
        const agent = exec?.agent;
        if (agent === undefined || agent === null || typeof agent !== 'object')
            return { loaded: loadedGlobally };
        const existing = loadedByAgent.get(agent);
        if (existing !== undefined)
            return { agent, loaded: existing };
        const fresh = new Set();
        loadedByAgent.set(agent, fresh);
        return { agent, loaded: fresh };
    };
    /**
     * 真的交给宿主注册。
     *
     * 幂等：同一个落点重复装载只是返回 false，不会注册第二遍。
     * 抛出（重名、被闸门拒）不吞：调用方要如实把错误报回模型。
     */
    const expose = (name, exposure) => {
        if (exposure.loaded.has(name))
            return false;
        const definition = known.get(name);
        if (definition === undefined)
            return false;
        const target = scopedToolsOf(exposure.agent) ?? ctx.tools;
        const dispose = target.register(definition);
        if (typeof dispose === 'function')
            ownedDisposers.add(dispose);
        exposure.loaded.add(name);
        return true;
    };
    /** 从**全局视角**看这个工具在不在：`undefined` = 读不出来（服务拒绝），不是「不在」。 */
    const inGlobalView = (name) => {
        try {
            return ctx.tools.get(name) !== undefined;
        }
        catch {
            return undefined;
        }
    };
    /**
     * 落点的如实读回，不拿我们的意图当事实：真正的会话层注册从全局视角是查不到的，
     * 查得到就说明它进了全局那张表（没有会话作用域时的退化路径）。
     */
    const scopeOfExposure = (exposure) => {
        const sample = [...exposure.loaded][0];
        if (sample === undefined)
            return exposure.agent === undefined ? 'global' : 'session';
        const seen = inGlobalView(sample);
        if (seen === undefined)
            return 'unknown';
        return seen ? 'global' : 'session';
    };
    /**
     * 登记一个工具的定义。全开：当场暴露；懒启动：只记账，等 `browser_tools` 来取。
     * 两种模式下存的都是同一份完整定义 —— 这里没有「桩描述」这种东西。
     */
    const mount = (definition) => {
        known.set(definition.name, definition);
        if (!options.lazyTools)
            expose(definition.name, { loaded: loadedGlobally });
    };
    // 提示词里那两句默认目标与让出，是「模型自己就能做对」的关键：工具结果里当然也写着
    // （`agentTargetTabId` / `focus` / `yielded`），但模型读提示词的成本远低于读 payload。
    const promptText = 'The browser_* tools drive the user\'s real, logged-in browser through the DSH '
        + 'Browser extension. '
        + 'Which tab a command lands on: an explicit tabId always wins; otherwise the tab the agent '
        + 'claimed (browser_tabs open/group/activate) — once you have a tab of your own, commands keep '
        + 'landing there instead of following the user\'s gaze. A session that never claimed a tab follows '
        + 'the tab the user is looking at. browser_tabs list marks owned/yielded per tab and reports '
        + 'agentTargetTabId. '
        + 'A tab you opened or grouped is collected into one titled Chrome tab group and gets a blue '
        + 'gradient frame while it is your target — that frame is how the user sees which page you are '
        + 'touching; it intercepts nothing. The group name comes from the tabGroupTitle setting unless '
        + 'you pass groupTitle on that call (empty string = no group). '
        + 'Close only closes tabs you opened; pass force:true only when the user explicitly asked you to '
        + 'close one of theirs (it is irreversible for them). '
        + 'When the user actually clicks or types in the tab you are driving (merely switching to it, '
        + 'watching, or scrolling does not count), page-mutating commands there fail with code '
        + 'yielded_to_user and nothing is sent: do not retry and do not work around it — open a tab of '
        + 'your own (browser_tabs open) or wait until they move to another tab, which clears it. '
        + 'When you must not touch the user\'s real signed-in session (logging in on their behalf, '
        + 'rehearsing a flow, clicking things that may be destructive), use browser_profile: '
        + 'action=launch opens an isolated incognito jar and every later command lands there, '
        + 'action=close shuts it down and returns to the normal jar. '
        + 'Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, '
        + 'and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. '
        + 'browser_read extracts page text in a window (offset/limit) and reports how much text is '
        + 'left, browser_screenshot saves a PNG/JPEG and returns its file '
        + 'path (view it with an image tool). Calls fail with actionable copy while the bridge is '
        + 'disabled or no browser is connected. When a result is cut to bound token cost it is '
        + 'marked "[renderedTruncated omittedChars=N limitChars=L]" — re-issue a narrower query '
        + '(smaller limit, a pattern filter, or browser_read\'s offset) instead of assuming the '
        + 'page is shorter than it is.';
    ctx.systemPrompt.section({
        name: 'tool:browser',
        order: 112,
        text: promptText,
    });
    mount(defineTool({
        name: 'browser_navigate',
        description: 'Navigate a browser tab to a URL and wait for the page load to settle.',
        parameters: {
            url: { type: 'string', required: true, description: 'Absolute URL to open in the tab.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    url: { type: 'string' },
                    title: { type: 'string' },
                    pendingUrl: { type: 'string' },
                    loadPending: { type: 'boolean' },
                    siteUnreachable: { type: 'boolean' },
                },
            },
            render: (_args, value) => {
                const label = [value.title, value.url].filter(part => typeof part === 'string' && part.length > 0).join(' — ');
                const shows = label.length > 0 ? label : '(untitled)';
                // Nothing was navigated to: say that instead of "now shows <the URL you asked for>".
                if (value.siteUnreachable === true) {
                    return [{ type: 'text', text: `Tab ${value.tabId} could not load ${String(value.url ?? '')} — the browser landed on its own error page (DNS failure or no connection), so browser_read/browser_snapshot return that error page, not the site.` }];
                }
                // The wait budget ran out before the new document settled: the tab may still
                // be showing the previous page, so do not call it loaded.
                if (value.loadPending === true) {
                    const to = typeof value.pendingUrl === 'string' && value.pendingUrl.length > 0 ? value.pendingUrl : 'the requested URL';
                    return [{ type: 'text', text: `Tab ${value.tabId} is still loading ${to} — the load had not settled when the wait budget ran out, so the tab may still be showing ${shows}. Re-check with browser_read before acting on it (or raise timeoutMs).` }];
                }
                if (typeof value.pendingUrl === 'string' && value.pendingUrl.length > 0) {
                    return [{ type: 'text', text: `Tab ${value.tabId} shows ${shows} and is navigating to ${value.pendingUrl}` }];
                }
                return [{ type: 'text', text: `Tab ${value.tabId} now shows ${shows}` }];
            },
        },
        isConcurrencySafe: () => false,
        presentCall: args => ({ card: 'generic', title: `Open ${args.url}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { url: args.url };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            const raw = await controller.execute('nav', params, exec.signal);
            // The declared schema is closed, so the fields describing a navigation that did
            // not arrive have to be carried over on purpose. The old shape check
            // (`siteUnreachable === true`) also missed the object the extension really
            // sends, so an unreachable target came back as a plain success.
            const out = { tabId: raw.tabId };
            if (typeof raw.url === 'string')
                out.url = raw.url;
            if (typeof raw.title === 'string')
                out.title = raw.title;
            if (typeof raw.pendingUrl === 'string')
                out.pendingUrl = raw.pendingUrl;
            if (raw.loadPending === true)
                out.loadPending = true;
            const unreachable = raw.siteUnreachable === true
                || (typeof raw.siteUnreachable === 'object' && raw.siteUnreachable !== null);
            if (unreachable)
                out.siteUnreachable = true;
            return out;
        },
    }));
    mount(defineTool({
        name: 'browser_read',
        description: 'Read the current page: title, URL and the page text itself (or full HTML) in a window you control with offset/limit. The returned text is what you see — no separate fetch step is needed.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            mode: { type: 'string', description: '"text" (default) for visible text, "html" for the whole document.' },
            offset: { type: 'number', description: `Character index the window starts at; default 0. Use the "call again with offset=" value the previous result reported.` },
            limit: { type: 'number', description: `Characters to return; default and cap ${READ_WINDOW_MAX_CHARS}.` },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    mode: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    content: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    offset: { type: 'number', required: true },
                    totalChars: { type: 'number', required: true },
                },
            },
            render: (_args, value) => {
                const end = value.offset + value.content.length;
                const head = `${value.title} (${value.url}) — ${value.mode} chars ${value.offset}-${end} of ${value.totalChars}`
                    + (value.truncated ? `; call again with offset=${end} to continue` : '');
                return [{ type: 'text', text: `${head}\n\n${value.content}` }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser page', kind: 'other' }),
        async execute(args, exec) {
            const mode = args.mode === 'html' ? 'html' : 'text';
            const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
            const limit = Math.min(READ_WINDOW_MAX_CHARS, Math.max(1, Math.floor(Number(args.limit ?? READ_WINDOW_MAX_CHARS)) || READ_WINDOW_MAX_CHARS));
            const raw = await controller.execute('content', args.tabId === undefined ? { mode } : { mode, tabId: args.tabId }, exec.signal);
            const full = raw.content ?? '';
            const content = full.slice(offset, offset + limit);
            return {
                tabId: raw.tabId,
                mode,
                title: raw.title ?? '',
                url: raw.url ?? '',
                content,
                truncated: offset + content.length < full.length,
                offset,
                totalChars: full.length,
            };
        },
    }));
    mount(defineTool({
        name: 'browser_snapshot',
        description: 'Inventory the page\'s interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards. mode:"ax" numbers them by Chrome\'s accessibility tree (role + accessible name), which survives a DOM redesign; the default mode matches CSS selectors.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            limit: { type: 'number', description: 'Max elements returned; defaults to 120, capped at 200.' },
            mode: { type: 'string', description: '"ax" for the accessibility tree, "dom" (default) for the selector list. "ax" falls back to "dom" with axFallback set if the page gives no a11y tree.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    title: { type: 'string', required: true },
                    url: { type: 'string', required: true },
                    mode: { type: 'string' },
                    axFallback: { type: 'string' },
                    items: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                ref: { type: 'string', required: true },
                                tag: { type: 'string', required: true },
                                role: { type: 'string' },
                                name: { type: 'string' },
                                href: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const head = `${value.items.length} interactive elements on ${value.title}`
                    + ` (mode ${value.mode ?? 'dom'}); click or fill them by ref:`
                    + (value.axFallback === undefined ? '' : `\n(mode ax fell back to dom: ${value.axFallback})`);
                const lines = value.items.map(item => {
                    const name = item.name === undefined ? '' : ` "${flattenOneLine(item.name, 80)}"`;
                    const href = item.href === undefined ? '' : ` -> ${flattenOneLine(item.href, 100)}`;
                    return `[${item.ref}] ${item.role ?? item.tag}${name}${href}`;
                });
                return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), SNAPSHOT_RENDER_MAX_CHARS) }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Snapshot browser page', kind: 'other' }),
        async execute(args, exec) {
            const limit = Math.min(200, Math.max(1, args.limit ?? 120));
            const params = { limit };
            if (typeof args.tabId === 'number')
                params.tabId = args.tabId;
            if (typeof args.mode === 'string')
                params.mode = args.mode;
            const raw = await controller.execute('snapshot', params, exec.signal);
            // 版本错位必须说出来：v1.0.10 及更早的扩展没有 AX 快照（1.0.11 才加的），
            // 它会照单收下 mode:"ax" 然后回一份 DOM 结果，既不带 mode 也不带 axFallback
            // （本机实测：扩展 1.0.10，两次请求的响应完全一样）。那时模型只看到「(mode dom)」，
            // 读不出「我要的 ax 被旧扩展静默降级了」，会把标签名当成可访问名。
            // 按「请求的模式 vs 回报的模式」比对，不一致就自己写 axFallback——扩展不用改，老扩展立刻受益。
            const requestedAx = args.mode === 'ax';
            const gotAx = raw.mode === 'ax' || raw.ax !== undefined;
            const axFallback = typeof raw.axFallback === 'string' && raw.axFallback.length > 0
                ? raw.axFallback
                : (requestedAx && !gotAx
                    ? 'this extension ignored mode:"ax" and returned CSS-DOM matches (AX mode needs DSH Browser extension v1.0.11 or newer) — the names below are tag names, not accessible names'
                    : undefined);
            return {
                tabId: raw.tabId,
                title: raw.title ?? '',
                url: raw.url ?? '',
                ...(raw.mode === undefined ? {} : { mode: raw.mode }),
                ...(axFallback === undefined ? {} : { axFallback }),
                items: (raw.items ?? []).map(item => ({
                    ref: item.ref,
                    tag: item.tag,
                    ...(item.role === undefined ? {} : { role: item.role }),
                    ...(item.name === undefined ? {} : { name: item.name }),
                    ...(item.href === undefined ? {} : { href: item.href }),
                })),
            };
        },
    }));
    mount(defineTool({
        name: 'browser_click',
        description: 'Click a page element with real mouse events; target it by snapshot ref or CSS selector.',
        parameters: {
            ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. "e3"); wins over selector.' },
            selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            doubleClick: { type: 'boolean', description: 'Send a double click instead.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Click ${args.ref ?? args.selector ?? ''}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: targetSelector(args) };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.doubleClick !== undefined)
                params.doubleClick = args.doubleClick;
            return await controller.execute('click', params, exec.signal);
        },
    }));
    mount(defineTool({
        name: 'browser_type',
        description: 'Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards.',
        parameters: {
            value: { type: 'string', required: true, description: 'Text to put into the element.' },
            ref: { type: 'string', description: 'Element ref from browser_snapshot; wins over selector.' },
            selector: { type: 'string', description: 'CSS selector; ignored when ref is given.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            submit: { type: 'boolean', description: 'Press Enter after filling.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Type into ${args.ref ?? args.selector ?? 'element'}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: targetSelector(args), value: args.value };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            const filled = await controller.execute('input', params, exec.signal);
            if (args.submit === true) {
                await controller.execute('press', args.tabId === undefined ? { key: 'Enter' } : { key: 'Enter', tabId: args.tabId }, exec.signal);
            }
            return filled;
        },
    }));
    mount(defineTool({
        name: 'browser_press',
        description: 'Send a real keyboard event to the page: a named key (Enter, Tab, Escape, ArrowDown…), a single character, or a combination such as "Ctrl+A" / "Shift+ArrowRight".',
        parameters: {
            key: { type: 'string', required: true, description: 'Named key, a single character, or "Modifier+Key" (alt, ctrl/control, meta/command, shift). Unknown names now fail loudly instead of doing nothing.' },
            modifiers: { type: 'array', items: { type: 'string' }, description: 'Alternative to the "Ctrl+A" spelling: ["ctrl", "shift"]. Shift alone still lets the character be typed; ctrl/meta suppress insertion.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Press ${args.key}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { key: args.key };
            if (Array.isArray(args.modifiers))
                params.modifiers = args.modifiers;
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('press', params, exec.signal);
        },
    }));
    mount(defineTool({
        name: 'browser_scroll',
        description: 'Scroll the page viewport by a delta and report the resulting position.',
        parameters: {
            x: { type: 'number', description: 'Horizontal delta in pixels; defaults to 0.' },
            y: { type: 'number', description: 'Vertical delta in pixels; positive scrolls down.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: () => ({ card: 'generic', title: 'Scroll browser page', kind: 'other' }),
        async execute(args, exec) {
            const params = { x: args.x ?? 0, y: args.y ?? 0 };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('scroll', params, exec.signal);
        },
    }));
    /** Page-side ceiling of `cmdWait`; the bridge budget adds slack on top. */
    const WAIT_MAX_MS = 120_000;
    mount(defineTool({
        name: 'browser_wait',
        description: 'Block until a selector appears, some text shows up in the body, or a page-side predicate turns true. Use it after navigation for SPA routes and lazy-rendered content, which browser_navigate does not wait for.',
        parameters: {
            selector: { type: 'string', description: 'CSS selector that must exist in the document.' },
            text: { type: 'string', description: 'Literal substring that must appear in document.body.innerText.' },
            fn: { type: 'string', description: 'JS predicate evaluated in the page: an expression ("window.x === 3") or a function body ("() => !!document.querySelector(\'.row\')").' },
            timeoutMs: { type: 'number', description: `Give up after this many milliseconds; defaults to 15000, capped at ${WAIT_MAX_MS}.` },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Wait for ${args.selector ?? args.text ?? 'page condition'}`, kind: 'other' }),
        async execute(args, exec) {
            const given = ['selector', 'text', 'fn'].filter(k => args[k] !== undefined && String(args[k]).length > 0);
            if (given.length === 0)
                throw new Error('browser_wait needs exactly one of selector, text, fn — otherwise there is nothing to wait for');
            if (given.length > 1)
                throw new Error(`browser_wait takes one condition, got ${given.join(' + ')} — pick the one you actually mean`);
            const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(100, Number(args.timeoutMs ?? 15_000)));
            const params = { [given[0]]: args[given[0]], timeoutMs };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            // Slack so the page-side timeout always reports before the bridge gives up.
            return await controller.execute('wait', params, exec.signal, timeoutMs + 10_000);
        },
    }));
    mount(defineTool({
        name: 'browser_find',
        description: 'Describe the elements matching a CSS selector — count, tag, id, class, text, href and viewport rect. Read-only; use it to decide what to click and to verify the page state.',
        parameters: {
            selector: { type: 'string', required: true, description: 'CSS selector to query.' },
            limit: { type: 'number', description: 'Maximum items to describe; defaults to 10, capped at 50 (count is always the full total).' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Find ${args.selector}`, kind: 'other' }),
        async execute(args, exec) {
            const params = { selector: args.selector };
            if (args.limit !== undefined)
                params.limit = args.limit;
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('find', params, exec.signal);
        },
    }));
    mount(defineTool({
        name: 'browser_hold',
        description: 'Put a cancellable take-over overlay on a tab so the user can see that you are working on this page and cannot mis-click. The card title is fixed by the extension; your `note` is the body text only (≤400 chars, newlines flattened). The user double-clicks the page (or presses Escape twice, or holds Escape) to close it — you can keep working. Pressing the card\'s abort button blocks your click/input/press/nav on that tab until you call action="off" (which counts as confirming you continue). This is a soft layer, not a security boundary: the popup lock is the thing that actually freezes the browser. Returns `covered:false` with a `reason` when the page cannot be covered (browser pages, error pages, CSP-strict frames, PDF viewer, an open native dialog).',
        parameters: {
            action: { type: 'string', enum: ['on', 'off', 'status'], required: true, description: '"on" shows the overlay, "off" removes it (and clears the abort state), "status" reports what is actually on the page.' },
            note: { type: 'string', description: 'on: body text — say what you are doing (e.g. "正在把「局域网」档改成放行"). The title cannot be set.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Overlay ${args.action}`, kind: 'other' }),
        async execute(args, exec) {
            const action = String(args.action);
            if (!['on', 'off', 'status'].includes(action))
                throw new Error('browser_hold action must be on, off or status');
            const params = { action };
            if (args.action === 'on' && args.note !== undefined)
                params.note = args.note;
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('hold', params, exec.signal);
        },
    }));
    mount(defineTool({
        name: 'browser_dialog',
        description: 'Read or change how native alert/confirm/prompt dialogs are answered (accept, dismiss, or manual), and get the recent dialog log so you can prove one appeared.',
        parameters: {
            policy: { type: 'string', enum: ['accept', 'dismiss', 'manual'], description: 'Set this policy; omit to only read the current one.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: args.policy ? `Dialog policy → ${args.policy}` : 'Read dialog policy', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            // 线协议用 `dialogPolicy`，不用 `policy`：`execute()` 会给每条命令盖顶层
            // `policy` 信封（对象），同名键会被 `{ ...params, policy: envelope }` 覆盖。
            // 第一版正好把字符串放在 `policy` 里，扩展于是永远读到 `[object Object]`
            // 并抛错——连"不带参只读"也崩，因为信封总是盖。对外的工具参数名不变。
            if (args.policy !== undefined)
                params.dialogPolicy = args.policy;
            return await controller.execute('dialog', params, exec.signal);
        },
    }));
    mount(defineTool({
        name: 'browser_info',
        description: 'Report which browser and which extension build is actually attached. Run it first when behaviour looks wrong — a stale extension or the wrong browser profile explains most of it.',
        parameters: {},
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: () => ({ card: 'generic', title: 'Browser identity', kind: 'other' }),
        async execute(_args, exec) {
            return await controller.execute('browser.info', {}, exec.signal);
        },
    }));
    mount(defineTool({
        name: 'browser_tabs',
        description: 'List tabs, or open/close/activate/group/ungroup. `list` reports `owned` (this agent opened the tab, or it sits in the agent tab group) and `yielded` (the user actually clicked or typed in that page, so page-mutating commands there are refused) per tab, plus `incognito` on every row and `isolatedWindowId` at the top level so you can tell which rows live in the isolated jar. `close` takes one tab (`tabId`) or several (`tabIds`) and only closes tabs the agent owns: ids the user opened come back under `refused` and stay open unless you pass `force: true` — a closed user tab cannot be restored, so ask first. The result accounts for every id (closed / alreadyGone / refused / failed), so a retry is safe.',
        parameters: {
            action: { type: 'string', required: true, description: 'One of: list, open, close, activate, group, ungroup.' },
            url: { type: 'string', description: 'URL for the open action.' },
            tabId: { type: 'number', description: 'Target tab for close/activate/group.' },
            tabIds: { type: 'array', items: { type: 'number' }, description: 'For close: every tab to close in one call. The result reports each id (closed / alreadyGone / refused / failed) instead of stopping at the first failure.' },
            active: { type: 'boolean', description: 'Whether a newly opened tab becomes active; defaults to true.' },
            group: { type: 'boolean', description: 'For open: put the new tab in the agent tab group (see groupTitle). Defaults to true; pass false to keep it loose.' },
            groupTitle: { type: 'string', description: 'For open/group: name of the Chrome tab group this tab joins. Omit to use the tabGroupTitle setting (`DSH` by default); pass an empty string to skip grouping for this call. The extension identifies its own groups by group id, not by this name: your tabs are collected into a group you own, and a group the user created under the same name is never merged into or treated as yours.' },
            windowId: { type: 'number', description: 'For ungroup: only dissolve that window\'s agent group; omit to clear every window.' },
            force: { type: 'boolean', description: 'For close: also close tabs the agent did not open (the user\'s own). Only after the user agreed — closing cannot be undone; without it those ids are reported under `refused` and left open.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        presentCall: args => ({ card: 'generic', title: `Browser tabs: ${args.action}`, kind: 'other' }),
        async execute(args, exec) {
            switch (args.action) {
                case 'list':
                    return await controller.execute('tabs.list', {}, exec.signal);
                case 'open': {
                    if (typeof args.url !== 'string' || args.url.length === 0)
                        throw new Error('open requires url');
                    const params = { url: args.url };
                    if (args.active !== undefined)
                        params.active = args.active;
                    if (args.group !== undefined)
                        params.group = args.group;
                    if (typeof args.groupTitle === 'string')
                        params.groupTitle = args.groupTitle;
                    return await controller.execute('tabs.open', params, exec.signal);
                }
                case 'close': {
                    const ids = closeTabIds(args);
                    // force 只对关闭有意义，而且只有显式 true 才发：扩展按 `=== true` 判定，
                    // 多写一个 false 只会让线上多一个没人读的字段。
                    const force = args.force === true ? { force: true } : {};
                    // One id keeps the single-tab command; several go out as ONE command
                    // (`tabs.closeMany`) instead of N round-trips that can die in between.
                    return ids.length === 1
                        ? await controller.execute('tabs.close', { tabId: ids[0], ...force }, exec.signal)
                        : await controller.execute('tabs.closeMany', { tabIds: ids, ...force }, exec.signal);
                }
                case 'activate':
                    return await controller.execute('tabs.activate', { tabId: requireTabId(args, 'activate') }, exec.signal);
                case 'group': {
                    const params = { tabId: requireTabId(args, 'group') };
                    if (typeof args.groupTitle === 'string')
                        params.groupTitle = args.groupTitle;
                    return await controller.execute('tabs.group', params, exec.signal);
                }
                case 'ungroup': {
                    const params = {};
                    if (typeof args.windowId === 'number')
                        params.windowId = args.windowId;
                    return await controller.execute('tabs.ungroup', params, exec.signal);
                }
                default:
                    throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate|group|ungroup)`);
            }
        },
    }));
    // 隔离实例（无痕罐）。名字与参数是对外契约：`verify_profile_tool.mjs` 逐条钉着
    // action→命令的映射，`verify_policy.mjs` 钉着闸门必须在命令发出去之前。
    mount(defineTool({
        name: 'browser_profile',
        description: 'Inspect or switch which browser profile the commands drive. The isolated instance is an incognito window: its own cookie jar, wiped when it closes, so you can log in or rehearse a flow there instead of touching the user\'s real signed-in session. `status` (read-only) reports your current jar, whether the browser allows incognito at all, and the window/tab counts of both jars; `launch` opens (or reuses) the isolated window and routes every later command into it; `use` only points later commands at a jar; `close` shuts the isolated window and returns to the normal jar. Off by default: it needs allowIncognito in the plugin settings AND "Allow in incognito/InPrivate" on the extension page, so a refusal means a human must open one of those two — tell the user which one instead of retrying.',
        parameters: {
            action: { type: 'string', enum: ['status', 'launch', 'use', 'close'], required: true, description: '"status" reports both jars (read-only), "launch" opens the isolated incognito window, "use" only switches which jar later commands land in, "close" shuts the isolated window down.' },
            jar: { type: 'string', enum: ['normal', 'incognito'], description: 'For use: which jar later commands (and browser_tabs open) land in. "incognito" needs allowIncognito; "normal" is always allowed.' },
            url: { type: 'string', description: 'For launch: URL the isolated window opens first.' },
        },
        output: {
            schema: { type: 'object', additionalProperties: true },
            render: (_args, value) => [{ type: 'text', text: clampRendered(JSON.stringify(value)) }],
        },
        isConcurrencySafe: () => false,
        presentCall: args => ({ card: 'generic', title: `Browser profile: ${args.action}`, kind: 'other' }),
        async execute(args, exec) {
            const action = String(args.action);
            if (action === 'status') {
                const result = await controller.execute('profile.status', {}, exec.signal);
                // 罐指针是插件侧状态，扩展不知道（它只读每条命令里的 policy.jar）。
                return { jar: controller.currentJar, ...result };
            }
            if (action === 'launch') {
                const params = {};
                if (typeof args.url === 'string' && args.url.length > 0)
                    params.url = args.url;
                const result = await controller.execute('profile.launch', params, exec.signal);
                // execute() 里已经过了一次闸门；这里仍走 switchJar，是为了让「进无痕罐」
                // 只有一条代码路径——use 也必须走它，否则那条路会绕开闸门。
                controller.switchJar('incognito');
                return { jar: 'incognito', ...result };
            }
            if (action === 'use') {
                if (args.jar !== 'normal' && args.jar !== 'incognito') {
                    throw new Error(`browser_profile use needs jar: normal | incognito (got ${args.jar === undefined ? 'nothing' : JSON.stringify(args.jar)})`);
                }
                // 这条命令**不经过** execute()：它只改插件里的罐指针，零往返。但切进无痕罐
                // 必须过与 profile.launch 同一道闸门——切过去之后下一条 tabs.open 会带着
                // policy.jar='incognito' 发出去，扩展侧 ensureIsolatedWindow 就会真的把无痕
                // 窗口建出来，那时闸门根本没经过。退出无痕罐永远是安全方向，不拦。
                controller.switchJar(args.jar);
                const switched = { jar: args.jar, note: '后续命令与 tabs.open 都落在这个罐里' };
                return switched;
            }
            if (action === 'close') {
                const result = await controller.execute('profile.close', {}, exec.signal);
                controller.switchJar('normal');
                return { jar: 'normal', ...result };
            }
            throw new Error(`unknown profile action: ${action} (use status|launch|use|close)`);
        },
    }));
    mount(defineTool({
        name: 'browser_evaluate',
        description: 'Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.',
        parameters: {
            expression: { type: 'string', required: true, description: 'JavaScript expression or statement sequence; awaited like a promise body.' },
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            timeoutMs: { type: 'number', description: 'Deadline in ms for the awaited expression (clamped to 100–120000). Omit for no extra limit — a hung await then rides the bridge default instead. A timed-out expression fails with code eval_timeout.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    json: { type: 'string', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: clampRendered(value.json) }],
        },
        presentCall: () => ({ card: 'generic', title: 'Evaluate in page', kind: 'other' }),
        async execute(args, exec) {
            const params = { expression: args.expression };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            // 扩展侧只认"传没传"（没传 = 不限时，见 evalBudgetOf）；这里不做 `|| 0`
            // 之类的转换，否则 NaN 会在下游被夹成 100ms，await 一句就超时。
            // 夹子与扩展同一区间；给了预算就把桥的 60s 天花板抬到预算 + 10s，否则
            // 预算比 60s 大时会被桥先杀掉，报的还是另一套文案。
            const budget = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
                ? Math.min(120_000, Math.max(100, args.timeoutMs))
                : undefined;
            if (budget !== undefined)
                params.timeoutMs = budget;
            const raw = await controller.execute('eval', params, exec.signal, budget === undefined ? undefined : budget + 10_000);
            let json;
            try {
                json = JSON.stringify(raw.value) ?? String(raw.value);
            }
            catch {
                json = String(raw.value);
            }
            return { tabId: raw.tabId, json };
        },
    }));
    mount(defineTool({
        name: 'browser_screenshot',
        description: 'Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path. Fails fast with the reason when the tab\'s window is minimized: Chromium renders no frames there, so the CDP capture would never return (restore the window, or capture a tab in a visible window).',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            fullPage: { type: 'boolean', description: 'Capture beyond the viewport.' },
            format: { type: 'string', description: '"png" (default) or "jpeg".' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    file: { type: 'string', required: true },
                    bytes: { type: 'number', required: true },
                    tabId: { type: 'number', required: true },
                    title: { type: 'string' },
                    url: { type: 'string' },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Saved ${value.file} (${value.bytes} bytes)` }],
        },
        presentCall: () => ({ card: 'generic', title: 'Browser screenshot', kind: 'other' }),
        async execute(args, exec) {
            const format = args.format === 'jpeg' ? 'jpeg' : 'png';
            const params = { format };
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.fullPage !== undefined)
                params.fullPage = args.fullPage;
            const payload = await controller.execute('screenshot', params, exec.signal);
            return saveScreenshot(controller, payload);
        },
    }));
    mount(defineTool({
        name: 'browser_cleanup',
        description: 'Delete generated screenshots and agent scratch files (__-prefixed temp scripts/artifacts) from their top-level directories.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    shotsRemoved: { type: 'number', required: true },
                    scratchRemoved: { type: 'array', required: true, items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `Cleaned ${value.shotsRemoved} screenshot(s) and ${value.scratchRemoved.length} scratch file(s)`,
                }],
        },
        presentCall: () => ({ card: 'generic', title: 'Clean up browser artifacts', kind: 'other' }),
        async execute() {
            const result = await controller.cleanup();
            return { shotsRemoved: result.shotsRemoved, scratchRemoved: Array.from(result.scratchRemoved) };
        },
    }));
    // v1.0.7: console + network capture, PDF export, device emulation.
    mount(defineTool({
        name: 'browser_console_log',
        description: 'Read the captured `console.log/info/warn/error` entries for a tab, with the entry text itself. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for "what did the page log after I clicked submit".',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            levels: { type: 'array', items: { type: 'string' }, description: 'Filter to one or more of: log, info, warn, error, debug.' },
            pattern: { type: 'string', description: 'Regex (case-insensitive) matched against the formatted text.' },
            limit: { type: 'number', description: 'Maximum entries to return; default 100, capped at 500.' },
            clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    count: { type: 'number', required: true },
                    total: { type: 'number', required: true },
                    entries: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                level: { type: 'string', required: true },
                                text: { type: 'string', required: true },
                                time: { type: 'string' },
                                location: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const head = `Tab ${value.tabId}: ${value.count} of ${value.total} console entries`
                    + ` (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit to see more` : ''}:`;
                const lines = value.entries.map((entry, index) => `${index + 1}. [${entry.time ?? '?'}] ${entry.level}${entry.location === undefined ? '' : ` @${entry.location}`} — ${entry.text}`);
                return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), LOG_RENDER_MAX_CHARS) }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser console', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (Array.isArray(args.levels))
                params.levels = args.levels;
            if (typeof args.pattern === 'string')
                params.pattern = args.pattern;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            const raw = await controller.execute('console.log', params, exec.signal);
            return {
                tabId: raw.tabId,
                count: raw.count,
                total: raw.total,
                entries: (raw.entries ?? []).map(entry => ({
                    level: entry.level ?? 'log',
                    text: flattenOneLine(entry.text ?? '', 400),
                    ...(entry.t === undefined ? {} : { time: formatClock(entry.t) }),
                    ...(entry.location === undefined ? {} : { location: entry.location }),
                })),
            };
        },
    }));
    mount(defineTool({
        name: 'browser_network_log',
        description: 'Read captured HTTP request/response pairs for a tab. `includeStatic:true` adds images / fonts / stylesheets / scripts (filtered by default — they dominate the buffer). `methodPattern` / `urlPattern` / `status` filter server-side results; `clear:true` empties the buffer.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            includeStatic: { type: 'boolean', description: 'Include images / fonts / stylesheets / scripts. Default false.' },
            methodPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the HTTP method.' },
            urlPattern: { type: 'string', description: 'Regex (case-insensitive) matched against the URL.' },
            status: { type: 'string', description: 'One of: 2xx, 3xx, 4xx, 5xx, failed, pending.' },
            limit: { type: 'number', description: 'Maximum entries to return; default 200, capped at 1000.' },
            clear: { type: 'boolean', description: 'Empty the buffer after reading.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    count: { type: 'number', required: true },
                    total: { type: 'number', required: true },
                    requests: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                method: { type: 'string', required: true },
                                url: { type: 'string', required: true },
                                resourceType: { type: 'string' },
                                status: { type: 'number' },
                                statusText: { type: 'string' },
                                mimeType: { type: 'string' },
                                bytes: { type: 'number' },
                                time: { type: 'string' },
                                finished: { type: 'boolean' },
                                failed: { type: 'boolean' },
                                canceled: { type: 'boolean' },
                                errorText: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const head = `Tab ${value.tabId}: ${value.count} of ${value.total} network requests`
                    + ` (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit or filter by urlPattern/status` : ''}:`;
                const lines = value.requests.map((row, index) => {
                    const outcome = row.failed === true
                        ? `FAILED ${row.errorText ?? ''}`.trim()
                        : row.status === undefined ? 'PENDING' : `${row.status} ${row.statusText ?? ''}`.trim();
                    const size = row.bytes === undefined ? '' : ` ${formatBytes(row.bytes)}`;
                    const type = row.resourceType === undefined ? '' : ` ${row.resourceType}`;
                    return `${index + 1}. [${row.time ?? '?'}] ${row.method} ${outcome}${type}${size} ${row.url}`;
                });
                return [{ type: 'text', text: clampRendered([head, ...lines].join('\n'), LOG_RENDER_MAX_CHARS) }];
            },
        },
        presentCall: () => ({ card: 'generic', title: 'Read browser network log', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.includeStatic === true)
                params.includeStatic = true;
            if (typeof args.methodPattern === 'string')
                params.methodPattern = args.methodPattern;
            if (typeof args.urlPattern === 'string')
                params.urlPattern = args.urlPattern;
            if (typeof args.status === 'string')
                params.status = args.status;
            if (typeof args.limit === 'number')
                params.limit = args.limit;
            if (args.clear === true)
                params.clear = true;
            const raw = await controller.execute('network.log', params, exec.signal);
            return {
                tabId: raw.tabId,
                count: raw.count,
                total: raw.total,
                requests: (raw.requests ?? []).map(row => networkRow(row)),
            };
        },
    }));
    mount(defineTool({
        name: 'browser_network_clear',
        description: 'Empty the per-tab network capture buffer without returning the rows.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    cleared: { type: 'boolean', required: true },
                },
            },
            render: (_args, value) => [{ type: 'text', text: `Tab ${value.tabId}: network log cleared` }],
        },
        presentCall: () => ({ card: 'generic', title: 'Clear browser network log', kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            return await controller.execute('network.clear', params, exec.signal);
        },
    }));
    mount(defineTool({
        name: 'browser_pdf',
        description: 'Export the current page to a PDF. `path` may be absolute (saved there) or omitted (saved under the configured shotsDir). Returns the absolute path + size; the PDF preserves text (selectable, searchable) and print-media CSS. Like screenshots it fails fast when the tab\'s window is minimized (no frames → the CDP print would never return).',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            path: { type: 'string', description: 'Absolute path. Omit to save under the configured shotsDir with a timestamped name.' },
            landscape: { type: 'boolean', description: 'Use landscape orientation.' },
            printBackground: { type: 'boolean', description: 'Render CSS backgrounds. Default true.' },
            paperWidth: { type: 'number', description: 'Paper width in inches.' },
            paperHeight: { type: 'number', description: 'Paper height in inches.' },
            scale: { type: 'number', description: 'Page scale (0.1–2.0).' },
            pageRanges: { type: 'string', description: 'Sub-range, e.g. "1-3" or "1,4-6".' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    file: { type: 'string', required: true },
                    bytes: { type: 'number', required: true },
                    tabId: { type: 'number', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: `PDF written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`,
                }],
        },
        presentCall: args => ({ card: 'generic', title: `Save PDF${args.path ? ' → ' + args.path : ''}`, kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (args.landscape === true)
                params.landscape = true;
            if (args.printBackground === false)
                params.printBackground = false;
            if (typeof args.paperWidth === 'number')
                params.paperWidth = args.paperWidth;
            if (typeof args.paperHeight === 'number')
                params.paperHeight = args.paperHeight;
            if (typeof args.scale === 'number')
                params.scale = args.scale;
            if (typeof args.pageRanges === 'string')
                params.pageRanges = args.pageRanges;
            const payload = await controller.execute('pdf', params, exec.signal);
            return await savePdf(controller, payload, typeof args.path === 'string' ? args.path : undefined);
        },
    }));
    mount(defineTool({
        name: 'browser_emulate',
        description: 'Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing. `device:"reset"` restores the user\'s actual viewport and reports whether every step really succeeded. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field. Touch is a capability the page only sees in documents loaded AFTER the switch (`\'ontouchstart\' in window` needs one navigation), so the result reports what the page actually sees (`touchVisible`) rather than what was requested.',
        parameters: {
            tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
            device: { type: 'string', description: 'Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below.' },
            width: { type: 'number', description: 'Custom viewport width in CSS px.' },
            height: { type: 'number', description: 'Custom viewport height in CSS px.' },
            deviceScaleFactor: { type: 'number', description: 'Custom DPR (1 = standard, 2 = retina, 3 = super-retina).' },
            isMobile: { type: 'boolean', description: 'Pass as mobile to the page (affects responsive meta).' },
            hasTouch: { type: 'boolean', description: 'Enable touch event dispatch.' },
            userAgent: { type: 'string', description: 'Custom User-Agent string. Empty string clears.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    tabId: { type: 'number', required: true },
                    reset: { type: 'boolean' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                    deviceScaleFactor: { type: 'number' },
                    isMobile: { type: 'boolean' },
                    hasTouch: { type: 'boolean' },
                    userAgent: { type: 'string' },
                    // 清理失败必须能被看见：`reset:false` 时模型要知道"没复位成功"。
                    resetFailures: { type: 'array', items: { type: 'string' } },
                    // 单项设置（UA / 触摸）失败：不算整条失败，但要说出来。
                    warnings: { type: 'array', items: { type: 'string' } },
                    // 页面**现场**看到的触摸能力，而不是我们的意图（见扩展的 touchStateOf）。
                    touchVisible: { type: 'boolean' },
                    pageMaxTouchPoints: { type: 'number' },
                },
            },
            render: (_args, value) => {
                // 页面到底看不看得见触摸：`hasTouch` 是**请求**，`touchVisible` 是页面现场。
                // 实测（Edge 156）：改触摸仿真只对**之后**加载的文档生效，所以这两个值会不一致
                // 一小段时间——必须说出来，否则模型会以为站点已经按触摸设备跑了。
                const touch = value.touchVisible === true
                    ? ` touch=on(${value.pageMaxTouchPoints ?? '?'}pt)`
                    : value.hasTouch === true
                        ? ' touch=已请求，但页面里没有 ontouchstart（只对之后加载的文档生效：导航一次即可）'
                        : ' touch=off';
                if (value.reset === false) {
                    const why = (value.resetFailures ?? []).join('; ');
                    return [{
                            type: 'text',
                            text: `Tab ${value.tabId}: 复位没有全部成功（reset:false）——${why.length > 0 ? why : '原因未报'}${touch}\n`
                                + '这些项可能仍处于仿真状态，别当成已复位：先用 browser_read 看一眼当前页面，再决定重试还是手动改回。',
                        }];
                }
                if (value.reset === true)
                    return [{ type: 'text', text: `Tab ${value.tabId}: emulation reset to default${touch}` }];
                // 覆盖生效的是哪个 UA 必须写出来：模型只看这句，看不见 value 里的字段。
                const ua = value.userAgent === undefined ? '' : ` UA="${flattenOneLine(value.userAgent, 80)}"`;
                const warn = (value.warnings ?? []).length > 0 ? `\n未生效：${(value.warnings ?? []).join('; ')}` : '';
                return [{
                        type: 'text',
                        text: `Tab ${value.tabId}: ${value.width || '?'}×${value.height || '?'} DPR=${value.deviceScaleFactor ?? '?'} mobile=${value.isMobile ?? false}${touch}${ua}${warn}`,
                    }];
            },
        },
        presentCall: args => ({ card: 'generic', title: `Emulate${args.device ? ' ' + args.device : ' device'}`, kind: 'other' }),
        async execute(args, exec) {
            const params = {};
            if (args.tabId !== undefined)
                params.tabId = args.tabId;
            if (typeof args.device === 'string')
                params.device = args.device;
            if (typeof args.width === 'number')
                params.width = args.width;
            if (typeof args.height === 'number')
                params.height = args.height;
            if (typeof args.deviceScaleFactor === 'number')
                params.deviceScaleFactor = args.deviceScaleFactor;
            if (typeof args.isMobile === 'boolean')
                params.isMobile = args.isMobile;
            if (typeof args.hasTouch === 'boolean')
                params.hasTouch = args.hasTouch;
            if (typeof args.userAgent === 'string')
                params.userAgent = args.userAgent;
            const raw = await controller.execute('emulate', params, exec.signal);
            // 扩展在无覆盖时回的是显式 `userAgent: null`（background.js:719），而宿主的
            // 校验器对 null **会下钻判类型**（只跳过 undefined）。原样透传时
            // `device:"desktop"` 或自定义宽高的每次调用都会抛 ToolOutputError。
            const strings = (value) => (Array.isArray(value) ? value.filter((line) => typeof line === 'string') : []);
            return {
                tabId: raw.tabId,
                ...(raw.reset === true ? { reset: true } : {}),
                // 复位失败是**可执行的信息**，必须原样带给模型（以前这一位根本不存在，
                // 于是清理失败也被当成"已复位"）。
                ...(raw.reset === false ? { reset: false } : {}),
                ...(typeof raw.width === 'number' ? { width: raw.width } : {}),
                ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
                ...(typeof raw.deviceScaleFactor === 'number' ? { deviceScaleFactor: raw.deviceScaleFactor } : {}),
                ...(typeof raw.isMobile === 'boolean' ? { isMobile: raw.isMobile } : {}),
                ...(typeof raw.hasTouch === 'boolean' ? { hasTouch: raw.hasTouch } : {}),
                ...(typeof raw.userAgent === 'string' && raw.userAgent.length > 0 ? { userAgent: raw.userAgent } : {}),
                ...(strings(raw.resetFailures).length > 0 ? { resetFailures: strings(raw.resetFailures) } : {}),
                ...(strings(raw.warnings).length > 0 ? { warnings: strings(raw.warnings) } : {}),
                ...(typeof raw.touchVisible === 'boolean' ? { touchVisible: raw.touchVisible } : {}),
                ...(typeof raw.pageMaxTouchPoints === 'number' ? { pageMaxTouchPoints: raw.pageMaxTouchPoints } : {}),
            };
        },
    }));
    // 懒启动：模型面前**只有**这一个工具，它先报目录、再按需装载。装上的工具拿到的
    // 就是完整描述，所以这里不需要、也不提供「查描述」的第二个入口。
    if (options.lazyTools) {
        /** 分组说明从 TOOL_GROUPS 现算，描述不可能是另一张手写表。 */
        const groupLine = Object.entries(TOOL_GROUPS)
            .map(([group, names]) => `"${group}" = ${names.join(', ')}`)
            .join('; ');
        const groupNamesOf = (key) => Object.prototype.hasOwnProperty.call(TOOL_GROUPS, key) ? TOOL_GROUPS[key] : undefined;
        ctx.tools.register(defineTool({
            name: 'browser_tools',
            description: 'Load browser tools. The browser_* family drives the user\'s real, logged-in browser '
                + 'through the DSH Browser extension, but lazy startup is on: this is the ONLY browser tool '
                + 'exposed, and a tool that is not loaded cannot be called at all. Load what you need first — it '
                + 'then behaves like any other tool, full description and parameters included, from your next '
                + 'step on. What you load applies to THIS session only — another session still sees just this '
                + 'loader, and your loads go away when the session does. '
                + 'Call with no `names` to list everything loadable. Call with `names` to load: exact '
                + 'tool names ("browser_click"), a group name, or "*" for all of them. '
                + `Groups: ${groupLine}. `
                + 'Load everything you need in ONE call: each load changes the tool list, so batching beats '
                + 'loading one tool at a time.',
            parameters: {
                names: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'What to load: exact tool names, group names ("read", "write", "tabs", "capture", "raw"), or "*" for everything. Omit to list what can be loaded.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        exposed: { type: 'array', items: { type: 'string' }, required: true },
                        activated: { type: 'array', items: { type: 'string' }, required: true },
                        already: { type: 'array', items: { type: 'string' }, required: true },
                        unknown: { type: 'array', items: { type: 'string' }, required: true },
                        scope: { type: 'string', required: true },
                        errors: { type: 'array', items: { type: 'string' } },
                        available: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    name: { type: 'string', required: true },
                                    group: { type: 'string', required: true },
                                    summary: { type: 'string', required: true },
                                },
                            },
                        },
                    },
                },
                render: (_args, value) => {
                    if (value.available !== undefined) {
                        const loaded = value.exposed.length === 0 ? 'nothing yet' : value.exposed.join(', ');
                        const lines = [
                            `Loaded: ${loaded}. Loadable (${value.available.length}):`,
                            ...value.available.map(row => `- ${row.name} [${row.group}] — ${row.summary}`),
                            'Load with browser_tools {names: [...]} — exact names, a group name, or "*".',
                        ];
                        return [{ type: 'text', text: clampRendered(lines.join('\n')) }];
                    }
                    const lines = [];
                    if (value.activated.length > 0)
                        lines.push(`Loaded, callable now: ${value.activated.join(', ')}`);
                    if (value.already.length > 0)
                        lines.push(`Already loaded: ${value.already.join(', ')}`);
                    if (value.unknown.length > 0) {
                        lines.push(`Unknown, nothing loaded for these: ${value.unknown.join(', ')} — call browser_tools with no names to see the exact tool names.`);
                    }
                    if (lines.length === 0)
                        lines.push('Nothing loaded: pass names, a group name, or "*".');
                    if (value.scope === 'global') {
                        lines.push('Note: these landed in the global layer (this call had no session scope), so every session sees them.');
                    }
                    if (value.scope === 'unknown')
                        lines.push('Note: could not read back which layer these landed in.');
                    if (value.errors !== undefined && value.errors.length > 0) {
                        lines.push(`Failed to load: ${value.errors.join('; ')}`);
                    }
                    return [{ type: 'text', text: clampRendered(lines.join('\n')) }];
                },
            },
            presentCall: () => ({ card: 'generic', title: 'Load browser tools', kind: 'other' }),
            async execute(args, exec) {
                const exposure = exposureOf(exec);
                const requested = (Array.isArray(args.names) ? args.names : [])
                    .map(item => (typeof item === 'string' ? item.trim() : ''))
                    .filter(item => item.length > 0);
                if (requested.length === 0) {
                    const available = [...known.keys()]
                        .filter(name => !exposure.loaded.has(name))
                        .map(name => ({
                        name,
                        group: groupOf(name) ?? 'other',
                        summary: summarize(known.get(name)?.description ?? ''),
                    }))
                        .sort((left, right) => left.name.localeCompare(right.name));
                    return {
                        exposed: [...exposure.loaded].sort(),
                        activated: [],
                        already: [],
                        unknown: [],
                        scope: scopeOfExposure(exposure),
                        available,
                    };
                }
                const wanted = new Set();
                const unknown = [];
                for (const item of requested) {
                    if (item === '*') {
                        for (const name of known.keys())
                            wanted.add(name);
                        continue;
                    }
                    const fromGroup = groupNamesOf(item.toLowerCase());
                    if (fromGroup !== undefined) {
                        for (const name of fromGroup)
                            if (known.has(name))
                                wanted.add(name);
                        continue;
                    }
                    if (known.has(item))
                        wanted.add(item);
                    else
                        unknown.push(item);
                }
                const activated = [];
                const already = [];
                const errors = [];
                for (const name of wanted) {
                    // 注册失败（重名、闸门拒绝）不许吞，也不许报成「装上了」。
                    try {
                        ;
                        (expose(name, exposure) ? activated : already).push(name);
                    }
                    catch (error) {
                        errors.push(`${name}: ${error?.message ?? String(error)}`);
                    }
                }
                const report = {
                    exposed: [...exposure.loaded].sort(),
                    activated: activated.sort(),
                    already: already.sort(),
                    unknown,
                    scope: scopeOfExposure(exposure),
                };
                if (errors.length > 0)
                    report.errors = errors;
                return report;
            },
        }));
    }
    // Raw CDP passthrough. Registered only while the config allows it, so the
    // model surface never advertises a capability the gate would refuse anyway.
    if (options.allowRawCdp) {
        mount(defineTool({
            name: 'browser_cdp',
            description: 'Send a raw Chrome DevTools Protocol command to a tab and return its JSON result. The escape hatch for domains with no dedicated browser_* tool (Page.captureSnapshot, Network.getAllCookies, Performance.getMetrics, Fetch.enable, …). Results over 20000 JSON characters are truncated and the full size is reported; prefer browser_screenshot / browser_pdf for binary payloads — they save to disk.',
            parameters: {
                method: { type: 'string', required: true, description: 'CDP method as "Domain.method", e.g. "Page.captureSnapshot" or "Network.getAllCookies".' },
                params: { type: 'json', description: 'Method parameters object; defaults to {}. Must be a JSON object.' },
                tabId: { type: 'number', description: 'Target tab; defaults to the active tab.' },
                timeoutMs: { type: 'number', description: 'Bridge budget in milliseconds; defaults to 30000 (capped at 300000).' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        tabId: { type: 'number', required: true },
                        method: { type: 'string', required: true },
                        json: { type: 'string', required: true },
                        bytes: { type: 'number', required: true },
                        truncated: { type: 'boolean', required: true },
                    },
                },
                render: (_args, value) => [{
                        type: 'text',
                        text: clampRendered(`Tab ${value.tabId}: ${value.method} returned ${value.bytes} JSON chars${value.truncated ? ' (truncated to 20000)' : ''}\n${value.json}`),
                    }],
            },
            isConcurrencySafe: () => false,
            presentCall: args => ({ card: 'generic', title: `CDP ${args.method}`, kind: 'other' }),
            async execute(args, exec) {
                if (typeof args.method !== 'string' || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(args.method)) {
                    throw new Error('browser_cdp requires a CDP method like "Page.captureSnapshot" (Domain.method)');
                }
                const params = { method: args.method };
                if (args.params !== undefined)
                    params.params = args.params;
                if (args.tabId !== undefined)
                    params.tabId = args.tabId;
                const timeoutMs = Math.min(300_000, Math.max(1_000, Number(args.timeoutMs ?? 30_000) || 30_000));
                return await controller.execute('cdp.call', params, exec.signal, timeoutMs);
            },
        }));
    }
}
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
export function apply(ctx, config) {
    const resolved = config;
    if (resolved.enabled && resolved.token.trim().length === 0) {
        throw new Error('browser-bridge: token must be a non-empty string when enabled');
    }
    const controller = new BridgeController(line => ctx.logger.info(line));
    let current = () => resolved;
    // Settings wiring, feature-detected. `sctx.settings.register` exists on
    // dsh-settings up to 0.1.2-rc.1; 0.1.7-rc.2 and 0.2.x export `SettingsForms`
    // instead, whose surface is configure/describe/update/replace/mutate — calling
    // `register` there throws a TypeError in the middle of this callback and used to
    // skip the reconcile/watch below (issue #8).
    ctx.inject(['settings'], (sctx) => {
        const settings = sctx.settings;
        /** Converge without a namespace: the profile config stays authoritative. */
        const withoutNamespace = (why) => {
            current = () => resolved;
            ctx.logger.info(`browser-bridge: settings integration skipped (${why})`);
            // A failed start is recorded on the controller so every tool call reports it,
            // instead of throwing out of a callback the host never awaits.
            void controller.reconcile(current());
        };
        const register = settings.register;
        if (typeof register !== 'function') {
            // dsh-settings 0.1.7+ / 0.2.x: the host projects this plugin's own `Config`
            // schema into an auto settings page, and editing that page re-applies the
            // entry, so the `config` handed to apply() is already the live value.
            const configure = settings.configure;
            if (typeof configure === 'function') {
                try {
                    ctx.effect(() => configure({ auto: true }), 'browser-bridge: settings presentation');
                }
                catch (error) {
                    ctx.logger.info(`browser-bridge: settings presentation skipped: ${errorMessage(error)}`);
                }
            }
            withoutNamespace('no settings.register on this dsh-settings build');
            return;
        }
        let scope;
        try {
            scope = register(BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, {
                base: config,
                validate: (value) => {
                    if (value.enabled && (value.token ?? '').trim().length === 0) {
                        throw new Error('browser-bridge: token must be a non-empty string when enabled');
                    }
                },
            });
        }
        catch (error) {
            ctx.logger.info(`browser-bridge: settings namespace failed: ${errorMessage(error)}`);
            withoutNamespace('register threw');
            return;
        }
        current = () => scope.get();
        ctx.effect(() => () => {
            // Mirror `isUnloading` from dsh-settings (private): the fiber's own
            // unload path runs the disposer too, and there re-applying the
            // composition entry and firing `onChange` would re-register routes
            // against a fiber whose resources are being released.
            if (ctx.fiber.state === 4 /* FiberState.DISPOSED */ || ctx.fiber.state === 5 /* FiberState.UNLOADING */)
                return;
            current = () => resolved;
            void controller.reconcile(current());
        }, 'browser-bridge: settings cleanup');
        void controller.reconcile(current());
        scope.watch(() => {
            if (ctx.fiber.state === 4 /* FiberState.DISPOSED */ || ctx.fiber.state === 5 /* FiberState.UNLOADING */)
                return;
            void controller.reconcile(current());
        });
    });
    // Activation converges loudly so a bad port fails the plugin at load;
    // later settings commits degrade to recorded errors instead.
    controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
        throw new Error(`browser-bridge: ${errorMessage(error)}`);
    });
    applyBrowserTools(ctx, controller, {
        lazyTools: resolved.lazyToolDocs === true,
        allowRawCdp: resolved.allowRawCdp !== false,
    });
    mountSettingsRoute(ctx, controller, current);
    ctx.effect(() => () => {
        void controller.stop();
    }, 'browser-bridge: server lifecycle');
}
/**
 * Read one Host service off a context.
 *
 * 两种读法都要试：`ctx.get(name)` 是 cordis 的正式读法，服务还没就绪时会**抛**
 * （那不是错误，只是「现在没有」）；`ctx.inject` 回调里的 ctx 则把服务直接挂在
 * 同名属性上。拿不到就返回 `undefined`，由调用方决定这是不是问题。
 * @param scope - the context (or injected child context) to read from.
 * @param name - exact service key, e.g. `webServer`.
 * @returns the service, or `undefined` while it does not exist.
 */
function serviceNamed(scope, name) {
    const get = scope.get;
    if (typeof get === 'function') {
        try {
            const found = get.call(scope, name);
            if (found !== undefined && found !== null)
                return found;
        }
        catch {
            // 服务不存在在 cordis 里是抛出：落到下面按属性再试一次。
        }
    }
    const viaProperty = scope[name];
    return viaProperty === null ? undefined : viaProperty;
}
/**
 * Mount the Settings page's same-origin JSON endpoint when this composition has
 * a Web server (headless profiles do not), and stay inert otherwise. The route is
 * an effect of the plugin context, so disabling or unloading the plugin removes
 * it together with everything else.
 *
 * **必须用 `ctx.inject`，不能在激活时 `get('webServer')` 探一次。** 第一版就是
 * 那样，而服务是按加载顺序出现的：本插件没有声明对 `webServer` 的依赖，于是冷启动
 * （重启 dsh）时经常比 Web 载体先跑到这里，那一次拿不到就 `return`——而这次错过是
 * **永久**的：设置页从此每 3 秒轮询一个宿主编排里根本不存在的路径，宿主回 404 空体，
 * 客户端只能报 `Failed to execute 'json' on 'Response': Unexpected end of JSON input`，
 * 页面于是显示「桥接 未监听 / 扩展 未连接」——这两个判断恰好全错（桥在听、扩展连着，
 * 用户看到的扩展弹窗是对的）。在插件详情页把它关掉再打开就恢复，正因为那时服务已就绪。
 *
 * `ctx.inject` 把「等它出现」写成声明式：依赖到位才执行，依赖换掉会重新执行（旧路由
 * 随旧 fiber 一起摘掉）。挂载失败也不再往外抛——设置页只是装饰层，它坏掉不该把桥接
 * 和全部工具一起带走，那会把「页面显示不对」升级成「AI 也不能用浏览器」。
 * @param ctx - the plugin context.
 * @param controller - live bridge controller whose status/cleanup the page uses.
 * @param current - the live resolved config the page reads and edits.
 */
function mountSettingsRoute(ctx, controller, current) {
    /** 挂一次：只在 webServer 已经在手时调用；`scope` 决定这条路由的处置归属。 */
    const attach = (scope) => {
        const webServer = serviceNamed(scope, 'webServer');
        if (webServer === undefined || typeof webServer.register !== 'function') {
            ctx.logger.info('browser-bridge: no webServer in this composition; the Settings page route is not mounted');
            return;
        }
        let origin;
        try {
            origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined;
        }
        catch {
            origin = undefined;
        }
        const route = buildSettingsRoute({
            packageName: PACKAGE_NAME,
            getConfig: () => current(),
            status: () => controller.status(),
            cleanup: () => controller.cleanup(),
            getService: name => serviceNamed(ctx, name),
            ...(origin === undefined ? {} : { origin }),
        });
        // 处置挂在 `scope` 上：`inject` 的 fiber 被换掉/卸载时路由跟着摘掉，不会留下
        // 一个指向旧 controller 的僵尸端点。scope 不是真 ctx 时才退回插件自己的 ctx。
        const effect = typeof scope.effect === 'function'
            ? scope.effect.bind(scope)
            : ctx.effect.bind(ctx);
        try {
            effect(() => webServer.register(route), 'browser-bridge: settings route');
        }
        catch (error) {
            ctx.logger.warn(`browser-bridge: settings route not mounted: ${errorMessage(error)}`);
        }
    };
    const inject = ctx.inject;
    if (typeof inject !== 'function') {
        // 真实宿主一定有 `inject`（上面 settings 集成那步先就要求了它），走到这里只可能是
        // 手工拼出来的 ctx：宁可留一行日志，也不要假装挂上了一条其实不存在的路由。
        ctx.logger.info('browser-bridge: ctx.inject is missing; the Settings page route is not mounted');
        return;
    }
    inject.call(ctx, ['webServer'], (inner) => {
        attach(inner === undefined || inner === null ? ctx : inner);
    });
}
