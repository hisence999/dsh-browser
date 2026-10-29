/**
 * DSH Browser — MV3 service worker.
 *
 * Maintains one outbound WebSocket to the local bridge (bridge/server.mjs),
 * receives JSON commands, executes them through chrome.tabs and the Chrome
 * DevTools Protocol (chrome.debugger), and replies with JSON results.
 *
 * Wire protocol (text frames, one JSON object each):
 *   ext -> bridge: {type:'hello', client, version, browser}
 *                  {type:'pong', t}                     (reply to {type:'ping'})
 *                  {type:'result', id, ok, result|error}
 *   bridge -> ext: {type:'ping', t}
 *                  {type:'command', id, command, params}
 */
'use strict';

const EXT_VERSION = chrome.runtime.getManifest().version;
/**
 * Wire protocol revision, independent of the app version: bumped only when the
 * frame contract changes (a command renamed, a payload reshaped). The bridge
 * compares it on `hello` so a version mismatch shows up as a line in the status
 * page instead of as "some commands mysteriously fail".
 */
const PROTOCOL_VERSION = 1;
const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;
const DEFAULT_PORT = 9777;
const DEFAULT_TOKEN = 'dsh-local';

/** Stored config shape (version 2): {port, token, autoConnect}. */
const DEFAULT_CONFIG = Object.freeze({
	port: DEFAULT_PORT,
	token: DEFAULT_TOKEN,
	autoConnect: true,
});

let cfg = { ...DEFAULT_CONFIG };
let ws = null;
let wsState = 'idle'; // idle | connecting | open
let backoffAttempt = 0;
let reconnectTimer = null;
let heartbeatTimer = null;
let helloInfo = null;
let lastError = null;
/** True after the user clicks 断开连接 in the popup; blocks auto-reconnect
 *  until they click 立即连接 again. Reset on browser restart. */
let manualDisconnect = false;

/** Tab ids we hold a persistent debugger attachment on. Detach only on
 *  explicit disconnect, tab close, or DevTools stealing the tab. */
const attachedTabs = new Set();

/** Per-tab ring buffer of CDP `Runtime.consoleAPICalled` entries since attach.
 *  Map<tabId, Array<entry>>. Entries are capped at 500 per tab; older entries
 *  shift off. A new attach bumps the tab's generation so stale entries queued
 *  before re-attach are not surfaced as if they were current. */
const consoleLog = new Map();
/** Bumped on every re-attach so entries recorded against an old generation are
 *  dropped. Map<tabId, number>. */
const tabBufferGenerations = new Map();
/** Per-tab in-flight network entries keyed by `Network.requestId`; merged
 *  across `requestWillBeSent` / `responseReceived` / `loadingFinished` /
 *  `loadingFailed`. Map<tabId, Map<requestId, entry>>. */
const networkLog = new Map();

/**
 * 每个标签页「页面应该长什么样」的仿真意图（目前只存触摸那一位）。
 *
 * 为什么需要它：Chromium 会在两个地方**悄悄**把仿真撤掉，而我们的工具还在报"已启用"——
 *   1) CDP 会话断开/重连（`EmulationHandler::Disable()` → 整体复位），而本扩展断线、
 *      service worker 回收、DevTools 抢会话时都会重新附着；
 *   2) **整页截图**（`captureBeyondViewport:true`）会重置触摸仿真——Playwright 为此
 *      在每次全文截图后补发一次 `setTouchEmulationEnabled`（Chromium issue 558509412）。
 * 所以：附着成功时重放、整页截图之后重放。Map<tabId, { hasTouch, maxTouchPoints }>。
 */
const emulationState = new Map();

/**
 * Native dialog (alert/confirm/prompt) auto-answer policy. 'accept' answers
 * every dialog as OK (prompt uses defaultText), 'dismiss' cancels, 'manual'
 * leaves dialogs open. The `dialog` command sends `params.dialogPolicy` to
 * change it (the choice persists for the session — it is not per-call), and
 * the default is accept so automation never deadlocks.
 *
 * 线协议上取值的键是 `dialogPolicy`，不是 `policy`：插件的 `execute()` 会给
 * 每条命令盖一个顶层 `policy` 信封（对象），同名键会被它覆盖。
 */
let dialogPolicy = 'accept';
/** Dialogs answered since attach, surfaced in results for verification. */
const dialogLog = [];

/* ------------------------------------------------------------------ config */

async function loadConfig() {
	const stored = await chrome.storage.local.get(Object.keys(DEFAULT_CONFIG));
	// v1→v2 migration: convert old serverUrl to port.
	if (stored.serverUrl && stored.port === undefined) {
		try {
			stored.port = new URL(stored.serverUrl).port ? Number(new URL(stored.serverUrl).port) : DEFAULT_PORT;
		} catch { stored.port = DEFAULT_PORT; }
		delete stored.serverUrl;
	}
	cfg = { ...DEFAULT_CONFIG, ...stored };
}

chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return;
	for (const [key, change] of Object.entries(changes)) {
		if (key in DEFAULT_CONFIG) cfg[key] = change.newValue;
	}
});

/* ------------------------------------------------------------ ws lifecycle */

function setBadge(text, color) {
	try {
		chrome.action.setBadgeBackgroundColor({ color });
		chrome.action.setBadgeText({ text });
	} catch (err) {
		console.warn('[dsh-bridge] badge unavailable:', err.message);
	}
}

function setState(state) {
	wsState = state;
	// While the local lock is on it owns the badge: "connected but frozen" must
	// not look like a healthy green ON.
	if (hardLocked) { setBadge('LOCK', '#dc2626'); return; }
	if (state === 'open') setBadge('ON', '#16a34a');
	else if (state === 'connecting') setBadge('…', '#d97706');
	else setBadge('OFF', '#6b7280');
}

function send(obj) {
	if (!ws || ws.readyState !== WebSocket.OPEN) return false;
	ws.send(JSON.stringify(obj));
	return true;
}

function scheduleReconnect() {
	if (manualDisconnect || !cfg.autoConnect) return;
	const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** backoffAttempt);
	backoffAttempt += 1;
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(connect, delay);
}

function connect() {
	if (wsState === 'open' || wsState === 'connecting') return;
	clearTimeout(reconnectTimer);
	if (manualDisconnect || !cfg.autoConnect) return;

	let url;
	try {
		url = new URL(`ws://127.0.0.1:${cfg.port}/ws`);
	} catch (err) {
		lastError = `端口无法解析: ${err.message}`;
		setState('idle');
		return;
	}
	url.searchParams.set('token', cfg.token);

	setState('connecting');
	let sock;
	try {
		sock = new WebSocket(url.toString());
	} catch (err) {
		lastError = err.message;
		setState('idle');
		scheduleReconnect();
		return;
	}
	ws = sock;

	sock.onopen = () => {
		if (sock !== ws) return;
		backoffAttempt = 0;
		lastError = null;
		setState('open');
		startHeartbeat();
		// 现在是 async：先读无痕权限再发 hello（约 1ms，但绝不能在没读到的情况下
		// 先发一个「incognitoAllowed:false」——那会让桥以为这台机器不支持隔离实例）。
		void sendHello();
	};
	sock.onmessage = (ev) => {
		if (sock !== ws || typeof ev.data !== 'string') return;
		let msg;
		try { msg = JSON.parse(ev.data); } catch { return; }
		handleBridgeMessage(msg);
	};
	sock.onclose = () => {
		if (sock !== ws) return;
		stopHeartbeat();
		ws = null;
		setState('idle');
		// 桥没了 = 没人在操作了：页面上那圈「AI 正在操作」必须立刻收掉，不能挂着骗人。
		void clearHighlight().catch(() => {});
		scheduleReconnect();
	};
	sock.onerror = () => { /* onclose always follows */ };
}

function disconnectNow() {
	clearTimeout(reconnectTimer);
	stopHeartbeat();
	if (ws) {
		const sock = ws;
		ws = null;
		sock.onclose = null;
		try { sock.close(); } catch { /* ignore */ }
	}
	detachAll();
	// 离开之前把「AI 正在操作」那一圈收掉：链接都断了还留着它，是对用户撒谎。
	void clearHighlight().catch(() => {});
	setState('idle');
}

function startHeartbeat() {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => send({ type: 'ping', t: Date.now() }), HEARTBEAT_MS);
}

function stopHeartbeat() {
	if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

async function sendHello() {
	const ua = navigator.userAgent;
	const name = /Edg\//.test(ua) ? 'edge' : /Chrome\//.test(ua) ? 'chrome' : 'chromium';
	const versionMatch = ua.match(/(?:Edg|Chrome)\/([\d.]+)/);
	helloInfo = { name, version: versionMatch ? versionMatch[1] : 'unknown', ua };
	// 无痕访问是「隔离实例」唯一的硬前提：握手时就把它的真实值报上去，桥/设置页一眼能看见
	// 「这台机器能不能开无痕罐」，而不是等模型点了 launch 才失败。
	const allowed = await syncIncognitoAllowed().catch(() => false);
	send({ type: 'hello', client: 'dsh-browser-extension', version: EXT_VERSION, protocol: PROTOCOL_VERSION, browser: helloInfo, incognitoAllowed: allowed });
}

/* Alarm keeps the SW alive for reconnect even without user events. */
try { chrome.alarms.create('keepalive', { periodInMinutes: 0.5 }); }
catch { chrome.alarms.create('keepalive', { periodInMinutes: 1 }); }
chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name !== 'keepalive') return;
	if (wsState === 'idle') connect();
	else send({ type: 'ping', t: Date.now() });
});

/* ------------------------------------------------------------- local lock */

/**
 * Local hard lock ("panic switch"): while on, every command from the bridge is
 * refused before it reaches a handler, and the WebSocket stays connected — so a
 * caller sees "reachable but frozen" instead of a dead link it might retry.
 *
 * Only the popup can toggle it, and that is structural rather than a promise:
 * the bridge speaks over the WebSocket, while this gate is set through a
 * `chrome.runtime` message, which only an extension page can post (the manifest
 * declares no `externally_connectable`). Nothing on the bridge side unlocks it.
 *
 * The flag is persisted in chrome.storage.local because MV3 evicts the service
 * worker after ~30s idle: an in-memory flag would silently lapse between two
 * commands, which is the one failure mode a panic switch cannot have.
 */
const HARD_LOCK_KEY = 'hardLock';
/** 拒绝文案的两种来源：真的是用户锁的，还是锁状态读不出来、按冻结处理。 */
const HARD_LOCK_REASON_MARKER = 'browser-locked-by-user:';
const HARD_LOCK_UNREADABLE_MARKER = 'browser-lock-unreadable:';
let hardLocked = false;
let hardLockLoaded = false;
let hardLockReason = 'user';

/** Read the persisted flag once per worker lifetime. */
async function syncHardLock() {
	if (hardLockLoaded) return;
	try {
		const stored = await chrome.storage.local.get([HARD_LOCK_KEY]);
		hardLocked = stored[HARD_LOCK_KEY] === true;
		hardLockReason = 'user';
		hardLockLoaded = true;
	} catch (err) {
		// 读不到锁的状态时按「锁着」处理。panic switch 唯一的失败方式就是「以为锁着
		// 其实没锁」，而 fail-open 恰好是那种失败；这里宁可让模型多做一次询问。
		// 不置 hardLockLoaded：下一条命令再读一次，存储恢复后自愈。
		// 用户仍然能解：弹窗那条通道走的是内存里的 setHardLock，不依赖这次读。
		hardLocked = true;
		hardLockReason = 'unreadable';
		lastError = `读取本地锁失败，已按「锁定」处理：${err.message}`;
	}
	// A worker that came back after eviction has not painted the badge yet; do it
	// now so "locked" is visible before the first command rather than after it.
	if (hardLocked) setState(wsState);
}

/** Persist and apply the lock; called only from the popup message handler. */
async function setHardLock(locked) {
	hardLocked = Boolean(locked);
	hardLockLoaded = true;
	hardLockReason = 'user';
	await chrome.storage.local.set({ [HARD_LOCK_KEY]: hardLocked });
	setState(wsState);
	return hardLocked;
}

/**
 * Refusal text the agent actually reads; it must say who can undo this.
 *
 * 前缀是给插件侧 `classify()` 认的线协议（`src/errors.ts` 里有一份同样的字面量，
 * `verify/verify_errors.mjs` 对账两边），所以文案怎么改都不能动前缀。
 */
function hardLockRefusal(command) {
	if (hardLockReason === 'unreadable') {
		return `${HARD_LOCK_UNREADABLE_MARKER} 扩展读不出本地锁的状态（chrome.storage.local 失败），已按「冻结」处理：命令 ${command} 被拦下，没有向浏览器发出任何操作。`
			+ `这不是用户按了锁定，请如实告诉用户原因；下一次调用会重新读一次锁状态，存储恢复后自动放行，所以现在重试是安全的，但不要循环重试。`;
	}
	return `${HARD_LOCK_REASON_MARKER} 本机扩展已被用户锁定：命令 ${command} 被拦下，没有向浏览器发出任何操作。`
		+ `解锁只能由用户在浏览器工具栏的扩展弹窗里点「已锁定」完成；在那之前请先与用户确认，不要重试。`;
}

/* --------------------------------------------------- 接管浮层（hold，软层） */

/**
 * 软层：在某个标签页上加一层可撤销的浮层，告诉用户「模型正在这一页操作」，并挡住误触。
 *
 * 定位（维护者在 #17 里明确过）：它是**告知 + 防误触**，不是安全边界 —— 桥的 token 模型
 * 读得到也改得动，所以任何长在插件侧/扩展侧的开关都只是策略。真正的硬停是弹窗里的本地锁。
 * 因此这里只做三件事：告诉用户、挡住误触、把「用户按了中止」如实回报给模型（模型可以
 * 通过 `hold action=off` 解除，这一步等于确认继续）。
 *
 * 状态放 **`chrome.storage.session`、按 tabId 记**：活过 service worker 回收（内存标志
 * 30 秒就丢，那正是浮层会「以为挡着、其实没挡」的失败方式），不落盘，浏览器关掉即清。
 * 页面里另留一份只读的 `window.__dshHold` 供读取「谁撤的、什么时候撤的」，它不参与决策。
 *
 * 覆盖不到的场合（严格 CSP、全屏、跨源 iframe、PDF 阅读器、错误页）是事实，所以
 * `covered: false` + `reason` 会被**如实报回去**，而不是只在文档里认怂。
 */
const HOLD_HOST_ID = '__dsh_hold_overlay__'
/** 浮层宿主的稳定标记：读取路径靠它把整棵子树排除掉（见 content / find / snapshot）。
 *  与 AI 高亮框**共用**：两者都是「我们自己的层」，读取路径只需要认识一个标记。 */
const HOLD_MARKER_ATTR = 'data-dsh-hold'
/** storage.session 里的键：{ [tabId]: { at, note, aborted, covered, reason } }。 */
const HOLD_STATE_KEY = 'holdByTab'
/** 标题由扩展写死；调用方只能提供正文（否则模型能写一句系统口吻的话冒充提示）。 */
const HOLD_FIXED_TITLE = 'DSH Browser'
/** 正文上限：模型给的话头再长也不会把卡片撑爆；换行压平成空格。 */
const HOLD_NOTE_MAX = 400
/** 中止态下直接拒绝的扩展命令（与 #17 里列的那四条一致）。 */
const HOLD_BLOCKED_COMMANDS = new Set(['click', 'input', 'press', 'nav'])
/** 拒绝文案前缀：与 src/errors.ts 里的同名常量对账（verify_errors 会检查两边一致）。 */
const HOLD_ABORTED_MARKER = 'browser-hold-aborted:'

/** 内存副本；`null` = 还没读。 */
let holdByTab = null
let holdStateLoaded = false

/** Lazily read the per-tab overlay state (once per worker lifetime). */
async function syncHoldState() {
	if (holdStateLoaded && holdByTab !== null) return holdByTab
	try {
		const stored = await chrome.storage.session.get([HOLD_STATE_KEY])
		const raw = stored && stored[HOLD_STATE_KEY]
		holdByTab = raw && typeof raw === 'object' ? raw : {}
	} catch (err) {
		// 读不到按「没有浮层」处理：它是软层，不拿它当边界；状态面会把这件事说出来。
		holdByTab = {}
		lastError = `读取浮层状态失败（按无浮层处理）：${err.message}`
	}
	holdStateLoaded = true
	return holdByTab
}

/** Persist one tab's entry (or delete it when `entry === null`). */
async function persistHoldEntry(tabId, entry) {
	await syncHoldState()
	if (entry === null) delete holdByTab[tabId]
	else holdByTab[tabId] = entry
	try {
		await chrome.storage.session.set({ [HOLD_STATE_KEY]: holdByTab })
	} catch (err) {
		lastError = `写入浮层状态失败：${err.message}`
	}
	return entry
}

/** 正文归一：压平换行、限长（给用户看的，也是模型传进来的那一句）。 */
function holdNoteOf(params) {
	const raw = typeof params?.note === 'string' ? params.note : ''
	const flat = raw.replace(/\s+/g, ' ').trim()
	return flat.length > HOLD_NOTE_MAX ? `${flat.slice(0, HOLD_NOTE_MAX)}…` : flat
}

/**
 * 页面侧：装浮层。**自包含**（会被 toString() 后送到页面里执行），不引用扩展作用域的
 * 任何东西 —— 标题与正文都从 payload 进来，正文只走 textContent。
 */
function pageHoldInject(payload) {
	const ID = '__dsh_hold_overlay__'
	const MARK = 'data-dsh-hold'
	try {
		const prev = document.getElementById(ID)
		if (prev && prev.parentNode) prev.parentNode.removeChild(prev)
		const host = document.createElement('div')
		host.id = ID
		host.setAttribute(MARK, '1')
		const root = host.attachShadow({ mode: 'open' })
		root.innerHTML = [
			'<style>',
			':host { all: initial; }',
			'.wrap { position: fixed; inset: 0; z-index: 2147483647; background: rgba(15,17,21,.42);',
			'  display: flex; align-items: center; justify-content: center;',
			'  font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }',
			'.card { min-width: 280px; max-width: 460px; padding: 16px 18px; border-radius: 14px;',
			'  background: rgba(32,34,40,.94); color: #f2f3f5; box-shadow: 0 12px 40px rgba(0,0,0,.35); }',
			'.title { font-size: 12px; font-weight: 600; letter-spacing: .02em; opacity: .8; }',
			'.note { margin-top: 8px; white-space: pre-wrap; word-break: break-word; }',
			'.hint { margin-top: 10px; font-size: 12px; opacity: .62; }',
			'.row { margin-top: 12px; }',
			'button { font: inherit; padding: 5px 12px; border-radius: 999px; cursor: pointer;',
			'  border: 1px solid rgba(255,255,255,.22); background: rgba(255,255,255,.08); color: inherit; }',
			'button:disabled { opacity: .6; cursor: default; }',
			'button:focus-visible { outline: 2px solid #7aa7ff; outline-offset: 2px; }',
			'</style>',
			'<div class="wrap">',
			'  <div class="card" role="dialog" aria-modal="true">',
			'    <div class="title"></div>',
			'    <div class="note"></div>',
			'    <div class="hint">双击这一页任意处即可关掉（键盘：连按两下 Esc，或按住 Esc）。关掉之后模型可以继续操作这一页。</div>',
			'    <div class="row"><button type="button" class="abort">中止模型操作</button></div>',
			'  </div>',
			'</div>',
		].join('')
		root.querySelector('.title').textContent = String(payload && payload.title ? payload.title : '')
		root.querySelector('.note').textContent = String(payload && payload.note ? payload.note : '')
		const wrap = root.querySelector('.wrap')
		const abortBtn = root.querySelector('.abort')
		const state = { at: Date.now(), note: String(payload && payload.note ? payload.note : ''), aborted: false, dismissedBy: null, closedAt: null }
		window.__dshHold = state
		const kill = (by) => {
			state.dismissedBy = by
			state.closedAt = Date.now()
			window.__dshHold = state
			if (host.parentNode) host.parentNode.removeChild(host)
		}
		// 双击任意处接管（500ms 内两下；点按钮不算）
		let lastClick = 0
		wrap.addEventListener('click', (e) => {
			if (e.target === abortBtn || (abortBtn.contains && abortBtn.contains(e.target))) return
			const now = Date.now()
			if (now - lastClick <= 500) { lastClick = 0; kill('user'); return }
			lastClick = now
		}, true)
		// Esc：800ms 内连按两下，或按住 600ms（单次 Esc 在网页里太常见，不能当接管）
		let escLastUp = 0
		let escLongPress = 0
		let escDown = false
		wrap.addEventListener('keydown', (e) => {
			if (e.key !== 'Escape') return
			e.preventDefault()
			if (escDown) return
			escDown = true
			escLongPress = setTimeout(() => { escLongPress = 0; escDown = false; kill('user') }, 600)
		}, true)
		wrap.addEventListener('keyup', (e) => {
			if (e.key !== 'Escape') return
			e.preventDefault()
			escDown = false
			if (escLongPress) { clearTimeout(escLongPress); escLongPress = 0 }
			const now = Date.now()
			if (now - escLastUp <= 800) { escLastUp = 0; kill('user'); return }
			escLastUp = now
		}, true)
		// 中止：两段确认（点一次变「再点一次确认」，3 秒不点还原）
		let armedAt = 0
		abortBtn.addEventListener('click', () => {
			const now = Date.now()
			if (armedAt !== 0 && now - armedAt <= 3000) {
				state.aborted = true
				window.__dshHold = state
				abortBtn.textContent = '已中止（模型操作已被拦）'
				abortBtn.disabled = true
				return
			}
			armedAt = now
			abortBtn.textContent = '再点一次确认中止'
			setTimeout(() => {
				if (armedAt !== 0 && Date.now() - armedAt >= 3000) {
					armedAt = 0
					abortBtn.textContent = '中止模型操作'
				}
			}, 3200)
		})
		// 先挂进文档，再抢焦点：不在文档里的按钮 focus() 是空操作（真机踩过）。
		document.documentElement.appendChild(host)
		const connected = host.isConnected !== false
		try { abortBtn.focus({ preventScroll: true }) } catch (err) { /* 页面不允许聚焦就算了 */ }
		return { covered: connected }
	} catch (err) {
		return { covered: false, reason: `inject-failed: ${String((err && err.message) || err)}` }
	}
}

/** 页面侧：撤掉浮层（模型 `hold action=off` 用；用户双击/按 Esc 由页面自己撤）。 */
function pageHoldRemove(by) {
	const host = document.getElementById('__dsh_hold_overlay__')
	if (host && host.parentNode) host.parentNode.removeChild(host)
	const prev = window.__dshHold || null
	const state = {
		at: prev ? prev.at : Date.now(), note: prev ? prev.note : '',
		aborted: false, dismissedBy: by || 'agent', closedAt: Date.now(),
	}
	window.__dshHold = state
	return { active: false, dismissedBy: state.dismissedBy }
}

/** 页面侧：读浮层现状（DOM 是否存在为准，别信内存）。 */
function pageHoldStatus() {
	const host = document.getElementById('__dsh_hold_overlay__')
	const st = window.__dshHold || null
	return {
		active: !!host,
		aborted: !!(st && st.aborted),
		dismissedBy: st ? st.dismissedBy : null,
		at: st ? st.at : null,
		closedAt: st ? st.closedAt : null,
		note: st ? st.note : '',
	}
}

/**
 * 页面侧判定：这个元素是不是我们自己那层浮层里的东西（含宿主本身）。
 *
 * 单独抽成函数、并在读取路径里以 `(${pageIsHoldNode.toString()})(el)` 的形式注入，
 * 是为了让它能被台子**直接执行**（`verify_hold` 拿假元素两向各跑一次），而不是只能
 * 断言"表达式里出现了某个字符串"。
 */
function pageIsHoldNode(el) {
	try {
		return !!(el && el.closest && el.closest('[data-dsh-hold]'))
	} catch (err) {
		return false
	}
}

/**
 * 页面侧：把浮层那棵子树摘掉之后的 `outerHTML`。
 * 宿主挂在 `<html>` 下，直接 `documentElement.outerHTML` 会把模型自己的提示带进
 * 「页面内容」里（模型随后可能把那句话当成页面文字去点）。克隆一份再摘，不动真页面。
 *
 * 现在页面上可能同时挂着**两个**我们自己的宿主（接管浮层 + AI 高亮框），所以要把所有
 * 带标记的子树都摘掉；只摘第一个，模型就会在 `browser_read` 里读到高亮框的小标签。
 */
