/** Absolute prefix the route owns on the Web server. */
export const SETTINGS_API_PREFIX = '/browser-control/api';
/** Largest request body this endpoint buffers; the payloads are tiny. */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * 分组名上限。插件侧（`src/index.ts`）往信封里盖章时切一次，扩展建组时再切一次，
 * 这里是设置页那一层——三处必须同一个数，所以它从这里导出，index.ts 直接引用它。
 */
export const TAB_GROUP_TITLE_MAX = 40;
/**
 * 浏览器可执行文件路径的长度上限。
 *
 * 比分组名宽得多：Windows 的完整路径本来就长（`C:\Program Files (x86)\…`），而且
 * 便携版/自定义安装可能更深。这里只挡住明显是垃圾的超长输入，不做任何路径归一——
 * 路径该长什么样由文件系统说了算。
 */
export const BROWSER_PATH_MAX = 512;
/**
 * `@` 引用菜单一次最多列多少行。
 *
 * 超出的行不返回，但仍计入 `total`：菜单可以据此说「还有更多」，而用户不会以为
 * 自己只开了 50 个页（一个开满标签页的浏览器很容易超过这个数）。
 */
export const TAB_REFERENCE_LIMIT = 50;
/**
 * 标签页列表的缓存窗口。
 *
 * `candidates` 是**每敲一个字符**调一次的回调，而一次 `tabs.list` 要跨 WebSocket 往返
 * 到浏览器扩展。两秒内复用上一份结果：键盘连击不会变成命令风暴，代价只是「刚开的页
 * 最迟两秒后才出现在菜单里」，这个延迟用户察觉不到。
 */
export const TAB_REFERENCE_TTL_MS = 2_000;
/** A failure the caller can act on; `status` is the HTTP status. */
class RouteError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
/**
 * Config fields the Settings page may flip — booleans only. Everything else is
 * profile-only (port, token, shotsDir).
 */
const BOOLEAN_FIELDS = new Set(['readOnly', 'allowScript', 'lazyToolDocs', 'allowRawCdp', 'allowIncognito', 'agentHighlight']);
/**
 * Enum fields and the only values each accepts. The words are the wire/config
 * vocabulary, never the Chinese labels: the page may re-word a label without
 * touching what lands in the profile, and the extension keeps reading one name
 * per behaviour.
 */
const ENUM_FIELDS = {
    tabWindow: ['current', 'new'],
    focusPolicy: ['avoid', 'auto'],
    userTakeover: ['yield', 'ignore'],
};
function recordOf(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
function headerOf(req, name) {
    const value = req.headers[name];
    if (Array.isArray(value))
        return value[0];
    return typeof value === 'string' ? value : undefined;
}
function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
 * Apply the browser-trust fence to one request.
 * @param req - the incoming request.
 * @param origin - this listener's own authority (`host:port`), captured at mount time.
 * @returns true only for a same-authority browser request or a local non-browser client.
 */
function isTrusted(req, origin) {
    const rawHost = headerOf(req, 'host')?.trim().toLowerCase();
    if (rawHost === undefined || rawHost.length === 0)
        return false;
    let hostUrl;
    try {
        hostUrl = new URL(`http://${rawHost}`);
    }
    catch {
        return false;
    }
    const ownAuthority = origin === undefined ? false : (() => {
        try {
            return new URL(origin).host.toLowerCase() === hostUrl.host.toLowerCase();
        }
        catch {
            return false;
        }
    })();
    if (!isLoopbackHostname(hostUrl.hostname) && !ownAuthority)
        return false;
    if (headerOf(req, 'sec-fetch-site') === 'cross-site')
        return false;
    const originHeader = headerOf(req, 'origin');
    if (originHeader === undefined)
        return true;
    try {
        return new URL(originHeader).host.toLowerCase() === hostUrl.host.toLowerCase();
    }
    catch {
        // The opaque "null" origin (sandboxed iframe, file: page) is not this app.
        return false;
    }
}
/** Buffer one JSON body, refusing malformed JSON and unbounded input. */
async function readJsonBody(req) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of req) {
        const buffer = chunk;
        bytes += buffer.length;
        if (bytes > MAX_BODY_BYTES)
            throw new RouteError(413, 'body_too_large', 'request body is too large');
        chunks.push(buffer);
    }
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (text.length === 0)
        return {};
    try {
        const parsed = JSON.parse(text);
        return recordOf(parsed);
    }
    catch {
        throw new RouteError(400, 'bad_json', 'request body is not valid JSON');
    }
}
function writeJson(res, status, payload) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}
function fail(res, status, code, message) {
    writeJson(res, status, { ok: false, error: { code, message } });
}
/** Mask the shared secret; the page never receives the value that would grant command access. */
function maskToken(token) {
    if (typeof token !== 'string' || token.length === 0)
        return null;
    if (token.length <= 4)
        return '****';
    return `${token.slice(0, 2)}${'*'.repeat(Math.min(8, token.length - 4))}${token.slice(-2)}`;
}
/** 只列真正能打开的网页：`chrome://`、`edge://`、`about:blank`、扩展页都是菜单里的噪音。 */
function isBrowsableUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}
/** 标题兜底：扩展偶尔给空标题（有些页面 `document.title` 就是空的），菜单里不能出现空行。 */
function tabTitleOf(url, title) {
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (trimmed.length > 0)
        return trimmed;
    try {
        const parsed = new URL(url);
        return `${parsed.host}${parsed.pathname}`;
    }
    catch {
        return url;
    }
}
/**
 * 排序：活跃页最前，其余按窗口升序、再按 id 升序。
 *
 * **必须是全序**：`candidates` 每按一个键就调用一次，一份顺序会抖动的菜单会让用户在
 * 按下回车的那一刻选到别的页——而选错的代价是把一段 URL 插进消息里。所以比较器在
 * 组内也继续比 `windowId` / `id`，`id` 唯一，比较结果不只「大致稳定」。
 * @returns 负数表示 a 排在 b 前面。
 */
