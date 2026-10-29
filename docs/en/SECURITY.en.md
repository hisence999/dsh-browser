# Security Policy

[简体中文](../../SECURITY.md)

## Permissions requested

The extension requests these Chrome permissions:

| Permission | Purpose |
|---|---|
| `debugger` | Drive pages via CDP (run JS, synthesize input, capture screenshots) |
| `tabs` | Read tab info and manage tab navigation |
| `storage` | Save user configuration (port, token, auto-connect) |
| `alarms` | Keepalive heartbeat for the WebSocket connection |

## Security boundaries

- **Listens on 127.0.0.1 only** — the bridge is never exposed to the network
- **Token authentication** — the extension must present the correct token to connect; `/api/command` and `/api/cleanup` demand the same token (`Authorization: Bearer`, `X-Token` or `?token=`) and answer 401 without it
- **Upgrade origin checks** — the WebSocket handshake requires a loopback `Host` (blocking DNS rebinding) and refuses any web-page `Origin`; only the extension's own scheme and non-browser clients that send no Origin are accepted
- **No cross-origin grant** — no HTTP response carries `Access-Control-Allow-Origin`; the status page and its own requests are same-origin
- **Local-only communication** — extension and bridge talk over WebSocket on localhost
- **No data upload** — nothing is sent to any external server
- **User control** — since v1.0.6 the plugin is on by default and binds only to 127.0.0.1; set `enabled: false` in your profile override layer to turn it off
- **Visibility** — Chrome shows its "is being debugged" banner during control; every action is visible on screen

## Agent activity highlight (v1.1.4+)

The tab the agent is driving carries a blue gradient outline plus an "AI 正在操作" badge; when you **actually act** on that page (click, type, key, paste — merely switching over to watch, or scrolling, does not count) it turns amber ("已让出 · 你可以操作"). It is controlled by the `agentHighlight` setting (on by default, switchable from the Settings page).

It is a `position: fixed`, `pointer-events: none` **decoration only**: it intercepts no click or key, takes part in no policy decision, and **is not a security boundary** — turning it off relaxes no gate, and leaving it on refuses no extra command. It is hidden while a screenshot is taken and while a PDF is printed, so neither your captures nor your PDFs contain it. It is not the take-over overlay (`browser_hold`): that overlay covers the page, blocks mis-clicks and requires a confirmation on its card before the agent is aborted, while the frame is only a status indicator.

**The yield itself (`yielded_to_user`) is no security boundary either**: it is the courtesy rule that stops both sides from wrecking the same page (and since v1.1.5 it only fires when you really act on that page). It constrains the model's tool surface only — the token-gated HTTP face is not subject to it, and it stops nobody who already holds the token. To actually stop the browser the only switch is the local lock in the extension popup (see the "One-click freeze" section of the [README](../../README.en.md)).

## Known limitations

- The bridge has no per-process identity check: **any local process that knows the token can drive this browser**. The loopback bind is not the boundary, the token is. `/api/status` and the status page remain unauthenticated read-only information (port, extension hello, browser name and version, screenshots directory).
- The `eval` command is always available; neither the extension nor the plugin has a switch to disable it. The `allowEval` mentioned in older docs was never implemented — do not rely on it.
- The default token `dsh-local` is published in the README and in `cordis.patch.yml`, so it is public knowledge, not a secret. Starting with the default token or one shorter than 16 characters logs a warning and shows "token: default/short" on the status page, but the bridge **still starts** — changing it is on you.

## Reporting a vulnerability

Either channel works:

- **Private report (preferred)**: GitHub Security Advisories (<https://github.com/hisence999/dsh-browser/security/advisories/new>)
- **Public issue**: fine for problems without exploitable details (no concrete attack steps, no token-bypass methods) — open it at <https://github.com/hisence999/dsh-browser/issues>

For anything exploitable, please use the private channel so it is not abused before a fix ships.
