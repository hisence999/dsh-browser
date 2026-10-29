// 协议版本握手实测：新版扩展、旧版扩展（不声明协议）、以及未来版扩展，
// 桥各自怎么判定，会不会误伤能正常工作的老安装。
import { BridgeServer, BRIDGE_PROTOCOL_VERSION } from "../src/server.ts";

const PORT = 9779;
const TOKEN = "proto-test";
let fails = 0;
const check = (name, ok, detail = "") => { if (!ok) fails++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`); };

async function helloOf(payload) {
  const server = new BridgeServer({ port: PORT, token: TOKEN, shotsDir: "dsh-browser-shots", log: () => {} });
  await server.start();
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((res, rej) => { ws.onerror = rej; ws.onopen = () => res(); });
  ws.send(JSON.stringify({ type: "hello", client: "fake", version: "9.9.9", browser: { name: "f", version: "1", ua: "" }, ...payload }));
  await new Promise((r) => setTimeout(r, 150));
  const st = server.status;
  ws.close();
  await server.stop();
  return st;
}

check("桥自身声明了协议版本", BRIDGE_PROTOCOL_VERSION === 1, `v${BRIDGE_PROTOCOL_VERSION}`);

const same = await helloOf({ protocol: BRIDGE_PROTOCOL_VERSION });
check("同版本 → 兼容", same.protocolCompatible === true && same.extensionProtocol === 1, `ext=v${same.extensionProtocol} note=${same.protocolNote}`);

const newer = await helloOf({ protocol: 99 });
check("扩展更新 → 判为不兼容并说要升级插件", newer.protocolCompatible === false && /升级 dsh 插件/.test(newer.protocolNote || ""), newer.protocolNote);

const older = await helloOf({ protocol: 0 });
check("老扩展声明 0 → 按兼容处理（不误伤能用的安装）", older.protocolCompatible === true && older.extensionProtocol === 0, `note=${older.protocolNote}`);

const silent = await helloOf({});
check("完全不声明协议的旧扩展 → 兼容 + 记为 0", silent.protocolCompatible === true && silent.extensionProtocol === 0, `note=${silent.protocolNote}`);

const future = await helloOf({ protocol: 2 });
check("扩展比桥新一版 → 不兼容且给出方向", future.protocolCompatible === false && /v2/.test(future.protocolNote || ""), future.protocolNote);

// 无痕权限（第 3 项的隔离实例唯一的硬前提）跟着握手一起过来。握手字面量是**手写**的
// ——上一版就漏过：扩展明明发了 `incognitoAllowed`，桥把它丢了，设置页那行于是永远显示
// 「—」。三种取值都要钉：true / false / 老扩展根本没有这个字段（那时是「不知道」，
// 不是「没权限」，两者的界面文案完全不同）。
const incognitoYes = await helloOf({ protocol: BRIDGE_PROTOCOL_VERSION, incognitoAllowed: true });
check("握手带 incognitoAllowed:true → 原样留在 status.hello 里",
  incognitoYes.hello?.incognitoAllowed === true, JSON.stringify(incognitoYes.hello));
const incognitoNo = await helloOf({ protocol: BRIDGE_PROTOCOL_VERSION, incognitoAllowed: false });
check("握手带 incognitoAllowed:false → 也是原样保留（不能被 falsy 判断吃掉）",
  incognitoNo.hello?.incognitoAllowed === false, JSON.stringify(incognitoNo.hello));
const incognitoLegacy = await helloOf({ protocol: BRIDGE_PROTOCOL_VERSION });
check("老扩展不带这个字段 → 保持 undefined（「不知道」不等于「没权限」）",
  incognitoLegacy.hello !== undefined && incognitoLegacy.hello.incognitoAllowed === undefined,
  JSON.stringify(incognitoLegacy.hello));
const incognitoJunk = await helloOf({ protocol: BRIDGE_PROTOCOL_VERSION, incognitoAllowed: "yes" });
check("字段类型不对（字符串）→ 不猜，仍然 undefined",
  incognitoJunk.hello !== undefined && incognitoJunk.hello.incognitoAllowed === undefined,
  JSON.stringify(incognitoJunk.hello));

console.log(`\n结论：${fails === 0 ? "协议握手全部通过" : fails + " 项未通过"}`);
process.exit(fails ? 1 : 0);
