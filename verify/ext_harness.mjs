// 扩展 service worker 的测试台：在 node:vm 里加载**真实的** extension/background.js，
// 配一台有状态的假 Chrome（chrome.tabs / chrome.tabGroups / chrome.debugger …）。
//
// 为什么假 chrome 而不是真浏览器：这台机器上没法无人值守地重装扩展；但归组、
// 命令派发、WS 帧契约这些逻辑跟 Chrome 的关系只是「API 形状」，把形状做成真的
// 对象、把状态做成真的 Map，断言就有意义。verify_extension_e2e.mjs 在这之上再
// 接一条真的 WebSocket，跑真的 BridgeServer。
//
// 两个坑：
//   - 自动打桩的 Proxy 会让 `typeof chrome.tabGroups.update === 'function'` 永远成立，
//     「能力探测 + 降级」那条路就永远测不到；要显式让命名空间返回 undefined。
//   - vm context 上只取得到顶层 `function` 声明（cmdTabsOpen / addToAgentGroup …），
//     `const`/`class`（COMMANDS / agentGroupsByWindow）取不到，断言只能写在函数与假状态上。
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const BG_PATH = new URL("../extension/background.js", import.meta.url);
const MANIFEST_PATH = new URL("../extension/manifest.json", import.meta.url);
let bgCode;
let realManifest;
let pageVm;

