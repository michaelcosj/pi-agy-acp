// Live: the Runtime approves Pi's agent tool by itself (no dialog).
import fs from "node:fs";
import { startMcpServer } from "../src/mcp.ts";
import { Runtime } from "../src/runtime.ts";
fs.mkdirSync("/tmp/agy-perm", { recursive: true });
let called = 0;
const events = { emit(n: string, d: any) { if (n === "agent-bridge:call") { called++; d.accept(); d.reply({ text: "No agents running." }); } } };
const mcp = (await startMcpServer({ events }))!;
const rt = new Runtime();
const dialogs: string[] = [];
rt.ctx = { hasUI: true, cwd: "/tmp/agy-perm", ui: { select: async (t: string) => { dialogs.push(t); return undefined; }, confirm: async () => false, notify: () => {}, setStatus: () => {} } } as any;
rt.mcpServers = () => [mcp.acpEntry()];
const s = await rt.session("/tmp/agy-perm");
await rt.setOption(s.sessionId, "model", "gemini-3.8-flash").catch(() => {});
await s.agy.prompt(s.sessionId, [{ type: "text", text: "Call the agent tool of the pi MCP server once with action status. Then reply with its output only." }]);
console.log(JSON.stringify({ dialogs, mcpCalls: called }));
rt.stop(); mcp.close();