function compareReferenceTabs(a, b) {
    if (a.active !== b.active)
        return a.active ? -1 : 1;
    if (a.windowId !== b.windowId)
        return a.windowId - b.windowId;
    return a.id - b.id;
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
export function selectReferenceTabs(raw, limit = TAB_REFERENCE_LIMIT) {
    const rows = Array.isArray(recordOf(raw).tabs) ? recordOf(raw).tabs : [];
    const seen = new Set();
    const kept = [];
    for (const row of rows) {
        const tab = recordOf(row);
        const id = tab.id;
        if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0)
            continue;
        // 去重在过滤之前：同一个 id 只认第一行，后面的重复行无论长什么样都不再看。
        if (seen.has(id))
            continue;
        seen.add(id);
        if (tab.incognito === true)
            continue;
        if (tab.openedByAgent === true)
            continue;
        if (!isBrowsableUrl(tab.url))
            continue;
        kept.push({
            id,
            title: tabTitleOf(tab.url, tab.title),
            url: tab.url,
            windowId: typeof tab.windowId === 'number' && Number.isFinite(tab.windowId) ? tab.windowId : 0,
            active: tab.active === true,
        });
    }
    kept.sort(compareReferenceTabs);
    const total = kept.length;
    return { tabs: kept.slice(0, Math.max(0, limit)), total };
}
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
export function createReferenceTabsCache(fetchTabs, options = {}) {
    const ttlMs = options.ttlMs ?? TAB_REFERENCE_TTL_MS;
    const limit = options.limit ?? TAB_REFERENCE_LIMIT;
    const now = options.now ?? (() => Date.now());
    let cached;
    let inflight;
    /**
     * 共享取数**唯一**的取消源。它不挂在任何调用者身上，所以没有任何单个请求能把
     * 别人的结果带坏（见上面那段时序）。
     */
    const ownAbort = new AbortController();
    /** 唯一一条 stale 判据：这份快照的年龄超出 TTL 了吗。 */
    const staleOf = (snapshot) => now() - snapshot.fetchedAt > ttlMs;
    /**
     * 让「这次调用」在它的 signal 取消时提前结束，但**不打断**共享的那次取数。
     * @param shared - 共享的在途取数。
     * @param signal - 这个调用者自己的取消信号（可选）。
     * @returns 与 `shared` 竞争的结果；调用者取消时以 `cancelled` 拒绝。
     */
    const waitFor = async (shared, signal) => {
        if (signal === undefined)
            return await shared;
        if (signal.aborted)
            throw new Error('cancelled');
        let onAbort;
        const cancelled = new Promise((_resolve, reject) => {
            onAbort = () => reject(new Error('cancelled'));
            signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
            return await Promise.race([shared, cancelled]);
        }
        finally {
            if (onAbort !== undefined)
                signal.removeEventListener('abort', onAbort);
        }
    };
    /**
     * 发起一次共享取数（已有在途时复用）。
     *
     * **`inflight` 的清理刻意不放在 async 函数体里。** 那里看着最自然（`finally` 里
     * `inflight = undefined`），但它依赖一个没写下来的前提：函数体至少让出过微任务。
     * `fetchTabs` **同步**抛错时刚成立不了——`(async () => { ... })()` 会同步跑到
     * catch/finally，`inflight = undefined` 在**赋值之前**就执行完了，紧接着
     * `inflight = run` 又把那个已 rejected 的 promise 装回去，从此没人清它：之后每次
     * `read()` 都直接拿到同一个 rejection，链路恢复了也永远不重试。
     * 所以改成赋值在前、清理挂在结算回调上（同步抛错时 `run` 已 rejected，回调仍在
     * 微任务里跑，顺序天然正确）。
     */
    const start = () => {
        const run = (async () => {
            try {
                // 注意：传给桥接的是 `ownAbort.signal`，**不是**调用者的信号。用调用者的
                // 信号会让「A 被取消」顺着共享 promise 传染给 B，菜单于是谎报断线。
                const picked = selectReferenceTabs(await fetchTabs(ownAbort.signal), limit);
                const snapshot = {
                    tabs: picked.tabs,
                    fetchedAt: now(),
                    stale: false,
                    total: picked.total,
                };
                // 刚取到的这份年龄为 0，也走同一条判据，不在分支里写死：这样 ttlMs
                // 被调成负值时它自己会算出 true，不会出现两份互相矛盾的结论。
                snapshot.stale = staleOf(snapshot);
                cached = snapshot;
                return snapshot;
            }
            catch (error) {
                // 失败回落：这里同样不写死 true，年龄按构造必然已超出 TTL，判据自己会说是。
                if (cached !== undefined)
                    return { ...cached, stale: staleOf(cached) };
                throw error;
            }
        })();
        inflight = run;
        // 成功与失败都要清。`inflight === run` 这个比较不能省：并发下更新的那次
        // `start()` 可能已经把 `inflight` 换成新 promise，老的结算不许把新的清掉。
        const settle = () => {
            if (inflight === run)
                inflight = undefined;
        };
        run.then(settle, settle);
        return run;
    };
    return {
        async read(signal) {
            if (signal?.aborted)
                throw new Error('cancelled');
            if (cached !== undefined && !staleOf(cached)) {
                // 命中 TTL：回的是同一份快照，`stale` 仍走年龄判据（此处必然 false）。
                return { ...cached, stale: staleOf(cached) };
            }
            return await waitFor(inflight ?? start(), signal);
        },
        /** 路由摘掉时结束可能还在途的取数；供 `buildSettingsRoute` 的清理路径调用。 */
        dispose() {
            ownAbort.abort();
        },
    };
}
/** The JSON `/status` reports; deliberately no raw token, no file paths. */
function statusPayload(deps) {
    const config = deps.getConfig();
    return {
        bridge: deps.status(),
        config: config === undefined ? null : {
            enabled: config.enabled === true,
            port: config.port ?? null,
            tokenMasked: maskToken(config.token),
            readOnly: config.readOnly === true,
            allowScript: config.allowScript !== false,
            lazyToolDocs: config.lazyToolDocs === true,
            allowRawCdp: config.allowRawCdp !== false,
            // 隔离实例的第三条授权。默认 false —— 与 schema 默认值一致，所以页面上那个
            // 开关在没法读取状态时也显示「关」而不是空白。
            allowIncognito: config.allowIncognito === true,
            // 枚举字段在页面上是受控下拉：值必须是三个词里的一个，否则 select 会显示
            // 空档。未知/缺失一律落到 schema 默认值，与扩展侧的 DEFAULT_POLICY 一致。
            tabWindow: config.tabWindow === 'new' ? 'new' : 'current',
            focusPolicy: config.focusPolicy === 'auto' ? 'auto' : 'avoid',
            userTakeover: config.userTakeover === 'ignore' ? 'ignore' : 'yield',
            // 分组名是**自由文本**，所以不能像枚举那样兜底成默认词：空串在这里是有含义的
            // （= 不分组），页面上的输入框必须如实显示成空。只有完全缺失（还没读过配置）
            // 才给默认值。
            tabGroupTitle: typeof config.tabGroupTitle === 'string' ? config.tabGroupTitle : 'DSH',
            agentHighlight: config.agentHighlight !== false,
            // 浏览器路径同样是**自由文本**，空串在这里也有含义（= 自动查找），所以
            // 不能兜底成任何默认路径：那会让「我不指定」悄悄变成一个可能不存在的路径。
            browserPath: typeof config.browserPath === 'string' ? config.browserPath : '',
        },
    };
}
/**
 * Every field the page may change, validated before anything is persisted.
 *
 * Two shapes, because the two kinds of setting cannot share one rule: a boolean
 * toggle either is or is not, an enum has a closed vocabulary. Both keep the
 * same `bad_field` code so the page has one error branch, and both reject the
 * whole patch instead of silently dropping the bad key — a dropped field looks
 * like a successful save with the old value.
 * @returns the validated patch, ready for the Host `configEditor`.
 */
function configPatchOf(body) {
    const patch = recordOf(body.patch);
    const out = {};
    for (const [key, value] of Object.entries(patch)) {
        const allowed = ENUM_FIELDS[key];
        if (allowed !== undefined) {
            if (typeof value !== 'string' || !allowed.includes(value)) {
                throw new RouteError(400, 'bad_field', `${key} must be one of ${allowed.join(' | ')}`);
            }
            out[key] = value;
            continue;
        }
        // 分组名是唯一一个**自由文本**字段：压平空白、限长，但**允许空串**（= 不分组）。
        // 这里不 trim 成默认值，否则用户「清空输入框」这个动作会被悄悄解释成「恢复 DSH」。
        if (key === 'tabGroupTitle') {
            if (typeof value !== 'string')
                throw new RouteError(400, 'bad_field', 'tabGroupTitle must be a string');
            const title = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
            if (title.length > TAB_GROUP_TITLE_MAX) {
                throw new RouteError(400, 'bad_field', `tabGroupTitle must be at most ${TAB_GROUP_TITLE_MAX} characters`);
            }
            out[key] = title;
            continue;
        }
        // 浏览器路径是第二个自由文本字段：**只去控制字符和首尾空白**，中间的空格与反斜杠
        // 一个都不能动（`C:\Program Files\...` 里那个空格是路径的一部分），也不能
        // 压平空白——压平会把带空格的真实路径改坏。留空 = 自动查找。
        if (key === 'browserPath') {
            if (typeof value !== 'string')
                throw new RouteError(400, 'bad_field', 'browserPath must be a string');
            const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
            if (cleaned.length > BROWSER_PATH_MAX) {
                throw new RouteError(400, 'bad_field', `browserPath must be at most ${BROWSER_PATH_MAX} characters`);
            }
            out[key] = cleaned;
            continue;
        }
        if (!BOOLEAN_FIELDS.has(key))
            throw new RouteError(400, 'unknown_field', `unknown config field: ${key}`);
        if (typeof value !== 'boolean')
            throw new RouteError(400, 'bad_field', `${key} must be a boolean`);
        out[key] = value;
    }
    if (Object.keys(out).length === 0)
        throw new RouteError(400, 'empty_patch', 'patch carries no editable field');
    return out;
}
/** Duck-typed entry addressing: Loader entry shapes differ across host generations. */
function entryName(entry) {
    const record = recordOf(entry);
    const options = recordOf(record.options);
    const value = record.name ?? options.name ?? record.packageName;
    return typeof value === 'string' ? value : undefined;
}
function entryId(entry) {
    const record = recordOf(entry);
    const options = recordOf(record.options);
    const value = record.patchId ?? record.id ?? options.id;
    return typeof value === 'string' ? value : undefined;
}
/**
 * Persist one patch through the Host `configEditor`, the documented path from a
 * raw config to a validated Loader reconciliation (a page edit therefore re-applies
 * the plugin exactly like a profile edit does).
 */
async function persistPatch(deps, patch) {
    const editor = deps.getService('configEditor');
    if (editor === undefined || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
        throw new RouteError(501, 'config_editor_unavailable', '这个宿主没有 configEditor 服务，设置页无法持久化：请改 profile 的 cordis.patch.yml（browser-bridge 的 config）后重启 dsh。');
    }
    const entries = await Promise.resolve(editor.entries());
    const list = Array.isArray(entries) ? entries : [];
    const entry = list.find(item => entryName(item) === deps.packageName)
        ?? list.find(item => entryId(item) === 'browser-bridge');
    if (entry === undefined) {
        throw new RouteError(409, 'entry_not_found', `在 profile 的配置行里找不到 ${deps.packageName}（patch id: browser-bridge）：请用 profile 覆盖层或插件详情页修改后重启。`);
    }
    await Promise.resolve(editor.edit(entry, current => ({ ...recordOf(current), ...patch })));
}
/** Build the one prefix route the Settings page talks to. */
export function buildSettingsRoute(deps) {
    /**
     * 标签页缓存挂在**路由实例**上，不在模块级：路由跟着插件生命周期活，插件被重载时
     * 旧快照必须一起走——否则重载后第一秒菜单里还是上一个桥接会话的 tab id。
     */
    const tabsCache = deps.listTabs === undefined
        ? undefined
        : createReferenceTabsCache(signal => deps.listTabs(signal));
    /** 标签页端点的失败形态与 `action` 端点一致：HTTP 200 + `ok:false`。 */
    const failTabs = (res, error) => {
        const code = typeof error.code === 'string' ? error.code : 'tabs_failed';
        const message = error instanceof Error ? error.message : String(error);
        writeJson(res, 200, { ok: false, error: { code, message } });
    };
    /**
     * 列标签页。缓存与过滤都是纯函数（可单测），这里只做接线与失败映射。
     *
     * 这里的 `AbortController` 只表达「**这一条请求**还要不要等」，**不会**顺着共享的
     * 在途取数传染给别人：用户敲下一个字母时宿主会取消上一次候选请求，如果那个取消
     * 能打断共享取数，同窗口里到达的下一条请求就会跟着失败，菜单于是谎报「浏览器未连接」。
     * 取舍写在 `createReferenceTabsCache` 的注释里（一次只读列举 + TTL 兜底，划得来）。
     */
    const dispatchTabs = async (req, res) => {
        if (tabsCache === undefined) {
            // 静默回空列表最坏：菜单看起来「一页都没有」，用户会以为菜单坏了，
            // 而真相是这个宿主的插件没接上这条数据源。
            throw new RouteError(501, 'tabs_unavailable', '这个宿主没有接上标签页数据源：请确认插件已启用并重启 dsh。');
        }
        const controller = new AbortController();
        // 守卫条件必须是 `!res.writableEnded`：正常响应结束时 `close` 也会触发（`end()` 之后
        // 连接才真正关闭），那时 abort 一次只是空操作；而真正的「客户端提前断开」发生时
        // `writableEnded` 仍是 false，abort 才会真的响。`off` 放在 finally 里，只是不让
        // 一个已完成的响应继续挂着监听器，不是正确性的依赖。
        const onClose = () => { if (!res.writableEnded)
            controller.abort(); };
        res.once('close', onClose);
        try {
            const snapshot = await tabsCache.read(controller.signal);
            writeJson(res, 200, { ok: true, value: snapshot });
        }
        catch (error) {
            // 调用者自己取消：这条请求没人要了，不再写响应（写了也只是对着一个已断开的
            // 连接），静默收场即可。别把它当成链路故障报给菜单。
            if (controller.signal.aborted)
                return;
            failTabs(res, error);
        }
        finally {
            res.off('close', onClose);
        }
    };
    /**
     * 把某个标签页叫到前台。走 `tabs.activate`，所以只读档会在这里被拦下（这是期望行为）。
     *
     * 这里**可以**把请求的取消直接传给桥接（与 `dispatchTabs` 不同）：每次 activate 都是
     * 一次独立动作，没有「共享在途」这回事，客户端断开就说明这个动作没人要看了，
     * 让它停是正确且省事的。
     */
    const dispatchActivate = async (req, res) => {
        const body = await readJsonBody(req);
        const tabId = body.tabId;
        if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) {
            throw new RouteError(400, 'bad_field', 'tabId must be a positive integer');
        }
        if (deps.activateTab === undefined) {
            throw new RouteError(501, 'tabs_unavailable', '这个宿主没有接上标签页数据源：请确认插件已启用并重启 dsh。');
        }
        const controller = new AbortController();
        const onClose = () => { if (!res.writableEnded)
            controller.abort(); };
        res.once('close', onClose);
        try {
            await deps.activateTab(tabId, controller.signal);
            writeJson(res, 200, { ok: true, value: { tabId } });
        }
        catch (error) {
            if (controller.signal.aborted)
                return;
            failTabs(res, error);
        }
        finally {
            res.off('close', onClose);
        }
    };
    const dispatch = async (endpoint, req, res) => {
        if (endpoint === 'status') {
            writeJson(res, 200, { ok: true, value: statusPayload(deps) });
            return;
        }
        if (endpoint === 'tabs') {
            await dispatchTabs(req, res);
            return;
        }
        if (endpoint === 'tabs/activate') {
            await dispatchActivate(req, res);
            return;
        }
        if (endpoint === 'config') {
            const body = await readJsonBody(req);
            const patch = configPatchOf(body);
            await persistPatch(deps, patch);
            writeJson(res, 200, { ok: true, value: { persisted: true, patch } });
            return;
        }
        if (endpoint === 'action') {
            const body = await readJsonBody(req);
            const action = typeof body.action === 'string' ? body.action : '';
            if (action === 'cleanup') {
                try {
                    const result = await deps.cleanup();
                    writeJson(res, 200, {
                        ok: true,
                        value: { shotsRemoved: result.shotsRemoved, scratchRemoved: [...result.scratchRemoved] },
                    });
                }
                catch (error) {
                    const code = typeof error.code === 'string' ? error.code : 'cleanup_failed';
                    const message = error instanceof Error ? error.message : String(error);
                    writeJson(res, 200, { ok: false, error: { code, message } });
                }
                return;
            }
            if (action === 'openStatus') {
                const config = deps.getConfig();
                if (config?.port === undefined)
                    throw new RouteError(409, 'bridge_not_configured', '桥接还没读到配置，没有状态页可开');
                writeJson(res, 200, { ok: true, value: { url: `http://127.0.0.1:${config.port}/` } });
                return;
            }
            throw new RouteError(400, 'unknown_action', `unknown action: ${action || '(empty)'}`);
        }
        throw new RouteError(404, 'not_found', `unknown endpoint: ${endpoint || '(empty)'}`);
    };
    return {
        kind: 'prefix',
        path: SETTINGS_API_PREFIX,
        async handler(req, res) {
            try {
                if (!isTrusted(req, deps.origin)) {
                    fail(res, 403, 'untrusted_request', 'request did not pass the browser-trust fence');
                    return;
                }
                const method = (req.method ?? 'GET').toUpperCase();
                const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname;
                if (!pathname.startsWith(`${SETTINGS_API_PREFIX}/`)) {
                    fail(res, 404, 'not_found', 'unknown endpoint');
                    return;
                }
                const endpoint = pathname.slice(SETTINGS_API_PREFIX.length + 1);
                // GET 端点：`status`（设置页轮询）与 `tabs`（`@` 菜单每敲一个键调一次）。
                // 两者都只读，因此不过 content-type 检查——GET 本来就没有请求体。
                if (method === 'GET' && (endpoint === 'status' || endpoint === 'tabs')) {
                    await dispatch(endpoint, req, res);
                    return;
                }
                // `tabs` 是只读列举，只认 GET：POST 它只会是一次没有请求体的空调用，
                // 与其静默成功不如直说该用 GET。
                if (endpoint === 'tabs') {
                    fail(res, 405, 'method_not_allowed', 'use GET for this endpoint');
                    return;
                }
                if (method !== 'POST') {
                    fail(res, 405, 'method_not_allowed', 'use POST for this endpoint');
                    return;
                }
                // `tabs/activate` 的端点名里带一个斜杠：`endpoint` 是**剩余全路径**，不是
                // 单段，所以它天然只有一个 POST 入口，不需要再拆一层。
                const mediaType = (headerOf(req, 'content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase();
                if (mediaType !== 'application/json') {
                    fail(res, 415, 'unsupported_media_type', 'content-type must be application/json');
                    return;
                }
                await dispatch(endpoint, req, res);
            }
            catch (error) {
                if (error instanceof RouteError) {
                    fail(res, error.status, error.code, error.message);
                    return;
                }
                fail(res, 500, 'internal_error', error instanceof Error ? error.message : String(error));
            }
        },
        // 路由摘掉时把缓存还在途的取数结束掉（见 `ReferenceTabsCache.dispose` 的理由）。
        ...(tabsCache === undefined ? {} : { dispose: () => tabsCache.dispose() }),
    };
}
