import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCall } from "../src/mcp.ts";
import { isPiAgentTool, isSubagentTool, updateAgyConfig } from "../src/agy-config.ts";
import { readSubagents, readTranscript, transcriptLines } from "../src/subagents.ts";
import { rosterRows, rowNames } from "../src/subagent-view.ts";
import { TurnGate } from "../src/gate.ts";
import { agyLevelFor, catalogFromModelsOutput, catalogFromSession, toPiModel } from "../src/models.ts";
import { describePermission, launchFromEnv } from "../src/runtime.ts";
import { stopReason, usageFrom } from "../src/translate.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

const asst = (stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason });
const userAt = (text: string, timestamp: number) => ({ role: "user", content: [{ type: "text", text }], timestamp });

test("gate: typed text is human and refills the budget", () => {
  const g = new TurnGate(Date.now, 2);
  g.arm("fix the bug");
  const d = g.decide([userAt("old", 1), asst(), userAt("fix the bug", 2)]);
  assert.deepEqual(d, { indexes: [2], human: true });
});

test("gate: a child result is automatic and uses the budget", () => {
  const g = new TurnGate(Date.now, 2);
  const msgs: any[] = [userAt("go", 1), asst()];
  for (let i = 0; i < 2; i++) {
    msgs.push(userAt(`Agent a finished: ${i}`, 10 + i));
    const d = g.decide(msgs) as any;
    assert.equal(d.human, false);
    g.commit(d.indexes.map((x: number) => msgs[x]), false);
    msgs.push(asst());
  }
  msgs.push(userAt("Agent b finished", 20));
  assert.match((g.decide(msgs) as any).refuse, /did not type/);
  g.arm("continue");
  msgs.push(userAt("continue", 21));
  const d = g.decide(msgs) as any;
  assert.deepEqual(d, { indexes: [msgs.length - 2, msgs.length - 1], human: true });
  g.commit([], true);
  assert.equal(g.autoTurns, 0);
});

test("gate: messages that agy got are not sent again (retry)", () => {
  const g = new TurnGate();
  g.arm("hi");
  const msgs: any[] = [userAt("hi", 1)];
  const d = g.decide(msgs) as any;
  g.commit([msgs[0]], d.human);
  msgs.push(asst("error"));
  assert.match((g.decide(msgs) as any).refuse, /Nothing new/);
});

test("gate: a /template token matches the expanded text", () => {
  const g = new TurnGate();
  g.arm("/review src");
  assert.equal((g.decide([userAt("Expanded template text", 1)]) as any).human, true);
});

