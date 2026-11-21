// Live: does agy ask before it runs Pi's MCP agent tool? One prompt per rule.
import fs from "node:fs";
import { AgyProcess } from "../src/acp/agent.ts";
import { startMcpServer } from "../src/mcp.ts";
import { launchFromEnv } from "../src/runtime.ts";
const SETTINGS = `${process.env.HOME}/.gemini/antigravity-cli/settings.json`;
const original = fs.readFileSync(SETTINGS, "utf8");
const rule = process.argv[2];
const s0 = JSON.parse(original);
s0.permissions = { allow: rule ? [rule] : [] };
fs.writeFileSync(SETTINGS, JSON.stringify(s0, null, 2));
const events = { emit(n: string, d: any) { if (n === "agent-bridge:call") { d.accept(); d.reply({ text: "No agents running." }); } } };
const mcp = (await startMcpServer({ events }))!;
let asked: any;
fs.mkdirSync("/tmp/agy-perm", { recursive: true });
const agy = await AgyProcess.start({ ...launchFromEnv(), cwd: "/tmp/agy-perm" }, {
  permission: async (r: any) => { asked = { title: r.toolCall?.title, options: r.options.map((o: any) => `${o.kind}:${o.name}`) }; const o = r.options.find((o: any) => o.kind === "allow_once"); return { outcome: { outcome: "selected", optionId: o.optionId } }; },
});
try {
  const s = await agy.newSession("/tmp/agy-perm", { mcpServers: [mcp.acpEntry()] });
  await agy.setConfigOption(s.sessionId, "mode", "auto");
  await agy.setConfigOption(s.sessionId, "model", "gemini-3.8-flash").catch(() => {});
  const tools: string[] = [];
  agy.subscribe(s.sessionId, (n: any) => { if (n.update.sessionUpdate === "tool_call") tools.push(`${n.update.title} | ${JSON.stringify(n.update._meta ?? {}).slice(0, 120)}`); });
  await agy.prompt(s.sessionId, [{ type: "text", text: "Call the agent tool of the pi MCP server once with action status. Then reply with its output only." }]);
  console.log(JSON.stringify({ rule, asked: asked ?? "no prompt", tools }));
} finally {
  fs.writeFileSync(SETTINGS, original);
  agy.kill(); mcp.close();
}