/** @returns 一台内存里的假浏览器。 */
export function makeModel({ failGroupTimes = 0 } = {}) {
  return {
    tabs: new Map(),
    groups: new Map(),
    /**
     * windowId -> {id, state, focused, type, incognito}。1 号窗口默认就存在且聚焦，老的台子
     * 不用改一行代码：`resolveTab` 的兜底、`tabs.create` 的默认窗口、`activateTabWindow`
     * 的「这个窗口是不是用户正在看的那个」都要读到它。
     */
    windows: new Map([[1, { id: 1, state: "normal", focused: true, type: "normal", incognito: false }]]),
    nextWindowId: 2,
    /**
     * 「当前窗口」——`chrome.tabs.create` 不传 windowId 时的落点。
     *
     * 它**不是** `lastFocusedWindowId()`：真 Chrome 里"当前窗口"是最后被激活过的那个 window，
     * 而一个新窗口（即使 `focused:false`）也会成为当前窗口。这个差异正是实测到的串罐缺陷
     * 的成因（`jar=normal` 的 `tabs.open` 落进了刚建的无痕窗口），所以假浏览器必须照这个语义来，
     * 否则那条缺陷在测试里根本发不出来。
     */
    currentWindowId: 1,
    /**
     * >0 时 `chrome.windows.remove` 的行为是"立刻 resolve、稍后才真的摘掉窗口"。
     * 真 Chrome 实测就长这样：`profile.close` 立刻复查窗口列表会看到它还在，于是误报
     * 「windows.remove 没有生效」。台子要能复现这个时序，才能钉住"要轮询等它消失"。
     */
    windowRemoveDelayMs: 0,
    /**
     * `chrome.extension.isAllowedIncognitoAccess()` 的答案。**默认 false**，跟真实新手装机
     * 一样：无痕访问必须由用户在扩展管理页显式打开。想测隔离实例就把它翻成 true。
     */
    incognitoAllowed: false,
    /** `chrome.windows.update` 每次调用的 [id, props]——「avoid 不许抬窗口」靠它判。 */
    windowUpdates: [],
    /** `chrome.windows.create` 每次调用的参数（新窗口策略的证据）。 */
    windowCreateCalls: [],
    /** >0 时 `chrome.windows.remove` 拒绝（演「窗口正在收尾/被挡住」）。 */
    failWindowsRemoveTimes: 0,
    windowsRemoveError: null,
    /** tabs.onActivated / windows.onFocusChanged 的订阅者（见 fireActivated / fireWindowFocus）。 */
    activationListeners: [],
    focusListeners: [],
    /** tabs.onRemoved 的订阅者：真 Chrome 在标签页消失时广播，扩展的清理路径挂在这上面。 */
    removedListeners: [],
    nextTabId: 100,
    nextGroupId: 500,
    calls: { group: 0, ungroup: 0, create: 0, remove: 0, windowsUpdate: 0, windowsCreate: 0 },
    failGroupTimes,
    /** 每次 `chrome.tabs.remove` 实际收到的参数（数组形态）——用来断言「一批 = 一次调用」。 */
    removeCalls: [],
    /** >0 时 `chrome.tabs.remove` 拒绝，用来演「调用失败但副作用可能已经发生」。 */
    failRemoveTimes: 0,
    removeError: null,
    /**
     * >0 时：先把前 N 个 id 真的关掉，再让整次 `remove` 拒绝 —— 真实竞态（用户在那
     * 一瞬间自己关掉了其中一个标签，Chrome 于是拒绝了整批）。专治「失败就当什么都没
     * 发生」的实现。
     */
    removeRejectButClose: 0,
    /**
     * 假 CDP 会话。`attached` 是 **Chrome 侧**的事实，扩展里的 `attachedTabs`
     * 是它的缓存——两者故意分开，才能测出「缓存说了谎」这类缺陷。
     * `failPlan(method, nth)` 返回错误文案，模拟会话中途丢失。
     */
    dbg: {
      attached: new Set(),
      attachCount: 0,
      detachCount: 0,
      sends: {},
      failPlan: null,
      attachPlan: null,
      listeners: { onEvent: [], onDetach: [] },
      /**
       * 每个 CDP 方法返回什么。值可以是现成的对象，也可以是 `(params) => 对象`——
       * 需要按参数演的时候（`DOM.resolveNode` 按 backendNodeId 找节点）用函数。
       * 没登记的走下面 `cdpResult` 里的默认语义。
       */
      results: {},
      /** 调用顺序记录，用来断言「先清了旧 ref 再取 AX 树」这类顺序要求。 */
      log: [],
      /** `Runtime.bindingCalled` 的到达顺序（谁在什么时候从页面报到扩展）。 */
      bindings: [],
    },
    /**
     * 页面本身的样子（title / url），以及「真实 DOM 节点」集合。
     *
     * `touchRequested*` 是**仿真请求**，`touchDocument*` 是**当前文档真正看到**的值。真机实测
     * （Edge 156，2026-10-29）：`Emulation.setTouchEmulationEnabled` 只对**之后**加载的文档
     * 生效——`navigator.maxTouchPoints` 立刻变，但 `'ontouchstart' in window` 要等一次导航
     * 才出现（补 `setDeviceMetricsOverride{mobile:true}` 也没用）。所以 `commitLoad` 才把
     * 请求值落到文档上。少了这个模型，"工具谎报 touch 已启用"这类缺陷测不出来。
     */
    page: {
      title: "Fake page",
      url: "https://fake.test/",
      touchRequested: false,
      touchRequestedPoints: 0,
      touchDocument: false,
      touchDocumentPoints: 0,
    },
    /**
     * 导航剧本：`'stale'` = 请求的文档永远不提交（标签还停在旧页面上），
     * `'load'` = 走一遍 loading→complete，`'instant'` = 直接完成。
     * `createNav` 管新建标签：`'blip'` 模拟真 Chrome 的「出生在 about:blank 且已是
     * complete，随后才开始加载」。
     */
    nav: "load",
    createNav: "load",
    loadDelayMs: 240,
    slowStartMs: 400,
    updatedListeners: [],
    axNodes: [],
    elements: new Map(),
    byBackend: new Map(),
    nextObjectId: 1,
    addTab(windowId, url) {
      const id = this.nextTabId++;
      if (!this.windows.has(windowId)) {
        this.windows.set(windowId, { id: windowId, state: "normal", focused: false, type: "normal", incognito: false });
      }
      const incognito = this.windows.get(windowId).incognito === true;
      this.tabs.set(id, { id, windowId, groupId: -1, url, title: url, active: false, status: "complete", pendingUrl: "", incognito });
      return id;
    },
    /** 造一个窗口；`focused: true` 会把其它窗口的聚焦标记让出去（真 Chrome 只有一个）。 */
    addWindow({ focused = false, state = "normal", incognito = false } = {}) {
      const id = this.nextWindowId++;
      if (focused) for (const w of this.windows.values()) w.focused = false;
      this.windows.set(id, { id, state, focused, type: "normal", incognito });
      // 新窗口会变成「当前窗口」（即使没聚焦）——`tabs.create` 不传 windowId 就落在这里。
      this.currentWindowId = id;
      return id;
    },
    /** 这个窗口里的标签页（tab.incognito 由窗口决定，真 Chrome 就是这么报告的）。 */
    tabsInWindow(windowId) {
      return [...this.tabs.values()].filter((t) => t.windowId === Number(windowId));
    },
    /** 现在「用户正在看的」窗口：有聚焦标记的那个，一个都没有就退回 1 号。 */
    lastFocusedWindowId() {
      const focused = [...this.windows.values()].filter((w) => w.focused === true);
      return focused.length > 0 ? focused[focused.length - 1].id : 1;
    },
    /**
     * 演「用户自己切到了某个标签页」：真 Chrome 会广播 tabs.onActivated。
     * 扩展靠它分辨「谁动的」——所以这里**不**改 active 标记以外的任何状态，
     * 也不假装是扩展自己切的。
     */
    fireActivated(tabId, windowId) {
      const tab = this.tabs.get(Number(tabId));
      const win = windowId ?? tab?.windowId ?? 1;
      if (tab !== undefined) {
        for (const t of this.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === tab.id;
      }
      for (const fn of this.activationListeners) { try { fn({ tabId: Number(tabId), windowId: win }); } catch { /* 监听器炸了不该影响假浏览器 */ } }
    },
    /**
     * 演「用户把某个窗口切到前台」；传 -1（= chrome.windows.WINDOW_ID_NONE）演
     * 「所有窗口都失焦了」（用户切去了别的应用）。
     */
    fireWindowFocus(windowId) {
      for (const w of this.windows.values()) w.focused = w.id === Number(windowId);
      // 真 Chrome 里「当前窗口」跟着聚焦走；WINDOW_ID_NONE 只是失焦，不换当前窗口。
      if (Number(windowId) > 0 && this.windows.has(Number(windowId))) this.currentWindowId = Number(windowId);
      for (const fn of this.focusListeners) { try { fn(Number(windowId)); } catch { /* 同上 */ } }
    },
    /**
     * 广播「这个标签页没了」。`tabs.remove` / `windows.remove` 内部会调它，测试里也能手动打。
     */
    fireTabRemoved(tabId) {
      for (const fn of this.removedListeners) { try { fn(Number(tabId), { windowId: 1, isWindowClosing: false }); } catch { /* 同上 */ } }
    },
    /**
     * 演「页面里那条 CDP binding 被调了一次」（`Runtime.addBinding` 的回调）。
     *
     * 真 Chrome 的 `payload` 是被调参数的 JSON 串；扩展只认名字、不解析内容，所以这里
     * 照原样塞进去。走 `chrome.debugger.onEvent` 是真路径——输入探针的监听器在真实
     * 页面上就是这个通道（见 ext_harness 的 makeInputProbePage）。
     */
    fireBinding(tabId, name, payload) {
      this.dbg.bindings.push({ tabId: Number(tabId), name, payload });
      const source = { tabId: Number(tabId), targetType: "page" };
      for (const fn of this.dbg.listeners.onEvent) {
        try { fn(source, "Runtime.bindingCalled", { name, payload }); } catch { /* 同上 */ }
      }
    },
    /**
     * 造一个「页面上的真实元素」，供 AX 快照通过 backendDOMNodeId 找到它。
     * 元素带 getBoundingClientRect / setAttribute，所以扩展那段在页面里跑的
     * 函数是**真的被执行**，而不是我们替它假定结果。
     */
    addPageNode({ backendNodeId, tagName = "BUTTON", rect = { x: 10, y: 20, width: 100, height: 30 }, type, value, href } = {}) {
      const objectId = `obj-${this.nextObjectId++}`;
      // 真 getBoundingClientRect() 同时有 x/y/width/height 和 left/top/right/bottom，
      // 页面里的函数读哪种都得给全，否则测试会假装通过
      const full = {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height,
      };
      const el = {
        objectId,
        tagName,
        type,
        value,
        href,
        attributes: {},
        rect: full,
        getBoundingClientRect() { return this.rect; },
        setAttribute(name, v) { this.attributes[name] = String(v); },
        removeAttribute(name) { delete this.attributes[name]; },
      };
      this.elements.set(objectId, el);
      if (backendNodeId !== undefined) this.byBackend.set(backendNodeId, objectId);
      return el;
    },
    /** 模拟 Chrome 单方面丢掉会话（DevTools 抢占 / 导航竞态），并广播 onDetach。 */
    fireDetach(tabId, reason = "target_closed") {
      this.dbg.attached.delete(tabId);
      for (const fn of this.dbg.listeners.onDetach) fn({ tabId, targetType: "page" }, reason);
    },
  };
}

/**
 * 把一次 CDP 调用演成真的结果。默认语义按 Chrome 的样子来：
 * `Runtime.evaluate` 回 `{result:{value}}`、`DOM.resolveNode` 按 backendNodeId
 * 找 objectId、`Runtime.callFunctionOn` **实际执行**扩展传进来的那段页面函数。
 * 测试可以用 `model.dbg.results[method]` 覆盖任意一个。
 */
function cdpResult(model, method, params) {
  const custom = model.dbg.results[method];
  if (typeof custom === "function") return custom(params, model);
  if (custom !== undefined) return custom;
  switch (method) {
    case "Runtime.evaluate": {
      const expression = String(params?.expression ?? "");
      if (expression.includes("document.title")) return { result: { value: model.page.title } };
      if (expression.includes("location.href")) return { result: { value: model.page.url } };
      // 扩展读回「页面真实看到的触摸能力」（background.js 的 touchStateOf）：只有文档锁定的值，
      // 不是仿真请求值——这一条正是用来拆穿"开关成功就算生效"的谎报。
      if (expression.includes("ontouchstart")) {
        return {
          result: {
            value: {
              ontouchstart: model.page.touchDocument === true,
              maxTouchPoints: model.page.touchDocumentPoints,
            },
          },
        };
      }
      return { result: { value: null } };
    }
    case "Emulation.setTouchEmulationEnabled":
      // 只登记请求值：当前文档看不到，要等下一次 commitLoad（真机语义）。
      model.page.touchRequested = params?.enabled === true;
      model.page.touchRequestedPoints = Number(params?.maxTouchPoints) || 0;
      return {};
    case "Emulation.setDeviceMetricsOverride":
    case "Emulation.clearDeviceMetricsOverride":
    case "Emulation.setUserAgentOverride":
      return {};
    case "DOM.resolveNode": {
      const objectId = model.byBackend.get(params?.backendNodeId);
      return objectId ? { object: { objectId } } : {};
    }
    case "Runtime.callFunctionOn":
      return runPageFunction(model, params);
    case "Accessibility.getFullAXTree":
      return { nodes: model.axNodes };
    case "Page.enable": case "Runtime.enable": case "Network.enable":
    case "DOM.enable": case "Accessibility.enable":
      return {};
    default:
      return { result: { value: null } };
  }
}

/** 在另一个 vm 里执行页面函数，`this` 绑到假元素上——所以副作用是真的发生的。 */
function runPageFunction(model, params) {
  const el = model.elements.get(params?.objectId);
  if (el === undefined) return { exceptionDetails: { text: "No node with given id found" } };
  pageVm ??= vm.createContext({ Math, String, Number, Object, Array, JSON, Boolean, isNaN, parseInt, parseFloat });
  try {
    const factory = vm.runInContext(`(${params.functionDeclaration})`, pageVm, { filename: "page-fn.js" });
    const args = (params.arguments ?? []).map((a) => (a && "value" in a ? a.value : a?.objectId));
    const value = Reflect.apply(factory, el, args);
    return { result: { value: value === undefined ? null : value } };
  } catch (error) {
    return { exceptionDetails: { text: String(error?.message ?? error) } };
  }
}

function stub(path, state) {
  return new Proxy(function () {}, {
    get: (_t, k) => {
      if (typeof k !== "string") return undefined;
      if (k === "lastError") return state.lastError;
      if (k === "then" || k === "catch" || k === "finally") return undefined;
      if (k === "addListener") return () => {};
      return stub(`${path}.${k}`, state);
    },
    apply: () => Promise.resolve({ result: { value: null } }),
  });
}

/**
 * @param model 假浏览器
 * @param options.withTabGroups 关掉即模拟「Chrome 太旧或权限没给」
 * @param options.storage chrome.storage.local.get 的返回值（扩展的端口/Token 就从这里来）
 * @param options.sessionStorage `chrome.storage.session` 的落点；默认与 local 同一份（多数台子
 *   不关心区别）。接管浮层把「哪个标签页被接管」放在 session 里，`verify_hold` 传一份单独的
 *   对象，才能断言它**没有**落进会跨浏览器重启留下的 local。
 * @param options.manifest 喂给 chrome.runtime.getManifest() 的内容（扩展会把它报给桥）
 */
export function makeChrome(model, { withTabGroups = true, storage = {}, sessionStorage = storage, manifest = { version: "0.0.0-harness" } } = {}) {
  const state = { lastError: undefined };
  const resolve = (v) => Promise.resolve(v);
  const reject = (m) => Promise.reject(new Error(m));
  const listener = () => ({ addListener: () => {}, removeListener: () => {} });

  const fireUpdated = (m, tab, info) => {
    for (const fn of m.updatedListeners) { try { fn(tab.id, info, { ...tab }); } catch { /* 监听器炸了不该影响假浏览器 */ } }
  };
  const beginLoad = (m, id, url) => {
    const tab = m.tabs.get(id);
    if (tab === undefined) return;
    tab.status = "loading";
    tab.pendingUrl = url ?? "";
    fireUpdated(m, tab, { status: "loading" });
    setTimeout(() => commitLoad(m, id, url), m.loadDelayMs);
  };
  const commitLoad = (m, id, url) => {
    const tab = m.tabs.get(id);
    if (tab === undefined) return;
    tab.url = url ?? tab.url;
    tab.pendingUrl = "";
    tab.status = "complete";
    m.page.url = tab.url;
    m.page.title = `Loaded: ${tab.url}`;
    // 新文档才看得见当前开着的触摸仿真（真机语义，见 model.page 的注释）。
    m.page.touchDocument = m.page.touchRequested === true;
    m.page.touchDocumentPoints = m.page.touchRequestedPoints;
    fireUpdated(m, tab, { status: "complete" });
  };

  const dropEmptyGroups = () => {
    for (const [gid, group] of model.groups) {
      if (![...model.tabs.values()].some((t) => t.groupId === gid)) model.groups.delete(gid);
    }
  };

  const setActive = (tab) => {
    for (const t of model.tabs.values()) if (t.windowId === tab.windowId) t.active = t.id === tab.id;
  };

  const tabs = {
    /**
     * `tabs.onRemoved` 以前是个**假** listener（addListener 空转），于是扩展里建立在它上面
     * 的清理路径（归属、让出、debugger 缓存）在测试里从来没被执行过——缺陷可以整片地活下来。
     * 现在它是真的注册表，`tabs.remove` / `windows.remove` 都会逐个广播（真 Chrome 就是这样）。
     */
    onRemoved: { addListener: (fn) => { model.removedListeners.push(fn); }, removeListener: (fn) => {
      const at = model.removedListeners.indexOf(fn);
      if (at >= 0) model.removedListeners.splice(at, 1);
    } },
    onUpdated: { addListener: (fn) => { model.updatedListeners.push(fn); }, removeListener: (fn) => {
      const at = model.updatedListeners.indexOf(fn);
      if (at >= 0) model.updatedListeners.splice(at, 1);
    } },
    onActivated: { addListener: (fn) => { model.activationListeners.push(fn); }, removeListener: (fn) => {
      const at = model.activationListeners.indexOf(fn);
      if (at >= 0) model.activationListeners.splice(at, 1);
    } },
    onCreated: listener(),
    onMoved: listener(),
    create: ({ url, active = true, windowId }) => {
      model.calls.create++;
      // 真 Chrome 不传 windowId 时落在**当前窗口**（最后被激活过的那个），不是 `lastFocusedWindow`
      // ——刚建的无痕窗口即使 focused:false 也会成为当前窗口，`jar=normal` 的标签页因此串进无痕罐。
      const id = model.addTab(windowId ?? model.currentWindowId ?? model.lastFocusedWindowId(), url ?? "");
      const tab = model.tabs.get(id);
      tab.active = active;
      if (active) setActive(tab);
      // 默认按真 Chrome：新建的标签先进 loading。'blip' 专门造那个坑——
      // 它出生在 about:blank 并且立刻就是 complete，requested URL 还没开始。
      if (model.createNav === "blip") {
        tab.url = "about:blank"; tab.status = "complete"; tab.pendingUrl = url ?? "";
        setTimeout(() => beginLoad(model, id, url), 30);
      } else if (model.createNav === "instant") {
        commitLoad(model, id, url);
      } else {
        tab.status = "loading"; tab.pendingUrl = url ?? "";
        fireUpdated(model, tab, { status: "loading" });
        setTimeout(() => commitLoad(model, id, url), model.loadDelayMs);
      }
      return resolve({ ...tab });
    },
    update: (id, props = {}) => {
      const tab = model.tabs.get(Number(id));
      if (tab === undefined) return reject(`No tab with id: ${id}`);
      if (props.url !== undefined) {
        if (model.nav === "stale") {
          // 请求的文档始终不提交：URL 不变、状态仍是 complete —— 就是「导航没到位」
        } else if (model.nav === "instant") {
          commitLoad(model, tab.id, props.url);
        } else if (model.nav === "slowstart") {
          // 真 Chrome 会有的样子：先让旧文档保持 complete 一小会儿，才开始加载
          tab.pendingUrl = props.url;
          setTimeout(() => {
            tab.status = "loading";
            fireUpdated(model, tab, { status: "loading" });
            setTimeout(() => commitLoad(model, tab.id, props.url), model.loadDelayMs);
          }, model.slowStartMs ?? 400);
        } else {
          tab.status = "loading"; tab.pendingUrl = props.url;
          fireUpdated(model, tab, { status: "loading" });
          setTimeout(() => commitLoad(model, tab.id, props.url), model.loadDelayMs);
        }
      }
      if (props.active !== undefined) {
        tab.active = props.active;
        // 真 Chrome：激活一个标签页，同窗口里其它的就都不是 active 了。
        if (props.active) setActive(tab);
      }
      return resolve({ ...tab });
    },
    get: (id) => (model.tabs.has(id) ? resolve({ ...model.tabs.get(id) }) : reject(`No tab with id: ${id}`)),
    query: (info = {}) => {
      let list = [...model.tabs.values()];
      if (info.windowId !== undefined) list = list.filter((t) => t.windowId === info.windowId);
      if (info.groupId !== undefined) list = list.filter((t) => t.groupId === info.groupId);
      if (info.active === true) list = list.filter((t) => t.active === true);
      if (info.active === false) list = list.filter((t) => t.active !== true);
      // `lastFocusedWindow` 是这个台子以前**忽略**掉的那个参数：扩展的兜底目标
      // 全靠它，忽略掉就等于让「用户在看哪个窗口」这件事无从测起。
      if (info.lastFocusedWindow === true) {
        const wid = model.lastFocusedWindowId();
        list = list.filter((t) => t.windowId === wid);
      }
      return resolve(list.map((t) => ({ ...t })));
    },
    group: ({ tabIds, groupId, createProperties }) => {
      model.calls.group++;
      if (model.failGroupTimes > 0) {
        model.failGroupTimes--;
        return reject("Cannot group the tab because it is being moved");
      }
      const ids = tabIds.map(Number);
      for (const id of ids) if (!model.tabs.has(id)) return reject(`No tab with id: ${id}`);
      let gid = groupId;
      if (gid === undefined) {
        const windowId = createProperties?.windowId ?? model.tabs.get(ids[0]).windowId;
        gid = model.nextGroupId++;
        model.groups.set(gid, { id: gid, windowId, title: "", color: "grey" });
      } else if (!model.groups.has(gid)) {
        // 往不存在的 groupId 上塞标签：真 Chrome 就是这么拒绝的
        return reject(`No group with id: ${gid}`);
      }
      for (const id of ids) model.tabs.get(id).groupId = gid;
      return resolve(gid);
    },
    ungroup: (tabIds) => {
      model.calls.ungroup++;
      const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number);
      for (const id of ids) {
        if (!model.tabs.has(id)) return reject(`No tab with id: ${id}`);
        model.tabs.get(id).groupId = -1;
      }
      dropEmptyGroups();
      return resolve();
    },
    /**
     * 真 Chrome 的语义：`remove` 接受**数组**，且任何一个 id 不存在就整次调用拒绝。
     * 后者正是 `tabs.closeMany` 必须先自查存在性的原因——不然「一个已经关掉的标签」
     * 会把同批里还能关的标签一起拖死。
     */
    remove: (ids) => {
      model.calls.remove++;
      const list = (Array.isArray(ids) ? ids : [ids]).map(Number);
      model.removeCalls.push(list);
      if (model.removeRejectButClose > 0) {
        const taken = list.slice(0, model.removeRejectButClose);
        for (const id of taken) model.tabs.delete(id);
        model.removeRejectButClose = 0;
        for (const id of taken) model.fireTabRemoved(id);
        return reject(model.removeError ?? `Tabs cannot be removed: ${taken.join(", ")}`);
      }
      if (model.failRemoveTimes > 0) {
        model.failRemoveTimes--;
        return reject(model.removeError ?? `Tabs cannot be removed: ${list.join(", ")}`);
      }
      for (const id of list) if (!model.tabs.has(id)) return reject(`No tab with id: ${id}`);
      for (const id of list) model.tabs.delete(id);
      // 真 Chrome：标签页真的消失之后才广播 onRemoved。扩展的归属/让出/debugger 清理挂在这上面。
      for (const id of list) model.fireTabRemoved(id);
      dropEmptyGroups();
      return resolve();
    },
  };

  const tabGroups = {
    get: (id) => (model.groups.has(id) ? resolve({ ...model.groups.get(id) }) : reject(`No group with id: ${id}`)),
    query: (info = {}) => {
      let list = [...model.groups.values()];
      if (info.title !== undefined) list = list.filter((g) => g.title === info.title);
      if (info.windowId !== undefined) list = list.filter((g) => g.windowId === info.windowId);
      return resolve(list.map((g) => ({ ...g })));
    },
    update: (id, props) => {
      if (!model.groups.has(id)) return reject(`No group with id: ${id}`);
      Object.assign(model.groups.get(id), props);
      return resolve({ ...model.groups.get(id) });
    },
  };

  /**
   * 假 `chrome.windows`。这台以前完全没有：`chrome.windows.get` 走打桩 Proxy 会回
   * `{result:{value:null}}`，于是 `win.state` 与 `win.id` 都是 undefined，
   * `windows.update(undefined, {focused:true})` 静默成功——「AI 有没有把窗口抬到
   * 用户脸上」这件事就这么从测试里漏掉了。聚焦策略要能被断言，就必须先有窗口。
   */
  const windowsApi = {
    WINDOW_ID_NONE: -1,
    get: (id) => (model.windows.has(Number(id)) ? resolve({ ...model.windows.get(Number(id)) }) : reject(`No window with id: ${id}`)),
    getAll: (info = {}) => {
      let list = [...model.windows.values()];
      if (info.windowTypes !== undefined) list = list.filter((w) => info.windowTypes.includes(w.type));
      return resolve(list.map((w) => ({ ...w })));
    },
    update: (id, props = {}) => {
      const win = model.windows.get(Number(id));
      if (win === undefined) return reject(`No window with id: ${id}`);
      model.calls.windowsUpdate++;
      model.windowUpdates.push([Number(id), { ...props }]);
      if (props.focused === true) for (const w of model.windows.values()) w.focused = w.id === win.id;
      else if (props.focused === false) win.focused = false;
      // 聚焦会把它变成「当前窗口」（`tabs.create` 的默认落点）。
      if (props.focused === true) model.currentWindowId = win.id;
      if (props.state !== undefined) win.state = props.state;
      return resolve({ ...win });
    },
    /** 新窗口策略：`focused:false` 是「别抢用户焦点」那一条的实际证据。 */
    create: ({ url, focused = true, type = "normal", incognito = false } = {}) => {
      model.calls.windowsCreate++;
      model.windowCreateCalls.push({ url, focused, type, incognito });
      const id = model.addWindow({ focused, state: "normal", incognito });
      const tabId = model.addTab(id, url ?? "");
      const tab = model.tabs.get(tabId);
      tab.active = true;
      tab.status = "loading";
      tab.pendingUrl = url ?? "";
      setTimeout(() => commitLoad(model, tabId, url ?? "about:blank"), model.loadDelayMs);
      return resolve({ ...model.windows.get(id), tabs: [{ ...tab }] });
    },
    /**
     * 关窗口（顺带关掉里面所有标签页）。隔离实例的 `profile.close` 走这里——
     * 台子必须连标签页一起清掉，否则「关掉无痕窗口之后归属还挂着」这种缺陷测不出来。
     */
    remove: (id) => {
      const winId = Number(id);
      if (!model.windows.has(winId)) return reject(`No window with id: ${id}`);
      model.calls.windowsRemove = (model.calls.windowsRemove ?? 0) + 1;
      // 失败注入：真 Chrome 会拒绝关某些窗口（正在收尾、被策略挡住）。扩展的
      // `profile.close` 必须**复查**之后才敢说「关掉了」——没有这个开关，
      // 「remove 失败却报 closed:[id]」这种谎话在测试里根本发不出来。
      if (model.failWindowsRemoveTimes > 0) {
        model.failWindowsRemoveTimes--;
        model.windowsRemoveRejections = (model.windowsRemoveRejections ?? 0) + 1;
        return reject(model.windowsRemoveError ?? `Cannot remove window with id: ${id}`);
      }
      const finish = () => {
        const doomed = model.tabsInWindow(winId).map((tab) => tab.id);
        for (const tabId of doomed) model.tabs.delete(tabId);
        model.windows.delete(winId);
        if (model.currentWindowId === winId) model.currentWindowId = model.lastFocusedWindowId();
        // 关窗口会连带关掉里面的标签页：真 Chrome 为每一个都广播 tabs.onRemoved
        //（`isWindowClosing: true`）。少了这条，「用户手动关掉无痕窗口」之后扩展的
        // 归属/让出清理就永远测不到。
        for (const tabId of doomed) {
          for (const fn of model.removedListeners) { try { fn(tabId, { windowId: winId, isWindowClosing: true }); } catch { /* 同上 */ } }
        }
        for (const fn of model.windowRemovedListeners ?? []) { try { fn(winId); } catch { /* 同上 */ } }
      };
      // 真实时序：remove 的 promise 立刻回来，窗口却还是列表里的一员（见 windowRemoveDelayMs）。
      if (model.windowRemoveDelayMs > 0) setTimeout(finish, model.windowRemoveDelayMs);
      else finish();
      return resolve();
    },
    onFocusChanged: { addListener: (fn) => { model.focusListeners.push(fn); }, removeListener: (fn) => {
      const at = model.focusListeners.indexOf(fn);
      if (at >= 0) model.focusListeners.splice(at, 1);
    } },
    onCreated: listener(),
    onRemoved: listener(),
  };

  /** 假 `chrome.extension`：无痕访问是**用户**在扩展管理页给的开关，台子用 model.incognitoAllowed 演。 */
  const extensionApi = {
    // MV3（Chrome 99+）返回 Promise；这里同样返回 Promise，扩展那边必须先看 then。
    isAllowedIncognitoAccess: () => Promise.resolve(model.incognitoAllowed === true),
    // spanning 模式下扩展是一个共享进程，真实 worker 里这个值没有决策意义。
    inIncognitoContext: false,
    isAllowedFileSchemeAccess: () => Promise.resolve(false),
  };

  const dbg = model.dbg;
  /**
   * 假 debugger。语义照着真 Chrome 来：会话已经被 Chrome 收回时，
   * `sendCommand` 回 `Debugger is not attached to the tab with id: N.`——
   * 这正是「扩展缓存还说附着着」暴露出来的方式。
   */
  const debuggerApi = {
    attach: (target, version, cb) => {
      const done = typeof version === "function" ? version : cb;
      dbg.attachCount++;
      // 演「页面卡住 / 渲染进程不响应」：附着回调永远不回来。真 Chrome 上这是会发生的，
      // 而且它能把任何等着附着的命令吊死——AI 高亮框要在认领标签页时附着，所以必须证明
      // 它吊住时 `tabs.open` 仍按自己的预算返回。
      if (dbg.attachHang === true) return undefined;
      // 演「附着本身要花时间」：真机冷附着几十到几百毫秒。用来证明 `eval` 的
      // timeoutMs 预算只量页面里那一段 await，不把附着算进去。
      if (dbg.attachDelayMs > 0) {
        const forcedByDelay = typeof dbg.attachPlan === "function" ? dbg.attachPlan(Number(target?.tabId), dbg.attachCount) : null;
        if (!forcedByDelay) dbg.attached.add(Number(target?.tabId));
        setTimeout(() => {
          state.lastError = forcedByDelay ? { message: forcedByDelay } : undefined;
          if (done) done();
        }, dbg.attachDelayMs);
        return undefined;
      }
      const forced = typeof dbg.attachPlan === "function" ? dbg.attachPlan(Number(target?.tabId), dbg.attachCount) : null;
      state.lastError = forced ? { message: forced } : undefined;
      if (!forced) dbg.attached.add(Number(target?.tabId));
      if (done) { done(); return undefined; }
      return forced ? Promise.reject(new Error(forced)) : Promise.resolve();
    },
    detach: (target, cb) => {
      dbg.detachCount++;
      dbg.attached.delete(Number(target?.tabId));
      state.lastError = undefined;
      if (cb) { cb(); return undefined; }
      return Promise.resolve();
    },
    sendCommand: (target, method, params, cb) => {
      const done = typeof params === "function" ? params : cb;
      const tabId = Number(target?.tabId);
      const nth = (dbg.sends[method] || 0) + 1;
      dbg.sends[method] = nth;
      dbg.log.push({ tabId, method, nth, params });
      let message;
      if (!dbg.attached.has(tabId)) message = `Debugger is not attached to the tab with id: ${tabId}.`;
      else if (typeof dbg.failPlan === "function") message = dbg.failPlan(method, nth, tabId);
      state.lastError = message ? { message } : undefined;
      // 失败时 CDP 不回结果，扩展就是靠 lastError 判的
      const value = message ? undefined : cdpResult(model, method, params);
      if (done) { done(message ? undefined : value); return undefined; }
      return message ? Promise.reject(new Error(message)) : Promise.resolve(value);
    },
    onEvent: { addListener: (fn) => { dbg.listeners.onEvent.push(fn); } },
    onDetach: { addListener: (fn) => { dbg.listeners.onDetach.push(fn); } },
  };

  // Badge calls are recorded rather than swallowed: "connected but frozen" is
  // only honest if the icon says so, and that is now assertable.
  const action = {
    setBadgeText: ({ text } = {}) => { model.badgeText = text ?? ""; },
    setBadgeBackgroundColor: ({ color } = {}) => { model.badgeColor = color; },
    setTitle: () => {},
  };

  // chrome.runtime.onMessage: the popup -> service worker channel. Kept per
  // boot() because a service-worker restart drops the previous listeners.
  const runtimeMessages = {
    listeners: [],
    async send(msg) {
      for (const fn of runtimeMessages.listeners) {
        const response = await new Promise((resolve) => {
          const keepOpen = fn(msg, { id: "test-extension-id" }, resolve);
          // `return true` means "sendResponse comes later"; anything else must
          // not resolve twice (Chrome logs that as an error).
          if (keepOpen !== true) queueMicrotask(() => resolve(undefined));
        });
        if (response !== undefined) return response;
      }
      return undefined;
    },
  };

  const runtime = {
    getManifest: () => manifest,
    onMessage: {
      addListener: (fn) => { runtimeMessages.listeners.push(fn); },
      removeListener: (fn) => {
        const at = runtimeMessages.listeners.indexOf(fn);
        if (at >= 0) runtimeMessages.listeners.splice(at, 1);
      },
    },
    id: "test-extension-id",
    // 必须是 getter：Chrome 在每次回调前改这个值，扩展就是读它来判失败的
    get lastError() { return state.lastError; },
  };

  const storageListeners = [];
  const fireStorageChanged = (changes) => {
    for (const fn of storageListeners) {
      try { fn(changes, "local"); } catch { /* 监听器炸了不该影响假浏览器 */ }
    }
  };
  const makeArea = (store) => ({
    // 只返回真给得出值的键：扩展那边 `{...DEFAULT_CONFIG, ...stored}` 会被 undefined 覆盖
    // model.storageGetError 非空时让 get 直接失败：本地锁这类东西在「读不到」时
    // 必须 fail-closed，而这只有把读盘演成失败才测得出来。
    // storageGetErrorKeys 用来把失败限制在某几个键上（真 Chrome 不会只让一个键读不出来，
    // 但不限制就会连 loadConfig 一起炸，测不到想测的那条分支）。
    get: (keys) => {
      const list = Array.isArray(keys) ? keys : Object.keys(keys ?? {});
      const only = model.storageGetErrorKeys;
      if (model.storageGetError && (!only || list.some((k) => only.includes(k)))) {
        return Promise.reject(new Error(model.storageGetError));
      }
      return resolve(Object.fromEntries(
        list.filter((k) => store[k] !== undefined).map((k) => [k, store[k]]),
      ));
    },
    // 真写入并广播：本地锁这类「必须活过 service worker 重启」的状态，
    // 用一个 set 不落盘的假件测不出来。
    set: (items) => {
      const changes = {};
      for (const [k, v] of Object.entries(items ?? {})) {
        changes[k] = { oldValue: store[k], newValue: v };
        store[k] = v;
      }
      fireStorageChanged(changes);
      return resolve();
    },
    remove: (keys) => {
      const changes = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        changes[k] = { oldValue: store[k], newValue: undefined };
        delete store[k];
      }
      fireStorageChanged(changes);
      return resolve();
    },
    onChanged: {
      addListener: (fn) => storageListeners.push(fn),
      removeListener: (fn) => {
        const at = storageListeners.indexOf(fn);
        if (at >= 0) storageListeners.splice(at, 1);
      },
    },
  });

  const storageArea = makeArea(storage);
  const sessionArea = makeArea(sessionStorage);

  model.sendRuntimeMessage = (msg) => runtimeMessages.send(msg);

  /**
   * 广播一次 `tabs.onUpdated`。真 Chrome 在文档换掉时发它，而扩展挂在上面做「页面导航
   * 完成后补画 AI 高亮框」——没有这个入口，那条重注入路径就只能靠真机验。
   * @param tabId 哪一个标签页。
   * @param info 变化面；默认 `{ status: 'complete' }`（正是导航完成那一次）。
   */
  model.fireTabUpdated = (tabId, info = { status: "complete" }) => {
    const tab = model.tabs.get(Number(tabId));
    if (tab !== undefined) fireUpdated(model, tab, info);
  };

  const withFallback = (obj, path) => new Proxy(obj, {
    get: (target, k) => (typeof k === "string" && !(k in target) ? stub(`${path}.${k}`, state) : target[k]),
  });

  const modeled = {
    tabs: withFallback(tabs, "chrome.tabs"),
    windows: withFallback(windowsApi, "chrome.windows"),
    extension: withFallback(extensionApi, "chrome.extension"),
    runtime: withFallback(runtime, "chrome.runtime"),
    debugger: withFallback(debuggerApi, "chrome.debugger"),
    action: withFallback(action, "chrome.action"),
    storage: withFallback({
      local: storageArea, session: sessionArea, onChanged: storageArea.onChanged,
    }, "chrome.storage"),
  };
  if (withTabGroups) modeled.tabGroups = withFallback(tabGroups, "chrome.tabGroups");

  const chrome = new Proxy({}, {
    get: (_t, k) => {
      if (typeof k !== "string") return undefined;
      if (!withTabGroups && k === "tabGroups") return undefined;
      if (k in modeled) return modeled[k];
      return stub(`chrome.${k}`, state);
    },
  });
  return chrome;
}