function pageHtmlWithoutHold() {
	try {
		const clone = document.documentElement.cloneNode(true)
		const mine = clone.querySelectorAll('[data-dsh-hold]')
		for (const node of mine) if (node.remove) node.remove()
		return clone.outerHTML
	} catch (err) {
		return document.documentElement.outerHTML
	}
}

/* ------------------------------------------------- AI 正在操作的那一页：蓝色渐变框 */

/**
 * 「AI 正在操作的标签页」的视觉指示：一圈蓝色渐变描边 + 右上角一个小徽标。
 *
 * 定位与接管浮层**不同**：浮层是模态提示 + 防误触（挡点击、有中止按钮），而这一层是
 * `pointer-events: none` 的纯装饰——它一个像素都不拦，也不构成任何安全边界。它存在的
 * 唯一理由是回答用户那个最自然的问题：「这台机器现在在动我哪一页？」
 *
 * 三个设计取舍：
 *   - **Shadow DOM + 与浮层共用的 `data-dsh-hold` 标记**：读取路径（content/find/
 *     snapshot）靠这个标记把我们的层当页面内容摘掉，共用标记就不用改三处过滤条件。
 *   - **样式全内联在本函数里**（会被 toString 送进页面执行）：不依赖任何注入的 <style>，
 *     导航、页面自己重写 DOM 都不会把它弄丢样式。
 *   - **截图与打印前隐藏**（见 `withHighlightHidden`）：否则每一张交给模型的图都镶一圈
 *     蓝边，PDF 还会在每一页重复。
 *
 * 宿主的 id 是 `__dsh_agent_highlight__`（写死在那几个页面侧函数里——它们要被 toString
 * 送进页面执行，读不到这里的模块常量）。
 */
/** `agent` = 我在操作；`yielded` = 用户接管了，我让出。 */
const HIGHLIGHT_TONE_AGENT = 'agent'
const HIGHLIGHT_TONE_YIELDED = 'yielded'
/** 徽标文案写死在扩展里：模型不能往用户界面上写自己的话。 */
const HIGHLIGHT_LABELS = Object.freeze({
	[HIGHLIGHT_TONE_AGENT]: 'AI 正在操作',
	[HIGHLIGHT_TONE_YIELDED]: '已让出 · 你可以操作',
})
/** 认领标签页时等画框的上限：超了就这次不画（视觉层不许拖慢命令）。 */
const HIGHLIGHT_BUDGET_MS = 2000
/**
 * 正在进行的「收框」动作计数。
 *
 * 桥断开时 `clearHighlight()` 会跑；而同一条路径上「页面加载完成 → 补画」可能正排着队。
 * 如果补画在收框**之后**落地，页面上会留下一圈永远擦不掉的框（桥没了，没人会再来收）。
 * 判据不能用「桥连着吗」——假浏览器里根本没有 socket；这里用一个显式的在飞状态：
 * 收框期间一律不画。
 */
let highlightClearsInFlight = 0

/** 页面侧：画上（或重画）高亮框。自包含，返回值会回给扩展。 */
function pageHighlightInject(payload) {
	const ID = '__dsh_agent_highlight__'
	const MARK = 'data-dsh-hold'
	try {
		const prev = document.getElementById(ID)
		if (prev && prev.parentNode) prev.parentNode.removeChild(prev)
		const tone = String(payload && payload.tone) === 'yielded' ? 'yielded' : 'agent'
		const label = String((payload && payload.label) || '')
		const host = document.createElement('div')
		host.id = ID
		host.setAttribute(MARK, 'highlight')
		host.setAttribute('aria-hidden', 'true')
		const root = host.attachShadow({ mode: 'open' })
		const ring = tone === 'yielded'
			? 'linear-gradient(120deg,#fbbf24 0%,#f59e0b 28%,#f97316 55%,#fbbf24 82%,#f59e0b 100%)'
			: 'linear-gradient(120deg,#22d3ee 0%,#3b82f6 30%,#6366f1 56%,#8b5cf6 80%,#22d3ee 100%)'
		const glow = tone === 'yielded' ? 'rgba(245,158,11,.40)' : 'rgba(59,130,246,.42)'
		const badge = tone === 'yielded'
			? 'linear-gradient(120deg,rgba(180,83,9,.94),rgba(217,119,6,.94))'
			: 'linear-gradient(120deg,rgba(37,99,235,.94),rgba(99,102,241,.94))'
		root.innerHTML = [
			'<style>',
			':host { all: initial; }',
			'.ring, .glow { position: fixed; inset: 0; pointer-events: none; }',
			'.ring { z-index: 2147483646; padding: 3px; border-radius: 14px;',
			'  background: ' + ring + '; background-size: 300% 300%;',
			'  animation: dsh-ring-move 9s linear infinite;',
			'  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);',
			'  -webkit-mask-composite: xor;',
			'  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);',
			'  mask-composite: exclude; }',
			'.glow { z-index: 2147483645; box-shadow: inset 0 0 24px ' + glow + ', inset 0 0 64px ' + glow + ';',
			'  animation: dsh-ring-breathe 3.6s ease-in-out infinite; }',
			'.tag { position: fixed; z-index: 2147483647; top: 10px; right: 12px; pointer-events: none;',
			'  display: flex; align-items: center; gap: 6px; padding: 5px 10px 5px 8px; border-radius: 999px;',
			'  color: #f8fafc; background: ' + badge + ';',
			'  font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;',
			'  letter-spacing: .01em; box-shadow: 0 6px 20px rgba(15,23,42,.28), inset 0 0 0 1px rgba(248,250,252,.28); }',
			'.dot { width: 7px; height: 7px; border-radius: 50%; background: #e0f2fe;',
			'  animation: dsh-ring-pulse 1.4s ease-in-out infinite; }',
			'@keyframes dsh-ring-move { 0% { background-position: 0% 50% } 100% { background-position: 300% 50% } }',
			'@keyframes dsh-ring-breathe { 0%,100% { opacity: .5 } 50% { opacity: 1 } }',
			'@keyframes dsh-ring-pulse { 0%,100% { opacity: .45; transform: scale(.82) } 50% { opacity: 1; transform: scale(1.18) } }',
			'@media (prefers-reduced-motion: reduce) { .ring, .glow, .dot { animation: none } }',
			'</style>',
			'<div class="glow"></div>',
			'<div class="ring"></div>',
			'<div class="tag"><span class="dot"></span><span class="text"></span></div>',
		].join('')
		root.querySelector('.text').textContent = label
		document.documentElement.appendChild(host)
		window.__dshHighlight = { at: Date.now(), tone, label }
		return { shown: host.isConnected !== false, tone }
	} catch (err) {
		return { shown: false, reason: 'inject-failed: ' + String((err && err.message) || err) }
	}
}

/** 页面侧：撤掉高亮框。 */
function pageHighlightRemove() {
	try {
		const host = document.getElementById('__dsh_agent_highlight__')
		if (host && host.parentNode) host.parentNode.removeChild(host)
		window.__dshHighlight = null
		return { shown: false }
	} catch (err) {
		return { shown: false, reason: String((err && err.message) || err) }
	}
}

/** 页面侧：高亮框现在在不在（以 DOM 为准，别信内存）。 */
function pageHighlightStatus() {
	try {
		const host = document.getElementById('__dsh_agent_highlight__')
		const st = window.__dshHighlight || null
		return { active: !!host, tone: st ? st.tone : null, label: st ? st.label : null }
	} catch (err) {
		return { active: false, tone: null, label: null }
	}
}

/**
 * 页面侧：截图前把高亮框藏起来。`display: none` 挂在宿主上，整棵影子树都不参与布局，
 * 所以 `captureScreenshot` 拿到的是干净页面；拍完由 `pageHighlightShow` 还原。
 */
function pageHighlightHide() {
	try {
		const host = document.getElementById('__dsh_agent_highlight__')
		if (!host) return { hidden: false }
		host.style.display = 'none'
		return { hidden: true }
	} catch (err) {
		return { hidden: false }
	}
}

/** 页面侧：恢复正常显示（只还原我们自己改的那一位）。 */
function pageHighlightShow() {
	try {
		const host = document.getElementById('__dsh_agent_highlight__')
		if (!host) return { shown: false }
		host.style.display = ''
		return { shown: true }
	} catch (err) {
		return { shown: false }
	}
}

/**
 * 在页面里画/擦高亮框。**永不抛**：它是给人看的状态指示，不该让一条命令失败。
 * @param tab - 目标标签页（需要 `.id` 与 `.url`）。
 * @param tone - `agent` | `yielded`。
 */
async function paintHighlight(tab, tone) {
	const unsupported = holdSupportOf(tab)
	if (unsupported !== null) return { shown: false, reason: unsupported }
	const wanted = tone === HIGHLIGHT_TONE_YIELDED ? HIGHLIGHT_TONE_YIELDED : HIGHLIGHT_TONE_AGENT
	return holdEval(tab, pageHighlightInject, { tone: wanted, label: HIGHLIGHT_LABELS[wanted] })
		.then((res) => (res && typeof res === 'object' ? res : { shown: false }))
		.catch((err) => ({ shown: false, reason: `inject-failed: ${String((err && err.message) || err)}` }))
}

/** 擦掉某个标签页上的高亮框（标签页没了、或那一页根本画不上，就什么都不做）。 */
async function eraseHighlight(tabId) {
	const tab = await chrome.tabs.get(tabId).catch(() => null)
	if (tab === null) return { shown: false, reason: 'gone' }
	// 受限页面（chrome:// / PDF 阅读器 / 错误页）上从来没画上过什么东西，去擦它只会白搭一次
	// `debugger.attach`（而且必然失败）——断桥清理那一步会因此多挂一次 CDP 会话。
	if (holdSupportOf(tab) !== null) return { shown: false, reason: 'unsupported' }
	return holdEval(tab, pageHighlightRemove).catch(() => ({ shown: false }))
}

/**
 * 把高亮框对齐到 `tabId`（`null` = 收掉）。
 *
 * 幂等且可重入：目标没变也允许重画（页面导航会把注入的宿主打掉，`tabs.onUpdated` 就靠
 * 这个重画）；目标换了先擦旧的再画新的。`policy.highlight === 'off'` 时等价于收掉。
 *
 * 两条容易写错的地方：
 *   - 记录**只在框真的画上之后**才写。否则 `chrome://` 页面上会出现「记录说画着、页面上
 *     什么都没有」的幽灵记录，之后每次断桥/截图都要为它白跑一次 CDP 探测。
 *   - 画的过程中桥可能断了（`clearHighlight` 把记录清空）：那这一次结果作废，并且把刚画
 *     上去的擦掉。少了这道复查，页面上会留下一圈**永远擦不掉**的框——桥没了，没人会再来
 *     收它。判据是「进来时本来有框、画完却没有了」：只有别人清过才会这样，而全新认领
 *     （进来时就没有框）不会被误伤。
 * @param tabId - 要画高亮框的标签页；`null` 收掉。
 * @param tone - `agent` | `yielded`。
 */
async function syncHighlight(tabId, tone = HIGHLIGHT_TONE_AGENT) {
	const state = await syncAgentState()
	const prev = state.highlight === null ? null : state.highlight.tabId
	const hadFrame = state.highlight !== null
	const configured = state.policy === null ? DEFAULT_POLICY.highlight : state.policy.highlight
	const wanted = tabId === null || configured === 'off' ? null : Number(tabId)
	const wantedTone = tone === HIGHLIGHT_TONE_YIELDED ? HIGHLIGHT_TONE_YIELDED : HIGHLIGHT_TONE_AGENT
	if (prev !== null && prev !== wanted) await eraseHighlight(prev)
	// 有人正在收框（断桥 / 本地锁）：这次不画。落地顺序在这里是随机的，而画上去之后
	// 那圈框就没有人负责擦了。
	if (wanted !== null && highlightClearsInFlight > 0) return { shown: false, reason: 'clearing' }
	let painted = { shown: false }
	if (wanted !== null) {
		const tab = await chrome.tabs.get(wanted).catch(() => null)
		if (tab !== null) painted = await paintHighlight(tab, wantedTone)
	}
	if (hadFrame && state.highlight === null) {
		// 画到一半被别人清了（断桥 / 本地锁）：这次作废，把刚画上去的也擦掉。
		if (painted.shown === true && wanted !== null) await eraseHighlight(wanted)
		return { shown: false, reason: 'cleared-while-painting' }
	}
	state.highlight = painted.shown === true ? { tabId: wanted, tone: wantedTone, at: Date.now() } : null
	await persistAgentState()
	return painted
}

/**
 * 让出 / 收回时改一改徽标颜色——但只改**当前画着的那一页**。
 *
 * 为什么不一概 `syncHighlight(tabId)`：用户接管的是 A，而 AI 的目标可能是 B；那一次
 * 重画会把「AI 正在操作」的框从 B 挪到 A，等于谎报 AI 的位置。
 */
async function retoneHighlight(tabId) {
	const state = await syncAgentState()
	if (state.highlight === null || state.highlight.tabId !== Number(tabId)) return { shown: false }
	const tone = state.yields[Number(tabId)] !== undefined ? HIGHLIGHT_TONE_YIELDED : HIGHLIGHT_TONE_AGENT
	return syncHighlight(Number(tabId), tone)
}

/**
 * 桥断了 / 本地锁上了：把高亮框收掉。
 *
 * 这一条回答的是「AI 走了，我的页面上还挂着一个『正在操作』」那种谎言。断开之后就没人
 * 在操作了，框必须跟着消失（下次连上时由下一条命令重新画）。
 */
async function clearHighlight() {
	highlightClearsInFlight += 1
	try {
		const state = await syncAgentState()
		if (state.highlight === null) return { shown: false }
		const tabId = state.highlight.tabId
		state.highlight = null
		await persistAgentState()
		await eraseHighlight(tabId)
		// 桥已经断了的时候，erase 会顺手把 CDP 重新接上：那会在标签页顶部留下「正在被调试」
		// 的横幅、并且多一个没人要的附件。断开这条路上擦完就把它摘掉。
		if (ws === null) detachTab(tabId)
		return { shown: false, tabId }
	} finally {
		highlightClearsInFlight -= 1
	}
}

/**
 * 已经在画着的标签页加载完成后补画一次（导航会打掉注入的宿主）。
 *
 * 策略读的是 `state.policy`（最后一条命令留下的快照），不是模块级 `currentPolicy`：
 * 这条路径跑在命令之外，而 worker 回收/浏览器重启之后 `currentPolicy` 只是缺省值——
 * 用户关掉高亮之后，一次页面跳转就能把框按旧值重新画回来。
 */
async function repaintHighlightFor(tabId) {
	const state = await syncAgentState()
	if (state.highlight === null || state.highlight.tabId !== Number(tabId)) return { shown: false }
	if ((state.policy === null ? DEFAULT_POLICY.highlight : state.policy.highlight) === 'off') {
		// 关掉了就顺手收干净（记录 + 页面上的那层），下一轮不再为它做任何事。
		return syncHighlight(null)
	}
	const tone = state.yields[Number(tabId)] !== undefined ? HIGHLIGHT_TONE_YIELDED : HIGHLIGHT_TONE_AGENT
	return syncHighlight(Number(tabId), tone)
}

/** 在页面里跑一段自包含函数，返回它的返回值。 */
async function holdEval(tab, fn, arg) {
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(`page exception: ${res.exceptionDetails.text}`)
		return res.result ? res.result.value : undefined
	}))
}

/** 哪些页面盖不住：扩展自己都读不到页面时，先说清楚，不要假装盖住了。 */
function holdSupportOf(tab) {
	const url = String(tab.url || '')
	if (url.startsWith('chrome-error:') || url.startsWith('edge-error:')) return 'error-page'
	if (url.startsWith('chrome:') || url.startsWith('edge:')) return 'browser-page'
	if (url.startsWith('devtools:')) return 'devtools'
	return null
}

/**
 * `hold on|off|status`：接管浮层的唯一入口（一条命令，参数区分动作）。
 *
 * `on` 会往页面里插一个宿主元素 ⇒ 它**改页面 DOM**，所以在只读档里必须被拒
 * （`src/policy.ts` 里显式登记，理由写在那个集合旁边）。
 */
async function cmdHold(params) {
	const action = String(params?.action ?? 'status')
	if (!['on', 'off', 'status'].includes(action)) throw new Error(`invalid hold action: ${action} (use on|off|status)`)
	const tab = await resolveTab(params?.tabId, policyOf(params).jar)
	const stored = (await syncHoldState())[tab.id] || null
	if (action === 'status') {
		const page = await holdEval(tab, pageHoldStatus).catch(() => null)
		return {
			tabId: tab.id,
			action,
			active: page ? page.active === true : false,
			covered: page !== null,
			...(page === null ? { reason: 'probe-failed' } : {}),
			aborted: page ? page.aborted === true : !!(stored && stored.aborted),
			dismissedBy: page ? page.dismissedBy : null,
			stored: stored ? { at: stored.at ?? null, aborted: stored.aborted === true, covered: stored.covered === true } : null,
			recentDialogs: dialogLog.slice(-1),
			support: holdSupportOf(tab),
		}
	}
	if (action === 'off') {
		await holdEval(tab, pageHoldRemove, 'agent').catch(() => {})
		await persistHoldEntry(tab.id, null)
		return { tabId: tab.id, action, active: false, covered: true }
	}
	const unsupported = holdSupportOf(tab)
	if (unsupported !== null) {
		const reason = unsupported
		await persistHoldEntry(tab.id, { at: Date.now(), note: holdNoteOf(params), aborted: false, covered: false, reason })
		return { tabId: tab.id, action, active: false, covered: false, reason }
	}
	const note = holdNoteOf(params)
	// 中止只有 `off` 能解（= 用户确认继续）。如果 `on` 能静默清掉中止，模型就有一条
	// 不用问用户、也不必说「继续」的旁路：被拦一次 → 再调一次 on → 照常点。
	const live = await holdEval(tab, pageHoldStatus).catch(() => null)
	if (live && live.active === true && live.aborted === true) {
		throw new Error(`${HOLD_ABORTED_MARKER} 用户已在浮层上按下「中止操作」，不能再挂一层去覆盖它：命令 hold 被拦下，没有向页面注入任何东西。`
			+ `请先与用户确认；用户同意继续后调用 browser_hold action=off（这一步等于确认继续），之后才能重新 on。不要重试本命令。`)
	}
	const injected = await holdEval(tab, pageHoldInject, { title: HOLD_FIXED_TITLE, note }).catch((err) => ({
		covered: false, reason: `inject-failed: ${String((err && err.message) || err)}`,
	}))
	const covered = injected ? injected.covered !== false : false
	const reason = covered ? undefined : (injected && injected.reason) || 'unknown'
	await persistHoldEntry(tab.id, { at: Date.now(), note, aborted: false, covered, ...(reason ? { reason } : {}) })
	return { tabId: tab.id, action, active: covered, covered, note, ...(reason ? { reason } : {}) }
}

/**
 * 中止态下的拒绝：命令一条都不发出去。
 *
 * 只在**存下来的状态说中止**、且页面上的浮层还在时才拦 —— 页面一导航浮层就没了，
 * 那时把存储里那条顺手清掉（如实报「覆盖层已消失」，不许假装还挡着）。
 */
async function holdRefusalFor(command, params) {
	if (!HOLD_BLOCKED_COMMANDS.has(command)) return null
	let tab
	try { tab = await resolveTab(params?.tabId, policyOf(params).jar) } catch { return null }
	const entry = (await syncHoldState())[tab.id] || null
	if (!entry) return null
	// 「谁按了中止」只发生在页面里（用户点浮层上的按钮，没有任何命令经过桥），所以
	// 页面现场是**唯一**可信来源；存储里那条只用来判断「这个标签页有没有浮层」。
	// 这也是为什么每拦一次都要探一次：省下这次探测，就等于让中止在 30 秒后自己失效。
	const page = await holdEval(tab, pageHoldStatus).catch(() => null)
	if (page === null) return null
	if (page.active !== true) { await persistHoldEntry(tab.id, null); return null }
	if (page.aborted !== true) return null
	return `${HOLD_ABORTED_MARKER} 用户已在页面的接管浮层上按下「中止操作」：命令 ${command} 被拦下，没有向浏览器发出任何操作。`
		+ `请先与用户确认；用户同意继续后调用 browser_hold action=off 解除这一状态（这一步等于确认继续）。不要重试，也不要换一个工具绕过去。`
}

/* ------------------------------------ 默认目标、归属与让出（第 4 项的行为面） */
/**
 * 线协议上的「默认目标策略」，插件在**每条命令**的 params 里盖一个 `policy` 信封
 * （`BridgeController.execute()` 一处盖章，工具侧不用逐条传）。
 *
 * 为什么不把策略存进 `chrome.storage`：那就有两份真相——插件配置改了、扩展还拿着
 * 上一次推送的值，两边都不报错。这里扩展**不持有任何策略状态**，缺省值写在下面，
 * 没有信封的命令按缺省跑；改了配置下一条命令立刻生效。
 */
const DEFAULT_POLICY = Object.freeze({
	focus: 'avoid', tabs: 'current-window', takeover: 'yield', jar: 'normal',
	// 高亮框默认画（它是纯视觉的状态指示），分组名默认 DSH。
	highlight: 'on', groupTitle: 'DSH',
})

function policyOf(params) {
	const raw = params && typeof params.policy === 'object' && params.policy !== null ? params.policy : {}
	return {
		focus: raw.focus === 'auto' ? 'auto' : DEFAULT_POLICY.focus,
		tabs: raw.tabs === 'new-window' ? 'new-window' : DEFAULT_POLICY.tabs,
		takeover: raw.takeover === 'ignore' ? 'ignore' : DEFAULT_POLICY.takeover,
		jar: raw.jar === 'incognito' ? 'incognito' : DEFAULT_POLICY.jar,
		highlight: raw.highlight === 'off' ? 'off' : DEFAULT_POLICY.highlight,
		// 空串是**有含义的**（不分组），所以这里只判类型，不做 `||` 兜底：兜底会把用户
		// 「我不想有分组」这个选择悄悄变回默认分组。
		groupTitle: typeof raw.groupTitle === 'string' ? raw.groupTitle : DEFAULT_POLICY.groupTitle,
	}
}

/**
 * 这一次调用用哪个分组名；`null` = 这一次不分组。
 *
 * 优先级：`group: false`（显式拒绝分组）> `params.groupTitle`（这一次的覆盖，含空串）
 * > 策略信封里的配置值。归一（压平空白、限长）放在这里一次做完，建组与查询共用它，
 * 免得「建组用了一个名字、查询用另一个」这种只能靠肉眼发现的错位。
 */
function groupTitleOf(params) {
	if (params && params.group === false) return null
	const explicit = params && typeof params.groupTitle === 'string' ? params.groupTitle : null
	const raw = explicit !== null ? explicit : policyOf(params).groupTitle
	const title = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_TITLE_MAX)
	return title.length === 0 ? null : title
}

/**
 * 当前这条命令生效的策略。`runCommand` 进来时刷新。
 *
 * `resolveTab` / `cmdTabsOpen` 需要知道「现在在哪个罐里干活」，而它们被几十处调用、
 * 签名里只有 tabId。与其把 policy 一路透传（每个调用点都得记得传，漏了不报错），
 * 不如在派发入口记一次——它本来就只在一次命令的栈里有效。
 */
let currentPolicy = DEFAULT_POLICY

/**
 * 把「事件路径也要知道」的那一位策略写进 session（只在变化时写一次）。
 *
 * 为什么要存：`tabs.onUpdated`（导航完成补画高亮）跑在**命令之外**。它以前读模块级
 * `currentPolicy`，而那个值在 service worker 回收/浏览器重启/扩展重载之后只是缺省值——
 * 用户关掉高亮之后，一次页面跳转就能被旧值把框画回来。
 *
 * 顺带回答设置页那句「改完下一条命令就生效」：关掉高亮之后，下一条命令就把已经挂着的
 * 那圈收掉，而不是等到某个凑巧的认领动作。
 * @param policy - 这条命令生效的策略（`policyOf(params)`）。
 */
async function rememberPolicy(policy) {
	const state = await syncAgentState()
	const next = policy.highlight === 'off' ? 'off' : 'on'
	if (state.policy === null || state.policy.highlight !== next) {
		state.policy = { highlight: next }
		await persistAgentState()
	}
	if (next === 'off' && state.highlight !== null) await syncHighlight(null).catch(() => {})
}

