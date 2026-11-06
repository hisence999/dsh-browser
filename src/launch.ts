/**
 * 找到并启动浏览器（`browser_launch`）。
 *
 * 为什么这是一个**插件本地**能力而不是扩展命令：浏览器没开的时候扩展根本不在运行，
 * 没有任何东西能执行那条命令。启动必须由宿主进程直接拉起浏览器可执行文件来做。
 *
 * ## 找浏览器：四段逐级下降，路径一律不写死
 *
 * 硬编码一个 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 在本机能跑，
 * 换一台机器就是 ENOENT——而用户看到的只有"点了启动没反应"。所以按可靠度从高到低：
 *
 *   1. **显式配置**（`browserPath`，设置页里可以填）：用户点名要用哪一个。给了就
 *      **只用它**，不再往下试——否则"我明明指定了却启动了另一个"是更糟的谎言。
 *   2. **已知安装位置**：各平台 Chromium 系浏览器的常见落点（含 `Program Files`、
 *      `Program Files (x86)`、`LOCALAPPDATA`、`/Applications`）。
 *   3. **PATH 搜索**：Windows 上是 `msedge.exe` / `chrome.exe` 等，POSIX 上是
 *      `microsoft-edge` / `google-chrome` / `chromium` 等，沿 `PATH` 逐个目录找。
 *   4. **目录搜索兜底**：前三级都没命中时，在**有限深度**内扫常见安装根目录，按文件名
 *      匹配（`msedge.exe` / `chrome.exe` / `chromium` …）。深度、目录数、耗时都有上限——
 *      一个无界的全盘搜索会让「启动浏览器」变成「卡住 AI 三十秒」。
 *
 * 找到了才 spawn；找不到就把**试过什么**原样报回去，绝不猜一个不存在的路径去 spawn
 * （那只会换来一句看不懂的 ENOENT，而且看不出到底试过哪里）。
 *
 * ## 启动：脱离宿主进程树
 *
 * `detached` + `stdio: 'ignore'` + `unref()` 三条缺一不可：浏览器会一直往 stdout 写
 * （pipe 接不住会把宿主撑住），而宿主退出时不许把它一起带走——否则用户看到的是
 * "浏览器闪一下就没了"。
 *
 * ## 等它连上：轮询而不是睡固定值
 *
 * 浏览器起来 ≠ 扩展连上。扩展要等 service worker 唤醒、读配置、WebSocket 握手，
 * 快则几百毫秒慢则数秒。固定 sleep 要么白等要么误报，所以轮询桥接的
 * `extensionConnected`，并且把"拉起来了但还没连上"与"根本没拉起来"分成两种结果。
 */

