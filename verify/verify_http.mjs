// #3 / #6 HTTP 面实测台：
//  1) 用一个假的扩展客户端连上 WS，让 /api/command 真的执行（不是 503 空转）
//  2) 断言跨源响应头里不再出现 Access-Control-Allow-Origin（CORS 收紧）
//  3) 断言鉴权：无 token / 错 token 必须 401，带 Bearer 或 ?token= 才放行
// 用法: node verify/verify_http.mjs
import net from "node:net";
import { BridgeServer } from "../src/server.ts";

const PORT = 9777;
const TOKEN = "s3cr3t-token-for-test";
const BASE = `http://127.0.0.1:${PORT}`;
const CORS_HEADERS = ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"];

let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
};

const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: "dsh-browser-shots", log: () => {} });
await server.start();

// 假扩展：连接 + hello + 对任何 command 回一个可辨认的结果
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
let sawCommand = false;
await new Promise((res, rej) => {
  ws.onerror = (e) => rej(new Error("fake extension failed to connect: " + (e?.message ?? "ws error")));
  ws.onopen = () => ws.send(JSON.stringify({ type: "hello", client: "fake-ext", version: "0", browser: { name: "fake", version: "1", ua: "" } }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "command") {
      sawCommand = true;
      ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true, result: { executed: msg.command, params: msg.params } }));
    }
  };
  setTimeout(res, 300);
});
check("假扩展已连上（status.extensionConnected）", server.status.extensionConnected === true);

const corsClean = (res) => CORS_HEADERS.filter((h) => res.headers.get(h));

// ---- CORS 面 ----
let res = await fetch(`${BASE}/api/status`, { headers: { Origin: "http://evil.example" } });
check("GET /api/status 不带 ACAO", corsClean(res).length === 0, `status=${res.status} 残留=${corsClean(res).join(",") || "无"}`);

res = await fetch(`${BASE}/api/command`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "http://evil.example", Authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ command: "nav", params: { url: "https://example.com" } }),
});
check("跨源 POST /api/command 不带 ACAO", corsClean(res).length === 0, `残留=${corsClean(res).join(",") || "无"}`);
const body = await res.json();
check("带 token 的命令确实驱动扩展执行（鉴权没有把功能一起砍掉）", sawCommand === true && body.ok === true, JSON.stringify(body).slice(0, 120));

res = await fetch(`${BASE}/api/status`, { method: "OPTIONS", headers: { Origin: "http://evil.example" } });
check("OPTIONS 预检不带 ACAO / Allow-Methods", res.status === 204 && corsClean(res).length === 0, `status=${res.status}`);

res = await fetch(`${BASE}/`, { headers: { Origin: "http://evil.example" } });
const pageText = await res.text();
check("状态页 HTML 仍可同源访问", res.status === 200 && pageText.includes("DSH Browser"));
check("状态页自带 Token 输入框并用 Bearer 调用清理", pageText.includes('id="token"') && pageText.includes("'Authorization':'Bearer '"));
check("状态页显示令牌强度行", pageText.includes("insecureToken") && pageText.includes("令牌强度"));

// ---- 鉴权面 ----
res = await fetch(`${BASE}/api/command`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "ping", params: {} }) });
check("无 token 的 /api/command -> 401", res.status === 401, `实际 ${res.status}`);

res = await fetch(`${BASE}/api/cleanup`, { method: "POST" });
check("无 token 的 /api/cleanup -> 401", res.status === 401, `实际 ${res.status}`);

res = await fetch(`${BASE}/api/command?token=wrong`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: "ping", params: {} }) });
check("错误 token -> 401", res.status === 401, `实际 ${res.status}`);

res = await fetch(`${BASE}/api/command`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ command: "ping", params: {} }) });
const bearerBody = await res.json().catch(() => ({}));
check("Bearer token -> 200 且执行", res.status === 200, `实际 ${res.status} ${JSON.stringify(bearerBody)}`.slice(0, 140));

res = await fetch(`${BASE}/api/cleanup?token=${TOKEN}`, { method: "POST" });
check("?token= 的 /api/cleanup -> 200", res.status === 200, `实际 ${res.status}`);

res = await fetch(`${BASE}/api/status`);
check("/api/status 保持免鉴权（只读状态页要用）", res.status === 200, `实际 ${res.status}`);

// ---- WebSocket 升级的 Host / Origin 约束 ----
const rawUpgrade = ({ host, origin, tokenQ }) => new Promise((res2) => {
  const s = net.connect(PORT, "127.0.0.1", () => {
    const lines = [
      `GET /ws?token=${tokenQ} HTTP/1.1`,
      `Host: ${host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGVzdC1rZXktMDEyMzQ1Njc4OQ==",
      "Sec-WebSocket-Version: 13",
    ];
    if (origin) lines.push(`Origin: ${origin}`);
    s.write(lines.join("\r\n") + "\r\n\r\n");
  });
  let data = "";
  s.on("data", (b) => { data += b.toString("latin1"); });
  s.on("error", () => res2("(socket error)"));
  setTimeout(() => { s.destroy(); res2(data.split("\r\n")[0] || "(no response)"); }, 250);
});

let statusLine = await rawUpgrade({ host: `127.0.0.1:${PORT}`, origin: "", tokenQ: TOKEN });
check("正常扩展握手（回环 Host、无 Origin）-> 101", statusLine.includes("101"), statusLine);

statusLine = await rawUpgrade({ host: `127.0.0.1:${PORT}`, origin: "", tokenQ: "nope" });
check("错误 token 的升级 -> 401", statusLine.includes("401"), statusLine);

statusLine = await rawUpgrade({ host: "evil.example", origin: "", tokenQ: TOKEN });
check("DNS 重绑定的 Host -> 403", statusLine.includes("403"), statusLine);

statusLine = await rawUpgrade({ host: `127.0.0.1:${PORT}`, origin: "https://evil.example", tokenQ: TOKEN });
check("网页 Origin 的升级 -> 403", statusLine.includes("403"), statusLine);

statusLine = await rawUpgrade({ host: `127.0.0.1:${PORT}`, origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", tokenQ: TOKEN });
check("扩展 Origin 的升级 -> 101", statusLine.includes("101"), statusLine);

ws.close();
await server.stop();
console.log(`\n结果：${failures === 0 ? "全部通过" : failures + " 项未通过"}`);
process.exit(failures === 0 ? 0 : 1);
