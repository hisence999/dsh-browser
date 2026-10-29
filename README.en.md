# DSH Browser Control

<p align="center">
  <img src="extension/icons/icon128.png" width="100" alt="DSH Browser Control">
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

A Chrome extension + DeepSeek Harness plugin that lets AI agents drive your **real** browser like a human.

## What is this

Not a headless browser, not Puppeteer — the Chrome/Edge you are already using, with your logins and cookies. The AI drives tabs through the Chrome DevTools Protocol, and every step is visible on your screen.

```
You say one sentence to the AI
      ↓
Agent calls browser_* tools
      ↓
DSH plugin (local WebSocket bridge, 127.0.0.1:9777)
      ↓
Chrome extension (chrome.debugger / CDP)
      ↓
Your real browser performs the action
```

| | This project | Playwright / Puppeteer MCP |
|---|---|---|
| Browser | The real Chrome you are using | Separate auto-downloaded instance |
| Logins / Cookies | ✅ Fully inherited, no re-login | ❌ Fresh profile every time |
| Visibility | Live on your screen: tabs land in a blue tab group, the page being driven carries a blue gradient frame | Headless or a separate window |
| Environment deps | No Node / npx / Python needed | Needs an npx or uvx runtime |

For "use **my own** browser" work (logged-in Bilibili, Zhihu, admin panels) use this project; for generic cross-browser test automation use MCP.

## Install

### 1. The Chrome extension

Open `chrome://extensions` → enable Developer mode → "Load unpacked" → pick this repository's `extension/` directory. Requires Chrome/Edge 116+.

A whale icon with a breathing green dot in the toolbar means it is connected.

### 2. The dsh plugin

This package is a bundle (`package.json` points `dsh.bundle.patch` at `cordis.patch.yml`), so a successful install registers it under the profile's `dsh.profile.bundles` and a DSH restart loads it.

```bash
dsh plugin --profile desktop add "file:D:\path\to\dsh-browser"
```

- **Use the explicit `file:` prefix.** A bare or relative path is treated by pnpm as `link:`, which is not materialized at the top of `node_modules` under a hoisted layout, so the package cannot be resolved at startup.
- Uninstall takes the **package name**: `dsh plugin --profile desktop remove dsh-browser`.

After a restart the bridge is on by default (port `9777`, token `dsh-local`) and the extension connects automatically. Open <http://127.0.0.1:9777/> to see the link status.

To change the port / token / turn the default off, configure `- id: browser-bridge` in the profile overlay `$DSH_HOME/profiles/<name>/cordis.patch.yml`; see [dsh-config/README.md](dsh-config/README.md).

## Usage

Once installed, just talk in natural language — the agent picks the tools. A few things worth knowing up front:

**Settings page**: on dsh 0.1.7+ / 0.2.x, "Settings → Browser Control" shows the link status, the switches (read-only, script execution, lazy docs, raw CDP, isolated instance, group name, AI highlight, tab placement, focus policy, user takeover) and a cleanup button for screenshots and scratch files.

**What the AI's tabs look like**: tabs it opens are collected into a blue tab group (name `DSH` by default and configurable; empty = no group; a single call may override it with `groupTitle`). Ownership is tracked by **group id**, never by name — a group of yours with the same name is never taken over. It only closes tabs it opened; closing yours requires an explicit `force`.

**You touch it, it stops**: when you actually click / type / paste on the page it is driving, its write operations there (including closing that tab) are refused with `yielded_to_user` and zero side effects. **Merely switching to it or scrolling does not count as taking over.**

**Isolated instance**: `browser_profile` works inside an incognito window with its own cookie jar — cleared on exit, never touching your sessions. Two manual grants are required: `allowIncognito: true` in the plugin config, plus allowing this extension in incognito/InPrivate in the browser's extension page.

**Read-only and script gates**: `readOnly: true` refuses every page-mutating command (zero side effects); `allowScript: false` additionally removes `browser_evaluate`. Both only constrain the model-facing tool surface — the HTTP surface is guarded by the token.