/**
 * 归属表 + 粘性目标 + 让出表，一条记录放 `chrome.storage.session`。
 *
 * 放 session 而不是内存：service worker 30 秒就被回收，内存里的归属一没，AI 自己开的
 * 标签页立刻变成「用户的」，`tabs.close` 会开始拒绝关它自己的标签页——这种状态必须活过
 * 回收。放 session 而不是 local：浏览器一关就该忘掉（那是上一轮的事）。
 */
const AGENT_STATE_KEY = 'agentState'

/**
 * 什么算「用户接管了」？——**他在那一页上真的动了手**，不是他切过去看了一眼。
 *
 * 第一版（v1.1.2）拿 `tabs.onActivated` / `windows.onFocusChanged` 当信号：用户切到 AI 的
 * 标签页、或者离开浏览器再回来，就算接管。那在「AI 正在点、用户回来收拾」时是对的，但把
 * 「我就在旁边看着它干活」也一并判成接管了：页面立刻变琥珀色「已让出」，AI 的下一步写操作
 * 被拒——而用户什么都没做。误报的方向是"安全"的，可它把最正常的用法（看 AI 干活）变成
 * 了一次假的冲突，所以按用户 2026-10-29 的要求收窄成**真实输入**。
 *
 * 现在的信号来自页面里的探针（`armUserInputProbe`）：只认 `isTrusted` 的
 * `pointerdown`（鼠标/笔）/ `click`（触屏）/ `keydown` / `input` / `paste`。
 * 切换标签页、切窗口、打开扩展弹窗都**不再**算接管。
 *
 * 纯滚动（`wheel`）**故意不在里面**：读长页面就是靠滚，把它算成接管就等于回到
 * 「看一眼就黄框」。代价是用户滚走之后 AI 的滚动/点击仍会动他眼前的页面——这是一条
 * 可以改的策略常量，不是散在逻辑里的魔法判断；真要更保守，把它加进这个数组即可。
 */
const USER_INPUT_KINDS = ['pointerdown', 'click', 'keydown', 'input', 'paste']
/** 页面里那个 CDP binding 的名字：探针把它当回调调回扩展。 */
const USER_INPUT_BINDING = '__dshUserInput'
/**
 * 我们自己派发的东西在页面里**也是** `isTrusted`，探针分不出它们和真人操作。
 *
 * 第一版用一个 400ms 的全局时间窗压掉，两个真问题：
 *   1) **按时间判不靠谱**：页面主线程卡一下，我们的回报就落到窗外，于是"自己点自己被判成
 *      用户接管"——AI 把自己锁死在自己刚点过的那一页上（审查把它列为理论边界，实测可构造）。
 *   2) **种类对不上就漏**：`cmdInput` 的 `type` 模式每个 ASCII 字符走
 *      `Input.dispatchKeyEvent{type:'keyDown', text: ch}`，页面产生的是 `keydown` **和**
 *      `input`；只按 `keydown` 压的话，那个 `input` 一定被当成用户输入——AI 打完字就把
 *      自己锁死（这条不是理论，是必然）。
 *
 * 现在改成**按派发配对**：派发之前登记"我期待收到哪几种回报"，收到同种类的第一条就消账。
 * 于是慢页面不影响（配对不看时间），种类映射错了由测试当场抓出来（漏了就是自锁）。
 * 剩下的风险是**登记了却没等到回报**（比如点进了没装探针的 iframe）：那条债会在 TTL 内
 * 吃掉一次同种类的真实输入，所以 TTL 取 1.5s 而不是无限——而且一次最多吃掉一条。
 */
const SELF_INPUT_TTL_MS = 1500
/** `tabId -> Map<kind, [登记时刻]>`：我们派发出去、还没收到回报的事件（按页分开，见上）。 */
const selfInputPending = new Map()
/** 已经装好探针的标签页。导航会把监听连同旧文档一起换掉，那时要重装。 */
const probeArmed = new Set()
/** `{ tabs: {[tabId]: {at, windowId}}, target: number|null, yields: {[tabId]: {at, reason}} }` */
let agentState = null
let agentStateLoaded = false

function normalizeAgentState(raw) {
	const record = raw && typeof raw === 'object' ? raw : {}
	return {
		tabs: record.tabs && typeof record.tabs === 'object' ? record.tabs : {},
		target: Number.isInteger(record.target) ? record.target : null,
		yields: record.yields && typeof record.yields === 'object' ? record.yields : {},
		// 隔离实例（无痕窗口）的 windowId；浏览器一关就没了，所以同样放 session。
		isolated: Number.isInteger(record.isolated?.windowId) ? { windowId: record.isolated.windowId, at: Number(record.isolated.at) || 0 } : null,
		// 现在哪一页上挂着 AI 高亮框。页面导航会把注入的宿主打掉，所以「有没有画过」这件事
		// 必须存下来（`tabs.onUpdated` 靠它补画、断开时靠它擦掉），不能只放内存。
		highlight: Number.isInteger(record.highlight?.tabId)
			? {
				tabId: record.highlight.tabId,
				tone: record.highlight.tone === HIGHLIGHT_TONE_YIELDED ? HIGHLIGHT_TONE_YIELDED : HIGHLIGHT_TONE_AGENT,
				at: Number(record.highlight.at) || 0,
			}
			: null,
		/**
		 * 我们自己建过（或加入过）的标签组：`{ [groupId]: { title, windowId, at } }`。
		 *
		 * 归属只认这张表（见 `ourGroupIds`）：按标题认会让用户自己的同名组里的标签页
		 * 变成「AI 的」。放 session 而不是内存：service worker 被回收之后，那些组里的
		 * 标签页仍然是 AI 的，`tabs.close` 不该突然开始要 `force`。
		 */
		groups: record.groups && typeof record.groups === 'object' ? record.groups : {},
		/**
		 * 最后一条命令的**策略快照**（事件路径要用的那一位）。
		 *
		 * 「用户接管就让出」与「导航完成补画高亮」都跑在**命令之外**（`tabs.onActivated`
		 * / `tabs.onUpdated`），读不到那一条命令的信封。以前它们读模块级的
		 * `currentPolicy`，而那个值在 service worker 回收/浏览器重启/扩展重载之后只是缺省
		 * 值——于是 `agentHighlight:false` 之后，一次页面跳转就能按旧值把框画回来。
		 * 所以每条命令进门时把这一位写进这里，事件路径只读这一份。
		 *
		 * 只存 `highlight`：组名不再参与任何「命令之外」的判定（归属按 groupId 认，
		 * 不按标题猜），多存一份只会变成没人读的死状态。
		 */
		policy: record.policy && typeof record.policy === 'object'
			? { highlight: record.policy.highlight === 'off' ? 'off' : 'on' }
			: null,
	}
}

/** Lazily read the ownership record (once per worker lifetime). */
async function syncAgentState() {
	if (agentStateLoaded && agentState !== null) return agentState
	try {
		const stored = await chrome.storage.session.get([AGENT_STATE_KEY])
		agentState = normalizeAgentState(stored && stored[AGENT_STATE_KEY])
	} catch (err) {
		// 读不到按「没有归属」处理：它影响的是「能不能关别人的标签页」与「默认打哪儿」，
		// 前者 fail-closed（不认归属 = 更保守），后者退回旧行为（跟着用户的当前标签页）。
		agentState = normalizeAgentState(null)
		lastError = `读取标签页归属失败（按没有归属处理）：${err.message}`
	}
	agentStateLoaded = true
	return agentState
}

async function persistAgentState() {
	agentStateLoaded = true
	try {
		await chrome.storage.session.set({ [AGENT_STATE_KEY]: agentState })
	} catch (err) {
		lastError = `写入标签页归属失败：${err.message}`
	}
	return agentState
}

/** 记住「这个标签页是 AI 的」并把它设成默认目标。`own: false` 只挪目标，不认领。 */
async function claimTab(tabId, { own = true } = {}) {
	const state = await syncAgentState()
	const id = Number(tabId)
	if (own) {
		const tab = await chrome.tabs.get(id).catch(() => null)
		state.tabs[id] = { at: Date.now(), ...(tab === null ? {} : { windowId: tab.windowId }) }
	}
	state.target = id
	await persistAgentState()
	// 认领/换目标 = 「AI 现在动的是这一页」这件事实变了，高亮框跟着挪。三条约束：
	//   - 只在**AI 自己的**标签页上画（`own` 或早就被认领过）。`tabs.activate` 到用户的页
	//     是 `own:false`：画框要挂 debugger，而挂上去之后那一页的弹窗会按 `dialogPolicy`
	//     自动应答（缺省 accept），他关页面时不再被问「有未保存的内容」——为了一个装饰层
	//     换一次潜在的数据丢失，不值得。目标挪走时这里传 null，把旧框收掉，不留谎报。
	//   - 画框失败（受限页面、CDP 不可用）不该让命令失败。
	//   - 有时间上限：一个卡住的页面能让 CDP 附着吊住，`tabs.open` 不能因此多等一个没有
	//     上界的时间。超了这次就不画（下一条命令或导航完成时会重画）。
	const mine = own || state.tabs[id] !== undefined
	// 两件事都要在认领时做完，但**并行**、各自一份预算：串起来就把 `tabs.open` 的上界从
	// 一个 2s 变成两个 2s（附着吊住时会真的观察到 4s）。两者都自己 `ensureAttached`，
	// 并发附着是扩展本来就容忍的（第二次会拿到 "already attached"）。
	await Promise.all([
		withBudget(syncHighlight(mine ? id : null), HIGHLIGHT_BUDGET_MS, { shown: false }).catch(() => {}),
		// 输入探针：**真实输入**是让出判定的唯一信号（见 noteUserInput）。探针不在，AI 就
		// 永远不会因为用户在页面上动手而停下。只对 AI 自己的标签页装（`mine`），用户的页面
		// 不碰——理由见 armUserInputProbe。
		mine ? withBudget(armUserInputProbe(id), HIGHLIGHT_BUDGET_MS, false).catch(() => {}) : Promise.resolve(false),
	])
	return state
}

/** 忘了这些标签页的归属/让出/目标（关闭、拆组、被用户接管后释放时用）。 */
async function forgetOwned(tabIds) {
	const state = await syncAgentState()
	let touched = false
	let dropHighlight = null
	for (const raw of tabIds) {
		const id = Number(raw)
		if (!Number.isInteger(id)) continue
		if (state.tabs[id] !== undefined) { delete state.tabs[id]; touched = true }
		if (state.yields[id] !== undefined) { delete state.yields[id]; touched = true }
		if (state.target === id) { state.target = null; touched = true }
		if (state.highlight !== null && state.highlight.tabId === id) { dropHighlight = id; state.highlight = null; touched = true }
	}
	if (touched) await persistAgentState()
	// 标签页可能还活着（`tabs.ungroup` = 放手）：那一圈框也得跟着撤，不然页面上还挂着
	// 「AI 正在操作」而它已经放手了。真关掉的标签页这里只是白跑一次，不会抛。
	if (dropHighlight !== null) await eraseHighlight(dropHighlight)
	return state
}

/**
 * 「AI 的标签页」= 自己开过的 **或** 现在待在我们自己那个组里的。
 *
 * 后者是刻意的：分组是**看得见**的认领手势，用户把某个标签页拖进那个组，就是在说
 * 「这一个给你用」。于是归属不需要一个新的 `tabs.claim` 命令——`tabs.group` 就是认领，
 * `tabs.ungroup` 就是放手，两个命令早就存在，也早就被只读档和错误契约登记过。
 *
 * 「我们的组」按 **id** 认（`ourGroupIds`），不按标题——理由见那一段注释：按标题认会让
 * 用户自己的同名组里的标签页变成「AI 的」，`close` 不必 `force` 就能关。同名不合并。
 */
async function ownedTabIds() {
	const state = await syncAgentState()
	const ids = new Set(Object.keys(state.tabs).map(Number).filter((n) => Number.isInteger(n)))
	if (!tabGroupsAvailable()) return ids;
	for (const groupId of await ourGroupIds()) {
		const members = await chrome.tabs.query({ groupId }).catch(() => [])
		for (const tab of members) if (tab.id !== undefined) ids.add(Number(tab.id))
	}
	return ids
}

/* --------------------------------------------------- 用户接管即让出（yield） */

/**
 * 用户**在 AI 的标签页上真的动了手**时，AI 在那一个标签页上的写操作开始被拒。
 *
 * 为什么信号是"真实输入"而不是"切过去了"（v1.1.5 收窄）：只看一眼不该算接管。旧信号
 * （`tabs.onActivated` / `windows.onFocusChanged`）会把"用户切过来看 AI 干活"判成冲突，
 * 页面立刻变琥珀色、AI 的下一条写命令被拒，而用户什么都没做。真实输入才是"两边马上要抢
 * 同一个页面"的证据，所以探针装在页面里，只认 `isTrusted` 的那几种事件。
 *
 * 为什么让出而不是「抢回来」：用户点进那个标签页，通常是为了看或者动手；AI 在同一个
 * 页面上继续点击/打字，两边会互相破坏（尤其是表单与滚动位置）。拒绝一条命令 + 说清
 * 怎么继续，比第二条命令把用户正在填的框清掉要好得多。
 *
 * 四条解除路径，缺一不可（少一条就等于"点一下就把 AI 永久锁死"）：
 *   1) 用户在**别的**标签页上动手（`noteUserInput` → clearAllYields）——他走了；
 *   2) 用户切到他自己的标签页（`noteUserActivation` 只保留这条"清场"职责）；
 *   3) 所有窗口都失焦（`windows.onFocusChanged` 的 WINDOW_ID_NONE）——他去了别的应用；
 *   4) 用户确认后，模型调 `tabs.activate` 把这个标签页要回来——显式解除。
 * 新增的自我服务出口：AI 自己新开一个标签页继续（`tabs.open`），不需要任何人授权。
 */
const YIELDED_MARKER = 'browser-yielded-to-user:'
/**
 * 让出期间被拒的扩展命令：会跟用户抢同一个页面的那几条。
 *
 * `tabs.close*` 也在里面，理由是**不可恢复**：关掉用户正看着的那一页，页面状态和填了一半的
 * 表单就没了，而点击/输入最多是「多了一次没意义的动作」。唯一例外是 `force: true`——
 * 它本来就表示「用户明确让我关这个标签页」，是他能给的最高授权。
 */
const YIELD_BLOCKED_COMMANDS = new Set(['click', 'input', 'press', 'nav', 'scroll', 'tabs.close', 'tabs.closeMany'])

/**
 * 让出表是「读-改-写 + await」，两条路径交错时后写的会把先写的结果盖掉。
 *
 * 实测的坏形态：用户点一下 AI 那一页（binding 报告在飞）→ 立刻切走
 * （`tabs.onActivated` → `clearAllYields`）→ 报告的 `setYield` 落在清场之后，**让出被复活**：
 * 解除路径白跑，AI 被锁在一个用户已经离开的页面上。
 *
 * 所以整段判定都串成一条链——**不只是最后那次写**。只把 `setYield` 包起来没用：清场会在
 * 「判定已经读过状态、还没写」的中间窗口插进来，最后仍按后写者生效。锁要罩住
 * 「读状态 → 决定 → 写」整个事务，顺序才等于调用顺序。
 */
let yieldWrites = Promise.resolve()
function withYieldLock(fn) {
	const run = yieldWrites.then(fn, fn)
	yieldWrites = run.then(() => {}, () => {})
	return run
}

/** 三个 `*Unlocked` 都假定**已经持锁**；对外只用下面三个包装。 */
async function setYieldUnlocked(tabId, reason) {
	const state = await syncAgentState()
	state.yields[Number(tabId)] = { at: Date.now(), reason }
	await persistAgentState()
	// 让出是**用户看得见**的状态变化：框还在，但颜色和徽标要变成「已让出」，
	// 否则页面上的蓝框会继续宣称「AI 正在操作」，而他明明已经接手了。
	await retoneHighlight(Number(tabId)).catch(() => {})
	return state
}

async function clearYieldUnlocked(tabId) {
	const state = await syncAgentState()
	if (state.yields[Number(tabId)] === undefined) return state
	delete state.yields[Number(tabId)]
	await persistAgentState()
	await retoneHighlight(Number(tabId)).catch(() => {})
	return state
}

async function clearAllYieldsUnlocked() {
	const state = await syncAgentState()
	if (Object.keys(state.yields).length === 0) return state
	state.yields = {}
	await persistAgentState()
	// 让出结束 ⇒ 框回到「我在操作」（只可能落在当前画着的那一页上）。
	if (state.highlight !== null) await retoneHighlight(state.highlight.tabId).catch(() => {})
	return state
}

function setYield(tabId, reason) {
	return withYieldLock(() => setYieldUnlocked(tabId, reason))
}

function clearYield(tabId) {
	return withYieldLock(() => clearYieldUnlocked(tabId))
}

function clearAllYields() {
	return withYieldLock(() => clearAllYieldsUnlocked())
}

/**
 * `tabs.onActivated` 来了：只用来**清场**，不再用来判定接管。
 *
 * v1.1.5 起「切到 AI 的标签页」不算接管（用户只是在看，见 `USER_INPUT_KINDS` 上面那段）。
 * 这条监听剩下的唯一职责是反方向的：用户切到**他自己的**标签页 = 他离开了 AI 那一页，
 * 把让出解除，别把 AI 锁死在一个已经被放弃的页面上。
 */
async function noteUserActivation(tabId) {
	const id = Number(tabId)
	const state = await syncAgentState()
	const owned = await ownedTabIds()
	if (owned.has(id) || state.target === id) return false
	await clearAllYields()
	return false
}

/**
 * 页面里的输入探针。自包含（`toString()` 后整段注入，不引用扩展作用域）：只有页面里
 * 看得到事件对象，所以四条判据都写在页面侧。
 *
 *   1) 只认 `isTrusted`：`browser_evaluate` 里 `.click()` 之类的合成事件不算——
 *      否则模型自己写的脚本能把它自己变成「用户接管」。
 *   2) 滚动不算（用户 2026-10-29 的决定）：滚轮压根没注册；键盘翻页键在焦点不在
 *      可编辑元素时忽略（在输入框里按空格/方向键是编辑，照算）。
 *   3) 落在滚动条上的 `pointerdown` 是拖动滚动条，不是点击。
 *   4) 触屏指针改用 `click`：触屏滑动的起手也是 `pointerdown`，而滑动不是操作、点击才是。
 *      鼠标/笔仍用 `pointerdown`，这样框选、拖拽、canvas 拖动都能立刻算。
 *
 * @param config `{binding, kinds}`——一个 JSON 参数，和注入高亮/浮层的写法保持一致
 * @returns `'installed'` | `'already'`
 */
function pageInputProbe(config) {
	const bindingName = config.binding
	const kinds = config.kinds
	const FLAG = '__dshInputProbeInstalled'
	if (window[FLAG] === true) return 'already'
	window[FLAG] = true
	const SCROLL_KEYS = ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar']
	const EDITABLE_TAGS = /^(INPUT|TEXTAREA|SELECT)$/
	const editable = (node) => {
		if (node === null || node === undefined) return false
		if (node.isContentEditable === true) return true
		return EDITABLE_TAGS.test(String(node.tagName || '').toUpperCase())
	}
	// 竖直滚动条画在 clientWidth 右侧；只有「确实在滚动的容器」才做这个判断——
	// 行内元素的 clientWidth 是 0，无条件比会把它上面所有的点击全判成滚动条。
	const onScrollbar = (event) => {
		const el = event.target
		if (!el || typeof el.clientWidth !== 'number' || typeof el.clientHeight !== 'number') return false
		const scrolls = el.clientWidth > 0 && el.clientHeight > 0
			&& (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)
		if (!scrolls) return false
		return Number(event.offsetX) >= el.clientWidth || Number(event.offsetY) >= el.clientHeight
	}
	const fire = (kind) => {
		try {
			const report = window[bindingName]
			if (typeof report === 'function') report(kind)
		} catch { /* binding 可能已经撤掉：静默，绝不因为上报失败影响页面 */ }
	}
	const listen = (kind, handler) => {
		window.addEventListener(kind, handler, { capture: true, passive: true })
	}
	for (const kind of kinds) {
		if (kind === 'keydown') {
			listen(kind, (event) => {
				if (event.isTrusted !== true) return
				if (!editable(event.target) && SCROLL_KEYS.indexOf(String(event.key)) >= 0) return
				fire(kind)
			})
			continue
		}
		if (kind === 'pointerdown') {
			listen(kind, (event) => {
				if (event.isTrusted !== true) return
				if (event.pointerType === 'touch') return
				if (onScrollbar(event)) return
				fire(kind)
			})
			continue
		}
		if (kind === 'click') {
			listen(kind, (event) => {
				if (event.isTrusted !== true) return
				// 只有触屏指针需要 click：鼠标/笔的 pointerdown 已经报过，这里再报就是一次点击两次。
				if (event.pointerType !== 'touch') return
				fire(kind)
			})
			continue
		}
		listen(kind, (event) => {
			if (event.isTrusted !== true) return
			fire(kind)
		})
	}
	return 'installed'
}

/**
 * 装好输入探针（**假定已经附着**）。
 *
 * `Runtime.addBinding` 是 target 级的，导航后还在；监听器却是文档级的，导航会连旧文档
 * 一起丢掉——所以 `tabs.onUpdated` 完成时还要重装一次（见 `rearmProbeIfAgentTab`）。
 */
async function installInputProbe(tabId) {
	const id = Number(tabId)
	// `addBinding` 失败就是失败：binding 不在，监听器装上也报不回来。这里**不吞错**——
	// 早先 `.catch(() => {})` 把它吞了，于是"装好了"只反映页面的返回值，而那个返回值
	// 依赖页面可见的 `window.__dshInputProbeInstalled`：页面预置成 true 就能让探针
	// 永久静默（独立审查实测复现）。
	const bound = await dbgSend(id, 'Runtime.addBinding', { name: USER_INPUT_BINDING }).then(() => true, () => false)
	const res = await dbgSend(id, 'Runtime.evaluate', {
		expression: `(${pageInputProbe.toString()})(${JSON.stringify({ binding: USER_INPUT_BINDING, kinds: USER_INPUT_KINDS })})`,
		awaitPromise: false, returnByValue: true,
	}).catch(() => null)
	const outcome = res?.result?.value
	if (bound && (outcome === 'installed' || outcome === 'already')) {
		probeArmed.add(id)
		return true
	}
	probeArmed.delete(id)
	return false
}

/**
 * 该页的探针装上了吗？没装上就装（只对 AI 自己的标签页）。
 *
 * 归属判断**只在缺探针时**才做：正常路径是一次 Set 命中，不该为它每条命令都去查一圈
 * 标签组（`ownedTabIds` 会按组 query）。缺探针是罕见状态，那时多花几次 IPC 完全值得——
 * 这条路径就是"装探针失败之后的自愈通道"。
 */
async function ensureProbeFor(tabId) {
	const id = Number(tabId)
	if (probeArmed.has(id)) return true
	const state = await syncAgentState().catch(() => null)
	if (state === null) return false
	const owned = await ownedTabIds().catch(() => new Set())
	if (!owned.has(id) && state.target !== id) return false
	return await installInputProbe(id)
}

/**
 * 给**AI 自己的**标签页装上探针（还没附着就先附着）。
 *
 * 为什么只给自己的：探针要在页面里注册一个 CDP binding。挂到用户自己的页面上既是多余的
 * 指纹，也意味着为了"监听"去附着他的页面——而附着的副作用是那页的弹窗会被自动应答
 * （缺省 accept）。同一个理由早就写在 `claimTab` 里"不为画框去挂 debugger"那一段。
 *
 * 这里**不再自己注入一次**：`ensureAttached` 里的 `ensureProbeFor` 已经把该做的事做了
 * （缓存命中也会补一次）。以前两处各注入一次，首装会走两轮 `addBinding` + 两次 evaluate。
 */
async function armUserInputProbe(tabId) {
	const id = Number(tabId)
	if (probeArmed.has(id)) return true
	await ensureAttached(id)
	return probeArmed.has(id)
}

/**
 * 把 `Runtime.bindingCalled` 的 `payload` 还原成探针报的事件种类。
 *
 * 探针只传一个字符串参数，所以 payload 是 `"pointerdown"` 这样的 JSON 串。解析失败返回
 * 空串（= 未知种类，不落进任何抑制窗）——宁可多让出一次，也不要因为页面把 binding 改坏
 * 就变成"永远不报"。
 */
function bindingKindOf(payload) {
	try {
		const parsed = JSON.parse(String(payload ?? '""'))
		return typeof parsed === 'string' ? parsed : ''
	} catch {
		return ''
	}
}

