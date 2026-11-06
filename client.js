/**
 * 「浏览器控制」设置页的 Client 半边。
 *
 * 宿主半边在同源端点 `/browser-control/api` 上实现（`src/settings-routes.ts`）。本模块只负责把
 * 它画进 `settings.section` 槽位，从不直连桥接端口：那是另一个源，而桥接刻意不发 CORS 头。
 *
 * 刻意用纯 JavaScript：npm 包发的是预构建的 `lib/index.js`，只为一个设置页把 React/TS 构建链
 * 拖进这个仓库，等于给一个「全部验证手段都是 node verify/*.mjs」的仓库再加一套工具链。React 来自
 * 浏览器模块表（`require`），不打包副本。
 *
 * 排版约定（这一版重排的来由）：正文只留「标签 + 控件」，控件一律靠右；解释性文字收进 `title`
 * （hover 才出现），正文里只保留一条真正影响判断的安全事实。间距一律是 8px 的整数倍。
 */
window.__ModuleLoader__.load({
  id: 'dsh-browser',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const API = 'browser-control/api';

    /**
     * 组件自带的样式；页面卸载时这个 <style> 元素随组件一起移除。
     *
     * 刻意放在 factory 内：HMR 或「重试本页同步」会在**同一个页面 realm** 里重新执行同一个
     * bundle。顶层 `const` 第二次执行会抛 `Identifier 'CSS' has already been declared`，bundle
     * 就什么都没注册上，页面报的正是「loaded without registering via __ModuleLoader__.load」。
     * 所有声明都必须留在 factory 里，文件的顶层语句只有那一次 load 调用。
     *
     * 颜色只用现成的 `--dsw-alias-*` 主题 token：深色主题下会自己反转，页面上不出现硬编码色值。
     */
    const CSS = `
.bc-page { display: flex; flex-direction: column; gap: 16px; max-width: 860px; color: var(--dsw-alias-label-primary); }
.bc-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.bc-title { font-size: 18px; font-weight: 600; line-height: 1.4; }
.bc-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }
.bc-card { display: flex; flex-direction: column; gap: 8px; padding: 16px 20px 20px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 14px; background: var(--dsw-alias-bg-layer-1); }
.bc-card-title { font-size: 13px; font-weight: 600; line-height: 1.5; }
.bc-status { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px 16px; }
.bc-status-row { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.bc-status-row.wide { grid-column: 1 / -1; }
.bc-status-label { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.bc-status-value { font-size: 13px; line-height: 1.5; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.bc-status-value.ok { color: var(--dsw-alias-state-success-primary); }
.bc-status-value.err { color: var(--dsw-alias-state-error-primary); }
.bc-status-value.warn { color: var(--dsw-alias-state-warn-primary); }
.bc-status-value.idle { color: var(--dsw-alias-state-idle-primary); }
.bc-rows { display: flex; flex-direction: column; }
.bc-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }
.bc-row-main { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; min-width: 0; }
.bc-row-title { font-size: 13px; line-height: 1.5; }
.bc-row-key { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.bc-row-ctrl { display: flex; flex: none; flex-direction: column; align-items: flex-end; gap: 4px; }
.bc-row[data-key="agentHighlight"] { margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--dsw-alias-border-l1); }
.bc-switch { position: relative; flex: none; width: 38px; height: 22px; padding: 0; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background .15s, border-color .15s; }
.bc-switch.on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.bc-switch:disabled { opacity: .5; cursor: default; }
.bc-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform .15s; }
.bc-switch.on .bc-knob { transform: translateX(16px); }
.bc-input { width: 220px; max-width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; }
.bc-input-wide { width: 360px; }
.bc-input:hover { border-color: var(--dsw-alias-border-l1); }
.bc-input:disabled { opacity: .5; cursor: default; }
.bc-select { width: 220px; max-width: 100%; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; }
.bc-select:hover { border-color: var(--dsw-alias-border-l1); }
.bc-select:disabled { opacity: .5; cursor: default; }
.bc-button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 1.2; cursor: pointer; }
.bc-button:hover { border-color: var(--dsw-alias-border-l1); }
.bc-button.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.bc-button:disabled { opacity: .5; cursor: default; }
.bc-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.bc-note { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.bc-banner { font-size: 12px; line-height: 1.5; padding: 8px 10px; border-radius: 8px; }
.bc-banner.ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); color: var(--dsw-alias-state-success-primary); }
.bc-banner.err { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
`;

    /**
     * 分组名上限，与宿主同一层同一个数（`src/settings-routes.ts` 的 `TAB_GROUP_TITLE_MAX`）。
     * 这里也切一次只是为了让输入框别让人白打 40 个字以上——真值以宿主校验为准。
     */
    const TAB_GROUP_TITLE_MAX = 40;
    /** 分组名的契约默认值：用户没配过时 status 里也是它。 */
    const TAB_GROUP_TITLE_FALLBACK = 'DSH';
    /**
     * 浏览器路径的上限，与宿主同一个数（`src/settings-routes.ts` 的 `BROWSER_PATH_MAX`）。
     * 这里也切一次只是为了让输入框别让人白打半屏——真值以宿主校验为准。
     */
    const BROWSER_PATH_MAX = 512;

    /** 发一个 JSON POST；端点回 `{ ok, value | error }`。 */
    async function post(path, body) {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      let payload = null;
      try { payload = await res.json(); } catch { payload = null; }
      if (!payload || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message
          ? payload.error.message
          : `请求失败（HTTP ${res.status}）`;
        throw new Error(message);
      }
      return payload.value;
    }

    /** 轮询链路状态；3 秒既让页面不撒谎，也不至于把宿主敲穿。 */
    function useStatus() {
      const [state, setState] = React.useState({ loading: true, value: null, error: null });
      const refresh = React.useCallback(async () => {
        try {
          const res = await fetch(`${API}/status`, { headers: { accept: 'application/json' } });
          // 先读文本再自己解析：宿主对**没注册过的路径**回的是 404 空体，而 `res.json()`
          // 在空体上抛的是 `Unexpected end of JSON input`——一句只有开发者看得懂、而且
          // 指向完全错误方向的话（它看起来像浏览器/网络坏了，实际是宿主没挂这条路由）。
          // 空体基本只有一个含义：设置页路由没挂上，得说出这句。
          const text = await res.text();
          let payload = null;
          try { payload = text.length === 0 ? null : JSON.parse(text); } catch { payload = null; }
          if (!payload || payload.ok !== true) {
            const message = payload && payload.error && payload.error.message
              ? payload.error.message
              : text.length === 0
                ? `状态端点没有返回内容（HTTP ${res.status}）：设置页的路由没有挂上。到「插件」里把 dsh-browser 关掉再打开即可恢复。`
                : `状态请求失败（HTTP ${res.status}）`;
            throw new Error(message);
          }
          setState({ loading: false, value: payload.value, error: null });
        } catch (error) {
          setState(prev => ({ ...prev, loading: false, error: String((error && error.message) || error) }));
        }
      }, []);
      React.useEffect(() => {
        void refresh();
        const timer = setInterval(() => { void refresh(); }, 3000);
        return () => clearInterval(timer);
      }, [refresh]);
      return { ...state, refresh };
    }

    /**
     * 三个枚举设置的下拉选项。`value` 是落进 profile、发上总线的那个词；`label` 只是人读的
     * 文案，所以改文案永远不会改掉背后的行为。
     */
    const TAB_WINDOW_OPTIONS = [
      { value: 'current', label: '当前窗口新开' },
      { value: 'new', label: '新开独立窗口' },
    ];
    const FOCUS_POLICY_OPTIONS = [
      { value: 'avoid', label: '不抢焦点（默认）' },
      { value: 'auto', label: '允许聚焦' },
    ];
    const USER_TAKEOVER_OPTIONS = [
      { value: 'yield', label: '让出（默认）' },
      { value: 'ignore', label: '忽略接管' },
    ];

    /** 选中值的文案；找不到就退回值本身（profile 被人手改成别的词时别显示空白）。 */
    function labelOf(options, value) {
      const option = options.find(item => item.value === value);
      return option ? option.label : String(value);
    }

    /**
     * 每一个设置的完整解释。它们**不占正文**，只挂在行元素的 `title` 上（hover 才出现）：
     * 这一版的要求是正文只留「标签 + 控件」，说明文字全部退居二线。
     */
    const HINTS = {
      readOnly: '拒绝一切会改变页面或浏览器状态的命令（点击/输入/按键/导航/滚动/标签页/视口/浮层），只留读页面与读日志。',
      allowScript: '关闭后 browser_evaluate 与 browser_cdp 都会被拒绝（两者都能在页面里执行任意脚本），点击与读取不受影响。',
      lazyToolDocs: '默认关。打开后每轮请求只出现一个 browser_tools：先调它装载要用的工具（可给工具名、分组名，或 "*" 全装），装上的工具立刻是它完整描述与完整参数，跟关着的时候一模一样。装载只作用于当前会话：别的会话（含新开的）仍然只有装载器，各自装载互不影响，会话结束时装上的工具随之消失。省下的是每轮固定那两万字符的工具块；关着就是全部工具一步到位，不需要先装载。',
      allowRawCdp: '注册 browser_cdp（任意 Domain.method 透传）；关闭后这个工具不出现。安全边界仍然是只读档与脚本开关。',
      allowIncognito: '默认关。打开后模型才能用 browser_profile 开无痕罐；还需要去浏览器扩展管理页打开本扩展的「在无痕 / InPrivate 中允许」——那是浏览器那层的权限，本页改不了。',
      agentHighlight: 'AI 正在操作的那一页会带一圈蓝色渐变框，你接管时变琥珀色；它不拦任何操作，也挡不住任何命令。关掉后只剩命令结果，页面上没有视觉提示。随每条命令下发，改完下一条命令就生效。',
      tabWindow: 'browser_tabs action=open 不带 windowId 时落在哪儿：当前窗口新开会归进 AI 分组，独立窗口不抢焦点、也不打断你。',
      tabGroupTitle: 'AI 开的标签页归进这个 Chrome 标签组。扩展按组记（不是按名字），所以改名字等于换一个新组；你自己那个同名组不会被合并，也不会被当成 AI 的。留空 = 不分组。',
      focusPolicy: '不抢焦点时不会调用 windows.update({focused:true})：真实键鼠走 CDP，本来就不需要窗口在前台。允许聚焦会先把窗口抬到前台。',
      userTakeover: '让出：你在 AI 正在操作的标签页上真的点了一下或敲了键盘之后，它在那页的点击/输入/按键/导航/滚动会被拒绝，并告诉模型怎么继续。只是切过去看、滚一下页面不算——切走或让它重新接管（activate）就恢复。忽略接管则不拦。',
      browserPath: 'browser_launch 启动浏览器时用的可执行文件。留空 = 自动找（已知安装位置 → PATH → 目录搜索兜底），一般不用填。只有便携版、非默认路径、或自动查找在你机器上失败时才需要填完整路径。注意：填了就用它，填错会如实报错，不会悄悄换成另一个浏览器。',
    };

    /**
     * 布尔设置的取值：host 没下发这个字段时用契约默认值，别把「没有这个字段」显示成「关闭」。
     * @param config - `/status` 里的 config（可能还没加载）。
     * @param key - 字段名。
     * @param fallback - schema 默认值。
     */
    function boolOf(config, key, fallback) {
      if (!config) return fallback;
      return config[key] === undefined ? fallback : config[key] === true;
    }

    /** 分组名归一：压平空白、trim、限长；空串是有含义的（= 不分组），不能兜底成默认值。 */
    function normalizeTitle(raw) {
      return String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, TAB_GROUP_TITLE_MAX);
    }

    /* ------------------------------------------------------------------ *
     * 输入框的 `@` 引用源：列出用户自己打开的浏览器标签页
     * ------------------------------------------------------------------ */

    /**
     * 源的名字。**必须与宿主内置的两条 `@` 源不同**（`reference` / `ui-skill`）：
     * `registerSource` 用的是同一张注册表，撞名会直接抛
     * `slash source "@browser-tabs" is already registered`，那条错误会把整个输入框的
     * 菜单一起带坏，而不只是我们自己这一组。
     */
    const TAB_REFERENCE_SOURCE = 'browser-tabs';
    /** 候选的小节标题。每条候选都给同一个串，宿主才把它们收拢到一组里。 */
    const TAB_REFERENCE_SECTION = '浏览器标签页';
    /** 菜单一行能显示多长：标题 60、描述 60。再长就会被宿主截断，不如我们自己切。 */
    const TAB_NAME_MAX = 60;
    const TAB_DESCRIPTION_MAX = 60;
    /** 插进消息的 chip 上的文字上限（比候选短一档：chip 在正文里很窄）。 */
    const TAB_LABEL_MAX = 48;

    /**
     * 引用在**正文里**的文本形态。`serialize` 与 `clipboardText` 共用这一个函数，
     * 不许各写一套——它们是同一句话的两个出口（一个进消息、一个进剪贴板）。
     *
     * **绝不以 `@` 开头**，这条是硬约束：宿主注入的系统提示段（`FILE_REFERENCE_PROMPT`）
     * 原话是「Tokens prefixed with `@` are paths the user explicitly referenced …… Anything
     * else is a file: use the read tool when its contents are needed」。也就是说任何以 `@`
     * 开头的非空白 token，模型都会被明确指示「那是一个文件路径，去 read 它」——我们的
     * `@browser-tab https://…` 恰好落在那个语法里，模型极可能去 `read("browser-tab")`
     * 拿一个 ENOENT，然后才反应过来。所以这里用一个自述式的中文短语开头，模型一眼就
     * 知道这是浏览器标签页而不是文件。
     *
     * 剪贴板同样用这一串：用户把正文复制回输入框时，以 `@` 开头的那半句会被编辑器当成
     * 文件 chip，指向一个名叫 browser-tab 的路径——同一个坑从另一边进来。
     * @param url - 完整 URL（必须完整可点，它是模型唯一能直接使用的东西）。
     * @param title - 页面标题；空白时省略括号。
     */
    function referenceTextOf(url, title) {
      const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
      return clean.length === 0 ? `浏览器标签页 ${url}` : `浏览器标签页「${clean}」 ${url}`;
    }

    /** 截断到 `max` 个字符，加省略号。 */
    function clip(text, max) {
      const value = String(text ?? '');
      return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + '…';
    }

    /**
     * `host + pathname`：菜单里那一行描述。query 与 hash 都丢掉——它们往往又长又
     * 带一堆参数，挤掉真正能区分两个页面的那半句。
     */
    function hostPathOf(url) {
      try {
        const parsed = new URL(String(url));
        return `${parsed.host}${parsed.pathname}`;
      } catch {
        return String(url ?? '');
      }
    }

    /**
     * 菜单每敲一个键都会调用一次 `candidates`，而每次都打一次 HTTP。宿主侧有两秒缓存
     * 兜住大半，这里不额外做防抖：宿主缓存已经吸收掉连击，再加一层只会让「刚开的页」
     * 更晚出现。
     */
    async function fetchReferenceTabs(signal) {
      const res = await fetch(`${API}/tabs`, { headers: { accept: 'application/json' }, signal });
      // 先读文本再自己解析：宿主对**没注册过的路径**回的是 404 空体，`res.json()` 会抛
      // 一句 `Unexpected end of JSON input`——它看起来像网络坏了，实际是路由没挂上。
      const text = await res.text();
      let payload = null;
      try { payload = text.length === 0 ? null : JSON.parse(text); } catch { payload = null; }
      if (!payload || payload.ok !== true) {
        const reason = payload && payload.error && payload.error.message
          ? String(payload.error.message)
          : `HTTP ${res.status}`;
        throw new Error(reason);
      }
      return payload.value || {};
    }

    /**
     * 链路不通时给的那一条候选。
     *
     * 菜单空着和菜单坏掉在用户眼里没有区别，都是「`@` 里没有我的标签页」。给一条说明
     * 至少能把「浏览器没连上」和「确实没有可列的页」分开。点它没有副作用（`onPick`
     * 直接返回 `'handled'`），文案里必须写明这一点，否则用户会以为点坏了什么。
     */
    function unavailableCandidate() {
      return {
        name: '浏览器未连接（点这里没有作用）',
        description: '在「设置 → 浏览器控制」查看链路状态',
        section: TAB_REFERENCE_SECTION,
        value: JSON.stringify({ unavailable: true }),
      };
    }

    /**
     * `@browser-tabs` 源。
     *
     * `order: 20` 把我们的组排在内置 `reference` / `ui-skill` 之后（它们没有 order，
     * 即 0）：用户按 `@` 时第一组仍然是宿主自带的文件引用，这符合原来的肌肉记忆。
     * `showGroupTitle: false` 是因为我们自己给每条候选带了 `section`——让宿主按
     * section 分组，比在组标题里再写一遍「浏览器标签页」更省一行。
     */
    const tabReferenceSource = {
      trigger: '@',
      name: TAB_REFERENCE_SOURCE,
      order: 20,
      showGroupTitle: false,

      async candidates(_session, request) {
        const signal = request && request.signal;
        // 已经取消的请求不必再打一次网络：连打几个字母时宿主会撤掉前几次调用。
        if (signal && signal.aborted) return [];
        const query = String((request && request.query) || '').trim().toLowerCase();
        let value;
        try {
          value = await fetchReferenceTabs(signal);
        } catch (error) {
          // 用户主动取消不是失败：返回空，别在菜单里塞一条「未连接」的假警报。
          if (signal && signal.aborted) return [];
          return [unavailableCandidate()];
        }
        const tabs = Array.isArray(value.tabs) ? value.tabs : [];
        const rows = tabs
          .filter(tab => {
            if (!query) return true;
            const title = String((tab && tab.title) || '').toLowerCase();
            const url = String((tab && tab.url) || '').toLowerCase();
            return title.includes(query) || url.includes(query);
          })
          .map(tab => ({
            name: clip(tab && tab.title, TAB_NAME_MAX),
            description: clip(hostPathOf(tab && tab.url), TAB_DESCRIPTION_MAX),
            section: TAB_REFERENCE_SECTION,
            // 私有载荷：只有 codec 与 openReference 读它，宿主不解释里面的字段。
            value: JSON.stringify({
              tabId: tab && tab.id,
              url: String((tab && tab.url) || ''),
              title: String((tab && tab.title) || ''),
            }),
          }));
        // 取到了、但过滤后一页都没有 → 空数组。这里**不**塞提示候选：用户的浏览器确实
        // 没开着可列的页，编一条提示只会让他以为链路坏了。
        return rows;
      },

      onPick({ candidate }) {
        let payload;
        try {
          payload = JSON.parse(String(candidate && candidate.value));
        } catch {
          return 'handled';
        }
        // 提示候选：菜单关掉就好，别往消息里插一段说明文字。
        if (!payload || payload.unavailable === true) return 'handled';
        const ref = JSON.stringify({
          tabId: payload.tabId,
          url: payload.url,
          title: payload.title,
        });
        return {
          insert: {
            source: TAB_REFERENCE_SOURCE,
            ref,
            label: clip(payload.title || hostPathOf(payload.url), TAB_LABEL_MAX),
            // 与 codec.serialize 同一串（理由见 referenceTextOf）：正文与剪贴板不许有两套口径。
            clipboardText: referenceTextOf(payload.url || '', payload.title),
            // 刻意**不传** `appearance`：它只接受 session/file/folder，给 `file` 会让
            // chip 渲染成「可点击打开本地文件」，而我们的引用指向的是一个浏览器标签页。
            // 缺省时宿主渲染一个普普通通的 `@` 标记，那才是诚实的。
          },
        };
      },

      /**
       * 点 chip 时把那一页叫到前台。
       *
       * 不 await、不抛：这是一次**顺手的**副作用（用户点引用只是想回去看那一页），
       * 失败了不该弹任何东西，更不该挡住 chip 的其他行为。`tabs.activate` 会经过宿主
       * 的策略闸门，所以只读档下它会被拒——那也是静默的，符合「点一下没反应」的预期。
       */
      openReference(_session, { ref }) {
        let payload;
        try {
          payload = JSON.parse(String(ref));
        } catch {
          return false;
        }
        const tabId = payload && payload.tabId;
        if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId <= 0) return false;
        try {
          void post(`${API}/tabs/activate`, { tabId }).catch(() => {});
        } catch {
          // post 是 async 函数，同步段不抛；这里只兜底「fetch 本身不存在」这种环境问题。
        }
        return true;
      },

      codec: {
        /**
         * 复制 quote 时进剪贴板的文字：与 `serialize` 同一串（见 `referenceTextOf`）。
         * 解析失败就把 ref 原样吐回，别抛。
         */
        clipboardText(ref) {
          try {
            const payload = JSON.parse(String(ref));
            const url = String((payload && payload.url) || '');
            if (url.length === 0) return String(ref);
            return referenceTextOf(url, payload.title);
          } catch {
            return String(ref);
          }
        },
        /**
         * **模型看到的东西**。
         *
         * 宿主发送时把每个引用的 `serialize()` 返回值原样拼进用户消息正文，所以这里
         * 返回什么，模型就读到什么——既要短，也要让模型一眼看出「这是一个真实的网页
         * URL」。标题是给人读的补充信息，没有就不写，别留一个空括号。
         *
         * **开头不能是 `@`**（理由见 `referenceTextOf`）：那会落进宿主的文件引用语法，
         * 模型会被指示去 `read` 一个名叫 browser-tab 的路径。
         */
        serialize(ref) {
          let payload;
          try {
            payload = JSON.parse(String(ref));
          } catch {
            // 解析不了就把 ref 原样交回去：至少模型还能看到那串东西，而不是一片空白。
            return Promise.resolve(String(ref));
          }
          const url = String((payload && payload.url) || '');
          if (url.length === 0) return Promise.resolve(String(ref));
          return Promise.resolve(referenceTextOf(url, payload.title));
        },
      },
    };

    function Switch({ checked, busy, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked ? 'true' : 'false',
        className: 'bc-switch' + (checked ? ' on' : ''),
        disabled: busy,
        onClick: () => { if (!busy) onChange(!checked); },
      }, h('span', { className: 'bc-knob' }));
    }

    /**
     * 一行设置：左边「中文标题 + 字段名」，右边控件。
     * `data-key` 同时给样式（AI 高亮那一行要和闸门分开）和验台用。
     */
    function Row({ configKey, title, hint, control }) {
      return h('div', { className: 'bc-row', 'data-key': configKey, title: hint || undefined },
        h('div', { className: 'bc-row-main' },
          h('span', { className: 'bc-row-title' }, title),
          h('span', { className: 'bc-row-key' }, configKey)),
        h('div', { className: 'bc-row-ctrl' }, control));
    }

    function ToggleRow({ configKey, title, hint, checked, busy, onChange }) {
      return h(Row, {
        configKey,
        title,
        hint,
        control: h(Switch, { checked: checked === true, busy, onChange }),
      });
    }

    function SelectRow({ configKey, title, hint, value, options, busy, onChange }) {
      return h(Row, {
        configKey,
        title,
        hint,
        control: h('select', {
          className: 'bc-select',
          'aria-label': title,
          value,
          disabled: busy,
          onChange: event => { if (!busy) onChange(event.target.value); },
        }, options.map(option => h('option', { key: option.value, value: option.value }, option.label))),
      });
    }

    /** 链路状态里的一格：小号标签在上、值在下，tone 只染颜色、不进正文。 */
    function StatusItem({ label, tone, wide, children }) {
      return h('div', { className: 'bc-status-row' + (wide ? ' wide' : '') },
        h('span', { className: 'bc-status-label' }, label),
        h('span', { className: 'bc-status-value' + (tone ? ' ' + tone : '') }, children));
    }

    function BrowserControlPage() {
      const status = useStatus();
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState(null);
      /** 分组名的本地草稿；`null` 表示「跟着服务端走」（没在编辑）。 */
      const [titleDraft, setTitleDraft] = React.useState(null);
      /** 浏览器路径的本地草稿，语义同上。 */
      const [pathDraft, setPathDraft] = React.useState(null);

      const value = status.value || {};
      const bridge = value.bridge || {};
      const config = value.config || null;
      const extension = bridge.extension || null;

      /**
       * 写一个可编辑字段，然后刷新状态。布尔开关、枚举下拉与分组名共用这条路径：差别只在成功
       * 文案（开关说「已开启/关闭」，下拉说「已改为某个值」），所以文案由调用方给，别在这里
       * 猜字段的类型。请求体永远是 `{ patch: { [字段]: 值 } }`。
       * @returns 写入是否成功（失败时页面已经给出错误提示条）。
       */
      const patch = async (key, doneText, next) => {
        setBusy(key);
        setMessage(null);
        try {
          await post(`${API}/config`, { patch: { [key]: next } });
          setMessage({ tone: 'ok', text: `${doneText}，已写入 profile 覆盖层。` });
          await status.refresh();
          return true;
        } catch (error) {
          setMessage({ tone: 'err', text: String((error && error.message) || error) });
          return false;
        } finally {
          setBusy('');
        }
      };

      /** 服务端当前的分组名（没有配置时用契约默认值）。 */
      const serverTitle = config && typeof config.tabGroupTitle === 'string'
        ? config.tabGroupTitle
        : TAB_GROUP_TITLE_FALLBACK;
      const titleValue = titleDraft === null ? serverTitle : titleDraft;

      /**
       * 分组名只在**失焦或回车**时提交一次。逐字提交会把每次敲键都变成一次 profile 写入，
       * 而 profile 覆盖层写一次就会重载插件、重连扩展。写失败时草稿留着，用户不用重打。
       */
      const commitTitle = () => {
        const next = normalizeTitle(titleValue);
        if (next === normalizeTitle(serverTitle)) { setTitleDraft(null); return; }
        void patch('tabGroupTitle',
          next === '' ? '分组名已清空（不分组）' : `分组名已改为「${next}」`, next)
          .then(ok => { if (ok) setTitleDraft(null); });
      };

      /**
       * 浏览器路径：与分组名同一套提交节奏（失焦/回车各一次），但**不做任何归一**——
       * 路径里的空格、反斜杠、`Program Files` 那个空格全都是路径的一部分，压平或
       * 改大小写都会把它改坏。只去首尾空白，留空 = 自动查找。
       */
      const serverPath = config && typeof config.browserPath === 'string' ? config.browserPath : '';
      const pathValue = pathDraft === null ? serverPath : pathDraft;
      const commitPath = () => {
        const next = String(pathValue ?? '').trim();
        if (next === serverPath.trim()) { setPathDraft(null); return; }
        void patch('browserPath',
          next === '' ? '浏览器路径已清空（自动查找）' : `浏览器路径已改为「${next}」`, next)
          .then(ok => { if (ok) setPathDraft(null); });
      };

      const runAction = async (action, key) => {
        setBusy(key);
        setMessage(null);
        try {
          if (action === 'openStatus' || action === 'open-status') {
            const result = await post(`${API}/action`, { action: 'openStatus' });
            window.open(result.url, '_blank', 'noopener');
            setMessage({ tone: 'ok', text: `已打开状态页 ${result.url}` });
          } else if (action === 'cleanup') {
            const result = await post(`${API}/action`, { action: 'cleanup' });
            setMessage({
              tone: 'ok',
              text: `已清理 ${result.shotsRemoved} 张截图、${result.scratchRemoved.length} 个临时文件。`,
            });
          } else {
            await status.refresh();
            setMessage({ tone: 'ok', text: '已刷新。' });
          }
        } catch (error) {
          setMessage({ tone: 'err', text: String((error && error.message) || error) });
        } finally {
          setBusy('');
        }
      };

      const bridgeState = config === null && bridge.configured === false
        ? '尚未加载配置'
        : (config && config.enabled === false ? '已停用（enabled: false）'
          : (bridge.listening ? `监听中 127.0.0.1:${config ? config.port : '?'}` : '未监听'));
      const bridgeTone = bridge.listening ? 'ok' : 'idle';

      const extensionText = extension && extension.connected
        ? `${(extension.hello && extension.hello.name) || '浏览器'} ${(extension.hello && extension.hello.version) || ''}`.trim()
        : '未连接';
      const protocolText = extension && extension.connected
        ? `v${extension.protocol}${extension.compatible === false ? '（不兼容：' + String(extension.note || '') + '）' : ''}`
        : '—';

      /**
       * 浏览器那层的无痕权限（`chrome.extension.isAllowedIncognitoAccess()`，扩展在握手的
       * hello 里报上来）。它和本页的 allowIncognito 是**两道**授权：本页开、浏览器那层没开，
       * 模型照样开不出隔离实例。缺失（没连上 / 宿主没转发这个字段）时只能显示「—」，不要猜成
       * 「未允许」——那会让用户去翻一个可能本来就开着的开关。
       */
      const incognitoAllowed = extension && extension.hello ? extension.hello.incognitoAllowed : undefined;
      const incognitoText = incognitoAllowed === true
        ? '已允许'
        : (incognitoAllowed === false ? '未允许（模型开不了隔离实例）' : '—');
      const incognitoTone = incognitoAllowed === true ? 'ok' : (incognitoAllowed === false ? 'warn' : '');

      return h('div', { className: 'bc-page' },
        h('style', null, CSS),

        // 页头：标题 + 三个动作。原来的长句副标题删掉了，页面靠标题层级说话。
        h('div', { className: 'bc-head' },
          h('div', { className: 'bc-title' }, '浏览器控制'),
          h('div', { className: 'bc-toolbar' },
            h('button', {
              type: 'button', className: 'bc-button', disabled: busy !== '',
              title: '在浏览器里打开扩展的完整状态页（握手信息与清理入口都在那儿）',
              onClick: () => runAction('openStatus', 'openStatus'),
            }, '打开状态页'),
            h('button', {
              type: 'button', className: 'bc-button', disabled: busy !== '',
              title: '删除本插件生成的截图与临时文件（shots/ 与 scratch/）',
              onClick: () => runAction('cleanup', 'cleanup'),
            }, '清理截图与临时文件'),
            h('button', {
              type: 'button', className: 'bc-button primary', disabled: busy !== '',
              title: '本页每 3 秒自动刷新一次；点这里立刻取一次最新状态',
              onClick: () => runAction('refresh', 'refresh'),
            }, busy === 'refresh' ? '刷新中…' : '刷新状态'))),

        status.error !== null && h('div', { className: 'bc-banner err' }, status.error),
        message !== null && h('div', { className: 'bc-banner ' + message.tone }, message.text),

        // 状态：一格一值的小网格，一屏就能扫完，不再是一串大间距列表。
        h('section', { className: 'bc-card' },
          h('div', { className: 'bc-card-title' }, '链路状态'),
          h('div', { className: 'bc-status' },
            h(StatusItem, { label: '桥接', tone: bridgeTone }, bridgeState),
            h(StatusItem, { label: '扩展', tone: extension && extension.connected ? 'ok' : 'err' },
              extensionText),
            h(StatusItem, { label: '协议' }, protocolText),
            h(StatusItem, {
              label: '无痕权限',
              ...(incognitoTone ? { tone: incognitoTone } : {}),
            }, incognitoText),
            h(StatusItem, {
              label: 'Token',
              ...(config && bridge.insecureToken ? { tone: 'warn' } : {}),
            }, config && config.tokenMasked !== null ? config.tokenMasked : '—'),
            h(StatusItem, { label: '待处理命令' }, String(bridge.pendingCommands ?? 0)),
            (bridge.lastError !== undefined && bridge.lastError !== null)
              && h(StatusItem, { label: '最近错误', tone: 'err', wide: true }, String(bridge.lastError)))),

        // 权限与行为：五个闸门 + AI 高亮。每行的解释都在 title 上，正文里没有。
        h('section', { className: 'bc-card' },
          h('div', { className: 'bc-card-title' }, '权限与行为'),
          h('div', { className: 'bc-rows' },
            h(ToggleRow, {
              configKey: 'readOnly', title: '只读档', hint: HINTS.readOnly,
              checked: boolOf(config, 'readOnly', false),
              busy: busy === 'readOnly',
              onChange: next => patch('readOnly', `只读档已${next ? '开启' : '关闭'}`, next),
            }),
            h(ToggleRow, {
              configKey: 'allowScript', title: '脚本执行', hint: HINTS.allowScript,
              checked: boolOf(config, 'allowScript', true),
              busy: busy === 'allowScript',
              onChange: next => patch('allowScript', `脚本执行已${next ? '开启' : '关闭'}`, next),
            }),
            h(ToggleRow, {
              configKey: 'lazyToolDocs', title: '工具懒加载', hint: HINTS.lazyToolDocs,
              checked: boolOf(config, 'lazyToolDocs', false),
              busy: busy === 'lazyToolDocs',
              onChange: next => patch('lazyToolDocs', `工具懒加载已${next ? '开启' : '关闭'}`, next),
            }),
            h(ToggleRow, {
              configKey: 'allowRawCdp', title: '原生 CDP', hint: HINTS.allowRawCdp,
              checked: boolOf(config, 'allowRawCdp', true),
              busy: busy === 'allowRawCdp',
              onChange: next => patch('allowRawCdp', `原生 CDP 已${next ? '开启' : '关闭'}`, next),
            }),
            h(ToggleRow, {
              configKey: 'allowIncognito', title: '隔离实例', hint: HINTS.allowIncognito,
              checked: boolOf(config, 'allowIncognito', false),
              busy: busy === 'allowIncognito',
              onChange: next => patch('allowIncognito', `隔离实例已${next ? '开启' : '关闭'}`, next),
            }),
            h(ToggleRow, {
              configKey: 'agentHighlight', title: 'AI 高亮', hint: HINTS.agentHighlight,
              checked: boolOf(config, 'agentHighlight', true),
              busy: busy === 'agentHighlight',
              onChange: next => patch('agentHighlight', `AI 高亮已${next ? '开启' : '关闭'}`, next),
            })),
          // 正文里唯一保留的一条说明：它是安全事实，而且本页确实没有入口。
          h('div', { className: 'bc-note' }, '锁定只能在扩展弹窗里开关，本页没有解锁入口。')),

        // 标签与接管：枚举 + 自由文本（分组名）。
        h('section', { className: 'bc-card' },
          h('div', { className: 'bc-card-title' }, '标签与接管'),
          h('div', { className: 'bc-rows' },
            h(SelectRow, {
              configKey: 'tabWindow', title: '标签页打开位置', hint: HINTS.tabWindow,
              value: config ? config.tabWindow : 'current',
              options: TAB_WINDOW_OPTIONS,
              busy: busy === 'tabWindow',
              onChange: next => patch('tabWindow',
                `标签页打开位置已改为「${labelOf(TAB_WINDOW_OPTIONS, next)}」`, next),
            }),
            h(Row, {
              configKey: 'tabGroupTitle',
              title: '分组名',
              hint: HINTS.tabGroupTitle,
              control: [
                h('input', {
                  key: 'field',
                  className: 'bc-input',
                  type: 'text',
                  'aria-label': '分组名',
                  value: titleValue,
                  placeholder: '不分组',
                  maxLength: TAB_GROUP_TITLE_MAX,
                  disabled: busy === 'tabGroupTitle',
                  onChange: event => setTitleDraft(event.target.value),
                  onBlur: () => commitTitle(),
                  onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur(); },
                }),
                h('span', { key: 'hint', className: 'bc-hint' }, '留空 = 不分组'),
              ],
            }),
            h(Row, {
              configKey: 'browserPath',
              title: '浏览器路径',
              hint: HINTS.browserPath,
              control: [
                h('input', {
                  key: 'field',
                  className: 'bc-input bc-input-wide',
                  type: 'text',
                  'aria-label': '浏览器路径',
                  value: pathValue,
                  placeholder: '留空 = 自动查找',
                  maxLength: BROWSER_PATH_MAX,
                  spellCheck: false,
                  disabled: busy === 'browserPath',
                  onChange: event => setPathDraft(event.target.value),
                  onBlur: () => commitPath(),
                  onKeyDown: event => { if (event.key === 'Enter') event.currentTarget.blur(); },
                }),
                h('span', { key: 'hint', className: 'bc-hint' }, '留空 = 自动查找'),
              ],
            }),
            h(SelectRow, {
              configKey: 'focusPolicy', title: '聚焦策略', hint: HINTS.focusPolicy,
              value: config ? config.focusPolicy : 'avoid',
              options: FOCUS_POLICY_OPTIONS,
              busy: busy === 'focusPolicy',
              onChange: next => patch('focusPolicy',
                `聚焦策略已改为「${labelOf(FOCUS_POLICY_OPTIONS, next)}」`, next),
            }),
            h(SelectRow, {
              configKey: 'userTakeover', title: '用户接管', hint: HINTS.userTakeover,
              value: config ? config.userTakeover : 'yield',
              options: USER_TAKEOVER_OPTIONS,
              busy: busy === 'userTakeover',
              onChange: next => patch('userTakeover',
                `用户接管策略已改为「${labelOf(USER_TAKEOVER_OPTIONS, next)}」`, next),
            }))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'browser-control',
          order: 17,
          label: () => '浏览器控制',
        }, BrowserControlPage));

        // `@` 源：**声明式等待** `inputTriggers`，与宿主 `mountSettingsRoute` 同一个模式。
        //
        // 刻意不把它写进模块顶层的 `inject` 数组：那个数组是硬依赖，服务缺失时整个模块
        // 都不激活——设置页会跟着一起消失。`@` 菜单只是锦上添花，它没条件不该连累设置页。
        //
        // `inner.get()` 在没有 inject 的 ctx 上是**直接抛**（不是返回 undefined），所以
        // 读取必须包 try；`inner.get` 也可能根本不存在（手工拼的 ctx，见验台），回退读属性。
        if (typeof ctx.inject !== 'function') return;
        ctx.inject(['inputTriggers'], inner => {
          let inputTriggers;
          try {
            inputTriggers = inner && typeof inner.get === 'function'
              ? inner.get('inputTriggers')
              : (inner && inner.inputTriggers);
          } catch {
            inputTriggers = inner && inner.inputTriggers;
          }
          if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') return;
          // 处置挂在**拿服务的那个 scope** 上：`inputTriggers` 被换掉/卸载时旧源跟着摘掉，
          // 不留一个指向旧注册表的僵尸源。inner 不是真 ctx 时退回插件自己的 ctx——
          // 与宿主 `mountSettingsRoute` 对 `scope.effect` 的能力判断同一套写法。
          const effect = inner && typeof inner.effect === 'function'
            ? inner.effect.bind(inner)
            : (ctx && typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : null);
          if (effect === null) return;
          effect(() => inputTriggers.registerSource(tabReferenceSource),
            'dsh-browser: @ browser-tabs source');
        });
      },
    };
  },
});
