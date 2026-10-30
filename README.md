# DSH Browser

<p align="center">
  <img src="extension/icons/icon128.png" width="100" alt="DSH Browser">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="Awesome DSH Plugin"></a>
  <a href="https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline"><img src="https://img.shields.io/badge/Chrome-MV3-yellow" alt="chrome mv3"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-purple" alt="dsh plugin"></a>
  <img src="https://img.shields.io/badge/CDP-powered-orange" alt="cdp">
  <img src="https://img.shields.io/badge/tools-24-red" alt="24 browser tools">
</p>

<p align="center">
  <a href="https://github.com/hisence999/dsh-browser">github.com/hisence999/dsh-browser</a>
</p>

Chrome 扩展 + DeepSeek Harness 插件，让 AI Agent 像人一样操控你的**真实**浏览器。

## 介绍

不是无头浏览器，也不是 Puppeteer——就是你正在用的那个 Chrome/Edge，带着你的登录态和 cookies。AI 通过 Chrome DevTools Protocol 驱动标签页，每一步都在屏幕上看得见。

```
你对 AI 说一句话
      ↓
Agent 调用 browser_* 工具
      ↓
DSH 插件（本地 WebSocket 桥，127.0.0.1:9777）
      ↓
Chrome 扩展（chrome.debugger / CDP）
      ↓
你的真实浏览器执行操作
```

| | 本项目 | Playwright / Puppeteer MCP |
|---|---|---|
| 浏览器 | 你正在用的真实 Chrome | 自动下载的独立实例 |
| 登录态 / Cookies | ✅ 全部继承，无需重新登录 | ❌ 每次全新 profile |
| 可见性 | 屏幕上实时可见：标签归进一个蓝色标签组，正在操作的那一页带一圈蓝色渐变描边 | 无头运行或独立窗口 |
| 环境依赖 | 无需 Node / npx / Python | 需要 npx 或 uvx 运行时 |

要 AI 用**你自己的**浏览器干活（已登录的 B 站、知乎、后台系统），用本项目；要做跨浏览器、跨应用的通用自动化测试，用 MCP。

## 安装