**Panic switch**: the "Lock" button in the extension popup takes effect on a single click. The extension then refuses every browser operation while the WebSocket stays up, so callers see "connected but frozen" instead of a dropped link. Unlocking is only possible from that same popup.

**Direct HTTP** (bypasses the tool layer):

```bash
curl -X POST http://127.0.0.1:9777/api/command \
  -H 'Authorization: Bearer dsh-local' \
  -H 'Content-Type: application/json' \
  -d '{"command":"nav","params":{"url":"https://example.com"}}'
```

The token may also be passed as `?token=` or `X-Token:`; missing or wrong is 401. `/` and `/api/status` stay unauthenticated read-only info.

## Architecture

```
Chrome browser
  └─ DSH Browser Control extension (MV3)
       └─ chrome.debugger (CDP)
            └─ WebSocket ──────→ DSH plugin (browser-bridge, 127.0.0.1:9777)
                                      └─ browser_* tools → Agent
```

- **The extension dials out**: no native messaging host, no second process.
- **On by default**: it listens as soon as it is installed; `enabled: false` turns that off.
- **Persistent debugger attachment**: the "being controlled" banner stays up while it works. After a link loss the first command reconnects and replays once (write operations replay at most once and are never dispatched twice).
- **Loopback only**: the WS and HTTP command surfaces share one token and never accept cross-origin requests.
- **Policy travels with every command** (`params.policy`): the extension keeps no copy of it, so a settings change applies to the very next command with no in-between state.
- **Protocol version is independent of the release version**: it changes only when the frame contract does, and the status page says which side to upgrade when they disagree.

## Tools

| Tool | Purpose |
|---|---|
| `browser_navigate` | Navigate to a URL and wait for the page to settle |
| `browser_read` | Read page text/HTML, returned straight to the model (`offset`/`limit` paging) |
| `browser_snapshot` | Interactive element tree, each element gets a `ref` (`mode:"ax"` uses the accessibility tree) |
| `browser_click` | Click an element (by `ref` or CSS selector) |
| `browser_type` | Fill text into an input |
| `browser_press` | Press keys, including combinations like `Ctrl+A` / `Shift+ArrowRight` |
| `browser_scroll` | Scroll the page |
| `browser_wait` | Wait for an element, some text, or a condition |
| `browser_find` | Query elements by CSS selector, return counts and geometry |
| `browser_dialog` | Read/change the native dialog policy (`accept`/`dismiss`/`manual`) and return recent records |
| `browser_hold` | Add/remove a cancellable takeover overlay (tells the user, prevents misclicks); a soft layer, not a security boundary |
| `browser_tabs` | Tab management: list / open / close / activate / group / ungroup |
| `browser_evaluate` | Run arbitrary JS; optional `timeoutMs` budget (100–120000) |
| `browser_screenshot` | Screenshot (PNG/JPEG, saved to disk, path returned) |
| `browser_pdf` | Export the current page to PDF |
| `browser_emulate` | Device viewport (mobile / desktop / custom / reset) |
| `browser_console_log` | Captured console entries, with each entry's text |
| `browser_network_log` | Captured requests/responses with method, status and URL |
| `browser_network_clear` | Empty the network log buffer |
| `browser_profile` | Isolated instance (incognito jar): `status` / `launch` / `use` / `close` |
| `browser_cdp` | Raw CDP passthrough (`method: "Domain.method"`) |
| `browser_info` | Report the browser and extension version actually connected (run this first when debugging) |
| `browser_cleanup` | Delete screenshots and scratch files |
| `browser_help` | Look up tool usage: omit `tool` for the catalog, pass a name for the full description and parameter table |

24 tools in total. `verify/verify_surface.mjs` reconciles this surface against the extension's command table; drift makes `npm run verify` fail.

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

- **Personal / academic / non-commercial use**: free of charge; use, modify and redistribute it under AGPL-3.0.
- **Commercial use**: AGPL-3.0 treats network use as distribution, so derived code must be published. Embedding it in a closed-source product or building a SaaS on it without open-sourcing requires a **commercial license** from the author (separate terms).
- **Commercial licensing enquiries**: use the contact details you used to deploy this repository.

The full license text is in [LICENSE](LICENSE) (AGPL-3.0).
