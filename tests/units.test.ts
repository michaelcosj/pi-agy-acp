import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCall } from "../src/mcp.ts";
import { deniedCommand, deniedTool, hookScript, installGuard, guardStatus, DENIED_TOOL_RE } from "../src/guard.ts";
import { TurnGate } from "../src/gate.ts";
import { agyLevelFor, catalogFromModelsOutput, catalogFromSession, toPiModel } from "../src/models.ts";
import { describePermission, launchFromEnv } from "../src/runtime.ts";
import { stopReason, usageFrom } from "../src/translate.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

test("gate: matches the typed text, once", () => {
  const g = new TurnGate();
  g.arm("fix the bug");
  assert.equal(g.take([user("other"), user("fix the bug")]), 1);
  assert.equal(g.take([user("fix the bug")]), -1);
});

test("gate: a /template token matches the newest user message", () => {
  const g = new TurnGate();
  g.arm("/review src");
  assert.equal(g.take([user("old"), user("Expanded template text")]), 1);
});

test("gate: refuses text that you did not type", () => {
  const g = new TurnGate();
  g.arm("hello");
  assert.equal(g.take([user("Agent scout finished: …")]), -1);
});

test("gate: tokens expire", () => {
  let now = 0;
  const g = new TurnGate(() => now);
  g.arm("x");
  now = 61 * 60_000;
  assert.equal(g.take([user("x")]), -1);
});

test("catalog from session/new", () => {
  const c = catalogFromSession({
    models: { availableModels: ["a-low", "a-high", "b"].map((modelId) => ({ modelId, name: modelId })) },
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "a", options: [{ value: "a", name: "A" }, { value: "b", name: "B" }] }],
  });
  assert.deepEqual(c, [
    { id: "a", name: "A", levels: ["low", "high"] },
    { id: "b", name: "B", levels: [] },
  ]);
  assert.equal(toPiModel(c[1]).reasoning, false);
});

test("catalog from agy models output", () => {
  const out = "Fetching available models...\ngemini-4-neon-high\tGemini 4 Neon (High)\ngemini-4-neon-low\tGemini 4 Neon (Low)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
  const c = catalogFromModelsOutput(out)!;
  assert.deepEqual(c[0], { id: "gemini-4-neon", name: "Gemini 4 Neon", levels: ["low", "high"] });
  assert.equal(c[1].id, "gpt-oss-120b");
  assert.equal(catalogFromModelsOutput("Please sign in to view available models"), undefined);
});

test("thinking level mapping picks the nearest level", () => {
  assert.equal(agyLevelFor({ levels: ["low", "medium", "high"] }, "xhigh"), "high");
  assert.equal(agyLevelFor({ levels: ["low", "medium", "high", "xhigh"] }, "max"), "xhigh");
  assert.equal(agyLevelFor({ levels: ["low", "high"] }, "minimal"), "low");
  assert.equal(agyLevelFor({ levels: [] }, "high"), undefined);
});

test("stop reasons and usage", () => {
  assert.equal(stopReason("end_turn"), "stop");
  assert.equal(stopReason("max_tokens"), "length");
  assert.equal(stopReason("cancelled"), "aborted");
  assert.equal(usageFrom({ inputTokens: 3, outputTokens: 4 })?.totalTokens, 7);
  assert.equal(usageFrom({}), undefined);
});

test("bridge policy", () => {
  const s = new Set<string>();
  assert.match(checkCall({ action: "start", name: "a", model: "antigravity/gemini-4-neon", task: "x" }, s)!, /may not run on antigravity/);
  assert.match(checkCall({ action: "start", name: "a", task: "x" }, s)!, /needs model/);
  assert.equal(checkCall({ action: "start", name: "a", model: "claude-code/claude-opus-5-5", task: "x" }, s), undefined);
  assert.match(checkCall({ action: "send", name: "other", text: "x" }, s)!, /no child other/);
  s.add("a");
  assert.equal(checkCall({ action: "wait", name: "a" }, s), undefined);
  assert.equal(checkCall({ action: "wait" }, s), undefined);
  assert.match(checkCall({ action: "hosts" }, s)!, /unknown action/);
});