> 不想 clone？到 [Releases](https://github.com/hisence999/dsh-browser/releases/latest) 下载 `dsh-browser-vX.Y.Z.zip`（扩展）与 `dsh-browser-plugin-vX.Y.Z.zip`（插件）两个离线包，校验和写在那个 Release 的正文里。

### 1. Chrome 扩展

打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选本仓库的 `extension/` 目录（用离线包的话，选解压出来的那个目录）。需要 Chrome/Edge 116+。

工具栏出现鲸鱼图标、绿点呼吸 = 已连上桥。

### 2. dsh 插件

本包是 bundle 包（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），装好会自动加入 profile 的 `dsh.profile.bundles`，重启 DSH 即加载。

```bash
dsh plugin --profile desktop add "file:D:\path\to\dsh-browser"
```

- **必须显式写 `file:` 前缀**。裸路径 / 相对路径会被 pnpm 当成 `link:`，在 hoisted 布局下不会物化到 `node_modules` 顶层，启动时解析不到该包。
- 卸载时跟的是**包名**：`dsh plugin --profile desktop remove dsh-browser`。

装好重启 DSH 后桥接默认开启（端口 `9777`、Token `dsh-local`），扩展会自动连上。打开 <http://127.0.0.1:9777/> 可看连接状态。

想改端口 / Token / 关掉默认开启，在 profile 覆盖层 `$DSH_HOME/profiles/<名字>/cordis.patch.yml` 里配 `- id: browser-bridge`，写法见 [dsh-config/README.md](dsh-config/README.md)。

## 使用

装好之后直接用自然语言说话，Agent 自己挑工具。几条一眼就该知道的：

**设置页**：宿主是 dsh 0.1.7+ / 0.2.x 时，「设置 → 浏览器控制」里能看链路状态、改开关（只读档 / 脚本 / 懒加载 / 原生 CDP / 隔离实例 / 分组名 / AI 高亮 / 打开位置 / 焦点策略 / 用户接管），也能清理截图与临时文件。

**AI 的标签长什么样**：它新建的标签页会归进一个蓝色标签组（默认名 `DSH`，可配，留空 = 不分组；每次调用还能用 `groupTitle` 临时换个名字）。归属按**组 id** 认，不按名字——你自己建的组哪怕同名也不会被它占。默认它只关自己开的标签页，关你的必须显式 `force`。

**你动手它就停**：你在 AI 正在操作的那一页上真的点了/打了字/粘贴了，它在该页的写操作（含关掉这页）会被拒绝，错误码 `yielded_to_user`、零副作用。**只是切过去看、或者滚页面，都不算接管**。

**隔离实例**：`browser_profile` 能在无痕窗口里干活，独立 cookie 罐，退出即清，碰不到你的登录态。需要两道人工作可：插件配 `allowIncognito: true` + 浏览器扩展管理页允许本扩展在无痕/InPrivate 中运行。

**只读档与脚本闸门**：`readOnly: true` 会拦下所有会改页面的命令（零副作用）；`allowScript: false` 另外关掉 `browser_evaluate`。两者只管模型那条工具面，HTTP 面靠 Token。

**一键冻结**：扩展弹窗里的「锁定」单击生效，此后扩展拒绝一切浏览器操作，但 WebSocket 照常——看到的是「连得上但被冻结」，不是掉线。解锁也只能在同一个弹窗里点。

**HTTP 直连**（不经过工具层）：

```bash
curl -X POST http://127.0.0.1:9777/api/command \
  -H 'Authorization: Bearer dsh-local' \
  -H 'Content-Type: application/json' \
  -d '{"command":"nav","params":{"url":"https://example.com"}}'
```

Token 也可以写 `?token=` 或 `X-Token:`；不带或带错一律 401。`/` 与 `/api/status` 是免鉴权的只读信息。

## 架构

```
Chrome 浏览器
  └─ DSH Browser 扩展 (MV3)
       └─ chrome.debugger (CDP)
            └─ WebSocket ──────→ DSH 插件（browser-bridge，127.0.0.1:9777）
                                      └─ browser_* 工具 → Agent
```

- **扩展主动外连桥**：不需要 native messaging host，也没有第二个进程。
- **默认开启**：装上即监听；`enabled: false` 才会关。
- **持久 debugger 附着**：控制期间页面顶部横幅始终显示；断线后第一次命令自动重连并重放一次（写操作只重放一次，绝不重复派发）。
- **只监听 127.0.0.1**：WS 与 HTTP 命令面共用一个 Token，跨源一律不放行。
- **策略随每条命令下发**（`params.policy` 信封）：扩展不保存策略副本，配置改了下一条命令立刻生效，不存在「切了配置没生效」的中间态。
- **协议版本独立于版本号**：帧契约变了才升，不匹配时状态页直接写出该升级哪一侧。

## 工具清单

| 工具 | 功能 |
|---|---|
| `browser_navigate` | 导航到 URL 并等页面稳定 |
| `browser_read` | 读取页面文本/HTML，正文直接给模型（`offset`/`limit` 窗口分页） |
| `browser_snapshot` | 交互元素树，给每个元素一个 `ref`（`mode:"ax"` 走无障碍树） |
| `browser_click` | 点击元素（`ref` 或 CSS selector） |
| `browser_type` | 在输入框填入文本 |
| `browser_press` | 按键，含 `Ctrl+A` / `Shift+ArrowRight` 这类组合键 |
| `browser_scroll` | 滚动页面 |
| `browser_wait` | 等元素出现 / 等文本出现 / 等条件为真 |
| `browser_find` | 按 CSS 选择器查元素，返回数量与位置尺寸 |
| `browser_dialog` | 读改原生弹窗应答策略（`accept`/`dismiss`/`manual`）并回最近记录 |
| `browser_hold` | 加/撤一层可取消的接管浮层（告知用户 + 防误触）；软层，不是安全边界 |
| `browser_tabs` | 标签页管理：列表 / 新建 / 关闭 / 切换 / 归组 / 拆组 |
| `browser_evaluate` | 执行任意 JS；可选 `timeoutMs` 预算（100–120000） |
| `browser_screenshot` | 截图（PNG/JPEG，落盘并回路径） |
| `browser_pdf` | 当前页导出 PDF |
| `browser_emulate` | 切设备视口（移动 / 桌面 / 自定义 / 复位） |
| `browser_console_log` | 抓取页面 console 日志，逐条给正文 |
| `browser_network_log` | 抓取请求/响应，逐条给方法、状态、URL |
| `browser_network_clear` | 清空网络日志缓冲 |
| `browser_profile` | 隔离实例（无痕罐）：`status` / `launch` / `use` / `close` |
| `browser_cdp` | 原生 CDP 透传（`method: "Domain.method"`） |
| `browser_info` | 报告实际连上的浏览器与扩展版本（排障先跑它） |
| `browser_cleanup` | 清理截图与临时文件 |
| `browser_tools` | 装载器：只在懒加载模式下出现，给它工具名、分组名或 `"*"` 把工具装上 |

共 23 个工具。默认全开：23 个全部注册给模型；打开「工具懒加载」后只留 `browser_tools` 一个装载器，由它按需把其余工具装进来（装上的定义与全开时逐字节一致）。装载只对**发起装载的那个会话**生效：别的会话看到的仍然只有装载器，会话结束时装上的工具随之消失。工具面与扩展命令表的一致性由 `verify/verify_surface.mjs` 对账，漂移会让 `npm run verify` 失败。

## 许可证 · License

本项目采用 **GNU Affero General Public License v3.0 (AGPL-3.0)**。

- **个人 / 学术 / 非商业用途**：完全免费，在遵守 AGPL-3.0 的前提下自由使用、修改、分发。
- **企业 / 商业用途**：AGPL-3.0 要求通过网络使用也构成"分发"，必须公开衍生代码。若要在闭源产品中嵌入、或基于本项目构建 SaaS 而不愿开源，需联系作者获取**商业许可**（另行协商条款）。
- **商业许可咨询**：通过你部署此仓库时使用的联系方式联系维护者。

完整许可证文本见 [LICENSE](LICENSE)（AGPL-3.0）。