/**
 * 页面里报了「用户真的动了」：把这一页标成已让出。
 *
 * 这是 v1.1.5 之后**唯一**的接管信号（旧的两条：切标签页、窗口回前台，都会把"看"误判成
 * "动手"）。两条早退：这一条是不是我们自己派发的（按"派发 → 回报"配对，见 SELF_INPUT_TTL_MS）；
 * 已经让出过的不重复落盘（每敲一个字符都会来一次，不该每次都写 session + 重播高亮）。
 *
 * @returns 是否因此把这个标签页标成「已让出」。
 */
async function noteUserInput(tabId, kind) {
	const id = Number(tabId)
	if (!Number.isInteger(id)) return false
	// 我们自己派发的输入在这里消账（按"派发 → 回报"配对，见 SELF_INPUT_TTL_MS 那段）。
	if (consumeSelfInput(id, kind)) return false
	// 整段判定都在让出锁里：「读状态 → 决定 → 写」必须是一个事务，否则清场会从中间插进来
	// （见 withYieldLock）。这条路径上不允许再调带锁的包装，只能用 `*Unlocked`。
	return await withYieldLock(async () => {
		const state = await syncAgentState()
		if (state.yields[id] !== undefined) return true
		const owned = await ownedTabIds()
		const isAgentTab = owned.has(id) || state.target === id
		if (!isAgentTab) {
			// 用户在**别的**页面上动手了：他离开了 AI 这一页，让出结束。
			await clearAllYieldsUnlocked()
			return false
		}
		if (!(await tabStillThere(id))) { await forgetOwned([id]); return false }
		await setYieldUnlocked(id, 'user_input')
		return true
	})
}

/**
 * 导航完成：探针（文档级监听）跟着旧文档一起没了，重装。
 *
 * 只在**已经附着**过、且这一页确实归 AI 时重装：没附着就没有 binding，也不该为了装探针
 * 去新附着一个页面；归属判断与 `armUserInputProbe` 一致。
 */
async function rearmProbeIfAgentTab(tabId) {
	const id = Number(tabId)
	if (!attachedTabs.has(id)) return false
	const state = await syncAgentState()
	const owned = await ownedTabIds()
	if (!owned.has(id) && state.target !== id) return false
	probeArmed.delete(id)
	return await installInputProbe(id)
}

/** 让出期间的拒绝文案；前缀是线协议，与 `src/errors.ts` 里的字面量对账。 */
async function yieldRefusalFor(command, params) {
	if (!YIELD_BLOCKED_COMMANDS.has(command)) return null
	if (policyOf(params).takeover === 'ignore') return null
	// `force` 是「用户明确让我关这个标签页」：那是他能给的最高授权，闭着眼拒它反而变成
	// 拿安全当借口不听人话。其余情况一律拦下。
	if ((command === 'tabs.close' || command === 'tabs.closeMany') && params?.force === true) return null
	let tab
	try { tab = await resolveTab(params?.tabId, policyOf(params).jar) } catch { return null }
	const state = await syncAgentState()
	const entry = state.yields[tab.id]
	if (!entry) return null
	// 标签页已经没了：顺手把这条让出清掉，别让它一直挂着。
	if (!(await tabStillThere(tab.id))) { await forgetOwned([tab.id]); return null }
	const recover = command === 'tabs.close' || command === 'tabs.closeMany'
		? '如果要关的就是这一页，那一定要先问用户：他确认之后传 force:true（那一位本来就是「用户明确让我关」）。'
		: '三条路：在你自己新开的标签页里继续（browser_tabs action=open），或者等用户切到别的标签页（他切走之后自动解除），'
			+ '或者由用户确认后调用 browser_tabs action=activate 把这个标签页要回来。'
	return `${YIELDED_MARKER} 用户已经接管了这个标签页（#${tab.id}）：命令 ${command} 被拦下，没有向浏览器发出任何操作。`
		+ `他可能正在这个页面上操作，跟他在同一个页面上继续动只会互相破坏。`
		+ recover + `不要原地重试。`
}

/* --------------------------------------------- 隔离实例（无痕罐，第 3 项） */

/**
 * 「隔离实例」= 一个**无痕窗口**。它有自己的 cookie/存储罐，跟你也带着登录态的那个
 * 罐完全隔开：模型可以在里面登录、试流程、点乱东西，退出即清，也不会污染你正在用的会话。
 *
 * 为什么不是无痕的 `split` 模式 + 双扩展进程：那需要两套 service worker、两条 WebSocket、
 * 桥侧多客户端路由与逐命令的实例寻址。而隔离要的是**罐**，不是进程——`spanning`
 * （扩展的默认模式）下一个实例就看得到两个罐，`tab.incognito` 足以分辨，改动小一个数量级，
 * 也没有第二套状态要同步。真需要「另一份持久登录」时（第二阶段）才会上独立 Chrome profile，
 * 那时多实例桥才有意义。
 *
 * 前提是**用户**在扩展管理页给了「在无痕/InPrivate 中允许」——插件翻不动那个开关，
 * 所以拿不到权限时如实报错，并说清去哪儿打开。
 */
const INCOGNITO_UNAVAILABLE_MARKER = 'browser-incognito-unavailable:'
let incognitoAllowed = false
let incognitoAllowedLoaded = false

/**
 * 读「是否允许在无痕中运行」。MV3（Chrome 99+）返回 Promise，老版本只吃回调——
 * 两种都试一遍，读不到一律按 false（= 不许开），因为它是**浏览器权限**不是我们的开关。
 */
async function readIncognitoAllowed() {
	const api = chrome.extension
	if (api === undefined || typeof api.isAllowedIncognitoAccess !== 'function') return false
	try {
		const maybe = api.isAllowedIncognitoAccess()
		if (maybe !== undefined && typeof maybe.then === 'function') return (await maybe) === true
	} catch { /* 老版本无参数调用会抛：走下面的回调形式 */ }
	return await new Promise((resolve) => {
		try { api.isAllowedIncognitoAccess((value) => resolve(value === true)) } catch { resolve(false) }
	})
}

/** 缓存到本次 worker 生命周期；`profile.launch` 会强制重读（用户可能刚在扩展页打开开关）。 */
async function syncIncognitoAllowed({ refresh = false } = {}) {
	if (incognitoAllowedLoaded && !refresh) return incognitoAllowed
	incognitoAllowed = await readIncognitoAllowed()
	incognitoAllowedLoaded = true
	return incognitoAllowed
}

/**
 * 找到（并顺手校验）隔离窗口。
 *
 * 用户随时可以自己关掉那个无痕窗口，所以每次都要问一次；拿不到就把记录清掉——
 * 让「已关闭的窗口」留在状态里，后面的命令就会往一个不存在的窗口上开标签页。
 */
async function isolatedWindow() {
	const state = await syncAgentState()
	const id = state.isolated?.windowId
	if (!Number.isInteger(id)) return null
	const win = await chrome.windows.get(id).catch(() => null)
	if (win === null || win.incognito !== true) {
		state.isolated = null
		// 用户随时可以自己关掉那个无痕窗口。真 Chrome 会为里面每个标签页发一次
		// tabs.onRemoved（下面的监听器负责清归属），但那只在 worker 活着时靠得住：
		// 浏览器重启、worker 被回收期间关窗都可能让事件到不了。所以这里再扫一遍——
		// 「已关闭的标签页还挂着归属/让出」是那种会一直烂到下次重启的状态。
		const dead = []
		for (const key of Object.keys(state.tabs)) {
			if (!(await tabStillThere(Number(key)))) dead.push(Number(key))
		}
		for (const key of Object.keys(state.yields)) {
			if (!(await tabStillThere(Number(key)))) dead.push(Number(key))
		}
		if (dead.length > 0) await forgetOwned(dead)
		else await persistAgentState()
		return null
	}
	return win
}

/** 确保有一个隔离窗口；没有就开一个（`focused:false`：开自己的罐，但不许抢用户焦点）。 */
async function ensureIsolatedWindow({ url } = {}) {
	const existing = await isolatedWindow()
	if (existing !== null) return { window: existing, created: false }
	// 缓存说「没有权限」时再问一次：用户完全可能刚刚在扩展管理页把开关打开，而 worker
	// 还活着（缓存不刷新的话，他打开了开关、模型换个入口（tabs.open jar=incognito）还是撞墙，
	// 要等 worker 被回收才恢复）。只有失败路径才多花这一次调用。
	let allowed = await syncIncognitoAllowed()
	if (!allowed) allowed = await syncIncognitoAllowed({ refresh: true })
	if (!allowed) {
		throw new Error(`${INCOGNITO_UNAVAILABLE_MARKER} 扩展还没有无痕/InPrivate 访问权限：请在浏览器扩展管理页打开本扩展的「在无痕模式中允许」（Edge 叫「在 InPrivate 中允许」），然后重试。这不是故障，是浏览器那一层的权限，插件改不了它。`)
	}
	const win = await chrome.windows.create({ incognito: true, focused: false, ...(url ? { url } : {}) })
	const state = await syncAgentState()
	state.isolated = { windowId: win.id, at: Date.now() }
	await persistAgentState()
	return { window: win, created: true }
}

async function cmdProfileLaunch(params) {
	// 用户可能刚在扩展管理页把开关打开：这里强制重读一次，别拿一小时前的缓存拒他。
	await syncIncognitoAllowed({ refresh: true })
	const { window, created } = await ensureIsolatedWindow({ url: params?.url })
	const tabs = await chrome.tabs.query({ windowId: window.id }).catch(() => [])
	return {
		jar: 'incognito',
		windowId: window.id,
		created,
		tabs: tabs.length,
		incognitoAllowed: true,
		...(params?.url ? { url: params.url } : {}),
	}
}

async function cmdProfileClose() {
	const state = await syncAgentState()
	const id = state.isolated?.windowId
	if (!Number.isInteger(id)) return { closed: [], tabs: 0, reason: '没有打开中的隔离实例' }
	const win = await chrome.windows.get(id).catch(() => null)
	const tabs = await chrome.tabs.query({ windowId: id }).catch(() => [])
	if (win !== null) {
		await chrome.windows.remove(id).catch(() => {})
		// 关完复查：`windows.remove` 可能被拒（窗口正在收尾、被别的扩展/策略挡住），
		// 那时**不能**报「已关」也不能把记录清掉——假装关掉的下场是下一次 launch 再开一个，
		// 用户屏幕上就多了一个来路不明的无痕窗口，而状态面还说是同一个。
		//
		// 但复查不能只查一次：`windows.remove` 的 promise 回来时，窗口列表**未必**已经摘掉
		// 这个窗口（实测就误报过一次「windows.remove 没有生效」——窗口其实已经关了，紧接着
		// 那几个标签页全返回 alreadyGone，状态页也是 incognito:{windows:0}）。所以轮询等它消失。
		const gone = await waitForWindowGone(id)
		if (!gone) {
			return { closed: [], tabs: tabs.length, reason: `windows.remove 没有生效，隔离窗口 ${id} 在 2 秒内仍在窗口列表里；稍后重试，或让用户自己关掉它` }
		}
	}
	// 归属/让出/目标都会指着这些标签页：窗口真的没了就一起清掉，别留幽灵状态。
	// （标签页消失时真 Chrome 也会逐个广播 tabs.onRemoved，走的是同一个 forgetOwned；
	//  这里显式再清一次是给「事件没送到」留的兜底，两次都幂等。）
	await forgetOwned(tabs.map((tab) => tab.id))
	state.isolated = null
	await persistAgentState()
	return { closed: win === null ? [] : [id], tabs: tabs.length }
}

async function cmdProfileStatus() {
	// 读命令报的是**此刻**的真实值：用户可能刚在扩展管理页打开无痕权限，缓存里的旧答案
	// 会让排障的人（和模型）以为这台机器永远开不了隔离实例。
	const allowed = await syncIncognitoAllowed({ refresh: true })
	const iso = await isolatedWindow()
	const windows = await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [])
	const all = await chrome.tabs.query({})
	const everyIncognito = all.filter((tab) => tab.incognito === true)
	// 隔离窗口里的标签页要**按窗口**数：用户自己也可能开着自己的无痕窗口，那几页不算
	// 「隔离实例」的一部分（数串了会把别人的窗口报成我们的，`active` 还会指到用户那页）。
	const inIsolated = iso === null ? [] : await chrome.tabs.query({ windowId: iso.id }).catch(() => [])
	return {
		instance: 'normal',
		incognitoAllowed: allowed,
		isolated: iso === null ? null : {
			windowId: iso.id,
			tabs: inIsolated.length,
			active: inIsolated.find((tab) => tab.active)?.id ?? null,
		},
		normal: { windows: windows.filter((win) => win.incognito !== true).length, tabs: all.length - everyIncognito.length },
		incognito: { windows: windows.filter((win) => win.incognito === true).length, tabs: everyIncognito.length },
	}
}

/* ------------------------------------------------------------- dispatching */

function handleBridgeMessage(msg) {
	if (msg.type === 'ping') { send({ type: 'pong', t: msg.t }); return; }
	if (msg.type === 'command' && typeof msg.id === 'string') {
		runCommand(msg.command, msg.params ?? {})
			.then((result) => send({ type: 'result', id: msg.id, ok: true, result }))
			.catch((err) => send({ type: 'result', id: msg.id, ok: false, error: String((err && err.message) || err) }));
	}
}

async function runCommand(command, params) {
	await syncHardLock();
	if (hardLocked) throw new Error(hardLockRefusal(command));
	const handler = COMMANDS[command];
	if (!handler) throw new Error(`unknown command: ${command}`);
	// 本条命令的策略：`resolveTab` / `tabs.open` 靠它知道该在哪个罐里干活。
	currentPolicy = policyOf(params);
	// 事件路径（`tabs.onActivated` / `tabs.onUpdated` / 输入探针的 binding）跑在命令之外，读不到这一条命令的
	// 信封，所以把要用的两位写进 session 里的策略快照。顺带回答设置页那句「改完下一条
	// 命令就生效」：关掉高亮之后，**下一条命令**就会把已经挂着的那圈收掉。
	await rememberPolicy(currentPolicy);
	// 接管浮层上的「中止操作」：只拦写页面那四条，且只在页面上的浮层还在时拦
	//（页面一导航浮层就没了，那时把存储里那条清掉并放行，不许假装还挡着）。
	const held = await holdRefusalFor(command, params);
	if (held !== null) throw new Error(held);
	// 用户接管了这个标签页：写操作在**发出之前**被拦下（零副作用），并说清怎么继续。
	const yielded = await yieldRefusalFor(command, params);
	if (yielded !== null) throw new Error(yielded);
	// 命令名对 `dbgSend` 有意义：只有 `eval` / `cdp.call` 里的 evaluate 能造出可信输入
	// （`execCommand('insertText')`），要按种类压掉；内部的读命令不能连坐（见 selfInputKindsOf）。
	runningCommand = command;
	try {
		return await handler(params);
	} finally {
		runningCommand = '';
	}
}

/* ------------------------------------------------------------ tab helpers */

/**
 * 这次解析走的是哪条路，写进结果里让模型知道「我没给 tabId 时打到了哪儿」。
 * `explicit` / `agent-target` / `active-tab` / `first-tab`。
 */
let lastTargetSource = 'none';

/**
 * 解析这次命令要作用在哪个标签页。
 *
 * 关键的一条是 `agent-target`：AI 自己开过（或用 `tabs.activate` / `tabs.group` 认领过）
 * 一个标签页之后，**不带 tabId 的命令就钉在它上面**，不再跟着用户切页面乱跑。
 * 这正是「AI 控制不与用户冲突」的实现方式——AI 不再被动地跟随用户视线，用户也就不必
 * 担心自己点开一个页面就把 AI 的工作流程带偏。反过来，从未认领过任何标签页时（全新会话）
 * 行为与历史版本一模一样：跟着用户正在看的那个标签页。
 *
 * @param tabId - 显式目标；省略时走默认目标。
 * @param jar - 这一条命令要在哪个罐里干活（`normal` / `incognito`）。**显式传**而不是只读全局：
 *   在那个「两条命令并发、其中一条正在切罐」的瞬间，全局会串（一次 `browser_profile use`
 *   与一条 `tabs.open` 同时发出就够）。默认值仍然取全局，漏传的调用点退化成旧行为。
 */
async function resolveTab(tabId, jar = currentPolicy.jar) {
	if (tabId !== undefined && tabId !== null) {
		const tab = await chrome.tabs.get(tabId);
		lastTargetSource = 'explicit';
		return tab;
	}
	const state = await syncAgentState();
	if (state.target !== null) {
		const target = await chrome.tabs.get(state.target).catch(() => null);
		if (target !== null) { lastTargetSource = 'agent-target'; return target; }
		// 目标标签页已经没了（用户关掉了它）：清掉指针，别让下一条命令继续指着它。
		state.target = null;
		await persistAgentState();
	}
	// 在隔离罐里干活时，默认目标先看那个无痕窗口：它通常**不是**当前聚焦窗口
	//（我们开它就是 focused:false），跟着 lastFocusedWindow 走会打到用户的页面上。
	if (jar === 'incognito') {
		const iso = await isolatedWindow();
		if (iso !== null) {
			const tabs = await chrome.tabs.query({ windowId: iso.id }).catch(() => []);
			const inside = tabs.find((tab) => tab.active === true) ?? tabs[0];
			if (inside !== undefined) { lastTargetSource = 'isolated-window'; return inside; }
		}
	}
	// 兜底那句「当前窗口的活动页」，只在**没有任何认领过的页**时才轮得到它。
	const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
	if (focused) { lastTargetSource = 'active-tab'; return focused; }
	const all = await chrome.tabs.query({});
	if (all.length > 0) { lastTargetSource = 'first-tab'; return all[0]; }
	throw new Error('no tab available');
}

/**
 * Wait until the navigation that is about to start has actually settled, and
 * say whether it did.
 *
 * Two mistakes this avoids, both of which let `nav` / `tabs.open` report a
 * settled page that was not there:
 *   - arming the listener AFTER `tabs.update` / `tabs.create` races the
 *     document swap: the tab still answers `status:'complete'` for the PREVIOUS
 *     document (a brand-new tab answers `complete` for about:blank), so a single
 *     `chrome.tabs.get` resolves the wait instantly against the old page;
 *   - a timeout that resolves silently is indistinguishable from success.
 * So: poll, insist on having seen the new document load (`status:'loading'`),
 * and report the outcome — `false` means the budget ran out while the new
 * document was still not in place.
 */