import { spawn } from 'node:child_process'
import { access, constants, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** 一次启动最多等扩展多久（毫秒）。浏览器冷启动 + 扩展握手，这个值相当宽裕。 */
export const LAUNCH_CONNECT_TIMEOUT_MS = 5_000
/** 轮询桥接连接状态的间隔（毫秒）。 */
const LAUNCH_POLL_INTERVAL_MS = 50
/** 目录搜索兜底的单个根目录最多下探几层。 */
export const LAUNCH_SEARCH_MAX_DEPTH = 4
/** 目录搜索兜底最多看多少个目录项（跨所有根目录累计）。 */
export const LAUNCH_SEARCH_MAX_ENTRIES = 4_000
/** 目录搜索兜底的总预算（毫秒）；用完就放弃，带着已有的结果返回。 */
export const LAUNCH_SEARCH_BUDGET_MS = 1_500

/** 一个待探测的浏览器落点。`label` 只出现在给人/模型看的文案里。 */
export interface BrowserCandidate {
	/** 人读的名字，例如 `Microsoft Edge`。 */
	readonly label: string
	/** 可执行文件的绝对路径，或只给命令名（交给 PATH 解析）。 */
	readonly target: string
	/** 命令名形态时附带的参数（例如 macOS 的 `open -a`）。 */
	readonly args?: readonly string[]
	/** 这个候选是怎么来的，失败文案里要说清（`configured` / `known-path` / `path` / `search`）。 */
	readonly source?: 'configured' | 'known-path' | 'path' | 'search'
}

/** 各平台**可执行文件名**的优先级表。用在 PATH 搜索与目录搜索兜底里。 */
const WINDOWS_EXE_NAMES: readonly { readonly label: string; readonly file: string }[] = [
	{ label: 'Microsoft Edge', file: 'msedge.exe' },
	{ label: 'Google Chrome', file: 'chrome.exe' },
	{ label: 'Chromium', file: 'chromium.exe' },
]

const POSIX_EXE_NAMES: readonly { readonly label: string; readonly file: string }[] = [
	{ label: 'Microsoft Edge', file: 'microsoft-edge' },
	{ label: 'Microsoft Edge', file: 'microsoft-edge-stable' },
	{ label: 'Google Chrome', file: 'google-chrome' },
	{ label: 'Google Chrome', file: 'google-chrome-stable' },
	{ label: 'Chromium', file: 'chromium' },
	{ label: 'Chromium', file: 'chromium-browser' },
]

/**
 * 各平台的**已知安装位置**，按优先级排列。
 *
 * 顺序是刻意的：**先 Edge 后 Chrome**，因为本仓库的实测环境是 Edge，用户给这个插件
 * 装的扩展也在 Edge 里；先拉起 Edge 最可能直接命中已装扩展的那个。
 * @param platform - `process.platform` 的值。
 * @param env - 环境变量，便于验台注入。
 * @returns 候选列表，顺序即优先级。
 */
export function knownBrowserPaths(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
): BrowserCandidate[] {
	if (platform === 'win32') {
		const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
		const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
		const localAppData = env['LOCALAPPDATA'] ?? ''
		const out: BrowserCandidate[] = []
		for (const root of [programFilesX86, programFiles]) {
			out.push({ label: 'Microsoft Edge', target: path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), source: 'known-path' })
		}
		for (const root of [programFiles, programFilesX86]) {
			out.push({ label: 'Google Chrome', target: path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), source: 'known-path' })
		}
		if (localAppData !== '') {
			out.push({ label: 'Google Chrome', target: path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'), source: 'known-path' })
			out.push({ label: 'Microsoft Edge', target: path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), source: 'known-path' })
		}
		return out
	}
	if (platform === 'darwin') {
		return [
			{ label: 'Microsoft Edge', target: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', source: 'known-path' },
			{ label: 'Google Chrome', target: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', source: 'known-path' },
			{ label: 'Chromium', target: '/Applications/Chromium.app/Contents/MacOS/Chromium', source: 'known-path' },
		]
	}
	// Linux：发行版把它们装在 /usr/bin 或 /usr/local/bin，交给 PATH 搜索其实更准，
	// 但这两个落点先试一次成本为零。
	return [
		{ label: 'Microsoft Edge', target: '/usr/bin/microsoft-edge', source: 'known-path' },
		{ label: 'Google Chrome', target: '/usr/bin/google-chrome', source: 'known-path' },
		{ label: 'Chromium', target: '/usr/bin/chromium', source: 'known-path' },
		{ label: 'Chromium', target: '/usr/bin/chromium-browser', source: 'known-path' },
	]
}

/**
 * 目录搜索兜底时要扫的根目录（只取存在的那些）。
 * @param platform - `process.platform` 的值。
 * @param env - 环境变量。
 * @returns 根目录列表，顺序即优先级。
 */
export function searchRoots(
	platform: string = process.platform,
	env: Record<string, string | undefined> = process.env,
): string[] {
	if (platform === 'win32') {
		const roots = [
			env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
			env['ProgramFiles'] ?? 'C:\\Program Files',
			env['LOCALAPPDATA'] ?? '',
			env['ProgramW6432'] ?? '',
		]
		return roots.filter((value) => value !== '')
	}
	if (platform === 'darwin') return ['/Applications']
	return ['/usr/bin', '/usr/local/bin', '/opt', '/snap/bin']
}

/**
 * 从 `PATH` 里拆出目录列表（平台分隔符不同）。
 * @param env - 环境变量。
 * @param platform - 平台。
 * @returns 目录列表；`PATH` 缺失时为空数组。
 */
export function pathDirectories(
	env: Record<string, string | undefined> = process.env,
	platform: string = process.platform,
): string[] {
	// Windows 上环境变量名大小写不敏感，两种写法都认。
	const raw = env['PATH'] ?? env['Path'] ?? env['path'] ?? ''
	return raw.split(platform === 'win32' ? ';' : ':').map((entry) => entry.trim()).filter((entry) => entry !== '')
}

/** 探测结果：找到了哪一个，以及**试过哪些**（失败文案要用）。 */
export interface ResolvedBrowser {
	/** 找到的那一个；没找到时 `undefined`。 */
	readonly found?: BrowserCandidate
	/** 实际试过的目标，按尝试顺序，已去重。 */
	readonly attempted: readonly string[]
	/** 每一级各自试了几个（诊断用，也进失败文案）。 */
	readonly stages: {
		readonly configured: number
		readonly knownPath: number
		readonly path: number
		readonly search: number
	}
}

/** 这个路径是不是一个存在的可执行文件。 */
async function isExecutable(target: string): Promise<boolean> {
	try {
		await access(target, constants.X_OK)
		return true
	} catch {
		return false
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
export async function searchForBrowser(options: {
	root: string
	names: readonly { readonly label: string; readonly file: string }[]
	maxDepth?: number
	maxEntries?: number
	budgetMs?: number
	now?: () => number
}): Promise<BrowserCandidate | undefined> {
	const maxDepth = options.maxDepth ?? LAUNCH_SEARCH_MAX_DEPTH
	const maxEntries = options.maxEntries ?? LAUNCH_SEARCH_MAX_ENTRIES
	const budgetMs = options.budgetMs ?? LAUNCH_SEARCH_BUDGET_MS
	const now = options.now ?? (() => Date.now())
	const started = now()
	const wanted = new Map(options.names.map((entry) => [entry.file.toLowerCase(), entry.label]))
	let seen = 0

	/** 广度优先，逐层下探；每层按名字排序，保证同一台机器上结果稳定。 */
	let frontier: { dir: string; depth: number }[] = [{ dir: options.root, depth: 0 }]
	while (frontier.length > 0) {
		const next: { dir: string; depth: number }[] = []
		for (const { dir, depth } of frontier) {
			if (now() - started > budgetMs || seen > maxEntries) return undefined
			let entries
			try {
				entries = await readdir(dir, { withFileTypes: true })
			} catch {
				continue
			}
			entries.sort((a, b) => a.name.localeCompare(b.name))
			for (const entry of entries) {
				seen += 1
				if (seen > maxEntries) return undefined
				const full = path.join(dir, entry.name)
				if (entry.isFile()) {
					const label = wanted.get(entry.name.toLowerCase())
					if (label !== undefined && await isExecutable(full)) {
						return { label, target: full, source: 'search' }
					}
					continue
				}
				if (entry.isDirectory() && depth < maxDepth) next.push({ dir: full, depth: depth + 1 })
			}
		}
		frontier = next
	}
	return undefined
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
export async function resolveBrowser(options: {
	path?: string
	platform?: string
	env?: Record<string, string | undefined>
	knownPaths?: readonly BrowserCandidate[]
	search?: boolean
	names?: readonly { readonly label: string; readonly file: string }[]
	now?: () => number
} = {}): Promise<ResolvedBrowser> {
	const platform = options.platform ?? process.platform
	const env = options.env ?? process.env
	const names = options.names ?? (platform === 'win32' ? WINDOWS_EXE_NAMES : POSIX_EXE_NAMES)
	const attempted: string[] = []
	const stages = { configured: 0, knownPath: 0, path: 0, search: 0 }
	const record = (target: string): void => {
		if (!attempted.includes(target)) attempted.push(target)
	}

	// ── 1. 显式配置：给了就**只用它** ──────────────────────────────────
	const explicit = options.path?.trim()
	if (explicit !== undefined && explicit !== '') {
		stages.configured = 1
		record(explicit)
		// 配置的可能是命令名（走 PATH）也可能是绝对路径（探测存在性）。
		const isBareName = !explicit.includes('/') && !explicit.includes('\\')
		if (isBareName || await isExecutable(explicit)) {
			return { found: { label: path.basename(explicit), target: explicit, source: 'configured' }, attempted, stages }
		}
		// 配了却不存在：**不往下试**，如实报错。悄悄换成另一个浏览器会让"我指定了"
		// 变成谎话，而且下一次他还是不知道为什么没生效。
		return { attempted, stages }
	}

	// ── 2. 已知安装位置 ────────────────────────────────────────────────
	const known = options.knownPaths ?? knownBrowserPaths(platform, env)
	for (const candidate of known) {
		stages.knownPath += 1
		record(candidate.target)
		if (await isExecutable(candidate.target)) return { found: candidate, attempted, stages }
	}

	// ── 3. PATH 搜索 ──────────────────────────────────────────────────
	for (const dir of pathDirectories(env, platform)) {
		for (const entry of names) {
			const target = path.join(dir, entry.file)
			stages.path += 1
			record(target)
			if (await isExecutable(target)) {
				return { found: { label: entry.label, target, source: 'path' }, attempted, stages }
			}
		}
	}

	// ── 4. 目录搜索兜底 ────────────────────────────────────────────────
	if (options.search !== false) {
		const now = options.now ?? (() => Date.now())
		for (const root of searchRoots(platform, env)) {
			try {
				await stat(root)
			} catch {
				continue
			}
			const found = await searchForBrowser({ root, names, ...(options.now === undefined ? {} : { now }) })
			if (found !== undefined) {
				stages.search += 1
				record(found.target)
				return { found, attempted, stages }
			}
		}
	}

	return { attempted, stages }
}

/** `browser_launch` 的结果。字段刻意少，且都能被模型直接拿去说人话。 */
export interface LaunchOutcome {
	/** 是否真的 spawn 成功（进程被拉起来了）。 */
	readonly launched: boolean
	/** 用的是哪一个浏览器（人读的名字）。 */
	readonly browser?: string
	/** 被执行的路径/命令。 */
	readonly target?: string
	/** 这个路径是怎么找到的（`configured` / `known-path` / `path` / `search`）。 */
	readonly foundVia?: string
	/** 扩展是否在超时前连上了桥。 */
	readonly connected: boolean
	/** 等了多久才连上（毫秒）；没连上时是等满的总时长。 */
	readonly waitedMs: number
	/** 没找到浏览器时试过的路径（截断后）。 */
	readonly attempted?: readonly string[]
	/** 拉起失败的原因（spawn 报错）。 */
	readonly error?: string
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
export function spawnBrowser(
	candidate: BrowserCandidate,
	extraArgs: readonly string[] = [],
): Promise<{ pid?: number }> {
	return new Promise((resolve, reject) => {
		const child = spawn(candidate.target, [...(candidate.args ?? []), ...extraArgs], {
			detached: true,
			stdio: 'ignore',
			windowsHide: false,
		})
		// `error` 只在 spawning 本身失败时来（ENOENT / EACCES）；`spawn` 事件先于它。
		child.once('error', (error) => reject(error))
		child.once('spawn', () => {
			// 到这里进程已经真的起来了。`unref` 之后再也不会为它保活。
			child.unref()
			resolve(child.pid === undefined ? {} : { pid: child.pid })
		})
	})
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
export async function waitForExtension(options: {
	isConnected: () => boolean
	timeoutMs?: number
	signal?: AbortSignal
	now?: () => number
	sleep?: (ms: number) => Promise<void>
}): Promise<{ connected: boolean; waitedMs: number }> {
	const timeoutMs = options.timeoutMs ?? LAUNCH_CONNECT_TIMEOUT_MS
	const now = options.now ?? (() => Date.now())
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	const started = now()
	for (;;) {
		if (options.isConnected()) return { connected: true, waitedMs: now() - started }
		const elapsed = now() - started
		if (elapsed >= timeoutMs) return { connected: false, waitedMs: elapsed }
		if (options.signal?.aborted === true) return { connected: false, waitedMs: elapsed }
		await sleep(Math.min(LAUNCH_POLL_INTERVAL_MS, timeoutMs - elapsed))
	}
}
