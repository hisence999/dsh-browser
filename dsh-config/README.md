# dsh 配置参考

安装方式见 [README](../README.md)。本文只说明插件的配置项含义，供需要自定义默认值的用户参考。

## 安装提示
官方源与镜像可能不一致：安装若报 `ERR_PNPM_NO_MATCHING_VERSION`，一般是**镜像还没同步**（`dsh plugin add` 会把依赖钉成确切版本号，而 pnpm 用的是你配置的源，国内默认常常是 `registry.npmmirror.com`），不是包出了问题。三条解法见 [README 的安装一节](../README.md#方式-a从-npm-安装推荐)。

## cordis.patch.yml 字段

插件包根目录的 `cordis.patch.yml` 声明默认配置：

```yaml
- insert:
    - id: browser-bridge
      name: 'dsh-browser'
      config:
        enabled: true
        port: 9777
        token: dsh-local
```

| 字段 | 默认值 | 说明 |
|---|---|---|
| `id` | `browser-bridge` | 插件实例 ID，勿改 |
| `name` | `dsh-browser` | 包名，即 Loader 的解析目标 |
| `config.enabled` | `true` | 默认开启，装好即监听（v1.0.6+）。这里写 `false` 会覆盖 schema 默认值，导致 9777 无监听（issue #4）；想关掉请用下面「覆盖默认值」里的 `merge` 写法 |
| `config.port` | `9777` | 本地桥接服务端口（127.0.0.1，仅监听回环） |
| `config.token` | `dsh-local` | 扩展与桥接的握手令牌；多用户环境建议改掉 |
| `config.readOnly` | `false` | 只读档：开启后拒绝一切会改变页面或浏览器状态的命令（点击/输入/按键/导航/滚动/标签页操作/视口模拟/弹窗策略/清缓冲），只留读页面与读日志。见下「两个闸门」 |
| `config.allowScript` | `true` | 是否允许 `browser_evaluate` 在页面里执行任意脚本。关掉它仍然可以点击和读页面 —— 单开只读档**不等于**拿掉了任意脚本能力（eval 能做其它工具能做的所有事）。它同时约束 `browser_cdp`：原生 CDP 能走到 `Runtime.evaluate`，只关 eval 等于没关 |
| `config.lazyToolDocs` | `false` | 工具懒启动：默认全开（23 个工具全部注册给模型）；打开后只为模型保留一个 `browser_tools` 装载器，由它按需把工具装进来（给工具名、分组名或 `"*"`）。装上的工具拿到的就是它**完整的描述与完整参数 schema**，与全开时逐字节相同——省的是每轮固定的工具块体积，不是安全边界 |
| `config.allowRawCdp` | `true` | 是否注册 `browser_cdp`（原生 CDP `Domain.method` 透传）。默认开；关掉后该工具不出现在模型工具面里。仍然受 `readOnly` / `allowScript` 约束 |
| `config.tabWindow` | `current` | 第 4 项（v1.1.2+）：`browser_tabs open` 的落点。`current` = 用户当前窗口里开一个 `DSH` 分组标签（Chrome 原生语义）；`new` = `windows.create({focused: false})` 新开一个自己的窗口，**不抢焦点** |
| `config.focusPolicy` | `avoid` | 第 4 项：`avoid` **绝不** `windows.update({focused:true})`（CDP 输入不需要 OS 焦点，不抬窗口也能点能打）；`auto` 是 v1.1.1 及以前的行为。两种都在最小化窗口上报 `window_minimized` |
| `config.userTakeover` | `yield` | 第 4 项：用户在 AI 的标签页上**真的动手**（v1.1.5 起只认 `isTrusted` 的点击/输入/按键/粘贴；切标签页、切窗口、打开扩展弹窗、滚动都不算）时，AI 在那页上的写操作被拒（`yielded_to_user`、零副作用）；四条解除路径：用户在别的标签页动手 / 用户切到自己的标签页 / 所有窗口失焦 / `tabs.activate` 显式要回来。`ignore` 关掉这条 |
| `config.allowIncognito` | `false` | 第 3 项（v1.1.3+）：允许开**隔离实例**（无痕窗口，独立 cookie 罐、退出即清）。默认关——它会在用户屏幕上开一个窗口，还能绕开用户真实会话，所以要显式打开；而且**还需要**在浏览器扩展管理页允许本扩展在无痕/InPrivate 中运行（浏览器那层的权限，插件翻不动）。`profile.close` 与 `profile.status` 不受它约束 |
| `config.tabGroupTitle` | `DSH` | 第 1 项（v1.1.4+）：AI 新建标签组时用的名字。扩展按 **Chrome 的 `groupId`** 认自己的组（记在 session 里），不是按标题——**同名不会合并**，也不会动用户自己的同名组（他那组里的标签页照旧不算 AI 的，`tabs.close` 要 `force`、`tabs.ungroup` 不拆它）。改名字 = 之后新建的组用新名字，已经建好的老组按 id 仍是 AI 的。**空串 = 不分组**，所以不能用 `\|\|` 兜底；压平空白、最长 40 字符。`browser_tabs` 的 `groupTitle` 参数可按次覆盖 |
| `config.agentHighlight` | `true` | 第 2 项（v1.1.4+）：AI 正在操作的那一页画不画一圈蓝色渐变高亮（`pointer-events: none` 的纯装饰层，用户接管时变琥珀色，截图与打印 PDF 期间临时隐藏）。它**不是安全边界**，也不拦任何命令；真要冻结浏览器仍是扩展弹窗里的本地硬锁 |

## 设置页里的「浏览器控制」（v1.1.1+）

dsh 0.1.7+ / 0.2.x 的「设置」里会多出一页**浏览器控制**（插件自带的 Client 半边注册在 `settings.section`，不是宿主按 schema 投影的卡片）：

- 看链路状态（端口、扩展版本、协议、待处理命令、最近错误、Token 掩码）与四个闸门的当前值；
- 四个开关（`readOnly` / `allowScript` / `lazyToolDocs` / `allowRawCdp`）直接写入 profile 覆盖层，宿主随后重新加载插件；`lazyToolDocs` 与 `allowRawCdp` 改的是**工具面**，所以生效点在下一个会话/请求（装载器与已装载的工具会跟着重算）；
- 「默认目标与接管」卡片里三个受控下拉（`tabWindow` / `focusPolicy` / `userTakeover`，v1.1.2+），写入路径同上；
- 「闸门」卡片里另有 `allowIncognito` 开关（v1.1.3+），链路状态里还有一行「无痕权限」读的是扩展握手的真实值；
- 「权限与行为」卡片里另有 `agentHighlight` 开关（v1.1.4+，默认开）；「标签与接管」卡片里多一个**分组名**文本框（`tabGroupTitle`，v1.1.4+，失焦或回车才提交一次，留空 = 不分组）；
- 清理截图与临时文件、打开 9777 状态页（两个按钮在页头）。

页面走宿主 Web 服务器的同源 JSON 面 `/browser-control/api`，带与官方 `/api` 一致的信任栅栏（Host 回环/本监听地址、拒绝 cross-site、Origin 同源），不直接连桥的端口。旧宿主没有 `settings.section` 时这一页不出现，本文件的配置写法仍然有效。

## 覆盖默认值

不想改包内文件的话，在你的 profile 覆盖层（`$DSH_HOME/profiles/<名字>/cordis.patch.yml`，它作用在 bundle 层之后）里按 `id` 覆盖 `browser-bridge` 的 config 即可。把要用的字段写全，例如改端口、或者干脆关掉：

```yaml
- id: browser-bridge
  name: 'dsh-browser'
  config:
    enabled: false
    port: 8888
    token: dsh-local
```

> dsh 生成的 profile 覆盖层就是「每个条目带一份完整 config」这种写法，照它写最稳妥；
> 写不全时未列出的字段走哪一层并未在文档里保证，别依赖。

## 两个闸门

```yaml
- id: browser-bridge
  name: 'dsh-browser'
  config:
    readOnly: true      # 只读档：只允许读页面/读日志
    allowScript: false  # 顺便把 browser_evaluate 关掉
```

- 被拦的命令**不会发到浏览器**：插件在把命令交给扩展之前就拒绝，副作用为零，错误码是
  `blocked_by_policy`（`effectState=not_started`），文案里写明改哪个字段。
- 只读档白名单是「读页面 + 读扩展缓冲」那 11 条（`content` / `find` / `snapshot` /
  `screenshot` / `pdf` / `wait` / `tabs.list` / `console.log` / `network.log` /
  `ping` / `browser.info`），其余一律拒绝 —— **默认拒绝**，扩展以后新增命令时不会自动放行。
- **`browser_cleanup` 也被只读档拒**：它不发命令给扩展，而是在插件进程里逐条 `rm` 本机文件，
  所以它不经过上面那张表，由 `cleanup()` 自己站一次闸门。删除不可逆，「只读」不该允许它。
- **`browser_hold` 按动作判**：`on` / `off` 会往页面插/删宿主元素（改 DOM），只读档拒绝；
  `action: "status"` 只读状态，放行——只读档不该连看一眼浮层状态都不让。
- 两项都改完重启 dsh 生效。
- 边界：这两个开关约束的是**模型走的那条工具面**。HTTP 面（`/api/command`，要你的 token）
  是你的通道，不受影响；同理它也不是「防有权限的人」，真要冻结整个浏览器扩展请用扩展弹窗里的
  「锁定」（README 的「一键冻结」一节）。

## 设置页里到底有没有这一节（issue #5）

npm 发布的 bundle 只有宿主侧 `lib/index.js`，没有浏览器端模块，卡片不是插件画的：

- dsh 0.1.7+ / 0.2.x（dsh-settings 0.1.7-rc.2 起）：宿主自己按插件 `Config` schema 投影出设置节，所以看得到、也能改。
- dsh 0.1.2 及更早：设置 → 插件 里**没有**条目（没有客户端半区认领命名空间，宿主就不渲染），只能改配置文件。

两边通用的做法就是下面「覆盖默认值」那份 profile 覆盖层。

## 状态页

桥接启动后可访问 `http://127.0.0.1:9777/` 查看连接状态；扩展工具栏图标绿点呼吸 = 已连接。