/** 比较目的地与真正落到的地址：忽略 hash 片段与末尾斜杠这类同文档差异。 */
function landsAt(tabUrl, expectedUrl) {
	if (typeof expectedUrl !== 'string' || expectedUrl.length === 0) return true;
	const norm = (u) => String(u ?? '').replace(/#.*$/, '').replace(/\/$/, '');
	return norm(tabUrl) === norm(expectedUrl);
}

function waitForNavigationComplete(tabId, timeoutMs, expectedUrl) {
	const started = Date.now();
	return new Promise((resolve) => {
		let sawLoading = false;
		const tick = async () => {
			const tab = await chrome.tabs.get(tabId).catch(() => null);
			if (tab) {
				if (tab.status === 'loading') sawLoading = true;
				else if (tab.status === 'complete') {
					if (sawLoading) return resolve(true);
					// No loading phase observed at all. Two very different things look
					// like this: the new document committed so fast we never polled a
					// loading state, and a navigation that never happened (a link that
					// turned into a download, a target Chrome refuses, a same-URL
					// no-op). The URL separates them — if the tab is not where we asked
					// it to be, nothing arrived and the caller must not say otherwise.
					if (Date.now() - started > 1200) return resolve(landsAt(tab.url, expectedUrl));
				}
			}
			if (Date.now() - started >= timeoutMs) return resolve(false);
			setTimeout(tick, 120);
		};
		void tick();
	});
}

/**
 * Await `promise`, but never longer than `ms`; resolve `fallback` on timeout or
 * rejection. CDP does not answer `Runtime.evaluate` while a navigation is stuck
 * before commit, so the post-navigation probes must not be able to outlive the
 * caller's budget (measured: an unbounded probe left `nav` unanswered for >40 s
 * while its own wait budget was 15 s).
 */
function withBudget(promise, ms, fallback) {
	return Promise.race([
		promise.catch(() => fallback),
		new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
	]);
}

/** 最小化窗口的错误：视口是 0×0，真实键盘/鼠标无处可落。 */
function windowMinimizedError() {
	const err = new Error('browser window is minimized — real keyboard/mouse input cannot reach a 0x0 viewport; restore the window manually (automation never changes window size or position)');
	err.code = 'window_minimized';
	return err;
}

/**
 * Bring the tab into a state where real input can land, WITHOUT touching window
 * geometry: tab activation never moves or resizes anything. The user's window
 * size/position/state (maximized included) is never modified.
 *
 * 两种聚焦策略（`params.policy.focus`）：
 *
 *   `auto` —— 历史行为：`windows.update({focused:true})` 把窗口抬到用户脸上，再切标签页。
 *   `avoid`（默认）—— **绝不**抬窗口。理由：CDP 的 `Input.*` 事件是在渲染进程上派发的，
 *     跟 OS 焦点无关（Puppeteer 对后台标签页点击就是这么做，从不 bringToFront）；
 *     而抬窗口是「AI 抢了用户正在用的桌面」这种冲突里最刺眼的那一种。所以这里只在
 *     「目标标签页本来就在用户正看着的那个窗口里」时才切标签页——那等于用户自己点了
 *     一下标签栏，是他眼前发生的、可预期的事；跨窗口则什么都不动，靠 CDP 把事件打进去。
 *
 * 最小化窗口仍然直接报错（两种策略都一样）：0×0 视口下 `elementFromPoint` 与滚动都不可信，
 * 与其猜，不如让用户自己恢复——自动化永远不改窗口尺寸与位置。
 *
 * @returns `{policy, windowFocused, tabActivated, skipped?}`，会原样进命令结果。
 */
async function activateTabWindow(tabId, focusPolicy = DEFAULT_POLICY.focus) {
	let tab, win;
	try {
		tab = await chrome.tabs.get(tabId);
		win = await chrome.windows.get(tab.windowId);
	} catch {
		// tab or window is closing; the command reports it downstream
		return { policy: focusPolicy, windowFocused: false, tabActivated: false, skipped: 'gone' };
	}
	if (win.state === 'minimized') throw windowMinimizedError();
	if (focusPolicy === 'auto') {
		try {
			await chrome.windows.update(win.id, { focused: true });
			await chrome.tabs.update(tabId, { active: true });
		} catch { /* tab may be closing; input will fail downstream anyway */ }
		return { policy: 'auto', windowFocused: true, tabActivated: true };
	}
	if (win.focused !== true) return { policy: 'avoid', windowFocused: false, tabActivated: false };
	try {
		await chrome.tabs.update(tabId, { active: true });
	} catch {
		return { policy: 'avoid', windowFocused: false, tabActivated: false };
	}
	return { policy: 'avoid', windowFocused: false, tabActivated: true };
}

/* ---------------------------------------------------------- debugger (CDP) — persistent attachment */

/**
 * 把记录下来的仿真意图重新发给页面（附着重建后、整页截图后各一次）。
 *
 * 失败一律吞掉：这只是"把页面样子补回去"的尽力而为，它坏了不该让当前这条命令失败。
 * 真正的判据仍然在工具结果里——`browser_emulate` 每次都读回页面**现场**看到的触摸能力。
 * @param tabId - 目标标签页。
 */
async function replayEmulation(tabId) {
	const saved = emulationState.get(Number(tabId));
	if (saved === undefined) return;
	await dbgSend(Number(tabId), 'Emulation.setTouchEmulationEnabled', saved.hasTouch
		? { enabled: true, maxTouchPoints: saved.maxTouchPoints }
		// 关的时候**不要**带 maxTouchPoints（Chrome 校验范围是 1-16，0 会被拒）。
		: { enabled: false }).catch(() => {});
}

/**
 * Ensure a persistent debugger attachment on `tabId`. Attaches once on first
 * CDP call and holds the attachment until explicit detach or tab close.
 * The Chrome "is being controlled" banner stays visible until detach.
 */
async function ensureAttached(tabId) {
	// 缓存命中也要补一次「探针可能缺失」的自愈检查。为什么必须在这里：装探针会失败
	// （最真实的形态是导航完成那一瞬间 `Runtime.evaluate` 拿到
	// `Cannot find default execution context`），失败之后 `probeArmed` 是空的；如果
	// 只在**首次附着**时才装，这条缓存会把重试永久挡住——用户动手 0 报告、AI 的写命令
	// 照常放行，而外观上毫无差别。独立审查把这条列为最坏的失效方向（静默、跨任意多条
	// 命令存活）。这段很便宜：`probeArmed` 命中即返回，只有缺失时才去查归属。
	if (attachedTabs.has(tabId)) {
		if (!probeArmed.has(tabId)) await ensureProbeFor(tabId).catch(() => {});
		return;
	}
	await new Promise((resolve, reject) => {
		chrome.debugger.attach({ tabId }, '1.3', () => {
			const err = chrome.runtime.lastError;
			if (!err) { attachedTabs.add(tabId); resolve(); return; }
			if (/already attached/i.test(err.message)) {
				attachedTabs.add(tabId);
				resolve();
				return;
			}
			reject(new Error(`debugger attach failed: ${err.message} (DevTools 打开着这个页面? 先关掉)`));
		});
	});
	// Enable the domains whose events we consume (dialogs, navigation results,
	// console + network capture for the browser_console_log / browser_network_log tools).
	await dbgSend(tabId, 'Page.enable').catch(() => {});
	await dbgSend(tabId, 'Runtime.enable').catch(() => {});
	await dbgSend(tabId, 'Network.enable').catch(() => {});
	// Bump the per-attached-tab generation so in-flight network entries queued
	// against an old attachment are not surfaced as if they were current.
	tabBufferGenerations.set(tabId, (tabBufferGenerations.get(tabId) ?? 0) + 1);
	// 输入探针必须在用户动手**之前**就位：附着是唯一的时机（`Runtime.addBinding` 只有
	// 附着着才存在）。只对 AI 自己的标签页装——`browser_read` 之类打到用户页面的命令
	// 不该因此往他的页面里塞一个探针，更不该为"监听"去承担自动应答弹窗的副作用。
	// 失败不连坐命令：拿不到探针时退回"没有接管信号"，而不是让这条命令失败。
	await ensureProbeFor(tabId).catch(() => {});
	// 新会话里 Chromium 的仿真已经全部复位（`EmulationHandler::Disable()`）：把页面
	// 该有的样子补回去，否则「工具说 touch 开着、页面里却什么都没有」会一直存在。
	await replayEmulation(tabId).catch(() => {});
}

/* Native dialog auto-answer: fires whenever the page opens alert/confirm/
 * prompt/beforeunload while a debugger is attached. Without an answer the
 * page's main thread stays blocked forever. */
chrome.debugger.onEvent.addListener((source, method, params) => {
	const tabId = source?.tabId;
	if (tabId === undefined) return;
	if (method === 'Page.javascriptDialogOpening') {
		const entry = {
			tabId, type: params.type, message: params.message,
			defaultPrompt: params.defaultPrompt, answeredAs: dialogPolicy, t: Date.now(),
		};
		dialogLog.push(entry);
		if (dialogLog.length > 50) dialogLog.shift();
		if (dialogPolicy === 'manual') return;
		chrome.debugger.sendCommand(
			{ tabId },
			'Page.handleJavaScriptDialog',
			{ accept: dialogPolicy === 'accept', promptText: params.defaultPrompt },
			() => void chrome.runtime.lastError,
		);
		return;
	}
	if (method === 'Runtime.bindingCalled') {
		// 页面探针报回来的真实输入（`Runtime.addBinding` 的回调）。这是**唯一**的接管信号：
		// 切标签页、切窗口、开弹窗都不再算（见 USER_INPUT_KINDS 上面那段）。
		// `payload` 是被调参数的 JSON 串（`window.__dshUserInput('pointerdown')` → `"pointerdown"`），
		// 种类要解析出来——抑制窗是按种类记的。
		if (params?.name === USER_INPUT_BINDING) void noteUserInput(tabId, bindingKindOf(params.payload));
		return;
	}
	if (method === 'Runtime.consoleAPICalled') {
		// Skip the noisy "log-type:verbose / "time-start" pseudo entries.
		const level = (params.type || 'log').toLowerCase();
		if (level === 'verbose' || level === 'timeStart' || level === 'timeEnd') return;
		const text = (params.args || []).map(arg => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type || '')).join(' ');
		let location;
		if (params.stackTrace && params.stackTrace.callFrames && params.stackTrace.callFrames[0]) {
			const f = params.stackTrace.callFrames[0];
			location = `${f.url || '<inline>'}:${f.lineNumber}`;
		}
		const entry = { tabId, level, text, t: params.timestamp ? Math.round(params.timestamp * 1000) : Date.now() };
		if (location) entry.location = location;
		const buf = consoleLog.get(tabId) || [];
		buf.push(entry);
		if (buf.length > 500) buf.shift();
		consoleLog.set(tabId, buf);
		return;
	}
	if (method === 'Network.requestWillBeSent') {
		// requestId from CDP; one per request. Key under the tab; the body is
		// capped at 64KB to keep the buffer from blowing up on large POSTs.
		const POST_LIMIT = 64 * 1024;
		const post = params.request.postData;
		const entry = {
			tabId,
			requestId: params.requestId,
			method: params.request.method,
			url: params.request.url,
			headers: params.request.headers,
			resourceType: params.type,
			postData: typeof post === 'string' && post.length > POST_LIMIT ? post.slice(0, POST_LIMIT) + '…(truncated)' : post,
			initiator: params.initiator && params.initiator.url,
			wallTime: params.wallTime,
		};
		let tabMap = networkLog.get(tabId);
		if (!tabMap) { tabMap = new Map(); networkLog.set(tabId, tabMap); }
		tabMap.set(params.requestId, entry);
		trimNetworkMap(tabMap);
		return;
	}
	if (method === 'Network.responseReceived') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.status = params.response.status;
		entry.statusText = params.response.statusText;
		entry.mimeType = params.response.mimeType;
		entry.responseHeaders = params.response.headers;
		return;
	}
	if (method === 'Network.loadingFinished') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.encodedDataLength = params.encodedDataLength;
		entry.finished = true;
		return;
	}
	if (method === 'Network.loadingFailed') {
		const tabMap = networkLog.get(tabId);
		if (!tabMap) return;
		const entry = tabMap.get(params.requestId);
		if (!entry) return;
		entry.failed = true;
		entry.errorText = params.errorText;
		entry.canceled = params.canceled;
		return;
	}
});

/** Cap a per-tab request map at 500 entries (LRU-by-insertion-order). */
function trimNetworkMap(tabMap) {
	if (tabMap.size <= 500) return;
	const overflow = tabMap.size - 500;
	const keys = tabMap.keys();
	for (let i = 0; i < overflow; i++) tabMap.delete(keys.next().value);
}

/** Drop every per-tab attachment artifact WITHOUT issuing a chrome.debugger
 *  call — safe to run from inside onDetach, where detaching again would be
 *  redundant. Deleting an unknown tabId is a no-op. */
function clearAttachment(tabId) {
	attachedTabs.delete(tabId);
	consoleLog.delete(tabId);
	networkLog.delete(tabId);
	tabBufferGenerations.delete(tabId);
	// 附着没了，页面里的 binding 也就没了：重连之后要重新装探针，别以为它还在。
	probeArmed.delete(Number(tabId));
	// 还没等到回报的派发记录也一并扔掉：换了新会话之后，那些债不该再吃掉真实输入。
	selfInputPending.delete(Number(tabId));
}

function detachTab(tabId) {
	clearAttachment(tabId);
	chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

function detachAll() {
	for (const tabId of [...attachedTabs]) detachTab(tabId);
}

/* Clean up when a tab is closed (detaches automatically, but remove from set). */
chrome.tabs.onRemoved.addListener((tabId) => {
	clearAttachment(tabId);
	// 标签页没了，这一页的仿真意图也就没人要了（见 emulationState）。
	emulationState.delete(Number(tabId));
	// 归属/让出/目标都指着 tabId：标签页没了就一起清掉，否则 `resolveTab` 会在
	// 下一条命令里发现目标已消失（它会自愈，但让「已关闭的标签页还挂着让出」这类
	// 幽灵状态留在存储里，等下次读出来就是一次假的「用户接管」）。
	void forgetOwned([tabId]);
});

/**
 * 用户自己切标签页 / 切窗口：这是「用户接管」的唯一来源。
 *
 * 两个监听都注册在顶层，service worker 被回收再唤醒时会重新注册——这是 MV3 里
 * 监听器能活过回收的唯一写法（在 async 函数里注册会随着 worker 一起消失）。
 */
chrome.tabs.onActivated.addListener((info) => {
	if (info === null || info === undefined || info.tabId === undefined) return;
	void noteUserActivation(info.tabId);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
	// 只剩一条职责：WINDOW_ID_NONE（-1）= 所有浏览器窗口都失焦，用户去了别的应用，
	// 让出结束（否则他切走之后 AI 会被永久锁死在一页上）。
	// 「窗口切回前台且当前页正是 AI 那一页」曾经也算接管，v1.1.5 起不算了——那只是看。
	if (windowId === chrome.windows.WINDOW_ID_NONE) void clearAllYields();
});

/**
 * 页面加载完成：如果这一页上本来挂着 AI 高亮框，补画一次。
 *
 * 导航会把注入的宿主连同旧文档一起丢掉，而「AI 正在操作」这件事没变。少了这条，框会在
 * 每次 `browser_navigate` / 点链接跳转之后消失，直到下一条命令才回来——用户看到的恰好是
 * 最需要指示的那段时间里没有指示。
 *
 * 判据只有一条：「这一页是不是记录里那个画着框的目标」。这里**不**额外判「桥还连着」：
 * 断线时 `clearHighlight()` 已经把那笔记录清空了，所以断线后的加载完成天然是空操作；
 * 多一道 `ws === null` 的闸门，只是让这条路径离不开真 socket 才能被测到。
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo === undefined || changeInfo.status !== 'complete') return;
	void repaintHighlightFor(tabId).catch(() => {});
	// 输入探针是文档级的：导航把旧文档连同监听一起丢了，这一页就再也报不出"用户动手"。
	// 重装只对已经附着的 AI 标签页做（见 rearmProbeIfAgentTab），不为装探针去附着新页面。
	void rearmProbeIfAgentTab(tabId).catch(() => {});
});

/* Invalidate the attachment cache whenever the debugger detaches, for ANY
 * reason. The cache is the only thing standing between an unexpected detach
 * (DevTools opened on the tab, a chrome-extension:// page, a navigation race)
 * and a clean re-attach: ensureAttached() returns early on a cache hit, so a
 * stale entry makes every later command fail with "Debugger is not attached"
 * forever. tabs.onRemoved also calls clearAttachment, so tab closures are
 * covered twice — harmless, the operation is idempotent. */
chrome.debugger.onDetach.addListener((source) => {
	const tabId = source?.tabId;
	if (tabId === undefined) return;
	clearAttachment(tabId);
});

/* Chrome reports a lost CDP session with one of these wordings. The cache can
 * still say "attached" when the detach event was missed (service-worker
 * restart, a race with DevTools), so dbgSend treats them as a cache-invalidating
 * signal and lets withCDP transparently re-attach once.
 *
 * "Cannot access a chrome-extension:// URL" is deliberately NOT in this list.
 * It belongs to the ATTACH path, not the send path: the observed form on a real
 * machine is "debugger attach failed: Cannot access a chrome-extension:// URL of
 * different extension", raised by chrome.debugger.attach() for a sibling
 * extension's page. chrome.debugger.sendCommand() has not been seen to produce
 * it, and a restricted target refuses attach permanently rather than
 * transiently, so treating it as a lost session would only buy one doomed
 * re-attach before the same error surfaced anyway. */
const DETACHED_RE = /not attached|Detached while handling|Inspected target navigated or closed/i;

/** 正在跑的扩展命令名（`dbgSend` 用它分辨"这条 evaluate 是不是模型自己的脚本"）。 */
let runningCommand = ''

/**
 * 这条 CDP 命令会让页面产生哪些「看起来像用户」的事件？（见 SELF_INPUT_TTL_MS 上面那段）
 *
 * 每种映射都必须和"页面真会收到什么"对齐——对不上就是自锁（漏登记）或者吞掉用户输入
 * （多登记）。当前依据：
 *   - `mousePressed` → 页面收到 `pointerdown`；`mouseReleased` 的 `click` 探针只认触屏，
 *     鼠标点击不报（所以这里不登记 `click`，登记了就是一条会 TTL 到期的债）。
 *   - 触屏：`touchStart` → `pointerdown`（探针按规则忽略触屏 pointerdown），
 *     `touchEnd` → `click`（探针只认这个）。
 *   - `dispatchKeyEvent`：`keyDown`/`rawKeyDown` 带 `text` 时 Chrome 会**插入字符**，
 *     页面因此同时收到 `keydown` 与 `input`（`cmdInput` 的 `type` 模式就是这条路，
 *     只登记 `keydown` 会让那个 `input` 被判成用户输入 → 打完字自锁）；`char` 只产生
 *     `input`；`keyUp` 什么都不产生。
 *   - `insertText` → `input`（CJK 与 emoji 走这条）。
 *   - `Runtime.evaluate` + `userGesture:true`：页面可以用 `document.execCommand('insertText')`
 *     造出**可信** `input`，而脚本只能从 `eval` / `cdp.call` 进来。内部的读命令也带
 *     `userGesture: true` 却不会打字，把它们算进来等于「AI 每读一次页面，用户接下来的
 *     第一次输入被吞」。
 *
 * @returns 种类数组；空数组 = 与输入无关。
 */
function selfInputKindsOf(method, params) {
	if (method === 'Input.dispatchMouseEvent') return params?.type === 'mousePressed' ? ['pointerdown'] : []
	if (method === 'Input.dispatchTouchEvent') return params?.type === 'touchEnd' ? ['click'] : []
	if (method === 'Input.insertText') return ['input']
	if (method === 'Input.dispatchKeyEvent') {
		const type = String(params?.type ?? '')
		const insertsText = typeof params?.text === 'string' && params.text.length > 0
		if (type === 'char') return insertsText ? ['input'] : []
		if (type === 'keyDown' || type === 'rawKeyDown') return insertsText ? ['keydown', 'input'] : ['keydown']
		return []
	}
	if (method === 'Runtime.evaluate' && params?.userGesture === true
		&& (runningCommand === 'eval' || runningCommand === 'cdp.call')) return ['input']
	return []
}

/** 登记"我们马上就要派发这几种事件"：`dbgSend` 在真正发出去之前调它。 */
function expectSelfInput(tabId, kinds) {
	const id = Number(tabId)
	if (!Number.isInteger(id) || kinds.length === 0) return
	let byKind = selfInputPending.get(id)
	if (byKind === undefined) {
		byKind = new Map()
		selfInputPending.set(id, byKind)
	}
	const at = Date.now()
	for (const kind of kinds) {
		const list = byKind.get(kind) ?? []
		list.push(at)
		byKind.set(kind, list)
	}
}

/**
 * 这一条回报是不是我们自己的？是就消一笔账并返回 `true`。
 * 过期的登记先剪掉：登记了却没等到回报（点进没装探针的 iframe、事件被页面吞掉）时，
 * 那条债最多在 TTL 内吃掉一次真实输入，不能永远留着。
 */
function consumeSelfInput(tabId, kind) {
	const byKind = selfInputPending.get(Number(tabId))
	const list = byKind?.get(String(kind ?? ''))
	if (list === undefined || list.length === 0) return false
	const now = Date.now()
	while (list.length > 0 && now - list[0] > SELF_INPUT_TTL_MS) list.shift()
	if (list.length === 0) return false
	list.shift()
	return true
}

function dbgSend(tabId, method, params) {
	// 我们自己派发的输入在页面里同样是 `isTrusted`：按"派发 → 回报"配对记一笔（见上）。
	expectSelfInput(tabId, selfInputKindsOf(method, params))
	return new Promise((resolve, reject) => {
		chrome.debugger.sendCommand({ tabId }, method, params ?? {}, (res) => {
			const err = chrome.runtime.lastError;
			if (!err) { resolve(res); return; }
			if (DETACHED_RE.test(err.message)) {
				// The cached entry is lying; drop it so the retry re-attaches.
				clearAttachment(tabId);
				const stale = new Error(`${method} failed: ${err.message}`);
				stale.code = 'cdp_detached';
				reject(stale);
				return;
			}
			reject(new Error(`${method} failed: ${err.message}`));
		});
	});
}

/** Persistent CDP: attaches (if not already) and holds. A command whose session
 *  was lost mid-flight re-attaches ONCE and replays — turning the old "detached
 *  means this tab is dead forever" behavior into a single transparent retry.
 *  A second failure propagates to the caller.
 *
 *  The replay is deliberately narrow: it happens ONLY when the first CDP call of
 *  the closure is the one that failed. Every later call means side effects have
 *  already landed on the page, so re-running the closure would fire them twice.
 *  That is not hypothetical — measured against a stubbed chrome.* on this repo,
 *  cmdClick's closure is evaluate(geometry) -> mouseMoved -> mousePressed ->
 *  mouseReleased, and replaying it after a detach on mouseReleased dispatched 6
 *  mouse events instead of 3, i.e. a second click reaching the page. cmdInput's
 *  mode:'type' is worse: each character is its own insertText, so a replay
 *  re-types part of the string. Single-shot read commands (browser_read,
 *  browser_snapshot) are idempotent and unaffected either way.
 *
 *  When the failure is NOT the first call the error is re-thrown untouched, and
 *  the caller re-issues the whole command. Semantically that is a NEW command,
 *  not a replay, which is the correct thing to ask of whoever wanted it. */
async function withCDP(tabId, fn) {
	let sends = 0;
	const call = (method, params) => { sends++; return dbgSend(tabId, method, params); };
	await ensureAttached(tabId);
	const started = sends;
	try {
		return await fn(call);
	} catch (error) {
		if (error?.code !== 'cdp_detached' || sends > started + 1) throw error;
		await ensureAttached(tabId);
		return fn(call);
	}
}

/* ------------------------------------------------------- command handlers */

async function cmdPing() {
	return { pong: true, t: Date.now(), version: EXT_VERSION };
}

/**
 * Return the recorded `Runtime.consoleAPICalled` entries for a tab. Filters
 * apply client-side so the model only sees the rows it asked for. `clear`
 * empties the buffer on the same call so the next call starts fresh; useful
 * for "give me the warnings that appeared after I clicked submit" without
 * earlier noise. `limit` defaults to 100, capped at 500.
 */
async function cmdConsoleLog(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
	// 工具描述承诺的是短名（`log` / `info` / `warn` / `error` / `debug`），但条目里
	// 存的是 CDP `Runtime.consoleAPICalled.type` 的原生名：`console.warn` 落进来是
	// `warning`。所以 `levels:['warn']` 曾经一条都查不到——两边名字必须在这层对齐，
	// 短名照旧可用，原生名（`warning`）也继续认。
	const LEVEL_ALIASES = { warn: 'warning' };
	const levels = Array.isArray(params.levels) && params.levels.length > 0
		? new Set(params.levels.map((l) => {
			const key = String(l).toLowerCase();
			return LEVEL_ALIASES[key] ?? key;
		}))
		: null;
	const pattern = typeof params.pattern === 'string' && params.pattern.length > 0
		? new RegExp(params.pattern, 'i')
		: null;
	const buf = consoleLog.get(tab.id) || [];
	const filtered = buf.filter((e) => {
		if (levels && !levels.has(e.level)) return false;
		if (pattern && !pattern.test(e.text || '')) return false;
		return true;
	});
	const tail = filtered.slice(-limit);
	if (params.clear === true) consoleLog.set(tab.id, []);
	return { tabId: tab.id, count: tail.length, total: filtered.length, entries: tail };
}

/**
 * Return merged request/response entries captured by `Network.*` events.
 * `includeStatic: true` surfaces images / fonts / stylesheets / scripts that
 * are filtered by default (they dominate the buffer in a typical page load).
 * `methodPattern` / `urlPattern` / `status` filter client-side.
 */
async function cmdNetworkLog(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const tabMap = networkLog.get(tab.id);
	const all = tabMap ? [...tabMap.values()] : [];
	const includeStatic = params.includeStatic === true;
	const methodPattern = typeof params.methodPattern === 'string' && params.methodPattern.length > 0
		? new RegExp(params.methodPattern, 'i')
		: null;
	const urlPattern = typeof params.urlPattern === 'string' && params.urlPattern.length > 0
		? new RegExp(params.urlPattern, 'i')
		: null;
	const statusFilter = typeof params.status === 'string' && params.status.length > 0 ? params.status : null;
	const staticTypes = new Set(['Image', 'Font', 'Stylesheet', 'Script', 'Favicon', 'Manifest']);
	const filtered = all.filter((e) => {
		if (!includeStatic && staticTypes.has(e.resourceType)) return false;
		if (methodPattern && !methodPattern.test(e.method || '')) return false;
		if (urlPattern && !urlPattern.test(e.url || '')) return false;
		if (statusFilter) {
			if (e.failed) {
				if (!/^f/i.test(statusFilter)) return false;
			} else if (e.status === undefined) {
				if (!/^p/i.test(statusFilter)) return false; // pending
			} else if (statusFilter === '2xx' && (e.status < 200 || e.status >= 300)) return false;
			else if (statusFilter === '3xx' && (e.status < 300 || e.status >= 400)) return false;
			else if (statusFilter === '4xx' && (e.status < 400 || e.status >= 500)) return false;
			else if (statusFilter === '5xx' && (e.status < 500 || e.status >= 600)) return false;
		}
		return true;
	});
	filtered.sort((a, b) => (a.wallTime || 0) - (b.wallTime || 0));
	const limit = Math.min(1000, Math.max(1, Number(params.limit) || 200));
	const out = filtered.slice(-limit).map((e) => {
		const { requestId: _id, tabId: _t, ...rest } = e;
		return rest;
	});
	if (params.clear === true) networkLog.set(tab.id, new Map());
	return { tabId: tab.id, count: out.length, total: filtered.length, requests: out };
}

async function cmdNetworkClear(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	networkLog.set(tab.id, new Map());
	return { tabId: tab.id, cleared: true };
}

/** Largest CDP result this bridge hands back to the model, in JSON characters.
 *  A screenshot or MHTML snapshot is orders of magnitude bigger than a useful
 *  model-facing payload; the caller is told the real size and told to switch to
 *  `screenshot` / `pdf` (which save to disk) instead of paying for it here. */
const CDP_RESULT_MAX_CHARS = 20_000;

/**
 * Raw CDP escape hatch (`browser_cdp` on the model face). Any `Domain.method`
 * string is forwarded verbatim through the persistent debugger attachment, so
 * this single command can reach every CDP domain — including ones no dedicated
 * tool wraps (`Page.captureSnapshot`, `Network.getAllCookies`,
 * `Performance.getMetrics`, `Fetch.enable`, …).
 *
 * The result is serialized to JSON here, on the extension side, for two
 * reasons: the result frame is text-only (no separate binary channel), and the
 * serialization itself is what lets us cap the payload honestly (bytes + a
 * `truncated` flag) instead of silently blowing the model's context.
 */
async function cmdCdpCall(params) {
	const tab = await resolveTab(params?.tabId, policyOf(params).jar);
	const method = String(params?.method ?? '').trim();
	if (!/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method)) {
		throw new Error(`cdp.call needs a CDP method like "Page.captureSnapshot", got ${JSON.stringify(method)}`);
	}
	const rawParams = params?.params;
	if (rawParams !== undefined && (rawParams === null || typeof rawParams !== 'object' || Array.isArray(rawParams))) {
		throw new Error('cdp.call params must be a JSON object (got ' + (Array.isArray(rawParams) ? 'array' : typeof rawParams) + ')');
	}
	const cdpParams = rawParams ?? {};
	// 不走 withCDP 的「首个 CDP 调用失败就重连并重放」：这条命令本身就可能是
	// 一次不可撤销的写（Page.navigate / Network.setCookie / Browser.close）。
	// 会话丢失时副作用是否已经发生无法确定，正确的报告是让插件按写操作报
	// effectState=unknown，而不是悄悄再发一次、可能做两遍。
	await ensureAttached(tab.id);
	const raw = await dbgSend(tab.id, method, cdpParams);
	let json;
	try {
		json = JSON.stringify(raw ?? null);
	} catch (error) {
		// A CDP result can contain values JSON cannot represent (e.g. a
		// RemoteObject holder); report that instead of throwing later in the
		// frame encoder.
		json = JSON.stringify({ unserializable: String((error && error.message) || error) });
	}
	const bytes = json.length;
	const truncated = bytes > CDP_RESULT_MAX_CHARS;
	return {
		tabId: tab.id,
		method,
		json: truncated ? `${json.slice(0, CDP_RESULT_MAX_CHARS)}…[truncated]` : json,
		bytes,
		truncated,
	};
}

