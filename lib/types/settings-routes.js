/** Absolute prefix the route owns on the Web server. */
export const SETTINGS_API_PREFIX = '/browser-control/api';
/** Largest request body this endpoint buffers; the payloads are tiny. */
const MAX_BODY_BYTES = 256 * 1024;
/**
 * 分组名上限。插件侧（`src/index.ts`）往信封里盖章时切一次，扩展建组时再切一次，
 * 这里是设置页那一层——三处必须同一个数，所以它从这里导出，index.ts 直接引用它。
 */
export const TAB_GROUP_TITLE_MAX = 40;
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
    const dispatch = async (endpoint, req, res) => {
        if (endpoint === 'status') {
            writeJson(res, 200, { ok: true, value: statusPayload(deps) });
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
                if (method === 'GET' && endpoint === 'status') {
                    await dispatch(endpoint, req, res);
                    return;
                }
                if (method !== 'POST') {
                    fail(res, 405, 'method_not_allowed', 'use POST for this endpoint');
                    return;
                }
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
    };
}