test("launch from env", () => {
  assert.deepEqual(launchFromEnv({}), { command: "agy", args: ["acp", "--process-per-session"], env: { PI_ANTIGRAVITY: "1" } });
  assert.deepEqual(launchFromEnv({ PI_ANTIGRAVITY_COMMAND: "/x/agy_acp_server" }).args, []);
  assert.deepEqual(launchFromEnv({ PI_ANTIGRAVITY_ARGS: "acp --agent reviewer" }).args, ["acp", "--agent", "reviewer", "--process-per-session"]);
});

test("permission title", () => {
  const t = describePermission({
    sessionId: "s",
    toolCall: { toolCallId: "1", title: "Run command", rawInput: { command: "rm -rf build" }, content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y\nz" }] },
    options: [],
  });
  assert.match(t, /Run command/);
  assert.match(t, /\$ rm -rf build/);
  assert.match(t, /a\.ts \(\+2 −1\)/);
});

test("denied tools and commands", () => {
  for (const t of ["invoke_subagent", "define_subagent", "manage_subagents", "send_message", "swarm_wait", "read_board", "board_post"]) assert.ok(DENIED_TOOL_RE.test(t), t);
  for (const t of ["run_command", "view_file", "mcp_pi_agent", "agent"]) assert.ok(!DENIED_TOOL_RE.test(t), t);
  assert.equal(deniedTool({ title: "Running invoke_subagent" }), "invoke_subagent");
  assert.equal(deniedTool({ title: "Run invoke_subagent?" }), "invoke_subagent");
  assert.equal(deniedTool({ title: "swarm_wait" }), "swarm_wait");
  assert.equal(deniedTool({ title: "x", rawInput: { Subagents: [] } }), "invoke_subagent");
  assert.equal(deniedTool({ title: "Run npm test" }), undefined);
  assert.equal(deniedCommand("/swarm build it"), "swarm");
  assert.equal(deniedCommand("/teamwork x"), "teamwork");
  assert.equal(deniedCommand("/goal x"), undefined);
});

test("guard hook script: denies only in Pi agy processes", async () => {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const script = path.join(dir, "guard.sh");
  fs.writeFileSync(script, hookScript(), { mode: 0o755 });
  const run = (name: string, pi: boolean) =>
    JSON.parse(execFileSync(script, { input: JSON.stringify({ conversationId: "c", toolCall: { name, args: { x: 1 } } }), env: { PATH: process.env.PATH, ...(pi ? { PI_ANTIGRAVITY: "1" } : {}) } }).toString());
  assert.equal(run("invoke_subagent", true).decision, "deny");
  assert.equal(run("swarm_wait", true).decision, "deny");
  assert.equal(run("run_command", true).decision, "allow");
  assert.equal(run("invoke_subagent", false).decision, "allow");
  fs.rmSync(dir, { recursive: true });
});

test("installGuard keeps other hooks and settings", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guard-"));
  const p = { stateDir: path.join(dir, "state"), hookScript: path.join(dir, "state", "guard.sh"), hooksJson: path.join(dir, "hooks.json"), settingsJson: path.join(dir, "settings.json") };
  fs.writeFileSync(p.hooksJson, JSON.stringify({ mine: { PreToolUse: [] } }));
  fs.writeFileSync(p.settingsJson, JSON.stringify({ trustedWorkspaces: ["/x"], permissions: { allow: ["command(git)"] } }));
  assert.equal(installGuard(p).length, 3);
  assert.deepEqual(guardStatus(p), { hook: true, script: true, mcpAllow: true });
  const hooks = JSON.parse(fs.readFileSync(p.hooksJson, "utf8"));
  assert.ok(hooks.mine && hooks["pi-antigravity-guard"]);
  const settings = JSON.parse(fs.readFileSync(p.settingsJson, "utf8"));
  assert.deepEqual(settings.trustedWorkspaces, ["/x"]);
  assert.deepEqual(settings.permissions.allow, ["command(git)", "mcp(pi/*)"]);
  assert.deepEqual(installGuard(p), []);
  fs.rmSync(dir, { recursive: true });
});
