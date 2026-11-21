import assert from "node:assert/strict";
import { test } from "node:test";
import { checkCall } from "../src/bridge.ts";
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
  assert.match(checkCall({ action: "start", name: "a", task: "x" }, s)!, /needs --model/);
  assert.equal(checkCall({ action: "start", name: "a", model: "claude-code/claude-opus-5-5", task: "x" }, s), undefined);
  assert.match(checkCall({ action: "send", name: "other", text: "x" }, s)!, /no pi-agent child/);
  s.add("a");
  assert.equal(checkCall({ action: "wait", name: "a" }, s), undefined);
  assert.equal(checkCall({ action: "wait" }, s), undefined);
  assert.match(checkCall({ action: "hosts" }, s)!, /unknown action/);
});

test("launch from env", () => {
  assert.deepEqual(launchFromEnv({}), { command: "agy", args: ["acp"], env: {} });
  assert.deepEqual(launchFromEnv({ PI_ANTIGRAVITY_COMMAND: "/x/agy_acp_server" }).args, []);
  assert.deepEqual(launchFromEnv({ PI_ANTIGRAVITY_ARGS: "acp --agent reviewer" }).args, ["acp", "--agent", "reviewer"]);
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
