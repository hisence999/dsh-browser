import { access, constants, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
/**
* Incremental frame parser over arbitrary TCP chunks. `drain` parses every
* complete frame currently buffered and keeps the remainder; an oversized or
* unmasked data frame throws, and the caller closes the link.
*/
var FrameReader = class {
	buffer = Buffer.alloc(0);
	/** Append one TCP chunk to the parse buffer. */
	push(chunk) {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
	}
	/** Parse and consume every complete frame, invoking `onFrame` per frame in order. */
	drain(onFrame) {
		for (;;) {
			const frame = this.readFrame();
			if (!frame) return;
			onFrame(frame);
		}
	}
	readFrame() {
		const buf = this.buffer;
		if (buf.length < 2) return null;
		const fin = (buf[0] & 128) !== 0;
		const opcode = buf[0] & 15;
		const masked = (buf[1] & 128) !== 0;
		let length = buf[1] & 127;
		let offset = 2;
		if (length === 126) {
			if (buf.length < offset + 2) return null;
			length = buf.readUInt16BE(offset);
			offset += 2;
		} else if (length === 127) {
			if (buf.length < offset + 8) return null;
			const extended = buf.readBigUInt64BE(offset);
			offset += 8;
			if (extended > BigInt(67108864)) throw new Error(`websocket frame too large: ${extended} bytes`);
			length = Number(extended);
		}
		let maskKey = null;
		if (masked) {
			if (buf.length < offset + 4) return null;
			maskKey = buf.subarray(offset, offset + 4);
			offset += 4;
		}
		if (buf.length < offset + length) return null;
		if (!masked && (opcode === 1 || opcode === 0 || opcode === 2)) throw new Error("websocket client sent an unmasked data frame");
		const payload = Buffer.from(buf.subarray(offset, offset + length));
		if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] = payload[i] ^ maskKey[i & 3];
		this.buffer = buf.subarray(offset + length);
		return {
			fin,
			opcode,
			payload
		};
	}
};
/** Encode one unmasked text frame carrying a UTF-8 JSON message. */
function encodeTextFrame(text) {
	const payload = Buffer.from(text, "utf8");
	if (payload.length < 126) return Buffer.from([
		129,
		payload.length,
		...payload
	]);
	if (payload.length < 65536) {
		const header = Buffer.alloc(4);
		header[0] = 129;
		header[1] = 126;
		header.writeUInt16BE(payload.length, 2);
		return Buffer.concat([header, payload]);
	}
	const header = Buffer.alloc(10);
	header[0] = 129;
	header[1] = 127;
	header.writeBigUInt64BE(BigInt(payload.length), 2);
	return Buffer.concat([header, payload]);
}
/** Encode one control frame (opcode 0x8 close, 0x9 ping, 0xA pong); payload stays ≤ 125 bytes. */
function encodeControlFrame(opcode, payload = Buffer.alloc(0)) {
	return Buffer.concat([Buffer.from([128 | opcode, payload.length]), payload]);
}
/** Build the close-frame bytes for a status code plus a UTF-8 reason within the 125-byte limit. */
function encodeCloseFrame(code, reason) {
	const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
	const body = Buffer.alloc(2 + reasonBytes.length);
	body.writeUInt16BE(code, 0);
	reasonBytes.copy(body, 2);
	return encodeControlFrame(8, body);
}
/**
* 会改变页面或不可逆地改变浏览器状态的命令；其余按只读处理。
*
* 表里绝大多数是**扩展命令名**（`classify()` 按调用方传进来的名字查表），但也包含
* 插件本地命令（见下面 `cleanup`）：判据始终是同一条——失败之后重试会不会多造成一次损害。
*
* 判据是「重试会不会造成额外损害」，不是「有没有动到浏览器」。所以标签分组
* （`tabs.group` / `tabs.ungroup`）不在这里：把已经在组里的标签再归一次是空操作，
* 拆组失败后再拆一次也不会多拆坏东西，重试安全；而 `tabs.open` 重试会多出标签页、
* `tabs.close` 重试可能关掉用户正在看的页面，必须报 unknown。
*/
const WRITE_COMMANDS = /* @__PURE__ */ new Set([
	"nav",
	"click",
	"input",
	"press",
	"scroll",
	"eval",
	"emulate",
	"tabs.open",
	"tabs.close",
	"tabs.closeMany",
	"tabs.activate",
	"dialog",
	"profile.launch",
	"profile.close",
	"cdp.call",
	"cleanup",
	"hold"
]);
/** 该命令是否可能留下副作用。 */
function isWriteCommand(command) {
	return WRITE_COMMANDS.has(command);
}
/** 每个 code 对应的下一步建议（写给 agent，不是写给用户看的日志）。 */
const HINTS = {
	bridge_disabled: "桥接未启用：在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true 后重启 dsh；不要重试本命令。",
	extension_offline: "浏览器扩展没连上：让用户打开装了 DSH Browser 的那个浏览器（扩展图标应为绿色），确认端口与 Token 两边一致后再试。",
	command_timeout: "扩展超时未回应：先别重试。用 browser_find / browser_snapshot 看页面当前状态，判断动作是否其实已经生效。",
	link_lost: "命令在途时链路断了：动作可能已经落到页面上。先用只读工具确认页面状态，再决定是否重做。",
	cancelled: "调用被取消：按需重新发起，不必当作错误处理。",
	not_configured: "插件还没读到配置：确认 dsh 已加载本插件（dsh plugin list）后再试。",
	held_by_user: "这是用户在页面上的接管浮层里按下的「中止操作」，不是故障：命令一条都没有发出。先与用户确认；他同意继续之后调用 browser_hold action=off 解除，然后再继续原来的步骤。不要重试，也不要换成别的工具绕过它。",
	yielded_to_user: "用户接管了这个标签页（他切到了这一页上），不是故障：命令一条都没有发出。三条恢复路径任选其一——在你自己新开的标签页里继续（browser_tabs action=open）、等用户切走（切走会自动解除）、或由用户确认后 browser_tabs action=activate 把这一页要回来。不要在原地重试，也不要换工具绕过它。",
	incognito_unavailable: "浏览器没给扩展无痕/InPrivate 权限，所以隔离实例开不出来——这不是故障，也不是谁拒绝了你：请用户在浏览器的扩展管理页打开本扩展的「在无痕模式中允许」（Edge 叫「在 InPrivate 中允许」），然后重试。在那之前请用普通的登录态浏览器继续，并如实告诉用户为什么开不了隔离实例。",
	blocked_by_policy: "这是本机策略拦下的，不是故障：命令没有发给浏览器（零副作用）。要放开改 profile 的 cordis.patch.yml（browser-bridge 的 readOnly / allowScript）并重启 dsh，或换成本机允许的只读工具；不要原地重试。",
	locked_by_user: "这是用户在扩展弹窗里按下的「锁定」，不是故障：命令一条都没有发出。请先与用户确认，由他在同一个弹窗里点「已锁定」解除；不要重试，也不要试图改配置绕过它。",
	lock_unreadable: "扩展这次读不出锁的状态，按冻结处理了：命令没有发出。下一条命令会重新读一次，所以可以再试一次，但不要循环重试；一直如此就请用户重启浏览器或重装扩展。",
	window_minimized: "那个标签页所在的浏览器窗口是最小化的——Chromium 不产帧，截图/PDF 这类出图调用只会一直挂着，不是选择器或页面问题。三条路：把那个窗口恢复、改用另一个可见窗口里的标签页、或者这次调用显式带上 restoreWindow:true（扩展会临时恢复窗口、拍完再放回最小化；不抢焦点）。注意：PDF 走打印排版，最小化窗口上也能出（browser_pdf 不受这条限制）。不要原样重试。",
	capture_timeout: "出图调用在预算内没有返回：目标窗口不产帧（最小化、被完全遮挡，或页面卡住）。这次已经放弃，没有任何副作用。先用 browser_read / browser_find 确认页面还在；要图就换一个可见窗口的标签页，或带 restoreWindow:true 再试一次；不要连续重试。",
	command_failed: "扩展报回失败：按 error 文本处理，通常是选择器没命中、标签页已关闭或页面不允许该操作。",
	launch_not_found: "找不到可启动的浏览器：这不是故障，是这台机器上没有装在常见位置、PATH 里也没有、目录搜索也没扫到。请让用户在设置页「浏览器路径」里填上浏览器可执行文件的完整路径（Edge 一般是 C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe，Chrome 一般是 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe），或者由用户自己打开浏览器。不要重复调用本工具——同样的环境不会给出不同结果。",
	launch_failed: "找到了浏览器但进程没拉起来（EACCES / 路径失效 / 被安全软件挡住）：这一次没有任何副作用，浏览器也没启动。请用户确认那个路径确实可执行、安全软件没拦，必要时在设置页改「浏览器路径」；不要原地重试。"
};
/**
* 失败文案里「该不该重试」那半句。
*
* 宿主的失败内容是 `Error: ${message}`（`@deepseek-ai/dsh-tools` `lib/index.js:3616-3623`），
* `code` / `effectState` / `hint` 这些结构化字段只进 `error.info` 与 HTTP 面，
* **模型读不到**。所以决定下一步所需的两个信息——副作用状态与下一步动作——必须写进
* message 本身，否则整个错误契约对 agent 失效（和「render 只写摘要」是同一类缺陷）。
*/
function effectClause(effectState) {
	switch (effectState) {
		case "unknown": return "effectState=unknown：动作可能已经落到页面上，先用只读工具看当前状态，再决定要不要重做，不要直接重试";
		case "committed": return "effectState=committed：动作已经生效";
		default: return "effectState=not_started：这次调用没有动到页面，重试安全";
	}
}
/** 带分类的桥接错误；`message` 面向模型，`toJSON()` 面向程序。 */
var BridgeError = class extends Error {
	code;
	effectState;
	hint;
	command;
	/** 原始失败描述：HTTP 面的 `error` 字段就是它，不含我们追加的契约文案。 */
	detail;
	constructor(command, code, effectState, message) {
		super(`[${code}] ${message} — ${effectClause(effectState)}。下一步：${HINTS[code]}`);
		this.name = "BridgeError";
		this.code = code;
		this.effectState = effectState;
		this.hint = HINTS[code];
		this.command = command;
		this.detail = message;
	}
	/** 给 HTTP 面用的扁平 JSON 形状。 */
	toJSON() {
		return {
			ok: false,
			error: this.detail,
			code: this.code,
			effectState: this.effectState,
			hint: this.hint
		};
	}
};
/**
* 把任意底层抛出的错误归类成 BridgeError。已经分类过的原样返回，
* 保证多次包裹不会把 code 洗掉。
*/
function classify(command, error) {
	if (error instanceof BridgeError) return error;
	const raw = error instanceof Error ? error.message : String(error);
	const locked = raw.startsWith("browser-locked-by-user:") ? "locked_by_user" : raw.startsWith("browser-lock-unreadable:") ? "lock_unreadable" : raw.startsWith("browser-hold-aborted:") ? "held_by_user" : raw.startsWith("browser-yielded-to-user:") ? "yielded_to_user" : raw.startsWith("browser-incognito-unavailable:") ? "incognito_unavailable" : void 0;
	const markerLength = locked === "locked_by_user" ? 23 : locked === "lock_unreadable" ? 24 : locked === "held_by_user" ? 21 : locked === "yielded_to_user" ? 24 : locked === "incognito_unavailable" ? 30 : 0;
	const message = locked ? raw.slice(markerLength).trim() : raw;
	const unknownIsPossible = isWriteCommand(command);
	let code;
	if (locked !== void 0) code = locked;
	else if (/no browser extension connected/.test(message)) code = "extension_offline";
	else if (/disconnected mid-command|browser-bridge stopped/.test(message)) code = "link_lost";
	else if (/timed out after/.test(message)) code = "command_timeout";
	else if (/窗口现在是「最小化」|window is minimized/.test(message)) code = "window_minimized";
	else if (/毫秒内没有返回|did not return within/.test(message)) code = "capture_timeout";
	else if (/cancelled/.test(message)) code = "cancelled";
	else if (/尚未加载配置|not configured yet/.test(message)) code = "not_configured";
	else if (/未启用|not enabled|桥接启动失败|listen EADDR|settings integration/.test(message)) code = "bridge_disabled";
	else code = "command_failed";
	const effectState = code === "command_timeout" || code === "link_lost" ? unknownIsPossible ? "unknown" : "not_started" : code === "command_failed" ? /unknown command/i.test(message) ? "not_started" : unknownIsPossible ? "unknown" : "not_started" : "not_started";
	return new BridgeError(command, code, effectState, message);
}
//#endregion
//#region lib/types/server.js
/**
* Local WebSocket+HTTP bridge between one browser extension and dsh. The
* extension connects OUT to `ws://127.0.0.1:<port>/ws?token=...`, so no
* native-messaging host or registry setup exists; dsh drives commands through
* {@link BridgeServer.execute} and reads link state through {@link BridgeServer.status}.
* A small HTTP face (`/api/status`, `/api/command`, `/api/cleanup`, `/`) keeps
* the bridge usable from curl while the server runs. `/api/command` and
* `/api/cleanup` demand the same token as the WebSocket upgrade; `/` and
* `/api/status` stay readable because the status page needs them and they only
* report link state. No response carries `Access-Control-Allow-Origin`, and the
* upgrade checks `Host` plus `Origin` so neither a web page nor a rebound
* hostname can attach.
*
* Wire protocol (text frames, one JSON object each):
* - extension → server: `{type:'hello',…}`, `{type:'pong',t}`, `{type:'result',id,ok,result?|error}`
* - server → extension: `{type:'ping',t}`, `{type:'command',id,command,params}`
*
* Command names (sent in `command`) include: `ping`, `browser.info`, `tabs.list/open/close/activate`,
* `nav`, `eval`, `content`, `find`, `click`, `input`, `press`, `scroll`, `snapshot`, `screenshot`,
* `wait`, `dialog`, `console.log`, `network.log`, `network.clear`, `pdf`, `emulate`.
* @module @deepseek-ai/dsh-browser-bridge/server
*/
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Hard ceiling accepted from callers; longer waits cannot be expressed. */
const MAX_COMMAND_TIMEOUT_MS = 3e5;
const MAX_HTTP_BODY_BYTES = 2097152;
/** The published default. It ships in README and `cordis.patch.yml`, so it is public knowledge. */
const DEFAULT_TOKEN = "dsh-local";
/** Tokens shorter than this cannot be brute-forced meaningfully; the bridge warns at start. */
const MIN_RECOMMENDED_TOKEN_LENGTH = 16;
/** Agent scratch-file convention: `__name.mjs`-style temp artifacts at the top level only. */
const SCRATCH_FILE_PATTERN = /^__[^/\\]+\.(mjs|cjs|js|png|jpg|jpeg)$/i;
/**
* Clear the screenshots directory and delete agent scratch files. Only the
* top level of each location is touched; nested trees stay untouched.
* @param options - `shotsDir` is cleared of direct file children; `scratchDir`
*   defaults to the process working directory and loses only scratch-named files.
* @returns counts and names of what was removed.
*/
async function cleanupArtifacts(options) {
	await mkdir(options.shotsDir, { recursive: true });
	const shotsEntries = await readdir(options.shotsDir, { withFileTypes: true });
	let shotsRemoved = 0;
	for (const entry of shotsEntries) {
		if (!entry.isFile()) continue;
		await rm(path.join(options.shotsDir, entry.name));
		shotsRemoved += 1;
	}
	const scratchDir = options.scratchDir ?? process.cwd();
	const scratchEntries = await readdir(scratchDir, { withFileTypes: true }).catch(() => []);
	const scratchRemoved = [];
	for (const entry of scratchEntries) {
		if (!entry.isFile() || !SCRATCH_FILE_PATTERN.test(entry.name)) continue;
		await rm(path.join(scratchDir, entry.name));
		scratchRemoved.push(entry.name);
	}
	return {
		shotsRemoved,
		scratchRemoved
	};
}
/**
* One live bridge endpoint. Start/stop may cycle repeatedly on one instance;
* a fresh listener is built per start so a changed config reuses the class
* without re-allocation concerns. Exactly one extension link is held at a
* time; a newer WebSocket replaces the older one.
*/
var BridgeServer = class {
	options;
	httpServer;
	clientSocket;
	hello;
	connectedAt;
	pending = /* @__PURE__ */ new Map();
	lastError;
	continuationRemainder = "";
	continuationOpen = false;
	constructor(options) {
		this.options = options;
	}
	/** Current link state, also served verbatim as `/api/status`. */
	get status() {
		return {
			listening: this.httpServer !== void 0,
			port: this.httpServer !== void 0 ? this.options.port : void 0,
			extensionConnected: this.clientSocket !== void 0,
			connectedAt: this.connectedAt?.toISOString(),
			hello: this.hello,
			bridgeProtocol: 1,
			extensionProtocol: this.hello?.protocol ?? 0,
			protocolCompatible: this.protocolNote === null,
			protocolNote: this.protocolNote,
			pendingCommands: this.pending.size,
			lastError: this.lastError,
			insecureToken: this.insecureToken
		};
	}
	get insecureToken() {
		return this.options.token === DEFAULT_TOKEN || this.options.token.trim().length < MIN_RECOMMENDED_TOKEN_LENGTH;
	}
	/** Bind `127.0.0.1:<port>` and start accepting the extension plus HTTP calls. */
	async start() {
		if (this.httpServer !== void 0) return;
		const server = http.createServer((req, res) => {
			try {
				this.handleHttp(req, res);
			} catch (error) {
				this.log(`http handler failed: ${errorMessage$1(error)}`);
				res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({
					ok: false,
					error: "internal error"
				}));
			}
		});
		server.on("upgrade", (req, socket) => {
			try {
				this.handleUpgrade(req, socket);
			} catch (error) {
				this.log(`upgrade failed: ${errorMessage$1(error)}`);
				socket.destroy();
			}
		});
		await new Promise((resolve, reject) => {
			const onError = (error) => {
				server.off("listening", onListening);
				this.lastError = errorMessage$1(error);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.options.port, "127.0.0.1");
		});
		this.httpServer = server;
		this.log(`listening on ws://127.0.0.1:${this.options.port}/ws`);
		if (this.insecureToken) this.log(`insecure token (${this.options.token === DEFAULT_TOKEN ? "the published default" : "shorter than 16 chars"}) — any local process can present it; set a longer \`token\` in the browser-bridge config`);
	}
	/** Close the extension link, fail every pending command, and release the port. Idempotent. */
	async stop() {
		const server = this.httpServer;
		if (server === void 0) return;
		this.httpServer = void 0;
		this.closeClientSocket(1001, "server stopping");
		this.failAllPending(/* @__PURE__ */ new Error("browser-bridge stopped"));
		await new Promise((resolve) => {
			server.close(() => resolve());
		});
		this.log("stopped");
	}
	/**
	* Send one command to the connected extension and await its result.
	* Throws while no extension is linked; the rejection message names the fix.
	*/
	async execute(command, params, options = {}) {
		const socket = this.clientSocket;
		if (socket === void 0) throw classify(command, /* @__PURE__ */ new Error("no browser extension connected — open the browser that has the DSH Browser extension installed"));
		const timeoutMs = Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? 6e4));
		const signal = options.signal;
		if (signal?.aborted) throw new Error(`browser command cancelled before send: ${command}`);
		const id = randomUUID();
		const entry = {
			command,
			resolve: () => {},
			reject: () => {},
			timer: setTimeout(() => {
				if (!this.pending.delete(id)) return;
				entry.reject(/* @__PURE__ */ new Error(`browser command timed out after ${timeoutMs}ms: ${command}`));
			}, timeoutMs)
		};
		const result = new Promise((resolve, reject) => {
			entry.resolve = resolve;
			entry.reject = reject;
		});
		if (signal !== void 0) {
			entry.onAbort = () => {
				if (!this.pending.delete(id)) return;
				entry.reject(/* @__PURE__ */ new Error(`browser command cancelled: ${command}`));
			};
			signal.addEventListener("abort", entry.onAbort, { once: true });
		}
		this.pending.set(id, entry);
		this.log(`-> ${command} (${id})`);
		socket.write(encodeTextFrame(JSON.stringify({
			type: "command",
			id,
			command,
			params
		})));
		try {
			return await result;
		} catch (error) {
			throw classify(command, error);
		} finally {
			clearTimeout(entry.timer);
			if (entry.onAbort !== void 0 && signal !== void 0) signal.removeEventListener("abort", entry.onAbort);
		}
	}
	/**
	* Delete generated screenshots and agent scratch files via
	* {@link cleanupArtifacts} using this server's configured directories.
	*/
	async cleanup() {
		const result = await cleanupArtifacts({
			shotsDir: this.options.shotsDir,
			...this.options.scratchDir === void 0 ? {} : { scratchDir: this.options.scratchDir }
		});
		this.log(`cleanup: ${result.shotsRemoved} screenshot(s), ${result.scratchRemoved.length} scratch file(s)`);
		return result;
	}
	log(line) {
		this.options.log?.(line);
	}
	/**
	* Mismatch description, or null when the two sides can talk. An older
	* extension that declares nothing is treated as v1-compatible: it still
	* answers every command this bridge has ever sent, so failing the link would
	* break working installs for a cosmetic gap.
	*/
	get protocolNote() {
		if (this.hello === void 0) return null;
		const theirs = this.hello.protocol;
		if (theirs === 0) return null;
		if (theirs > 1) return `扩展声明协议 v${theirs}，本桥只支持到 v1 —— 请升级 dsh 插件，否则新命令会报「未知命令」`;
		if (theirs < 1) return `扩展协议 v${theirs} 低于本桥 v1 —— 旧扩展可能缺少新命令，必要时重新下载扩展包`;
		return null;
	}
	/**
	* Whether a request carries the bridge token, the same credential the WebSocket
	* upgrade checks. Accepted forms: `Authorization: Bearer <token>`, `X-Token: <token>`
	* and `?token=<token>` (the query form exists for curl and for the status page).
	*/
	authorized(req, url) {
		const authorization = req.headers.authorization;
		const header = typeof authorization === "string" && /^bearer\s+/i.test(authorization) ? authorization.replace(/^bearer\s+/i, "") : typeof req.headers["x-token"] === "string" ? req.headers["x-token"] : "";
		return tokenMatches(header.length > 0 ? header : url.searchParams.get("token") ?? "", this.options.token);
	}
	rejectUnauthenticated(res, route) {
		this.log(`http ${route}: rejected (missing or wrong token)`);
		this.respondJson(res, 401, {
			ok: false,
			error: "unauthorized: pass the bridge token as \"Authorization: Bearer <token>\", \"X-Token: <token>\" or ?token=<token>"
		});
	}
	handleHttp(req, res) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}
		if (url.pathname === "/api/status" && req.method === "GET") {
			this.respondJson(res, 200, {
				ok: true,
				...this.status,
				wsUrl: `ws://127.0.0.1:${this.options.port}/ws`,
				shotsDir: path.resolve(this.options.shotsDir)
			});
			return;
		}
		if (url.pathname === "/api/cleanup" && req.method === "POST") {
			if (!this.authorized(req, url)) {
				this.rejectUnauthenticated(res, "POST /api/cleanup");
				return;
			}
			this.cleanup().then((result) => this.respondJson(res, 200, {
				ok: true,
				...result
			}), (error) => this.respondJson(res, 500, {
				ok: false,
				error: errorMessage$1(error)
			}));
			return;
		}
		if (url.pathname === "/api/command" && req.method === "POST") {
			if (!this.authorized(req, url)) {
				this.rejectUnauthenticated(res, "POST /api/command");
				return;
			}
			this.handleCommandRequest(req, res);
			return;
		}
		if (url.pathname === "/" && req.method === "GET") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(statusPageHtml(this.options.port));
			return;
		}
		this.respondJson(res, 404, {
			ok: false,
			error: `no route: ${req.method} ${url.pathname}`
		});
	}
	respondJson(res, statusCode, body) {
		res.writeHead(statusCode, {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store"
		});
		res.end(JSON.stringify(body));
	}
	handleCommandRequest(req, res) {
		const chunks = [];
		let size = 0;
		let aborted = false;
		req.on("data", (chunk) => {
			if (aborted) return;
			size += chunk.length;
			if (size > MAX_HTTP_BODY_BYTES) {
				aborted = true;
				chunks.length = 0;
				this.respondJson(res, 413, {
					ok: false,
					error: "body too large"
				});
				req.resume();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (aborted) return;
			let parsed;
			try {
				parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (error) {
				this.respondJson(res, 400, {
					ok: false,
					error: `invalid JSON body: ${errorMessage$1(error)}`
				});
				return;
			}
			if (typeof parsed.command !== "string" || parsed.command.length === 0) {
				this.respondJson(res, 400, {
					ok: false,
					error: "body must be {\"command\": \"...\", \"params\": {...}}"
				});
				return;
			}
			const timeoutMs = typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : void 0;
			this.execute(parsed.command, parsed.params ?? {}, timeoutMs === void 0 ? {} : { timeoutMs }).then((result) => this.respondJson(res, 200, {
				ok: true,
				result
			}), (error) => {
				if (error instanceof BridgeError) {
					const status = error.code === "extension_offline" || error.code === "bridge_disabled" || error.code === "not_configured" ? 503 : error.code === "command_timeout" || error.code === "link_lost" ? 504 : 502;
					this.respondJson(res, status, error.toJSON());
					return;
				}
				this.respondJson(res, 502, {
					ok: false,
					error: errorMessage$1(error)
				});
			});
		});
	}
	handleUpgrade(req, socket) {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname !== "/ws") {
			socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
			socket.destroy();
			return;
		}
		if (!tokenMatches(url.searchParams.get("token") ?? "", this.options.token)) {
			this.log("websocket rejected: bad token");
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		if (!isLoopbackHost(String(req.headers.host ?? ""))) {
			this.log(`websocket rejected: host ${req.headers.host}`);
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
		if (!isTrustedUpgradeOrigin(origin)) {
			this.log(`websocket rejected: origin ${origin}`);
			socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
			socket.destroy();
			return;
		}
		const key = req.headers["sec-websocket-key"];
		if (typeof key !== "string" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
			socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
			socket.destroy();
			return;
		}
		const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
		socket.write(`HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r\n\r
`);
		this.closeClientSocket(1e3, "replaced by a newer connection");
		this.clientSocket = socket;
		this.hello = void 0;
		this.connectedAt = /* @__PURE__ */ new Date();
		this.continuationRemainder = "";
		this.continuationOpen = false;
		this.log(`extension connected from ${socket.remoteAddress}:${socket.remotePort}`);
		const reader = new FrameReader();
		socket.on("data", (chunk) => {
			reader.push(chunk);
			try {
				reader.drain((frame) => this.handleFrame(frame));
			} catch (error) {
				this.log(`protocol error: ${errorMessage$1(error)}`);
				this.lastError = errorMessage$1(error);
				this.closeClientSocket(1002, "protocol error");
			}
		});
		socket.on("error", (error) => {
			this.logVerbose(`socket error: ${errorMessage$1(error)}`);
			this.closeClientSocket(1011, "server error");
		});
		socket.on("close", () => {
			if (this.clientSocket !== socket) return;
			this.closeClientSocket(1e3, "");
		});
	}
	handleFrame(frame) {
		switch (frame.opcode) {
			case 1:
			case 0:
				this.handleText(frame.payload.toString("utf8"), frame.fin, frame.opcode);
				return;
			case 8:
				this.closeClientSocket(1e3, "");
				return;
			case 9:
				this.clientSocket?.write(encodeControlFrame(10, frame.payload));
				return;
			default: return;
		}
	}
	handleText(text, fin, opcode) {
		if (opcode === 0 && !this.continuationOpen) return;
		if (opcode === 1) this.continuationRemainder = "";
		this.continuationOpen = opcode === 0 || !fin;
		this.continuationRemainder += text;
		if (!fin) return;
		const full = this.continuationRemainder;
		this.continuationRemainder = "";
		this.continuationOpen = false;
		let msg;
		try {
			msg = JSON.parse(full);
		} catch {
			this.logVerbose("dropped a non-JSON extension message");
			return;
		}
		if (msg.type === "hello") {
			const declared = typeof msg.protocol === "number" ? msg.protocol : 0;
			this.hello = {
				client: typeof msg.client === "string" ? msg.client : "unknown",
				version: typeof msg.version === "string" ? msg.version : "unknown",
				protocol: declared,
				browser: msg.browser ?? {
					name: "unknown",
					version: "unknown",
					ua: ""
				},
				...typeof msg.incognitoAllowed === "boolean" ? { incognitoAllowed: msg.incognitoAllowed } : {}
			};
			this.log(`hello: client=${this.hello.client} v${this.hello.version} protocol=v${declared || "?"} browser=${this.hello.browser.name} ${this.hello.browser.version}${this.hello.incognitoAllowed === void 0 ? "" : ` incognito=${this.hello.incognitoAllowed ? "allowed" : "denied"}`}`);
			const note = this.protocolNote;
			if (note !== null) this.log(`protocol mismatch: ${note}`);
			return;
		}
		if (msg.type === "pong") return;
		if (msg.type === "result" && typeof msg.id === "string") {
			const entry = this.pending.get(msg.id);
			if (entry === void 0) {
				this.logVerbose(`result for unknown id ${msg.id}`);
				return;
			}
			this.pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.ok === true) entry.resolve(msg.result);
			else entry.reject(new Error(typeof msg.error === "string" && msg.error.length > 0 ? msg.error : "unknown extension error"));
		}
	}
	closeClientSocket(code, reason) {
		const socket = this.clientSocket;
		if (socket === void 0) return;
		this.clientSocket = void 0;
		this.hello = void 0;
		this.connectedAt = void 0;
		this.failAllPending(/* @__PURE__ */ new Error("the browser extension disconnected mid-command"));
		try {
			socket.write(encodeCloseFrame(code, reason));
			socket.end();
			setTimeout(() => socket.destroy(), 500).unref();
		} catch {
			socket.destroy();
		}
		if (reason.length > 0) this.log(`extension disconnected (${reason})`);
	}
	failAllPending(error) {
		for (const [, entry] of this.pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
	logVerbose(line) {
		this.options.log?.(line);
	}
};
function errorMessage$1(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Constant-time token comparison; a length mismatch is the only thing leaked. */
function tokenMatches(presented, expected) {
	const a = Buffer.from(presented, "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}
/**
* `Host` must name the loopback address this server binds. Rejecting anything else is
* what stops a rebinding setup (a public hostname resolving to 127.0.0.1) from reaching
* the bridge through the browser.
*/
function isLoopbackHost(host) {
	const withoutPort = host.replace(/:\d+$/, "");
	return withoutPort === "127.0.0.1" || withoutPort === "localhost" || withoutPort === "[::1]" || withoutPort === "::1";
}
/**
* An `Origin` of a web scheme means a page opened the socket — WebSocket handshakes are
* not covered by CORS, so that has to be refused here. Extension schemes (`chrome-extension:`
* etc.) and non-browser clients that send no Origin at all are accepted.
*/
function isTrustedUpgradeOrigin(origin) {
	if (origin === "") return true;
	if (/^(?:chrome|moz|ms|safari)-extension:\/\//.test(origin)) return true;
	return /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(origin);
}
/** Minimal self-refreshing status page with the cleanup action. */
function statusPageHtml(port) {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Browser — 状态</title>
<style>
  :root{--bg:#0f172a;--card:#1e293b;--border:#334155;--text:#e2e8f0;--dim:#94a3b8;
        --green:#22c55e;--green-bg:rgba(34,197,94,.12);--red:#ef4444;--red-bg:rgba(239,68,68,.10)}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;background:var(--bg);
       color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;max-width:440px;width:100%;overflow:hidden}
  .head{padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px}
  .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;background:var(--red)}
  .dot.on{background:var(--green);box-shadow:0 0 6px var(--green)}
  .head h1{font-size:15px;font-weight:600}.head small{color:var(--dim);font-size:11px}
  .rows{padding:16px 24px}
  .row{display:flex;justify-content:space-between;align-items:baseline;padding:7px 0;
       border-bottom:1px solid var(--border);font-size:13px}
  .row:last-child{border-bottom:none}
  .row .k{color:var(--dim)}.row .v{font-weight:500;text-align:right;max-width:260px;word-break:break-all}
  .badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:600}
  .badge.on{background:var(--green-bg);color:var(--green)}.badge.off{background:var(--red-bg);color:var(--red)}
  .actions{padding:8px 24px;display:flex;gap:8px}
  .btn{padding:7px 14px;border:1px solid var(--border);border-radius:9px;background:var(--card);
       color:var(--text);font-size:12px;cursor:pointer}.btn:hover{background:#334155}
  .btn.danger{border-color:var(--red);color:var(--red)}.btn.danger:hover{background:var(--red-bg)}
  .tok{flex:1;min-width:150px;padding:7px 10px;border:1px solid var(--border);border-radius:9px;
       background:var(--bg);color:var(--text);font-size:12px}
  .hint{color:var(--dim);font-size:11px;padding:4px 24px 8px}
  .pre{background:var(--bg);border-top:1px solid var(--border);padding:12px 24px}
  .pre code{color:var(--dim);font-size:11px;white-space:pre-wrap;word-break:break-all}
  .foot{text-align:center;padding:12px;font-size:11px;color:var(--dim)}
</style>
</head>
<body>
<div class="card">
  <div class="head">
    <div class="dot" id="dot"></div>
    <div><h1>DSH Browser</h1><small id="sub">加载中…</small></div>
  </div>
  <div class="rows" id="rows"></div>
  <div class="actions">
    <input class="tok" id="token" type="password" placeholder="桥接 Token（清理按钮需要）" autocomplete="off">
    <button class="btn" onclick="refresh()">刷新</button>
    <button class="btn danger" id="cleanup">🧹 清理截图 + 脚本草稿</button>
  </div>
  <div class="hint">Token 只保存在本次浏览器会话（sessionStorage），不写盘；留空则点按钮时询问。/api/command 与 /api/cleanup 现在都要求带 Token。</div>
  <div class="pre"><code id="raw"> </code></div>
  <div class="foot">DSH Browser Bridge · 127.0.0.1:${port}</div>
</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/api/status');const j=await r.json();
    const connected=j.extensionConnected;
    document.getElementById('dot').className='dot'+(connected?' on':'');
    document.getElementById('sub').textContent=connected
      ?(j.hello?j.hello.client+' '+j.hello.browser.name+' '+j.hello.browser.version:'已连接')
      :'等待浏览器扩展连接…';
    const rows=[
      ['监听端口','<span class="badge on">'+j.port+'</span>'],
      ['扩展状态',connected?'<span class="badge on">已连接</span>':'<span class="badge off">未连接</span>'],
      ['扩展类型',j.hello?(j.hello.client+' v'+j.hello.version):'—'],
      ['浏览器',j.hello?(j.hello.browser.name+' '+j.hello.browser.version):'—'],
      ['等待命令',String(j.pendingCommands??0)],
      ['连接时间',j.connectedAt?new Date(j.connectedAt).toLocaleString():'—'],
      ['截图目录',j.shotsDir||'—'],
      ['令牌强度',j.insecureToken?'<span class="badge off">默认/过短，建议改了</span>':'<span class="badge on">已自定义</span>'],
      ['协议版本','桥 v'+j.bridgeProtocol+' / 扩展 v'+(j.extensionProtocol||'?')+(j.protocolCompatible?'':' <span class="badge off">不匹配</span>')],
    ];
    if(j.protocolNote) rows.push(['协议提示','<span style="color:var(--red)">'+j.protocolNote+'</span>']);
    document.getElementById('rows').innerHTML=rows.map(([k,v])=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+v+'</span></div>').join('');
    document.getElementById('raw').textContent=JSON.stringify(j,null,2);
  }catch(e){document.getElementById('sub').textContent='连接失败: '+e.message}
}
function bridgeToken(){
  const el=document.getElementById('token');
  let t=(el.value||'').trim()||sessionStorage.getItem('dshBridgeToken')||'';
  if(!t){ t=(prompt('桥接 Token（在 profile 的 browser-bridge 配置里，token 字段）')||'').trim(); el.value=t; }
  if(t) sessionStorage.setItem('dshBridgeToken',t);
  return t;
}
document.getElementById('cleanup').onclick=async()=>{
  if(!confirm('确认清理截图与临时脚本？'))return;
  const r=await fetch('/api/cleanup',{method:'POST',headers:{'Authorization':'Bearer '+bridgeToken()}});
  const j=await r.json();
  if(r.status===401){alert('Token 不对，清理没有执行。');return;}
  alert(j.ok?('已删除 '+j.shotsRemoved+' 个截图，'+j.scratchRemoved.length+' 个草稿'):('失败：'+j.error));
  refresh();
};
refresh();setInterval(refresh,2000);
<\/script>
</body></html>`;
}
//#endregion
//#region lib/types/policy.js
/**
* 本机策略闸门：只读档（`readOnly`）与脚本开关（`allowScript`）。
*
* 这两张表与 `errors.ts` 里的 `WRITE_COMMANDS` **故意不是同一张**，别合并：
*
*   - `WRITE_COMMANDS` 回答「超时或掉线之后重试，会不会多留一次副作用」，那是
*     `effectState` 的语义。所以 `tabs.group` / `tabs.ungroup` 在那里**刻意算只读**：
*     重复把标签归进同一个组是空操作，重试安全。
*   - 这里回答的是「这条命令会不会改变页面、文件或浏览器状态」，用户开只读档时想要的
*     正是这个。所以 `tabs.group` / `tabs.ungroup` / `tabs.activate` / `emulate` /
*     `dialog` / `network.clear` 都不在白名单里。
*
* 白名单是**默认拒绝**：扩展以后新增一条命令，它自动被只读档拦下，等人判断完再放进来。
* `verify/verify_policy.mjs` 会把扩展 `COMMANDS` 表逐条对账，让这个判断无法被跳过。
*
* 第三张表 `LOCAL_DESTRUCTIVE_COMMANDS` 是给**不经过扩展**的插件本地命令的：闸门如果只长在
* `execute()` 上，这类调用就整个绕开只读档（`browser_cleanup` 合并进来时正是这样）。
*/
/** 只读档允许的命令：读页面、读扩展自己的缓冲、或者把页面**内容**落到本机文件。 */
const READ_ONLY_ALLOWED = /* @__PURE__ */ new Set([
	"ping",
	"browser.info",
	"profile.status",
	"content",
	"find",
	"snapshot",
	"screenshot",
	"pdf",
	"wait",
	"tabs.list",
	"console.log",
	"network.log"
]);
/**
* 会执行**任意页面脚本**的扩展命令。这条与只读档分开管，因为用户可能想「可以读、
* 也可以点，但别在我页面里跑任意 JS」——`browser_evaluate` 能绕开其他所有工具做的事。
*/
const SCRIPT_COMMANDS = /* @__PURE__ */ new Set(["eval", "cdp.call"]);
/**
* 不经过扩展、直接在插件进程里改动本机文件的命令名。
*
* `browser_cleanup` 走 `BridgeController.cleanup()`，**不经过 `execute()`**，所以它天然
* 绕开了上面两张表管的那条路。只读档下仍然能删掉用户的整个截图目录，这正是「只读」
* 最不该允许的动作，所以单独列一张表，并且由 `cleanup()` 自己调闸门。
*/
const LOCAL_DESTRUCTIVE_COMMANDS = /* @__PURE__ */ new Set(["cleanup"]);
/**
* 不经过扩展、会**在用户屏幕上拉起一个程序**的插件本地命令。
*
* `browser_launch` 要在浏览器没开的时候把它启动起来——那时扩展根本不在运行，没有
* 任何东西能执行命令，所以这件事只能由宿主进程自己 spawn。它因此天然绕开每一张
* 扩展命令表，必须单独登记：只读档下"在用户桌面弹出一个窗口"毫无疑问属于改写
* 状态的范畴，而它的成本也是可见的（一个窗口、一次冷启动）。
*
* 与 `LOCAL_DESTRUCTIVE_COMMANDS` 分开列，因为**拒因不同**：那是"删东西不可逆"，
* 这是"往用户的桌面上放一个窗口"，文案必须各自说清。
*/
const LOCAL_SPAWN_COMMANDS = /* @__PURE__ */ new Set(["launch"]);
/**
* 明确登记「会改页面 DOM」的命令 —— 只读档里必须拒，理由写在名字旁边。
*
* 现在往页面 `<html>` 下插宿主的只有 `hold`（接管浮层）。AI 高亮框是**扩展侧自动**做的
* （认领标签页时顺手插一层，没有对应命令），所以它不在这张表里；只读档也不受影响：
* `tabs.open` / `tabs.group` / `tabs.activate` 在只读档里本就被拒，认领发生不了，框也就
* 画不出来。默认拒绝其实已经盖住它，但「默认拒绝是对的」不等于「不需要解释」：这一条要
* 的不是安全性，是**拒绝理由**——告诉模型为什么一个「只是提示用户」的动作在只读档里也
* 算写操作。
*
* `hold` 是一条命令带 `action`（on/off/status）：on/off 改 DOM，**status 只读**
* （它读 session 里的条目 + 探一下页面上还有没有那层宿主），所以只读档放行 status。
* 这也是 `policyRefusal` 唯一需要看参数的地方——判据是「这个动作改不改东西」，
* 不是「这个命令名字在不在表里」。
*/
const PAGE_MUTATING_COMMANDS = /* @__PURE__ */ new Set(["hold"]);
const CONFIG_HINT = "开关在 profile 的 cordis.patch.yml 里（browser-bridge 的 config），改完重启 dsh；dsh 0.1.7+ 的宿主也会在「设置 → 插件」里直接列出这两项";
/**
* 判断一条命令是否被本机策略拦下。
* @param command - 扩展命令名（`click` / `eval` / `tabs.close` …），或 `LOCAL_DESTRUCTIVE_COMMANDS` 里的插件本地命令名。
* @param flags - 当前的两个闸门值。
* @param params - 这条命令的参数；只有带动作的命令（目前是 `hold`）需要它来分辨「这个动作改不改东西」。
* @returns 拒绝时写给 agent 的整句理由；放行时 `undefined`。
*/
function policyRefusal(command, flags, params) {
	if (!flags.allowScript && SCRIPT_COMMANDS.has(command)) return `在页面里执行任意脚本已被关闭（allowScript: false）：命令 ${command} 被拒绝，没有向浏览器发出任何操作。要读页面内容请改用 browser_read / browser_snapshot / browser_find；确实需要执行脚本时，${CONFIG_HINT}之后再说。`;
	if (!flags.allowIncognito && command === "profile.launch") return `隔离实例默认关闭（allowIncognito: false）：命令 ${command} 被拒绝，没有打开任何无痕窗口。它会在浏览器里新开一个无痕窗口（独立 cookie 罐，退出即清），既是用户屏上可见的动作，也能绕开用户真实会话，所以要显式打开。要放开就${CONFIG_HINT}把 allowIncognito 打开（设置页「浏览器控制」里也有这个开关），并且还要在浏览器扩展管理页允许本扩展在无痕/InPrivate 中运行——那是浏览器那层的权限，插件改不了。不要原地重试本命令。`;
	if (flags.readOnly && LOCAL_DESTRUCTIVE_COMMANDS.has(command)) return `只读模式已开启（readOnly: true）：命令 ${command} 会删除本机保存的截图与临时文件，删除不可逆，所以已被拒绝，没有任何文件被删除。只读档的含义是「什么都不要改」，清理属于改动；要释放磁盘请由用户自己关掉 readOnly，${CONFIG_HINT}。不要原地重试本命令。`;
	if (flags.readOnly && LOCAL_SPAWN_COMMANDS.has(command)) return `只读模式已开启（readOnly: true）：命令 ${command} 会在你的桌面上启动一个浏览器程序（一个可见窗口、一次冷启动），已被拒绝，没有启动任何进程。只读档的含义是「什么都不要改」；要启动浏览器请由用户自己关掉 readOnly 后重试，${CONFIG_HINT}。另外：如果浏览器本来就开着、只是扩展没连上，这条命令也帮不了你——让用户看一眼扩展图标是不是绿色。不要原地重试本命令。`;
	const isReadOnlyAction = command === "hold" && params?.action === "status";
	if (flags.readOnly && PAGE_MUTATING_COMMANDS.has(command) && !isReadOnlyAction) return `只读模式已开启（readOnly: true）：命令 ${command} 会往页面里插入一层接管浮层（改页面 DOM），已被拒绝，没有向浏览器发出任何操作。浮层是给用户看的提示层，不是安全边界；只读档里连这种「只是提示」的改动也一并拒绝。要开浮层请由用户关掉 readOnly，${CONFIG_HINT}不要原地重试本命令。`;
	if (flags.readOnly && !READ_ONLY_ALLOWED.has(command) && !isReadOnlyAction) return `只读模式已开启（readOnly: true）：命令 ${command} 会改变页面或浏览器状态，已被拒绝，没有向浏览器发出任何操作。只读模式下可用的工具是读页面与读日志那几类；要放开写操作，${CONFIG_HINT}不要原地重试本命令。`;
}
//#endregion
//#region lib/types/settings-routes.js
/** Absolute prefix the route owns on the Web server. */
const SETTINGS_API_PREFIX = "/browser-control/api";
/** Largest request body this endpoint buffers; the payloads are tiny. */
const MAX_BODY_BYTES = 262144;
/** A failure the caller can act on; `status` is the HTTP status. */
var RouteError = class extends Error {
	status;
	code;
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
	}
};
/**
* Config fields the Settings page may flip — booleans only. Everything else is
* profile-only (port, token, shotsDir).
*/
const BOOLEAN_FIELDS = /* @__PURE__ */ new Set([
	"readOnly",
	"allowScript",
	"lazyToolDocs",
	"allowRawCdp",
	"allowIncognito",
	"agentHighlight"
]);
/**
* Enum fields and the only values each accepts. The words are the wire/config
* vocabulary, never the Chinese labels: the page may re-word a label without
* touching what lands in the profile, and the extension keeps reading one name
* per behaviour.
*/
const ENUM_FIELDS = {
	tabWindow: ["current", "new"],
	focusPolicy: ["avoid", "auto"],
	userTakeover: ["yield", "ignore"]
};
function recordOf(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function headerOf(req, name) {
	const value = req.headers[name];
	if (Array.isArray(value)) return value[0];
	return typeof value === "string" ? value : void 0;
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
* Apply the browser-trust fence to one request.
* @param req - the incoming request.
* @param origin - this listener's own authority (`host:port`), captured at mount time.
* @returns true only for a same-authority browser request or a local non-browser client.
*/
function isTrusted(req, origin) {
	const rawHost = headerOf(req, "host")?.trim().toLowerCase();
	if (rawHost === void 0 || rawHost.length === 0) return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${rawHost}`);
	} catch {
		return false;
	}
	const ownAuthority = origin === void 0 ? false : (() => {
		try {
			return new URL(origin).host.toLowerCase() === hostUrl.host.toLowerCase();
		} catch {
			return false;
		}
	})();
	if (!isLoopbackHostname(hostUrl.hostname) && !ownAuthority) return false;
	if (headerOf(req, "sec-fetch-site") === "cross-site") return false;
	const originHeader = headerOf(req, "origin");
	if (originHeader === void 0) return true;
	try {
		return new URL(originHeader).host.toLowerCase() === hostUrl.host.toLowerCase();
	} catch {
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
		if (bytes > MAX_BODY_BYTES) throw new RouteError(413, "body_too_large", "request body is too large");
		chunks.push(buffer);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text.length === 0) return {};
	try {
		return recordOf(JSON.parse(text));
	} catch {
		throw new RouteError(400, "bad_json", "request body is not valid JSON");
	}
}
function writeJson(res, status, payload) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(payload));
}
function fail(res, status, code, message) {
	writeJson(res, status, {
		ok: false,
		error: {
			code,
			message
		}
	});
}
/** Mask the shared secret; the page never receives the value that would grant command access. */
function maskToken(token) {
	if (typeof token !== "string" || token.length === 0) return null;
	if (token.length <= 4) return "****";
	return `${token.slice(0, 2)}${"*".repeat(Math.min(8, token.length - 4))}${token.slice(-2)}`;
}
/** 只列真正能打开的网页：`chrome://`、`edge://`、`about:blank`、扩展页都是菜单里的噪音。 */
function isBrowsableUrl(url) {
	return typeof url === "string" && /^https?:\/\//i.test(url);
}
/** 标题兜底：扩展偶尔给空标题（有些页面 `document.title` 就是空的），菜单里不能出现空行。 */
function tabTitleOf(url, title) {
	const trimmed = typeof title === "string" ? title.trim() : "";
	if (trimmed.length > 0) return trimmed;
	try {
		const parsed = new URL(url);
		return `${parsed.host}${parsed.pathname}`;
	} catch {
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
	if (a.active !== b.active) return a.active ? -1 : 1;
	if (a.windowId !== b.windowId) return a.windowId - b.windowId;
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
function selectReferenceTabs(raw, limit = 50) {
	const rows = Array.isArray(recordOf(raw).tabs) ? recordOf(raw).tabs : [];
	const seen = /* @__PURE__ */ new Set();
	const kept = [];
	for (const row of rows) {
		const tab = recordOf(row);
		const id = tab.id;
		if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) continue;
		if (seen.has(id)) continue;
		seen.add(id);
		if (tab.incognito === true) continue;
		if (tab.openedByAgent === true) continue;
		if (!isBrowsableUrl(tab.url)) continue;
		kept.push({
			id,
			title: tabTitleOf(tab.url, tab.title),
			url: tab.url,
			windowId: typeof tab.windowId === "number" && Number.isFinite(tab.windowId) ? tab.windowId : 0,
			active: tab.active === true
		});
	}
	kept.sort(compareReferenceTabs);
	const total = kept.length;
	return {
		tabs: kept.slice(0, Math.max(0, limit)),
		total
	};
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
function createReferenceTabsCache(fetchTabs, options = {}) {
	const ttlMs = options.ttlMs ?? 2e3;
	const limit = options.limit ?? 50;
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
		if (signal === void 0) return await shared;
		if (signal.aborted) throw new Error("cancelled");
		let onAbort;
		const cancelled = new Promise((_resolve, reject) => {
			onAbort = () => reject(/* @__PURE__ */ new Error("cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([shared, cancelled]);
		} finally {
			if (onAbort !== void 0) signal.removeEventListener("abort", onAbort);
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
				const picked = selectReferenceTabs(await fetchTabs(ownAbort.signal), limit);
				const snapshot = {
					tabs: picked.tabs,
					fetchedAt: now(),
					stale: false,
					total: picked.total
				};
				snapshot.stale = staleOf(snapshot);
				cached = snapshot;
				return snapshot;
			} catch (error) {
				if (cached !== void 0) return {
					...cached,
					stale: staleOf(cached)
				};
				throw error;
			}
		})();
		inflight = run;
		const settle = () => {
			if (inflight === run) inflight = void 0;
		};
		run.then(settle, settle);
		return run;
	};
	return {
		async read(signal) {
			if (signal?.aborted) throw new Error("cancelled");
			if (cached !== void 0 && !staleOf(cached)) return {
				...cached,
				stale: staleOf(cached)
			};
			return await waitFor(inflight ?? start(), signal);
		},
		/** 路由摘掉时结束可能还在途的取数；供 `buildSettingsRoute` 的清理路径调用。 */
		dispose() {
			ownAbort.abort();
		}
	};
}
/** The JSON `/status` reports; deliberately no raw token, no file paths. */
function statusPayload(deps) {
	const config = deps.getConfig();
	return {
		bridge: deps.status(),
		config: config === void 0 ? null : {
			enabled: config.enabled === true,
			port: config.port ?? null,
			tokenMasked: maskToken(config.token),
			readOnly: config.readOnly === true,
			allowScript: config.allowScript !== false,
			lazyToolDocs: config.lazyToolDocs === true,
			allowRawCdp: config.allowRawCdp !== false,
			allowIncognito: config.allowIncognito === true,
			tabWindow: config.tabWindow === "new" ? "new" : "current",
			focusPolicy: config.focusPolicy === "auto" ? "auto" : "avoid",
			userTakeover: config.userTakeover === "ignore" ? "ignore" : "yield",
			tabGroupTitle: typeof config.tabGroupTitle === "string" ? config.tabGroupTitle : "DSH",
			agentHighlight: config.agentHighlight !== false,
			browserPath: typeof config.browserPath === "string" ? config.browserPath : ""
		}
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
		if (allowed !== void 0) {
			if (typeof value !== "string" || !allowed.includes(value)) throw new RouteError(400, "bad_field", `${key} must be one of ${allowed.join(" | ")}`);
			out[key] = value;
			continue;
		}
		if (key === "tabGroupTitle") {
			if (typeof value !== "string") throw new RouteError(400, "bad_field", "tabGroupTitle must be a string");
			const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
			if (title.length > 40) throw new RouteError(400, "bad_field", `tabGroupTitle must be at most 40 characters`);
			out[key] = title;
			continue;
		}
		if (key === "browserPath") {
			if (typeof value !== "string") throw new RouteError(400, "bad_field", "browserPath must be a string");
			const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
			if (cleaned.length > 512) throw new RouteError(400, "bad_field", `browserPath must be at most 512 characters`);
			out[key] = cleaned;
			continue;
		}
		if (!BOOLEAN_FIELDS.has(key)) throw new RouteError(400, "unknown_field", `unknown config field: ${key}`);
		if (typeof value !== "boolean") throw new RouteError(400, "bad_field", `${key} must be a boolean`);
		out[key] = value;
	}
	if (Object.keys(out).length === 0) throw new RouteError(400, "empty_patch", "patch carries no editable field");
	return out;
}
/** Duck-typed entry addressing: Loader entry shapes differ across host generations. */
function entryName(entry) {
	const record = recordOf(entry);
	const options = recordOf(record.options);
	const value = record.name ?? options.name ?? record.packageName;
	return typeof value === "string" ? value : void 0;
}
function entryId(entry) {
	const record = recordOf(entry);
	const options = recordOf(record.options);
	const value = record.patchId ?? record.id ?? options.id;
	return typeof value === "string" ? value : void 0;
}
/**
* Persist one patch through the Host `configEditor`, the documented path from a
* raw config to a validated Loader reconciliation (a page edit therefore re-applies
* the plugin exactly like a profile edit does).
*/
async function persistPatch(deps, patch) {
	const editor = deps.getService("configEditor");
	if (editor === void 0 || typeof editor.entries !== "function" || typeof editor.edit !== "function") throw new RouteError(501, "config_editor_unavailable", "这个宿主没有 configEditor 服务，设置页无法持久化：请改 profile 的 cordis.patch.yml（browser-bridge 的 config）后重启 dsh。");
	const entries = await Promise.resolve(editor.entries());
	const list = Array.isArray(entries) ? entries : [];
	const entry = list.find((item) => entryName(item) === deps.packageName) ?? list.find((item) => entryId(item) === "browser-bridge");
	if (entry === void 0) throw new RouteError(409, "entry_not_found", `在 profile 的配置行里找不到 ${deps.packageName}（patch id: browser-bridge）：请用 profile 覆盖层或插件详情页修改后重启。`);
	await Promise.resolve(editor.edit(entry, (current) => ({
		...recordOf(current),
		...patch
	})));
}
/** Build the one prefix route the Settings page talks to. */
function buildSettingsRoute(deps) {
	/**
	* 标签页缓存挂在**路由实例**上，不在模块级：路由跟着插件生命周期活，插件被重载时
	* 旧快照必须一起走——否则重载后第一秒菜单里还是上一个桥接会话的 tab id。
	*/
	const tabsCache = deps.listTabs === void 0 ? void 0 : createReferenceTabsCache((signal) => deps.listTabs(signal));
	/** 标签页端点的失败形态与 `action` 端点一致：HTTP 200 + `ok:false`。 */
	const failTabs = (res, error) => {
		writeJson(res, 200, {
			ok: false,
			error: {
				code: typeof error.code === "string" ? error.code : "tabs_failed",
				message: error instanceof Error ? error.message : String(error)
			}
		});
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
		if (tabsCache === void 0) throw new RouteError(501, "tabs_unavailable", "这个宿主没有接上标签页数据源：请确认插件已启用并重启 dsh。");
		const controller = new AbortController();
		const onClose = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.once("close", onClose);
		try {
			writeJson(res, 200, {
				ok: true,
				value: await tabsCache.read(controller.signal)
			});
		} catch (error) {
			if (controller.signal.aborted) return;
			failTabs(res, error);
		} finally {
			res.off("close", onClose);
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
		const tabId = (await readJsonBody(req)).tabId;
		if (typeof tabId !== "number" || !Number.isInteger(tabId) || tabId <= 0) throw new RouteError(400, "bad_field", "tabId must be a positive integer");
		if (deps.activateTab === void 0) throw new RouteError(501, "tabs_unavailable", "这个宿主没有接上标签页数据源：请确认插件已启用并重启 dsh。");
		const controller = new AbortController();
		const onClose = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.once("close", onClose);
		try {
			await deps.activateTab(tabId, controller.signal);
			writeJson(res, 200, {
				ok: true,
				value: { tabId }
			});
		} catch (error) {
			if (controller.signal.aborted) return;
			failTabs(res, error);
		} finally {
			res.off("close", onClose);
		}
	};
	const dispatch = async (endpoint, req, res) => {
		if (endpoint === "status") {
			writeJson(res, 200, {
				ok: true,
				value: statusPayload(deps)
			});
			return;
		}
		if (endpoint === "tabs") {
			await dispatchTabs(req, res);
			return;
		}
		if (endpoint === "tabs/activate") {
			await dispatchActivate(req, res);
			return;
		}
		if (endpoint === "config") {
			const patch = configPatchOf(await readJsonBody(req));
			await persistPatch(deps, patch);
			writeJson(res, 200, {
				ok: true,
				value: {
					persisted: true,
					patch
				}
			});
			return;
		}
		if (endpoint === "action") {
			const body = await readJsonBody(req);
			const action = typeof body.action === "string" ? body.action : "";
			if (action === "cleanup") {
				try {
					const result = await deps.cleanup();
					writeJson(res, 200, {
						ok: true,
						value: {
							shotsRemoved: result.shotsRemoved,
							scratchRemoved: [...result.scratchRemoved]
						}
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						error: {
							code: typeof error.code === "string" ? error.code : "cleanup_failed",
							message: error instanceof Error ? error.message : String(error)
						}
					});
				}
				return;
			}
			if (action === "openStatus") {
				const config = deps.getConfig();
				if (config?.port === void 0) throw new RouteError(409, "bridge_not_configured", "桥接还没读到配置，没有状态页可开");
				writeJson(res, 200, {
					ok: true,
					value: { url: `http://127.0.0.1:${config.port}/` }
				});
				return;
			}
			throw new RouteError(400, "unknown_action", `unknown action: ${action || "(empty)"}`);
		}
		throw new RouteError(404, "not_found", `unknown endpoint: ${endpoint || "(empty)"}`);
	};
	return {
		kind: "prefix",
		path: SETTINGS_API_PREFIX,
		async handler(req, res) {
			try {
				if (!isTrusted(req, deps.origin)) {
					fail(res, 403, "untrusted_request", "request did not pass the browser-trust fence");
					return;
				}
				const method = (req.method ?? "GET").toUpperCase();
				const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
				if (!pathname.startsWith(`/browser-control/api/`)) {
					fail(res, 404, "not_found", "unknown endpoint");
					return;
				}
				const endpoint = pathname.slice(21);
				if (method === "GET" && (endpoint === "status" || endpoint === "tabs")) {
					await dispatch(endpoint, req, res);
					return;
				}
				if (endpoint === "tabs") {
					fail(res, 405, "method_not_allowed", "use GET for this endpoint");
					return;
				}
				if (method !== "POST") {
					fail(res, 405, "method_not_allowed", "use POST for this endpoint");
					return;
				}
				if ((headerOf(req, "content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
					fail(res, 415, "unsupported_media_type", "content-type must be application/json");
					return;
				}
				await dispatch(endpoint, req, res);
			} catch (error) {
				if (error instanceof RouteError) {
					fail(res, error.status, error.code, error.message);
					return;
				}
				fail(res, 500, "internal_error", error instanceof Error ? error.message : String(error));
			}
		},
		...tabsCache === void 0 ? {} : { dispose: () => tabsCache.dispose() }
	};
}
//#endregion
//#region lib/types/tool-help.js
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
const TOOL_GROUPS = {
	read: [
		"browser_read",
		"browser_snapshot",
		"browser_find",
		"browser_info",
		"browser_wait",
		"browser_console_log",
		"browser_network_log"
	],
	write: [
		"browser_navigate",
		"browser_click",
		"browser_type",
		"browser_press",
		"browser_scroll",
		"browser_evaluate",
		"browser_hold",
		"browser_dialog"
	],
	tabs: [
		"browser_tabs",
		"browser_profile",
		"browser_launch",
		"browser_cleanup",
		"browser_network_clear"
	],
	capture: [
		"browser_screenshot",
		"browser_pdf",
		"browser_emulate"
	],
	raw: ["browser_cdp"]
};
/** 反查：工具属于哪个分组；不在表里返回 `undefined`（验台保证不会发生）。 */
function groupOf(name) {
	for (const [group, names] of Object.entries(TOOL_GROUPS)) if (names.includes(name)) return group;
}
/** First sentence (or a bounded prefix) of a description, for the catalog. */
function summarize(description) {
	const line = description.replace(/\s+/g, " ").trim();
	if (line.length === 0) return "(no description)";
	const stop = line.search(/[。！？]|\.\s/);
	const head = stop > 0 ? line.slice(0, stop + 1) : line;
	return head.length <= 120 ? head : `${head.slice(0, 117)}…`;
}
/** 轮询桥接连接状态的间隔（毫秒）。 */
const LAUNCH_POLL_INTERVAL_MS = 50;
/** 各平台**可执行文件名**的优先级表。用在 PATH 搜索与目录搜索兜底里。 */
const WINDOWS_EXE_NAMES = [
	{
		label: "Microsoft Edge",
		file: "msedge.exe"
	},
	{
		label: "Google Chrome",
		file: "chrome.exe"
	},
	{
		label: "Chromium",
		file: "chromium.exe"
	}
];
const POSIX_EXE_NAMES = [
	{
		label: "Microsoft Edge",
		file: "microsoft-edge"
	},
	{
		label: "Microsoft Edge",
		file: "microsoft-edge-stable"
	},
	{
		label: "Google Chrome",
		file: "google-chrome"
	},
	{
		label: "Google Chrome",
		file: "google-chrome-stable"
	},
	{
		label: "Chromium",
		file: "chromium"
	},
	{
		label: "Chromium",
		file: "chromium-browser"
	}
];
/**
* 各平台的**已知安装位置**，按优先级排列。
*
* 顺序是刻意的：**先 Edge 后 Chrome**，因为本仓库的实测环境是 Edge，用户给这个插件
* 装的扩展也在 Edge 里；先拉起 Edge 最可能直接命中已装扩展的那个。
* @param platform - `process.platform` 的值。
* @param env - 环境变量，便于验台注入。
* @returns 候选列表，顺序即优先级。
*/
function knownBrowserPaths(platform = process.platform, env = process.env) {
	if (platform === "win32") {
		const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
		const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const localAppData = env["LOCALAPPDATA"] ?? "";
		const out = [];
		for (const root of [programFilesX86, programFiles]) out.push({
			label: "Microsoft Edge",
			target: path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
			source: "known-path"
		});
		for (const root of [programFiles, programFilesX86]) out.push({
			label: "Google Chrome",
			target: path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
			source: "known-path"
		});
		if (localAppData !== "") {
			out.push({
				label: "Google Chrome",
				target: path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
				source: "known-path"
			});
			out.push({
				label: "Microsoft Edge",
				target: path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe"),
				source: "known-path"
			});
		}
		return out;
	}
	if (platform === "darwin") return [
		{
			label: "Microsoft Edge",
			target: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			source: "known-path"
		},
		{
			label: "Google Chrome",
			target: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			source: "known-path"
		},
		{
			label: "Chromium",
			target: "/Applications/Chromium.app/Contents/MacOS/Chromium",
			source: "known-path"
		}
	];
	return [
		{
			label: "Microsoft Edge",
			target: "/usr/bin/microsoft-edge",
			source: "known-path"
		},
		{
			label: "Google Chrome",
			target: "/usr/bin/google-chrome",
			source: "known-path"
		},
		{
			label: "Chromium",
			target: "/usr/bin/chromium",
			source: "known-path"
		},
		{
			label: "Chromium",
			target: "/usr/bin/chromium-browser",
			source: "known-path"
		}
	];
}
/**
* 目录搜索兜底时要扫的根目录（只取存在的那些）。
* @param platform - `process.platform` 的值。
* @param env - 环境变量。
* @returns 根目录列表，顺序即优先级。
*/
function searchRoots(platform = process.platform, env = process.env) {
	if (platform === "win32") return [
		env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		env["ProgramFiles"] ?? "C:\\Program Files",
		env["LOCALAPPDATA"] ?? "",
		env["ProgramW6432"] ?? ""
	].filter((value) => value !== "");
	if (platform === "darwin") return ["/Applications"];
	return [
		"/usr/bin",
		"/usr/local/bin",
		"/opt",
		"/snap/bin"
	];
}
/**
* 从 `PATH` 里拆出目录列表（平台分隔符不同）。
* @param env - 环境变量。
* @param platform - 平台。
* @returns 目录列表；`PATH` 缺失时为空数组。
*/
function pathDirectories(env = process.env, platform = process.platform) {
	return (env["PATH"] ?? env["Path"] ?? env["path"] ?? "").split(platform === "win32" ? ";" : ":").map((entry) => entry.trim()).filter((entry) => entry !== "");
}
/** 这个路径是不是一个存在的可执行文件。 */
async function isExecutable(target) {
	try {
		await access(target, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* 在有限深度内搜索一个根目录，找匹配的浏览器可执行文件。
*
* 三道预算都要有：深度（`maxDepth`）、看的目录项总数（`maxEntries`）、总耗时
* （`budgetMs`）。任何一道用完就带着已有结果返回——目录搜索是**兜底**，它的失败
* 不该让「启动浏览器」变成一次长时间卡顿。
* @param options.root - 搜索起点。
* @param options.names - 可执行文件名 → 人读名字。
* @param options.maxDepth - 最多下探几层。
* @param options.maxEntries - 最多看多少个目录项。
* @param options.budgetMs - 总耗时预算。
* @param options.now - 注入时钟（验台用）。
* @returns 找到的候选，或 `undefined`。
*/
async function searchForBrowser(options) {
	const maxDepth = options.maxDepth ?? 4;
	const maxEntries = options.maxEntries ?? 4e3;
	const budgetMs = options.budgetMs ?? 1500;
	const now = options.now ?? (() => Date.now());
	const started = now();
	const wanted = new Map(options.names.map((entry) => [entry.file.toLowerCase(), entry.label]));
	let seen = 0;
	/** 广度优先，逐层下探；每层按名字排序，保证同一台机器上结果稳定。 */
	let frontier = [{
		dir: options.root,
		depth: 0
	}];
	while (frontier.length > 0) {
		const next = [];
		for (const { dir, depth } of frontier) {
			if (now() - started > budgetMs || seen > maxEntries) return void 0;
			let entries;
			try {
				entries = await readdir(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			entries.sort((a, b) => a.name.localeCompare(b.name));
			for (const entry of entries) {
				seen += 1;
				if (seen > maxEntries) return void 0;
				const full = path.join(dir, entry.name);
				if (entry.isFile()) {
					const label = wanted.get(entry.name.toLowerCase());
					if (label !== void 0 && await isExecutable(full)) return {
						label,
						target: full,
						source: "search"
					};
					continue;
				}
				if (entry.isDirectory() && depth < maxDepth) next.push({
					dir: full,
					depth: depth + 1
				});
			}
		}
		frontier = next;
	}
}
/**
* 按四级顺序解析出要启动的浏览器。
*
* 每一级只在**上一级完全落空**时才跑，而且都会把试过的东西记进 `attempted`——
* 找不到的时候，这份清单就是唯一能让用户/模型明白"为什么没找到"的东西。
* @param options.path - 配置里的显式路径；给了就只用它。
* @param options.platform - 平台。
* @param options.env - 环境变量。
* @param options.knownPaths - 覆盖已知位置表（验台用）。
* @param options.search - 是否允许目录搜索兜底；`false` 时只跑前三段。
* @param options.names - 覆盖可执行文件名表（验台用）。
* @param options.now - 注入时钟。
* @returns 解析结果。
*/
async function resolveBrowser(options = {}) {
	const platform = options.platform ?? process.platform;
	const env = options.env ?? process.env;
	const names = options.names ?? (platform === "win32" ? WINDOWS_EXE_NAMES : POSIX_EXE_NAMES);
	const attempted = [];
	const stages = {
		configured: 0,
		knownPath: 0,
		path: 0,
		search: 0
	};
	const record = (target) => {
		if (!attempted.includes(target)) attempted.push(target);
	};
	const explicit = options.path?.trim();
	if (explicit !== void 0 && explicit !== "") {
		stages.configured = 1;
		record(explicit);
		if (!explicit.includes("/") && !explicit.includes("\\") || await isExecutable(explicit)) return {
			found: {
				label: path.basename(explicit),
				target: explicit,
				source: "configured"
			},
			attempted,
			stages
		};
		return {
			attempted,
			stages
		};
	}
	const known = options.knownPaths ?? knownBrowserPaths(platform, env);
	for (const candidate of known) {
		stages.knownPath += 1;
		record(candidate.target);
		if (await isExecutable(candidate.target)) return {
			found: candidate,
			attempted,
			stages
		};
	}
	for (const dir of pathDirectories(env, platform)) for (const entry of names) {
		const target = path.join(dir, entry.file);
		stages.path += 1;
		record(target);
		if (await isExecutable(target)) return {
			found: {
				label: entry.label,
				target,
				source: "path"
			},
			attempted,
			stages
		};
	}
	if (options.search !== false) {
		const now = options.now ?? (() => Date.now());
		for (const root of searchRoots(platform, env)) {
			try {
				await stat(root);
			} catch {
				continue;
			}
			const found = await searchForBrowser({
				root,
				names,
				...options.now === void 0 ? {} : { now }
			});
			if (found !== void 0) {
				stages.search += 1;
				record(found.target);
				return {
					found,
					attempted,
					stages
				};
			}
		}
	}
	return {
		attempted,
		stages
	};
}
/**
* 拉起一个脱离宿主进程树的浏览器进程。
*
* 三个选项缺一不可：`detached: true`（自成进程组，宿主退出不连坐）、
* `stdio: 'ignore'`（浏览器会一直往 stdout 写，pipe 接不住会把宿主撑住）、
* `unref()`（宿主的事件循环不再为它保活）。
* @param candidate - 要启动的浏览器。
* @param extraArgs - 追加参数（例如 `--user-data-dir=…`）。
* @returns spawn 之后立刻 resolve；进程是否真的活着由后续的连接探测回答。
*/
function spawnBrowser(candidate, extraArgs = []) {
	return new Promise((resolve, reject) => {
		const child = spawn(candidate.target, [...candidate.args ?? [], ...extraArgs], {
			detached: true,
			stdio: "ignore",
			windowsHide: false
		});
		child.once("error", (error) => reject(error));
		child.once("spawn", () => {
			child.unref();
			resolve(child.pid === void 0 ? {} : { pid: child.pid });
		});
	});
}
/**
* 等桥接报告扩展已连接。
*
* 为什么要轮询而不是 sleep 一个固定值：扩展连上来的时间取决于浏览器冷启动、
* service worker 唤醒、读配置、WebSocket 握手，快则几百毫秒慢则数秒。固定 sleep
* 要么白等要么误报；轮询能在连上的那一刻就返回，超时则如实说超时。
* @param options.isConnected - 读一次当前是否已连接。
* @param options.timeoutMs - 最长等多久。
* @param options.signal - 取消信号（工具调用被取消时立刻停）。
* @param options.now - 注入时钟，验台用。
* @param options.sleep - 注入等待，验台用（避免真睡）。
* @returns 是否在超时前连上，以及等了多久。
*/
async function waitForExtension(options) {
	const timeoutMs = options.timeoutMs ?? 5e3;
	const now = options.now ?? (() => Date.now());
	const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const started = now();
	for (;;) {
		if (options.isConnected()) return {
			connected: true,
			waitedMs: now() - started
		};
		const elapsed = now() - started;
		if (elapsed >= timeoutMs) return {
			connected: false,
			waitedMs: elapsed
		};
		if (options.signal?.aborted === true) return {
			connected: false,
			waitedMs: elapsed
		};
		await sleep(Math.min(LAUNCH_POLL_INTERVAL_MS, timeoutMs - elapsed));
	}
}
//#endregion
//#region lib/types/index.js
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
/** Cordis plugin name used by loader diagnostics. */
const name = "browser-bridge";
/** npm package name whose profile row the Settings page edits. */
const PACKAGE_NAME = "dsh-browser";
/** The tool registry this plugin contributes `browser_*` tools to. */
const inject = ["tools", "systemPrompt"];
/** Settings namespace carrying the bridge switch and endpoint options. */
const BROWSER_BRIDGE_SETTINGS_NAMESPACE = "browser-bridge";
const Config = z.object({
	enabled: z.boolean().default(true),
	port: z.number().step(1).min(1024).max(65535).default(9777),
	token: z.string().default("dsh-local"),
	shotsDir: z.string().default("dsh-browser-shots"),
	readOnly: z.boolean().default(false),
	allowScript: z.boolean().default(true),
	lazyToolDocs: z.boolean().default(false),
	allowRawCdp: z.boolean().default(true),
	allowIncognito: z.boolean().default(false),
	tabWindow: z.union(["current", "new"]).default("current"),
	focusPolicy: z.union(["avoid", "auto"]).default("avoid"),
	userTakeover: z.union(["yield", "ignore"]).default("yield"),
	tabGroupTitle: z.string().default("DSH"),
	agentHighlight: z.boolean().default(true),
	browserPath: z.string().default("")
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
	if (typeof raw !== "string") return "DSH";
	return raw.replace(/\s+/g, " ").trim().slice(0, 40);
}
/** One `browser_read` window, in characters of page text. Longer pages are paged
*  with `offset`, so no single call can put a whole site into the transcript. */
const READ_WINDOW_MAX_CHARS = 2e4;
/**
* Owns zero or one live {@link BridgeServer} and restarts it whenever the
* resolved settings change. Reconciles serialize through a promise chain so a
* burst of settings commits cannot interleave stop/start pairs.
*/
var BridgeController = class {
	log;
	server;
	serverKey = "";
	lastError;
	chain = Promise.resolve();
	current;
	constructor(log) {
		this.log = log;
	}
	/**
	* 扩展此刻连着没有。
	*
	* `browser_launch` 用它在 spawn 之前先判断「其实已经连上了，根本不用启动」，
	* 以及 spawn 之后轮询等它连上。读的是活服务器，不是缓存：桥被停掉时
	* `server` 就是 `undefined`，这时答案必然是 false。
	* @returns 已连接为 true。
	*/
	isExtensionConnected() {
		return this.server?.status.extensionConnected === true;
	}
	/** 配置里显式指定的浏览器路径；没配过是空串。 */
	get browserPath() {
		return this.current?.browserPath ?? "";
	}
	/** Resolved directory screenshots land in; defined once any config arrived. */
	get shotsDir() {
		return this.current === void 0 ? void 0 : path.resolve(this.current.shotsDir);
	}
	/**
	* Live link state for the Settings page (and nothing else — the model-facing
	* `browser_info` still asks the extension for the truth it reports there).
	* @returns a JSON-safe snapshot; `configured: false` before the first config.
	*/
	status() {
		if (this.current === void 0) return { configured: false };
		const server = this.server;
		if (server === void 0) return {
			configured: true,
			enabled: false,
			lastError: this.lastError ?? null
		};
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
				note: live.protocolNote ?? null
			}
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
		this.chain = run.catch(() => {});
		if (options.throwOnError === true) return run.catch((error) => {
			throw error instanceof Error ? error : new Error(String(error));
		});
		return Promise.resolve();
	}
	async reconcileNow(config) {
		const shotsDir = path.resolve(config.shotsDir);
		const key = config.enabled ? `${config.port}|${config.token}|${shotsDir}` : "";
		if (key === this.serverKey) return;
		const previous = this.server;
		this.server = void 0;
		this.serverKey = "";
		await previous?.stop();
		if (!config.enabled) {
			this.lastError = void 0;
			return;
		}
		const server = new BridgeServer({
			port: config.port,
			token: config.token,
			shotsDir,
			log: this.log
		});
		try {
			await server.start();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.lastError = `桥接启动失败（端口 ${config.port}）: ${message}`;
			this.log(this.lastError);
			throw error instanceof Error ? error : new Error(message);
		}
		this.server = server;
		this.serverKey = key;
		this.lastError = void 0;
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
		if (server === void 0) throw classify(command, new Error(this.lastError ?? "浏览器控制未启用 —— 在 profile 的 cordis.patch.yml 里给 browser-bridge 配 enabled: true（dsh 0.1.7+ 的宿主也会在设置 → 插件 自动列出本插件开关；0.1.2 及更早的宿主没有这张卡片，只能改配置文件）"));
		return server.execute(command, {
			...params,
			policy: this.policyEnvelope()
		}, timeoutMs === void 0 ? { signal } : {
			signal,
			timeoutMs
		});
	}
	/**
	* Which cookie jar the next commands land in. Host-side state only: the
	* extension keeps no copy, it reads `policy.jar` off every command (the same
	* "no policy state on the far side" rule the other three envelope fields
	* follow), so a stale replica cannot silently route a command to the wrong jar.
	*/
	jar = "normal";
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
		if (target === "incognito") this.policyGate("profile.launch");
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
			focus: config?.focusPolicy === "auto" ? "auto" : "avoid",
			tabs: config?.tabWindow === "new" ? "new-window" : "current-window",
			takeover: config?.userTakeover === "ignore" ? "ignore" : "yield",
			jar: this.jar,
			highlight: config?.agentHighlight === false ? "off" : "on",
			groupTitle: groupTitleOf(config?.tabGroupTitle)
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
			allowIncognito: this.current?.allowIncognito === true
		}, params);
		if (refusal !== void 0) throw new BridgeError(command, "blocked_by_policy", "not_started", refusal);
	}
	/**
	* Delete generated artifacts using the currently resolved directories;
	* works while the bridge is stopped because it never touches the socket.
	* @returns counts and names of what was removed.
	*/
	async cleanup() {
		this.policyGate("cleanup");
		const dir = this.shotsDir;
		if (dir === void 0) throw classify("cleanup", /* @__PURE__ */ new Error("browser-bridge is not configured yet —— 浏览器控制尚未加载配置，无法确定清理目录"));
		try {
			return await cleanupArtifacts({ shotsDir: dir });
		} catch (error) {
			throw classify("cleanup", error);
		}
	}
	/**
	* 启动浏览器并等扩展连上桥（`browser_launch`）。
	*
	* 这条路**不经过** `execute()`：浏览器没开的时候扩展不在运行，没有任何东西能
	* 执行扩展命令。所以它必须自己站一次策略闸门（见 {@link policyGate}），否则
	* 只读档下模型仍能在用户桌面上拉起一个窗口。
	*
	* 三种结果分开报，因为它们要人做的事完全不同：
	*   - 已经连着 → 什么都不做，直接说"已经连上了"（重复启动只会多开一个窗口）；
	*   - spawn 成功但没连上 → 浏览器起来了，扩展没握手（没装/被禁用/端口或 Token
	*     两边不一致），这要**人去查扩展**，不是重试；
	*   - 找不到浏览器 / spawn 失败 → 把试过的路径原样带回去。
	* @param options.force - 已经连着时仍然启动一个新的浏览器实例。
	* @param options.args - 额外命令行参数（例如 `--user-data-dir=…`）。
	* @param options.signal - 工具调用取消。
	* @param options.lockArgs - 覆盖锁文件参数（验台用；默认按平台给）。
	* @param options.timeoutMs - 等扩展连上的上限。
	* @returns 结构化的启动结果。
	*/
	async launch(options = {}) {
		this.policyGate("launch");
		const timeoutMs = options.timeoutMs ?? 5e3;
		if (options.force !== true && this.isExtensionConnected()) return {
			launched: false,
			connected: true,
			waitedMs: 0,
			browser: void 0,
			target: void 0
		};
		const resolved = await resolveBrowser({ path: this.browserPath });
		if (resolved.found === void 0) {
			const attempted = resolved.attempted.slice(0, 20);
			throw new BridgeError("launch", "launch_not_found", "not_started", `没有找到可启动的浏览器：试过 ${resolved.attempted.length} 个位置（显式配置 ${resolved.stages.configured}、已知安装位置 ${resolved.stages.knownPath}、PATH ${resolved.stages.path}、目录搜索 ${resolved.stages.search}）。${attempted.length > 0 ? `试过的前几个：${attempted.join("；")}。` : ""}三条路任选：在设置页「浏览器路径」里填可执行文件的完整路径、在 profile 的 browser-bridge 配置里写 browserPath、或者由用户自己打开浏览器。不要重复调用本工具——同样的环境不会给出不同结果。`);
		}
		const extraArgs = [...options.args ?? []];
		let pid;
		try {
			pid = (await spawnBrowser(resolved.found, extraArgs)).pid;
		} catch (error) {
			throw new BridgeError("launch", "launch_failed", "not_started", `拉起浏览器失败（${resolved.found.target}）：${errorMessage(error)}。进程没有被启动，没有任何副作用。请用户确认那个路径确实可执行；路径可用设置页「浏览器路径」修改。不要原地重试。`);
		}
		this.log(`browser-bridge: launched ${resolved.found.label} (${resolved.found.target}) pid=${pid ?? "?"}`);
		const waited = await waitForExtension({
			isConnected: () => this.isExtensionConnected(),
			timeoutMs,
			...options.signal === void 0 ? {} : { signal: options.signal }
		});
		return {
			launched: true,
			browser: resolved.found.label,
			target: resolved.found.target,
			...resolved.found.source === void 0 ? {} : { foundVia: resolved.found.source },
			connected: waited.connected,
			waitedMs: waited.waitedMs
		};
	}
	/** Stop the listener; safe to call repeatedly and during teardown. */
	stop() {
		const previous = this.server;
		this.server = void 0;
		this.serverKey = "";
		return previous?.stop() ?? Promise.resolve();
	}
};
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
const MAX_RENDERED_CHARS = 4e3;
function clampRendered(text, maxChars = MAX_RENDERED_CHARS) {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n… [renderedTruncated omittedChars=${omitted} limitChars=${maxChars}] narrow the query and call again to see the rest`;
}
/** Model-facing budget for one snapshot listing; `limit` narrows the listing. */
const SNAPSHOT_RENDER_MAX_CHARS = 8e3;
/** Model-facing budget for one console/network log listing. */
const LOG_RENDER_MAX_CHARS = 6e3;
/** Collapse one page-supplied field to a single line inside a rendered listing. */
function flattenOneLine(value, maxChars) {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}
/** `HH:MM:SS` in UTC from an epoch-milliseconds stamp. */
function formatClock(epochMs) {
	return new Date(epochMs).toISOString().slice(11, 19);
}
function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}
/**
* Reduce one captured network row to the fields this tool declares. The buffer
* also carries request/response header maps and POST bodies; those stay out of
* the value, because the value never reaches the model and the header dump is
* what would blow the transcript.
*/
function networkRow(row) {
	const out = {
		method: typeof row.method === "string" ? row.method : "GET",
		url: flattenOneLine(typeof row.url === "string" ? row.url : "", 200)
	};
	if (typeof row.resourceType === "string") out.resourceType = row.resourceType;
	if (typeof row.status === "number") out.status = row.status;
	if (typeof row.statusText === "string" && row.statusText.length > 0) out.statusText = flattenOneLine(row.statusText, 60);
	if (typeof row.mimeType === "string") out.mimeType = row.mimeType;
	if (typeof row.encodedDataLength === "number") out.bytes = row.encodedDataLength;
	if (typeof row.wallTime === "number") out.time = formatClock(row.wallTime * 1e3);
	if (row.finished === true) out.finished = true;
	if (row.failed === true) out.failed = true;
	if (row.canceled === true) out.canceled = true;
	if (typeof row.errorText === "string" && row.errorText.length > 0) out.errorText = flattenOneLine(row.errorText, 120);
	return out;
}
/**
* Resolve the element target a click/type tool received.
* @param args - validated tool arguments carrying at most one targeting field.
* @returns the CSS selector to send on the wire, refs translated to their attribute form.
*/
function targetSelector(args) {
	const hasSelector = typeof args.selector === "string" && args.selector.length > 0;
	const hasRef = typeof args.ref === "string" && args.ref.length > 0;
	if (hasSelector === hasRef) throw new Error("provide exactly one of selector or ref (ref comes from browser_snapshot)");
	if (hasRef) {
		const ref = args.ref;
		if (!SNAPSHOT_REF_SELECTOR_PATTERN.test(ref)) throw new Error(`invalid ref: ${ref}`);
		return `[data-dsh-ref="${ref}"]`;
	}
	return args.selector;
}
function requireTabId(args, action) {
	if (typeof args.tabId !== "number") throw new Error(`${action} requires tabId`);
	return args.tabId;
}
/**
* Every tab the caller asked to close. `tabId` and `tabIds` are both accepted
* (a batch call that repeats one id, or passes both, must not close it twice),
* and the ids are deduplicated and normalised before they leave the host.
*/
function closeTabIds(args) {
	const asked = [...Array.isArray(args.tabIds) ? args.tabIds : [], ...typeof args.tabId === "number" ? [args.tabId] : []];
	const ids = [...new Set(asked.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
	if (ids.length === 0) throw new Error("close requires tabId or tabIds");
	return ids;
}
/** Write one screenshot payload to the shots directory and return its durable location. */
async function saveScreenshot(controller, payload) {
	const dir = controller.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	await mkdir(dir, { recursive: true });
	const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
	const random = Math.random().toString(36).slice(2, 6);
	const file = path.join(dir, `${stamp}-${random}.${payload.format === "jpeg" ? "jpg" : "png"}`);
	const buffer = Buffer.from(payload.base64, "base64");
	await writeFile(file, buffer);
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		title: payload.tabTitle,
		url: payload.tabUrl,
		...payload.restored === true ? { restored: true } : {},
		...payload.raised === true ? { raised: true } : {}
	};
}
/** Write one PDF payload to `path` (absolute or relative to `controller.shotsDir`)
*  and return the absolute path + size. Mirrors saveScreenshot's contract. */
async function savePdf(controller, payload, requestedPath) {
	const dir = controller.shotsDir;
	if (dir === void 0) throw new Error("browser-bridge is not configured yet");
	let file;
	if (requestedPath && path.isAbsolute(requestedPath)) {
		file = requestedPath;
		await mkdir(path.dirname(file), { recursive: true });
	} else {
		await mkdir(dir, { recursive: true });
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const random = Math.random().toString(36).slice(2, 6);
		const name = requestedPath ? path.basename(requestedPath) : `${stamp}-${random}.pdf`;
		file = path.join(dir, name);
	}
	const buffer = Buffer.from(payload.base64, "base64");
	await writeFile(file, buffer);
	return {
		file,
		bytes: buffer.length,
		tabId: payload.tabId,
		...payload.tabTitle === void 0 ? {} : { title: payload.tabTitle },
		...payload.tabUrl === void 0 ? {} : { url: payload.tabUrl }
	};
}
/** Register every `browser_*` tool; each is a thin adapter over one extension command. */
function applyBrowserTools(ctx, controller, options) {
	/** 全量定义，**包括还没暴露出去的** —— 懒启动时就是从这里取，描述一个字不改。 */
	const known = /* @__PURE__ */ new Map();
	/**
	* 懒启动把工具装进**发起装载的那个会话**，所以账也按会话记。
	*
	* 键是宿主的 agent 对象：一个会话一个，且跨轮次稳定（实测同一个对象，`agent.id` 就是
	* 会话 id）。会话结束时宿主会回收它的 scope，WeakMap 跟着放掉，不会攒住死会话。
	*/
	const loadedByAgent = /* @__PURE__ */ new WeakMap();
	/** 拿不到 agent 的调用（复合派发、嵌套子派发）退回全局层，用这张表记账。 */
	const loadedGlobally = /* @__PURE__ */ new Set();
	/** 我们自己注册出去的 disposer：插件被卸载/重载时要把它们收回来。 */
	const ownedDisposers = /* @__PURE__ */ new Set();
	ctx.effect(() => () => {
		for (const dispose of ownedDisposers) dispose();
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
		if (agent === void 0) return void 0;
		try {
			return agent.ctx?.tools ?? void 0;
		} catch {
			return;
		}
	};
	const exposureOf = (exec) => {
		const agent = exec?.agent;
		if (agent === void 0 || agent === null || typeof agent !== "object") return { loaded: loadedGlobally };
		const existing = loadedByAgent.get(agent);
		if (existing !== void 0) return {
			agent,
			loaded: existing
		};
		const fresh = /* @__PURE__ */ new Set();
		loadedByAgent.set(agent, fresh);
		return {
			agent,
			loaded: fresh
		};
	};
	/**
	* 真的交给宿主注册。
	*
	* 幂等：同一个落点重复装载只是返回 false，不会注册第二遍。
	* 抛出（重名、被闸门拒）不吞：调用方要如实把错误报回模型。
	*/
	const expose = (name, exposure) => {
		if (exposure.loaded.has(name)) return false;
		const definition = known.get(name);
		if (definition === void 0) return false;
		const dispose = (scopedToolsOf(exposure.agent) ?? ctx.tools).register(definition);
		if (typeof dispose === "function") ownedDisposers.add(dispose);
		exposure.loaded.add(name);
		return true;
	};
	/** 从**全局视角**看这个工具在不在：`undefined` = 读不出来（服务拒绝），不是「不在」。 */
	const inGlobalView = (name) => {
		try {
			return ctx.tools.get(name) !== void 0;
		} catch {
			return;
		}
	};
	/**
	* 落点的如实读回，不拿我们的意图当事实：真正的会话层注册从全局视角是查不到的，
	* 查得到就说明它进了全局那张表（没有会话作用域时的退化路径）。
	*/
	const scopeOfExposure = (exposure) => {
		const sample = [...exposure.loaded][0];
		if (sample === void 0) return exposure.agent === void 0 ? "global" : "session";
		const seen = inGlobalView(sample);
		if (seen === void 0) return "unknown";
		return seen ? "global" : "session";
	};
	/**
	* 登记一个工具的定义。全开：当场暴露；懒启动：只记账，等 `browser_tools` 来取。
	* 两种模式下存的都是同一份完整定义 —— 这里没有「桩描述」这种东西。
	*/
	const mount = (definition) => {
		known.set(definition.name, definition);
		if (!options.lazyTools) expose(definition.name, { loaded: loadedGlobally });
	};
	ctx.systemPrompt.section({
		name: "tool:browser",
		order: 112,
		text: "The browser_* tools drive the user's real, logged-in browser through the DSH Browser extension. Which tab a command lands on: an explicit tabId always wins; otherwise the tab the agent claimed (browser_tabs open/group/activate) — once you have a tab of your own, commands keep landing there instead of following the user's gaze. A session that never claimed a tab follows the tab the user is looking at. browser_tabs list marks owned/yielded per tab and reports agentTargetTabId. A tab you opened or grouped is collected into one titled Chrome tab group and gets a blue gradient frame while it is your target — that frame is how the user sees which page you are touching; it intercepts nothing. The group name comes from the tabGroupTitle setting unless you pass groupTitle on that call (empty string = no group). Close only closes tabs you opened; pass force:true only when the user explicitly asked you to close one of theirs (it is irreversible for them). When the user actually clicks or types in the tab you are driving (merely switching to it, watching, or scrolling does not count), page-mutating commands there fail with code yielded_to_user and nothing is sent: do not retry and do not work around it — open a tab of your own (browser_tabs open) or wait until they move to another tab, which clears it. When you must not touch the user's real signed-in session (logging in on their behalf, rehearsing a flow, clicking things that may be destructive), use browser_profile: action=launch opens an isolated incognito jar and every later command lands there, action=close shuts it down and returns to the normal jar. Prefer browser_snapshot first on unfamiliar pages: it numbers interactive elements, and browser_click/browser_type accept the returned ref instead of guessing CSS selectors. browser_read extracts page text in a window (offset/limit) and reports how much text is left, browser_screenshot saves a PNG/JPEG and returns its file path (view it with an image tool). Calls fail with actionable copy while the bridge is disabled or no browser is connected. When a result is cut to bound token cost it is marked \"[renderedTruncated omittedChars=N limitChars=L]\" — re-issue a narrower query (smaller limit, a pattern filter, or browser_read's offset) instead of assuming the page is shorter than it is."
	});
	mount(defineTool({
		name: "browser_navigate",
		description: "Navigate a browser tab to a URL and wait for the page load to settle.",
		parameters: {
			url: {
				type: "string",
				required: true,
				description: "Absolute URL to open in the tab."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					url: { type: "string" },
					title: { type: "string" },
					pendingUrl: { type: "string" },
					loadPending: { type: "boolean" },
					siteUnreachable: { type: "boolean" }
				}
			},
			render: (_args, value) => {
				const label = [value.title, value.url].filter((part) => typeof part === "string" && part.length > 0).join(" — ");
				const shows = label.length > 0 ? label : "(untitled)";
				if (value.siteUnreachable === true) return [{
					type: "text",
					text: `Tab ${value.tabId} could not load ${String(value.url ?? "")} — the browser landed on its own error page (DNS failure or no connection), so browser_read/browser_snapshot return that error page, not the site.`
				}];
				if (value.loadPending === true) {
					const to = typeof value.pendingUrl === "string" && value.pendingUrl.length > 0 ? value.pendingUrl : "the requested URL";
					return [{
						type: "text",
						text: `Tab ${value.tabId} is still loading ${to} — the load had not settled when the wait budget ran out, so the tab may still be showing ${shows}. Re-check with browser_read before acting on it (or raise timeoutMs).`
					}];
				}
				if (typeof value.pendingUrl === "string" && value.pendingUrl.length > 0) return [{
					type: "text",
					text: `Tab ${value.tabId} shows ${shows} and is navigating to ${value.pendingUrl}`
				}];
				return [{
					type: "text",
					text: `Tab ${value.tabId} now shows ${shows}`
				}];
			}
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => ({
			card: "generic",
			title: `Open ${args.url}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { url: args.url };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const raw = await controller.execute("nav", params, exec.signal);
			const out = { tabId: raw.tabId };
			if (typeof raw.url === "string") out.url = raw.url;
			if (typeof raw.title === "string") out.title = raw.title;
			if (typeof raw.pendingUrl === "string") out.pendingUrl = raw.pendingUrl;
			if (raw.loadPending === true) out.loadPending = true;
			if (raw.siteUnreachable === true || typeof raw.siteUnreachable === "object" && raw.siteUnreachable !== null) out.siteUnreachable = true;
			return out;
		}
	}));
	mount(defineTool({
		name: "browser_read",
		description: "Read the current page: title, URL and the page text itself (or full HTML) in a window you control with offset/limit. The returned text is what you see — no separate fetch step is needed.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			mode: {
				type: "string",
				description: "\"text\" (default) for visible text, \"html\" for the whole document."
			},
			offset: {
				type: "number",
				description: `Character index the window starts at; default 0. Use the "call again with offset=" value the previous result reported.`
			},
			limit: {
				type: "number",
				description: `Characters to return; default and cap ${READ_WINDOW_MAX_CHARS}.`
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					mode: {
						type: "string",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					content: {
						type: "string",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					},
					offset: {
						type: "number",
						required: true
					},
					totalChars: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => {
				const end = value.offset + value.content.length;
				return [{
					type: "text",
					text: `${`${value.title} (${value.url}) — ${value.mode} chars ${value.offset}-${end} of ${value.totalChars}` + (value.truncated ? `; call again with offset=${end} to continue` : "")}\n\n${value.content}`
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const mode = args.mode === "html" ? "html" : "text";
			const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)) || 0);
			const limit = Math.min(READ_WINDOW_MAX_CHARS, Math.max(1, Math.floor(Number(args.limit ?? READ_WINDOW_MAX_CHARS)) || READ_WINDOW_MAX_CHARS));
			const raw = await controller.execute("content", args.tabId === void 0 ? { mode } : {
				mode,
				tabId: args.tabId
			}, exec.signal);
			const full = raw.content ?? "";
			const content = full.slice(offset, offset + limit);
			return {
				tabId: raw.tabId,
				mode,
				title: raw.title ?? "",
				url: raw.url ?? "",
				content,
				truncated: offset + content.length < full.length,
				offset,
				totalChars: full.length
			};
		}
	}));
	mount(defineTool({
		name: "browser_snapshot",
		description: "Inventory the page's interactive elements with stable refs; pass a ref to browser_click/browser_type afterwards. mode:\"ax\" numbers them by Chrome's accessibility tree (role + accessible name), which survives a DOM redesign; the default mode matches CSS selectors.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			limit: {
				type: "number",
				description: "Max elements returned; defaults to 120, capped at 200."
			},
			mode: {
				type: "string",
				description: "\"ax\" for the accessibility tree, \"dom\" (default) for the selector list. \"ax\" falls back to \"dom\" with axFallback set if the page gives no a11y tree."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					title: {
						type: "string",
						required: true
					},
					url: {
						type: "string",
						required: true
					},
					mode: { type: "string" },
					axFallback: { type: "string" },
					items: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								ref: {
									type: "string",
									required: true
								},
								tag: {
									type: "string",
									required: true
								},
								role: { type: "string" },
								name: { type: "string" },
								href: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: clampRendered([`${value.items.length} interactive elements on ${value.title} (mode ${value.mode ?? "dom"}); click or fill them by ref:` + (value.axFallback === void 0 ? "" : `\n(mode ax fell back to dom: ${value.axFallback})`), ...value.items.map((item) => {
						const name = item.name === void 0 ? "" : ` "${flattenOneLine(item.name, 80)}"`;
						const href = item.href === void 0 ? "" : ` -> ${flattenOneLine(item.href, 100)}`;
						return `[${item.ref}] ${item.role ?? item.tag}${name}${href}`;
					})].join("\n"), SNAPSHOT_RENDER_MAX_CHARS)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Snapshot browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { limit: Math.min(200, Math.max(1, args.limit ?? 120)) };
			if (typeof args.tabId === "number") params.tabId = args.tabId;
			if (typeof args.mode === "string") params.mode = args.mode;
			const raw = await controller.execute("snapshot", params, exec.signal);
			const requestedAx = args.mode === "ax";
			const gotAx = raw.mode === "ax" || raw.ax !== void 0;
			const axFallback = typeof raw.axFallback === "string" && raw.axFallback.length > 0 ? raw.axFallback : requestedAx && !gotAx ? "this extension ignored mode:\"ax\" and returned CSS-DOM matches (AX mode needs DSH Browser extension v1.0.11 or newer) — the names below are tag names, not accessible names" : void 0;
			return {
				tabId: raw.tabId,
				title: raw.title ?? "",
				url: raw.url ?? "",
				...raw.mode === void 0 ? {} : { mode: raw.mode },
				...axFallback === void 0 ? {} : { axFallback },
				items: (raw.items ?? []).map((item) => ({
					ref: item.ref,
					tag: item.tag,
					...item.role === void 0 ? {} : { role: item.role },
					...item.name === void 0 ? {} : { name: item.name },
					...item.href === void 0 ? {} : { href: item.href }
				}))
			};
		}
	}));
	mount(defineTool({
		name: "browser_click",
		description: "Click a page element with real mouse events; target it by snapshot ref or CSS selector.",
		parameters: {
			ref: {
				type: "string",
				description: "Element ref from browser_snapshot (e.g. \"e3\"); wins over selector."
			},
			selector: {
				type: "string",
				description: "CSS selector; ignored when ref is given."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			doubleClick: {
				type: "boolean",
				description: "Send a double click instead."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Click ${args.ref ?? args.selector ?? ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { selector: targetSelector(args) };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.doubleClick !== void 0) params.doubleClick = args.doubleClick;
			return await controller.execute("click", params, exec.signal);
		}
	}));
	mount(defineTool({
		name: "browser_type",
		description: "Fill an input/textarea/select/contentEditable (React-compatible events); optionally press Enter afterwards.",
		parameters: {
			value: {
				type: "string",
				required: true,
				description: "Text to put into the element."
			},
			ref: {
				type: "string",
				description: "Element ref from browser_snapshot; wins over selector."
			},
			selector: {
				type: "string",
				description: "CSS selector; ignored when ref is given."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			submit: {
				type: "boolean",
				description: "Press Enter after filling."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Type into ${args.ref ?? args.selector ?? "element"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {
				selector: targetSelector(args),
				value: args.value
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const filled = await controller.execute("input", params, exec.signal);
			if (args.submit === true) await controller.execute("press", args.tabId === void 0 ? { key: "Enter" } : {
				key: "Enter",
				tabId: args.tabId
			}, exec.signal);
			return filled;
		}
	}));
	mount(defineTool({
		name: "browser_press",
		description: "Send a real keyboard event to the page: a named key (Enter, Tab, Escape, ArrowDown…), a single character, or a combination such as \"Ctrl+A\" / \"Shift+ArrowRight\".",
		parameters: {
			key: {
				type: "string",
				required: true,
				description: "Named key, a single character, or \"Modifier+Key\" (alt, ctrl/control, meta/command, shift). Unknown names now fail loudly instead of doing nothing."
			},
			modifiers: {
				type: "array",
				items: { type: "string" },
				description: "Alternative to the \"Ctrl+A\" spelling: [\"ctrl\", \"shift\"]. Shift alone still lets the character be typed; ctrl/meta suppress insertion."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Press ${args.key}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { key: args.key };
			if (Array.isArray(args.modifiers)) params.modifiers = args.modifiers;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("press", params, exec.signal);
		}
	}));
	mount(defineTool({
		name: "browser_scroll",
		description: "Scroll the page viewport by a delta and report the resulting position.",
		parameters: {
			x: {
				type: "number",
				description: "Horizontal delta in pixels; defaults to 0."
			},
			y: {
				type: "number",
				description: "Vertical delta in pixels; positive scrolls down."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Scroll browser page",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {
				x: args.x ?? 0,
				y: args.y ?? 0
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("scroll", params, exec.signal);
		}
	}));
	/** Page-side ceiling of `cmdWait`; the bridge budget adds slack on top. */
	const WAIT_MAX_MS = 12e4;
	mount(defineTool({
		name: "browser_wait",
		description: "Block until a selector appears, some text shows up in the body, or a page-side predicate turns true. Use it after navigation for SPA routes and lazy-rendered content, which browser_navigate does not wait for.",
		parameters: {
			selector: {
				type: "string",
				description: "CSS selector that must exist in the document."
			},
			text: {
				type: "string",
				description: "Literal substring that must appear in document.body.innerText."
			},
			fn: {
				type: "string",
				description: "JS predicate evaluated in the page: an expression (\"window.x === 3\") or a function body (\"() => !!document.querySelector('.row')\")."
			},
			timeoutMs: {
				type: "number",
				description: `Give up after this many milliseconds; defaults to 15000, capped at ${WAIT_MAX_MS}.`
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Wait for ${args.selector ?? args.text ?? "page condition"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const given = [
				"selector",
				"text",
				"fn"
			].filter((k) => args[k] !== void 0 && String(args[k]).length > 0);
			if (given.length === 0) throw new Error("browser_wait needs exactly one of selector, text, fn — otherwise there is nothing to wait for");
			if (given.length > 1) throw new Error(`browser_wait takes one condition, got ${given.join(" + ")} — pick the one you actually mean`);
			const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(100, Number(args.timeoutMs ?? 15e3)));
			const params = {
				[given[0]]: args[given[0]],
				timeoutMs
			};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("wait", params, exec.signal, timeoutMs + 1e4);
		}
	}));
	mount(defineTool({
		name: "browser_find",
		description: "Describe the elements matching a CSS selector — count, tag, id, class, text, href and viewport rect. Read-only; use it to decide what to click and to verify the page state.",
		parameters: {
			selector: {
				type: "string",
				required: true,
				description: "CSS selector to query."
			},
			limit: {
				type: "number",
				description: "Maximum items to describe; defaults to 10, capped at 50 (count is always the full total)."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Find ${args.selector}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { selector: args.selector };
			if (args.limit !== void 0) params.limit = args.limit;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("find", params, exec.signal);
		}
	}));
	mount(defineTool({
		name: "browser_hold",
		description: "Put a cancellable take-over overlay on a tab so the user can see that you are working on this page and cannot mis-click. The card title is fixed by the extension; your `note` is the body text only (≤400 chars, newlines flattened). The user double-clicks the page (or presses Escape twice, or holds Escape) to close it — you can keep working. Pressing the card's abort button blocks your click/input/press/nav on that tab until you call action=\"off\" (which counts as confirming you continue). This is a soft layer, not a security boundary: the popup lock is the thing that actually freezes the browser. Returns `covered:false` with a `reason` when the page cannot be covered (browser pages, error pages, CSP-strict frames, PDF viewer, an open native dialog).",
		parameters: {
			action: {
				type: "string",
				enum: [
					"on",
					"off",
					"status"
				],
				required: true,
				description: "\"on\" shows the overlay, \"off\" removes it (and clears the abort state), \"status\" reports what is actually on the page."
			},
			note: {
				type: "string",
				description: "on: body text — say what you are doing (e.g. \"正在把「局域网」档改成放行\"). The title cannot be set."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Overlay ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const action = String(args.action);
			if (![
				"on",
				"off",
				"status"
			].includes(action)) throw new Error("browser_hold action must be on, off or status");
			const params = { action };
			if (args.action === "on" && args.note !== void 0) params.note = args.note;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("hold", params, exec.signal);
		}
	}));
	mount(defineTool({
		name: "browser_dialog",
		description: "Read or change how native alert/confirm/prompt dialogs are answered (accept, dismiss, or manual), and get the recent dialog log so you can prove one appeared.",
		parameters: { policy: {
			type: "string",
			enum: [
				"accept",
				"dismiss",
				"manual"
			],
			description: "Set this policy; omit to only read the current one."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.policy ? `Dialog policy → ${args.policy}` : "Read dialog policy",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.policy !== void 0) params.dialogPolicy = args.policy;
			return await controller.execute("dialog", params, exec.signal);
		}
	}));
	mount(defineTool({
		name: "browser_launch",
		description: "Start the browser itself when it is not running, then wait for the DSH Browser extension to connect back. Use this when browser_info or any other tool reports \"extension offline\" and the user has confirmed the browser is closed — not when the browser is open with a broken extension (that needs the user to check the extension, and this tool will not fix it). If the extension is already connected this does nothing and says so. Finds the browser by: the configured `browserPath` setting first (used exclusively when set), then known install locations, then PATH, then a bounded directory search; if none work the error lists what was tried. Launches a detached process, so the browser outlives this agent session. Returns whether it got as far as the extension connecting: a launch that succeeds but never connects means the extension is missing, disabled, or pointed at a different port/token.",
		parameters: {
			force: {
				type: "boolean",
				description: "Start another browser instance even when the extension is already connected. Defaults to false because launching when it already works only adds a window the user did not ask for."
			},
			args: {
				type: "array",
				items: { type: "string" },
				description: "Extra command-line arguments passed to the browser, e.g. [\"--user-data-dir=C:\\\\tmp\\\\profile\"]. Omit for the user real profile (with its logins)."
			},
			handshakeMs: {
				type: "number",
				description: "How long to wait for the extension to connect after launching, in ms (1000-60000; default 5000). Raise it on a slow cold start rather than calling again."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					launched: {
						type: "boolean",
						required: true
					},
					connected: {
						type: "boolean",
						required: true
					},
					waitedMs: {
						type: "number",
						required: true
					},
					browser: { type: "string" },
					target: { type: "string" },
					foundVia: { type: "string" }
				}
			},
			render: (_args, value) => {
				if (value.launched !== true) return [{
					type: "text",
					text: `Browser extension is already connected — nothing launched. ${value.browser === void 0 ? "" : `(${value.browser})`}`.trim()
				}];
				const how = value.foundVia === void 0 ? "" : ` (found via ${value.foundVia})`;
				const head = `Launched ${value.browser ?? "browser"}${how}: ${value.target ?? "?"}`;
				return [{
					type: "text",
					text: value.connected === true ? `${head}. The extension connected after ${value.waitedMs}ms — browser tools work now.` : `${head}. The extension did NOT connect within ${value.waitedMs}ms. The browser is running, so the problem is on the extension side: it may not be installed in this browser, be disabled, or point at a different port/token. Ask the user to check the extension icon (green = connected) instead of launching again.`
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Launch browser",
			kind: "other"
		}),
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const options = { signal: exec.signal };
			if (args.force === true) options.force = true;
			if (Array.isArray(args.args) && args.args.length > 0) options.args = args.args.map(String);
			if (typeof args.handshakeMs === "number") options.timeoutMs = Math.min(6e4, Math.max(1e3, Math.round(args.handshakeMs)));
			const outcome = await controller.launch(options);
			return {
				launched: outcome.launched,
				connected: outcome.connected,
				waitedMs: outcome.waitedMs,
				...outcome.browser === void 0 ? {} : { browser: outcome.browser },
				...outcome.target === void 0 ? {} : { target: outcome.target },
				...outcome.foundVia === void 0 ? {} : { foundVia: outcome.foundVia }
			};
		}
	}));
	mount(defineTool({
		name: "browser_info",
		description: "Report which browser and which extension build is actually attached. Run it first when behaviour looks wrong — a stale extension or the wrong browser profile explains most of it.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser identity",
			kind: "other"
		}),
		async execute(_args, exec) {
			return await controller.execute("browser.info", {}, exec.signal);
		}
	}));
	mount(defineTool({
		name: "browser_tabs",
		description: "List tabs, or open/close/activate/group/ungroup. `list` reports `owned` (this agent opened the tab, or it sits in the agent tab group) and `yielded` (the user actually clicked or typed in that page, so page-mutating commands there are refused) per tab, plus `incognito` on every row and `isolatedWindowId` at the top level so you can tell which rows live in the isolated jar. `close` takes one tab (`tabId`) or several (`tabIds`) and only closes tabs the agent owns: ids the user opened come back under `refused` and stay open unless you pass `force: true` — a closed user tab cannot be restored, so ask first. The result accounts for every id (closed / alreadyGone / refused / failed), so a retry is safe.",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "One of: list, open, close, activate, group, ungroup."
			},
			url: {
				type: "string",
				description: "URL for the open action."
			},
			tabId: {
				type: "number",
				description: "Target tab for close/activate/group."
			},
			tabIds: {
				type: "array",
				items: { type: "number" },
				description: "For close: every tab to close in one call. The result reports each id (closed / alreadyGone / refused / failed) instead of stopping at the first failure."
			},
			active: {
				type: "boolean",
				description: "Whether a newly opened tab becomes active; defaults to true."
			},
			group: {
				type: "boolean",
				description: "For open: put the new tab in the agent tab group (see groupTitle). Defaults to true; pass false to keep it loose."
			},
			groupTitle: {
				type: "string",
				description: "For open/group: name of the Chrome tab group this tab joins. Omit to use the tabGroupTitle setting (`DSH` by default); pass an empty string to skip grouping for this call. The extension identifies its own groups by group id, not by this name: your tabs are collected into a group you own, and a group the user created under the same name is never merged into or treated as yours."
			},
			windowId: {
				type: "number",
				description: "For ungroup: only dissolve that window's agent group; omit to clear every window."
			},
			force: {
				type: "boolean",
				description: "For close: also close tabs the agent did not open (the user's own). Only after the user agreed — closing cannot be undone; without it those ids are reported under `refused` and left open."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Browser tabs: ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			switch (args.action) {
				case "list": return await controller.execute("tabs.list", {}, exec.signal);
				case "open": {
					if (typeof args.url !== "string" || args.url.length === 0) throw new Error("open requires url");
					const params = { url: args.url };
					if (args.active !== void 0) params.active = args.active;
					if (args.group !== void 0) params.group = args.group;
					if (typeof args.groupTitle === "string") params.groupTitle = args.groupTitle;
					return await controller.execute("tabs.open", params, exec.signal);
				}
				case "close": {
					const ids = closeTabIds(args);
					const force = args.force === true ? { force: true } : {};
					return ids.length === 1 ? await controller.execute("tabs.close", {
						tabId: ids[0],
						...force
					}, exec.signal) : await controller.execute("tabs.closeMany", {
						tabIds: ids,
						...force
					}, exec.signal);
				}
				case "activate": return await controller.execute("tabs.activate", { tabId: requireTabId(args, "activate") }, exec.signal);
				case "group": {
					const params = { tabId: requireTabId(args, "group") };
					if (typeof args.groupTitle === "string") params.groupTitle = args.groupTitle;
					return await controller.execute("tabs.group", params, exec.signal);
				}
				case "ungroup": {
					const params = {};
					if (typeof args.windowId === "number") params.windowId = args.windowId;
					return await controller.execute("tabs.ungroup", params, exec.signal);
				}
				default: throw new Error(`unknown tabs action: ${String(args.action)} (use list|open|close|activate|group|ungroup)`);
			}
		}
	}));
	mount(defineTool({
		name: "browser_profile",
		description: "Inspect or switch which browser profile the commands drive. The isolated instance is an incognito window: its own cookie jar, wiped when it closes, so you can log in or rehearse a flow there instead of touching the user's real signed-in session. `status` (read-only) reports your current jar, whether the browser allows incognito at all, and the window/tab counts of both jars; `launch` opens (or reuses) the isolated window and routes every later command into it; `use` only points later commands at a jar; `close` shuts the isolated window and returns to the normal jar. Off by default: it needs allowIncognito in the plugin settings AND \"Allow in incognito/InPrivate\" on the extension page, so a refusal means a human must open one of those two — tell the user which one instead of retrying.",
		parameters: {
			action: {
				type: "string",
				enum: [
					"status",
					"launch",
					"use",
					"close"
				],
				required: true,
				description: "\"status\" reports both jars (read-only), \"launch\" opens the isolated incognito window, \"use\" only switches which jar later commands land in, \"close\" shuts the isolated window down."
			},
			jar: {
				type: "string",
				enum: ["normal", "incognito"],
				description: "For use: which jar later commands (and browser_tabs open) land in. \"incognito\" needs allowIncognito; \"normal\" is always allowed."
			},
			url: {
				type: "string",
				description: "For launch: URL the isolated window opens first."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(JSON.stringify(value))
			}]
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => ({
			card: "generic",
			title: `Browser profile: ${args.action}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const action = String(args.action);
			if (action === "status") {
				const result = await controller.execute("profile.status", {}, exec.signal);
				return {
					jar: controller.currentJar,
					...result
				};
			}
			if (action === "launch") {
				const params = {};
				if (typeof args.url === "string" && args.url.length > 0) params.url = args.url;
				const result = await controller.execute("profile.launch", params, exec.signal);
				controller.switchJar("incognito");
				return {
					jar: "incognito",
					...result
				};
			}
			if (action === "use") {
				if (args.jar !== "normal" && args.jar !== "incognito") throw new Error(`browser_profile use needs jar: normal | incognito (got ${args.jar === void 0 ? "nothing" : JSON.stringify(args.jar)})`);
				controller.switchJar(args.jar);
				return {
					jar: args.jar,
					note: "后续命令与 tabs.open 都落在这个罐里"
				};
			}
			if (action === "close") {
				const result = await controller.execute("profile.close", {}, exec.signal);
				controller.switchJar("normal");
				return {
					jar: "normal",
					...result
				};
			}
			throw new Error(`unknown profile action: ${action} (use status|launch|use|close)`);
		}
	}));
	mount(defineTool({
		name: "browser_evaluate",
		description: "Run JavaScript in the page and get the JSON result back as a string. Prefer read-only inspection.",
		parameters: {
			expression: {
				type: "string",
				required: true,
				description: "JavaScript expression or statement sequence; awaited like a promise body."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			timeoutMs: {
				type: "number",
				description: "Deadline in ms for the awaited expression (clamped to 100–120000). Omit for no extra limit — a hung await then rides the bridge default instead. A timed-out expression fails with code eval_timeout."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					json: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(value.json)
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Evaluate in page",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { expression: args.expression };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const budget = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) ? Math.min(12e4, Math.max(100, args.timeoutMs)) : void 0;
			if (budget !== void 0) params.timeoutMs = budget;
			const raw = await controller.execute("eval", params, exec.signal, budget === void 0 ? void 0 : budget + 1e4);
			let json;
			try {
				json = JSON.stringify(raw.value) ?? String(raw.value);
			} catch {
				json = String(raw.value);
			}
			return {
				tabId: raw.tabId,
				json
			};
		}
	}));
	mount(defineTool({
		name: "browser_screenshot",
		description: "Capture the tab as PNG/JPEG, save it under the configured shots directory, and return the absolute file path. Fails fast with the reason when the tab's window is minimized: Chromium renders no frames there, so the CDP capture would never return. Pass `restoreWindow: true` to let the extension restore that window for the shot and put it back to minimized afterwards — it does not take focus, unless the window turns out to be fully covered (then it is raised once). Prefer a tab in a visible window when you can: a minimized window means the user is not looking at it.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			fullPage: {
				type: "boolean",
				description: "Capture beyond the viewport."
			},
			format: {
				type: "string",
				description: "\"png\" (default) or \"jpeg\"."
			},
			restoreWindow: {
				type: "boolean",
				description: "When the tab's window is minimized: restore it just for the capture and minimize it again afterwards. Defaults to false (the call fails fast instead of touching the user's window)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					tabId: {
						type: "number",
						required: true
					},
					title: { type: "string" },
					url: { type: "string" },
					restored: { type: "boolean" },
					raised: { type: "boolean" }
				}
			},
			render: (_args, value) => {
				const note = value.raised === true ? " (window was minimized: restored and raised to the front for the shot, then minimized again)" : value.restored === true ? " (window was minimized: restored for the shot, then minimized again)" : "";
				return [{
					type: "text",
					text: `Saved ${value.file} (${value.bytes} bytes)${note}`
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Browser screenshot",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = { format: args.format === "jpeg" ? "jpeg" : "png" };
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.fullPage !== void 0) params.fullPage = args.fullPage;
			if (args.restoreWindow !== void 0) params.restoreWindow = args.restoreWindow;
			return saveScreenshot(controller, await controller.execute("screenshot", params, exec.signal));
		}
	}));
	mount(defineTool({
		name: "browser_cleanup",
		description: "Delete generated screenshots and agent scratch files (__-prefixed temp scripts/artifacts) from their top-level directories.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					shotsRemoved: {
						type: "number",
						required: true
					},
					scratchRemoved: {
						type: "array",
						required: true,
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Cleaned ${value.shotsRemoved} screenshot(s) and ${value.scratchRemoved.length} scratch file(s)`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Clean up browser artifacts",
			kind: "other"
		}),
		async execute() {
			const result = await controller.cleanup();
			return {
				shotsRemoved: result.shotsRemoved,
				scratchRemoved: Array.from(result.scratchRemoved)
			};
		}
	}));
	mount(defineTool({
		name: "browser_console_log",
		description: "Read the captured `console.log/info/warn/error` entries for a tab, with the entry text itself. Set `clear:true` to also empty the buffer so the next call shows only entries recorded after this one. Useful for \"what did the page log after I clicked submit\".",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			levels: {
				type: "array",
				items: { type: "string" },
				description: "Filter to one or more of: log, info, warn, error, debug."
			},
			pattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the formatted text."
			},
			limit: {
				type: "number",
				description: "Maximum entries to return; default 100, capped at 500."
			},
			clear: {
				type: "boolean",
				description: "Empty the buffer after reading."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					total: {
						type: "number",
						required: true
					},
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								level: {
									type: "string",
									required: true
								},
								text: {
									type: "string",
									required: true
								},
								time: { type: "string" },
								location: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: clampRendered([`Tab ${value.tabId}: ${value.count} of ${value.total} console entries (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit to see more` : ""}:`, ...value.entries.map((entry, index) => `${index + 1}. [${entry.time ?? "?"}] ${entry.level}${entry.location === void 0 ? "" : ` @${entry.location}`} — ${entry.text}`)].join("\n"), LOG_RENDER_MAX_CHARS)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser console",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (Array.isArray(args.levels)) params.levels = args.levels;
			if (typeof args.pattern === "string") params.pattern = args.pattern;
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.clear === true) params.clear = true;
			const raw = await controller.execute("console.log", params, exec.signal);
			return {
				tabId: raw.tabId,
				count: raw.count,
				total: raw.total,
				entries: (raw.entries ?? []).map((entry) => ({
					level: entry.level ?? "log",
					text: flattenOneLine(entry.text ?? "", 400),
					...entry.t === void 0 ? {} : { time: formatClock(entry.t) },
					...entry.location === void 0 ? {} : { location: entry.location }
				}))
			};
		}
	}));
	mount(defineTool({
		name: "browser_network_log",
		description: "Read captured HTTP request/response pairs for a tab. `includeStatic:true` adds images / fonts / stylesheets / scripts (filtered by default — they dominate the buffer). `methodPattern` / `urlPattern` / `status` filter server-side results; `clear:true` empties the buffer.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			includeStatic: {
				type: "boolean",
				description: "Include images / fonts / stylesheets / scripts. Default false."
			},
			methodPattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the HTTP method."
			},
			urlPattern: {
				type: "string",
				description: "Regex (case-insensitive) matched against the URL."
			},
			status: {
				type: "string",
				description: "One of: 2xx, 3xx, 4xx, 5xx, failed, pending."
			},
			limit: {
				type: "number",
				description: "Maximum entries to return; default 200, capped at 1000."
			},
			clear: {
				type: "boolean",
				description: "Empty the buffer after reading."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					total: {
						type: "number",
						required: true
					},
					requests: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								method: {
									type: "string",
									required: true
								},
								url: {
									type: "string",
									required: true
								},
								resourceType: { type: "string" },
								status: { type: "number" },
								statusText: { type: "string" },
								mimeType: { type: "string" },
								bytes: { type: "number" },
								time: { type: "string" },
								finished: { type: "boolean" },
								failed: { type: "boolean" },
								canceled: { type: "boolean" },
								errorText: { type: "string" }
							}
						}
					}
				}
			},
			render: (_args, value) => {
				return [{
					type: "text",
					text: clampRendered([`Tab ${value.tabId}: ${value.count} of ${value.total} network requests (times UTC)${value.count < value.total ? ` — showing the newest ${value.count}; raise limit or filter by urlPattern/status` : ""}:`, ...value.requests.map((row, index) => {
						const outcome = row.failed === true ? `FAILED ${row.errorText ?? ""}`.trim() : row.status === void 0 ? "PENDING" : `${row.status} ${row.statusText ?? ""}`.trim();
						const size = row.bytes === void 0 ? "" : ` ${formatBytes(row.bytes)}`;
						const type = row.resourceType === void 0 ? "" : ` ${row.resourceType}`;
						return `${index + 1}. [${row.time ?? "?"}] ${row.method} ${outcome}${type}${size} ${row.url}`;
					})].join("\n"), LOG_RENDER_MAX_CHARS)
				}];
			}
		},
		presentCall: () => ({
			card: "generic",
			title: "Read browser network log",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.includeStatic === true) params.includeStatic = true;
			if (typeof args.methodPattern === "string") params.methodPattern = args.methodPattern;
			if (typeof args.urlPattern === "string") params.urlPattern = args.urlPattern;
			if (typeof args.status === "string") params.status = args.status;
			if (typeof args.limit === "number") params.limit = args.limit;
			if (args.clear === true) params.clear = true;
			const raw = await controller.execute("network.log", params, exec.signal);
			return {
				tabId: raw.tabId,
				count: raw.count,
				total: raw.total,
				requests: (raw.requests ?? []).map((row) => networkRow(row))
			};
		}
	}));
	mount(defineTool({
		name: "browser_network_clear",
		description: "Empty the per-tab network capture buffer without returning the rows.",
		parameters: { tabId: {
			type: "number",
			description: "Target tab; defaults to the active tab."
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					cleared: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `Tab ${value.tabId}: network log cleared`
			}]
		},
		presentCall: () => ({
			card: "generic",
			title: "Clear browser network log",
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			return await controller.execute("network.clear", params, exec.signal);
		}
	}));
	mount(defineTool({
		name: "browser_pdf",
		description: "Export the current page to a PDF. `path` may be absolute (saved there) or omitted (saved under the configured shotsDir). Returns the absolute path + size; the PDF preserves text (selectable, searchable) and print-media CSS. Like screenshots it fails fast when the tab's window is minimized (no frames → the CDP print would never return).",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			path: {
				type: "string",
				description: "Absolute path. Omit to save under the configured shotsDir with a timestamped name."
			},
			landscape: {
				type: "boolean",
				description: "Use landscape orientation."
			},
			printBackground: {
				type: "boolean",
				description: "Render CSS backgrounds. Default true."
			},
			paperWidth: {
				type: "number",
				description: "Paper width in inches."
			},
			paperHeight: {
				type: "number",
				description: "Paper height in inches."
			},
			scale: {
				type: "number",
				description: "Page scale (0.1–2.0)."
			},
			pageRanges: {
				type: "string",
				description: "Sub-range, e.g. \"1-3\" or \"1,4-6\"."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					file: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					tabId: {
						type: "number",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `PDF written to ${value.file} (${(value.bytes / 1024).toFixed(1)} KB)`
			}]
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Save PDF${args.path ? " → " + args.path : ""}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (args.landscape === true) params.landscape = true;
			if (args.printBackground === false) params.printBackground = false;
			if (typeof args.paperWidth === "number") params.paperWidth = args.paperWidth;
			if (typeof args.paperHeight === "number") params.paperHeight = args.paperHeight;
			if (typeof args.scale === "number") params.scale = args.scale;
			if (typeof args.pageRanges === "string") params.pageRanges = args.pageRanges;
			return await savePdf(controller, await controller.execute("pdf", params, exec.signal), typeof args.path === "string" ? args.path : void 0);
		}
	}));
	mount(defineTool({
		name: "browser_emulate",
		description: "Switch the tab into a device viewport (mobile / tablet / desktop) for responsive-UI testing. `device:\"reset\"` restores the user's actual viewport and reports whether every step really succeeded. Custom `width`/`height`/`deviceScaleFactor`/`isMobile`/`hasTouch` override any preset field. Touch is a capability the page only sees in documents loaded AFTER the switch (`'ontouchstart' in window` needs one navigation), so the result reports what the page actually sees (`touchVisible`) rather than what was requested.",
		parameters: {
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			device: {
				type: "string",
				description: "Preset: desktop | mobile-iphone-13 | mobile-pixel-7 | tablet-ipad | reset. Or pass custom width/height below."
			},
			width: {
				type: "number",
				description: "Custom viewport width in CSS px."
			},
			height: {
				type: "number",
				description: "Custom viewport height in CSS px."
			},
			deviceScaleFactor: {
				type: "number",
				description: "Custom DPR (1 = standard, 2 = retina, 3 = super-retina)."
			},
			isMobile: {
				type: "boolean",
				description: "Pass as mobile to the page (affects responsive meta)."
			},
			hasTouch: {
				type: "boolean",
				description: "Enable touch event dispatch."
			},
			userAgent: {
				type: "string",
				description: "Custom User-Agent string. Empty string clears."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					reset: { type: "boolean" },
					width: { type: "number" },
					height: { type: "number" },
					deviceScaleFactor: { type: "number" },
					isMobile: { type: "boolean" },
					hasTouch: { type: "boolean" },
					userAgent: { type: "string" },
					resetFailures: {
						type: "array",
						items: { type: "string" }
					},
					warnings: {
						type: "array",
						items: { type: "string" }
					},
					touchVisible: { type: "boolean" },
					pageMaxTouchPoints: { type: "number" }
				}
			},
			render: (_args, value) => {
				const touch = value.touchVisible === true ? ` touch=on(${value.pageMaxTouchPoints ?? "?"}pt)` : value.hasTouch === true ? " touch=已请求，但页面里没有 ontouchstart（只对之后加载的文档生效：导航一次即可）" : " touch=off";
				if (value.reset === false) {
					const why = (value.resetFailures ?? []).join("; ");
					return [{
						type: "text",
						text: `Tab ${value.tabId}: 复位没有全部成功（reset:false）——${why.length > 0 ? why : "原因未报"}${touch}\n这些项可能仍处于仿真状态，别当成已复位：先用 browser_read 看一眼当前页面，再决定重试还是手动改回。`
					}];
				}
				if (value.reset === true) return [{
					type: "text",
					text: `Tab ${value.tabId}: emulation reset to default${touch}`
				}];
				const ua = value.userAgent === void 0 ? "" : ` UA="${flattenOneLine(value.userAgent, 80)}"`;
				const warn = (value.warnings ?? []).length > 0 ? `\n未生效：${(value.warnings ?? []).join("; ")}` : "";
				return [{
					type: "text",
					text: `Tab ${value.tabId}: ${value.width || "?"}×${value.height || "?"} DPR=${value.deviceScaleFactor ?? "?"} mobile=${value.isMobile ?? false}${touch}${ua}${warn}`
				}];
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: `Emulate${args.device ? " " + args.device : " device"}`,
			kind: "other"
		}),
		async execute(args, exec) {
			const params = {};
			if (args.tabId !== void 0) params.tabId = args.tabId;
			if (typeof args.device === "string") params.device = args.device;
			if (typeof args.width === "number") params.width = args.width;
			if (typeof args.height === "number") params.height = args.height;
			if (typeof args.deviceScaleFactor === "number") params.deviceScaleFactor = args.deviceScaleFactor;
			if (typeof args.isMobile === "boolean") params.isMobile = args.isMobile;
			if (typeof args.hasTouch === "boolean") params.hasTouch = args.hasTouch;
			if (typeof args.userAgent === "string") params.userAgent = args.userAgent;
			const raw = await controller.execute("emulate", params, exec.signal);
			const strings = (value) => Array.isArray(value) ? value.filter((line) => typeof line === "string") : [];
			return {
				tabId: raw.tabId,
				...raw.reset === true ? { reset: true } : {},
				...raw.reset === false ? { reset: false } : {},
				...typeof raw.width === "number" ? { width: raw.width } : {},
				...typeof raw.height === "number" ? { height: raw.height } : {},
				...typeof raw.deviceScaleFactor === "number" ? { deviceScaleFactor: raw.deviceScaleFactor } : {},
				...typeof raw.isMobile === "boolean" ? { isMobile: raw.isMobile } : {},
				...typeof raw.hasTouch === "boolean" ? { hasTouch: raw.hasTouch } : {},
				...typeof raw.userAgent === "string" && raw.userAgent.length > 0 ? { userAgent: raw.userAgent } : {},
				...strings(raw.resetFailures).length > 0 ? { resetFailures: strings(raw.resetFailures) } : {},
				...strings(raw.warnings).length > 0 ? { warnings: strings(raw.warnings) } : {},
				...typeof raw.touchVisible === "boolean" ? { touchVisible: raw.touchVisible } : {},
				...typeof raw.pageMaxTouchPoints === "number" ? { pageMaxTouchPoints: raw.pageMaxTouchPoints } : {}
			};
		}
	}));
	if (options.lazyTools) {
		/** 分组说明从 TOOL_GROUPS 现算，描述不可能是另一张手写表。 */
		const groupLine = Object.entries(TOOL_GROUPS).map(([group, names]) => `"${group}" = ${names.join(", ")}`).join("; ");
		const groupNamesOf = (key) => Object.prototype.hasOwnProperty.call(TOOL_GROUPS, key) ? TOOL_GROUPS[key] : void 0;
		ctx.tools.register(defineTool({
			name: "browser_tools",
			description: `Load browser tools. The browser_* family drives the user's real, logged-in browser through the DSH Browser extension, but lazy startup is on: this is the ONLY browser tool exposed, and a tool that is not loaded cannot be called at all. Load what you need first — it then behaves like any other tool, full description and parameters included, from your next step on. What you load applies to THIS session only — another session still sees just this loader, and your loads go away when the session does. Call with no \`names\` to list everything loadable. Call with \`names\` to load: exact tool names ("browser_click"), a group name, or "*" for all of them. Groups: ${groupLine}. Load everything you need in ONE call: each load changes the tool list, so batching beats loading one tool at a time.`,
			parameters: { names: {
				type: "array",
				items: { type: "string" },
				description: "What to load: exact tool names, group names (\"read\", \"write\", \"tabs\", \"capture\", \"raw\"), or \"*\" for everything. Omit to list what can be loaded."
			} },
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						exposed: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						activated: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						already: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						unknown: {
							type: "array",
							items: { type: "string" },
							required: true
						},
						scope: {
							type: "string",
							required: true
						},
						errors: {
							type: "array",
							items: { type: "string" }
						},
						available: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									name: {
										type: "string",
										required: true
									},
									group: {
										type: "string",
										required: true
									},
									summary: {
										type: "string",
										required: true
									}
								}
							}
						}
					}
				},
				render: (_args, value) => {
					if (value.available !== void 0) return [{
						type: "text",
						text: clampRendered([
							`Loaded: ${value.exposed.length === 0 ? "nothing yet" : value.exposed.join(", ")}. Loadable (${value.available.length}):`,
							...value.available.map((row) => `- ${row.name} [${row.group}] — ${row.summary}`),
							"Load with browser_tools {names: [...]} — exact names, a group name, or \"*\"."
						].join("\n"))
					}];
					const lines = [];
					if (value.activated.length > 0) lines.push(`Loaded, callable now: ${value.activated.join(", ")}`);
					if (value.already.length > 0) lines.push(`Already loaded: ${value.already.join(", ")}`);
					if (value.unknown.length > 0) lines.push(`Unknown, nothing loaded for these: ${value.unknown.join(", ")} — call browser_tools with no names to see the exact tool names.`);
					if (lines.length === 0) lines.push("Nothing loaded: pass names, a group name, or \"*\".");
					if (value.scope === "global") lines.push("Note: these landed in the global layer (this call had no session scope), so every session sees them.");
					if (value.scope === "unknown") lines.push("Note: could not read back which layer these landed in.");
					if (value.errors !== void 0 && value.errors.length > 0) lines.push(`Failed to load: ${value.errors.join("; ")}`);
					return [{
						type: "text",
						text: clampRendered(lines.join("\n"))
					}];
				}
			},
			presentCall: () => ({
				card: "generic",
				title: "Load browser tools",
				kind: "other"
			}),
			async execute(args, exec) {
				const exposure = exposureOf(exec);
				const requested = (Array.isArray(args.names) ? args.names : []).map((item) => typeof item === "string" ? item.trim() : "").filter((item) => item.length > 0);
				if (requested.length === 0) {
					const available = [...known.keys()].filter((name) => !exposure.loaded.has(name)).map((name) => ({
						name,
						group: groupOf(name) ?? "other",
						summary: summarize(known.get(name)?.description ?? "")
					})).sort((left, right) => left.name.localeCompare(right.name));
					return {
						exposed: [...exposure.loaded].sort(),
						activated: [],
						already: [],
						unknown: [],
						scope: scopeOfExposure(exposure),
						available
					};
				}
				const wanted = /* @__PURE__ */ new Set();
				const unknown = [];
				for (const item of requested) {
					if (item === "*") {
						for (const name of known.keys()) wanted.add(name);
						continue;
					}
					const fromGroup = groupNamesOf(item.toLowerCase());
					if (fromGroup !== void 0) {
						for (const name of fromGroup) if (known.has(name)) wanted.add(name);
						continue;
					}
					if (known.has(item)) wanted.add(item);
					else unknown.push(item);
				}
				const activated = [];
				const already = [];
				const errors = [];
				for (const name of wanted) try {
					(expose(name, exposure) ? activated : already).push(name);
				} catch (error) {
					errors.push(`${name}: ${error?.message ?? String(error)}`);
				}
				const report = {
					exposed: [...exposure.loaded].sort(),
					activated: activated.sort(),
					already: already.sort(),
					unknown,
					scope: scopeOfExposure(exposure)
				};
				if (errors.length > 0) report.errors = errors;
				return report;
			}
		}));
	}
	if (options.allowRawCdp) mount(defineTool({
		name: "browser_cdp",
		description: "Send a raw Chrome DevTools Protocol command to a tab and return its JSON result. The escape hatch for domains with no dedicated browser_* tool (Page.captureSnapshot, Network.getAllCookies, Performance.getMetrics, Fetch.enable, …). Results over 20000 JSON characters are truncated and the full size is reported; prefer browser_screenshot / browser_pdf for binary payloads — they save to disk.",
		parameters: {
			method: {
				type: "string",
				required: true,
				description: "CDP method as \"Domain.method\", e.g. \"Page.captureSnapshot\" or \"Network.getAllCookies\"."
			},
			params: {
				type: "json",
				description: "Method parameters object; defaults to {}. Must be a JSON object."
			},
			tabId: {
				type: "number",
				description: "Target tab; defaults to the active tab."
			},
			timeoutMs: {
				type: "number",
				description: "Bridge budget in milliseconds; defaults to 30000 (capped at 300000)."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					tabId: {
						type: "number",
						required: true
					},
					method: {
						type: "string",
						required: true
					},
					json: {
						type: "string",
						required: true
					},
					bytes: {
						type: "number",
						required: true
					},
					truncated: {
						type: "boolean",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: clampRendered(`Tab ${value.tabId}: ${value.method} returned ${value.bytes} JSON chars${value.truncated ? " (truncated to 20000)" : ""}\n${value.json}`)
			}]
		},
		isConcurrencySafe: () => false,
		presentCall: (args) => ({
			card: "generic",
			title: `CDP ${args.method}`,
			kind: "other"
		}),
		async execute(args, exec) {
			if (typeof args.method !== "string" || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(args.method)) throw new Error("browser_cdp requires a CDP method like \"Page.captureSnapshot\" (Domain.method)");
			const params = { method: args.method };
			if (args.params !== void 0) params.params = args.params;
			if (args.tabId !== void 0) params.tabId = args.tabId;
			const timeoutMs = Math.min(3e5, Math.max(1e3, Number(args.timeoutMs ?? 3e4) || 3e4));
			return await controller.execute("cdp.call", params, exec.signal, timeoutMs);
		}
	}));
}
/** Cordis plugin entry: wire the settings-driven lifecycle plus the model-facing tools. */
function apply(ctx, config) {
	const resolved = config;
	if (resolved.enabled && resolved.token.trim().length === 0) throw new Error("browser-bridge: token must be a non-empty string when enabled");
	const controller = new BridgeController((line) => ctx.logger.info(line));
	let current = () => resolved;
	ctx.inject(["settings"], (sctx) => {
		const settings = sctx.settings;
		/** Converge without a namespace: the profile config stays authoritative. */
		const withoutNamespace = (why) => {
			current = () => resolved;
			ctx.logger.info(`browser-bridge: settings integration skipped (${why})`);
			controller.reconcile(current());
		};
		const register = settings.register;
		if (typeof register !== "function") {
			const configure = settings.configure;
			if (typeof configure === "function") try {
				ctx.effect(() => configure({ auto: true }), "browser-bridge: settings presentation");
			} catch (error) {
				ctx.logger.info(`browser-bridge: settings presentation skipped: ${errorMessage(error)}`);
			}
			withoutNamespace("no settings.register on this dsh-settings build");
			return;
		}
		let scope;
		try {
			scope = register(BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, {
				base: config,
				validate: (value) => {
					if (value.enabled && (value.token ?? "").trim().length === 0) throw new Error("browser-bridge: token must be a non-empty string when enabled");
				}
			});
		} catch (error) {
			ctx.logger.info(`browser-bridge: settings namespace failed: ${errorMessage(error)}`);
			withoutNamespace("register threw");
			return;
		}
		current = () => scope.get();
		ctx.effect(() => () => {
			if (ctx.fiber.state === 4 || ctx.fiber.state === 5) return;
			current = () => resolved;
			controller.reconcile(current());
		}, "browser-bridge: settings cleanup");
		controller.reconcile(current());
		scope.watch(() => {
			if (ctx.fiber.state === 4 || ctx.fiber.state === 5) return;
			controller.reconcile(current());
		});
	});
	controller.reconcile(resolved, { throwOnError: resolved.enabled }).catch((error) => {
		throw new Error(`browser-bridge: ${errorMessage(error)}`);
	});
	applyBrowserTools(ctx, controller, {
		lazyTools: resolved.lazyToolDocs === true,
		allowRawCdp: resolved.allowRawCdp !== false
	});
	mountSettingsRoute(ctx, controller, current);
	ctx.effect(() => () => {
		controller.stop();
	}, "browser-bridge: server lifecycle");
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
	if (typeof get === "function") try {
		const found = get.call(scope, name);
		if (found !== void 0 && found !== null) return found;
	} catch {}
	const viaProperty = scope[name];
	return viaProperty === null ? void 0 : viaProperty;
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
		const webServer = serviceNamed(scope, "webServer");
		if (webServer === void 0 || typeof webServer.register !== "function") {
			ctx.logger.info("browser-bridge: no webServer in this composition; the Settings page route is not mounted");
			return;
		}
		let origin;
		try {
			origin = typeof webServer.getOrigin === "function" ? webServer.getOrigin() : void 0;
		} catch {
			origin = void 0;
		}
		/**
		* 「这条请求没有信号时」用的兜底信号。
		*
		* 路由对每个请求各造一个 `AbortController` 并在响应关闭时 abort，所以正常情况下
		* 传来的 signal 是有的、也真的会响。但 `SettingsRouteDeps` 上这两个回调的信号是
		* **可选**的（验台会直接 `listTabs()` 不带参数调），而 `controller.execute` 要求
		* 必填。这里给一个插件生命周期内的常驻信号兜底；它在插件卸载时被 abort（见下面
		* `ctx.effect`），所以不会出现「永远不可取消」的命令。
		*/
		const fallbackSignal = new AbortController();
		const route = buildSettingsRoute({
			packageName: PACKAGE_NAME,
			getConfig: () => current(),
			status: () => controller.status(),
			cleanup: () => controller.cleanup(),
			getService: (name) => serviceNamed(ctx, name),
			listTabs: (signal) => controller.execute("tabs.list", {}, signal ?? fallbackSignal.signal),
			activateTab: (tabId, signal) => controller.execute("tabs.activate", { tabId }, signal ?? fallbackSignal.signal),
			...origin === void 0 ? {} : { origin }
		});
		ctx.effect(() => () => fallbackSignal.abort(), "browser-bridge: tabs signal");
		const effect = typeof scope.effect === "function" ? scope.effect.bind(scope) : ctx.effect.bind(ctx);
		try {
			effect(() => {
				const unregister = webServer.register(route);
				return () => {
					if (typeof unregister === "function") unregister();
					route.dispose?.();
				};
			}, "browser-bridge: settings route");
		} catch (error) {
			ctx.logger.warn(`browser-bridge: settings route not mounted: ${errorMessage(error)}`);
		}
	};
	const inject = ctx.inject;
	if (typeof inject !== "function") {
		ctx.logger.info("browser-bridge: ctx.inject is missing; the Settings page route is not mounted");
		return;
	}
	inject.call(ctx, ["webServer"], (inner) => {
		attach(inner === void 0 || inner === null ? ctx : inner);
	});
}
//#endregion
export { BROWSER_BRIDGE_SETTINGS_NAMESPACE, Config, LOCAL_DESTRUCTIVE_COMMANDS, LOCAL_SPAWN_COMMANDS, PACKAGE_NAME, PAGE_MUTATING_COMMANDS, READ_ONLY_ALLOWED, SCRIPT_COMMANDS, apply, inject, name, policyRefusal };
