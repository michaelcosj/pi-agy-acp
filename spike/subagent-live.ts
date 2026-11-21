// Live: one prompt that starts one agy subagent, to learn the ACP updates and the brain/ records.
import fs from "node:fs";
import { AgyProcess } from "../src/acp/agent.ts";
import { launchFromEnv } from "../src/runtime.ts";
const out = fs.createWriteStream("/tmp/agy-sub/updates.jsonl");
const agy = await AgyProcess.start({ ...launchFromEnv(), cwd: "/tmp/agy-sub" }, {
  permission: async (r: any) => { out.write(JSON.stringify({ permission: r }) + "\n"); const o = r.options.find((o: any) => o.kind.startsWith("allow")); return { outcome: { outcome: "selected", optionId: o.optionId } }; },
});
const s = await agy.newSession("/tmp/agy-sub", {});
console.log("session", s.sessionId);
await agy.setConfigOption(s.sessionId, "mode", "auto");
await agy.setConfigOption(s.sessionId, "model", "gemini-3.8-flash").catch((e: any) => console.log("model", e.message));
agy.subscribe(s.sessionId, (n: any) => out.write(JSON.stringify(n.update) + "\n"));
const r = await agy.prompt(s.sessionId, [{ type: "text", text: "Test of subagents. Use invoke_subagent to start exactly one subagent with role 'counter' and the prompt 'Reply with the word: seven. Use no tools.' Wait for its result, then reply with its answer only." }]);
console.log("stop", r.stopReason);
await new Promise((res) => setTimeout(res, 20000));
agy.kill();