/**
 * 加载真实的 background.js。
 * @param options.model 复用同一台假浏览器（模拟 service worker 重启：缓存没了，状态还在）
 * @param options.realWebSocket 注入 Node 的全局 WebSocket，让它真的去连本地 BridgeServer
 * @param options.backgroundPath 换一份扩展代码来跑（评审外部补丁 / 合并预览用），默认仓库的 extension/background.js
 */
export async function bootBackground({ model, withTabGroups = true, storage = {}, sessionStorage, realWebSocket = false, backgroundPath, userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" } = {}) {
  const code = backgroundPath
    ? await readFile(new URL(backgroundPath, import.meta.url), "utf8")
    : (bgCode ??= await readFile(BG_PATH, "utf8"));
  // 扩展在加载期就读 getManifest().version 并把它报给桥，所以喂真的 manifest.json，
  // 免得一发布版本号就和一个写死在测试台里的字符串悄悄分家
  realManifest ??= JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const browser = model ?? makeModel();
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, crypto, AbortController, Blob,
    navigator: { userAgent },
    fetch: () => Promise.resolve({}),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    chrome: makeChrome(browser, {
      withTabGroups, storage, manifest: realManifest,
      ...(sessionStorage === undefined ? {} : { sessionStorage }),
    }),
  };
  if (realWebSocket) sandbox.WebSocket = globalThis.WebSocket;
  sandbox.globalThis = sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(code, ctx, { filename: backgroundPath ? "background.candidate.js" : "extension/background.js" });
  await new Promise((r) => setTimeout(r, 5));
  return { model: browser, ctx, sandbox };
}