/* ------------------------------------------- 出图（截图 / PDF）的可见性与预算 */

/**
 * 出图类 CDP 调用**自己的**预算（毫秒）。
 *
 * `Page.captureScreenshot` / `Page.printToPDF` 在窗口**最小化**（或完全被遮挡）时不产帧，
 * 而且它不报错——就一直不回来。`dbgSend` 本身没有超时，于是这条命令会一路挂到桥的 60 秒
 * 天花板，模型收到的只是一句通用的 `effectState: not_started`，看不出真正原因
 * （用户 2026-10-29 实测两次，各吃满 60 秒）。这里自己定一个上限：超了带着原因放弃，
 * 总比"什么都没发生地等 60 秒"有用。
 *
 * 用 `let` 而不是 `const`：验台要把它压到几十毫秒，才能真把「挂着不返回」这条路径测出来。
 */
let CAPTURE_BUDGET_MS = 15000

/**
 * 等 `promise` 最多 `ms`；超时以 `code: 'capture_timeout'` 拒绝。
 *
 * 注意这里**不重放**：出图是只读的，重放没有意义；而 `withCDP` 的自动重连只认
 * `cdp_detached`，所以超时会原样抛给调用方（与「断线重放一次」互不干扰）。
 * 底下那次 CDP 调用会一直挂着直到浏览器自己回话或标签页消失——纯挂着，零副作用。
 * @param promise - 已经发出去的 CDP 调用。
 * @param ms - 预算（毫秒）。
 * @param what - 出现在错误文案里的动作名。
 */
function withCaptureBudget(promise, ms, what) {
	let timer = null
	const timeout = new Promise((_resolve, reject) => {
		timer = setTimeout(() => {
			const error = new Error(
				`${what} 在 ${Math.round(ms)} 毫秒内没有返回：窗口最小化或被完全遮挡时，CDP 的出图调用`
				+ '不产帧、也不报错，只会一直挂着。这次已经放弃——出图是只读操作，页面上没有留下任何副作用；'
				+ '先把那个浏览器窗口恢复可见（或改用另一个可见窗口里的标签页）再重试。',
			)
			error.code = 'capture_timeout'
			reject(error)
		}, ms)
	})
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== null) clearTimeout(timer)
	})
}

/**
 * 出图前先看窗口状态：最小化的窗口上截图会**挂住**，不是慢。
 *
 * 能当场判断的事就别花 15 秒去等。这一条让「最小化」这种确定性情形立刻失败，
 * 并给出唯一有用的下一步；而真正的兜底是 {@link withCaptureBudget}（其它不产帧的形态，
 * 例如窗口被完全遮挡，未必能从 `windows.get` 看出来）。
 * @param tab - 目标标签页（需要 `.id` 与 `.windowId`）。
 * @param what - 出现在错误文案里的动作名。
 */
async function assertFrameableWindow(tab, what) {
	const win = await chrome.windows.get(tab.windowId).catch(() => null)
	if (win === null || win.state !== 'minimized') return
	throw new Error(
		`${what} 需要一个真的会产帧的窗口：标签页 ${tab.id} 所在的窗口现在是「最小化」。`
		+ 'CDP 在这种窗口上不会报错，只会一直不返回（实测会吃满 60 秒），重试多少次都一样。'
		+ '先把那个浏览器窗口恢复（或改用另一个可见窗口里的标签页）。',
	)
}

/**
 * `Page.printToPDF` returns base64-encoded PDF. The extension's MV3 SW cannot
 * write to absolute paths on the host; the bridge decodes the base64 to a
 * `path` the caller supplies (or to `<shotsDir>/<tabId>-<t>.pdf` when no path
 * is given). The result echoes the saved path + size so callers can hand it
 * off to a reader tool.
 */
async function cmdPdf(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	await assertFrameableWindow(tab, '导出 PDF');
	// 打印也得躲开我们自己的高亮层：`position: fixed` 的描边与徽标会在**每一页**重复出现。
	const shouldHide = await highlightOnTab(tab.id);
	return withCDP(tab.id, async (send) => {
		const cdpParams = {
			printBackground: params.printBackground !== false,
			landscape: params.landscape === true,
			...(typeof params.paperWidth === 'number' ? { paperWidth: params.paperWidth } : {}),
			...(typeof params.paperHeight === 'number' ? { paperHeight: params.paperHeight } : {}),
			...(typeof params.scale === 'number' ? { scale: params.scale } : {}),
			...(params.pageRanges ? { pageRanges: String(params.pageRanges) } : {}),
		};
		// 预算只罩住**打印本身**，不罩「藏高亮 → 还原」：万一超时，`withHighlightHidden`
		// 的 finally 仍然会跑，页面上那圈框不会被永久藏掉。
		const res = await withHighlightHidden(send, shouldHide, () =>
			withCaptureBudget(send('Page.printToPDF', cdpParams), CAPTURE_BUDGET_MS, '导出 PDF（Page.printToPDF）'));
		if (!res || !res.data) throw new Error('Page.printToPDF returned no data');
		return { tabId: tab.id, base64: res.data };
	});
}

/**
 * Apply `Emulation.setDeviceMetricsOverride` + `setUserAgentOverride` +
 * `setTouchEmulationEnabled` to switch how the page renders. Presets cover
 * the common shapes (desktop / iphone / ipad / pixel); a custom object
 * overrides any field. Restoring back to desktop is `device:"reset"` so
 * the agent can clean up after itself.
 */
async function cmdEmulate(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const preset = params.device && params.device !== 'reset' ? PRESETS[String(params.device).toLowerCase()] : null;
	if (params.device && params.device !== 'reset' && !preset && typeof params.device === 'string') {
		throw new Error(`unknown device preset "${params.device}". Use one of: ${Object.keys(PRESETS).join(', ')}, reset, or pass width/height fields directly.`);
	}
	const width = Number(params.width ?? (preset && preset.width) ?? 0);
	const height = Number(params.height ?? (preset && preset.height) ?? 0);
	const deviceScaleFactor = Number(params.deviceScaleFactor ?? (preset && preset.deviceScaleFactor) ?? 1);
	const isMobile = params.isMobile ?? (preset && preset.isMobile) ?? false;
	const hasTouch = params.hasTouch ?? (preset && preset.hasTouch) ?? false;
		const userAgent = params.userAgent || (preset && preset.userAgent) || undefined;
	return withCDP(tab.id, async (send) => {
		// 每一步都记账：以前这里三条 `.catch(() => {})` 之后无条件回 `{reset:true}`，
		// 清理失败也报成功，模型于是以为已经复位（用户 2026-10-29 报的就是这条）。
		const failures = [];
		const step = async (name, action) => {
			try { await action(); return true; }
			catch (error) {
				// `dbgSend` 已经会把 CDP 方法名放在消息前面（`Emulation.x failed: …`），
				// 这里只在它没提及时补一次步骤名，免得同一句里出现两遍。
				const message = String((error && error.message) || error);
				failures.push(message.includes(name) ? message : `${name}: ${message}`);
				return false;
			}
		};
		if (params.device === 'reset') {
			const cleared = await Promise.all([
				step('clearDeviceMetricsOverride', () => send('Emulation.clearDeviceMetricsOverride')),
				step('setUserAgentOverride', () => send('Emulation.setUserAgentOverride', { userAgent: '' })),
				step('setTouchEmulationEnabled', () => send('Emulation.setTouchEmulationEnabled', { enabled: false })),
			]);
			const touch = await touchStateOf(send);
			// 复位之后就没有"该有的样子"了：别在下一次附着时又把它补回来。
			emulationState.delete(tab.id);
			return {
				tabId: tab.id,
				// `reset` 只在**每一步都成功**时才是 true；否则如实说没复位。
				reset: cleared.every((ok) => ok === true),
				...(failures.length === 0 ? {} : { resetFailures: failures }),
				...touch,
			};
		}
		if (width > 0 && height > 0) {
			await send('Emulation.setDeviceMetricsOverride', {
				width, height, deviceScaleFactor, mobile: isMobile,
			}).catch((e) => { throw new Error(`setDeviceMetricsOverride failed: ${e.message}`); });
		}
		if (userAgent) {
			await step('setUserAgentOverride', () => send('Emulation.setUserAgentOverride', { userAgent }));
		}
		// `maxTouchPoints` 必须显式给：不给时 `navigator.maxTouchPoints` 是 0/1，
		// 站点据此判「不是触摸设备」，就算事件能派发也适配错。
		await step('setTouchEmulationEnabled', () => send('Emulation.setTouchEmulationEnabled', hasTouch === true
			? { enabled: true, maxTouchPoints: TOUCH_MAX_POINTS }
			: { enabled: false }));
		// 读回页面**真实**看到的触摸能力：仿真开关成功不等于页面看得见（见 touchStateOf）。
		const touch = await touchStateOf(send);
		// 记住"这一页该有的样子"：CDP 会话重建和整页截图都会把它悄悄撤掉（见 emulationState）。
		emulationState.set(tab.id, { hasTouch: hasTouch === true, maxTouchPoints: TOUCH_MAX_POINTS });
		return {
			tabId: tab.id,
			width, height, deviceScaleFactor, isMobile, hasTouch,
			userAgent: userAgent || null,
			...touch,
			...(failures.length === 0 ? {} : { warnings: failures }),
		};
	});
}

/** 触摸仿真报给 `navigator.maxTouchPoints` 的点数（现代手机普遍报 5）。 */
const TOUCH_MAX_POINTS = 5

/**
 * 读回页面**真正看到**的触摸能力。
 *
 * 实测（Edge 156，2026-10-29，逐个组合试过）：`Emulation.setTouchEmulationEnabled{enabled:true,
 * maxTouchPoints:5}` 之后 `navigator.maxTouchPoints` 立刻变成 5、`(pointer: coarse)` 也为真，
 * 但 `'ontouchstart' in window` **仍然是 false**；再补一次
 * `Emulation.setDeviceMetricsOverride{mobile:true}` 也救不回来；只有**页面导航一次**之后，
 * `ontouchstart` / `ontouchmove` 才出现（Blink 把 touch-event 这个 runtime feature 按文档锁定，
 * 改它只对之后加载的文档生效）。
 *
 * 所以这里把真实值报回去，而不是重复一遍我们的意图：工具不许在页面看不到的情况下
 * 宣称「touch 已启用」。读不到（受限页面 / 无执行上下文）就返回空对象，不猜。
 * @param send - 这个标签页的 CDP 发送函数。
 */
async function touchStateOf(send) {
	const res = await send('Runtime.evaluate', {
		expression: `({ ontouchstart: 'ontouchstart' in window, maxTouchPoints: navigator.maxTouchPoints })`,
		awaitPromise: false, returnByValue: true,
	}).catch(() => null);
	const value = res && res.result ? res.result.value : null;
	if (value === null || typeof value !== 'object') return {};
	return {
		touchVisible: value.ontouchstart === true,
		pageMaxTouchPoints: Number(value.maxTouchPoints) || 0,
	};
}

const PRESETS = {
	desktop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false, userAgent: '' },
	'mobile-iphone-13': { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
	'mobile-pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
	'tablet-ipad': { width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
};

async function cmdBrowserInfo() {
	// 隔离实例的可达性也在这里报一次：模型（和排障的人）第一件事就是看「能不能开无痕罐」。
	// 现读而不是用缓存——这条命令就是用来回答「现在到底行不行」的。
	const iso = await isolatedWindow().catch(() => null);
	return {
		client: 'dsh-browser-extension',
		version: EXT_VERSION,
		browser: helloInfo,
		incognitoAllowed: await syncIncognitoAllowed({ refresh: true }).catch(() => false),
		isolatedWindowId: iso === null ? null : iso.id,
	};
}

/**
 * Every tab, with the two flags that decide what the agent may do with it:
 * `owned` (opened by the agent, or sitting in a DSH group) and `yielded`
 * (the user took it over, so writes there are refused until they leave).
 *
 * `agentTargetTabId` answers the other half of the question: where a command
 * *without* `tabId` will land. `null` means "the tab you are looking at", which
 * is the pre-4 behaviour and still the default for a session that never claimed
 * a tab of its own.
 */
async function cmdTabsList() {
	const tabs = await chrome.tabs.query({});
	const state = await syncAgentState();
	const owned = await ownedTabIds();
	// Compact shape (id/url/active/title + the flags): the bridge serializes this
	// straight into a tool result and wide shapes were truncating mid-JSON.
	return {
		count: tabs.length,
		activeTabId: tabs.find((t) => t.active)?.id,
		agentTargetTabId: state.target,
		isolatedWindowId: state.isolated?.windowId ?? null,
		tabs: tabs.map((t) => ({
			id: t.id,
			url: t.url,
			title: t.title,
			active: t.active,
			windowId: t.windowId,
			owned: owned.has(Number(t.id)),
			yielded: state.yields[t.id] !== undefined,
			incognito: t.incognito === true,
		})),
	};
}

/* ------------------------------------------------------ agent tab grouping */

/**
 * Tabs the agent opens get collected into one labelled, coloured group per
 * window, so a human can see at a glance which tabs a machine is driving and
 * sweep them away afterwards. Grouping straight after `tabs.create` races
 * Chrome's own tab bookkeeping, hence the short backoff.
 *
 * 组名由用户决定（设置里的 `tabGroupTitle`，或某一次调用的 `groupTitle` 参数），
 * `DSH` 只是默认值；`GROUP_TITLE_MAX` 同时被上面的 `groupTitleOf` 用着（插件侧与
 * 设置页用的是同一个数）。
 */
const LEGACY_GROUP_TITLE = 'DSH';
const AGENT_GROUP_COLOR = 'blue';
const GROUP_TITLE_MAX = 40;
const GROUP_RETRY_DELAYS_MS = [50, 150, 400];

/**
 * 「我们的组」= **我们建过（或加入过）的那个组**，按 **groupId 记在 session 里**。
 *
 * 为什么不按标题认（第一版就是那么写的，被审查打回来了）：用户完全可能把
 * `tabGroupTitle` 设成他自己也在用的名字——「工作」「调研」「临时」都是极自然的选择。
 * 按标题认的话，他那个组里的标签页会**突然变成 AI 的**：`tabs.close` 不必 `force` 就能
 * 关（那些页面找不回来），`tabs.ungroup` 还会把他自己的分组拆掉。两条都不可逆，而放宽
 * 的方向只能靠用户「猜到这个巧合」来规避，所以改成按 id 记：同名也不合并、不串。
 *
 * 反过来，「把标签页拖进 AI 那个组 = 认领」这条手势照旧成立——拖进去的正是这张表里的组。
 */

/**
 * normal 罐的落点窗口。**必须显式挑**，不能靠 `chrome.tabs.create` 的默认值。
 *
 * 实测过的串罐：`chrome.tabs.create({url})` 不传 windowId 时落点是「当前窗口」，而"当前"
 * 是**最后被激活过的那个 window**——我们刚为隔离实例建的无痕窗口即便 `focused:false`，
 * 也会成为默认落点。于是 `jar=normal` 的 `tabs.open` 把标签页生进了无痕窗口（`incognito:true`），
 * 宿主以为在 normal 罐、登录态却在另一个罐里，静默串掉。
 *
 * 顺序：显式 windowId（必须真的是 normal 窗口）→ 当前目标所在窗口（若在 normal 罐）→
 * 最后聚焦的 normal 窗口 → 任一 normal 窗口 → `null`（调用方新建一个 normal 窗口）。
 * 显式点名了无痕窗口却声称 `jar=normal` 时**报错**——这种矛盾不能让插件自己猜。
 */
async function normalWindowId(preferred) {
	const isNormal = (win) => win !== null && win !== undefined && win.incognito !== true
	if (preferred !== undefined && preferred !== null) {
		const win = await chrome.windows.get(Number(preferred)).catch(() => null)
		if (win === null) throw new Error(`window ${preferred} 不存在`)
		if (!isNormal(win)) {
			throw new Error(`window ${preferred} 是无痕窗口，但这次按 normal 罐执行（policy.jar=normal）。要对隔离罐操作请先用 browser_profile use jar=incognito——不要指望插件替你换罐。`)
		}
		return win.id
	}
	const state = await syncAgentState()
	if (state.target !== null) {
		const target = await chrome.tabs.get(state.target).catch(() => null)
		if (target !== null && target.incognito !== true && Number.isInteger(target.windowId)) return target.windowId
	}
	const windows = await chrome.windows.getAll({ populate: false }).catch(() => [])
	const normal = windows.filter((win) => isNormal(win) && Number.isInteger(win.id))
	if (normal.length === 0) return null
	const focused = normal.find((win) => win.focused === true)
	return (focused ?? normal[normal.length - 1]).id
}

/** 等窗口真的从 Chrome 的窗口列表里消失；返回是否等到了。 */
async function waitForWindowGone(windowId, timeoutMs = 2000) {
	const id = Number(windowId)
	const started = Date.now()
	for (;;) {
		const win = await chrome.windows.get(id).catch(() => null)
		if (win === null) return true
		if (Date.now() - started >= timeoutMs) return false
		await sleep(60)
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tabGroupsAvailable() {
	return typeof chrome.tabGroups?.update === 'function' && typeof chrome.tabs?.group === 'function';
}

/** 记住一个组是我们的（建组成功、或加入已有组之后调用）。 */
async function rememberAgentGroup(groupId, title, windowId) {
	const state = await syncAgentState();
	state.groups[Number(groupId)] = { title: String(title), windowId: Number(windowId), at: Date.now() };
	await persistAgentState();
}

/**
 * 这张表里当前**还活着**的组 id（用户把组拆了、或关掉最后一个标签页，记录顺手丢掉）。
 * @returns 组 id 的集合。
 */
async function ourGroupIds() {
	const state = await syncAgentState();
	const recorded = Object.keys(state.groups).map(Number).filter((id) => Number.isInteger(id));
	if (recorded.length === 0) return new Set();
	const live = await chrome.tabGroups.query({}).catch(() => []);
	const alive = new Set(live.map((group) => Number(group.id)));
	let pruned = false;
	for (const id of recorded) {
		if (alive.has(id)) continue;
		delete state.groups[id];
		pruned = true;
	}
	if (pruned) await persistAgentState();
	return new Set(recorded.filter((id) => alive.has(id)));
}

/** 这个窗口里已经属于我们的、叫这个名字的组（没有就 `undefined`，调用方去建一个新的）。 */
async function findAgentGroup(windowId, title) {
	const live = new Set(
		(await chrome.tabGroups.query({ windowId: Number(windowId) }).catch(() => [])).map((group) => Number(group.id)),
	);
	const state = await syncAgentState();
	for (const [rawId, entry] of Object.entries(state.groups)) {
		const id = Number(rawId);
		if (entry.title !== title || entry.windowId !== Number(windowId) || !live.has(id)) continue;
		return id;
	}
	return undefined;
}

/** Put one tab in the window's group with this title, creating the group if needed. */
async function addToAgentGroup(tabId, title) {
	if (!tabGroupsAvailable()) {
		return { grouped: false, reason: 'tabGroups API 不可用（需 Chrome ≥ 89 且已授予 tabGroups 权限）' };
	}
	// 空串在调用方已经变成 `null`（= 这一次不分组）；这里只做归一，**不做** `|| 'DSH'`
	// 兜底——那会把「我不想有分组」悄悄变回默认组。真收到空串就当没分组处理。
	const wanted = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_TITLE_MAX);
	if (wanted.length === 0) return { grouped: false, reason: 'grouping-disabled' };
	let lastError = 'unknown';
	for (let attempt = 0; attempt <= GROUP_RETRY_DELAYS_MS.length; attempt += 1) {
		const tab = await chrome.tabs.get(tabId).catch(() => null);
		if (tab === null || tab.windowId === undefined) return { grouped: false, reason: '标签页已不存在' };
		try {
			const existing = await findAgentGroup(tab.windowId, wanted);
			if (existing !== undefined) {
				await chrome.tabs.group({ tabIds: [tabId], groupId: existing });
				return { grouped: true, groupId: existing, groupTitle: wanted, created: false };
			}
			const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
			await chrome.tabGroups.update(groupId, { title: wanted, color: AGENT_GROUP_COLOR });
			await rememberAgentGroup(groupId, wanted, tab.windowId);
			return { grouped: true, groupId, groupTitle: wanted, created: true };
		} catch (error) {
			lastError = error?.message ?? String(error);
			const wait = GROUP_RETRY_DELAYS_MS[attempt];
			if (wait === undefined) break;
			await sleep(wait);
		}
	}
	return { grouped: false, reason: lastError };
}

/** Release every agent group (one window, or all) back to plain tabs. */
async function dissolveAgentGroups(windowId) {
	if (!tabGroupsAvailable()) return { ungrouped: 0, groups: 0, released: [], reason: 'tabGroups API 不可用' };
	const state = await syncAgentState();
	const recorded = Object.keys(state.groups).map(Number).filter((id) => Number.isInteger(id));
	// 只拆**我们的**组：用户的同名组一个都不动（那是他自己整理的分组）。
	const scoped = windowId === undefined
		? recorded
		: recorded.filter((id) => state.groups[id]?.windowId === Number(windowId));
	const released = [];
	let groups = 0;
	for (const groupId of scoped) {
		const live = await chrome.tabGroups.get(groupId).catch(() => null);
		delete state.groups[groupId];
		if (live === null) continue;
		groups += 1;
		const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
		const ids = tabs.map((t) => t.id).filter((id) => id !== undefined);
		if (ids.length === 0) continue;
		try {
			await chrome.tabs.ungroup(ids);
			released.push(...ids);
		} catch { /* 用户可能已经手动拆开了 */ }
	}
	await persistAgentState();
	return { ungrouped: released.length, groups, released };
}

async function cmdTabGroup(params) {
	if (params?.tabId === undefined) throw new Error('params.tabId is required');
	const tabId = Number(params.tabId);
	const title = groupTitleOf(params);
	// 分组被用户关掉了（`tabGroupTitle` 是空串）或这一次显式不分：**认领照做，组不建**。
	// 报错会让「归组=认领」这个手势在配置为「不分组」时彻底失效，而用户想要的只是别建组。
	const result = title === null
		? { grouped: false, reason: params?.group === false ? 'group:false' : 'grouping-disabled' }
		: await addToAgentGroup(tabId, title);
	if (result.grouped !== true && result.reason !== 'grouping-disabled' && result.reason !== 'group:false') {
		throw new Error(`group failed: ${result.reason}`);
	}
	// 归组 = 认领：这一个标签页算 AI 的，并且成为后续不带 tabId 的命令的默认目标。
	await claimTab(tabId, { own: true });
	return { tabId, ...result, owned: true, agentTargetTabId: tabId };
}

async function cmdTabUngroup(params) {
	const result = await dissolveAgentGroups(params?.windowId);
	// 拆组 = 放手：那几个标签页不再是 AI 的，`tabs.close` 从此需要 force 才肯动它们。
	await forgetOwned(result.released ?? []);
	return { ungrouped: result.ungrouped, groups: result.groups, ...(result.reason ? { reason: result.reason } : {}) };
}

async function cmdTabsOpen(params) {
	if (!params.url) throw new Error('params.url is required');
	const policy = policyOf(params);
	const active = params.active !== undefined ? Boolean(params.active) : true;
	let created;
	let newWindow = false;
	let isolated = false;
	if (policy.jar === 'incognito') {
		// 隔离罐优先：先把无痕窗口要到手，再在**它里面**开标签页。`tabs.create` 的
		// `incognito` 是只读属性，只能靠 windowId 决定它生在哪个罐里。
		if (params.windowId !== undefined) {
			const named = await chrome.windows.get(Number(params.windowId)).catch(() => null)
			if (named === null || named.incognito !== true) {
				throw new Error(`window ${params.windowId} 不是无痕窗口，但这次按 incognito 罐执行；隔离罐里开标签页请不要指定 windowId（会自动落在隔离窗口里）`)
			}
		}
		const { window: isoWin } = await ensureIsolatedWindow();
		created = await chrome.tabs.create({ url: params.url, active, windowId: isoWin.id });
		isolated = true;
	} else if (policy.tabs === 'new-window') {
		// `focused: false` 是新窗口策略里唯一重要的一位：开自己的窗口，但**不许**把用户
		// 正在用的窗口顶下去。给新窗口第一个标签页当目标是 Chrome 的默认行为。
		const win = await chrome.windows.create({ url: params.url, focused: false, type: 'normal' });
		newWindow = true;
		const inNewWindow = Array.isArray(win?.tabs) && win.tabs.length > 0
			? win.tabs[0]
			: (await chrome.tabs.query({ windowId: win?.id }))[0];
		if (inNewWindow === undefined || inNewWindow.id === undefined) throw new Error('新窗口创建了，但它的标签页还没露出来（再调一次 tabs.list 看看）');
		created = inNewWindow;
	} else {
		// normal 罐：**显式挑窗口**。不传 windowId 的「当前窗口」指的是最后被激活过的那个，
		// 我们刚建的无痕窗口即使 focused:false 也会中招——标签页会被生进无痕罐（实测过）。
		const windowId = await normalWindowId(params.windowId)
		if (windowId === null) {
			// 一个 normal 窗口都没有（用户全关了，只剩我们那扇无痕窗）：显式开一个，
			// 否则 `tabs.create` 又会落进无痕窗口。
			const win = await chrome.windows.create({ url: params.url, focused: false, type: 'normal' })
			newWindow = true
			const inNewWindow = Array.isArray(win?.tabs) && win.tabs.length > 0
				? win.tabs[0]
				: (await chrome.tabs.query({ windowId: win?.id }))[0]
			if (inNewWindow === undefined || inNewWindow.id === undefined) throw new Error('normal 窗口创建了，但它的标签页还没露出来（再调一次 tabs.list 看看）')
			created = inNewWindow
		} else {
			created = await chrome.tabs.create({ url: params.url, active, windowId })
		}
	}
	const timeoutMs = Number(params.timeoutMs) || 15_000;
	// Arm the waiter before the tab starts loading: a created tab is born on
	// about:blank and reports `complete` immediately, so a waiter armed
	// afterwards can conclude "already settled" while the requested URL has not
	// even started.
	const settled = params.wait === false ? true : await waitForNavigationComplete(created.id, timeoutMs, params.url);
	const fresh = await chrome.tabs.get(created.id).catch(() => null);
// A pending navigation is not visible in `url` (a tab that has not committed
	// anything yet reports an empty url); `pendingUrl` is where it is heading.
	const pendingUrl = fresh?.pendingUrl && fresh.pendingUrl !== fresh.url ? fresh.pendingUrl : undefined;
	// 归组失败不该让「打开标签」这件事失败，只把结果带回去。组名可以是这一次的参数，
	// 也可以是设置里的默认值；`group: false` 与「分组名留空」都表示这一次不建组。
	const wantedGroupTitle = groupTitleOf(params);
	const group = wantedGroupTitle === null
		? { grouped: false, reason: params.group === false ? 'group:false' : 'grouping-disabled' }
		: await addToAgentGroup(created.id, wantedGroupTitle);
	// 自己开的标签页就是自己的（分组失败也一样），并成为默认目标。
	await claimTab(created.id, { own: true });
	return {
		tabId: created.id,
		url: fresh?.url,
		title: fresh?.title,
		windowId: fresh?.windowId,
		...(pendingUrl === undefined ? {} : { pendingUrl }),
		...(settled === true ? {} : { loadPending: true }),
		...group,
		owned: true,
		agentTargetTabId: created.id,
		...(fresh?.incognito === true ? { incognito: true } : {}),
		...(newWindow ? { newWindow: true } : {}),
		...(isolated ? { isolated: true } : {}),
	};
}

/** 这个 id 现在还在不在。关闭前先问一次，是为了不让「已经没了」把整批连坐。 */
async function tabStillThere(tabId) {
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch {
		return false;
	}
}

/**
 * 一句给人/模型看的失败文案。跨 realm 抛来的 Error（`instanceof Error` 为假，
 * 例如从注入上下文或 chrome API 代理里冒出来的）也要认出它的 `message`，
 * 否则文案会变成 `Error: <原因>` 这种带前缀的二手货。
 */
function failureText(error) {
	if (error instanceof Error) return error.message;
	if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message);
	return String(error);
}

/**
 * 关闭一个或多个标签页，并把**每个 id** 的去向报清楚。
 *
 * 为什么不允许「第一个失败就抛出」：关标签是有副作用的写操作，前面的 id 可能
 * 已经真的关掉了。只回一句错误，模型会以为什么都没发生，然后重放整批；而
 * `effectState` 那套（errors.ts）对写操作的底线正是「不许把已发生的副作用藏起来」。
 * 所以这里收齐 `closed` / `alreadyGone` / `refused` / `failed`，并且**不猜**：调用
 * `chrome.tabs.remove` 之后逐个复查，还在的才算 failed。
 *
 * `alreadyGone` 是幂等成功，不是错误 —— 这样重试是安全的。
 *
 * `refused` 是第 4 项加的：**只关自己开过的标签页**。用户自己的标签页关掉就找不回来，
 * 所以默认拒绝，必须显式 `force: true`（模型得先在对话里跟用户确认过）。拒绝是
 * 「没有发生」而不是「失败」——它压根没进 remove，超时重试也不会多关一个。
 */
async function cmdTabsCloseMany(params) {
	const raw = Array.isArray(params.tabIds) ? params.tabIds : [];
	const ids = [...new Set(raw.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
	if (ids.length === 0) throw new Error('params.tabIds must be a non-empty array of tab ids');
	const force = params.force === true;
	const owned = await ownedTabIds();
	const present = [];
	const alreadyGone = [];
	const refused = [];
	for (const id of ids) {
		if (!(await tabStillThere(id))) { alreadyGone.push(id); continue; }
		if (!force && !owned.has(id)) {
			refused.push({ tabId: id, reason: 'not_owned_by_agent' });
			continue;
		}
		present.push(id);
	}
	let report = null;
	if (present.length > 0) {
		try {
			// 一次调用、数组形态：一批标签在链路上是一条命令、一份超时预算。
			await chrome.tabs.remove(present);
		} catch (error) {
			report = failureText(error);
		}
	}
	const closed = [];
	const failed = [];
	for (const id of present) {
		if (await tabStillThere(id)) failed.push({ tabId: id, error: report ?? 'tabs.remove resolved but the tab is still open' });
		else closed.push(id);
	}
	if (closed.length > 0) await forgetOwned(closed);
	return { requested: ids.length, closed, alreadyGone, failed, ...(refused.length > 0 ? { refused } : {}) };
}

async function cmdTabsClose(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	const many = { tabIds: [Number(params.tabId)] };
	if (params.force === true) many.force = true;
	return cmdTabsCloseMany(many);
}

/**
 * 激活一个标签页，并把它设成默认目标。
 *
 * 这一条同时是**让出的解除手势**：用户接管之后，模型可以调它把这个标签页要回来
 * （等于「我要在这页上继续」），要回来之后写操作重新可用——这是模型**自己能做**的
 * 那条恢复路径（另一条是等用户切走，自动解除）。
 */
async function cmdTabsActivate(params) {
	if (params.tabId === undefined) throw new Error('params.tabId is required');
	const tabId = Number(params.tabId);
	await chrome.tabs.update(tabId, { active: true });
	await claimTab(tabId, { own: false });
	await clearYield(tabId);
	return { activated: tabId, agentTargetTabId: tabId };
}

async function cmdNav(params) {
	if (!params.url) throw new Error('params.url is required');
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const timeoutMs = Number(params.timeoutMs) || 15_000;
	// Arm the waiter BEFORE triggering the navigation — see
	// waitForNavigationComplete for why the order decides the answer.
	const settling = params.wait === false ? Promise.resolve(true) : waitForNavigationComplete(tab.id, timeoutMs, params.url);
	await chrome.tabs.update(tab.id, { url: params.url });
	const settled = await settling;
	const fresh = await chrome.tabs.get(tab.id).catch(() => null);
	// Chrome lands dead navigations on an internal error page, but tabs.get()
	// keeps reporting the ORIGINAL url — only in-page location.href reveals
	// chrome-error://. Probe it so callers can react structurally. Both probes
	// are budgeted: CDP stays silent while a navigation is stuck before commit,
	// and an unbounded await there outlives the command's own timeout.
	const landedUrl = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: 'location.href', awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((r) => String(r.result?.value ?? ''))), 2000, '');
	let siteUnreachable;
	if (/^chrome-error:/.test(landedUrl)) {
		const errText = await withBudget(withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: 'document.body ? document.body.innerText.slice(0, 4000) : ""',
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((r) => String(r.result?.value ?? ''))), 2000, '');
		// Error-page copy is localized (zh-CN shows 无法找到 … 的 DNS 地址,
		// en-US shows ERR_NAME_NOT_RESOLVED); match either plus any bare DNS
		// mention such as DNS_PROBE_STARTED.
		const dns = /ERR_NAME_NOT_RESOLVED|ERR_DNS_TIMED_OUT|\bDNS\b|无法找到.{0,40}(DNS|服务器)/i.test(errText)
			|| /ERR_NAME_NOT_RESOLVED|dns/i.test(fresh?.title ?? '');
		siteUnreachable = { reason: dns ? 'dns' : 'unreachable' };
	}
	// While a navigation is pending, `url` is still the OLD document (or empty for
	// a tab that has not committed anything yet) and the destination only exists
	// in `pendingUrl` — report it so "still going to X" is visible.
	const pendingUrl = fresh?.pendingUrl && fresh.pendingUrl !== fresh?.url ? fresh.pendingUrl : undefined;
	return {
		tabId: tab.id,
		url: siteUnreachable ? params.url : (fresh?.url ?? params.url),
		title: siteUnreachable ? undefined : fresh?.title,
		...(pendingUrl === undefined ? {} : { pendingUrl }),
		...(siteUnreachable ? { siteUnreachable } : {}),
		// A timed-out wait must never read as "the page is there": loadPending
		// says the new document was still not in place when the budget ran out.
		...(siteUnreachable === undefined && settled !== true ? { loadPending: true } : {}),
	};
}

