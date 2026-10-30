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
      },
    };
  },
});
