// Non-model ACP probe: initialize, session/new, session/list. Sends no prompt.
import { spawn } from "node:child_process";
const [cmd, ...args] = (process.argv[2] ?? "agy acp").split(" ");
const p = spawn(cmd, args, { cwd: process.argv[3] ?? process.cwd(), stdio: ["pipe", "pipe", "inherit"] });
let buf = "", id = 0; const pending = new Map();
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line);
  if (m.id !== undefined && pending.has(m.id) && !m.method) { pending.get(m.id)(m); pending.delete(m.id); } else console.log("<<", JSON.stringify(m)); } });
const req = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: i, method, params }) + "\n"); });
const init = await req("initialize", { protocolVersion: 1, clientInfo: { name: "pi-antigravity", version: "0.0.0" }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false } });
console.log("initialize", JSON.stringify(init.result ?? init.error));
const s = await req("session/new", { cwd: process.argv[3] ?? process.cwd(), mcpServers: [] });
console.log("session/new", JSON.stringify(s.result ?? s.error, null, 1));
await new Promise((r) => setTimeout(r, 1500));
const l = await req("session/list", {});
console.log("session/list", JSON.stringify(l.result ?? l.error).slice(0, 600));
if (s.result?.sessionId) { const c = await req("session/close", { sessionId: s.result.sessionId }); console.log("close", JSON.stringify(c.result ?? c.error)); }
p.kill();