/**
 * 假页面里的**输入探针靶场**。
 *
 * 输入探针（`pageInputProbe`）是「用户接管」唯一的信号源，而它的过滤规则全写在页面侧
 * （只认 `isTrusted`、滚动不算、拖滚动条不算、触屏滑动不算、输入框里的翻页键算）。不真跑
 * 一遍，这些规则就只剩「函数被注入过」这种空断言。所以这里**不替它编返回值**：把扩展真正
 * 注入的那段函数 `runInContext` 执行掉，`window.addEventListener` 挂到假 window 上，之后
 * 测试就能以用户的名义派发事件，看它到底报还是不报。
 *
 * binding 回调走 `model.fireBinding(...)`，那是 `chrome.debugger.onEvent` 的真路径。
 */
export function makeInputProbePage(model) {
  /** kind -> [handler]：探针自己注册的那些 */
  const listeners = new Map();
  let bindingName = null;
  let currentTab = null;
  let injections = 0;
  let installed = false;
  const win = {
    addEventListener(kind, handler) {
      const list = listeners.get(kind) ?? [];
      list.push(handler);
      listeners.set(kind, list);
    },
  };
  /**
   * 处理扩展那一次注入表达式 `(function pageInputProbe(config) {...})(JSON)`。
   * 不是探针的表达式返回 `undefined`，让调用方接别的处理器。
   */
  const handle = (params) => {
    const expression = String(params?.expression ?? "");
    if (!expression.includes("function pageInputProbe(")) return undefined;
    injections += 1;
    const call = /^(\([\s\S]*\}\))\(([\s\S]*)\)$/.exec(expression);
    if (call === null) return { exceptionDetails: { text: "probe injection not parsable" } };
    const config = JSON.parse(call[2]);
    bindingName = config.binding;
    win[bindingName] = (kind) => {
      if (currentTab !== null) model.fireBinding(currentTab, bindingName, JSON.stringify(kind));
    };
    const pageCtx = vm.createContext({ window: win, Number, String, Object, Array, JSON, Math, Boolean });
    try {
      const factory = vm.runInContext(call[1], pageCtx);
      const outcome = factory(config);
      installed = outcome === "installed" || outcome === "already";
      return { result: { value: outcome ?? null } };
    } catch (error) {
      return { exceptionDetails: { text: String(error?.message ?? error) } };
    }
  };
  /**
   * 以用户的名义派发一个事件。**先过探针**（可能被它过滤掉），过了才会变成一次 binding。
   * @returns 页面侧真的报到扩展的次数
   */
  const fire = (tabId, kind, fields = {}) => {
    currentTab = Number(tabId);
    const before = model.dbg.bindings.length;
    const event = { isTrusted: true, pointerType: "mouse", key: "", target: null, offsetX: 2, offsetY: 2, ...fields };
    for (const handler of listeners.get(kind) ?? []) {
      try { handler(event); } catch { /* 页面侧监听器炸了不该影响测试进程 */ }
    }
    return model.dbg.bindings.length - before;
  };
  return {
    handle,
    fire,
    listeners,
    isInstalled: () => installed,
    injections: () => injections,
    bindingName: () => bindingName,
    registeredKinds: () => [...listeners.keys()],
    /** 演一次导航：文档换了，探针（文档级监听 + `window` 上的安装标记）一起没了。 */
    dropDocument() {
      listeners.clear();
      installed = false;
      delete win.__dshInputProbeInstalled;
    },
  };
}