test("gate: tokens expire", () => {
  let now = 0;
  const g = new TurnGate(() => now);
  g.arm("x");
  now = 61 * 60_000;
  assert.equal((g.decide([userAt("x", 1)]) as any).human, false);
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

test("agent tool policy", () => {
  const s = new Set<string>();
  assert.equal(checkCall({ action: "start", name: "a", model: "antigravity/gemini-4-neon", task: "x" }, s), undefined);
  assert.equal(checkCall({ action: "start", name: "a", task: "x" }, s), undefined);
  assert.match(checkCall({ action: "start", name: "a", task: "x", host: "h" }, s)!, /remote hosts/);
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

test("subagent tool calls are recognized", () => {
  assert.ok(isSubagentTool({ title: "Run invoke_subagent" }));
  assert.ok(isSubagentTool({ title: "Running start_subagent" }));
  assert.ok(!isSubagentTool({ title: "Run npm test" }));
});

test("Pi's agent tool title", () => {
  assert.ok(isPiAgentTool({ title: "Run mcp_pi_agent" }));
  assert.ok(isPiAgentTool({ title: "Running mcp_pi_agent" }));
  assert.ok(!isPiAgentTool({ title: "Run mcp_other_agent" }));
  assert.ok(!isPiAgentTool({ title: "Run mcp_pi_agent_x" }));
});

test("updateAgyConfig removes the old allow rule and hook, keeping the rest", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agycfg-"));
  const p = { settingsJson: path.join(dir, "settings.json"), hooksJson: path.join(dir, "hooks.json"), oldStateDir: path.join(dir, "state") };
  fs.writeFileSync(p.settingsJson, JSON.stringify({ trustedWorkspaces: ["/x"], permissions: { allow: ["command(git)", "mcp(pi/*)"] } }));
  fs.writeFileSync(p.hooksJson, JSON.stringify({ mine: { PreToolUse: [] }, "pi-antigravity-guard": { enabled: true } }));
  assert.equal(updateAgyConfig(p).length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.settingsJson, "utf8")), { trustedWorkspaces: ["/x"], permissions: { allow: ["command(git)"] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.hooksJson, "utf8")), { mine: { PreToolUse: [] } });
  assert.deepEqual(updateAgyConfig(p), []);
  fs.writeFileSync(p.settingsJson, JSON.stringify({ trustedWorkspaces: ["/x"], permissions: { allow: ["mcp(pi/*)"] } }));
  updateAgyConfig(p);
  assert.deepEqual(JSON.parse(fs.readFileSync(p.settingsJson, "utf8")), { trustedWorkspaces: ["/x"] });
  fs.rmSync(dir, { recursive: true });
});

test("agy subagents from its records", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const brain = fs.mkdtempSync(path.join(os.tmpdir(), "brain-"));
  const parent = "395cab90-24ad-40ce-8663-cda27baf6ede";
  const a = "faa81dcb-1094-418e-b96d-ac0a0fcc6a0d";
  const b = "0b0b0b0b-1094-418e-b96d-ac0a0fcc6a0d";
  const sg = path.join(brain, parent, ".system_generated");
  fs.mkdirSync(path.join(sg, "subagents"), { recursive: true });
  fs.mkdirSync(path.join(sg, "messages"), { recursive: true });
  fs.writeFileSync(path.join(sg, "subagents", `${a}.json`), JSON.stringify({ conversationId: a, subagentDescriptor: { typeName: "self", role: "counter" }, state: "SUBAGENT_STATE_ALIVE" }));
  fs.writeFileSync(path.join(sg, "subagents", `${b}.json`), JSON.stringify({ conversationId: b, subagentDescriptor: { role: "Tester" }, state: "SUBAGENT_STATE_ALIVE" }));
  fs.writeFileSync(path.join(sg, "messages", "m1.json"), JSON.stringify({ sender: "system", timestamp: new Date(Date.now() + 60_000).toISOString(), content: `Subagent ${a} has gone idle. This was the subagent's most recent response: seven` }));
  fs.writeFileSync(path.join(sg, "messages", "read.json"), "{}");
  const logs = path.join(brain, a, ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  fs.writeFileSync(
    path.join(logs, "transcript.jsonl"),
    [
      { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "x\n<SYSTEM_MESSAGE>\n[Message] sender=p content=Reply seven.\n</SYSTEM_MESSAGE>" },
      { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", content: "seven", tool_calls: [{ name: "view_file" }] },
    ].map((x) => JSON.stringify(x)).join("\n"),
  );
  const list = readSubagents(parent, brain);
  const byRole = Object.fromEntries(list.map((s) => [s.role, s]));
  assert.equal(byRole.counter.status, "idle");
  assert.equal(byRole.counter.lastReply, "seven");
  assert.equal(byRole.Tester.status, "working");
  assert.deepEqual(transcriptLines(readTranscript(a, brain)), ["message: Reply seven.", "▸ view_file", "reply: seven"]);
  const rows = rosterRows(list);
  assert.deepEqual(rows.map((r) => [r.name, r.status]).sort(), [["agy-counter", "idle"], ["agy-tester", "working"]]);
  assert.deepEqual([...rowNames([{ ...list[0], role: "x" }, { ...list[1], role: "x" }]).values()], ["agy-x", "agy-x-2"]);
  assert.deepEqual(readSubagents("not-an-id", brain), []);
  fs.rmSync(brain, { recursive: true });
});