/**
 * `eval` 的额外限时预算（毫秒）。`null` = 不额外限时，由桥的 60s 兜底。
 *
 * 这里曾经是 `Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 0)) || null`：
 * 不传 `timeoutMs` 时 `Number(undefined)` 是 NaN → `|| 0` → 0 → `Math.max(100, 0)` 恒等于
 * 100，于是"没传就不限时"的那半边永远不可达，**任何真实 await 都在 100ms 被杀**。
 * 判据只能是"传没传"，不能看数值的真假。
 */
function evalBudgetOf(params) {
	if (params?.timeoutMs === undefined || params.timeoutMs === null) return null;
	const n = Number(params.timeoutMs);
	if (!Number.isFinite(n)) return null;
	return Math.min(120_000, Math.max(100, n));
}

/**
 * 给 `eval` 的**页面侧**调用套一个预算：`ms` 为空就不限时（原样返回同一个 promise）。
 * 到点抛 `code: 'eval_timeout'` 的错误，调用方因此能分辨"表达式超时"和"桥超时"。
 * 计时器在调用结束时清掉——否则一个到点才 reject 的悬空定时器会一直吊着事件循环。
 */
async function raceEvalDeadline(promise, ms) {
	if (!ms) return promise;
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const err = new Error(`eval timeout after ${ms}ms`);
			err.code = 'eval_timeout';
			reject(err);
		}, ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

async function cmdEval(params) {
	if (typeof params.expression !== 'string' || params.expression.length === 0) {
		throw new Error('params.expression is required');
	}
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	// Frame targeting: params.frameSelector (CSS selector of an <iframe>) runs
	// the expression inside that frame via contentDocument (same-origin).
	// Cross-origin frames need a separate debugger target — reported clearly.
	let expression = params.expression;
	if (Array.isArray(params.argNames) && Array.isArray(params.args)
		&& params.argNames.length === params.args.length && params.argNames.length > 0) {
		const argValues = params.args.map((a) => JSON.stringify(a)).join(', ');
		expression = `((${params.argNames.join(', ')}) => { ${params.expression} })(${argValues})`;
	}
	if (params.frameSelector) {
		const inner = expression.startsWith('(') ? expression : `(() => { ${expression} })()`;
		// Rebind document/window to the frame by passing them as parameters of
		// the wrapping arrow — parameter shadowing, no TDZ hazard. A `const
		// document = doc` declaration in the same scope would throw
		// "Cannot access 'document' before initialization" at the host lookup
		// above it.
		expression = `(() => {
			const host = document.querySelector(${JSON.stringify(String(params.frameSelector))});
			if (!host || !(host instanceof HTMLIFrameElement)) throw new Error('iframe not found: ${String(params.frameSelector).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');
			if (!host.contentDocument) throw new Error('cross-origin iframe: same-origin only supported, use a frame-specific tool');
			const doc = host.contentDocument, win = host.contentWindow;
			return ((document, window) => ${inner})(doc, win);
		})()`;
	}
	// params.timeoutMs races the evaluation: a hung awaitPromise (looping
	// promise, blocked page) must fail at the caller's budget instead of
	// riding the bridge-wide 60s default.
	const evalTimeoutMs = evalBudgetOf(params);
	const evaluate = withCDP(tab.id, async (send) => {
		// Evaluate WITHOUT returnByValue first: the RemoteObject's type/subtype
		// metadata tells us honestly what came back. Newer Chrome serializes
		// un-serializable objects to `{}` under returnByValue:true, which would
		// masquerade as a legitimate empty object.
		const call = send('Runtime.evaluate', {
			expression,
			awaitPromise: params.awaitPromise !== false,
			returnByValue: false,
			userGesture: true,
		}).then(async (res) => {
			if (res.exceptionDetails) {
				const d = res.exceptionDetails;
				const desc = String(d.exception?.description ?? d.text);
				if (CONTEXT_DESTROYED_RE.test(desc)) {
					const err = new Error('context_destroyed: page navigated while evaluate was pending');
					err.code = 'context_destroyed';
					throw err;
				}
				throw new Error(`page exception: ${desc}`);
			}
			const ro = res.result;
			// Primitives carry their value inline; nothing more to transfer.
			const isPrimitiveLike = ro.type === 'number' || ro.type === 'string' || ro.type === 'boolean'
				|| ro.type === 'bigint' || ro.type === 'undefined' || ro.subtype === 'null';
			if (isPrimitiveLike || !ro.objectId) return ro;
			// Objects known un-serializable by value get an honest report instead
			// of a silent {} (DOM nodes, functions, proxies, symbols, Map/Set…).
			const NOT_BY_VALUE = new Set(['node', 'function', 'proxy', 'symbol', 'map', 'set',
				'weakmap', 'weakset', 'iterator', 'generator']);
			if (NOT_BY_VALUE.has(ro.subtype ?? '') || ro.type === 'function' || ro.type === 'symbol') return ro;
			// Transfer by value without re-executing the expression:
			// callFunctionOn(identity) on the existing objectId.
			const ser = await send('Runtime.callFunctionOn', {
				objectId: ro.objectId,
				functionDeclaration: 'function () { return this; }',
				returnByValue: true,
			});
			if (ser.exceptionDetails) return ro;
			return { ...ro, value: ser.result.value };
		}).catch((err) => {
			// Protocol-level variant: Chrome rejects the whole sendCommand with
			// -32000 "Inspected target navigated or closed" when the target dies
			// mid-call; surface it under the same structural code.
			if (err instanceof Error && CONTEXT_DESTROYED_RE.test(err.message)) {
				const wrapped = new Error('context_destroyed: page navigated while evaluate was pending');
				wrapped.code = 'context_destroyed';
				throw wrapped;
			}
			throw err;
		})
		// 预算只量"页面里那一段 await"：`withCDP` 的附着发生在回调之前，真机上冷附着
		// 几十到几百毫秒。把附着算进预算，`timeoutMs: 100` 配一句立刻返回的表达式也会
		// "凭空超时"（报告里"10ms 的 promise 也挂"正是这一半）。附着吊死跟其它命令
		// 一样由桥的超时兜底——`eval` 不该比 `click` / `snapshot` 更特殊。
		return raceEvalDeadline(call, evalTimeoutMs)
	})
	const value = await evaluate;
	// Serialize what we honestly got. `value` here is a RemoteObject; a
	// missing `.value` on a non-primitive means transfer was impossible.
	let out;
	if (value.value !== undefined) {
		out = value.value;
	} else if (value.type === 'undefined') {
		out = null;
	} else if (value.subtype === 'node') {
		out = `[dom:${value.className ?? 'Node'} — wrap in JSON.stringify() or read specific properties]`;
	} else {
		out = `[${value.type}${value.subtype ? `:${value.subtype}` : ''}: not serializable — wrap the expression in JSON.stringify()]`;
	}
	return { tabId: tab.id, value: out, valueType: value.type };
}

async function cmdContent(params) {
	const mode = params.mode === 'html' ? 'html' : 'text';
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	// html 模式要把浮层那棵子树摘掉：宿主挂在 <html> 下，outerHTML 会把模型自己的提示
	// 带进「页面内容」里（模型随后可能把这句话当成页面文字去点）。`data-dsh-hold` 是
	// 稳定标记，克隆一份再摘，不动真页面。
	const inner = mode === 'html'
		? `(${pageHtmlWithoutHold.toString()})()`
		: '(document.body && (document.body.innerText || document.body.textContent)) || ""';
	const payload = await withCDP(tab.id, (send) =>
		send('Runtime.evaluate', {
			expression: `JSON.stringify({title: document.title, url: location.href, readyState: document.readyState, content: ${inner}})`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(`page exception: ${res.exceptionDetails.text}`);
			return JSON.parse(res.result.value);
		}));
	return { tabId: tab.id, mode, ...payload };
}

async function cmdFind(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const limit = Math.max(1, Math.min(50, Number(params.limit) || 10));
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const payload = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			const els = [...document.querySelectorAll(${JSON.stringify(String(params.selector))})]
				.filter((el) => !(${pageIsHoldNode.toString()})(el));
			return JSON.stringify({
				count: els.length,
				items: els.slice(0, ${limit}).map((el) => {
					const r = el.getBoundingClientRect();
					return {
						tag: el.tagName.toLowerCase(), id: el.id || undefined,
						class: String(el.className || '').slice(0, 120) || undefined,
						text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160) || undefined,
						href: el instanceof Element && el.hasAttribute('href') ? el.getAttribute('href') : undefined,
						rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
					};
				}),
			});
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => JSON.parse(res.result.value)));
	return { tabId: tab.id, selector: params.selector, ...payload };
}

async function cmdClick(params) {
	if (!params.selector) throw new Error('params.selector is required');
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	// Mouse events land on whatever is under the viewport coordinates of the tab
	// we drive. CDP injects them into the renderer, so the tab does NOT have to be
	// frontmost; `focus` reports what we actually touched (see activateTabWindow).
	const focus = await activateTabWindow(tab.id, policyOf(params).focus);
	return withCDP(tab.id, async (send) => {
		const hit = await send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				if (!el) return null;
				el.scrollIntoView({ block: 'center', inline: 'center' });
				const r = el.getBoundingClientRect();
				// elementFromPoint at the intended hit point catches overlays
				// (sticky headers, ads) that would swallow the click.
				const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
				const topEl = document.elementFromPoint(x, y);
				let isTop = topEl === el || el.contains(topEl);
				// 盖住命中的如果是我们自己的接管浮层，那不是「页面挡住了目标」——它存在的
				// 意义是不让**人**误触，不该把模型自己的点击吃掉（否则浮层一挂，click 就全废，
				// 而且同一坐标连点两下会被浮层当成双击、以用户的名义把浮层关掉）。
				// 做法：临时让宿主对指针透明、重测一次命中点，派发完再恢复（见下面的 finally）。
				const ownOverlay = !isTop && topEl && topEl.closest ? topEl.closest('[data-dsh-hold]') : null;
				let bypassedOwnOverlay = false;
				if (ownOverlay) {
					ownOverlay.style.pointerEvents = 'none';
					bypassedOwnOverlay = true;
					const clear = document.elementFromPoint(x, y);
					isTop = clear === el || el.contains(clear);
				}
				const after = bypassedOwnOverlay ? document.elementFromPoint(x, y) : topEl;
				return { x, y, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 120),
					hitTag: after ? after.tagName.toLowerCase() : null, isTop, bypassedOwnOverlay };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		});
		if (!hit) throw new Error(`element not found: ${params.selector}`);
		const clickCount = params.doubleClick ? 2 : 1;
		try {
			await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
			await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount });
			await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', clickCount });
		} finally {
			if (hit.bypassedOwnOverlay) {
				// 点击可能触发导航：上下文没了就算了，浮层本来就随页面消失。
				await send('Runtime.evaluate', {
					expression: `(() => { const h = document.querySelector('[data-dsh-hold]'); if (h) h.style.pointerEvents = ''; })()`,
					awaitPromise: false, returnByValue: true,
				}).catch(() => {});
			}
		}
		return {
			tabId: tab.id,
			clicked: { x: hit.x, y: hit.y, tag: hit.tag, text: hit.text },
			hitVerified: hit.isTop,
			...(hit.isTop ? {} : { hitInstead: hit.hitTag }),
			...(hit.bypassedOwnOverlay ? { bypassedOwnOverlay: true } : {}),
			focus,
			dialogsAnswered: dialogLog.filter((d) => d.tabId === tab.id && Date.now() - d.t < 5000).length,
		};
	});
}

/** 定位 + 聚焦 + 清空（`fill` 与 `type` 两种模式共用）。没命中返回 null。 */
async function locateAndClearField(tabId, selector) {
	return withCDP(tabId, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			const el = document.querySelector(${JSON.stringify(String(selector))});
			if (!el) return null;
			el.scrollIntoView({ block: 'center', inline: 'center' });
			el.focus();
			let tag = el.tagName.toLowerCase();
			let cleared = '';
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
				const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
				Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
				el.dispatchEvent(new Event('input', { bubbles: true }));
				tag = tag + '[' + (el.getAttribute('type') || 'text') + ']';
				cleared = '';
			} else if (el.isContentEditable) {
				el.textContent = '';
				el.dispatchEvent(new InputEvent('input', { bubbles: true }));
			} else if (el instanceof HTMLSelectElement) {
				tag = 'select';
			}
			return { tag };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		return res.result.value;
	}));
}

/**
 * `type` 模式：逐字符真按键，然后**读回**落地值。
 *
 * 读回那一步不只是给人看：`avoid` 聚焦策略下第一次不激活标签页，如果键盘事件压根
 * 没落进去（后台标签页在某些版本上就是这样），读回是唯一能证伪的信号。没有它，
 * 我们只能猜「应该进去了」。
 */
async function typeIntoField(tabId, selector, value) {
	const text = String(value);
	return withCDP(tabId, async (send) => {
		for (const ch of text) {
			if (ch === '\n') {
				await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter', text: '\r' });
				await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13, code: 'Enter' });
				continue;
			}
			// Non-ASCII (CJK, emoji) cannot travel through keyEvent text — the
			// protocol mangles them to '?'. Route them through insertText which
			// performs a real composition-style insertion; ASCII keeps full
			// keyDown/char/keyUp so per-key handlers still fire.
			if (ch.charCodeAt(0) > 127 || ch.codePointAt(0) > 0xFFFF) {
				await send('Input.insertText', { text: ch });
				continue;
			}
			await send('Input.dispatchKeyEvent', {
				type: 'keyDown', key: ch, text: ch, unmodifiedText: ch,
				windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
			});
			// NOTE: no separate 'char' event — Chrome inserts the character from
			// keyDown's text field; an explicit char event duplicates the input.
			await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0) });
		}
		// Read back what actually landed in the element.
		return send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(selector))});
				if (!el) return null;
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => res.result.value);
	});
}

