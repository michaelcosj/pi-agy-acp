// Live check, no prompt: real agy + mcp.ts + auto mode. Run: node --experimental-transform-types spike/mcp-live.ts
import { AgyProcess } from "../src/acp/agent.ts";
import { startMcpServer } from "../src/mcp.ts";
import { launchFromEnv } from "../src/runtime.ts";
const seen: string[] = [];
const events = { emit(n: string, d: any) { if (n === "agent-bridge:call") { d.accept(); d.reply({ text: "No agents running." }); } } };
const mcp = (await startMcpServer({ events }))!;
const origFetch = mcp.url;
const l = launchFromEnv();
console.log("launch:", l.command, l.args.join(" "), JSON.stringify(l.env));
const agy = await AgyProcess.start({ ...l, cwd: "/tmp" }, { trace: (e) => e.method && seen.push(`${e.dir} ${e.method}`) });
console.log("http MCP:", JSON.stringify((agy.init.agentCapabilities as any)?.mcpCapabilities));
const s = await agy.newSession("/tmp", { mcpServers: [mcp.acpEntry()], systemPromptAppend: "test" });
await agy.setConfigOption(s.sessionId, "mode", "auto");
await new Promise((r) => setTimeout(r, 5000));
console.log("session ok, mode set to auto; trace:", [...new Set(seen)].join(", "));
await agy.closeSession(s.sessionId);
agy.kill(); mcp.close();