async function cmdInput(params) {
	if (!params.selector) throw new Error('params.selector is required');
	if (params.value === undefined) throw new Error('params.value is required');
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const policy = policyOf(params);
	// 'type' mode drives the real keyboard pipeline (Input.insertText per
	// keystroke) so stateful components (React-controlled, search bars with
	// internal suggestion state) observe every character. 'fill' (default)
	// sets the value directly — fast, but bypasses component keystroke logic.
	const mode = params.mode === 'type' ? 'type' : 'fill';

	// Locate + focus + clear in one evaluate, shared by both modes.
	const located = await locateAndClearField(tab.id, params.selector);
	if (!located) throw new Error(`element not found: ${params.selector}`);

	if (mode === 'fill') {
		const result = await withCDP(tab.id, (send) => send('Runtime.evaluate', {
			expression: `(() => {
				const el = document.querySelector(${JSON.stringify(String(params.selector))});
				const value = ${JSON.stringify(String(params.value))};
				if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
					const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
					Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else if (el.isContentEditable) {
					el.textContent = value;
					el.dispatchEvent(new InputEvent('input', { bubbles: true }));
				} else if (el instanceof HTMLSelectElement) {
					el.value = value;
					el.dispatchEvent(new Event('change', { bubbles: true }));
				} else {
					el.textContent = value;
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				}
				return { tag: el.tagName.toLowerCase(), value: String(el.value ?? el.textContent ?? '') };
			})()`,
			awaitPromise: false, returnByValue: true, userGesture: true,
		}).then((res) => {
			if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
			return res.result.value;
		}));
		// fill 是直接写值，不需要焦点，所以不打标签页也不需要窗口——如实说清。
		return { tabId: tab.id, mode, filled: result, focus: { policy: policy.focus, windowFocused: false, tabActivated: false, skipped: 'fill-mode' } };
	}

	const focus = await activateTabWindow(tab.id, policy.focus);
	let filled = await typeIntoField(tab.id, params.selector, params.value);
	let effectiveFocus = focus;
	// 自适应升级：`avoid` 下没有激活标签页，而按键**一个字符都没落地**（读回是空串）。
	// 这是唯一能证伪「后台标签页也能收键盘」的信号，所以只信它：升级一次（这才是允许
	// 抬窗口的那一刻），清空重打，并在结果里如实标注我们动过窗口。
	const missed = String(params.value).length > 0 && (filled?.value ?? '') === '';
	if (policy.focus === 'avoid' && focus.tabActivated === false && focus.skipped === undefined && missed) {
		const escalated = await activateTabWindow(tab.id, 'auto');
		await locateAndClearField(tab.id, params.selector).catch(() => {});
		filled = await typeIntoField(tab.id, params.selector, params.value);
		effectiveFocus = { policy: 'avoid', windowFocused: escalated.windowFocused, tabActivated: escalated.tabActivated, escalated: true };
	}
	return {
		tabId: tab.id,
		mode,
		filled,
		focus: effectiveFocus,
		...(effectiveFocus.escalated === true ? { focusedFallback: true } : {}),
	};
}

const KEY_CODES = {
	Enter: [13, 'Enter'], Tab: [9, 'Tab'], Escape: [27, 'Escape'],
	Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Space: [32, 'Space'],
	ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'],
	ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
	Home: [36, 'Home'], End: [35, 'End'],
	PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
};
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, command: 4, shift: 8 };

/** 把 "Ctrl+A" 这类组合串拆成真正的按键 + 修饰键集合。 */
function parseKeySpec(key, rawModifiers) {
	const mods = new Set((Array.isArray(rawModifiers) ? rawModifiers : []).map((m) => String(m).toLowerCase()));
	// 只有长度 > 1 且含 '+' 才当组合串：`+` 与 `=` 这类键本身就是单字符。
	const parts = key.length > 1 && key.includes('+') ? key.split('+') : [key];
	const finalKey = parts.pop();
	for (const part of parts) {
		const name = part.trim().toLowerCase();
		if (!(name in MODIFIER_BITS)) {
			throw new Error(`unknown modifier "${part.trim()}" in key "${key}". Valid: alt, ctrl/control, meta/command, shift — or pass modifiers: ["ctrl"] together with key: "a".`);
		}
		mods.add(name);
	}
	return { key: finalKey, modifiers: [...mods] };
}

async function cmdPress(params) {
	const raw = String(params.key ?? '');
	if (raw.length === 0) throw new Error('params.key is required');
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const { key, modifiers: modifierNames } = parseKeySpec(raw, params.modifiers);
	// Key events go through CDP; `focus` says whether we had to bring the tab
	// forward to make them land (policy-dependent — see activateTabWindow).
	const focus = await activateTabWindow(tab.id, policyOf(params).focus);
	let keyCode, code;
	if (KEY_CODES[key]) { [keyCode, code] = KEY_CODES[key]; }
	else if (key.length === 1) {
		keyCode = key.toUpperCase().charCodeAt(0);
		if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
		else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
	}
	if (keyCode === undefined) {
		// 以前这里不报错，照样把 undefined 的 keyCode/code 发出去：Chrome 什么都不做，
		// 调用方却收到 `{key:"…", pressed:true}`——静默失败比失败本身更糟。
		throw new Error(`unknown key "${raw}". Use one of ${Object.keys(KEY_CODES).join(', ')}, a single character, or a combination like "Ctrl+A" / "Shift+ArrowRight".`);
	}
	const text = params.text !== undefined
		? String(params.text)
		: key === 'Enter' ? '\r' // '\r' makes keyDown perform implicit form submission
		: key.length === 1 && !modifierNames.some((m) => m in MODIFIER_BITS && m !== 'shift') ? key : undefined;
	let modifiers = 0;
	for (const m of modifierNames) modifiers |= MODIFIER_BITS[String(m).toLowerCase()] ?? 0;
	return withCDP(tab.id, async (send) => {
		// NOTE: no separate 'char' event — Chrome inserts the character from
		// keyDown's text field; an explicit char event duplicates the input
		// (double characters, and Enter submitted the form twice). Same rule
		// `cmdInput`'s type mode already follows; see issue #14.
		await send('Input.dispatchKeyEvent', {
			type: 'keyDown', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, text, unmodifiedText: text, modifiers,
		});
		await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, code, modifiers });
		return { tabId: tab.id, key, pressed: true, focus, ...(modifiers ? { modifiers } : {}) };
	});
}

/**
 * 在「我们自己的高亮层被藏起来」的前提下跑一次 CDP 动作（截图与打印 PDF 共用）。
 *
 * 为什么必须做：那一层固定覆盖整个视口，留着它等于给每一张交给模型的图镶一圈蓝边，
 * 模型随后可能把那圈颜色当成页面设计的一部分；打印成 PDF 时 `position: fixed` 的元素
 * 还会在**每一页**重复出现。它和接管浮层一样**不是页面内容**，读取路径既然会把它摘掉，
 * 出图这两条路也得摘掉。
 * @param send - 这个标签页的 CDP 发送函数。
 * @param shouldHide - 这一页上是否真的有我们的框；没有就一次 evaluate 都不要发。
 * @param action - 真正要跑的 CDP 调用（截图 / 打印）。
 */
async function withHighlightHidden(send, shouldHide, action) {
	if (shouldHide !== true) return action()
	const hidden = await send('Runtime.evaluate', {
		expression: `(${pageHighlightHide.toString()})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((r) => r && r.result && r.result.value && r.result.value.hidden === true).catch(() => false)
	try {
		return await action()
	} finally {
		if (hidden) {
			await send('Runtime.evaluate', {
				expression: `(${pageHighlightShow.toString()})()`,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).catch(() => {});
		}
	}
}

/** 这一页上是否真的挂着我们的高亮框（决定截图/打印前要不要藏一下）。 */
async function highlightOnTab(tabId) {
	const framed = (await syncAgentState()).highlight
	return framed !== null && framed.tabId === Number(tabId)
}

/** 截图：藏、拍（带自己的预算）、还原。`options` 原样透传给 `Page.captureScreenshot`。 */
function captureWithoutHighlight(send, options, shouldHide) {
	// 预算只罩住**拍照本身**：`withHighlightHidden` 的 finally 必须还能跑，
	// 否则一次超时就会把页面上那圈框永久藏起来（display:none 没人再还原）。
	return withHighlightHidden(send, shouldHide, () =>
		withCaptureBudget(send('Page.captureScreenshot', options), CAPTURE_BUDGET_MS, '截图（Page.captureScreenshot）'))
}

async function cmdScreenshot(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const format = params.format === 'jpeg' ? 'jpeg' : 'png';
	// 最小化的窗口上截图会一直挂着（见 assertFrameableWindow）：能当场说清就别等预算。
	await assertFrameableWindow(tab, '截图');
	// 只在这一页真的挂着我们的框时才去藏：否则每条截图都白搭一次 CDP 往返。
	const shouldHide = await highlightOnTab(tab.id);
	const res = await withCDP(tab.id, async (send) => {
		// Element capture: resolve the selector to a CSS-pixel rect, then pass
		// it as clip. Page.captureScreenshot's clip is in CSS pixels and it
		// handles DPR internally (unlike raw base64 math).
		if (params.selector) {
			const rect = await send('Runtime.evaluate', {
				expression: `(() => {
					const el = document.querySelector(${JSON.stringify(String(params.selector))});
					if (!el) return null;
					el.scrollIntoView({ block: 'center', inline: 'center' });
					const r = el.getBoundingClientRect();
					return { x: r.left, y: r.top, width: r.width, height: r.height };
				})()`,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).then((r) => {
				if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
				return r.result.value;
			});
			if (!rect) throw new Error(`element not found: ${params.selector}`);
			return captureWithoutHighlight(send, {
				format,
				quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
				clip: { ...rect, scale: 1 },
			}, shouldHide).then((shot) => ({ shot, elementRect: rect }));
		}
		const shot = await captureWithoutHighlight(send, {
			format,
			quality: format === 'jpeg' ? Math.min(100, Math.max(1, Number(params.quality) || 80)) : undefined,
			captureBeyondViewport: Boolean(params.fullPage),
		}, shouldHide);
		// 整页截图会把触摸仿真重置（Chromium issue 558509412；Playwright 为此每次补发）：
		// 不补的话，页面会静默退回桌面形态，而工具还在说 touch 是开的。
		if (params.fullPage === true) await replayEmulation(tab.id).catch(() => {});
		return { shot };
	});
	return {
		tabId: tab.id,
		format,
		base64: res.shot.data,
		tabTitle: tab.title,
		tabUrl: tab.url,
		...(res.elementRect ? {
			elementRect: {
				x: Math.round(res.elementRect.x), y: Math.round(res.elementRect.y),
				w: Math.round(res.elementRect.width), h: Math.round(res.elementRect.height),
			},
		} : {}),
	};
}

async function cmdScroll(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const dx = Number.isFinite(Number(params.x)) ? Number(params.x) : 0;
	const dy = Number.isFinite(Number(params.y)) ? Number(params.y) : 0;
	return withCDP(tab.id, (send) => send('Runtime.evaluate', {
		expression: `(() => {
			window.scrollBy({ left: ${JSON.stringify(dx)}, top: ${JSON.stringify(dy)}, behavior: 'instant' });
			return { tabId: ${tab.id}, scrollX: window.scrollX, scrollY: window.scrollY,
				pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => res.result.value));
}

/** All CDP message variants that mean "the page went away mid-evaluation". */
const CONTEXT_DESTROYED_RE = /Execution context was destroyed|Cannot find default execution context|Inspected target navigated or closed/i;

const SNAPSHOT_SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], '
	+ '[role="tab"], [role="checkbox"], [role="radio"], [contenteditable="true"], [onclick]';

/** DOM mode: stamp `data-dsh-ref` on everything matching the selector list. */
async function snapshotViaDom(send, tab, limit) {
	const payload = await send('Runtime.evaluate', {
		expression: `(() => {
			const ATTR = 'data-dsh-ref';
			document.querySelectorAll('[' + ATTR + ']').forEach((el) => el.removeAttribute(ATTR));
			const nodes = [...document.querySelectorAll(${JSON.stringify(SNAPSHOT_SELECTOR)})]
				.filter((el) => !(${pageIsHoldNode.toString()})(el));
			const items = [];
			let n = 0;
			for (const el of nodes) {
				if (items.length >= ${limit}) break;
				const r = el.getBoundingClientRect();
				if (r.width === 0 && r.height === 0) continue;
				const ref = 'e' + (++n);
				el.setAttribute(ATTR, ref);
				const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
				items.push({
					ref, tag: el.tagName.toLowerCase(),
					type: el.getAttribute('type') || undefined,
					role: el.getAttribute('role') || undefined,
					name: (el.getAttribute('aria-label') || el.getAttribute('placeholder')
						|| (el.textContent || '').trim().replace(/\\s+/g, ' ')).slice(0, 80) || undefined,
					value: isField || el instanceof HTMLSelectElement ? String(el.value ?? '').slice(0, 60) : undefined,
					href: el.hasAttribute('href') ? el.href : undefined,
					rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
				});
			}
			return { tabId: ${tab.id}, title: document.title, url: location.href, total: nodes.length, items };
		})()`,
		awaitPromise: false, returnByValue: true, userGesture: true,
	}).then((res) => {
		if (res.exceptionDetails) throw new Error(res.exceptionDetails.text);
		return res.result.value;
	});
	payload.limitedTo = limit;
	return payload;
}

/* --------------------------------------------------- snapshot: a11y (AX) mode */

/**
 * Roles an agent can actually act on. Chrome computes these (including the
 * accessible name, which is what makes this survive a DOM redesign), so the list
 * is deliberately an allow-list: internal nodes like `GenericContainer`,
 * `StaticText` and `InlineTextBox` would otherwise dominate the tree and eat the
 * whole `limit` budget on a text-heavy page.
 */
const AX_ACTIONABLE_ROLES = new Set([
	'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'menuitem',
	'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'checkbox', 'switch',
	'slider', 'spinbutton', 'tab', 'treeitem', 'gridcell', 'columnheader', 'rowheader',
]);

/**
 * Runs in the page: returns null for anything invisible (so no ref is consumed
 * and no attribute is left behind), otherwise stamps the ref and reports back
 * what the DOM node actually is. One round trip per kept element.
 */
const AX_STAMP_FN = 'function(ref){'
	+ 'var r = this.getBoundingClientRect();'
	+ 'if (r.width === 0 && r.height === 0) return null;'
	// 接管浮层自己也是「可操作」的（卡片上有个按钮），但它属于扩展、不属于页面：
	// 让它进快照，模型就会看到自己刚挂上去的那句话和一个「中止模型操作」按钮。
	+ 'var hold = this.closest ? this.closest("[data-dsh-hold]") : null;'
	+ 'if (hold) return { ownOverlay: true };'
	+ 'this.setAttribute("data-dsh-ref", ref);'
	+ 'return {'
	+ ' tag: this.tagName.toLowerCase(),'
	+ ' type: (this.type ? String(this.type) : undefined),'
	+ ' href: (this.href ? String(this.href) : undefined),'
	+ ' value: (this.value === undefined || this.value === null) ? undefined : String(this.value).slice(0, 60),'
	+ ' rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }'
	+ '};'
	+ '}';

/**
 * AX mode: read Chrome's accessibility tree, then stamp the **same**
 * `data-dsh-ref` attribute onto the real DOM node behind each interesting a11y
 * node. That keeps the ref contract intact — `browser_click` / `browser_type`
 * still resolve `[data-dsh-ref="e7"]` — while the agent gets `role` + accessible
 * `name` instead of a guessed selector.
 */
async function snapshotViaAx(send, tab, limit) {
	await send('DOM.enable').catch(() => {});
	await send('Accessibility.enable').catch(() => {});
	// Clear refs from a previous snapshot first: a stale attribute would otherwise
	// let an old ref click whatever is on screen now.
	await send('Runtime.evaluate', {
		expression: 'document.querySelectorAll("[data-dsh-ref]").forEach((el) => el.removeAttribute("data-dsh-ref")); void 0;',
		returnByValue: true,
	}).catch(() => {});
	const tree = await send('Accessibility.getFullAXTree');
	const nodes = (tree && tree.nodes) || [];
	if (!Array.isArray(nodes)) throw new Error('Accessibility.getFullAXTree 没有返回 nodes');
	const candidates = nodes.filter((node) => node
		&& node.ignored !== true
		&& node.backendDOMNodeId !== undefined
		&& AX_ACTIONABLE_ROLES.has(String(node.role && node.role.value || '').toLowerCase()));
	const items = [];
	const skipped = { unresolved: 0, invisible: 0, ownOverlay: 0 };
	for (const node of candidates) {
		if (items.length >= limit) break;
		const ref = 'e' + (items.length + 1);
		let resolved = null;
		try {
			resolved = await send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
		} catch {
			resolved = null;
		}
		const objectId = resolved && resolved.object && resolved.object.objectId;
		if (!objectId) { skipped.unresolved += 1; continue; }
		let call = null;
		try {
			call = await send('Runtime.callFunctionOn', {
				objectId, functionDeclaration: AX_STAMP_FN, arguments: [{ value: ref }], returnByValue: true,
			});
		} catch {
			skipped.unresolved += 1;
			continue;
		}
		const geo = call && call.result ? call.result.value : null;
		if (call && call.exceptionDetails) { skipped.unresolved += 1; continue; }
		// null means invisible: the stamp function refused to write the attribute,
		// so this ref number is simply reused by the next candidate.
		// 我们自己的接管浮层：不是页面内容，跳过（也不占 ref 编号）。
		if (geo && geo.ownOverlay === true) { skipped.ownOverlay += 1; continue; }
		if (!geo) { skipped.invisible += 1; continue; }
		items.push({
			ref,
			tag: geo.tag,
			role: String(node.role && node.role.value || '').toLowerCase() || undefined,
			name: String(node.name && node.name.value || '').replace(/\s+/g, ' ').slice(0, 80) || undefined,
			type: geo.type,
			href: geo.href,
			value: geo.value,
			rect: geo.rect,
		});
	}
	return {
		tabId: tab.id,
		mode: 'ax',
		title: await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
			.then((r) => r.result && r.result.value).catch(() => undefined),
		url: await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })
			.then((r) => r.result && r.result.value).catch(() => undefined),
		// total 是「页面上可操作的元素数」：我们自己的浮层不属于页面，别算进去。
		total: candidates.length - skipped.ownOverlay,
		ax: { nodes: nodes.length, candidates: candidates.length, ...skipped },
		items,
		limitedTo: limit,
	};
}

async function cmdSnapshot(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const limit = Math.min(200, Math.max(1, Number(params.limit) || 120));
	const wantAx = String(params.mode ?? params.source ?? 'dom').toLowerCase() === 'ax';
	return withCDP(tab.id, async (send) => {
		await send('Runtime.enable').catch(() => {});
		if (!wantAx) return snapshotViaDom(send, tab, limit);
		try {
			return await snapshotViaAx(send, tab, limit);
		} catch (error) {
			// A page (or an older Chrome) that will not give us an accessibility
			// tree must still produce a usable snapshot: fall back to the DOM
			// selectors and say out loud that we did.
			const payload = await snapshotViaDom(send, tab, limit);
			payload.mode = 'dom';
			payload.axFallback = String((error && error.message) || error);
			return payload;
		}
	});
}

const COMMANDS = {
	ping: cmdPing, 'browser.info': cmdBrowserInfo,
	'tabs.list': cmdTabsList, 'tabs.open': cmdTabsOpen, 'tabs.close': cmdTabsClose, 'tabs.closeMany': cmdTabsCloseMany, 'tabs.activate': cmdTabsActivate,
	'tabs.group': cmdTabGroup, 'tabs.ungroup': cmdTabUngroup,
	'profile.status': cmdProfileStatus, 'profile.launch': cmdProfileLaunch, 'profile.close': cmdProfileClose,
	nav: cmdNav, eval: cmdEval, content: cmdContent, find: cmdFind,
	click: cmdClick, input: cmdInput, press: cmdPress, scroll: cmdScroll,
	snapshot: cmdSnapshot, screenshot: cmdScreenshot,
	wait: cmdWait, dialog: cmdDialogPolicy,
	'console.log': cmdConsoleLog, 'network.log': cmdNetworkLog, 'network.clear': cmdNetworkClear,
	pdf: cmdPdf, emulate: cmdEmulate,
	'cdp.call': cmdCdpCall,
	hold: cmdHold,
};

/**
 * Explicit wait primitive: poll until a selector appears, page text contains
 * a string, or a predicate function returns truthy. Polls inside the page via
 * requestAnimationFrame-ish loop (50ms interval) — no bridge round-trips.
 */
async function cmdWait(params) {
	const tab = await resolveTab(params.tabId, policyOf(params).jar);
	const timeoutMs = Math.min(120_000, Math.max(100, Number(params.timeoutMs) || 15_000));
	let condition;
	if (params.selector) {
		condition = `!!document.querySelector(${JSON.stringify(String(params.selector))})`;
	} else if (typeof params.text === 'string') {
		condition = `(document.body && document.body.innerText.includes(${JSON.stringify(params.text)}))`;
	} else if (typeof params.fn === 'string' && params.fn.length > 0) {
		// Accept both a predicate function ("() => x.ready") and a bare boolean
		// expression ("x.ready === true"): call function values, evaluate
		// everything else as-is.
		condition = `(() => { const f = (${params.fn}); return typeof f === 'function' ? Boolean(f()) : Boolean(f); })()`;
	} else {
		throw new Error('provide one of selector, text, or fn');
	}
	return withCDP(tab.id, async (send) => {
		const started = Date.now();
		for (;;) {
			const res = await send('Runtime.evaluate', {
				expression: condition,
				awaitPromise: false, returnByValue: true, userGesture: true,
			}).catch(() => ({ result: { value: false } }));
			if (res.exceptionDetails) throw new Error(`wait condition error: ${res.exceptionDetails.text}`);
			if (res.result.value === true) return { tabId: tab.id, waited: Date.now() - started };
			if (Date.now() - started >= timeoutMs) throw new Error(`wait timeout after ${timeoutMs}ms`);
			await new Promise((r) => setTimeout(r, 50));
		}
	});
}

/**
 * Read or set the native-dialog auto-answer policy. Passing `policy`
 * ('accept' | 'dismiss' | 'manual') sets it; omitting it is a read. Always
 * returns {policy, recent} — the last 10 answered dialogs, so a caller can
 * verify one actually fired.
 */
async function cmdDialogPolicy(params) {
	// 取值来源有两个，优先级明确：
	//   1) `dialogPolicy`——插件 v1.1.4+ 发的键（对外的工具参数名仍是 policy）；
	//   2) 顶层 `policy` 且**确实是字符串**——v1.1.3 及更早的插件用这个键传字符串。
	// 绝不能只看 `params.policy !== undefined`：信封每次都盖，值是对象，`String()`
	// 出来就是 `[object Object]`，于是连"不带参只读"都会当非法取值抛错。
	const asked = params?.dialogPolicy !== undefined
		? params.dialogPolicy
		: (typeof params?.policy === 'string' ? params.policy : undefined);
	if (asked !== undefined) {
		const p = String(asked);
		if (!['accept', 'dismiss', 'manual'].includes(p)) throw new Error(`invalid dialog policy: ${p}`);
		dialogPolicy = p;
	}
	return { policy: dialogPolicy, recent: dialogLog.slice(-10) };
}

/* ------------------------------------------------------------ popup link */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (msg?.type === 'bridgeStatus') {
		// 归属与让出存在 session 里，读它是异步的；弹窗要看「现在默认打到哪个标签页、
		// 哪几个被让出了」，所以这条从同步回话改成延后回话（`return true` 就是那个协议）。
		void (async () => {
			const state = await syncAgentState();
			sendResponse({
				state: wsState, cfg, helloInfo, lastError, locked: hardLocked, lockReason: hardLocked ? hardLockReason : 'none',
				agent: {
					targetTabId: state.target,
					yielded: Object.keys(state.yields).map(Number),
					isolatedWindowId: state.isolated?.windowId ?? null,
					incognitoAllowed: await syncIncognitoAllowed().catch(() => false),
				},
			});
		})();
		return true;
	}
	if (msg?.type === 'lockSet') {
		// The lock is set from the popup only (see the local-lock section): this
		// channel cannot be reached by the bridge, so "unlock from the browser"
		// is enforced by where the code lives, not by who asks nicely.
		// Fail closed: only an explicit `locked: false` unlocks, so a malformed
		// message cannot quietly unfreeze the browser.
		setHardLock(msg.locked !== false)
			.then((locked) => sendResponse({ locked }))
			.catch((err) => sendResponse({ locked: hardLocked, error: String((err && err.message) || err) }));
		return true;
	}
	if (msg?.type === 'reconnect') {
		manualDisconnect = false;
		backoffAttempt = 0;
		disconnectNow();
		loadConfig().then(() => { connect(); sendResponse({ started: true }); });
		return true;
	}
	if (msg?.type === 'disconnect') {
		manualDisconnect = true;
		disconnectNow();
		sendResponse({ started: true });
		return false;
	}
	return false;
});

/* -------------------------------------------------------------- lifecycle */

async function init() {
	await loadConfig();
	// 先把本地锁读出来再连：service worker 被回收后重新唤醒时，如果只有第一条命令
	// 才触发重读，那段时间图标上显示的是绿色 ON —— 用户以为锁着，桥那边却一切正常。
	await syncHardLock();
	connect();
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());
init();
